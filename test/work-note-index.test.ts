import { TFile, TFolder, type CachedMetadata } from 'obsidian';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkNoteIndex } from '../src/projects/work-notes/WorkNoteIndex';
import type { WorkNoteCompatibilityPreset } from '../src/projects/work-notes/types';

const fields: WorkNoteCompatibilityPreset['fields'] = {
  project: 'Project',
  status: 'Status',
  priority: 'Priority',
  description: 'Description',
  start: 'Start',
  end: 'End',
  created: 'Created',
  updated: 'Updated',
  id: 'ID',
  milestone: 'Milestone',
  blockedBy: 'Blocked by',
  related: 'Related',
};

const preset: WorkNoteCompatibilityPreset = {
  revision: 3,
  enabled: true,
  membershipQuery: '#work-note',
  ordinaryKindQuery: '#work-note/task',
  milestoneKindQuery: '#work-note/milestone',
  folder: 'Tasks',
  fields,
  rawStatusByStatusId: { active: 'Active', done: 'Done' },
};

function tfile(path: string): TFile {
  return Object.assign(Object.create(TFile.prototype) as object, {
    path,
    extension: path.endsWith('.md') ? 'md' : '',
  }) as TFile;
}

function tfolder(path: string): TFolder {
  return Object.assign(Object.create(TFolder.prototype) as object, {
    path,
    name: path.slice(path.lastIndexOf('/') + 1),
    children: [],
  }) as unknown as TFolder;
}

interface FileData {
  readonly path: string;
  readonly tags?: readonly string[];
  readonly frontmatter?: Record<string, unknown>;
}

function harness(initial: readonly FileData[], resolutions: Record<string, string | null>) {
  let files = initial.map(({ path }) => tfile(path));
  const linkResolutions = { ...resolutions };
  const data = new Map(initial.map((entry) => [entry.path, entry]));
  const metadataHandlers: Array<(file: TFile, text: string, cache: CachedMetadata) => void> = [];
  const vaultHandlers = new Map<string, Array<(...args: unknown[]) => void>>();
  const writes: string[] = [];
  const cacheReads: string[] = [];
  const offref = vi.fn();
  const on = (event: string, listener: (...args: never[]) => void): object => {
    if (event === 'changed') metadataHandlers.push(listener as never);
    else vaultHandlers.set(event, [...(vaultHandlers.get(event) ?? []), listener as never]);
    return { event, listener };
  };
  const cacheFor = (path: string): CachedMetadata => {
    const entry = data.get(path);
    return {
      frontmatter: entry?.frontmatter,
      tags: entry?.tags?.map((tag) => ({ tag })) as never,
    };
  };
  const app = {
    vault: {
      getMarkdownFiles: () => files,
      getAbstractFileByPath: (path: string) => files.find((file) => file.path === path) ?? null,
      modify: async () => writes.push('modify'),
      create: async () => writes.push('create'),
      process: async () => writes.push('process'),
      on,
      offref,
    },
    metadataCache: {
      getFileCache: (file: TFile) => {
        cacheReads.push(file.path);
        return cacheFor(file.path);
      },
      getFirstLinkpathDest: (linkpath: string, sourcePath: string) => {
        const path = linkResolutions[`${sourcePath}\0${linkpath}`];
        return path ? tfile(path) : null;
      },
      on,
      offref,
    },
  };
  return {
    app: app as never,
    writes,
    cacheReads,
    offref,
    metadata(path: string) {
      const file = files.find((candidate) => candidate.path === path)!;
      for (const handler of metadataHandlers) handler(file, '', cacheFor(path));
    },
    rename(oldPath: string, newPath: string) {
      const file = files.find((candidate) => candidate.path === oldPath)!;
      Object.assign(file, { path: newPath });
      files = [...files];
      const entry = data.get(oldPath);
      if (entry) {
        data.delete(oldPath);
        data.set(newPath, { ...entry, path: newPath });
      }
      for (const [key, target] of Object.entries(linkResolutions)) {
        const separator = key.indexOf('\0');
        const sourcePath = key.slice(0, separator);
        const linkpath = key.slice(separator + 1);
        const rewrittenSource = sourcePath === oldPath ? newPath : sourcePath;
        const rewrittenTarget = target === oldPath ? newPath : target;
        if (rewrittenSource !== sourcePath) delete linkResolutions[key];
        linkResolutions[`${rewrittenSource}\0${linkpath}`] = rewrittenTarget;
      }
      for (const handler of vaultHandlers.get('rename') ?? []) handler(file, oldPath);
    },
    renameFolder(oldPath: string, newPath: string) {
      const rewrite = (path: string): string =>
        path.startsWith(`${oldPath}/`) ? `${newPath}${path.slice(oldPath.length)}` : path;
      files = files.map((file) => tfile(rewrite(file.path)));
      for (const [path, entry] of [...data]) {
        const rewritten = rewrite(path);
        if (rewritten === path) continue;
        data.delete(path);
        data.set(rewritten, { ...entry, path: rewritten });
      }
      for (const [key, target] of Object.entries(linkResolutions)) {
        const separator = key.indexOf('\0');
        const sourcePath = key.slice(0, separator);
        const linkpath = key.slice(separator + 1);
        delete linkResolutions[key];
        linkResolutions[`${rewrite(sourcePath)}\0${linkpath}`] = target ? rewrite(target) : null;
      }
      const folder = tfolder(newPath);
      for (const handler of vaultHandlers.get('rename') ?? []) handler(folder, oldPath);
    },
    delete(path: string) {
      const file = files.find((candidate) => candidate.path === path)!;
      files = files.filter((candidate) => candidate !== file);
      data.delete(path);
      for (const [key, target] of Object.entries(linkResolutions)) {
        if (target === path) linkResolutions[key] = null;
      }
      for (const handler of vaultHandlers.get('delete') ?? []) handler(file);
    },
    setFrontmatter(path: string, frontmatter: Record<string, unknown>) {
      const prior = data.get(path)!;
      data.set(path, { ...prior, frontmatter });
    },
  };
}

afterEach(() => vi.useRealTimers());

describe('WorkNoteIndex', () => {
  it('keeps an eligible unknown status visible and diagnoses non-string dates', () => {
    const h = harness(
      [
        {
          path: 'Tasks/Unknown.md',
          tags: ['#work-note/task'],
          frontmatter: { Project: '[[Projects/A]]', Status: 'Review', Start: [2026, 8, 26] },
        },
      ],
      { 'Tasks/Unknown.md\0Projects/A': 'Projects/A.md' },
    );
    const index = new WorkNoteIndex(h.app, preset);
    index.initialize();

    expect(index.get('Tasks/Unknown.md')).toMatchObject({
      statusId: null,
      rawStatus: 'Review',
      writableStatusShape: true,
      range: { issue: 'invalid-start' },
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ type: 'unknown-status', rawValue: 'Review' }),
        expect.objectContaining({ type: 'non-scalar-date', field: 'start' }),
      ]),
    });
    index.destroy();
  });

  it('resolves relative and aliased project links through metadata cache', () => {
    const h = harness(
      [
        {
          path: 'Tasks/Sub/A.md',
          tags: ['#work-note/task'],
          frontmatter: { Project: '[[../../Projects/Canonical|Roadmap]]', Status: 'Active' },
        },
      ],
      { 'Tasks/Sub/A.md\0../../Projects/Canonical': 'Projects/Canonical.md' },
    );
    const index = new WorkNoteIndex(h.app, preset);
    index.initialize();
    expect(index.get('Tasks/Sub/A.md')?.projectPath).toBe('Projects/Canonical.md');
    index.destroy();
  });

  it('preserves project cardinality and relation diagnostics without stem guessing', () => {
    const h = harness(
      [
        {
          path: 'Tasks/A.md',
          tags: ['#work-note/task'],
          frontmatter: {
            Project: ['[[A]]', 'not a link'],
            Status: ['Active'],
            'Blocked by': ['[[Tasks/B]]', 7],
            Related: '[[Missing]]',
          },
        },
        { path: 'Projects/A.md' },
        { path: 'Archive/A.md' },
      ],
      { 'Tasks/A.md\0Tasks/B': 'Tasks/B.md' },
    );
    const index = new WorkNoteIndex(h.app, preset);
    index.initialize();

    expect(index.get('Tasks/A.md')).toBeUndefined();
    expect(index.diagnosticsFor('Tasks/A.md')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'ambiguous-project' }),
        expect.objectContaining({ type: 'non-scalar-status', rawValue: ['Active'] }),
        expect.objectContaining({ type: 'invalid-relation-entry', rawValue: 7 }),
        expect.objectContaining({ type: 'broken-relation', rawValue: '[[Missing]]' }),
      ]),
    );
    index.destroy();
  });

  it('performs zero writes during audit', async () => {
    const h = harness(
      [
        {
          path: 'Tasks/A.md',
          tags: ['#work-note/task'],
          frontmatter: { Project: '[[P]]', Status: 'Active' },
        },
      ],
      { 'Tasks/A.md\0P': 'Projects/P.md' },
    );
    const index = new WorkNoteIndex(h.app, preset);
    index.initialize();
    await index.audit();
    expect(h.writes).toEqual([]);
    index.destroy();
  });

  it('never guesses a duplicate basename', () => {
    const h = harness(
      [
        {
          path: 'Tasks/A.md',
          tags: ['#work-note/task'],
          frontmatter: { Project: '[[A]]', Status: 'Active' },
        },
        { path: 'Projects/A.md' },
        { path: 'Archive/A.md' },
      ],
      {},
    );
    const index = new WorkNoteIndex(h.app, preset);
    index.initialize();
    expect(index.diagnosticsFor('Tasks/A.md')).toContainEqual(
      expect.objectContaining({ type: 'ambiguous-project' }),
    );
    index.destroy();
  });

  it('invalidates old and new buckets when a resolved Project dependency is renamed', () => {
    vi.useFakeTimers();
    const h = harness(
      [
        {
          path: 'Tasks/A.md',
          tags: ['#work-note/task'],
          frontmatter: { Project: '[[Projects/A]]', Status: 'Active' },
        },
        { path: 'Projects/A.md' },
      ],
      { 'Tasks/A.md\0Projects/A': 'Projects/A.md' },
    );
    const index = new WorkNoteIndex(h.app, preset);
    index.initialize();
    const events: Array<{ invalidatedProjectPaths: readonly string[] }> = [];
    index.onUpdate((event) => events.push(event));

    h.rename('Projects/A.md', 'Elsewhere/A.md');
    vi.runAllTimers();

    expect(events[events.length - 1]?.invalidatedProjectPaths).toEqual([
      'Projects/A.md',
      'Elsewhere/A.md',
    ]);
    expect(index.get('Tasks/A.md')?.projectPath).toBe('Elsewhere/A.md');
    index.destroy();
  });

  it('invalidates the old bucket when a resolved Project dependency is deleted', () => {
    vi.useFakeTimers();
    const h = harness(
      [
        {
          path: 'Tasks/A.md',
          tags: ['#work-note/task'],
          frontmatter: { Project: '[[Projects/A]]', Status: 'Active' },
        },
        { path: 'Projects/A.md' },
      ],
      { 'Tasks/A.md\0Projects/A': 'Projects/A.md' },
    );
    const index = new WorkNoteIndex(h.app, preset);
    index.initialize();
    const events: Array<{
      changedPaths: readonly string[];
      invalidatedProjectPaths: readonly string[];
    }> = [];
    index.onUpdate((event) => events.push(event));

    h.delete('Projects/A.md');
    vi.runAllTimers();

    expect(events[events.length - 1]).toEqual({
      changedPaths: ['Tasks/A.md'],
      invalidatedProjectPaths: ['Projects/A.md'],
    });
    expect(index.get('Tasks/A.md')).toBeUndefined();
    index.destroy();
  });

  it('reindexes affected Work Notes and invalidates old and new buckets on folder rename', () => {
    vi.useFakeTimers();
    const h = harness(
      [
        {
          path: 'Workspace/Tasks/A.md',
          tags: ['#work-note/task'],
          frontmatter: { Project: '[[Workspace/Projects/A]]', Status: 'Active' },
        },
        { path: 'Workspace/Projects/A.md' },
      ],
      { 'Workspace/Tasks/A.md\0Workspace/Projects/A': 'Workspace/Projects/A.md' },
    );
    const index = new WorkNoteIndex(h.app, { ...preset, folder: '' });
    index.initialize();
    const events: Array<{
      changedPaths: readonly string[];
      invalidatedProjectPaths: readonly string[];
    }> = [];
    index.onUpdate((event) => events.push(event));

    h.renameFolder('Workspace', 'Archive');
    vi.runAllTimers();

    expect(events[events.length - 1]?.invalidatedProjectPaths).toEqual([
      'Workspace/Projects/A.md',
      'Archive/Projects/A.md',
    ]);
    expect(events[events.length - 1]?.changedPaths).toEqual([
      'Archive/Tasks/A.md',
      'Workspace/Tasks/A.md',
    ]);
    expect(index.get('Archive/Tasks/A.md')?.projectPath).toBe('Archive/Projects/A.md');
    index.destroy();
  });

  it('does not publish unrelated Markdown rename or delete paths as Project buckets', () => {
    vi.useFakeTimers();
    const h = harness(
      [
        {
          path: 'Tasks/A.md',
          tags: ['#work-note/task'],
          frontmatter: { Project: '[[Projects/A]]', Status: 'Active' },
        },
        { path: 'Projects/A.md' },
        { path: 'Notes/Unrelated.md' },
      ],
      { 'Tasks/A.md\0Projects/A': 'Projects/A.md' },
    );
    const index = new WorkNoteIndex(h.app, preset);
    index.initialize();
    const listener = vi.fn();
    index.onUpdate(listener);

    h.rename('Notes/Unrelated.md', 'Archive/Unrelated.md');
    vi.runAllTimers();
    h.delete('Archive/Unrelated.md');
    vi.runAllTimers();

    expect(listener).not.toHaveBeenCalled();
    index.destroy();
  });

  it('invalidates only the owning project bucket when a Work Note is deleted', () => {
    vi.useFakeTimers();
    const h = harness(
      [
        {
          path: 'Tasks/A.md',
          tags: ['#work-note/task'],
          frontmatter: { Project: '[[P]]', Status: 'Active' },
        },
        {
          path: 'Tasks/B.md',
          tags: ['#work-note/task'],
          frontmatter: { Project: '[[Q]]', Status: 'Active' },
        },
      ],
      { 'Tasks/A.md\0P': 'Projects/P.md', 'Tasks/B.md\0Q': 'Projects/Q.md' },
    );
    const index = new WorkNoteIndex(h.app, preset);
    index.initialize();
    const events: Array<{ invalidatedProjectPaths: readonly string[] }> = [];
    index.onUpdate((event) => events.push(event));

    h.delete('Tasks/A.md');
    vi.runAllTimers();

    expect(events[events.length - 1]?.invalidatedProjectPaths).toEqual(['Projects/P.md']);
    expect(
      (events[events.length - 1] as { changedPaths?: readonly string[] }).changedPaths,
    ).toEqual(['Tasks/A.md']);
    index.destroy();
  });

  it('forces a full reindex when the preset fingerprint changes', () => {
    vi.useFakeTimers();
    const h = harness(
      [
        {
          path: 'Tasks/A.md',
          tags: ['#work-note/task'],
          frontmatter: { Project: '[[P]]', Status: 'Active' },
        },
        {
          path: 'Tasks/B.md',
          tags: ['#work-note/task'],
          frontmatter: { Project: '[[P]]', Status: 'Active' },
        },
      ],
      { 'Tasks/A.md\0P': 'Projects/P.md', 'Tasks/B.md\0P': 'Projects/P.md' },
    );
    let current = preset;
    const index = new WorkNoteIndex(h.app, () => current);
    index.initialize();
    current = { ...preset, folder: 'Elsewhere' };

    h.metadata('Tasks/A.md');
    vi.runAllTimers();

    expect(index.list()).toEqual([]);
    index.destroy();
  });

  it('unsubscribes every Obsidian listener and cancels queued work on destroy', () => {
    vi.useFakeTimers();
    const h = harness([], {});
    const index = new WorkNoteIndex(h.app, preset);
    index.initialize();
    const listener = vi.fn();
    index.onUpdate(listener);
    index.destroy();
    vi.runAllTimers();

    expect(h.offref).toHaveBeenCalledTimes(4);
    expect(listener).not.toHaveBeenCalled();
  });

  it('coalesces metadata events and updates only affected snapshots', () => {
    vi.useFakeTimers();
    const h = harness(
      [
        {
          path: 'Tasks/A.md',
          tags: ['#work-note/task'],
          frontmatter: { Project: '[[P]]', Status: 'Active' },
        },
        {
          path: 'Tasks/B.md',
          tags: ['#work-note/task'],
          frontmatter: { Project: '[[P]]', Status: 'Active' },
        },
      ],
      { 'Tasks/A.md\0P': 'Projects/P.md', 'Tasks/B.md\0P': 'Projects/P.md' },
    );
    const index = new WorkNoteIndex(h.app, preset);
    index.initialize();
    h.cacheReads.length = 0;
    const listener = vi.fn();
    index.onUpdate(listener);
    h.setFrontmatter('Tasks/A.md', { Project: '[[P]]', Status: 'Done' });
    h.metadata('Tasks/A.md');
    h.metadata('Tasks/A.md');
    vi.runAllTimers();

    expect(index.get('Tasks/A.md')?.statusId).toBe('done');
    expect(h.cacheReads).toEqual(['Tasks/A.md']);
    expect(listener).toHaveBeenCalledTimes(1);
    index.destroy();
  });
});
