import * as THREE from 'three';
import type { SmokeParams } from './params';
import { FullscreenPass } from '../shared/FullscreenPass';
import { SMOKE_BLUR_H_FRAG, SMOKE_BLUR_V_FRAG, SMOKE_COMPOSITE_FRAG } from './shaders/trail.glsl';

type Range = readonly [number, number];
const lerp = (r: Range, t: number) => r[0] + (r[1] - r[0]) * t;

/** Smoke look tuning that is not exposed in the panel. [a, b] pairs are lerped by a param. */
export const SMOKE_LOOK = {
  exposure: 1,
  /** Line layer memory per step and blur (CSS px) by Softness. */
  lineFade: 0.82,
  lineBlur: [0.5, 3] as Range,
  /** Wash memory per step, blur (CSS px) and gain by Haze. */
  washFade: 0.975,
  washBlur: [0.6, 3.5] as Range,
  washGain: [0.1, 0.8] as Range,
  /** Light paper: darkest the wash alone can get. */
  washMax: 0.55,
  /** Wash drift upward, CSS px per step (warm air). */
  drift: 0.35,
  pivot: 0.42,
  paperTex: 0.01,
  paperFeature: 260,
  /** Beat swell: wash gain x (1 + bs * washBeat), wash blur x (1 + bs * washBlurBeat). */
  washBeat: 1.2,
  washBlurBeat: 0.8,
};

const BLACK = new THREE.Color(0, 0, 0);

/**
 * Density, trail feedback and composite for the smoke effect (InkTrails' structure, own
 * shaders): density splat target, MRT line + wash ping-pong, upward wash drift, and a light
 * paper (subtractive) or dark (additive) composite. The density rgb encoding depends on the
 * mode, so the trails are cleared when the mode changes (clear()).
 */
export class SmokeTrails {
  readonly look = SMOKE_LOOK;
  private density: THREE.WebGLRenderTarget | null = null;
  private temp: THREE.WebGLRenderTarget | null = null;
  private trails: [THREE.WebGLRenderTarget, THREE.WebGLRenderTarget] | null = null;
  private cur = 0;
  private needsClear = true;
  private width = 0;
  private height = 0;
  private frame = 0;
  private prevClear = new THREE.Color();
  private bgHex = '';

  private blurH = new FullscreenPass(SMOKE_BLUR_H_FRAG, {
    uLine: { value: null as THREE.Texture | null },
    uWash: { value: null as THREE.Texture | null },
    uTexel: { value: new THREE.Vector2() },
    uSigmaLine: { value: 0 },
    uSigmaWash: { value: 0 },
    uAspect: { value: 1 },
    uDrift: { value: 0 },
    uTime: { value: 0 },
  });
  private blurV = new FullscreenPass(SMOKE_BLUR_V_FRAG, {
    uLine: { value: null as THREE.Texture | null },
    uWash: { value: null as THREE.Texture | null },
    uTexel: { value: new THREE.Vector2() },
    uSigmaLine: { value: 0 },
    uSigmaWash: { value: 0 },
    uDensity: { value: null as THREE.Texture | null },
    uFade: { value: new THREE.Vector2(1, 1) },
  });
  private composite = new FullscreenPass(SMOKE_COMPOSITE_FRAG, {
    uLine: { value: null as THREE.Texture | null },
    uWash: { value: null as THREE.Texture | null },
    uDark: { value: false },
    uExposure: { value: 1 },
    uWashGain: { value: 0.3 },
    uWashMax: { value: 0.5 },
    uContrast: { value: 1 },
    uPivot: { value: 0.42 },
    uBackground: { value: new THREE.Color() },
    uGrain: { value: 0 },
    uGrainCell: { value: 1 },
    uPaperTex: { value: 0 },
    uPaperScale: { value: 1 },
    uFrame: { value: 0 },
  });

  get densityTarget(): THREE.WebGLRenderTarget | null { return this.density; }

  resize(width: number, height: number): void {
    width = Math.max(1, Math.round(width));
    height = Math.max(1, Math.round(height));
    if (width === this.width && height === this.height && this.trails) return;
    this.disposeTargets();
    this.width = width;
    this.height = height;
    const make = (count: number) => new THREE.WebGLRenderTarget(width, height, {
      type: THREE.HalfFloatType, format: THREE.RGBAFormat, count,
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
      wrapS: THREE.ClampToEdgeWrapping, wrapT: THREE.ClampToEdgeWrapping,
      generateMipmaps: false, depthBuffer: false, stencilBuffer: false,
    });
    this.density = make(1);
    this.temp = make(2);
    this.trails = [make(2), make(2)];
    this.cur = 0;
    this.needsClear = true;
  }

  /** Empty the trails before the next splat (mode change). */
  clear(): void { this.needsClear = true; }

  private clearAll(renderer: THREE.WebGLRenderer): void {
    renderer.getClearColor(this.prevClear);
    const prevAlpha = renderer.getClearAlpha();
    renderer.setClearColor(BLACK, 0);
    for (const t of [this.density!, this.temp!, this.trails![0], this.trails![1]]) {
      renderer.setRenderTarget(t);
      renderer.clear(true, false, false);
    }
    renderer.setClearColor(this.prevClear, prevAlpha);
    this.needsClear = false;
  }

  prepare(renderer: THREE.WebGLRenderer): void {
    if (this.needsClear && this.trails) {
      const prev = renderer.getRenderTarget();
      this.clearAll(renderer);
      renderer.setRenderTarget(prev);
    }
  }

  /** Fold the density accumulated over `steps` simulation steps into the trail. */
  update(
    renderer: THREE.WebGLRenderer, params: Readonly<SmokeParams>, steps: number, dpr: number, time: number,
    beatStrength: number,
  ): void {
    if (!this.trails || steps <= 0) return;
    const prevAutoClear = renderer.autoClear;
    const prevTarget = renderer.getRenderTarget();
    renderer.autoClear = false;
    if (this.needsClear) this.clearAll(renderer);

    const read = this.trails[this.cur];
    const write = this.trails[1 - this.cur];
    const L = this.look;
    const rootSteps = Math.sqrt(steps);
    const sigmaLine = lerp(L.lineBlur, params.softness) * dpr * rootSteps;
    const sigmaWash = lerp(L.washBlur, params.haze) * (1 + beatStrength * L.washBlurBeat) * dpr * rootSteps;

    const h = this.blurH.uniforms;
    h.uLine.value = read.textures[0];
    h.uWash.value = read.textures[1];
    h.uTexel.value.set(1 / this.width, 1 / this.height);
    h.uSigmaLine.value = sigmaLine;
    h.uSigmaWash.value = sigmaWash;
    h.uAspect.value = this.width / this.height;
    h.uDrift.value = L.drift * dpr * steps;
    h.uTime.value = time;
    this.blurH.render(renderer, this.temp);

    const v = this.blurV.uniforms;
    v.uLine.value = this.temp!.textures[0];
    v.uWash.value = this.temp!.textures[1];
    v.uTexel.value.set(1 / this.width, 1 / this.height);
    v.uSigmaLine.value = sigmaLine;
    v.uSigmaWash.value = sigmaWash;
    v.uDensity.value = this.density!.texture;
    v.uFade.value.set(Math.pow(L.lineFade, steps), Math.pow(L.washFade, steps));
    this.blurV.render(renderer, write);
    this.cur = 1 - this.cur;

    renderer.getClearColor(this.prevClear);
    const prevAlpha = renderer.getClearAlpha();
    renderer.setClearColor(BLACK, 0);
    renderer.setRenderTarget(this.density);
    renderer.clear(true, false, false);
    renderer.setClearColor(this.prevClear, prevAlpha);

    renderer.setRenderTarget(prevTarget);
    renderer.autoClear = prevAutoClear;
  }

  present(renderer: THREE.WebGLRenderer, params: Readonly<SmokeParams>, dpr: number, beatStrength: number): void {
    if (!this.trails) return;
    const L = this.look;
    const c = this.composite.uniforms;
    c.uLine.value = this.trails[this.cur].textures[0];
    c.uWash.value = this.trails[this.cur].textures[1];
    c.uDark.value = params.mode === 'dark';
    c.uContrast.value = params.contrast;
    c.uExposure.value = L.exposure;
    c.uWashGain.value = lerp(L.washGain, params.haze) * (1 + beatStrength * L.washBeat);
    c.uWashMax.value = L.washMax;
    c.uPivot.value = L.pivot;
    c.uPaperTex.value = L.paperTex;
    c.uGrain.value = params.grain;
    c.uGrainCell.value = dpr;
    c.uPaperScale.value = 1 / (L.paperFeature * dpr);
    c.uFrame.value = this.frame = (this.frame + 1) >>> 0;
    if (params.background !== this.bgHex) { this.bgHex = params.background; c.uBackground.value.set(this.bgHex).convertLinearToSRGB(); }

    const prevAutoClear = renderer.autoClear;
    renderer.autoClear = false;
    this.composite.render(renderer, null);
    renderer.autoClear = prevAutoClear;
  }

  private disposeTargets(): void {
    this.density?.dispose();
    this.temp?.dispose();
    this.trails?.[0].dispose();
    this.trails?.[1].dispose();
    this.density = this.temp = null;
    this.trails = null;
  }

  dispose(): void {
    this.disposeTargets();
    this.blurH.dispose();
    this.blurV.dispose();
    this.composite.dispose();
  }
}
