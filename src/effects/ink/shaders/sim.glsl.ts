import { NOISE_GLSL } from '../../shared/shaders/noise.glsl';
import { MAX_ATTRACTORS } from '../Attractors';

/**
 * One simulation step. Each fragment is one particle.
 *
 *   uStateA: pos.xy, vel.xy
 *   uStateB: age, life (< 0 = dormant), seed, source index
 *   uStateC: bleed centre.xy (drop / satellite / seep centre), bleed reach R, bleed angle
 *
 * Space is aspect-corrected: x in [-aspect, aspect], y in [-1, 1]. All times are simulation
 * seconds (the effect scales dt by the Speed param before it gets here).
 *
 * Ink metaphor: drops landing on paper. A particle is born by
 *   - seep: a dormant particle wakes up in a small disc at a source (rate uSeepChance), or
 *   - drop: on a beat (or an idle drip) a share of all particles respawn as a splat: a dense
 *     disc at the source with a fast radial launch, plus 3-7 satellite spatters around it.
 * After landing it bleeds: the medium velocity points along the particle's bleed angle with
 * speed uBleedRate * R * f^2, f = 1 - d / R, d = distance from the bleed centre, so the bleed
 * slows and stops at the reach R. A static high-frequency "paper fibre" field bends the bleed
 * direction, so the front is ragged. Curl noise (scaled by wetness) moves the medium.
 * The particle's velocity relaxes toward the medium velocity at uRelax (drag): a splat's
 * launch dies within ~1 / uRelax seconds.
 * Particles that die (age > life, or leave the view) go dormant until they are reborn.
 */
export const SIM_FRAG = /* glsl */ `
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
uniform float uTurbulence;    // curl velocity (already x wetness influence)
uniform float uRelax;         // per-second velocity relaxation toward the medium (drag)
uniform float uMaxSpeed;
uniform float uLifespan;      // mean life, simulation seconds
uniform float uBleedRate;     // bleed speed = uBleedRate * R * f^2

uniform float uSeepChance;    // per-step wake-up probability of a dormant particle
uniform float uSeepRadius;
uniform float uSeepSpeed;
uniform float uSeepBleed;     // extra bleed reach of seep ink

uniform float uDropChance;    // per-step probability that a particle joins this step's drop
uniform int   uDropEmitter;   // source of the drop, -1 = every source
uniform uint  uDropSeed;      // changes every drop: offsets and satellite layout
uniform float uDropStrength;  // 0.25..1
uniform float uDropJitter;    // drop lands up to this far from the source
uniform vec2  uDropRadius;    // disc radius at strength 0 and 1
uniform float uSplat;         // splat reach (distance the launch carries)
uniform float uDropBleed;     // extra bleed reach of drop ink
uniform float uDropLife;      // life multiplier of drop ink
uniform float uSatFraction;   // share of drop particles in satellites
uniform vec2  uSatDist;       // satellite distance range from the drop centre
uniform float uSatRadius;     // max satellite disc radius
uniform float uSatBleed;      // satellite bleed reach, relative to its radius

uniform float uFibre;         // share of particles that bleed into long fibre tendrils
uniform float uFeather;       // bleed direction noise amplitude, radians
uniform float uFeatherFreq;   // paper fibre field frequency
uniform float uEdgeNoise;     // angular modulation of the bleed reach (lobed, ragged edge)

layout(location = 0) out vec4 outA;
layout(location = 1) out vec4 outB;
layout(location = 2) out vec4 outC;

${NOISE_GLSL}

const float TAU = 6.28318530718;
const float INV32 = 1.0 / 4294967296.0;

float sn(vec3 v) { vec3 g; return snoiseGrad(v, g); }

vec3 hash3(uvec3 v) { return vec3(pcg3d(v)) * INV32; }

// Uniform point in the unit disc.
vec2 disc(float u, float a) { return sqrt(u) * vec2(cos(a * TAU), sin(a * TAU)); }

// Bleed reach R = d0 * (1 + grow * g * m): the landing disc scales up as a whole, so it stays
// solid (adding the same offset to every particle would hollow the centre into a ring).
// m modulates the growth by angle (lobes + fine raggedness), so the final edge is irregular;
// g is a little per-particle spread (soft edge) and a few particles become fibre tendrils.
float reach(float d0, float grow, vec2 radial, float shapeSeed, vec3 r) {
  float g = 0.85 + 0.15 * r.x;
  if (r.y < uFibre) g = 1.4 + 1.4 * r.x;
  float m = 1.0 + uEdgeNoise * (0.7 * sn(vec3(radial * 1.8, shapeSeed)) + 0.35 * sn(vec3(radial * 7.0, shapeSeed + 3.1)));
  return d0 * (1.0 + grow * g * max(m, 0.1));
}

// Seep: a small disc at the source, slow outward velocity.
void spawnSeep(int e, vec3 r0, vec3 r1, out vec4 A, out vec4 C) {
  vec2 src = uAttractors[e];
  vec2 off = disc(r0.x, r0.y) * uSeepRadius;
  vec2 radial = normalize(off + vec2(1e-5, 0.0));
  float R = reach(length(off), uSeepBleed / uSeepRadius, radial, float(e) * 7.3 + uTime * 0.05, vec3(r1.x, r1.y, 0.0));
  A = vec4(src + off, radial * uSeepSpeed * (0.3 + 0.7 * r0.z));
  C = vec4(src, R, atan(radial.y, radial.x) + (r1.z - 0.5) * 0.3);
}

// Drop: dense disc + satellites. Everything per drop comes from (source, uDropSeed).
void spawnDrop(int e, vec3 r0, vec3 r1, vec3 r2, out vec4 A, out vec4 C) {
  vec3 dh = hash3(uvec3(uint(e), uDropSeed, 11u));
  vec2 src = uAttractors[e] + disc(dh.x, dh.y) * uDropJitter;
  float st = uDropStrength;
  float shapeSeed = float(uDropSeed % 4093u) * 0.731 + float(e) * 17.0;
  int nSat = 3 + int(dh.z * 5.0);   // 3..7

  if (r0.x < uSatFraction) {
    // Satellite spatter: a tiny solid disc, stretched along its direction from the drop.
    int k = min(int(pow(r0.y, 1.5) * float(nSat)), nSat - 1);
    vec3 sh = hash3(uvec3(uint(e), uDropSeed, 100u + uint(k)));
    vec2 dir = vec2(cos(sh.x * TAU), sin(sh.x * TAU));
    float dist = mix(uSatDist.x, uSatDist.y, sh.y * sh.y) * (0.6 + 0.5 * st);
    float rad = uSatRadius * (0.3 + 0.7 * sh.z) * (1.0 - 0.4 * sh.y);
    vec2 cc = src + dir * dist;
    vec2 u = disc(r0.z, r1.x);
    vec2 off = (dir * u.x * 1.7 + vec2(-dir.y, dir.x) * u.y) * rad;
    vec2 radial = normalize(off + dir * 1e-5);
    float R = reach(length(off), uSatBleed, radial, shapeSeed + float(k) * 3.7, r2);
    A = vec4(cc + off, vec2(0.0));
    C = vec4(cc, R, atan(radial.y, radial.x));
    return;
  }
  // Main splat: dense disc, radial launch proportional to the distance from the centre (so
  // the disc expands as a whole and stays solid), carrying about uSplat before drag kills it.
  float rd = mix(uDropRadius.x, uDropRadius.y, st);
  vec2 off = disc(r0.y, r0.z) * rd;
  float d0 = length(off);
  vec2 radial = normalize(off + vec2(1e-5, 0.0));
  float splat = uSplat * (0.5 + st);
  float launch = splat * (0.6 + 0.4 * r1.x) * d0 / rd;
  float R = reach(d0, (splat + uDropBleed * (0.6 + 0.6 * st)) / rd, radial, shapeSeed, r2);
  A = vec4(src + off, radial * launch * uRelax);
  C = vec4(src, R, atan(radial.y, radial.x) + (r1.y - 0.5) * 0.25);
}

void main() {
  ivec2 texel = ivec2(gl_FragCoord.xy);
  uvec2 utexel = uvec2(texel);
  vec3 r0 = rand3(utexel, uFrame * 3u);
  vec3 r1 = rand3(utexel, uFrame * 3u + 1u);

  if (uInit) {
    // Everything starts dormant: ink arrives by seep and drops.
    vec3 s = rand3(utexel, 0xA511E9B3u);
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
    // Bleed toward the reach, along the fibre-bent bleed angle.
    float d = distance(p, C.xy);
    float f = clamp(1.0 - d / max(C.z, 1e-4), 0.0, 1.0);
    float th = C.w + uFeather * sn(vec3(p * uFeatherFreq, 4.7));
    vec2 u = vec2(cos(th), sin(th)) * (uBleedRate * C.z * f * f);

    // Medium flow: curl noise, base octave + 3x octave for fine filaments.
    float t = uTime * uNoiseSpeed;
    vec2 q = p * uNoiseScale;
    u += (curl2(vec3(q, t)) + 0.35 * curl2(vec3(q * 3.0, t * 1.7 + 19.1))) * uTurbulence;

    v = mix(v, u, 1.0 - exp(-uRelax * uDt));
    float sp = length(v);
    if (sp > uMaxSpeed) v *= uMaxSpeed / sp;
    p += v * uDt;
    bool outside = abs(p.x) > uAspect * 1.1 || abs(p.y) > 1.1;
    dormant = age > B.y || outside;
  }

  bool drop = r1.x < uDropChance;
  bool seep = dormant && r0.z < uSeepChance;
  if (drop || seep) {
    vec3 s = rand3(utexel, uFrame * 3u + 0x9E3779B9u);
    vec3 s2 = rand3(utexel, uFrame * 3u + 0x7F4A7C15u);
    vec3 s3 = rand3(utexel, uFrame * 3u + 0x2545F491u);
    int e = uDropEmitter >= 0 && drop ? uDropEmitter : min(int(floor(s.x * float(uAttractorCount))), uAttractorCount - 1);
    vec4 nA, nC;
    if (drop) spawnDrop(e, vec3(s.yz, s2.x), vec3(s2.yz, r0.x), s3, nA, nC);
    else spawnSeep(e, vec3(s.yz, s2.x), vec3(s2.yz, r0.x), nA, nC);
    float life = uLifespan * (0.7 + 0.6 * r0.y) * (drop ? uDropLife : 1.0);
    outA = nA;
    outB = vec4(0.0, life, B.z, float(e));
    outC = nC;
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
