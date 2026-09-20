import { TFile } from 'obsidian';
import { describe, expect, it, vi } from 'vitest';
import { AppState } from '../src/app/AppState';
import { CenterPanel } from '../src/panels/CenterPanel';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import { toStatusRules } from '../src/settings/statusCatalogAdapter';
import { StatusRegistry } from '../src/status/StatusRegistry';
import { TaskApplicationService } from '../src/tasks/application/TaskApplicationService';
import type { TaskDiagnosticSink } from '../src/tasks/application/TaskDependencyService';
import type { TaskDestinationProvider } from '../src/tasks/application/TaskDestinationProvider';
import { StatusCatalog } from '../src/tasks/domain/StatusCatalog';
import type { TaskDestination, TaskRef, TaskSnapshot } from '../src/tasks/domain/types';
import { localDate } from '../src/tasks/domain/validation';
import { TaskIndex } from '../src/tasks/infrastructure/TaskIndex';
import { TaskRefAuthority } from '../src/tasks/infrastructure/TaskRefAuthority';
import { TaskBlockEditor } from '../src/tasks/infrastructure/markdown/TaskBlockEditor';
import { TaskLocator } from '../src/tasks/infrastructure/markdown/TaskLocator';
import { TaskMarkdownCodec } from '../src/tasks/infrastructure/markdown/TaskMarkdownCodec';
import { ObsidianTaskRepository } from '../src/tasks/infrastructure/obsidian/ObsidianTaskRepository';
import { TaskArchiveRecoveryModal } from '../src/ui/TaskArchiveRecoveryModal';
import {
  createAppWithFiles,
  expectDefined,
  flushMicrotasks,
  freshContainer,
  useRealMoment,
} from './helpers';

useRealMoment();

const ARCHIVE: TaskDestination = {
  filePath: 'tasks/archive.md',
  insertion: { type: 'append' },
};

async function harness(
  source: string,
  archive = '',
): Promise<{
  readonly app: Awaited<ReturnType<typeof createAppWithFiles>>;
  readonly index: TaskIndex;
  readonly repository: ObsidianTaskRepository;
  readonly ref: TaskRef;
  readonly read: (path: string) => Promise<string>;
}> {
  const app = await createAppWithFiles({ 'source.md': source, 'tasks/archive.md': archive });
  const statusCatalog = new StatusCatalog(toStatusRules(DEFAULT_SETTINGS.taskStatuses));
  const authority = new TaskRefAuthority('archive-contract');
  const index = new TaskIndex(app, {
    statusCatalog,

    refAuthority: authority,
    excludeSource: ({ filePath }) => filePath.toLowerCase() === 'tasks/archive.md',
  });
  await index.initialize();
  const repository = new ObsidianTaskRepository(app, {
    codec: new TaskMarkdownCodec(statusCatalog),
    editor: new TaskBlockEditor(),
    locator: new TaskLocator(authority),
    snapshotsFromContent: (path, content) => index.snapshotsFromContent(path, content),
    refAuthority: authority,
    snapshotState: index,
  });
  const ref = expectDefined(index.list({ filePath: 'source.md' })[0]).ref;
  return {
    app,
    index,
    repository,
    ref,
    read: async (path) => {
      const file = app.vault.getAbstractFileByPath(path);
      if (!(file instanceof TFile)) throw new Error(`missing ${path}`);
      return app.vault.cachedRead(file);
    },
  };
}

function archiveApplication(
  h: Awaited<ReturnType<typeof harness>>,
  destinationProvider?: TaskDestinationProvider,
  diagnostics?: TaskDiagnosticSink,
): TaskApplicationService {
  return new TaskApplicationService(
    h.index,
    h.repository,
    new StatusCatalog(toStatusRules(DEFAULT_SETTINGS.taskStatuses)),
    { today: () => localDate('2026-09-19') },
    destinationProvider,
    undefined,
    undefined,
    diagnostics,
  );
}

function archiveProvider(
  planArchive: TaskDestinationProvider['planArchive'],
): TaskDestinationProvider {
  return { planArchive } as TaskDestinationProvider;
}

async function archiveSelection(
  h: Awaited<ReturnType<typeof harness>>,
  selected: readonly TaskSnapshot[],
  afterArchive?: (el: HTMLElement) => void,
): Promise<readonly string[]> {
  const application = archiveApplication(
    h,
    archiveProvider(async () => ({
      destination: ARCHIVE,
      prepare: async () => ({ type: 'resolved', destination: ARCHIVE }),
    })),
  );
  const state = new AppState();
  state.set('selectedList', 'inbox');
  const panel = new CenterPanel(
    state,
    h.app,
    DEFAULT_SETTINGS,
    h.index,
    new StatusRegistry(DEFAULT_SETTINGS.taskStatuses),
    async () => {},
    null,
    null,
    application,
  );
  const el = freshContainer();
  panel.mount(el);
  for (const task of selected) {
    el.querySelector<HTMLElement>(`.abyss-task-card[data-line="${task.ref.line}"]`)?.dispatchEvent(
      new MouseEvent('click', { bubbles: true, ctrlKey: true }),
    );
  }
  try {
    await (
      panel as unknown as {
        archiveTasks_abyssPrivate(tasks: readonly TaskSnapshot[]): Promise<void>;
      }
    ).archiveTasks_abyssPrivate(selected);
    state.batch(() => {});
    afterArchive?.(el);
    return [...el.querySelectorAll<HTMLElement>('.abyss-multi-selected')].map(
      (card) =>
        h.index.list().find((task) => task.ref.line === Number(card.dataset['line']))?.title ?? '',
    );
  } finally {
    panel.destroy();
  }
}

describe('transactional task archive', () => {
  it.each([
    { order: [0, 1, 2, 3], archived: '- [ ] First\n- [ ] Second\n- [ ] Third\n- [ ] Fourth\n' },
    { order: [3, 0, 2, 1], archived: '- [ ] Fourth\n- [ ] First\n- [ ] Third\n- [ ] Second\n' },
  ])(
    'archives the entire selection despite repeated line shifts ($order)',
    async ({ order, archived }) => {
      const h = await harness(
        '- [ ] First\n- [ ] Second\n- [ ] Third\n- [ ] Fourth\n',
        '# Archive\n',
      );
      try {
        const roots = h.index.list({ filePath: 'source.md' });
        await archiveSelection(
          h,
          order.map((index) => expectDefined(roots[index])),
        );
        expect(await h.read('source.md')).toBe('');
        expect(await h.read('tasks/archive.md')).toBe(`# Archive\n${archived}`);
      } finally {
        h.index.destroy();
      }
    },
  );

  it('stops on ambiguous identical roots without moving the remaining unique task', async () => {
    const block = '- [x] Same\n  Description\n  - [ ] Child\n';
    const source = `# Tasks\n${block.repeat(4)}- [ ] Keep\n`;
    const h = await harness(source, '# Archive\n');
    try {
      await archiveSelection(h, h.index.list({ filePath: 'source.md' }));
      expect(await h.read('source.md')).toBe(source);
      expect(await h.read('tasks/archive.md')).toBe('# Archive\n');
    } finally {
      h.index.destroy();
    }
  });

  it('stops the batch on partial failure so remaining tasks and recovery evidence stay intact', async () => {
    const source = '- [ ] First\n- [ ] Second\n- [ ] Third\n';
    const h = await harness(source, '# Archive\n');
    const process = h.app.vault.process.bind(h.app.vault);
    vi.spyOn(h.app.vault, 'process')
      .mockImplementationOnce(process)
      .mockRejectedValueOnce(new Error('source removal failed'))
      .mockImplementation(process);
    try {
      await archiveSelection(h, h.index.list({ filePath: 'source.md' }));
      expect(await h.read('source.md')).toBe(source);
      expect(await h.read('tasks/archive.md')).toBe('# Archive\n- [ ] First\n');
    } finally {
      h.index.destroy();
    }
  });

  it('keeps only failed and unattempted tasks selected after a successful removal shifts their lines', async () => {
    const h = await harness('- [ ] First\n- [ ] Second\n- [ ] Third\n- [ ] Keep\n', '# Archive\n');
    const process = h.app.vault.process.bind(h.app.vault);
    let removals = 0;
    vi.spyOn(h.app.vault, 'process').mockImplementation(async (file, transform) => {
      if (file.path === 'source.md' && ++removals === 2) throw new Error('second removal failed');
      return await process(file, transform);
    });
    try {
      const selected = await archiveSelection(
        h,
        h.index.list({ filePath: 'source.md' }).slice(0, 3),
        (el) => {
          expect(
            [...el.querySelectorAll<HTMLElement>('.abyss-multi-selected')].map(
              (card) => card.dataset['line'],
            ),
          ).toEqual(['0', '1']);
          expectDefined(
            el.querySelector<HTMLElement>('.abyss-task-card[data-line="0"]'),
          ).dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }));
        },
      );
      expect(await h.read('source.md')).toBe('- [ ] Second\n- [ ] Third\n- [ ] Keep\n');
      expect(await h.read('tasks/archive.md')).toBe('# Archive\n- [ ] First\n- [ ] Second\n');
      expect(selected).toEqual(['Second']);
    } finally {
      h.index.destroy();
    }
  });

  it('stops when an external edit replaces a pending task instead of archiving the replacement', async () => {
    const h = await harness('- [ ] First\n- [ ] Second\n- [ ] Third\n', '# Archive\n');
    const process = h.app.vault.process.bind(h.app.vault);
    vi.spyOn(h.app.vault, 'process').mockImplementation(async (file, transform) => {
      const result = await process(file, transform);
      if (file.path === 'tasks/archive.md') {
        const source = h.app.vault.getAbstractFileByPath('source.md');
        if (!(source instanceof TFile)) throw new Error('missing source');
        const changed = (await h.app.vault.read(source)).replace('Second', 'External replacement');
        await h.app.vault.modify(source, changed);
        h.index.installCommittedContent('source.md', changed);
      }
      return result;
    });
    try {
      await archiveSelection(h, h.index.list({ filePath: 'source.md' }));
      expect(await h.read('source.md')).toBe('- [ ] External replacement\n- [ ] Third\n');
      expect(await h.read('tasks/archive.md')).toBe('# Archive\n- [ ] First\n');
    } finally {
      h.index.destroy();
    }
  });

  it('returns an executable unavailable session when no archive destination is configured', async () => {
    const h = await harness('- [ ] Keep active\n');
    try {
      const application = archiveApplication(h);

      const session = await application.planArchive();

      expect(session.type).toBe('unavailable');
      await expect(session.execute(h.ref)).resolves.toEqual({
        type: 'invalid',
        issues: [{ code: 'destination-unavailable', field: 'destination' }],
      });
      expect(await h.read('source.md')).toBe('- [ ] Keep active\n');
    } finally {
      h.index.destroy();
    }
  });

  it('diagnoses archive planning failures and keeps the unavailable session executable', async () => {
    const h = await harness('- [ ] Planner failure\n');
    const failure = new Error('archive planning failed');
    const diagnostics = vi.fn<TaskDiagnosticSink>();
    const provider = archiveProvider(vi.fn().mockRejectedValue(failure));
    try {
      const application = archiveApplication(h, provider, diagnostics);

      const session = await application.planArchive();

      expect(session.type).toBe('unavailable');
      await expect(session.execute(h.ref)).resolves.toEqual({
        type: 'invalid',
        issues: [{ code: 'destination-unavailable', field: 'destination' }],
      });
      expect(diagnostics).toHaveBeenCalledWith(
        { operation: 'archive', phase: 'unexpected', cause: 'destination-plan' },
        failure,
      );
      expect(await h.read('source.md')).toBe('- [ ] Planner failure\n');
    } finally {
      h.index.destroy();
    }
  });

  it('rejects a stale prepared-session ref before repository I/O', async () => {
    const h = await harness('- [ ] Session target\n');
    const prepare = vi.fn().mockResolvedValue({ type: 'resolved', destination: ARCHIVE });
    const provider = archiveProvider(vi.fn().mockResolvedValue({ destination: ARCHIVE, prepare }));
    const archive = vi.spyOn(h.repository, 'archive');
    try {
      const session = await archiveApplication(h, provider).planArchive();
      if (session.type !== 'ready') throw new Error('archive session unavailable');

      await expect(
        session.execute({ ...h.ref, revision: `${h.ref.revision}:stale` }),
      ).resolves.toMatchObject({ type: 'not-found' });
      expect(prepare).not.toHaveBeenCalled();
      expect(archive).not.toHaveBeenCalled();
      expect(await h.read('source.md')).toBe('- [ ] Session target\n');
    } finally {
      h.index.destroy();
    }
  });

  it.each(['synchronous', 'asynchronous'] as const)(
    'diagnoses %s archive preparation failure inside the session boundary',
    async (kind) => {
      const h = await harness('- [ ] Preparation failure\n');
      const failure = new Error('disk unavailable');
      const diagnostics = vi.fn<TaskDiagnosticSink>();
      const prepare =
        kind === 'synchronous'
          ? vi.fn(() => {
              throw failure;
            })
          : vi.fn().mockRejectedValue(failure);
      const provider = archiveProvider(
        vi.fn().mockResolvedValue({ destination: ARCHIVE, prepare }),
      );
      try {
        const session = await archiveApplication(h, provider, diagnostics).planArchive();
        if (session.type !== 'ready') throw new Error('archive session unavailable');

        await expect(session.execute(h.ref)).resolves.toEqual({
          type: 'io-error',
          cause: 'repository-error',
          contentState: 'unknown',
        });
        expect(diagnostics).toHaveBeenCalledWith(
          { operation: 'archive', phase: 'unexpected', cause: 'repository-error' },
          failure,
        );
      } finally {
        h.index.destroy();
      }
    },
  );

  it('diagnoses a prepared-session repository failure without claiming an archive', async () => {
    const h = await harness('- [ ] Repository failure\n');
    const failure = new Error('archive repository failed');
    const diagnostics = vi.fn<TaskDiagnosticSink>();
    const provider = archiveProvider(
      vi.fn().mockResolvedValue({
        destination: ARCHIVE,
        prepare: vi.fn().mockResolvedValue({ type: 'resolved', destination: ARCHIVE }),
      }),
    );
    vi.spyOn(h.repository, 'archive').mockRejectedValueOnce(failure);
    try {
      const session = await archiveApplication(h, provider, diagnostics).planArchive();
      if (session.type !== 'ready') throw new Error('archive session unavailable');

      await expect(session.execute(h.ref)).resolves.toEqual({
        type: 'io-error',
        cause: 'repository-error',
        contentState: 'unknown',
      });
      expect(diagnostics).toHaveBeenCalledWith(
        { operation: 'archive', phase: 'unexpected', cause: 'repository-error' },
        failure,
      );
      expect(await h.read('source.md')).toBe('- [ ] Repository failure\n');
    } finally {
      h.index.destroy();
    }
  });

  it.each([
    {
      name: 'no plan',
      createProvider: () => ({
        provider: archiveProvider(vi.fn().mockResolvedValue(undefined)),
        prepare: vi.fn(),
      }),
      expected: {
        type: 'invalid',
        issues: [{ code: 'destination-unavailable', field: 'destination' }],
      },
      prepareCalls: 0,
    },
    {
      name: 'advertised source collision',
      createProvider: () => {
        const prepare = vi.fn().mockResolvedValue({ type: 'resolved', destination: ARCHIVE });
        return {
          provider: archiveProvider(
            vi.fn().mockResolvedValue({
              destination: { filePath: 'SOURCE.md', insertion: { type: 'append' } },
              prepare,
            }),
          ),
          prepare,
        };
      },
      expected: {
        type: 'invalid',
        issues: [{ code: 'invalid-target', field: 'destination' }],
      },
      prepareCalls: 0,
    },
    {
      name: 'unavailable preparation',
      createProvider: () => {
        const prepare = vi.fn().mockResolvedValue({ type: 'unavailable' });
        return {
          provider: archiveProvider(vi.fn().mockResolvedValue({ destination: ARCHIVE, prepare })),
          prepare,
        };
      },
      expected: {
        type: 'invalid',
        issues: [{ code: 'destination-unavailable', field: 'destination' }],
      },
      prepareCalls: 1,
    },
    {
      name: 'prepared source collision',
      createProvider: () => {
        const prepare = vi.fn().mockResolvedValue({
          type: 'resolved',
          destination: { filePath: 'SOURCE.md', insertion: { type: 'append' } },
        });
        return {
          provider: archiveProvider(vi.fn().mockResolvedValue({ destination: ARCHIVE, prepare })),
          prepare,
        };
      },
      expected: {
        type: 'invalid',
        issues: [{ code: 'invalid-target', field: 'destination' }],
      },
      prepareCalls: 1,
    },
  ])(
    'rejects $name before archive repository I/O',
    async ({ createProvider, expected, prepareCalls }) => {
      const h = await harness('- [ ] Destination guard\n');
      const { provider, prepare } = createProvider();
      const archive = vi.spyOn(h.repository, 'archive');
      try {
        const application = archiveApplication(h, provider);

        await expect(application.execute({ type: 'archive', ref: h.ref })).resolves.toEqual(
          expected,
        );
        expect(archive).not.toHaveBeenCalled();
        expect(prepare).toHaveBeenCalledTimes(prepareCalls);
        expect(await h.read('source.md')).toBe('- [ ] Destination guard\n');
      } finally {
        h.index.destroy();
      }
    },
  );

  it('appends the complete owned root, leaves source delimiters, and never publishes the archive root', async () => {
    const block =
      '- [x] Root 🆔 root-id ⛔ other\n  - > Description\n  - 2026-09-19: comment\n  - [ ] Child\n';
    const source = `# Source\n%%\n${block}%%\n# End\n`;
    const h = await harness(source, '# Archive\n');

    const result = await h.repository.archive(h.ref, ARCHIVE);

    expect(result).toEqual({
      type: 'committed',
      changed: true,
      outcome: { type: 'archived', ref: h.ref, filePath: 'tasks/archive.md' },
    });
    expect(await h.read('tasks/archive.md')).toBe(`# Archive\n${block.trimEnd()}\n`);
    expect(await h.read('source.md')).toBe('# Source\n%%\n%%\n# End\n');
    expect(h.index.list().map((task) => task.title)).toEqual([]);
    expect(
      h.index.previewContent('tasks/archive.md', await h.read('tasks/archive.md')),
    ).toHaveLength(1);
    h.index.destroy();
  });

  it('retains tracked bytes through a partial archive and removes only public tracked totals', async () => {
    const block = [
      '- [ ] Tracked root #work',
      '  - [ ] Tracked child #work/child',
      '    - 2026-09-19T09:00:00+00:00 → 2026-09-19T09:15:00+00:00',
      '  - 2026-09-19T10:00:00+00:00 →',
      '',
    ].join('\n');
    const h = await harness(block, '# Archive\n');
    try {
      expect(h.index.activeEntries()).toHaveLength(1);
      expect(h.index.fileTotal('source.md')).toEqual({
        closedMs: 900_000,
        openStartsMs: [Date.parse('2026-09-19T10:00:00Z')],
      });
      const originalProcess = h.app.vault.process.bind(h.app.vault);
      vi.spyOn(h.app.vault, 'process')
        .mockImplementationOnce(originalProcess)
        .mockRejectedValueOnce(new Error('source write failed'))
        .mockImplementation(originalProcess);

      await expect(h.repository.archive(h.ref, ARCHIVE)).resolves.toMatchObject({
        type: 'partial',
        operation: 'archive',
      });
      expect(h.index.activeEntries()).toHaveLength(1);
      expect(h.index.fileTotal(ARCHIVE.filePath)).toEqual({ closedMs: 0, openStartsMs: [] });

      await expect(h.repository.archive(h.ref, ARCHIVE)).resolves.toMatchObject({
        type: 'committed',
        outcome: { type: 'archived' },
      });
      expect(await h.read(ARCHIVE.filePath)).toBe(`# Archive\n${block}`);
      expect(await h.read('source.md')).toBe('');
      expect(h.index.activeEntries()).toEqual([]);
      expect(
        h.index.entriesOverlapping(
          Date.parse('2026-09-19T00:00:00Z'),
          Date.parse('2026-09-20T00:00:00Z'),
        ),
      ).toEqual([]);
      expect(h.index.fileTotal('source.md')).toEqual({ closedMs: 0, openStartsMs: [] });
      const raw = expectDefined(
        h.index.previewContent(ARCHIVE.filePath, await h.read(ARCHIVE.filePath))[0],
      );
      expect(raw.timeEntries).toHaveLength(1);
      expect(expectDefined(raw.subtasks[0]).timeEntries).toHaveLength(1);
      expect(h.index.activeEntries()).toEqual([]);
    } finally {
      h.index.destroy();
    }
  });

  it('preserves CRLF owned bytes when the source has no final newline', async () => {
    const block = '- [ ] CRLF root\r\n  - [ ] nested';
    const h = await harness(block, '# Archive\r\n');

    await expect(h.repository.archive(h.ref, ARCHIVE)).resolves.toMatchObject({
      type: 'committed',
      outcome: { type: 'archived' },
    });

    expect(await h.read('source.md')).toBe('');
    expect(await h.read('tasks/archive.md')).toBe(`# Archive\r\n${block}\r\n`);
    h.index.destroy();
  });

  it('resumes a proven partial archive without appending a duplicate', async () => {
    const h = await harness('- [ ] Retry me\n', '# Archive\n');
    const originalProcess = h.app.vault.process.bind(h.app.vault);
    vi.spyOn(h.app.vault, 'process')
      .mockImplementationOnce(originalProcess)
      .mockRejectedValueOnce(new Error('source write failed'))
      .mockImplementation(originalProcess);

    await expect(h.repository.archive(h.ref, ARCHIVE)).resolves.toMatchObject({
      type: 'partial',
      operation: 'archive',
      recovery: { source: h.ref, targetPath: 'tasks/archive.md' },
    });
    await expect(h.repository.archive(h.ref, ARCHIVE)).resolves.toMatchObject({
      type: 'committed',
      outcome: { type: 'archived', ref: h.ref, filePath: 'tasks/archive.md' },
    });
    expect(await h.read('tasks/archive.md')).toBe('# Archive\n- [ ] Retry me\n');
    expect(await h.read('source.md')).toBe('');
    h.index.destroy();
  });

  it('leaves the source intact when the target write rejects before proof', async () => {
    const h = await harness('- [ ] Keep me\n', '# Archive\n');
    vi.spyOn(h.app.vault, 'process').mockRejectedValueOnce(new Error('target failed'));

    await expect(h.repository.archive(h.ref, ARCHIVE)).resolves.toMatchObject({
      type: 'io-error',
      path: 'tasks/archive.md',
      contentState: 'unknown',
    });
    expect(await h.read('source.md')).toBe('- [ ] Keep me\n');
    expect(await h.read('tasks/archive.md')).toBe('# Archive\n');
    h.index.destroy();
  });

  it('retains uncertain target ownership and retries without duplicating a completed write', async () => {
    const h = await harness('- [ ] Uncertain write\n', '# Archive\n');
    const originalProcess = h.app.vault.process.bind(h.app.vault);
    vi.spyOn(h.app.vault, 'process')
      .mockImplementationOnce(async (file, transform) => {
        await originalProcess(file, transform);
        throw new Error('target acknowledgement failed');
      })
      .mockImplementation(originalProcess);

    await expect(h.repository.archive(h.ref, ARCHIVE)).resolves.toMatchObject({
      type: 'partial',
      operation: 'archive',
      recovery: { cause: 'io-error' },
    });
    expect(await h.read('source.md')).toBe('- [ ] Uncertain write\n');
    expect(await h.read('tasks/archive.md')).toBe('# Archive\n- [ ] Uncertain write\n');

    await expect(h.repository.archive(h.ref, ARCHIVE)).resolves.toMatchObject({
      type: 'committed',
      outcome: { type: 'archived' },
    });
    expect(await h.read('source.md')).toBe('');
    expect(await h.read('tasks/archive.md')).toBe('# Archive\n- [ ] Uncertain write\n');
    h.index.destroy();
  });

  it('refuses recovery when the retained archive location has changed', async () => {
    const h = await harness('- [ ] Changed target\n', '# Archive\n');
    const originalProcess = h.app.vault.process.bind(h.app.vault);
    vi.spyOn(h.app.vault, 'process')
      .mockImplementationOnce(originalProcess)
      .mockRejectedValueOnce(new Error('source write failed'))
      .mockImplementation(originalProcess);
    await expect(h.repository.archive(h.ref, ARCHIVE)).resolves.toMatchObject({
      type: 'partial',
      operation: 'archive',
    });

    const target = h.app.vault.getAbstractFileByPath('tasks/archive.md');
    if (!(target instanceof TFile)) throw new Error('archive missing');
    await h.app.vault.modify(target, `# Changed\n${await h.read('tasks/archive.md')}`);

    await expect(h.repository.archive(h.ref, ARCHIVE)).resolves.toMatchObject({
      type: 'partial',
      operation: 'archive',
      recovery: { cause: 'conflict' },
    });
    expect(await h.read('source.md')).toBe('- [ ] Changed target\n');
    expect((await h.read('tasks/archive.md')).match(/Changed target/gu)).toHaveLength(1);
    h.index.destroy();
  });

  it('serializes concurrent attempts so one source root is appended once', async () => {
    const h = await harness('- [ ] Concurrent\n', '# Archive\n');

    const results = await Promise.all([
      h.repository.archive(h.ref, ARCHIVE),
      h.repository.archive(h.ref, ARCHIVE),
    ]);

    expect(results[0]).toMatchObject({ type: 'committed', outcome: { type: 'archived' } });
    expect(results[1]).toMatchObject({ type: 'not-found' });
    expect((await h.read('tasks/archive.md')).match(/Concurrent/gu)).toHaveLength(1);
    h.index.destroy();
  });

  it('blocks source removal when the indexed revision changes away and back during target I/O', async () => {
    const h = await harness('- [ ] ABA\n', '# Archive\n');
    const originalProcess = h.app.vault.process.bind(h.app.vault);
    vi.spyOn(h.app.vault, 'process').mockImplementation(async (file, transform) => {
      const result = await originalProcess(file, transform);
      if (file.path === 'tasks/archive.md') {
        h.index.installCommittedContent('source.md', '- [ ] changed\n');
        h.index.installCommittedContent('source.md', '- [ ] ABA\n');
      }
      return result;
    });

    await expect(h.repository.archive(h.ref, ARCHIVE)).resolves.toMatchObject({
      type: 'partial',
      operation: 'archive',
      recovery: { cause: 'conflict' },
    });
    expect(await h.read('source.md')).toBe('- [ ] ABA\n');
    expect((await h.read('tasks/archive.md')).match(/ABA/gu)).toHaveLength(1);
    h.index.destroy();
  });

  it('blocks source removal when a duplicate population appears during target I/O', async () => {
    const h = await harness('- [ ] Duplicate\n', '# Archive\n');
    const originalProcess = h.app.vault.process.bind(h.app.vault);
    vi.spyOn(h.app.vault, 'process').mockImplementation(async (file, transform) => {
      const result = await originalProcess(file, transform);
      if (file.path === 'tasks/archive.md') {
        const source = h.app.vault.getAbstractFileByPath('source.md');
        if (!(source instanceof TFile)) throw new Error('source missing');
        await h.app.vault.modify(source, '- [ ] Duplicate\n- [ ] Duplicate\n');
        h.index.installCommittedContent('source.md', '- [ ] Duplicate\n- [ ] Duplicate\n');
      }
      return result;
    });

    await expect(h.repository.archive(h.ref, ARCHIVE)).resolves.toMatchObject({
      type: 'partial',
      operation: 'archive',
      recovery: { cause: 'conflict' },
    });
    expect((await h.read('source.md')).match(/Duplicate/gu)).toHaveLength(2);
    expect((await h.read('tasks/archive.md')).match(/Duplicate/gu)).toHaveLength(1);
    h.index.destroy();
  });

  it('reports an unknown source-removal state when post-write readback also fails', async () => {
    const h = await harness('- [ ] Unknown removal\n', '# Archive\n');
    const originalProcess = h.app.vault.process.bind(h.app.vault);
    const read = vi.spyOn(h.app.vault, 'read');
    vi.spyOn(h.app.vault, 'process').mockImplementation(async (file, transform) => {
      const result = await originalProcess(file, transform);
      if (file.path === 'source.md') {
        read.mockRejectedValue(new Error('readback unavailable'));
        throw new Error('source acknowledgement failed');
      }
      return result;
    });

    await expect(h.repository.archive(h.ref, ARCHIVE)).resolves.toMatchObject({
      type: 'partial',
      operation: 'archive',
      recovery: { state: 'source-removal-unknown', cause: 'io-error' },
    });
    expect(await h.read('tasks/archive.md')).toBe('# Archive\n- [ ] Unknown removal\n');
    h.index.destroy();
  });

  it('proves the inserted occurrence rather than an older byte-identical archive root', async () => {
    const h = await harness('- [ ] Identical\n', '# Archive\n- [ ] Identical\n');
    const originalProcess = h.app.vault.process.bind(h.app.vault);
    vi.spyOn(h.app.vault, 'process')
      .mockImplementationOnce(originalProcess)
      .mockRejectedValueOnce(new Error('source write failed'))
      .mockImplementation(originalProcess);
    await expect(h.repository.archive(h.ref, ARCHIVE)).resolves.toMatchObject({
      type: 'partial',
      operation: 'archive',
    });
    expect((await h.read('tasks/archive.md')).match(/Identical/gu)).toHaveLength(2);
    const target = h.app.vault.getAbstractFileByPath('tasks/archive.md');
    if (!(target instanceof TFile)) throw new Error('archive missing');
    await h.app.vault.modify(target, '# Archive\n- [ ] Identical\n');
    expect(await h.read('tasks/archive.md')).toBe('# Archive\n- [ ] Identical\n');

    await expect(h.repository.archive(h.ref, ARCHIVE)).resolves.toMatchObject({
      type: 'committed',
      outcome: { type: 'archived' },
    });
    expect(await h.read('source.md')).toBe('');
    expect((await h.read('tasks/archive.md')).match(/Identical/gu)).toHaveLength(2);
    h.index.destroy();
  });

  it('archives two roots from one source through a single prepared application session', async () => {
    const h = await harness('- [ ] First\n- [ ] Second\n', '# Archive\n');
    const refs = h.index.list({ filePath: 'source.md' }).map((task) => task.ref);
    const prepare = vi.fn().mockResolvedValue({ type: 'resolved', destination: ARCHIVE });
    const destinationProvider = {
      planArchive: vi.fn().mockResolvedValue({ destination: ARCHIVE, prepare }),
    } as unknown as TaskDestinationProvider;
    const application = new TaskApplicationService(
      h.index,
      h.repository,
      new StatusCatalog(toStatusRules(DEFAULT_SETTINGS.taskStatuses)),
      { today: () => localDate('2026-09-19') },
      destinationProvider,
    );
    const session = await application.planArchive();
    if (session.type !== 'ready') throw new Error('archive unavailable');

    const results = [];
    for (const ref of refs) results.push(await session.execute(ref));

    expect(results).toHaveLength(2);
    expect(results.every((result) => result.type === 'ok')).toBe(true);
    expect(prepare).toHaveBeenCalledOnce();
    expect(await h.read('source.md')).toBe('');
    expect(await h.read('tasks/archive.md')).toBe('# Archive\n- [ ] First\n- [ ] Second\n');
    h.index.destroy();
  });

  it('keeps partial archive ownership when application rebasing moves the source line', async () => {
    const h = await harness('- [ ] Top\n- [ ] Bottom\n', '# Archive\n');
    const [top, bottom] = h.index.list({ filePath: 'source.md' }).map((task) => task.ref);
    const destinationProvider = {
      planArchive: vi.fn().mockResolvedValue({
        destination: ARCHIVE,
        prepare: vi.fn().mockResolvedValue({ type: 'resolved', destination: ARCHIVE }),
      }),
    } as unknown as TaskDestinationProvider;
    const application = new TaskApplicationService(
      h.index,
      h.repository,
      new StatusCatalog(toStatusRules(DEFAULT_SETTINGS.taskStatuses)),
      { today: () => localDate('2026-09-19') },
      destinationProvider,
    );
    const originalProcess = h.app.vault.process.bind(h.app.vault);
    vi.spyOn(h.app.vault, 'process')
      .mockImplementationOnce(originalProcess)
      .mockRejectedValueOnce(new Error('bottom source write failed'))
      .mockImplementation(originalProcess);

    const partial = await application.execute({ type: 'archive', ref: expectDefined(bottom) });
    expect(partial).toMatchObject({ type: 'partial', operation: 'archive' });
    await expect(
      application.execute({ type: 'archive', ref: expectDefined(top) }),
    ).resolves.toMatchObject({ type: 'ok', outcome: { type: 'archived' } });
    if (partial.type !== 'partial' || partial.operation !== 'archive') {
      throw new Error('missing archive recovery');
    }
    await expect(
      application.execute({ type: 'archive', ref: partial.recovery.source }),
    ).resolves.toMatchObject({
      type: 'partial',
      operation: 'archive',
      recovery: { cause: 'conflict', source: partial.recovery.source },
    });
    const reselected = expectDefined(h.index.list({ filePath: 'source.md' })[0]).ref;
    expect(reselected.line).toBe(0);
    await expect(application.execute({ type: 'archive', ref: reselected })).resolves.toMatchObject({
      type: 'partial',
      operation: 'archive',
      recovery: { cause: 'conflict', source: partial.recovery.source },
    });

    const modal = new TaskArchiveRecoveryModal(h.app, application, partial.recovery);
    modal.onOpen();
    const retry = [...modal.contentEl.querySelectorAll('button')].find(
      (button) => button.textContent === 'Verify and retry',
    );
    if (!(retry instanceof HTMLButtonElement)) throw new Error('missing archive retry');
    retry.click();
    await flushMicrotasks(30);

    expect(modal.contentEl.textContent).toContain('Task was not archived');
    expect(await h.read('source.md')).toBe('- [ ] Bottom\n');
    expect((await h.read('tasks/archive.md')).match(/Bottom/gu)).toHaveLength(1);
    expect((await h.read('tasks/archive.md')).match(/Top/gu)).toHaveLength(1);
    modal.onClose();
    h.index.destroy();
  });

  it('rejects raw-identical source text from a different authority occurrence', async () => {
    const h = await harness('- [ ] Identical\n', '# Archive\n');
    const destinationProvider = {
      planArchive: vi.fn().mockResolvedValue({
        destination: ARCHIVE,
        prepare: vi.fn().mockResolvedValue({ type: 'resolved', destination: ARCHIVE }),
      }),
    } as unknown as TaskDestinationProvider;
    const application = new TaskApplicationService(
      h.index,
      h.repository,
      new StatusCatalog(toStatusRules(DEFAULT_SETTINGS.taskStatuses)),
      { today: () => localDate('2026-09-19') },
      destinationProvider,
    );
    const originalProcess = h.app.vault.process.bind(h.app.vault);
    vi.spyOn(h.app.vault, 'process')
      .mockImplementationOnce(originalProcess)
      .mockRejectedValueOnce(new Error('source write failed'))
      .mockImplementation(originalProcess);

    const partial = await application.execute({ type: 'archive', ref: h.ref });
    expect(partial).toMatchObject({ type: 'partial', operation: 'archive' });
    const source = h.app.vault.getAbstractFileByPath('source.md');
    if (!(source instanceof TFile)) throw new Error('source missing');
    await h.app.vault.modify(source, '');
    h.index.installCommittedContent('source.md', '');
    await h.app.vault.modify(source, '- [ ] Identical\n');
    const replacement = expectDefined(
      h.index.installCommittedContent('source.md', '- [ ] Identical\n')[0],
    );
    expect(replacement.ref.revision).not.toBe(h.ref.revision);

    await expect(application.execute({ type: 'archive', ref: replacement.ref })).resolves.toEqual({
      type: 'io-error',
      cause: 'archive-recovery-ambiguous',
      path: 'tasks/archive.md',
      contentState: 'unchanged',
    });
    expect(await h.read('source.md')).toBe('- [ ] Identical\n');
    expect((await h.read('tasks/archive.md')).match(/Identical/gu)).toHaveLength(1);
    h.index.destroy();
  });

  it('rejects new writes when retained recovery ownership reaches its bound', async () => {
    const files: Record<string, string> = { 'tasks/archive.md': '# Archive\n' };
    for (let index = 0; index < 65; index += 1) {
      files[`source-${index}.md`] = `- [ ] Pending ${index}\n`;
    }
    const app = await createAppWithFiles(files);
    const statusCatalog = new StatusCatalog(toStatusRules(DEFAULT_SETTINGS.taskStatuses));
    const authority = new TaskRefAuthority('archive-capacity');
    const index = new TaskIndex(app, {
      statusCatalog,

      refAuthority: authority,
      excludeSource: ({ filePath }) => filePath === 'tasks/archive.md',
    });
    await index.initialize();
    const repository = new ObsidianTaskRepository(app, {
      codec: new TaskMarkdownCodec(statusCatalog),
      editor: new TaskBlockEditor(),
      locator: new TaskLocator(authority),
      snapshotsFromContent: (path, content) => index.snapshotsFromContent(path, content),
      refAuthority: authority,
      snapshotState: index,
    });
    const originalProcess = app.vault.process.bind(app.vault);
    vi.spyOn(app.vault, 'process').mockImplementation(async (file, transform) => {
      if (file.path !== 'tasks/archive.md') throw new Error('source write failed');
      return await originalProcess(file, transform);
    });
    const refs = Array.from(
      { length: 65 },
      (_, fileIndex) => expectDefined(index.list({ filePath: `source-${fileIndex}.md` })[0]).ref,
    );

    for (const ref of refs.slice(0, 64)) {
      await expect(repository.archive(ref, ARCHIVE)).resolves.toMatchObject({
        type: 'partial',
        operation: 'archive',
      });
    }
    const archiveFile = app.vault.getAbstractFileByPath('tasks/archive.md');
    if (!(archiveFile instanceof TFile)) throw new Error('archive missing');
    const before = await app.vault.cachedRead(archiveFile);
    await expect(repository.archive(expectDefined(refs[64]), ARCHIVE)).resolves.toEqual({
      type: 'io-error',
      cause: 'archive-recovery-capacity',
      path: 'tasks/archive.md',
      contentState: 'unchanged',
    });
    expect(await app.vault.cachedRead(archiveFile)).toBe(before);
    await expect(repository.archive(expectDefined(refs[0]), ARCHIVE)).resolves.toMatchObject({
      type: 'partial',
      operation: 'archive',
    });
    expect(before.match(/Pending/gu) ?? []).toHaveLength(64);
    index.destroy();
  });

  it('rejects source/archive collisions without writing', async () => {
    const h = await harness('- [ ] Keep me\n');

    await expect(
      h.repository.archive(h.ref, {
        filePath: 'source.md',
        insertion: { type: 'append' },
      }),
    ).resolves.toEqual({
      type: 'invalid',
      issues: [{ code: 'invalid-target', field: 'destination' }],
    });
    expect(await h.read('source.md')).toBe('- [ ] Keep me\n');
    h.index.destroy();
  });
});
