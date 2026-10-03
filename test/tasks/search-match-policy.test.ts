import { describe, expect, it, vi } from 'vitest';
import {
  fallbackSearchWords,
  matchSearchText,
  matchesSearchText,
  prepareSearchQuery,
  type SearchWordSegmenter,
} from '../../src/tasks/domain/searchMatchPolicy';
const prepare = (text: string) => prepareSearchQuery(text, fallbackSearchWords);
const matches = (text: string, query: string) =>
  matchesSearchText(text, prepare(query), fallbackSearchWords);

describe('shared multilingual matching policy', () => {
  it.each([
    ['taks', 'task'],
    ['tast', 'task'],
    ['тескт', 'текст'],
    ['abdc', 'abcd'],
    ['bacd', 'abcd'],
    ['acbd', 'abcd'],
  ])('finds bounded typo %s in %s', (query, text) => {
    expect(matches(text, query)).toBe(true);
  });
  it('does not fuzz short words, and prefixes only the final word of length at least two', () => {
    expect(matches('b', 'a')).toBe(false);
    expect(matches('ax', 'ab')).toBe(false);
    expect(matches('abc', 'ab')).toBe(true);
    expect(matches('abc budget', 'ab budget')).toBe(false);
    expect(matches('ab', 'a')).toBe(false);
  });
  it('retains accents while permitting their bounded substitution', () => {
    expect(fallbackSearchWords('cafe café').map((word) => word.text)).toEqual(['cafe', 'café']);
    expect(matches('cafe', 'café')).toBe(true);
    expect(matchSearchText('😀 Cafe\u0301', prepare('CAFÉ'), fallbackSearchWords)).toEqual([
      { start: 3, end: 8, queryToken: 0, exact: true },
    ]);
  });
  it('falls back without Intl with mixed scripts, CJK and combining marks', () => {
    expect(fallbackSearchWords('Hi Мир 中文 日本語 한글 cafe\u0301 😀').map((w) => w.text)).toEqual(
      ['Hi', 'Мир', '中', '文', '日', '本', '語', '한', '글', 'cafe\u0301'],
    );
    expect(matches('Мир 中文', '中文 мир')).toBe(true);
  });
  it('AND-covers distinct tokens and distinguishes blank from nonword queries', () => {
    expect(prepare('task TASK task').tokens).toHaveLength(1);
    expect(matches('task', 'task budget')).toBe(false);
    expect(matches('', ' \n ')).toBe(true);
    expect(matches('anything', '😀!!!')).toBe(false);
  });
  it('counts Unicode points for edits and swaps, retaining UTF-16 offsets', () => {
    const segment: SearchWordSegmenter = (text) => [{ text, start: 0, end: text.length }];
    expect(prepareSearchQuery('😀a', segment).tokens[0]).toMatchObject({
      edits: 0,
      prefix: true,
      swaps: [],
    });
    expect(prepareSearchQuery('😀ab', segment).tokens[0]).toMatchObject({
      edits: 1,
      swaps: ['a😀b', '😀ba'],
    });
    expect(matchesSearchText('𐐀ab', prepareSearchQuery('xab', segment), segment)).toBe(true);
  });
  it('makes tokens over 64 code points exact-only', () => {
    const word = 'a'.repeat(65);
    expect(prepare(word).tokens[0]).toMatchObject({ edits: 0, prefix: false, swaps: [] });
    expect(matches(`${word}a`, word)).toBe(false);
    expect(matches(word, word)).toBe(true);
  });
  it('rejects oversized input before segmentation and enforces distinct-token cap', () => {
    const segment = vi.fn(fallbackSearchWords);
    for (const text of ['x'.repeat(4097), 'x'.repeat(2049), '😀'.repeat(2049)]) {
      expect(() => prepareSearchQuery(text, segment)).toThrow(
        expect.objectContaining({ code: 'invalid-query' }),
      );
    }
    expect(segment).not.toHaveBeenCalled();
    expect(() => prepare('😀'.repeat(2048))).not.toThrow();
    expect(() => prepare(Array.from({ length: 33 }, (_, i) => `word${i}`).join(' '))).toThrow(
      expect.objectContaining({ code: 'invalid-query' }),
    );
    expect(() => prepare('word '.repeat(33))).not.toThrow();
  });
});

it('retains combining marks following a standalone CJK fallback unit', () => {
  expect(fallbackSearchWords('か\u3099次')).toEqual([
    { text: 'か\u3099', start: 0, end: 2 },
    { text: '次', start: 2, end: 3 },
  ]);
});

it.each([
  ['abcd', 'axyd'],
  ['план', 'слон'],
  ['budget', 'xxxbudget'],
  ['a', 'я'],
])('rejects outside-policy neighbor %s in %s', (query, text) => {
  expect(matches(text, query)).toBe(false);
});
