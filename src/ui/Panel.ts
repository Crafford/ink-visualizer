import { APP_PARAMS, APP_SECTIONS, type ParamDef, type SectionDef } from '../app/params';
import type { ParamStore } from '../app/store';
import type { AudioEngine } from '../audio/AudioEngine';
import type { EffectEntry } from '../effects/types';
import { h, Disposer, type Component } from './dom';
import { createSlider } from './components/Slider';
import { createKnob } from './components/Knob';
import { createColorField } from './components/ColorField';
import { createButton } from './components/Button';
import { createSegments, createToggleField } from './components/Segments';
import { createInputSection } from './InputSection';
import { createPresetsSection } from './PresetsSection';
import type { PresetBank } from '../presets/store';

export interface PanelActions {
  fullscreen(): void;
  screenshot(): void;
  /** Switch the active effect (store, stage); the panel re-renders itself from the store. */
  setEffect(id: string): void;
}

function controlFor(def: ParamDef, store: ParamStore): Component {
  if (def.kind === 'color') return createColorField(def, store);
  if (def.kind === 'toggle') return createToggleField(def, store);
  return def.control === 'knob' ? createKnob(def, store) : createSlider(def, store);
}

/** Append the controls of `defs` to `body`: knobs first as a compact row, then the rest in schema order. */
function fillControls(body: HTMLElement, defs: readonly ParamDef[], store: ParamStore, d: Disposer): void {
  const knobs = defs.filter((x) => x.kind === 'number' && x.control === 'knob');
  const rest = defs.filter((x) => !knobs.includes(x));
  for (const def of [...knobs, ...rest]) {
    const c = controlFor(def, store);
    d.add(c.dispose);
    body.append(c.el);
    // E.g. per-source colours: only show the ones that are in use.
    const vw = def.visibleWhen;
    if (vw) d.add(store.watch<number>(vw.id, (n) => { c.el.hidden = n < vw.min; }));
  }
}

function section(sec: SectionDef): { el: HTMLElement; body: HTMLElement } {
  const headId = `sec-${sec.id}`;
  const body = h('div', { class: 'section-body' });
  const el = h('section', { class: `section section-${sec.id}`, 'aria-labelledby': headId },
    h('h2', { class: 'section-label', id: headId }, sec.label),
    body,
  );
  return { el, body };
}

/**
 * The control panel: Presets, Input, the active effect's sections, Audio response, Output.
 * Param sections are generated from the schema; Input and Output have bespoke bodies.
 * The effect sections are rebuilt when the store switches effect.
 * Layout-agnostic: the host decides whether it is a sidebar or a sheet.
 */
export function createPanel(
  store: ParamStore, engine: AudioEngine, presets: PresetBank, effects: readonly EffectEntry[], actions: PanelActions,
): Component {
  const d = new Disposer();
  const el = h('aside', { class: 'panel', 'aria-label': 'Controls' });

  const selector = createSegments(
    effects.map((e) => ({ value: e.id, label: e.label })), store.effectId,
    (id) => actions.setEffect(id), 'Effect', 'effect-select',
  );
  el.append(h('header', { class: 'panel-head' },
    h('span', { class: 'panel-title' }, h('span', { class: 'wordmark' }, 'Visualizer'), selector.el),
    h('span', { class: 'mono panel-version' }, 'v0.3'),
  ));

  const presetSection = createPresetsSection(store, presets, actions.setEffect);
  d.add(presetSection.dispose);
  el.append(h('section', { class: 'section section-presets', 'aria-labelledby': 'sec-presets' },
    h('h2', { class: 'section-label', id: 'sec-presets' }, 'Presets'),
    h('div', { class: 'section-body' }, presetSection.el),
  ));

  const input = section(APP_SECTIONS.input);
  const inputBody = createInputSection(engine);
  d.add(inputBody.dispose);
  input.body.append(inputBody.el);
  el.append(input.el);

  // Effect sections live in their own container and are rebuilt on every effect switch.
  const effectHost = h('div', { class: 'effect-sections' });
  el.append(effectHost);
  let effectDisposer = new Disposer();
  const renderEffect = () => {
    effectDisposer.dispose();
    effectDisposer = new Disposer();
    const entry = effects.find((e) => e.id === store.effectId)!;
    effectHost.replaceChildren();
    effectHost.dataset.effect = entry.id;
    for (const sec of entry.sections) {
      const s = section(sec);
      fillControls(s.body, entry.params.filter((p) => p.section === sec.id), store, effectDisposer);
      effectHost.append(s.el);
    }
    selector.set(entry.id);
  };
  renderEffect();
  d.add(store.onEffect(renderEffect));
  d.add(() => effectDisposer.dispose());

  const audio = section(APP_SECTIONS.audio);
  fillControls(audio.body, APP_PARAMS.filter((p) => p.section === 'audio'), store, d);
  el.append(audio.el);

  const output = section(APP_SECTIONS.output);
  output.body.append(h('div', { class: 'btn-row' },
    createButton({ label: 'Fullscreen', onClick: actions.fullscreen }),
    createButton({ label: 'Screenshot', onClick: actions.screenshot }),
  ));
  el.append(output.el);

  return { el, dispose: () => d.dispose() };
}
