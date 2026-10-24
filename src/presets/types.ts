import type { Params } from '../app/params';

/** A saved look. Values are validated by ParamStore.patch on load, so stale presets degrade safely. */
export interface Preset {
  /** Schema version for migrations. */
  version: 1;
  id: string;
  name: string;
  /** Effect id from effects/registry.ts. */
  effect: string;
  /** Missing keys fall back to defaults; unknown keys are ignored. */
  params: Partial<Params>;
  createdAt: string;
  builtIn?: boolean;
}

/** Storage backend (localStorage first, file import/export later). */
export interface PresetRepository {
  list(): Promise<Preset[]>;
  get(id: string): Promise<Preset | undefined>;
  save(preset: Preset): Promise<void>;
  remove(id: string): Promise<void>;
}

/** JSON file shape for import/export. */
export interface PresetFile {
  format: 'ink-visualizer/preset';
  presets: Preset[];
}
