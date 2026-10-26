import { NOISE_GLSL } from '../../shared/shaders/noise.glsl';
import { MAX_ATTRACTORS } from '../../shared/shaders/fullscreen.glsl';

/**
 * One smoke simulation step. Each fragment is one particle.
 *
 *   uStateA: pos.xy, vel.xy
 *   uStateB: age, life (< 0 = dormant), seed, source index (+ 4 for puff smoke)
 *   uStateC: ring centre.xy (where it was emitted), spin (signed roll speed), puff flag (0 / 1)
 *
 * Space is aspect-corrected: x in [-aspect, aspect], y in [-1, 1]. Times are simulation seconds.
 *
 * Births:
 *   - emission: a dormant particle wakes (rate uEmitChance) on a small ring around a source,
 *     moving outward and rolling around the ring (tangential), so a steady stream curls off it.
 *     The roll direction of each source drifts slowly between left and right (noise in time),
 *     so the plume alternately curls one way and the other.
 *   - puff: on a beat a share of all particles (uPuffChance) respawn on the ring at every
 *     source with a much stronger outward + rolling launch: a smoke ring that expands, slows
 *     (drag) and is then broken up by the turbulence.
 * Motion: the medium is three-octave curl noise (the finer octaves ramp in over uSettle seconds
 * of age: laminar near the source, breaking into wisps as it rises; rings stay clean for a moment) + a decaying roll around the ring centre +
 * a lateral spread away from the plume axis (widening). Buoyancy is a constant upward
 * acceleration; drag relaxes the velocity toward the medium, so the rise reaches a terminal
 * speed of about uRise / uRelax. Particles die at the end of life or outside the view.
 */
export const SMOKE_SIM_FRAG = /* glsl */ `
precision highp float;
precision highp int;
precision highp sampler2D;

uniform sampler2D uStateA;
uniform sampler2D uStateB;
uniform sampler2D uStateC;

uniform float uDt;            // simulation seconds this step
uniform float uTime;          // simulation clock
uniform uint  uFrame;
uniform float uAspect;
uniform bool  uInit;

uniform vec2  uAttractors[${MAX_ATTRACTORS}];   // source positions
uniform int   uAttractorCount;

uniform float uNoiseScale;    // curl frequency, per view half-height
uniform float uNoiseSpeed;    // curl field evolution per simulation second
uniform float uFieldShift;    // the curl field is carried upward with the smoke (view half-heights)
uniform float uTurbulence;    // curl velocity
uniform float uSettle;        // curl ramps in over this much age
uniform float uRelax;         // per-second velocity relaxation toward the medium (drag)
uniform float uMaxSpeed;
uniform float uLifespan;      // mean life, simulation seconds
uniform float uRise;          // buoyancy, upward acceleration (half-heights / s^2)
uniform float uWiden;         // lateral spread rate, 1/s, away from the emission x
uniform float uSpinDecay;     // roll decays with this time constant (s)

uniform float uEmitChance;    // per-step wake-up probability of a dormant particle
uniform float uRingRadius;
uniform vec2  uEmitVel;       // outward, roll speed of the steady stream
uniform float uPuffChance;    // per-step probability that a particle joins this step's puff
uniform float uPuffStrength;  // 0.25..1
uniform vec2  uPuffVel;       // outward, roll speed of a puff at strength 1
uniform float uPuffLife;      // life multiplier of puff smoke

layout(location = 0) out vec4 outA;
layout(location = 1) out vec4 outB;
layout(location = 2) out vec4 outC;

${NOISE_GLSL}

const float TAU = 6.28318530718;

float sn(vec3 v) { vec3 g; return snoiseGrad(v, g); }

// Roll direction of a source: drifts smoothly between -1 and 1 over a few seconds.
float spinSign(int e) {
  return clamp(1.6 * sn(vec3(float(e) * 13.7, uTime * 0.12, 3.3)), -1.0, 1.0);
}

void main() {
  ivec2 texel = ivec2(gl_FragCoord.xy);
  uvec2 utexel = uvec2(texel);
  vec3 r0 = rand3(utexel, uFrame * 3u);
  vec3 r1 = rand3(utexel, uFrame * 3u + 1u);

  if (uInit) {
    vec3 s = rand3(utexel, 0x5A0CEu);
    outA = vec4(9.0, 9.0, 0.0, 0.0);
    outB = vec4(0.0, -1.0, s.x, 0.0);
    outC = vec4(0.0);
    return;
  }

  vec4 A = texelFetch(uStateA, texel, 0);
  vec4 B = texelFetch(uStateB, texel, 0);
  vec4 C = texelFetch(uStateC, texel, 0);
  bool dormant = B.y < 0.0;
  vec2 p = A.xy;
  vec2 v = A.zw;
  float age = B.x + uDt;

  if (!dormant) {
    float t = uTime * uNoiseSpeed;
    // Eddies rise with the smoke instead of standing still, so nothing gets trapped circling one.
    vec2 q = (p - vec2(0.0, uFieldShift)) * uNoiseScale;
    // Large slow curls everywhere; finer curls ramp in with age, so the stream leaves the
    // source laminar and breaks into wisps as it rises.
    float ramp = smoothstep(0.0, uSettle, age);
    vec2 u = ((0.5 + 0.25 * ramp) * curl2(vec3(q, t))
            + (0.15 + 0.55 * ramp) * curl2(vec3(q * 2.3, t * 1.6 + 19.1))
            + 0.45 * ramp * curl2(vec3(q * 5.3, t * 2.7 + 41.7))) * uTurbulence;
    // Puffs keep rolling around the ring centre, decaying: the ring curls while it expands.
    // (The steady stream only gets the initial roll, or it would orbit the source as a donut.)
    if (C.w > 0.5) {
      vec2 d = p - C.xy;
      float r = length(d);
      u += vec2(-d.y, d.x) / max(r, 1e-3) * C.z * exp(-age / uSpinDecay) * smoothstep(0.0, 0.02, r);
    }
    // Widening: smoke spreads sideways away from where it was emitted, more as it rises.
    u.x += (p.x - C.x) * uWiden * smoothstep(0.0, 0.4, p.y - C.y);

    v = mix(v, u, 1.0 - exp(-uRelax * uDt));
    v.y += uRise * uDt;
    float sp = length(v);
    if (sp > uMaxSpeed) v *= uMaxSpeed / sp;
    p += v * uDt;
    bool outside = abs(p.x) > uAspect * 1.15 || abs(p.y) > 1.15;
    dormant = age > B.y || outside;
  }

  bool puff = r1.x < uPuffChance;
  bool emit = dormant && r0.z < uEmitChance;
  if (puff || emit) {
    vec3 s = rand3(utexel, uFrame * 3u + 0x9E3779B9u);
    vec3 s2 = rand3(utexel, uFrame * 3u + 0x7F4A7C15u);
    int e = min(int(floor(s.x * float(uAttractorCount))), uAttractorCount - 1);
    vec2 src = uAttractors[e];
    float a = s.y * TAU;
    vec2 dir = vec2(cos(a), sin(a));
    vec2 tan = vec2(-dir.y, dir.x);
    float spin = spinSign(e);
    float rr = uRingRadius * (0.85 + 0.3 * s.z);
    vec2 vel;
    float roll;
    float life = uLifespan * (0.7 + 0.6 * r0.y);
    if (puff) {
      // A thin ring: every particle gets nearly the same launch, so the ring stays a ring.
      // Lobed: the launch varies smoothly around the ring (new shape every puff), so the ring
      // is organic rather than a perfect circle.
      float lobes = 1.0 + 0.18 * sn(vec3(dir * 1.7, uTime * 3.1 + float(e) * 5.0));
      float k = (0.5 + uPuffStrength) * lobes * (0.94 + 0.12 * s2.x);
      roll = uPuffVel.y * (0.5 + uPuffStrength) * (spin >= 0.0 ? 1.0 : -1.0) * (0.6 + 0.4 * abs(spin));
      vel = dir * uPuffVel.x * k;
      life *= uPuffLife;
    } else {
      roll = uEmitVel.y * spin;
      vel = dir * uEmitVel.x * (0.6 + 0.8 * s2.x);
    }
    // Hot gas leaves the source already rising (at the terminal buoyant speed for the stream,
    // half of it for a puff), so it does not stall and pool into a blob at the source.
    vel.y += (puff ? 0.5 : 1.0) * uRise / max(uRelax, 0.1);
    outA = vec4(src + dir * rr, vel + tan * roll);
    outB = vec4(0.0, life, B.z, float(e) + (puff ? 4.0 : 0.0));
    outC = vec4(src, roll, puff ? 1.0 : 0.0);
  } else if (dormant) {
    outA = vec4(9.0, 9.0, 0.0, 0.0);
    outB = vec4(0.0, -1.0, B.z, B.w);
    outC = C;
  } else {
    outA = vec4(p, v);
    outB = vec4(age, B.y, B.z, B.w);
    outC = C;
  }
}
`;
