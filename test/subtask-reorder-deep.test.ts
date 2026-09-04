import { describe, expect, it } from 'vitest';
import { TaskBlockEditor } from '../src/tasks/infrastructure/markdown/TaskBlockEditor';
import { expectDefined } from './helpers';

describe('TaskBlockEditor reorder losslessness', () => {
  it('preserves CRLF, final newline, quotes, and mixed indentation', () => {
    const content =
      '> - [ ] Parent\r\n' +
      '>\t- [ ] Tab child\r\n' +
      '>\t  - > description\r\n' +
      '>   - [ ] Space child\r\n';
    const editor = new TaskBlockEditor();
    const block = expectDefined(editor.rootBlocks(content)[0]);
    const result = editor.edit(
      content,
      block,
      {
        relativeLine: 0,
        lineCount: 4,
        childRanges: [
          { from: 1, to: 2 },
          { from: 3, to: 3 },
        ],
      },
      {
        type: 'reorder-subtask',
        source: {
          relativeLine: 1,
          originalBlock: '>\t- [ ] Tab child\r\n>\t  - > description',
        },
        target: { relativeLine: 3, originalBlock: '>   - [ ] Space child' },
        placement: 'after',
      },
    );

    expect(result).toMatchObject({
      type: 'changed',
      content:
        '> - [ ] Parent\r\n' +
        '>   - [ ] Space child\r\n' +
        '>\t- [ ] Tab child\r\n' +
        '>\t  - > description\r\n',
    });
  });

  it('rejects a range that is not an immediate child of the confirmed parent', () => {
    const content = '- [ ] Parent\n  - [ ] Branch\n    - [ ] Nested\n  - [ ] Sibling';
    const editor = new TaskBlockEditor();
    const block = expectDefined(editor.rootBlocks(content)[0]);

    expect(
      editor.edit(
        content,
        block,
        {
          relativeLine: 0,
          lineCount: 4,
          childRanges: [
            { from: 1, to: 2 },
            { from: 3, to: 3 },
          ],
        },
        {
          type: 'reorder-subtask',
          source: { relativeLine: 2, originalBlock: '    - [ ] Nested' },
          target: { relativeLine: 3, originalBlock: '  - [ ] Sibling' },
          placement: 'after',
        },
      ),
    ).toEqual({ type: 'conflict' });
  });
});
