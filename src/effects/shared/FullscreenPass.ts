import * as THREE from 'three';
import { FULLSCREEN_VERT } from './shaders/fullscreen.glsl';

/** One fullscreen-triangle draw with its own raw shader material. */
export class FullscreenPass<U extends Record<string, THREE.IUniform>> {
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
