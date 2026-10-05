import { expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import type { TaskSearchEvidence, TaskSearchTreeNode } from '../src/tasks';
import { fallbackSearchWords, prepareSearchQuery } from '../src/tasks/domain/searchMatchPolicy';
import { taskSearchContext } from '../src/tasks/infrastructure/search/taskSearchContext';
import { expectDefined } from './helpers';
import { createCanonicalSearchHarness } from './support/taskSearchHarness';

const markdown = [
  '- [ ] **bud**get [[HiddenLedger|Visible alias]]',
  String.raw`  - > escaped \*budget\* and \`budget\``,
  '  - 2026-10-04: first budget comment',
  '  - 2026-10-04: second budget comment',
]
  .join('\n')
  .replaceAll('\\`', '`');

function allEvidence(tree: TaskSearchTreeNode): TaskSearchEvidence[] {
  return [...tree.evidence, ...tree.children.flatMap(allEvidence)];
}

async function pipeline(query: string, text = markdown) {
  const h = await createCanonicalSearchHarness({ 'a.md': text }, structuredClone(DEFAULT_SETTINGS));
  const signal = new AbortController().signal;
  const cursor = await h.search.open({ kind: 'roots', query }, signal);
  const page = await h.search.read(cursor, 0, 50, signal);
  expect(page.hits).toHaveLength(1);
  const hydrated = expectDefined((await h.search.resolveHits(page.hits, signal))[0]);
  return {
    ...h,
    hydrated,
    context: taskSearchContext(
      hydrated.task.root,
      hydrated.hit.address,
      prepareSearchQuery(query, fallbackSearchWords),
      fallbackSearchWords,
    ),
  };
}

it('proves split title source and complete escaped description through real retrieval and hydration', async () => {
  const h = await pipeline('budget');
  try {
    const title = expectDefined(allEvidence(h.context.tree).find((e) => e.field === 'title'));
    expect(title.markdown).toBe('**bud**get [[HiddenLedger|Visible alias]]');
    expect(title.matches[0]?.sourceRanges).toEqual([
      { from: 2, to: 5 },
      { from: 7, to: 10 },
    ]);
    const desc = expectDefined(allEvidence(h.context.tree).find((e) => e.field === 'description'));
    expect(desc.markdown).toBe(
      String.raw`escaped \*budget\* and \`budget\``.replaceAll('\\`', '`'),
    );
    expect(
      desc.matches.map((m) =>
        m.sourceRanges.map((r) => desc.markdown?.slice(r.from, r.to)).join(''),
      ),
    ).toEqual(['budget', 'budget']);
    expect(allEvidence(h.context.tree)).toHaveLength(4);
    expect(
      allEvidence(h.context.tree)
        .filter((e) => e.field === 'comment')
        .map((e) => e.commentLine),
    ).toEqual([2, 3]);
  } finally {
    h.close();
  }
});

it('keeps the second repeated comment separate with its exact authored line', async () => {
  const h = await pipeline('second budget');
  try {
    const comment = expectDefined(allEvidence(h.context.tree).find((e) => e.commentLine === 3));
    expect(comment.markdown).toBe('second budget comment');
    expect(comment.provenance).toMatchObject({ type: 'field', field: 'comment', commentLine: 3 });
    expect(comment.matches.map((m) => m.sourceRanges)).toContainEqual([{ from: 7, to: 13 }]);
  } finally {
    h.close();
  }
});

it.each([
  {
    query: 'HiddenLedger',
    field: 'link-target',
    text: 'HiddenLedger',
    ranges: [{ from: 13, to: 25 }],
  },
  { query: 'alias', field: 'title', text: 'budget Visible alias', ranges: [{ from: 34, to: 39 }] },
])(
  'separates $query evidence from the other side of a link',
  async ({ query, field, text, ranges }) => {
    const h = await pipeline(query);
    try {
      expect(allEvidence(h.context.tree)).toHaveLength(1);
      const excerpt = expectDefined(allEvidence(h.context.tree)[0]);
      expect(excerpt.field).toBe(field);
      expect(excerpt.text).toBe(text);
      expect(excerpt.matches[0]?.sourceRanges).toEqual(ranges);
      if (field === 'link-target') {
        expect(excerpt.markdown).toBe('**bud**get [[HiddenLedger|Visible alias]]');
        expect(excerpt.provenance).toMatchObject({ type: 'field', field: 'title' });
      }
    } finally {
      h.close();
    }
  },
);

it('uses actual nested relative lines despite repeated sibling names', async () => {
  const h = await pipeline(
    'needle',
    [
      '- [ ] root',
      '  - > root description',
      '  - [ ] repeated',
      '    - > padding',
      '    - [ ] repeated',
      '      - 2026-10-04: needle here',
      '  - [ ] repeated',
      '    - [ ] needle title',
    ].join('\n'),
  );
  try {
    expect(
      allEvidence(h.context.tree).map((e) => ({
        path: e.address.childLines,
        field: e.field,
        line: e.commentLine,
      })),
    ).toEqual([
      { path: [2, 2], field: 'comment', line: 1 },
      {
        path: [6, 1],
        field: 'title',
        line: undefined,
      },
    ]);
  } finally {
    h.close();
  }
});

it('retains all contributing fields without a coverage cap and retains the whole authored field', async () => {
  const h = await pipeline(
    'needle zebra',
    [
      '- [ ] needle',
      '  - 2026-10-04: needle one',
      '  - 2026-10-04: needle two',
      '  - 2026-10-04: needle three',
      `  - > ${'long unrelated '.repeat(40)}zebra`,
    ].join('\n'),
  );
  try {
    expect(allEvidence(h.context.tree)).toHaveLength(5);
    expect(allEvidence(h.context.tree).map((e) => e.field)).toEqual([
      'title',
      'description',
      'comment',
      'comment',
      'comment',
    ]);
    expect(
      expectDefined(allEvidence(h.context.tree).find((e) => e.field === 'description')).markdown
        ?.length,
    ).toBeGreaterThan(160);
  } finally {
    h.close();
  }
});

it.each([
  ['Cafe\u0301', '- [ ] 😀 **Café**', [{ from: 5, to: 9 }]],
  ['budget', '- [ ] **budjet**', [{ from: 2, to: 8 }]],
] as const)(
  'maps normalized/fuzzy %s to the complete original UTF-16 token',
  async (query, text, ranges) => {
    const h = await pipeline(query, text);
    try {
      expect(allEvidence(h.context.tree)[0]?.matches[0]?.sourceRanges).toEqual(ranges);
    } finally {
      h.close();
    }
  },
);

it('rejects a replaced hit before context can project an unproven field', async () => {
  const h = await createCanonicalSearchHarness(
    { 'a.md': markdown },
    structuredClone(DEFAULT_SETTINGS),
  );
  try {
    const signal = new AbortController().signal;
    const cursor = await h.search.open({ kind: 'roots', query: 'budget' }, signal);
    const page = await h.search.read(cursor, 0, 50, signal);
    h.index.installCommittedContent('a.md', '- [ ] replacement budget');
    await expect(h.search.resolveHits(page.hits, signal)).rejects.toMatchObject({ code: 'stale' });
  } finally {
    h.close();
  }
});

it('keeps second-paragraph and later-child evidence while excluding unrelated fields', async () => {
  const h = await pipeline(
    'budget zebra',
    [
      '- [ ] root',
      '  - > unrelated paragraph',
      '  - > ',
      '  - > second **budget** paragraph',
      '  - 2026-10-04: unrelated comment',
      '  - [ ] zebra',
    ].join('\n'),
  );
  try {
    expect(allEvidence(h.context.tree).map((e) => e.field)).toEqual(['description', 'title']);
    expect(allEvidence(h.context.tree)[0]?.markdown).toBe(
      'unrelated paragraph\n\nsecond **budget** paragraph',
    );
    expect(allEvidence(h.context.tree)[0]?.matches[0]?.sourceRanges).toEqual([
      { from: 30, to: 36 },
    ]);
    expect(allEvidence(h.context.tree)[1]?.address.childLines).toEqual([5]);
  } finally {
    h.close();
  }
});

it('retains scalar metadata without fabricating authored source ranges', async () => {
  const h = await pipeline('2026-11-30', '- [ ] unrelated 📅 2026-11-30');
  try {
    expect(allEvidence(h.context.tree)).toHaveLength(1);
    expect(allEvidence(h.context.tree)[0]?.provenance).toEqual({ type: 'semantic', key: 'due' });
    expect(
      allEvidence(h.context.tree)[0]?.matches.every((match) => match.sourceRanges.length === 0),
    ).toBe(true);
    expect(allEvidence(h.context.tree)[0]?.markdown).toBeUndefined();
  } finally {
    h.close();
  }
});

it('retains early evidence and every later matching child', async () => {
  const h = await pipeline(
    'budget zebra',
    ['- [ ] budget', '  - 2026-10-04: budget comment', '  - [ ] budget', '  - [ ] zebra'].join(
      '\n',
    ),
  );
  try {
    expect(
      allEvidence(h.context.tree).map((excerpt) => ({
        field: excerpt.field,
        lines: excerpt.address.childLines,
      })),
    ).toEqual([
      { field: 'title', lines: [] },
      { field: 'comment', lines: [] },
      { field: 'title', lines: [2] },
      { field: 'title', lines: [3] },
    ]);
  } finally {
    h.close();
  }
});

it('maps repeated link labels to their own full-field occurrences', async () => {
  const h = await pipeline('budget', '- [ ] [[One|budget]] [[Two|budget]]');
  try {
    expect(allEvidence(h.context.tree)[0]?.matches.map((match) => match.sourceRanges)).toEqual([
      [{ from: 6, to: 12 }],
      [{ from: 21, to: 27 }],
    ]);
    expect(allEvidence(h.context.tree)[0]?.markdown).toBe('[[One|budget]] [[Two|budget]]');
  } finally {
    h.close();
  }
});

it('retains full fragmented field provenance while choosing later distinct-token evidence', async () => {
  const count = 512;
  const field = '**needle** '.repeat(count).trimEnd();
  const h = await pipeline(
    'needle zebra',
    ['- [ ] needle', `  - > ${field}`, '  - 2026-10-04: needle', '  - 2026-10-04: zebra'].join(
      '\n',
    ),
  );
  try {
    expect(
      allEvidence(h.context.tree).map((excerpt) => [excerpt.field, excerpt.commentLine]),
    ).toEqual([
      ['title', undefined],
      ['description', undefined],
      ['comment', 2],
      ['comment', 3],
    ]);
    const description = expectDefined(allEvidence(h.context.tree)[1]);
    expect(description.markdown).toBe(field);
    expect(description.text).toBe('needle '.repeat(count).trimEnd());
    expect(description.matches).toHaveLength(count);
    for (const [index, match] of description.matches.entries()) {
      expect(match).toMatchObject({
        start: index * 7,
        end: index * 7 + 6,
        sourceRanges: [{ from: index * 11 + 2, to: index * 11 + 8 }],
      });
    }
  } finally {
    h.close();
  }
});

it('retains every matched field and exact ancestor chain in source order', async () => {
  const h = await pipeline(
    'needle',
    [
      '- [ ] root',
      '  - > unrelated description',
      '  - 2026-10-04: first needle',
      '  - [ ] repeated',
      '    - [ ] repeated',
      '      - 2026-10-04: deep needle',
      '  - 2026-10-04: last needle',
      '  - [ ] repeated',
      '    - > fourth needle field',
      '  - [ ] unrelated branch',
    ].join('\n'),
  );
  try {
    const tree = h.context.tree;
    expect(tree.address.childLines).toEqual([]);
    expect(tree.children.map((n) => n.address.childLines)).toEqual([[3], [7]]);
    expect(tree.children[0]?.children[0]?.address.childLines).toEqual([3, 1]);
    expect(tree.evidence.filter((e) => e.field === 'comment').map((e) => e.commentLine)).toEqual([
      2, 6,
    ]);
    expect(tree.evidence.some((e) => e.field === 'description')).toBe(false);
  } finally {
    h.close();
  }
});

it('returns an empty root tree for a match-all query without inventing field evidence', async () => {
  const h = await pipeline('root', '- [ ] root\n  - [ ] child\n  - > description');
  try {
    const context = taskSearchContext(
      h.hydrated.task.root,
      h.hydrated.hit.address,
      prepareSearchQuery('', fallbackSearchWords),
      fallbackSearchWords,
    );
    expect(context.tree.address.childLines).toEqual([]);
    expect(context.tree.evidence).toEqual([]);
    expect(context.tree.children).toEqual([]);
  } finally {
    h.close();
  }
});

it.each([
  ['needle-id', '- [ ] root 🆔 needle-id', 'dependencyId', 'needle-id'],
  ['needle-dep', '- [ ] root\n  - [ ] child ⛔ needle-dep', 'dependsOn', 'needle-dep'],
  ['90', '- [ ] root ⏱️ 1h30m', 'duration', '90'],
  ['1h30m', '- [ ] root ⏱️ 1h30m', 'duration', '1h30m'],
] as const)(
  'retrieves contributing scalar %s with semantic evidence and no edit ranges',
  async (query, source, key, text) => {
    const h = await pipeline(query, source);
    try {
      const evidence = allEvidence(h.context.tree);
      expect(evidence).toHaveLength(1);
      expect(evidence[0]).toMatchObject({
        field: 'metadata',
        text,
        provenance: { type: 'semantic', key },
      });
      expect(evidence[0]?.matches.every((m) => m.sourceRanges.length === 0)).toBe(true);
    } finally {
      h.close();
    }
  },
);
