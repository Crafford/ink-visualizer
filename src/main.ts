import './ui/tokens.css';
import './ui/app.css';
import { ParamStore } from './app/store';
import { Stage } from './app/stage';
import { AudioEngine } from './audio/AudioEngine';
import { EFFECTS, DEFAULT_EFFECT, getEffect } from './effects/registry';
import { createPanel } from './ui/Panel';
import { createTransport } from './ui/Transport';
import { PresetBank } from './presets/store';
import { h } from './ui/dom';

const mobile = matchMedia('(pointer: coarse)').matches;

const store = new ParamStore(getEffect(DEFAULT_EFFECT)!, { mobile });
const engine = new AudioEngine();
const presets = new PresetBank(EFFECTS, { mobile });

// Audio response params flow into the engine; everything else is read by the effect per frame.
const AUDIO_KEYS = ['bassSens', 'midSens', 'highSens', 'smoothRise', 'smoothFall'] as const;
for (const k of AUDIO_KEYS) store.watch(k, (v) => engine.configure({ [k]: v }));

const root = document.getElementById('app')!;
const stageEl = h('main', { class: 'stage', 'aria-label': 'Visualization' });

let stage: Stage | null = null;

const toggleFullscreen = () => {
  if (document.fullscreenElement) void document.exitFullscreen();
  else void stageEl.requestFullscreen?.();
};

/** Local time as YYYYMMDD-HHMMSS. */
const stamp = (d: Date) => {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};

const screenshot = async () => {
  if (!stage) return;
  const blob = await stage.screenshot();
  const a = h('a', { href: URL.createObjectURL(blob), download: `${store.effectId}-${stamp(new Date())}.png` });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};

/** Swap the effect: the store swaps the effect params (keeping the old ones), the stage
 *  disposes the old effect and creates the new one (fresh, empty trails), the panel re-renders. */
const setEffect = (id: string) => {
  const entry = getEffect(id);
  if (!entry || entry.id === store.effectId) return;
  store.setEffect(entry);
  stage?.setEffect(entry.create);
};

const panel = createPanel(store, engine, presets, EFFECTS, {
  fullscreen: toggleFullscreen, screenshot: () => void screenshot(), setEffect,
});
const transport = createTransport(engine, toggleFullscreen);
stageEl.append(transport.el);
root.append(h('div', { class: 'shell' }, panel.el, stageEl));

try {
  stage = new Stage(stageEl, store, engine, getEffect(store.effectId)!.create);
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
if (import.meta.env.DEV || new URLSearchParams(location.search).has('debug')) Object.assign(window, { store, engine, stage, presets, setEffect });
