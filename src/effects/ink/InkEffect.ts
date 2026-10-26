import * as THREE from 'three';
import type { Effect, EffectContext, EffectFactory, RenderSize } from '../types';
import type { AudioFrame } from '../../audio/types';
import type { InkParams } from './params';
import { Attractors } from '../shared/Attractors';
import { InkTrails } from './InkTrails';
import { ParticleSim, type SimInputs } from './ParticleSim';
import { POINTS_FRAG, POINTS_VERT } from './shaders/points.glsl';
import { MAX_ATTRACTORS } from '../shared/shaders/fullscreen.glsl';

type Range = readonly [number, number];
const lerp = (r: Range, t: number) => r[0] + (r[1] - r[0]) * t;

/**
 * Fixed tuning that maps the 0..1-ish panel params onto simulation units
 * (view half-heights and simulation seconds). Kept in one place so the look can be retuned
 * without hunting through shader code. `[dry, wet]` pairs are interpolated by Wetness.
 */
const TUNE = {
  /** Noise frequency per unit of turbulenceScale (view half-heights). */
  noiseScale: 0.9,
  /** How fast the curl field itself evolves (noise-space units per simulation second). */
  noiseSpeed: 0.04,
  /** Curl velocity (view half-heights / s) per unit of turbulenceStrength, at full wetness. */
  turbulence: 0.035,
  /** Velocity relaxation toward the medium, 1/s, per unit of (dragFloor + drag). */
  damping: 6,
  dragFloor: 0.25,
  maxSpeed: 1.2,
  /** Source wander phase rate (x Speed): 0.4 = full traverse in 40-60 s. */
  wander: 0.4,

  /** Wetness table [dry, wet]. */
  wetRelax: [2.6, 0.8] as Range,      // x damping * (dragFloor + drag): splat dies fast when dry
  wetCurl: [0.15, 0.7] as Range,      // curl influence
  wetBleed: [1, 3] as Range,          // bleed reach multiplier
  wetBleedRate: [2.2, 0.7] as Range,  // bleed speed, 1/s (reach x rate x f^2)
  wetLife: [1, 1.6] as Range,         // lifespan multiplier
  wetInk: [1, 0.7] as Range,          // ink per particle: watercolour is more translucent

  /** Seep: wake-up rate of dormant particles per second at emissionRate 1, disc radius,
   *  outward speed, and how far the disc bleeds (absolute, x wetBleed). */
  seep: 0.15,
  seepRadius: 0.02,
  seepSpeed: 0.03,
  seepBleed: 0.025,

  /** Beat drop: fraction of all particles respawned at burstSize 1, beatStrength 1. */
  burst: 0.15,
  /** Idle drips (no beat for dripQuiet s): fraction per unit emissionRate, interval and strength. */
  drip: 0.15,
  dripInterval: [1.4, 3.4] as Range,
  dripStrength: [0.3, 0.65] as Range,
  dripQuiet: 2,
  /** Drop geometry (view half-heights). splat + dropBleed = how far the disc grows (x wetBleed);
   *  satBleed is relative to the satellite's own radius. */
  dropJitter: 0.1,
  dropRadius: [0.03, 0.05] as Range,
  splat: 0.035,
  dropBleed: 0.035,
  dropLife: 1.2,
  satFraction: 0.2,
  satDist: [0.08, 0.25] as Range,
  satRadius: 0.014,
  satBleed: 0.5,
  /** Edge feathering: tendril share, fibre bend (radians), fibre field frequency, edge lobes. */
  fibre: 0.08,
  feather: 0.7,
  featherFreq: 45,
  edgeNoise: 0.45,

  /** In-place beat response (render only). Kick: radial expansion about the source x bs. */
  kick: 0.25,
  kickRadius: 0.8,
  /** Shiver: displacement x bs, at shiverScale x the curl frequency. */
  shiver: 0.005,
  shiverScale: 3.5,
  /** Breathing: radial scale x bass. */
  breath: 0.015,
  /** Band mappings: x (1 + k * band). Bands are 0..1 at sensitivity 1, up to 3 at 3. */
  bassEmission: 2,
  bassSpeed: 1,
  midTurbulence: 1.5,
  highScale: 1,
  highInk: 0.5,
};

/**
 * Ink effect: GPU particle simulation, density splat, trail feedback, ink-on-paper composite.
 *
 * step():   sources wander on the CPU, drop events are scheduled (beats, idle drips), one
 *           simulation pass on the GPU (ParticleSim), then the particles are splatted
 *           additively into the density target (InkTrails).
 * render(): if any steps ran since the last frame, fold density into the trail
 *           (blurH + drift, blurV * fade + density), then composite to the screen.
 *
 * Passes per 60 Hz frame: sim, points -> density, blurH, blurV, composite.
 * Speed scales the simulation clock (sim dt, wander); trails and render-time audio response
 * stay on the real clock.
 */
export class InkEffect implements Effect<InkParams> {
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
  /** Simulation clock (scaled by Speed). */
  private simTime = 0;
  /** Real time of the last beat, and per-source sim time of the next idle drip. */
  private lastBeat = -1e9;
  private dripAt = [0.3, 1.1, 1.9];
  private rng = 0x2f6b1d;

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
    uShiver: { value: 0 },
    uShiverScale: { value: 1 },
    uRTime: { value: 0 },
    uBreath: { value: 0 },
  };

  constructor(renderer: THREE.WebGLRenderer, params: Readonly<InkParams>) {
    this.sim = new ParticleSim(renderer, params.particleCount);
    const T = TUNE;
    this.inputs = {
      dt: 0, time: 0, aspect: 1, attractors: this.attractors.positions, attractorCount: 1,
      noiseScale: 1, noiseSpeed: T.noiseSpeed, turbulence: 0, relax: 1, maxSpeed: T.maxSpeed,
      lifespan: 4, bleedRate: 1, seepChance: 0, seepRadius: T.seepRadius, seepSpeed: T.seepSpeed,
      seepBleed: T.seepBleed, dropChance: 0, dropEmitter: -1, dropSeed: 0, dropStrength: 0.5,
      dropJitter: T.dropJitter, dropRadius: T.dropRadius, splat: T.splat, dropBleed: T.dropBleed,
      dropLife: T.dropLife, satFraction: T.satFraction, satDist: T.satDist, satRadius: T.satRadius,
      satBleed: T.satBleed, fibre: T.fibre, feather: T.feather, featherFreq: T.featherFreq, edgeNoise: T.edgeNoise,
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

  onParamChange(id: string, params: Readonly<InkParams>): void {
    if (id !== 'particleCount') return;
    this.sim.allocate(params.particleCount);
    this.geometry.setDrawRange(0, 2 * params.particleCount);
    this.needsInit = true;
  }

  /** Uniform 0..1 from a small LCG (idle drip timing only). */
  private rand(): number {
    this.rng = (Math.imul(this.rng, 1664525) + 1013904223) >>> 0;
    return this.rng / 4294967296;
  }

  step({ dt, time, params, audio, renderer }: EffectContext<InkParams>): void {
    const s = this.inputs;
    const T = this.tune;
    const wet = params.wetness;
    const sdt = dt * params.speed;
    this.simTime += sdt;
    // Audio mapping (see ARCHITECTURE.md, ink). Bands already include the panel sensitivity
    // (0 = off, 1 = nominal, 3 = up to 3x), so every mapping is linear in it.
    const bass = audio.bass, mid = audio.mid, high = audio.high;
    const bs = audio.beatStrength;
    this.attractors.update(sdt, T.wander * (1 + T.bassSpeed * bass), this.aspect);
    const count = Math.max(1, Math.min(MAX_ATTRACTORS, Math.round(params.emitters)));

    s.dt = sdt;
    s.time = this.simTime;
    s.aspect = this.aspect;
    s.attractorCount = count;
    s.noiseScale = params.turbulenceScale * T.noiseScale * (1 + T.highScale * high);
    s.turbulence = params.turbulenceStrength * T.turbulence * lerp(T.wetCurl, wet) * (1 + T.midTurbulence * mid);
    s.relax = T.damping * (T.dragFloor + params.drag) * lerp(T.wetRelax, wet);
    s.lifespan = params.lifespan * lerp(T.wetLife, wet);
    s.bleedRate = lerp(T.wetBleedRate, wet);
    const bleed = lerp(T.wetBleed, wet);
    s.seepBleed = T.seepBleed * bleed;
    s.dropBleed = T.dropBleed * bleed;
    s.satBleed = T.satBleed * bleed;
    s.splat = T.splat;
    s.feather = T.feather;
    s.featherFreq = T.featherFreq;
    s.edgeNoise = T.edgeNoise;
    s.fibre = T.fibre;
    s.seepChance = params.emissionRate * T.seep * (1 + T.bassEmission * bass) * sdt;

    // Drops: a beat drops at every source at once; with no beats for a while, each source
    // drips on its own (sim clock, so Speed slows the drips too). One drop event per step.
    const beatNow = (audio.beat && !this.beatUsed) || this.beatPending;
    if (audio.beat) this.beatUsed = true;
    this.beatPending = false;
    s.dropChance = 0;
    if (beatNow) {
      this.lastBeat = time;
      const st = Math.max(bs, 0.25);
      s.dropChance = params.burstSize * st * T.burst;
      s.dropEmitter = -1;
      s.dropStrength = st;
    } else if (time - this.lastBeat > T.dripQuiet) {
      for (let i = 0; i < count; i++) {
        if (this.simTime < this.dripAt[i]) continue;
        this.dripAt[i] = this.simTime + lerp(T.dripInterval, this.rand());
        s.dropChance = T.drip * params.emissionRate;
        s.dropEmitter = i;
        s.dropStrength = lerp(T.dripStrength, this.rand());
        break;
      }
    }
    if (s.dropChance > 0) s.dropSeed = (s.dropSeed + 0x9e37) >>> 0;

    if (this.needsInit) {
      this.sim.init(renderer, s);
      this.needsInit = false;
    } else {
      this.sim.step(renderer, s);
    }

    const density = this.trails.densityTarget;
    if (density) {
      this.trails.prepare(renderer);
      this.renderParticles(renderer, params, density, audio, time);
      this.stepsSinceRender++;
    }
  }

  /** Draw the particles into `target` (null = default framebuffer). Does not clear. */
  renderParticles(
    renderer: THREE.WebGLRenderer, params: Readonly<InkParams>, target: THREE.WebGLRenderTarget | null,
    audio?: Readonly<AudioFrame>, time = 0,
  ): void {
    const T = this.tune;
    const u = this.uniforms;
    const high = audio?.high ?? 0, bass = audio?.bass ?? 0, bs = audio?.beatStrength ?? 0;
    u.uStateA.value = this.sim.stateA;
    u.uStateB.value = this.sim.stateB;
    u.uSize.value = this.sim.size;
    u.uAspect.value = this.aspect;
    u.uViewPx.value.copy(this.bufferSize);
    u.uStepDt.value = this.inputs.dt;
    // Constant ink per particle per CSS px^2, so the look does not change with dpr.
    u.uInk.value = params.pointOpacity * this.dpr * this.dpr * lerp(T.wetInk, params.wetness) * (1 + T.highInk * high);
    this.updateAbsorb(params);
    u.uAttractorCount.value = Math.max(1, Math.min(MAX_ATTRACTORS, Math.round(params.emitters)));
    u.uKick.value = bs * T.kick * (0.5 + params.burstSize);
    u.uKickRadius.value = T.kickRadius;
    u.uShiver.value = bs > 0.01 ? bs * T.shiver * (0.5 + params.burstSize) : 0;
    u.uShiverScale.value = this.inputs.noiseScale * T.shiverScale;
    u.uRTime.value = time;
    u.uBreath.value = bass * T.breath;

    const prevTarget = renderer.getRenderTarget();
    const prevAutoClear = renderer.autoClear;
    renderer.autoClear = false;
    renderer.setRenderTarget(target);
    renderer.render(this.scene, this.camera);
    renderer.setRenderTarget(prevTarget);
    renderer.autoClear = prevAutoClear;
  }

  /** Source colours -> absorbance (-ln of the sRGB value), parsed only on change. */
  private updateAbsorb(params: Readonly<InkParams>): void {
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

  render({ renderer, params, time, audio }: EffectContext<InkParams>): void {
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

export const createInkEffect: EffectFactory = (r, p) => new InkEffect(r, p as Readonly<InkParams>);
