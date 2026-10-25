import * as THREE from 'three';
import { FULLSCREEN_VERT, MAX_ATTRACTORS, SIM_FRAG } from './shaders/sim.glsl';

/** Per-step inputs, already mapped from params + audio by the effect. Times are simulation seconds. */
export interface SimInputs {
  dt: number;
  time: number;
  aspect: number;
  attractors: readonly THREE.Vector2[];
  attractorCount: number;
  noiseScale: number;
  noiseSpeed: number;
  turbulence: number;
  relax: number;
  maxSpeed: number;
  lifespan: number;
  bleedRate: number;
  seepChance: number;
  seepRadius: number;
  seepSpeed: number;
  seepBleed: number;
  dropChance: number;
  dropEmitter: number;
  dropSeed: number;
  dropStrength: number;
  dropJitter: number;
  dropRadius: readonly [number, number];
  splat: number;
  dropBleed: number;
  dropLife: number;
  satFraction: number;
  satDist: readonly [number, number];
  satRadius: number;
  satBleed: number;
  fibre: number;
  feather: number;
  featherFreq: number;
  edgeNoise: number;
}

type FloatKind = 'float' | 'half';

/**
 * GPU particle state and the simulation pass.
 *
 * State lives in a ping-pong pair of 3-attachment (MRT) float render targets:
 *   textures[0] = pos.xy, vel.xy
 *   textures[1] = age, life (< 0 = dormant), seed, source index
 *   textures[2] = bleed centre.xy, bleed reach, bleed angle
 * Texture side = ceil(sqrt(count)); texels past `count` simulate but are never drawn.
 * One fullscreen-triangle draw per step reads the current target, writes the other.
 */
export class ParticleSim {
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
  private uniforms = {
    uStateA: { value: null as THREE.Texture | null },
    uStateB: { value: null as THREE.Texture | null },
    uStateC: { value: null as THREE.Texture | null },
    uDt: { value: 0 },
    uTime: { value: 0 },
    uFrame: { value: 0 },
    uAspect: { value: 1 },
    uInit: { value: false },
    uAttractors: { value: [] as THREE.Vector2[] },
    uAttractorCount: { value: 1 },
    uNoiseScale: { value: 1 },
    uNoiseSpeed: { value: 0.1 },
    uTurbulence: { value: 0 },
    uRelax: { value: 1 },
    uMaxSpeed: { value: 1 },
    uLifespan: { value: 4 },
    uBleedRate: { value: 1 },
    uSeepChance: { value: 0 },
    uSeepRadius: { value: 0.02 },
    uSeepSpeed: { value: 0 },
    uSeepBleed: { value: 0 },
    uDropChance: { value: 0 },
    uDropEmitter: { value: -1 },
    uDropSeed: { value: 0 },
    uDropStrength: { value: 0.5 },
    uDropJitter: { value: 0 },
    uDropRadius: { value: new THREE.Vector2(0.03, 0.05) },
    uSplat: { value: 0 },
    uDropBleed: { value: 0 },
    uDropLife: { value: 1 },
    uSatFraction: { value: 0 },
    uSatDist: { value: new THREE.Vector2(0.08, 0.25) },
    uSatRadius: { value: 0.01 },
    uSatBleed: { value: 1 },
    uFibre: { value: 0 },
    uFeather: { value: 0 },
    uFeatherFreq: { value: 40 },
    uEdgeNoise: { value: 0 },
  };

  constructor(renderer: THREE.WebGLRenderer, count: number) {
    this.floatKind = ParticleSim.pickFloatKind(renderer);
    console.info(
      `[ink] particle state format: ${this.floatKind === 'float' ? 'RGBA32F (EXT_color_buffer_float)' : 'RGBA16F (EXT_color_buffer_half_float), reduced precision'}`,
    );

    this.material = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: SIM_FRAG,
      uniforms: this.uniforms,
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

  /** (Re)allocate state for `count` particles. Contents are undefined until init(). */
  allocate(count: number): void {
    const size = Math.ceil(Math.sqrt(count));
    this.count = count;
    if (size === this.size && this.targets) return;
    this.disposeTargets();
    this.size = size;
    const opts: THREE.RenderTargetOptions = {
      count: 3,
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

  /** Current state textures (read side). */
  get stateA(): THREE.Texture { return this.targets![this.cur].textures[0]; }
  get stateB(): THREE.Texture { return this.targets![this.cur].textures[1]; }
  get stateC(): THREE.Texture { return this.targets![this.cur].textures[2]; }

  /** Reset the state: every particle dormant. */
  init(renderer: THREE.WebGLRenderer, inputs: SimInputs): void {
    this.uniforms.uInit.value = true;
    this.run(renderer, inputs);
    this.uniforms.uInit.value = false;
  }

  step(renderer: THREE.WebGLRenderer, inputs: SimInputs): void {
    this.run(renderer, inputs);
  }

  private run(renderer: THREE.WebGLRenderer, s: SimInputs): void {
    const u = this.uniforms;
    const read = this.targets![this.cur];
    const write = this.targets![1 - this.cur];
    u.uStateA.value = read.textures[0];
    u.uStateB.value = read.textures[1];
    u.uStateC.value = read.textures[2];
    u.uDt.value = s.dt;
    u.uTime.value = s.time;
    u.uFrame.value = this.frame = (this.frame + 1) >>> 0;
    u.uAspect.value = s.aspect;
    u.uAttractors.value = s.attractors as THREE.Vector2[];
    u.uAttractorCount.value = Math.max(1, Math.min(MAX_ATTRACTORS, s.attractorCount));
    u.uNoiseScale.value = s.noiseScale;
    u.uNoiseSpeed.value = s.noiseSpeed;
    u.uTurbulence.value = s.turbulence;
    u.uRelax.value = s.relax;
    u.uMaxSpeed.value = s.maxSpeed;
    u.uLifespan.value = s.lifespan;
    u.uBleedRate.value = s.bleedRate;
    u.uSeepChance.value = s.seepChance;
    u.uSeepRadius.value = s.seepRadius;
    u.uSeepSpeed.value = s.seepSpeed;
    u.uSeepBleed.value = s.seepBleed;
    u.uDropChance.value = s.dropChance;
    u.uDropEmitter.value = s.dropEmitter;
    u.uDropSeed.value = s.dropSeed >>> 0;
    u.uDropStrength.value = s.dropStrength;
    u.uDropJitter.value = s.dropJitter;
    u.uDropRadius.value.set(s.dropRadius[0], s.dropRadius[1]);
    u.uSplat.value = s.splat;
    u.uDropBleed.value = s.dropBleed;
    u.uDropLife.value = s.dropLife;
    u.uSatFraction.value = s.satFraction;
    u.uSatDist.value.set(s.satDist[0], s.satDist[1]);
    u.uSatRadius.value = s.satRadius;
    u.uSatBleed.value = s.satBleed;
    u.uFibre.value = s.fibre;
    u.uFeather.value = s.feather;
    u.uFeatherFreq.value = s.featherFreq;
    u.uEdgeNoise.value = s.edgeNoise;

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
