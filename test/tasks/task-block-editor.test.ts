import { describe, expect, it } from 'vitest';
import type { TaskEditCommand } from '../../src/tasks/application/TaskRepository';
import { atomDateTime } from '../../src/tasks/domain/commentTimestamp';
import { applyTaskCommand } from '../../src/tasks/infrastructure/markdown/applyTaskCommand';
import { TaskBlockEditor } from '../../src/tasks/infrastructure/markdown/TaskBlockEditor';
import { TaskLocator } from '../../src/tasks/infrastructure/markdown/TaskLocator';
import { TaskMarkdownCodec } from '../../src/tasks/infrastructure/markdown/TaskMarkdownCodec';
import { canonicalStatusCatalog, expectDefined } from './../helpers';

describe('TaskBlockEditor', () => {
  it('applies dependency metadata to root and subtask lines without touching surrounding bytes', () => {
    const editor = new TaskBlockEditor();
    const codec = new TaskMarkdownCodec(canonicalStatusCatalog());
    const source =
      '- [ ] root 🧩 future ^root\r\n' +
      '  - 2026-07-14T09:30:45+00:00: root comment\r\n' +
      '  - [ ] child 🧲 future ^child\r\n' +
      '    - 2026-07-14: child comment\r\n' +
      '  - [ ] sibling\r\n' +
      '- [ ] neighbor\r\n';
    const rootTarget = {
      type: 'task' as const,
      ref: { filePath: 'tasks.md', line: 0, revision: 'root' },
    };
    const childTarget = {
      type: 'subtask' as const,
      ref: {
        parent: rootTarget,
        relativeLine: 2,
        originalBlock: '  - [ ] child 🧲 future ^child\r\n    - 2026-07-14: child comment',
      },
    };
    const apply = (content: string, relativeLine: number, command: TaskEditCommand): string => {
      const block = expectDefined(editor.rootBlocks(content)[0]);
      const line = expectDefined(content.split(/\r?\n/u)[block.line + relativeLine]);
      const result = applyTaskCommand(codec, line, command);
      expect(result.type).toBe('changed');
      return editor.replaceLine(
        content,
        block,
        relativeLine,
        (result as Extract<typeof result, { readonly type: 'changed' }>).content,
      ).content;
    };

    const withRootId = apply(source, 0, {
      type: 'set-dependency-id',
      target: rootTarget,
      id: 'root_id',
    });
    const withChildDependencies = apply(withRootId, 2, {
      type: 'set-depends-on',
      target: childTarget,
      ids: ['root_id', 'root_id', 'external'],
    });

    expect(withChildDependencies).toBe(
      '- [ ] root 🧩 future 🆔 root_id ^root\r\n' +
        '  - 2026-07-14T09:30:45+00:00: root comment\r\n' +
        '  - [ ] child 🧲 future ⛔ root_id, root_id, external ^child\r\n' +
        '    - 2026-07-14: child comment\r\n' +
        '  - [ ] sibling\r\n' +
        '- [ ] neighbor\r\n',
    );
  });

  it('rejects multiline roots and malformed aggregates without changing a destination', () => {
    const editor = new TaskBlockEditor();

    expect(editor.insertRoot('', '- [ ] root\n- [ ] second', { type: 'append' })).toBeUndefined();
    expect(
      editor.insertRootBlock('', '- [ ] root\nplain sibling', { type: 'append' }),
    ).toBeUndefined();
    expect(editor.insertRoot('', '- [ ] root', { type: 'append' })?.content).toBe('- [ ] root');
  });

  it('rejects empty recurrence subtree replacements without touching the block', () => {
    const editor = new TaskBlockEditor();
    const source = '- [ ] root\n  - [ ] child';
    const block = expectDefined(editor.rootBlocks(source)[0]);

    expect(editor.replaceOwnedTaskSubtree(source, block, 0, [''])).toBeUndefined();
  });

  it('rejects child evidence whose captured range extends beyond current content', () => {
    const editor = new TaskBlockEditor();
    const source = '- [ ] root\n  - [ ] child';
    const block = expectDefined(editor.rootBlocks(source)[0]);

    expect(
      editor.edit(
        source,
        block,
        { relativeLine: 0, lineCount: 2, childRanges: [{ from: 1, to: 2 }] },
        {
          type: 'delete-subtask',
          relativeLine: 1,
          originalBlock: '  - [ ] child\n    - [ ] missing descendant',
        },
      ),
    ).toEqual({ type: 'conflict' });
    expect(
      editor.edit(
        source,
        block,
        { relativeLine: 0, lineCount: 2, childRanges: [{ from: 0, to: 0 }] },
        { type: 'delete-subtask', relativeLine: 0, originalBlock: '- [ ] root' },
      ),
    ).toEqual({ type: 'conflict' });
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

    expect(editor.deleteRoot(source, expectDefined(editor.rootBlocks(source)[0]))).toBe('note');
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
  ])(
    'inserts a root block through %s',
    (
      ...[_case, source, block, insertion, expected]: readonly [
        string,
        string,
        string,
        Parameters<TaskBlockEditor['insertRootBlock']>[2],
        string,
      ]
    ) => {
      expect(new TaskBlockEditor().insertRootBlock(source, block, insertion)?.content).toBe(
        expected,
      );
    },
  );

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
    expect(editor.deleteRoot(source, expectDefined(block))).toBe(expected);
  });

  it('keeps the complete root aggregate and CRLF when replacing its task line', () => {
    const editor = new TaskBlockEditor();
    const source = '- [ ] root\r\n  - description\r\n  - [ ] child\r\n- [ ] next\r\n';
    const blocks = editor.rootBlocks(source);

    expect(blocks.map((block) => block.source)).toEqual([
      '- [ ] root\r\n  - description\r\n  - [ ] child',
      '- [ ] next',
    ]);
    expect(editor.replaceLine(source, expectDefined(blocks[0]), 0, '- [ ] changed').content).toBe(
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
    const block = expectDefined(editor.rootBlocks(source)[0]);
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
      expectDefined(changed).content,
      expectDefined(changed).block,
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
    const block = expectDefined(editor.rootBlocks(source)[0]);
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
    const block = expectDefined(editor.rootBlocks(source)[0]);
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
    const block = expectDefined(editor.rootBlocks(source)[0]);
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
    const block = expectDefined(editor.rootBlocks(source)[0]);
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

  it('rejects a blank subtask before changing the source block', () => {
    const editor = new TaskBlockEditor();
    const source = '- [ ] root\n';
    const block = expectDefined(editor.rootBlocks(source)[0]);

    expect(
      editor.edit(
        source,
        block,
        { relativeLine: 0, lineCount: 1, childRanges: [] },
        { type: 'add-subtask', text: '   ' },
      ),
    ).toEqual({ type: 'invalid', field: 'subtask' });
  });

  it('deletes the exact duplicate child and all of its descendants', () => {
    const editor = new TaskBlockEditor();
    const source =
      '- [ ] root\n' + '  - [ ] duplicate\n' + '    - [ ] descendant\n' + '  - [ ] duplicate\n';
    const block = expectDefined(editor.rootBlocks(source)[0]);
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
    const block = expectDefined(editor.rootBlocks(source)[0]);
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
    const block = expectDefined(editor.rootBlocks(source)[0]);

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
    const original = expectDefined(editor.rootBlocks('- [ ] wanted\n')[0]);
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
    const first = expectDefined(editor.rootBlocks('- [ ] first\n')[0]);
    const second = expectDefined(editor.rootBlocks('- [ ] second\n')[0]);
    const ref = { filePath: 'tasks.md', line: 0, revision: locator.revision(first.source) };

    expect(locator.revision(first.source)).not.toBe(locator.revision(second.source));
    expect(locator.locate([second], ref)).toEqual({ type: 'conflict', block: second });
  });
});
