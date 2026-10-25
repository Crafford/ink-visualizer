import { formatValue, parseValue, uiScale, type NumberParamDef } from '../../app/params';
import { h } from '../dom';

/**
 * Borderless mono value field. Shows the value on the param's panel scale (0..10 for
 * `display: norm10`, else real units), accepts free text ("200k", "4s", "3.5"), commits
 * on Enter (or blur after typing), reverts on Escape. Arrow keys nudge by one display step (Shift = 10 steps).
 * The value in and out is always the real value; the hover title shows it in real units.
 */
export interface NumberField {
  el: HTMLInputElement;
  /** Push a new real value from outside (does not call onCommit). */
  update(v: number): void;
}

export function createNumberField(
  def: NumberParamDef, label: string, onCommit: (v: number) => void,
): NumberField {
  const scale = uiScale(def);
  const norm = def.display !== undefined;
  let value = def.default;
  /** True once the user has typed since the value was last shown; blur commits only then. */
  let edited = false;
  const el = h('input', {
    class: 'num-field', type: 'text', inputmode: 'decimal', spellcheck: 'false', autocomplete: 'off',
    'aria-label': `${label} value`,
  });

  const show = () => {
    edited = false;
    el.value = scale.text(value);
    if (norm) el.title = formatValue(def, value);
  };
  /** Commit a value on the display scale. */
  const commit = (u: number) => {
    if (!Number.isNaN(u)) value = scale.fromUi(Math.min(scale.max, Math.max(scale.min, u)));
    show();
    onCommit(value);
  };

  el.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      const dir = e.key === 'ArrowUp' ? 1 : -1;
      // Nudge from the shown (rounded) value so steps land on the display grid.
      const shown = Math.round(scale.toUi(value) / scale.step) * scale.step;
      commit(shown + dir * scale.step * (e.shiftKey ? 10 : 1));
      el.select();
    } else if (e.key === 'Enter') {
      commit(parseValue(el.value));
      el.select();
    } else if (e.key === 'Escape') {
      show();
      el.blur();
    }
  });
  el.addEventListener('input', () => { edited = true; });
  el.addEventListener('focus', () => el.select());
  // Without edits, blur only repaints: the store may have changed while the field had focus.
  el.addEventListener('blur', () => (edited ? commit(parseValue(el.value)) : show()));

  return {
    el,
    update(v) {
      value = v;
      if (document.activeElement !== el) show();
    },
  };
}
