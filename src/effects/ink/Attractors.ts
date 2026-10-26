import * as THREE from 'three';

/** Max sources; the uniform arrays are fixed-size, uAttractorCount picks how many are live. */
export const MAX_ATTRACTORS = 3;

/** Deterministic PRNG so each attractor keeps its own path between reloads. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Path { w: Float32Array; ph: Float32Array }

/**
 * Wandering ink sources (the dropper positions) on the CPU: three points are not worth a
 * GPU pass. Each one follows its own low-frequency quasi-periodic noise: two incommensurate
 * sines per axis with seeded frequencies and phases. The dominant half period is 16-24 s
 * of wander phase; the effect advances the phase at TUNE.wander (0.4) x Speed, so at the
 * defaults a full traverse of the central 60% of the view takes 40-60 s.
 */
export class Attractors {
  /** Uniform value, length MAX_ATTRACTORS; entries past `count` are stale and ignored. */
  readonly positions: THREE.Vector2[] = [];
  private paths: Path[] = [];
  private phase = 0;

  constructor() {
    for (let i = 0; i < MAX_ATTRACTORS; i++) {
      const r = mulberry32(0x1f2e3d4c + i * 7919);
      const base = 0.13 + r() * 0.07;
      // x: base, 2.37x; y: slightly different base, 1.91x. Phases random.
      const w = new Float32Array([base, base * 2.37, base * (0.8 + r() * 0.3), base * 1.91]);
      const ph = new Float32Array([r() * 6.283, r() * 6.283, r() * 6.283, r() * 6.283]);
      this.paths.push({ w, ph });
      this.positions.push(new THREE.Vector2());
    }
  }

  /**
   * Advance the shared wander clock. speed 1 = nominal; the effect folds in Speed and audio.
   * Integrating a phase (instead of time * speed) keeps paths continuous when speed changes.
   */
  update(dt: number, speed: number, aspect: number): void {
    this.phase += dt * speed;
    const ex = 0.6 * aspect;
    const ey = 0.6;
    for (let i = 0; i < MAX_ATTRACTORS; i++) {
      const { w, ph } = this.paths[i];
      const t = this.phase;
      const x = 0.65 * Math.sin(w[0] * t + ph[0]) + 0.35 * Math.sin(w[1] * t + ph[1]);
      const y = 0.65 * Math.sin(w[2] * t + ph[2]) + 0.35 * Math.sin(w[3] * t + ph[3]);
      this.positions[i].set(x * ex, y * ey);
    }
  }
}
