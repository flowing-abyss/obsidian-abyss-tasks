import { addIcon } from 'obsidian';
import { describe, expect, it, vi } from 'vitest';
import { buildDefaultTaskStatuses } from '../src/settings/defaults';
import { StatusRegistry } from '../src/status/StatusRegistry';
import { renderStatusMarker } from '../src/ui/StatusMarker';

const reg = new StatusRegistry(buildDefaultTaskStatuses());

describe('renderStatusMarker', () => {
  it('exposes checkbox semantics and completion state from the status definition', () => {
    for (const [symbol, checked, name] of [
      ['x', 'true', 'Done'],
      [' ', 'false', 'To-do'],
      ['/', 'false', 'In progress'],
      ['-', 'false', 'Cancelled'],
    ] as const) {
      const parent = document.createElement('div');
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
    const parent = document.createElement('div');
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
    const parent = document.createElement('div');
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

  it('styles inert preview markers with the default cursor', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const css = readFileSync(resolve(import.meta.dirname, '..', 'styles.css'), 'utf8');
    const rule = /\.abyss-status-marker--inert\s*\{([^}]*)\}/u.exec(css)?.[1] ?? '';

    expect(rule).toMatch(/cursor:\s*default/u);
  });

  it('renders a chip with the type + priority data attrs and an icon (no color)', () => {
    const parent = document.createElement('div');
    const el = renderStatusMarker(parent, {
      task: { statusSymbol: '!', priority: 'A' } as any,
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
    const parent = document.createElement('div');
    const el = renderStatusMarker(parent, {
      task: { statusSymbol: '/', priority: 'D' } as any,
      registry: reg,
      onLeftClick: () => {},
      onContextMenu: () => {},
    });
    expect(el.getAttribute('data-status-type')).toBe('in-progress');
  });

  it('keeps default and custom in-progress markers circular after both menu sizing rules', async () => {
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
      const el = renderStatusMarker(document.createElement('div'), {
        task: { statusSymbol: symbol, priority: 'D' },
        registry,
        onLeftClick: () => {},
        onContextMenu: () => {},
      });
      expect(el.getAttribute('data-status-type')).toBe('in-progress');
    }

    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const css = readFileSync(resolve(import.meta.dirname, '..', 'styles.css'), 'utf8');
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
    const parent = document.createElement('div');
    const el = renderStatusMarker(parent, {
      task: { statusSymbol: ' ', priority: 'D' } as any,
      registry: reg,
      onLeftClick: () => {},
      onContextMenu: () => {},
    });
    expect(el.getAttribute('data-priority')).toBeNull(); // D → no ring
    expect(el.textContent).toBe('');
  });

  it('fires callbacks on click and contextmenu', () => {
    const parent = document.createElement('div');
    const left = vi.fn();
    const ctx = vi.fn();
    const el = renderStatusMarker(parent, {
      task: { statusSymbol: 'x', priority: 'D' } as any,
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
    const parent = document.createElement('div');
    const parentClick = vi.fn();
    parent.addEventListener('click', parentClick);
    const left = vi.fn();
    const el = renderStatusMarker(parent, {
      task: { statusSymbol: 'x', priority: 'D' } as any,
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
    const parent = document.createElement('div');
    const el = renderStatusMarker(parent, {
      task: { statusSymbol: 'x', priority: 'D' } as any,
      registry: reg,
      onLeftClick: () => {},
      onContextMenu: () => {},
    });
    const svg = el.querySelector('svg');
    expect(svg).not.toBeNull();
  });

  it('renders unknown status glyph on neutral chip', () => {
    const parent = document.createElement('div');
    const el = renderStatusMarker(parent, {
      task: { statusSymbol: '@', priority: 'D' } as any,
      registry: reg,
      onLeftClick: () => {},
      onContextMenu: () => {},
    });
    expect(el.getAttribute('data-status')).toBe('other');
    expect(el.textContent).toBe('@');
  });
});
