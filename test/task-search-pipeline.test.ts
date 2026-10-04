import { expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
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

async function pipeline(query: string, text = markdown) {
  const h = await createCanonicalSearchHarness({ 'a.md': text }, structuredClone(DEFAULT_SETTINGS));
  const signal = new AbortController().signal;
  const cursor = await h.search.open({ kind: 'roots', query }, signal);
  const page = await h.search.read(cursor, 0, 50, signal);
  expect(page.hits).toHaveLength(1);
  const hydrated = expectDefined((await h.search.resolvePage(page.hits, signal))[0]);
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
    const title = expectDefined(h.context.excerpts.find((e) => e.field === 'title'));
    expect(title.markdown).toBe('**bud**get [[HiddenLedger|Visible alias]]');
    expect(title.matches[0]?.sourceRanges).toEqual([
      { from: 2, to: 5 },
      { from: 7, to: 10 },
    ]);
    const desc = expectDefined(h.context.excerpts.find((e) => e.field === 'description'));
    expect(desc.markdown).toBe(
      String.raw`escaped \*budget\* and \`budget\``.replaceAll('\\`', '`'),
    );
    expect(
      desc.matches.map((m) =>
        m.sourceRanges.map((r) => desc.markdown?.slice(r.from, r.to)).join(''),
      ),
    ).toEqual(['budget', 'budget']);
    expect(h.context.excerpts).toHaveLength(3);
    expect(
      h.context.excerpts.filter((e) => e.field === 'comment').map((e) => e.commentLine),
    ).toEqual([2]);
  } finally {
    h.close();
  }
});

it('keeps the second repeated comment separate with its exact authored line', async () => {
  const h = await pipeline('second budget');
  try {
    const comment = expectDefined(h.context.excerpts.find((e) => e.commentLine === 3));
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
      expect(h.context.excerpts).toHaveLength(1);
      const excerpt = expectDefined(h.context.excerpts[0]);
      expect(excerpt.field).toBe(field);
      expect(excerpt.text).toBe(text);
      expect(excerpt.matches[0]?.sourceRanges).toEqual(ranges);
      if (field === 'link-target') {
        expect(excerpt.markdown).toBeUndefined();
        expect(excerpt.label).toContain('target');
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
      h.context.excerpts.map((e) => ({
        path: e.address.childLines,
        field: e.field,
        line: e.commentLine,
        breadcrumb: e.breadcrumb,
      })),
    ).toEqual([
      { path: [2, 2], field: 'comment', line: 1, breadcrumb: ['root', 'repeated', 'repeated'] },
      {
        path: [6, 1],
        field: 'title',
        line: undefined,
        breadcrumb: ['root', 'repeated', 'needle title'],
      },
    ]);
  } finally {
    h.close();
  }
});

it('prefers distinct term coverage within three fields and retains the whole authored field', async () => {
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
    expect(h.context.excerpts).toHaveLength(3);
    expect(h.context.excerpts.map((e) => e.field)).toEqual(['title', 'description', 'comment']);
    expect(
      expectDefined(h.context.excerpts.find((e) => e.field === 'description')).markdown?.length,
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
      expect(h.context.excerpts[0]?.matches[0]?.sourceRanges).toEqual(ranges);
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
    await expect(h.search.resolvePage(page.hits, signal)).rejects.toMatchObject({ code: 'stale' });
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
    expect(h.context.excerpts.map((e) => e.field)).toEqual(['description', 'title']);
    expect(h.context.excerpts[0]?.markdown).toBe(
      'unrelated paragraph\n\nsecond **budget** paragraph',
    );
    expect(h.context.excerpts[0]?.matches[0]?.sourceRanges).toEqual([{ from: 30, to: 36 }]);
    expect(h.context.excerpts[1]?.address.childLines).toEqual([5]);
  } finally {
    h.close();
  }
});

it('labels scalar metadata without fabricating authored source ranges', async () => {
  const h = await pipeline('2026-11-30', '- [ ] unrelated 📅 2026-11-30');
  try {
    expect(h.context.excerpts).toHaveLength(1);
    expect(h.context.excerpts[0]?.provenance).toEqual({ type: 'semantic', key: 'due' });
    expect(h.context.excerpts[0]?.matches.every((match) => match.sourceRanges.length === 0)).toBe(
      true,
    );
    expect(h.context.excerpts[0]?.markdown).toBeUndefined();
  } finally {
    h.close();
  }
});

it('replaces redundant early evidence with a later child that covers a missing term', async () => {
  const h = await pipeline(
    'budget zebra',
    ['- [ ] budget', '  - 2026-10-04: budget comment', '  - [ ] budget', '  - [ ] zebra'].join(
      '\n',
    ),
  );
  try {
    expect(
      h.context.excerpts.map((excerpt) => ({
        field: excerpt.field,
        lines: excerpt.address.childLines,
      })),
    ).toEqual([
      { field: 'title', lines: [] },
      { field: 'comment', lines: [] },
      { field: 'title', lines: [3] },
    ]);
  } finally {
    h.close();
  }
});

it('maps repeated link labels to their own full-field occurrences', async () => {
  const h = await pipeline('budget', '- [ ] [[One|budget]] [[Two|budget]]');
  try {
    expect(h.context.excerpts[0]?.matches.map((match) => match.sourceRanges)).toEqual([
      [{ from: 6, to: 12 }],
      [{ from: 21, to: 27 }],
    ]);
    expect(h.context.excerpts[0]?.markdown).toBe('[[One|budget]] [[Two|budget]]');
  } finally {
    h.close();
  }
});
