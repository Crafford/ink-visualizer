import { FeatureExtractor } from './analysis';
import {
  AudioSourceError, silentFrame,
  type AudioEvents, type AudioFrame, type AudioResponse,
  type SourceKind, type SourcePayloads, type TransportState,
} from './types';

const DEFAULT_RESPONSE: AudioResponse = {
  bassSens: 1, midSens: 1, highSens: 1, smoothRise: 0.02, smoothFall: 0.25, beatThreshold: 0,
};

/** How long a link must play in pure digital silence before we call it a CORS block. */
const CORS_SILENCE_S = 2;

const STREAMING_HOSTS = /(^|\.)(spotify\.com|youtube\.com|youtu\.be|soundcloud\.com|music\.apple\.com|deezer\.com|tidal\.com|bandcamp\.com|mixcloud\.com)$/i;

export const MSG = {
  corsSilence: 'This host blocks cross-origin audio. Try the Capture tab.',
  linkFailed: 'Could not load this link. It must be a direct .mp3/.m4a file on a host that allows cross-origin requests. Try the Capture tab.',
  streaming: 'Streaming links (Spotify, YouTube and similar) need the Capture tab.',
  badUrl: 'Enter a full http(s) link to an audio file.',
  noCaptureAudio: "No audio captured. Pick a tab and tick 'Share tab audio' in the Chrome dialog.",
  captureUnsupported: 'Tab capture needs Chrome or Edge on desktop',
  captureCancelled: 'Capture cancelled.',
  micDenied: 'Microphone access was blocked. Allow it in the address bar and try again.',
  micMissing: 'No microphone found.',
  micUnsupported: 'This browser cannot access the microphone here (it needs https).',
  decode: 'Could not decode this file',
} as const;

type Teardown = () => void;

/**
 * Owns the AudioContext, the active source and analysis.
 * Graph: media source -> analyser and media source -> destination (file/url, audible);
 *        stream source -> analyser only (mic/capture, never audible: avoids feedback and double audio).
 * The AudioContext is created lazily on the first setSource() call, which must come from a user gesture,
 * and resumed on every play/start.
 */
export class AudioEngine {
  private ctx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private extractor: FeatureExtractor | null = null;
  private media: HTMLMediaElement | null = null;
  private liveStart = 0;
  private teardown: Teardown[] = [];
  /** Bumped on every source change; async work from an older source checks it and bails. */
  private generation = 0;

  private response: AudioResponse = { ...DEFAULT_RESPONSE };
  private frame: AudioFrame = silentFrame();
  private lastFrameTime = 0;

  private readonly handlers: { [K in keyof AudioEvents]: Set<AudioEvents[K]> } = {
    level: new Set(), beat: new Set(), state: new Set(), error: new Set(),
  };

  private _state: TransportState = {
    source: null, label: '', playing: false, live: false, seekable: false, currentTime: 0, duration: NaN,
  };

  get state(): Readonly<TransportState> {
    if (this.media) this._state.currentTime = this.media.currentTime;
    return this._state;
  }

  /** Rolling tempo estimate from detected beats, 0 when unknown. */
  get bpm(): number { return this.extractor?.bpm ?? 0; }

  /** Tab capture needs getDisplayMedia with audio, which only Chromium desktop provides. */
  static get captureSupported(): boolean {
    const md = typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined;
    if (!md || typeof md.getDisplayMedia !== 'function') return false;
    if (!('userAgentData' in navigator)) return false; // Chromium only
    return !matchMedia('(pointer: coarse)').matches;
  }

  on<K extends keyof AudioEvents>(type: K, fn: AudioEvents[K]): () => void {
    this.handlers[type].add(fn);
    return () => this.handlers[type].delete(fn);
  }

  configure(patch: Partial<AudioResponse>): void {
    Object.assign(this.response, patch);
  }

  async setSource<K extends SourceKind>(kind: K, payload: SourcePayloads[K]): Promise<void> {
    try {
      switch (kind) {
        case 'file': return await this.setFile(payload as File);
        case 'mic': return await this.setMic(payload as SourcePayloads['mic']);
        case 'url': return await this.setUrl(payload as string);
        case 'capture': return await this.setCapture();
      }
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      this.fire('error', e);
      throw e;
    }
  }

  /** Stop and release the current source; back to idle. */
  stop(): void {
    this.teardownSource();
  }

  /** Play file/link sources. No-op for live sources or when nothing is loaded. */
  async play(): Promise<void> {
    const el = this.media;
    if (!el) return;
    try {
      await this.ctx?.resume();
      await el.play();
    } catch (err) {
      // Autoplay refusal or a source switch mid-play (AbortError): not worth an error message.
      // Load failures (NotSupportedError) are reported by the element's 'error' event with a better message.
      if (err instanceof DOMException && ['AbortError', 'NotAllowedError', 'NotSupportedError'].includes(err.name)) return;
      throw err;
    }
  }

  pause(): void {
    this.media?.pause();
  }

  async toggle(): Promise<void> {
    if (!this.media) return;
    if (this._state.playing) this.pause();
    else await this.play();
  }

  seek(seconds: number): void {
    if (!this.media || !this._state.seekable || !Number.isFinite(seconds)) return;
    const d = this.media.duration;
    this.media.currentTime = Math.max(0, Number.isFinite(d) ? Math.min(d, seconds) : seconds);
    this.updateState({ currentTime: this.media.currentTime });
  }

  /** Call once per animation frame. Returns a reused object; copy if you need to keep it. */
  getFrame(): AudioFrame {
    const now = performance.now() / 1000;
    const dt = this.lastFrameTime ? Math.min(0.1, Math.max(0, now - this.lastFrameTime)) : 1 / 60;
    this.lastFrameTime = now;

    const f = this.frame;
    const playing = this._state.playing;
    f.playing = playing;
    if (this.media) {
      f.time = this.media.currentTime;
      f.duration = Number.isFinite(this.media.duration) ? this.media.duration : 0;
    } else {
      f.time = this._state.live && this.ctx ? this.ctx.currentTime - this.liveStart : 0;
      f.duration = 0;
    }
    if (!this.extractor) return f;
    this.extractor.extract(dt, this.response, playing, f);
    this.fire('level', f.level, f.peak);
    if (f.beat) this.fire('beat', f.beatStrength, this.bpm);
    return f;
  }

  dispose(): void {
    this.teardownSource();
    void this.ctx?.close();
    this.ctx = null;
  }

  // ---------------------------------------------------------------- sources

  private async setFile(file: File): Promise<void> {
    const ctx = this.ensureContext();
    this.teardownSource();
    // A <video> element decodes both audio and video containers; for MP4 video we only use its audio track.
    const el = document.createElement(file.type.startsWith('video/') ? 'video' : 'audio');
    el.preload = 'auto';
    const url = URL.createObjectURL(file);
    this.teardown.push(() => URL.revokeObjectURL(url));
    el.src = url;
    this.attachMedia(el, ctx, () => MSG.decode);
    this.updateState({
      source: 'file', label: file.name, playing: false, live: false, seekable: true, currentTime: 0, duration: NaN,
    });
    await ctx.resume();
  }

  private async setUrl(raw: string): Promise<void> {
    let url: URL;
    try { url = new URL(raw.trim(), location.href); } catch { throw new AudioSourceError(MSG.badUrl); }
    if (!/^https?:$/.test(url.protocol) || !raw.trim()) throw new AudioSourceError(MSG.badUrl);
    if (STREAMING_HOSTS.test(url.hostname)) throw new AudioSourceError(MSG.streaming);

    const ctx = this.ensureContext();
    this.teardownSource();
    const el = document.createElement('audio');
    el.crossOrigin = 'anonymous';
    el.preload = 'auto';
    el.src = url.href;
    this.attachMedia(el, ctx, () => MSG.linkFailed);
    this.watchCorsSilence(el);
    const name = decodeURIComponent(url.pathname.split('/').pop() || '') || url.hostname;
    this.updateState({
      source: 'url', label: name, playing: false, live: false, seekable: true, currentTime: 0, duration: NaN,
    });
    await ctx.resume();
  }

  private async setMic(opts: SourcePayloads['mic']): Promise<void> {
    const md = navigator.mediaDevices;
    if (!md?.getUserMedia) throw new AudioSourceError(MSG.micUnsupported);
    const ctx = this.ensureContext();
    this.teardownSource();
    const gen = this.generation;
    let stream: MediaStream;
    try {
      stream = await md.getUserMedia({
        audio: {
          echoCancellation: false, noiseSuppression: false, autoGainControl: false,
          ...(opts?.deviceId ? { deviceId: { exact: opts.deviceId } } : {}),
        },
      });
    } catch (err) {
      const name = err instanceof DOMException ? err.name : '';
      if (name === 'NotAllowedError' || name === 'SecurityError') throw new AudioSourceError(MSG.micDenied);
      if (name === 'NotFoundError' || name === 'OverconstrainedError') throw new AudioSourceError(MSG.micMissing);
      throw err;
    }
    if (gen !== this.generation) { stopStream(stream); return; } // superseded while the prompt was open
    const track = stream.getAudioTracks()[0];
    this.attachStream(stream, ctx, 'mic', track?.label || 'Default microphone');
    await ctx.resume();
  }

  private async setCapture(): Promise<void> {
    if (!AudioEngine.captureSupported) throw new AudioSourceError(MSG.captureUnsupported);
    const ctx = this.ensureContext();
    this.teardownSource();
    const gen = this.generation;
    let stream: MediaStream;
    try {
      // Chrome only gives audio when video is requested too. The extra keys are Chrome hints.
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: true, audio: true, selfBrowserSurface: 'exclude', systemAudio: 'include',
      } as DisplayMediaStreamOptions);
    } catch (err) {
      const name = err instanceof DOMException ? err.name : '';
      if (name === 'NotAllowedError' || name === 'AbortError') throw new AudioSourceError(MSG.captureCancelled);
      if (name === 'NotSupportedError' || name === 'TypeError') throw new AudioSourceError(MSG.captureUnsupported);
      throw err;
    }
    for (const t of stream.getVideoTracks()) t.stop();
    if (gen !== this.generation) { stopStream(stream); return; }
    const track = stream.getAudioTracks()[0];
    if (!track) {
      stopStream(stream);
      throw new AudioSourceError(MSG.noCaptureAudio);
    }
    this.attachStream(stream, ctx, 'capture', track.label || 'Tab audio');
    await ctx.resume();
  }

  // ---------------------------------------------------------------- internals

  private ensureContext(): AudioContext {
    if (this.ctx) return this.ctx;
    const ctx = new AudioContext({ latencyHint: 'interactive' });
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0; // we smooth ourselves with rise/fall
    this.ctx = ctx;
    this.analyser = analyser;
    this.extractor = new FeatureExtractor(analyser);
    return ctx;
  }

  private attachMedia(el: HTMLMediaElement, ctx: AudioContext, errorMsg: () => string): void {
    el.hidden = true;
    (el as HTMLVideoElement).playsInline = true;
    this.media = el;
    const node = ctx.createMediaElementSource(el);
    node.connect(this.analyser!);
    node.connect(ctx.destination);
    const on = (type: string, fn: () => void) => {
      el.addEventListener(type, fn);
      this.teardown.push(() => el.removeEventListener(type, fn));
    };
    on('play', () => this.updateState({ playing: true }));
    on('pause', () => this.updateState({ playing: false }));
    on('ended', () => this.updateState({ playing: false }));
    on('timeupdate', () => this.updateState({ currentTime: el.currentTime }));
    on('loadedmetadata', () => this.updateState({ duration: el.duration }));
    on('error', () => {
      this.updateState({ playing: false });
      this.fire('error', new AudioSourceError(errorMsg()));
    });
    this.teardown.push(() => {
      el.pause();
      el.removeAttribute('src');
      el.load();
      node.disconnect();
    });
  }

  private attachStream(stream: MediaStream, ctx: AudioContext, kind: 'mic' | 'capture', label: string): void {
    const node = ctx.createMediaStreamSource(stream);
    node.connect(this.analyser!); // analyser only: never to destination
    const track = stream.getAudioTracks()[0];
    // Mic unplugged, permission revoked, or "Stop sharing" clicked: back to idle.
    const onEnded = () => { if (this._state.source === kind) this.teardownSource(); };
    track?.addEventListener('ended', onEnded);
    this.teardown.push(() => {
      track?.removeEventListener('ended', onEnded);
      node.disconnect();
      stopStream(stream);
    });
    this.liveStart = ctx.currentTime;
    this.updateState({
      source: kind, label, playing: true, live: true, seekable: false, currentTime: 0, duration: Infinity,
    });
  }

  /**
   * A media element without CORS access feeds zeros into the graph. Chrome usually fails the load
   * outright when crossOrigin is set, but a cross-origin redirect can still taint it silently.
   * Count playing time in pure digital silence; give up after CORS_SILENCE_S.
   */
  private watchCorsSilence(el: HTMLMediaElement): void {
    let silentFor = 0;
    let last = 0;
    const id = window.setInterval(() => {
      const now = performance.now() / 1000;
      const dt = last ? now - last : 0;
      last = now;
      if (el.paused || el.readyState < 3 || !this.extractor) return;
      if (!this.extractor.isDigitalSilence()) { window.clearInterval(id); return; }
      silentFor += dt;
      if (silentFor >= CORS_SILENCE_S) {
        window.clearInterval(id);
        this.fire('error', new AudioSourceError(MSG.corsSilence));
      }
    }, 100);
    this.teardown.push(() => window.clearInterval(id));
  }

  private teardownSource(): void {
    this.generation++;
    for (const fn of this.teardown.splice(0).reverse()) {
      try { fn(); } catch { /* best effort */ }
    }
    this.media = null;
    this.extractor?.reset();
    this.updateState({
      source: null, label: '', playing: false, live: false, seekable: false, currentTime: 0, duration: NaN,
    });
  }

  private updateState(patch: Partial<TransportState>): void {
    Object.assign(this._state, patch);
    this.fire('state', this._state);
  }

  private fire<K extends keyof AudioEvents>(type: K, ...args: Parameters<AudioEvents[K]>): void {
    for (const fn of this.handlers[type]) (fn as (...a: unknown[]) => void)(...args);
  }
}

function stopStream(s: MediaStream): void {
  for (const t of s.getTracks()) t.stop();
}
