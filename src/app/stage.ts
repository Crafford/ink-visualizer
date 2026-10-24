import * as THREE from 'three';
import type { AudioEngine } from '../audio/AudioEngine';
import type { Effect, EffectContext, EffectFactory, RenderSize } from '../effects/types';
import type { ParamStore } from './store';
import { Loop } from './loop';

const MAX_DPR = 2;

/**
 * Owns the canvas, the WebGL2 renderer, the render loop and the active effect.
 * Sized by its container via ResizeObserver, never by the window.
 */
export class Stage {
  readonly canvas: HTMLCanvasElement;
  readonly renderer: THREE.WebGLRenderer;
  private effect: Effect;
  private loop: Loop;
  private size: RenderSize = { width: 1, height: 1, dpr: 1 };
  private ctx: EffectContext;
  private ro: ResizeObserver;
  private captureQueue: ((c: HTMLCanvasElement) => void)[] = [];
  private unsub: () => void;

  constructor(
    readonly container: HTMLElement,
    private store: ParamStore,
    private audio: AudioEngine,
    effectFactory: EffectFactory,
  ) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'stage-canvas';
    container.prepend(this.canvas);

    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas, antialias: false, alpha: false, powerPreference: 'high-performance',
    });
    this.effect = effectFactory(this.renderer, store.all);
    this.ctx = {
      audio: audio.getFrame(), time: 0, dt: 0, params: store.all, renderer: this.renderer, size: this.size,
    };
    this.unsub = store.subscribe((id, _v, all) => this.effect.onParamChange?.(id, all));

    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(container);
    this.resize();

    this.loop = new Loop({
      frame: () => { this.ctx.audio = this.audio.getFrame(); this.ctx.params = this.store.all; },
      step: (dt, t) => { this.ctx.dt = dt; this.ctx.time = t; this.effect.step(this.ctx); },
      render: (dt, t) => {
        this.ctx.dt = dt; this.ctx.time = t;
        this.effect.render(this.ctx);
        // Read pixels in the same task as the draw, so preserveDrawingBuffer is not needed.
        if (this.captureQueue.length) for (const fn of this.captureQueue.splice(0)) fn(this.canvas);
      },
    });
    this.loop.start();
  }

  /** Resolve with a PNG of the next rendered frame. */
  screenshot(): Promise<Blob> {
    return new Promise((resolve, reject) => {
      this.captureQueue.push((c) => c.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/png'));
    });
  }

  setEffect(factory: EffectFactory): void {
    this.effect.dispose();
    this.effect = factory(this.renderer, this.store.all);
    this.effect.resize(this.size, this.renderer);
  }

  dispose(): void {
    this.loop.stop();
    this.ro.disconnect();
    this.unsub();
    this.effect.dispose();
    this.renderer.dispose();
    this.canvas.remove();
  }

  private resize(): void {
    const r = this.container.getBoundingClientRect();
    const w = Math.max(1, Math.round(r.width));
    const h = Math.max(1, Math.round(r.height));
    const dpr = Math.min(MAX_DPR, window.devicePixelRatio || 1);
    if (w === this.size.width && h === this.size.height && dpr === this.size.dpr) return;
    this.size.width = w; this.size.height = h; this.size.dpr = dpr;
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(w, h, false); // false: CSS controls the element size
    this.effect.resize(this.size, this.renderer);
  }
}
