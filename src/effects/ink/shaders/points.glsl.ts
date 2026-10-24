/**
 * Particle draw. No vertex attributes: gl_VertexID indexes the state textures
 * (row-major, width uSize), so the draw count alone decides how many particles render.
 */
export const POINTS_VERT = /* glsl */ `
precision highp float;
precision highp int;
precision highp sampler2D;

uniform sampler2D uStateA;
uniform sampler2D uStateB;
uniform int   uSize;
uniform float uAspect;
uniform float uPointSize;   // device pixels
uniform float uOpacity;

out float vAlpha;

void main() {
  ivec2 c = ivec2(gl_VertexID % uSize, gl_VertexID / uSize);
  vec4 a = texelFetch(uStateA, c, 0);
  vec4 b = texelFetch(uStateB, c, 0);
  float t = b.x / max(b.y, 1e-3);
  // Fade out over the last 20% of life, and in over the first 3% so respawns do not pop.
  vAlpha = uOpacity * (1.0 - smoothstep(0.8, 1.0, t)) * smoothstep(0.0, 0.03, t);
  gl_Position = vec4(a.x / uAspect, a.y, 0.0, 1.0);
  gl_PointSize = uPointSize;
}
`;

export const POINTS_FRAG = /* glsl */ `
precision highp float;

uniform vec3 uInk;
uniform bool uRound;

in float vAlpha;
out vec4 outColor;

void main() {
  float a = vAlpha;
  if (uRound) {
    // Only for points >= 3 px; at 1-2 px the sprite is a square anyway.
    float d = length(gl_PointCoord - 0.5);
    a *= 1.0 - smoothstep(0.35, 0.5, d);
  }
  outColor = vec4(uInk, a);
}
`;
