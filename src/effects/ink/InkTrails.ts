import * as THREE from 'three';
import type { InkParams } from './params';
import { DensityTargets } from '../shared/subpixel';
import { FullscreenPass } from '../shared/FullscreenPass';
import { MAX_ATTRACTORS } from '../shared/shaders/fullscreen.glsl';
import { BLUR_H_FRAG, BLUR_V_FRAG, COMPOSITE_FRAG } from './shaders/trail.glsl';

/** Look tuning that is not exposed in the panel. */
export const LOOK = {
  /** Trail -> optical density gain (ink = 1 - exp(-(line + wash * w) * exposure)). */
  exposure: 1,
  /** Wash gain in the composite (initial slope relative to the line channel). */
  wash: 0.3,
  /** Darkest the wash alone can get (0..1 ink coverage). */
  washMax: 0.5,
  /** Line channel blur per step, CSS px: just enough to melt single points into strokes. */
  lineBlur: 0.6,
  /** Wash memory relative to line memory: washFade = 1 - (1 - trailFade) * washFadeRatio. */
  washFadeRatio: 0.22,
  /** Wetness table [dry, wet]: dry = little halo, crisp edge; wet = wide soft bloom, drift.
   *  Blur, wash gain, drift and line blur are multipliers; washFadeRatio replaces the base. */
  wetWashBlur: [0.3, 1.2] as readonly [number, number],
  wetWashGain: [0.5, 0.65] as readonly [number, number],
  wetDrift: [0.15, 1] as readonly [number, number],
  wetWashFadeRatio: [0.6, 0.25] as readonly [number, number],
  wetLineBlur: [1.3, 2.6] as readonly [number, number],
  /** Pivot of the contrast S-curve, in ink coverage (0 paper .. 1 ink). */
  pivot: 0.42,
  /** Paper texture: +-amplitude around the paper colour, feature size in CSS px. */
  paperTex: 0.01,
  paperFeature: 260,
  /** Beat swell: wash gain x (1 + beatStrength * washBeat), wash blur x (1 + bs * washBlurBeat). */
  washBeat: 1.2,
  washBlurBeat: 0.8,
  /** trailDrift (px per step) -> device px per step. */
  driftGain: 2,
  /** Line deposit gain = pointSize ^ pointSizeGain (darkness compensation for thicker lines). */
  pointSizeGain: 0.6,
};

const BLACK = new THREE.Color(0, 0, 0);
const lerp = (r: readonly [number, number], t: number) => r[0] + (r[1] - r[0]) * t;

/**
 * Density, trail feedback and composite for the ink effect.
 *
 *   density (RGBA16F): particles splatted additively, once per simulation step, cleared
 *                   after each trail update, so trails are continuous even when one display
 *                   frame covers several steps. rgb = ink * absorbance of its colour, a = ink.
 *   temp    (2 x RGBA16F, MRT): horizontal blur of the previous trail (+ drift on the wash).
 *   trail A/B (2 x RGBA16F, MRT, ping-pong): blurV(temp) * fade + density;
 *                   attachment 0 = line, 1 = wash (see shaders/trail.glsl.ts).
 *   screen: coverage, contrast, ink mixture, paper/ink mix, grain.
 *
 * Panel mapping: trailFade = line memory (wash memory derived, longer), trailBlur = wash
 * spread per step, trailDrift = wash drift per step (x LOOK.driftGain), pointSize = line
 * thickness (line blur x pointSize, line deposit x pointSize^0.6 so darkness roughly holds).
 * wetness scales wash blur, gain, drift and memory and the line blur (LOOK.wet* tables).
 *
 * Fade, blur and drift are applied per simulation step (pow(fade, n), sigma * sqrt(n),
 * drift * n), so the look does not depend on the display refresh rate.
 */
export class InkTrails {
  /** Tuning table, read every frame (reachable from the console via ?debug for look work). */
  readonly look = LOOK;
  private density = new DensityTargets(1);
  private temp: THREE.WebGLRenderTarget | null = null;
  private trails: [THREE.WebGLRenderTarget, THREE.WebGLRenderTarget] | null = null;
  private cur = 0;
  private needsClear = true;
  private width = 0;
  private dpr = 1;
  private height = 0;
  private frame = 0;
  private prevClear = new THREE.Color();
  private paperHex = '';

  private blurH = new FullscreenPass(BLUR_H_FRAG, {
    uLine: { value: null as THREE.Texture | null },
    uWash: { value: null as THREE.Texture | null },
    uTexel: { value: new THREE.Vector2() },
    uSigmaLine: { value: 0 },
    uSigmaWash: { value: 0 },
    uAttractors: { value: Array.from({ length: MAX_ATTRACTORS }, () => new THREE.Vector2()) },
    uAttractorCount: { value: 1 },
    uAspect: { value: 1 },
    uDrift: { value: 0 },
    uTime: { value: 0 },
  });
  private blurV = new FullscreenPass(BLUR_V_FRAG, {
    uLine: { value: null as THREE.Texture | null },
    uWash: { value: null as THREE.Texture | null },
    uTexel: { value: new THREE.Vector2() },
    uSigmaLine: { value: 0 },
    uSigmaWash: { value: 0 },
    uDensity: { value: null as THREE.Texture | null },
    uDensityHalf: { value: null as THREE.Texture | null },
    uFade: { value: new THREE.Vector2(1, 1) },
    uLineGain: { value: 1 },
    ...DensityTargets.uniforms(),
  });
  private composite = new FullscreenPass(COMPOSITE_FRAG, {
    uLine: { value: null as THREE.Texture | null },
    uWash: { value: null as THREE.Texture | null },
    uExposure: { value: LOOK.exposure },
    uWashGain: { value: LOOK.wash },
    uWashMax: { value: LOOK.washMax },
    uContrast: { value: 1 },
    uPivot: { value: LOOK.pivot },
    uPaper: { value: new THREE.Color() },
    uGrain: { value: 0 },
    uGrainCell: { value: 1 },
    uPaperTex: { value: LOOK.paperTex },
    uPaperScale: { value: 1 / LOOK.paperFeature },
    uFrame: { value: 0 },
  });

  /** The target particles of this Size are splatted into (half-res below 0.5 px). Null before the first resize. */
  densityTarget(size: number): THREE.WebGLRenderTarget | null { return this.trails ? this.density.pick(size) : null; }

  /** Ink multiplier for splatting into `target` (texel area relative to the full-res target). */
  densityInkScale(target: THREE.WebGLRenderTarget): number { return this.density.inkScale(target); }

  /** Reallocate every target at the drawing-buffer size. Trails restart empty. */
  resize(width: number, height: number, dpr = 1): void {
    width = Math.max(1, Math.round(width));
    height = Math.max(1, Math.round(height));
    if (width === this.width && height === this.height && dpr === this.dpr && this.trails) return;
    this.dpr = dpr;
    this.disposeTargets();
    this.width = width;
    this.height = height;
    const opts: THREE.RenderTargetOptions = {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      wrapS: THREE.ClampToEdgeWrapping,
      wrapT: THREE.ClampToEdgeWrapping,
      generateMipmaps: false,
      depthBuffer: false,
      stencilBuffer: false,
    };
    const make = (count: number) => new THREE.WebGLRenderTarget(width, height, { ...opts, format: THREE.RGBAFormat, count });
    this.density.allocate(width, height, dpr);
    this.temp = make(2);
    this.trails = [make(2), make(2)];
    this.cur = 0;
    this.needsClear = true;
  }

  /** Clear the trails and density (first frame after allocation or on demand). */
  private clearAll(renderer: THREE.WebGLRenderer): void {
    renderer.getClearColor(this.prevClear);
    const prevAlpha = renderer.getClearAlpha();
    renderer.setClearColor(BLACK, 0);
    for (const t of [this.temp!, this.trails![0], this.trails![1]]) {
      renderer.setRenderTarget(t);
      renderer.clear(true, false, false);
    }
    renderer.setClearColor(this.prevClear, prevAlpha);
    this.density.clear(renderer, true);
    this.needsClear = false;
  }

  /** Call before splatting into the density target, so a fresh target starts at zero. */
  prepare(renderer: THREE.WebGLRenderer): void {
    if (this.needsClear && this.trails) this.clearAll(renderer);
  }

  /**
   * Fold the density accumulated over `steps` simulation steps into the trail.
   * attractors are in view space (x in [-aspect, aspect], y in [-1, 1]).
   */
  update(
    renderer: THREE.WebGLRenderer, params: Readonly<InkParams>, steps: number, dpr: number, time: number,
    attractors: readonly THREE.Vector2[], attractorCount: number, beatStrength: number,
  ): void {
    if (!this.trails || steps <= 0) return;
    const prevAutoClear = renderer.autoClear;
    const prevTarget = renderer.getRenderTarget();
    renderer.autoClear = false;
    if (this.needsClear) this.clearAll(renderer);

    const read = this.trails[this.cur];
    const write = this.trails[1 - this.cur];
    const aspect = this.width / this.height;
    const rootSteps = Math.sqrt(steps);
    const L = this.look, wet = params.wetness;
    const sigmaLine = L.lineBlur * lerp(L.wetLineBlur, wet) * params.pointSize * dpr * rootSteps;
    const sigmaWash = params.trailBlur * lerp(L.wetWashBlur, wet) * (1 + beatStrength * L.washBlurBeat) * dpr * rootSteps;
    const washFade = 1 - (1 - params.trailFade) * lerp(L.wetWashFadeRatio, wet);

    const h = this.blurH.uniforms;
    h.uLine.value = read.textures[0];
    h.uWash.value = read.textures[1];
    h.uTexel.value.set(1 / this.width, 1 / this.height);
    h.uSigmaLine.value = sigmaLine;
    h.uSigmaWash.value = sigmaWash;
    h.uAspect.value = aspect;
    h.uDrift.value = params.trailDrift * L.driftGain * lerp(L.wetDrift, wet) * dpr * steps;
    h.uTime.value = time;
    h.uAttractorCount.value = Math.max(1, Math.min(MAX_ATTRACTORS, attractorCount));
    for (let i = 0; i < MAX_ATTRACTORS; i++) {
      const a = attractors[i];
      // view space -> uv
      if (a) h.uAttractors.value[i].set(a.x / aspect * 0.5 + 0.5, a.y * 0.5 + 0.5);
    }
    this.blurH.render(renderer, this.temp);

    const v = this.blurV.uniforms;
    v.uLine.value = this.temp!.textures[0];
    v.uWash.value = this.temp!.textures[1];
    // Thicker strokes spread the same ink wider: compensate, but sub-linearly, because dense
    // areas (cores) are not diluted by blur and would otherwise get much darker.
    v.uLineGain.value = Math.pow(params.pointSize, this.look.pointSizeGain);
    v.uTexel.value.set(1 / this.width, 1 / this.height);
    v.uSigmaLine.value = sigmaLine;
    v.uSigmaWash.value = sigmaWash;
    this.density.bind(v, params.pointSize, [['uDensity', 'uDensityHalf']]);
    v.uFade.value.set(Math.pow(params.trailFade, steps), Math.pow(washFade, steps));
    this.blurV.render(renderer, write);
    this.cur = 1 - this.cur;

    // Density has been consumed.
    this.density.clear(renderer);

    renderer.setRenderTarget(prevTarget);
    renderer.autoClear = prevAutoClear;
  }

  /** Composite the current trail to the default framebuffer. */
  present(renderer: THREE.WebGLRenderer, params: Readonly<InkParams>, dpr: number, beatStrength: number): void {
    if (!this.trails) return;
    const c = this.composite.uniforms;
    c.uLine.value = this.trails[this.cur].textures[0];
    c.uWash.value = this.trails[this.cur].textures[1];
    c.uContrast.value = params.contrast;
    c.uExposure.value = this.look.exposure;
    c.uWashGain.value = this.look.wash * lerp(this.look.wetWashGain, params.wetness) * (1 + beatStrength * this.look.washBeat);
    c.uWashMax.value = this.look.washMax;
    c.uPivot.value = this.look.pivot;
    c.uPaperTex.value = this.look.paperTex;
    c.uGrain.value = params.grain;
    c.uGrainCell.value = dpr;
    c.uPaperScale.value = 1 / (this.look.paperFeature * dpr);
    c.uFrame.value = this.frame = (this.frame + 1) >>> 0;
    // Raw shader output is not colour-managed: feed sRGB values to match the swatches.
    // Parse only on change (Color.set(string) allocates).
    if (params.paperColor !== this.paperHex) { this.paperHex = params.paperColor; c.uPaper.value.set(this.paperHex).convertLinearToSRGB(); }

    const prevAutoClear = renderer.autoClear;
    renderer.autoClear = false;
    this.composite.render(renderer, null);
    renderer.autoClear = prevAutoClear;
  }

  private disposeTargets(): void {
    this.density.dispose();
    this.temp?.dispose();
    this.trails?.[0].dispose();
    this.trails?.[1].dispose();
    this.temp = null;
    this.trails = null;
  }

  dispose(): void {
    this.disposeTargets();
    this.blurH.dispose();
    this.blurV.dispose();
    this.composite.dispose();
  }
}
