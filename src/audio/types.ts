/** Per-frame audio features handed to effects. All values 0..1 unless noted. */
export interface AudioFrame {
  /** Smoothed band energies after sensitivity. */
  bass: number;
  mid: number;
  high: number;
  /** Overall RMS level, smoothed. */
  level: number;
  /** True on the frame a beat onset is detected. */
  beat: boolean;
  /** 0..1 strength of the most recent beat, decays over ~250ms. Useful for bursts. */
  beatEnvelope: number;
  /** True while a source is producing sound. Effects should idle gracefully when false. */
  active: boolean;
}

export const SILENT_FRAME: Readonly<AudioFrame> = Object.freeze({
  bass: 0, mid: 0, high: 0, level: 0, beat: false, beatEnvelope: 0, active: false,
});

export type SourceKind = 'file' | 'mic' | 'url' | 'capture';

/** Payload type per source kind, so setSource is checked at the call site. */
export interface SourcePayloads {
  file: File;
  mic: { deviceId?: string } | undefined;
  /** Direct audio URL. The host must send CORS headers or analysis reads silence. */
  url: string;
  /** getDisplayMedia tab capture (Chrome desktop). */
  capture: undefined;
}

/** Tunables from the "Audio response" param section. */
export interface AudioResponse {
  bassSens: number;
  midSens: number;
  highSens: number;
  /** Attack time constant, seconds. */
  smoothRise: number;
  /** Release time constant, seconds. */
  smoothFall: number;
  beatThreshold: number;
}

export interface TransportState {
  source: SourceKind | null;
  /** Display name, e.g. file name. */
  label: string;
  playing: boolean;
  /** Seekable sources only (file, url). */
  seekable: boolean;
  currentTime: number;
  /** Seconds; NaN or Infinity for live sources. */
  duration: number;
}

export interface AudioEvents {
  level: (level: number, peak: number) => void;
  state: (state: Readonly<TransportState>) => void;
  error: (err: Error) => void;
}

export class NotImplementedError extends Error {
  constructor(what: string) {
    super(`${what} is not implemented yet`);
    this.name = 'NotImplementedError';
  }
}
