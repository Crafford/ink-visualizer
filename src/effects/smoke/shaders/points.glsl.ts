import { NOISE_GLSL } from '../../shared/shaders/noise.glsl';
import { MAX_ATTRACTORS } from '../../shared/shaders/fullscreen.glsl';

/**
 * Smoke particle splat into the density target (copied from ink's and diverged: age cooling,
 * per-source colour vector instead of absorbance), drawn as gl.LINES: two vertices per particle,
 * no vertex attributes. Particle = gl_VertexID / 2 indexes the state textures (row-major,
 * width uSize); vertex 0 is where the particle was one step ago, vertex 1 where it is now.
 * Consecutive steps' segments tile the path, so fast particles draw continuous strokes
 * instead of a row of specks. Slow particles get a 1 device px segment (a point). Segments are
 * capped at uMaxSeg px, so the fast roll at the edge of a ring never draws spokes.
 *
 * Ink per particle is constant regardless of length: per-pixel ink = uInk / length.
 * Output: rgb = ink * uColorK[source], a = ink. uColorK is the absorbance (-ln colour) on light
 * paper (subtractive) and the colour itself in dark mode (additive light).
 * Cooling: ink per particle falls as (1 - age / life)^uCool, so smoke thins as it rises.
 *
 * Render-time audio response (moves ink in place, never moves the simulated particles):
 *   kick:   radial expansion about the nearest source, follows beatStrength.
 *   shiver: high-frequency curl displacement, follows beatStrength, wobbles on the real clock.
 *   breath: radial scale about the nearest source, follows bass.
 * Dormant particles (life < 0) are moved outside the clip volume.
 */
export const SMOKE_POINTS_VERT = /* glsl */ `
precision highp float;
precision highp int;
precision highp sampler2D;

uniform sampler2D uStateA;
uniform sampler2D uStateB;
uniform sampler2D uStateD;  // phi0, rho (tube radii), R0, v0
uniform float uTubeSigma;   // tube cross-section sigma (tube radii)
uniform int   uSize;
uniform float uAspect;
uniform vec2  uViewPx;      // drawing buffer size, device px
uniform float uStepDt;      // one simulation step, simulation seconds (x speed)
uniform float uInk;         // ink per particle (device px units)
uniform vec3  uColorK[${MAX_ATTRACTORS}];
uniform float uCool;        // ink falls as (1 - age / life)^uCool
uniform float uFadeIn;      // seconds (steady stream)
uniform float uPuffInk;     // ink multiplier of puff smoke (fades in at once, so the ring shows)
uniform float uStreamInk;   // ink multiplier of stream smoke
uniform vec2  uAttractors[${MAX_ATTRACTORS}];  // view space
uniform int   uAttractorCount;
uniform float uKick;        // beat kick: radial expansion about the nearest core (0 = none)
uniform float uKickRadius;  // the kick fades out by this distance
uniform float uShiver;      // shiver displacement amplitude (0 = none)
uniform float uShiverScale; // shiver field frequency
uniform float uRTime;       // real-time clock, seconds (not scaled by speed)
uniform float uBreath;      // radial scale about the nearest source (bass)
uniform float uMaxSeg;      // longest segment drawn, device px (longer steps are shortened)

uniform vec2  uRingLife;    // ring life (s): puff, stream
uniform float uDissolve;    // ring starts dissolving at this fraction of its life
uniform float uWashYoung;   // wash deposit weight of an intact ring (1 once dissolved)

out vec4 vInk;
out float vWash;

${NOISE_GLSL}

void main() {
  int id = gl_VertexID >> 1;
  ivec2 c = ivec2(id % uSize, id / uSize);
  vec4 a = texelFetch(uStateA, c, 0);
  vec4 b = texelFetch(uStateB, c, 0);
  if (b.y < 0.0) { vInk = vec4(0.0); vWash = 0.0; gl_Position = vec4(2.0, 2.0, 0.0, 1.0); return; }
  float t = b.x / max(b.y, 1e-3);
  // Cooling: thins steadily with age (faster than ink); fades in so the source is not a blob.
  bool puff = b.w > 3.5;
  // Tube cross-section weight (mean 1): the core carries more ink than the sparse gaussian
  // tail, so the edge of a moving ring is a soft gradient instead of a fringe of single dots.
  float rho = texelFetch(uStateD, c, 0).y / max(uTubeSigma, 1e-3);
  float tube = 2.0 * exp(-0.5 * rho * rho);
  float Tr = puff ? uRingLife.x : uRingLife.y;
  vWash = mix(uWashYoung, 1.0, smoothstep(uDissolve * Tr, Tr, b.x));
  float alpha = tube * pow(clamp(1.0 - t, 0.0, 1.0), uCool) * (puff ? uPuffInk * smoothstep(0.0, 0.04, b.x) : uStreamInk * smoothstep(0.0, uFadeIn, b.x));

  if (uKick > 0.0 || uBreath > 0.0) {
    vec2 best = vec2(0.0);
    float bestD2 = 1e9;
    for (int i = 0; i < ${MAX_ATTRACTORS}; i++) {
      if (i >= uAttractorCount) break;
      vec2 d = a.xy - uAttractors[i];
      float d2 = dot(d, d);
      if (d2 < bestD2) { bestD2 = d2; best = d; }
    }
    float dist = sqrt(bestD2);
    a.xy += best * (uKick * (1.0 - smoothstep(0.0, uKickRadius, dist))
                  + uBreath * (1.0 - smoothstep(0.0, 1.2, dist)));
  }
  // Shiver: every bit of ink wobbles where it is. The field changes fast on the real clock,
  // so the displacement reverses within a beat instead of carrying ink anywhere.
  if (uShiver > 0.0) {
    vec2 q = a.xy * uShiverScale;
    a.xy += curl2(vec3(q, uRTime * 7.0)) * uShiver;
  }

  // Segment in device px: from p - v*dt to p, at least 1 px long.
  vec2 toPx = 0.5 * uViewPx * vec2(1.0 / uAspect, 1.0);
  vec2 dPx = a.zw * uStepDt * toPx;
  // Capped: a fast rolling particle at the soft edge of a ring would otherwise draw a spoke.
  float len = min(length(dPx), uMaxSeg);
  vec2 dir = len > 1e-4 ? dPx / len : vec2(1.0, 0.0);
  float L = max(len, 1.0);
  vec2 head = vec2(a.x / uAspect, a.y);
  vec2 tail = head - dir * L / (0.5 * uViewPx);
  // Vertex 1 = head, vertex 0 = tail. Centre slow points on the particle.
  vec2 pos = (gl_VertexID & 1) == 1 ? head : tail;
  if (len < 1.0) pos += dir * (L * 0.5) / (0.5 * uViewPx);

  int e = clamp(int(b.w + 0.5) & 3, 0, ${MAX_ATTRACTORS - 1});
  float ink = uInk * alpha / L;
  vInk = vec4(uColorK[e] * ink, ink);
  gl_Position = vec4(pos, 0.0, 1.0);
}
`;

export const SMOKE_POINTS_FRAG = /* glsl */ `
precision highp float;

in vec4 vInk;
in float vWash;
layout(location = 0) out vec4 outLine;
layout(location = 1) out vec4 outWash;

void main() {
  outLine = vInk;
  outWash = vInk * vWash;
}
`;
