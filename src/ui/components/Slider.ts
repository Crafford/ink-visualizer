import { uiScale, type NumberParamDef, type NumberParamId } from '../../app/params';
import type { ParamStore } from '../../app/store';
import { h, nextId, type Component } from '../dom';
import { createNumberField } from './NumberField';

/**
 * Label + value field on one line, a native range input styled as a 2px track below.
 * The range input works on the panel scale (0..10 for norm10 params) and keeps full
 * keyboard and screen-reader support. Double-click resets to the default.
 */
export function createSlider(def: NumberParamDef, store: ParamStore): Component {
  const id = def.id as NumberParamId;
  const inputId = nextId(`p-${def.id}`);
  const scale = uiScale(def);

  const range = h('input', {
    class: 'range', type: 'range', id: inputId,
    min: scale.min, max: scale.max, step: scale.step,
  });
  const field = createNumberField(def, def.label, (v) => store.set(id, v));

  const paint = (v: number) => {
    const u = scale.toUi(v);
    range.value = String(u);
    const pct = ((u - scale.min) / (scale.max - scale.min)) * 100;
    range.style.setProperty('--fill', `${pct}%`);
    field.update(v);
    range.setAttribute('aria-valuetext', scale.text(v));
  };
  range.addEventListener('input', () => store.set(id, scale.fromUi(Number(range.value))));
  range.addEventListener('dblclick', () => store.set(id, store.defaultOf(id)));

  const el = h('div', { class: 'ctl ctl-slider' },
    h('div', { class: 'ctl-row' },
      h('label', { class: 'ctl-label', for: inputId }, def.label),
      field.el,
    ),
    range,
  );
  const unwatch = store.watch(id, paint);
  return { el, dispose: unwatch };
}
