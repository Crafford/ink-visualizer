import type { ToggleParamDef } from '../../app/params';
import type { ParamStore } from '../../app/store';
import { h, nextId, type Component } from '../dom';

export interface SegmentOption<T extends string> { value: T; label: string }

/**
 * Small segmented control (radio group of flat buttons): arrow keys move and select,
 * roving tabindex. Used for toggle params and the effect selector.
 */
export function createSegments<T extends string>(
  options: readonly SegmentOption<T>[], initial: T, onChange: (v: T) => void, ariaLabel: string, cls = '',
): Component & { set(v: T): void } {
  const el = h('div', { class: `segments ${cls}`.trim(), role: 'radiogroup', 'aria-label': ariaLabel });
  const buttons = new Map<T, HTMLButtonElement>();
  let value = initial;

  const paint = () => {
    for (const [v, b] of buttons) {
      const on = v === value;
      b.setAttribute('aria-checked', String(on));
      b.tabIndex = on ? 0 : -1;
    }
  };
  const pick = (v: T, focus = false) => {
    if (focus) buttons.get(v)?.focus();
    if (v === value) return;
    value = v;
    paint();
    onChange(v);
  };

  options.forEach((o, i) => {
    const b = h('button', {
      class: 'segment', type: 'button', role: 'radio',
      onclick: () => pick(o.value),
      onkeydown: ((e: KeyboardEvent) => {
        const d = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
        if (!d) return;
        e.preventDefault();
        pick(options[(i + d + options.length) % options.length].value, true);
      }) as EventListener,
    }, o.label);
    buttons.set(o.value, b);
    el.append(b);
  });
  paint();

  return { el, set: (v) => { value = v; paint(); }, dispose: () => {} };
}

/** Label + segmented control for a toggle param. */
export function createToggleField(def: ToggleParamDef, store: ParamStore): Component {
  const labelId = nextId(`p-${def.id}`);
  const seg = createSegments(def.options, store.get(def.id) as string, (v) => store.set(def.id, v), def.label);
  seg.el.setAttribute('aria-labelledby', labelId);
  const el = h('div', { class: 'ctl ctl-toggle' },
    h('span', { class: 'ctl-label', id: labelId }, def.label),
    seg.el,
  );
  const unwatch = store.watch<string>(def.id, (v) => seg.set(v));
  return { el, dispose: unwatch };
}
