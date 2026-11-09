import { afterEach, expect, it, vi } from 'vitest';
import { TaskBlockEditor } from '../src/tasks/infrastructure/markdown/TaskBlockEditor';
import { CanonicalNoteTaskProtection } from '../src/tasks/infrastructure/obsidian/NoteTaskProtection';
import { expectDefined, flushMicrotasks, metadataChangedEmitter } from './helpers';
import { publicApiHarness, type PublicApiHarness } from './support/publicApiHarness';

const owners: PublicApiHarness[] = [];
afterEach(() => {
  owners.splice(0).forEach((h) => {
    h.dispose();
  });
});
async function setup(content: string) {
  const h = await publicApiHarness({ 'a.md': content });
  owners.push(h);
  const read = await h.index.projectSources().acquire('a.md');
  if (read.type !== 'ok' || read.value === undefined) throw new Error('Missing source');
  return { ...h, source: read.value };
}

it('reuses only the last exact canonical content and keeps returned ranges immutable', async () => {
  const content = '\uFEFFProse🙂\r\n\r\n- [ ] Same\r\n  - [ ] Child\r\n- [ ] Same\r\n';
  const h = await setup(content);
  const protection = new CanonicalNoteTaskProtection(h.app, h.index, h.authority);
  const parse = vi.spyOn(TaskBlockEditor.prototype, 'rootBlocks');
  const first = protection.ranges(content);
  expect(protection.ranges(content)).toEqual(first);
  expect(parse).toHaveBeenCalledTimes(1);
  expect(Object.isFrozen(first)).toBe(true);
  expect(first.every(Object.isFrozen)).toBe(true);
  expect(Reflect.set(expectDefined(first[0]), 'from', 0)).toBe(false);
  const changed = `Extra\r\n${content}`;
  expect(protection.ranges(changed)[0]?.from).toBe(expectDefined(first[0]).from + 7);
  protection.ranges(changed);
  expect(parse).toHaveBeenCalledTimes(2);
  expect(protection.ranges(content)).toEqual(first);
  expect(parse).toHaveBeenCalledTimes(3);
});

it('checks each displaced duplicate task interval with linear candidate reads', async () => {
  const count = 128;
  const prefix = 'Context\n\n';
  const replacement = 'Context\nShift\n\n';
  const tasks = '- [ ] Same\n  - [ ] Child\n'.repeat(count);
  const before = prefix + tasks;
  const after = replacement + tasks;
  const h = await setup(before);
  const protection = new CanonicalNoteTaskProtection(h.app, h.index, h.authority);
  const ranges = protection.ranges.bind(protection);
  let candidateReads = 0;
  vi.spyOn(protection, 'ranges').mockImplementation((content) => {
    const actual = ranges(content);
    if (content !== after) return actual;
    return Object.freeze(
      actual.map((range) =>
        Object.freeze({
          ...range,
          get from() {
            candidateReads++;
            return range.from;
          },
        }),
      ),
    );
  });
  expect(ranges(before)).toHaveLength(count);
  expect(ranges(after)).toHaveLength(count);
  expect(
    protection.preservesAll(before, after, [
      { range: { from: 0, to: prefix.length, kind: 'prose', editable: true }, replacement },
    ]),
  ).toBe(true);
  expect(candidateReads).toBeLessThanOrEqual(count * 4);
});

it.each([
  ['same-length root text', '- [ ] Else\n  - [ ] Child\n- [ ] Same\n  - [ ] Child\n'],
  ['same-length child text', '- [ ] Same\n  - [ ] Other\n- [ ] Same\n  - [ ] Child\n'],
  ['different range end', '- [ ] Longer\n  - [ ] Child\n- [ ] Same\n  - [ ] Child\n'],
  ['different range start', '\n- [ ] Same\n  - [ ] Child\n- [ ] Same\n  - [ ] Child\n'],
  ['missing duplicate', '- [ ] Same\n  - [ ] Child\n'],
  ['extra duplicate', '- [ ] Same\n  - [ ] Child\n'.repeat(3)],
])('rejects %s despite a valid prose displacement', async (_name, candidateTasks) => {
  const prefix = 'Context\n\n';
  const replacement = 'Context\nShift\n\n';
  const before = prefix + '- [ ] Same\n  - [ ] Child\n'.repeat(2);
  const h = await setup(before);
  const protection = new CanonicalNoteTaskProtection(h.app, h.index, h.authority);
  expect(
    protection.preservesAll(before, replacement + candidateTasks, [
      { range: { from: 0, to: prefix.length, kind: 'prose', editable: true }, replacement },
    ]),
  ).toBe(false);
});

it('rejects a claimed edit overlapping a protected task even when its bytes stay exact', async () => {
  const before = 'Context\n\n- [ ] Same\n  - [ ] Child\n';
  const h = await setup(before);
  const protection = new CanonicalNoteTaskProtection(h.app, h.index, h.authority);
  const task = expectDefined(protection.ranges(before)[0]);
  expect(
    protection.preservesAll(before, before, [
      {
        range: { ...task, to: task.from + 1 },
        replacement: before.slice(task.from, task.from + 1),
      },
    ]),
  ).toBe(false);
});

it('refreshes exact host heading and block anchors while canonical content stays the same', async () => {
  const content = '# Title\n\nText ^block\n\n- [ ] Task\n';
  const h = await setup(content);
  const parse = vi.spyOn(TaskBlockEditor.prototype, 'rootBlocks');
  h.noteService.sections(h.source);
  const count = parse.mock.calls.length;
  const file = expectDefined(h.app.vault.getFileByPath('a.md') ?? undefined);
  const point = (offset: number, line: number, col: number) => ({ offset, line, col });
  metadataChangedEmitter(h.app)(file, content, {
    headings: [
      { heading: 'Title', level: 1, position: { start: point(0, 0, 0), end: point(7, 0, 7) } },
    ],
    blocks: { block: { id: 'block', position: { start: point(9, 2, 0), end: point(20, 2, 11) } } },
  });
  await flushMicrotasks();
  parse.mockClear();
  const sections = h.noteService.sections(h.source);
  expect(count).toBe(1);
  expect(parse).not.toHaveBeenCalled();
  expect(sections).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ kind: 'heading', label: 'Title', editable: false }),
      expect.objectContaining({ kind: 'block', label: 'block', editable: false }),
    ]),
  );
});

it.each(['content', 'replacement', 'scope'] as const)(
  'still validates the accepted source before reusing ranges after %s changes',
  async (change) => {
    const content = 'Prose\n\n- [ ] Task\n';
    const h = await setup(content);
    h.noteService.sections(h.source);
    if (change === 'content') await h.external('a.md', `More\n${content}`);
    if (change === 'scope') await h.index.refreshSourceExclusion(() => true);
    if (change === 'replacement') {
      const file = expectDefined(h.app.vault.getFileByPath('a.md') ?? undefined);
      await h.app.fileManager.trashFile(file);
      await h.app.vault.create('a.md', content);
      await flushMicrotasks();
    }
    expect(() => h.noteService.sections(h.source)).toThrow();
  },
);
