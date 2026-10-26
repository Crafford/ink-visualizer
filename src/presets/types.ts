import type { ParamValues } from '../app/params';

/** Preset schema version. Bump with a migration in presets/store.ts when the shape changes. */
export const PRESET_SCHEMA = 1;

/**
 * A saved look. `params` holds REAL values (the store's units, never the panel's 0..10),
 * keyed by param id, so retuning a display range or curve never breaks a preset.
 * On load, unknown ids are ignored and missing or invalid ones fall back to the defaults.
 */
export interface Preset {
  /** Schema version for migrations. */
  version: typeof PRESET_SCHEMA;
  id: string;
  name: string;
  /** Effect id from effects/registry.ts. Schema 1 files without one are Ink presets. */
  effect: string;
  /** App params (audio response) plus the effect's own params. */
  params: Partial<ParamValues>;
  createdAt: string;
  builtIn?: boolean;
}

/** localStorage document under PRESET_STORAGE_KEY. */
export interface PresetStorage {
  schema: typeof PRESET_SCHEMA;
  presets: Preset[];
}

/** JSON file shape for export/import. */
export interface PresetFile {
  format: 'visualizer/presets';
  schema: typeof PRESET_SCHEMA;
  presets: Preset[];
}
