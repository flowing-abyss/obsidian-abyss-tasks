import { describe, expect, it } from 'vitest';
import { atomDateTime } from '../../src/tasks/domain/commentTimestamp';
import { TaskBlockEditor } from '../../src/tasks/infrastructure/markdown/TaskBlockEditor';
import { TaskLocator } from '../../src/tasks/infrastructure/markdown/TaskLocator';

describe('TaskBlockEditor', () => {
  it('rejects multiline roots and malformed aggregates without changing a destination', () => {
    const editor = new TaskBlockEditor();

    expect(editor.insertRoot('', '- [ ] root\n- [ ] second', { type: 'append' })).toBeUndefined();
    expect(
      editor.insertRootBlock('', '- [ ] root\nplain sibling', { type: 'append' }),
    ).toBeUndefined();
  });

  it('rejects deletion when the referenced root range is outside current content', () => {
    expect(
      new TaskBlockEditor().deleteRoot('- [ ] current', {
        line: 3,
        toLine: 4,
        source: '- [ ] stale',
      }),
    ).toBeUndefined();
  });

  it('creates a missing section after blank content without adding a second spacer', () => {
    expect(
      new TaskBlockEditor().insertRootBlock('\n', '- [ ] task', {
        type: 'section',
        heading: '## Tasks',
      })?.content,
    ).toBe('\n## Tasks\n- [ ] task\n');
  });

  it('removes the preceding line ending with a final root that has no ending', () => {
    const editor = new TaskBlockEditor();
    const source = 'note\n- [ ] final';

    expect(editor.deleteRoot(source, editor.rootBlocks(source)[0]!)).toBe('note');
  });

  it.each([
    [
      'append mode',
      '# Note\n\nbody',
      '- [ ] task',
      { type: 'append' } as const,
      '# Note\n\nbody\n- [ ] task',
    ],
    [
      'an existing section',
      '# Note\n## Tasks\n- [ ] existing\n## Notes\nblah',
      '- [ ] task',
      { type: 'section', heading: '## Tasks' } as const,
      '# Note\n## Tasks\n- [ ] task\n- [ ] existing\n## Notes\nblah',
    ],
    [
      'a newly-created section',
      '# Note\nbody',
      '- [ ] task',
      { type: 'section', heading: '## Tasks' } as const,
      '# Note\nbody\n\n## Tasks\n- [ ] task',
    ],
    [
      'a blank section name falling back to append',
      'body',
      '- [ ] task',
      { type: 'section', heading: '   ' } as const,
      'body\n- [ ] task',
    ],
    [
      'a contiguous task aggregate',
      '## Tasks\nexisting',
      '- [ ] parent\n\t- [ ] child',
      { type: 'section', heading: '## Tasks' } as const,
      '## Tasks\n- [ ] parent\n\t- [ ] child\nexisting',
    ],
  ])('inserts a root block through %s', (_case, source, block, insertion, expected) => {
    expect(new TaskBlockEditor().insertRootBlock(source, block, insertion)?.content).toBe(expected);
  });

  it.each([
    [
      'a parent and its complete nested range without touching the following root',
      '- [ ] parent\n  - [ ] child\n- [ ] sibling',
      0,
      '- [ ] sibling',
    ],
    [
      'a blockquote parent and its quoted descendants',
      '> - [ ] parent\n> \t- [ ] child\n> \t- [ ] child2\n> - [ ] sibling',
      0,
      '> - [ ] sibling',
    ],
    [
      'one flat blockquote task while preserving its siblings',
      '> - [ ] A\n> - [ ] B\n> - [ ] C',
      1,
      '> - [ ] A\n> - [ ] C',
    ],
    [
      'a quoted task without consuming the following plain-list aggregate',
      '> - [ ] quoted\n- [ ] plain next\n  - [ ] plain sub',
      0,
      '- [ ] plain next\n  - [ ] plain sub',
    ],
  ])('deletes %s', (_case, source, rootIndex, expected) => {
    const editor = new TaskBlockEditor();
    const block = editor.rootBlocks(source)[rootIndex];

    expect(block).toBeDefined();
    expect(editor.deleteRoot(source, block!)).toBe(expected);
  });

  it('keeps the complete root aggregate and CRLF when replacing its task line', () => {
    const editor = new TaskBlockEditor();
    const source = '- [ ] root\r\n  - description\r\n  - [ ] child\r\n- [ ] next\r\n';
    const blocks = editor.rootBlocks(source);

    expect(blocks.map((block) => block.source)).toEqual([
      '- [ ] root\r\n  - description\r\n  - [ ] child',
      '- [ ] next',
    ]);
    expect(editor.replaceLine(source, blocks[0]!, 0, '- [ ] changed').content).toBe(
      '- [ ] changed\r\n  - description\r\n  - [ ] child\r\n- [ ] next\r\n',
    );
  });

  it('ends a root revision at the first non-child structural boundary', () => {
    const editor = new TaskBlockEditor();
    const blocks = editor.rootBlocks('- [ ] root\n  - [ ] child\n## heading\n- [ ] next\n');

    expect(blocks.map((block) => block.source)).toEqual([
      '- [ ] root\n  - [ ] child',
      '- [ ] next',
    ]);
  });

  it('applies structural edits synchronously while preserving the file newline boundary', () => {
    const editor = new TaskBlockEditor();
    const source = '- [ ] root\n  - > description';
    const block = editor.rootBlocks(source)[0]!;
    const target = {
      relativeLine: 0,
      lineCount: 2,
      childRanges: [],
      description: 'description',
    };

    const cleared = editor.edit(source, block, target, {
      type: 'set-description',
      text: null,
    });
    expect(cleared).toMatchObject({ type: 'changed', content: '- [ ] root' });

    const changed = cleared.type === 'changed' ? cleared : undefined;
    const added = editor.edit(
      changed!.content,
      changed!.block,
      { relativeLine: 0, lineCount: 1, childRanges: [] },
      {
        type: 'add-comment',
        text: 'note',
        stamp: atomDateTime('2026-07-14T12:34:56+07:00'),
      },
    );
    expect(added).toMatchObject({
      type: 'changed',
      content: '- [ ] root\n  - 2026-07-14T12:34:56+07:00: note',
    });
  });

  it.each([
    '2026-07-13',
    '2026-07-13T10:20:30Z',
    '2026-07-13T10:20:30.123Z',
    '2026-07-13T17:20:30+07:00',
  ])('preserves the exact %s prefix while updating comment text', (stamp) => {
    const editor = new TaskBlockEditor();
    const source = `- [ ] root\n  - ${stamp}: old`;
    const block = editor.rootBlocks(source)[0]!;
    const result = editor.edit(
      source,
      block,
      { relativeLine: 0, lineCount: 2, childRanges: [] },
      {
        type: 'update-comment',
        relativeLine: 1,
        originalMarkdown: `  - ${stamp}: old`,
        text: 'new',
      },
    );

    expect(result).toMatchObject({ type: 'changed', content: `- [ ] root\n  - ${stamp}: new` });
  });

  it('does not consume an invalid Atom-looking prefix when editing an undated comment', () => {
    const editor = new TaskBlockEditor();
    const source = '- [ ] root\n  - 2026-07-13T25:20:30Z: old';
    const block = editor.rootBlocks(source)[0]!;
    const result = editor.edit(
      source,
      block,
      { relativeLine: 0, lineCount: 2, childRanges: [] },
      {
        type: 'update-comment',
        relativeLine: 1,
        originalMarkdown: '  - 2026-07-13T25:20:30Z: old',
        text: 'new',
      },
    );

    expect(result).toMatchObject({ type: 'changed', content: '- [ ] root\n  - new' });
  });

  it('refuses a comment edit when relative-line and original-Markdown evidence disagree', () => {
    const editor = new TaskBlockEditor();
    const source = '- [ ] root\r\n  - 2026-07-13: duplicate\r\n  - 2026-07-13: duplicate\r\n';
    const block = editor.rootBlocks(source)[0]!;
    const result = editor.edit(
      source,
      block,
      { relativeLine: 0, lineCount: 3, childRanges: [] },
      {
        type: 'update-comment',
        relativeLine: 2,
        originalMarkdown: '  - 2026-07-13: stale\r',
        text: 'replacement',
      },
    );

    expect(result).toEqual({ type: 'conflict' });
  });

  it('adds a quoted child without changing CRLF or the missing final newline', () => {
    const editor = new TaskBlockEditor();
    const source = '>\t- [ ] root\r\n>\t  - [ ] existing';
    const block = editor.rootBlocks(source)[0]!;
    const result = editor.edit(
      source,
      block,
      { relativeLine: 0, lineCount: 2, childRanges: [{ from: 1, to: 1 }] },
      { type: 'add-subtask', text: 'new [[child]]' },
    );

    expect(result).toMatchObject({
      type: 'changed',
      content: '>\t- [ ] root\r\n>\t  - [ ] existing\r\n>\t  - [ ] new [[child]]',
    });
  });

  it('deletes the exact duplicate child and all of its descendants', () => {
    const editor = new TaskBlockEditor();
    const source =
      '- [ ] root\n' + '  - [ ] duplicate\n' + '    - [ ] descendant\n' + '  - [ ] duplicate\n';
    const block = editor.rootBlocks(source)[0]!;
    const result = editor.edit(
      source,
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
        type: 'delete-subtask',
        relativeLine: 1,
        originalBlock: '  - [ ] duplicate\n    - [ ] descendant',
      },
    );

    expect(result).toMatchObject({
      type: 'changed',
      content: '- [ ] root\n  - [ ] duplicate\n',
    });
  });

  it('reorders only exact immediate-child blocks and preserves mixed indentation', () => {
    const editor = new TaskBlockEditor();
    const source =
      '- [ ] root\r\n' + '\t- [ ] first\r\n' + '\t  - [ ] nested\r\n' + '    - [ ] second\r\n';
    const block = editor.rootBlocks(source)[0]!;
    const result = editor.edit(
      source,
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
          originalBlock: '\t- [ ] first\r\n\t  - [ ] nested',
        },
        target: { relativeLine: 3, originalBlock: '    - [ ] second' },
        placement: 'after',
      },
    );

    expect(result).toMatchObject({
      type: 'changed',
      content:
        '- [ ] root\r\n' + '    - [ ] second\r\n' + '\t- [ ] first\r\n' + '\t  - [ ] nested\r\n',
    });
  });

  it('refuses structural edits whose exact child evidence is stale', () => {
    const editor = new TaskBlockEditor();
    const source = '- [ ] root\n  - [ ] current\n';
    const block = editor.rootBlocks(source)[0]!;

    expect(
      editor.edit(
        source,
        block,
        { relativeLine: 0, lineCount: 2, childRanges: [{ from: 1, to: 1 }] },
        { type: 'delete-subtask', relativeLine: 1, originalBlock: '  - [ ] stale' },
      ),
    ).toEqual({ type: 'conflict' });
  });
});

describe('TaskLocator', () => {
  it('decodes legacy separator-free revisions and rejects non-string JSON payloads', () => {
    const locator = new TaskLocator();

    expect(locator.exactSource('block:"legacy source"')).toBe('legacy source');
    expect(locator.exactSource('block:fingerprint:42')).toBeUndefined();
  });

  it('uses the line hint, recovers unique drift, and reports duplicate exact blocks as ambiguous', () => {
    const locator = new TaskLocator(() => 'same-fingerprint');
    const editor = new TaskBlockEditor();
    const original = editor.rootBlocks('- [ ] wanted\n')[0]!;
    const ref = { filePath: 'tasks.md', line: 0, revision: locator.revision(original.source) };

    expect(locator.locate(editor.rootBlocks('- [ ] wanted\n'), ref)).toMatchObject({
      type: 'exact',
    });
    expect(locator.locate(editor.rootBlocks('heading\n- [ ] wanted\n'), ref)).toMatchObject({
      type: 'exact',
      block: { line: 1 },
    });
    expect(locator.locate(editor.rootBlocks('- [ ] wanted\n- [ ] wanted\n'), ref)).toMatchObject({
      type: 'ambiguous',
      blocks: [{ line: 0 }, { line: 1 }],
    });
  });

  it('never authorizes a write from a colliding fingerprint without exact source confirmation', () => {
    const locator = new TaskLocator(() => 'collision');
    const editor = new TaskBlockEditor();
    const first = editor.rootBlocks('- [ ] first\n')[0]!;
    const second = editor.rootBlocks('- [ ] second\n')[0]!;
    const ref = { filePath: 'tasks.md', line: 0, revision: locator.revision(first.source) };

    expect(locator.revision(first.source)).not.toBe(locator.revision(second.source));
    expect(locator.locate([second], ref)).toEqual({ type: 'conflict', block: second });
  });
});
