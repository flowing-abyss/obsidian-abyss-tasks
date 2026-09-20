import { describe, expect, it, vi } from 'vitest';
import { atomDateTime } from '../../src/tasks/domain/commentTimestamp';
import {
  TaskBlockEditor,
  type TaskBlockEdit,
  type TaskBlockTarget,
  type TaskIndentUnit,
} from '../../src/tasks/infrastructure/markdown/TaskBlockEditor';
import { TaskMarkdownCodec } from '../../src/tasks/infrastructure/markdown/TaskMarkdownCodec';
import { canonicalStatusCatalog, expectDefined } from '../helpers';

function written(
  source: string,
  edit: TaskBlockEdit,
  target: TaskBlockTarget,
  editor = new TaskBlockEditor(),
): string {
  const result = editor.edit(source, expectDefined(editor.rootBlocks(source)[0]), target, edit);
  if (result.type !== 'changed') throw new Error(`Expected changed, received ${result.type}`);
  return result.content;
}

const stamp = atomDateTime('2026-09-20T12:00:00+07:00');
const additions: ReadonlyArray<{ name: string; edit: TaskBlockEdit; line: string }> = [
  { name: 'comment', edit: { type: 'add-comment', stamp, text: 'note' }, line: `- ${stamp}: note` },
  { name: 'subtask', edit: { type: 'add-subtask', text: 'child' }, line: '- [ ] child' },
  { name: 'entry', edit: { type: 'add-time-entry', stamp }, line: `- ${stamp} →` },
  { name: 'description', edit: { type: 'set-description', text: 'details' }, line: '- > details' },
];

describe('native nested indentation', () => {
  it.each(additions)('defaults a childless root and subtask to TAB for $name', ({ edit, line }) => {
    for (const ending of ['\n', '\r\n']) {
      for (const final of ['', ending]) {
        // A lone root without a final newline has no CRLF evidence to infer.
        if (final !== '' || ending === '\n') {
          expect(
            written(`- [ ] root${final}`, edit, {
              relativeLine: 0,
              lineCount: 1,
              childRanges: [],
            }),
          ).toBe(`- [ ] root${ending}\t${line}${final}`);
        }
        const source = `- [ ] root${ending}\t- [ ] owner${final}`;
        expect(
          written(source, edit, {
            relativeLine: 1,
            lineCount: 1,
            childRanges: [],
          }),
        ).toBe(`- [ ] root${ending}\t- [ ] owner${ending}\t\t${line}${final}`);
      }
    }
  });

  it.each(['  ', '    ', '\t'])('preserves existing immediate child prefix %j', (prefix) => {
    const source = `- [ ] root\n\n${prefix}- [ ] existing\n`;
    expect(
      written(
        source,
        { type: 'add-comment', stamp, text: 'note' },
        {
          relativeLine: 0,
          lineCount: 3,
          childRanges: [{ from: 2, to: 2 }],
        },
      ),
    ).toBe(`${source}${prefix}- ${stamp}: note\n`);
  });

  it('retains each replaced description prefix and derives new lines before removal', () => {
    const source = '- [ ] root\r\n\t- > first\r\n    - > second\r\n\t- [ ] child';
    expect(
      written(
        source,
        {
          type: 'set-description',
          text: 'changed first\nchanged second\nadded',
        },
        {
          relativeLine: 0,
          lineCount: 4,
          childRanges: [{ from: 3, to: 3 }],
          description: 'first\nsecond',
        },
      ),
    ).toBe(
      '- [ ] root\r\n\t- > changed first\r\n    - > changed second\r\n\t- > added\r\n\t- [ ] child',
    );
  });

  it.each(['\t', '    '])('preserves a sole description prefix %j', (prefix) => {
    expect(
      written(
        `- [ ] root\n${prefix}- > old`,
        {
          type: 'set-description',
          text: 'updated',
        },
        {
          relativeLine: 0,
          lineCount: 2,
          childRanges: [],
          description: 'old',
        },
      ),
    ).toBe(`- [ ] root\n${prefix}- > updated`);
  });

  it('captures the provider once per write and observes changes on the next write', () => {
    let unit: TaskIndentUnit = '\t';
    const provider = vi.fn(() => unit);
    const editor = new TaskBlockEditor(provider);
    const target = { relativeLine: 0, lineCount: 1, childRanges: [] };
    const edit = { type: 'set-description', text: 'one\ntwo' } as const;
    expect(written('- [ ] root\n', edit, target, editor)).toBe(
      '- [ ] root\n\t- > one\n\t- > two\n',
    );
    expect(provider).toHaveBeenCalledTimes(1);
    unit = '    ';
    expect(written('- [ ] root\n', edit, target, editor)).toBe(
      '- [ ] root\n    - > one\n    - > two\n',
    );
    expect(provider).toHaveBeenCalledTimes(2);
  });

  it.each(additions)('uses four spaces for a childless quoted owner: $name', ({ edit, line }) => {
    const editor = new TaskBlockEditor(() => '    ');
    expect(
      written(
        '> - [ ] root\r\n',
        edit,
        {
          relativeLine: 0,
          lineCount: 1,
          childRanges: [],
        },
        editor,
      ),
    ).toBe(`> - [ ] root\r\n>     ${line}\r\n`);
  });

  it.each(['blocked-by', 'blocks'] as const)(
    'shares native indentation for linked creation: %s',
    (direction) => {
      for (const unit of ['\t', '    '] as const) {
        const provider = vi.fn(() => unit);
        const editor = new TaskBlockEditor(provider);
        const source = '- [ ] root\r\n\t- [ ] owner';
        const result = editor.createDependencySubtask(
          new TaskMarkdownCodec(canonicalStatusCatalog()),
          source,
          expectDefined(editor.rootBlocks(source)[0]),
          {
            type: 'create-dependency-subtask',
            current: { relativeLine: 1, lineCount: 1, childRanges: [] },
            direction,
            text: 'child',
            currentId: 'owner_id',
            childId: 'child_id',
          },
        );
        expect(result).toMatchObject({
          type: 'changed',
          createdChildRelativeLine: 2,
          content:
            direction === 'blocked-by'
              ? `- [ ] root\r\n\t- [ ] owner ⛔ child_id\r\n\t${unit}- [ ] child 🆔 child_id`
              : `- [ ] root\r\n\t- [ ] owner 🆔 owner_id\r\n\t${unit}- [ ] child ⛔ owner_id`,
        });
        expect(provider).toHaveBeenCalledTimes(1);
      }
    },
  );
});
