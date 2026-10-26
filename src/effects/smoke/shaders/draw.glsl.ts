/**
 * Smoke strands: each particle draws the piece of its strand up to the next-born particle of
 * the same strand (slot k -> k + 1), as uSub Catmull-Rom sub-segments through slots k - 1 .. k + 2,
 * so a stretched strand stays a smooth curve. Six vertices per sub-segment, no attributes:
 * gl_VertexID indexes the state.
 *
 * Each sub-segment quad is the segment widened by half the line width + 0.5 px and extended
 * 1 px at both ends; the fragment box-filters it (coverage across = clamp(W/2 + 0.5 - |d|),
 * along = the same at both ends), so consecutive pieces join seamlessly and nothing serrates.
 * A strand piece carries a fixed amount of light spread along its length: intensity per pixel
 * = energy / (piece length x width), so stretched smoke thins out, as real smoke does; a piece
 * much longer than uStretch has torn and fades out.
 */
export const SMOKE_DRAW_VERT = /* glsl */ `
precision highp float;
precision highp int;
precision highp sampler2D;

uniform sampler2D uStateA;
uniform sampler2D uStateB;
uniform sampler2D uStateC;
uniform int   uSize;       // state texture side
uniform int   uStrandLen;  // slots per strand
uniform int   uSub;        // sub-segments per piece
uniform float uAspect;
uniform vec2  uViewPx;     // target size, device px
uniform float uWidth;      // line width, device px (drawn at least 1)
uniform float uEnergy;     // light per particle
uniform float uLifespan;
uniform float uSourceY;
uniform float uFadeH;      // fade-in height above the source
uniform float uFadeOut;    // life fraction where the fade-out starts
uniform float uStretch;    // piece length (device px) beyond which a piece thins out: torn smoke

out vec2 vLocal;           // x: px along from the piece start, y: px across
flat out float vLen;
flat out float vHalf;
out float vI;              // light per pixel, interpolated along the piece

ivec2 texel(int i) { return ivec2(i % uSize, i / uSize); }
vec2 toPx(vec2 v) { return vec2((v.x / uAspect) * 0.5 + 0.5, v.y * 0.5 + 0.5) * uViewPx; }

vec2 catmull(vec2 p0, vec2 p1, vec2 p2, vec2 p3, float t) {
  float t2 = t * t, t3 = t2 * t;
  return 0.5 * ((2.0 * p1) + (-p0 + p2) * t + (2.0 * p0 - 5.0 * p1 + 4.0 * p2 - p3) * t2 + (-p0 + 3.0 * p1 - 3.0 * p2 + p3) * t3);
}

// Fade in with height (smoke appears from nothing; a surge shows sooner),
// fade out over the end of life.
float fadeOf(vec4 A, float boost) {
  float h = A.y - uSourceY;
  float t = A.w / uLifespan;
  float fin = smoothstep(0.0, uFadeH * mix(1.0, 0.5, boost), h);
  return fin * fin * (1.0 - smoothstep(uFadeOut, 1.0, t));
}

void main() {
  int per = 6 * uSub;
  int idx = gl_VertexID / per;
  int rem = gl_VertexID - idx * per;
  int sub = rem / 6;
  int corner = rem - sub * 6;

  int slot = idx % uStrandLen;
  int base = idx - slot;
  int iNext = base + (slot + 1) % uStrandLen;
  int iPrev = base + (slot + uStrandLen - 1) % uStrandLen;
  int iNext2 = base + (slot + 2) % uStrandLen;

  vec4 A1 = texelFetch(uStateA, texel(idx), 0);
  vec4 A2 = texelFetch(uStateA, texel(iNext), 0);
  float born1 = texelFetch(uStateB, texel(idx), 0).w;
  float born2 = texelFetch(uStateB, texel(iNext), 0).w;
  // The slot after the newest particle is the oldest one: no piece there.
  if (born1 <= 0.0 || born2 <= 0.0 || A2.w > A1.w || A1.w > uLifespan) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }
  vec4 A0 = texelFetch(uStateA, texel(iPrev), 0);
  vec4 A3 = texelFetch(uStateA, texel(iNext2), 0);
  float born3 = texelFetch(uStateB, texel(iNext2), 0).w;
  vec2 q1 = toPx(A1.xy), q2 = toPx(A2.xy);
  // Missing neighbours (strand ends): mirror, so the curve ends straight.
  vec2 q0 = (A0.w > A1.w && A0.w <= uLifespan * 1.2) ? toPx(A0.xy) : 2.0 * q1 - q2;
  vec2 q3 = (born3 > 0.0 && A3.w < A2.w) ? toPx(A3.xy) : 2.0 * q2 - q1;

  // Short pieces are drawn straight; longer ones get up to uSub curve segments (~4 px each).
  float pieceLen = length(q2 - q1);
  int nSub = clamp(int(ceil(pieceLen / 4.0)), 1, uSub);
  if (sub >= nSub) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  float ta = float(sub) / float(nSub), tb = float(sub + 1) / float(nSub);
  vec2 p0 = catmull(q0, q1, q2, q3, ta);
  vec2 p1 = catmull(q0, q1, q2, q3, tb);

  vec2 d = p1 - p0;
  float len = length(d);
  vec2 dir = len > 1e-4 ? d / len : vec2(0.0, 1.0);
  vec2 nrm = vec2(-dir.y, dir.x);
  float w = max(uWidth, 1.0);
  float hw = 0.5 * w + 0.5;

  // corners: (end, side) = (0,-1) (1,-1) (1,1) / (0,-1) (1,1) (0,1)
  float e = (corner == 1 || corner == 2 || corner == 4) ? 1.0 : 0.0;
  float s = (corner == 2 || corner == 4 || corner == 5) ? 1.0 : -1.0;
  vec2 pos = mix(p0 - dir, p1 + dir, e) + nrm * (s * hw);
  vLocal = vec2(dot(pos - p0, dir), s * hw);
  vLen = len;
  vHalf = 0.5 * w;

  vec4 C1 = texelFetch(uStateC, texel(idx), 0);
  vec4 C2 = texelFetch(uStateC, texel(iNext), 0);
  float gain = 0.5 * (C1.w + C2.w);
  // The piece's light spread along its length (sub-segments share it by length); the fade is
  // interpolated along the piece so the fade-in at the source has no steps.
  float fade = mix(fadeOf(A1, C1.y), fadeOf(A2, C2.y), mix(ta, tb, e));
  float torn = pieceLen / uStretch;
  vI = uEnergy * gain * fade / (max(pieceLen, 1.0) * w * (1.0 + torn * torn));

  gl_Position = vec4(pos / uViewPx * 2.0 - 1.0, 0.0, 1.0);
}
`;

export const SMOKE_DRAW_FRAG = /* glsl */ `
precision highp float;

in vec2 vLocal;
flat in float vLen;
flat in float vHalf;
in float vI;
out vec4 outColor;

void main() {
  float across = clamp(vHalf + 0.5 - abs(vLocal.y), 0.0, 1.0);
  float along = clamp(vLocal.x + 0.5, 0.0, 1.0) * clamp(vLen - vLocal.x + 0.5, 0.0, 1.0);
  outColor = vec4(vI * across * along);
}
`;
