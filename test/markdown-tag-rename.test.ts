import { describe, expect, it } from 'vitest';
import { extractMarkdownBodyTags, transformMarkdownTags } from '../src/markdown/markdownTagRename';

describe('Markdown body tags after a hash mark', () => {
  it('skips a tag that starts right after another hash mark', () => {
    expect(extractMarkdownBodyTags('##a #b')).toEqual(['#b']);
  });

  it('reads a tag right after a letter or another tag, and skips one in inline code', () => {
    expect(extractMarkdownBodyTags('##a #b `#c` C#d #e#f')).toEqual(['#b', '#d', '#e', '#f']);
  });

  it.each([
    ['exact', '##work #work', '##work #job'],
    ['exact', '##work #work #work/dev', '##work #job #work/dev'],
    ['prefix', '##work #work #work/dev #workx', '##work #job #job/dev #workx'],
  ] as const)(
    'renames only tags that follow no hash mark in %s scope: %j',
    (scope, source, expected) => {
      expect(transformMarkdownTags(source, '#work', '#job', scope)).toBe(expected);
    },
  );
});
