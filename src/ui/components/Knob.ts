import { formatValue, quantize, type NumberParamDef, type NumberParamId } from '../../app/params';
import type { ParamStore } from '../../app/store';
import { h, nextId, type Component } from '../dom';
import { createNumberField } from './NumberField';

const SWEEP = 270;
/** Pixels of vertical drag for a full min..max sweep. Shift = 5x finer. */
const DRAG_PX = 180;

/**
 * Rotary knob. A visually hidden native range input carries focus, keyboard and
 * accessibility; the disc is a pointer-driven view of the same value.
 * Drag vertically to change, double-click to reset.
 */
export function createKnob(def: NumberParamDef, store: ParamStore): Component {
  const id = def.id as NumberParamId;
  const inputId = nextId(`p-${def.id}`);

  const range = h('input', {
    class: 'sr-only', type: 'range', id: inputId, min: def.min, max: def.max, step: def.step,
  });
  const dial = h('span', { class: 'knob-dial' }, h('span', { class: 'knob-indicator' }));
  const knob = h('div', { class: 'knob', title: 'Drag to change, double-click to reset' }, dial, range);
  const field = createNumberField(def, def.label, (v) => store.set(id, v));

  const paint = (v: number) => {
    const t = (v - def.min) / (def.max - def.min);
    dial.style.transform = `rotate(${-SWEEP / 2 + t * SWEEP}deg)`;
    range.value = String(v);
    field.update(v);
    range.setAttribute('aria-valuetext', formatValue(def, v));
  };

  range.addEventListener('input', () => store.set(id, Number(range.value)));

  let startY = 0;
  let startV = 0;
  knob.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    knob.setPointerCapture(e.pointerId);
    knob.classList.add('is-dragging');
    startY = e.clientY;
    startV = store.get(id);
    range.focus({ preventScroll: true });
  });
  knob.addEventListener('pointermove', (e) => {
    if (!knob.hasPointerCapture(e.pointerId)) return;
    const span = def.max - def.min;
    const fine = e.shiftKey ? 0.2 : 1;
    store.set(id, quantize(def, startV + ((startY - e.clientY) / DRAG_PX) * span * fine));
  });
  const end = (e: PointerEvent) => {
    if (knob.hasPointerCapture(e.pointerId)) knob.releasePointerCapture(e.pointerId);
    knob.classList.remove('is-dragging');
  };
  knob.addEventListener('pointerup', end);
  knob.addEventListener('pointercancel', end);
  knob.addEventListener('dblclick', () => store.set(id, store.defaultOf(id)));

  const el = h('div', { class: 'ctl ctl-knob' },
    knob,
    h('label', { class: 'ctl-label', for: inputId }, def.label),
    field.el,
  );
  const unwatch = store.watch(id, paint);
  return { el, dispose: unwatch };
}
