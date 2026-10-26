import { APP_PARAMS, defaultValues, sanitizeValue, type ParamDef, type ParamValues } from '../app/params';
import { PRESET_SCHEMA, type Preset, type PresetFile, type PresetStorage } from './types';

/** Versioned key: a breaking change gets a new key plus a migration from the old one. */
export const PRESET_STORAGE_KEY = 'visualizer.presets.v1';
const FILE_FORMAT = 'visualizer/presets';
/** Schema 1 presets written before the effect selector are all Ink. */
const LEGACY_EFFECT = 'ink';

/** The built-in "Default" of an effect. */
export const defaultPresetId = (effect: string) => `builtin:default:${effect}`;

/** What the bank needs to know about each effect: its own params (APP_PARAMS are added). */
export interface PresetSchema { id: string; params: readonly ParamDef[] }

const schemaDefs = (s: PresetSchema): readonly ParamDef[] => [...APP_PARAMS, ...s.params];

/** Built-in "Default" per effect: the schema defaults (env-aware, e.g. fewer particles on mobile). */
export function builtInPresets(effects: readonly PresetSchema[], env: { mobile?: boolean } = {}): Preset[] {
  return effects.map((e) => ({
    version: PRESET_SCHEMA, id: defaultPresetId(e.id), name: 'Default', effect: e.id,
    params: defaultValues(schemaDefs(e), env), createdAt: '1970-01-01T00:00:00.000Z', builtIn: true,
  }));
}

/**
 * Keep only known ids with values of the right kind. Numbers are not clamped here;
 * ParamStore clamps and snaps them when the preset is applied.
 */
export function cleanParams(raw: unknown, defs: readonly ParamDef[]): Partial<ParamValues> {
  const out: ParamValues = {};
  if (!raw || typeof raw !== 'object') return out;
  const src = raw as Record<string, unknown>;
  for (const d of defs) {
    const v = src[d.id];
    const ok = d.kind === 'number' ? typeof v === 'number' && Number.isFinite(v) : sanitizeValue(d, v) !== undefined;
    if (ok) out[d.id] = v as number | string;
  }
  return out;
}

/** Full value bag for a preset: its values over the defaults (keys of `defaults` only). */
export function resolvePreset(preset: Preset, defaults: Readonly<ParamValues>): ParamValues {
  const out: ParamValues = { ...defaults };
  for (const [k, v] of Object.entries(preset.params)) if (k in out && v !== undefined) out[k] = v;
  return out;
}

const newId = () => `user:${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** User presets in localStorage. Every access is guarded: storage may be blocked or full. */
export class PresetBank {
  private user: Preset[];
  /** Stored presets for effects this build does not have: kept as they are, never shown. */
  private foreign: unknown[] = [];
  readonly builtIn: Preset[];
  private schemas: Map<string, readonly ParamDef[]>;

  constructor(
    effects: readonly PresetSchema[], env: { mobile?: boolean } = {},
    private storage: Storage | null = safeStorage(),
  ) {
    this.schemas = new Map(effects.map((e) => [e.id, schemaDefs(e)]));
    this.builtIn = builtInPresets(effects, env);
    this.user = this.read();
  }

  /** Presets of one effect: its Default first, then the user's. */
  list(effect: string): Preset[] {
    return [...this.builtIn, ...this.user].filter((p) => p.effect === effect);
  }
  get(id: string): Preset | undefined { return [...this.builtIn, ...this.user].find((p) => p.id === id); }
  isReserved(name: string): boolean { return this.builtIn.some((p) => p.name.toLowerCase() === name.trim().toLowerCase()); }
  findUser(name: string, effect: string): Preset | undefined {
    const n = name.trim().toLowerCase();
    return this.user.find((p) => p.effect === effect && p.name.toLowerCase() === n);
  }

  /** Save current values under a name for an effect. Overwrites that effect's user preset of the same name. */
  save(name: string, values: Readonly<ParamValues>, effect: string): Preset {
    const defs = this.schemas.get(effect);
    if (!defs) throw new Error(`Unknown effect "${effect}".`);
    const clean = name.trim().slice(0, 60);
    if (!clean) throw new Error('Name the preset.');
    if (this.isReserved(clean)) throw new Error(`"${clean}" is a built-in preset.`);
    const existing = this.findUser(clean, effect);
    const preset: Preset = {
      version: PRESET_SCHEMA, id: existing?.id ?? newId(), name: clean, effect,
      params: cleanParams(values, defs), createdAt: new Date().toISOString(),
    };
    this.user = existing ? this.user.map((p) => (p.id === existing.id ? preset : p)) : [...this.user, preset];
    this.write();
    return preset;
  }

  remove(id: string): void {
    this.user = this.user.filter((p) => p.id !== id);
    this.write();
  }

  /** Export file for one preset. */
  toFile(preset: Preset): PresetFile {
    const { builtIn, ...rest } = preset;
    return { format: FILE_FORMAT, schema: PRESET_SCHEMA, presets: [{ ...rest, id: builtIn ? newId() : rest.id }] };
  }

  /**
   * Validate and add the presets in an export file. Name clashes with existing presets of the
   * same effect get a numeric suffix; presets for unknown effects are skipped. Returns the
   * added presets; throws with a readable message when invalid.
   */
  importFile(text: string): Preset[] {
    let data: unknown;
    try { data = JSON.parse(text); } catch { throw new Error('Not a JSON file.'); }
    const d = data as Partial<PresetFile> | null;
    if (!d || d.format !== FILE_FORMAT || !Array.isArray(d.presets)) throw new Error('Not a Visualizer preset file.');
    if (typeof d.schema !== 'number' || d.schema > PRESET_SCHEMA) throw new Error('Preset file is from a newer version.');
    const added: Preset[] = [];
    for (const raw of d.presets) {
      const p = this.asPreset(raw);
      if (!p || Object.keys(p.params).length === 0) continue;
      p.name = this.uniqueName(p.name, p.effect);
      if (this.user.some((u) => u.id === p.id)) p.id = newId();
      this.user.push(p);
      added.push(p);
    }
    if (!added.length) throw new Error('No valid presets in the file.');
    this.write();
    return added;
  }

  /** Validate one stored or imported preset; null when invalid or for an unknown effect. */
  private asPreset(raw: unknown): Preset | null {
    if (!raw || typeof raw !== 'object') return null;
    const r = raw as Record<string, unknown>;
    const name = typeof r.name === 'string' ? r.name.trim().slice(0, 60) : '';
    if (!name || !r.params || typeof r.params !== 'object') return null;
    const effect = typeof r.effect === 'string' && r.effect ? r.effect : LEGACY_EFFECT;
    const defs = this.schemas.get(effect);
    if (!defs) return null;
    return {
      version: PRESET_SCHEMA,
      id: typeof r.id === 'string' && r.id && !r.id.startsWith('builtin:') ? r.id : newId(),
      name,
      effect,
      params: cleanParams(r.params, defs),
      createdAt: typeof r.createdAt === 'string' ? r.createdAt : new Date().toISOString(),
    };
  }

  private uniqueName(name: string, effect: string): string {
    const taken = (n: string) => this.isReserved(n) || !!this.findUser(n, effect);
    if (!taken(name)) return name;
    for (let i = 2; ; i++) if (!taken(`${name} (${i})`)) return `${name} (${i})`;
  }

  private read(): Preset[] {
    try {
      const raw = this.storage?.getItem(PRESET_STORAGE_KEY);
      if (!raw) return [];
      const doc = JSON.parse(raw) as Partial<PresetStorage>;
      if (!Array.isArray(doc.presets)) return [];
      const out: Preset[] = [];
      for (const raw of doc.presets) {
        const p = this.asPreset(raw);
        if (p) out.push(p);
        else if (raw && typeof raw === 'object' && typeof (raw as Preset).effect === 'string') this.foreign.push(raw);
      }
      return out;
    } catch {
      return [];
    }
  }

  private write(): void {
    const doc: PresetStorage = { schema: PRESET_SCHEMA, presets: [...this.user, ...(this.foreign as Preset[])] };
    try { this.storage?.setItem(PRESET_STORAGE_KEY, JSON.stringify(doc)); } catch { /* blocked or full: in-memory only */ }
  }
}

function safeStorage(): Storage | null {
  try { return window.localStorage; } catch { return null; }
}
