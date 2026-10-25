/**
 * Parameter schema. Single source of truth for the panel UI, the store,
 * presets and effects. Adding a parameter is one line in PARAMS.
 */

export type SectionId = 'input' | 'particles' | 'trails' | 'look' | 'audio' | 'output';

export const SECTIONS: readonly { id: SectionId; label: string }[] = [
  { id: 'input', label: 'Input' },
  { id: 'particles', label: 'Particles' },
  { id: 'trails', label: 'Trails' },
  { id: 'look', label: 'Look' },
  { id: 'audio', label: 'Audio response' },
  { id: 'output', label: 'Output' },
];

/** Which control renders the param. Defaults: 'slider' for numbers, 'color' for colors. */
export type ControlKind = 'slider' | 'knob' | 'color';

export interface NumberParamDef<Id extends string = string> {
  kind: 'number';
  id: Id;
  label: string;
  section: SectionId;
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

export interface ColorParamDef<Id extends string = string> {
  kind: 'color';
  id: Id;
  label: string;
  section: SectionId;
  /** Hex string, #rrggbb. */
  default: string;
  control?: 'color';
}

export type ParamDef<Id extends string = string> = NumberParamDef<Id> | ColorParamDef<Id>;

type NumOpts = Partial<Pick<NumberParamDef, 'unit' | 'format' | 'control' | 'defaultMobile' | 'display'>>;

const num = <const Id extends string>(
  id: Id, label: string, section: SectionId,
  min: number, max: number, step: number, def: number, opts: NumOpts = {},
): NumberParamDef<Id> => ({ kind: 'number', id, label, section, min, max, step, default: def, ...opts });

const color = <const Id extends string>(
  id: Id, label: string, section: SectionId, def: string,
): ColorParamDef<Id> => ({ kind: 'color', id, label, section, default: def });

const kilo = (v: number) => `${Math.round(v / 1000)}k`;
const secs = (d: number) => (v: number) => `${v.toFixed(d)}s`;
const times = (v: number) => `${v.toFixed(2)}\u00d7`;

/** 0..10 on the panel, linear. */
const N10: DisplaySpec = { scale: 'norm10' };
/** Persistence: the visible trail length goes as 1 / (1 - fade), so map log(1 - fade) linearly. */
const N10_PERSIST: DisplaySpec = { scale: 'norm10', curve: 'log', pole: 1 };
const n10 = (o: NumOpts = {}): NumOpts => ({ display: N10, ...o });

// Ranges and defaults are real units. Params with `display` show 0..10 on the panel.
//            id                    label           section      min    max     step    default
export const PARAMS = [
  num('particleCount',      'Count',        'particles', 10000, 500000, 10000, 250000, { format: kilo, defaultMobile: 50000 }),
  num('emissionRate',       'Emission',     'particles', 0,     1,      0.01,  0.5,    n10()),
  num('lifespan',           'Lifespan',     'particles', 1,     10,     0.1,   5.5,    { format: secs(1) }),
  num('speed',              'Speed',        'particles', 0.1,   2,      0.05,  1.05,   { format: times }),
  num('wetness',            'Wetness',      'particles', 0,     1,      0.01,  0.5,    n10()),
  num('turbulenceStrength', 'Turbulence',   'particles', 0,     3,      0.01,  0.5,    n10()),
  num('turbulenceScale',    'Swirl',        'particles', 0.2,   4,      0.01,  0.8,    n10()),
  num('drag',               'Drag',         'particles', 0,     1,      0.01,  0.5,    n10()),
  num('emitters',           'Sources',      'particles', 1,     3,      1,     3),
  num('trailFade',          'Persistence',  'trails',    0.85,  0.99,   0.0001, 0.92,  { control: 'knob', display: N10_PERSIST }),
  num('trailBlur',          'Blur',         'trails',    0,     6,      0.01,  1.5,    n10({ unit: 'px' })),
  num('trailDrift',         'Drift',        'trails',    0,     2,      0.01,  0.5,    n10({ unit: 'px' })),
  num('pointOpacity',       'Ink',          'look',      0.005, 0.4,    0.001, 0.2,    n10()),
  num('pointSize',          'Size',         'look',      0.5,   4,      0.01,  0.5,    n10({ unit: 'px' })),
  color('inkColor1',        'Ink colour 1', 'look',      '#00BBFF'),
  color('inkColor2',        'Ink colour 2', 'look',      '#EC008C'),
  color('inkColor3',        'Ink colour 3', 'look',      '#FFF200'),
  color('paperColor',       'Paper',        'look',      '#F7F7F5'),
  num('contrast',           'Contrast',     'look',      0.5,   3,      0.01,  1.75,   { control: 'knob', display: N10 }),
  num('grain',              'Grain',        'look',      0,     1,      0.01,  0.1,    n10()),
  num('bassSens',           'Bass',         'audio',     0,     6,      0.01,  3,      n10()),
  num('midSens',            'Mid',          'audio',     0,     6,      0.01,  3,      n10()),
  num('highSens',           'High',         'audio',     0,     6,      0.01,  3,      n10()),
  num('smoothRise',         'Rise',         'audio',     0,     1,      0.01,  0.5,    n10({ format: secs(2) })),
  num('smoothFall',         'Fall',         'audio',     0,     1,      0.01,  0.5,    n10({ format: secs(2) })),
  num('burstSize',          'Burst',        'audio',     0,     2,      0.01,  1,      n10()),
] as const satisfies readonly ParamDef[];

export type AnyParamDef = (typeof PARAMS)[number];
export type ParamId = AnyParamDef['id'];
export type NumberParamId = Extract<AnyParamDef, { kind: 'number' }>['id'];
export type ColorParamId = Extract<AnyParamDef, { kind: 'color' }>['id'];

/** Concrete value bag: numbers for number params, hex strings for colors. */
export type Params = {
  [D in AnyParamDef as D['id']]: D extends { kind: 'color' } ? string : number;
};

const BY_ID = new Map<string, ParamDef>(PARAMS.map((d) => [d.id, d]));
export const getDef = (id: ParamId): ParamDef => BY_ID.get(id)!;

export function defaultParams(env: { mobile?: boolean } = {}): Params {
  const out: Record<string, number | string> = {};
  for (const d of PARAMS as readonly ParamDef[]) {
    out[d.id] = d.kind === 'number' && env.mobile && d.defaultMobile !== undefined ? d.defaultMobile : d.default;
  }
  return out as Params;
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
