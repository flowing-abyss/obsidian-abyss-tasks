import { selectorSpecificity } from '@csstools/selector-specificity';
import { addIcon } from 'obsidian';
import selectorParser from 'postcss-selector-parser';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { buildDefaultTaskStatuses } from '../src/settings/defaults';
import { StatusRegistry } from '../src/status/StatusRegistry';
import { renderStatusMarker, setStatusMarkerCompletionBlocked } from '../src/ui/StatusMarker';
import { cssDeclarationsFor, cssDeclarationValue, expectDefined } from './helpers';
import { expandCompoundSelectorLists } from './support/expandedCss';

const reg = new StatusRegistry(buildDefaultTaskStatuses());

function styles(): string {
  const path = ts.sys.resolvePath(`${import.meta.dirname}/../styles.css`);
  const content = ts.sys.readFile(path);
  if (content === undefined) throw new Error(`Unable to read ${path}`);
  return expandCompoundSelectorLists(content);
}

function legacySpanResetSelector(css: string): string {
  return expectDefined(
    /(\.tasksCalendar span[^{}]*)\{\s*display: contents;/u.exec(css)?.[1],
  ).trim();
}

describe('renderStatusMarker', () => {
  it('keeps modern control and indicator geometry outside the legacy codeblock span reset', () => {
    const css = styles();
    const selector = legacySpanResetSelector(css);
    expect(cssDeclarationValue(cssDeclarationsFor(css, selector), 'display')).toBe('contents');
    expect(
      cssDeclarationValue(cssDeclarationsFor(css, '.tasksCalendar span'), 'display'),
    ).toBeUndefined();
    const calendar = createDiv({ cls: 'tasksCalendar' });
    expect(calendar.createSpan({ cls: 'inner' }).matches(selector)).toBe(true);
    for (const cls of [
      'abyss-status-marker',
      'abyss-status-control',
      'abyss-dep-indicator',
      'abyss-dep-divider',
      'abyss-dep-count-blocked-by',
      'abyss-recurrence-badge-icon',
    ]) {
      expect(calendar.createSpan({ cls }).matches(selector), cls).toBe(false);
    }
  });

  it('keeps the legacy span reset below the toolbar count display rule in the cascade', () => {
    const css = styles();
    const reset = selectorParser().astSync(legacySpanResetSelector(css)).first;
    const count = selectorParser().astSync('.tasksCalendar .stat-count').first;

    expect(selectorSpecificity(reset)).toEqual({ a: 0, b: 1, c: 1 });
    expect(selectorSpecificity(count)).toEqual({ a: 0, b: 2, c: 0 });
    expect(
      cssDeclarationValue(cssDeclarationsFor(css, '.tasksCalendar .stat-count'), 'display'),
    ).toBe('inline-block');
  });

  it('preserves owner-document focus when a mounted marker becomes blocked', () => {
    const frame = activeDocument.body.createEl('iframe');
    const ownerDocument = expectDefined(frame.contentDocument);
    const parent = activeDocument.body.createDiv();
    const left = vi.fn();
    const marker = renderStatusMarker(parent, {
      task: { statusSymbol: ' ' },
      registry: reg,
      onLeftClick: left,
      onContextMenu: () => {},
    });
    ownerDocument.body.append(parent);
    try {
      marker.focus();
      expect(ownerDocument.activeElement).toBe(marker);
      setStatusMarkerCompletionBlocked(marker, true);
      const wrapper = expectDefined(parent.querySelector<HTMLElement>('.abyss-status-control'));
      expect(ownerDocument.activeElement).toBe(wrapper);
      expect(wrapper.getAttribute('aria-disabled')).toBe('true');
      expect(wrapper.getAttribute('role')).toBe('checkbox');
      expect(marker.getAttribute('aria-hidden')).toBe('true');
      marker.dispatchEvent(new Event('pointerdown', { bubbles: true, cancelable: true }));
      for (const detail of [1, 0])
        marker.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail }));
      expect(left).not.toHaveBeenCalled();
      wrapper.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
      );
      wrapper.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', repeat: true }));
      expect(left).toHaveBeenCalledOnce();
      setStatusMarkerCompletionBlocked(marker, false);
      expect(ownerDocument.activeElement).toBe(marker);
      const other = parent.createEl('button');
      other.focus();
      setStatusMarkerCompletionBlocked(marker, true);
      expect(ownerDocument.activeElement).toBe(other);
    } finally {
      frame.remove();
    }
  });

  it('exposes checkbox semantics and completion state from the status definition', () => {
    for (const [symbol, checked, name] of [
      ['x', 'true', 'Done'],
      [' ', 'false', 'To-do'],
      ['/', 'false', 'In progress'],
      ['-', 'false', 'Cancelled'],
    ] as const) {
      const parent = createDiv();
      const el = renderStatusMarker(parent, {
        task: { statusSymbol: symbol, priority: 'D' },
        registry: reg,
        onLeftClick: () => {},
        onContextMenu: () => {},
      });

      expect(el.getAttribute('role')).toBe('checkbox');
      expect(el.getAttribute('aria-checked')).toBe(checked);
      expect(el.getAttribute('aria-label')).toBe(`Task status: ${name}`);
      expect(el.getAttribute('tabindex')).toBe('0');
    }
  });

  it.each(['Enter', ' '])('activates with %j and prevents the default keyboard action', (key) => {
    const parent = createDiv();
    const left = vi.fn();
    const el = renderStatusMarker(parent, {
      task: { statusSymbol: ' ', priority: 'D' },
      registry: reg,
      onLeftClick: left,
      onContextMenu: () => {},
    });
    const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });

    el.dispatchEvent(event);

    expect(left).toHaveBeenCalledOnce();
    expect(event.defaultPrevented).toBe(true);
  });

  it('renders an inert visual marker when interactive is false', () => {
    const parent = createDiv();
    const left = vi.fn();
    const context = vi.fn();
    const el = renderStatusMarker(parent, {
      task: { statusSymbol: '/', priority: 'A' },
      registry: reg,
      interactive: false,
      onLeftClick: left,
      onContextMenu: context,
    });

    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));

    expect(el.getAttribute('data-status-type')).toBe('in-progress');
    expect(el.getAttribute('data-priority')).toBe('A');
    expect(el.hasAttribute('role')).toBe(false);
    expect(el.hasAttribute('aria-checked')).toBe(false);
    expect(el.hasAttribute('aria-label')).toBe(false);
    expect(el.hasAttribute('tabindex')).toBe(false);
    expect(el.classList.contains('abyss-status-marker--inert')).toBe(true);
    expect(left).not.toHaveBeenCalled();
    expect(context).not.toHaveBeenCalled();
  });

  it('allows only the context menu on a context-menu-only inert marker', () => {
    const parent = createDiv();
    const parentClick = vi.fn();
    const left = vi.fn();
    const context = vi.fn();
    parent.addEventListener('click', parentClick);
    const el = renderStatusMarker(parent, {
      task: { statusSymbol: '/', priority: 'A' },
      registry: reg,
      interactive: 'menu',
      onLeftClick: left,
      onContextMenu: context,
    });
    const contextEvent = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });

    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    el.dispatchEvent(contextEvent);

    expect(left).not.toHaveBeenCalled();
    expect(context).toHaveBeenCalledOnce();
    expect(contextEvent.defaultPrevented).toBe(true);
    expect(parentClick).not.toHaveBeenCalled();
  });

  it('exposes a context-menu-only marker as a keyboard-reachable menu trigger', () => {
    const context = vi.fn();
    const parent = activeDocument.body.createDiv();
    const el = renderStatusMarker(parent, {
      task: { statusSymbol: '/', priority: 'A' },
      registry: reg,
      interactive: 'menu',
      onLeftClick: () => {},
      onContextMenu: context,
    });
    el.focus();
    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, detail: 0 });
    el.dispatchEvent(event);

    expect(el.getAttribute('role')).toBe('img');
    expect(el.getAttribute('aria-label')).toBe('In progress');
    expect(el.getAttribute('aria-haspopup')).toBe('menu');
    expect(el.getAttribute('tabindex')).toBe('0');
    expect(el.hasAttribute('aria-checked')).toBe(false);
    expect(el.ownerDocument.activeElement).toBe(el);
    expect(context).toHaveBeenCalledOnce();
    expect(event.defaultPrevented).toBe(true);
    parent.remove();
  });

  it('styles inert preview markers with the default cursor', () => {
    const css = styles();
    const rule = /\.abyss-status-marker--inert\s*\{([^}]*)\}/u.exec(css)?.[1] ?? '';

    expect(rule).toMatch(/cursor:\s*default/u);
  });

  it('renders a chip with the type + priority data attrs and an icon (no color)', () => {
    const parent = createDiv();
    const el = renderStatusMarker(parent, {
      task: { statusSymbol: '!', priority: 'A' },
      registry: reg,
      onLeftClick: () => {},
      onContextMenu: () => {},
    });
    expect(el.classList.contains('abyss-status-marker')).toBe(true);
    expect(el.getAttribute('data-status-type')).toBe('todo');
    expect(el.getAttribute('data-priority')).toBe('A');
    expect(el.style.getPropertyValue('--abyss-status-color')).toBe('');
  });

  it('renders the in-progress group with data-status-type used for circular shape', () => {
    const parent = createDiv();
    const el = renderStatusMarker(parent, {
      task: { statusSymbol: '/', priority: 'D' },
      registry: reg,
      onLeftClick: () => {},
      onContextMenu: () => {},
    });
    expect(el.getAttribute('data-status-type')).toBe('in-progress');
  });

  it('keeps default and custom in-progress markers circular after both menu sizing rules', () => {
    const registry = new StatusRegistry([
      ...reg.all(),
      {
        id: 'status-waiting',
        symbol: 'w',
        name: 'Waiting',
        type: 'in-progress',
        icon: '',
        core: false,
      },
    ]);
    for (const symbol of ['/', 'w']) {
      const el = renderStatusMarker(createDiv(), {
        task: { statusSymbol: symbol, priority: 'D' },
        registry,
        onLeftClick: () => {},
        onContextMenu: () => {},
      });
      expect(el.getAttribute('data-status-type')).toBe('in-progress');
    }

    const css = styles();
    const popoverSizing = css.indexOf('.abyss-status-popover-row .abyss-status-marker {');
    const nativeSizing = css.indexOf('.menu-item-icon .abyss-status-marker {');
    const circularOverride = css.indexOf(
      ".abyss-status-popover-row .abyss-status-marker[data-status-type='in-progress']",
    );
    const nativeCircularOverride = css.indexOf(
      ".menu-item-icon .abyss-status-marker[data-status-type='in-progress']",
    );
    expect(circularOverride).toBeGreaterThan(popoverSizing);
    expect(circularOverride).toBeGreaterThan(nativeSizing);
    expect(nativeCircularOverride).toBeGreaterThan(nativeSizing);
    expect(nativeCircularOverride).toBeLessThan(css.indexOf('{', circularOverride));
    expect(css.slice(circularOverride, css.indexOf('}', circularOverride))).toContain(
      'border-radius: 50%',
    );
  });

  it('renders an empty chip for to-do (no icon)', () => {
    const parent = createDiv();
    const el = renderStatusMarker(parent, {
      task: { statusSymbol: ' ', priority: 'D' },
      registry: reg,
      onLeftClick: () => {},
      onContextMenu: () => {},
    });
    expect(el.getAttribute('data-priority')).toBeNull(); // D → no ring
    expect(el.textContent).toBe('');
  });

  it('fires callbacks on click and contextmenu', () => {
    const parent = createDiv();
    const left = vi.fn();
    const ctx = vi.fn();
    const el = renderStatusMarker(parent, {
      task: { statusSymbol: 'x', priority: 'D' },
      registry: reg,
      onLeftClick: left,
      onContextMenu: ctx,
    });
    el.dispatchEvent(new MouseEvent('click'));
    el.dispatchEvent(new MouseEvent('contextmenu'));
    expect(left).toHaveBeenCalledOnce();
    expect(ctx).toHaveBeenCalledOnce();
  });

  it('stops click propagation so a parent card click handler does not also fire', () => {
    const parent = createDiv();
    const parentClick = vi.fn();
    parent.addEventListener('click', parentClick);
    const left = vi.fn();
    const el = renderStatusMarker(parent, {
      task: { statusSymbol: 'x', priority: 'D' },
      registry: reg,
      onLeftClick: left,
      onContextMenu: () => {},
    });
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(left).toHaveBeenCalledOnce();
    expect(parentClick).not.toHaveBeenCalled();
  });

  it('renders an <svg> child for a status with an icon (e.g. Done)', () => {
    addIcon('check', '<svg><path d="M20 6 9 17l-5-5"/></svg>');
    const parent = createDiv();
    const el = renderStatusMarker(parent, {
      task: { statusSymbol: 'x', priority: 'D' },
      registry: reg,
      onLeftClick: () => {},
      onContextMenu: () => {},
    });
    const svg = el.querySelector('svg');
    expect(svg).not.toBeNull();
  });

  it('renders unknown status glyph on neutral chip', () => {
    const parent = createDiv();
    const el = renderStatusMarker(parent, {
      task: { statusSymbol: '@', priority: 'D' },
      registry: reg,
      onLeftClick: () => {},
      onContextMenu: () => {},
    });
    expect(el.getAttribute('data-status')).toBe('other');
    expect(el.textContent).toBe('@');
  });
});
