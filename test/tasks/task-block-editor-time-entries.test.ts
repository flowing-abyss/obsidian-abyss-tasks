import { describe, expect, it } from 'vitest';
import { atomDateTime } from '../../src/tasks/domain/commentTimestamp';
import {
  TaskBlockEditor,
  type TaskBlockEdit,
  type TaskBlockEditResult,
  type TaskBlockTarget,
} from '../../src/tasks/infrastructure/markdown/TaskBlockEditor';
import { expectDefined } from '../helpers';

const START = '2026-09-18T14:05:00+03:00';
const END = '2026-09-18T15:05:00+03:00';
const MINIMUM_MS = 60_000;

/** Fixture instants only. The editor itself never reads a clock. */
const instantMs = (atom: string): number => Date.parse(atom);

function editBlock(
  source: string,
  target: TaskBlockTarget,
  edit: TaskBlockEdit,
): TaskBlockEditResult {
  const editor = new TaskBlockEditor();
  return editor.edit(source, expectDefined(editor.rootBlocks(source)[0]), target, edit);
}

function closeEdit(
  relativeLine: number,
  originalMarkdown: string,
  end: string,
  endMs: number,
): TaskBlockEdit {
  return {
    type: 'close-time-entry',
    relativeLine,
    originalMarkdown,
    stamp: atomDateTime(end),
    endMs,
    minimumMs: MINIMUM_MS,
  };
}

describe('TaskBlockEditor time entries', () => {
  it.each([
    [
      'a node that already has a comment and a subtask',
      '- [ ] root\n  - 2026-07-14: note\n  - [ ] child\n',
      { relativeLine: 0, lineCount: 3, childRanges: [{ from: 2, to: 2 }] },
      `- [ ] root\n  - 2026-07-14: note\n  - [ ] child\n  - ${START} →\n`,
    ],
    [
      'a tab-indented CRLF node without a final newline',
      '\t- [ ] root\r\n\t  - [ ] child',
      { relativeLine: 0, lineCount: 2, childRanges: [{ from: 1, to: 1 }] },
      `\t- [ ] root\r\n\t  - [ ] child\r\n\t  - ${START} →`,
    ],
    [
      'a quoted node',
      '> - [ ] root\n>   - 2026-07-14: note\n',
      { relativeLine: 0, lineCount: 2, childRanges: [] },
      `> - [ ] root\n>   - 2026-07-14: note\n>   - ${START} →\n`,
    ],
  ])(
    'opens an entry at the end of %s',
    (...[, source, target, expected]: readonly [string, string, TaskBlockTarget, string]) => {
      expect(
        editBlock(source, target, { type: 'add-time-entry', stamp: atomDateTime(START) }),
      ).toMatchObject({ type: 'changed', content: expected });
    },
  );

  it('opens an entry inside the subtask that owns it', () => {
    const source = '- [ ] root\n  - [ ] child\n    - 2026-07-14: note\n  - [ ] sibling\n';

    expect(
      editBlock(
        source,
        { relativeLine: 1, lineCount: 2, childRanges: [] },
        { type: 'add-time-entry', stamp: atomDateTime(START) },
      ),
    ).toMatchObject({
      type: 'changed',
      content: `- [ ] root\n  - [ ] child\n    - 2026-07-14: note\n    - ${START} →\n  - [ ] sibling\n`,
    });
  });

  it.each([
    ['a canonical open entry', `  - ${START} →`, `  - ${START} → ${END}`],
    [
      'a hand-written entry with a tail',
      '  - 2026-09-18 14:05 → call',
      `  - 2026-09-18 14:05 → ${END} call`,
    ],
  ])('closes %s', (...[, line, expectedLine]: readonly [string, string, string]) => {
    const result = editBlock(
      `- [ ] root\n${line}\n`,
      { relativeLine: 0, lineCount: 2, childRanges: [] },
      closeEdit(1, line, END, instantMs(END)),
    );

    expect(result).toMatchObject({ type: 'changed', content: `- [ ] root\n${expectedLine}\n` });
    expect(result).not.toHaveProperty('discardedShortEntry');
  });

  it('closes an entry in a CRLF file from evidence that carries the carriage return', () => {
    const line = `  - ${START} →`;

    expect(
      editBlock(
        `- [ ] root\r\n${line}\r\n`,
        { relativeLine: 0, lineCount: 2, childRanges: [] },
        closeEdit(1, `${line}\r`, END, instantMs(END)),
      ),
    ).toMatchObject({ type: 'changed', content: `- [ ] root\r\n${line} ${END}\r\n` });
  });

  it.each([
    [59_999, '2026-09-18T14:05:59.999+03:00', true],
    [60_000, '2026-09-18T14:06:00+03:00', false],
  ])(
    'discards a %i ms session only below the minimum',
    (...[durationMs, end, discarded]: readonly [number, string, boolean]) => {
      const line = `  - ${START} →`;
      const result = editBlock(
        `- [ ] root\n${line}\n`,
        { relativeLine: 0, lineCount: 2, childRanges: [] },
        closeEdit(1, line, end, instantMs(START) + durationMs),
      );

      expect(result).toMatchObject(
        discarded
          ? { type: 'changed', content: '- [ ] root\n', discardedShortEntry: true }
          : { type: 'changed', content: `- [ ] root\n  - ${START} → ${end}\n` },
      );
    },
  );

  it('closes a short session that carries a hand-written tail instead of dropping it', () => {
    const line = `  - ${START} \u2192 what I was doing`;
    const end = '2026-09-18T14:05:30+03:00';

    const result = editBlock(
      `- [ ] root\n${line}\n`,
      { relativeLine: 0, lineCount: 2, childRanges: [] },
      closeEdit(1, line, end, instantMs(START) + 30_000),
    );

    expect(result).toMatchObject({
      type: 'changed',
      content: `- [ ] root\n  - ${START} \u2192 ${end} what I was doing\n`,
    });
    expect(result).not.toHaveProperty('discardedShortEntry');
  });

  it('still drops a short session with no tail of its own', () => {
    const line = `  - ${START} \u2192`;
    const end = '2026-09-18T14:05:30+03:00';

    expect(
      editBlock(
        `- [ ] root\n${line}\n`,
        { relativeLine: 0, lineCount: 2, childRanges: [] },
        closeEdit(1, line, end, instantMs(START) + 30_000),
      ),
    ).toMatchObject({ type: 'changed', content: '- [ ] root\n', discardedShortEntry: true });
  });

  it('measures a hand-written start at the offset the closing stamp was written in', () => {
    const line = '  - 2026-09-18 14:05 →';
    const end = '2026-09-18T14:05:59Z';

    expect(
      editBlock(
        `- [ ] root\n${line}\n`,
        { relativeLine: 0, lineCount: 2, childRanges: [] },
        closeEdit(1, line, end, instantMs(end)),
      ),
    ).toMatchObject({ type: 'changed', content: '- [ ] root\n', discardedShortEntry: true });
  });

  it('refuses to close an entry whose position or text no longer matches', () => {
    const line = `  - ${START} →`;
    const source = `- [ ] root\n${line}\n  - [ ] child\n    - ${START} →\n`;
    const target = { relativeLine: 0, lineCount: 4, childRanges: [{ from: 2, to: 3 }] };
    const close = (relativeLine: number, originalMarkdown: string): TaskBlockEditResult =>
      editBlock(source, target, closeEdit(relativeLine, originalMarkdown, END, instantMs(END)));

    expect(close(1, '  - 2026-01-01T00:00:00Z →')).toEqual({ type: 'conflict' });
    expect(close(3, `    - ${START} →`)).toEqual({ type: 'conflict' });
    expect(close(0, '- [ ] root')).toEqual({ type: 'conflict' });
    expect(close(4, line)).toEqual({ type: 'conflict' });
  });

  it.each([
    ['carries no offset at all', '2026-09-18T15:05:00'],
    ['carries an offset outside the legal range', '2026-09-18T15:05:00+15:00'],
  ])('refuses to close an entry when the end stamp %s', (...[, end]: readonly [string, string]) => {
    const line = `  - ${START} →`;

    expect(
      editBlock(
        `- [ ] root\n${line}\n`,
        { relativeLine: 0, lineCount: 2, childRanges: [] },
        closeEdit(1, line, end, instantMs(END)),
      ),
    ).toEqual({ type: 'conflict' });
  });

  it('refuses to close an entry that started after the end instant', () => {
    const line = `  - ${START} →`;

    expect(
      editBlock(
        `- [ ] root\n${line}\n`,
        { relativeLine: 0, lineCount: 2, childRanges: [] },
        closeEdit(1, line, END, instantMs(START) - 1),
      ),
    ).toEqual({ type: 'conflict' });
  });

  it('refuses to close an entry that is already closed', () => {
    const line = `  - ${START} → ${END}`;

    expect(
      editBlock(
        `- [ ] root\n${line}\n`,
        { relativeLine: 0, lineCount: 2, childRanges: [] },
        closeEdit(1, line, END, instantMs(END)),
      ),
    ).toEqual({ type: 'conflict' });
  });

  it('removes an entry line and reports the exact Markdown for undo', () => {
    const line = `  - ${START} → ${END}`;

    expect(
      editBlock(
        `- [ ] root\n${line}\n  - 2026-07-14: note\n`,
        { relativeLine: 0, lineCount: 3, childRanges: [] },
        { type: 'delete-time-entry', relativeLine: 1, originalMarkdown: line },
      ),
    ).toMatchObject({
      type: 'changed',
      content: '- [ ] root\n  - 2026-07-14: note\n',
      removedTimeEntry: { markdown: line, relativeLine: 1 },
    });
  });

  it('refuses to delete a line that is not a time entry', () => {
    const line = '  - 2026-07-14: note';

    expect(
      editBlock(
        `- [ ] root\n${line}\n`,
        { relativeLine: 0, lineCount: 2, childRanges: [] },
        { type: 'delete-time-entry', relativeLine: 1, originalMarkdown: line },
      ),
    ).toEqual({ type: 'conflict' });
  });

  it('restores an entry at its remembered relative line', () => {
    const line = `  - ${START} → ${END}`;

    expect(
      editBlock(
        '- [ ] root\n  - 2026-07-14: note\n',
        { relativeLine: 0, lineCount: 2, childRanges: [] },
        { type: 'restore-time-entry', markdown: line, relativeLine: 1 },
      ),
    ).toMatchObject({
      type: 'changed',
      content: `- [ ] root\n${line}\n  - 2026-07-14: note\n`,
    });
  });

  it.each([
    ['sits past the node', 9],
    ['sits inside a subtask block', 3],
  ])(
    'appends a restored entry verbatim when the remembered line %s',
    (...[, relativeLine]: readonly [string, number]) => {
      const line = `\t- ${START} → ${END}`;
      const source = '- [ ] root\n  - 2026-07-14: note\n  - [ ] child\n    - [ ] grandchild\n';

      expect(
        editBlock(
          source,
          { relativeLine: 0, lineCount: 4, childRanges: [{ from: 2, to: 3 }] },
          { type: 'restore-time-entry', markdown: line, relativeLine },
        ),
      ).toMatchObject({ type: 'changed', content: `${source}${line}\n` });
    },
  );

  it.each([
    ['a plain comment', '  - 2026-07-14: note'],
    ['two lines at once', `  - ${START} →\n  - ${START} →`],
    ['blank text', '   '],
  ])('rejects restoring %s as a time entry', (...[, markdown]: readonly [string, string]) => {
    expect(
      editBlock(
        '- [ ] root\n',
        { relativeLine: 0, lineCount: 1, childRanges: [] },
        { type: 'restore-time-entry', markdown, relativeLine: 1 },
      ),
    ).toEqual({ type: 'invalid', field: 'time-entry' });
  });

  it('keeps a missing final newline when opening and when removing the last entry', () => {
    const line = `  - ${START} →`;

    expect(
      editBlock(
        '- [ ] root',
        { relativeLine: 0, lineCount: 1, childRanges: [] },
        { type: 'add-time-entry', stamp: atomDateTime(START) },
      ),
    ).toMatchObject({ type: 'changed', content: `- [ ] root\n${line}` });

    expect(
      editBlock(
        `- [ ] root\n${line}`,
        { relativeLine: 0, lineCount: 2, childRanges: [] },
        { type: 'delete-time-entry', relativeLine: 1, originalMarkdown: line },
      ),
    ).toMatchObject({
      type: 'changed',
      content: '- [ ] root',
      removedTimeEntry: { markdown: line, relativeLine: 1 },
    });
  });
});

describe('TaskBlockEditor entry indentation', () => {
  it('opens an entry at the indentation the node already uses', () => {
    const source = '- [ ] root\n\t- [ ] existing\n';

    const result = editBlock(
      source,
      { relativeLine: 0, lineCount: 2, childRanges: [{ from: 1, to: 1 }] },
      { type: 'add-time-entry', stamp: atomDateTime(START) },
    );

    expect(result).toMatchObject({ type: 'changed', content: `${source}\t- ${START} →\n` });
  });

  it('opens an entry at two spaces under a node without nested lines', () => {
    const source = '- [ ] root\n';

    const result = editBlock(
      source,
      { relativeLine: 0, lineCount: 1, childRanges: [] },
      { type: 'add-time-entry', stamp: atomDateTime(START) },
    );

    expect(result).toMatchObject({ type: 'changed', content: `${source}  - ${START} →\n` });
  });
});
