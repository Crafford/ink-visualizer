import { h, nextId, type Component } from '../dom';

export interface TabDef<T extends string> {
  id: T;
  label: string;
}

/**
 * Flat segmented control (WAI-ARIA tabs pattern). Arrow keys move between tabs.
 * Panels are owned by the caller; onChange tells it which one to show.
 */
export function createTabs<T extends string>(
  tabs: readonly TabDef<T>[], initial: T, onChange: (id: T) => void, ariaLabel: string,
): Component & { select(id: T): void; panelIdFor(id: T): string } {
  const base = nextId('tabs');
  const buttons = new Map<T, HTMLButtonElement>();
  const el = h('div', { class: 'tabs', role: 'tablist', 'aria-label': ariaLabel });

  const select = (id: T, focus = false) => {
    for (const [tid, b] of buttons) {
      const on = tid === id;
      b.setAttribute('aria-selected', String(on));
      b.tabIndex = on ? 0 : -1;
      if (on && focus) b.focus();
    }
    onChange(id);
  };

  tabs.forEach((t, i) => {
    const b = h('button', {
      class: 'tab', type: 'button', role: 'tab', id: `${base}-${t.id}`, 'aria-controls': `${base}-${t.id}-panel`,
      onclick: () => select(t.id),
      onkeydown: ((e: KeyboardEvent) => {
        const d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
        if (!d) return;
        e.preventDefault();
        select(tabs[(i + d + tabs.length) % tabs.length].id, true);
      }) as EventListener,
    }, t.label);
    buttons.set(t.id, b);
    el.append(b);
  });
  select(initial);

  return {
    el,
    select: (id) => select(id),
    panelIdFor: (id) => `${base}-${id}-panel`,
    dispose: () => {},
  };
}
