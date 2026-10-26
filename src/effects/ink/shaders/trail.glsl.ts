import { MAX_ATTRACTORS } from '../../shared/shaders/fullscreen.glsl';
import { BLUR_COMMON } from '../../shared/shaders/blur.glsl';

/**
 * Trail feedback, two separable passes at drawing-buffer resolution, two RGBA layers
 * (multiple render targets, attachment 0 = line, 1 = wash):
 *
 *   line: short memory, small blur. Fresh deposits: thin dark filaments and cores.
 *   wash: long memory, wide blur, drift. Diffused ink: the soft halo and veils.
 *
 * Each layer stores rgb = sum of ink * absorbance (-ln of the attractor colour) and
 * a = sum of ink, so the composite can recover both how much ink is there (a, exactly the
 * M4 single-channel density) and which mixture of inks it is (rgb / a).
 *
 *   H: temp  = (blurH_line(prev.line), blurH_wash(prev.wash at uv - drift(uv)))
 *   V: trail = (blurV_line(temp.line) * fadeLine + density * gainLine,
 *               blurV_wash(temp.wash) * fadeWash + density)
 *
 * The wash blur is a 9-tap gaussian spanning +-2 sigma (line: 5 taps, +-1.5 sigma), sampled
 * with bilinear filtering, so it stays smooth for any sigma. Applied every step to the whole
 * history, older ink has been blurred more often (sigma grows with sqrt(age)), which is how
 * ink diffuses in water. Drift moves the wash slowly away from the nearest attractor with a
 * gentle swirl.
 */
export const BLUR_H_FRAG = /* glsl */ `
${BLUR_COMMON}
uniform vec2  uAttractors[${MAX_ATTRACTORS}];   // uv space
uniform int   uAttractorCount;
uniform float uAspect;   // width / height
uniform float uDrift;    // device px this update
uniform float uTime;

void main() {
  vec2 uv = gl_FragCoord.xy * uTexel;
  // Aspect-correct space (x scaled) so the radial direction is round on screen.
  vec2 p = vec2(uv.x * uAspect, uv.y);
  // Outward direction blended over all attractors (inverse-square weights) rather than
  // from the nearest one only, so there is no seam on the line halfway between two cores.
  vec2 radial = vec2(0.0);
  float wsum = 0.0;
  float dist = 1e9;
  for (int i = 0; i < ${MAX_ATTRACTORS}; i++) {
    if (i >= uAttractorCount) break;
    vec2 a = vec2(uAttractors[i].x * uAspect, uAttractors[i].y);
    vec2 d = p - a;
    float l = max(length(d), 1e-4);
    float w = 1.0 / (l * l + 0.01);
    radial += d / l * w;
    wsum += w;
    dist = min(dist, l);
  }
  radial /= max(wsum, 1e-6);
  // Slow swirl: a low-frequency rotational field, so the wash curls a little as it spreads.
  float t = uTime * 0.05;
  vec2 swirl = vec2(sin(p.y * 3.1 + t * 1.3) + sin(p.y * 1.7 - t), cos(p.x * 2.7 - t * 0.9) + cos(p.x * 1.3 + t * 1.1)) * 0.35;
  // Full speed outside the core, none at its centre (keeps the core dense).
  vec2 dir = radial * smoothstep(0.0, 0.15, dist) + swirl;
  vec2 src = uv - dir * uDrift * uTexel;
  outLine = blur5(uLine, uv, vec2(1.0, 0.0), uSigmaLine);
  outWash = blur9(uWash, src, vec2(1.0, 0.0), uSigmaWash);
}
`;

export const BLUR_V_FRAG = /* glsl */ `
${BLUR_COMMON}
uniform sampler2D uDensity;
uniform vec2  uFade;     // line, wash fade for this update (already pow(fade, steps))
uniform float uLineGain; // deposit gain of the line layer (point size compensation)

void main() {
  vec2 uv = gl_FragCoord.xy * uTexel;
  vec4 d = texelFetch(uDensity, ivec2(gl_FragCoord.xy), 0);
  outLine = blur5(uLine, uv, vec2(0.0, 1.0), uSigmaLine) * uFade.x + d * uLineGain;
  outWash = blur9(uWash, uv, vec2(0.0, 1.0), uSigmaWash) * uFade.y + d;
}
`;

/**
 * Composite to screen: trail -> optical density -> contrast -> paper/ink mix -> grain.
 *
 * Coverage comes from the a channels exactly as in M4 (single ink). The ink colour is the
 * mixture of the inks present: mean absorbance K = rgb / a per layer, weighted by layer
 * coverage, colour = exp(-K). Mixing in absorbance (log) space multiplies the colours, so
 * indigo over oxblood gives a dark violet-brown, not an average or an overlay; overlapping
 * ink is also denser (a adds), so it gets darker. With all three colours equal this reduces
 * to M4 exactly.
 */
export const COMPOSITE_FRAG = /* glsl */ `
precision highp float;
precision highp int;
precision highp sampler2D;

uniform sampler2D uLine;
uniform sampler2D uWash;
uniform float uExposure;
uniform float uWashGain;  // wash gain
uniform float uWashMax;   // wash alone never gets darker than this
uniform float uContrast;
uniform float uPivot;
uniform vec3  uPaper;     // sRGB
uniform float uGrain;
uniform float uGrainCell; // grain cell size, device px (= dpr, so it reads the same on 2x)
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
  vec4 L = max(texelFetch(uLine, px, 0), 0.0);
  vec4 W = max(texelFetch(uWash, px, 0), 0.0);
  vec2 t = vec2(L.a, W.a);
  // Optical density: dense regions approach full ink smoothly instead of clipping.
  // Lines can reach solid ink; the wash saturates at a mid grey, so veils stay soft and
  // only real line density makes a core black. Layers combine like two glazes.
  float line = 1.0 - exp(-t.r * uExposure);
  float wash = uWashMax * (1.0 - exp(-t.g * uWashGain * uExposure / uWashMax));
  float ink = 1.0 - (1.0 - line) * (1.0 - wash);
  ink = clamp(contrastCurve(ink, uContrast, uPivot), 0.0, 1.0);

  // Ink mixture: mean absorbance per layer, layers weighted by their coverage.
  vec3 kLine = L.rgb / max(L.a, 1e-6);
  vec3 kWash = W.rgb / max(W.a, 1e-6);
  vec3 k = (kLine * line + kWash * wash) / max(line + wash, 1e-6);
  vec3 inkCol = exp(-k);

  vec2 q = gl_FragCoord.xy * uPaperScale;
  float tex = (vnoise(q) + 0.5 * vnoise(q * 2.3 + 17.0)) / 1.5 - 0.5;
  vec3 paper = uPaper * (1.0 + tex * 2.0 * uPaperTex);

  vec3 col = mix(paper, inkCol, ink);
  // Film grain in CSS-px cells: a light floor everywhere (paper tooth), strongest in the
  // midtones, so 0.25 reads as texture and 1.0 as grit.
  uvec2 cell = uvec2(gl_FragCoord.xy / uGrainCell);
  float n = hash01(uvec3(cell, uFrame)) - 0.5;
  col += n * uGrain * (0.07 + 0.38 * (4.0 * ink * (1.0 - ink)));
  outColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
`;
