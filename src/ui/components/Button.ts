import { h } from '../dom';

export interface ButtonOpts {
  label: string;
  onClick: (e: MouseEvent) => void;
  /** Primary: ink border and text instead of hairline grey. */
  primary?: boolean;
  title?: string;
}

/** Flat 28px button with a hairline border and no fill. */
export function createButton({ label, onClick, primary, title }: ButtonOpts): HTMLButtonElement {
  return h('button', {
    class: primary ? 'btn btn-primary' : 'btn', type: 'button', title,
    onclick: onClick as EventListener,
  }, label);
}
