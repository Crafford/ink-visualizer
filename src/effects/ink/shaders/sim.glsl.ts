import { NOISE_GLSL } from './noise.glsl';

/** Max attractors; the uniform arrays are fixed-size, uAttractorCount picks how many are live. */
export const MAX_ATTRACTORS = 3;

/**
 * Fullscreen triangle from gl_VertexID: no vertex buffer at all.
 * Shared by every full-target pass (simulation, later the trail/composite passes).
 */
export const FULLSCREEN_VERT = /* glsl */ `
precision highp float;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}
`;

/**
 * One simulation step. Each fragment is one particle.
 *
 *   in  uStateA: pos.xy, vel.xy          out location 0: same layout
 *   in  uStateB: age, life, seed, emitter out location 1: same layout
 *
 * Space is aspect-corrected: x in [-aspect, aspect], y in [-1, 1].
 * Forces: two octaves of curl noise + a soft spring toward the nearest attractor with a
 * tangential swirl, then drag and a speed clamp. Respawn at an attractor when the particle
 * is too old, randomly at the emission rate, on a beat burst, or when it leaves the view.
 */
export const SIM_FRAG = /* glsl */ `
precision highp float;
precision highp int;
precision highp sampler2D;

uniform sampler2D uStateA;
uniform sampler2D uStateB;

uniform float uDt;
uniform float uTime;
uniform uint  uFrame;
uniform float uAspect;
uniform bool  uInit;

uniform vec2  uAttractors[${MAX_ATTRACTORS}];
uniform int   uAttractorCount;

uniform float uNoiseScale;     // spatial frequency, view heights
uniform float uNoiseSpeed;     // how fast the field evolves
uniform float uTurbulence;     // curl acceleration
uniform float uPull;           // attractor spring
uniform float uSwirl;          // tangential force near attractors
uniform float uDamping;        // per-second velocity loss
uniform float uMaxSpeed;
uniform float uLifespan;       // seconds, mean
uniform float uRespawnChance;  // per-step probability of early respawn
uniform float uBurstChance;    // per-step probability from a beat burst
uniform float uCoreRadius;     // gaussian sigma of the spawn core
uniform float uCoreFraction;   // share of births that stay in the core (rest go to jets)
uniform int   uJets;           // jets per attractor
uniform float uJetSpeed;       // initial jet speed
uniform float uJetWidth;       // angular jitter of a jet, radians
uniform float uJetSpin;        // jet rotation, radians per second
uniform float uCalmRadius;     // curl noise fades in over this distance from an attractor
uniform float uBurstSpeed;     // radial launch speed of beat-burst births
uniform float uBurstCurl;      // tangential share of the burst launch (curls the ejected ink)
uniform float uBurstLife;      // lifespan multiplier of burst births
uniform int   uBurstRays;      // rays per attractor per beat (0 = isotropic spray)
uniform uint  uBeatSeed;       // changes every beat, so each beat shoots new rays
uniform float uBeatPush;       // outward acceleration on live particles (beat, decaying)
uniform float uBeatRadius;     // the push fades to 0 at this distance from the nearest attractor

layout(location = 0) out vec4 outA;
layout(location = 1) out vec4 outB;

${NOISE_GLSL}

vec2 gaussian2(vec2 u) {
  float r = sqrt(-2.0 * log(max(u.x, 1e-6)));
  float a = 6.28318530718 * u.y;
  return r * vec2(cos(a), sin(a));
}

// New particle at attractor 'e'. Returns position and velocity in a.
//
// A uniform radial spray only ever makes a fuzzy blob. Ink strands are streaklines: many
// particles released from (nearly) the same point into the same flow. So most births go
// into one of uJets narrow, slowly rotating jets per attractor (each jet becomes a strand
// that the curl field bends and curls), and the rest stay in the core to keep it dense.
void spawn(int e, vec3 r0, vec3 r1, bool burst, out vec4 a) {
  vec2 c = uAttractors[e];
  vec2 off = gaussian2(r0.xy) * uCoreRadius;
  bool jet = r1.z > uCoreFraction;
  vec2 v;
  if (jet) {
    int k = int(floor(r0.z * float(uJets)));
    // Irregular, fixed spacing per (emitter, jet), plus a slow spin that alternates per emitter.
    float base = float(pcg3d(uvec3(uint(e), uint(k), 77u)).x) * (6.28318530718 / 4294967296.0);
    float spin = uTime * uJetSpin * (e == 1 ? -1.0 : 1.0) * (1.0 + 0.3 * float(e));
    float ang = base + spin + (r1.x - 0.5) * uJetWidth;
    vec2 dir = vec2(cos(ang), sin(ang));
    v = dir * uJetSpeed * (0.6 + 0.8 * r1.y);
    off *= 0.5;
  } else {
    vec2 radial = normalize(off + 1e-5);
    v = vec2(-radial.y, radial.x) * 0.05 * r1.y;
  }
  if (burst) {
    // Beat: eject from the core. Mostly radial, jittered, plus a signed tangential share so
    // the ejected ink curls instead of forming a perfect starburst.
    // Rays: each beat picks a fresh set of directions per attractor, and every burst birth
    // rides one of them, so the ejected ink reads as strands shot out of the core rather
    // than an even (and invisible) spray.
    vec2 radial = normalize(off + 1e-5);
    if (uBurstRays > 0) {
      int k = int(floor(r0.z * float(uBurstRays)));
      float ang = float(pcg3d(uvec3(uint(e), uint(k), uBeatSeed)).x) * (6.28318530718 / 4294967296.0);
      ang += (r1.z - 0.5) * 0.12;
      radial = vec2(cos(ang), sin(ang));
    }
    vec2 tangent = vec2(-radial.y, radial.x);
    float s = uBurstSpeed * (0.3 + 0.9 * r1.x);
    v = radial * s + tangent * s * uBurstCurl * (r1.y * 2.0 - 1.0);
  }
  a = vec4(c + off, v);
}

void main() {
  ivec2 texel = ivec2(gl_FragCoord.xy);
  uvec2 utexel = uvec2(texel);
  vec3 r0 = rand3(utexel, uFrame * 2u);
  vec3 r1 = rand3(utexel, uFrame * 2u + 1u);

  if (uInit) {
    // Fresh state: seed, emitter and staggered ages so the population does not pulse.
    vec3 s = rand3(utexel, 0xA511E9B3u);
    int e = int(floor(s.y * float(uAttractorCount)));
    float life = uLifespan * (0.7 + 0.6 * s.z);
    vec4 a;
    spawn(e, r0, r1, false, a);
    a.xy += gaussian2(r1.xy) * 0.12; // a bit wider than the core so frame 1 is not a dot
    outA = a;
    outB = vec4(life * s.x, life, s.x, float(e));
    return;
  }

  vec4 A = texelFetch(uStateA, texel, 0);
  vec4 B = texelFetch(uStateB, texel, 0);
  vec2 p = A.xy;
  vec2 v = A.zw;
  float age = B.x + uDt;
  float life = B.y;

  // Curl noise: base octave + 3x octave at 0.35 for fine filaments.
  float t = uTime * uNoiseSpeed;
  vec2 q = p * uNoiseScale;
  vec2 f = curl2(vec3(q, t)) + 0.35 * curl2(vec3(q * 3.0, t * 1.7 + 19.1));
  vec2 acc = f * uTurbulence;

  // Nearest attractor: spring scaled by inverse distance (soft floor) = roughly constant
  // pull outside the core, linear inside it, so particles orbit and trail instead of collapsing.
  vec2 best = vec2(0.0);
  float bestD2 = 1e9;
  for (int i = 0; i < ${MAX_ATTRACTORS}; i++) {
    if (i >= uAttractorCount) break;
    vec2 d = uAttractors[i] - p;
    float d2 = dot(d, d);
    if (d2 < bestD2) { bestD2 = d2; best = d; }
  }
  float dist = sqrt(bestD2);
  // Calm water at the core: the curl field fades in over uCalmRadius, so jets leave the
  // core as distinct strands before the flow picks them up and curls them.
  acc *= smoothstep(0.0, uCalmRadius, dist);
  float soft = max(dist, 0.25);
  acc += best * (uPull / soft);
  // Swirl falls off with distance: curls near the core, free strands further out.
  vec2 tang = vec2(-best.y, best.x) / max(dist, 1e-4);
  acc += tang * uSwirl * exp(-dist * 3.0);
  // Beat shove: outward from the nearest core, strongest close in, gone by uBeatRadius.
  // uBeatPush follows beatStrength (decays over ~250 ms), so the shove lasts several steps.
  float fall = 1.0 - smoothstep(0.0, uBeatRadius, dist);
  acc -= (best / max(dist, 1e-3)) * uBeatPush * fall * fall;

  v += acc * uDt;
  v *= max(0.0, 1.0 - uDamping * uDt);
  float sp = length(v);
  if (sp > uMaxSpeed) v *= uMaxSpeed / sp;
  p += v * uDt;

  bool outside = abs(p.x) > uAspect * 1.25 || abs(p.y) > 1.25;
  bool burst = r1.x < uBurstChance;
  bool respawn = age > life || outside || burst || r0.z < uRespawnChance;

  if (respawn) {
    vec3 s = rand3(utexel, uFrame * 2u + 0x9E3779B9u);
    vec3 s2 = rand3(utexel, uFrame * 2u + 0x7F4A7C15u);
    int e = min(int(floor(s.x * float(uAttractorCount))), uAttractorCount - 1);
    vec4 a;
    spawn(e, vec3(s.yz, s2.x), vec3(s2.y, r1.yz), burst, a);
    outA = a;
    outB = vec4(0.0, uLifespan * (0.7 + 0.6 * s2.z) * (burst ? uBurstLife : 1.0), B.z, float(e));
  } else {
    outA = vec4(p, v);
    outB = vec4(age, life, B.z, B.w);
  }
}
`;
