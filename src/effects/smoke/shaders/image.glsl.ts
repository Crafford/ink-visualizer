/**
 * Composite: accumulated light d -> a = 1 - exp(-d) -> baked ramp (thin = cool blue-grey,
 * dense = near white) over the background, additive like backlit smoke. A +-1 LSB triangular
 * dither keeps the dark gradients from banding (invisible, not grain).
 */
export const SMOKE_COMPOSITE_FRAG = /* glsl */ `
precision highp float;
precision highp int;
precision highp sampler2D;

uniform sampler2D uLight;
uniform vec3  uBg;
uniform vec3  uThin;
uniform vec3  uDense;
uniform vec2  uRamp;   // a range over which thin turns dense
uniform float uExposure;

out vec4 outColor;

float hash(uvec2 v) {
  v = v * 1664525u + 1013904223u;
  v.x += v.y * 1664525u; v.y += v.x * 1664525u;
  v ^= v >> 16u;
  v.x += v.y * 1664525u; v.y += v.x * 1664525u;
  v ^= v >> 16u;
  return float(v.x) * (1.0 / 4294967296.0);
}

void main() {
  ivec2 px = ivec2(gl_FragCoord.xy);
  float d = max(texelFetch(uLight, px, 0).r, 0.0);
  // Log-compressed exposure: the thread at the source carries every strand in a few pixels,
  // the sheets above a small share of it; compression keeps both readable.
  float a = 1.0 - exp(-uExposure * log2(1.0 + d));
  vec3 ramp = mix(uThin, uDense, smoothstep(uRamp.x, uRamp.y, a));
  vec3 col = uBg + (ramp - uBg) * a;
  uvec2 q = uvec2(px);
  col += (hash(q) + hash(q + 7919u) - 1.0) / 255.0;
  outColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
`;
