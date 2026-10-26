# Architecture

Static site, no backend. TypeScript + Vite + three.js (WebGL2) + Web Audio. No UI framework.

## Module map

```
src/
  main.ts                 composition root: store, engine, panel, transport, stage
  app/
    params.ts             ParamDef schema + helpers (num/color/toggle, n10), APP_PARAMS (audio response),
                          ValuesOf<>, defaults, quantize/format/parse/sanitize, uiScale
    store.ts              ParamStore: app params + the active effect's params, validated against the
                          schema; setEffect() swaps the effect set and keeps each effect's last values
    loop.ts               rAF loop, fixed-timestep accumulator (60 Hz step, per-frame render)
    stage.ts              canvas + WebGLRenderer, ResizeObserver, DPR cap, active Effect, screenshot
  audio/
    types.ts              AudioFrame, SourceKind/SourcePayloads, AudioResponse, TransportState
    AudioEngine.ts        AudioContext, sources, play/pause/seek, getFrame(), events
    analysis.ts           FeatureExtractor: bands, rise/fall smoothing, beat detection
  effects/
    types.ts              Effect contract, EffectEntry
    registry.ts           EFFECTS: { id, label, params, sections, create, linked? }[] (Ink, Smoke)
    shared/               Attractors (wandering sources), PingPongState (float MRT ping-pong particle
                          state + sim pass), subpixel (Size < 0.5 px density pre-filter),
                          FullscreenPass, shaders/ (noise + curl + hash, fullscreen triangle +
                          MAX_ATTRACTORS, two-layer blur header)
    ink/                  ink effect: params.ts (INK_PARAMS, sections), InkEffect (TUNE, audio
                          mapping), ParticleSim, InkTrails (density/trail/composite), shaders/
    smoke/                smoke effect: params.ts (SMOKE_PARAMS, mode-linked colours, Auto mode),
                          SmokeEffect (TUNE, ring cadence, audio mapping, splat), SmokeTrails (trail, light/dark
                          composite), shaders/
  ui/
    tokens.css, app.css   design tokens and component styles
    dom.ts                h(), Component, Disposer
    Panel.ts              header effect selector; builds sections and controls from the schema
    PresetsSection.ts     preset select, Reset (reload preset), Save/Delete inline, Export/Import
    InputSection.ts       source tabs, status, level meter
    Transport.ts          floating pill: play/pause, time, seek, fullscreen
    components/           Slider, NumberField, Knob, ColorField, Segments (toggle params, effect
                          selector), Tabs, Button, LevelMeter
  presets/
    types.ts              Preset, PresetStorage, PresetFile, PRESET_SCHEMA
    store.ts              PresetBank: built-in Default per effect (from the schema), user presets in
                          localStorage, JSON export/import with validation, filtered by effect
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

UI input -> store.set(id, v) -> sanitize (clamp, snap, hex, toggle value) -> listeners
            -> effect entry linked(id) (e.g. Smoke Mode / Background swap default colours; not during preset load)
  - controls repaint themselves (store.watch)
  - audio response keys -> engine.configure()
  - effect.onParamChange?(id) for expensive changes (e.g. particleCount realloc)
ResizeObserver(stage container) -> renderer.setSize(w, h, false), dpr = min(devicePixelRatio, 2)
  -> effect.resize(size)
```

Audio is sampled once per display frame and shared by all fixed steps in that frame.

## Effect contract

```ts
interface EffectContext<P = ParamValues> {
  audio: Readonly<AudioFrame>;   // see Audio below
  time: number;                  // simulation clock, seconds
  dt: number;                    // 1/60 in step(), wall-clock delta in render()
  params: Readonly<P>;           // APP_PARAMS + the effect's own params
  renderer: WebGLRenderer;
  size: Readonly<RenderSize>;    // CSS px width/height + applied dpr
}

interface Effect<P = ParamValues> {
  readonly id: string;
  readonly label: string;
  step(ctx: EffectContext<P>): void;      // 0..N times per frame, fixed dt
  render(ctx: EffectContext<P>): void;    // once per frame, to the default framebuffer
  resize(size: Readonly<RenderSize>, renderer: WebGLRenderer): void;
  onParamChange?(id: string, params: Readonly<P>): void;
  dispose(): void;
}
type EffectFactory = (renderer: WebGLRenderer, params: Readonly<ParamValues>) => Effect;

interface EffectEntry {                    // one line in registry.ts
  id: string; label: string;
  params: readonly ParamDef[];             // the effect's own params (APP_PARAMS are added)
  sections: readonly SectionDef[];         // panel sections for them, in order
  create: EffectFactory;
  linked?(id, values): ParamValues | null; // values to apply after a user change
}
```

Rules: the app owns renderer, canvas, audio and params. An effect owns only the GPU
resources it creates and must free them all in `dispose()`. Context objects are reused
between frames: read them, never keep references. A new effect is a folder with a
`params.ts` (its PARAMS and sections) and the effect class, plus one entry in `registry.ts`;
each effect types its params as `AppParams & ValuesOf<typeof ITS_PARAMS>`.

Switching effect (panel header selector, `setEffect(id)` in main.ts): the store saves the
outgoing effect's values and loads the incoming effect's last values (defaults the first
time; app params are untouched), then the stage disposes the old effect and creates the new
one (new trails, so the canvas starts empty), and the panel rebuilds the effect sections.

## Parameter schema

```ts
type SectionId = string;   // app: 'input' | 'audio' | 'output'; effects declare their own

interface NumberParamDef<Id extends string = string> {
  kind: 'number'; id: Id; label: string; section: SectionId;
  min: number; max: number; step: number; default: number;
  defaultMobile?: number; unit?: string; format?: (v: number) => string;
  control?: 'slider' | 'knob';
  display?: { scale: 'norm10'; curve?: 'linear' | 'pow' | 'log'; exponent?: number; pole?: number };
  visibleWhen?: { id: string; min: number };   // e.g. colour 2 only with Sources >= 2
}
interface ColorParamDef<Id extends string = string> {
  kind: 'color'; id: Id; label: string; section: SectionId; default: string; visibleWhen?: ...;
}
interface ToggleParamDef<Id extends string = string, V extends string = string> {
  kind: 'toggle'; id: Id; label: string; section: SectionId;
  options: readonly { value: V; label: string }[]; default: V;   // panel: segmented control
}
type ParamDef<Id extends string = string> = NumberParamDef<Id> | ColorParamDef<Id> | ToggleParamDef<Id>;
```

`APP_PARAMS` (params.ts: bassSens, midSens, highSens, smoothRise, smoothFall, burstSize) and
each effect's `INK_PARAMS` / `SMOKE_PARAMS` are `const` arrays built with the `num(...)`,
`color(...)` and `toggle(...)` helpers, so ids stay literal types; `ValuesOf<typeof X>` gives
the value bag. Adding a parameter is one line in the effect's list; the panel control, store
validation, reset, presets and `ctx.params.<id>` follow automatically. Effects may reuse ids
with the same meaning (Count, Emission, Lifespan, Speed, Turbulence, Swirl, Drag, Sources,
Contrast, Grain); values are kept per effect.

### Panel scale (0..10)

Params with `display: { scale: 'norm10' }` show 0..10 with one decimal on the panel, like a
hardware knob. The store, the effect and presets always hold the real value; only the
controls convert (`uiScale(def)` in params.ts: range, step, text, `toUi`, `fromUi`). Slider,
knob, value field and keyboard all go through it, so the mapping is in one place. Typing
into the value field takes a 0..10 number (clamped); arrows nudge 0.1 (Shift 1.0) from the
shown value; the hover title shows the real value. The real `step` of norm10 params is at
most 1/100 of the range so every 0.1 display step lands on a distinct real value.

Curves (t = display / 10):

| Curve | Real value | Used by |
|-------|-----------|---------|
| linear (default) | `min + (max - min) t` | all norm10 params except Persistence |
| log, pole p | `p + sign * exp(lerp(log abs(min - p), log abs(max - p), t^exponent))` | Persistence (`trailFade`, pole 1) |
| pow | `min + (max - min) t^exponent` | none yet |

Persistence: the trail length goes as 1 / (1 - fade) (6.7 steps at 0.85, 100 at 0.99), so
log(1 - fade) is linear in the display: each 0.1 multiplies the trail length by the same
factor (1.028). The default 0.92 sits at 2.3.

Real units stay for Count (k), Lifespan (s), Speed (x), Sources and the colours.

## Ink effect

Metaphor: drops of ink from a dropper landing on art paper. A drop splatters, then bleeds into
the paper and stops, feathering at the edges. Wetness turns dry card into wet watercolour paper.

1. Particle state in three RGBA32F ping-pong MRT textures, sqrt(count) square, 200k desktop,
   50k mobile (`defaultMobile`):
   - A: pos.xy, vel.xy
   - B: age, life (< 0 = dormant), seed, source index
   - C: bleed centre.xy, bleed reach R, bleed angle (set at birth, see Bleed below)
   Particles start dormant (culled in the draw pass) and return to dormant when age > life or
   they leave the view, so the pool feeds both seep and drops.
2. Simulation pass (fullscreen triangle, `shaders/sim.glsl.ts`), all in simulation seconds
   (dt x `speed`):
   - Seep: each dormant particle wakes with probability `emissionRate * 0.15 * (1 + 2 bass) * dt`
     in a disc (r 0.02) at a random source with a slow outward velocity (0.03).
   - Drop: on a beat, `burstSize * max(bs, 0.25) * 0.15` of all particles respawn at every source:
     a dense disc (r 0.03..0.05 by strength, landing up to 0.1 from the source) with a radial
     launch proportional to the distance from the centre, carrying ~`0.035 * (0.5 + bs)`, plus
     3-7 satellite spatters (20% of the drop's particles, small discs stretched along their
     direction, 0.08-0.25 from the centre, same colour). Life x 1.2. With no beat for 2 s
     (real time), each source drips on its own every 1.4-3.4 s of sim time (strength 0.3-0.65,
     `0.15 * emissionRate` of all particles), so the idle canvas still shows drops.
   - Bleed: the medium velocity is `dir(angle + fibre) * bleedRate * R * f^2`, f = 1 - d / R,
     d = distance from the bleed centre (C.xy), so the bleed slows and stops at R. R is set at
     birth as `d0 * (1 + grow * g * m)`: the landing disc scales up as a whole (an additive
     offset would hollow it into a ring); m varies with angle (low + high frequency noise,
     lobed ragged edge); 8% of particles are fibre tendrils (g 1.4-2.8). The bleed angle is bent
     by a static high-frequency noise field (`feather` 0.7 rad, frequency 45): paper fibres,
     so the bleed front is ragged.
   - Curl noise (two octaves) is added to the medium velocity: `turbulenceStrength * 0.035`
     view half-heights/s x wetness influence x (1 + 1.5 mid).
   - The particle velocity relaxes toward the medium at `6 * (0.25 + drag) * wetRelax` per second,
     which is also what kills a splat launch (dry: ~0.1 s).
   - Sources (`shared/Attractors.ts`, CPU) wander at phase rate 0.4 x `speed` x (1 + bass): a full
     traverse of the central 60% of the view takes 40-60 s.
   All tuning lives in `TUNE` (InkEffect.ts), exposed as `stage.effect.tune` with `?debug`.
3. Splat pass (`shaders/points.glsl.ts`): `gl.LINES`, two vertices per particle, no
   attributes (`gl_VertexID >> 1` indexes the state). Each particle draws the segment it
   travelled in its last step (min 1 device px). Ink per particle is constant
   (per-pixel ink = ink / length). Additive into an RGBA16F density target:
   rgb = ink * absorbance of the particle's source colour (-ln of its sRGB value), a = ink.
   Render-time audio response (real clock, never moves the simulated particles, so ink is moved
   in place, not carried away): kick, shiver, breath (see Audio mapping).
4. Feedback (`InkTrails.ts`, `shaders/trail.glsl.ts`): two RGBA16F layers in one MRT
   ping-pong pair, same rgb/a layout as the density.
   - line: fade `trailFade`, blur `0.6px * pointSize * wetLineBlur`, deposit x `pointSize^0.6`.
   - wash: longer memory (derived from `trailFade` and wetness), blur `trailBlur * wetWashBlur`,
     drift `trailDrift * 2 * wetDrift` px per step outward from the sources (direction blended
     over all sources) with a slow swirl.
   Fade, blur and drift are applied per real-time step (not scaled by `speed`), so the look is
   refresh-rate independent.
5. Composite: coverage from the a channels (line + capped wash x `wetWashGain`, contrast
   S-curve). Ink colour = exp(-K), K = per-layer mean absorbance rgb / a, layers weighted by
   coverage, so overlapping inks mix subtractively. Result = mix(paper, ink colour, coverage) +
   paper texture + grain.

Shared with Smoke (`effects/shared/`): Attractors, PingPongState (ParticleSim maps SimInputs
onto the uniforms and runs it), FullscreenPass, noise/curl/hash GLSL, fullscreen triangle and
the blur header. These were moved, not changed: the Ink shaders are textually identical and
a 10 s fake-clock still matches the pre-M7 build (mean abs diff 0.004 / 255, the same as two
runs of the old build). M8 routes Ink's density through `shared/subpixel.ts` (Size < 0.5 px only); at the
default Size the 10 s fake-clock still matches M7 (mean abs diff 0.004 / 255).

Per-source colours: `inkColor1..3` (defaults #000000, #0091FF, #FF0000); the panel shows colour
2 and 3 only when Sources (`emitters`) >= 2 / 3.

### Wetness

`wetness` (0..1, default 0.35) interpolates linearly between the dry and wet columns:

| Quantity | Dry (0) | Wet (1) | Where |
|----------|---------|---------|-------|
| velocity relaxation (drag) | x 2.6 | x 0.8 | sim: splat dies within ~0.1 s when dry, carries further when wet |
| curl influence | x 0.15 | x 0.7 | sim: dry ink stays put, wet ink drifts and swirls |
| bleed reach | x 1 | x 3 | sim: short bleed vs bloom |
| bleed rate (1/s) | 2.2 | 0.7 | sim: wet bleed is slower and keeps going |
| lifespan | x 1 | x 1.6 | sim: wet ink lingers in motion |
| ink per particle | x 1 | x 0.7 | draw: watercolour is more translucent |
| line blur | x 1.3 | x 2.6 | trails: crisp feathered edge vs soft pigment |
| wash blur | x 0.3 | x 1.2 | trails: little halo vs wide soft bloom |
| wash gain | x 0.5 | x 0.65 | composite |
| wash drift | x 0.15 | x 1 | trails |
| wash memory ratio | 0.6 | 0.25 | trails: washFade = 1 - (1 - trailFade) * ratio (lower = longer) |

### Speed

`speed` (0.1..2, default 1) scales the simulation clock: sim dt (motion, bleed, splat decay,
ageing, seep probability, curl field evolution, idle drips) and the source wander. It does not
scale trail fade, blur and drift, or the render-time audio response, which stay real-time so
the ink stays responsive to music at any speed.

### Audio mapping

Bands arrive already multiplied by their sensitivity slider (0 = off, 1 = nominal, 3 = up to
3x; the engine clamps the normalised band to 0..1 before applying sensitivity). `bs` is
`beatStrength` (0.25..1 on the beat frame, decays with tau 250 ms).

| Input | Drives | Mapping |
|-------|--------|---------|
| beat (one frame) | drop | `burstSize * max(bs, 0.25) * 0.15` of all particles respawn as a splat + satellites at every source (above) |
| bs | kick (render only) | positions drawn expanded about the nearest source by `bs * 0.25 * (0.5 + burstSize)`, fading out by d = 0.8 |
| bs | shiver (render only) | curl displacement `bs * 0.005 * (0.5 + burstSize)` at 3.5x the curl frequency, field evolving at 7x real time: all ink, including ink that has bled and stopped, wobbles in place |
| bs | wash swell | wash gain x `(1 + 1.2 bs)`, wash blur x `(1 + 0.8 bs)` (`trailFade` untouched) |
| bass | breathing (render only) | radial scale about the nearest source `1 + 0.015 bass`, fading out by d = 1.2 |
| bass | seep, wander | seep rate x `(1 + 2 bass)`, wander speed x `(1 + bass)` |
| mid | turbulence | curl velocity x `(1 + 1.5 mid)` |
| high | noise scale, ink | `turbulenceScale` x `(1 + high)`, ink per particle x `(1 + 0.5 high)` |

The panel's level meter has a beat blip (accent dot, 200 ms fade, brightness from the beat
strength) and the `engine.bpm` estimate, from the engine's `beat` event, for tuning Beat thresh.

## Smoke effect

Metaphor: smoke rings blown from 1-3 slowly wandering sources (the ink Attractors, shifted
down: y x 0.7 - 0.32). Every particle belongs to a vortex ring: a beat puff, or one of the
small rings the steady stream is made of. No drops, bleed or wetness. Tuning in `TUNE`
(SmokeEffect.ts) and `SMOKE_LOOK` (SmokeTrails.ts). State: shared PingPongState, 4 attachments:
A pos.xy vel.xy; B age, life (< 0 dormant), seed, source (+ 4 = puff); C ring origin.xy,
theta (angle around the ring), ring seed; D phi0 (tube angle at birth), rho (distance from the
tube core in tube radii), R0, v0.

1. Ring model (`shaders/sim.glsl.ts`), analytic in the particle's age t, so a ring travels as
   one object. A torus in 3D seen from the front: axis tilted sideways by alpha (per ring, hashed
   from its seed: +-25 deg puff, +-10 deg stream) and toward the viewer by beta (50-70 deg), so
   it reads as a fat oval moving up and slightly toward us.

   | Quantity | Formula | Constants |
   |----------|---------|-----------|
   | slowing | slow = 1 - exp(-t / tau), speed v0 exp(-t / tau) | tau = 0.9 / (0.25 + Drag): 1.2 s at Drag 0.5 |
   | centre | origin + axis v0 tau slow + up riseV (t - tau slow) | riseV = Rise x 0.6 / (0.25 + Drag) |
   | ring radius | R0 (1 + 1.5 slow) (1 + wobble) | R0 puff 0.075..0.1 by beat strength, stream 0.045 (x 0.85-1.15) |
   | tube radius | R0 lerp(0.45, 1.2, slow) | gaussian cross-section, rho ~ Rayleigh(sigma 0.55), clamped at 2.2 sigma |
   | roll | phi = phi0 + omega tau slow, omega = 0.8 v0 / R0 / (1 + 2 rho^2) x (0.9..1.1 per particle) | outside of the tube forward, inside back; the core turns fastest |
   | position | centre + (R + rho r cos phi) radial(theta) + rho r sin phi axis, projected to xy | |
   | wobble | 0.06 (0.7 sin(2 pi t / P1 + a) cos 2 theta + 0.3 sin(2 pi t / P2 + b) cos theta), P 2-4 s | slow, smooth outline; no high-frequency terms |
   | launch | puff v0 = 1.1 (0.5 + strength), stream v0 = 0.3 (x 0.8-1.2) | |

   On top of the ring each particle carries a free displacement D = pos - ringPos(age), advanced
   by curl noise (frequency Swirl x 1.2, velocity Turbulence x 0.12 x (1 + 1.5 mid); the field
   rises with the smoke). Influence = smoothstep(0, 1.2 s, t) x lerp(0.25, 1, dissolve),
   dissolve = smoothstep(0.45 Tr, Tr, t), ring life Tr 3.2 s (puff) / 1.8 s (stream); the two
   finer octaves only come in with dissolve, and dissolved smoke spreads sideways (Rise x 0.5
   1/s): the ring holds together, slows, widens and thickens, then breaks into haze.
2. Stream: each source emits a small ring every 0.4-0.8 s / (0.5 + Emission) (CPU cadence);
   dormant particles wake into it with probability Emission x 0.15 x (1 + 2 bass) x interval /
   sources, so the supply still scales with Emission. A chain of soft rings merges into a column.
3. Beat = puff: `burstSize * max(bs, 0.25) * 0.15 / sources` of all particles respawn per source
   on a ring at that source (life x 0.6). Many particles per ring (about 12k per source at
   250k, Burst 1, bs 0.8) keep the tube smooth.
4. Splat (`shaders/points.glsl.ts`): gl.POINTS of size 1 (not ink's 1 px line segments: a 1 px
   segment rasterises or not depending on its sub-pixel position and direction, which varied
   smoothly around a ring and serrated its edge), each dithered by a fresh +-1 texel
   (triangular) offset every step so consecutive steps carry independent shot noise, additive
   into an MRT density target: line deposit and wash deposit. rgb = ink x the source's colour vector (absorbance on light paper,
   the colour itself in dark mode), a = ink. Ink per particle = Density x 4 x size gain x tube
   weight 2 exp(-rho^2 / 2 sigma^2) (dense tube core, soft edge) x cooling (1 - age/life)^1.6,
   x 8 overall; puffs x 0.55 and at once, stream x 0.4 fading in over 0.6 s. The wash deposit is
   x 0.5 while the ring is intact (1 once dissolved), so a travelling ring leaves little wake.
   Shiver and breath as ink (render only); the kick is 0.04 (ink 0.25): the puff ring is the beat,
   and a large render-time kick smeared rings into radial streaks.
5. Trails (`SmokeTrails`): line layer fade 0.75/step, blur hypot(lerp(0.5, 3, Softness),
   0.6 x max(0, Size - 1)) CSS px; wash fade 0.975/step, blur `lerp(0.6, 3.5, haze)`, drifting up
   0.35 CSS px/step with a slow sway. Both deposits go through the sub-pixel pre-filter (below).
   Beat swell on the wash as ink. A change of the resolved mode clears the trails.
6. Composite: Light = ink's subtractive composite (wash gain `lerp(0.1, 0.8, haze)`, cap 0.55,
   contrast S-curve, paper texture). Dark = additive light: per channel E = line.rgb + wash.rgb x
   washGain, light = contrast(1 - exp(-E)), result = background + (1 - background) x light.
   Grain as ink in both.

Mode (`toggle`, Auto | Light | Dark, default Auto): Auto renders Light when the background's
luminance (Rec. 709 weights on the hex values) is > 0.5, Dark otherwise, re-resolved whenever
Background changes. Explicit Light / Dark set the background to that mode's default (#F7F7F5 /
#24231E). In every case each smoke colour still at the other resolved mode's default is swapped
to this one's (light: #00BBFF #EC008C #FFF200; dark: #E8E8E8 #9FB8D0 #D0A090); custom colours
stay; in Auto the background is never changed by the link. Presets apply values without it.

Swirl (`turbulenceScale`) range 0.2..2.67 (the old 0..10 scale's 6.5 is the new 10; the real
default 0.58 now shows 1.5). Ink keeps 0.2..4.

### Size and sub-pixel particles (both effects)

Size (`pointSize`, 0.25..4 px, 0..10 display) in both effects. Particles are always rasterised
at 1 px. Smoke: ink per particle x size below 1 px (a 1 px point carrying less), x size^0.6
above, where the line blur widens instead (default 0.25 = display 0). Ink keeps its line
deposit x size^0.6 and line blur x size (min lowered from 0.5 to 0.25; its default 0.5 now
shows 0.7).

Below 0.5 px (`shared/subpixel.ts`, `DensityTargets`) particles splat into a low-resolution
density target, 300 CSS px tall (at most half the drawing buffer: 1/2 res for a 600 px view,
1/3 for 900 px; the particle count does not grow with the screen, so the filter is
screen-relative), ink per texel x the texel area so total ink is conserved, and the trail pass
reads it through a pre-filter that also upsamples: 4 x 4 bilinear taps `spread` low-res texels
apart, weights (1 3 3 1) per axis, i.e. the binomial 5 x 5 kernel at spread 1. Spread ramps
from 0 (plain bilinear upsample) at Size 0.5 to 1 at 0.25, so at the minimum a lone particle
is a soft smudge and only accumulated density reads. (M8 used a fixed half-res target: at
1440 x 900 the shot noise of a travelling ring still showed as a fine serration.) At 0.5 and
above (Ink's default) the full-res target is used and read with the old exact texelFetch; the
half-res taps only run while the half target was written since the last trail update. Going
from 0.5 to 0.49 is a small step (full res to bilinear low res), not a ramp.

Audio: bass -> stream supply x (1 + 2 bass) and wander x (1 + bass); mid -> turbulence x (1 + 1.5 mid);
high -> curl frequency x (1 + high), ink x (1 + 0.5 high); beat -> puff ring, kick, shiver, wash swell.

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

Panel and transport are plain functions returning `{ el, dispose }`. The header reads
"Visualizer" followed by the effect selector (a small mono segmented control: INK | SMOKE,
arrow keys move) and the version. Section order: Presets, Input, the effect's sections
(Ink: Particles, Trails, Look; Smoke: Plume, Look), Audio response, Output. Layout lives only in
CSS (`.shell` grid: 320px panel, canvas fills the rest), so the panel can become a bottom
sheet under 768px without code changes. The accent colour is reserved for the active tab,
seek fill, level meter and focus ring.

## Presets

`PresetBank` (presets/store.ts). Each effect has a built-in "Default" generated from its
schema (`builtin:default:<effect>`, env-aware). User presets live in localStorage under
`visualizer.presets.v1` as `{ schema: 1, presets: Preset[] }`, each preset
`{ version, id, name, effect, params, createdAt }` with `params` as REAL values keyed by param
id: the app params plus that effect's params. The shape did not change in M7, so the schema
stays 1; a stored or imported preset without `effect` is an Ink preset (all M6 presets were),
and stored presets of unknown effects are kept but not shown. Loading resolves a preset over the defaults: unknown ids are ignored, missing or
invalid values come from the defaults, and the store clamps and snaps. Save overwrites a
user preset of the same name; "Default" is reserved. Storage failures fall back to memory.

Panel: select (Default + the active effect's user presets; the selection is remembered per
effect for the session), Reset (reload the selected preset), Save (inline
name field), Delete (user presets only, inline confirm), Export (the selected preset as
`preset-<name>.json`, `{ format: 'visualizer/presets', schema: 1, presets: [...] }`) and
Import (validates the format and values, adds every valid preset with a de-duplicated name,
then selects and loads the first, switching effect when it belongs to another one). Names are
unique per effect. The page always starts on Ink with Default.

## Output

Screenshot: the next rendered frame is read with `canvas.toBlob` in the same task as the
draw (no preserveDrawingBuffer), at the drawing-buffer size (CSS size x dpr, dpr capped at
2), composited on the paper colour; saved as `<effect>-YYYYMMDD-HHMMSS.png` (local time).
Fullscreen targets the stage container: the panel is outside it and hides, the transport
pill is inside it and stays; the ResizeObserver reallocates the trail targets (cleared).

## Milestones

M0/M1 architecture, scaffold, panel shell. M2 GPU ink effect, mic/link/capture.
M3-M5b ink effect, trails, audio response. M6 0..10 panel scale, presets (localStorage +
JSON file), output checks, "Visualizer" title. M7 effect selector, per-effect params and presets,
shared effect infrastructure, Smoke effect (light paper / dark). M8 smoke rings (analytic
vortex-ring model), Swirl cap, Mode Auto | Light | Dark, Size + sub-pixel pre-filter. Next: performance tiers,
mobile sheet.
