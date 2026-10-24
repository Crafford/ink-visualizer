/**
 * rAF loop with a fixed-timestep accumulator.
 * step() runs at a fixed rate (deterministic simulation), render() once per display frame.
 */
export interface LoopCallbacks {
  /** Called once per rAF before stepping (sample audio here). */
  frame(frameDt: number): void;
  step(fixedDt: number, simTime: number): void;
  render(frameDt: number, simTime: number): void;
}

export class Loop {
  static readonly FIXED_DT = 1 / 60;
  /** Cap catch-up work after a stall (tab switch, GC) to avoid a spiral of death. */
  static readonly MAX_STEPS = 4;

  private raf = 0;
  private last = 0;
  private acc = 0;
  private simTime = 0;
  private running = false;

  constructor(private cb: LoopCallbacks) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.last = performance.now();
    this.raf = requestAnimationFrame(this.tick);
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.raf);
  }

  private tick = (now: number): void => {
    if (!this.running) return;
    const frameDt = Math.min(0.25, Math.max(0, (now - this.last) / 1000));
    this.last = now;
    this.cb.frame(frameDt);

    this.acc += frameDt;
    let steps = 0;
    while (this.acc >= Loop.FIXED_DT && steps < Loop.MAX_STEPS) {
      this.cb.step(Loop.FIXED_DT, this.simTime);
      this.simTime += Loop.FIXED_DT;
      this.acc -= Loop.FIXED_DT;
      steps++;
    }
    if (steps === Loop.MAX_STEPS) this.acc = 0;

    this.cb.render(frameDt, this.simTime);
    this.raf = requestAnimationFrame(this.tick);
  };
}
