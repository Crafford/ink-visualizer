import * as THREE from 'three';
import { FULLSCREEN_VERT, MAX_ATTRACTORS, SIM_FRAG } from './shaders/sim.glsl';

/** Per-step inputs, already mapped from params + audio by the effect. */
export interface SimInputs {
  dt: number;
  time: number;
  aspect: number;
  attractors: readonly THREE.Vector2[];
  attractorCount: number;
  noiseScale: number;
  noiseSpeed: number;
  turbulence: number;
  pull: number;
  swirl: number;
  damping: number;
  maxSpeed: number;
  lifespan: number;
  respawnChance: number;
  burstChance: number;
  coreRadius: number;
  coreFraction: number;
  jets: number;
  jetSpeed: number;
  jetWidth: number;
  jetSpin: number;
  calmRadius: number;
  burstSpeed: number;
  burstCurl: number;
  burstLife: number;
  burstRays: number;
  beatSeed: number;
  beatPush: number;
  beatRadius: number;
}

type FloatKind = 'float' | 'half';

/**
 * GPU particle state and the simulation pass.
 *
 * State lives in a ping-pong pair of 2-attachment (MRT) float render targets:
 *   textures[0] = pos.xy, vel.xy     textures[1] = age, life, seed, emitterIndex
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
    uPull: { value: 0 },
    uSwirl: { value: 0 },
    uDamping: { value: 0 },
    uMaxSpeed: { value: 1 },
    uLifespan: { value: 4 },
    uRespawnChance: { value: 0 },
    uBurstChance: { value: 0 },
    uCoreRadius: { value: 0.03 },
    uCoreFraction: { value: 0.3 },
    uJets: { value: 5 },
    uJetSpeed: { value: 0.2 },
    uJetWidth: { value: 0.2 },
    uJetSpin: { value: 0.1 },
    uCalmRadius: { value: 0.2 },
    uBurstSpeed: { value: 0.8 },
    uBurstCurl: { value: 0.3 },
    uBurstLife: { value: 1 },
    uBurstRays: { value: 0 },
    uBeatSeed: { value: 0 },
    uBeatPush: { value: 0 },
    uBeatRadius: { value: 0.8 },
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
      count: 2,
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

  /** Fill the state procedurally: particles around the attractors with staggered ages. */
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
    u.uDt.value = s.dt;
    u.uTime.value = s.time;
    u.uFrame.value = this.frame = (this.frame + 1) >>> 0;
    u.uAspect.value = s.aspect;
    u.uAttractors.value = s.attractors as THREE.Vector2[];
    u.uAttractorCount.value = Math.max(1, Math.min(MAX_ATTRACTORS, s.attractorCount));
    u.uNoiseScale.value = s.noiseScale;
    u.uNoiseSpeed.value = s.noiseSpeed;
    u.uTurbulence.value = s.turbulence;
    u.uPull.value = s.pull;
    u.uSwirl.value = s.swirl;
    u.uDamping.value = s.damping;
    u.uMaxSpeed.value = s.maxSpeed;
    u.uLifespan.value = s.lifespan;
    u.uRespawnChance.value = s.respawnChance;
    u.uBurstChance.value = s.burstChance;
    u.uCoreRadius.value = s.coreRadius;
    u.uCoreFraction.value = s.coreFraction;
    u.uJets.value = s.jets;
    u.uJetSpeed.value = s.jetSpeed;
    u.uJetWidth.value = s.jetWidth;
    u.uJetSpin.value = s.jetSpin;
    u.uCalmRadius.value = s.calmRadius;
    u.uBurstSpeed.value = s.burstSpeed;
    u.uBurstCurl.value = s.burstCurl;
    u.uBurstLife.value = s.burstLife;
    u.uBurstRays.value = s.burstRays;
    u.uBeatSeed.value = s.beatSeed >>> 0;
    u.uBeatPush.value = s.beatPush;
    u.uBeatRadius.value = s.beatRadius;

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
