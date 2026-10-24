import type { EffectFactory } from './types';
import { createInkEffect } from './ink/InkEffect';

/** All available effects, by id. The first entry is the default. */
export const EFFECTS: Record<string, EffectFactory> = {
  ink: createInkEffect,
};

export const DEFAULT_EFFECT = 'ink';
