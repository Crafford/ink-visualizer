import { PARAMS, defaultParams, isHexColor, type ParamDef, type Params } from '../app/params';
import { PRESET_SCHEMA, type Preset, type PresetFile, type PresetStorage } from './types';

/** Versioned key: a breaking change gets a new key plus a migration from the old one. */
export const PRESET_STORAGE_KEY = 'visualizer.presets.v1';
export const DEFAULT_PRESET_ID = 'builtin:default';
const FILE_FORMAT = 'visualizer/presets';
const EFFECT = 'ink';

/** Built-in "Default": the schema defaults (env-aware, e.g. fewer particles on mobile). */
export function builtInPresets(env: { mobile?: boolean } = {}): Preset[] {
  return [{
    version: PRESET_SCHEMA, id: DEFAULT_PRESET_ID, name: 'Default', effect: EFFECT,
    params: defaultParams(env), createdAt: '1970-01-01T00:00:00.000Z', builtIn: true,
  }];
}

/**
 * Keep only known ids with values of the right kind. Numbers are not clamped here;
 * ParamStore clamps and snaps them when the preset is applied.
 */
export function cleanParams(raw: unknown): Partial<Params> {
  const out: Record<string, number | string> = {};
  if (!raw || typeof raw !== 'object') return out as Partial<Params>;
  const src = raw as Record<string, unknown>;
  for (const d of PARAMS as readonly ParamDef[]) {
    const v = src[d.id];
    if (d.kind === 'number' ? typeof v === 'number' && Number.isFinite(v) : isHexColor(v)) out[d.id] = v as number | string;
  }
  return out as Partial<Params>;
}

/** Full value bag for a preset: its values over the defaults. */
export function resolvePreset(preset: Preset, defaults: Readonly<Params>): Params {
  return { ...defaults, ...cleanParams(preset.params) };
}

function asPreset(raw: unknown): Preset | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const name = typeof r.name === 'string' ? r.name.trim().slice(0, 60) : '';
  if (!name || !r.params || typeof r.params !== 'object') return null;
  return {
    version: PRESET_SCHEMA,
    id: typeof r.id === 'string' && r.id && !r.id.startsWith('builtin:') ? r.id : newId(),
    name,
    effect: typeof r.effect === 'string' ? r.effect : EFFECT,
    params: cleanParams(r.params),
    createdAt: typeof r.createdAt === 'string' ? r.createdAt : new Date().toISOString(),
  };
}

const newId = () => `user:${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** User presets in localStorage. Every access is guarded: storage may be blocked or full. */
export class PresetBank {
  private user: Preset[];
  readonly builtIn: Preset[];

  constructor(env: { mobile?: boolean } = {}, private storage: Storage | null = safeStorage()) {
    this.builtIn = builtInPresets(env);
    this.user = this.read();
  }

  list(): Preset[] { return [...this.builtIn, ...this.user]; }
  get(id: string): Preset | undefined { return this.list().find((p) => p.id === id); }
  isReserved(name: string): boolean { return this.builtIn.some((p) => p.name.toLowerCase() === name.trim().toLowerCase()); }
  findUser(name: string): Preset | undefined {
    const n = name.trim().toLowerCase();
    return this.user.find((p) => p.name.toLowerCase() === n);
  }

  /** Save current values under a name. Overwrites a user preset of the same name. */
  save(name: string, values: Readonly<Params>): Preset {
    const clean = name.trim().slice(0, 60);
    if (!clean) throw new Error('Name the preset.');
    if (this.isReserved(clean)) throw new Error(`"${clean}" is a built-in preset.`);
    const existing = this.findUser(clean);
    const preset: Preset = {
      version: PRESET_SCHEMA, id: existing?.id ?? newId(), name: clean, effect: EFFECT,
      params: cleanParams(values), createdAt: new Date().toISOString(),
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
   * Validate and add the presets in an export file. Name clashes with existing presets get
   * a numeric suffix. Returns the added presets; throws with a readable message when invalid.
   */
  importFile(text: string): Preset[] {
    let data: unknown;
    try { data = JSON.parse(text); } catch { throw new Error('Not a JSON file.'); }
    const d = data as Partial<PresetFile> | null;
    if (!d || d.format !== FILE_FORMAT || !Array.isArray(d.presets)) throw new Error('Not a Visualizer preset file.');
    if (typeof d.schema !== 'number' || d.schema > PRESET_SCHEMA) throw new Error('Preset file is from a newer version.');
    const added: Preset[] = [];
    for (const raw of d.presets) {
      const p = asPreset(raw);
      if (!p || Object.keys(p.params).length === 0) continue;
      p.name = this.uniqueName(p.name);
      if (this.user.some((u) => u.id === p.id)) p.id = newId();
      this.user.push(p);
      added.push(p);
    }
    if (!added.length) throw new Error('No valid presets in the file.');
    this.write();
    return added;
  }

  private uniqueName(name: string): string {
    const taken = (n: string) => this.isReserved(n) || !!this.findUser(n);
    if (!taken(name)) return name;
    for (let i = 2; ; i++) if (!taken(`${name} (${i})`)) return `${name} (${i})`;
  }

  private read(): Preset[] {
    try {
      const raw = this.storage?.getItem(PRESET_STORAGE_KEY);
      if (!raw) return [];
      const doc = JSON.parse(raw) as Partial<PresetStorage>;
      if (!Array.isArray(doc.presets)) return [];
      return doc.presets.map(asPreset).filter((p): p is Preset => p !== null);
    } catch {
      return [];
    }
  }

  private write(): void {
    const doc: PresetStorage = { schema: PRESET_SCHEMA, presets: this.user };
    try { this.storage?.setItem(PRESET_STORAGE_KEY, JSON.stringify(doc)); } catch { /* blocked or full: in-memory only */ }
  }
}

function safeStorage(): Storage | null {
  try { return window.localStorage; } catch { return null; }
}
