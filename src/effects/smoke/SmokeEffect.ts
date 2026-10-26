import * as THREE from 'three';
import type { Effect, EffectContext, EffectFactory, RenderSize } from '../types';
import type { AudioFrame } from '../../audio/types';
import type { SmokeParams } from './params';
import { Attractors } from '../shared/Attractors';
import { PingPongState } from '../shared/PingPongState';
import { MAX_ATTRACTORS } from '../shared/shaders/fullscreen.glsl';
import { SmokeTrails } from './SmokeTrails';
import { SMOKE_SIM_FRAG } from './shaders/sim.glsl';
import { SMOKE_POINTS_FRAG, SMOKE_POINTS_VERT } from './shaders/points.glsl';

/**
 * Fixed tuning that maps the panel params onto simulation units (view half-heights and
 * simulation seconds). Reachable as `stage.effect.tune` with ?debug.
 */
const TUNE = {
  /** Curl noise frequency per unit of Swirl, field evolution per sim second, velocity per unit of Turbulence. */
  noiseScale: 1.2,
  noiseSpeed: 0.12,
  turbulence: 0.12,
  /** Curl ramps up over this much particle age (s): laminar near the source, curls further up. */
  settle: 2.5,
  /** Velocity relaxation toward the medium, 1/s, per unit of (dragFloor + drag). */
  damping: 2,
  dragFloor: 0.25,
  maxSpeed: 1.2,
  /** Buoyancy: upward acceleration per unit of Rise (terminal rise speed = accel / relax). */
  rise: 1.2,
  /** The curl field rises at this share of the terminal rise speed (eddies are carried by the plume). */
  fieldRise: 0.5,
  /** Lateral spread rate (1/s) per unit of Rise: plumes widen as they lift. */
  widen: 0.5,
  /** Roll decay time constant (s). */
  spinDecay: 1.4,
  /** Source wander phase rate (x Speed), as ink. Sources sit lower in the view: y -> y * ySpan + yOffset. */
  wander: 0.4,
  ySpan: 0.7,
  yOffset: -0.32,

  /** Steady emission: wake-up rate per second at Emission 1, ring radius, outward and roll speed. */
  emit: 0.15,
  ringRadius: 0.03,
  emitVel: [0.03, 0.05] as const,
  /** Beat puff: fraction of all particles at Burst 1, beat strength 1; launch outward and roll. */
  puff: 0.07,
  puffVel: [0.4, 0.1] as const,
  puffLife: 0.8,
  /** Ink multiplier of puff smoke (it skips the stream's slow fade-in). */
  puffInk: 1.5,

  /** Cooling: ink per particle x (1 - age / life)^cool; fade in over fadeIn s. */
  cool: 1.6,
  fadeIn: 1.2,

  /** In-place beat response (render only), as ink. */
  kick: 0.2,
  kickRadius: 0.8,
  shiver: 0.005,
  shiverScale: 3.5,
  breath: 0.015,
  /** Band mappings: x (1 + k * band). */
  bassEmission: 2,
  bassSpeed: 1,
  midTurbulence: 1.5,
  highScale: 1,
  highInk: 0.5,
};

/**
 * Smoke effect: buoyant plumes from 1-3 wandering sources.
 *
 * step():   sources wander (CPU), puff events from beats, one simulation pass on the GPU
 *           (shared PingPongState + SMOKE_SIM_FRAG), then particles are splatted additively
 *           into the density target (SmokeTrails).
 * render(): fold density into the line/wash trails (upward drift), composite (light paper or dark).
 *
 * No drops, bleed or wetness: smoke is emitted on a ring (steady stream), puffs a smoke ring on
 * each beat, rises, curls and thins.
 */
export class SmokeEffect implements Effect<SmokeParams> {
  readonly id = 'smoke';
  readonly label = 'Smoke';
  readonly tune = TUNE;

  private state: PingPongState;
  private attractors = new Attractors();
  /** Source positions in view space (attractor wander, shifted down). Uniform value. */
  private sources = Array.from({ length: MAX_ATTRACTORS }, () => new THREE.Vector2());
  private aspect = 1;
  private dpr = 1;
  private needsInit = true;
  private beatPending = false;
  private beatUsed = false;
  private simTime = 0;
  private fieldShift = 0;
  private stepDt = 1 / 60;
  private noiseScale = 1;
  private colorK = Array.from({ length: MAX_ATTRACTORS }, () => new THREE.Vector3());
  private colorKey = '';
  private tmpColor = new THREE.Color();

  private simUniforms = {
    uStateA: { value: null as THREE.Texture | null },
    uStateB: { value: null as THREE.Texture | null },
    uStateC: { value: null as THREE.Texture | null },
    uFrame: { value: 0 },
    uDt: { value: 0 },
    uTime: { value: 0 },
    uAspect: { value: 1 },
    uInit: { value: false },
    uAttractors: { value: this.sources },
    uAttractorCount: { value: 1 },
    uNoiseScale: { value: 1 },
    uNoiseSpeed: { value: TUNE.noiseSpeed },
    uFieldShift: { value: 0 },
    uTurbulence: { value: 0 },
    uSettle: { value: TUNE.settle },
    uRelax: { value: 1 },
    uMaxSpeed: { value: TUNE.maxSpeed },
    uLifespan: { value: 8 },
    uRise: { value: 0 },
    uWiden: { value: 0 },
    uSpinDecay: { value: TUNE.spinDecay },
    uEmitChance: { value: 0 },
    uRingRadius: { value: TUNE.ringRadius },
    uEmitVel: { value: new THREE.Vector2() },
    uPuffChance: { value: 0 },
    uPuffStrength: { value: 0.5 },
    uPuffVel: { value: new THREE.Vector2() },
    uPuffLife: { value: 1 },
  };

  private trails = new SmokeTrails();
  private stepsSinceRender = 0;
  private scene = new THREE.Scene();
  private camera = new THREE.Camera();
  private geometry = new THREE.BufferGeometry();
  private material: THREE.RawShaderMaterial;
  private bufferSize = new THREE.Vector2();
  private uniforms = {
    uStateA: { value: null as THREE.Texture | null },
    uStateB: { value: null as THREE.Texture | null },
    uSize: { value: 1 },
    uAspect: { value: 1 },
    uViewPx: { value: new THREE.Vector2(1, 1) },
    uStepDt: { value: 1 / 60 },
    uInk: { value: 0.1 },
    uColorK: { value: this.colorK },
    uCool: { value: TUNE.cool },
    uFadeIn: { value: TUNE.fadeIn },
    uPuffInk: { value: TUNE.puffInk },
    uAttractors: { value: this.sources },
    uAttractorCount: { value: 1 },
    uKick: { value: 0 },
    uKickRadius: { value: 0.8 },
    uShiver: { value: 0 },
    uShiverScale: { value: 1 },
    uRTime: { value: 0 },
    uBreath: { value: 0 },
  };

  constructor(renderer: THREE.WebGLRenderer, params: Readonly<SmokeParams>) {
    this.state = new PingPongState(renderer, SMOKE_SIM_FRAG, this.simUniforms, 3, params.particleCount, 'smoke');
    this.material = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: SMOKE_POINTS_VERT,
      fragmentShader: SMOKE_POINTS_FRAG,
      uniforms: this.uniforms,
      transparent: true,
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneFactor,
      depthTest: false,
      depthWrite: false,
    });
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

  onParamChange(id: string, params: Readonly<SmokeParams>): void {
    if (id === 'particleCount') {
      this.state.allocate(params.particleCount);
      this.geometry.setDrawRange(0, 2 * params.particleCount);
      this.needsInit = true;
    } else if (id === 'mode') {
      // The density encoding (absorbance vs colour) changes with the mode.
      this.trails.clear();
    }
  }

  step({ dt, time, params, audio, renderer }: EffectContext<SmokeParams>): void {
    const T = this.tune;
    const u = this.simUniforms;
    const sdt = dt * params.speed;
    this.simTime += sdt;
    this.stepDt = sdt;
    const bass = audio.bass, mid = audio.mid, high = audio.high;
    const bs = audio.beatStrength;
    this.attractors.update(sdt, T.wander * (1 + T.bassSpeed * bass), this.aspect);
    for (let i = 0; i < MAX_ATTRACTORS; i++) {
      const a = this.attractors.positions[i];
      this.sources[i].set(a.x, a.y * T.ySpan + T.yOffset);
    }
    const count = Math.max(1, Math.min(MAX_ATTRACTORS, Math.round(params.emitters)));
    const relax = T.damping * (T.dragFloor + params.drag);
    this.noiseScale = params.turbulenceScale * T.noiseScale * (1 + T.highScale * high);

    u.uDt.value = sdt;
    u.uTime.value = this.simTime;
    u.uAspect.value = this.aspect;
    u.uAttractorCount.value = count;
    u.uNoiseScale.value = this.noiseScale;
    u.uNoiseSpeed.value = T.noiseSpeed;
    u.uTurbulence.value = params.turbulenceStrength * T.turbulence * (1 + T.midTurbulence * mid);
    u.uSettle.value = T.settle;
    u.uRelax.value = relax;
    u.uMaxSpeed.value = T.maxSpeed;
    u.uLifespan.value = params.lifespan;
    u.uRise.value = params.rise * T.rise;
    this.fieldShift += T.fieldRise * (params.rise * T.rise / relax) * sdt;
    u.uFieldShift.value = this.fieldShift;
    u.uWiden.value = params.rise * T.widen;
    u.uSpinDecay.value = T.spinDecay;
    u.uEmitChance.value = params.emissionRate * T.emit * (1 + T.bassEmission * bass) * sdt;
    u.uRingRadius.value = T.ringRadius;
    u.uEmitVel.value.set(T.emitVel[0], T.emitVel[1]);
    u.uPuffVel.value.set(T.puffVel[0], T.puffVel[1]);
    u.uPuffLife.value = T.puffLife;

    // Beat = puff at every source (one event per step; a beat in a frame with no step waits).
    const beatNow = (audio.beat && !this.beatUsed) || this.beatPending;
    if (audio.beat) this.beatUsed = true;
    this.beatPending = false;
    u.uPuffChance.value = 0;
    if (beatNow) {
      const st = Math.max(bs, 0.25);
      u.uPuffChance.value = params.burstSize * st * T.puff;
      u.uPuffStrength.value = st;
    }

    if (this.needsInit) {
      u.uInit.value = true;
      this.state.run(renderer);
      u.uInit.value = false;
      this.needsInit = false;
    } else {
      this.state.run(renderer);
    }

    const density = this.trails.densityTarget;
    if (density) {
      this.trails.prepare(renderer);
      this.renderParticles(renderer, params, density, audio, time);
      this.stepsSinceRender++;
    }
  }

  private renderParticles(
    renderer: THREE.WebGLRenderer, params: Readonly<SmokeParams>, target: THREE.WebGLRenderTarget,
    audio: Readonly<AudioFrame>, time: number,
  ): void {
    const T = this.tune;
    const u = this.uniforms;
    const high = audio.high, bass = audio.bass, bs = audio.beatStrength;
    u.uStateA.value = this.state.texture(0);
    u.uStateB.value = this.state.texture(1);
    u.uSize.value = this.state.size;
    u.uAspect.value = this.aspect;
    u.uViewPx.value.copy(this.bufferSize);
    u.uStepDt.value = this.stepDt;
    u.uInk.value = params.density * this.dpr * this.dpr * (1 + T.highInk * high);
    this.updateColors(params);
    u.uCool.value = T.cool;
    u.uFadeIn.value = T.fadeIn;
    u.uPuffInk.value = T.puffInk;
    u.uAttractorCount.value = Math.max(1, Math.min(MAX_ATTRACTORS, Math.round(params.emitters)));
    u.uKick.value = bs * T.kick * (0.5 + params.burstSize);
    u.uKickRadius.value = T.kickRadius;
    u.uShiver.value = bs > 0.01 ? bs * T.shiver * (0.5 + params.burstSize) : 0;
    u.uShiverScale.value = this.noiseScale * T.shiverScale;
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

  /** Per-source colour vector: absorbance (-ln sRGB) on light paper, the sRGB colour in dark mode. */
  private updateColors(params: Readonly<SmokeParams>): void {
    const hex = [params.smokeColor1, params.smokeColor2, params.smokeColor3];
    const key = params.mode + hex.join();
    if (key === this.colorKey) return;
    this.colorKey = key;
    const dark = params.mode === 'dark';
    const k = (x: number) => -Math.log(Math.min(1, Math.max(x, 0.01)));
    for (let i = 0; i < MAX_ATTRACTORS; i++) {
      // Raw shader output is not colour-managed: work on the sRGB values the swatch shows.
      const c = this.tmpColor.set(hex[i]).convertLinearToSRGB();
      if (dark) this.colorK[i].set(c.r, c.g, c.b);
      else this.colorK[i].set(k(c.r), k(c.g), k(c.b));
    }
  }

  render({ renderer, params, time, audio }: EffectContext<SmokeParams>): void {
    if (audio.beat && !this.beatUsed) this.beatPending = true;
    this.beatUsed = false;
    if (this.stepsSinceRender > 0) {
      this.trails.update(renderer, params, this.stepsSinceRender, this.dpr, time, audio.beatStrength);
      this.stepsSinceRender = 0;
    }
    this.trails.present(renderer, params, this.dpr, audio.beatStrength);
  }

  dispose(): void {
    this.state.dispose();
    this.trails.dispose();
    this.geometry.dispose();
    this.material.dispose();
  }
}

export const createSmokeEffect: EffectFactory = (r, p) => new SmokeEffect(r, p as Readonly<SmokeParams>);
