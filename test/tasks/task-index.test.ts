import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { TFile, type CachedMetadata, type TAbstractFile } from 'obsidian';
import { describe, expect, it, vi } from 'vitest';
import { TaskApplicationService } from '../../src/tasks/application/TaskApplicationService';
import * as taskTypes from '../../src/tasks/domain/types';
import { localDate } from '../../src/tasks/domain/validation';
import { TaskIndex } from '../../src/tasks/infrastructure/TaskIndex';
import {
  TaskRefAuthority,
  taskRefContentFingerprint,
} from '../../src/tasks/infrastructure/TaskRefAuthority';
import {
  canonicalStatusCatalog,
  captureChangedCallback,
  createAppWithFiles,
  flushMicrotasks,
  seedTaskCache,
  useRealMoment,
} from '../helpers';

useRealMoment();

function taskCache(line = 0, frontmatter?: Record<string, unknown>): CachedMetadata {
  return {
    listItems: [
      {
        task: ' ',
        parent: -1,
        position: { start: { line }, end: { line } },
      },
    ],
    ...(frontmatter ? { frontmatter } : {}),
  } as CachedMetadata;
}

function rootsCache(lines: readonly number[]): CachedMetadata {
  return {
    listItems: lines.map((line) => ({
      task: ' ',
      parent: -1,
      position: { start: { line }, end: { line } },
    })),
  } as CachedMetadata;
}

async function setup(
  files: Record<string, string>,
  refAuthority?: TaskRefAuthority,
): Promise<{
  app: Awaited<ReturnType<typeof createAppWithFiles>>;
  index: TaskIndex;
  fireChanged: (file: TFile, data: string, cache: CachedMetadata) => void;
}> {
  const app = await createAppWithFiles(files);
  for (const path of Object.keys(files))
    seedTaskCache(app, path, [{ task: ' ', parent: -1, line: 0 }]);
  const fireChanged = captureChangedCallback(app);
  const index = new TaskIndex(app, {
    statusCatalog: canonicalStatusCatalog(),
    dailyNoteFormat: 'YYYY-MM-DD',
    ...(refAuthority && { refAuthority }),
  });
  return { app, index, fireChanged };
}

function mdFile(app: Awaited<ReturnType<typeof createAppWithFiles>>, path: string): TFile {
  const file = app.vault.getAbstractFileByPath(path);
  if (!(file instanceof TFile)) throw new Error(`missing ${path}`);
  return file;
}

function reconciliationState(index: TaskIndex): {
  readonly generations: readonly string[];
  readonly transitions: readonly string[];
} {
  const internal = index as unknown as {
    fileGenerations: ReadonlyMap<string, number>;
    reconciliationTransitions: ReadonlyMap<string, unknown>;
  };
  return {
    generations: [...internal.fileGenerations.keys()].sort(),
    transitions: [...internal.reconciliationTransitions.keys()].sort(),
  };
}

function deferred(): { readonly promise: Promise<void>; readonly release: () => void } {
  let release!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    release = resolvePromise;
  });
  return { promise, release };
}

function blockRead(
  app: Awaited<ReturnType<typeof createAppWithFiles>>,
  path: string,
  staleContent: string,
): { readonly started: Promise<void>; readonly release: () => void } {
  const originalRead = app.vault.cachedRead.bind(app.vault);
  const gate = deferred();
  let markStarted!: () => void;
  const started = new Promise<void>((resolvePromise) => {
    markStarted = resolvePromise;
  });
  let blocked = false;
  app.vault.cachedRead = async (file): Promise<string> => {
    const observedPath = file.path;
    if (observedPath !== path || blocked) return originalRead(file);
    blocked = true;
    markStarted();
    await gate.promise;
    return staleContent;
  };
  return { started, release: gate.release };
}

function captureCreateCallback(
  app: Awaited<ReturnType<typeof createAppWithFiles>>,
): (file: TAbstractFile) => void {
  let captured: ((file: TAbstractFile) => void) | undefined;
  const originalOn = app.vault.on.bind(app.vault) as (
    name: string,
    callback: (...args: unknown[]) => void,
  ) => unknown;
  app.vault.on = ((name: string, callback: (...args: unknown[]) => void) => {
    if (name === 'create') captured = callback as (file: TAbstractFile) => void;
    return originalOn(name, callback);
  }) as typeof app.vault.on;
  return (file: TAbstractFile): void => {
    if (!captured) throw new Error('captureCreateCallback: no create handler registered');
    captured(file);
  };
}

describe('TaskIndex lifecycle and events', () => {
  it('distinguishes a plugin-owned authority successor and rejects a stale retry', async () => {
    const source = '- [ ] alpha\n';
    const candidate = '- [ ] beta\n';
    const authority = new TaskRefAuthority('identity-session');
    const { index } = await setup({ 'task.md': source }, authority);
    await index.initialize();
    const observed = index.list()[0]!;
    const successor = authority.successor(observed.ref.revision, candidate.trimEnd());
    if (!successor) throw new Error('missing successor');
    const staged = authority.stage(
      {
        filePath: 'task.md',
        candidateFingerprint: taskRefContentFingerprint(candidate),
        candidateLength: candidate.length,
        expectedRevision: observed.ref.revision,
        roots: [{ line: 0, source: candidate.trimEnd(), revision: successor }],
      },
      observed.ref.revision,
    );
    if (staged.type !== 'staged') throw new Error('missing staged transition');
    authority.commit(staged.token);
    const installed = index.installCommittedContent('task.md', candidate)[0]!;
    authority.acknowledge('task.md', candidate);

    expect(authority.evidence(observed.ref.revision)).toMatchObject({ generation: '0' });
    expect(authority.evidence(installed.ref.revision)).toMatchObject({ generation: '1' });
    expect(index.resolve(observed.ref)).toMatchObject({
      type: 'rebased',
      evidence: 'authority-transition',
      previous: { ref: observed.ref },
      current: { ref: installed.ref },
    });

    const edit = vi.fn();
    const application = new TaskApplicationService(
      index,
      { edit, completeRecurrence: vi.fn(), create: vi.fn(), move: vi.fn() },
      canonicalStatusCatalog(),
      { today: () => localDate('2026-08-13') },
    );
    await expect(
      application.execute({
        type: 'toggle-completion',
        target: { type: 'task', ref: observed.ref },
      }),
    ).resolves.toMatchObject({ type: 'conflict', current: { ref: installed.ref } });
    expect(edit).not.toHaveBeenCalled();
    index.destroy();
  });

  it('does not treat an ordinary external edit as authority provenance', async () => {
    const source = '- [ ] alpha\n';
    const candidate = '- [ ] beta\n';
    const authority = new TaskRefAuthority('identity-session');
    const { app, index, fireChanged } = await setup({ 'task.md': source }, authority);
    await index.initialize();
    const observed = index.list()[0]!;

    fireChanged(mdFile(app, 'task.md'), candidate, taskCache());
    const current = index.list()[0]!;

    expect(authority.evidence(observed.ref.revision)).toMatchObject({ generation: '0' });
    expect(authority.evidence(current.ref.revision)).toMatchObject({ generation: '1' });
    expect(authority.observeTransition('task.md', candidate)).toBeUndefined();
    expect(index.resolve(observed.ref)).toMatchObject({
      type: 'visual',
      stale: observed.ref,
      current: { ref: current.ref, title: 'beta' },
      evidence: 'same-line',
    });
    index.destroy();
  });

  it('installs a committed byte-identical successor and preserves it across line drift', async () => {
    const source = '- [ ] task\n';
    const authority = new TaskRefAuthority('index-session');
    const { app, index, fireChanged } = await setup({ 'task.md': source }, authority);
    await index.initialize();
    const initial = index.list()[0]!;
    const rootSource = initial.source.originalBlock;
    const successor = authority.successor(initial.ref.revision, rootSource);
    if (!successor) throw new Error('missing successor');
    const staged = authority.stage(
      {
        filePath: 'task.md',
        candidateFingerprint: taskRefContentFingerprint(source),
        candidateLength: source.length,
        expectedRevision: initial.ref.revision,
        roots: [{ line: 0, source: rootSource, revision: successor }],
      },
      initial.ref.revision,
    );
    if (staged.type !== 'staged') throw new Error('missing transition');
    authority.commit(staged.token);

    const installed = index.installCommittedContent('task.md', source);

    expect(installed[0]?.ref.revision).toBe(successor);
    expect(index.list()[0]?.ref.revision).toBe(successor);
    authority.acknowledge('task.md', source);
    expect(authority.observe('task.md', source)).toEqual([]);

    const drifted = `heading\n${source}`;
    fireChanged(mdFile(app, 'task.md'), drifted, taskCache(1));

    expect(index.list()[0]?.ref).toMatchObject({ line: 1, revision: successor });
    index.destroy();
  });

  it('keeps duplicate exact source ambiguous after a generated revision', async () => {
    const source = '- [ ] duplicate\n';
    const authority = new TaskRefAuthority('index-session');
    const { app, index, fireChanged } = await setup({ 'task.md': source }, authority);
    await index.initialize();
    const initial = index.list()[0]!;
    const rootSource = initial.source.originalBlock;
    const successor = authority.successor(initial.ref.revision, rootSource);
    if (!successor) throw new Error('missing successor');
    const staged = authority.stage(
      {
        filePath: 'task.md',
        candidateFingerprint: taskRefContentFingerprint(source),
        candidateLength: source.length,
        expectedRevision: initial.ref.revision,
        roots: [{ line: 0, source: rootSource, revision: successor }],
      },
      initial.ref.revision,
    );
    if (staged.type !== 'staged') throw new Error('missing transition');
    authority.commit(staged.token);
    index.installCommittedContent('task.md', source);
    authority.acknowledge('task.md', source);

    fireChanged(mdFile(app, 'task.md'), `${source}${source}`, {
      listItems: [
        { task: ' ', parent: -1, position: { start: { line: 0 }, end: { line: 0 } } },
        { task: ' ', parent: -1, position: { start: { line: 1 }, end: { line: 1 } } },
      ],
    } as CachedMetadata);

    expect(index.resolve({ ...initial.ref, line: 99, revision: successor })).toMatchObject({
      type: 'ambiguous',
      candidates: [{ root: { source: { line: 0 } } }, { root: { source: { line: 1 } } }],
    });
    index.destroy();
  });

  it('advances a known root generation across an external A-to-B-to-A mutation', async () => {
    const sourceA = '- [ ] alpha\n';
    const sourceB = '- [ ] beta\n';
    const authority = new TaskRefAuthority('index-session');
    const { app, index, fireChanged } = await setup({ 'task.md': sourceA }, authority);
    await index.initialize();
    const initialRevision = index.list()[0]!.ref.revision;

    fireChanged(mdFile(app, 'task.md'), sourceB, taskCache());
    const intermediateRevision = index.list()[0]!.ref.revision;
    fireChanged(mdFile(app, 'task.md'), sourceA, taskCache());
    const restoredRevision = index.list()[0]!.ref.revision;

    expect(intermediateRevision).not.toBe(initialRevision);
    expect(restoredRevision).not.toBe(initialRevision);
    expect(restoredRevision).not.toBe(intermediateRevision);
    expect(authority.evidence(initialRevision)).toMatchObject({ generation: '0' });
    expect(authority.evidence(intermediateRevision)).toMatchObject({ generation: '1' });
    expect(authority.evidence(restoredRevision)).toMatchObject({ generation: '2' });
    expect(
      index.resolve({ filePath: 'task.md', line: 0, revision: initialRevision }),
    ).toMatchObject({
      type: 'visual',
      stale: { filePath: 'task.md', line: 0, revision: initialRevision },
      current: { ref: { revision: restoredRevision }, title: 'alpha' },
      evidence: 'same-line',
    });
    index.destroy();
  });

  it('does not identify a deleted then recreated byte-identical root as the original', async () => {
    const source = '- [ ] alpha\n';
    const authority = new TaskRefAuthority('identity-session');
    const { app, index, fireChanged } = await setup({ 'task.md': source }, authority);
    await index.initialize();
    const observed = index.list()[0]!;
    const file = mdFile(app, 'task.md');

    fireChanged(file, '', rootsCache([]));
    expect(index.resolve(observed.ref)).toEqual({ type: 'not-found', ref: observed.ref });
    fireChanged(file, source, taskCache());

    const recreated = index.list()[0]!;
    expect(recreated.ref.revision).not.toBe(observed.ref.revision);
    expect(index.resolve(observed.ref)).toMatchObject({
      type: 'visual',
      stale: observed.ref,
      current: { ref: recreated.ref, title: 'alpha' },
      evidence: 'same-line',
    });
    index.destroy();
  });

  it('does not resolve a different task that replaces the observed stale line', async () => {
    const authority = new TaskRefAuthority('index-session');
    const { app, index, fireChanged } = await setup({ 'task.md': '- [ ] observed\n' }, authority);
    await index.initialize();
    const observed = index.list()[0]!;

    fireChanged(mdFile(app, 'task.md'), '- [ ] replacement\n', taskCache());

    expect(index.resolve(observed.ref)).toMatchObject({
      type: 'visual',
      stale: observed.ref,
      current: { title: 'replacement' },
      evidence: 'same-line',
    });
    index.destroy();
  });

  it('rebases a changed root only inside byte-identical neighboring anchors', async () => {
    const initial = ['- [ ] before', '- [ ] observed', '- [ ] after'].join('\n');
    const changed = ['- [ ] before', '- [ ] edited externally', '- [ ] after'].join('\n');
    const authority = new TaskRefAuthority('index-session');
    const { app, index, fireChanged } = await setup({ 'task.md': initial }, authority);
    seedTaskCache(app, 'task.md', [
      { task: ' ', parent: -1, line: 0 },
      { task: ' ', parent: -1, line: 1 },
      { task: ' ', parent: -1, line: 2 },
    ]);
    await index.initialize();
    const observed = index.list()[1]!;

    fireChanged(mdFile(app, 'task.md'), changed, {
      listItems: [
        { task: ' ', parent: -1, position: { start: { line: 0 }, end: { line: 0 } } },
        { task: ' ', parent: -1, position: { start: { line: 1 }, end: { line: 1 } } },
        { task: ' ', parent: -1, position: { start: { line: 2 }, end: { line: 2 } } },
      ],
    } as CachedMetadata);

    expect(index.resolve(observed.ref)).toMatchObject({
      type: 'visual',
      stale: observed.ref,
      current: { title: 'edited externally' },
      evidence: 'anchored-range',
    });
    index.destroy();
  });

  it('does not identify a replacement merely because two surrounding anchors survived', async () => {
    const initial = ['- [ ] before', '- [ ] observed', '- [ ] after'].join('\n');
    const replaced = ['- [ ] before', '- [ ] replacement', '- [ ] after'].join('\n');
    const authority = new TaskRefAuthority('identity-session');
    const { app, index, fireChanged } = await setup({ 'task.md': initial }, authority);
    seedTaskCache(app, 'task.md', [
      { task: ' ', parent: -1, line: 0 },
      { task: ' ', parent: -1, line: 1 },
      { task: ' ', parent: -1, line: 2 },
    ]);
    await index.initialize();
    const observed = index.list()[1]!;

    fireChanged(mdFile(app, 'task.md'), replaced, rootsCache([0, 1, 2]));

    expect(index.resolve(observed.ref)).toMatchObject({
      type: 'visual',
      stale: observed.ref,
      current: { title: 'replacement' },
      evidence: 'anchored-range',
    });
    index.destroy();
  });

  it('does not positionally identify changed roots that were also swapped', async () => {
    const initial = ['- [ ] before', '- [ ] alpha', '- [ ] beta', '- [ ] after'].join('\n');
    const swappedAndEdited = [
      '- [ ] before',
      '- [ ] beta edited',
      '- [ ] alpha edited',
      '- [ ] after',
    ].join('\n');
    const authority = new TaskRefAuthority('identity-session');
    const { app, index, fireChanged } = await setup({ 'task.md': initial }, authority);
    seedTaskCache(app, 'task.md', [
      { task: ' ', parent: -1, line: 0 },
      { task: ' ', parent: -1, line: 1 },
      { task: ' ', parent: -1, line: 2 },
      { task: ' ', parent: -1, line: 3 },
    ]);
    await index.initialize();
    const alpha = index.list()[1]!;
    const beta = index.list()[2]!;

    fireChanged(mdFile(app, 'task.md'), swappedAndEdited, rootsCache([0, 1, 2, 3]));

    expect(index.resolve(alpha.ref)).toMatchObject({
      type: 'visual',
      stale: alpha.ref,
      current: { title: 'beta edited' },
      evidence: 'anchored-range',
    });
    expect(index.resolve(beta.ref)).toMatchObject({
      type: 'visual',
      stale: beta.ref,
      current: { title: 'alpha edited' },
      evidence: 'anchored-range',
    });
    index.destroy();
  });

  it('keeps only the current per-file reconciliation transition', async () => {
    const initial = ['- [ ] before', '- [ ] observed', '- [ ] after'].join('\n');
    const second = ['- [ ] before', '- [ ] second', '- [ ] after'].join('\n');
    const third = ['- [ ] before', '- [ ] third', '- [ ] after'].join('\n');
    const authority = new TaskRefAuthority('index-session');
    const { app, index, fireChanged } = await setup({ 'task.md': initial }, authority);
    seedTaskCache(app, 'task.md', [
      { task: ' ', parent: -1, line: 0 },
      { task: ' ', parent: -1, line: 1 },
      { task: ' ', parent: -1, line: 2 },
    ]);
    await index.initialize();
    const observed = index.list()[1]!;
    const cache = {
      listItems: [
        { task: ' ', parent: -1, position: { start: { line: 0 }, end: { line: 0 } } },
        { task: ' ', parent: -1, position: { start: { line: 1 }, end: { line: 1 } } },
        { task: ' ', parent: -1, position: { start: { line: 2 }, end: { line: 2 } } },
      ],
    } as CachedMetadata;

    fireChanged(mdFile(app, 'task.md'), second, cache);
    const secondSnapshot = index.list()[1]!;
    expect(index.resolve(observed.ref).type).toBe('visual');
    fireChanged(mdFile(app, 'task.md'), third, cache);

    expect(index.resolve(observed.ref)).toMatchObject({ type: 'visual', evidence: 'same-line' });
    expect(index.resolve(secondSnapshot.ref).type).toBe('visual');
    index.destroy();
  });

  it('expires a transition on the next observed file generation even when tasks are unchanged', async () => {
    const initial = ['- [ ] before', '- [ ] observed', '- [ ] after'].join('\n');
    const changed = ['- [ ] before', '- [ ] edited', '- [ ] after'].join('\n');
    const authority = new TaskRefAuthority('index-session');
    const { app, index, fireChanged } = await setup({ 'task.md': initial }, authority);
    seedTaskCache(app, 'task.md', [
      { task: ' ', parent: -1, line: 0 },
      { task: ' ', parent: -1, line: 1 },
      { task: ' ', parent: -1, line: 2 },
    ]);
    await index.initialize();
    const observed = index.list()[1]!;
    const cache = {
      listItems: [
        { task: ' ', parent: -1, position: { start: { line: 0 }, end: { line: 0 } } },
        { task: ' ', parent: -1, position: { start: { line: 1 }, end: { line: 1 } } },
        { task: ' ', parent: -1, position: { start: { line: 2 }, end: { line: 2 } } },
      ],
    } as CachedMetadata;

    fireChanged(mdFile(app, 'task.md'), changed, cache);
    expect(index.resolve(observed.ref).type).toBe('visual');
    fireChanged(mdFile(app, 'task.md'), changed, cache);

    expect(index.resolve(observed.ref)).toMatchObject({ type: 'visual', evidence: 'same-line' });
    index.destroy();
  });

  it('lets an event observe staging before commit and keeps post-commit installation idempotent', async () => {
    const source = '- [ ] task\n';
    const candidate = '- [ ] changed\n';
    const authority = new TaskRefAuthority('index-session');
    const { app, index, fireChanged } = await setup({ 'task.md': source }, authority);
    await index.initialize();
    const initial = index.list()[0]!;
    const candidateRoot = candidate.trimEnd();
    const successor = authority.successor(initial.ref.revision, candidateRoot);
    if (!successor) throw new Error('missing successor');
    const staged = authority.stage(
      {
        filePath: 'task.md',
        candidateFingerprint: taskRefContentFingerprint(candidate),
        candidateLength: candidate.length,
        expectedRevision: initial.ref.revision,
        roots: [{ line: 0, source: candidateRoot, revision: successor }],
      },
      initial.ref.revision,
    );
    if (staged.type !== 'staged') throw new Error('missing transition token');

    fireChanged(mdFile(app, 'task.md'), candidate, taskCache());
    expect(index.list()[0]?.ref.revision).toBe(successor);
    authority.commit(staged.token);
    expect(index.installCommittedContent('task.md', candidate)[0]?.ref.revision).toBe(successor);
    authority.acknowledge('task.md', candidate);
    expect(authority.observe('task.md', candidate)).toEqual([]);
    index.destroy();
  });

  it('creates one authority revision for a root with one thousand subtasks', async () => {
    const source = [
      '- [ ] root',
      ...Array.from({ length: 1_000 }, (_, index) => `  - [ ] child ${index}`),
    ].join('\n');
    const authority = new TaskRefAuthority('index-session');
    const revision = vi.spyOn(authority, 'revision');
    const { index } = await setup({ 'task.md': source }, authority);

    const roots = index.snapshotsFromContent('task.md', source);

    expect(roots).toHaveLength(1);
    expect(roots[0]?.subtasks).toHaveLength(1_000);
    expect(revision).toHaveBeenCalledOnce();
    index.destroy();
  });

  it('previews changed content without allocating a successor generation', async () => {
    const authority = new TaskRefAuthority('index-session');
    const { index } = await setup({ 'task.md': '- [ ] alpha\n' }, authority);
    await index.initialize();
    const successor = vi.spyOn(authority, 'successor');

    const first = index.previewContent('task.md', '- [ ] beta\n');
    const second = index.previewContent('task.md', '- [ ] beta\n');

    expect(successor).not.toHaveBeenCalled();
    expect(first[0]?.ref.revision).toBe(second[0]?.ref.revision);
    index.destroy();
  });

  it('holds file lifecycle generations by weak identity', async () => {
    const { index } = await setup({ 'task.md': '- [ ] task' });
    expect((index as unknown as { fileLifecycles: unknown }).fileLifecycles).toBeInstanceOf(
      WeakMap,
    );
    index.destroy();
  });

  it('composes TaskMarkdownCodec directly instead of the legacy root parser', () => {
    const source = readFileSync(
      resolve(import.meta.dirname, '../../src/tasks/infrastructure/TaskIndex.ts'),
      'utf8',
    );
    expect(source).toContain('TaskMarkdownCodec');
    expect(source).not.toContain("from '../../parser/TaskParser'");
    expect(source).not.toMatch(/\bparseTask\s*\(/u);
  });

  it('projects complete recursive snapshots directly from lossless task blocks', async () => {
    const content = [
      '> - [/] Parent [[Note|alias]] #root 🔺 🔁 every week 🛫 2026-07-10 📅 2026-07-12 ⏰ 09:30 ⏱️ 1h30m 🆔 parent-id ⛔ dep-1 ^parent',
      '>   - > first description line',
      '>   - > second description line',
      '>   - 2026-07-11: root comment [[Comment]]',
      '>   - [x] Child [docs](https://example.com) #child ⏳ 2026-07-11 ✅ 2026-07-11 🆔 child-id',
      '>     - plain child comment',
      '>     - [ ] Grandchild #deep 🛫 2026-07-09 ⏰ 08:00',
    ].join('\n');
    const { index } = await setup({ 'nested.md': content });

    const root = index.snapshotsFromContent('nested.md', content)[0]!;

    expect(root).toMatchObject({
      title: 'Parent 🔗Note',
      markdownTitle: 'Parent [[Note|alias]]',
      status: 'in-progress',
      statusSymbol: '/',
      priority: 'A',
      planning: {
        start: '2026-07-10',
        due: '2026-07-12',
        time: '09:30',
        duration: 90,
      },
      tags: ['#root'],
      recurrence: 'every week',
      description: 'first description line\nsecond description line',
      source: { originalMarkdown: expect.stringContaining('🆔 parent-id ⛔ dep-1 ^parent') },
    });
    expect(root.source.originalBlock).toBe(content);
    expect(root.presentation.linkCount).toBe(2);
    expect(root.comments).toMatchObject([{ date: '2026-07-11', text: 'root comment [[Comment]]' }]);
    expect(root.subtasks[0]).toMatchObject({
      title: 'Child 🌐 docs',
      markdownTitle: 'Child [docs](https://example.com)',
      status: 'done',
      planning: { scheduled: '2026-07-11' },
      tags: ['#child'],
      comments: [{ text: 'plain child comment' }],
    });
    expect(root.subtasks[0]?.ref.originalBlock).toContain('🆔 child-id');
    expect(root.subtasks[0]?.subtasks[0]).toMatchObject({
      title: 'Grandchild',
      tags: ['#deep'],
      planning: { start: '2026-07-09', time: '08:00' },
    });
    expect(root.subtasks[0]?.comments[0]?.ref.parent).toEqual({
      type: 'subtask',
      ref: root.subtasks[0]?.ref,
    });
    index.destroy();
  });

  it('initially scans markdown files and returns stable vault-path/line ordering', async () => {
    const { index } = await setup({
      'z.md': '- [ ] z',
      'a.md': '- [ ] first\n- [ ] second',
    });
    const app = (index as unknown as { app: Awaited<ReturnType<typeof createAppWithFiles>> }).app;
    seedTaskCache(app, 'a.md', [
      { task: ' ', parent: -1, line: 0 },
      { task: ' ', parent: -1, line: 1 },
    ]);
    const events: unknown[] = [];
    index.subscribe((event) => events.push(event));
    await index.initialize();
    expect(index.list().map((task) => `${task.source.filePath}:${task.source.line}`)).toEqual([
      'a.md:0',
      'a.md:1',
      'z.md:0',
    ]);
    expect(events).toEqual([{ type: 'initialized' }]);
    expect(Object.isFrozen(events[0])).toBe(true);
    index.destroy();
  });

  it('atomically replaces modified files, observes metadata-only changes, and batches refresh events', async () => {
    const { app, index, fireChanged } = await setup({ 'a.md': '- [ ] a', 'b.md': '- [ ] b' });
    await index.initialize();
    const events: Array<{ type: string; files?: readonly string[] }> = [];
    index.subscribe((event) => {
      if (event.type === 'changed') {
        expect(index.list({ filePath: event.files[0] })).toHaveLength(1);
      }
      events.push(event);
    });
    fireChanged(mdFile(app, 'b.md'), '- [ ] b2', taskCache(0, { color: '#bbb' }));
    fireChanged(mdFile(app, 'a.md'), '- [ ] a2', taskCache(0, { color: '#aaa' }));
    await flushMicrotasks();

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ type: 'changed', files: ['a.md', 'b.md'] });
    expect(Object.isFrozen(events[0])).toBe(true);
    expect(Object.isFrozen(events[0]?.files)).toBe(true);
    expect(index.list().map((task) => [task.title, task.presentation.noteColor])).toEqual([
      ['a2', '#aaa'],
      ['b2', '#bbb'],
    ]);
    index.destroy();
  });

  it('handles create, rename with oldPath, and delete after applying each change', async () => {
    const { app, index, fireChanged } = await setup({ 'old.md': '- [ ] old' });
    await index.initialize();
    const events: unknown[] = [];
    index.subscribe((event) => events.push(event));

    const created = await app.vault.create('created.md', '- [ ] created');
    fireChanged(created, '- [ ] created', taskCache());
    expect(index.list({ filePath: 'created.md' })).toHaveLength(1);
    await flushMicrotasks();
    expect(index.list({ filePath: 'created.md' })).toHaveLength(1);

    await app.vault.rename(mdFile(app, 'old.md'), 'new.md');
    await flushMicrotasks();
    expect(index.list({ filePath: 'old.md' })).toEqual([]);
    expect(index.list({ filePath: 'new.md' })).toHaveLength(1);

    await app.vault.delete(created);
    await flushMicrotasks();
    expect(index.list({ filePath: 'created.md' })).toEqual([]);
    expect(events).toContainEqual({ type: 'renamed', oldPath: 'old.md', newPath: 'new.md' });
    expect(events).toContainEqual({ type: 'deleted', path: 'created.md' });
    index.destroy();
  });

  it('bounds reconciliation maps to live paths across rename, delete, and destroy', async () => {
    const authority = new TaskRefAuthority('lifecycle-session');
    const { app, index } = await setup({ 'old.md': '- [ ] old' }, authority);
    await index.initialize();
    const initialRevision = index.list()[0]!.ref.revision;
    expect(reconciliationState(index)).toEqual({
      generations: ['old.md'],
      transitions: ['old.md'],
    });

    await app.vault.rename(mdFile(app, 'old.md'), 'new.md');
    const renamedRevision = index.list()[0]!.ref.revision;
    expect(renamedRevision).not.toBe(initialRevision);
    expect(reconciliationState(index)).toEqual({
      generations: ['new.md'],
      transitions: ['new.md'],
    });

    await app.vault.delete(mdFile(app, 'new.md'));
    expect(reconciliationState(index)).toEqual({ generations: [], transitions: [] });

    index.destroy();
    expect(reconciliationState(index)).toEqual({ generations: [], transitions: [] });
  });

  it('unsubscribe and destroy dispose listeners and pending notifications', async () => {
    const { app, index, fireChanged } = await setup({ 'a.md': '- [ ] a' });
    await index.initialize();
    let calls = 0;
    const off = index.subscribe(() => calls++);
    off();
    fireChanged(mdFile(app, 'a.md'), '- [ ] changed', taskCache());
    await flushMicrotasks();
    expect(calls).toBe(0);

    index.destroy();
    index.destroy();
    app.metadataCache.trigger('changed', mdFile(app, 'a.md'), '- [ ] later', taskCache());
    await flushMicrotasks();
    expect(index.list()).toEqual([]);
  });

  it('destroy prevents an in-flight initial read from repopulating the index', async () => {
    const { app, index } = await setup({ 'a.md': '- [ ] a' });
    const cachedRead = app.vault.cachedRead.bind(app.vault);
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    app.vault.cachedRead = async (file): Promise<string> => {
      await blocked;
      return cachedRead(file);
    };
    const events: unknown[] = [];
    index.subscribe((event) => events.push(event));
    const initializing = index.initialize();
    index.destroy();
    release();
    await initializing;
    expect(index.list()).toEqual([]);
    expect(events).toEqual([]);
  });

  it('indexes a file created while the initial scan is blocked', async () => {
    const { app, index } = await setup({ 'blocked.md': '- [ ] initial' });
    const read = blockRead(app, 'blocked.md', '- [ ] initial');
    const events: unknown[] = [];
    index.subscribe((event) => events.push(event));

    const initializing = index.initialize();
    await read.started;
    await app.vault.create('created.md', '- [ ] created');
    read.release();
    await initializing;

    expect(index.list().map((task) => task.title)).toEqual(['initial', 'created']);
    expect(events).toEqual([{ type: 'initialized' }]);
    index.destroy();
  });

  it('fallback creation indexes nested tasks once under their root parent', async () => {
    const content = ['- [ ] parent', '  - [ ] child', '    - [ ] grandchild', '- [ ] sibling'].join(
      '\n',
    );
    const app = await createAppWithFiles({ 'created.md': content });
    app.metadataCache.getFileCache = (): null => null;
    const index = new TaskIndex(app, {
      statusCatalog: canonicalStatusCatalog(),
      dailyNoteFormat: 'YYYY-MM-DD',
    });
    const fireCreate = captureCreateCallback(app);
    await index.initialize();
    const file = mdFile(app, 'created.md');

    fireCreate(file);
    await flushMicrotasks();

    const tasks = index.list();
    expect(tasks.map((task) => task.title)).toEqual(['parent', 'sibling']);
    expect(tasks[0]?.subtasks.map((task) => task.title)).toEqual(['child']);
    expect(tasks[0]?.subtasks[0]?.subtasks.map((task) => task.title)).toEqual(['grandchild']);
    index.destroy();
  });

  it('fallback creation leaves an unclosed quoted fence before indexing plain tasks', async () => {
    const content = [
      '> [!example] Fenced tasks',
      '> ```md',
      '> - [ ] hidden quoted example',
      '- [ ] visible plain',
    ].join('\n');
    const app = await createAppWithFiles({ 'created.md': content });
    app.metadataCache.getFileCache = (): null => null;
    const index = new TaskIndex(app, {
      statusCatalog: canonicalStatusCatalog(),
      dailyNoteFormat: 'YYYY-MM-DD',
    });
    const fireCreate = captureCreateCallback(app);
    await index.initialize();

    fireCreate(mdFile(app, 'created.md'));
    await flushMicrotasks();

    expect(index.list().map((task) => task.title)).toEqual(['visible plain']);
    index.destroy();
  });

  it('fallback creation keeps an indented task after a closed quoted fence as a root', async () => {
    const content = [
      '- [ ] parent',
      '> ```md',
      '> code example',
      '> ```',
      '  - [ ] after boundary',
    ].join('\n');
    const app = await createAppWithFiles({ 'created.md': content });
    app.metadataCache.getFileCache = (): null => null;
    const index = new TaskIndex(app, {
      statusCatalog: canonicalStatusCatalog(),
      dailyNoteFormat: 'YYYY-MM-DD',
    });
    const fireCreate = captureCreateCallback(app);
    await index.initialize();

    fireCreate(mdFile(app, 'created.md'));
    await flushMicrotasks();

    const tasks = index.list();
    expect(tasks.map((task) => task.title)).toEqual(['parent', 'after boundary']);
    expect(tasks[0]?.subtasks).toEqual([]);
    index.destroy();
  });

  it('fallback creation treats a same-depth root fence as a non-list boundary', async () => {
    const content = ['- [ ] parent', '```md', 'code example', '```', '  - [ ] after boundary'].join(
      '\n',
    );
    const app = await createAppWithFiles({ 'created.md': content });
    app.metadataCache.getFileCache = (): null => null;
    const index = new TaskIndex(app, {
      statusCatalog: canonicalStatusCatalog(),
      dailyNoteFormat: 'YYYY-MM-DD',
    });
    const fireCreate = captureCreateCallback(app);
    await index.initialize();

    fireCreate(mdFile(app, 'created.md'));
    await flushMicrotasks();

    const tasks = index.list();
    expect(tasks.map((task) => task.title)).toEqual(['parent', 'after boundary']);
    expect(tasks[0]?.subtasks).toEqual([]);
    index.destroy();
  });

  it('fallback creation preserves hierarchy across a list-indented fence', async () => {
    const content = [
      '- [ ] parent',
      '  ```md',
      '  code example',
      '  ```',
      '  - [ ] child after fence',
    ].join('\n');
    const app = await createAppWithFiles({ 'created.md': content });
    app.metadataCache.getFileCache = (): null => null;
    const index = new TaskIndex(app, {
      statusCatalog: canonicalStatusCatalog(),
      dailyNoteFormat: 'YYYY-MM-DD',
    });
    const fireCreate = captureCreateCallback(app);
    await index.initialize();

    fireCreate(mdFile(app, 'created.md'));
    await flushMicrotasks();

    const tasks = index.list();
    expect(tasks.map((task) => task.title)).toEqual(['parent']);
    expect(tasks[0]?.subtasks.map((task) => task.title)).toEqual(['child after fence']);
    index.destroy();
  });

  it('keeps a metadata modification that arrives during a blocked initial read', async () => {
    const { app, index, fireChanged } = await setup({ 'blocked.md': '- [ ] stale' });
    const read = blockRead(app, 'blocked.md', '- [ ] stale');

    const initializing = index.initialize();
    await read.started;
    fireChanged(mdFile(app, 'blocked.md'), '- [ ] current', taskCache());
    read.release();
    await initializing;

    expect(index.list().map((task) => task.title)).toEqual(['current']);
    index.destroy();
  });

  it('keeps a delete that arrives during a blocked initial read', async () => {
    const { app, index } = await setup({ 'blocked.md': '- [ ] stale' });
    const read = blockRead(app, 'blocked.md', '- [ ] stale');

    const initializing = index.initialize();
    await read.started;
    await app.vault.delete(mdFile(app, 'blocked.md'));
    read.release();
    await initializing;

    expect(index.list()).toEqual([]);
    index.destroy();
  });

  it('keeps a markdown-to-non-markdown rename during a blocked initial read', async () => {
    const { app, index } = await setup({ 'blocked.md': '- [ ] stale' });
    const read = blockRead(app, 'blocked.md', '- [ ] stale');

    const initializing = index.initialize();
    await read.started;
    await app.vault.rename(mdFile(app, 'blocked.md'), 'blocked.txt');
    read.release();
    await initializing;

    expect(index.list()).toEqual([]);
    index.destroy();
  });

  it('indexes the new path after a markdown rename during a blocked initial read', async () => {
    const { app, index } = await setup({ 'blocked.md': '- [ ] renamed task' });
    const read = blockRead(app, 'blocked.md', '- [ ] renamed task');

    const initializing = index.initialize();
    await read.started;
    await app.vault.rename(mdFile(app, 'blocked.md'), 'renamed.md');
    read.release();
    await initializing;

    expect(index.list().map((task) => [task.source.filePath, task.title])).toEqual([
      ['renamed.md', 'renamed task'],
    ]);
    index.destroy();
  });

  it('invalidates a create read after newer metadata and transfers the current snapshot on rename', async () => {
    const { app, index, fireChanged } = await setup({ 'created.md': '- [ ] initial' });
    const fireCreate = captureCreateCallback(app);
    await index.initialize();
    const read = blockRead(app, 'created.md', '- [ ] stale create');
    const events: unknown[] = [];
    index.subscribe((event) => events.push(event));

    const created = mdFile(app, 'created.md');
    fireCreate(created);
    await read.started;
    fireChanged(created, '- [ ] current metadata', taskCache());
    expect(index.list().map((task) => task.title)).toEqual(['current metadata']);
    await app.vault.rename(created, 'renamed.md');
    expect(index.list().map((task) => task.title)).toEqual(['current metadata']);
    read.release();
    await flushMicrotasks();

    expect(index.list().map((task) => [task.source.filePath, task.title])).toEqual([
      ['renamed.md', 'current metadata'],
    ]);
    expect(events.filter((event) => (event as { type: string }).type === 'renamed')).toEqual([
      { type: 'renamed', oldPath: 'created.md', newPath: 'renamed.md' },
    ]);
    expect(events).not.toContainEqual({ type: 'changed', files: ['renamed.md'] });
    index.destroy();
  });

  it('invalidates a create read when the file is deleted', async () => {
    const { app, index } = await setup({ 'created.md': '- [ ] indexed' });
    const fireCreate = captureCreateCallback(app);
    await index.initialize();
    const read = blockRead(app, 'created.md', '- [ ] stale create');

    const created = mdFile(app, 'created.md');
    fireCreate(created);
    await read.started;
    await app.vault.delete(created);
    read.release();
    await flushMicrotasks();

    expect(index.list()).toEqual([]);
    index.destroy();
  });

  it('ignores stale metadata after delete without publishing changed after deleted', async () => {
    const { app, index, fireChanged } = await setup({ 'deleted.md': '- [ ] current' });
    await index.initialize();
    const file = mdFile(app, 'deleted.md');
    const events: unknown[] = [];
    index.subscribe((event) => events.push(event));

    await app.vault.delete(file);
    fireChanged(file, '- [ ] stale metadata', taskCache());
    await flushMicrotasks();

    expect(index.list()).toEqual([]);
    expect(events).toEqual([{ type: 'deleted', path: 'deleted.md' }]);
    index.destroy();
  });

  it('recomputes the daily-note date after a markdown rename', async () => {
    const { app, index } = await setup({ '2026-07-01.md': '- [ ] daily task' });
    await index.initialize();

    await app.vault.rename(mdFile(app, '2026-07-01.md'), '2026-07-02.md');

    expect(index.list()[0]?.presentation.dailyNoteDate).toBe('2026-07-02');
    index.destroy();
  });

  it('removes tasks and publishes rename when markdown becomes non-markdown', async () => {
    const { app, index } = await setup({ 'task.md': '- [ ] task' });
    await index.initialize();
    const events: unknown[] = [];
    index.subscribe((event) => events.push(event));

    await app.vault.rename(mdFile(app, 'task.md'), 'task.txt');

    expect(index.list()).toEqual([]);
    expect(events).toEqual([{ type: 'renamed', oldPath: 'task.md', newPath: 'task.txt' }]);
    index.destroy();
  });

  it('safely indexes content when a non-markdown file becomes markdown', async () => {
    const { app, index } = await setup({ 'task.txt': '- [ ] newly markdown' });
    await index.initialize();
    const file = app.vault.getAbstractFileByPath('task.txt');
    if (!(file instanceof TFile)) throw new Error('missing task.txt');
    const events: unknown[] = [];
    index.subscribe((event) => events.push(event));

    await app.vault.rename(file, 'task.md');
    await flushMicrotasks();

    expect(index.list().map((task) => [task.source.filePath, task.title])).toEqual([
      ['task.md', 'newly markdown'],
    ]);
    expect(events).toEqual([{ type: 'renamed', oldPath: 'task.txt', newPath: 'task.md' }]);
    index.destroy();
  });

  it('fallback rename preserves quoted task hierarchy without duplicate roots', async () => {
    const content = [
      '> [!todo] Tasks',
      '> - [ ] quoted parent',
      '>   - [ ] quoted child',
      '> - [ ] quoted sibling',
    ].join('\n');
    const { app, index } = await setup({ 'callout.txt': content });
    await index.initialize();
    const file = app.vault.getAbstractFileByPath('callout.txt');
    if (!(file instanceof TFile)) throw new Error('missing callout.txt');

    await app.vault.rename(file, 'callout.md');
    await flushMicrotasks();

    const tasks = index.list();
    expect(tasks.map((task) => task.title)).toEqual(['quoted parent', 'quoted sibling']);
    expect(tasks[0]?.subtasks.map((task) => task.title)).toEqual(['quoted child']);
    index.destroy();
  });

  it('fallback rename does not close an outer fence from a deeper quote container', async () => {
    const content = [
      '> [!example] Fenced tasks',
      '> ```md',
      '> > ```',
      '> > - [ ] hidden deeper example',
      '> - [ ] hidden outer example',
      '> ```',
      '- [ ] visible root',
    ].join('\n');
    const app = await createAppWithFiles({ 'examples.txt': content });
    app.metadataCache.getFileCache = (): null => null;
    const index = new TaskIndex(app, {
      statusCatalog: canonicalStatusCatalog(),
      dailyNoteFormat: 'YYYY-MM-DD',
    });
    await index.initialize();
    const file = app.vault.getAbstractFileByPath('examples.txt');
    if (!(file instanceof TFile)) throw new Error('missing examples.txt');

    await app.vault.rename(file, 'examples.md');
    await flushMicrotasks();

    expect(index.list().map((task) => task.title)).toEqual(['visible root']);
    index.destroy();
  });

  it('fallback rename keeps an indented task after a closed quoted fence as a root', async () => {
    const content = [
      '- [ ] parent',
      '> ~~~md',
      '> callout code example',
      '> ~~~',
      '  - [ ] after boundary',
    ].join('\n');
    const app = await createAppWithFiles({ 'examples.txt': content });
    app.metadataCache.getFileCache = (): null => null;
    const index = new TaskIndex(app, {
      statusCatalog: canonicalStatusCatalog(),
      dailyNoteFormat: 'YYYY-MM-DD',
    });
    await index.initialize();
    const file = app.vault.getAbstractFileByPath('examples.txt');
    if (!(file instanceof TFile)) throw new Error('missing examples.txt');

    await app.vault.rename(file, 'examples.md');
    await flushMicrotasks();

    const tasks = index.list();
    expect(tasks.map((task) => task.title)).toEqual(['parent', 'after boundary']);
    expect(tasks[0]?.subtasks).toEqual([]);
    index.destroy();
  });

  it('fallback rename treats a same-depth quoted fence as a non-list boundary', async () => {
    const content = [
      '> - [ ] parent',
      '> ~~~md',
      '> code example',
      '> ~~~',
      '>   - [ ] after boundary',
    ].join('\n');
    const app = await createAppWithFiles({ 'examples.txt': content });
    app.metadataCache.getFileCache = (): null => null;
    const index = new TaskIndex(app, {
      statusCatalog: canonicalStatusCatalog(),
      dailyNoteFormat: 'YYYY-MM-DD',
    });
    await index.initialize();
    const file = app.vault.getAbstractFileByPath('examples.txt');
    if (!(file instanceof TFile)) throw new Error('missing examples.txt');

    await app.vault.rename(file, 'examples.md');
    await flushMicrotasks();

    const tasks = index.list();
    expect(tasks.map((task) => task.title)).toEqual(['parent', 'after boundary']);
    expect(tasks[0]?.subtasks).toEqual([]);
    index.destroy();
  });

  it('fallback hierarchy does not cross quote-container boundaries', async () => {
    const content = [
      '- [ ] plain parent',
      '> - [ ] quoted boundary',
      '  - [ ] plain after boundary',
    ].join('\n');
    const { app, index } = await setup({ 'boundaries.txt': content });
    await index.initialize();
    const file = app.vault.getAbstractFileByPath('boundaries.txt');
    if (!(file instanceof TFile)) throw new Error('missing boundaries.txt');

    await app.vault.rename(file, 'boundaries.md');
    await flushMicrotasks();

    expect(index.list().map((task) => task.title)).toEqual([
      'plain parent',
      'quoted boundary',
      'plain after boundary',
    ]);
    index.destroy();
  });

  it('replaces recurrence-owner sources atomically with the owning file snapshot', async () => {
    const initial = ['- [ ] root', '  - [ ] repeating 🔁 every day 📅 2026-08-01'].join('\n');
    const { app, index, fireChanged } = await setup({ 'owners.md': initial });
    await index.initialize();

    expect(
      index
        .forCalendarProjection([localDate('2026-08-08')])
        .recurringSources.map(({ node }) => node.title),
    ).toEqual(['repeating']);

    const replacement = ['- [ ] root', '  - [ ] no longer repeating 📅 2026-08-08'].join('\n');
    fireChanged(mdFile(app, 'owners.md'), replacement, taskCache());

    const projection = index.forCalendarProjection([localDate('2026-08-08')]);
    expect(projection.recurringSources).toEqual([]);
    expect(projection.materialized.map(({ node }) => node.title)).toEqual([]);
    index.destroy();
  });

  it('relocates and deletes flattened recurrence-owner sources with their file', async () => {
    const content = '- [ ] owner 🔁 every week 📅 2026-07-01';
    const { app, index } = await setup({ 'old.md': content });
    await index.initialize();

    await app.vault.rename(mdFile(app, 'old.md'), 'new.md');
    const renamed = index.forCalendarProjection([localDate('2026-08-08')]).recurringSources[0]!;
    expect(renamed.root.source.filePath).toBe('new.md');
    expect(renamed.target).toMatchObject({ type: 'task', ref: { filePath: 'new.md' } });

    await app.vault.delete(mdFile(app, 'new.md'));
    expect(index.forCalendarProjection([localDate('2026-08-08')])).toEqual({
      materialized: [],
      recurringSources: [],
    });
    index.destroy();
  });

  it('returns detached calendar source graphs with matching root and subtask navigation identity', async () => {
    const content = ['- [ ] root', '  - [ ] nested 🔁 every day 📅 2026-08-08'].join('\n');
    const { index } = await setup({ 'owners.md': content });
    await index.initialize();

    const compareNodeRefs = vi.spyOn(taskTypes, 'sameTaskNodeRef');
    compareNodeRefs.mockClear();
    const first = index.forCalendarProjection([localDate('2026-08-08')]);
    const breadthSearchOperations = compareNodeRefs.mock.calls.length;
    compareNodeRefs.mockRestore();
    expect(breadthSearchOperations).toBe(0);
    const source = first.materialized[0]!;
    expect(source.target.type).toBe('subtask');
    expect(source.node).toBe(source.root.subtasks[0]);
    if (source.target.type !== 'subtask') throw new Error('expected nested source');
    expect(source.target.ref).toBe(source.node.ref);
    expect(first.recurringSources[0]?.root).toBe(source.root);
    expect(first.recurringSources[0]?.node).toBe(source.node);

    (first.materialized as unknown as unknown[]).length = 0;
    (first.recurringSources as unknown as unknown[]).length = 0;
    (source.root as unknown as { title: string }).title = 'mutated root';
    (source.node as unknown as { title: string }).title = 'mutated nested';
    (source.root.subtasks as unknown as unknown[]).length = 0;
    (source.target.ref as unknown as { originalBlock: string }).originalBlock = 'mutated target';

    const fresh = index.forCalendarProjection([localDate('2026-08-08')]);
    expect(fresh.materialized[0]?.root).not.toBe(source.root);
    expect(fresh.recurringSources[0]?.root).toBe(fresh.materialized[0]?.root);
    expect(fresh.materialized[0]?.root.title).toBe('root');
    expect(fresh.materialized[0]?.node.title).toBe('nested');
    expect(fresh.materialized[0]?.root.subtasks).toHaveLength(1);
    expect(fresh.materialized[0]?.target).toMatchObject({
      type: 'subtask',
      ref: { originalBlock: expect.stringContaining('nested') },
    });
    index.destroy();
  });
});
