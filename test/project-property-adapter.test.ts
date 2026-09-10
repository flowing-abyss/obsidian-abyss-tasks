import type { App, EventRef } from 'obsidian';
import { describe, expect, it, vi } from 'vitest';
import { ObsidianProjectProperties } from '../src/projects/ObsidianProjectProperties';

interface ListenerRef extends EventRef {
  readonly event: string;
  readonly listener: (...args: unknown[]) => void;
}

function eventSource() {
  const refs: ListenerRef[] = [];
  const on = vi.fn((event: string, listener: (...args: unknown[]) => void): ListenerRef => {
    const ref = { event, listener };
    refs.push(ref);
    return ref;
  });
  const offref = vi.fn((ref: EventRef) => {
    const index = refs.indexOf(ref as ListenerRef);
    if (index >= 0) refs.splice(index, 1);
  });
  return {
    on,
    offref,
    emit(event: string): void {
      for (const ref of [...refs]) if (ref.event === event) ref.listener();
    },
  };
}

describe('ObsidianProjectProperties', () => {
  it('inspects native presence and explicit assignment provenance without inventing missing types', () => {
    const assignments = new Map<string, string | null>([
      ['budget', null],
      ['aliases', 'aliases'],
      ['formula', 'formula'],
      ['missing', null],
    ]);
    const manager = {
      getAllProperties: () => ({
        budget: { name: 'Budget' },
        aliases: { name: 'aliases' },
      }),
      getTypeInfo: (name: string) => ({
        expected: { type: name === 'Budget' ? 'number' : 'aliases' },
      }),
      getAssignedWidget: (name: string) => assignments.get(name.toLocaleLowerCase()) ?? null,
      ...eventSource(),
    };
    const app = {
      metadataTypeManager: manager,
      vault: { getMarkdownFiles: () => [] },
      metadataCache: { getFileCache: () => null, ...eventSource() },
    } as unknown as App;
    const catalog = new ObsidianProjectProperties(app);

    expect(catalog.inspect('budget')).toEqual({
      kind: 'available',
      property: { name: 'Budget', type: 'number' },
      assignment: { kind: 'none' },
    });
    expect(catalog.inspect('aliases')).toEqual({
      kind: 'available',
      property: { name: 'aliases', type: 'list' },
      assignment: { kind: 'assigned', nativeType: 'aliases', type: 'list' },
    });
    expect(catalog.inspect('formula')).toEqual({
      kind: 'available',
      property: undefined,
      assignment: { kind: 'assigned', nativeType: 'formula', type: null },
    });
    expect(catalog.inspect('missing')).toEqual({
      kind: 'available',
      property: undefined,
      assignment: { kind: 'none' },
    });
  });

  it('reports unavailable inspection for missing, malformed, throwing, or ambiguous provenance', () => {
    const base = {
      getAllProperties: () => ({ budget: { name: 'Budget' } }),
      getTypeInfo: () => ({ expected: { type: 'number' } }),
      ...eventSource(),
    };
    const app = (manager: object) =>
      ({
        metadataTypeManager: manager,
        vault: { getMarkdownFiles: () => [] },
        metadataCache: { getFileCache: () => null, ...eventSource() },
      }) as unknown as App;

    expect(new ObsidianProjectProperties(app(base)).inspect('Budget')).toEqual({
      kind: 'unavailable',
    });
    expect(
      new ObsidianProjectProperties(
        app({ ...base, getAssignedWidget: () => ({ widget: 'number' }) }),
      ).inspect('Budget'),
    ).toEqual({ kind: 'unavailable' });
    expect(
      new ObsidianProjectProperties(
        app({
          ...base,
          getAssignedWidget: () => {
            throw new Error('private API unavailable');
          },
        }),
      ).inspect('Budget'),
    ).toEqual({ kind: 'unavailable' });
    expect(
      new ObsidianProjectProperties(
        app({
          ...base,
          getAllProperties: () => ({
            first: { name: 'Budget' },
            second: { name: 'BUDGET' },
          }),
          getAssignedWidget: () => null,
        }),
      ).inspect('Budget'),
    ).toEqual({ kind: 'unavailable' });
  });

  it('uses getTypeInfo(name).expected.type and maps every supported native type', () => {
    const nativeTypes = new Map([
      ['Title', 'text'],
      ['Owners', 'multitext'],
      ['Aliases', 'aliases'],
      ['Budget', 'number'],
      ['Approved', 'checkbox'],
      ['Start', 'date'],
      ['ReviewAt', 'datetime'],
      ['tags', 'tags'],
      ['Formula', 'formula'],
    ]);
    const getTypeInfo = vi.fn((name: string) => ({
      expected: { type: nativeTypes.get(name) },
    }));
    const manager = {
      getAllProperties: () =>
        Object.fromEntries([...nativeTypes.keys()].map((name) => [name.toLowerCase(), { name }])),
      getTypeInfo,
      ...eventSource(),
    };
    const app = {
      metadataTypeManager: manager,
      vault: { getMarkdownFiles: () => [] },
      metadataCache: { getFileCache: () => null, ...eventSource() },
    } as unknown as App;

    const catalog = new ObsidianProjectProperties(app);

    expect(catalog.list()).toEqual([
      { name: 'Title', type: 'text' },
      { name: 'Owners', type: 'list' },
      { name: 'Aliases', type: 'list' },
      { name: 'Budget', type: 'number' },
      { name: 'Approved', type: 'checkbox' },
      { name: 'Start', type: 'date' },
      { name: 'ReviewAt', type: 'datetime' },
      { name: 'tags', type: 'tags' },
      { name: 'Formula', type: null },
    ]);
    expect(getTypeInfo.mock.calls.map(([name]) => name)).toEqual([...nativeTypes.keys()]);
  });

  it('distinguishes successful empty discovery from unavailable or malformed discovery', () => {
    const app = {
      vault: { getMarkdownFiles: () => [] },
      metadataCache: { getFileCache: () => null, ...eventSource() },
    } as unknown as App;
    const malformed = {
      metadataTypeManager: { getAllProperties: () => ({ Budget: { name: 'Budget' } }) },
      vault: { getMarkdownFiles: () => [] },
      metadataCache: { getFileCache: () => null, ...eventSource() },
    } as unknown as App;

    const empty = {
      metadataTypeManager: {
        getAllProperties: () => ({}),
        getTypeInfo: () => ({ expected: { type: 'text' } }),
        ...eventSource(),
      },
      vault: { getMarkdownFiles: () => [] },
      metadataCache: { getFileCache: () => null, ...eventSource() },
    } as unknown as App;

    expect(new ObsidianProjectProperties(empty).list()).toEqual([]);
    expect(new ObsidianProjectProperties(app).list()).toBeNull();
    expect(new ObsidianProjectProperties(malformed).list()).toBeNull();
  });

  it('collects stable case-insensitive scalar and list suggestions using the exact property key', () => {
    const files = [{ path: 'A.md' }, { path: 'B.md' }, { path: 'C.md' }];
    const caches = new Map([
      ['A.md', { frontmatter: { Owners: ['beta', 42] } }],
      ['B.md', { frontmatter: { owners: 'Alpha' } }],
      ['C.md', { frontmatter: { OWNERS: ['alpha', 'beta', 'High', 'high'] } }],
    ]);
    const app = {
      metadataTypeManager: {
        getAllProperties: () => ({ owners: { name: 'Owners' } }),
        getTypeInfo: () => ({ expected: { type: 'multitext' } }),
        ...eventSource(),
      },
      vault: { getMarkdownFiles: () => files },
      metadataCache: {
        getFileCache: (file: { path: string }) => caches.get(file.path),
        ...eventSource(),
      },
    } as unknown as App;

    const catalog = new ObsidianProjectProperties(app);

    expect(catalog.values('owners')).toEqual(['42', 'Alpha', 'alpha', 'beta', 'High', 'high']);
    expect(catalog.values('OWNERS')).toEqual(['42', 'Alpha', 'alpha', 'beta', 'High', 'high']);
  });

  it('invalidates values, publishes manager and metadata changes, and detaches every event ref', () => {
    const managerEvents = eventSource();
    const metadataEvents = eventSource();
    const app = {
      metadataTypeManager: {
        getAllProperties: () => ({}),
        getTypeInfo: () => ({ expected: { type: 'text' } }),
        ...managerEvents,
      },
      vault: { getMarkdownFiles: () => [] },
      metadataCache: { getFileCache: () => null, ...metadataEvents },
    } as unknown as App;
    const callback = vi.fn();
    const catalog = new ObsidianProjectProperties(app);

    const off = catalog.onChange(callback);
    managerEvents.emit('changed');
    metadataEvents.emit('changed');
    metadataEvents.emit('deleted');
    expect(callback).toHaveBeenCalledTimes(3);

    off();
    expect(managerEvents.offref).toHaveBeenCalledOnce();
    expect(metadataEvents.offref).toHaveBeenCalledTimes(2);
    managerEvents.emit('changed');
    expect(callback).toHaveBeenCalledTimes(3);
  });

  it('keeps public metadata invalidation when the internal manager event API throws', () => {
    const metadataEvents = eventSource();
    const app = {
      metadataTypeManager: {
        getAllProperties: () => ({}),
        getTypeInfo: () => ({ expected: { type: 'text' } }),
        on: () => {
          throw new Error('unsupported event API');
        },
        offref: vi.fn(),
      },
      vault: { getMarkdownFiles: () => [] },
      metadataCache: { getFileCache: () => null, ...metadataEvents },
    } as unknown as App;
    const callback = vi.fn();
    const catalog = new ObsidianProjectProperties(app);

    const off = catalog.onChange(callback);
    metadataEvents.emit('changed');
    metadataEvents.emit('deleted');

    expect(callback).toHaveBeenCalledTimes(2);
    off();
    expect(metadataEvents.offref).toHaveBeenCalledTimes(2);
  });
});
