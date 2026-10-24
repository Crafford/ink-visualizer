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
    ink/InkEffect.ts      first effect (M1 placeholder, M2 GPU pipeline)
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
  frame():  audio = engine.getFrame()          // analyser read, smoothing, beat; emits 'level'
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
  audio: Readonly<AudioFrame>;   // bass, mid, high, level, beat, beatEnvelope, active
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

## Ink effect plan (M2)

1. Particle state in two RGBA32F ping-pong textures (pos.xy, vel.xy; age/life in a second
   pair). sqrt(count) square, 200k desktop, 50k mobile (`defaultMobile`).
2. Simulation pass (fullscreen quad): curl noise at `turbulenceScale`, pull toward 1 to 3
   attractors that wander on their own low-frequency noise; `drag`; respawn on age > life
   near attractors at `emissionRate`; beat adds a radial impulse scaled by `burstSize`.
   Bass drives attractor pull, mid the curl strength, high the point size jitter.
3. Splat pass: `gl.POINTS` reading positions in the vertex shader, additive blend into a
   half-float density target, alpha = `pointOpacity`.
4. Feedback: previous trail target * `trailFade`, separable blur `trailBlur`, offset by
   `trailDrift`, plus new density. Ping-pong.
5. Composite: density -> tone curve (`contrast`) -> mix(paper, ink) -> grain. Inverted
   look: ink on white paper.

## Audio

`setSource(kind, payload)` is typed per kind via `SourcePayloads`. File is implemented
(HTMLAudioElement -> MediaElementSource -> Analyser -> destination). Mic, URL and tab
capture throw `NotImplementedError` (M2). Live sources connect to the analyser only, never
to the destination. `getFrame()` returns smoothed 0..1 bands (bass 20-250 Hz,
mid 250-2000, high 2000-12000) with asymmetric rise/fall, RMS level, and a beat flag from
bass onset over a running mean with a 150 ms refractory period.

## UI

Panel and transport are plain functions returning `{ el, dispose }`. Layout lives only in
CSS (`.shell` grid: 320px panel, canvas fills the rest), so the panel can become a bottom
sheet under 768px without code changes. The accent colour is reserved for the active tab,
seek fill, level meter and focus ring.

## Milestones

M0/M1 architecture, scaffold, panel shell. M2 GPU ink effect, mic/link/capture.
M3 presets (localStorage + JSON file). M4 performance tiers, mobile sheet. M5 polish.
