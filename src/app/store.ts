import {
  PARAMS, defaultParams, getDef, isHexColor, quantize,
  type ParamDef, type ParamId, type Params,
} from './params';

export type ParamListener = (id: ParamId, value: Params[ParamId], all: Readonly<Params>) => void;

/**
 * Tiny typed observable store for parameter values.
 * All writes are validated against the schema (clamped, snapped, hex-checked).
 */
export class ParamStore {
  private values: Params;
  private readonly defaults: Params;
  private readonly listeners = new Set<ParamListener>();

  constructor(env: { mobile?: boolean } = {}) {
    this.defaults = defaultParams(env);
    this.values = { ...this.defaults };
  }

  get<K extends ParamId>(id: K): Params[K] {
    return this.values[id];
  }

  /** Live, read-only view. Effects read this every frame; do not mutate. */
  get all(): Readonly<Params> {
    return this.values;
  }

  defaultOf<K extends ParamId>(id: K): Params[K] {
    return this.defaults[id];
  }

  set<K extends ParamId>(id: K, value: Params[K]): void {
    const next = this.sanitize(getDef(id), value);
    if (next === undefined || next === this.values[id]) return;
    (this.values as Record<ParamId, number | string>)[id] = next;
    this.emit(id);
  }

  /** Apply many values (preset load). Unknown keys and invalid values are ignored. */
  patch(partial: Partial<Record<string, unknown>>): void {
    for (const d of PARAMS as readonly ParamDef[]) {
      if (!(d.id in partial)) continue;
      this.set(d.id as ParamId, partial[d.id] as never);
    }
  }

  reset(): void {
    this.patch(this.defaults);
  }

  subscribe(fn: ParamListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Subscribe to one parameter; fires immediately with the current value. */
  watch<K extends ParamId>(id: K, fn: (value: Params[K]) => void): () => void {
    fn(this.values[id]);
    return this.subscribe((changed, v) => {
      if (changed === id) fn(v as Params[K]);
    });
  }

  private sanitize(def: ParamDef, value: unknown): number | string | undefined {
    if (def.kind === 'color') return isHexColor(value) ? value.toUpperCase() : undefined;
    return typeof value === 'number' ? quantize(def, value) : undefined;
  }

  private emit(id: ParamId): void {
    const v = this.values[id];
    for (const fn of this.listeners) fn(id, v, this.values);
  }
}
