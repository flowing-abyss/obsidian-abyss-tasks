import fc from 'fast-check';
import { TFile } from 'obsidian';
import { describe, expect, it, vi } from 'vitest';
import type { TaskSnapshot } from '../../src/tasks/domain/types';
import { TaskIndex } from '../../src/tasks/infrastructure/TaskIndex';
import {
  canonicalStatusCatalog,
  createAppWithFiles,
  expectDefined,
  flushMicrotasks,
} from '../helpers';
import { canonicalSearchForIndex } from '../support/taskSearchHarness';
import { taskSyntaxArbitrary, type TaskSyntaxCase } from '../support/taskSyntaxArbitraries';

// Long tokens disable fuzzy/prefix matching, so the model needs no copy of the match policy.
const allToken = `modelall${'z'.repeat(65)}`;
const tokens = ['Read', 'Задача', 'café', '日本語', '𐐀word'].map((word) => ({
  word,
  token: word + 'q'.repeat(65),
}));
const queries = [allToken, ...tokens.map(({ token }) => token)];
function searchableFixture(fixture: TaskSyntaxCase): TaskSyntaxCase {
  const title = [
    allToken,
    ...tokens.filter(({ word }) => fixture.title.includes(word)).map(({ token }) => token),
    fixture.title,
  ].join(' ');
  const at = fixture.source.indexOf(']') + 2;
  return {
    ...fixture,
    title,
    source: fixture.source.slice(0, at) + title + fixture.source.slice(at + fixture.title.length),
  };
}
const fixtureArbitrary = taskSyntaxArbitrary().map(searchableFixture);
type Operation =
  { kind: 'put'; path: string; fixture: TaskSyntaxCase } | { kind: 'remove'; path: string };
const paths = fc.constantFrom('slot-0.md', 'slot-1.md', 'slot-2.md', 'slot-3.md');
const operationArbitrary: fc.Arbitrary<Operation> = fc.oneof(
  fc.record({ kind: fc.constant('put' as const), path: paths, fixture: fixtureArbitrary }),
  fc.record({ kind: fc.constant('remove' as const), path: paths }),
);
const operationsArbitrary: fc.Arbitrary<Operation[]> = fc
  .tuple(paths, fixtureArbitrary, fixtureArbitrary, fc.array(operationArbitrary, { maxLength: 8 }))
  .map(([path, first, replacement, rest]) => [
    { kind: 'put', path, fixture: first },
    { kind: 'put', path, fixture: replacement },
    { kind: 'remove', path },
    { kind: 'put', path, fixture: first },
    ...rest,
  ]);

function taskSemantics(task: TaskSnapshot) {
  return {
    path: task.source.filePath,
    line: task.source.line,
    title: task.title,
    markdownTitle: task.markdownTitle,
    status: task.status,
    symbol: task.statusSymbol,
    tags: task.tags,
    priority: task.priority,
    due: task.planning.due,
    dependencyId: task.dependencyId,
    dependsOn: task.dependsOn,
  };
}
function fixtureSemantics(path: string, fixture: TaskSyntaxCase) {
  return {
    path,
    line: 0,
    title: fixture.title,
    markdownTitle: fixture.title,
    status: fixture.status === 'x' ? 'done' : 'open',
    symbol: fixture.status,
    tags: [...new Set(fixture.tags)],
    priority: fixture.priority,
    due: fixture.due,
    dependencyId: fixture.dependencyId,
    dependsOn: [...new Set(fixture.dependsOn)],
  };
}
function ordered<T extends { path: string }>(values: T[]): T[] {
  return values.sort((a, b) => a.path.localeCompare(b.path));
}
async function assertIndexMatchesModel(
  index: TaskIndex,
  search: ReturnType<typeof canonicalSearchForIndex>,
  expected: ReadonlyMap<string, TaskSyntaxCase>,
): Promise<void> {
  expect(ordered(index.list().map(taskSemantics))).toEqual(
    ordered([...expected].map(([path, fixture]) => fixtureSemantics(path, fixture))),
  );
  const source = index.searchSource();
  const documents = source.files().flatMap((file) => [...source.documents(file)]);
  expect(
    ordered(
      documents.map((doc) => ({
        path: doc.order.filePath,
        line: doc.order.line,
        childLines: doc.order.childLines,
        title: doc.title,
        description: doc.description,
        comments: doc.comments,
        tags: doc.tags,
        metadata: doc.metadata,
        links: doc.links,
        sourcePath: doc.sourcePath,
      })),
    ),
  ).toEqual(
    ordered(
      [...expected].map(([path, fixture]) => ({
        path,
        line: 0,
        childLines: [],
        title: fixture.title,
        description: '',
        comments: '',
        tags: [...new Set(fixture.tags)].join(' '),
        metadata: [
          fixture.priority,
          fixture.due,
          fixture.dependencyId,
          ...new Set(fixture.dependsOn),
        ].join(' '),
        links: '',
        sourcePath: path,
      })),
    ),
  );
  for (const query of queries) {
    const signal = new AbortController().signal;
    const cursor = await search.open({ kind: 'roots', query }, signal);
    try {
      const batch = await search.read(cursor, 0, 50, signal);
      const hits = await search.resolveHits(batch.hits, signal);
      const wanted = ordered(
        [...expected]
          .filter(([, fixture]) => fixture.title.includes(query))
          .map(([path, fixture]) => fixtureSemantics(path, fixture)),
      );
      expect(cursor.total).toBe(wanted.length);
      expect(batch.done).toBe(true);
      expect(
        ordered(
          hits.map((hit) => {
            if (hit.task.target.type !== 'task' || !('source' in hit.task.node))
              throw new Error('Expected a root hit');
            return taskSemantics(hit.task.node);
          }),
        ),
      ).toEqual(wanted);
    } finally {
      search.release(cursor);
    }
  }
}
async function assertFreshRebuildMatchesModel(
  expected: ReadonlyMap<string, TaskSyntaxCase>,
): Promise<void> {
  const app = await createAppWithFiles(
    Object.fromEntries([...expected].map(([path, fixture]) => [path, fixture.source])),
  );
  const index = new TaskIndex(app, { statusCatalog: canonicalStatusCatalog() });
  const search = canonicalSearchForIndex(index);
  try {
    await index.initialize();
    await assertIndexMatchesModel(index, search, expected);
  } finally {
    search.dispose();
    index.destroy();
  }
}

describe('canonical index and persistent search transitions', () => {
  it('keeps HTML colors out of root and subtask tags after indexing and updates', async () => {
    const source =
      '- [ ] #real <font color="#ff0000">root</font>\n  - [ ] <span style="color: #abc">child</span> #child\n';
    const app = await createAppWithFiles({ 'html.md': source });
    const index = new TaskIndex(app, { statusCatalog: canonicalStatusCatalog() });
    try {
      await index.initialize();
      const root = expectDefined(index.list()[0]);
      expect(root.tags).toEqual(['#real']);
      expect(root.markdownTitle).toBe('<font color="#ff0000">root</font>');
      expect(root.subtasks[0]?.tags).toEqual(['#child']);
      expect(root.subtasks[0]?.markdownTitle).toBe('<span style="color: #abc">child</span>');
      expect(index.list({ tag: '#ff0000' })).toEqual([]);
      expect(index.list({ tag: '#abc' })).toEqual([]);
      index.installCommittedContent('html.md', source.replace('#ff0000', '#00ff00'));
      expect(index.list({ tag: '#00ff00' })).toEqual([]);
      expect(index.list()[0]?.tags).toEqual(['#real']);
    } finally {
      index.destroy();
    }
  });

  it('matches an authored Map through committed puts, removals and re-adds', async () => {
    await fc.assert(
      fc.asyncProperty(operationsArbitrary, async (operations) => {
        const app = await createAppWithFiles({});
        const index = new TaskIndex(app, { statusCatalog: canonicalStatusCatalog() });
        const search = canonicalSearchForIndex(index);
        try {
          await index.initialize();
          const expected = new Map<string, TaskSyntaxCase>();
          await assertIndexMatchesModel(index, search, expected);
          for (const operation of operations) {
            if (operation.kind === 'put') {
              expected.set(operation.path, operation.fixture);
              index.installCommittedContent(operation.path, operation.fixture.source);
            } else {
              expected.delete(operation.path);
              index.installCommittedContent(operation.path, '');
            }
            await assertIndexMatchesModel(index, search, expected);
            await assertFreshRebuildMatchesModel(expected);
          }
        } finally {
          search.dispose();
          index.destroy();
        }
      }),
      { seed: 20261012, numRuns: 20 },
    );
  });

  it('drops the old root/token on a real file delete and finds its recreation', async () => {
    const old = searchableFixture({
      source: '- [ ] Read 📅 2026-10-01 🆔 old ⛔ parent',
      title: 'Read',
      status: ' ',
      tags: [],
      dependencyId: 'old',
      dependsOn: ['parent'],
      due: '2026-10-01',
      priority: 'D',
      lineEnding: '',
    });
    const next = searchableFixture({
      ...old,
      source: '- [x] café 📅 2026-10-02 🆔 new ⛔ other',
      title: 'café',
      status: 'x',
      dependencyId: 'new',
      dependsOn: ['other'],
      due: '2026-10-02',
    });
    const app = await createAppWithFiles({ 'slot-0.md': old.source });
    const index = new TaskIndex(app, { statusCatalog: canonicalStatusCatalog() });
    const search = canonicalSearchForIndex(index);
    try {
      await index.initialize();
      await assertIndexMatchesModel(index, search, new Map([['slot-0.md', old]]));
      const oldRef = expectDefined(index.list()[0]).ref;
      const file = app.vault.getAbstractFileByPath('slot-0.md');
      if (!(file instanceof TFile)) throw new Error('Missing fixture file');
      await app.fileManager.trashFile(file);
      await flushMicrotasks(20);
      await assertIndexMatchesModel(index, search, new Map());
      await app.vault.create('slot-0.md', next.source);
      await flushMicrotasks(20);
      await assertIndexMatchesModel(index, search, new Map([['slot-0.md', next]]));
      expect(index.list()[0]?.ref).not.toEqual(oldRef);
      await assertFreshRebuildMatchesModel(new Map([['slot-0.md', next]]));
    } finally {
      search.dispose();
      index.destroy();
    }
  });

  it('releases live cursors, source subscriptions and vault listeners on every failing shrink', async () => {
    let acquired = 0,
      released = 0,
      cases = 0;
    const expectedFailure = new Error('Intentional shrink cleanup probe');
    const cleanupFailures: unknown[] = [];
    const result = await fc.check(
      fc.asyncProperty(fc.integer({ min: 1, max: 100 }), async (count) => {
        cases++;
        const app = await createAppWithFiles({ 'a.md': `- [ ] ${allToken}` });
        const vaultOn = vi.spyOn(app.vault, 'on');
        const vaultOff = vi.spyOn(app.vault, 'offref');
        const metadataOn = vi.spyOn(app.metadataCache, 'on');
        const metadataOff = vi.spyOn(app.metadataCache, 'offref');
        const index = new TaskIndex(app, { statusCatalog: canonicalStatusCatalog() });
        const realSource = index.searchSource();
        const realSubscribe = realSource.subscribe.bind(realSource);
        realSource.subscribe = (listener) => {
          acquired++;
          const subscription = realSubscribe(listener);
          let active = true;
          return {
            ...subscription,
            unsubscribe: () => {
              if (active) {
                active = false;
                released++;
                subscription.unsubscribe();
              }
            },
          };
        };
        const sourceSpy = vi.spyOn(index, 'searchSource').mockReturnValue(realSource);
        const search = canonicalSearchForIndex(index);
        try {
          await index.initialize();
          const signal = new AbortController().signal;
          const cursor = await search.open({ kind: 'nodes', query: allToken }, signal);
          try {
            expect((await search.read(cursor, 0, 50, signal)).hits).toHaveLength(1);
            // Intentional property failure exercises real teardown again during shrinking.
            expect(count).toBeGreaterThanOrEqual(1);
            throw expectedFailure;
          } finally {
            search.release(cursor);
            await expect(search.read(cursor, 0, 50, signal)).rejects.toMatchObject({
              code: 'cursor-expired',
            });
          }
        } finally {
          search.dispose();
          index.destroy();
          try {
            expect(vaultOff.mock.calls.map(([ref]) => ref)).toEqual(
              vaultOn.mock.results.map((result) => result.value as unknown),
            );
            expect(metadataOff.mock.calls.map(([ref]) => ref)).toEqual(
              metadataOn.mock.results.map((result) => result.value as unknown),
            );
            expect(released).toBe(acquired);
            await expect(
              search.open({ kind: 'roots', query: allToken }, new AbortController().signal),
            ).rejects.toMatchObject({ code: 'disposed' });
          } catch (error) {
            cleanupFailures.push(error);
          } finally {
            sourceSpy.mockRestore();
            vaultOn.mockRestore();
            vaultOff.mockRestore();
            metadataOn.mockRestore();
            metadataOff.mockRestore();
          }
        }
      }),
      { seed: 20261012, numRuns: 1 },
    );
    expect(cleanupFailures).toEqual([]);
    expect(acquired).toBe(cases);
    expect(result.failed).toBe(true);
    expect(result.errorInstance).toBe(expectedFailure);
    expect(result.numShrinks).toBeGreaterThan(0);
    expect(cases).toBeGreaterThan(1);
    expect(released).toBe(acquired);
  });
});
