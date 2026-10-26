import {
  N10, N10_PERSIST, color, kilo, n10, num, secs, times,
  type AppParams, type ParamDef, type SectionDef, type ValuesOf,
} from '../../app/params';

export const INK_SECTIONS: readonly SectionDef[] = [
  { id: 'particles', label: 'Particles' },
  { id: 'trails', label: 'Trails' },
  { id: 'look', label: 'Look' },
];

const SOURCES_2 = { visibleWhen: { id: 'emitters', min: 2 } };
const SOURCES_3 = { visibleWhen: { id: 'emitters', min: 3 } };

// Ranges and defaults are real units. Params with `display` show 0..10 on the panel.
//            id                    label           section      min    max     step    default
export const INK_PARAMS = [
  num('particleCount',      'Count',        'particles', 10000, 500000, 10000, 350000, { format: kilo, defaultMobile: 50000 }),
  num('emissionRate',       'Emission',     'particles', 0,     1,      0.01,  0.5,    n10()),
  num('lifespan',           'Lifespan',     'particles', 1,     10,     0.1,   5.5,    { format: secs(1) }),
  num('speed',              'Speed',        'particles', 0.1,   2,      0.05,  1.05,   { format: times }),
  num('wetness',            'Wetness',      'particles', 0,     1,      0.01,  0.5,    n10()),
  num('turbulenceStrength', 'Turbulence',   'particles', 0,     3,      0.01,  0.45,    n10()),
  num('turbulenceScale',    'Swirl',        'particles', 0.2,   4,      0.01,  0.77,    n10()),
  num('drag',               'Drag',         'particles', 0,     1,      0.01,  0.5,    n10()),
  num('emitters',           'Sources',      'particles', 1,     3,      1,     3),
  num('trailFade',          'Persistence',  'trails',    0.85,  0.99,   0.0001, 0.9238,  { control: 'knob', display: N10_PERSIST }),
  num('trailBlur',          'Blur',         'trails',    0,     6,      0.01,  1.5,    n10({ unit: 'px' })),
  num('trailDrift',         'Drift',        'trails',    0,     2,      0.01,  0.5,    n10({ unit: 'px' })),
  num('pointOpacity',       'Ink',          'look',      0.005, 0.4,    0.001, 0.2025,    n10()),
  num('pointSize',          'Size',         'look',      0.5,   4,      0.01,  0.5,    n10({ unit: 'px' })),
  color('inkColor1',        'Ink colour 1', 'look',      '#00BBFF'),
  color('inkColor2',        'Ink colour 2', 'look',      '#EC008C', SOURCES_2),
  color('inkColor3',        'Ink colour 3', 'look',      '#FFF200', SOURCES_3),
  color('paperColor',       'Paper',        'look',      '#F7F7F5'),
  num('contrast',           'Contrast',     'look',      0.5,   3,      0.01,  1.75,   { control: 'knob', display: N10 }),
  num('grain',              'Grain',        'look',      0,     1,      0.01,  0.1,    n10()),
] as const satisfies readonly ParamDef[];

export type InkParams = AppParams & ValuesOf<typeof INK_PARAMS>;
export type InkParamId = keyof InkParams;
