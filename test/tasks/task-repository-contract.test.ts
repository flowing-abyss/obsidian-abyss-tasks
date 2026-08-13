import { TFile, type App } from 'obsidian';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '../../src/settings/defaults';
import { toStatusRules } from '../../src/settings/statusCatalogAdapter';
import type { TaskEditCommand, TaskEditRequest } from '../../src/tasks/application/TaskRepository';
import { StatusCatalog } from '../../src/tasks/domain/StatusCatalog';
import type { TaskRef } from '../../src/tasks/domain/types';
import { localDate, localTime } from '../../src/tasks/domain/validation';
import { TaskBlockEditor } from '../../src/tasks/infrastructure/markdown/TaskBlockEditor';
import { TaskLocator } from '../../src/tasks/infrastructure/markdown/TaskLocator';
import { TaskMarkdownCodec } from '../../src/tasks/infrastructure/markdown/TaskMarkdownCodec';
import { ObsidianTaskRepository } from '../../src/tasks/infrastructure/obsidian/ObsidianTaskRepository';
import { TaskIndex } from '../../src/tasks/infrastructure/TaskIndex';
import {
  TaskRefAuthority,
  taskRefContentFingerprint,
} from '../../src/tasks/infrastructure/TaskRefAuthority';
import { createAppWithFiles, seedTaskCache } from '../helpers';

interface Harness {
  readonly app: App;
  readonly repository: ObsidianTaskRepository;
  readonly locator: TaskLocator;
  readonly editor: TaskBlockEditor;
  readonly snapshotsFromContent: (
    path: string,
    content: string,
  ) => readonly import('../../src/tasks/domain/types').TaskSnapshot[];
}

async function harness(
  files: Record<string, string>,
  snapshotsOverride?: Harness['snapshotsFromContent'],
): Promise<Harness> {
  const app = await createAppWithFiles(files);
  const statusCatalog = new StatusCatalog(toStatusRules(DEFAULT_SETTINGS.taskStatuses));
  const codec = new TaskMarkdownCodec(statusCatalog);
  const editor = new TaskBlockEditor();
  const locator = new TaskLocator();
  const index = new TaskIndex(app, {
    statusCatalog,
    dailyNoteFormat: DEFAULT_SETTINGS.desktop.dailyNoteFormat,
  });
  const snapshotsFromContent =
    snapshotsOverride ??
    ((path: string, content: string) => index.snapshotsFromContent(path, content));
  const repository = new ObsidianTaskRepository(app, {
    codec,
    editor,
    locator,
    snapshotsFromContent,
  });
  return { app, repository, locator, editor, snapshotsFromContent };
}

function refFor(h: Harness, path: string, content: string, line = 0): TaskRef {
  const block = h.editor.rootBlocks(content).find((candidate) => candidate.line === line);
  if (!block) throw new Error(`missing task at ${line}`);
  return { filePath: path, line, revision: h.locator.revision(block.source) };
}

async function read(app: App, path: string): Promise<string> {
  const file = app.vault.getAbstractFileByPath(path);
  if (!(file instanceof TFile)) throw new Error('missing file');
  return app.vault.cachedRead(file);
}

function patch(
  ref: TaskRef,
  field: 'due' | 'scheduled' | 'start',
  value: string | null,
): TaskEditCommand {
  return {
    type: 'patch',
    target: { type: 'task', ref },
    patch: {
      [field]:
        value === null
          ? { type: 'clear' as const }
          : { type: 'set' as const, value: localDate(value) },
    },
  };
}

describe('ObsidianTaskRepository planning contract', () => {
  it('returns repository-authoritative same-line authority-transition evidence', async () => {
    const path = 'tasks.md';
    const source = '- [ ] task\n';
    const candidate = '- [ ] task #external\n';
    const app = await createAppWithFiles({ [path]: source });
    const statusCatalog = new StatusCatalog(toStatusRules(DEFAULT_SETTINGS.taskStatuses));
    const authority = new TaskRefAuthority('repository-race');
    const editor = new TaskBlockEditor();
    const locator = new TaskLocator(authority);
    const codec = new TaskMarkdownCodec(statusCatalog);
    const index = new TaskIndex(app, {
      statusCatalog,
      dailyNoteFormat: DEFAULT_SETTINGS.desktop.dailyNoteFormat,
      refAuthority: authority,
    });
    await index.initialize();
    const baseRoot = index.list()[0]!;
    const successor = authority.successor(baseRoot.ref.revision, candidate.trimEnd());
    if (!successor) throw new Error('missing successor');
    const staged = authority.stage(
      {
        filePath: path,
        candidateFingerprint: taskRefContentFingerprint(candidate),
        candidateLength: candidate.length,
        expectedRevision: baseRoot.ref.revision,
        roots: [{ line: 0, source: candidate.trimEnd(), revision: successor }],
      },
      baseRoot.ref.revision,
    );
    if (staged.type !== 'staged') throw new Error('missing transition');
    authority.commit(staged.token);
    const current = index.installCommittedContent(path, candidate)[0]!;
    authority.acknowledge(path, candidate);
    const file = app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) throw new Error('missing file');
    await app.vault.modify(file, candidate);
    const repository = new ObsidianTaskRepository(app, {
      codec,
      editor,
      locator,
      snapshotsFromContent: (filePath, content) => index.snapshotsFromContent(filePath, content),
      refAuthority: authority,
      snapshotState: index,
    });

    await expect(
      repository.edit({
        command: {
          type: 'patch',
          target: { type: 'task', ref: baseRoot.ref },
          patch: { tags: { add: ['#work'] } },
        },
        baseRoot,
        baseTarget: { type: 'task', ref: baseRoot.ref },
        reconciliation: { observed: baseRoot },
      }),
    ).resolves.toMatchObject({
      type: 'rebased',
      previous: { ref: baseRoot.ref },
      current: { ref: current.ref },
      evidence: 'authority-transition',
    });
    expect(await read(app, path)).toBe(candidate);
    index.destroy();
  });

  it('returns repository-authoritative relocation evidence before a prepared write', async () => {
    const source = '- [ ] task\n- [ ] other\n';
    const relocated = 'intro\n- [ ] task\n- [ ] other\n';
    const h = await harness({ 'tasks.md': source });
    const baseRoot = h.snapshotsFromContent('tasks.md', source)[0]!;
    const file = h.app.vault.getAbstractFileByPath('tasks.md');
    if (!(file instanceof TFile)) throw new Error('missing file');
    await h.app.vault.modify(file, relocated);
    const request: TaskEditRequest = {
      command: {
        type: 'patch',
        target: { type: 'task', ref: baseRoot.ref },
        patch: { tags: { add: ['#work'] } },
      },
      baseRoot,
      baseTarget: { type: 'task', ref: baseRoot.ref },
      reconciliation: { observed: baseRoot },
    };

    await expect(h.repository.edit(request)).resolves.toMatchObject({
      type: 'rebased',
      previous: baseRoot,
      current: { source: { line: 1, originalBlock: '- [ ] task' } },
      evidence: 'byte-identical-relocation',
    });
    expect(await read(h.app, 'tasks.md')).toBe(relocated);
  });

  it('returns uncertain instead of treating a changed same-line occupant as writable', async () => {
    const source = '- [ ] task\n';
    const externallyEdited = '- [ ] task #external\n';
    const h = await harness({ 'tasks.md': source });
    const baseRoot = h.snapshotsFromContent('tasks.md', source)[0]!;
    const file = h.app.vault.getAbstractFileByPath('tasks.md');
    if (!(file instanceof TFile)) throw new Error('missing file');
    await h.app.vault.modify(file, externallyEdited);

    await expect(
      h.repository.edit({
        command: {
          type: 'patch',
          target: { type: 'task', ref: baseRoot.ref },
          patch: { priority: { type: 'set', value: 'A' } },
        },
        baseRoot,
        baseTarget: { type: 'task', ref: baseRoot.ref },
        reconciliation: { observed: baseRoot },
      }),
    ).resolves.toEqual({
      type: 'uncertain',
      target: { type: 'task', ref: baseRoot.ref },
    });
    expect(await read(h.app, 'tasks.md')).toBe(externallyEdited);
  });

  it('commits a validated structural candidate through one synchronous process callback', async () => {
    const source = '- [ ] task\r\n  - > old\r\n- [ ] other\r\n';
    const h = await harness({ 'tasks.md': source });
    const process = vi.spyOn(h.app.vault, 'process');
    const root = h.snapshotsFromContent('tasks.md', source)[0]!;

    await expect(
      h.repository.edit({
        type: 'set-description',
        target: { type: 'task', ref: root.ref },
        text: 'new',
      }),
    ).resolves.toMatchObject({
      type: 'committed',
      changed: true,
      outcome: { type: 'task', task: { description: 'new' } },
    });
    expect(process).toHaveBeenCalledOnce();
    expect(process.mock.calls[0]?.[1].constructor.name).not.toBe('AsyncFunction');
    expect(await read(h.app, 'tasks.md')).toBe('- [ ] task\r\n  - > new\r\n- [ ] other\r\n');
  });

  it('sets and clears planning fields losslessly in one synchronous process callback', async () => {
    const source = '- [ ] task custom 🆔 keep-id ⛔ dep ^block\r\n';
    const h = await harness({ 'tasks.md': source });
    const file = h.app.vault.getAbstractFileByPath('tasks.md');
    if (!(file instanceof TFile)) throw new Error('missing file');
    const process = vi.spyOn(h.app.vault, 'process');
    const result = await h.repository.edit(
      patch(refFor(h, 'tasks.md', source), 'due', '2026-07-20'),
    );

    expect(result).toMatchObject({
      type: 'committed',
      changed: true,
      outcome: { type: 'task', task: { planning: { due: '2026-07-20' } } },
    });
    expect(await read(h.app, 'tasks.md')).toBe(
      '- [ ] task custom 🆔 keep-id ⛔ dep 📅 2026-07-20 ^block\r\n',
    );
    expect(process).toHaveBeenCalledOnce();
    const transform = process.mock.calls[0]?.[1];
    expect(transform?.constructor.name).not.toBe('AsyncFunction');

    const changed = await read(h.app, 'tasks.md');
    const clear = await h.repository.edit(patch(refFor(h, 'tasks.md', changed), 'due', null));
    expect(clear).toMatchObject({ type: 'committed', changed: true });
    expect(await read(h.app, 'tasks.md')).toBe(source);
  });

  it('converts a timed task to all-day through exactly one vault process', async () => {
    const source = '- [/] task #keep 📅 2026-07-20 ⏰ 09:30 ⏱️ 45m\n';
    const h = await harness({ 'tasks.md': source });
    const process = vi.spyOn(h.app.vault, 'process');

    await expect(
      h.repository.edit({
        type: 'move-to-all-day',
        ref: refFor(h, 'tasks.md', source),
        days: 0,
      }),
    ).resolves.toMatchObject({ type: 'committed', changed: true });

    expect(await read(h.app, 'tasks.md')).toBe('- [/] task #keep 📅 2026-07-20\n');
    expect(process).toHaveBeenCalledOnce();
  });

  it.each([
    {
      command: {
        type: 'move-time-slot' as const,
        days: -1,
        time: localTime('10:15'),
      },
      source: '- [ ] earliest 🛫 0000-01-01 📅 0000-01-03 ⏰ 09:30\n',
    },
    {
      command: { type: 'move-to-all-day' as const, days: 1 },
      source: '- [ ] latest 🛫 9999-12-29 📅 9999-12-31 ⏰ 09:30 ⏱️ 45m\n',
    },
  ])(
    'atomically rejects an out-of-range $command.type without changing bytes',
    async ({ command, source }) => {
      const h = await harness({ 'tasks.md': source });
      const process = vi.spyOn(h.app.vault, 'process');

      await expect(
        h.repository.edit({ ...command, ref: refFor(h, 'tasks.md', source) }),
      ).resolves.toEqual({
        type: 'invalid',
        issues: [{ code: 'invalid-date', field: 'schedule' }],
      });
      expect(await read(h.app, 'tasks.md')).toBe(source);
      expect(process).toHaveBeenCalledOnce();
    },
  );

  it('reschedules scheduled before due and adds due when neither exists', async () => {
    const source = '- [ ] both ⏳ 2026-07-10 📅 2026-07-20\n- [ ] plain\n';
    const h = await harness({ 'tasks.md': source });
    const first = await h.repository.edit({
      type: 'reschedule',
      ref: refFor(h, 'tasks.md', source, 0),
      date: localDate('2026-07-11'),
    });
    expect(first).toMatchObject({ type: 'committed', changed: true });
    let content = await read(h.app, 'tasks.md');
    expect(content).toContain('⏳ 2026-07-11 📅 2026-07-20');

    const second = await h.repository.edit({
      type: 'reschedule',
      ref: refFor(h, 'tasks.md', content, 1),
      date: localDate('2026-07-12'),
    });
    expect(second).toMatchObject({ type: 'committed', changed: true });
    content = await read(h.app, 'tasks.md');
    expect(content).toContain('- [ ] plain 📅 2026-07-12');
  });

  it('rejects an inverted span and duplicate target field without changing bytes', async () => {
    const source =
      '- [ ] span 🛫 2026-07-10 📅 2026-07-20\n- [ ] duplicate 📅 2026-07-20 📅 2026-07-21\n';
    const h = await harness({ 'tasks.md': source });

    await expect(
      h.repository.edit(patch(refFor(h, 'tasks.md', source, 0), 'start', '2026-07-21')),
    ).resolves.toEqual({
      type: 'invalid',
      issues: [{ code: 'inverted-span', field: 'start,due' }],
    });
    await expect(
      h.repository.edit(patch(refFor(h, 'tasks.md', source, 1), 'due', '2026-07-22')),
    ).resolves.toEqual({
      type: 'invalid',
      issues: [{ code: 'duplicate-field', field: 'due' }],
    });
    expect(await read(h.app, 'tasks.md')).toBe(source);
  });

  it('returns no-op success and repeated execution becomes stale instead of overwriting', async () => {
    const source = '- [ ] task 📅 2026-07-20\n';
    const h = await harness({ 'tasks.md': source });
    const ref = refFor(h, 'tasks.md', source);
    await expect(h.repository.edit(patch(ref, 'due', '2026-07-20'))).resolves.toMatchObject({
      type: 'committed',
      changed: false,
    });
    await expect(h.repository.edit(patch(ref, 'due', '2026-07-21'))).resolves.toMatchObject({
      type: 'committed',
      changed: true,
    });
    await expect(h.repository.edit(patch(ref, 'due', '2026-07-22'))).resolves.toMatchObject({
      type: 'conflict',
      current: { planning: { due: '2026-07-21' } },
    });
    expect(await read(h.app, 'tasks.md')).toContain('📅 2026-07-21');
  });

  it('recovers unique line drift, distinguishes conflict/not-found, and returns exact ambiguity candidates', async () => {
    const original = '- [ ] wanted\n';
    const h = await harness({ 'tasks.md': original });
    const ref = refFor(h, 'tasks.md', original);
    const file = h.app.vault.getAbstractFileByPath('tasks.md');
    if (!(file instanceof TFile)) throw new Error('missing file');

    await h.app.vault.modify(file, 'heading\n- [ ] wanted\n');
    await expect(h.repository.edit(patch(ref, 'due', '2026-07-20'))).resolves.toMatchObject({
      type: 'committed',
      outcome: { type: 'task', task: { source: { line: 1 } } },
    });

    const current = await read(h.app, 'tasks.md');
    const changedRef = refFor(h, 'tasks.md', current, 1);
    await h.app.vault.modify(file, 'heading\n- [ ] changed\n');
    await expect(h.repository.edit(patch(changedRef, 'due', '2026-07-21'))).resolves.toMatchObject({
      type: 'conflict',
      current: { markdownTitle: 'changed' },
    });

    await h.app.vault.modify(file, 'heading only\n');
    await expect(h.repository.edit(patch(changedRef, 'due', '2026-07-21'))).resolves.toMatchObject({
      type: 'not-found',
    });

    await h.app.vault.modify(file, '- [ ] changed\n- [ ] changed\n');
    const duplicateRef = {
      filePath: 'tasks.md',
      line: 9,
      revision: h.locator.revision('- [ ] changed'),
    };
    const ambiguous = await h.repository.edit(patch(duplicateRef, 'due', '2026-07-21'));
    expect(ambiguous).toMatchObject({
      type: 'ambiguous',
      candidates: [
        { root: { source: { line: 0 } }, target: { type: 'task' } },
        { root: { source: { line: 1 } }, target: { type: 'task' } },
      ],
    });
  });

  it('deletes the complete root aggregate after unique line drift', async () => {
    const original = '- [ ] task\n  - [ ] subtask\n- [ ] after\n';
    const h = await harness({ 'tasks.md': original });
    const ref = refFor(h, 'tasks.md', original);
    const file = h.app.vault.getAbstractFileByPath('tasks.md');
    if (!(file instanceof TFile)) throw new Error('missing file');
    await h.app.vault.modify(file, `inserted\n${original}`);

    await expect(h.repository.edit({ type: 'delete', ref })).resolves.toMatchObject({
      type: 'committed',
      changed: true,
      outcome: { type: 'deleted' },
    });
    expect(await read(h.app, 'tasks.md')).toBe('inserted\n- [ ] after\n');
  });

  it('maps process rejection to an unknown content-state io error', async () => {
    const source = '- [ ] task\n';
    const h = await harness({ 'tasks.md': source });
    vi.spyOn(h.app.vault, 'process').mockRejectedValue(new Error('boom'));

    await expect(
      h.repository.edit(patch(refFor(h, 'tasks.md', source), 'due', '2026-07-20')),
    ).resolves.toEqual({
      type: 'io-error',
      cause: 'process-error',
      path: 'tasks.md',
      contentState: 'unknown',
    });
  });

  it('rejects unavailable create and move paths before starting a vault transaction', async () => {
    const h = await harness({ 'tasks.md': '- [ ] task\n' });

    await expect(
      h.repository.create(
        { filePath: 'missing.md', insertion: { type: 'append' } },
        { markdownBody: 'new task' },
      ),
    ).resolves.toEqual({
      type: 'invalid',
      issues: [{ code: 'destination-unavailable', field: 'destination' }],
    });
    await expect(
      h.repository.move(
        { filePath: 'missing.md', line: 0, revision: 'missing' },
        { filePath: 'tasks.md', insertion: { type: 'append' } },
      ),
    ).resolves.toMatchObject({ type: 'not-found' });
  });

  it('fails closed when an exact block cannot be projected before or after a mutation', async () => {
    const source = '- [ ] task\n';
    const h = await harness({ 'tasks.md': source, 'target.md': '' }, () => []);
    const ref = refFor(h, 'tasks.md', source);

    await expect(h.repository.edit({ type: 'delete', ref })).resolves.toMatchObject({
      type: 'not-found',
    });
    await expect(h.repository.edit(patch(ref, 'due', '2026-07-20'))).resolves.toEqual({
      type: 'invalid',
      issues: [{ code: 'invalid-task-syntax' }],
    });
    await expect(
      h.repository.move(ref, {
        filePath: 'target.md',
        insertion: { type: 'append' },
      }),
    ).resolves.toMatchObject({ type: 'not-found' });
    expect(await read(h.app, 'tasks.md')).toBe(source);
  });

  it('maps a process implementation that skips its callback to a fail-closed I/O result', async () => {
    const source = '- [ ] task\n';
    const h = await harness({ 'tasks.md': source });
    vi.spyOn(h.app.vault, 'process').mockResolvedValue(source);

    await expect(
      h.repository.edit(patch(refFor(h, 'tasks.md', source), 'due', '2026-07-20')),
    ).resolves.toEqual({
      type: 'io-error',
      cause: 'process-error',
      path: 'tasks.md',
      contentState: 'unknown',
    });
  });

  it('throws for an impossible runtime edit command without a task reference', async () => {
    const h = await harness({ 'tasks.md': '- [ ] task\n' });

    await expect(
      h.repository.edit({ type: 'external-command' } as unknown as TaskEditCommand),
    ).rejects.toThrow('Task edit command has no root reference');
  });

  it('confirms every child block before editing and never adopts a same-line replacement', async () => {
    const source = '- [ ] root\n  - [ ] child 📅 2026-07-20\n';
    const h = await harness({ 'tasks.md': source });
    const root = h.snapshotsFromContent('tasks.md', source)[0]!;
    const child = root.subtasks[0]!;
    const forged = {
      ...child.ref,
      originalBlock: '  - [ ] replacement 📅 2026-07-20',
      parent: { type: 'task' as const, ref: root.ref },
    };

    await expect(
      h.repository.edit({
        type: 'patch',
        target: { type: 'subtask', ref: forged },
        patch: { due: { type: 'set', value: localDate('2026-07-21') } },
      }),
    ).resolves.toMatchObject({ type: 'conflict', current: { ref: root.ref } });
    expect(await read(h.app, 'tasks.md')).toBe(source);
  });

  it('edits an exactly confirmed nested child and returns the updated root aggregate', async () => {
    const source = '- [ ] root\n  - [ ] child\n    - [ ] nested 📅 2026-07-20\n';
    const h = await harness({ 'tasks.md': source });
    const root = h.snapshotsFromContent('tasks.md', source)[0]!;
    const nested = root.subtasks[0]!.subtasks[0]!;

    const result = await h.repository.edit({
      type: 'patch',
      target: { type: 'subtask', ref: nested.ref },
      patch: { due: { type: 'set', value: localDate('2026-07-21') } },
    });

    expect(result).toMatchObject({
      type: 'committed',
      changed: true,
      outcome: {
        type: 'task',
        task: { subtasks: [{ subtasks: [{ planning: { due: '2026-07-21' } }] }] },
      },
    });
    expect(await read(h.app, 'tasks.md')).toContain('nested 📅 2026-07-21');
  });

  it('retains complete presentation metadata from exact post-edit frontmatter', async () => {
    const source =
      '---\ncolor: "#123456"\ntextColor: "#abcdef"\nicon: calendar-days\n---\n- [ ] [[Linked task]]\n';
    const h = await harness({ 'tasks.md': source });
    seedTaskCache(h.app, 'tasks.md', [{ task: ' ', parent: -1, line: 5 }], {
      color: '#stale',
      textColor: '#stale',
      icon: 'stale',
    });

    const result = await h.repository.edit(
      patch(refFor(h, 'tasks.md', source, 5), 'due', '2026-07-20'),
    );

    expect(result).toMatchObject({
      type: 'committed',
      changed: true,
      outcome: {
        type: 'task',
        task: {
          presentation: {
            linkCount: 1,
            noteColor: '#123456',
            noteTextColor: '#abcdef',
            noteIcon: 'calendar-days',
          },
        },
      },
    });
  });
});
