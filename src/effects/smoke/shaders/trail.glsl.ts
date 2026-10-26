import { DENSITY_PREFILTER_GLSL } from '../../shared/subpixel';
import { BLUR_COMMON } from '../../shared/shaders/blur.glsl';

/**
 * Smoke trail feedback: the same two-layer separable scheme as ink (line = short memory,
 * Softness blur; wash = long memory, Haze blur), but the wash drifts upward (warm air) with a
 * slow sideways sway instead of outward from the sources.
 *
 *   H: temp  = (blurH_line(prev.line), blurH_wash(prev.wash at uv - drift(uv)))
 *   V: trail = (blurV_line(temp.line) * fadeLine + density.line, blurV_wash(temp.wash) * fadeWash + density.wash)
 *   (density.wash is the same splat weighted down while a ring is intact: no smeared wake behind a ring)
 */
export const SMOKE_BLUR_H_FRAG = /* glsl */ `
${BLUR_COMMON}
uniform float uAspect;   // width / height
uniform float uDrift;    // device px this update
uniform float uTime;

void main() {
  vec2 uv = gl_FragCoord.xy * uTexel;
  vec2 p = vec2(uv.x * uAspect, uv.y);
  float t = uTime * 0.07;
  float sway = 0.35 * (sin(p.y * 3.3 - t * 1.4) + 0.6 * sin(p.y * 7.1 + p.x * 2.0 + t));
  vec2 src = uv - vec2(sway, 1.0) * uDrift * uTexel;
  outLine = blur5(uLine, uv, vec2(1.0, 0.0), uSigmaLine);
  outWash = blur9(uWash, src, vec2(1.0, 0.0), uSigmaWash);
}
`;

export const SMOKE_BLUR_V_FRAG = /* glsl */ `
${BLUR_COMMON}
uniform sampler2D uDensity;      // line deposit
uniform sampler2D uDensityWash;  // wash deposit (young rings put little into the haze)
uniform sampler2D uDensityHalf;      // the same at half resolution (Size < 0.5 px, shared/subpixel.ts)
uniform sampler2D uDensityWashHalf;
uniform vec2  uFade;     // line, wash fade for this update (already pow(fade, steps))
${DENSITY_PREFILTER_GLSL}
void main() {
  vec2 uv = gl_FragCoord.xy * uTexel;
  vec4 d = densityAt(uDensity, uDensityHalf, gl_FragCoord.xy);  // + sub-pixel Size pre-filter
  vec4 dw = densityAt(uDensityWash, uDensityWashHalf, gl_FragCoord.xy);
  outLine = blur5(uLine, uv, vec2(0.0, 1.0), uSigmaLine) * uFade.x + d;
  outWash = blur9(uWash, uv, vec2(0.0, 1.0), uSigmaWash) * uFade.y + dw;
}
`;

/**
 * Composite to screen, two modes:
 *
 *   light paper (uDark false), subtractive as ink: coverage from the a channels (line + capped
 *     wash, contrast S-curve), colour = exp(-mean absorbance), mix(background, colour, coverage)
 *     + a faint paper texture.
 *   dark (uDark true), additive light: the rgb channels hold colour x density, so per channel
 *     E = line.rgb + wash.rgb x washGain, light = 1 - exp(-E) (tone mapped), contrast S-curve on
 *     the light, result = background + (1 - background) x light.
 *
 * Grain as ink's: a light floor everywhere, strongest in the midtones.
 */
export const SMOKE_COMPOSITE_FRAG = /* glsl */ `
precision highp float;
precision highp int;
precision highp sampler2D;

uniform sampler2D uLine;
uniform sampler2D uWash;
uniform bool  uDark;
uniform float uExposure;
uniform float uWashGain;
uniform float uWashMax;   // light mode: wash alone never gets darker than this
uniform float uContrast;
uniform float uPivot;
uniform vec3  uBackground; // sRGB
uniform float uGrain;
uniform float uGrainCell;
uniform float uPaperTex;
uniform float uPaperScale;
uniform uint  uFrame;

out vec4 outColor;

uint hash(uvec3 v) {
  v = v * 1664525u + 1013904223u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  v ^= v >> 16u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  return v.x;
}
float hash01(uvec3 v) { return float(hash(v)) * (1.0 / 4294967296.0); }

float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  uvec2 ii = uvec2(ivec2(i) + 4096);
  float a = hash01(uvec3(ii, 7u));
  float b = hash01(uvec3(ii + uvec2(1u, 0u), 7u));
  float c = hash01(uvec3(ii + uvec2(0u, 1u), 7u));
  float d = hash01(uvec3(ii + uvec2(1u, 1u), 7u));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

float contrastCurve(float x, float c, float p) {
  return x < p
    ? p * pow(x / p, c)
    : 1.0 - (1.0 - p) * pow((1.0 - x) / (1.0 - p), c);
}

void main() {
  ivec2 px = ivec2(gl_FragCoord.xy);
  vec4 L = max(texelFetch(uLine, px, 0), 0.0);
  vec4 W = max(texelFetch(uWash, px, 0), 0.0);
  vec3 col;
  float amount;
  if (uDark) {
    vec3 E = (L.rgb + W.rgb * uWashGain) * uExposure;
    vec3 light = 1.0 - exp(-E);
    light = vec3(contrastCurve(light.r, uContrast, uPivot), contrastCurve(light.g, uContrast, uPivot), contrastCurve(light.b, uContrast, uPivot));
    light = clamp(light, 0.0, 1.0);
    col = uBackground + (1.0 - uBackground) * light;
    amount = max(light.r, max(light.g, light.b));
  } else {
    float line = 1.0 - exp(-L.a * uExposure);
    float wash = uWashMax * (1.0 - exp(-W.a * uWashGain * uExposure / uWashMax));
    float ink = 1.0 - (1.0 - line) * (1.0 - wash);
    ink = clamp(contrastCurve(ink, uContrast, uPivot), 0.0, 1.0);
    vec3 kLine = L.rgb / max(L.a, 1e-6);
    vec3 kWash = W.rgb / max(W.a, 1e-6);
    vec3 k = (kLine * line + kWash * wash) / max(line + wash, 1e-6);
    vec2 q = gl_FragCoord.xy * uPaperScale;
    float tex = (vnoise(q) + 0.5 * vnoise(q * 2.3 + 17.0)) / 1.5 - 0.5;
    vec3 paper = uBackground * (1.0 + tex * 2.0 * uPaperTex);
    col = mix(paper, exp(-k), ink);
    amount = ink;
  }
  uvec2 cell = uvec2(gl_FragCoord.xy / uGrainCell);
  float n = hash01(uvec3(cell, uFrame)) - 0.5;
  col += n * uGrain * (0.07 + 0.38 * (4.0 * amount * (1.0 - amount)));
  outColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
`;
