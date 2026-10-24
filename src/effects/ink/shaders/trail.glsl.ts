import { MAX_ATTRACTORS } from './sim.glsl';

/**
 * Trail feedback, two separable passes at drawing-buffer resolution, two channels:
 *
 *   R "line": short memory, almost no blur. Fresh deposits: thin dark filaments and cores.
 *   G "wash": long memory, wide blur, drift. Diffused ink: the soft grey halo and veils.
 *
 *   H: temp  = (blurH_line(prev.r), blurH_wash(prev.g at uv - drift(uv)))
 *   V: trail = (blurV_line(temp.r) * fadeLine + density, blurV_wash(temp.g) * fadeWash + density)
 *
 * The wash blur is a 9-tap gaussian spanning +-2 sigma (line: 5 taps, +-1.5 sigma), sampled with bilinear filtering, so it
 * stays smooth for any sigma. Applied every step to the whole history, older ink has been
 * blurred more often (sigma grows with sqrt(age)), which is how ink diffuses in water.
 * Drift moves the wash slowly away from the nearest attractor with a gentle swirl.
 */
const BLUR_COMMON = /* glsl */ `
precision highp float;
precision highp sampler2D;

uniform sampler2D uSrc;
uniform vec2  uTexel;      // 1 / target size
uniform float uSigmaLine;  // device px
uniform float uSigmaWash;  // device px

const float W0 = 1.0;
const float W1 = 0.8824969;  // exp(-1/8)
const float W2 = 0.6065307;  // exp(-4/8)
const float W3 = 0.3246525;  // exp(-9/8)
const float W4 = 0.1353353;  // exp(-16/8)
const float WSUM = W0 + 2.0 * (W1 + W2 + W3 + W4);

vec4 blur9(vec2 uv, vec2 dir, float sigma) {
  vec2 s = dir * uTexel * (0.5 * sigma);
  vec4 c = texture(uSrc, uv) * W0;
  c += (texture(uSrc, uv + s) + texture(uSrc, uv - s)) * W1;
  c += (texture(uSrc, uv + 2.0 * s) + texture(uSrc, uv - 2.0 * s)) * W2;
  c += (texture(uSrc, uv + 3.0 * s) + texture(uSrc, uv - 3.0 * s)) * W3;
  c += (texture(uSrc, uv + 4.0 * s) + texture(uSrc, uv - 4.0 * s)) * W4;
  return c / WSUM;
}

// 5 taps, +-1.5 sigma: enough for the small line blur, 4 fetches cheaper than blur9.
const float V1 = 0.7548396;  // exp(-0.75^2 / 2)
const float V2 = 0.3246525;  // exp(-1.5^2 / 2)
const float VSUM = 1.0 + 2.0 * (V1 + V2);

vec4 blur5(vec2 uv, vec2 dir, float sigma) {
  vec2 s = dir * uTexel * (0.75 * sigma);
  vec4 c = texture(uSrc, uv);
  c += (texture(uSrc, uv + s) + texture(uSrc, uv - s)) * V1;
  c += (texture(uSrc, uv + 2.0 * s) + texture(uSrc, uv - 2.0 * s)) * V2;
  return c / VSUM;
}
`;

export const BLUR_H_FRAG = /* glsl */ `
${BLUR_COMMON}
uniform vec2  uAttractors[${MAX_ATTRACTORS}];   // uv space
uniform int   uAttractorCount;
uniform float uAspect;   // width / height
uniform float uDrift;    // device px this update
uniform float uTime;

out vec4 outColor;

void main() {
  vec2 uv = gl_FragCoord.xy * uTexel;
  // Aspect-correct space (x scaled) so the radial direction is round on screen.
  vec2 p = vec2(uv.x * uAspect, uv.y);
  vec2 best = vec2(0.0, 1.0);
  float bestD2 = 1e9;
  for (int i = 0; i < ${MAX_ATTRACTORS}; i++) {
    if (i >= uAttractorCount) break;
    vec2 a = vec2(uAttractors[i].x * uAspect, uAttractors[i].y);
    vec2 d = p - a;
    float d2 = dot(d, d);
    if (d2 < bestD2) { bestD2 = d2; best = d; }
  }
  float dist = sqrt(bestD2);
  vec2 radial = best / max(dist, 1e-4);
  // Slow swirl: a low-frequency rotational field, so the wash curls a little as it spreads.
  float t = uTime * 0.05;
  vec2 swirl = vec2(sin(p.y * 3.1 + t * 1.3) + sin(p.y * 1.7 - t), cos(p.x * 2.7 - t * 0.9) + cos(p.x * 1.3 + t * 1.1)) * 0.35;
  // Full speed outside the core, none at its centre (keeps the core dense).
  vec2 dir = radial * smoothstep(0.0, 0.15, dist) + swirl;
  vec2 src = uv - dir * uDrift * uTexel;
  float line = blur5(uv, vec2(1.0, 0.0), uSigmaLine).r;
  float wash = blur9(src, vec2(1.0, 0.0), uSigmaWash).g;
  outColor = vec4(line, wash, 0.0, 1.0);
}
`;

export const BLUR_V_FRAG = /* glsl */ `
${BLUR_COMMON}
uniform sampler2D uDensity;
uniform vec2  uFade;     // line, wash fade for this update (already pow(fade, steps))

out vec4 outColor;

void main() {
  vec2 uv = gl_FragCoord.xy * uTexel;
  float line = blur5(uv, vec2(0.0, 1.0), uSigmaLine).r;
  float wash = blur9(uv, vec2(0.0, 1.0), uSigmaWash).g;
  float d = texelFetch(uDensity, ivec2(gl_FragCoord.xy), 0).r;
  outColor = vec4(vec2(line, wash) * uFade + d, 0.0, 1.0);
}
`;

/**
 * Composite to screen: trail -> optical density -> contrast -> paper/ink mix -> grain.
 */
export const COMPOSITE_FRAG = /* glsl */ `
precision highp float;
precision highp int;
precision highp sampler2D;

uniform sampler2D uTrail;
uniform float uExposure;
uniform float uWash;      // wash gain
uniform float uWashMax;   // wash alone never gets darker than this
uniform float uContrast;
uniform float uPivot;
uniform vec3  uPaper;     // sRGB
uniform vec3  uInk;       // sRGB
uniform float uGrain;
uniform float uPaperTex;  // amplitude of the paper texture
uniform float uPaperScale; // 1 / feature size in device px
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

// Smooth value noise for the paper.
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

// S-curve around a pivot: slope uContrast at the pivot, fixed at 0 and 1.
float contrastCurve(float x, float c, float p) {
  return x < p
    ? p * pow(x / p, c)
    : 1.0 - (1.0 - p) * pow((1.0 - x) / (1.0 - p), c);
}

void main() {
  ivec2 px = ivec2(gl_FragCoord.xy);
  vec2 t = max(texelFetch(uTrail, px, 0).rg, 0.0);
  // Optical density: dense regions approach full ink smoothly instead of clipping.
  // Lines can reach solid ink; the wash saturates at a mid grey, so veils stay soft and
  // only real line density makes a core black. Layers combine like two glazes.
  float line = 1.0 - exp(-t.r * uExposure);
  float wash = uWashMax * (1.0 - exp(-t.g * uWash * uExposure / uWashMax));
  float ink = 1.0 - (1.0 - line) * (1.0 - wash);
  ink = clamp(contrastCurve(ink, uContrast, uPivot), 0.0, 1.0);

  vec2 q = gl_FragCoord.xy * uPaperScale;
  float tex = (vnoise(q) + 0.5 * vnoise(q * 2.3 + 17.0)) / 1.5 - 0.5;
  vec3 paper = uPaper * (1.0 + tex * 2.0 * uPaperTex);

  vec3 col = mix(paper, uInk, ink);
  // Film grain, mostly in the midtones so paper and solid ink stay clean.
  float n = hash01(uvec3(uvec2(px), uFrame)) - 0.5;
  col += n * uGrain * 0.16 * (4.0 * ink * (1.0 - ink));
  outColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
`;
