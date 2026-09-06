import { TFile } from 'obsidian';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TaskCommand } from '../src/tasks';
import { TaskApplicationService } from '../src/tasks/application/TaskApplicationService';
import {
  TaskDependencyService,
  nextTaskDependencyId,
  type TaskDiagnosticSink,
} from '../src/tasks/application/TaskDependencyService';
import { localDate } from '../src/tasks/domain/validation';
import { TaskIndex } from '../src/tasks/infrastructure/TaskIndex';
import { TaskRefAuthority } from '../src/tasks/infrastructure/TaskRefAuthority';
import { TaskBlockEditor } from '../src/tasks/infrastructure/markdown/TaskBlockEditor';
import { TaskLocator } from '../src/tasks/infrastructure/markdown/TaskLocator';
import { TaskMarkdownCodec } from '../src/tasks/infrastructure/markdown/TaskMarkdownCodec';
import { ObsidianTaskRepository } from '../src/tasks/infrastructure/obsidian/ObsidianTaskRepository';
import {
  canonicalStatusCatalog,
  createAppWithFiles,
  deferred,
  expectDefined,
  flushMicrotasks,
} from './helpers';

const indexes: TaskIndex[] = [];
type ReverseDependencyCommand = Extract<TaskCommand, { readonly type: 'reverse-dependency' }>;
afterEach(() => {
  for (const index of indexes.splice(0)) index.destroy();
});

async function harness(files: Record<string, string>, writable = true) {
  const app = await createAppWithFiles(files);
  const statuses = canonicalStatusCatalog();
  const authority = new TaskRefAuthority('reversal');
  const index = new TaskIndex(app, {
    statusCatalog: statuses,
    dailyNoteFormat: 'YYYY-MM-DD',
    refAuthority: authority,
  });
  indexes.push(index);
  await index.initialize();
  for (const [path, content] of Object.entries(files)) index.installCommittedContent(path, content);
  const codec = new TaskMarkdownCodec(statuses);
  const repository = new ObsidianTaskRepository(app, {
    codec,
    editor: new TaskBlockEditor(),
    locator: new TaskLocator(authority),
    snapshotsFromContent: (path, content) => index.snapshotsFromContent(path, content),
    ...(writable ? { refAuthority: authority, snapshotState: index } : {}),
  });
  const diagnostics = vi.fn<TaskDiagnosticSink>();
  const dependencies = new TaskDependencyService(
    index,
    repository,
    nextTaskDependencyId,
    diagnostics,
  );
  const application = new TaskApplicationService(
    index,
    repository,
    statuses,
    { today: () => localDate('2026-09-06') },
    undefined,
    undefined,
    dependencies,
    diagnostics,
  );
  const node = (title: string) =>
    expectDefined(
      index.listNodes().find((entry) => entry.node.title === title),
      `Missing ${title}: ${index
        .listNodes()
        .map((entry) => entry.node.title)
        .join(', ')}`,
    );
  const file = (path: string) => {
    const entry = app.vault.getAbstractFileByPath(path);
    if (!(entry instanceof TFile)) throw new Error('missing fixture');
    return entry;
  };
  const command = (
    blocker = 'A',
    dependent = 'B',
    dependencyId = 'a',
  ): ReverseDependencyCommand => ({
    type: 'reverse-dependency',
    blocker: node(blocker).target,
    dependent: node(dependent).target,
    dependencyId,
  });
  const read = app.vault.read.bind(app.vault);
  const contents = async (): Promise<Record<string, string>> =>
    Object.fromEntries(
      await Promise.all(
        Object.keys(files).map(async (path): Promise<[string, string]> => [
          path,
          await read(file(path)),
        ]),
      ),
    );
  return {
    app,
    authority,
    index,
    codec,
    repository,
    diagnostics,
    dependencies,
    application,
    node,
    file,
    command,
    contents,
  };
}

describe('public dependency reversal', () => {
  it.each(['', 'invalid ID'])('rejects malformed dependency ID %j without writing', async (id) => {
    const source = '- [ ] A 🆔 a\n- [ ] B 🆔 b ⛔ a\n';
    const h = await harness({ 'tasks.md': source });
    const process = vi.spyOn(h.app.vault, 'process');
    expect(await h.application.execute(h.command('A', 'B', id))).toEqual({
      type: 'invalid',
      issues: [{ code: 'invalid-target', field: 'dependency-id' }],
    });
    expect(process).not.toHaveBeenCalled();
    expect(await h.contents()).toEqual({ 'tasks.md': source });
  });

  it('rejects a missing original blocker without touching its remaining dependent', async () => {
    const h = await harness({ 'tasks.md': '- [ ] A 🆔 a\n- [ ] B 🆔 b ⛔ a\n' });
    const command = h.command();
    const source = '- [ ] B 🆔 b ⛔ a\n';
    await h.app.vault.modify(h.file('tasks.md'), source);
    h.index.installCommittedContent('tasks.md', source);
    const process = vi.spyOn(h.app.vault, 'process');
    expect(await h.application.execute(command)).toEqual({
      type: 'not-found',
      target: command.blocker,
    });
    expect(process).not.toHaveBeenCalled();
    expect(await h.contents()).toEqual({ 'tasks.md': source });
  });

  it('keeps exact source when the repository does not provide atomic reversal', async () => {
    const source = '- [ ] A 🆔 a\n- [ ] B 🆔 b ⛔ a\n';
    const h = await harness({ 'tasks.md': source });
    Object.defineProperty(h.repository, 'reverseDependency', { value: undefined });
    const process = vi.spyOn(h.app.vault, 'process');
    expect(await h.application.execute(h.command())).toEqual({
      type: 'invalid',
      issues: [{ code: 'invalid-target', field: 'dependency-write' }],
    });
    expect(process).not.toHaveBeenCalled();
    expect(await h.contents()).toEqual({ 'tasks.md': source });
  });

  it('keeps the original edge when no valid new blocker ID can be allocated', async () => {
    const source = '- [ ] A 🆔 a\n- [ ] B ⛔ a\n';
    const h = await harness({ 'tasks.md': source });
    const service = new TaskDependencyService(
      h.index,
      h.repository,
      () => 'invalid!',
      h.diagnostics,
    );
    const process = vi.spyOn(h.app.vault, 'process');
    expect(await service.execute(h.command())).toEqual({
      type: 'invalid',
      issues: [{ code: 'invalid-target', field: 'dependency-id' }],
    });
    expect(process).not.toHaveBeenCalled();
    expect(await h.contents()).toEqual({ 'tasks.md': source });
  });

  it.each(['unavailable', 'stale', 'nonwritable'] as const)(
    'does not write %s endpoints',
    async (fault) => {
      const source = '- [ ] A 🆔 a\n  - [ ] B 🆔 b ⛔ a\n';
      const h = await harness({ 'tasks.md': source }, fault !== 'nonwritable');
      const command = h.command();
      let current = source;
      if (fault === 'unavailable') current = '- [ ] A 🆔 a\n';
      if (fault === 'stale') current = source.replace('B 🆔', 'Changed 🆔');
      await h.app.vault.modify(h.file('tasks.md'), current);
      h.index.installCommittedContent('tasks.md', current);
      expect((await h.application.execute(command)).type).not.toBe('ok');
      expect(await h.contents()).toEqual({ 'tasks.md': current });
    },
  );

  it.each(['false', 'throw'] as const)(
    'keeps a same-file candidate unpublished when its proof returns %s',
    async (fault) => {
      const source = '- [ ] A 🆔 a\n- [ ] B 🆔 b ⛔ a\n';
      const h = await harness({ 'tasks.md': source });
      const reverse = h.repository.reverseDependency.bind(h.repository);
      vi.spyOn(h.repository, 'reverseDependency').mockImplementation((request) =>
        reverse({
          ...request,
          proveReversal: () => {
            if (fault === 'throw') throw new Error('proof rejected');
            return undefined;
          },
        }),
      );
      expect(await h.application.execute(h.command())).toMatchObject({
        type: 'io-error',
        contentState: 'unchanged',
      });
      expect(await h.contents()).toEqual({ 'tasks.md': source });
    },
  );
  it.each([' ', 'x'])(
    'reverses the identified edge in both directions for status %s',
    async (symbol) => {
      const h = await harness({ 'tasks.md': `- [${symbol}] A 🆔 a\n- [${symbol}] B 🆔 b ⛔ a\n` });
      const process = vi.spyOn(h.app.vault, 'process');
      const first = await h.application.execute(h.command());
      expect(first).toMatchObject({
        type: 'ok',
        changed: true,
        outcome: {
          type: 'dependency',
          change: 'reversed',
          dependencyId: 'b',
          blocker: { root: { title: 'B', dependsOn: [] } },
          dependent: { root: { title: 'A', dependsOn: ['b'] } },
        },
      });
      expect(await h.contents()).toEqual({
        'tasks.md': `- [${symbol}] A 🆔 a ⛔ b\n- [${symbol}] B 🆔 b\n`,
      });
      expect(process).toHaveBeenCalledOnce();
      expect(process.mock.calls[0]?.[1].constructor.name).not.toBe('AsyncFunction');
      expect(await h.application.execute(h.command('B', 'A', 'b'))).toMatchObject({ type: 'ok' });
      expect(await h.contents()).toEqual({
        'tasks.md': `- [${symbol}] A 🆔 a\n- [${symbol}] B 🆔 b ⛔ a\n`,
      });
    },
  );

  it('allocates only the new blocker ID, preserves unrelated CRLF bytes and repeated remaining declarations', async () => {
    const h = await harness({
      'tasks.md':
        '---\r\nkind: test\r\n---\r\n- [ ] A 🆔 a\r\n  - [ ] B ⛔ spare, a, spare, a\r\n\r\ntext',
    });
    expect(await h.application.execute(h.command())).toMatchObject({ type: 'ok' });
    expect(await h.contents()).toEqual({
      'tasks.md':
        '---\r\nkind: test\r\n---\r\n- [ ] A 🆔 a ⛔ 00000000\r\n  - [ ] B 🆔 00000000 ⛔ spare, spare\r\n\r\ntext',
    });
    expect(h.index.dependencies(h.node('A').target).blockedBy).toMatchObject([
      { type: 'resolved', task: { node: { title: 'B' } } },
    ]);
  });

  it.each([
    { name: 'self', source: '- [ ] A 🆔 a ⛔ a\n', dependent: 'A', id: 'a' },
    { name: 'wrong ID', source: '- [ ] A 🆔 a\n- [ ] B 🆔 b ⛔ a\n', dependent: 'B', id: 'wrong' },
    { name: 'absent edge', source: '- [ ] A 🆔 a\n- [ ] B 🆔 b\n', dependent: 'B', id: 'a' },
    {
      name: 'existing reverse edge',
      source: '- [ ] A 🆔 a ⛔ b\n- [ ] B 🆔 b ⛔ a\n',
      dependent: 'B',
      id: 'a',
    },
    {
      name: 'alternate cycle path',
      source: '- [ ] A 🆔 a\n- [ ] B 🆔 b ⛔ a, c\n- [ ] C 🆔 c ⛔ a\n',
      dependent: 'B',
      id: 'a',
    },
    {
      name: 'ambiguous original ID',
      source: '- [ ] A 🆔 a\n- [ ] B 🆔 b ⛔ a\n- [ ] C 🆔 a\n',
      dependent: 'B',
      id: 'a',
    },
    {
      name: 'ambiguous new ID',
      source: '- [ ] A 🆔 a\n- [ ] B 🆔 b ⛔ a\n- [ ] C 🆔 b\n',
      dependent: 'B',
      id: 'a',
    },
  ])('leaves exact source untouched for $name', async ({ source, dependent, id }) => {
    const h = await harness({ 'tasks.md': source });
    const process = vi.spyOn(h.app.vault, 'process');
    expect((await h.application.execute(h.command('A', dependent, id))).type).not.toBe('ok');
    expect(await h.contents()).toEqual({ 'tasks.md': source });
    expect(process).not.toHaveBeenCalled();
  });

  it('commits both cross-file directions in deterministic file order with fresh outcomes', async () => {
    const h = await harness({ 'z.md': '- [ ] A 🆔 a\n', 'a.md': '- [ ] B 🆔 b ⛔ a\n' });
    const process = vi.spyOn(h.app.vault, 'process');
    expect(await h.application.execute(h.command())).toMatchObject({
      type: 'ok',
      outcome: { change: 'reversed' },
    });
    expect(await h.contents()).toEqual({ 'z.md': '- [ ] A 🆔 a ⛔ b\n', 'a.md': '- [ ] B 🆔 b\n' });
    expect(process.mock.calls.map(([file]) => file.path)).toEqual(['a.md', 'z.md']);
    expect(await h.application.execute(h.command('B', 'A', 'b'))).toMatchObject({ type: 'ok' });
    expect(await h.contents()).toEqual({ 'z.md': '- [ ] A 🆔 a\n', 'a.md': '- [ ] B 🆔 b ⛔ a\n' });
  });
});

describe('cross-file reversal compensation', () => {
  it.each(['parse', 'install'] as const)(
    'reconciles readable siblings independently after a restoration %s failure',
    async (fault) => {
      const originals = { 'a.md': '- [ ] A 🆔 a\n', 'b.md': '- [ ] B 🆔 b ⛔ a\n' };
      const h = await harness(originals);
      vi.spyOn(h.app.metadataCache, 'trigger').mockImplementation(() => undefined);
      const process = h.app.vault.process.bind(h.app.vault);
      const parse = h.index.snapshotsFromContent.bind(h.index);
      const install = h.index.installCommittedContent.bind(h.index);
      let writes = 0;
      vi.spyOn(h.app.vault, 'process').mockImplementation(async (...args) => {
        writes++;
        return await process(...args);
      });
      vi.spyOn(h.index, 'snapshotsFromContent').mockImplementation((path, content) => {
        if (writes === 4 && path === 'a.md' && fault === 'parse')
          throw new Error('restoration parse failed');
        return parse(path, content);
      });
      vi.spyOn(h.index, 'installCommittedContent').mockImplementation((path, content) => {
        if (writes === 4 && path === 'a.md' && fault === 'install')
          throw new Error('restoration install failed');
        const roots = install(path, content);
        if (writes === 2 && path === 'b.md')
          throw new Error('postcondition failed after installation');
        return roots;
      });
      expect(await h.application.execute(h.command())).toMatchObject({
        type: 'io-error',
        contentState: 'unknown',
      });
      expect(await h.contents()).toEqual(originals);
      expect(h.node('B').node.dependsOn).toEqual(['a']);
      expect(
        h.diagnostics.mock.calls.some(([entry]) => entry.phase === 'reversal-restoration-proof'),
      ).toBe(true);
      expect(await h.dependencies.serializeMutation(async () => Promise.resolve('released'))).toBe(
        'released',
      );
    },
  );
  it.each(['forward-callback', 'postcondition-read'] as const)(
    'does not overwrite an external ABA replay after contrary %s bytes without index notification',
    async (fault) => {
      const originals = { 'a.md': '- [ ] A 🆔 a\n', 'b.md': '- [ ] B 🆔 b ⛔ a\n' };
      const h = await harness(originals);
      const observedSources = vi.spyOn(h.authority, 'observeTransition');
      vi.spyOn(h.app.metadataCache, 'trigger').mockImplementation(() => undefined);
      const read = h.app.vault.read.bind(h.app.vault);
      const process = h.app.vault.process.bind(h.app.vault);
      let writes = 0;
      let observed = false;
      const candidate = '- [ ] A 🆔 a ⛔ b\n';
      vi.spyOn(h.app.vault, 'process').mockImplementation(async (file, transform) => {
        writes++;
        if (writes === 1 && fault === 'forward-callback') {
          await h.app.vault.modify(file, '- [ ] External\n');
          try {
            return await process(file, transform);
          } finally {
            await h.app.vault.modify(file, candidate);
          }
        }
        if (writes === 3 && fault === 'postcondition-read')
          await h.app.vault.modify(h.file('a.md'), candidate);
        return await process(file, transform);
      });
      vi.spyOn(h.app.vault, 'read').mockImplementation(async (file) => {
        if (fault === 'postcondition-read' && writes === 2 && file.path === 'a.md' && !observed) {
          observed = true;
          await h.app.vault.modify(file, '- [ ] External\n');
        }
        return await read(file);
      });
      expect(await h.application.execute(h.command())).toMatchObject({
        type: 'io-error',
        contentState: 'unknown',
      });
      expect(
        observedSources.mock.calls.filter(([, content]) => content.includes('External')),
      ).toEqual([]);
      expect(await h.contents()).toEqual({ 'a.md': candidate, 'b.md': originals['b.md'] });
      expect(h.node('A').node.dependsOn).toEqual(['b']);
    },
  );
  it.each(['postcondition', 'restoration'] as const)(
    'does not prove stale captured bytes during the second %s read',
    async (phase) => {
      const source = { 'a.md': '- [ ] A 🆔 a\n', 'b.md': '- [ ] B 🆔 b ⛔ a\n' };
      const h = await harness(source);
      const read = h.app.vault.read.bind(h.app.vault);
      const process = h.app.vault.process.bind(h.app.vault);
      let writes = 0;
      let changed = false;
      vi.spyOn(h.app.vault, 'process').mockImplementation(async (...args) => {
        writes++;
        if (phase === 'restoration' && writes === 2) throw new Error('second write failed');
        return await process(...args);
      });
      vi.spyOn(h.app.vault, 'read').mockImplementation(async (file) => {
        if (file.path === 'b.md' && writes === (phase === 'postcondition' ? 2 : 4) && !changed) {
          changed = true;
          await h.app.vault.modify(h.file('a.md'), '- [ ] External 🆔 a\n');
          h.index.installCommittedContent('a.md', '- [ ] External 🆔 a\n');
        }
        return await read(file);
      });
      expect(await h.application.execute(h.command())).toMatchObject({
        type: 'io-error',
        contentState: 'unknown',
      });
      expect(await h.contents()).toEqual({
        'a.md': '- [ ] External 🆔 a\n',
        'b.md': '- [ ] B 🆔 b ⛔ a\n',
      });
      expect(h.index.list({ filePath: 'a.md' }).map((root) => root.title)).toEqual(['External']);
    },
  );
  it.each([false, true])(
    'finishes compensation even if diagnostics throw (rollback failure: %s)',
    async (rollbackFails) => {
      const source = { 'a.md': '- [ ] A 🆔 a\n', 'b.md': '- [ ] B 🆔 b ⛔ a\n' };
      const h = await harness(source);
      const process = h.app.vault.process.bind(h.app.vault);
      let calls = 0;
      vi.spyOn(h.app.vault, 'process').mockImplementation(async (file, transform) => {
        calls++;
        if (calls === 2 || (calls === 4 && rollbackFails)) throw new Error('write failed');
        return await process(file, transform);
      });
      const fallback = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      h.diagnostics.mockImplementation(() => {
        throw new Error('private diagnostic failure');
      });
      await expect(h.application.execute(h.command())).resolves.toMatchObject({
        type: 'io-error',
        contentState: rollbackFails ? 'unknown' : 'unchanged',
      });
      expect(calls).toBe(4);
      if (!rollbackFails) expect(await h.contents()).toEqual(source);
      expect(JSON.stringify(fallback.mock.calls)).not.toContain('private');
    },
  );

  it('rejects a captured predecessor superseded before acquiring the second source', async () => {
    const source = { 'a.md': '- [ ] A 🆔 a\n', 'b.md': '- [ ] B 🆔 b ⛔ a\n' };
    const h = await harness(source);
    const read = h.app.vault.read.bind(h.app.vault);
    let changed = false;
    vi.spyOn(h.app.vault, 'read').mockImplementation(async (file) => {
      if (file.path === 'b.md' && !changed) {
        changed = true;
        for (const id of ['temporary', 'a'])
          await h.repository.edit({ type: 'set-dependency-id', target: h.node('A').target, id });
      }
      return await read(file);
    });
    expect((await h.application.execute(h.command())).type).not.toBe('ok');
    expect(await h.contents()).toEqual(source);
  });
  it('compensates when installation returns unproven endpoint revisions', async () => {
    const source = { 'a.md': '- [ ] A 🆔 a\n', 'b.md': '- [ ] B 🆔 b ⛔ a\n' };
    const h = await harness(source);
    const before = h.node('A').root.ref;
    const install = h.index.installCommittedContent.bind(h.index);
    vi.spyOn(h.index, 'installCommittedContent').mockImplementation((path, content) => {
      const roots = install(path, content);
      return path === 'a.md' && content.includes('⛔ b')
        ? roots.map((root) => ({ ...root, ref: before }))
        : roots;
    });
    expect(await h.application.execute(h.command())).toMatchObject({
      type: 'io-error',
      contentState: 'unchanged',
    });
    expect(await h.contents()).toEqual(source);
  });
  it('holds serialization through compensation across service instances', async () => {
    const source = { 'a.md': '- [ ] A 🆔 a\n', 'b.md': '- [ ] B 🆔 b ⛔ a\n' };
    const h = await harness(source);
    const command = h.command();
    const secondService = new TaskDependencyService(
      h.index,
      h.repository,
      nextTaskDependencyId,
      h.diagnostics,
    );
    const entered = deferred<void>();
    const release = deferred<void>();
    const process = h.app.vault.process.bind(h.app.vault);
    let calls = 0;
    vi.spyOn(h.app.vault, 'process').mockImplementation(async (file, transform) => {
      calls++;
      if (calls === 2) throw new Error('second write failed');
      if (calls === 3) {
        entered.resolve();
        await release.promise;
      }
      return await process(file, transform);
    });
    const first = h.application.execute(command);
    await entered.promise;
    const second = secondService.execute(command);
    await flushMicrotasks();
    expect(calls).toBe(3);
    release.resolve();
    expect(await first).toMatchObject({ type: 'io-error', contentState: 'unchanged' });
    expect(await second).toMatchObject({ type: 'ok' });
    expect(await h.contents()).toEqual({ 'a.md': '- [ ] A 🆔 a ⛔ b\n', 'b.md': '- [ ] B 🆔 b\n' });
  });
  const originals = { 'a.md': '- [ ] A 🆔 a\r\nuntouched\r\n', 'b.md': '- [ ] B 🆔 b ⛔ a' };

  it.each([
    'source-read',
    'reservation',
    'first-write',
    'second-write',
    'first-write-late',
    'second-write-late',
    'postcondition-parse',
    'postcondition-proof',
  ] as const)('restores exact originals after %s failure', async (fault) => {
    const h = await harness(originals);
    const read = h.app.vault.read.bind(h.app.vault);
    const parse = h.index.snapshotsFromContent.bind(h.index);
    let writes = 0;
    let failed = false;
    if (fault === 'source-read')
      vi.spyOn(h.app.vault, 'read').mockRejectedValueOnce(new Error('secret source'));
    if (fault === 'reservation')
      vi.spyOn(h.authority, 'reserveMutation').mockReturnValueOnce(undefined);
    vi.spyOn(h.app.vault, 'process').mockImplementation(async (file, transform) => {
      writes++;
      const fail =
        (writes === 1 && fault.startsWith('first-write')) ||
        (writes === 2 && fault.startsWith('second-write'));
      if (fail && !fault.endsWith('late')) throw new Error('secret source');
      const candidate = transform(await read(file));
      await h.app.vault.modify(file, candidate);
      if (fail) throw new Error('secret source');
      return candidate;
    });
    vi.spyOn(h.index, 'snapshotsFromContent').mockImplementation((path, content) => {
      if (writes === 2 && !failed && fault.startsWith('postcondition')) {
        failed = true;
        if (fault === 'postcondition-parse') throw new Error('secret source');
        return [];
      }
      return parse(path, content);
    });
    expect(await h.application.execute(h.command())).toMatchObject({
      type: 'io-error',
      contentState: 'unchanged',
    });
    expect(await h.contents()).toEqual(originals);
    expect(JSON.stringify(h.diagnostics.mock.calls)).not.toContain('secret');
    expect(h.diagnostics).toHaveBeenCalled();
    for (const path of Object.keys(originals))
      expect(
        h.authority.observeTransition(path, originals[path as keyof typeof originals]),
      ).toBeUndefined();
    expect(await h.application.execute(h.command())).toMatchObject({ type: 'ok' });
  });

  it.each(['first-rollback', 'second-rollback', 'concurrent-mutation'] as const)(
    'reports unknown content and preserves unowned bytes after %s',
    async (fault) => {
      const h = await harness(originals);
      const read = h.app.vault.read.bind(h.app.vault);
      const parse = h.index.snapshotsFromContent.bind(h.index);
      let writes = 0;
      let failed = false;
      vi.spyOn(h.app.vault, 'process').mockImplementation(async (file, transform) => {
        writes++;
        if (
          (fault === 'first-rollback' && writes === 3) ||
          (fault === 'second-rollback' && writes === 4)
        )
          throw new Error('rollback denied');
        if (fault === 'concurrent-mutation' && writes === 3)
          await h.app.vault.modify(file, 'external bytes');
        const candidate = transform(await read(file));
        await h.app.vault.modify(file, candidate);
        return candidate;
      });
      vi.spyOn(h.index, 'snapshotsFromContent').mockImplementation((path, content) => {
        if (writes === 2 && !failed) {
          failed = true;
          throw new Error('proof failed');
        }
        return parse(path, content);
      });
      expect(await h.application.execute(h.command())).toMatchObject({
        type: 'io-error',
        contentState: 'unknown',
      });
      const contents = await h.contents();
      expect(contents).not.toEqual(originals);
      expect(h.index.list({ filePath: 'b.md' }).map((root) => root.dependsOn)).toEqual(
        contents['b.md'] === 'external bytes'
          ? []
          : [contents['b.md']?.includes('⛔ a') === true ? ['a'] : []],
      );
      expect(h.index.list({ filePath: 'a.md' }).map((root) => root.dependsOn)).toEqual([
        contents['a.md']?.includes('⛔ b') === true ? ['b'] : [],
      ]);
      if (fault === 'concurrent-mutation')
        expect(Object.values(contents)).toContain('external bytes');
      expect(
        h.diagnostics.mock.calls.some(
          ([entry]) => entry.phase.includes('rollback') || entry.phase.includes('restoration'),
        ),
      ).toBe(true);
      expect(await h.dependencies.serializeMutation(async () => Promise.resolve('released'))).toBe(
        'released',
      );
    },
  );
});
