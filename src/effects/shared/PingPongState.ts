import * as THREE from 'three';
import { FULLSCREEN_VERT } from './shaders/fullscreen.glsl';

type FloatKind = 'float' | 'half';

/** Uniform names the state textures are bound to, by attachment. */
const STATE_UNIFORMS = ['uStateA', 'uStateB', 'uStateC', 'uStateD'] as const;

export interface StateUniforms {
  uStateA: THREE.IUniform<THREE.Texture | null>;
  uFrame: THREE.IUniform<number>;
  [name: string]: THREE.IUniform;
}

/**
 * GPU particle state: a ping-pong pair of float MRT render targets (`attachments` RGBA
 * textures each), sqrt(count) square, and one fullscreen-triangle simulation pass that
 * reads the current target and writes the other. The effect owns the shader and its
 * uniforms; this class binds the read side to uStateA.. and bumps uFrame on every run.
 * Texels past `count` simulate but are never drawn.
 */
export class PingPongState {
  readonly floatKind: FloatKind;
  size = 0;
  count = 0;

  private targets: [THREE.WebGLRenderTarget, THREE.WebGLRenderTarget] | null = null;
  private cur = 0;
  private frame = 0;

  private scene = new THREE.Scene();
  private camera = new THREE.Camera(); // unused by the raw shader, required by render()
  private geometry = new THREE.BufferGeometry();
  private material: THREE.RawShaderMaterial;

  constructor(
    renderer: THREE.WebGLRenderer, fragmentShader: string, private uniforms: StateUniforms,
    private attachments: number, count: number, tag: string,
  ) {
    this.floatKind = PingPongState.pickFloatKind(renderer);
    console.info(
      `[${tag}] particle state format: ${this.floatKind === 'float' ? 'RGBA32F (EXT_color_buffer_float)' : 'RGBA16F (EXT_color_buffer_half_float), reduced precision'}`,
    );
    this.material = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: FULLSCREEN_VERT,
      fragmentShader,
      uniforms,
      depthTest: false,
      depthWrite: false,
      blending: THREE.NoBlending,
    });
    // Attribute-less draw of 3 vertices; the vertex shader builds the triangle from gl_VertexID.
    this.geometry.setDrawRange(0, 3);
    const tri = new THREE.Mesh(this.geometry, this.material);
    tri.frustumCulled = false;
    this.scene.add(tri);
    this.allocate(count);
  }

  private static pickFloatKind(renderer: THREE.WebGLRenderer): FloatKind {
    const gl = renderer.getContext();
    if (gl.getExtension('EXT_color_buffer_float')) return 'float';
    if (gl.getExtension('EXT_color_buffer_half_float')) return 'half';
    throw new Error('Float render targets are not supported (need EXT_color_buffer_float or _half_float)');
  }

  /** (Re)allocate state for `count` particles. Contents are undefined until the next init run. */
  allocate(count: number): void {
    const size = Math.ceil(Math.sqrt(count));
    this.count = count;
    if (size === this.size && this.targets) return;
    this.disposeTargets();
    this.size = size;
    const opts: THREE.RenderTargetOptions = {
      count: this.attachments,
      type: this.floatKind === 'float' ? THREE.FloatType : THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      wrapS: THREE.ClampToEdgeWrapping,
      wrapT: THREE.ClampToEdgeWrapping,
      generateMipmaps: false,
      depthBuffer: false,
      stencilBuffer: false,
    };
    this.targets = [new THREE.WebGLRenderTarget(size, size, opts), new THREE.WebGLRenderTarget(size, size, opts)];
    this.cur = 0;
  }

  /** Current state texture `i` (read side). */
  texture(i: number): THREE.Texture { return this.targets![this.cur].textures[i]; }

  /** One simulation pass with the uniforms as the caller left them. */
  run(renderer: THREE.WebGLRenderer): void {
    const u = this.uniforms;
    const read = this.targets![this.cur];
    const write = this.targets![1 - this.cur];
    for (let i = 0; i < this.attachments; i++) u[STATE_UNIFORMS[i]].value = read.textures[i];
    u.uFrame.value = this.frame = (this.frame + 1) >>> 0;

    const prevTarget = renderer.getRenderTarget();
    const prevAutoClear = renderer.autoClear;
    renderer.autoClear = false; // every texel is overwritten, a clear would be wasted bandwidth
    renderer.setRenderTarget(write);
    renderer.render(this.scene, this.camera);
    renderer.setRenderTarget(prevTarget);
    renderer.autoClear = prevAutoClear;
    this.cur = 1 - this.cur;
  }

  private disposeTargets(): void {
    if (!this.targets) return;
    this.targets[0].dispose();
    this.targets[1].dispose();
    this.targets = null;
  }

  dispose(): void {
    this.disposeTargets();
    this.material.dispose();
    this.geometry.dispose();
  }
}
