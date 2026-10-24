/** Unsmoothed band values, 0..1 after adaptive normalisation and sensitivity. */
export interface BandValues {
  bass: number;
  mid: number;
  high: number;
}

/**
 * Per-frame audio features handed to effects. All values 0..1 unless noted.
 * Bands: bass 20-150 Hz, mid 150-2000 Hz, high 2000-12000 Hz. Each band is normalised
 * against its own slowly decaying running max, so quiet and loud material both use the range.
 */
export interface AudioFrame {
  /** Smoothed band energies (asymmetric rise/fall), after sensitivity. */
  bass: number;
  mid: number;
  high: number;
  /** Normalised RMS level, smoothed. */
  level: number;
  /** Peak-hold of `level`: holds ~0.8s, then falls. Meant for meters. */
  peak: number;
  /** True for exactly one frame when an onset is detected. */
  beat: boolean;
  /** Strength of the most recent beat (set on the beat frame), decaying with a ~250ms time constant. */
  beatStrength: number;
  /** Band values before rise/fall smoothing. Same scale as bass/mid/high. */
  raw: BandValues;
  /** True while a source is producing sound (file/link playing, or mic/capture live). */
  playing: boolean;
  /** Seconds. Media position for file/link, seconds since start for mic/capture, 0 when idle. */
  time: number;
  /** Seconds. Media duration for file/link once known, otherwise 0 (live or unknown). */
  duration: number;
}

export function silentFrame(): AudioFrame {
  return {
    bass: 0, mid: 0, high: 0, level: 0, peak: 0, beat: false, beatStrength: 0,
    raw: { bass: 0, mid: 0, high: 0 }, playing: false, time: 0, duration: 0,
  };
}

export type SourceKind = 'file' | 'mic' | 'url' | 'capture';

/** Sources without a timeline: no play/pause, no seek. */
export const isLiveSource = (k: SourceKind | null): boolean => k === 'mic' || k === 'capture';

/** Payload type per source kind, so setSource is checked at the call site. */
export interface SourcePayloads {
  file: File;
  mic: { deviceId?: string } | undefined;
  /** Direct audio URL. The host must send CORS headers or analysis reads silence. */
  url: string;
  /** getDisplayMedia tab capture (Chrome/Edge desktop). */
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
  /** 0..1. Higher = fewer beats. 0.6 is the default. */
  beatThreshold: number;
}

export interface TransportState {
  source: SourceKind | null;
  /** Display name, e.g. file name, link host, mic device label. */
  label: string;
  playing: boolean;
  /** True for mic and capture: no timeline, shown as "Live". */
  live: boolean;
  /** Seekable sources only (file, url). */
  seekable: boolean;
  currentTime: number;
  /** Seconds; NaN until known, Infinity for live sources. */
  duration: number;
}

export interface AudioEvents {
  level: (level: number, peak: number) => void;
  state: (state: Readonly<TransportState>) => void;
  error: (err: Error) => void;
}

/** Error with a message written for the user (shown verbatim in the status line). */
export class AudioSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AudioSourceError';
  }
}
