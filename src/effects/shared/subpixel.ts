import * as THREE from 'three';

/**
 * Sub-pixel particle sizes (Size below 0.5 px), shared by Ink and Smoke.
 *
 * Particles are always rasterised as 1 px points / segments; a smaller Size shrinks the ink
 * each one carries (per effect). Below `start` (0.5 px) the particles are splatted into a
 * LOW-resolution density target (`lowResCss` CSS px tall, at most half res; the names below say
 * "half") instead of the full one, and the trail pass reads it through a pre-filter: a 4 x 4
 * grid of bilinear taps `spread` low-res texels apart with weights (1 3 3 1) per axis (the
 * binomial 5 x 5 kernel at spread 1), which also upsamples. So at the minimum size a lone
 * particle lands as a soft smudge and only accumulated density reads. The spread ramps from 0
 * (plain bilinear upsample) at `start` to `maxSpread` at `full`. At or above `start` (Ink's default 0.5) the full-resolution
 * target is used and read with an exact texelFetch, so the look is unchanged.
 */
export const SUBPIXEL = {
  start: 0.5,
  full: 0.25,
  maxSpread: 1,
  /** Height of the low-res density target in CSS px (at most half the drawing buffer). The
   *  particle count does not grow with the screen, so the filter is screen-relative: a 900 px
   *  tall view gets a 1/3 res target, a 600 px one 1/2. */
  lowResCss: 300,
};

/** True when a Size (px) splats into the half-resolution density target. */
export const subPixelHalf = (size: number) => size < SUBPIXEL.start;

/** Pre-filter tap spacing in low-res texels for a Size (px). */
export function subPixelSpread(size: number): number {
  const w = Math.min(1, Math.max(0, (SUBPIXEL.start - size) / (SUBPIXEL.start - SUBPIXEL.full)));
  return w * SUBPIXEL.maxSpread;
}

/**
 * GLSL: `vec4 densityAt(sampler2D dFull, sampler2D dHalf, vec2 fragCoord)`: the full-res density
 * texel plus, when uHalfOn, the pre-filtered half-res density (linear filtering required).
 */
export const DENSITY_PREFILTER_GLSL = /* glsl */ `
uniform bool  uHalfOn;     // the half-res density was written since the last update
uniform vec2  uHalfTexel;  // 1 / half-res size
uniform vec2  uFullTexel;  // 1 / full-res size
uniform float uSpread;     // tap spacing, half-res texels
vec4 densityAt(sampler2D dFull, sampler2D dHalf, vec2 fragCoord) {
  vec4 c = texelFetch(dFull, ivec2(fragCoord), 0);
  if (!uHalfOn) return c;
  vec2 uv = fragCoord * uFullTexel;
  vec4 h = vec4(0.0);
  for (int j = 0; j < 4; j++) {
    float wy = (j == 0 || j == 3) ? 1.0 : 3.0;
    for (int i = 0; i < 4; i++) {
      float wx = (i == 0 || i == 3) ? 1.0 : 3.0;
      vec2 o = (vec2(float(i), float(j)) - 1.5) * uSpread;
      h += texture(dHalf, uv + o * uHalfTexel) * (wx * wy);
    }
  }
  return c + h * (1.0 / 64.0);
}
`;

const BLACK = new THREE.Color(0, 0, 0);

/**
 * The full- and half-resolution density targets of a trail (each `count` RGBA16F attachments),
 * which one a Size splats into, and the uniforms the trail pass needs to read them.
 */
export class DensityTargets {
  full: THREE.WebGLRenderTarget | null = null;
  half: THREE.WebGLRenderTarget | null = null;
  private halfUsed = false;
  private prevClear = new THREE.Color();

  constructor(private count: number) {}

  allocate(width: number, height: number, dpr = 1): void {
    this.dispose();
    const make = (w: number, h: number) => new THREE.WebGLRenderTarget(w, h, {
      type: THREE.HalfFloatType, format: THREE.RGBAFormat, count: this.count,
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
      wrapS: THREE.ClampToEdgeWrapping, wrapT: THREE.ClampToEdgeWrapping,
      generateMipmaps: false, depthBuffer: false, stencilBuffer: false,
    });
    this.full = make(width, height);
    const scale = Math.min(0.5, (SUBPIXEL.lowResCss * dpr) / Math.max(1, height));
    this.half = make(Math.max(1, Math.ceil(width * scale)), Math.max(1, Math.ceil(height * scale)));
    this.halfUsed = false;
  }

  /** The target to splat into for `size` (marks the half target as used). */
  pick(size: number): THREE.WebGLRenderTarget | null {
    if (!subPixelHalf(size)) return this.full;
    this.halfUsed = true;
    return this.half;
  }

  /** Set the densityAt uniforms (+ the samplers named `fullName` / `halfName` by attachment). */
  bind(u: Record<string, THREE.IUniform>, size: number, names: readonly (readonly [string, string])[]): void {
    names.forEach(([f, h], i) => {
      u[f].value = this.full!.textures[i];
      u[h].value = this.half!.textures[i];
    });
    u.uHalfOn.value = this.halfUsed;
    u.uHalfTexel.value.set(1 / this.half!.width, 1 / this.half!.height);
    u.uFullTexel.value.set(1 / this.full!.width, 1 / this.full!.height);
    u.uSpread.value = subPixelSpread(size);
  }

  /** Ink multiplier for a target: per-texel ink x texel area, so total ink is conserved. */
  inkScale(target: THREE.WebGLRenderTarget): number {
    return target === this.half && this.full ? (target.width * target.height) / (this.full.width * this.full.height) : 1;
  }

  /** Clear the targets (the density has been consumed); `all` also clears an unused half target. */
  clear(renderer: THREE.WebGLRenderer, all = false): void {
    if (!this.full) return;
    renderer.getClearColor(this.prevClear);
    const prevAlpha = renderer.getClearAlpha();
    renderer.setClearColor(BLACK, 0);
    renderer.setRenderTarget(this.full);
    renderer.clear(true, false, false);
    if (this.halfUsed || all) {
      renderer.setRenderTarget(this.half);
      renderer.clear(true, false, false);
    }
    renderer.setClearColor(this.prevClear, prevAlpha);
    this.halfUsed = false;
  }

  /** Uniform declarations for a FullscreenPass that calls densityAt. */
  static uniforms(): Record<string, THREE.IUniform> {
    return {
      uHalfOn: { value: false },
      uHalfTexel: { value: new THREE.Vector2(1, 1) },
      uFullTexel: { value: new THREE.Vector2(1, 1) },
      uSpread: { value: 0 },
    };
  }

  dispose(): void {
    this.full?.dispose();
    this.half?.dispose();
    this.full = this.half = null;
  }
}
