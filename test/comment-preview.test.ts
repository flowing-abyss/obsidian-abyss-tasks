import { describe, expect, it } from 'vitest';
import { commentPreview } from '../src/ui/commentPreview';

describe('commentPreview', () => {
  it.each([
    { text: '`[[Hidden]]\ncode` [[Actual]]', markdown: '`[[Hidden]]', fullOccurrences: [-1] },
    { text: '[[First]]\n[[Second]]', markdown: '[[First]]', fullOccurrences: [0] },
    { text: '`[[Same]]\ncode` [[Same]]', markdown: '`[[Same]]', fullOccurrences: [-1] },
    { text: '[[One]] [[One]]\n[[Two]]', markdown: '[[One]] [[One]]', fullOccurrences: [0, 1] },
    { text: 'plain', markdown: 'plain', fullOccurrences: [] },
    { text: 'first\r\nsecond', markdown: 'first', fullOccurrences: [] },
  ])('maps only original source tokens in $text', ({ text, markdown, fullOccurrences }) => {
    expect(commentPreview(text)).toEqual({ markdown, fullOccurrences });
  });
});
