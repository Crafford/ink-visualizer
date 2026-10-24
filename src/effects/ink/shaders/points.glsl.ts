import { MAX_ATTRACTORS } from './sim.glsl';

/**
 * Particle splat into the density target, drawn as gl.LINES: two vertices per particle,
 * no vertex attributes. Particle = gl_VertexID / 2 indexes the state textures (row-major,
 * width uSize); vertex 0 is where the particle was one step ago, vertex 1 where it is now.
 * Consecutive steps' segments tile the path, so fast particles draw continuous strokes
 * instead of a row of specks. Slow particles get a 1 device px segment (a point).
 *
 * Ink per particle is constant regardless of length: per-pixel ink = uInk / length.
 * Output: rgb = ink * absorbance of the particle's attractor colour (-ln colour), a = ink.
 */
export const POINTS_VERT = /* glsl */ `
precision highp float;
precision highp int;
precision highp sampler2D;

uniform sampler2D uStateA;
uniform sampler2D uStateB;
uniform int   uSize;
uniform float uAspect;
uniform vec2  uViewPx;      // drawing buffer size, device px
uniform float uStepDt;      // one simulation step, seconds
uniform float uInk;         // ink per particle (device px units)
uniform vec3  uAbsorb[${MAX_ATTRACTORS}];
uniform vec2  uAttractors[${MAX_ATTRACTORS}];  // view space
uniform int   uAttractorCount;
uniform float uKick;        // beat kick: radial expansion about the nearest core (0 = none)
uniform float uKickRadius;  // the kick fades out by this distance

out vec4 vInk;

void main() {
  int id = gl_VertexID >> 1;
  ivec2 c = ivec2(id % uSize, id / uSize);
  vec4 a = texelFetch(uStateA, c, 0);
  vec4 b = texelFetch(uStateB, c, 0);
  float t = b.x / max(b.y, 1e-3);
  // Fade out over the last 20% of life; fade in over the first 50 ms so respawns do not pop
  // (absolute, so beat-burst particles show almost at once).
  float alpha = (1.0 - smoothstep(0.8, 1.0, t)) * smoothstep(0.0, 0.05, b.x);

  // Beat kick, render-time only: the structure around each core expands for a few frames
  // and relaxes as beatStrength decays, without moving the simulated particles (so repeated
  // beats do not scatter the ink into fog). The trails keep the imprint of the jump.
  if (uKick > 0.0) {
    vec2 best = vec2(0.0);
    float bestD2 = 1e9;
    for (int i = 0; i < ${MAX_ATTRACTORS}; i++) {
      if (i >= uAttractorCount) break;
      vec2 d = a.xy - uAttractors[i];
      float d2 = dot(d, d);
      if (d2 < bestD2) { bestD2 = d2; best = d; }
    }
    float f = 1.0 - smoothstep(0.0, uKickRadius, sqrt(bestD2));
    a.xy += best * uKick * f;
  }

  // Segment in device px: from p - v*dt to p, at least 1 px long.
  vec2 toPx = 0.5 * uViewPx * vec2(1.0 / uAspect, 1.0);
  vec2 dPx = a.zw * uStepDt * toPx;
  float len = length(dPx);
  vec2 dir = len > 1e-4 ? dPx / len : vec2(1.0, 0.0);
  float L = max(len, 1.0);
  vec2 head = vec2(a.x / uAspect, a.y);
  vec2 tail = head - dir * L / (0.5 * uViewPx);
  // Vertex 1 = head, vertex 0 = tail. Centre slow points on the particle.
  vec2 pos = (gl_VertexID & 1) == 1 ? head : tail;
  if (len < 1.0) pos += dir * (L * 0.5) / (0.5 * uViewPx);

  int e = clamp(int(b.w + 0.5), 0, ${MAX_ATTRACTORS - 1});
  float ink = uInk * alpha / L;
  vInk = vec4(uAbsorb[e] * ink, ink);
  gl_Position = vec4(pos, 0.0, 1.0);
}
`;

export const POINTS_FRAG = /* glsl */ `
precision highp float;

in vec4 vInk;
out vec4 outColor;

void main() {
  outColor = vInk;
}
`;
