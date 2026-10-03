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
