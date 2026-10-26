/**
 * Fullscreen triangle from gl_VertexID: no vertex buffer at all.
 * Shared by every full-target pass (simulation, trail, composite).
 */
export const FULLSCREEN_VERT = /* glsl */ `
precision highp float;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}
`;
