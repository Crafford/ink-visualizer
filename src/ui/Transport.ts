import type { AudioEngine } from '../audio/AudioEngine';
import { h, svg, Disposer, type Component } from './dom';
import { ICONS } from './icons';

export const formatTime = (s: number) => {
  if (!Number.isFinite(s) || s < 0) return '00:00';
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
};

/** Floating pill over the canvas: play/pause, time, seek bar, fullscreen. */
export function createTransport(engine: AudioEngine, onFullscreen: () => void): Component {
  const d = new Disposer();
  const playBtn = h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Play' });
  const time = h('span', { class: 'mono t-time' }, '00:00');
  const dur = h('span', { class: 'mono t-time t-dur' }, '00:00');
  const seek = h('input', { class: 'seek', type: 'range', min: 0, max: 1, step: 0.001, value: 0, 'aria-label': 'Seek' });
  const fsBtn = h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Fullscreen', onclick: onFullscreen });
  fsBtn.append(svg(ICONS.fullscreen));

  let scrubbing = false;
  playBtn.addEventListener('click', () => void engine.toggle());
  seek.addEventListener('input', () => {
    scrubbing = true;
    const s = engine.state;
    time.textContent = formatTime(Number(seek.value) * s.duration);
  });
  seek.addEventListener('change', () => {
    scrubbing = false;
    engine.seek(Number(seek.value) * engine.state.duration);
  });

  let lastPlaying: boolean | null = null;
  d.add(engine.on('state', (s) => {
    if (s.playing !== lastPlaying) {
      lastPlaying = s.playing;
      playBtn.replaceChildren(svg(s.playing ? ICONS.pause : ICONS.play));
      playBtn.setAttribute('aria-label', s.playing ? 'Pause' : 'Play');
    }
    playBtn.disabled = s.source === null;
    seek.disabled = !s.seekable || !Number.isFinite(s.duration);
    dur.textContent = formatTime(s.duration);
    if (!scrubbing) {
      time.textContent = formatTime(s.currentTime);
      const p = Number.isFinite(s.duration) && s.duration > 0 ? s.currentTime / s.duration : 0;
      seek.value = String(p);
      seek.style.setProperty('--fill', `${p * 100}%`);
    }
  }));

  // Prime with the current state.
  playBtn.replaceChildren(svg(ICONS.play));
  playBtn.disabled = true;
  seek.disabled = true;
  seek.style.setProperty('--fill', '0%');

  const el = h('div', { class: 'transport', role: 'group', 'aria-label': 'Transport' },
    playBtn, time, seek, dur, h('span', { class: 't-sep', 'aria-hidden': 'true' }), fsBtn,
  );
  return { el, dispose: () => d.dispose() };
}
