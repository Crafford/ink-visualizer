import { formatValue, parseValue, quantize, type NumberParamDef } from '../../app/params';
import { h } from '../dom';

/**
 * Borderless mono value field. Shows the formatted value, accepts free text ("200k", "4s"),
 * commits on Enter/blur, reverts on Escape. Arrow keys nudge by one step (Shift = 10 steps).
 */
export interface NumberField {
  el: HTMLInputElement;
  /** Push a new value from outside (does not call onCommit). */
  update(v: number): void;
}

export function createNumberField(
  def: NumberParamDef, label: string, onCommit: (v: number) => void,
): NumberField {
  let value = def.default;
  const el = h('input', {
    class: 'num-field', type: 'text', inputmode: 'decimal', spellcheck: 'false', autocomplete: 'off',
    'aria-label': `${label} value`,
  });

  const show = () => { el.value = formatValue(def, value); };
  const commit = (v: number) => {
    const q = quantize(def, Number.isNaN(v) ? value : v);
    value = q;
    show();
    onCommit(q);
  };

  el.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      const dir = e.key === 'ArrowUp' ? 1 : -1;
      commit(value + dir * def.step * (e.shiftKey ? 10 : 1));
      el.select();
    } else if (e.key === 'Enter') {
      commit(parseValue(el.value));
      el.select();
    } else if (e.key === 'Escape') {
      show();
      el.blur();
    }
  });
  el.addEventListener('focus', () => el.select());
  el.addEventListener('blur', () => commit(parseValue(el.value)));

  return {
    el,
    update(v) {
      value = v;
      if (document.activeElement !== el) show();
    },
  };
}
