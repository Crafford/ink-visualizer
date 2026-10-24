import { AudioEngine, MSG } from '../audio/AudioEngine';
import { h, Disposer, type Component } from './dom';
import { createTabs } from './components/Tabs';
import { createButton } from './components/Button';
import { createBeatIndicator, createLevelMeter } from './components/LevelMeter';

type InputTab = 'upload' | 'mic' | 'link' | 'capture';

const TABS = [
  { id: 'upload', label: 'Upload' },
  { id: 'mic', label: 'Mic' },
  { id: 'link', label: 'Link' },
  { id: 'capture', label: 'Capture' },
] as const;

const ACCEPT = '.mp3,.mp4,.m4a,audio/mpeg,audio/mp4,video/mp4';

/** Input section body: source tabs, per-source controls, status line and level meter. */
export function createInputSection(engine: AudioEngine): Component {
  const d = new Disposer();
  const status = h('p', { class: 'status', role: 'status', 'aria-live': 'polite' });
  const say = (msg: string, isError = false) => {
    status.textContent = msg;
    status.classList.toggle('is-error', isError);
  };

  const run = async (fn: () => Promise<void>) => {
    try {
      say('');
      await fn();
    } catch (err) {
      say(err instanceof Error ? err.message : String(err), true);
    }
  };

  // Upload
  const fileInput = h('input', { type: 'file', accept: ACCEPT, class: 'sr-only', tabindex: -1, 'aria-hidden': 'true' });
  const fileName = h('span', { class: 'file-name' }, 'No file loaded');
  const loadFile = (file: File) => run(async () => {
    await engine.setSource('file', file);
    await engine.play();
  });
  fileInput.addEventListener('change', () => {
    const f = fileInput.files?.[0];
    if (f) void loadFile(f);
    fileInput.value = '';
  });
  const upload = h('div', { class: 'input-pane' },
    h('div', { class: 'input-row' },
      createButton({ label: 'Choose file', primary: true, onClick: () => fileInput.click() }),
      fileName,
    ),
    h('p', { class: 'hint' }, 'MP3 or MP4. You can also drop a file anywhere.'),
    fileInput,
  );
  d.add(engine.on('state', (s) => {
    fileName.textContent = s.source === 'file' ? s.label : 'No file loaded';
    fileName.title = fileName.textContent;
  }));

  // Drag and drop onto the whole window
  const onDragOver = (e: DragEvent) => { e.preventDefault(); };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    const f = e.dataTransfer?.files?.[0];
    if (f) { tabs.select('upload'); void loadFile(f); }
  };
  window.addEventListener('dragover', onDragOver);
  window.addEventListener('drop', onDrop);
  d.add(() => { window.removeEventListener('dragover', onDragOver); window.removeEventListener('drop', onDrop); });

  // Live sources (mic, capture): one Start/Stop button plus a status line driven by engine state.
  const livePane = (kind: 'mic' | 'capture', o: {
    start: string; stop: string; idle: string; on: (label: string) => string; disabled?: string;
  }) => {
    const status = h('p', { class: 'hint', 'aria-live': 'polite' }, o.disabled ?? o.idle);
    const btn = createButton({
      label: o.start, primary: true,
      onClick: () => run(async () => {
        if (engine.state.source === kind) engine.stop();
        else await engine.setSource(kind, undefined);
      }),
    });
    btn.disabled = !!o.disabled;
    d.add(engine.on('state', (s) => {
      const active = s.source === kind;
      btn.textContent = active ? o.stop : o.start;
      status.textContent = o.disabled ?? (active ? o.on(s.label) : o.idle);
      status.classList.toggle('is-on', active);
    }));
    return h('div', { class: 'input-pane' }, h('div', { class: 'input-row' }, btn), status);
  };

  const mic = livePane('mic', {
    start: 'Start microphone', stop: 'Stop microphone',
    idle: 'Uses the default input device. Nothing is recorded.',
    on: (label) => `Listening: ${label}`,
  });

  // Link
  const urlField = h('input', {
    class: 'text-field', type: 'url', placeholder: 'https://example.com/track.mp3', 'aria-label': 'Audio URL', spellcheck: 'false',
  });
  const loadUrl = () => run(async () => {
    await engine.setSource('url', urlField.value.trim());
    await engine.play();
  });
  urlField.addEventListener('keydown', (e) => { if (e.key === 'Enter') void loadUrl(); });
  const link = h('div', { class: 'input-pane' },
    h('div', { class: 'input-row' }, urlField, createButton({ label: 'Load', primary: true, onClick: () => void loadUrl() })),
    h('p', { class: 'hint' }, 'Direct .mp3/.m4a links only. Spotify, YouTube and other streaming links need the Capture tab.'),
  );

  // Capture
  const capture = livePane('capture', {
    start: 'Start capture', stop: 'Stop capture',
    idle: 'Pick a tab and tick \u201cShare tab audio\u201d in the Chrome dialog. Keep that tab playing.',
    on: (label) => `Capturing: ${label}`,
    disabled: AudioEngine.captureSupported ? undefined : MSG.captureUnsupported,
  });

  const panes: Record<InputTab, HTMLElement> = { upload, mic, link, capture };
  const tabs = createTabs<InputTab>(TABS, 'upload', (id) => {
    for (const [k, el] of Object.entries(panes)) el.hidden = k !== id;
    say('');
  }, 'Audio input');
  for (const [k, el] of Object.entries(panes) as [InputTab, HTMLElement][]) {
    el.id = tabs.panelIdFor(k);
    el.setAttribute('role', 'tabpanel');
  }

  const meter = createLevelMeter(engine);
  d.add(meter.dispose);
  const beat = createBeatIndicator(engine);
  d.add(beat.dispose);
  d.add(engine.on('error', (e) => say(e.message, true)));

  const el = h('div', { class: 'input-section' },
    tabs.el,
    upload, mic, link, capture,
    status,
    h('div', { class: 'ctl ctl-meter' }, h('span', { class: 'ctl-label' }, 'Level'), meter.el, beat.el),
  );
  return { el, dispose: () => d.dispose() };
}
