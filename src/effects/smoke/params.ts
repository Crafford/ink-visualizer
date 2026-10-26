import {
  N10, color, kilo, n10, num, secs, times, toggle,
  type AppParams, type ParamDef, type ParamValues, type SectionDef, type ValuesOf,
} from '../../app/params';

export const SMOKE_SECTIONS: readonly SectionDef[] = [
  { id: 'plume', label: 'Plume' },
  { id: 'look', label: 'Look' },
];

const SOURCES_2 = { visibleWhen: { id: 'emitters', min: 2 } };
const SOURCES_3 = { visibleWhen: { id: 'emitters', min: 3 } };

/** Colour defaults per resolved mode: process inks on paper, light smoke on black. */
export const SMOKE_MODE_COLOURS = {
  light: { smokeColor1: '#00BBFF', smokeColor2: '#EC008C', smokeColor3: '#FFF200', background: '#F7F7F5' },
  dark: { smokeColor1: '#E8E8E8', smokeColor2: '#9FB8D0', smokeColor3: '#D0A090', background: '#24231E' },
} as const;
const L = SMOKE_MODE_COLOURS.light;

/** Mode: Auto follows the background (light paper when its luminance > 0.5, dark otherwise). */
const SMOKE_MODES = [
  { value: 'auto', label: 'Auto' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
] as const;
export type SmokeMode = (typeof SMOKE_MODES)[number]['value'];
export type ResolvedSmokeMode = 'light' | 'dark';

/** Relative luminance (sRGB coefficients on the gamma-encoded hex, 0..1). */
export function hexLuminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  if (!Number.isFinite(n)) return 1;
  return (0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255;
}

/** The mode actually rendered: Auto resolves from the background luminance. */
export function resolveSmokeMode(mode: string, background: string): ResolvedSmokeMode {
  if (mode === 'light' || mode === 'dark') return mode;
  return hexLuminance(background) > 0.5 ? 'light' : 'dark';
}

// Ranges and defaults are real units. Params with `display` show 0..10 on the panel.
// Shared meanings with Ink: Count, Emission, Lifespan, Speed, Turbulence, Swirl, Drag, Sources,
// Contrast, Grain. Smoke defaults to larger, slower curls (lower Swirl) and a longer life.
//            id                    label           section  min    max     step    default
export const SMOKE_PARAMS = [
  num('particleCount',      'Count',        'plume', 10000, 500000, 10000, 250000, { format: kilo, defaultMobile: 50000 }),
  num('emissionRate',       'Emission',     'plume', 0,     1,      0.01,  0.5,    n10()),
  num('lifespan',           'Lifespan',     'plume', 1,     15,     0.1,   8,      { format: secs(1) }),
  num('speed',              'Speed',        'plume', 0.1,   2,      0.05,  0.75,   { format: times }),
  num('rise',               'Rise',         'plume', 0,     1,      0.01,  0.15,   n10()),
  num('turbulenceStrength', 'Turbulence',   'plume', 0,     3,      0.01,  1.5,    n10()),
  // Max 2.67 = the old (0.2..4) scale's 6.5: larger values only shredded the smoke.
  num('turbulenceScale',    'Swirl',        'plume', 0.2,   2.67,   0.01,  0.58,   n10()),
  num('drag',               'Drag',         'plume', 0,     1,      0.01,  0.5,    n10()),
  num('emitters',           'Sources',      'plume', 1,     3,      1,     3),
  toggle('mode',            'Mode',         'look',  SMOKE_MODES, 'auto'),
  num('density',            'Density',      'look',  0.005, 0.4,    0.001, 0.104,  n10()),
  num('softness',           'Softness',     'look',  0,     1,      0.01,  0.5,    n10()),
  num('haze',               'Haze',         'look',  0,     1,      0.01,  0.5,    n10()),
  num('pointSize',          'Size',         'look',  0.25,  4,      0.01,  0.25,   n10({ unit: 'px' })),
  color('smokeColor1',      'Smoke colour 1', 'look', L.smokeColor1),
  color('smokeColor2',      'Smoke colour 2', 'look', L.smokeColor2, SOURCES_2),
  color('smokeColor3',      'Smoke colour 3', 'look', L.smokeColor3, SOURCES_3),
  color('background',       'Background',   'look',  L.background),
  num('contrast',           'Contrast',     'look',  0.5,   3,      0.01,  1.13,   { control: 'knob', display: N10 }),
  num('grain',              'Grain',        'look',  0,     1,      0.01,  0,      n10()),
] as const satisfies readonly ParamDef[];

export type SmokeParams = AppParams & ValuesOf<typeof SMOKE_PARAMS>;

/**
 * Mode / Background link: each colour still at the other resolved mode's default is swapped to
 * this resolved mode's default, so the defaults follow the mode while custom colours stay.
 * Explicit Light / Dark always set the background to that mode's default (#F7F7F5 / #24231E);
 * in Auto the background is the user's and drives the mode, so it is never changed here
 * (changing it re-resolves the mode and swaps the smoke colours).
 */
export function smokeLinked(id: string, values: Readonly<ParamValues>): ParamValues | null {
  if (id !== 'mode' && !(id === 'background' && values.mode === 'auto')) return null;
  const resolved = resolveSmokeMode(String(values.mode), String(values.background));
  const to = SMOKE_MODE_COLOURS[resolved];
  const from = SMOKE_MODE_COLOURS[resolved === 'dark' ? 'light' : 'dark'];
  const out: ParamValues = {};
  for (const k of Object.keys(to) as (keyof typeof to)[]) {
    if (k === 'background') {
      if (values.mode !== 'auto') out[k] = to[k];
      continue;
    }
    if (String(values[k]).toUpperCase() === from[k].toUpperCase()) out[k] = to[k];
  }
  return out;
}
