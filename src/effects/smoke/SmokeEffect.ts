import * as THREE from 'three';
import type { Effect, EffectContext, EffectFactory, RenderSize } from '../types';
import type { SmokeParams } from './params';
import { PingPongState } from '../shared/PingPongState';
import { SmokeLight } from './SmokeLight';
import { SMOKE_SIM_FRAG } from './shaders/sim.glsl';
import { SMOKE_DRAW_FRAG, SMOKE_DRAW_VERT } from './shaders/draw.glsl';

const lerp = (r: readonly [number, number], t: number) => r[0] + (r[1] - r[0]) * t;

/**
 * Fixed tuning: maps the panel params onto simulation units (view units: the view is 2 tall,
 * y -1..1; seconds). Reachable as `stage.effect.tune` with ?debug.
 */
const TUNE = {
  /** Smoke source. Only 'point' exists for now; `width` is the spawn radius (x and z), so a
   *  wide source (smoke machine, fire) is a setting later, not a rebuild. y: 8% from the bottom. */
  source: { kind: 'point' as 'point', width: 0.004, x: 0, y: -0.84 },
  /** Particles per strand (Detail / strandLen strands), Catmull-Rom sub-segments per piece. */
  strandLen: 128,
  subdiv: 3,
  /** Launch speed (up). */
  v0: 0.1,
  /** Buoyant acceleration per unit of Rise; terminal rise speed = buoy / drag. */
  buoy: 1.0,
  /** Buoyancy x (1 + lift) at height 1; buoyancy lost by the end of life (cooling). */
  lift: 0.35,
  cool: 0.85,
  /** Drag (1/s) over Resistance 0..1. */
  drag: [0.25, 3.25] as [number, number],
  /** Air coupling = drag / (drag + coupleK): low resistance stretches, high follows every curl. */
  coupleK: 0.6,
  /** Curl velocity over Turbulence 0..1, second octave weight, and the height where the curl
   *  is fully on (breakup point). */
  turb: [0.01, 0.3] as [number, number],
  octave2: 0.15,
  /** Depth frequency of the curl field relative to x/y (low = sheets fold together). */
  zScale: 0.3,
  onset: [1.6, 0.35] as [number, number],
  /** The curl field rises at this share of the terminal rise speed; evolves at `evolve` /s. */
  fieldRise: 0.7,
  evolve: 0.1,
  /** Breeze speed at Breeze 1 (view units / s, at height ~1). */
  breeze: 0.25,
  /** Outward spread speed (column widening), reached over spreadH of height. */
  spread: 0.06,
  spreadH: 1.0,
  /** Strands spawn on a ring (radius fraction ring..1 of the source width): a tube wall. */
  ring: 0.75,
  /** Fade in over this height above the source; fade out over the last (1 - fadeOut) of life. */
  fadeH: 0.25,
  fadeOut: 0.6,
  /** A strand piece longer than this (view units) has torn: its light falls off as 1 / (1 + (len / stretch)^2). */
  stretch: 0.04,
  /** Light per particle at Brightness 1, 300k particles, 900 device px tall, Size 1. */
  energy: 0.5,
  refCount: 300000,
  refHeight: 900,

  // Audio
  /** Surge envelope: attack and decay time constants (s), and what it multiplies (x Surge):
   *  launch speed, birth intensity, source width. The smoke near the source is slow, so the
   *  envelope must be a smooth bump (~0.5 s): a fast attack maps onto a hard edge in the column. */
  surgeAttack: 0.25,
  surgeTau: 0.35,
  surgeV0: 1.5,
  /** The source widens with the surge (spawn radius x (1 + k surge)): more smoke, a visible packet; launched straight up. */
  surgeWidth: 2,
  surgeBright: 4,
  /** Bass (continuous): emission brightness at the base x (1 + k bass). */
  bassBright: 0.4,
  /** Mid: turbulence x (1 + k mid), breakup height / (1 + k mid). */
  midTurb: 0.6,
  midOnset: 0.4,
  /** High: fine curl octave (3.3x the base frequency, the finest the strands resolve) amplitude per unit of high. */
  high: 0.03,
  /** Beats above `gustMin` strength add a sideways breath (view units / s x strength x Surge), decays gustTau s. */
  gust: 0.12,
  gustMin: 0.6,
  gustTau: 1.5,
};

/**
 * Smoke: a single invisible point source and a buoyant column that is laminar at the source and
 * turbulent higher up (curl noise whose influence grows with height). Own machinery: particle
 * state organised as strands (streaklines, PingPongState with three attachments, see
 * shaders/sim.glsl), a strand renderer (shaders/draw.glsl) and a light buffer + composite
 * (SmokeLight).
 *
 * step():   emission phase + audio (CPU), one simulation pass.
 * render(): draw every strand into the light buffer, composite it to the screen.
 */
export class SmokeEffect implements Effect<SmokeParams> {
  readonly id = 'smoke';
  readonly label = 'Smoke';
  readonly tune = TUNE;

  private state: PingPongState;
  readonly light: SmokeLight;
  private aspect = 1;
  private dpr = 1;
  private bufferSize = new THREE.Vector2();
  private needsInit = true;
  private count = 0;
  private strandLen = TUNE.strandLen;

  private simTime = 0;
  private phase = 0;
  private fieldY = 0;
  private fieldZ = 0;
  private surge = 0;
  private surgeTarget = 0;
  private gust = 0;
  private gustSign = 1;
  private beatPending = false;
  private beatUsed = false;

  private simUniforms = {
    uStateA: { value: null as THREE.Texture | null },
    uStateB: { value: null as THREE.Texture | null },
    uStateC: { value: null as THREE.Texture | null },
    uFrame: { value: 0 },
    uInit: { value: false },
    uDt: { value: 0 },
    uTime: { value: 0 },
    uSize: { value: 1 },
    uStrandLen: { value: TUNE.strandLen },
    uSource: { value: new THREE.Vector3() },
    uSourceWidth: { value: 0 },
    uFirst: { value: 0 },
    uNum: { value: 0 },
    uOffset: { value: 1 },
    uDPhase: { value: 0 },
    uV0: { value: 0 },
    uBirthGain: { value: 1 },
    uBoost: { value: 0 },
    uBuoy: { value: 0 },
    uLift: { value: 0 },
    uCool: { value: 0 },
    uLifespan: { value: 8 },
    uDrag: { value: 1 },
    uCouple: { value: 1 },
    uTurb: { value: 0 },
    uOctave2: { value: 0 },
    uFreq: { value: 1 },
    uOnset: { value: 1 },
    uField: { value: new THREE.Vector3() },
    uHigh: { value: 0 },
    uBreeze: { value: 0 },
    uSpread: { value: 0 },
    uSpreadH: { value: 1 },
    uZScale: { value: 1 },
    uRing: { value: 1 },
  };

  private scene = new THREE.Scene();
  private camera = new THREE.Camera();
  private geometry = new THREE.BufferGeometry();
  private material: THREE.RawShaderMaterial;
  private drawUniforms = {
    uStateA: { value: null as THREE.Texture | null },
    uStateB: { value: null as THREE.Texture | null },
    uStateC: { value: null as THREE.Texture | null },
    uSize: { value: 1 },
    uStrandLen: { value: TUNE.strandLen },
    uSub: { value: TUNE.subdiv },
    uAspect: { value: 1 },
    uViewPx: { value: new THREE.Vector2(1, 1) },
    uWidth: { value: 1 },
    uEnergy: { value: 0 },
    uLifespan: { value: 8 },
    uSourceY: { value: TUNE.source.y },
    uFadeH: { value: TUNE.fadeH },
    uFadeOut: { value: TUNE.fadeOut },
    uStretch: { value: 1 },
  };

  constructor(renderer: THREE.WebGLRenderer, params: Readonly<SmokeParams>) {
    this.state = new PingPongState(renderer, SMOKE_SIM_FRAG, this.simUniforms, 3, 1, 'smoke');
    this.allocate(params.smokeDetail);
    this.light = new SmokeLight(renderer);
    this.material = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: SMOKE_DRAW_VERT,
      fragmentShader: SMOKE_DRAW_FRAG,
      uniforms: this.drawUniforms,
      transparent: true,
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneFactor,
      depthTest: false,
      depthWrite: false,
    });
    const mesh = new THREE.Mesh(this.geometry, this.material);
    mesh.frustumCulled = false;
    this.scene.add(mesh);
    this.setDrawRange();
  }

  /** Whole strands only: count = strands x strandLen. */
  private allocate(detail: number): void {
    this.strandLen = this.tune.strandLen;
    const strands = Math.max(1, Math.round(detail / this.strandLen));
    this.count = strands * this.strandLen;
    this.state.allocate(this.count);
    this.needsInit = true;
  }

  /** No attributes: six vertices per sub-segment, uSub per particle; gl_VertexID does the rest. */
  private setDrawRange(): void {
    this.geometry.setDrawRange(0, 6 * this.tune.subdiv * this.count);
  }

  resize(size: Readonly<RenderSize>, renderer: THREE.WebGLRenderer): void {
    this.aspect = size.width / Math.max(1, size.height);
    this.dpr = size.dpr;
    renderer.getDrawingBufferSize(this.bufferSize);
    this.light.resize(this.bufferSize.x, this.bufferSize.y);
  }

  onParamChange(id: string, params: Readonly<SmokeParams>): void {
    if (id !== 'smokeDetail') return;
    this.allocate(params.smokeDetail);
    this.setDrawRange();
  }

  step({ dt, params, audio, renderer }: EffectContext<SmokeParams>): void {
    const T = this.tune;
    const u = this.simUniforms;
    this.simTime += dt;
    const bass = audio.bass, mid = audio.mid, high = audio.high;
    const surgeAmt = params.burstSize;

    // Beat: one event per step (a beat in a frame with no step waits for the next one).
    const beatNow = (audio.beat && !this.beatUsed) || this.beatPending;
    if (audio.beat) this.beatUsed = true;
    this.beatPending = false;
    this.surgeTarget *= Math.exp(-dt / T.surgeTau);
    this.gust *= Math.exp(-dt / T.gustTau);
    if (beatNow) {
      const bs = Math.max(audio.beatStrength, 0.25);
      this.surgeTarget = Math.max(this.surgeTarget, bs);
      if (bs >= T.gustMin) {
        this.gustSign = -this.gustSign;
        this.gust += this.gustSign * T.gust * bs * surgeAmt;
      }
    }
    this.surge += (this.surgeTarget - this.surge) * (1 - Math.exp(-dt / T.surgeAttack));
    const surge = this.surge * surgeAmt;

    if (this.needsInit) {
      // A fresh start (first step, Detail change): the smoke restarts from an empty view.
      this.simTime = dt;
      this.fieldY = this.fieldZ = 0;
      this.surge = this.surgeTarget = this.gust = 0;
      this.phase = 0;
      u.uSource.value.set(T.source.x, T.source.y, 0);
      u.uSize.value = this.state.size;
      u.uInit.value = true;
      this.state.run(renderer);
      u.uInit.value = false;
      this.needsInit = false;
    }

    // Emission: every strand emits its next slot every lifespan / M seconds, so a slot is
    // reborn after exactly one lifespan.
    const life = params.smokeLifespan;
    const M = this.strandLen;
    const dPhase = M * dt / life;
    const start = this.phase, end = start + dPhase;
    const first = Math.floor(start) + 1;
    u.uFirst.value = first % M;
    u.uNum.value = Math.min(M, Math.floor(end) - Math.floor(start));
    u.uOffset.value = first - start;
    u.uDPhase.value = dPhase;
    this.phase = end % M;

    const drag = lerp(T.drag, params.smokeResistance);
    const buoy = params.smokeRise * T.buoy;
    this.fieldY += T.fieldRise * (buoy / drag) * dt;
    this.fieldZ += T.evolve * dt;
    // Breeze: a slow, mostly one-sided current (low-frequency sines in time) + beat gusts.
    const tt = this.simTime;
    const wind = 0.25 + 0.6 * Math.sin(0.043 * tt + 0.7) + 0.4 * Math.sin(0.11 * tt + 2.1);

    u.uDt.value = dt;
    u.uTime.value = tt;
    u.uSize.value = this.state.size;
    u.uStrandLen.value = M;
    u.uSource.value.set(T.source.x, T.source.y, 0);
    u.uSourceWidth.value = T.source.width * (1 + T.surgeWidth * surge);
    u.uV0.value = T.v0 * (1 + T.surgeV0 * surge);
    // Amount = how much smoke the source gives off: light carried per particle.
    u.uBirthGain.value = params.smokeAmount * 2 * (1 + T.bassBright * bass) * (1 + T.surgeBright * surge);
    u.uBoost.value = Math.min(1, surge + 0.3 * bass);
    u.uBuoy.value = buoy;
    u.uLift.value = T.lift;
    u.uCool.value = T.cool;
    u.uLifespan.value = life;
    u.uDrag.value = drag;
    u.uCouple.value = drag / (drag + T.coupleK);
    u.uTurb.value = lerp(T.turb, params.smokeTurbulence) * (1 + T.midTurb * mid);
    u.uOctave2.value = T.octave2;
    u.uFreq.value = params.smokeSwirl;
    u.uOnset.value = lerp(T.onset, params.smokeTurbulence) / (1 + T.midOnset * mid);
    u.uField.value.set(0, this.fieldY, this.fieldZ);
    u.uHigh.value = T.high * high;
    u.uBreeze.value = params.smokeBreeze * T.breeze * wind + this.gust;
    u.uSpread.value = T.spread;
    u.uSpreadH.value = T.spreadH;
    u.uZScale.value = T.zScale;
    u.uRing.value = T.ring;
    this.state.run(renderer);
  }

  private draw(renderer: THREE.WebGLRenderer, params: Readonly<SmokeParams>): void {
    const target = this.light.target;
    if (!target) return;
    const T = this.tune;
    const d = this.drawUniforms;
    d.uStateA.value = this.state.texture(0);
    d.uStateB.value = this.state.texture(1);
    d.uStateC.value = this.state.texture(2);
    d.uSize.value = this.state.size;
    d.uStrandLen.value = this.strandLen;
    d.uSub.value = T.subdiv;
    d.uAspect.value = this.aspect;
    d.uViewPx.value.set(target.width, target.height);
    // Size in CSS px; light per particle ~ sqrt(Size) (thin filaments dimmer, thick ones spread),
    // x (300k / N) so Detail changes smoothness, not brightness, and x (height / 900)^2 so the
    // look holds at any resolution and dpr.
    d.uWidth.value = params.smokeSize * this.dpr;
    const hScale = target.height / T.refHeight;
    d.uEnergy.value = params.smokeBrightness * T.energy * (T.refCount / this.count) * hScale * hScale * Math.sqrt(params.smokeSize);
    d.uLifespan.value = params.smokeLifespan;
    d.uSourceY.value = T.source.y;
    d.uFadeH.value = T.fadeH;
    d.uFadeOut.value = T.fadeOut;
    d.uStretch.value = T.stretch * 0.5 * target.height;

    const prevTarget = renderer.getRenderTarget();
    const prevAutoClear = renderer.autoClear;
    renderer.autoClear = false;
    this.light.begin(renderer);
    renderer.render(this.scene, this.camera);
    renderer.setRenderTarget(prevTarget);
    renderer.autoClear = prevAutoClear;
  }

  render({ renderer, params, audio }: EffectContext<SmokeParams>): void {
    if (audio.beat && !this.beatUsed) this.beatPending = true;
    this.beatUsed = false;
    if (!this.needsInit) this.draw(renderer, params);
    this.light.present(renderer);
  }

  dispose(): void {
    this.state.dispose();
    this.light.dispose();
    this.geometry.dispose();
    this.material.dispose();
  }
}

export const createSmokeEffect: EffectFactory = (r, p) => new SmokeEffect(r, p as Readonly<SmokeParams>);
