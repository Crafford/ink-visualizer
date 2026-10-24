import * as THREE from 'three';
import type { Params } from '../../app/params';
import { FULLSCREEN_VERT, MAX_ATTRACTORS } from './shaders/sim.glsl';
import { BLUR_H_FRAG, BLUR_V_FRAG, COMPOSITE_FRAG } from './shaders/trail.glsl';

/** One fullscreen-triangle draw with its own raw shader material. */
class FullscreenPass<U extends Record<string, THREE.IUniform>> {
  readonly uniforms: U;
  private scene = new THREE.Scene();
  private camera = new THREE.Camera();
  private geometry = new THREE.BufferGeometry();
  private material: THREE.RawShaderMaterial;

  constructor(fragmentShader: string, uniforms: U) {
    this.uniforms = uniforms;
    this.material = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: FULLSCREEN_VERT,
      fragmentShader,
      uniforms,
      depthTest: false,
      depthWrite: false,
      blending: THREE.NoBlending,
    });
    this.geometry.setDrawRange(0, 3);
    const tri = new THREE.Mesh(this.geometry, this.material);
    tri.frustumCulled = false;
    this.scene.add(tri);
  }

  /** Overwrites every pixel of `target`; assumes the caller turned autoClear off. */
  render(renderer: THREE.WebGLRenderer, target: THREE.WebGLRenderTarget | null): void {
    renderer.setRenderTarget(target);
    renderer.render(this.scene, this.camera);
  }

  dispose(): void {
    this.material.dispose();
    this.geometry.dispose();
  }
}

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
  /** Pivot of the contrast S-curve, in ink coverage (0 paper .. 1 ink). */
  pivot: 0.42,
  /** Paper texture: +-amplitude around the paper colour, feature size in CSS px. */
  paperTex: 0.01,
  paperFeature: 260,
};

const BLACK = new THREE.Color(0, 0, 0);

/**
 * Density, trail feedback and composite for the ink effect.
 *
 *   density (R16F): particles splatted additively, once per simulation step, cleared after
 *                   each trail update, so trails are continuous even when one display frame
 *                   covers several steps.
 *   temp    (RG16F): horizontal blur of the previous trail (+ drift on the wash channel).
 *   trail A/B (RG16F, ping-pong): blurV(temp) * fade + density; R = line, G = wash
 *                   (see shaders/trail.glsl.ts).
 *   screen: tone map, contrast, paper/ink mix, grain.
 *
 * Panel mapping: trailFade = line memory (wash memory derived, longer), trailBlur = wash
 * spread per step, trailDrift = wash drift per step. The line blur is fixed (LOOK.lineBlur).
 *
 * Fade, blur and drift are applied per simulation step (pow(fade, n), sigma * sqrt(n),
 * drift * n), so the look does not depend on the display refresh rate.
 */
export class InkTrails {
  /** Tuning table, read every frame (reachable from the console via ?debug for look work). */
  readonly look = LOOK;
  private density: THREE.WebGLRenderTarget | null = null;
  private temp: THREE.WebGLRenderTarget | null = null;
  private trails: [THREE.WebGLRenderTarget, THREE.WebGLRenderTarget] | null = null;
  private cur = 0;
  private needsClear = true;
  private width = 0;
  private height = 0;
  private frame = 0;
  private prevClear = new THREE.Color();
  private inkHex = '';
  private paperHex = '';

  private blurH = new FullscreenPass(BLUR_H_FRAG, {
    uSrc: { value: null as THREE.Texture | null },
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
    uSrc: { value: null as THREE.Texture | null },
    uTexel: { value: new THREE.Vector2() },
    uSigmaLine: { value: 0 },
    uSigmaWash: { value: 0 },
    uDensity: { value: null as THREE.Texture | null },
    uFade: { value: new THREE.Vector2(1, 1) },
  });
  private composite = new FullscreenPass(COMPOSITE_FRAG, {
    uTrail: { value: null as THREE.Texture | null },
    uExposure: { value: LOOK.exposure },
    uWash: { value: LOOK.wash },
    uWashMax: { value: LOOK.washMax },
    uContrast: { value: 1 },
    uPivot: { value: LOOK.pivot },
    uPaper: { value: new THREE.Color() },
    uInk: { value: new THREE.Color() },
    uGrain: { value: 0 },
    uPaperTex: { value: LOOK.paperTex },
    uPaperScale: { value: 1 / LOOK.paperFeature },
    uFrame: { value: 0 },
  });

  /** The target particles are splatted into. Null before the first resize. */
  get densityTarget(): THREE.WebGLRenderTarget | null { return this.density; }

  /** Reallocate every target at the drawing-buffer size. Trails restart empty. */
  resize(width: number, height: number): void {
    width = Math.max(1, Math.round(width));
    height = Math.max(1, Math.round(height));
    if (width === this.width && height === this.height && this.trails) return;
    this.disposeTargets();
    this.width = width;
    this.height = height;
    const opts: THREE.RenderTargetOptions = {
      type: THREE.HalfFloatType,
      format: THREE.RedFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      wrapS: THREE.ClampToEdgeWrapping,
      wrapT: THREE.ClampToEdgeWrapping,
      generateMipmaps: false,
      depthBuffer: false,
      stencilBuffer: false,
    };
    const make = (format: THREE.PixelFormat) => new THREE.WebGLRenderTarget(width, height, { ...opts, format });
    this.density = make(THREE.RedFormat);
    this.temp = make(THREE.RGFormat);
    this.trails = [make(THREE.RGFormat), make(THREE.RGFormat)];
    this.cur = 0;
    this.needsClear = true;
  }

  /** Clear the trails and density (first frame after allocation or on demand). */
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

  /** Call before splatting into the density target, so a fresh target starts at zero. */
  prepare(renderer: THREE.WebGLRenderer): void {
    if (this.needsClear && this.trails) this.clearAll(renderer);
  }

  /**
   * Fold the density accumulated over `steps` simulation steps into the trail.
   * attractors are in view space (x in [-aspect, aspect], y in [-1, 1]).
   */
  update(
    renderer: THREE.WebGLRenderer, params: Readonly<Params>, steps: number, dpr: number, time: number,
    attractors: readonly THREE.Vector2[], attractorCount: number,
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
    const sigmaLine = this.look.lineBlur * dpr * rootSteps;
    const sigmaWash = params.trailBlur * dpr * rootSteps;
    const washFade = 1 - (1 - params.trailFade) * this.look.washFadeRatio;

    const h = this.blurH.uniforms;
    h.uSrc.value = read.texture;
    h.uTexel.value.set(1 / this.width, 1 / this.height);
    h.uSigmaLine.value = sigmaLine;
    h.uSigmaWash.value = sigmaWash;
    h.uAspect.value = aspect;
    h.uDrift.value = params.trailDrift * dpr * steps;
    h.uTime.value = time;
    h.uAttractorCount.value = Math.max(1, Math.min(MAX_ATTRACTORS, attractorCount));
    for (let i = 0; i < MAX_ATTRACTORS; i++) {
      const a = attractors[i];
      // view space -> uv
      if (a) h.uAttractors.value[i].set(a.x / aspect * 0.5 + 0.5, a.y * 0.5 + 0.5);
    }
    this.blurH.render(renderer, this.temp);

    const v = this.blurV.uniforms;
    v.uSrc.value = this.temp!.texture;
    v.uTexel.value.set(1 / this.width, 1 / this.height);
    v.uSigmaLine.value = sigmaLine;
    v.uSigmaWash.value = sigmaWash;
    v.uDensity.value = this.density!.texture;
    v.uFade.value.set(Math.pow(params.trailFade, steps), Math.pow(washFade, steps));
    this.blurV.render(renderer, write);
    this.cur = 1 - this.cur;

    // Density has been consumed.
    renderer.getClearColor(this.prevClear);
    const prevAlpha = renderer.getClearAlpha();
    renderer.setClearColor(BLACK, 0);
    renderer.setRenderTarget(this.density);
    renderer.clear(true, false, false);
    renderer.setClearColor(this.prevClear, prevAlpha);

    renderer.setRenderTarget(prevTarget);
    renderer.autoClear = prevAutoClear;
  }

  /** Composite the current trail to the default framebuffer. */
  present(renderer: THREE.WebGLRenderer, params: Readonly<Params>, dpr: number): void {
    if (!this.trails) return;
    const c = this.composite.uniforms;
    c.uTrail.value = this.trails[this.cur].texture;
    c.uContrast.value = params.contrast;
    c.uExposure.value = this.look.exposure;
    c.uWash.value = this.look.wash;
    c.uWashMax.value = this.look.washMax;
    c.uPivot.value = this.look.pivot;
    c.uPaperTex.value = this.look.paperTex;
    c.uGrain.value = params.grain;
    c.uPaperScale.value = 1 / (this.look.paperFeature * dpr);
    c.uFrame.value = this.frame = (this.frame + 1) >>> 0;
    // Raw shader output is not colour-managed: feed sRGB values to match the swatches.
    // Parse only on change (Color.set(string) allocates).
    if (params.inkColor !== this.inkHex) { this.inkHex = params.inkColor; c.uInk.value.set(this.inkHex).convertLinearToSRGB(); }
    if (params.paperColor !== this.paperHex) { this.paperHex = params.paperColor; c.uPaper.value.set(this.paperHex).convertLinearToSRGB(); }

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
