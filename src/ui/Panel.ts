import { PARAMS, SECTIONS, type ParamDef, type SectionId } from '../app/params';
import type { ParamStore } from '../app/store';
import type { AudioEngine } from '../audio/AudioEngine';
import { h, Disposer, type Component } from './dom';
import { createSlider } from './components/Slider';
import { createKnob } from './components/Knob';
import { createColorField } from './components/ColorField';
import { createButton } from './components/Button';
import { createInputSection } from './InputSection';

/** Controls shown only when at least this many attractors are active. */
const MIN_EMITTERS: Partial<Record<string, number>> = { inkColor2: 2, inkColor3: 3 };

export interface PanelActions {
  fullscreen(): void;
  screenshot(): void;
}

function controlFor(def: ParamDef, store: ParamStore): Component {
  if (def.kind === 'color') return createColorField(def, store);
  return def.control === 'knob' ? createKnob(def, store) : createSlider(def, store);
}

/**
 * The control panel. Param sections are generated from the schema; Input and Output
 * have bespoke bodies. Layout-agnostic: the host decides whether it is a sidebar or a sheet.
 */
export function createPanel(store: ParamStore, engine: AudioEngine, actions: PanelActions): Component {
  const d = new Disposer();
  const el = h('aside', { class: 'panel', 'aria-label': 'Controls' });

  el.append(h('header', { class: 'panel-head' },
    h('span', { class: 'wordmark' }, 'Ink'),
    h('span', { class: 'mono panel-version' }, 'v0.1'),
  ));

  const bySection = new Map<SectionId, ParamDef[]>();
  for (const def of PARAMS as readonly ParamDef[]) {
    const list = bySection.get(def.section) ?? [];
    list.push(def);
    bySection.set(def.section, list);
  }

  for (const sec of SECTIONS) {
    const headId = `sec-${sec.id}`;
    const body = h('div', { class: 'section-body' });
    const section = h('section', { class: `section section-${sec.id}`, 'aria-labelledby': headId },
      h('h2', { class: 'section-label', id: headId }, sec.label),
      body,
    );

    if (sec.id === 'input') {
      const input = createInputSection(engine);
      d.add(input.dispose);
      body.append(input.el);
    } else if (sec.id === 'output') {
      body.append(h('div', { class: 'btn-row' },
        createButton({ label: 'Fullscreen', onClick: actions.fullscreen }),
        createButton({ label: 'Screenshot', onClick: actions.screenshot }),
        createButton({ label: 'Reset', onClick: () => store.reset(), title: 'Reset all parameters to defaults' }),
      ));
    }

    // Knobs first as a compact row, then sliders and colors in schema order.
    const defs = bySection.get(sec.id) ?? [];
    const knobs = defs.filter((x) => x.kind === 'number' && x.control === 'knob');
    const rest = defs.filter((x) => !knobs.includes(x));
    for (const def of [...knobs, ...rest]) {
      const c = controlFor(def, store);
      d.add(c.dispose);
      body.append(c.el);
      // Per-attractor colours: only show the ones that are in use.
      const need = MIN_EMITTERS[def.id];
      if (need) d.add(store.watch('emitters', (n) => { c.el.hidden = n < need; }));
    }
    el.append(section);
  }

  return { el, dispose: () => d.dispose() };
}
