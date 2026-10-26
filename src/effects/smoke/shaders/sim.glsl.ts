import { NOISE_GLSL } from '../../shared/shaders/noise.glsl';

/**
 * Smoke simulation pass: one texel per particle, three RGBA float attachments.
 *
 *   A: pos.xyz (view units: y -1..1, x -aspect..aspect, z depth), age (s)
 *   B: buoyant velocity u.xyz, born flag (> 0 once born)
 *   C: unused, boost (surge share at birth, shortens the fade-in), strand seed, birth intensity
 *
 * Particles are organised in strands (streaklines): particle i is slot i % M of strand i / M.
 * Every strand has a fixed spawn point in the source disc and emits its slots in order, one
 * every lifespan / M seconds (the CPU advances a shared emission phase), so slot k + 1 is always
 * the particle born just after slot k at the same place. The draw pass connects them, so each
 * strand is a continuous line from the source however far the flow stretches it. A slot is
 * reborn when the phase comes round again, i.e. after exactly one lifespan.
 *
 * Particles are 3D and projected orthographically (drop z), so a sheet of strands folded by
 * the 3D curl field is brightest where it is seen edge-on, like backlit smoke.
 *
 * Motion = own buoyant velocity u (integrated: buoyancy - drag u) + coupling x air velocity
 * (advected directly, no inertia, so the flow stays divergence free and sheets stay sheets).
 * Air = curl noise x influence(height) + breeze + spread.
 */
export const SMOKE_SIM_FRAG = /* glsl */ `
precision highp float;
precision highp int;
precision highp sampler2D;

uniform sampler2D uStateA;
uniform sampler2D uStateB;
uniform sampler2D uStateC;
uniform uint  uFrame;
uniform bool  uInit;
uniform float uDt;
uniform float uTime;
uniform int   uSize;         // state texture side
uniform int   uStrandLen;    // M, slots per strand

uniform vec3  uSource;       // source centre (view units)
uniform float uSourceWidth;  // spawn radius (x and z)
uniform int   uFirst;        // first slot born this step
uniform int   uNum;          // slots born this step (consecutive, wrapping)
uniform float uOffset;       // phase distance (slots) from the step start to uFirst, (0, 1]
uniform float uDPhase;       // slots emitted per step (phase advance)
uniform float uV0;           // upward launch speed
uniform float uBirthGain;    // intensity carried by particles born this step
uniform float uBoost;        // 0..1: share of surge (+ bass) at birth; such smoke shows from the source

uniform float uBuoy;         // buoyant acceleration
uniform float uLift;         // extra buoyancy share at height 1 (accelerates slightly as it rises)
uniform float uCool;         // buoyancy lost by the end of life
uniform float uLifespan;
uniform float uDrag;         // 1/s
uniform float uCouple;       // how closely the smoke follows the air (0..1)

uniform float uTurb;         // curl velocity amplitude
uniform float uOctave2;      // second octave weight
uniform float uFreq;         // curl frequency (1 / view units)
uniform float uOnset;        // height where the curl influence reaches 1
uniform vec3  uField;        // field offset (rises with the smoke) + evolution along z
uniform float uHigh;         // fine octave amplitude (high band)
uniform float uBreeze;       // sideways air speed at height ~1
uniform float uSpread;       // outward spread speed at height ~1
uniform float uSpreadH;      // height over which the spread comes in

layout(location = 0) out vec4 outA;
layout(location = 1) out vec4 outB;
layout(location = 2) out vec4 outC;

${NOISE_GLSL}

// Curl of a 3D vector potential built from three decorrelated simplex fields, sampled at
// (q.x, q.y, uZScale q.z): the field varies slowly in depth, so strands at different depths move
// together and the smoke folds as a sheet instead of shredding. d/dz carries uZScale (chain
// rule), so the flow stays divergence free.
uniform float uZScale;
vec3 curl3(vec3 q) {
  q.z *= uZScale;
  vec3 ga, gb, gc;
  snoiseGrad(q, ga);
  snoiseGrad(q + vec3(31.416, -47.853, 12.793), gb);
  snoiseGrad(q + vec3(-23.37, 11.31, 71.97), gc);
  ga.z *= uZScale; gb.z *= uZScale; gc.z *= uZScale;
  return vec3(gc.y - gb.z, ga.z - gc.x, gb.x - ga.y);
}

// Strand constants from independent hash channels: spawn angle and radius fraction. The radius
// fraction lies in uRing..1, so the strands form a tube wall (a plume's sheet): projected, it is
// brightest along its edges where it is seen edge-on, which gives the sheets clean edges.
// (One random number for both would put the strands on a curve, not a ring.)
uniform float uRing;
vec2 strandShape(int strand) {
  vec3 h = vec3(pcg3d(uvec3(uint(strand), 4099u, 7919u))) * (1.0 / 4294967296.0);
  return vec2(h.x * 6.2831853, mix(uRing, 1.0, h.y));
}

// One integration step of length dt for a particle with strand shape sh.
void advance(inout vec3 p, inout vec3 u, inout float age, vec2 sh, float dt) {
  float h = max(p.y - uSource.y, 0.0);
  float t = age / uLifespan;

  // Own (buoyant) velocity: rises, accelerates a little with height, cools late in life.
  float buoy = uBuoy * (1.0 + uLift * smoothstep(0.0, 1.0, h)) * (1.0 - uCool * smoothstep(0.5, 1.0, t));
  u.y += (buoy - uDrag * u.y) * dt;
  u.xz -= uDrag * u.xz * dt;

  // Air: laminar near the source, curl turbulence growing with height.
  float infl = smoothstep(0.04 * uOnset, uOnset, h);
  infl *= infl;
  vec3 air = vec3(0.0);
  if (infl > 0.0) {
    vec3 q = (p - vec3(0.0, uField.y, 0.0)) * uFreq + vec3(0.0, 0.0, uField.z);
    air = (curl3(q) + uOctave2 * curl3(q * 2.07 + vec3(17.3, 5.1, -9.7))) * (uTurb * infl);
    if (uHigh > 0.0) air += curl3(q * 3.3 + vec3(-41.0, 23.0, 7.0)) * (uHigh * infl * infl);
  }
  // Breeze: grows with height, a slow sway along the column.
  air.x += uBreeze * smoothstep(-0.05, 1.2, h) * (1.0 + 0.3 * sin(2.3 * h - 0.31 * uTime));
  // Spread: each strand drifts outward along its spawn direction (the column widens).
  vec3 spread = vec3(cos(sh.x), 0.0, sin(sh.x)) * (sh.y * uSpread * smoothstep(0.15 * uSpreadH, uSpreadH, h));

  p += (u + uCouple * air + spread) * dt;
  age += dt;
}

void main() {
  ivec2 px = ivec2(gl_FragCoord.xy);
  int i = px.y * uSize + px.x;
  int slot = i % uStrandLen;
  int strand = i / uStrandLen;
  float seed = float(pcg3d(uvec3(uint(strand), 911u, 3571u)).x) * (1.0 / 4294967296.0);

  if (uInit) {
    outA = vec4(uSource, 0.0);
    outB = vec4(0.0);
    outC = vec4(0.0, 0.0, seed, 0.0);
    return;
  }

  vec4 A = texelFetch(uStateA, px, 0);
  vec4 B = texelFetch(uStateB, px, 0);
  vec4 C = texelFetch(uStateC, px, 0);
  vec2 sh = strandShape(strand);

  // Birth: this slot's turn came round during the step (the CPU picks the slots in integers,
  // so none is ever skipped); d = phase distance from the step start.
  int j = (slot - uFirst + uStrandLen) % uStrandLen;
  if (j < uNum) {
    float d = uOffset + float(j);
    float rad = uSourceWidth * sh.y;
    vec3 p = uSource + vec3(cos(sh.x) * rad, 0.0, sin(sh.x) * rad);
    vec3 u = vec3(0.0, uV0, 0.0);
    float age = 0.0;
    // Born part-way through the step: integrate the rest of it with the same physics, so
    // consecutive slots stay evenly spaced along the strand (an even strand has even light).
    advance(p, u, age, sh, clamp(1.0 - d / max(uDPhase, 1e-6), 0.0, 1.0) * uDt);
    outA = vec4(p, age);
    outB = vec4(u, 1.0);
    outC = vec4(0.0, uBoost, seed, uBirthGain);
    return;
  }
  if (B.w <= 0.0) { outA = A; outB = B; outC = C; return; }

  vec3 p = A.xyz;
  vec3 u = B.xyz;
  float age = A.w;
  advance(p, u, age, sh, uDt);
  outA = vec4(p, age);
  outB = vec4(u, B.w);
  outC = C;
}
`;
