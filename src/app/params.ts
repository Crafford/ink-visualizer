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
  /** Display formatter for the value field. Falls back to step precision + unit. */
  format?: (v: number) => string;
  control?: 'slider' | 'knob';
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

type NumOpts = Partial<Pick<NumberParamDef, 'unit' | 'format' | 'control' | 'defaultMobile'>>;

const num = <const Id extends string>(
  id: Id, label: string, section: SectionId,
  min: number, max: number, step: number, def: number, opts: NumOpts = {},
): NumberParamDef<Id> => ({ kind: 'number', id, label, section, min, max, step, default: def, ...opts });

const color = <const Id extends string>(
  id: Id, label: string, section: SectionId, def: string,
): ColorParamDef<Id> => ({ kind: 'color', id, label, section, default: def });

const kilo = (v: number) => `${Math.round(v / 1000)}k`;
const secs = (d: number) => (v: number) => `${v.toFixed(d)}s`;

//            id                    label           section      min    max     step    default
export const PARAMS = [
  num('particleCount',      'Count',        'particles', 10000, 500000, 10000, 200000, { format: kilo, defaultMobile: 50000 }),
  num('emissionRate',       'Emission',     'particles', 0,     1,      0.01,  0.4),
  num('lifespan',           'Lifespan',     'particles', 1,     10,     0.1,   4,      { format: secs(1) }),
  num('turbulenceStrength', 'Turbulence',   'particles', 0,     3,      0.01,  0.8),
  num('turbulenceScale',    'Noise scale',  'particles', 0.2,   4,      0.01,  2),
  num('drag',               'Drag',         'particles', 0,     1,      0.01,  0.4),
  num('emitters',           'Attractors',   'particles', 1,     3,      1,     2),
  num('trailFade',          'Fade',         'trails',    0.85,  0.99,   0.001, 0.94,   { control: 'knob' }),
  num('trailBlur',          'Blur',         'trails',    0,     6,      0.1,   3.5,    { unit: 'px' }),
  num('trailDrift',         'Drift',        'trails',    0,     2,      0.01,  0.3,    { unit: 'px' }),
  num('pointOpacity',       'Ink',          'look',      0.005, 0.1,    0.001, 0.025),
  num('pointSize',          'Point size',   'look',      0.5,   4,      0.1,   1,      { unit: 'px' }),
  color('inkColor',         'Ink colour',   'look',      '#141413'),
  color('paperColor',       'Paper',        'look',      '#F7F7F5'),
  num('contrast',           'Contrast',     'look',      0.5,   3,      0.01,  1.6,    { control: 'knob' }),
  num('grain',              'Grain',        'look',      0,     1,      0.01,  0.25),
  num('bassSens',           'Bass',         'audio',     0,     3,      0.01,  1),
  num('midSens',            'Mid',          'audio',     0,     3,      0.01,  1),
  num('highSens',           'High',         'audio',     0,     3,      0.01,  1),
  num('smoothRise',         'Rise',         'audio',     0,     1,      0.01,  0.02,   { format: secs(2) }),
  num('smoothFall',         'Fall',         'audio',     0,     1,      0.01,  0.25,   { format: secs(2) }),
  num('beatThreshold',      'Beat thresh.', 'audio',     0,     1,      0.01,  0.6),
  num('burstSize',          'Burst',        'audio',     0,     1,      0.01,  0.5),
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
