import { TFile, type App } from 'obsidian';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '../../src/settings/defaults';
import { toStatusRules } from '../../src/settings/statusCatalogAdapter';
import type { TaskRepository } from '../../src/tasks/application/TaskRepository';
import { StatusCatalog } from '../../src/tasks/domain/StatusCatalog';
import type { TaskDestination, TaskRef, TaskSnapshot } from '../../src/tasks/domain/types';
import { TaskIndex } from '../../src/tasks/infrastructure/TaskIndex';
import { TaskBlockEditor } from '../../src/tasks/infrastructure/markdown/TaskBlockEditor';
import { TaskLocator } from '../../src/tasks/infrastructure/markdown/TaskLocator';
import { TaskMarkdownCodec } from '../../src/tasks/infrastructure/markdown/TaskMarkdownCodec';
import { ObsidianTaskRepository } from '../../src/tasks/infrastructure/obsidian/ObsidianTaskRepository';
import { createAppWithFiles } from '../helpers';
import { InMemoryTaskRepository } from '../support/InMemoryTaskRepository';
import { expectDefined } from './../helpers';

type Adapter = 'in-memory' | 'obsidian';

interface Harness {
  readonly app: App;
  readonly repository: TaskRepository;
  readonly snapshots: (path: string, content: string) => readonly TaskSnapshot[];
  readonly read: (path: string) => Promise<string>;
}

async function harness(
  adapter: Adapter,
  source: string,
  target: string,
  snapshotsOverride?: (path: string, content: string) => readonly TaskSnapshot[],
): Promise<Harness> {
  const files = { 'source.md': source, 'target.md': target };
  const app = await createAppWithFiles(files);
  const statusCatalog = new StatusCatalog(toStatusRules(DEFAULT_SETTINGS.taskStatuses));
  const codec = new TaskMarkdownCodec(statusCatalog);
  const index = new TaskIndex(app, {
    statusCatalog,
    dailyNoteFormat: DEFAULT_SETTINGS.desktop.dailyNoteFormat,
  });
  const snapshots = (path: string, content: string) =>
    snapshotsOverride?.(path, content) ?? index.snapshotsFromContent(path, content);
  if (adapter === 'in-memory') {
    const repository = new InMemoryTaskRepository({
      files,
      codec,
      snapshotsFromContent: snapshots,
    });
    return {
      app,
      repository,
      snapshots,
      read: async (path) => repository.content(path) ?? '',
    };
  }
  const repository = new ObsidianTaskRepository(app, {
    codec,
    editor: new TaskBlockEditor(),
    locator: new TaskLocator(),
    snapshotsFromContent: snapshots,
  });
  return {
    app,
    repository,
    snapshots,
    read: async (path) => {
      const file = app.vault.getAbstractFileByPath(path);
      if (!(file instanceof TFile)) throw new Error(`missing ${path}`);
      return app.vault.cachedRead(file);
    },
  };
}

function sourceRef(h: Harness, source: string, line = 0): TaskRef {
  const task = h.snapshots('source.md', source).find((candidate) => candidate.source.line === line);
  if (task == null) throw new Error(`missing source task at line ${line}`);
  return task.ref;
}

function destination(
  insertion: TaskDestination['insertion'] = { type: 'append' },
): TaskDestination {
  return { filePath: 'target.md', insertion };
}

for (const adapter of ['in-memory', 'obsidian'] as const) {
  describe(`${adapter} move repository contract`, () => {
    it('returns a same-path no-op without changing content', async () => {
      const source = '- [ ] task\n';
      const h = await harness(adapter, source, '- [ ] target\n');

      const result = await h.repository.move(sourceRef(h, source), {
        filePath: 'source.md',
        insertion: { type: 'append' },
      });

      expect(result).toMatchObject({
        type: 'committed',
        changed: false,
        outcome: { type: 'task', task: { source: { filePath: 'source.md', line: 0 } } },
      });
      expect(await h.read('source.md')).toBe(source);
    });

    it.each([
      {
        name: 'LF source into final-newline LF target',
        source:
          '- [ ] root 🆔 portable-id ⛔ blocked-by\n  - > description\n  - 2026-07-14: comment\n  - [ ] child\n    - [ ] nested\n- [ ] keep\n',
        target: '# Target\n',
        expectedTarget:
          '# Target\n- [ ] root 🆔 portable-id ⛔ blocked-by\n  - > description\n  - 2026-07-14: comment\n  - [ ] child\n    - [ ] nested\n',
        expectedSource: '- [ ] keep\n',
      },
      {
        name: 'CRLF block into non-final-newline LF target',
        source:
          '> - [ ] quoted 🆔 keep-id ⛔ dep\r\n> \t- > details\r\n> \t- [ ] child\r\n- [ ] keep',
        target: '# Target',
        expectedTarget:
          '# Target\n> - [ ] quoted 🆔 keep-id ⛔ dep\r\n> \t- > details\r\n> \t- [ ] child',
        expectedSource: '- [ ] keep',
      },
      {
        name: 'non-final-newline LF block into final-newline CRLF target',
        source: '- [ ] root\n  - > details\n- [ ] keep',
        target: '# Target\r\n',
        expectedTarget: '# Target\r\n- [ ] root\n  - > details\r\n',
        expectedSource: '- [ ] keep',
      },
      {
        name: 'final-newline CRLF block into non-final-newline CRLF target',
        source: '- [ ] root\r\n  - > details\r\n- [ ] keep\r\n',
        target: '# Target\r\nbody',
        expectedTarget: '# Target\r\nbody\r\n- [ ] root\r\n  - > details',
        expectedSource: '- [ ] keep\r\n',
      },
    ])('moves the complete exact block byte-for-byte for $name', async (fixture) => {
      const h = await harness(adapter, fixture.source, fixture.target);

      const result = await h.repository.move(sourceRef(h, fixture.source), destination());

      expect(result).toMatchObject({
        type: 'committed',
        changed: true,
        outcome: { type: 'task', task: { source: { filePath: 'target.md' } } },
      });
      expect(await h.read('target.md')).toBe(fixture.expectedTarget);
      expect(await h.read('source.md')).toBe(fixture.expectedSource);
    });

    it('uses the known section insertion offset when an identical target task already exists', async () => {
      const source = '- [ ] duplicate 🆔 same-id\n';
      const target = '# Project\n## Tasks\n- [ ] duplicate 🆔 same-id\n';
      const h = await harness(adapter, source, target);

      const result = await h.repository.move(
        sourceRef(h, source),
        destination({ type: 'section', heading: '## Tasks' }),
      );

      expect(await h.read('target.md')).toBe(
        '# Project\n## Tasks\n- [ ] duplicate 🆔 same-id\n- [ ] duplicate 🆔 same-id\n',
      );
      expect(result).toMatchObject({
        type: 'committed',
        outcome: { type: 'task', task: { source: { filePath: 'target.md', line: 2 } } },
      });
    });

    it.each([
      {
        name: 'creates a missing section with target-native boundaries',
        insertion: { type: 'section' as const, heading: '## Tasks' },
        expected: '# Project\r\nbody\r\n\r\n## Tasks\r\n- [ ] task',
      },
      {
        name: 'treats a blank section heading as append',
        insertion: { type: 'section' as const, heading: '   ' },
        expected: '# Project\r\nbody\r\n- [ ] task',
      },
    ])('$name', async ({ insertion, expected }) => {
      const source = '- [ ] task\n';
      const h = await harness(adapter, source, '# Project\r\nbody');

      const result = await h.repository.move(sourceRef(h, source), destination(insertion));

      expect(result).toMatchObject({ type: 'committed', changed: true });
      expect(await h.read('target.md')).toBe(expected);
      expect(await h.read('source.md')).toBe('');
    });
  });
}

describe('Obsidian move failure state machine', () => {
  it('returns destination-unavailable before target commit and leaves the source intact', async () => {
    const source = '- [ ] task\n';
    const h = await harness('obsidian', source, '# Target\n');

    await expect(
      h.repository.move(sourceRef(h, source), {
        filePath: 'missing.md',
        insertion: { type: 'append' },
      }),
    ).resolves.toEqual({
      type: 'invalid',
      issues: [{ code: 'destination-unavailable', field: 'destination' }],
    });
    expect(await h.read('source.md')).toBe(source);
  });

  it.each([
    ['not-found', '# unrelated\n', { type: 'not-found' }],
    ['conflict', '- [ ] changed\n', { type: 'conflict' }],
    ['ambiguous', '- [ ] task\n- [ ] task\n', { type: 'ambiguous' }],
  ] as const)(
    'leaves both files unchanged for a pre-target %s source result',
    async (_, live, expected) => {
      const original = '- [ ] task\n';
      const h = await harness('obsidian', original, '# Target\n');
      const ref = sourceRef(h, original);
      const file = h.app.vault.getAbstractFileByPath('source.md');
      if (!(file instanceof TFile)) throw new Error('missing source');
      await h.app.vault.modify(file, live);

      await expect(h.repository.move(ref, destination())).resolves.toMatchObject(expected);
      expect(await h.read('source.md')).toBe(live);
      expect(await h.read('target.md')).toBe('# Target\n');
    },
  );

  it('returns ordinary invalid when target validation fails and never removes the source', async () => {
    const source = '- [ ] task\n';
    const normalSnapshots = {
      current: undefined as
        ((path: string, content: string) => readonly TaskSnapshot[]) | undefined,
    };
    const h = await harness('obsidian', source, '# Target\n', (path, content) =>
      path === 'target.md' ? [] : (normalSnapshots.current?.(path, content) ?? []),
    );
    normalSnapshots.current = (path, content) => {
      const catalog = new StatusCatalog(toStatusRules(DEFAULT_SETTINGS.taskStatuses));
      const appIndex = new TaskIndex(h.app, {
        statusCatalog: catalog,
        dailyNoteFormat: DEFAULT_SETTINGS.desktop.dailyNoteFormat,
      });
      return appIndex.snapshotsFromContent(path, content);
    };
    const ref = expectDefined(normalSnapshots.current('source.md', source)[0]).ref;

    await expect(h.repository.move(ref, destination())).resolves.toEqual({
      type: 'invalid',
      issues: [{ code: 'invalid-task-syntax' }],
    });
    expect(await h.read('source.md')).toBe(source);
    expect(await h.read('target.md')).toBe('# Target\n');
  });

  it('returns target io-error with unknown commit state and leaves the source intact', async () => {
    const source = '- [ ] task\n';
    const h = await harness('obsidian', source, '# Target\n');
    vi.spyOn(h.app.vault, 'process').mockRejectedValueOnce(new Error('target failed'));

    await expect(h.repository.move(sourceRef(h, source), destination())).resolves.toEqual({
      type: 'io-error',
      cause: 'process-error',
      path: 'target.md',
      contentState: 'unknown',
    });
    expect(await h.read('source.md')).toBe(source);
  });

  it.each([
    ['conflict', '- [ ] changed\n', 'conflict'],
    ['not-found', '# removed\n', 'not-found'],
    ['ambiguous', '- [ ] task\n- [ ] task\n', 'ambiguous'],
  ] as const)(
    'returns typed partial/%s after the confirmed target copy and never guesses',
    async (_name, changedSource, cause) => {
      const source = '- [ ] task\n';
      const h = await harness('obsidian', source, '# Target\n');
      const ref = sourceRef(h, source);
      const sourceFile = h.app.vault.getAbstractFileByPath('source.md');
      if (!(sourceFile instanceof TFile)) throw new Error('missing source');
      const originalProcess = h.app.vault.process.bind(h.app.vault);
      const process = vi.spyOn(h.app.vault, 'process');
      let calls = 0;
      process.mockImplementation(async (file, transform, options) => {
        calls++;
        if (calls === 2) await h.app.vault.modify(sourceFile, changedSource);
        return originalProcess(file, transform, options);
      });

      const result = await h.repository.move(ref, destination());

      expect(result).toMatchObject({
        type: 'partial',
        operation: 'move',
        recovery: {
          source: ref,
          targetPath: 'target.md',
          copiedTask: { source: { filePath: 'target.md', line: 1 } },
          state: 'target-copied-source-remains',
          cause,
        },
      });
      expect(await h.read('source.md')).toBe(changedSource);
      expect(await h.read('target.md')).toBe('# Target\n- [ ] task\n');
    },
  );

  it('returns partial/io-error when source removal rejects after target commit', async () => {
    const source = '- [ ] task\n';
    const h = await harness('obsidian', source, '# Target\n');
    vi.spyOn(h.app.vault, 'process')
      .mockImplementationOnce(async (file, transform) => {
        const current = await h.app.vault.cachedRead(file);
        const next = transform(current);
        await h.app.vault.modify(file, next);
        return next;
      })
      .mockRejectedValueOnce(new Error('source failed'));

    await expect(h.repository.move(sourceRef(h, source), destination())).resolves.toMatchObject({
      type: 'partial',
      operation: 'move',
      recovery: { cause: 'io-error', state: 'target-copied-source-remains' },
    });
    expect(await h.read('source.md')).toBe(source);
    expect(await h.read('target.md')).toBe('# Target\n- [ ] task\n');
  });

  it('returns partial/io-error when source transform runs but its process promise rejects', async () => {
    const source = '- [ ] task\n';
    const h = await harness('obsidian', source, '# Target\n');
    vi.spyOn(h.app.vault, 'process')
      .mockImplementationOnce(async (file, transform) => {
        const current = await h.app.vault.cachedRead(file);
        const next = transform(current);
        await h.app.vault.modify(file, next);
        return next;
      })
      .mockImplementationOnce(async (file, transform) => {
        transform(await h.app.vault.cachedRead(file));
        throw new Error('source rejected after transform');
      });

    await expect(h.repository.move(sourceRef(h, source), destination())).resolves.toMatchObject({
      type: 'partial',
      operation: 'move',
      recovery: { cause: 'io-error', state: 'target-copied-source-remains' },
    });
    expect(await h.read('source.md')).toBe(source);
    expect(await h.read('target.md')).toBe('# Target\n- [ ] task\n');
  });

  it('re-resolves the original path and returns partial when the source is renamed after target commit', async () => {
    const source = '- [ ] task\n';
    const h = await harness('obsidian', source, '# Target\n');
    const sourceFile = h.app.vault.getAbstractFileByPath('source.md');
    if (!(sourceFile instanceof TFile)) throw new Error('missing source');
    const originalProcess = h.app.vault.process.bind(h.app.vault);
    let calls = 0;
    vi.spyOn(h.app.vault, 'process').mockImplementation(async (file, transform, options) => {
      const result = await originalProcess(file, transform, options);
      calls++;
      if (calls === 1) await h.app.vault.rename(sourceFile, 'renamed.md');
      return result;
    });

    const result = await h.repository.move(sourceRef(h, source), destination());

    expect(result).toMatchObject({
      type: 'partial',
      operation: 'move',
      recovery: { cause: 'not-found', source: { filePath: 'source.md' } },
    });
    expect(await h.read('renamed.md')).toBe(source);
    expect(await h.read('target.md')).toBe('# Target\n- [ ] task\n');
  });

  it('re-resolves the original path and returns partial when the source is deleted after target commit', async () => {
    const source = '- [ ] task\n';
    const h = await harness('obsidian', source, '# Target\n');
    const sourceFile = h.app.vault.getAbstractFileByPath('source.md');
    if (!(sourceFile instanceof TFile)) throw new Error('missing source');
    const originalProcess = h.app.vault.process.bind(h.app.vault);
    let calls = 0;
    vi.spyOn(h.app.vault, 'process').mockImplementation(async (file, transform, options) => {
      const result = await originalProcess(file, transform, options);
      calls++;
      if (calls === 1) await h.app.fileManager.trashFile(sourceFile);
      return result;
    });

    const result = await h.repository.move(sourceRef(h, source), destination());

    expect(result).toMatchObject({
      type: 'partial',
      operation: 'move',
      recovery: { cause: 'not-found', source: { filePath: 'source.md' } },
    });
    expect(h.app.vault.getAbstractFileByPath('source.md')).toBeNull();
    expect(await h.read('target.md')).toBe('# Target\n- [ ] task\n');
  });
});
