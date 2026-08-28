import { TFile, TFolder, type CachedMetadata } from 'obsidian';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveSemanticProjectStatus } from '../src/projects/lifecycle';
import { WorkNoteIndex } from '../src/projects/work-notes/WorkNoteIndex';
import { acceptWorkNoteAudit } from '../src/projects/work-notes/compatibility';
import { workNoteLifecycleBehavior } from '../src/projects/work-notes/rollups';
import type {
  WorkNoteCompatibilityPreset,
  WorkNoteIndexEvent,
} from '../src/projects/work-notes/types';
import type { ProjectStatus } from '../src/settings/types';
import type { TaskIndexSettledEvent } from '../src/tasks';

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

type StatusAwareWorkNoteIndexConstructor = new (
  app: ConstructorParameters<typeof WorkNoteIndex>[0],
  configuredPreset: ConstructorParameters<typeof WorkNoteIndex>[1],
  taskSettlements: ConstructorParameters<typeof WorkNoteIndex>[2],
  projectStatuses: () => readonly ProjectStatus[],
) => WorkNoteIndex;

function statusAwareIndex(
  app: ConstructorParameters<typeof WorkNoteIndex>[0],
  configuredPreset: WorkNoteCompatibilityPreset,
  projectStatuses: () => readonly ProjectStatus[],
): WorkNoteIndex {
  const Constructor = WorkNoteIndex as unknown as StatusAwareWorkNoteIndexConstructor;
  return new Constructor(app, configuredPreset, undefined, projectStatuses);
}

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

function taskSettlementSource() {
  const listeners: Array<(event: TaskIndexSettledEvent) => void> = [];
  return {
    source: {
      subscribeSettled(listener: (event: TaskIndexSettledEvent) => void) {
        listeners.push(listener);
        return () => {};
      },
    },
    settle(path: string, generation: number) {
      for (const listener of listeners) {
        listener({ type: 'settled', reason: 'index', files: [{ path, generation }] });
      }
    },
    settleFolderRename(
      oldPath: string,
      newPath: string,
      files: readonly { path: string; generation: number }[],
    ) {
      for (const listener of listeners) {
        listener({
          type: 'settled',
          reason: 'topology',
          topology: { type: 'folder-rename', oldPath, newPath },
          files,
        });
      }
    },
  };
}

afterEach(() => vi.useRealTimers());

describe('WorkNoteIndex', () => {
  it('keeps the last working Work Note index and exposes source-specific query diagnostics', () => {
    vi.useFakeTimers();
    const h = harness(
      [
        {
          path: 'Tasks/A.md',
          tags: ['#work-note/task'],
          frontmatter: { Project: '[[Projects/A]]', Status: 'Active' },
        },
      ],
      { 'Tasks/A.md\0Projects/A': 'Projects/A.md' },
    );
    let current = preset;
    const index = new WorkNoteIndex(h.app, () => current);
    index.initialize();

    current = { ...preset, membershipQuery: '#work-note AND (' };
    h.metadata('Tasks/A.md');
    vi.runAllTimers();

    expect(index.list().map(({ path }) => path)).toEqual(['Tasks/A.md']);
    expect(index.queryDiagnostics()).toEqual([
      { source: 'membershipQuery', code: 'unclosed-parenthesis', offset: 15 },
    ]);
    index.destroy();
  });

  it.each(['tasks-changed', 'tasks-unchanged'] as const)(
    'publishes the exact Task barrier for a metadata edit when %s',
    (taskResult) => {
      vi.useFakeTimers();
      const path = 'Tasks/A.md';
      const h = harness(
        [
          {
            path,
            tags: ['#work-note/task'],
            frontmatter: { Project: '[[Projects/A]]', Status: 'Active' },
          },
        ],
        { [`${path}\0Projects/A`]: 'Projects/A.md' },
      );
      const taskSource = taskSettlementSource();
      const index = new WorkNoteIndex(h.app, preset, taskSource.source);
      index.initialize();
      const updates: unknown[] = [];
      const settlements: unknown[] = [];
      index.onUpdate((event) => updates.push(event));
      index.onSettled((event) => settlements.push(event));

      h.setFrontmatter(path, {
        Project: '[[Projects/A]]',
        Status: taskResult === 'tasks-changed' ? 'Done' : 'Active',
        Priority: 'High',
      });
      h.metadata(path);
      vi.runAllTimers();
      expect(updates).toEqual([]);
      expect(settlements).toEqual([]);

      taskSource.settle(path, 7);
      vi.runAllTimers();
      expect(updates).toEqual([
        {
          cause: 'index',
          changedPaths: [path],
          invalidatedProjectPaths: ['Projects/A.md'],
          taskBarriers: [{ path, generation: 7 }],
        },
      ]);
      expect(settlements).toEqual([{ reason: 'index', files: [{ path, generation: 2 }] }]);
      index.destroy();
    },
  );

  it('marks an explicit refresh distinctly without fabricating a Task barrier', () => {
    vi.useFakeTimers();
    const path = 'Tasks/A.md';
    const h = harness(
      [
        {
          path,
          tags: ['#work-note/task'],
          frontmatter: { Project: '[[Projects/A]]', Status: 'Active' },
        },
      ],
      { [`${path}\0Projects/A`]: 'Projects/A.md' },
    );
    const taskSource = taskSettlementSource();
    const index = new WorkNoteIndex(h.app, preset, taskSource.source);
    index.initialize();
    const updates: unknown[] = [];
    index.onUpdate((event) => updates.push(event));
    h.setFrontmatter(path, { Project: '[[Projects/A]]', Status: 'Done' });

    index.refresh();
    vi.runAllTimers();

    expect(updates).toEqual([
      {
        cause: 'refresh',
        changedPaths: [path],
        invalidatedProjectPaths: ['Projects/A.md'],
        taskBarriers: [],
      },
    ]);
    index.destroy();
  });

  it('does not scan the vault while the compatibility preset is disabled', async () => {
    const h = harness([{ path: 'Notes/A.md' }], {});
    const getMarkdownFiles = vi.spyOn(
      (h.app as never as { vault: { getMarkdownFiles(): TFile[] } }).vault,
      'getMarkdownFiles',
    );
    const index = new WorkNoteIndex(h.app, { ...preset, enabled: false });

    index.initialize();
    await index.audit();

    expect(getMarkdownFiles).not.toHaveBeenCalled();
    expect(index.list()).toEqual([]);
    index.destroy();
  });

  it('previews a disabled unaccepted preset through aggregate-only production metadata', async () => {
    const h = harness(
      [
        {
          path: 'Private Notes/Secret ordinary.md',
          tags: ['#work-note/task'],
          frontmatter: {
            Project: '[[Projects/Secret project]]',
            Status: 'Private active value',
          },
        },
        {
          path: 'Private Notes/Secret milestone.md',
          tags: ['#work-note/milestone'],
          frontmatter: {
            Project: '[[Projects/Secret project]]',
            Status: 'Private done value',
            Related: '[[Missing private relation]]',
          },
        },
        {
          path: 'Unrelated private note.md',
          tags: [],
          frontmatter: { Status: 'Unrelated private value' },
        },
      ],
      {
        'Private Notes/Secret ordinary.md\0Projects/Secret project': 'Projects/Secret project.md',
        'Private Notes/Secret milestone.md\0Projects/Secret project': 'Projects/Secret project.md',
      },
    );
    const disabled = { ...preset, enabled: false, acceptedAudit: undefined };
    const before = structuredClone(disabled);
    const index = new WorkNoteIndex(h.app, disabled);

    const preview = await index.previewCompatibility();

    expect(preview).toMatchObject({
      preset: { enabled: false, accepted: false },
      notes: { scanned: 3, eligible: 2, excluded: 0 },
      kinds: { ordinary: 1, milestone: 1, ambiguous: 0, missing: 0 },
      links: { brokenRelation: 1 },
      cardinality: { missingProject: 0, multipleProjects: 0, multipleMilestones: 0 },
      capabilities: { update: false, create: false },
    });
    expect(preview.diagnostics['broken-relation']).toBe(1);
    expect(disabled).toEqual(before);
    expect(h.writes).toEqual([]);
    const serialized = JSON.stringify(preview);
    expect(serialized).not.toContain('Private Notes');
    expect(serialized).not.toContain('Secret');
    expect(serialized).not.toContain('Private active value');
    expect(serialized).not.toContain('Private done value');
    expect(serialized).not.toContain('Missing private relation');
    expect(serialized).not.toContain('Unrelated private');
    index.destroy();
  });

  it('accepts a safe inferred creation contract when both kind markers are unambiguous', async () => {
    const h = harness(
      [
        {
          path: 'Work Notes/A.md',
          tags: ['#work-note/task'],
          frontmatter: { Project: '[[Projects/A]]', Status: 'Active' },
        },
        {
          path: 'Work Notes/M.md',
          tags: ['#work-note/milestone'],
          frontmatter: { Project: '[[Projects/A]]', Status: 'Done' },
        },
      ],
      {
        'Work Notes/A.md\0Projects/A': 'Projects/A.md',
        'Work Notes/M.md\0Projects/A': 'Projects/A.md',
      },
    );
    const index = new WorkNoteIndex(h.app, { ...preset, enabled: false });

    const preview = await index.previewCompatibility();
    const accepted = await index.acceptSuggestedCompatibility(
      preview.acceptanceToken!,
      '2026-08-27T00:00:00Z',
    );

    expect(accepted.type).toBe('ok');
    if (accepted.type !== 'ok') throw new Error('Expected exact preview acceptance');
    expect(accepted.preset.creation).toMatchObject({
      folder: 'Work Notes',
      defaultKind: 'ordinary',
      defaultStatusId: 'active',
      kindMarkers: {
        ordinary: { kind: 'frontmatter-tag', value: 'work-note/task' },
        milestone: { kind: 'frontmatter-tag', value: 'work-note/milestone' },
      },
    });
    expect(accepted.preview.capabilities).toEqual({ update: true, create: true });
  });

  it('intersects live capabilities with the accepted audit ceiling for an enabled preset', async () => {
    const h = harness(
      [
        {
          path: 'Work Notes/A.md',
          tags: ['#work-note/task'],
          frontmatter: { Project: '[[Projects/A]]', Status: 'Active' },
        },
        {
          path: 'Work Notes/M.md',
          tags: ['#work-note/milestone'],
          frontmatter: { Project: '[[Projects/A]]', Status: 'Done' },
        },
      ],
      {
        'Work Notes/A.md\0Projects/A': 'Projects/A.md',
        'Work Notes/M.md\0Projects/A': 'Projects/A.md',
      },
    );
    const candidate = acceptWorkNoteAudit(
      {
        ...preset,
        creation: {
          folder: 'Work Notes',
          defaultKind: 'ordinary',
          defaultStatusId: 'active',
          kindMarkers: {
            ordinary: { kind: 'frontmatter-tag', value: 'work-note/task' },
            milestone: { kind: 'frontmatter-tag', value: 'work-note/milestone' },
          },
        },
      },
      { update: false, create: true },
      '2026-08-27T00:00:00Z',
    );
    const index = new WorkNoteIndex(h.app, candidate);

    expect((await index.previewCompatibility()).capabilities).toEqual({
      update: false,
      create: false,
    });
  });

  it('reuses semantic Project status ids and keeps an unmatched raw status collision-free', async () => {
    const h = harness(
      [
        {
          path: 'Work Notes/A.md',
          tags: ['#work-note/task'],
          frontmatter: { Project: '[[Projects/A]]', Status: 'ACTIVE' },
        },
        {
          path: 'Work Notes/B.md',
          tags: ['#work-note/task'],
          frontmatter: { Project: '[[Projects/A]]', Status: 'dOnE' },
        },
        {
          path: 'Work Notes/C.md',
          tags: ['#work-note/task'],
          frontmatter: { Project: '[[Projects/A]]', Status: 'review' },
        },
      ],
      {
        'Work Notes/A.md\0Projects/A': 'Projects/A.md',
        'Work Notes/B.md\0Projects/A': 'Projects/A.md',
        'Work Notes/C.md\0Projects/A': 'Projects/A.md',
      },
    );
    const projectStatuses: readonly ProjectStatus[] = [
      {
        id: 'project-active-id',
        label: 'Active',
        onLeftPanel: true,
        behavior: 'regular',
        match: { kind: 'property', property: 'status', value: 'in progress' },
      },
      {
        id: 'project-done-id',
        label: 'Complete',
        onLeftPanel: false,
        behavior: 'completed',
        match: { kind: 'property', property: 'status', value: 'Done' },
      },
      {
        id: 'review',
        label: 'Someday',
        onLeftPanel: false,
        behavior: 'regular',
        match: { kind: 'property', property: 'status', value: 'someday' },
      },
    ];
    const index = statusAwareIndex(h.app, { ...preset, enabled: false }, () => projectStatuses);

    const preview = await index.previewCompatibility();
    const accepted = await index.acceptSuggestedCompatibility(
      preview.acceptanceToken!,
      '2026-08-27T00:00:00Z',
    );

    expect(accepted.type).toBe('ok');
    if (accepted.type !== 'ok') throw new Error('Expected exact preview acceptance');
    expect(accepted.preset.rawStatusByStatusId['project-active-id']).toBe('ACTIVE');
    expect(accepted.preset.rawStatusByStatusId['project-done-id']).toBe('dOnE');
    const unmatched = Object.entries(accepted.preset.rawStatusByStatusId).find(
      ([, raw]) => raw === 'review',
    );
    expect(unmatched).toBeDefined();
    expect(unmatched?.[0]).not.toBe('review');
    expect(projectStatuses.map(({ id }) => id)).not.toContain(unmatched?.[0]);
  });

  it('rejects acceptance when the Project status provider changes after preview', async () => {
    const path = 'Work Notes/A.md';
    const h = harness(
      [
        {
          path,
          tags: ['#work-note/task'],
          frontmatter: { Project: '[[Projects/A]]', Status: 'Active' },
        },
      ],
      { [`${path}\0Projects/A`]: 'Projects/A.md' },
    );
    let statuses: readonly ProjectStatus[] = [
      {
        id: 'active-v1',
        label: 'Active',
        onLeftPanel: true,
        behavior: 'regular',
        match: { kind: 'property', property: 'status', value: 'active' },
      },
    ];
    const index = statusAwareIndex(h.app, { ...preset, enabled: false }, () => statuses);
    const preview = await index.previewCompatibility();
    statuses = [{ ...statuses[0]!, id: 'active-v2' }];

    expect(
      await index.acceptSuggestedCompatibility(preview.acceptanceToken!, '2026-08-27T00:00:00Z'),
    ).toEqual({ type: 'stale-preview' });
  });

  it('does not stale an exact preview for presentation-only Project status changes', async () => {
    const path = 'Work Notes/A.md';
    const h = harness(
      [
        {
          path,
          tags: ['#work-note/task'],
          frontmatter: { Project: '[[Projects/A]]', Status: 'Active' },
        },
      ],
      { [`${path}\0Projects/A`]: 'Projects/A.md' },
    );
    let statuses: readonly ProjectStatus[] = [
      {
        id: 'active',
        label: 'Active',
        color: '#123456',
        onLeftPanel: true,
        behavior: 'regular',
        match: { kind: 'property', property: 'status', value: 'active' },
      },
    ];
    const index = statusAwareIndex(h.app, { ...preset, enabled: false }, () => statuses);
    const preview = await index.previewCompatibility();
    statuses = [{ ...statuses[0]!, color: '#abcdef', onLeftPanel: false }];

    expect(
      await index.acceptSuggestedCompatibility(preview.acceptanceToken!, '2026-08-27T00:00:00Z'),
    ).toMatchObject({ type: 'ok' });
  });

  it.each(['id', 'label', 'match', 'behavior'] as const)(
    'stales an exact preview when mapping-relevant Project status %s changes',
    async (field) => {
      const path = 'Work Notes/A.md';
      const h = harness(
        [
          {
            path,
            tags: ['#work-note/task'],
            frontmatter: { Project: '[[Projects/A]]', Status: 'Active' },
          },
        ],
        { [`${path}\0Projects/A`]: 'Projects/A.md' },
      );
      let statuses: readonly ProjectStatus[] = [
        {
          id: 'active',
          label: 'Active',
          onLeftPanel: true,
          behavior: 'regular',
          match: { kind: 'property', property: 'status', value: 'active' },
        },
      ];
      const index = statusAwareIndex(h.app, { ...preset, enabled: false }, () => statuses);
      const preview = await index.previewCompatibility();
      statuses = [
        field === 'id'
          ? { ...statuses[0]!, id: 'active-v2' }
          : field === 'label'
            ? { ...statuses[0]!, label: 'Doing' }
            : field === 'match'
              ? {
                  ...statuses[0]!,
                  match: { kind: 'property', property: 'status', value: 'doing' },
                }
              : { ...statuses[0]!, behavior: 'completed' },
      ];

      expect(
        await index.acceptSuggestedCompatibility(preview.acceptanceToken!, '2026-08-27T00:00:00Z'),
      ).toEqual({ type: 'stale-preview' });
    },
  );

  it('keeps case aliases collision-free and disables both writes when they target one Project status', async () => {
    const paths = ['Work Notes/A.md', 'Work Notes/B.md'];
    const h = harness(
      paths.map((path, index) => ({
        path,
        tags: ['#work-note/task'],
        frontmatter: { Project: '[[Projects/A]]', Status: index === 0 ? 'Done' : 'done' },
      })),
      Object.fromEntries(paths.map((path) => [`${path}\0Projects/A`, 'Projects/A.md'])),
    );
    const statuses: readonly ProjectStatus[] = [
      {
        id: 'canonical-done',
        label: 'Done',
        onLeftPanel: false,
        behavior: 'completed',
        match: { kind: 'property', property: 'status', value: 'done' },
      },
      {
        id: 'canonical-done-2',
        label: 'Reviewed',
        onLeftPanel: false,
        behavior: 'regular',
        match: { kind: 'property', property: 'status', value: 'reviewed' },
      },
    ];
    const index = statusAwareIndex(h.app, { ...preset, enabled: false }, () => statuses);
    const preview = await index.previewCompatibility();
    const accepted = await index.acceptSuggestedCompatibility(
      preview.acceptanceToken!,
      '2026-08-27T00:00:00Z',
    );

    expect(accepted.type).toBe('ok');
    if (accepted.type !== 'ok') throw new Error('Expected safe read-only acceptance');
    expect(Object.values(accepted.preset.rawStatusByStatusId).sort()).toEqual(['Done', 'done']);
    expect(new Set(Object.keys(accepted.preset.rawStatusByStatusId)).size).toBe(2);
    const alias = Object.entries(accepted.preset.rawStatusByStatusId).find(
      ([id]) => id !== 'canonical-done',
    )!;
    expect(alias[0]).not.toBe('canonical-done-2');
    expect(
      workNoteLifecycleBehavior(
        {
          ...(index.list()[0] ?? (await index.audit()).snapshots[0]!),
          statusId: alias[0],
          rawStatus: alias[1],
        },
        statuses,
      ),
    ).toBe('completed');
    expect(accepted.preview.capabilities).toEqual({ update: false, create: false });
  });

  it('preserves prototype-like and Unicode raw statuses with collision-free fallback ids', async () => {
    const rawStatuses = ['__proto__', 'constructor', 'toString', '🧪', '🧪️'];
    const paths = rawStatuses.map((_, index) => `Work Notes/${String(index)}.md`);
    const h = harness(
      paths.map((path, index) => ({
        path,
        tags: ['#work-note/task'],
        frontmatter: { Project: '[[Projects/A]]', Status: rawStatuses[index] },
      })),
      Object.fromEntries(paths.map((path) => [`${path}\0Projects/A`, 'Projects/A.md'])),
    );
    const reserved = ['__proto__', 'constructor', 'toString', 'status', 'work-note-status'];
    const statuses: readonly ProjectStatus[] = reserved.map((id) => ({
      id,
      label: `Reserved ${id}`,
      onLeftPanel: false,
      behavior: 'regular',
      match: { kind: 'property', property: 'status', value: `reserved-${id}` },
    }));
    const index = statusAwareIndex(h.app, { ...preset, enabled: false }, () => statuses);
    const preview = await index.previewCompatibility();
    const accepted = await index.acceptSuggestedCompatibility(
      preview.acceptanceToken!,
      '2026-08-27T00:00:00Z',
    );

    expect(accepted.type).toBe('ok');
    if (accepted.type !== 'ok') throw new Error('Expected collision-free acceptance');
    const mapping = accepted.preset.rawStatusByStatusId;
    expect(Object.values(mapping).sort()).toEqual([...rawStatuses].sort());
    expect(Object.keys(mapping)).toHaveLength(rawStatuses.length);
    expect(Object.keys(mapping).some((id) => reserved.includes(id))).toBe(false);
  });

  it.each([
    ['✅️ Ｄｏｎｅ', 'Done'],
    ['Done', '✅ Ｄｏｎｅ'],
  ])(
    'matches emoji, variation selectors, and NFKC status semantics symmetrically',
    async (label, raw) => {
      const path = 'Work Notes/A.md';
      const h = harness(
        [
          {
            path,
            tags: ['#work-note/task'],
            frontmatter: { Project: '[[Projects/A]]', Status: raw },
          },
        ],
        { [`${path}\0Projects/A`]: 'Projects/A.md' },
      );
      const statuses: readonly ProjectStatus[] = [
        {
          id: 'canonical-done',
          label,
          onLeftPanel: false,
          behavior: 'completed',
          match: { kind: 'property', property: 'status', value: 'unrelated' },
        },
      ];
      const index = statusAwareIndex(h.app, { ...preset, enabled: false }, () => statuses);
      const preview = await index.previewCompatibility();
      const accepted = await index.acceptSuggestedCompatibility(
        preview.acceptanceToken!,
        '2026-08-27T00:00:00Z',
      );

      expect(accepted.type).toBe('ok');
      if (accepted.type !== 'ok') throw new Error('Expected semantic acceptance');
      expect(accepted.preset.rawStatusByStatusId['canonical-done']).toBe(raw);
    },
  );

  it.each([
    ['unrelated emoji-only', '✅'],
    ['blank', '   '],
  ])(
    'does not treat an emoji-only raw status as a canonical %s Project status',
    async (_, label) => {
      const path = 'Work Notes/A.md';
      const rawStatus = '🧪️';
      const h = harness(
        [
          {
            path,
            tags: ['#work-note/task'],
            frontmatter: { Project: '[[Projects/A]]', Status: rawStatus },
          },
        ],
        { [`${path}\0Projects/A`]: 'Projects/A.md' },
      );
      const statuses: readonly ProjectStatus[] = [
        {
          id: 'configured-status',
          label,
          onLeftPanel: false,
          behavior: 'completed',
          match: { kind: 'property', property: 'status', value: label },
        },
      ];
      expect(resolveSemanticProjectStatus(statuses, rawStatus)).toEqual({ type: 'unmatched' });
      const index = statusAwareIndex(h.app, { ...preset, enabled: false }, () => statuses);

      const preview = await index.previewCompatibility();
      const accepted = await index.acceptSuggestedCompatibility(
        preview.acceptanceToken!,
        '2026-08-27T00:00:00Z',
      );

      expect(accepted.type).toBe('ok');
      if (accepted.type !== 'ok') throw new Error('Expected read-only fallback acceptance');
      expect(accepted.preset.rawStatusByStatusId['configured-status']).toBeUndefined();
      const fallback = Object.entries(accepted.preset.rawStatusByStatusId).find(
        ([, raw]) => raw === rawStatus,
      )!;
      expect(
        workNoteLifecycleBehavior(
          {
            path,
            presetRevision: accepted.preset.revision,
            presetFingerprint: '',
            kind: 'ordinary',
            projectPath: 'Projects/A.md',
            statusId: fallback[0],
            rawStatus: fallback[1],
            writableStatusShape: true,
            range: {},
            blockedByPaths: [],
            relatedPaths: [],
            diagnostics: [],
          },
          statuses,
        ),
      ).toBe('regular');
    },
  );

  it('keeps an ambiguous semantic Project status match read-only instead of choosing a winner', async () => {
    const path = 'Work Notes/A.md';
    const h = harness(
      [
        {
          path,
          tags: ['#work-note/task'],
          frontmatter: { Project: '[[Projects/A]]', Status: 'Done' },
        },
      ],
      { [`${path}\0Projects/A`]: 'Projects/A.md' },
    );
    const competingStatuses: readonly ProjectStatus[] = [
      {
        id: 'done-by-label',
        label: 'Done',
        onLeftPanel: false,
        behavior: 'completed',
        match: { kind: 'property', property: 'status', value: 'complete' },
      },
      {
        id: 'done-by-property',
        label: 'Finished',
        onLeftPanel: false,
        behavior: 'completed',
        match: { kind: 'property', property: 'status', value: 'Done' },
      },
    ];
    const index = statusAwareIndex(h.app, { ...preset, enabled: false }, () => competingStatuses);

    const preview = await index.previewCompatibility();
    const accepted = await index.acceptSuggestedCompatibility(
      preview.acceptanceToken!,
      '2026-08-27T00:00:00Z',
    );

    expect(accepted.type).toBe('ok');
    if (accepted.type !== 'ok') throw new Error('Expected read-only compatibility acceptance');
    expect(Object.keys(accepted.preset.rawStatusByStatusId)).not.toContain('done-by-label');
    expect(Object.keys(accepted.preset.rawStatusByStatusId)).not.toContain('done-by-property');
    expect(accepted.preview.capabilities).toEqual({ update: false, create: false });
  });

  it('rejects acceptance when vault metadata drifts after the exact preview', async () => {
    const path = 'Work Notes/A.md';
    const h = harness(
      [
        {
          path,
          tags: ['#work-note/task'],
          frontmatter: { Project: '[[Projects/A]]', Status: 'Active' },
        },
      ],
      { [`${path}\0Projects/A`]: 'Projects/A.md' },
    );
    const index = new WorkNoteIndex(h.app, { ...preset, enabled: false });
    const preview = await index.previewCompatibility();
    h.setFrontmatter(path, { Project: '[[Projects/A]]', Status: 'Review' });

    expect(
      await index.acceptSuggestedCompatibility(preview.acceptanceToken!, '2026-08-27T00:00:00Z'),
    ).toEqual({ type: 'stale-preview' });
    expect(h.writes).toEqual([]);
  });

  it('accepts the exact pending preview once without exposing candidate details in its token', async () => {
    const path = 'Private Notes/Secret.md';
    const h = harness(
      [
        {
          path,
          tags: ['#work-note/task'],
          frontmatter: { Project: '[[Projects/Secret]]', Status: 'Private active' },
        },
      ],
      { [`${path}\0Projects/Secret`]: 'Projects/Secret.md' },
    );
    const index = new WorkNoteIndex(h.app, { ...preset, enabled: false });

    const preview = await index.previewCompatibility();

    expect(preview.acceptanceToken).toMatch(/^work-note-preview-[a-z0-9]+$/u);
    expect(preview.acceptanceToken).not.toContain('Secret');
    const accepted = await index.acceptSuggestedCompatibility(
      preview.acceptanceToken!,
      '2026-08-27T00:00:00Z',
    );
    expect(accepted.type).toBe('ok');
    expect(
      await index.acceptSuggestedCompatibility(preview.acceptanceToken!, '2026-08-27T00:00:01Z'),
    ).toEqual({ type: 'compatibility-conflict', reason: 'invalid-preview-token' });
  });

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

  it('carries the configured scalar description from metadata into the indexed snapshot', () => {
    const h = harness(
      [
        {
          path: 'Tasks/Described.md',
          tags: ['#work-note/task'],
          frontmatter: {
            Project: '[[Projects/A]]',
            Status: 'Active',
            Description: 'Indexed release narrative',
          },
        },
      ],
      { 'Tasks/Described.md\0Projects/A': 'Projects/A.md' },
    );
    const index = new WorkNoteIndex(h.app, preset);
    index.initialize();

    expect(index.get('Tasks/Described.md')?.description).toBe('Indexed release narrative');
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
      cause: 'index',
      changedPaths: ['Tasks/A.md'],
      invalidatedProjectPaths: ['Projects/A.md'],
      taskBarriers: [],
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
    const settlements: Array<{
      reason: 'initialization' | 'index' | 'refresh';
      files: readonly { path: string; generation: number }[];
    }> = [];
    index.onUpdate((event) => events.push(event));
    index.onSettled((event) => settlements.push(event));

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
    expect(settlements).toEqual([
      {
        reason: 'index',
        files: [
          { path: 'Archive/Tasks/A.md', generation: 1 },
          { path: 'Workspace/Tasks/A.md', generation: 2 },
        ],
      },
    ]);
    expect(index.get('Archive/Tasks/A.md')?.projectPath).toBe('Archive/Projects/A.md');
    index.destroy();
  });

  it('waits for one folder-topology settlement, including empty descendants, and then keeps indexing', () => {
    vi.useFakeTimers();
    const h = harness(
      [
        {
          path: 'Workspace/A.md',
          tags: ['#work-note/task'],
          frontmatter: { Project: '[[Projects/A]]', Status: 'Active' },
        },
        {
          path: 'Workspace/Empty.md',
          tags: ['#work-note/task'],
          frontmatter: { Project: '[[Projects/A]]', Status: 'Active' },
        },
        { path: 'Projects/A.md' },
      ],
      {
        'Workspace/A.md\0Projects/A': 'Projects/A.md',
        'Workspace/Empty.md\0Projects/A': 'Projects/A.md',
      },
    );
    const taskSource = taskSettlementSource();
    const index = new WorkNoteIndex(h.app, { ...preset, folder: '' }, taskSource.source);
    index.initialize();
    const updates: unknown[] = [];
    const settlements: unknown[] = [];
    index.onUpdate((event) => updates.push(event));
    index.onSettled((event) => settlements.push(event));

    h.renameFolder('Workspace', 'Archive');
    vi.runAllTimers();
    expect(updates).toEqual([]);
    expect(settlements).toEqual([]);

    taskSource.settleFolderRename('Workspace', 'Archive', [
      { path: 'Archive/A.md', generation: 1 },
      { path: 'Workspace/A.md', generation: 2 },
    ]);
    vi.runAllTimers();

    expect(index.list().map(({ path }) => path)).toEqual(['Archive/A.md', 'Archive/Empty.md']);
    expect(updates).toEqual([
      {
        cause: 'index',
        changedPaths: ['Archive/A.md', 'Archive/Empty.md', 'Workspace/A.md', 'Workspace/Empty.md'],
        invalidatedProjectPaths: ['Projects/A.md'],
        taskBarriers: [
          { path: 'Archive/A.md', generation: 1 },
          { path: 'Workspace/A.md', generation: 2 },
        ],
      },
    ]);

    h.setFrontmatter('Archive/Empty.md', {
      Project: '[[Projects/A]]',
      Status: 'Active',
      Priority: 'High',
    });
    h.metadata('Archive/Empty.md');
    taskSource.settle('Archive/Empty.md', 2);
    vi.runAllTimers();
    expect(updates).toHaveLength(2);
    expect(settlements).toHaveLength(2);
    index.destroy();
  });

  it('converges chained folder topologies to final paths and settles post-audit descendants', () => {
    vi.useFakeTimers();
    const h = harness(
      [
        {
          path: 'Workspace/A.md',
          tags: ['#work-note/task'],
          frontmatter: { Project: '[[Projects/A]]', Status: 'Active' },
        },
        {
          path: 'Workspace/Empty.md',
          tags: ['#work-note/task'],
          frontmatter: { Project: '[[Projects/A]]', Status: 'Active' },
        },
        { path: 'Projects/A.md' },
      ],
      {
        'Workspace/A.md\0Projects/A': 'Projects/A.md',
        'Workspace/Empty.md\0Projects/A': 'Projects/A.md',
      },
    );
    const taskSource = taskSettlementSource();
    const index = new WorkNoteIndex(h.app, { ...preset, folder: '' }, taskSource.source);
    index.initialize();
    const updates: WorkNoteIndexEvent[] = [];
    const settlements: unknown[] = [];
    index.onUpdate((event) => updates.push(event));
    index.onSettled((event) => settlements.push(event));

    h.renameFolder('Workspace', 'Archive');
    h.renameFolder('Archive', 'Final');
    vi.runAllTimers();
    expect(updates).toEqual([]);
    expect(settlements).toEqual([]);

    taskSource.settleFolderRename('Workspace', 'Archive', [
      { path: 'Archive/A.md', generation: 1 },
      { path: 'Workspace/A.md', generation: 2 },
    ]);
    vi.runAllTimers();
    expect(updates).toEqual([]);
    expect(settlements).toEqual([]);

    taskSource.settleFolderRename('Archive', 'Final', [
      { path: 'Archive/A.md', generation: 2 },
      { path: 'Final/A.md', generation: 1 },
    ]);
    vi.runAllTimers();

    expect(index.list().map(({ path }) => path)).toEqual(['Final/A.md', 'Final/Empty.md']);
    expect(updates).toEqual([
      {
        cause: 'index',
        changedPaths: ['Final/A.md', 'Final/Empty.md', 'Workspace/A.md', 'Workspace/Empty.md'],
        invalidatedProjectPaths: ['Projects/A.md'],
        taskBarriers: [
          { path: 'Final/A.md', generation: 1 },
          { path: 'Workspace/A.md', generation: 2 },
        ],
      },
    ]);
    expect(settlements).toEqual([
      {
        reason: 'index',
        files: [
          { path: 'Final/A.md', generation: 1 },
          { path: 'Final/Empty.md', generation: 1 },
          { path: 'Workspace/A.md', generation: 2 },
          { path: 'Workspace/Empty.md', generation: 2 },
        ],
      },
    ]);
    expect(JSON.stringify({ updates, settlements })).not.toContain('Archive/');

    h.setFrontmatter('Final/Empty.md', {
      Project: '[[Projects/A]]',
      Status: 'Active',
      Priority: 'High',
    });
    h.metadata('Final/Empty.md');
    taskSource.settle('Final/Empty.md', 2);
    vi.runAllTimers();
    expect(updates).toHaveLength(2);
    expect(settlements).toHaveLength(2);
    index.destroy();
  });

  it('settles a reverse topology chain without aliasing the intermediate prefix', () => {
    vi.useFakeTimers();
    const h = harness(
      [
        {
          path: 'Workspace/A.md',
          tags: ['#work-note/task'],
          frontmatter: { Project: '[[Projects/A]]', Status: 'Active' },
        },
        {
          path: 'Workspace/Empty.md',
          tags: ['#work-note/task'],
          frontmatter: { Project: '[[Projects/A]]', Status: 'Active' },
        },
        { path: 'Projects/A.md' },
      ],
      {
        'Workspace/A.md\0Projects/A': 'Projects/A.md',
        'Workspace/Empty.md\0Projects/A': 'Projects/A.md',
      },
    );
    const taskSource = taskSettlementSource();
    const index = new WorkNoteIndex(h.app, { ...preset, folder: '' }, taskSource.source);
    index.initialize();
    const updates: WorkNoteIndexEvent[] = [];
    const settlements: unknown[] = [];
    index.onUpdate((event) => updates.push(event));
    index.onSettled((event) => settlements.push(event));

    h.renameFolder('Workspace', 'Archive');
    h.renameFolder('Archive', 'Workspace');
    taskSource.settleFolderRename('Workspace', 'Archive', [
      { path: 'Archive/A.md', generation: 1 },
      { path: 'Workspace/A.md', generation: 2 },
    ]);
    taskSource.settleFolderRename('Archive', 'Workspace', [
      { path: 'Archive/A.md', generation: 2 },
      { path: 'Workspace/A.md', generation: 3 },
    ]);
    vi.runAllTimers();

    expect(index.list().map(({ path }) => path)).toEqual(['Workspace/A.md', 'Workspace/Empty.md']);
    expect(updates).toEqual([
      {
        cause: 'index',
        changedPaths: [],
        invalidatedProjectPaths: ['Projects/A.md'],
        taskBarriers: [{ path: 'Workspace/A.md', generation: 3 }],
      },
    ]);
    expect(settlements).toEqual([
      {
        reason: 'index',
        files: [
          { path: 'Workspace/A.md', generation: 2 },
          { path: 'Workspace/Empty.md', generation: 2 },
        ],
      },
    ]);
    expect(JSON.stringify({ updates, settlements })).not.toContain('Archive/');
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
