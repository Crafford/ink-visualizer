import type { ColorParamDef, ColorParamId } from '../../app/params';
import type { ParamStore } from '../../app/store';
import { h, nextId, type Component } from '../dom';

/** Label + flat swatch (native color picker underneath) + hex value in mono. */
export function createColorField(def: ColorParamDef, store: ParamStore): Component {
  const id = def.id as ColorParamId;
  const inputId = nextId(`p-${def.id}`);
  const picker = h('input', { class: 'swatch-input', type: 'color', id: inputId });
  const swatch = h('span', { class: 'swatch' }, picker);
  const hex = h('span', { class: 'num-field num-static' });

  picker.addEventListener('input', () => store.set(id, picker.value));

  const el = h('div', { class: 'ctl ctl-color' },
    h('label', { class: 'ctl-label', for: inputId }, def.label),
    h('span', { class: 'ctl-color-value' }, swatch, hex),
  );
  const unwatch = store.watch(id, (v) => {
    picker.value = v.toLowerCase();
    swatch.style.background = v;
    hex.textContent = v.toUpperCase();
  });
  return { el, dispose: unwatch };
}
