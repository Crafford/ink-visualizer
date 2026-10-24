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

/**
 * Beat blip: an accent dot that flashes on each detected onset and fades over ~200 ms,
 * plus the tempo estimate in mono. For tuning Beat thresh. by eye.
 */
export function createBeatIndicator(engine: AudioEngine): Component {
  const flash = h('span', { class: 'beat-flash' });
  const dot = h('span', { class: 'beat-dot', 'aria-hidden': 'true' }, flash);
  const bpm = h('span', { class: 'beat-bpm mono' }, '--- bpm');
  const el = h('span', { class: 'beat', title: 'Beat detector' }, dot, bpm);
  let anim: Animation | null = null;
  const offBeat = engine.on('beat', (strength, tempo) => {
    anim?.cancel();
    const peak = 0.45 + 0.55 * strength;
    anim = flash.animate(
      [{ opacity: peak, transform: 'scale(1.35)' }, { opacity: 0, transform: 'scale(1)' }],
      { duration: 200, easing: 'ease-out' },
    );
    bpm.textContent = tempo > 0 ? `${String(tempo).padStart(3, '\u2007')} bpm` : '--- bpm';
  });
  const offState = engine.on('state', (st) => {
    if (!st.source) bpm.textContent = '--- bpm';
  });
  return { el, dispose: () => { offBeat(); offState(); anim?.cancel(); } };
}
