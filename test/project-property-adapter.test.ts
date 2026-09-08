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

  it('does not guess property types when the internal manager is unavailable or malformed', () => {
    const app = {
      vault: { getMarkdownFiles: () => [] },
      metadataCache: { getFileCache: () => null, ...eventSource() },
    } as unknown as App;
    const malformed = {
      metadataTypeManager: { getAllProperties: () => ({ Budget: { name: 'Budget' } }) },
      vault: { getMarkdownFiles: () => [] },
      metadataCache: { getFileCache: () => null, ...eventSource() },
    } as unknown as App;

    expect(new ObsidianProjectProperties(app).list()).toEqual([]);
    expect(new ObsidianProjectProperties(malformed).list()).toEqual([]);
  });

  it('collects stable case-insensitive scalar and list suggestions using the exact property key', () => {
    const files = [{ path: 'A.md' }, { path: 'B.md' }, { path: 'C.md' }];
    const caches = new Map([
      ['A.md', { frontmatter: { Owners: ['beta', 42] } }],
      ['B.md', { frontmatter: { owners: 'Alpha' } }],
      ['C.md', { frontmatter: { OWNERS: ['alpha', 'beta'] } }],
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

    expect(catalog.values('owners')).toEqual(['42', 'Alpha', 'beta']);
    expect(catalog.values('OWNERS')).toEqual(['42', 'Alpha', 'beta']);
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
