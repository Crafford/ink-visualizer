import type { AudioEngine } from '../../audio/AudioEngine';
import { h, type Component } from '../dom';

/** 2px accent bar with a peak tick. Driven by the engine's 'level' event (once per frame). */
export function createLevelMeter(engine: AudioEngine): Component {
  const fill = h('span', { class: 'meter-fill' });
  const peak = h('span', { class: 'meter-peak' });
  const el = h('div', { class: 'meter', role: 'meter', 'aria-label': 'Input level', 'aria-valuemin': 0, 'aria-valuemax': 1 },
    fill, peak);
  let lastAria = 0;
  const off = engine.on('level', (level, pk) => {
    fill.style.transform = `scaleX(${level})`;
    peak.style.left = `${pk * 100}%`;
    peak.style.opacity = pk > 0.005 ? '1' : '0';
    const now = performance.now();
    if (now - lastAria > 500) { el.setAttribute('aria-valuenow', level.toFixed(2)); lastAria = now; }
  });
  return { el, dispose: off };
}
