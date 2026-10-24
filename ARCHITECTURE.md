# Architecture

Static site, no backend. TypeScript + Vite + three.js (WebGL2) + Web Audio. No UI framework.

## Module map

```
src/
  main.ts                 composition root: store, engine, panel, transport, stage
  app/
    params.ts             ParamDef schema (PARAMS), Params type, defaults, quantize/format/parse
    store.ts              ParamStore: typed observable values, validated against the schema
    loop.ts               rAF loop, fixed-timestep accumulator (60 Hz step, per-frame render)
    stage.ts              canvas + WebGLRenderer, ResizeObserver, DPR cap, active Effect, screenshot
  audio/
    types.ts              AudioFrame, SourceKind/SourcePayloads, AudioResponse, TransportState
    AudioEngine.ts        AudioContext, sources, play/pause/seek, getFrame(), events
    analysis.ts           FeatureExtractor: bands, rise/fall smoothing, beat detection
  effects/
    types.ts              Effect contract
    registry.ts           id -> EffectFactory
    ink/                  ink effect: InkEffect (TUNE, audio mapping), ParticleSim, Attractors,
                          InkTrails (density/trail/composite), shaders/
  ui/
    tokens.css, app.css   design tokens and component styles
    dom.ts                h(), Component, Disposer
    Panel.ts              builds sections and controls from PARAMS
    InputSection.ts       source tabs, status, level meter
    Transport.ts          floating pill: play/pause, time, seek, fullscreen
    components/           Slider, NumberField, Knob, ColorField, Tabs, Button, LevelMeter
  presets/
    types.ts              Preset, PresetRepository, PresetFile (types only in M1)
```

Dependency direction: `ui -> app, audio`; `app/stage -> effects, audio, app/store`;
`effects -> (types only) audio, app/params`. Effects never import UI, store or engine.

## Data flow per frame

```
rAF tick (Loop)
  frame():  audio = engine.getFrame()          // analyser read, smoothing, beat; emits 'level', 'beat'
            params = store.all                 // live read-only view, no copy
  step() x N  (N = accumulated time / 1/60, max 4)
            effect.step({ audio, time, dt: 1/60, params, renderer, size })
  render(): effect.render({ ..., dt: frameDt })
            pending screenshot -> canvas.toBlob (same task, no preserveDrawingBuffer)

UI input -> store.set(id, v) -> sanitize (clamp, snap, hex) -> listeners
  - controls repaint themselves (store.watch)
  - audio response keys -> engine.configure()
  - effect.onParamChange?(id) for expensive changes (e.g. particleCount realloc)
ResizeObserver(stage container) -> renderer.setSize(w, h, false), dpr = min(devicePixelRatio, 2)
  -> effect.resize(size)
```

Audio is sampled once per display frame and shared by all fixed steps in that frame.

## Effect contract

```ts
interface EffectContext {
  audio: Readonly<AudioFrame>;   // see Audio below
  time: number;                  // simulation clock, seconds
  dt: number;                    // 1/60 in step(), wall-clock delta in render()
  params: Readonly<Params>;
  renderer: WebGLRenderer;
  size: Readonly<RenderSize>;    // CSS px width/height + applied dpr
}

interface Effect {
  readonly id: string;
  readonly label: string;
  step(ctx: EffectContext): void;      // 0..N times per frame, fixed dt
  render(ctx: EffectContext): void;    // once per frame, to the default framebuffer
  resize(size: Readonly<RenderSize>, renderer: WebGLRenderer): void;
  onParamChange?(id: ParamId, params: Readonly<Params>): void;
  dispose(): void;
}
type EffectFactory = (renderer: WebGLRenderer, params: Readonly<Params>) => Effect;
```

Rules: the app owns renderer, canvas, audio and params. An effect owns only the GPU
resources it creates and must free them all in `dispose()`. Context objects are reused
between frames: read them, never keep references. Effects may ignore params they do
not use; a new effect is one file plus one line in `registry.ts`.

## Parameter schema

```ts
type SectionId = 'input' | 'particles' | 'trails' | 'look' | 'audio' | 'output';

interface NumberParamDef<Id extends string = string> {
  kind: 'number'; id: Id; label: string; section: SectionId;
  min: number; max: number; step: number; default: number;
  defaultMobile?: number; unit?: string; format?: (v: number) => string;
  control?: 'slider' | 'knob';
}
interface ColorParamDef<Id extends string = string> {
  kind: 'color'; id: Id; label: string; section: SectionId; default: string; control?: 'color';
}
type ParamDef<Id extends string = string> = NumberParamDef<Id> | ColorParamDef<Id>;
```

`PARAMS` is a `const` array built with `num(...)` and `color(...)` helpers, so ids stay
literal types. `Params` (the value bag) and `ParamId` are derived from it. Adding a
parameter is one line in `PARAMS`; the panel control, store validation, reset, preset
typing and `ctx.params.<id>` all follow automatically.

## Ink effect

1. Particle state in two RGBA32F ping-pong MRT textures (pos.xy, vel.xy | age, life, seed,
   emitterIndex). sqrt(count) square, 200k desktop, 50k mobile (`defaultMobile`).
2. Simulation pass (fullscreen triangle, `shaders/sim.glsl.ts`): curl noise at `turbulenceScale`,
   spring + swirl toward the nearest of 1 to 3 wandering attractors (`Attractors.ts`, CPU),
   `drag`, speed clamp. Births at an attractor: 25% stay in the core, the rest ride a few
   slowly spinning jets. Respawn on age > life, at `emissionRate`, off-screen, or on a beat
   (burst, see the audio table). All audio constants live in `TUNE` (InkEffect.ts), exposed
   as `stage.effect.tune` with `?debug`.
3. Splat pass (`shaders/points.glsl.ts`): `gl.LINES`, two vertices per particle, no
   attributes (`gl_VertexID >> 1` indexes the state). Each particle draws the segment it
   travelled in its last step (min 1 device px), so consecutive steps tile the path and fast
   particles leave continuous strokes instead of specks. Ink per particle is constant
   (per-pixel ink = ink / length). Additive into an RGBA16F density target:
   rgb = ink * absorbance of the particle's attractor colour (-ln of its sRGB value), a = ink.
   A render-time beat kick (radial expansion about the nearest core) is applied here.
4. Feedback (`InkTrails.ts`, `shaders/trail.glsl.ts`): two RGBA16F layers in one MRT
   ping-pong pair, same rgb/a layout as the density.
   - line: fade `trailFade`, blur `0.6px * pointSize`, deposit x `pointSize^0.6` (thicker
     strokes, roughly the same darkness; cores are not diluted by blur, so not fully linear).
   - wash: longer memory (derived from `trailFade`), blur `trailBlur`, drift `trailDrift * 4`
     px per step outward from the attractors (direction blended over all attractors, so there
     is no seam between two cores) with a slow swirl.
   Fade, blur and drift are applied per simulation step, so the look is refresh-rate independent.
5. Composite: coverage from the a channels exactly as before (line + capped wash, contrast
   S-curve). Ink colour = exp(-K), K = per-layer mean absorbance rgb / a, layers weighted by
   coverage. Mixing in absorbance space multiplies colours (subtractive): indigo over oxblood
   gives a dark violet-brown, and overlapping ink is denser, so darker. With all three colours
   equal this is identical to the single-colour M4 composite. Result = mix(paper, ink colour,
   coverage) + paper texture + grain (CSS-px cells; a light floor everywhere, strongest in the
   midtones).

Per-attractor colours: `inkColor1..3`; the panel shows colour 2 and 3 only when `emitters` >= 2 / 3.

### Audio mapping

Bands arrive already multiplied by their sensitivity slider (0 = off, 1 = nominal, 3 = up to
3x; the engine clamps the normalised band to 0..1 before applying sensitivity). `bs` is
`beatStrength` (0.25..1 on the beat frame, decays with tau 250 ms).

| Input | Drives | Mapping |
|-------|--------|---------|
| beat (one frame) | burst births | `burstSize * max(bs, 0.25) * 0.4` of all particles respawn at a core and ride 5 fresh rays per attractor (new directions every beat), speed `1.6 * (0.3..1.2)`, 8% tangential, life x 0.5 |
| bs | push on live particles | outward acceleration `bs * 0.8 * (0.5 + burstSize)`, falloff `(1 - smoothstep(0, 0.45, d))^2` from the nearest core |
| bs | kick (render only) | positions drawn expanded about the nearest core by `bs * 0.35 * (0.5 + burstSize)`, fading out by d = 0.8; relaxes as bs decays, so beats do not scatter the ink into fog |
| bs | shiver | turbulence x `(1 + 0.6 bs)` |
| bs | wash swell | wash gain x `(1 + 1.2 bs)`, wash blur x `(1 + 0.8 bs)` (`trailFade` untouched) |
| bass | emission, attractor speed | respawn rate x `(1 + 2 bass)`, wander speed x `(1 + 1.5 bass)` |
| mid | turbulence | x `(1 + 1.5 mid)` |
| high | noise scale, ink | `turbulenceScale` x `(1 + high)`, ink per particle x `(1 + 0.5 high)` |

The panel's level meter has a beat blip (accent dot, 200 ms fade, brightness from the beat
strength) and the `engine.bpm` estimate, from the engine's `beat` event, for tuning Beat thresh.

## Audio

`setSource(kind, payload)` is typed per kind via `SourcePayloads`; `stop()` returns to idle.
Switching source tears the previous one down (stop tracks, disconnect nodes, revoke object
URLs). The AudioContext and a single AnalyserNode (fftSize 2048, smoothingTimeConstant 0)
are created lazily on the first `setSource()` (a user gesture) and resumed on every play/start.

| Source  | Input                                                        | Audible            | Transport          |
|---------|--------------------------------------------------------------|--------------------|--------------------|
| file    | `<audio>` (or `<video>` for video/* so MP4 uses its audio)   | yes, to destination | play/pause, seek   |
| url     | `<audio crossOrigin="anonymous">`                            | yes                | play/pause, seek   |
| mic     | `getUserMedia` with AEC/NS/AGC off -> MediaStreamSource      | no (feedback)      | "Live"             |
| capture | `getDisplayMedia({video, audio})`, video tracks stopped      | no (tab already plays) | "Live"         |

Failure handling: a link that fails to load (no CORS headers, 404, not audio) reports via the
element `error` event; a link that plays pure digital zeros for 2 s (tainted element) reports
"This host blocks cross-origin audio. Try the Capture tab." Streaming hosts (Spotify, YouTube...)
are rejected up front. Capture with no audio track, or outside Chromium desktop, gets its own
message; the audio track's `ended` event (user clicked "Stop sharing", mic unplugged) returns to idle.

```ts
interface AudioFrame {
  bass: number; mid: number; high: number;   // smoothed, 0..1 x sensitivity (0..3)
  level: number;                             // normalised RMS, smoothed
  peak: number;                              // peak-hold of level (0.8 s hold), for meters
  beat: boolean;                             // true for exactly one frame per onset
  beatStrength: number;                      // set on the beat frame, decays (tau 250 ms)
  raw: { bass: number; mid: number; high: number };  // before rise/fall smoothing
  playing: boolean;
  time: number;                              // media time, or seconds since live start
  duration: number;                          // media duration, 0 for live/unknown
}
```

`FeatureExtractor` (analysis.ts), once per display frame while playing:

1. Bands from the real sampleRate: bass 20-150 Hz, mid 150-2000, high 2000-12000. Bin powers
   are averaged linearly and converted to dB above a -100 dBFS floor (a plain mean of dB values
   would bury a narrow tone in a wide band).
2. Per-band adaptive normaliser: running max with a 4 s half-life, floored at 50 dB above the
   floor; the 30 dB window below the max maps to 0..1, so silence stays 0.
3. Sensitivity (`bassSens` etc., applied after the 0..1 clamp so 3 means up to 3x), then asymmetric exponential smoothing with time constants
   `smoothRise` / `smoothFall` (framerate independent). `raw` is the value before this step.
4. Level: time-domain RMS in dBFS through the same kind of normaliser; peak hold 0.8 s, then
   falls 0.6/s.
5. Beats: spectral flux over 20-400 Hz on log(1 + 10|X|) magnitudes. Fire when flux >
   mean + k * std of the last 1.5 s (k = 0.25 + 2.5 * `beatThreshold`, so 0.6 -> 1.75), total
   region energy is rising (rejects note-offs), and 120 ms have passed since the last beat.
   `engine.bpm` is a rolling median-interval tempo estimate (0 when unknown).

When nothing is playing the bands, level and beatStrength decay to 0 with the fall constant.
Add `?debug` to the URL to expose `engine`, `store` and `stage` on `window` in production builds.

## UI

Panel and transport are plain functions returning `{ el, dispose }`. Layout lives only in
CSS (`.shell` grid: 320px panel, canvas fills the rest), so the panel can become a bottom
sheet under 768px without code changes. The accent colour is reserved for the active tab,
seek fill, level meter and focus ring.

## Milestones

M0/M1 architecture, scaffold, panel shell. M2 GPU ink effect, mic/link/capture.
M3 presets (localStorage + JSON file). M4 performance tiers, mobile sheet. M5 polish.
