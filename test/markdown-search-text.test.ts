import { describe, expect, it } from 'vitest';
import { parseLinks, searchLinkSpans } from '../src/markdown/links';
import { projectSearchText, searchTextSourceRanges } from '../src/markdown/searchText';
import { expectDefined } from './helpers';

describe('shared search text projection', () => {
  it('maps a word split by formatting to disjoint original field ranges', () => {
    const value = projectSearchText('**bud**get', 'title').visible;
    expect(value.text).toBe('budget');
    expect(searchTextSourceRanges(value, { from: 0, to: 6 })).toEqual([
      { from: 2, to: 5 },
      { from: 7, to: 10 },
    ]);
    expect(searchTextSourceRanges(value, { from: 1, to: 4 })).toEqual([
      { from: 3, to: 5 },
      { from: 7, to: 8 },
    ]);
  });
  it.each([
    ['***budget***', 'budget'],
    ['**budget*', '*budget'],
    ['a_b_c', 'a_b_c'],
    ['a*b*c', 'abc'],
    ['a ** b', 'a ** b'],
    ['*a **b** c*', 'a b c'],
    ['~~bud~~get', 'budget'],
    ['\\*budget\\*', '*budget*'],
    ['\\q', '\\q'],
    ['`**bud**`get', '**bud**get'],
    ['`` `bud` ``', '`bud`'],
    ['` a\r\nb `', 'a b'],
    ['`   `', '   '],
    ['`budget', '`budget'],
  ])('projects balanced inline syntax %s', (source, text) => {
    expect(projectSearchText(source, 'title').visible.text).toBe(text);
  });
  it('retains escape and normalized code origins without assigning delimiter ranges', () => {
    const value = projectSearchText('\\* ` a\r\nb `', 'title').visible;
    expect(value.text).toBe('* a b');
    expect(searchTextSourceRanges(value, { from: 0, to: 1 })).toEqual([{ from: 0, to: 2 }]);
    expect(searchTextSourceRanges(value, { from: 3, to: 4 })).toEqual([{ from: 6, to: 8 }]);
  });
  it('keeps visible aliases separate from independently mapped destinations', () => {
    const source = '[**bud**get](ledger) [[Folder/Note.md#Heading| Alias ]]';
    const result = projectSearchText(source, 'title');
    expect(result.visible.text).toBe('budget Alias');
    expect(result.destinations.map((value) => value.text)).toEqual([
      'ledger',
      'Folder/Note.md#Heading',
    ]);
    expect(searchTextSourceRanges(result.visible, { from: 0, to: 6 })).toEqual([
      { from: 3, to: 6 },
      { from: 8, to: 11 },
    ]);
    expect(
      searchTextSourceRanges(expectDefined(result.destinations[0]), { from: 0, to: 6 }),
    ).toEqual([{ from: 13, to: 19 }]);
  });
  it('uses compact embed labels without synthetic decoration or editable occurrences', () => {
    const source = '![[Folder/Note.md#Heading]] ![**literal**](photo.png) [[Other]]';
    expect(projectSearchText(source, 'title').visible.text).toBe('Note#Heading **literal** Other');
    expect(projectSearchText(source, 'title').destinations.map((value) => value.text)).toEqual([
      'Folder/Note.md#Heading',
      'photo.png',
      'Other',
    ]);
    expect(parseLinks(source).map((token) => [token.index, token.target])).toEqual([[54, 'Other']]);
    expect(searchLinkSpans(source).map((span) => span.kind)).toEqual(['embed', 'embed', 'wiki']);
  });
  it('maps an unaliased wiki basename and subpath around the removed extension', () => {
    const value = projectSearchText('[[Folder/Note.md#H]]', 'title').visible;
    expect(value.text).toBe('Note#H');
    expect(searchTextSourceRanges(value, { from: 0, to: 6 })).toEqual([
      { from: 9, to: 13 },
      { from: 16, to: 18 },
    ]);
  });
  it('excludes known prose HTML scaffolding but preserves code and unknown text', () => {
    expect(
      projectSearchText('<span class="secret">budget</span> <!-- hidden --> <unknown', 'prose')
        .visible.text,
    ).toBe('budget  <unknown');
    expect(projectSearchText('`<span>` \\<span>', 'prose').visible.text).toBe('<span> <span>');
  });
  it('never reconstructs links across code spans or escaped starts', () => {
    const result = projectSearchText('`[[Raw]]` \\[label](target)', 'title');
    expect(result.visible.text).toBe('[[Raw]] [label](target)');
    expect(result.destinations).toEqual([]);
  });
});

it('does not index link-shaped values hidden in HTML attributes or comments', () => {
  const result = projectSearchText(
    '<span data-x="[[Hidden]]">visible</span><!-- [[Secret]] -->',
    'prose',
  );
  expect(result.visible.text).toBe('visible');
  expect(result.destinations).toEqual([]);
});
it('recognizes code after an escaped backslash pair', () => {
  const result = projectSearchText('\\\\`**code**`', 'prose');
  expect(result.visible.text).toBe('\\**code**');
});
it('maps UTF-16 visible offsets after emoji in a formatted link label', () => {
  const value = projectSearchText('[😀 **bud**get](target)', 'title').visible;
  expect(value.text).toBe('😀 budget');
  expect(searchTextSourceRanges(value, { from: 3, to: 9 })).toEqual([
    { from: 6, to: 9 },
    { from: 11, to: 14 },
  ]);
});

it('uses authored delimiter flanking around code and link syntax', () => {
  expect(projectSearchText('a*`bud`*get', 'title').visible.text).toBe('a*bud*get');
  expect(projectSearchText('*[ label](target)*', 'title').visible.text).toBe(' label');
});

it.each(['title', 'prose'] as const)(
  'keeps a large literal %s field untruncated with precise interior UTF-16 origins',
  (presentation) => {
    const source = 'word 😀 e\u0301 中文 '.repeat(8192);
    const value = projectSearchText(source, presentation).visible;
    expect(value.text).toBe(source);
    expect(value.map).toEqual([
      { visible: { from: 0, to: source.length }, source: [{ from: 0, to: source.length }] },
    ]);
    expect(searchTextSourceRanges(value, { from: 65537, to: 65555 })).toEqual([
      { from: 65537, to: 65555 },
    ]);
  },
);

it('keeps long code contents literal while mapping normalized newlines and trimmed edge spaces', () => {
  const literal = '**raw** \\* [[Target]] 😀 '.repeat(4096);
  const source = `\` \r\n${literal}\r\nnext\rtail\n \``;
  const value = projectSearchText(source, 'prose').visible;
  expect(value.text).toBe(` ${literal} next tail `);
  expect(searchTextSourceRanges(value, { from: 0, to: 1 })).toEqual([{ from: 2, to: 4 }]);
  expect(searchTextSourceRanges(value, { from: 1, to: 1 + literal.length })).toEqual([
    { from: 4, to: 4 + literal.length },
  ]);
  expect(
    searchTextSourceRanges(value, { from: 1 + literal.length, to: 2 + literal.length }),
  ).toEqual([{ from: 4 + literal.length, to: 6 + literal.length }]);
  expect(
    searchTextSourceRanges(value, { from: value.text.length - 1, to: value.text.length }),
  ).toEqual([{ from: source.length - 3, to: source.length - 2 }]);
  expect(projectSearchText(source, 'prose').destinations).toEqual([]);
});

it('preserves formatting gaps, link-label offsets and code precedence between long prose runs', () => {
  const n = 65536;
  const prose = 'a'.repeat(n);
  const code = 'b'.repeat(n);
  const source = `${prose}**bud**get \` ${code} \` [**la**bel](target)<i>${prose}</i> \\* unmatched*`;
  const result = projectSearchText(source, 'prose');
  expect(result.visible.text).toBe(`${prose}budget ${code} label${prose} * unmatched*`);
  expect(searchTextSourceRanges(result.visible, { from: n - 1, to: n + 6 })).toEqual([
    { from: n - 1, to: n },
    { from: n + 2, to: n + 5 },
    { from: n + 7, to: n + 10 },
  ]);
  expect(searchTextSourceRanges(result.visible, { from: n + 7, to: 2 * n + 7 })).toEqual([
    { from: n + 13, to: 2 * n + 13 },
  ]);
  expect(searchTextSourceRanges(result.visible, { from: 2 * n + 8, to: 2 * n + 13 })).toEqual([
    { from: 2 * n + 19, to: 2 * n + 21 },
    { from: 2 * n + 23, to: 2 * n + 26 },
  ]);
  expect(result.destinations).toEqual([
    {
      text: 'target',
      map: [{ visible: { from: 0, to: 6 }, source: [{ from: 2 * n + 28, to: 2 * n + 34 }] }],
    },
  ]);
});

it('projects a long Markdown label with original-field offsets through the same delimiter pass', () => {
  const label = 'x'.repeat(65536);
  const value = projectSearchText(`before [**${label}**tail](dest)`, 'title').visible;
  expect(value.text).toBe(`before ${label}tail`);
  expect(
    searchTextSourceRanges(value, { from: 7 + label.length - 1, to: value.text.length }),
  ).toEqual([
    { from: 10 + label.length - 1, to: 10 + label.length },
    { from: 12 + label.length, to: 16 + label.length },
  ]);
});
