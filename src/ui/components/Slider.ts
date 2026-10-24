import { formatValue, type NumberParamDef, type NumberParamId } from '../../app/params';
import type { ParamStore } from '../../app/store';
import { h, nextId, type Component } from '../dom';
import { createNumberField } from './NumberField';

/**
 * Label + value field on one line, a native range input styled as a 2px track below.
 * The range input keeps full keyboard and screen-reader support.
 */
export function createSlider(def: NumberParamDef, store: ParamStore): Component {
  const id = def.id as NumberParamId;
  const inputId = nextId(`p-${def.id}`);

  const range = h('input', {
    class: 'range', type: 'range', id: inputId,
    min: def.min, max: def.max, step: def.step,
  });
  const field = createNumberField(def, def.label, (v) => store.set(id, v));

  const paint = (v: number) => {
    range.value = String(v);
    const pct = ((v - def.min) / (def.max - def.min)) * 100;
    range.style.setProperty('--fill', `${pct}%`);
    field.update(v);
    range.setAttribute('aria-valuetext', formatValue(def, v));
  };
  range.addEventListener('input', () => store.set(id, Number(range.value)));
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
