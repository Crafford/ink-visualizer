import * as THREE from 'three';
import type { Effect, EffectContext, EffectFactory, RenderSize } from '../types';
import type { AudioFrame } from '../../audio/types';
import { resolveSmokeMode, type ResolvedSmokeMode, type SmokeParams } from './params';
import { smokeSizeGain } from './SmokeTrails';
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
  /** Curl influence on ring smoke: fades in over noiseIn s of age to noiseFloor, 1 once dissolved. */
  noiseIn: 1.2,
  noiseFloor: 0.25,
  /** A ring starts dissolving at this fraction of its ring life. */
  dissolve: 0.45,
  /** Ring life (s): beat puff, stream ring. */
  puffRingLife: 3.2,
  streamRingLife: 1.8,
  /** Ring speed decay time constant (s) = ringDrag / (dragFloor + drag): 1.2 s at Drag 0.5. */
  ringDrag: 0.9,
  dragFloor: 0.25,
  /** Rise speed of slowed rings and haze (half-heights / s) per unit of Rise / (dragFloor + drag). */
  rise: 0.6,
  /** The curl field rises at this share of the rise speed (eddies are carried by the plume). */
  fieldRise: 0.5,
  /** Lateral spread rate (1/s) per unit of Rise once a ring has dissolved: plumes widen. */
  widen: 0.5,
  /** Ring geometry: R grows to R0 x rGrow, tube radius / R0 from tube[0] to tube[1] as it slows. */
  rGrow: 2.5,
  tube: [0.45, 1.2] as const,
  /** Gaussian cross-section of the tube, sigma in tube radii. */
  tubeSigma: 0.55,
  /** Poloidal roll: omega0 = roll x v0 / R0 at the tube core. */
  roll: 0.8,
  /** Outline wobble amplitude (fraction of R), two slow lobes. */
  wobble: 0.06,
  /** Ring axis: sideways tilt (deg) puff / stream, tilt toward the viewer (deg) min..max. */
  tiltDeg: [25, 10] as const,
  betaDeg: [50, 70] as const,
  /** Source wander phase rate (x Speed), as ink. Sources sit lower in the view: y -> y * ySpan + yOffset. */
  wander: 0.4,
  ySpan: 0.7,
  yOffset: -0.32,

  /** Stream: dormant wake-up rate per second at Emission 1 (all sources), ring cadence (s at
   *  Emission 0.5, shorter with more Emission), ring radius and speed. */
  emit: 0.15,
  streamInterval: [0.4, 0.8] as const,
  streamR0: 0.045,
  streamV0: 0.3,
  /** Beat puff: fraction of all particles at Burst 1, beat strength 1; ring radius at strength
   *  0.25..1, launch speed x (0.5 + strength), life multiplier. */
  puff: 0.15,
  puffR0: [0.075, 0.1] as const,
  puffV0: 1.1,
  puffLife: 0.6,
  /** Ink multiplier of puff smoke (it skips the stream's slow fade-in). */
  puffInk: 0.55,
  /** Ink multiplier of stream smoke. */
  streamInk: 0.4,
  /** Ink per particle gain (so Density 2.5 at Size 0 is the reference look). */
  inkGain: 5,

  /** Wash (haze) deposit weight of an intact ring; 1 once it has dissolved. */
  washYoung: 0.5,
  /** Longest splat segment per step, CSS px (no spokes from the fast edge of a ring). */
  maxSeg: 1,
  /** Cooling: ink per particle x (1 - age / life)^cool; fade in over fadeIn s. */
  cool: 1.6,
  fadeIn: 0.6,

  /** In-place beat response (render only), as ink; a small kick, the puff ring is the beat (a large kick smears rings radially). */
  kick: 0.04,
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
 * Smoke effect: smoke rings from 1-3 wandering sources.
 *
 * step():   sources wander (CPU), puff events from beats, one simulation pass on the GPU
 *           (shared PingPongState + SMOKE_SIM_FRAG), then particles are splatted additively
 *           into the density target (SmokeTrails).
 * render(): fold density into the line/wash trails (upward drift), composite (light paper or dark).
 *
 * Every particle belongs to a vortex ring (analytic model in sim.glsl): the steady stream is a
 * chain of small slow rings (CPU cadence per source), each beat blows a big ring at every source.
 * Rings travel, roll, slow, widen and thicken, then curl noise breaks them into haze.
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
    uStateD: { value: null as THREE.Texture | null },
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
    uNoiseIn: { value: TUNE.noiseIn },
    uNoiseFloor: { value: TUNE.noiseFloor },
    uDissolve: { value: TUNE.dissolve },
    uRingLife: { value: new THREE.Vector2() },
    uLifespan: { value: 8 },
    uRiseV: { value: 0 },
    uWiden: { value: 0 },
    uTau: { value: 1 },
    uRGrow: { value: TUNE.rGrow },
    uTube: { value: new THREE.Vector2() },
    uTubeSigma: { value: TUNE.tubeSigma },
    uRoll: { value: TUNE.roll },
    uWobble: { value: TUNE.wobble },
    uTilt: { value: new THREE.Vector2() },
    uBeta: { value: new THREE.Vector2() },
    uPuffChance: { value: 0 },
    uPuffStrength: { value: 0.5 },
    uPuffSeed: { value: [0, 0, 0] },
    uPuffR0: { value: new THREE.Vector2() },
    uPuffV0: { value: TUNE.puffV0 },
    uPuffLife: { value: 1 },
    uStreamChance: { value: [0, 0, 0] },
    uStreamSeed: { value: [0, 0, 0] },
    uStreamR0: { value: TUNE.streamR0 },
    uStreamV0: { value: TUNE.streamV0 },
  };
  /** Ring seeds (integers, hashed on the GPU into each ring's tilt and wobble) and stream cadence. */
  private ringSeed = 1;
  private streamAt = [0.1, 0.35, 0.6];
  private rng = 0x51f2a3;
  private resolvedMode: ResolvedSmokeMode = 'light';

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
    uStateD: { value: null as THREE.Texture | null },
    uTubeSigma: { value: TUNE.tubeSigma },
    uSize: { value: 1 },
    uAspect: { value: 1 },
    uViewPx: { value: new THREE.Vector2(1, 1) },
    uStepDt: { value: 1 / 60 },
    uInk: { value: 0.1 },
    uColorK: { value: this.colorK },
    uCool: { value: TUNE.cool },
    uFadeIn: { value: TUNE.fadeIn },
    uPuffInk: { value: TUNE.puffInk },
    uStreamInk: { value: TUNE.streamInk },
    uAttractors: { value: this.sources },
    uAttractorCount: { value: 1 },
    uKick: { value: 0 },
    uKickRadius: { value: 0.8 },
    uShiver: { value: 0 },
    uShiverScale: { value: 1 },
    uRTime: { value: 0 },
    uBreath: { value: 0 },
    uMaxSeg: { value: 2 },
    uRingLife: { value: new THREE.Vector2() },
    uDissolve: { value: TUNE.dissolve },
    uWashYoung: { value: TUNE.washYoung },
  };

  constructor(renderer: THREE.WebGLRenderer, params: Readonly<SmokeParams>) {
    this.state = new PingPongState(renderer, SMOKE_SIM_FRAG, this.simUniforms, 4, params.particleCount, 'smoke');
    this.resolvedMode = resolveSmokeMode(params.mode, params.background);
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
    } else if (id === 'mode' || id === 'background') {
      // The density encoding (absorbance vs colour) changes with the resolved mode.
      const m = resolveSmokeMode(params.mode, params.background);
      if (m !== this.resolvedMode) { this.resolvedMode = m; this.trails.clear(); }
    }
  }

  /** Uniform 0..1 from a small LCG (stream ring cadence only). */
  private rand(): number {
    this.rng = (Math.imul(this.rng, 1664525) + 1013904223) >>> 0;
    return this.rng / 4294967296;
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
    const dragK = T.dragFloor + params.drag;
    const riseV = params.rise * T.rise / dragK;
    this.noiseScale = params.turbulenceScale * T.noiseScale * (1 + T.highScale * high);
    const deg = Math.PI / 180;

    u.uDt.value = sdt;
    u.uTime.value = this.simTime;
    u.uAspect.value = this.aspect;
    u.uAttractorCount.value = count;
    u.uNoiseScale.value = this.noiseScale;
    u.uNoiseSpeed.value = T.noiseSpeed;
    u.uTurbulence.value = params.turbulenceStrength * T.turbulence * (1 + T.midTurbulence * mid);
    u.uNoiseIn.value = T.noiseIn;
    u.uNoiseFloor.value = T.noiseFloor;
    u.uDissolve.value = T.dissolve;
    u.uRingLife.value.set(T.puffRingLife, T.streamRingLife);
    u.uLifespan.value = params.lifespan;
    u.uRiseV.value = riseV;
    this.fieldShift += T.fieldRise * riseV * sdt;
    u.uFieldShift.value = this.fieldShift;
    u.uWiden.value = params.rise * T.widen;
    u.uTau.value = T.ringDrag / dragK;
    u.uRGrow.value = T.rGrow;
    u.uTube.value.set(T.tube[0], T.tube[1]);
    u.uTubeSigma.value = T.tubeSigma;
    u.uRoll.value = T.roll;
    u.uWobble.value = T.wobble;
    u.uTilt.value.set(T.tiltDeg[0] * deg, T.tiltDeg[1] * deg);
    u.uBeta.value.set(T.betaDeg[0] * deg, T.betaDeg[1] * deg);
    u.uPuffR0.value.set(T.puffR0[0], T.puffR0[1]);
    u.uPuffV0.value = T.puffV0;
    u.uPuffLife.value = T.puffLife;
    u.uStreamR0.value = T.streamR0;
    u.uStreamV0.value = T.streamV0;

    // Stream: each source emits a small ring on its own cadence (0.4-0.8 s at Emission 0.5).
    // Wake-up chance per ring = the per-second rate share of this source x the interval, so the
    // smoke supply still goes as Emission x (1 + 2 bass).
    const rate = params.emissionRate * T.emit * (1 + T.bassEmission * bass);
    for (let i = 0; i < MAX_ATTRACTORS; i++) {
      u.uStreamChance.value[i] = 0;
      if (i >= count || params.emissionRate <= 0) continue;
      if (this.simTime < this.streamAt[i]) continue;
      const interval = (T.streamInterval[0] + (T.streamInterval[1] - T.streamInterval[0]) * this.rand())
        * 1 / (0.5 + params.emissionRate);
      this.streamAt[i] = this.simTime + interval;
      u.uStreamChance.value[i] = Math.min(0.5, rate * interval / count);
      u.uStreamSeed.value[i] = this.ringSeed = (this.ringSeed + 1) % 0xffffff;
    }

    // Beat = puff at every source (one event per step; a beat in a frame with no step waits).
    const beatNow = (audio.beat && !this.beatUsed) || this.beatPending;
    if (audio.beat) this.beatUsed = true;
    this.beatPending = false;
    u.uPuffChance.value = 0;
    if (beatNow) {
      const st = Math.max(bs, 0.25);
      u.uPuffChance.value = params.burstSize * st * T.puff / count;
      u.uPuffStrength.value = st;
      for (let i = 0; i < MAX_ATTRACTORS; i++) u.uPuffSeed.value[i] = this.ringSeed = (this.ringSeed + 1) % 0xffffff;
    }

    if (this.needsInit) {
      u.uInit.value = true;
      this.state.run(renderer);
      u.uInit.value = false;
      this.needsInit = false;
    } else {
      this.state.run(renderer);
    }

    const density = this.trails.densityTarget(params.pointSize);
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
    u.uStateD.value = this.state.texture(3);
    u.uTubeSigma.value = T.tubeSigma;
    u.uSize.value = this.state.size;
    u.uAspect.value = this.aspect;
    u.uViewPx.value.set(target.width, target.height);
    u.uStepDt.value = this.stepDt;
    // Size below 1 px shrinks each particle's ink (a sub-pixel point), not its footprint.
    u.uInk.value = this.trails.densityInkScale(target) * params.density * T.inkGain * smokeSizeGain(params.pointSize) * this.dpr * this.dpr * (1 + T.highInk * high);
    this.updateColors(params);
    u.uCool.value = T.cool;
    u.uFadeIn.value = T.fadeIn;
    u.uPuffInk.value = T.puffInk;
    u.uStreamInk.value = T.streamInk;
    u.uAttractorCount.value = Math.max(1, Math.min(MAX_ATTRACTORS, Math.round(params.emitters)));
    u.uKick.value = bs * T.kick * (0.5 + params.burstSize);
    u.uKickRadius.value = T.kickRadius;
    u.uShiver.value = bs > 0.01 ? bs * T.shiver * (0.5 + params.burstSize) : 0;
    u.uShiverScale.value = this.noiseScale * T.shiverScale;
    u.uRTime.value = time;
    u.uBreath.value = bass * T.breath;
    u.uMaxSeg.value = T.maxSeg * this.dpr;
    u.uRingLife.value.set(T.puffRingLife, T.streamRingLife);
    u.uDissolve.value = T.dissolve;
    u.uWashYoung.value = T.washYoung;

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
    const mode = resolveSmokeMode(params.mode, params.background);
    const key = mode + hex.join();
    if (key === this.colorKey) return;
    this.colorKey = key;
    const dark = mode === 'dark';
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
