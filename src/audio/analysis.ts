import type { AudioFrame, AudioResponse } from './types';

/** Band edges in Hz. */
const BANDS = { bass: [20, 250], mid: [250, 2000], high: [2000, 12000] } as const;

const REFRACTORY_S = 0.15;

/**
 * Turns raw analyser data into a smoothed AudioFrame.
 * Stateless with respect to the source; owns only smoothing and beat state.
 */
export class FeatureExtractor {
  private freq: Float32Array<ArrayBuffer>;
  private wave: Float32Array<ArrayBuffer>;
  private smooth = { bass: 0, mid: 0, high: 0, level: 0 };
  private bassAvg = 0;
  private sinceBeat = 1;
  private beatEnv = 0;

  constructor(private analyser: AnalyserNode) {
    this.freq = new Float32Array(analyser.frequencyBinCount);
    this.wave = new Float32Array(analyser.fftSize);
  }

  reset(): void {
    this.smooth = { bass: 0, mid: 0, high: 0, level: 0 };
    this.bassAvg = 0;
    this.beatEnv = 0;
  }

  /** Returns raw RMS level as well, for the meter. */
  extract(dt: number, cfg: AudioResponse, active: boolean, out: AudioFrame): number {
    const a = this.analyser;
    let rawLevel = 0;
    let bass = 0, mid = 0, high = 0;

    if (active) {
      a.getFloatFrequencyData(this.freq);
      a.getFloatTimeDomainData(this.wave);
      const hzPerBin = a.context.sampleRate / a.fftSize;
      const range = a.maxDecibels - a.minDecibels;
      const band = ([lo, hi]: readonly [number, number]) => {
        const i0 = Math.max(1, Math.floor(lo / hzPerBin));
        const i1 = Math.min(this.freq.length - 1, Math.ceil(hi / hzPerBin));
        let sum = 0;
        for (let i = i0; i <= i1; i++) sum += clamp01((this.freq[i] - a.minDecibels) / range);
        return sum / (i1 - i0 + 1);
      };
      bass = band(BANDS.bass);
      mid = band(BANDS.mid);
      high = band(BANDS.high);
      let sq = 0;
      for (let i = 0; i < this.wave.length; i++) sq += this.wave[i] * this.wave[i];
      rawLevel = Math.sqrt(sq / this.wave.length);
    }

    const s = this.smooth;
    s.bass = follow(s.bass, clamp01(bass * cfg.bassSens), dt, cfg.smoothRise, cfg.smoothFall);
    s.mid = follow(s.mid, clamp01(mid * cfg.midSens), dt, cfg.smoothRise, cfg.smoothFall);
    s.high = follow(s.high, clamp01(high * cfg.highSens), dt, cfg.smoothRise, cfg.smoothFall);
    s.level = follow(s.level, clamp01(rawLevel * 2.5), dt, cfg.smoothRise, cfg.smoothFall);

    // Beat: bass onset above a slow running average. Higher threshold = fewer beats.
    this.bassAvg += (bass - this.bassAvg) * Math.min(1, dt / 0.8);
    this.sinceBeat += dt;
    const margin = 0.02 + cfg.beatThreshold * 0.25;
    const beat = active && this.sinceBeat > REFRACTORY_S && bass > 0.1 && bass - this.bassAvg > margin;
    if (beat) {
      this.sinceBeat = 0;
      this.beatEnv = 1;
    } else {
      this.beatEnv *= Math.exp(-dt / 0.25);
    }

    out.bass = s.bass;
    out.mid = s.mid;
    out.high = s.high;
    out.level = s.level;
    out.beat = beat;
    out.beatEnvelope = this.beatEnv;
    out.active = active;
    return rawLevel;
  }
}

function follow(cur: number, target: number, dt: number, rise: number, fall: number): number {
  const tau = target > cur ? rise : fall;
  if (tau <= 0) return target;
  return cur + (target - cur) * (1 - Math.exp(-dt / tau));
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
