import type { WebGLRenderer } from 'three';
import type { AudioFrame } from '../audio/types';
import type { ParamId, Params } from '../app/params';

/** Drawing-buffer size. CSS pixels times dpr = device pixels. */
export interface RenderSize {
  /** CSS pixels. */
  width: number;
  height: number;
  /** Device pixel ratio actually applied (capped at 2). */
  dpr: number;
}

/** Everything an effect gets each call. Objects are reused between frames: read, do not keep. */
export interface EffectContext {
  audio: Readonly<AudioFrame>;
  /** Seconds since start, simulation clock (advances in fixed steps). */
  time: number;
  /** Seconds. Fixed (1/60) in step(), wall-clock frame delta in render(). */
  dt: number;
  params: Readonly<Params>;
  renderer: WebGLRenderer;
  size: Readonly<RenderSize>;
}

/**
 * A visual effect. The app owns the renderer, the canvas, audio and params;
 * the effect owns its GPU resources and nothing else.
 *
 * Lifecycle: constructor -> resize(size) -> { step(ctx)* render(ctx) } per rAF -> dispose().
 */
export interface Effect {
  readonly id: string;
  readonly label: string;
  /** Advance the simulation by ctx.dt (fixed timestep). Called 0..N times per animation frame. */
  step(ctx: EffectContext): void;
  /** Draw one frame to the renderer's default framebuffer. Called once per animation frame. */
  render(ctx: EffectContext): void;
  /** Reallocate size-dependent targets. Called before the first render and on every container resize. */
  resize(size: Readonly<RenderSize>, renderer: WebGLRenderer): void;
  /** Optional: react to a param change that needs work beyond reading ctx.params (e.g. buffer realloc). */
  onParamChange?(id: ParamId, params: Readonly<Params>): void;
  /** Free every GPU resource the effect created. */
  dispose(): void;
}

export type EffectFactory = (renderer: WebGLRenderer, params: Readonly<Params>) => Effect;
