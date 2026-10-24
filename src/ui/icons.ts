/** Inline SVG icons, 16px box, 1.5px stroke, currentColor. */
const wrap = (body: string) =>
  `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="square" aria-hidden="true">${body}</svg>`;

export const ICONS = {
  play: wrap('<path d="M4.75 3.25v9.5l7.5-4.75z" stroke-linejoin="miter"/>'),
  pause: wrap('<path d="M5.25 3.5v9M10.75 3.5v9"/>'),
  fullscreen: wrap('<path d="M2.75 6V2.75H6M10 2.75h3.25V6M13.25 10v3.25H10M6 13.25H2.75V10"/>'),
} as const;
