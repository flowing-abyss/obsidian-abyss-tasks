import MiniSearch from 'minisearch';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  TaskSearchEngine,
  TaskSearchEngineRequest,
} from '../../src/tasks/application/TaskSearchEngine';
import type { TaskSearchDocument } from '../../src/tasks/application/TaskSearchSource';
import { fallbackSearchWords, prepareSearchQuery } from '../../src/tasks/domain/searchMatchPolicy';
import { createMiniSearchTaskEngine } from '../../src/tasks/infrastructure/search/MiniSearchTaskEngine';
const engines: TaskSearchEngine[] = [];
afterEach(() => {
  for (const engine of engines.splice(0)) engine.dispose();
});
function document(id: number, fields: Partial<TaskSearchDocument> = {}): TaskSearchDocument {
  return {
    id,
    rootId: id,
    order: { filePath: 'a.md', line: 0, childLines: [] },
    title: '',
    description: '',
    comments: '',
    tags: '',
    metadata: '',
    links: '',
    sourcePath: 'a.md',
    ...fields,
  };
}
function engine(documents: readonly TaskSearchDocument[]) {
  const value = createMiniSearchTaskEngine(fallbackSearchWords);
  engines.push(value);
  value.add(documents);
  return value;
}
function search(
  value: TaskSearchEngine,
  query: string,
  options: Partial<TaskSearchEngineRequest> = {},
) {
  return value.search({
    kind: 'roots',
    query: prepareSearchQuery(query, fallbackSearchWords),
    includeSourcePath: false,
    ...options,
  });
}
describe('single MiniSearch task engine', () => {
  it('AND-covers root title, third tag and descendant fields, without leaking to a sibling picker node', () => {
    const value = engine([
      document(1, { title: 'Release', tags: '#one #two #budget' }),
      document(2, {
        rootId: 1,
        comments: 'Завтра',
        order: { filePath: 'a.md', line: 0, childLines: [1] },
      }),
      document(3, {
        rootId: 1,
        tags: '#descendant',
        order: { filePath: 'a.md', line: 0, childLines: [1, 2] },
      }),
      document(4, {
        rootId: 1,
        title: 'Sibling',
        order: { filePath: 'a.md', line: 0, childLines: [3] },
      }),
    ]);
    expect(search(value, 'release budget завтра').map((hit) => hit.id)).toEqual([1]);
    expect(search(value, 'release budget завтра', { kind: 'nodes' })).toEqual([]);
    expect(search(value, 'budget', { kind: 'nodes' }).map((hit) => hit.id)).toEqual([1]);
    expect(search(value, 'release budget завтра descendant').map((hit) => hit.id)).toEqual([1]);
    expect(search(value, 'descendant', { kind: 'nodes' }).map((hit) => hit.id)).toEqual([3]);
    expect(search(value, 'завтра', { kind: 'nodes' })).toEqual([]);
  });
  it.each([
    ['taks', 'task'],
    ['tast', 'task'],
    ['тескт', 'текст'],
    ['abdc', 'abcd'],
    ['bacd', 'abcd'],
    ['acbd', 'abcd'],
    ['budgte', 'budget'],
    ['CAFÉ', 'cafe\u0301'],
    ['中文', '中文'],
    ['κόσμος', 'ΚΟΣΜΟΣ'],
    ['#work/urgent', '#Work/Urgent'],
    ['2026-10-04', '2026-10-04'],
    ['dependency42', 'dependency42'],
  ])('retrieves %s from %s', (query, title) => {
    expect(search(engine([document(1, { title })]), query).map((hit) => hit.id)).toEqual([1]);
  });
  it('ranks exact title before typo alternatives and accent substitutions', () => {
    const value = engine([document(1, { title: 'taks' }), document(2, { title: 'task' })]);
    expect(search(value, 'task').map((hit) => hit.id)).toEqual([2, 1]);
    expect(
      search(engine([document(1, { title: 'cafe' }), document(2, { title: 'café' })]), 'café').map(
        (hit) => hit.id,
      ),
    ).toEqual([2, 1]);
  });
  it('indexes every root field but limits picker fields and source-path opt-in', () => {
    for (const field of ['description', 'comments', 'tags', 'metadata', 'links'] as const) {
      const value = engine([document(1, { [field]: 'needle' })]);
      expect(search(value, 'needle').map((hit) => hit.id)).toEqual([1]);
      expect(search(value, 'needle', { kind: 'nodes' }).map((hit) => hit.id)).toEqual(
        field === 'tags' ? [1] : [],
      );
    }
    const value = engine([document(1, { sourcePath: 'secret.md' })]);
    expect(search(value, 'secret')).toEqual([]);
    expect(search(value, 'secret', { includeSourcePath: true }).map((hit) => hit.id)).toEqual([1]);
  });
  it('performs at most one normal and three exact swap branches per distinct original token', () => {
    const value = engine([document(1, { title: 'abcd task' })]);
    const spy = vi.spyOn(MiniSearch.prototype, 'search');
    expect(search(value, 'abdc taks abdc').map((hit) => hit.id)).toEqual([1]);
    expect(spy.mock.calls.length).toBeLessThanOrEqual(8);
    for (const [text, options] of spy.mock.calls) {
      if (text !== 'abdc' && text !== 'taks')
        expect(options).toMatchObject({ fuzzy: 0, prefix: false });
    }
  });
  it('has deterministic coordinate ties, file restriction and preferred-file ordering', () => {
    const value = engine([
      document(1, { title: 'task', order: { filePath: 'b.md', line: 0, childLines: [] } }),
      document(2, { title: 'task', order: { filePath: 'a.md', line: 2, childLines: [] } }),
      document(3, { title: 'task', order: { filePath: 'a.md', line: 1, childLines: [] } }),
    ]);
    expect(search(value, 'task').map((hit) => hit.id)).toEqual([3, 2, 1]);
    expect(search(value, 'task', { filePath: 'b.md' }).map((hit) => hit.id)).toEqual([1]);
    expect(search(value, 'task', { preferFilePath: 'b.md' }).map((hit) => hit.id)).toEqual([
      1, 3, 2,
    ]);
  });
  it('does not treat punctuation as match-all or fuzz long/one-character tokens', () => {
    const value = engine([document(1, { title: `b ${'a'.repeat(66)}` })]);
    expect(search(value, '!!!')).toEqual([]);
    expect(search(value, 'a')).toEqual([]);
    expect(search(value, 'a'.repeat(65))).toEqual([]);
    expect(search(value, '  ').map((hit) => hit.id)).toEqual([1]);
  });
  it('replacement, discard and vacuum agree with a clean build', async () => {
    const value = engine([
      document(1, { title: 'old' }),
      document(2, { title: 'survivor', order: { filePath: 'b.md', line: 0, childLines: [] } }),
    ]);
    value.replaceBegin('a.md');
    value.add([document(3, { title: 'new budget' })]);
    value.replaceCommit('a.md');
    value.remove('b.md');
    const fresh = engine([document(3, { title: 'new budget' })]);
    for (const query of ['old', 'survivor', 'budget', 'new', ''])
      expect(search(value, query).map((hit) => hit.id)).toEqual(
        search(fresh, query).map((hit) => hit.id),
      );
    await value.vacuum();
    for (const query of ['old', 'survivor', 'budget', 'new', ''])
      expect(search(value, query)).toEqual(search(fresh, query));
    value.dispose();
    expect(() => search(value, 'budget')).toThrow(expect.objectContaining({ code: 'disposed' }));
  });
});

it('uses preferred file only after relevance for nonempty queries', () => {
  const value = engine([
    document(1, { title: 'taks' }),
    document(2, { title: 'task', order: { filePath: 'b.md', line: 0, childLines: [] } }),
  ]);
  expect(search(value, 'task', { preferFilePath: 'a.md' }).map((hit) => hit.id)).toEqual([2, 1]);
});
it('discounts descendants and caps their combined contribution', () => {
  const value = engine([
    document(1, { title: 'budget' }),
    ...Array.from({ length: 20 }, (_, i) =>
      document(i + 2, {
        rootId: 1,
        title: 'budget',
        order: { filePath: 'a.md', line: 0, childLines: [i + 1] },
      }),
    ),
  ]);
  const own = search(value, 'budget', { kind: 'nodes' })[0]?.score ?? 0;
  expect(own).toBeGreaterThan(0);
  expect(search(value, 'budget')[0]?.score).toBeCloseTo(2 * own);
  const oneChild = engine([
    document(1),
    document(2, {
      rootId: 1,
      title: 'budget',
      order: { filePath: 'a.md', line: 0, childLines: [1] },
    }),
  ]);
  expect(search(oneChild, 'budget')[0]?.score).toBeCloseTo(
    0.8 * (search(oneChild, 'budget', { kind: 'nodes' })[0]?.score ?? 0),
  );
});

it.each([
  ['ab𐐀 z', 'ab z'],
  ['abc z', 'ab𐐀 z'],
  ['abcde z', 'ab𐐀𐐀e z'],
])('retrieves code-point edits for astral letters: %s', (query, title) => {
  expect(search(engine([document(1, { title })]), query).map((hit) => hit.id)).toEqual([1]);
});

it('rejects wider UTF-16 candidates before they contribute coverage or score', () => {
  const value = engine([
    document(1, { title: 'abcd abxy' }),
    document(2, { title: 'abxy zzzz' }),
    document(3, { title: 'abcd wxyz' }),
  ]);
  expect(search(value, 'abcd anchor')).toEqual([]);
  expect(search(value, 'abcd zzzz')).toEqual([]);
  const results = search(value, 'abcd');
  expect(results.map((hit) => hit.id)).toEqual([1, 3]);
  expect(results[0]?.score).toBe(results[1]?.score);
});
