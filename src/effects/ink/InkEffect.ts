import * as THREE from 'three';
import type { Effect, EffectContext, RenderSize } from '../types';
import type { ParamId, Params } from '../../app/params';
import { Attractors } from './Attractors';
import { InkTrails } from './InkTrails';
import { ParticleSim, type SimInputs } from './ParticleSim';
import { POINTS_FRAG, POINTS_VERT } from './shaders/points.glsl';
import { MAX_ATTRACTORS } from './shaders/sim.glsl';

/**
 * Fixed tuning that maps the 0..1-ish panel params onto simulation units
 * (view heights and seconds). Kept in one place so the look can be retuned without
 * hunting through shader code.
 */
const TUNE = {
  /** Noise frequency per unit of turbulenceScale (view half-heights). */
  noiseScale: 0.9,
  /** How fast the curl field itself evolves (noise-space units per second). */
  noiseSpeed: 0.07,
  /** Curl acceleration per unit of turbulenceStrength. */
  turbulence: 0.3,
  /** Attractor spring (units/s^2 outside the soft floor). */
  pull: 0.11,
  /** Tangential force at the attractor, decays with distance. */
  swirl: 0.12,
  /** Per-second velocity damping per unit of drag. */
  damping: 4,
  maxSpeed: 1.6,
  /** Early-respawn rate per second at emissionRate 1. */
  emission: 0.35,
  /** Fraction of particles respawned per beat at burstSize 1 and beatStrength 1. */
  burst: 0.4,
  /** Launch speed of beat-burst births (view half-heights / s), and its tangential share. */
  burstSpeed: 1.6,
  burstCurl: 0.08,
  /** Lifespan multiplier of burst births: ejected ink reads as an event and then clears. */
  burstLife: 0.5,
  /** Rays per attractor per beat that the burst births ride (fresh directions every beat). */
  burstRays: 5,
  /** Outward acceleration on live particles per unit beatStrength, and its reach. Kept
   *  modest: a strong push on every beat scatters the cores into an even grey fog. */
  beatPush: 0.8,
  beatRadius: 0.45,
  /** Render-time beat kick: radial expansion about the core per unit beatStrength, and reach. */
  kick: 0.35,
  kickRadius: 0.8,
  /** Turbulence x (1 + beatStrength * beatShiver). */
  beatShiver: 0.6,
  /** Band mappings: x (1 + k * band). Bands are 0..1 at sensitivity 1, up to 3 at 3. */
  bassEmission: 2,
  bassSpeed: 1.5,
  midTurbulence: 1.5,
  highScale: 1,
  highInk: 0.5,
  /** Gaussian sigma of the birth core, view half-heights. */
  coreRadius: 0.015,
  /** Share of births that stay in the core; the rest are released along jets. */
  coreFraction: 0.25,
  /** Jets per attractor: each becomes one strand. */
  jets: 6,
  jetSpeed: 0.45,
  /** Angular jitter of a jet (radians): thinner strands when smaller. */
  jetWidth: 0.06,
  /** Jet rotation, radians per second, so strands fan and sweep. */
  jetSpin: 0.12,
  /** Curl noise fades in over this distance from an attractor (view half-heights). */
  calmRadius: 0.3,
};

/**
 * Ink effect: GPU particle simulation, density splat, trail feedback, ink-on-paper composite.
 *
 * step():   attractors wander on the CPU, one simulation pass on the GPU (ParticleSim), then
 *           the particles are splatted additively into the density target (InkTrails).
 * render(): if any steps ran since the last frame, fold density into the trail
 *           (blurH + drift, blurV * fade + density), then composite to the screen.
 *
 * Passes per 60 Hz frame: sim, points -> density, blurH, blurV, composite.
 */
export class InkEffect implements Effect {
  readonly id = 'ink';
  readonly label = 'Ink';
  /** Tuning table, read every step (reachable from the console via ?debug). */
  readonly tune = TUNE;

  private sim: ParticleSim;
  private attractors = new Attractors();
  private aspect = 1;
  private dpr = 1;
  private needsInit = true;
  /** A beat seen in a frame that ran no simulation step waits for the next step. */
  private beatPending = false;
  private beatUsed = false;
  private inputs: SimInputs;
  private absorb = Array.from({ length: MAX_ATTRACTORS }, () => new THREE.Vector3());
  private inkHex = ['', '', ''];
  private tmpColor = new THREE.Color();

  private trails = new InkTrails();
  private stepsSinceRender = 0;
  private scene = new THREE.Scene();
  private camera = new THREE.Camera();
  private geometry = new THREE.BufferGeometry();
  private material: THREE.RawShaderMaterial;
  private uniforms = {
    uStateA: { value: null as THREE.Texture | null },
    uStateB: { value: null as THREE.Texture | null },
    uSize: { value: 1 },
    uAspect: { value: 1 },
    uViewPx: { value: new THREE.Vector2(1, 1) },
    uStepDt: { value: 1 / 60 },
    uInk: { value: 0.1 },
    uAbsorb: { value: this.absorb },
    uAttractors: { value: this.attractors.positions },
    uAttractorCount: { value: 1 },
    uKick: { value: 0 },
    uKickRadius: { value: 0.8 },
  };

  constructor(renderer: THREE.WebGLRenderer, params: Readonly<Params>) {
    this.sim = new ParticleSim(renderer, params.particleCount);
    this.inputs = {
      dt: 0, time: 0, aspect: 1, attractors: this.attractors.positions, attractorCount: 1,
      noiseScale: 1, noiseSpeed: TUNE.noiseSpeed, turbulence: 0, pull: TUNE.pull, swirl: TUNE.swirl,
      damping: 0, maxSpeed: TUNE.maxSpeed, lifespan: 4, respawnChance: 0, burstChance: 0,
      coreRadius: TUNE.coreRadius, coreFraction: TUNE.coreFraction, jets: TUNE.jets,
      jetSpeed: TUNE.jetSpeed, jetWidth: TUNE.jetWidth, jetSpin: TUNE.jetSpin, calmRadius: TUNE.calmRadius,
      burstSpeed: TUNE.burstSpeed, burstCurl: TUNE.burstCurl, burstLife: TUNE.burstLife, burstRays: TUNE.burstRays, beatSeed: 0, beatPush: 0, beatRadius: TUNE.beatRadius,
    };

    this.material = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: POINTS_VERT,
      fragmentShader: POINTS_FRAG,
      uniforms: this.uniforms,
      transparent: true,
      // Plain additive: dst += src.
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneFactor,
      depthTest: false,
      depthWrite: false,
    });
    // No attributes: two line vertices per particle, gl_VertexID does the rest.
    this.geometry.setDrawRange(0, 2 * params.particleCount);
    const points = new THREE.LineSegments(this.geometry, this.material);
    points.frustumCulled = false;
    this.scene.add(points);
  }

  resize(size: Readonly<RenderSize>, renderer: THREE.WebGLRenderer): void {
    this.aspect = size.width / Math.max(1, size.height);
    this.dpr = size.dpr;
    renderer.getDrawingBufferSize(this.bufferSize);
    this.trails.resize(this.bufferSize.x, this.bufferSize.y);
    this.stepsSinceRender = 0;
  }
  private bufferSize = new THREE.Vector2();

  onParamChange(id: ParamId, params: Readonly<Params>): void {
    if (id !== 'particleCount') return;
    this.sim.allocate(params.particleCount);
    this.geometry.setDrawRange(0, 2 * params.particleCount);
    this.needsInit = true;
  }

  step({ dt, time, params, audio, renderer }: EffectContext): void {
    const s = this.inputs;
    const T = this.tune;
    // Audio mapping (see ARCHITECTURE.md, ink step 2). Bands already include the panel
    // sensitivity (0 = off, 1 = nominal, 3 = up to 3x), so every mapping is linear in it.
    const bass = audio.bass, mid = audio.mid, high = audio.high;
    const bs = audio.beatStrength;
    this.attractors.update(dt, 1 + T.bassSpeed * bass, this.aspect);

    s.dt = dt;
    s.time = time;
    s.aspect = this.aspect;
    s.attractorCount = Math.round(params.emitters);
    s.noiseScale = params.turbulenceScale * T.noiseScale * (1 + T.highScale * high);
    s.turbulence = params.turbulenceStrength * T.turbulence * (1 + T.midTurbulence * mid) * (1 + T.beatShiver * bs);
    s.damping = params.drag * T.damping;
    s.lifespan = params.lifespan;
    s.burstSpeed = T.burstSpeed;
    s.burstCurl = T.burstCurl;
    s.burstLife = T.burstLife;
    s.burstRays = T.burstRays;
    s.beatRadius = T.beatRadius;
    s.respawnChance = params.emissionRate * T.emission * (1 + T.bassEmission * bass) * dt;
    const beatNow = (audio.beat && !this.beatUsed) || this.beatPending;
    s.burstChance = beatNow ? params.burstSize * Math.max(bs, 0.25) * T.burst : 0;
    s.beatPush = bs * T.beatPush * (0.5 + params.burstSize);
    if (beatNow) s.beatSeed = (s.beatSeed + 0x9e37) >>> 0;
    if (audio.beat) this.beatUsed = true;
    this.beatPending = false;

    if (this.needsInit) {
      this.sim.init(renderer, s);
      this.needsInit = false;
    } else {
      this.sim.step(renderer, s);
    }

    const density = this.trails.densityTarget;
    if (density) {
      this.trails.prepare(renderer);
      this.renderParticles(renderer, params, density, high, bs);
      this.stepsSinceRender++;
    }
  }

  /** Draw the particles into `target` (null = default framebuffer). Does not clear. */
  renderParticles(renderer: THREE.WebGLRenderer, params: Readonly<Params>, target: THREE.WebGLRenderTarget | null, high = 0, beatStrength = 0): void {
    const u = this.uniforms;
    u.uStateA.value = this.sim.stateA;
    u.uStateB.value = this.sim.stateB;
    u.uSize.value = this.sim.size;
    u.uAspect.value = this.aspect;
    u.uViewPx.value.copy(this.bufferSize);
    u.uStepDt.value = 1 / 60;
    // Constant ink per particle per CSS px^2, so the look does not change with dpr.
    u.uInk.value = params.pointOpacity * this.dpr * this.dpr * (1 + this.tune.highInk * high);
    this.updateAbsorb(params);
    u.uAttractorCount.value = Math.max(1, Math.min(MAX_ATTRACTORS, Math.round(params.emitters)));
    u.uKick.value = beatStrength * this.tune.kick * (0.5 + params.burstSize);
    u.uKickRadius.value = this.tune.kickRadius;

    const prevTarget = renderer.getRenderTarget();
    const prevAutoClear = renderer.autoClear;
    renderer.autoClear = false;
    renderer.setRenderTarget(target);
    renderer.render(this.scene, this.camera);
    renderer.setRenderTarget(prevTarget);
    renderer.autoClear = prevAutoClear;
  }

  /** Attractor colours -> absorbance (-ln of the sRGB value), parsed only on change. */
  private updateAbsorb(params: Readonly<Params>): void {
    const hex = [params.inkColor1, params.inkColor2, params.inkColor3];
    for (let i = 0; i < MAX_ATTRACTORS; i++) {
      if (hex[i] === this.inkHex[i]) continue;
      this.inkHex[i] = hex[i];
      // Raw shader output is not colour-managed: work on the sRGB values the swatch shows.
      const c = this.tmpColor.set(hex[i]).convertLinearToSRGB();
      const k = (x: number) => -Math.log(Math.min(1, Math.max(x, 0.01)));
      this.absorb[i].set(k(c.r), k(c.g), k(c.b));
    }
  }

  render({ renderer, params, time, audio }: EffectContext): void {
    if (audio.beat && !this.beatUsed) this.beatPending = true;
    this.beatUsed = false;
    if (this.stepsSinceRender > 0) {
      this.trails.update(
        renderer, params, this.stepsSinceRender, this.dpr, time,
        this.attractors.positions, Math.round(params.emitters), audio.beatStrength,
      );
      this.stepsSinceRender = 0;
    }
    this.trails.present(renderer, params, this.dpr, audio.beatStrength);
  }

  dispose(): void {
    this.sim.dispose();
    this.trails.dispose();
    this.geometry.dispose();
    this.material.dispose();
  }
}

export const createInkEffect = (r: THREE.WebGLRenderer, p: Readonly<Params>) => new InkEffect(r, p);
