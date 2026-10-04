import { Component } from 'obsidian';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { timelineViewportRows } from '../src/panels/projects/projectTimelineRowModel';
import { ProjectTimelineRows } from '../src/panels/projects/projectTimelineRows';
import { expectDefined } from './helpers';

const owners: ProjectTimelineRows[] = [];
afterEach(() => {
  owners.forEach((owner) => {
    owner.destroy();
  });
  owners.length = 0;
  document.body.empty();
  vi.restoreAllMocks();
});
function fixture() {
  const callbacks = new Map<number, FrameRequestCallback>();
  let id = 0;
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
    callbacks.set(++id, callback);
    return id;
  });
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((key) => {
    callbacks.delete(key);
  });
  const scroll = document.body.createDiv();
  Object.defineProperties(scroll, {
    clientHeight: { configurable: true, value: 300 },
    clientWidth: { value: 800 },
  });
  const host = scroll.createDiv();
  const destroyed: string[] = [];
  const markdown = new Map<string, Component>();
  const beforeWindow = vi.fn();
  const reportFailure = vi.fn();
  const owner = new ProjectTimelineRows({
    host,
    scroll,
    beforeWindow,
    reportFailure,
    mountedChanged: () => {},
    mount: (parent, row, component) => {
      const element = parent.createDiv({ attr: { 'data-key': row.key, tabindex: '0' } });
      markdown.set(row.key, component);
      return {
        element,
        update: () => {},
        destroy: () => {
          destroyed.push(row.key);
          element.remove();
        },
      };
    },
  });
  owners.push(owner);
  const rows = timelineViewportRows(
    [
      {
        key: 'g',
        collapsed: false,
        rows: Array.from({ length: 1100 }, (_, index) => ({
          occurrenceId: `r${index}`,
          revision: '1',
          estimatedHeight: 80,
        })),
      },
    ],
    'wide',
    32,
  );
  const frame = () => {
    const work = [...callbacks.values()];
    callbacks.clear();
    expect(work.length).toBeGreaterThan(0);
    work.forEach((callback) => {
      callback(0);
    });
  };
  owner.update(rows, false);
  frame();
  return {
    owner,
    host,
    scroll,
    rows,
    frame,
    callbacks,
    markdown,
    destroyed,
    beforeWindow,
    reportFailure,
  };
}

describe('Timeline vertical windows', () => {
  it('excludes collapsed projects while retaining a distinct header and revisions', () => {
    const rows = timelineViewportRows(
      [
        {
          key: 'g',
          collapsed: true,
          rows: [{ occurrenceId: 'one', revision: '1', estimatedHeight: 80 }],
        },
      ],
      'wide',
      32,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'group', groupKey: 'g', estimatedHeight: 32 });
    const expanded = timelineViewportRows(
      [
        {
          key: 'g',
          collapsed: false,
          rows: [{ occurrenceId: 'one', revision: '1', estimatedHeight: 80 }],
        },
      ],
      'narrow',
      32,
    );
    expect(expanded[1]).toMatchObject({ key: 'one', kind: 'project', occurrenceId: 'one' });
    expect(expanded[0]?.measurementRevision).not.toBe(rows[0]?.measurementRevision);
  });
  it('bounds mounts, retains actual focused nodes and sparse pins, reaches the last row', () => {
    const { owner, host, scroll, frame } = fixture();
    const first = expectDefined(owner.element('r0'));
    first.focus();
    const release = owner.pin('r700');
    scroll.scrollTop = 60_000;
    scroll.dispatchEvent(new Event('scroll'));
    frame();
    expect(document.activeElement).toBe(first);
    expect(first.isConnected).toBe(true);
    expect(owner.element('r700')?.isConnected).toBe(true);
    expect(host.querySelectorAll('[data-key]').length).toBeLessThan(20);
    expect(owner.reveal('r1099')?.isConnected).toBe(true);
    expect(scroll.scrollTop).toBeGreaterThan(87_000);
    release();
    expect(owner.element('r700')).toBeUndefined();
  });
  it('does not write normalized fractional or elastic native offsets in executed scroll frames', () => {
    const { scroll, frame, beforeWindow } = fixture();
    for (const offset of [300.75, -8.5]) {
      let top = offset;
      const write = vi.fn((value: number) => {
        top = value;
      });
      Object.defineProperty(scroll, 'scrollTop', {
        configurable: true,
        get: () => top,
        set: write,
      });
      const horizontal = vi.fn();
      Object.defineProperty(scroll, 'scrollLeft', {
        configurable: true,
        get: () => 123.25,
        set: horizontal,
      });
      const prior = beforeWindow.mock.calls.length;
      scroll.dispatchEvent(new Event('scroll'));
      frame();
      expect(beforeWindow.mock.calls).toHaveLength(prior + 1);
      expect(write).not.toHaveBeenCalled();
      expect(horizontal).not.toHaveBeenCalled();
    }
  });
  it('unloads each evicted row Component once after mount cleanup and cancels inactive frames', () => {
    const { owner, markdown, destroyed, callbacks } = fixture();
    const component = expectDefined(markdown.get('r0'));
    const unload = vi.spyOn(component, 'unload').mockImplementation(() => {
      expect(destroyed).toContain('r0');
    });
    owner.setActive(false);
    expect(owner.element('r0')).toBeUndefined();
    expect(unload).toHaveBeenCalledTimes(1);
    expect(callbacks.size).toBe(0);
    owner.destroy();
    expect(unload).toHaveBeenCalledTimes(1);
  });
});

it('installs grown extent before preserving a fractional anchor without touching horizontal scroll', () => {
  const { owner, host, scroll, rows } = fixture();
  owner.reveal('r1099');
  let top = scroll.scrollTop - 0.75;
  const horizontal = vi.fn();
  Object.defineProperty(scroll, 'scrollLeft', {
    configurable: true,
    get: () => 82.5,
    set: horizontal,
  });
  Object.defineProperty(scroll, 'scrollTop', {
    configurable: true,
    get: () => top,
    set: (value: number) => {
      const height = [...host.children].reduce((sum, child) => {
        const element = child as HTMLElement;
        const key = element.dataset['key'];
        if (key !== undefined) return sum + (key.startsWith('timeline-header:') ? 32 : 80);
        return (
          sum +
          Number(
            element.style
              .getPropertyValue('--abyss-project-timeline-spacer-height')
              .replace('px', ''),
          )
        );
      }, 0);
      top = Math.min(value, height - 300);
    },
  });
  const previous = top;
  owner.update(
    [
      {
        key: 'new',
        kind: 'project',
        groupKey: 'g',
        occurrenceId: 'new',
        estimatedHeight: 80,
        measurementRevision: '1',
      },
      ...rows,
    ],
    true,
  );
  expect(top).toBe(previous + 80);
  expect(horizontal).not.toHaveBeenCalled();
});

it('places a newly acquired sparse pin at its logical position and preserves real focus', () => {
  const { owner, host } = fixture();
  owner.reveal('r1099');
  const bottom = expectDefined(owner.element('r1099'));
  bottom.focus();
  owner.pin('r700');
  const keys = [...host.querySelectorAll<HTMLElement>('[data-key]')].map(
    (node) => node.dataset['key'],
  );
  expect(keys[0]).toBe('r700');
  expect(keys[keys.length - 1]).toBe('r1099');
  expect(document.activeElement).toBe(bottom);
});

it('does not mount a hidden zero-height surface and resumes on a real resize', () => {
  const { owner, host, scroll, rows, frame, callbacks } = fixture();
  Object.defineProperty(scroll, 'clientHeight', { configurable: true, value: 0 });
  owner.update(rows, true);
  expect(host.querySelector('[data-key]')).toBeNull();
  expect(owner.reveal('r900')).toBeUndefined();
  expect(callbacks.size).toBe(0);
  Object.defineProperty(scroll, 'clientHeight', { configurable: true, value: 300 });
  window.dispatchEvent(new Event('resize'));
  frame();
  expect(owner.element('r0')).toBeDefined();
});

it('uses the actual owning window and suppresses stale callbacks after disposal', () => {
  const iframe = document.body.createEl('iframe');
  const doc = expectDefined(iframe.contentDocument);
  const ownerWindow = expectDefined(iframe.contentWindow);
  const scroll = document.body.createDiv();
  doc.body.append(scroll);
  Object.defineProperty(scroll, 'clientHeight', { value: 300 });
  const host = scroll.createDiv();
  const pending: FrameRequestCallback[] = [];
  const main = vi.spyOn(window, 'requestAnimationFrame');
  vi.spyOn(ownerWindow, 'requestAnimationFrame').mockImplementation((callback) => {
    pending.push(callback);
    return pending.length;
  });
  const cancel = vi.spyOn(ownerWindow, 'cancelAnimationFrame');
  const before = vi.fn();
  const failure = vi.fn();
  const owner = new ProjectTimelineRows({
    host,
    scroll,
    beforeWindow: before,
    mountedChanged: () => {},
    reportFailure: failure,
    mount: (parent) => {
      expect(parent.ownerDocument).toBe(doc);
      const element = parent.cloneNode(false) as HTMLElement;
      parent.append(element);
      return {
        element,
        update: () => {},
        destroy: () => {
          element.remove();
        },
      };
    },
  });
  owners.push(owner);
  owner.update(
    [{ key: 'one', kind: 'project', groupKey: 'g', estimatedHeight: 80, measurementRevision: '1' }],
    false,
  );
  expect(failure).not.toHaveBeenCalled();
  expect(pending).toHaveLength(1);
  expect(main).not.toHaveBeenCalled();
  expectDefined(pending.shift())(0);
  expect(before).toHaveBeenCalledOnce();
  scroll.dispatchEvent(new Event('scroll'));
  const stale = expectDefined(pending.shift());
  owner.destroy();
  expect(cancel).toHaveBeenCalled();
  stale(0);
  expect(before).toHaveBeenCalledOnce();
  expect(failure).not.toHaveBeenCalled();
  expect(host.children).toHaveLength(0);
});

it('reports a mounting failure once and unloads failed Components without publishing detached work', () => {
  const host = document.body.createDiv();
  Object.defineProperty(host, 'clientHeight', { value: 300 });
  const report = vi.fn();
  const owner = new ProjectTimelineRows({
    host,
    scroll: host,
    beforeWindow: () => {},
    mountedChanged: () => {},
    reportFailure: report,
    mount: () => {
      throw new Error('broken renderer');
    },
  });
  owners.push(owner);
  const unload = vi.spyOn(Component.prototype, 'unload');
  const rows = [
    {
      key: 'one',
      kind: 'project' as const,
      groupKey: 'g',
      estimatedHeight: 80,
      measurementRevision: '1',
    },
  ];
  owner.update(rows, false);
  owner.flush();
  owner.flush();
  expect(report).toHaveBeenCalledOnce();
  expect(unload).toHaveBeenCalledOnce();
  owner.update(rows, false);
  expect(report).toHaveBeenCalledTimes(2);
  expect(unload).toHaveBeenCalledTimes(2);
  expect(host.querySelector('[data-key]')).toBeNull();
  owner.destroy();
  owner.update(rows, false);
  expect(report).toHaveBeenCalledTimes(2);
});

it.each([
  ['font', 160, 120],
  ['update', 160, 120],
  ['font', 1000, 800],
  ['update', 1000, 800],
] as const)(
  'retains the tall row anchor across %s invalidation at height%s/offset%s',
  (route, oldHeight, offset) => {
    const fonts = new EventTarget();
    Object.defineProperty(document, 'fonts', { configurable: true, value: fonts });
    const h = fixture();
    h.owner.update(
      h.rows.map((row) => ({ ...row, estimatedHeight: row.kind === 'group' ? 32 : 100 })),
      false,
    );
    const anchor = expectDefined(h.owner.element('r0'));
    let height: number = oldHeight;
    anchor.getBoundingClientRect = () => ({ height }) as DOMRect;
    h.owner.flush();
    h.scroll.scrollTop = 32 + offset; // Within-row offset exceeds replacement estimate100.
    h.scroll.dispatchEvent(new Event('scroll'));
    h.frame();
    height += 20;
    if (route === 'font') {
      fonts.dispatchEvent(new Event('loadingdone'));
      h.frame();
    } else
      h.owner.update(
        h.rows.map((row) => ({
          ...row,
          estimatedHeight: row.kind === 'group' ? 32 : 100,
          measurementRevision: 'next',
        })),
        true,
      );
    expect(h.reportFailure).not.toHaveBeenCalled();
    expect(h.owner.element('r0')).toBe(anchor);
    expect(h.scroll.scrollTop).toBe(32 + offset);
    h.owner.reveal('r1099');
    const revealedTop = h.scroll.scrollTop;
    expect(revealedTop).toBeGreaterThan(100000);
    h.owner.flush();
    expect(h.scroll.scrollTop).toBe(revealedTop);
    expect(h.owner.element('r0')).toBeUndefined();
  },
);
