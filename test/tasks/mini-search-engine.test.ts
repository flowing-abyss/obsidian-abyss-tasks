import MiniSearch from 'minisearch';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  TaskSearchEngine,
  TaskSearchEngineRequest,
} from '../../src/tasks/application/TaskSearchEngine';
import type { TaskSearchDocument } from '../../src/tasks/application/TaskSearchSource';
import * as matchPolicy from '../../src/tasks/domain/searchMatchPolicy';
import {
  fallbackSearchWords,
  matchesSearchText,
  prepareSearchQuery,
} from '../../src/tasks/domain/searchMatchPolicy';
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
  it.each(['roots', 'nodes'] as const)(
    'keeps exact and derived constructor matches in %s, with the exact title first',
    (kind) => {
      const value = engine([
        document(1, { title: 'constructors' }),
        document(2, { title: 'constructer' }),
        document(3, { title: 'constructor' }),
        document(4, { title: 'unrelated' }),
      ]);
      const hits = search(value, 'constructor', { kind });
      expect(hits.map((hit) => hit.id).sort((a, b) => a - b)).toEqual([1, 2, 3]);
      expect(hits[0]?.id).toBe(3);
      expect(hits.every((hit) => Number.isFinite(hit.score) && hit.score > 0)).toBe(true);
    },
  );
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
    document(4, { title: '𐐀𐐀𐐀𐐀' }),
  ]);
  expect(search(value, 'abcd anchor')).toEqual([]);
  expect(search(value, 'abcd zzzz')).toEqual([]);
  const results = search(value, 'abcd');
  expect(results.map((hit) => hit.id)).toEqual([1, 3]);
  expect(results[0]?.score).toBe(results[1]?.score);
});

describe('conditional UTF-16 candidate radius', () => {
  it.each([
    ['ab', 0],
    ['abc', 1],
    ['abcd', 1],
    ['abcde', 2],
    ['a'.repeat(65), 0],
  ])('keeps the original radius for BMP query %s and BMP vocabulary', (query, radius) => {
    const value = engine([document(1, { title: query })]);
    const spy = vi.spyOn(MiniSearch.prototype, 'search');
    expect(search(value, query).map((hit) => hit.id)).toEqual([1]);
    expect(spy.mock.calls[0]?.[1]?.fuzzy).toBe(radius);
  });

  it.each([
    ['abc', 'ab𐐀', 2],
    ['ab𐐀', 'abc', 2],
    ['abc', 'ab𐐀c', 2],
    ['ab𐐀c', 'abc', 2],
    ['abcde', 'ab𐐀𐐀e', 4],
    ['ab𐐀𐐀e', 'abcde', 4],
  ])('agrees with code-point policy in both directions: %s -> %s', (query, title, radius) => {
    // The final one-letter anchor prevents prefix matches masking insert/delete errors.
    const prepared = prepareSearchQuery(`${query} z`, fallbackSearchWords);
    expect(matchesSearchText(`${title} z`, prepared, fallbackSearchWords)).toBe(true);
    const value = engine([document(1, { title: `${title} z` })]);
    const spy = vi.spyOn(MiniSearch.prototype, 'search');
    expect(search(value, `${query} z`).map((hit) => hit.id)).toEqual([1]);
    expect(spy.mock.calls[0]?.[1]?.fuzzy).toBe(radius);
    expect(spy.mock.calls.length).toBeLessThanOrEqual(5);
    for (const [text, options] of spy.mock.calls.slice(1)) {
      expect(options).toMatchObject({ fuzzy: 0, prefix: false });
      expect(text).not.toBe(query);
    }
  });

  it.each(['description', 'comments', 'metadata', 'links', 'sourcePath'] as const)(
    'widens only searched fields when astral words occur in %s',
    (field) => {
      const value = engine([document(1, { title: 'abc', [field]: 'ab𐐀' })]);
      const spy = vi.spyOn(MiniSearch.prototype, 'search');
      search(value, 'abc', { kind: 'nodes' });
      expect(spy.mock.calls[0]?.[1]?.fuzzy).toBe(1);
      spy.mockClear();
      search(value, 'abc');
      expect(spy.mock.calls[0]?.[1]?.fuzzy).toBe(field === 'sourcePath' ? 1 : 2);
      spy.mockClear();
      search(value, 'abc', { includeSourcePath: true });
      expect(spy.mock.calls[0]?.[1]?.fuzzy).toBe(2);
    },
  );

  it('does not widen for emoji discarded by segmentation', () => {
    const value = engine([document(1, { title: 'abc 😀', tags: '🔥', sourcePath: '😀.md' })]);
    const spy = vi.spyOn(MiniSearch.prototype, 'search');
    search(value, 'abc 😀', { includeSourcePath: true });
    expect(spy.mock.calls[0]?.[1]?.fuzzy).toBe(1);
  });

  it('updates presence through multi-batch replacement, removal, vacuum and disposal', async () => {
    const value = engine([document(1, { title: 'abc' })]);
    const spy = vi.spyOn(MiniSearch.prototype, 'search');
    const check = (radius: number, ids: number[]) => {
      spy.mockClear();
      expect(search(value, 'abc').map((hit) => hit.id)).toEqual(ids);
      expect(spy.mock.calls[0]?.[1]?.fuzzy).toBe(radius);
    };
    check(1, [1]);
    value.replaceBegin('b.md');
    value.add([
      document(2, { title: 'ab𐐀 ab𐐀', order: { filePath: 'b.md', line: 0, childLines: [] } }),
    ]);
    value.add([
      document(3, { title: 'ab𐐀', order: { filePath: 'b.md', line: 1, childLines: [] } }),
    ]);
    expect(() => search(value, 'abc')).toThrow(expect.objectContaining({ code: 'unavailable' }));
    value.replaceCommit('b.md');
    spy.mockClear();
    expect(new Set(search(value, 'abc').map((hit) => hit.id))).toEqual(new Set([1, 2, 3]));
    expect(spy.mock.calls[0]?.[1]?.fuzzy).toBe(2);
    value.replaceBegin('b.md');
    value.add([
      document(4, { title: 'unrelated', order: { filePath: 'b.md', line: 0, childLines: [] } }),
    ]);
    value.replaceCommit('b.md');
    check(1, [1]);
    value.add([document(5, { tags: 'ab𐐀', order: { filePath: 'c.md', line: 0, childLines: [] } })]);
    value.add([document(6, { tags: 'ab𐐀', order: { filePath: 'd.md', line: 0, childLines: [] } })]);
    value.remove('c.md');
    check(2, [1, 6]);
    value.remove('d.md');
    value.remove('d.md');
    check(1, [1]);
    await value.vacuum();
    const fresh = engine([
      document(1, { title: 'abc' }),
      document(4, { title: 'unrelated', order: { filePath: 'b.md', line: 0, childLines: [] } }),
    ]);
    expect(search(value, 'abc')).toEqual(search(fresh, 'abc'));
    value.add([document(7, { title: 'ab𐐀' })]);
    check(2, [1, 7]);
    value.dispose();
    value.dispose();
    expect(() => search(value, 'abc')).toThrow(expect.objectContaining({ code: 'disposed' }));
    expect(() => {
      value.add([document(8, { title: 'ab𐐀' })]);
    }).toThrow(expect.objectContaining({ code: 'disposed' }));
    spy.mockClear();
    search(fresh, 'abc');
    expect(spy.mock.calls[0]?.[1]?.fuzzy).toBe(1);
  });

  it('caches accepted and rejected terms across documents/fields only within the query', () => {
    const value = engine([
      document(1, { title: 'abc abx axx', tags: 'abc abx axx', description: '𐐀𐐀𐐀' }),
      document(2, { title: 'abc abx axx', tags: 'abc abx axx' }),
    ]);
    const spy = vi.spyOn(matchPolicy, 'matchesSearchTerm');
    expect(search(value, 'abc').map((hit) => hit.id)).toEqual([1, 2]);
    const terms = spy.mock.calls.map(([term]) => term);
    expect(terms).toContain('axx');
    expect(terms).toContain('abx');
    expect(terms).toHaveLength(new Set(terms).size);
    spy.mockClear();
    search(value, 'abc');
    expect(spy.mock.calls.map(([term]) => term)).toEqual(terms);
    spy.mockClear();
    expect(search(value, 'axx').map((hit) => hit.id)).toEqual([1, 2]);
    expect(spy.mock.calls.some(([term]) => term === 'axx')).toBe(true);
  });
});

describe('opt-in subtree node search', () => {
  const options = { kind: 'nodes', matchScope: 'subtree' } as const;
  function tree() {
    return [
      document(1, { title: 'Parent' }),
      document(2, {
        rootId: 1,
        title: 'Alpha',
        description: 'detailneedle',
        order: { filePath: 'a.md', line: 0, childLines: [2] },
      }),
      document(3, {
        rootId: 1,
        title: 'Beta',
        comments: 'commentneedle',
        order: { filePath: 'a.md', line: 0, childLines: [2, 4] },
      }),
      document(4, {
        rootId: 1,
        title: 'Unrelated',
        order: { filePath: 'a.md', line: 0, childLines: [6] },
      }),
      document(5, {
        rootId: 1,
        tags: 'siblingtag',
        order: { filePath: 'a.md', line: 0, childLines: [6, 4] },
      }),
    ];
  }
  it('uses exact ancestry and AND coverage without ancestor or sibling leakage', () => {
    const value = engine(tree());
    for (const matchScope of [undefined, 'node'] as const)
      expect(
        search(value, 'commentneedle', {
          kind: 'nodes',
          ...(matchScope === undefined ? {} : { matchScope }),
        }),
      ).toEqual([]);
    expect(
      search(value, 'commentneedle', options)
        .map((h) => h.id)
        .sort((a, b) => a - b),
    ).toEqual([1, 2, 3]);
    expect(
      search(value, 'detailneedle', options)
        .map((h) => h.id)
        .sort((a, b) => a - b),
    ).toEqual([1, 2]);
    expect(
      search(value, 'Alpha commentneedle', options)
        .map((h) => h.id)
        .sort((a, b) => a - b),
    ).toEqual([1, 2]);
    expect(search(value, 'Parent commentneedle', options).map((h) => h.id)).toEqual([1]);
    expect(search(value, 'siblingtag commentneedle', options).map((h) => h.id)).toEqual([1]);
    expect(search(value, 'commentneedle').map((h) => h.id)).toEqual([1]);
  });
  it.each(['description', 'comments', 'tags', 'metadata', 'links', 'sourcePath'] as const)(
    'searches %s with source path opt-in',
    (field) => {
      const value = engine([document(1, { [field]: 'needle' })]);
      expect(search(value, 'needle', options).map((h) => h.id)).toEqual(
        field === 'sourcePath' ? [] : [1],
      );
      expect(
        search(value, 'needle', { ...options, includeSourcePath: true }).map((h) => h.id),
      ).toEqual([1]);
    },
  );
  it('keeps raw descendant scores independent of depth and matches root scoring', () => {
    const value = engine(tree());
    const hits = search(value, 'commentneedle', options);
    const own = hits.find((h) => h.id === 3)?.score ?? 0;
    expect(own).toBeGreaterThan(0);
    expect(hits.find((h) => h.id === 2)?.score).toBeCloseTo(own * 0.8);
    expect(hits.find((h) => h.id === 1)?.score).toBeCloseTo(own * 0.8);
    const combined = search(value, 'Alpha commentneedle', options);
    expect(combined.find((h) => h.id === 1)?.score).toBeCloseTo(
      search(value, 'Alpha commentneedle')[0]?.score ?? 0,
    );
  });
  it('caps wide subtree contributions and keeps exact-title relevance ahead of file preference', () => {
    const value = engine([
      document(1, { title: 'needle' }),
      ...Array.from({ length: 20 }, (_, index) =>
        document(index + 2, {
          rootId: 1,
          title: 'needle',
          order: { filePath: 'a.md', line: 0, childLines: [index + 1] },
        }),
      ),
      document(100, { title: 'needlf', order: { filePath: 'b.md', line: 0, childLines: [] } }),
    ]);
    const hits = search(value, 'needle', { ...options, preferFilePath: 'b.md' });
    const own = search(value, 'needle', { kind: 'nodes' }).find((hit) => hit.id === 1)?.score ?? 0;
    expect(hits[0]?.id).toBe(1);
    expect(hits[0]?.score).toBeCloseTo(2 * own);
    expect(hits[0]?.score).toBeCloseTo(search(value, 'needle')[0]?.score ?? 0);
    expect(hits[hits.length - 1]?.id).toBe(100);
  });
  it('resolves unordered batches, removes old ancestry and restricts files', async () => {
    const value = engine([]);
    const docs = tree();
    value.replaceBegin('a.md');
    for (const doc of [...docs].reverse()) value.add([doc]);
    value.replaceCommit('a.md');
    expect(
      search(value, 'commentneedle', options)
        .map((h) => h.id)
        .sort((a, b) => a - b),
    ).toEqual([1, 2, 3]);
    value.add([
      document(20, {
        comments: 'commentneedle',
        order: { filePath: 'b.md', line: 0, childLines: [] },
      }),
    ]);
    expect(
      search(value, 'commentneedle', { ...options, filePath: 'b.md' }).map((h) => h.id),
    ).toEqual([20]);
    value.replaceBegin('a.md');
    value.add([document(10, { title: 'Replacement' })]);
    value.replaceCommit('a.md');
    expect(search(value, 'commentneedle', options).map((h) => h.id)).toEqual([20]);
    value.remove('b.md');
    await value.vacuum();
    expect(search(value, 'commentneedle', options)).toEqual([]);
    expect(search(value, '', options).map((h) => h.id)).toEqual([10]);
  });
});
