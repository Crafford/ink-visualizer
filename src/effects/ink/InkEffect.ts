import * as THREE from 'three';
import type { Effect, EffectContext, RenderSize } from '../types';
import type { ParamId, Params } from '../../app/params';
import { Attractors } from './Attractors';
import { ParticleSim, type SimInputs } from './ParticleSim';
import { POINTS_FRAG, POINTS_VERT } from './shaders/points.glsl';

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
  maxSpeed: 0.9,
  /** Early-respawn rate per second at emissionRate 1. */
  emission: 0.35,
  /** Fraction of particles respawned per beat at burstSize 1 (kept light until M5). */
  burst: 0.15,
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
 * Ink effect, M3: GPU particle simulation drawn as faint points on paper.
 *
 * step():   attractors wander on the CPU, then one simulation pass on the GPU (ParticleSim).
 * render(): clear to paper, draw the particles with "over" blending of the ink colour.
 *           With a single ink colour that is order independent and accumulates density
 *           exponentially (paper -> ink), so dense cores saturate gracefully.
 * renderParticles(target) is split out so M4 can draw into a density/trail target instead.
 */
export class InkEffect implements Effect {
  readonly id = 'ink';
  readonly label = 'Ink';

  private sim: ParticleSim;
  private attractors = new Attractors();
  private aspect = 1;
  private dpr = 1;
  private needsInit = true;
  private beatUsed = false;
  private inputs: SimInputs;

  private paper = new THREE.Color();
  private scene = new THREE.Scene();
  private camera = new THREE.Camera();
  private geometry = new THREE.BufferGeometry();
  private material: THREE.RawShaderMaterial;
  private uniforms = {
    uStateA: { value: null as THREE.Texture | null },
    uStateB: { value: null as THREE.Texture | null },
    uSize: { value: 1 },
    uAspect: { value: 1 },
    uPointSize: { value: 1 },
    uOpacity: { value: 0.1 },
    uInk: { value: new THREE.Color() },
    uRound: { value: false },
  };

  constructor(renderer: THREE.WebGLRenderer, params: Readonly<Params>) {
    this.sim = new ParticleSim(renderer, params.particleCount);
    this.inputs = {
      dt: 0, time: 0, aspect: 1, attractors: this.attractors.positions, attractorCount: 1,
      noiseScale: 1, noiseSpeed: TUNE.noiseSpeed, turbulence: 0, pull: TUNE.pull, swirl: TUNE.swirl,
      damping: 0, maxSpeed: TUNE.maxSpeed, lifespan: 4, respawnChance: 0, burstChance: 0,
      coreRadius: TUNE.coreRadius, coreFraction: TUNE.coreFraction, jets: TUNE.jets,
      jetSpeed: TUNE.jetSpeed, jetWidth: TUNE.jetWidth, jetSpin: TUNE.jetSpin, calmRadius: TUNE.calmRadius,
    };

    this.material = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: POINTS_VERT,
      fragmentShader: POINTS_FRAG,
      uniforms: this.uniforms,
      transparent: true,
      blending: THREE.NormalBlending,
      depthTest: false,
      depthWrite: false,
    });
    // No attributes: the draw range is the particle count, gl_VertexID does the rest.
    this.geometry.setDrawRange(0, params.particleCount);
    const points = new THREE.Points(this.geometry, this.material);
    points.frustumCulled = false;
    this.scene.add(points);
  }

  resize(size: Readonly<RenderSize>): void {
    this.aspect = size.width / Math.max(1, size.height);
    this.dpr = size.dpr;
  }

  onParamChange(id: ParamId, params: Readonly<Params>): void {
    if (id !== 'particleCount') return;
    this.sim.allocate(params.particleCount);
    this.geometry.setDrawRange(0, params.particleCount);
    this.needsInit = true;
  }

  step({ dt, time, params, audio, renderer }: EffectContext): void {
    const s = this.inputs;
    // Audio mapping, deliberately light until M5.
    const bass = audio.bass, mid = audio.mid, high = audio.high;
    this.attractors.update(dt, 1 + bass, this.aspect);

    s.dt = dt;
    s.time = time;
    s.aspect = this.aspect;
    s.attractorCount = Math.round(params.emitters);
    s.noiseScale = params.turbulenceScale * TUNE.noiseScale * (1 + 0.5 * high);
    s.turbulence = params.turbulenceStrength * TUNE.turbulence * (1 + mid);
    s.damping = params.drag * TUNE.damping;
    s.lifespan = params.lifespan;
    s.respawnChance = params.emissionRate * TUNE.emission * (1 + bass) * dt;
    s.burstChance = audio.beat && !this.beatUsed ? params.burstSize * TUNE.burst : 0;
    if (audio.beat) this.beatUsed = true;

    if (this.needsInit) {
      this.sim.init(renderer, s);
      this.needsInit = false;
    } else {
      this.sim.step(renderer, s);
    }
  }

  /** Draw the particles into `target` (null = default framebuffer). Does not clear. */
  renderParticles(renderer: THREE.WebGLRenderer, params: Readonly<Params>, target: THREE.WebGLRenderTarget | null): void {
    const u = this.uniforms;
    u.uStateA.value = this.sim.stateA;
    u.uStateB.value = this.sim.stateB;
    u.uSize.value = this.sim.size;
    u.uAspect.value = this.aspect;
    u.uPointSize.value = params.pointSize * this.dpr;
    u.uRound.value = u.uPointSize.value >= 3;
    u.uOpacity.value = params.pointOpacity;
    // Raw shader output is not colour-managed: feed sRGB values to match the swatch.
    u.uInk.value.set(params.inkColor).convertLinearToSRGB();

    const prevTarget = renderer.getRenderTarget();
    const prevAutoClear = renderer.autoClear;
    renderer.autoClear = false;
    renderer.setRenderTarget(target);
    renderer.render(this.scene, this.camera);
    renderer.setRenderTarget(prevTarget);
    renderer.autoClear = prevAutoClear;
  }

  render({ renderer, params }: EffectContext): void {
    this.beatUsed = false;
    if (this.needsInit) return; // nothing simulated yet
    this.paper.set(params.paperColor);
    renderer.setClearColor(this.paper, 1);
    renderer.setRenderTarget(null);
    renderer.clear(true, false, false);
    this.renderParticles(renderer, params, null);
  }

  dispose(): void {
    this.sim.dispose();
    this.geometry.dispose();
    this.material.dispose();
  }
}

export const createInkEffect = (r: THREE.WebGLRenderer, p: Readonly<Params>) => new InkEffect(r, p);
