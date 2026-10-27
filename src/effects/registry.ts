import type { EffectEntry } from './types';
import { createInkEffect } from './ink/InkEffect';
import { INK_PARAMS, INK_SECTIONS } from './ink/params';
import { createSmokeEffect } from './smoke/SmokeEffect';
import { SMOKE_PARAMS, SMOKE_SECTIONS, smokeLinked } from './smoke/params';

/** All available effects, in panel order. The first entry is the default. */
export const EFFECTS: readonly EffectEntry[] = [
  { id: 'ink', label: 'Ink', params: INK_PARAMS, sections: INK_SECTIONS, create: createInkEffect },
  {
    id: 'smoke', label: 'Smoke', params: SMOKE_PARAMS, sections: SMOKE_SECTIONS,
    create: createSmokeEffect, linked: smokeLinked,
  },
];

export const DEFAULT_EFFECT = EFFECTS[0].id;

export const getEffect = (id: string): EffectEntry | undefined => EFFECTS.find((e) => e.id === id);
