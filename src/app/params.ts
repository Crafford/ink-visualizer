/**
 * Parameter schema. Single source of truth for the panel UI, the store, presets and effects.
 *
 * App-level params (input / audio response / output) live in APP_PARAMS. Every effect exports
 * its own PARAMS list built with the same helpers (num, color, toggle, n10...) and its own
 * sections; the store holds APP_PARAMS plus the active effect's params.
 */

/** App-level sections. Effects declare their own (see EffectSection). */
export type AppSectionId = 'input' | 'audio' | 'output';
/** Any section id: an app section or one declared by an effect. */
export type SectionId = string;

export interface SectionDef { id: SectionId; label: string }

export const APP_SECTIONS = {
  input: { id: 'input', label: 'Input' },
  audio: { id: 'audio', label: 'Audio response' },
  output: { id: 'output', label: 'Output' },
} as const satisfies Record<AppSectionId, SectionDef>;

/** Which control renders the param. Defaults: 'slider' for numbers, 'color' for colors, segments for toggles. */
export type ControlKind = 'slider' | 'knob' | 'color' | 'segments';

/** Show the control only while another (number) param is at least `min`. */
export interface VisibleWhen { id: string; min: number }

interface BaseDef<Id extends string> {
  id: Id;
  label: string;
  section: SectionId;
  visibleWhen?: VisibleWhen;
}

export interface NumberParamDef<Id extends string = string> extends BaseDef<Id> {
  kind: 'number';
  min: number;
  max: number;
  step: number;
  default: number;
  /** Optional default on mobile / low-power devices. */
  defaultMobile?: number;
  unit?: string;
  /** Display formatter for the value field (real units). Falls back to step precision + unit. */
  format?: (v: number) => string;
  control?: 'slider' | 'knob';
  /**
   * Panel display scale. Absent: the panel shows the real value in real units.
   * `norm10`: the panel shows 0..10 (one decimal) like a hardware knob, mapped onto
   * min..max through `curve`. The store, the engine and presets always hold the real value.
   */
  display?: DisplaySpec;
}

/**
 * 0..10 display mapping. t = display / 10.
 * - linear: real = min + (max - min) * t
 * - pow:    real = min + (max - min) * t^exponent
 * - log:    interpolates log|real - pole| between the ends (pole defaults to 0), with
 *           t^exponent (default 1). trailFade uses pole 1: log(1 - fade) is linear in t.
 */
export interface DisplaySpec {
  scale: 'norm10';
  curve?: 'linear' | 'pow' | 'log';
  exponent?: number;
  /** log curve only: the value the log distance is measured from. */
  pole?: number;
}

export interface ColorParamDef<Id extends string = string> extends BaseDef<Id> {
  kind: 'color';
  /** Hex string, #rrggbb. */
  default: string;
  control?: 'color';
}

/** A choice between a few named values (the panel shows a segmented control). */
export interface ToggleParamDef<Id extends string = string, V extends string = string> extends BaseDef<Id> {
  kind: 'toggle';
  options: readonly { value: V; label: string }[];
  default: V;
}

export type ParamDef<Id extends string = string> = NumberParamDef<Id> | ColorParamDef<Id> | ToggleParamDef<Id>;

export type NumOpts = Partial<Pick<NumberParamDef, 'unit' | 'format' | 'control' | 'defaultMobile' | 'display' | 'visibleWhen'>>;

export const num = <const Id extends string>(
  id: Id, label: string, section: SectionId,
  min: number, max: number, step: number, def: number, opts: NumOpts = {},
): NumberParamDef<Id> => ({ kind: 'number', id, label, section, min, max, step, default: def, ...opts });

export const color = <const Id extends string>(
  id: Id, label: string, section: SectionId, def: string, opts: { visibleWhen?: VisibleWhen } = {},
): ColorParamDef<Id> => ({ kind: 'color', id, label, section, default: def, ...opts });

export const toggle = <const Id extends string, const V extends string>(
  id: Id, label: string, section: SectionId, options: readonly { value: V; label: string }[], def: NoInfer<V>,
): ToggleParamDef<Id, V> => ({ kind: 'toggle', id, label, section, options, default: def });

export const kilo = (v: number) => `${Math.round(v / 1000)}k`;
export const secs = (d: number) => (v: number) => `${v.toFixed(d)}s`;
export const times = (v: number) => `${v.toFixed(2)}\u00d7`;

/** 0..10 on the panel, linear. */
export const N10: DisplaySpec = { scale: 'norm10' };
/** Persistence: the visible trail length goes as 1 / (1 - fade), so map log(1 - fade) linearly. */
export const N10_PERSIST: DisplaySpec = { scale: 'norm10', curve: 'log', pole: 1 };
export const n10 = (o: NumOpts = {}): NumOpts => ({ display: N10, ...o });

// Ranges and defaults are real units. Params with `display` show 0..10 on the panel.
// App-level: audio response (read by the engine and by every effect's beat mapping).
//            id                    label           section      min    max     step    default
export const APP_PARAMS = [
  num('bassSens',           'Bass',         'audio',     0,     6,      0.01,  3,      n10()),
  num('midSens',            'Mid',          'audio',     0,     6,      0.01,  3,      n10()),
  num('highSens',           'High',         'audio',     0,     6,      0.01,  3,      n10()),
  num('smoothRise',         'Attack',       'audio',     0,     1,      0.01,  0.5,    n10({ format: secs(2) })),
  num('smoothFall',         'Release',      'audio',     0,     1,      0.01,  0.5,    n10({ format: secs(2) })),
  num('burstSize',          'Surge',        'audio',     0,     2,      0.01,  1,      n10()),
] as const satisfies readonly ParamDef[];

/** Value bag of a param list: numbers, hex strings, toggle values. */
export type ValuesOf<T extends readonly ParamDef[]> = {
  [D in T[number] as D['id']]: D extends { kind: 'number' } ? number : D extends ToggleParamDef<string, infer V> ? V : string;
};

export type ParamValue = number | string;
/** Untyped value bag (the store's view across effects). */
export type ParamValues = Record<string, ParamValue>;

export type AppParams = ValuesOf<typeof APP_PARAMS>;
export type AppParamId = keyof AppParams;

export function defaultValues(defs: readonly ParamDef[], env: { mobile?: boolean } = {}): ParamValues {
  const out: ParamValues = {};
  for (const d of defs) {
    out[d.id] = d.kind === 'number' && env.mobile && d.defaultMobile !== undefined ? d.defaultMobile : d.default;
  }
  return out;
}

/** Validate one value against its def: clamp + snap numbers, check hex and toggle values. */
export function sanitizeValue(def: ParamDef, value: unknown): ParamValue | undefined {
  if (def.kind === 'color') return isHexColor(value) ? value.toUpperCase() : undefined;
  if (def.kind === 'toggle') return def.options.some((o) => o.value === value) ? (value as string) : undefined;
  return typeof value === 'number' ? quantize(def, value) : undefined;
}

/** Clamp and snap a number to a def's range and step. */
export function quantize(def: NumberParamDef, v: number): number {
  if (!Number.isFinite(v)) return def.default;
  const c = Math.min(def.max, Math.max(def.min, v));
  const snapped = def.min + Math.round((c - def.min) / def.step) * def.step;
  const decimals = stepDecimals(def.step);
  return Number(Math.min(def.max, snapped).toFixed(decimals));
}

export function stepDecimals(step: number): number {
  const s = String(step);
  const i = s.indexOf('.');
  return i < 0 ? 0 : s.length - i - 1;
}

export function formatValue(def: NumberParamDef, v: number): string {
  if (def.format) return def.format(v);
  return v.toFixed(stepDecimals(def.step)) + (def.unit ?? '');
}

/** Parse user input like "200k", "4s", "1.5px", "0.3". Returns NaN on failure. */
export function parseValue(raw: string): number {
  const m = raw.trim().toLowerCase().match(/^(-?\d*\.?\d+)\s*(k)?/);
  if (!m) return NaN;
  return parseFloat(m[1]) * (m[2] ? 1000 : 1);
}

const HEX = /^#[0-9a-f]{6}$/i;
export const isHexColor = (v: unknown): v is string => typeof v === 'string' && HEX.test(v);

// ---------------------------------------------------------------- display scale

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

/** Real value -> display fraction 0..1 (unrounded). */
function toFrac(def: NumberParamDef, spec: DisplaySpec, v: number): number {
  const curve = spec.curve ?? 'linear';
  let f: number;
  if (curve === 'log') {
    const p = spec.pole ?? 0;
    const a = Math.log(Math.abs(def.min - p));
    const b = Math.log(Math.abs(def.max - p));
    f = (Math.log(Math.max(1e-12, Math.abs(v - p))) - a) / (b - a);
  } else {
    f = (v - def.min) / (def.max - def.min);
  }
  f = clamp01(f);
  const e = curve === 'linear' ? 1 : spec.exponent ?? 1;
  return e === 1 ? f : Math.pow(f, 1 / e);
}

/** Display fraction 0..1 -> real value (unquantized). */
function fromFrac(def: NumberParamDef, spec: DisplaySpec, t: number): number {
  const curve = spec.curve ?? 'linear';
  const e = curve === 'linear' ? 1 : spec.exponent ?? 1;
  const f = e === 1 ? clamp01(t) : Math.pow(clamp01(t), e);
  if (curve === 'log') {
    const p = spec.pole ?? 0;
    const a = Math.log(Math.abs(def.min - p));
    const b = Math.log(Math.abs(def.max - p));
    return p + Math.sign(def.min - p) * Math.exp(a + f * (b - a));
  }
  return def.min + f * (def.max - def.min);
}

/**
 * How a control presents a number param: the range, step and text of the value it shows,
 * and the conversion to and from the real value the store holds.
 */
export interface UiScale {
  min: number;
  max: number;
  step: number;
  /** Real -> shown value (unrounded). */
  toUi(v: number): number;
  /** Shown value -> real (clamped to the range, quantized to the param's step). */
  fromUi(u: number): number;
  /** Text for the value field. */
  text(v: number): string;
}

const scales = new WeakMap<NumberParamDef, UiScale>();

export function uiScale(def: NumberParamDef): UiScale {
  let s = scales.get(def);
  if (s) return s;
  const spec = def.display;
  if (spec?.scale === 'norm10') {
    const toUi = (v: number) => toFrac(def, spec, v) * 10;
    s = {
      min: 0, max: 10, step: 0.1,
      toUi,
      fromUi: (u) => quantize(def, fromFrac(def, spec, (Number.isFinite(u) ? u : 0) / 10)),
      text: (v) => toUi(v).toFixed(1),
    };
  } else {
    s = {
      min: def.min, max: def.max, step: def.step,
      toUi: (v) => v,
      fromUi: (u) => quantize(def, u),
      text: (v) => formatValue(def, v),
    };
  }
  scales.set(def, s);
  return s;
}
