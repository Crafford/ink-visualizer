/** Minimal DOM helpers. No framework: components are functions returning { el, dispose }. */

export interface Component<E extends HTMLElement = HTMLElement> {
  el: E;
  dispose(): void;
}

type Attrs = Record<string, string | number | boolean | undefined | null | EventListener>;
type Child = Node | string | null | undefined | false;

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K, attrs: Attrs = {}, ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v as EventListener);
    else if (k === 'class') el.className = String(v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, String(v));
  }
  for (const c of children) if (c) el.append(c);
  return el;
}

/** Parse a trusted inline SVG string (icons only). */
export function svg(markup: string): SVGSVGElement {
  const t = document.createElement('template');
  t.innerHTML = markup.trim();
  return t.content.firstElementChild as SVGSVGElement;
}

let uid = 0;
export const nextId = (prefix: string) => `${prefix}-${++uid}`;

/** Collects teardown functions. */
export class Disposer {
  private fns: (() => void)[] = [];
  add(fn: () => void): void { this.fns.push(fn); }
  dispose(): void { for (const fn of this.fns.splice(0)) fn(); }
}
