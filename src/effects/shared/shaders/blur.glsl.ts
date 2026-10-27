/**
 * Two-layer separable blur header shared by the trail passes (ink, smoke): uniforms
 * uLine / uWash / uTexel / uSigmaLine / uSigmaWash, MRT outputs outLine / outWash, and
 * blur9 (9 taps, +-2 sigma) / blur5 (5 taps, +-1.5 sigma), both sampled with bilinear
 * filtering so they stay smooth for any sigma.
 */
export const BLUR_COMMON = /* glsl */ `
precision highp float;
precision highp sampler2D;

uniform sampler2D uLine;
uniform sampler2D uWash;
uniform vec2  uTexel;      // 1 / target size
uniform float uSigmaLine;  // device px
uniform float uSigmaWash;  // device px

layout(location = 0) out vec4 outLine;
layout(location = 1) out vec4 outWash;

const float W0 = 1.0;
const float W1 = 0.8824969;  // exp(-1/8)
const float W2 = 0.6065307;  // exp(-4/8)
const float W3 = 0.3246525;  // exp(-9/8)
const float W4 = 0.1353353;  // exp(-16/8)
const float WSUM = W0 + 2.0 * (W1 + W2 + W3 + W4);

vec4 blur9(sampler2D src, vec2 uv, vec2 dir, float sigma) {
  vec2 s = dir * uTexel * (0.5 * sigma);
  vec4 c = texture(src, uv) * W0;
  c += (texture(src, uv + s) + texture(src, uv - s)) * W1;
  c += (texture(src, uv + 2.0 * s) + texture(src, uv - 2.0 * s)) * W2;
  c += (texture(src, uv + 3.0 * s) + texture(src, uv - 3.0 * s)) * W3;
  c += (texture(src, uv + 4.0 * s) + texture(src, uv - 4.0 * s)) * W4;
  return c / WSUM;
}

// 5 taps, +-1.5 sigma: enough for the small line blur, 4 fetches cheaper than blur9.
const float V1 = 0.7548396;  // exp(-0.75^2 / 2)
const float V2 = 0.3246525;  // exp(-1.5^2 / 2)
const float VSUM = 1.0 + 2.0 * (V1 + V2);

vec4 blur5(sampler2D src, vec2 uv, vec2 dir, float sigma) {
  vec2 s = dir * uTexel * (0.75 * sigma);
  vec4 c = texture(src, uv);
  c += (texture(src, uv + s) + texture(src, uv - s)) * V1;
  c += (texture(src, uv + 2.0 * s) + texture(src, uv - 2.0 * s)) * V2;
  return c / VSUM;
}
`;
