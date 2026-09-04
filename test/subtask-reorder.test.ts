import { describe, expect, it } from 'vitest';
import { TaskBlockEditor } from '../src/tasks/infrastructure/markdown/TaskBlockEditor';
import { expectDefined } from './helpers';

function reorder(
  content: string,
  source: { relativeLine: number; originalBlock: string },
  target: { relativeLine: number; originalBlock: string },
  placement: 'before' | 'after',
): string {
  const editor = new TaskBlockEditor();
  const block = expectDefined(editor.rootBlocks(content)[0]);
  const sourceLines = source.originalBlock.split(/\r?\n/u).length;
  const targetLines = target.originalBlock.split(/\r?\n/u).length;
  const result = editor.edit(
    content,
    block,
    {
      relativeLine: 0,
      lineCount: block.toLine - block.line + 1,
      childRanges: [
        { from: source.relativeLine, to: source.relativeLine + sourceLines - 1 },
        { from: target.relativeLine, to: target.relativeLine + targetLines - 1 },
      ],
    },
    { type: 'reorder-subtask', source, target, placement },
  );
  if (result.type !== 'changed' && result.type !== 'unchanged') throw new Error(result.type);
  return result.content;
}

describe('TaskBlockEditor subtask reorder', () => {
  it('moves a complete child block down after a later sibling', () => {
    const content = '- [ ] Parent\n  - [ ] First\n    - [ ] Nested\n  - [ ] Second\n  - [ ] Third';
    expect(
      reorder(
        content,
        { relativeLine: 1, originalBlock: '  - [ ] First\n    - [ ] Nested' },
        { relativeLine: 4, originalBlock: '  - [ ] Third' },
        'after',
      ),
    ).toBe('- [ ] Parent\n  - [ ] Second\n  - [ ] Third\n  - [ ] First\n    - [ ] Nested');
  });

  it('moves a child up before an earlier sibling', () => {
    const content = '- [ ] Parent\n  - [ ] First\n  - [ ] Second\n  - [ ] Third\n';
    expect(
      reorder(
        content,
        { relativeLine: 3, originalBlock: '  - [ ] Third' },
        { relativeLine: 1, originalBlock: '  - [ ] First' },
        'before',
      ),
    ).toBe('- [ ] Parent\n  - [ ] Third\n  - [ ] First\n  - [ ] Second\n');
  });

  it('is byte-identical when source and target are the same child', () => {
    const content = '- [ ] Parent\n  - [ ] First\n  - [ ] Second';
    expect(
      reorder(
        content,
        { relativeLine: 1, originalBlock: '  - [ ] First' },
        { relativeLine: 1, originalBlock: '  - [ ] First' },
        'after',
      ),
    ).toBe(content);
  });
});
