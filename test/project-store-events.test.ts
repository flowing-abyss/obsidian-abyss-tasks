import { TFile, type CachedMetadata } from 'obsidian';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProjectStore } from '../src/projects/ProjectStore';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import type { TaskIndexEvent, TaskQueryApi, TaskSnapshot } from '../src/tasks';
import { taskQueryApi } from './helpers';

function tfile(path: string, extension = 'md'): TFile {
  return Object.assign(Object.create(TFile.prototype) as object, {
    path,
    extension,
  }) as TFile;
}

function task(status: TaskSnapshot['status']): TaskSnapshot {
  return {
    ref: { filePath: 'Projects/A.md', line: 0, revision: `rev:${status}` },
    title: status,
    markdownTitle: status,
    status,
    statusSymbol: status === 'done' ? 'x' : ' ',
    priority: 'F',
    onCompletion: 'keep' as const,
    onCompletionExplicit: false,
    planning: {},
    tags: [],
    subtasks: [],
    comments: [],
    source: {
      filePath: 'Projects/A.md',
      line: 0,
      originalMarkdown: `- [ ] ${status}`,
      originalBlock: `- [ ] ${status}`,
    },
    presentation: { linkCount: 0 },
  };
}

function taskAt(path: string, status: TaskSnapshot['status']): TaskSnapshot {
  const snapshot = task(status);
  return {
    ...snapshot,
    ref: { ...snapshot.ref, filePath: path },
    source: { ...snapshot.source, filePath: path },
  };
}

function harness() {
  const file = tfile('Projects/A.md');
  let files = [file];
  const metadataChanged: Array<(file: TFile, data: string, cache: CachedMetadata) => void> = [];
  const vaultHandlers = new Map<string, Array<() => void>>();
  const refs = new Set<object>();
  const offref = vi.fn((ref: object) => refs.delete(ref));
  const on = (event: string, listener: (...args: never[]) => void): object => {
    const ref = { event, listener };
    refs.add(ref);
    if (event === 'changed') {
      metadataChanged.push(
        listener as unknown as (file: TFile, data: string, cache: CachedMetadata) => void,
      );
    } else {
      const handlers = vaultHandlers.get(event) ?? [];
      handlers.push(listener as unknown as () => void);
      vaultHandlers.set(event, handlers);
    }
    return ref;
  };
  const getMarkdownFiles = vi.fn(() => files);
  const app = {
    vault: {
      getMarkdownFiles,
      getAbstractFileByPath: (path: string) => files.find((candidate) => candidate.path === path),
      on,
      offref,
    },
    metadataCache: {
      getFileCache: () => ({ frontmatter: { status: 'active' } }),
      on,
      offref,
    },
  };
  let snapshots: readonly TaskSnapshot[] = [task('open')];
  let indexListener: ((event: TaskIndexEvent) => void) | undefined;
  const indexUnsub = vi.fn();
  const queries: TaskQueryApi = taskQueryApi({
    list: (query) =>
      snapshots.filter(
        (snapshot) => query?.filePath === undefined || snapshot.ref.filePath === query.filePath,
      ),
    resolve: vi.fn(),
    subscribe: (listener) => {
      indexListener = listener;
      return indexUnsub;
    },
  });
  return {
    app: app as never,
    queries,
    metadata: (changedFile: TFile = file, data = '', cache = { listItems: [] } as CachedMetadata) =>
      metadataChanged[0]?.(changedFile, data, cache),
    vault: (
      event: 'create' | 'delete' | 'rename',
      changedFile: TFile = file,
      oldPath = 'Old.md',
    ) => {
      for (const listener of vaultHandlers.get(event) ?? []) {
        (listener as (...args: unknown[]) => void)(changedFile, oldPath);
      }
    },
    index: (event: TaskIndexEvent) => indexListener?.(event),
    setTasks: (next: readonly TaskSnapshot[]) => {
      snapshots = next;
    },
    setFiles: (next: TFile[]) => {
      files = next;
    },
    file,
    indexUnsub,
    offref,
    getMarkdownFiles,
  };
}

afterEach(() => vi.useRealTimers());

describe('ProjectStore event convergence', () => {
  it.each(['changed', 'renamed'] as const)(
    'does not let a late equivalent empty-project %s event release unrelated task metadata',
    (lateEvent) => {
      vi.useFakeTimers();
      const h = harness();
      const empty = tfile('Projects/B.md');
      if (lateEvent === 'renamed') h.setFiles([h.file, empty]);
      const store = new ProjectStore(h.app, h.queries, DEFAULT_SETTINGS);
      store.initialize();
      const listener = vi.fn();
      store.onUpdate(listener);

      h.setTasks([task('done')]);
      h.metadata(h.file);
      if (lateEvent === 'changed') {
        h.setFiles([h.file, empty]);
        h.vault('create', empty);
        h.metadata(empty);
      } else {
        const renamed = tfile('Projects/C.md');
        h.setFiles([h.file, renamed]);
        h.vault('rename', renamed, empty.path);
      }
      vi.advanceTimersByTime(150);
      expect(listener).toHaveBeenCalledOnce();
      listener.mockClear();

      if (lateEvent === 'changed') {
        h.index({ type: 'changed', files: [empty.path] });
      } else {
        h.index({ type: 'renamed', oldPath: empty.path, newPath: 'Projects/C.md' });
      }
      vi.advanceTimersByTime(150);
      expect(store.get(h.file.path)?.stats.done).toBe(0);
      expect(listener).not.toHaveBeenCalled();

      h.index({ type: 'changed', files: [h.file.path] });
      vi.advanceTimersByTime(150);
      expect(store.get(h.file.path)?.stats.done).toBe(1);
      expect(listener).toHaveBeenCalledOnce();
      store.destroy();
    },
  );

  it('waits for TaskIndex when task metadata arrives before a created file is indexed', () => {
    vi.useFakeTimers();
    const h = harness();
    const store = new ProjectStore(h.app, h.queries, DEFAULT_SETTINGS);
    store.initialize();
    const listener = vi.fn();
    store.onUpdate(listener);
    const created = tfile('Projects/B.md');
    h.setFiles([h.file, created]);
    h.vault('create', created);
    h.metadata(created, '- [ ] New task', {
      listItems: [
        {
          task: ' ',
          parent: -1,
          position: {
            start: { line: 0, col: 0, offset: 0 },
            end: { line: 0, col: 14, offset: 14 },
          },
        },
      ],
    } as CachedMetadata);

    expect(store.get(created.path)).toBeUndefined();
    expect(listener).not.toHaveBeenCalled();

    h.setTasks([task('open'), taskAt(created.path, 'open')]);
    h.index({ type: 'changed', files: [created.path] });
    vi.advanceTimersByTime(150);
    expect(store.get(created.path)?.stats.total).toBe(1);
    expect(listener).toHaveBeenCalledOnce();
    store.destroy();
  });

  it.each(['create', 'delete', 'rename'] as const)(
    'settles an empty project %s without flushing unrelated task work or waiting for an index event',
    (event) => {
      vi.useFakeTimers();
      const h = harness();
      const oldProject = tfile('Projects/B.md');
      if (event !== 'create') h.setFiles([h.file, oldProject]);
      const store = new ProjectStore(h.app, h.queries, DEFAULT_SETTINGS);
      store.initialize();
      const listener = vi.fn();
      store.onUpdate(listener);
      h.setTasks([task('done')]);
      h.metadata(h.file);

      if (event === 'create') {
        const created = tfile('Projects/B.md');
        h.setFiles([h.file, created]);
        h.vault('create', created);
        h.metadata(created);
      } else if (event === 'delete') {
        h.setFiles([h.file]);
        h.vault('delete', oldProject);
      } else {
        const renamed = tfile('Projects/C.md');
        h.setFiles([h.file, renamed]);
        h.vault('rename', renamed, oldProject.path);
      }

      expect(listener).not.toHaveBeenCalled();
      vi.advanceTimersByTime(150);
      expect(store.get('Projects/A.md')?.stats.done).toBe(0);
      if (event === 'create') expect(store.get('Projects/B.md')).toBeDefined();
      else expect(store.get('Projects/B.md')).toBeUndefined();
      if (event === 'rename') expect(store.get('Projects/C.md')).toBeDefined();
      expect(listener).toHaveBeenCalledOnce();

      h.index({ type: 'changed', files: ['Projects/A.md'] });
      vi.advanceTimersByTime(150);
      expect(store.get('Projects/A.md')?.stats.done).toBe(1);
      expect(listener).toHaveBeenCalledTimes(2);
      store.destroy();
    },
  );

  it.each(['metadata-first', 'index-first'] as const)(
    'coalesces %s delivery and publishes once from consistent index data',
    (order) => {
      vi.useFakeTimers();
      const h = harness();
      const store = new ProjectStore(h.app, h.queries, DEFAULT_SETTINGS);
      store.initialize();
      const listener = vi.fn();
      store.onUpdate(listener);
      h.setTasks([task('done')]);
      if (order === 'metadata-first') {
        h.metadata();
        h.index({ type: 'changed', files: ['Projects/A.md'] });
      } else {
        h.index({ type: 'changed', files: ['Projects/A.md'] });
        h.metadata();
      }
      vi.advanceTimersByTime(150);
      expect(store.get('Projects/A.md')?.stats.done).toBe(1);
      expect(listener).toHaveBeenCalledTimes(1);
      store.destroy();
    },
  );

  it('keeps an empty project note and unsubscribes index plus Obsidian streams', () => {
    const h = harness();
    h.setTasks([]);
    const store = new ProjectStore(h.app, h.queries, DEFAULT_SETTINGS);
    store.initialize();
    expect(store.get('Projects/A.md')).toBeDefined();
    store.destroy();
    expect(h.indexUnsub).toHaveBeenCalledTimes(1);
    expect(h.offref).toHaveBeenCalledTimes(4);
  });

  it('waits for a delayed task-index barrier before publishing metadata changes', () => {
    vi.useFakeTimers();
    const h = harness();
    const store = new ProjectStore(h.app, h.queries, DEFAULT_SETTINGS);
    store.initialize();
    const listener = vi.fn();
    store.onUpdate(listener);
    h.setTasks([task('done')]);
    h.metadata();
    vi.advanceTimersByTime(1_000);
    expect(listener).not.toHaveBeenCalled();
    expect(store.get('Projects/A.md')?.stats.done).toBe(0);
    h.index({ type: 'changed', files: ['Projects/A.md'] });
    vi.advanceTimersByTime(150);
    expect(listener).toHaveBeenCalledOnce();
    expect(store.get('Projects/A.md')?.stats.done).toBe(1);
    store.destroy();
  });

  it('ignores a stale markdown metadata event whose file is no longer current', () => {
    vi.useFakeTimers();
    const h = harness();
    const store = new ProjectStore(h.app, h.queries, DEFAULT_SETTINGS);
    store.initialize();
    h.setTasks([task('done')]);
    h.metadata(tfile('Projects/A.md'));
    h.index({ type: 'changed', files: ['Other.md'] });
    vi.advanceTimersByTime(150);
    expect(store.get('Projects/A.md')?.stats.done).toBe(0);
    store.destroy();
  });

  it.each(['create', 'rename'] as const)(
    'uses the task-index %s event as the full-rescan barrier',
    (event) => {
      vi.useFakeTimers();
      const h = harness();
      h.setFiles([]);
      h.setTasks([]);
      const store = new ProjectStore(h.app, h.queries, DEFAULT_SETTINGS);
      store.initialize();
      const listener = vi.fn();
      store.onUpdate(listener);
      h.setFiles([h.file]);
      h.setTasks([task('open')]);
      h.vault(event, h.file, 'Old.md');
      vi.advanceTimersByTime(1_000);
      expect(listener).not.toHaveBeenCalled();
      if (event === 'create') h.index({ type: 'changed', files: ['Projects/A.md'] });
      else h.index({ type: 'renamed', oldPath: 'Old.md', newPath: 'Projects/A.md' });
      vi.advanceTimersByTime(150);
      expect(listener).toHaveBeenCalledOnce();
      expect(store.get('Projects/A.md')).toBeDefined();
      store.destroy();
    },
  );

  it.each(['create', 'delete', 'rename'] as const)(
    'ignores attachment %s so an unrelated task event cannot flush a latent full rescan',
    (event) => {
      vi.useFakeTimers();
      const h = harness();
      const store = new ProjectStore(h.app, h.queries, DEFAULT_SETTINGS);
      store.initialize();
      h.vault(event, tfile('asset.png', 'png'), 'old-asset.png');
      h.index({ type: 'changed', files: ['Projects/A.md'] });
      vi.advanceTimersByTime(150);
      expect(h.getMarkdownFiles).toHaveBeenCalledOnce();
      store.destroy();
    },
  );

  it('settles a markdown-to-attachment rename from its scoped index barrier', () => {
    vi.useFakeTimers();
    const h = harness();
    const store = new ProjectStore(h.app, h.queries, DEFAULT_SETTINGS);
    store.initialize();
    const listener = vi.fn();
    store.onUpdate(listener);
    const attachment = tfile('Projects/A.png', 'png');
    h.setFiles([attachment]);
    h.vault('rename', attachment, 'Projects/A.md');
    vi.advanceTimersByTime(1_000);
    expect(store.get('Projects/A.md')).toBeDefined();
    expect(listener).not.toHaveBeenCalled();
    expect(h.getMarkdownFiles).toHaveBeenCalledOnce();
    h.index({ type: 'renamed', oldPath: 'Projects/A.md', newPath: 'Projects/A.png' });
    vi.advanceTimersByTime(150);
    expect(store.get('Projects/A.md')).toBeUndefined();
    expect(listener).toHaveBeenCalledOnce();
    expect(h.getMarkdownFiles).toHaveBeenCalledOnce();
    store.destroy();
  });
});
