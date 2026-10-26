import {
  APP_PARAMS, defaultValues, sanitizeValue,
  type ParamDef, type ParamValue, type ParamValues,
} from './params';

export type ParamListener = (id: string, value: ParamValue, all: Readonly<ParamValues>) => void;

/** What the store needs to know about an effect (a subset of EffectEntry). */
export interface EffectSchema {
  id: string;
  params: readonly ParamDef[];
  linked?(id: string, values: Readonly<ParamValues>): ParamValues | null;
}

/**
 * Tiny observable store for parameter values: the app params (APP_PARAMS) plus the
 * active effect's params. All writes are validated against the schema (clamped, snapped,
 * hex-checked, toggle values checked); ids outside the current schema are ignored.
 *
 * setEffect() swaps the effect param set. Each effect's last values are kept for the
 * session, so switching back restores them. App params are untouched by a switch.
 */
export class ParamStore {
  private values: ParamValues = {};
  private defaults: ParamValues = {};
  private defs: ParamDef[] = [];
  private byId = new Map<string, ParamDef>();
  private effect: EffectSchema;
  /** Last effect values per effect id (only the effect's own params). */
  private kept = new Map<string, ParamValues>();
  private patching = false;
  private readonly listeners = new Set<ParamListener>();
  private readonly effectListeners = new Set<(effectId: string) => void>();

  constructor(effect: EffectSchema, private readonly env: { mobile?: boolean } = {}) {
    this.effect = effect;
    const app = defaultValues(APP_PARAMS, env);
    this.load(effect, app);
  }

  /** Active effect id. */
  get effectId(): string { return this.effect.id; }

  /** Current schema: APP_PARAMS then the active effect's params. */
  get schema(): readonly ParamDef[] { return this.defs; }

  def(id: string): ParamDef | undefined { return this.byId.get(id); }
  has(id: string): boolean { return this.byId.has(id); }

  get(id: string): ParamValue { return this.values[id]; }
  num(id: string): number { return this.values[id] as number; }

  /** Live, read-only view. Effects read this every frame; do not mutate. */
  get all(): Readonly<ParamValues> {
    return this.values;
  }

  /** Defaults of the current schema (env-aware). */
  get defaultValues(): Readonly<ParamValues> { return this.defaults; }

  defaultOf(id: string): ParamValue {
    return this.defaults[id];
  }

  set(id: string, value: unknown): void {
    const def = this.byId.get(id);
    if (!def) return;
    const next = sanitizeValue(def, value);
    if (next === undefined || next === this.values[id]) return;
    this.values[id] = next;
    this.emit(id);
    if (!this.patching && this.effect.linked) {
      const more = this.effect.linked(id, this.values);
      if (more) this.patch(more);
    }
  }

  /** Apply many values (preset load). Unknown keys and invalid values are ignored. */
  patch(partial: Readonly<Record<string, unknown>>): void {
    const was = this.patching;
    this.patching = true;
    try {
      for (const d of this.defs) {
        if (d.id in partial) this.set(d.id, partial[d.id]);
      }
    } finally {
      this.patching = was;
    }
  }

  reset(): void {
    this.patch(this.defaults);
  }

  /**
   * Switch the effect param set. The outgoing effect's values are kept; the incoming
   * effect gets its kept values (or its defaults the first time). Fires onEffect listeners,
   * not per-param listeners.
   */
  setEffect(effect: EffectSchema): void {
    if (effect.id === this.effect.id) return;
    const ownIds = new Set(this.effect.params.map((d) => d.id));
    const keep: ParamValues = {};
    for (const id of ownIds) keep[id] = this.values[id];
    this.kept.set(this.effect.id, keep);

    const app: ParamValues = {};
    for (const d of APP_PARAMS) app[d.id] = this.values[d.id];
    this.effect = effect;
    this.load(effect, app);
    for (const fn of this.effectListeners) fn(effect.id);
  }

  subscribe(fn: ParamListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Called after the effect param set has been swapped. */
  onEffect(fn: (effectId: string) => void): () => void {
    this.effectListeners.add(fn);
    return () => this.effectListeners.delete(fn);
  }

  /** Subscribe to one parameter; fires immediately with the current value. */
  watch<V extends ParamValue = ParamValue>(id: string, fn: (value: V) => void): () => void {
    fn(this.values[id] as V);
    return this.subscribe((changed, v) => {
      if (changed === id) fn(v as V);
    });
  }

  private load(effect: EffectSchema, app: ParamValues): void {
    this.defs = [...APP_PARAMS, ...effect.params];
    this.byId = new Map(this.defs.map((d) => [d.id, d]));
    this.defaults = defaultValues(this.defs, this.env);
    // A new object, so a reference held across the switch never sees mixed effects.
    this.values = { ...this.defaults, ...app, ...(this.kept.get(effect.id) ?? {}) };
  }

  private emit(id: string): void {
    const v = this.values[id];
    for (const fn of this.listeners) fn(id, v, this.values);
  }
}
