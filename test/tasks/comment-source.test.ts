// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { readCommentBlock } from '../../src/tasks/domain/commentSource';

describe('owned comment source', () => {
  it('keeps exact block bytes and maps logical text to physical columns', () => {
    const lines = [
      '- [ ] Root',
      '\t- 2026-10-06:  first  \r',
      '\t    second\t\r',
      '\t  \\- [ ] literal\r',
      '\t  - [ ] Existing child',
    ];
    expect(readCommentBlock(lines, 1, lines.length)).toMatchObject({
      from: 1,
      toExclusive: 4,
      continuationPrefix: '\t  ',
      headPrefix: '\t- 2026-10-06: ',
      text: ' first  \n  second\t\n\\- [ ] literal',
      originalMarkdown: lines.slice(1, 4).join('\n'),
      lines: [
        { line: 1, column: 15, textFrom: 0, text: ' first  ' },
        { line: 2, column: 3, textFrom: 9, text: '  second\t' },
        { line: 3, column: 3, textFrom: 19, text: '\\- [ ] literal' },
      ],
    });
  });
  it.each([
    '',
    '  ',
    '\ttail',
    '    - [ ] child',
    '    - > description',
    '    - 2026-10-06: adjacent',
    '    > quote',
    '    ## heading',
    '    ```',
    '    2) item',
    '>     quote depth',
  ])('stops at boundary %j', (tail) => {
    expect(readCommentBlock(['  - head', tail, '    after'], 0, 3)).toMatchObject({
      text: 'head',
      toExclusive: 1,
    });
  });
  it.each([
    '- [ ] task',
    '  - > description',
    '  - 2026-10-06T12:00:00Z → 2026-10-06T13:00:00Z',
    'ordinary',
  ])('rejects non-comment %j', (head) => {
    expect(readCommentBlock([head], 0, 1)).toBeUndefined();
  });
  it('preserves quoted instant, undated and malformed historical heads', () => {
    expect(readCommentBlock(['> \t- 2026-10-06T12:00:00Z:  a', '> \t  b'], 0, 2)).toMatchObject({
      text: ' a\nb',
      continuationPrefix: '> \t  ',
      timestamp: { precision: 'instant' },
    });
    expect(readCommentBlock(['  - >'], 0, 1)).toMatchObject({ text: '>' });
    expect(readCommentBlock(['  -  keep  '], 0, 1)).toMatchObject({ text: ' keep  ' });
    expect(readCommentBlock([], 0, 0)).toBeUndefined();
  });
});
