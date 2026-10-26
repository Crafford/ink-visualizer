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
    shared/               generic GPU utilities only: PingPongState (float MRT ping-pong state +
                          one fullscreen pass), FullscreenPass, shaders/ (simplex noise with
                          gradient, curl2, pcg3d hash; fullscreen triangle)
    ink/                  ink effect: params.ts (INK_PARAMS, sections), InkEffect (TUNE, audio
                          mapping), Attractors (wandering sources, MAX_ATTRACTORS), ParticleSim,
                          InkTrails (density/trail/composite), shaders/ (sim, points, trail, blur)
    smoke/                smoke effect: params.ts (SMOKE_PARAMS, sections), SmokeEffect (TUNE,
                          strand emission, audio mapping, strand draw), SmokeLight (light buffer,
                          colour-ramp composite), shaders/ (sim, draw, image)
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
            -> effect entry linked(id) if the effect has one (none does at present; not during preset load)
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

**Each effect has its own machinery.** An effect's simulation, particle state layout, shaders
and rendering live in its own folder and an effect never imports from another effect's folder.
The only shared layer is the effect contract, the audio frame, the param / panel / preset
system and genuinely generic utilities in `effects/shared/` (PingPongState, FullscreenPass,
noise / hash GLSL, the fullscreen triangle). Anything shaped by one effect's model (Ink's
wandering Attractors, its line/wash trail and blur) lives in that effect's folder. (M9 moved
Attractors and the blur header into `ink/`, deleted the sub-pixel density layer and rebuilt
Smoke from scratch on this rule.)

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

`APP_PARAMS` (params.ts: bassSens, midSens, highSens, smoothRise, smoothFall, burstSize; panel
labels Bass, Mid, High, Attack, Release, Surge, renamed in M9 with the ids kept so presets
survive) and
each effect's `INK_PARAMS` / `SMOKE_PARAMS` are `const` arrays built with the `num(...)`,
`color(...)` and `toggle(...)` helpers, so ids stay literal types; `ValuesOf<typeof X>` gives
the value bag. Adding a parameter is one line in the effect's list; the panel control, store
validation, reset, presets and `ctx.params.<id>` follow automatically. Values are kept per
effect; Smoke's ids are all prefixed `smoke` so they never collide with Ink's.

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
| linear (default) | `min + (max - min) t` | all norm10 params except Persistence and Swirl |
| log, pole p | `p + sign * exp(lerp(log abs(min - p), log abs(max - p), t^exponent))` | Persistence (`trailFade`, pole 1), Smoke Swirl (`smokeSwirl`, pole 0: a frequency, so each 0.1 scales the curl size by the same factor) |
| pow | `min + (max - min) t^exponent` | none yet |

Persistence: the trail length goes as 1 / (1 - fade) (6.7 steps at 0.85, 100 at 0.99), so
log(1 - fade) is linear in the display: each 0.1 multiplies the trail length by the same
factor (1.028). The default 0.92 sits at 2.3.

Real units stay for Count / Detail (k), Lifespan (s), Speed (x), Sources and the colours.

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
   - Sources (`ink/Attractors.ts`, CPU) wander at phase rate 0.4 x `speed` x (1 + bass): a full
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

Ink uses the generic `effects/shared/` utilities (PingPongState: ParticleSim maps SimInputs
onto the uniforms and runs it; FullscreenPass; noise/curl/hash GLSL; fullscreen triangle). Its
Attractors and blur header live in `ink/`. M9 removed the M8 sub-pixel density layer: Ink is
back to the M7 density/trail code (full-resolution density, exact texelFetch). Size keeps its
0.25..4 range and default 0.5 (display 0.7); below 0.5 particles are drawn exactly as at 0.5
and above (1 device px segments) with the line blur x Size and line deposit x Size^0.6, so a
smaller Size is just thinner, lighter strokes. The Ink shaders are textually identical to M7
and the default 10 s fake-clock still matches the M8 build (see Milestones for the number).

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

Metaphor: cigarette smoke in still air, backlit on black. A thin glassy thread rises from an
almost invisible source, widens into smooth translucent sheets, and the sheets fold into a few
big curls near the top and dissolve. Built from scratch in M9 with its own machinery
(nothing from `ink/`): its own particle state layout and simulation, a strand renderer, its own
light buffer and composite. Tuning lives in `TUNE` (SmokeEffect.ts, `stage.effect.tune` with
?debug) and `SMOKE_LOOK` (SmokeLight.ts).

### Strands (why it is smooth without blur)

Particles are organised as **strands** (streaklines). Particle i is slot `i % M` of strand
`i / M` (M = `strandLen` = 128; strands = round(Detail / 128), 2344 at 300k). Every strand has a
fixed spawn point on the source and emits its slots in order, one every `lifespan / M` s, so
slot k + 1 is always the particle born just after slot k at the same place. The draw pass
connects consecutive slots, so each strand is a continuous line from the source however far the
flow stretches it: no dots, no shot noise, no feedback trail and no image blur. A slot is
reborn after exactly one lifespan.

- Emission phase (CPU): advances `M dt / lifespan` slots per step; the slots born in a step
  are picked in integers (`uFirst`, `uNum`) so none is ever skipped (a float phase skipped
  slots and left a notch across the column).
- A slot born part-way through a step is integrated over the rest of the step with the same
  physics, so consecutive slots stay evenly spaced (a plain sub-step offset left 20 % spacing
  jitter, i.e. light bands across all strands).
- Spawn: strands sit on a ring (radius fraction 0.75..1 of `source.width`, angle and radius from
  independent hash channels) in x and z, so the column is a tube wall: projected, it is
  brightest along its edges where the sheet is seen edge-on, which gives the sheets clean edges.

### State (PingPongState, three RGBA32F attachments, `shaders/sim.glsl.ts`)

- A: pos.xyz (view units: y -1..1, x -aspect..aspect, z depth), age (s)
- B: buoyant velocity u.xyz, born flag
- C: unused, boost (surge share at birth), unused (strand seed), birth intensity

Particles are 3D and projected orthographically (z dropped).

### Motion (laminar to turbulent column)

Per step: `p += (u + couple * air + spread) dt`.

| Term | Formula | Constants (TUNE) |
|------|---------|------------------|
| buoyancy (own velocity u) | `du.y = (buoy (1 + lift smoothstep(0, 1, h)) (1 - cool smoothstep(0.5, 1, age / life)) - drag u.y) dt` | buoy = Rise x 1.0, lift 0.35, cool 0.85; launch v0 0.1 |
| drag | `drag = lerp(0.25, 3.25, Resistance)` 1/s; terminal rise = buoy / drag | default 1.75 /s, rise 0.23 view units/s |
| coupling | `couple = drag / (drag + 0.6)`: low Resistance shoots up and stretches, high follows every curl and hangs | 0.74 at default |
| curl turbulence | 3D curl of three simplex potentials (two octaves, second at 2.07x, weight 0.15), x influence `smoothstep(0.04 onset, onset, h)^2` | amplitude `lerp(0.01, 0.3, Turbulence)`, onset `lerp(1.6, 0.35, Turbulence)` view units |
| curl field | frequency = Swirl (1 / view units); depth frequency x `zScale` 0.3 (chain rule keeps it divergence free) so strands at different depths fold together as a sheet; the field rises at 0.7 x terminal speed and evolves along z at 0.1 /s, so structures rise with the smoke | |
| breeze | `x += Breeze x 0.25 x wind(t) x smoothstep(-0.05, 1.2, h) x (1 + 0.3 sin(2.3 h - 0.31 t))`, `wind = 0.25 + 0.6 sin(0.043 t + 0.7) + 0.4 sin(0.11 t + 2.1)` (slow, mostly one-sided) + beat gust | |
| spread | each strand drifts outward along its spawn direction: `0.06 x radius fraction x smoothstep(0.15, 1.0, h)`; the column widens with height | |

h = height above the source. The curl is ~0 at the source (straight glassy thread) and grows
with height (waving, folding sheets, curls); Turbulence moves the breakup lower and makes it
stronger, Swirl sets the curl size (low = big smooth folds like the 01 reference, high = fine
wisps like 02).

Source: `TUNE.source = { kind: 'point', width: 0.004, x: 0, y: -0.84 }` (8 % from the bottom).
Only 'point' exists; `width` is the real spawn radius, so a wide source (smoke machine, fire)
is a new `kind` / setting, not a rebuild.

### Drawing (`shaders/draw.glsl.ts`, `SmokeLight.ts`)

Once per display frame (not per step) into a float light buffer (RGBA32F when
EXT_float_blend, else 16F) cleared each frame, additive:

- Each particle draws the piece of its strand to the next slot as up to 3 Catmull-Rom
  sub-segments through slots k-1..k+2 (straight when the piece is under 4 px), skipped at the
  strand head (the slot after the newest is the oldest). Six vertices per sub-segment, no
  attributes (`gl_VertexID`).
- Each sub-segment is a quad: the segment widened to `max(Size x dpr, 1)` + 1 px and extended
  1 px at both ends; the fragment box-filters it (coverage across `clamp(W/2 + 0.5 - |d|)`,
  along the same at both ends), so pieces join seamlessly and edges do not serrate.
- Light per pixel = `energy x gain x fade / (max(pieceLen, 1) x W x (1 + (pieceLen / stretch)^2))`:
  a piece carries fixed light spread along its length (stretched smoke thins), and a piece
  longer than `stretch` (0.04 view units) has torn and fades out (no straight lines across
  gaps when fast smoke overtakes slow smoke).
- `energy = Brightness x 0.5 x (300k / count) x (bufferHeight / 900)^2 x sqrt(Size)`: Detail
  changes smoothness, not brightness; the look holds at any resolution and dpr; thin
  filaments are a little dimmer, thick ones spread their light.
- `gain` = birth intensity = `Amount x 2 x (1 + 0.4 bass) x (1 + 4 surge)`.
- `fade` = `smoothstep(0, 0.25 x mix(1, 0.5, boost), h)^2 x (1 - smoothstep(0.6, 1, age / life))`:
  the smoke appears from nothing over the first ~12 % of the view, a surge shows sooner; the
  top dissolves over the last 40 % of life. Interpolated along each piece (no steps).

Composite (`shaders/image.glsl.ts`): `a = 1 - exp(-0.8 log2(1 + light))` (log-compressed, so
the thread, which carries every strand in a few pixels, and the sheets above both read), colour
ramp `mix(#7F93A6, #F2F4F5, smoothstep(0.12, 0.9, a))` (thin = cool blue-grey, dense = near
white), `result = #0A0A0B + (ramp - background) x a`, +-1 LSB triangular dither against banding.
Background and ramp are fixed (not in the panel).

### Params (section `smoke` "Smoke", section `smokeLook` "Look")

| Param | id | Real range | Default real | Default shown | Display |
|-------|----|-----------|--------------|---------------|---------|
| Amount | smokeAmount | 0..1 | 0.5 | 5.0 | n10 linear (light per particle = smoke given off) |
| Rise | smokeRise | 0..1 | 0.4 | 4.0 | n10 linear (buoyancy) |
| Lifespan | smokeLifespan | 2..15 s | 9 s | 9.0s | real seconds |
| Resistance | smokeResistance | 0..1 | 0.5 | 5.0 | n10 linear (drag) |
| Turbulence | smokeTurbulence | 0..1 | 0.3 | 3.0 | n10 linear |
| Swirl | smokeSwirl | 0.6..9 | 1.6 | 3.6 | n10 log (curl frequency) |
| Breeze | smokeBreeze | 0..1 | 0.2 | 2.0 | n10 linear |
| Brightness | smokeBrightness | 0..2 | 1 | 5.0 | n10 linear |
| Size | smokeSize | 0.25..4 px | 1 px | 2.0 | n10 linear (filament width) |
| Detail | smokeDetail | 50k..600k | 300k (mobile 100k) | 300k | real, rounded to whole strands |

Turbulence 3 / Swirl 3.6 is the 01 look; Turbulence 7 / Swirl 7 (real 0.7 / 4.0) approaches 02.
Detail reallocates the state and restarts the smoke (clock, emission phase, field).

### Audio mapping

| Input | Drives | Mapping |
|-------|--------|---------|
| beat (Surge = `burstSize`) | surge packet | envelope target = max(target, bs), decays tau 0.35 s; envelope follows with attack 0.25 s (a smooth ~0.5 s bump: the smoke near the source is slow, so a faster attack becomes a hard edge in the column). surge = envelope x Surge. Birth intensity x (1 + 4 surge), launch speed x (1 + 1.5 surge), source width x (1 + 2 surge), fade-in height x mix(1, 0.5, surge): a denser, brighter packet forms at the base and travels up. No rings, nothing radial. |
| beat, bs >= 0.6 | sideways breath | gust += alternating sign x 0.12 x bs x Surge (view units/s), decays tau 1.5 s, added to the breeze |
| bass | base breathing | birth intensity x (1 + 0.4 bass); boost (shorter fade-in) + 0.3 bass |
| mid | turbulence | curl amplitude x (1 + 0.6 mid), breakup height / (1 + 0.4 mid) |
| high | upper wisps | a third curl octave (3.3x frequency, the finest the strands resolve) at 0.03 x high x influence^2 |

Bands arrive multiplied by their sensitivity (display 5.0 = 3x), so at the default audio
settings the response is clearly visible (2 Hz beats: a livelier, lower breakup and packets
rising up the column).

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
(Ink: Particles, Trails, Look; Smoke: Smoke, Look), Audio response, Output. Layout lives only in
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
vortex-ring model), Swirl cap, Mode Auto | Light | Dark, Size + sub-pixel pre-filter. M9 Smoke rebuilt
from scratch with its own machinery (streakline strands, laminar-to-turbulent buoyant column,
additive light, surge packets), sub-pixel layer removed, per-effect machinery rule, audio labels
Attack / Release / Surge; Ink default 10 s still vs the M8 build: mean abs diff 0.005 / 255 (two M8 runs: 0.004).
Next: performance tiers, mobile sheet.
