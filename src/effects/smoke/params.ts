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

/** Colour defaults per Mode: grey smoke on paper, light smoke on black. */
export const SMOKE_MODE_COLOURS = {
  light: { smokeColor1: '#2B2B2B', smokeColor2: '#3A4A5A', smokeColor3: '#5A3A3A', background: '#F7F7F5' },
  dark: { smokeColor1: '#E8E8E8', smokeColor2: '#9FB8D0', smokeColor3: '#D0A090', background: '#0B0B0C' },
} as const;
const L = SMOKE_MODE_COLOURS.light;

// Ranges and defaults are real units. Params with `display` show 0..10 on the panel.
// Shared meanings with Ink: Count, Emission, Lifespan, Speed, Turbulence, Swirl, Drag, Sources,
// Contrast, Grain. Smoke defaults to larger, slower curls (lower Swirl) and a longer life.
//            id                    label           section  min    max     step    default
export const SMOKE_PARAMS = [
  num('particleCount',      'Count',        'plume', 10000, 500000, 10000, 250000, { format: kilo, defaultMobile: 50000 }),
  num('emissionRate',       'Emission',     'plume', 0,     1,      0.01,  0.5,    n10()),
  num('lifespan',           'Lifespan',     'plume', 1,     15,     0.1,   9,      { format: secs(1) }),
  num('speed',              'Speed',        'plume', 0.1,   2,      0.05,  1,      { format: times }),
  num('rise',               'Rise',         'plume', 0,     1,      0.01,  0.4,    n10()),
  num('turbulenceStrength', 'Turbulence',   'plume', 0,     3,      0.01,  1.2,    n10()),
  num('turbulenceScale',    'Swirl',        'plume', 0.2,   4,      0.01,  0.58,   n10()),
  num('drag',               'Drag',         'plume', 0,     1,      0.01,  0.5,    n10()),
  num('emitters',           'Sources',      'plume', 1,     3,      1,     3),
  toggle('mode',            'Mode',         'look',  [{ value: 'light', label: 'Light paper' }, { value: 'dark', label: 'Dark' }], 'light'),
  num('density',            'Density',      'look',  0.005, 0.4,    0.001, 0.1,    n10()),
  num('softness',           'Softness',     'look',  0,     1,      0.01,  0.5,    n10()),
  num('haze',               'Haze',         'look',  0,     1,      0.01,  0.5,    n10()),
  color('smokeColor1',      'Smoke colour 1', 'look', L.smokeColor1),
  color('smokeColor2',      'Smoke colour 2', 'look', L.smokeColor2, SOURCES_2),
  color('smokeColor3',      'Smoke colour 3', 'look', L.smokeColor3, SOURCES_3),
  color('background',       'Background',   'look',  L.background),
  num('contrast',           'Contrast',     'look',  0.5,   3,      0.01,  1.25,   { control: 'knob', display: N10 }),
  num('grain',              'Grain',        'look',  0,     1,      0.01,  0.1,    n10()),
] as const satisfies readonly ParamDef[];

export type SmokeParams = AppParams & ValuesOf<typeof SMOKE_PARAMS>;

/**
 * Switching Mode swaps each colour that is still at the other mode's default to this mode's
 * default, so the defaults follow the mode while custom colours stay.
 */
export function smokeLinked(id: string, values: Readonly<ParamValues>): ParamValues | null {
  if (id !== 'mode') return null;
  const to = values.mode === 'dark' ? SMOKE_MODE_COLOURS.dark : SMOKE_MODE_COLOURS.light;
  const from = values.mode === 'dark' ? SMOKE_MODE_COLOURS.light : SMOKE_MODE_COLOURS.dark;
  const out: ParamValues = {};
  for (const k of Object.keys(to) as (keyof typeof to)[]) {
    if (String(values[k]).toUpperCase() === from[k].toUpperCase()) out[k] = to[k];
  }
  return out;
}
