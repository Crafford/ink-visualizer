import type { ParamStore } from '../app/store';
import { defaultPresetId, resolvePreset, type PresetBank } from '../presets/store';
import type { Preset } from '../presets/types';
import { h, type Component } from './dom';
import { createButton } from './components/Button';

type Mode = 'idle' | 'saving' | 'deleting';

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'preset';

/**
 * Preset picker for the active effect: select (Default + that effect's presets) + Reset
 * (reload the selected preset), then Save / Delete and Export / Import. Save and Delete
 * confirm inline in the second row (no browser dialogs). The selection is remembered per
 * effect for the session. Importing a preset of another effect switches to that effect.
 */
export function createPresetsSection(
  store: ParamStore, bank: PresetBank, switchEffect: (effectId: string) => void,
): Component {
  const defaultId = () => defaultPresetId(store.effectId);
  const chosen = new Map<string, string>();
  let selected = defaultId();
  let mode: Mode = 'idle';

  const select = h('select', { class: 'select', 'aria-label': 'Preset' });
  const status = h('p', { class: 'status', role: 'status', 'aria-live': 'polite' });
  const actions = h('div', { class: 'preset-actions' });
  const file = h('input', { type: 'file', accept: '.json,application/json', hidden: true, 'aria-hidden': 'true', tabindex: -1 });

  const say = (msg: string, error = false) => {
    status.textContent = msg;
    status.classList.toggle('is-error', error);
  };
  const current = (): Preset => bank.get(selected) ?? bank.get(defaultId())!;

  // Over the store's defaults (app + active effect), so every param is set.
  const apply = (p: Preset) => store.patch(resolvePreset(p, store.defaultValues));

  const fillSelect = () => {
    select.replaceChildren(...bank.list(store.effectId).map((p) => h('option', { value: p.id }, p.name)));
    select.value = selected;
  };

  const choose = (id: string, load = true) => {
    const p = bank.get(id);
    selected = p && p.effect === store.effectId ? id : defaultId();
    chosen.set(store.effectId, selected);
    fillSelect();
    if (load) apply(current());
    setMode('idle');
  };

  // ---- second row, per mode
  const nameField = h('input', {
    class: 'text-field', type: 'text', maxlength: 60, spellcheck: 'false', autocomplete: 'off',
    'aria-label': 'Preset name', placeholder: 'Preset name',
  });
  const commitSave = () => {
    try {
      const p = bank.save(nameField.value, store.all, store.effectId);
      say(`Saved “${p.name}”.`);
      choose(p.id, false);
    } catch (err) {
      say((err as Error).message, true);
      nameField.focus();
    }
  };
  nameField.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); commitSave(); }
    else if (e.key === 'Escape') { e.preventDefault(); setMode('idle'); }
  });

  const small = (label: string, onClick: () => void, title?: string, primary = false) => {
    const b = createButton({ label, onClick, title, primary });
    b.classList.add('btn-s');
    return b;
  };

  function setMode(next: Mode): void {
    mode = next;
    actions.classList.toggle('is-confirm', mode !== 'idle');
    const p = current();
    if (mode === 'saving') {
      nameField.value = p.builtIn ? '' : p.name;
      actions.replaceChildren(nameField,
        small('Save', commitSave, 'Save the current values', true),
        small('Cancel', () => setMode('idle')));
      nameField.focus();
      nameField.select();
    } else if (mode === 'deleting') {
      const yes = small('Delete', () => {
        bank.remove(p.id);
        say(`Deleted “${p.name}”.`);
        choose(defaultId(), false);
      }, undefined, true);
      actions.replaceChildren(
        h('span', { class: 'preset-confirm' }, `Delete “${p.name}”?`),
        yes, small('Cancel', () => setMode('idle')));
      yes.focus();
    } else {
      const del = small('Delete', () => setMode('deleting'), 'Delete the selected preset');
      del.disabled = !!p.builtIn;
      actions.replaceChildren(
        small('Save', () => { say(''); setMode('saving'); }, 'Save the current values as a preset'),
        del,
        h('span', { class: 'spacer' }),
        small('Export', exportPreset, 'Download the selected preset as JSON'),
        small('Import', () => file.click(), 'Add presets from a JSON file'),
      );
    }
  }

  function exportPreset(): void {
    const p = current();
    const blob = new Blob([JSON.stringify(bank.toFile(p), null, 2)], { type: 'application/json' });
    const a = h('a', { href: URL.createObjectURL(blob), download: `preset-${slug(p.name)}.json` });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  file.addEventListener('change', async () => {
    const f = file.files?.[0];
    file.value = '';
    if (!f) return;
    try {
      const added = bank.importFile(await f.text());
      say(added.length === 1 ? `Imported “${added[0].name}”.` : `Imported ${added.length} presets.`);
      if (added[0].effect !== store.effectId) switchEffect(added[0].effect);
      choose(added[0].id);
    } catch (err) {
      say((err as Error).message, true);
    }
  });

  select.addEventListener('change', () => { say(''); choose(select.value); });

  const reset = createButton({
    label: 'Reset', onClick: () => { say(''); apply(current()); },
    title: 'Reload the selected preset',
  });

  fillSelect();
  setMode('idle');
  // Effect switched: show its presets and its last selection; values are the store's.
  const offEffect = store.onEffect((effectId) => {
    selected = chosen.get(effectId) ?? defaultId();
    fillSelect();
    setMode('idle');
  });

  const el = h('div', { class: 'presets' },
    h('div', { class: 'preset-row' }, select, reset),
    actions, status, file,
  );
  return { el, dispose: offEffect };
}
