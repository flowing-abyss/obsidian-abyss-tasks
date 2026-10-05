import { describe, expect, it } from 'vitest';
import {
  kanbanInsertion,
  KanbanRowIndex,
  type KanbanViewportRow,
  type PlannedKanbanInsertion,
} from '../src/panels/projects/projectKanbanRows';
import { RowViewport } from '../src/panels/virtualization/rowViewport';
import { expectDefined } from './helpers';
import { recordVirtualSurfaceResources } from './support/virtualSurfaceResources';

const card = (projectPath: string, groupKey = 'g'): KanbanViewportRow => ({
  kind: 'card',
  key: `${groupKey}:${projectPath}`,
  groupKey,
  projectPath,
  estimatedHeight: 40,
  measurementRevision: '1',
});
const header = (groupKey: string): KanbanViewportRow => ({
  kind: 'group',
  key: groupKey,
  groupKey,
  estimatedHeight: 20,
  measurementRevision: '1',
});
function insertion(rows: readonly KanbanViewportRow[], y: number, source = 'a') {
  const viewport = new RowViewport();
  viewport.replace(rows);
  return kanbanInsertion(rows, viewport, y, source);
}

describe('logical Kanban insertion', () => {
  it('resolves an unmounted neighbor and excludes the dragged physical project', () => {
    const rows = ['a', 'b', 'c'].map((path) => card(path));
    expect(insertion(rows, 35)).toEqual({ groupKey: 'g', beforePath: 'b', top: 40 });
    expect(insertion(rows, 119)).toEqual({ groupKey: 'g', top: 120 });
  });
  it('keeps header, occupied gap and end positions inside their owning group', () => {
    const rows = [header('g'), card('a'), card('b'), header('h'), card('c', 'h')];
    expect(insertion(rows, 0)).toEqual({ groupKey: 'g', beforePath: 'b', top: 60 });
    expect(insertion(rows, 99)).toEqual({ groupKey: 'g', top: 100 });
    expect(insertion(rows, 101)).toEqual({ groupKey: 'h', beforePath: 'c', top: 120 });
    expect(insertion(rows, 999)).toEqual({ groupKey: 'h', top: 160 });
  });
  it('excludes duplicate physical occurrences without crossing a group boundary', () => {
    const rows = [header('g'), card('a'), header('h'), card('a', 'h'), card('c', 'h')];
    expect(insertion(rows, 21)).toEqual({ groupKey: 'g', top: 60 });
    expect(insertion(rows, 81)).toEqual({ groupKey: 'h', beforePath: 'c', top: 120 });
  });
  it('handles a collapsed header and empty projection without inventing neighbors', () => {
    expect(insertion([header('g'), header('h')], 1)).toEqual({ groupKey: 'g', top: 20 });
    expect(insertion([], 1)).toBeUndefined();
    expect(insertion([card('b')], Number.NaN)).toBeUndefined();
  });
});

function plannedInsertion(
  rows: readonly KanbanViewportRow[],
  viewport: RowViewport,
  insertion: PlannedKanbanInsertion,
  path: string,
) {
  return new KanbanRowIndex(rows).insertionTop(viewport, insertion, path);
}
describe('planned Kanban insertion coordinates', () => {
  it('uses the exact group occurrence and measured full-row edges', () => {
    const rows = [header('g'), card('a'), header('h'), card('a', 'h'), card('b', 'h')];
    const viewport = new RowViewport();
    viewport.replace(rows);
    viewport.measure([{ key: 'h:a', height: 60 }], 0);
    expect(
      plannedInsertion(
        rows,
        viewport,
        { kind: 'before', groupKey: 'h', beforePath: 'a' },
        'moving',
      ),
    ).toBe(80);
    expect(
      plannedInsertion(rows, viewport, { kind: 'after', groupKey: 'h', afterPath: 'a' }, 'moving'),
    ).toBe(140);
  });
  it('retains arbitrary first-occurrence keys while live measurements change', () => {
    const rows = [
      { ...header('g'), key: 'section alpha' },
      { ...card('a'), key: 'unrelated first key' },
      { ...card('a'), key: 'same-path second key' },
      { ...header('h'), key: 'section beta' },
      { ...card('a', 'h'), key: 'another group key' },
    ];
    const viewport = new RowViewport();
    viewport.replace(rows);
    const index = new KanbanRowIndex(rows);
    expect(
      index.insertionTop(viewport, { kind: 'before', groupKey: 'g', beforePath: 'a' }, 'moving'),
    ).toBe(20);
    expect(
      index.insertionTop(viewport, { kind: 'before', groupKey: 'h', beforePath: 'a' }, 'moving'),
    ).toBe(120);
    viewport.measure([{ key: 'unrelated first key', height: 60 }], 0);
    expect(
      index.insertionTop(viewport, { kind: 'after', groupKey: 'g', afterPath: 'a' }, 'moving'),
    ).toBe(80);
    expect(
      index.insertionTop(viewport, { kind: 'before', groupKey: 'h', beforePath: 'a' }, 'moving'),
    ).toBe(140);
    expect(
      index.insertionTop(
        viewport,
        { kind: 'before', groupKey: 'g', beforePath: 'absent' },
        'moving',
      ),
    ).toBeUndefined();
  });
  it('resolves an empty group, a new group before its neighbor, and the logical tail', () => {
    const rows = [header('g'), card('a'), header('h')];
    const viewport = new RowViewport();
    viewport.replace(rows);
    expect(plannedInsertion(rows, viewport, { kind: 'empty', groupKey: 'h' }, 'moving')).toBe(80);
    expect(
      plannedInsertion(
        rows,
        viewport,
        { kind: 'empty', groupKey: 'new', beforeGroupKey: 'h' },
        'moving',
      ),
    ).toBe(60);
    expect(plannedInsertion(rows, viewport, { kind: 'empty', groupKey: 'new' }, 'moving')).toBe(80);
    expect(
      plannedInsertion([], new RowViewport(), { kind: 'empty', groupKey: 'new' }, 'moving'),
    ).toBe(0);
  });
  it('uses the proposed singleton top and collapsed header boundary without inventing a forecast', () => {
    const rows = [header('g'), card('moving'), header('h')];
    const viewport = new RowViewport();
    viewport.replace(rows);
    expect(plannedInsertion(rows, viewport, { kind: 'empty', groupKey: 'g' }, 'moving')).toBe(20);
    expect(
      plannedInsertion(
        rows,
        viewport,
        { kind: 'after', groupKey: 'h', afterPath: 'unmounted-collapsed' },
        'moving',
      ),
    ).toBe(80);
    expect(
      plannedInsertion(rows, viewport, { kind: 'none', groupKey: 'g' }, 'moving'),
    ).toBeUndefined();
  });
});

import { afterEach, vi } from 'vitest';
import { ProjectKanbanColumnViewport } from '../src/panels/projects/projectKanbanViewport';

const owners: ProjectKanbanColumnViewport[] = [];
afterEach(() => {
  owners.splice(0).forEach((owner) => {
    owner.destroy();
  });
  document.body.replaceChildren();
  vi.restoreAllMocks();
});
function nativeColumn(count = 1000, doc = document) {
  const scroll = document.body.createDiv();
  doc.body.append(scroll);
  Object.defineProperty(scroll, 'clientHeight', { value: 200, configurable: true });
  const host = scroll.createDiv();
  const cleaned: string[] = [];
  const unloaded: string[] = [];
  const errors: unknown[] = [];
  const reconciled = vi.fn();
  const owner = new ProjectKanbanColumnViewport({
    host,
    scroll,
    mount(parent, row, markdown) {
      const element = parent.createDiv({ text: row.key });
      element.tabIndex = 0;
      markdown.register(() => unloaded.push(row.key));
      return {
        element,
        update(next) {
          element.textContent = next.key;
        },
        destroy() {
          cleaned.push(row.key);
          element.remove();
        },
      };
    },
    mountedChanged: reconciled,
    reportFailure: (error) => errors.push(error),
  });
  owners.push(owner);
  const rows = Array.from({ length: count }, (_, index) => card(String(index)));
  owner.update(rows, false);
  return {
    owner,
    host,
    scroll,
    rows,
    cleaned,
    unloaded,
    errors,
    reconciled,
    typography(property: 'fontWeight', value: string) {
      host.style[property] = value;
    },
  };
}
describe('native Kanban columns', () => {
  it.each([1000, 10000])(
    'bounds %s cards, reveals synchronously, and unloads evicted Markdown',
    (count) => {
      const { owner, host, cleaned, unloaded, errors } = nativeColumn(count);
      expect(host.children.length).toBeLessThan(20);
      expect(owner.element('g:900')).toBeUndefined();
      expect(owner.reveal('g:900')?.textContent).toBe('g:900');
      expect(cleaned).toContain('g:0');
      expect(unloaded).toEqual(cleaned);
      expect(errors).toEqual([]);
    },
  );
  it('previews a sorted landing at an unmounted neighbor without mounting it', () => {
    const { owner } = nativeColumn();
    expect(owner.element('g:900')).toBeUndefined();
    expect(owner.insertionTop({ kind: 'before', groupKey: 'g', beforePath: '900' }, 'moving')).toBe(
      36000,
    );
    expect(owner.insertionTop({ kind: 'after', groupKey: 'g', afterPath: '900' }, 'moving')).toBe(
      36040,
    );
    expect(owner.element('g:900')).toBeUndefined();
  });
  it('keeps pinned offscreen nodes connected and focused without moving them', () => {
    const { owner, host, scroll } = nativeColumn();
    const element = owner.reveal('g:0');
    element?.focus();
    const release = owner.pin('g:0');
    scroll.scrollTop = 20000;
    owner.reveal('g:500');
    expect(owner.element('g:0')).toBe(element);
    expect(document.activeElement).toBe(element);
    expect(host.firstElementChild).toBe(element);
    owner.setActive(false);
    expect(owner.element('g:500')).toBeUndefined();
    expect(owner.element('g:0')).toBe(element);
    element?.blur();
    release();
    expect(owner.element('g:0')).toBeUndefined();
  });
  it('does not normalize ordinary fractional or elastic native scroll offsets', () => {
    const callbacks: FrameRequestCallback[] = [];
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      callbacks.push(callback);
      return callbacks.length;
    });
    const { scroll, reconciled } = nativeColumn();
    expect(callbacks).toHaveLength(1);
    callbacks.splice(0).forEach((callback) => {
      callback(0);
    });
    expect(reconciled).toHaveBeenCalledTimes(2);
    let value = 23.75;
    const write = vi.fn((next: number) => {
      value = next;
    });
    Object.defineProperty(scroll, 'scrollTop', {
      get: () => value,
      set: write,
      configurable: true,
    });
    scroll.dispatchEvent(new Event('scroll'));
    expect(callbacks).toHaveLength(1);
    callbacks.splice(0).forEach((callback) => {
      callback(0);
    });
    expect(reconciled).toHaveBeenCalledTimes(3);
    expect(write).not.toHaveBeenCalled();
    value = -3.5;
    scroll.dispatchEvent(new Event('scroll'));
    expect(callbacks).toHaveLength(1);
    callbacks.splice(0).forEach((callback) => {
      callback(0);
    });
    expect(reconciled).toHaveBeenCalledTimes(4);
    expect(write).not.toHaveBeenCalled();
  });
  it('unloads every mounted Component exactly once after its mount cleanup', () => {
    const { owner, cleaned, unloaded } = nativeColumn();
    owner.destroy();
    owner.destroy();
    expect(unloaded).toEqual(cleaned);
    expect(new Set(unloaded).size).toBe(unloaded.length);
    expect(unloaded.length).toBeGreaterThan(0);
  });
});

it.each([1000, 10000])('bounds insertion lookup work over %s full rows', (count) => {
  const h = nativeColumn(count);
  let reads = 0;
  const rows = h.rows.map((row) => ({
    ...row,
    get groupKey() {
      reads++;
      return 'g';
    },
  }));
  h.owner.update(rows, false);
  reads = 0;
  expect(
    h.owner.insertionTop({ kind: 'after', groupKey: 'g', afterPath: String(count - 1) }, 'moving'),
  ).toBe(count * 40);
  expect(reads).toBeLessThan(10);
});

it('replaces the column insertion index without retaining removed rows', () => {
  const h = nativeColumn(2);
  expect(h.owner.insertionTop({ kind: 'before', groupKey: 'g', beforePath: '0' }, 'moving')).toBe(
    0,
  );
  h.owner.update([{ ...card('new'), key: 'supplied replacement key' }], false);
  expect(
    h.owner.insertionTop({ kind: 'before', groupKey: 'g', beforePath: '0' }, 'moving'),
  ).toBeUndefined();
  expect(h.owner.insertionTop({ kind: 'after', groupKey: 'g', afterPath: 'new' }, 'moving')).toBe(
    40,
  );
});
it('transfers a card Component and its existing release token to another column owner', () => {
  const source = nativeColumn(1);
  const destination = nativeColumn(0);
  const release = source.owner.pin('g:0');
  const element = source.owner.element('g:0');
  const row = { ...card('0'), key: 'moved:0' };
  destination.owner.setActive(false);
  expect(source.owner.transferTo(destination.owner, 'g:0', row)).toBe(true);
  destination.owner.update([row], false);
  source.owner.update([], false);
  source.owner.destroy();
  expect(destination.owner.element('moved:0')).toBe(element);
  expect(source.unloaded).toEqual([]);
  release();
  expect(destination.owner.element('moved:0')).toBeUndefined();
  expect(source.cleaned).toEqual(['g:0']);
  expect(source.unloaded).toEqual(['g:0']);
});

import { ProjectKanbanHoverViewport } from '../src/panels/projects/projectKanbanHoverViewport';
it('bounds a collapsed-column title preview and resolves an unmounted logical target', () => {
  const host = document.body.createDiv();
  Object.defineProperty(host, 'clientHeight', { value: 200 });
  const rows = Array.from({ length: 10000 }, (_, index) => card(String(index)));
  const owner = new ProjectKanbanHoverViewport(
    host,
    rows,
    (parent, row) => parent.createDiv({ text: row.projectPath ?? row.key }),
    (error) => {
      throw error;
    },
  );
  expect(host.children.length).toBeLessThan(20);
  expect(owner.hitTest(20001, '0')).toEqual({ groupKey: 'g', beforePath: '500', top: 20000 });
  owner.destroy();
  expect(host.children).toHaveLength(0);
});

it('reports a live mount failure once and releases partial Markdown resources', () => {
  const host = document.body.createDiv();
  const errors: unknown[] = [];
  let released = 0;
  const failure = new Error('Cannot render card');
  const owner = new ProjectKanbanColumnViewport({
    host,
    scroll: host,
    mount(parent, _row, markdown) {
      parent.createDiv({ text: 'partial card' });
      markdown.register(() => {
        released++;
      });
      throw failure;
    },
    mountedChanged() {},
    reportFailure(error) {
      errors.push(error);
    },
  });
  owners.push(owner);
  expect(() => {
    owner.update([card('a')], false);
  }).not.toThrow();
  expect(errors).toEqual([failure]);
  expect(released).toBe(1);
  expect(host.textContent).toBe('');
});

it('ignores captured column and hover callbacks after destruction', () => {
  const callbacks: FrameRequestCallback[] = [];
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
    callbacks.push(callback);
    return callbacks.length;
  });
  const column = nativeColumn();
  const host = document.body.createDiv();
  const errors: unknown[] = [];
  const hover = new ProjectKanbanHoverViewport(
    host,
    [card('a')],
    (parent, row) => parent.createDiv({ text: row.key }),
    (error) => {
      errors.push(error);
    },
  );
  column.owner.destroy();
  hover.destroy();
  callbacks.forEach((callback) => {
    callback(0);
  });
  expect(column.errors).toEqual([]);
  expect(errors).toEqual([]);
  expect(host.children).toHaveLength(0);
  expect(column.host.children).toHaveLength(0);
});

it('places a newly pinned offscreen card between its exact sparse spacers', () => {
  const { owner, host } = nativeColumn();
  const release = owner.pin('g:900');
  const pinned = owner.element('g:900');
  expect(
    pinned?.previousElementSibling?.classList.contains('abyss-project-kanban-viewport-spacer'),
  ).toBe(true);
  expect(
    pinned?.nextElementSibling?.classList.contains('abyss-project-kanban-viewport-spacer'),
  ).toBe(true);
  expect(host.lastElementChild?.getAttribute('style')).toContain('3960px');
  release();
});

it('updates retained hover titles and never writes ordinary fractional or elastic offsets', () => {
  const callbacks: FrameRequestCallback[] = [];
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
    callbacks.push(callback);
    return callbacks.length;
  });
  const host = document.body.createDiv();
  const owner = new ProjectKanbanHoverViewport(
    host,
    [card('a')],
    (parent, row) => parent.createDiv({ text: row.measurementRevision }),
    (error) => {
      throw error;
    },
  );
  owner.update([{ ...card('a'), measurementRevision: 'renamed' }]);
  expect(host.textContent).toBe('renamed');
  let top = 1.25;
  const write = vi.fn((value: number) => {
    top = value;
  });
  Object.defineProperty(host, 'scrollTop', { get: () => top, set: write });
  host.dispatchEvent(new Event('scroll'));
  callbacks.splice(0).forEach((callback) => {
    callback(0);
  });
  top = -2.75;
  host.dispatchEvent(new Event('scroll'));
  callbacks.splice(0).forEach((callback) => {
    callback(0);
  });
  expect(write).not.toHaveBeenCalled();
  owner.destroy();
});

it('does not move an established pinned source subtree while arranging new neighbors', () => {
  const { owner, host } = nativeColumn();
  const source: Node = expectDefined(owner.element('g:3'));
  const release = owner.pin('g:3');
  const insert = vi.spyOn(host, 'insertBefore');
  owner.reveal('g:900');
  expect(insert.mock.calls.some(([element]) => element === source)).toBe(false);
  release();
});

import { ProjectKanbanDragController } from '../src/panels/projects/projectKanbanDrag';
import type {
  ProjectKanbanDropSource,
  ProjectKanbanDropTarget,
} from '../src/panels/projects/projectKanbanDrop';
it('retargets the logical drag neighbor after edge scrolling without another pointer event', async () => {
  const frames: FrameRequestCallback[] = [];
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
    frames.push(callback);
    return frames.length;
  });
  const root = document.body.createDiv();
  const board = root.createDiv();
  const column = board.createDiv({
    cls: 'abyss-project-kanban-column',
    attr: { 'data-status-key': 'g' },
  });
  const scroll = column.createDiv({ cls: 'abyss-project-kanban-column-body' });
  const cardElement = scroll.createDiv({
    cls: 'abyss-project-kanban-card',
    attr: { 'data-project-path': 'a' },
  });
  const source: ProjectKanbanDropSource = {
    projectPath: 'a',
    statusKey: 'g',
    group: { key: 'all', value: null },
    statusGuard: {
      fieldId: 'status',
      fieldType: 'status',
      sourceProperty: 'status',
      expectedValue: 'Active',
      expectedExists: true,
    },
    settingsGuard: { groupBy: 'none', sortField: 'none', sortDirection: 'asc' },
  };
  const seen: ProjectKanbanDropTarget[] = [];
  const committed: ProjectKanbanDropTarget[] = [];
  let pins = 0;
  const controller = new ProjectKanbanDragController(root, board, {
    begin: () => () => {},
    capture: () => source,
    insertionLocation: () => undefined,
    pin() {
      pins++;
      return () => {
        pins--;
      };
    },
    hitTest() {
      return {
        target: {
          status: { key: 'g', value: 'Active' },
          beforePath: scroll.scrollTop > 0 ? 'unmounted-next' : 'initial',
        },
        lineHost: scroll,
      };
    },
    preview(_source, target) {
      seen.push(target);
      return { allowed: false, message: 'preview only' };
    },
    async commit(_source, target) {
      committed.push(target);
    },
    reportFailure(error) {
      throw error;
    },
  });
  vi.spyOn(scroll, 'getBoundingClientRect').mockReturnValue({
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    right: 300,
    bottom: 200,
    width: 300,
    height: 200,
    toJSON() {},
  });
  const values = new Map<string, string>();
  const transfer = {
    types: ['application/x-abyss-project-kanban-card'],
    setData(type: string, value: string) {
      values.set(type, value);
    },
    getData(type: string) {
      return values.get(type) ?? '';
    },
    setDragImage() {},
    effectAllowed: '',
    dropEffect: '',
  };
  const drag = (type: string) => {
    const event = new MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      clientX: 150,
      clientY: 190,
    });
    Object.defineProperty(event, 'dataTransfer', { value: transfer });
    return event;
  };
  cardElement.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }));
  cardElement.dispatchEvent(drag('dragstart'));
  expect(pins).toBe(1);
  cardElement.dispatchEvent(drag('dragover'));
  frames.shift()?.(0);
  expect(scroll.scrollTop).toBe(10);
  expect(seen[seen.length - 1]?.beforePath).toBe('unmounted-next');
  cardElement.dispatchEvent(drag('drop'));
  await Promise.resolve();
  expect(committed[0]?.beforePath).toBe('unmounted-next');
  expect(pins).toBe(0);
  controller.destroy();
});

it('cancels native work and evicts unowned mounts when its column is detached', () => {
  const frames: FrameRequestCallback[] = [];
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
    frames.push(callback);
    return frames.length;
  });
  const column = nativeColumn();
  column.scroll.remove();
  frames.splice(0).forEach((callback) => {
    callback(0);
  });
  expect(column.owner.element('g:0')).toBeUndefined();
  expect(column.errors).toEqual([]);
});

it.each(['document', 'group', 'project', 'header', 'duplicate'] as const)(
  'rejects a %s transfer without changing source ownership or its pin release',
  (reason) => {
    const source = nativeColumn(1);
    const frame = document.body.createEl('iframe');
    const doc = reason === 'document' ? expectDefined(frame.contentDocument) : document;
    const destination = nativeColumn(reason === 'duplicate' ? 1 : 0, doc);
    const element = expectDefined(source.owner.element('g:0'));
    const release = source.owner.pin('g:0');
    const row =
      reason === 'header'
        ? header('g')
        : {
            ...card(reason === 'project' ? 'other' : '0'),
            key: reason === 'duplicate' ? 'g:0' : 'moved:0',
            groupKey: reason === 'group' ? 'other' : 'g',
          };
    expect(source.owner.transferTo(destination.owner, 'g:0', row)).toBe(false);
    expect(source.owner.element('g:0')).toBe(element);
    expect(source.unloaded).toEqual([]);
    expect(source.cleaned).toEqual([]);
    if (reason !== 'duplicate') expect(destination.owner.element(row.key)).toBeUndefined();
    source.owner.setActive(false);
    expect(source.owner.element('g:0')).toBe(element);
    release();
    release();
    expect(source.owner.element('g:0')).toBeUndefined();
    expect(source.unloaded).toEqual(['g:0']);
    expect(source.cleaned).toEqual(['g:0']);
    source.owner.destroy();
    destination.owner.destroy();
    expect(source.unloaded).toEqual(['g:0']);
  },
);
it('admits a same-document transfer once and rejects a duplicate source acquisition', () => {
  const source = nativeColumn(1);
  const destination = nativeColumn(0);
  const element = source.owner.element('g:0');
  const release = source.owner.pin('g:0');
  const row = { ...card('0'), key: 'moved:0' };
  expect(source.owner.transferTo(destination.owner, 'g:0', row)).toBe(true);
  expect(source.owner.transferTo(destination.owner, 'g:0', row)).toBe(false);
  destination.owner.update([row], false);
  source.owner.destroy();
  expect(destination.owner.element(row.key)).toBe(element);
  expect(source.unloaded).toEqual([]);
  destination.owner.setActive(false);
  release();
  destination.owner.destroy();
  expect(source.unloaded).toEqual(['g:0']);
  expect(source.cleaned).toEqual(['g:0']);
});

it('plateaus real hover owners over twenty scroll cycles at both scales and disposes captured work', () => {
  const counts: number[] = [];
  for (const count of [1000, 10000]) {
    const resources = recordVirtualSurfaceResources();
    const frames = new Map<number, FrameRequestCallback>();
    let next = 0;
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      frames.set(++next, callback);
      return next;
    });
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => frames.delete(id));
    const flush = () => {
      const callbacks = [...frames.values()];
      frames.clear();
      for (const callback of callbacks) callback(0);
    };
    const host = document.body.createDiv();
    Object.defineProperty(host, 'clientHeight', { value: 200 });
    const failure = vi.fn();
    const rows = Array.from({ length: count }, (_, index) => card(String(index)));
    const owner = new ProjectKanbanHoverViewport(
      host,
      rows,
      (parent, row) => parent.createDiv({ text: row.projectPath ?? row.key }),
      failure,
    );
    flush();
    const retained = resources.counts();
    expect(retained.components).toBeGreaterThan(0);
    expect(retained.observers).toBe(1);
    counts.push(host.children.length);
    for (let cycle = 0; cycle < 20; cycle++) {
      host.scrollTop = count * 40 - 200;
      host.dispatchEvent(new Event('scroll'));
      flush();
      expect(host.textContent).toContain(String(count - 1));
      host.scrollTop = 0;
      host.dispatchEvent(new Event('scroll'));
      flush();
      expect(resources.counts()).toEqual(retained);
    }
    host.dispatchEvent(new Event('scroll'));
    const late = [...frames.values()];
    owner.destroy();
    for (const callback of late) callback(0);
    for (const callback of resources.callbacks) callback([], {} as ResizeObserver);
    flush();
    expect(resources.counts()).toEqual({ components: 0, listeners: 0, observers: 0, targets: 0 });
    expect(host.children).toHaveLength(0);
    expect(failure).not.toHaveBeenCalled();
    host.remove();
    vi.restoreAllMocks();
  }
  expect(expectDefined(counts[1])).toBeLessThanOrEqual(expectDefined(counts[0]) * 1.1);
});

it('rebinds a live adopted column to its document and ignores old-owner/disposed native callbacks', () => {
  const resources = recordVirtualSurfaceResources();
  const frame = document.body.createEl('iframe');
  const doc = expectDefined(frame.contentDocument);
  const win = expectDefined(frame.contentWindow);
  Object.defineProperty(win, 'ResizeObserver', {
    value: window.ResizeObserver,
    configurable: true,
  });
  const mainFrames: FrameRequestCallback[] = [];
  const adoptedFrames: FrameRequestCallback[] = [];
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
    mainFrames.push(callback);
    return mainFrames.length;
  });
  const mainCancel = vi.spyOn(window, 'cancelAnimationFrame');
  vi.spyOn(win, 'requestAnimationFrame').mockImplementation((callback) => {
    adoptedFrames.push(callback);
    return adoptedFrames.length;
  });
  const adoptedCancel = vi.spyOn(win, 'cancelAnimationFrame');
  const h = nativeColumn();
  h.scroll.dispatchEvent(new Event('scroll'));
  const old = [...mainFrames];
  doc.body.append(h.scroll);
  h.owner.update(h.rows, false);
  expect(mainCancel).toHaveBeenCalled();
  expect(resources.observers.size).toBe(1);
  expect(resources.observed.has(h.scroll)).toBe(true);
  const pendingBeforeOld = adoptedFrames.length;
  for (const callback of old) callback(0);
  expect(adoptedFrames).toHaveLength(pendingBeforeOld);
  for (const callback of adoptedFrames.splice(0)) callback(0);
  h.scroll.dispatchEvent(new Event('scroll'));
  expect(adoptedFrames).toHaveLength(1);
  expectDefined(adoptedFrames.shift())(0);
  h.scroll.dispatchEvent(new Event('scroll'));
  const late = [...adoptedFrames];
  h.owner.destroy();
  expect(adoptedCancel).toHaveBeenCalled();
  for (const callback of late) callback(0);
  for (const callback of resources.callbacks) callback([], {} as ResizeObserver);
  expect(resources.liveComponents.size).toBe(0);
  expect(resources.observers.size).toBe(0);
  expect(resources.observed.size).toBe(0);
  expect(h.host.children).toHaveLength(0);
  expect(h.errors).toEqual([]);
});

it('keeps zero-size Kanban hidden without row mounts and preserves its offset across hide/show', () => {
  const h = nativeColumn();
  h.owner.reveal('g:900');
  const before = h.scroll.scrollTop;
  h.owner.setActive(false);
  Object.defineProperty(h.scroll, 'clientHeight', { value: 0, configurable: true });
  h.owner.update(h.rows, false);
  expect(h.host.querySelector('[tabindex]')).toBeNull();
  expect(h.scroll.scrollTop).toBe(before);
  Object.defineProperty(h.scroll, 'clientHeight', { value: 200, configurable: true });
  h.owner.setActive(true);
  expect(h.owner.element('g:900')).toBeDefined();
  expect(h.scroll.scrollTop).toBe(before);
});

it.each([
  ['font', 120, 80],
  ['update', 120, 80],
  ['font', 1000, 800],
  ['update', 1000, 800],
] as const)(
  'retains a variable-height card across %s invalidation at height%s/offset%s',
  (route, oldHeight, offset) => {
    const callbacks = new Map<number, FrameRequestCallback>();
    let id = 0;
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      callbacks.set(++id, callback);
      return id;
    });
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((key) => {
      callbacks.delete(key);
    });
    const frame = () => {
      const work = [...callbacks.values()];
      callbacks.clear();
      expect(work.length).toBeGreaterThan(0);
      work.forEach((callback) => {
        callback(0);
      });
    };
    const h = nativeColumn();
    Object.defineProperty(h.host, 'clientWidth', { value: 300 });
    const anchor = expectDefined(h.owner.element('g:0'));
    let height: number = oldHeight;
    anchor.getBoundingClientRect = () => ({ height }) as DOMRect;
    frame();
    h.scroll.scrollTop = offset;
    h.scroll.dispatchEvent(new Event('scroll'));
    frame();
    height += 40;
    if (route === 'font') {
      h.typography('fontWeight', '800');
      h.scroll.dispatchEvent(new Event('scroll'));
      frame();
    } else
      h.owner.update(
        h.rows.map((row) => ({ ...row, measurementRevision: 'next' })),
        true,
      );
    expect(h.errors).toEqual([]);
    expect(h.owner.element('g:0')).toBe(anchor);
    expect(h.scroll.scrollTop).toBe(offset);
    h.owner.reveal('g:999');
    const revealedTop = h.scroll.scrollTop;
    expect(revealedTop).toBeGreaterThan(39000);
    frame();
    expect(h.scroll.scrollTop).toBe(revealedTop);
    expect(h.owner.element('g:0')).toBeUndefined();
  },
);
