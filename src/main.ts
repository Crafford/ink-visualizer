import './ui/tokens.css';
import './ui/app.css';
import { ParamStore } from './app/store';
import { Stage } from './app/stage';
import { AudioEngine } from './audio/AudioEngine';
import { EFFECTS, DEFAULT_EFFECT } from './effects/registry';
import { createPanel } from './ui/Panel';
import { createTransport } from './ui/Transport';
import { h } from './ui/dom';

const mobile = matchMedia('(pointer: coarse)').matches;

const store = new ParamStore({ mobile });
const engine = new AudioEngine();

// Audio response params flow into the engine; everything else is read by the effect per frame.
const AUDIO_KEYS = ['bassSens', 'midSens', 'highSens', 'smoothRise', 'smoothFall', 'beatThreshold'] as const;
for (const k of AUDIO_KEYS) store.watch(k, (v) => engine.configure({ [k]: v }));

const root = document.getElementById('app')!;
const stageEl = h('main', { class: 'stage', 'aria-label': 'Visualization' });

let stage: Stage | null = null;

const toggleFullscreen = () => {
  if (document.fullscreenElement) void document.exitFullscreen();
  else void stageEl.requestFullscreen?.();
};

const screenshot = async () => {
  if (!stage) return;
  const blob = await stage.screenshot();
  const a = h('a', { href: URL.createObjectURL(blob), download: `ink-${new Date().toISOString().replace(/[:.]/g, '-')}.png` });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};

const panel = createPanel(store, engine, { fullscreen: toggleFullscreen, screenshot: () => void screenshot() });
const transport = createTransport(engine, toggleFullscreen);
stageEl.append(transport.el);
root.append(h('div', { class: 'shell' }, panel.el, stageEl));

try {
  stage = new Stage(stageEl, store, engine, EFFECTS[DEFAULT_EFFECT]);
} catch (err) {
  console.error(err);
  stageEl.prepend(h('p', { class: 'stage-error' }, 'WebGL2 is not available in this browser.'));
}

// Space toggles playback when focus is not in a control.
window.addEventListener('keydown', (e) => {
  if (e.code !== 'Space') return;
  const t = e.target as HTMLElement;
  if (t.closest('input, button, textarea, select, [role="tab"]')) return;
  e.preventDefault();
  void engine.toggle();
});

// Dev builds, or any build with ?debug, expose internals for the console and automated tests.
if (import.meta.env.DEV || new URLSearchParams(location.search).has('debug')) Object.assign(window, { store, engine, stage });
