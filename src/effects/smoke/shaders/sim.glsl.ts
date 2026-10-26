import { NOISE_GLSL } from '../../shared/shaders/noise.glsl';
import { MAX_ATTRACTORS } from '../../shared/shaders/fullscreen.glsl';

/**
 * One smoke simulation step. Each fragment is one particle. Every particle belongs to a
 * vortex ring (a beat puff or one of the small rings of the steady stream).
 *
 *   uStateA: pos.xy, vel.xy (vel = this step's displacement / dt, for the line splat)
 *   uStateB: age, life (< 0 = dormant), seed, source index (+ 4 for puff smoke)
 *   uStateC: ring origin.xy (source position at birth), theta (angle around the ring), ring seed
 *   uStateD: phi0 (tube angle at birth), rho (distance from the tube core, in tube radii),
 *            R0 (ring radius at birth), v0 (travel speed at birth)
 *
 * Space is aspect-corrected: x in [-aspect, aspect], y in [-1, 1]. Times are simulation seconds.
 *
 * Ring kinematics are analytic in the particle's age t (no integration, so a ring stays one
 * coherent object). The ring is a torus in 3D seen from the front, its axis `ax` tilted
 * sideways by alpha (per ring, +-uTilt) and toward the viewer by beta (uBeta), so it reads
 * as a fat oval travelling up and slightly toward us:
 *
 *   slow(t) = 1 - exp(-t / tau)              tau = uTau (drag): speed v0 exp(-t / tau)
 *   centre  = origin + ax * v0 tau slow + up * riseV (t - tau slow)   (rises once it has slowed)
 *   R(t)    = R0 (1 + (uRGrow - 1) slow) (1 + wobble(theta, t))
 *   r(t)    = R0 mix(uTube.x, uTube.y, slow)  (tube radius: thickens as it slows)
 *   phi(t)  = phi0 + omega(rho) tau slow,  omega = uRoll v0 / R0 / (1 + 2 rho^2)  (poloidal roll,
 *             the core turns fastest, outside of the tube forward, inside back)
 *   pos     = centre + (R + rho r cos phi) radial(theta) + rho r sin phi ax   (projected to xy)
 *
 * wobble: two slow lobes (cos 2 theta and cos theta, periods 2-4 s, amplitude uWobble), so the
 * outline breathes smoothly like an egg in a pan; no high-frequency terms.
 *
 * On top of the ring each particle carries a free displacement D = pos - ringPos(age), driven
 * by curl noise. Its influence fades in from 0 over uNoiseIn s and grows to 1 as the ring
 * dissolves (dissolve = smoothstep(uDissolve * Tr, Tr, t), Tr = ring life), when the finer
 * octaves also come in: the ring travels as one object, then breaks into haze.
 *
 * Births:
 *   - puff: on a beat a share of all particles (uPuffChance per source) respawn on a ring at
 *     every source, radius uPuffR0 x strength, launched at uPuffV0.
 *   - stream: each source emits a small slow ring every 0.4-0.8 s (CPU cadence); dormant
 *     particles wake into it with probability uStreamChance[source]. A chain of soft rings
 *     merges into the plume column.
 *   Tube cross-section: rho is the radius of a 2D gaussian (sigma uTubeSigma tube radii), so
 *   the tube has a dense core and soft edges.
 */
export const SMOKE_SIM_FRAG = /* glsl */ `
precision highp float;
precision highp int;
precision highp sampler2D;

uniform sampler2D uStateA;
uniform sampler2D uStateB;
uniform sampler2D uStateC;
uniform sampler2D uStateD;

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
uniform float uNoiseIn;       // curl influence fades in over this much ring age
uniform float uNoiseFloor;    // curl influence while the ring is intact (x fade-in)
uniform float uDissolve;      // the ring starts dissolving at this fraction of its life
uniform vec2  uRingLife;      // ring life Tr (s): puff, stream
uniform float uLifespan;      // mean particle life, simulation seconds
uniform float uRiseV;         // buoyant rise speed of a slowed ring / haze (half-heights / s)
uniform float uWiden;         // lateral spread rate, 1/s, away from the ring origin (dissolved smoke)
uniform float uTau;           // ring speed decay time constant (drag)
uniform float uRGrow;         // R grows to R0 x uRGrow as the ring slows
uniform vec2  uTube;          // tube radius / R0: at birth, when slowed
uniform float uTubeSigma;     // gaussian cross-section, sigma in tube radii
uniform float uRoll;          // poloidal roll rate x v0 / R0
uniform float uWobble;        // outline wobble amplitude (fraction of R)
uniform vec2  uTilt;          // max sideways tilt of the ring axis (rad): puff, stream
uniform vec2  uBeta;          // tilt of the axis toward the viewer (rad), min..max

uniform float uPuffChance;    // per-step probability per source that a particle joins this step's puff
uniform float uPuffStrength;  // 0.25..1
uniform float uPuffSeed[${MAX_ATTRACTORS}];
uniform vec2  uPuffR0;        // ring radius at strength 0.25, 1
uniform float uPuffV0;        // launch speed x (0.5 + strength)
uniform float uPuffLife;      // life multiplier of puff smoke
uniform float uStreamChance[${MAX_ATTRACTORS}];  // wake-up probability of a dormant particle into this source's ring
uniform float uStreamSeed[${MAX_ATTRACTORS}];
uniform float uStreamR0;
uniform float uStreamV0;

layout(location = 0) out vec4 outA;
layout(location = 1) out vec4 outB;
layout(location = 2) out vec4 outC;
layout(location = 3) out vec4 outD;

${NOISE_GLSL}

const float TAU = 6.28318530718;

vec4 hash4(float seed, uint k) {
  uvec3 h = pcg3d(uvec3(uint(seed), k, 0x51F2u));
  uvec3 g = pcg3d(h ^ uvec3(0x9E37u, k, 7u));
  return vec4(vec3(h), float(g.x)) * (1.0 / 4294967296.0);
}

// Ring position of a particle at ring age t (see the header).
vec2 ringPos(vec4 C, vec4 D, bool puff, float t) {
  vec4 h = hash4(C.w, 1u);
  vec4 w = hash4(C.w, 2u);
  float alpha = (2.0 * h.x - 1.0) * (puff ? uTilt.x : uTilt.y);
  float beta = mix(uBeta.x, uBeta.y, h.y);
  vec3 ax = vec3(vec2(sin(alpha), cos(alpha)) * cos(beta), sin(beta));
  vec3 e1 = normalize(vec3(ax.y, -ax.x, 0.0));
  vec3 e2 = cross(ax, e1);

  float slow = 1.0 - exp(-t / uTau);
  float theta = C.z, rho = D.y, R0 = D.z, v0 = D.w;
  // Two slow lobes, each breathing on its own 2-4 s period.
  float wob = uWobble * (0.7 * sin(TAU * t / mix(2.0, 4.0, w.x) + TAU * w.y) * cos(2.0 * theta + TAU * h.z)
                       + 0.3 * sin(TAU * t / mix(2.0, 4.0, w.z) + TAU * w.w) * cos(theta + TAU * h.w));
  float R = R0 * (1.0 + (uRGrow - 1.0) * slow) * (1.0 + wob);
  float r = R0 * mix(uTube.x, uTube.y, slow);
  // Per-particle roll rate +-10% (from phi0's fraction, independent of theta), so the roll
  // never lines particles up into stripes.
  float omega = uRoll * v0 / max(R0, 1e-3) / (1.0 + 2.0 * rho * rho) * (0.9 + 0.2 * fract(D.x * 7.13));
  float phi = D.x + omega * uTau * slow;
  vec3 radial = e1 * cos(theta) + e2 * sin(theta);
  vec3 p = (R + rho * r * cos(phi)) * radial + (rho * r * sin(phi) + v0 * uTau * slow) * ax;
  return C.xy + p.xy + vec2(0.0, uRiseV * (t - uTau * slow));
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
    outD = vec4(0.0);
    return;
  }

  vec4 A = texelFetch(uStateA, texel, 0);
  vec4 B = texelFetch(uStateB, texel, 0);
  vec4 C = texelFetch(uStateC, texel, 0);
  vec4 D = texelFetch(uStateD, texel, 0);
  bool dormant = B.y < 0.0;
  vec2 p = A.xy;
  vec2 v = A.zw;
  float age = B.x + uDt;

  if (!dormant) {
    bool isPuff = B.w > 3.5;
    // Free displacement carried from the last step, then advanced by the noise.
    vec2 disp = A.xy - ringPos(C, D, isPuff, B.x);
    vec2 ring = ringPos(C, D, isPuff, age);
    float Tr = isPuff ? uRingLife.x : uRingLife.y;
    float dissolve = smoothstep(uDissolve * Tr, Tr, age);
    float influence = smoothstep(0.0, uNoiseIn, age) * mix(uNoiseFloor, 1.0, dissolve);
    vec2 q = (A.xy - vec2(0.0, uFieldShift)) * uNoiseScale;
    float t = uTime * uNoiseSpeed;
    // Large slow curls carry the ring as a whole; finer curls only come in as it dissolves.
    vec2 u = (0.6 * curl2(vec3(q, t))
            + 0.45 * dissolve * curl2(vec3(q * 2.3, t * 1.6 + 19.1))
            + 0.15 * dissolve * curl2(vec3(q * 5.3, t * 2.7 + 41.7))) * uTurbulence * influence;
    // Dissolved smoke spreads sideways away from where it was emitted (the plume widens).
    u.x += (A.xy.x - C.x) * uWiden * dissolve;
    disp += u * uDt;
    p = ring + disp;
    v = (p - A.xy) / max(uDt, 1e-5);
    bool outside = abs(p.x) > uAspect * 1.15 || abs(p.y) > 1.15;
    dormant = age > B.y || outside;
  }

  // Puff: r1.x picks the source directly (uPuffChance per source).
  int count = uAttractorCount;
  int pe = int(floor(r1.x / max(uPuffChance, 1e-9)));
  bool puff = uPuffChance > 0.0 && pe < count;
  int se = -1;
  if (!puff && dormant) {
    float acc = 0.0;
    for (int i = 0; i < ${MAX_ATTRACTORS}; i++) {
      if (i >= count) break;
      acc += uStreamChance[i];
      if (r0.z < acc) { se = i; break; }
    }
  }
  if (puff || se >= 0) {
    vec3 s = rand3(utexel, uFrame * 3u + 0x9E3779B9u);
    int e = puff ? pe : se;
    vec2 src = uAttractors[e];
    float theta = s.y * TAU;
    float phi0 = s.z * TAU;
    // 2D gaussian radius (Rayleigh), clamped: dense tube core, soft outside.
    float rho = min(uTubeSigma * sqrt(-2.0 * log(max(r1.y, 1e-6))), 2.2 * uTubeSigma);
    float life = uLifespan * (0.7 + 0.6 * r0.y);
    float seed, R0, v0;
    if (puff) {
      float st = clamp((uPuffStrength - 0.25) / 0.75, 0.0, 1.0);
      seed = uPuffSeed[e];
      R0 = mix(uPuffR0.x, uPuffR0.y, st);
      v0 = uPuffV0 * (0.5 + uPuffStrength);
      life *= uPuffLife;
    } else {
      seed = uStreamSeed[e];
      R0 = uStreamR0 * (0.85 + 0.3 * hash4(seed, 3u).x);
      v0 = uStreamV0 * (0.8 + 0.4 * hash4(seed, 3u).y);
    }
    vec4 nC = vec4(src, theta, seed);
    vec4 nD = vec4(phi0, rho, R0, v0);
    outA = vec4(ringPos(nC, nD, puff, 0.0), 0.0, 0.0);
    outB = vec4(0.0, life, B.z, float(e) + (puff ? 4.0 : 0.0));
    outC = nC;
    outD = nD;
  } else if (dormant) {
    outA = vec4(9.0, 9.0, 0.0, 0.0);
    outB = vec4(0.0, -1.0, B.z, B.w);
    outC = C;
    outD = D;
  } else {
    outA = vec4(p, v);
    outB = vec4(age, B.y, B.z, B.w);
    outC = C;
    outD = D;
  }
}
`;
