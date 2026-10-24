import type { AudioFrame, AudioResponse } from './types';

/** Band edges in Hz. */
const BANDS = { bass: [20, 150], mid: [150, 2000], high: [2000, 12000] } as const;
/** Onset detection region: bass plus low mids (kick, bass notes, snare body). */
const FLUX_BAND = [20, 400] as const;

/** Anything below this is treated as silence. dBFS. */
const DB_FLOOR = -100;
/** Running max half-life for the adaptive normaliser. */
const NORM_HALF_LIFE_S = 4;
/** Dynamic window below the running max that maps to 0..1. */
const NORM_RANGE_DB = 30;
/** The running max never drops below floor + this, so near-silence stays near 0. */
const NORM_MIN_MAX_DB = 50;

/** Level uses RMS in dBFS with its own floor and window. */
const LEVEL_FLOOR_DB = -70;
const LEVEL_RANGE_DB = 36;

const BEAT_WINDOW_S = 1.5;
/** C in log(1 + C * |X|) for the flux magnitudes. */
const FLUX_COMPRESSION = 10;
/** Absolute minimum flux (per bin, compressed units) for a beat, so near-silence never fires. */
const FLUX_MIN = 0.01;
const BEAT_REFRACTORY_S = 0.12;
const BEAT_DECAY_S = 0.25;
const PEAK_HOLD_S = 0.8;
const PEAK_FALL_PER_S = 0.6;

/** beatThreshold 0..1 -> k in "flux > mean + k * std". 0.6 -> 1.75. */
export const thresholdToK = (t: number) => 0.25 + 2.5 * t;

/**
 * Adaptive normaliser for a dB-above-floor value. Tracks a running max that decays
 * with a fixed half-life and maps [max - range, max] to [0, 1].
 */
class Normaliser {
  private max: number;
  constructor(private range: number, private minMax: number) { this.max = minMax; }
  reset(): void { this.max = this.minMax; }
  apply(x: number, dt: number): number {
    this.max = Math.max(x, this.minMax, this.max * Math.pow(0.5, dt / NORM_HALF_LIFE_S));
    return clamp01((x - (this.max - this.range)) / this.range);
  }
}

/**
 * Turns raw analyser data into an AudioFrame: per-band adaptive normalisation,
 * asymmetric rise/fall smoothing, RMS level with peak hold, and spectral-flux beats.
 * Owns only analysis state; the engine owns the graph.
 */
export class FeatureExtractor {
  private freq: Float32Array<ArrayBuffer>;
  private prevMag: Float32Array<ArrayBuffer>;
  private wave: Float32Array<ArrayBuffer>;
  private hasPrev = false;
  private prevPow = 0;

  private norm = {
    bass: new Normaliser(NORM_RANGE_DB, NORM_MIN_MAX_DB),
    mid: new Normaliser(NORM_RANGE_DB, NORM_MIN_MAX_DB),
    high: new Normaliser(NORM_RANGE_DB, NORM_MIN_MAX_DB),
    level: new Normaliser(LEVEL_RANGE_DB, LEVEL_RANGE_DB),
  };
  private smooth = { bass: 0, mid: 0, high: 0, level: 0 };
  private peak = 0;
  private peakHold = 0;

  // Flux ring buffer (values + timestamps); capacity covers 1.5s at up to ~300 fps.
  private fluxVals = new Float32Array(512);
  private fluxTimes = new Float64Array(512);
  private fluxHead = 0;
  private fluxCount = 0;
  private clock = 0;
  private sinceBeat = 1;
  private beatStr = 0;
  private beatTimes: number[] = [];
  /** Rolling tempo estimate from recent beat intervals; 0 when unknown. */
  bpm = 0;
  /** Last spectral flux value, exposed for debugging and tests. */
  flux = 0;

  constructor(private analyser: AnalyserNode) {
    this.freq = new Float32Array(analyser.frequencyBinCount);
    this.prevMag = new Float32Array(analyser.frequencyBinCount);
    this.wave = new Float32Array(analyser.fftSize);
  }

  reset(): void {
    for (const n of Object.values(this.norm)) n.reset();
    this.smooth = { bass: 0, mid: 0, high: 0, level: 0 };
    this.peak = 0;
    this.peakHold = 0;
    this.hasPrev = false;
    this.fluxHead = 0;
    this.fluxCount = 0;
    this.sinceBeat = 1;
    this.beatStr = 0;
    this.beatTimes.length = 0;
    this.bpm = 0;
    this.flux = 0;
  }

  /** True if the last read time-domain buffer was exactly zero (used for CORS-silence detection). */
  isDigitalSilence(): boolean {
    this.analyser.getFloatTimeDomainData(this.wave);
    for (let i = 0; i < this.wave.length; i++) if (this.wave[i] !== 0) return false;
    return true;
  }

  extract(dt: number, cfg: AudioResponse, active: boolean, out: AudioFrame): void {
    this.clock += dt;
    let bass = 0, mid = 0, high = 0, level = 0;
    let beat = false;

    if (active) {
      const a = this.analyser;
      a.getFloatFrequencyData(this.freq);
      a.getFloatTimeDomainData(this.wave);
      const hzPerBin = a.context.sampleRate / a.fftSize;

      bass = this.norm.bass.apply(this.bandDb(BANDS.bass, hzPerBin), dt);
      mid = this.norm.mid.apply(this.bandDb(BANDS.mid, hzPerBin), dt);
      high = this.norm.high.apply(this.bandDb(BANDS.high, hzPerBin), dt);

      let sq = 0;
      for (let i = 0; i < this.wave.length; i++) sq += this.wave[i] * this.wave[i];
      const rmsDb = 10 * Math.log10(sq / this.wave.length + 1e-20);
      level = this.norm.level.apply(Math.max(0, rmsDb - LEVEL_FLOOR_DB), dt);

      beat = this.detectBeat(hzPerBin, dt, cfg.beatThreshold);
    } else {
      this.hasPrev = false;
      this.sinceBeat += dt;
    }

    // Sensitivity scales after the clamp, so 3 really means up to 3x (not a hard 0..1 cap).
    out.raw.bass = clamp01(bass) * cfg.bassSens;
    out.raw.mid = clamp01(mid) * cfg.midSens;
    out.raw.high = clamp01(high) * cfg.highSens;

    const s = this.smooth;
    s.bass = follow(s.bass, out.raw.bass, dt, cfg.smoothRise, cfg.smoothFall);
    s.mid = follow(s.mid, out.raw.mid, dt, cfg.smoothRise, cfg.smoothFall);
    s.high = follow(s.high, out.raw.high, dt, cfg.smoothRise, cfg.smoothFall);
    s.level = follow(s.level, level, dt, cfg.smoothRise, cfg.smoothFall);

    // Peak tick: hold, then fall linearly.
    if (s.level >= this.peak) { this.peak = s.level; this.peakHold = PEAK_HOLD_S; }
    else if ((this.peakHold -= dt) <= 0) this.peak = Math.max(s.level, this.peak - dt * PEAK_FALL_PER_S);

    if (!beat) this.beatStr *= Math.exp(-dt / BEAT_DECAY_S);

    out.bass = s.bass;
    out.mid = s.mid;
    out.high = s.high;
    out.level = s.level;
    out.peak = this.peak;
    out.beat = beat;
    out.beatStrength = this.beatStr;
  }

  /**
   * Band energy in dB above DB_FLOOR. Bins are averaged as power and then converted back
   * to dB, so a narrow tone inside a wide band still registers (a plain mean of dB values
   * would be dominated by the empty bins).
   */
  private bandDb([lo, hi]: readonly [number, number], hzPerBin: number): number {
    const i0 = Math.max(1, Math.round(lo / hzPerBin));
    const i1 = Math.min(this.freq.length - 1, Math.round(hi / hzPerBin));
    let p = 0;
    for (let i = i0; i <= i1; i++) {
      const db = this.freq[i];
      if (db > DB_FLOOR) p += Math.pow(10, db / 10);
    }
    const db = 10 * Math.log10(p / (i1 - i0 + 1) + 1e-30);
    return Math.max(0, db - DB_FLOOR);
  }

  /**
   * Spectral flux over FLUX_BAND against a 1.5s adaptive threshold. Magnitudes are log-compressed
   * as log(1 + C * |X|) rather than plain dB, so leakage rising out of the noise floor counts for
   * little while real energy increases dominate.
   */
  private detectBeat(hzPerBin: number, dt: number, threshold: number): boolean {
    const i0 = Math.max(1, Math.round(FLUX_BAND[0] / hzPerBin));
    const i1 = Math.min(this.freq.length - 1, Math.round(FLUX_BAND[1] / hzPerBin));
    let flux = 0, pow = 0;
    for (let i = i0; i <= i1; i++) {
      const lin = Math.pow(10, this.freq[i] / 20);
      pow += lin * lin;
      const m = Math.log1p(FLUX_COMPRESSION * lin);
      if (this.hasPrev) { const d = m - this.prevMag[i]; if (d > 0) flux += d; }
      this.prevMag[i] = m;
    }
    flux /= i1 - i0 + 1;
    // An onset must also raise total energy in the region. When a note stops abruptly, spectral
    // leakage gives some positive flux, but overall energy falls, so this rejects note-offs.
    const rising = pow > this.prevPow;
    this.prevPow = pow;
    const first = !this.hasPrev;
    this.hasPrev = true;
    this.flux = flux;
    this.sinceBeat += dt;
    if (first) return false;

    // Stats over the window, excluding the current value.
    const cap = this.fluxVals.length;
    const cutoff = this.clock - BEAT_WINDOW_S;
    let n = 0, sum = 0, sum2 = 0;
    for (let j = 0; j < this.fluxCount; j++) {
      const idx = (this.fluxHead - 1 - j + cap) % cap;
      if (this.fluxTimes[idx] < cutoff) break;
      const v = this.fluxVals[idx];
      n++; sum += v; sum2 += v * v;
    }
    this.fluxVals[this.fluxHead] = flux;
    this.fluxTimes[this.fluxHead] = this.clock;
    this.fluxHead = (this.fluxHead + 1) % cap;
    this.fluxCount = Math.min(cap, this.fluxCount + 1);
    if (n < 10) return false; // need some history

    const mean = sum / n;
    // Floor the deviation so steady material does not turn tiny wobbles into beats.
    const std = Math.max(Math.sqrt(Math.max(0, sum2 / n - mean * mean)), FLUX_MIN + 0.25 * mean);
    const k = thresholdToK(threshold);
    const z = (flux - mean) / std;
    if (z <= k || !rising || flux < FLUX_MIN || this.sinceBeat < BEAT_REFRACTORY_S) return false;

    this.sinceBeat = 0;
    this.beatStr = 0.25 + 0.75 * clamp01((z - k) / 4);
    this.updateBpm();
    return true;
  }

  private updateBpm(): void {
    const t = this.beatTimes;
    t.push(this.clock);
    while (t.length > 0 && this.clock - t[0] > 8) t.shift();
    if (t.length < 4) { this.bpm = 0; return; }
    const iv: number[] = [];
    for (let i = 1; i < t.length; i++) iv.push(t[i] - t[i - 1]);
    iv.sort((a, b) => a - b);
    let bpm = 60 / iv[iv.length >> 1];
    while (bpm > 0 && bpm < 70) bpm *= 2;
    while (bpm > 190) bpm /= 2;
    this.bpm = Math.round(bpm);
  }
}

/** Exponential approach with separate rise and fall time constants (seconds). Framerate independent. */
function follow(cur: number, target: number, dt: number, rise: number, fall: number): number {
  const tau = target > cur ? rise : fall;
  if (tau <= 0) return target;
  return cur + (target - cur) * (1 - Math.exp(-dt / tau));
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
