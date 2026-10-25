import { uiScale, type NumberParamDef, type NumberParamId } from '../../app/params';
import type { ParamStore } from '../../app/store';
import { h, nextId, type Component } from '../dom';
import { createNumberField } from './NumberField';

const SWEEP = 270;
/** Pixels of vertical drag for a full min..max sweep. Shift = 5x finer. */
const DRAG_PX = 180;

/**
 * Rotary knob on the param's panel scale (same mapping as the slider and value field).
 * A visually hidden native range input carries focus, keyboard and
 * accessibility; the disc is a pointer-driven view of the same value.
 * Drag vertically to change, double-click to reset.
 */
export function createKnob(def: NumberParamDef, store: ParamStore): Component {
  const id = def.id as NumberParamId;
  const inputId = nextId(`p-${def.id}`);
  const scale = uiScale(def);

  const range = h('input', {
    class: 'sr-only', type: 'range', id: inputId, min: scale.min, max: scale.max, step: scale.step,
  });
  const dial = h('span', { class: 'knob-dial' }, h('span', { class: 'knob-indicator' }));
  const knob = h('div', { class: 'knob', title: 'Drag to change, double-click to reset' }, dial, range);
  const field = createNumberField(def, def.label, (v) => store.set(id, v));

  const paint = (v: number) => {
    const u = scale.toUi(v);
    const t = (u - scale.min) / (scale.max - scale.min);
    dial.style.transform = `rotate(${-SWEEP / 2 + t * SWEEP}deg)`;
    range.value = String(u);
    field.update(v);
    range.setAttribute('aria-valuetext', scale.text(v));
  };

  range.addEventListener('input', () => store.set(id, scale.fromUi(Number(range.value))));

  let startY = 0;
  let startU = 0;
  knob.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    knob.setPointerCapture(e.pointerId);
    knob.classList.add('is-dragging');
    startY = e.clientY;
    startU = scale.toUi(store.get(id));
    range.focus({ preventScroll: true });
  });
  knob.addEventListener('pointermove', (e) => {
    if (!knob.hasPointerCapture(e.pointerId)) return;
    // Drag on the panel scale, so the knob turns evenly through the display curve.
    const span = scale.max - scale.min;
    const fine = e.shiftKey ? 0.2 : 1;
    const u = Math.min(scale.max, Math.max(scale.min, startU + ((startY - e.clientY) / DRAG_PX) * span * fine));
    store.set(id, scale.fromUi(u));
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
