import * as THREE from 'three';
import type { Effect, EffectContext, RenderSize } from '../types';
import type { Params } from '../../app/params';

/**
 * M1 placeholder for the ink effect. Clears to paper and draws a small CPU particle
 * cloud swirling around wandering attractors, so the loop, params and audio wiring
 * are visibly alive. M2 replaces the internals with the GPU pipeline described in
 * ARCHITECTURE.md (ping-pong float textures, curl noise, feedback trails, ink inversion)
 * without changing this class's public surface.
 */
export class InkEffect implements Effect {
  readonly id = 'ink';
  readonly label = 'Ink';

  private static readonly COUNT = 6000;

  private scene = new THREE.Scene();
  private camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -1, 1);
  private geometry = new THREE.BufferGeometry();
  private material = new THREE.PointsMaterial({
    size: 1.5, sizeAttenuation: false, transparent: true, depthWrite: false,
  });
  private points: THREE.Points;
  private pos: Float32Array;
  private vel: Float32Array;
  private aspect = 1;
  private paper = new THREE.Color();
  private dpr = 1;

  constructor(_renderer: THREE.WebGLRenderer, _params: Readonly<Params>) {
    const n = InkEffect.COUNT;
    this.pos = new Float32Array(n * 3);
    this.vel = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = Math.sqrt(Math.random()) * 0.6;
      this.pos[i * 3] = Math.cos(a) * r;
      this.pos[i * 3 + 1] = Math.sin(a) * r;
    }
    this.geometry.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.points = new THREE.Points(this.geometry, this.material);
    this.points.frustumCulled = false;
    this.scene.add(this.points);
  }

  resize(size: Readonly<RenderSize>): void {
    this.aspect = size.width / Math.max(1, size.height);
    this.dpr = size.dpr;
    this.camera.left = -this.aspect;
    this.camera.right = this.aspect;
    this.camera.updateProjectionMatrix();
  }

  step({ dt, time, params, audio }: EffectContext): void {
    const n = InkEffect.COUNT;
    const k = Math.round(params.emitters);
    const turb = params.turbulenceStrength;
    const scale = params.turbulenceScale;
    const damp = Math.exp(-dt * (0.5 + params.drag * 6));
    const kick = audio.beat ? params.burstSize * 0.8 : 0;
    const swirl = 0.8 + audio.mid * 2;

    const ax: number[] = [];
    const ay: number[] = [];
    for (let j = 0; j < k; j++) {
      const t = time * (0.11 + j * 0.03) + j * 2.1;
      ax.push(Math.sin(t * 1.3) * 0.55 * this.aspect + Math.sin(t * 0.7 + j) * 0.2);
      ay.push(Math.cos(t * 0.9 + j * 1.7) * 0.45);
    }

    const p = this.pos, v = this.vel;
    for (let i = 0; i < n; i++) {
      const o = i * 3;
      const j = i % k;
      const dx = ax[j] - p[o], dy = ay[j] - p[o + 1];
      const d2 = dx * dx + dy * dy + 0.02;
      const inv = 1 / Math.sqrt(d2);
      // pull + perpendicular swirl + cheap trig "noise"
      const nx = Math.sin(p[o + 1] * scale * 3 + time * 0.7) * turb;
      const ny = Math.cos(p[o] * scale * 3 - time * 0.6) * turb;
      v[o] += (dx * 0.9 - dy * inv * 0.15 * swirl + nx * 0.3) * dt;
      v[o + 1] += (dy * 0.9 + dx * inv * 0.15 * swirl + ny * 0.3) * dt;
      if (kick) { v[o] -= dx * inv * kick * Math.random(); v[o + 1] -= dy * inv * kick * Math.random(); }
      v[o] *= damp;
      v[o + 1] *= damp;
      p[o] += v[o] * dt;
      p[o + 1] += v[o + 1] * dt;
    }
    (this.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
  }

  render({ renderer, params, audio }: EffectContext): void {
    this.paper.set(params.paperColor);
    renderer.setClearColor(this.paper, 1);
    this.material.color.set(params.inkColor);
    this.material.opacity = Math.min(1, params.pointOpacity * 4 * (0.6 + params.contrast * 0.3));
    this.material.size = params.pointSize * this.dpr * (1.5 + audio.bass * 1.5);
    renderer.render(this.scene, this.camera);
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}

export const createInkEffect = (r: THREE.WebGLRenderer, p: Readonly<Params>) => new InkEffect(r, p);
