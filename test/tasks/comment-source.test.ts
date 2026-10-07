// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { readCommentBlock } from '../../src/tasks/domain/commentSource';

describe('owned comment source', () => {
  it('owns all reported tab continuations and uses raw source columns', () => {
    const lines = [
      '\t- 2026-10-07T10:55:39+07:00: head',
      '\t\ttail [[Target|label]]',
      '\t\tthird',
      '\t- neighbor',
    ];
    const block = readCommentBlock(lines, 0, lines.length);
    expect(block?.text).toBe('head\ntail [[Target|label]]\nthird');
    expect(block?.originalMarkdown).toBe(lines.slice(0, 3).join('\n'));
    expect(block?.toExclusive).toBe(3);
    expect(block?.continuationPrefix).toBe('\t\t');
    expect(block?.lines[0]).toMatchObject({
      prefix: '\t- 2026-10-07T10:55:39+07:00: ',
      column: 30,
    });
    expect(block?.lines[1]).toMatchObject({ column: 2, prefix: '\t\t', textFrom: 5 });
  });
  it.each([
    ['  - head', '\ttail', '\t', 'tail'],
    ['  - head', '  \ttail', '  \t', 'tail'],
    ['    - head', '\t  tail', '\t  ', 'tail'],
    [' \t- head', '\t\ttail', '\t\t', 'tail'],
    ['\t - head', '       tail', '       ', 'tail'],
    ['\t- head', '\t  \t payload\t  ', '\t  ', '\t payload\t  '],
    ['> \t- head', '> \t\ttail', '> \t\t', 'tail'],
    ['> \t- head', '>     tail', '>     ', 'tail'],
    ['>\t- head', '> \t  tail', '> \t  ', 'tail'],
    ['>- head', '>\ttail', '>\t', 'tail'],
    ['> >  - head', '>>\t  tail', '>>\t  ', 'tail'],
    ['  >  - head', '>    tail', '>    ', 'tail'],
  ])('decodes %j with %j without inventing payload whitespace', (head, tail, prefix, text) => {
    const block = readCommentBlock([head, tail], 0, 2);
    expect(block).toMatchObject({ text: `head\n${text}`, toExclusive: 2 });
    expect(block?.lines[1]).toMatchObject({ column: prefix.length, prefix, text });
  });
  it.each([
    ['   - head', ' \ttail'],
    ['\t- head', '     tail'],
    ['\t- head', '\ttail'],
    ['> \t- head', '>\ttail'],
    ['> \t- head', '\t\ttail'],
    ['> \t- head', '> > \t\ttail'],
    ['> >  - head', '>    tail'],
    ['> \t- head', '> \t  '],
    ['> \t- head', '>'],
  ])('stops at insufficient indentation or changed quote containers: %j / %j', (head, tail) => {
    expect(readCommentBlock([head, tail, '\t\t  after'], 0, 3)).toMatchObject({
      text: 'head',
      toExclusive: 1,
    });
  });
  it.each([
    '- item',
    '* item',
    '+ item',
    '1. item',
    '12) item',
    '123456789. item',
    '-',
    '*',
    '+',
    '1.',
    '- [ ] child',
    '3) [ ] child',
    '- > description',
    '- 2026-10-06: sibling',
    '- 2026-10-06T12:00:00Z → ...',
    '> quote',
    '# heading',
    '~~~',
    '```',
  ])('stops formatted continuations at structural %j', (payload) => {
    expect(readCommentBlock(['\t- head', `\t\t${payload}`, '\t\tafter'], 0, 3)).toMatchObject({
      text: 'head',
      toExclusive: 1,
    });
  });
  it.each([
    '-word',
    '1234567890. item',
    '####### text',
    '\\- item',
    '2\\. item',
    '\\> quote',
    '---',
    '===',
    '<div>',
    '$$math',
    '%%raw',
    '`code`',
    '\u00a0text',
  ])('retains supported raw, escaped and non-marker payload %j', (payload) => {
    expect(readCommentBlock(['\t- head', `\t\t${payload}`], 0, 2)).toMatchObject({
      text: `head\n${payload}`,
      toExclusive: 2,
    });
  });
  it.each([
    ['>- head', '>  tail', '>  '],
    ['>>- head', '>>  tail', '>>  '],
    ['> >- head', '> >  tail', '> >  '],
    ['  >- head', '  >  tail', '  >  '],
  ])('retains exact legacy quote-container spelling: %j / %j', (head, tail, prefix) => {
    expect(readCommentBlock([head, tail, `${head.slice(0, -4)}neighbor`], 0, 3)).toMatchObject({
      text: 'head\ntail',
      toExclusive: 2,
      continuationPrefix: prefix,
      lines: [{ prefix: head.slice(0, -4) }, { prefix, column: prefix.length, text: 'tail' }],
    });
  });
  it.each([
    ['>- head', '> tail'],
    ['>- head', '>  '],
    ['>- head', '>  - neighbor'],
    ['>- head', '>- neighbor'],
    ['>- head', '> >  tail'],
    ['>- head', '  tail'],
    ['>>- head', '>  tail'],
    ['>>- head', '>>>  tail'],
    ['  >- head', '>  tail'],
    ['> - head', '>  tail'],
  ])('does not expand legacy quote ownership at %j / %j', (head, boundary) => {
    expect(readCommentBlock([head, boundary, `${head.slice(0, -6)}  later`], 0, 3)).toMatchObject({
      text: 'head',
      toExclusive: 1,
    });
  });
  it('stays inside the supplied bound and never resumes below a boundary', () => {
    const lines = ['\t- head', '\t\ttail', '\t\tthird'];
    expect(readCommentBlock(lines, 0, 2)).toMatchObject({ text: 'head\ntail', toExclusive: 2 });
    expect(readCommentBlock([lines[0] ?? '', '', ...lines.slice(1)], 0, 4)).toMatchObject({
      text: 'head',
      toExclusive: 1,
    });
  });
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
