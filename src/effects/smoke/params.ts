import {
  kilo, n10, num, secs,
  type AppParams, type DisplaySpec, type ParamDef, type SectionDef, type ValuesOf,
} from '../../app/params';

export const SMOKE_SECTIONS: readonly SectionDef[] = [
  { id: 'smoke', label: 'Smoke' },
  { id: 'smokeLook', label: 'Look' },
];

/** Swirl is a noise frequency: log display, so each 0.1 multiplies the curl size by the same factor. */
const N10_LOG: DisplaySpec = { scale: 'norm10', curve: 'log' };

// Ranges and defaults are real units; params with `display` show 0..10 on the panel.
// The ids are Smoke's own (the M7/M8 smoke ids are gone; old presets fall back to defaults).
//            id                    label           section      min    max     step    default
export const SMOKE_PARAMS = [
  num('smokeAmount',        'Amount',       'smoke',     0,     1,      0.01,  0.5,    n10()),
  num('smokeRise',          'Rise',         'smoke',     0,     1,      0.01,  0.4,    n10()),
  num('smokeLifespan',      'Lifespan',     'smoke',     2,     15,     0.1,   9,      { format: secs(1) }),
  num('smokeResistance',    'Resistance',   'smoke',     0,     1,      0.01,  0.5,    n10()),
  num('smokeTurbulence',    'Turbulence',   'smoke',     0,     1,      0.01,  0.3,    n10()),
  num('smokeSwirl',         'Swirl',        'smoke',     0.6,   9,      0.01,  1.6,    { display: N10_LOG }),
  num('smokeBreeze',        'Breeze',       'smoke',     0,     1,      0.01,  0.2,    n10()),
  num('smokeBrightness',    'Brightness',   'smokeLook', 0,     2,      0.01,  1,      n10()),
  num('smokeSize',          'Size',         'smokeLook', 0.25,  4,      0.01,  3,      n10({ unit: 'px' })),
  num('smokeDetail',        'Detail',       'smokeLook', 50000, 600000, 10000, 300000, { format: kilo, defaultMobile: 100000 }),
] as const satisfies readonly ParamDef[];

export type SmokeParams = AppParams & ValuesOf<typeof SMOKE_PARAMS>;
