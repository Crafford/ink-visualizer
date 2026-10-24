import { FeatureExtractor } from './analysis';
import {
  NotImplementedError, SILENT_FRAME,
  type AudioEvents, type AudioFrame, type AudioResponse,
  type SourceKind, type SourcePayloads, type TransportState,
} from './types';

const DEFAULT_RESPONSE: AudioResponse = {
  bassSens: 1, midSens: 1, highSens: 1, smoothRise: 0.02, smoothFall: 0.25, beatThreshold: 0.6,
};

/**
 * Owns the AudioContext, the active source and analysis.
 * The graph is: source -> analyser -> destination (file/url) or source -> analyser (mic/capture).
 * The AudioContext is created lazily on the first setSource() call, which must come from a user gesture.
 */
export class AudioEngine {
  private ctx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private extractor: FeatureExtractor | null = null;
  private media: HTMLAudioElement | null = null;
  private mediaNode: MediaElementAudioSourceNode | null = null;
  private objectUrl: string | null = null;

  private response: AudioResponse = { ...DEFAULT_RESPONSE };
  private frame: AudioFrame = { ...SILENT_FRAME };
  private lastFrameTime = 0;
  private peak = 0;
  private peakHold = 0;

  private readonly handlers: { [K in keyof AudioEvents]: Set<AudioEvents[K]> } = {
    level: new Set(), state: new Set(), error: new Set(),
  };

  private _state: TransportState = {
    source: null, label: '', playing: false, seekable: false, currentTime: 0, duration: NaN,
  };

  get state(): Readonly<TransportState> {
    if (this.media) this._state.currentTime = this.media.currentTime;
    return this._state;
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
      this.fire('error', err instanceof Error ? err : new Error(String(err)));
      throw err;
    }
  }

  async play(): Promise<void> {
    if (!this.media) return;
    await this.ctx?.resume();
    await this.media.play();
  }

  pause(): void {
    this.media?.pause();
  }

  async toggle(): Promise<void> {
    if (this._state.playing) this.pause();
    else await this.play();
  }

  seek(seconds: number): void {
    if (!this.media || !this._state.seekable) return;
    const d = this.media.duration;
    this.media.currentTime = Math.max(0, Number.isFinite(d) ? Math.min(d, seconds) : seconds);
    this.updateState({ currentTime: this.media.currentTime });
  }

  /** Call once per animation frame. Returns a reused object; copy if you need to keep it. */
  getFrame(): AudioFrame {
    const now = performance.now() / 1000;
    const dt = this.lastFrameTime ? Math.min(0.1, now - this.lastFrameTime) : 1 / 60;
    this.lastFrameTime = now;

    if (!this.extractor) return this.frame;
    const active = this._state.playing;
    this.extractor.extract(dt, this.response, active, this.frame);

    // Peak tick for the meter: hold 0.8s, then fall.
    const lvl = this.frame.level;
    if (lvl >= this.peak) { this.peak = lvl; this.peakHold = 0.8; }
    else if ((this.peakHold -= dt) <= 0) this.peak = Math.max(lvl, this.peak - dt * 0.6);
    this.fire('level', lvl, this.peak);
    return this.frame;
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
    const el = new Audio();
    el.preload = 'auto';
    this.objectUrl = URL.createObjectURL(file);
    el.src = this.objectUrl;
    this.attachMedia(el, ctx);
    this.updateState({
      source: 'file', label: file.name, playing: false, seekable: true, currentTime: 0, duration: NaN,
    });
    await ctx.resume();
  }

  private async setMic(_opts: SourcePayloads['mic']): Promise<void> {
    // TODO(M2): getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } })
    // -> createMediaStreamSource -> analyser (not to destination, avoids feedback).
    throw new NotImplementedError('Microphone input');
  }

  private async setUrl(_url: string): Promise<void> {
    // TODO(M2): same path as file with el.crossOrigin = 'anonymous'. Without CORS headers the
    // MediaElementSource outputs silence; detect via all-zero analyser data and surface a message.
    throw new NotImplementedError('Audio link input');
  }

  private async setCapture(): Promise<void> {
    // TODO(M2): getDisplayMedia({ video: true, audio: true }) (Chrome desktop, user must tick "share tab audio"),
    // stop video tracks, createMediaStreamSource on the audio track, analyser only.
    throw new NotImplementedError('Tab capture');
  }

  // ---------------------------------------------------------------- internals

  private ensureContext(): AudioContext {
    if (this.ctx) return this.ctx;
    const ctx = new AudioContext({ latencyHint: 'interactive' });
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0; // we smooth ourselves with rise/fall
    analyser.minDecibels = -90;
    analyser.maxDecibels = -15;
    this.ctx = ctx;
    this.analyser = analyser;
    this.extractor = new FeatureExtractor(analyser);
    return ctx;
  }

  private attachMedia(el: HTMLAudioElement, ctx: AudioContext): void {
    this.media = el;
    this.mediaNode = ctx.createMediaElementSource(el);
    this.mediaNode.connect(this.analyser!);
    this.analyser!.connect(ctx.destination);
    el.addEventListener('play', () => this.updateState({ playing: true }));
    el.addEventListener('pause', () => this.updateState({ playing: false }));
    el.addEventListener('ended', () => this.updateState({ playing: false }));
    el.addEventListener('timeupdate', () => this.updateState({ currentTime: el.currentTime }));
    el.addEventListener('loadedmetadata', () => this.updateState({ duration: el.duration }));
    el.addEventListener('error', () => this.fire('error', new Error('Could not decode this file')));
  }

  private teardownSource(): void {
    if (this.media) {
      this.media.pause();
      this.media.removeAttribute('src');
      this.media.load();
    }
    this.mediaNode?.disconnect();
    this.analyser?.disconnect();
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
    this.media = null;
    this.mediaNode = null;
    this.objectUrl = null;
    this.extractor?.reset();
    this.updateState({ source: null, label: '', playing: false, seekable: false, currentTime: 0, duration: NaN });
  }

  private updateState(patch: Partial<TransportState>): void {
    Object.assign(this._state, patch);
    this.fire('state', this._state);
  }

  private fire<K extends keyof AudioEvents>(type: K, ...args: Parameters<AudioEvents[K]>): void {
    for (const fn of this.handlers[type]) (fn as (...a: unknown[]) => void)(...args);
  }
}
