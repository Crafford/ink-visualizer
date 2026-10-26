import * as THREE from 'three';
import { FullscreenPass } from '../shared/FullscreenPass';
import { SMOKE_COMPOSITE_FRAG } from './shaders/image.glsl';

/** Fixed look of the smoke (not in the panel). Colours are sRGB hex. */
export const SMOKE_LOOK = {
  background: '#0A0A0B',
  thin: '#7F93A6',
  dense: '#F2F4F5',
  /** a = 1 - exp(-light) range over which thin turns dense. */
  ramp: [0.12, 0.9] as [number, number],
  /** a = 1 - exp(-exposure log2(1 + light)). */
  exposure: 0.8,
};

const BLACK = new THREE.Color(0, 0, 0);

/**
 * The smoke's light buffer: one float target at drawing-buffer size, cleared every frame; the
 * strands add their light into it, present() maps it through the colour ramp to the screen.
 * No feedback trail: the strands are continuous lines already.
 */
export class SmokeLight {
  readonly look = SMOKE_LOOK;
  target: THREE.WebGLRenderTarget | null = null;
  private width = 0;
  private height = 0;
  private prevClear = new THREE.Color();
  private type: THREE.TextureDataType;

  private composite = new FullscreenPass(SMOKE_COMPOSITE_FRAG, {
    uLight: { value: null as THREE.Texture | null },
    uBg: { value: new THREE.Color() },
    uThin: { value: new THREE.Color() },
    uDense: { value: new THREE.Color() },
    uRamp: { value: new THREE.Vector2() },
    uExposure: { value: 1 },
  });

  constructor(renderer: THREE.WebGLRenderer) {
    // Full float when it can be blended (a strand's light is tiny next to a dense core), else half.
    this.type = renderer.getContext().getExtension('EXT_float_blend') ? THREE.FloatType : THREE.HalfFloatType;
  }

  resize(width: number, height: number): void {
    width = Math.max(1, Math.round(width));
    height = Math.max(1, Math.round(height));
    if (width === this.width && height === this.height && this.target) return;
    this.target?.dispose();
    this.width = width;
    this.height = height;
    this.target = new THREE.WebGLRenderTarget(width, height, {
      type: this.type, format: THREE.RGBAFormat,
      minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
      wrapS: THREE.ClampToEdgeWrapping, wrapT: THREE.ClampToEdgeWrapping,
      generateMipmaps: false, depthBuffer: false, stencilBuffer: false,
    });
  }

  /** Bind and clear the light buffer for this frame's strands. */
  begin(renderer: THREE.WebGLRenderer): void {
    if (!this.target) return;
    renderer.setRenderTarget(this.target);
    renderer.getClearColor(this.prevClear);
    const a = renderer.getClearAlpha();
    renderer.setClearColor(BLACK, 0);
    renderer.clear(true, false, false);
    renderer.setClearColor(this.prevClear, a);
  }

  present(renderer: THREE.WebGLRenderer): void {
    if (!this.target) return;
    const c = this.composite.uniforms;
    const L = this.look;
    c.uLight.value = this.target.texture;
    // Raw shader output is not colour-managed: feed the sRGB values as they are.
    c.uBg.value.set(L.background).convertLinearToSRGB();
    c.uThin.value.set(L.thin).convertLinearToSRGB();
    c.uDense.value.set(L.dense).convertLinearToSRGB();
    c.uRamp.value.set(L.ramp[0], L.ramp[1]);
    c.uExposure.value = L.exposure;
    const prevAutoClear = renderer.autoClear;
    renderer.autoClear = false;
    this.composite.render(renderer, null);
    renderer.autoClear = prevAutoClear;
  }

  dispose(): void {
    this.target?.dispose();
    this.target = null;
    this.composite.dispose();
  }
}
