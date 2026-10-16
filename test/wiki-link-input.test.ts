import { describe, expect, it } from 'vitest';
import { wikiLinkInputRange } from '../src/ui/wikiLinkInput';

describe('task wiki-link input range', () => {
  it.each([
    ['[[', 2, { from: 0, to: 2, query: '' }],
    ['Before [[Al]] after', 11, { from: 7, to: 13, query: 'Al' }],
    ['[[Alpha]] suffix', 4, { from: 0, to: 9, query: 'Al' }],
    ['😀 [[東京', 7, { from: 3, to: 7, query: '東京' }],
    ['[[one]] [[tw', 12, { from: 8, to: 12, query: 'tw' }],
    ['text\n[[new', 10, { from: 5, to: 10, query: 'new' }],
    ['`code` [[A', 10, { from: 7, to: 10, query: 'A' }],
  ])('finds only the current range in %s', (value, cursor, expected) => {
    expect(wikiLinkInputRange(value, cursor, cursor)).toEqual(expected);
  });

  it.each([
    String.raw`\[[Al`,
    '`[[Al',
    '``[[Al',
    '```md\n[[Al',
    '~~~\n[[Al',
    '> ```\n> [[Al',
    '[[Note|Alias',
    '[[Note#Heading',
    '[[closed]]',
    '[[line\nbreak',
    'plain',
  ])('does not complete protected or finished text: %s', (value) => {
    expect(wikiLinkInputRange(value, value.length, value.length)).toBeUndefined();
  });

  it('does not replace an explicit selection or a manually entered suffix', () => {
    expect(wikiLinkInputRange('[[Al', 2, 4)).toBeUndefined();
    expect(wikiLinkInputRange('[[Al#Heading]]', 4, 4)).toBeUndefined();
    expect(wikiLinkInputRange('[[Al|Alias]]', 4, 4)).toBeUndefined();
  });
});
