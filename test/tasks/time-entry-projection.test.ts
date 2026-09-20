import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '../../src/settings/defaults';
import { cloneTaskSnapshot } from '../../src/tasks/domain/cloneTaskSnapshot';
import type * as TimeEntryModule from '../../src/tasks/domain/timeEntry';
import { timeEntryRef } from '../../src/tasks/domain/timeTracking';
import type { TaskNodeRef, TaskSnapshot } from '../../src/tasks/domain/types';
import { TaskIndex } from '../../src/tasks/infrastructure/TaskIndex';
import {
  canonicalStatusCatalog,
  configuredTaskApplication,
  createAppWithFiles,
  expectDefined,
  seedTaskCache,
  useRealMoment,
} from '../helpers';

const parsedLines = vi.hoisted(() => [] as string[]);

vi.mock('../../src/tasks/domain/timeEntry', async () => {
  const actual = await vi.importActual<typeof TimeEntryModule>('../../src/tasks/domain/timeEntry');
  return {
    ...actual,
    parseTimeEntryLine: (line: string, offsetAt: TimeEntryModule.OffsetAt) => {
      parsedLines.push(line);
      return actual.parseTimeEntryLine(line, offsetAt);
    },
  };
});

useRealMoment();

const FILE = 't.md';

const CONTENT = [
  '- [ ] Write report ⏱️ 2h',
  '    - > description line',
  '    - 2026-09-17T09:12:00+03:00 → 2026-09-17T10:40:51+03:00',
  '    - 2026-09-17T12:00:00+03:00: a timestamped comment',
  '    - plain comment → with arrow',
  '    - [ ] Subtask',
  '        - 2026-09-18T11:00:00+03:00 → 2026-09-18T11:25:10+03:00 call with Bob',
  '        - 2026-09-18T14:05:32+03:00 →',
  '    - 2026-09-16T14:05:00+03:00 → 13:20',
].join('\n');

async function indexed(
  content: string,
  items: Array<{ task: string; parent: number; line: number }>,
): Promise<ReturnType<typeof configuredTaskApplication>> {
  const app = await createAppWithFiles({ [FILE]: content });
  seedTaskCache(app, FILE, items);
  const stack = configuredTaskApplication(app, DEFAULT_SETTINGS);
  await stack.index.initialize();
  return stack;
}

async function projectedRoot(): Promise<{
  readonly stack: ReturnType<typeof configuredTaskApplication>;
  readonly root: TaskSnapshot;
}> {
  const stack = await indexed(CONTENT, [
    { task: ' ', parent: -1, line: 0 },
    { task: ' ', parent: 0, line: 5 },
  ]);
  return { stack, root: expectDefined(stack.index.list()[0]) };
}

/** A hand-written entry with no written offset, so only the index's resolver can place it. */
const OFFSETLESS_CONTENT = ['- [ ] Track', '    - 2026-09-17 09:12 → 2026-09-17 10:40'].join('\n');

async function offsetIndex(timeZoneOffsetAt?: TimeEntryModule.OffsetAt): Promise<TaskIndex> {
  const app = await createAppWithFiles({ [FILE]: OFFSETLESS_CONTENT });
  seedTaskCache(app, FILE, [{ task: ' ', parent: -1, line: 0 }]);
  const index = new TaskIndex(app, {
    statusCatalog: canonicalStatusCatalog(),

    ...(timeZoneOffsetAt === undefined ? {} : { timeZoneOffsetAt }),
  });
  await index.initialize();
  return index;
}

function onlyEntry(roots: readonly TaskSnapshot[]): TimeEntryModule.ParsedTimeEntry {
  return expectDefined(expectDefined(roots[0]).timeEntries[0]);
}

describe('time entry projection', () => {
  it('projects owned entry lines onto the root task', async () => {
    const { root } = await projectedRoot();
    expect(
      root.timeEntries.map((entry) => ({
        relativeLine: entry.relativeLine,
        state: entry.state,
        ...(entry.issue === undefined ? {} : { issue: entry.issue }),
      })),
    ).toEqual([
      { relativeLine: 2, state: 'closed' },
      { relativeLine: 8, state: 'broken', issue: 'end-before-start' },
    ]);
    expect(root.timeEntries[0]?.originalMarkdown).toBe(
      '    - 2026-09-17T09:12:00+03:00 → 2026-09-17T10:40:51+03:00',
    );
  });

  it('leaves a timestamped comment and an arrow without a stamp on the comment path', async () => {
    const { root } = await projectedRoot();
    expect(root.comments.map((comment) => comment.text)).toEqual([
      'a timestamped comment',
      'plain comment → with arrow',
    ]);
  });

  it('projects a running entry and a closed entry with a tail onto a subtask', async () => {
    const { root } = await projectedRoot();
    const child = expectDefined(root.subtasks[0]);
    expect(
      child.timeEntries.map((entry) => ({
        relativeLine: entry.relativeLine,
        state: entry.state,
        ...(entry.tail === undefined ? {} : { tail: entry.tail }),
      })),
    ).toEqual([
      { relativeLine: 1, state: 'closed', tail: 'call with Bob' },
      { relativeLine: 2, state: 'running' },
    ]);
  });

  it('addresses a projected entry line through the node that owns it', async () => {
    const { root } = await projectedRoot();
    const child = expectDefined(root.subtasks[0]);
    const node: TaskNodeRef = { type: 'subtask', ref: child.ref };
    expect(timeEntryRef(node, expectDefined(child.timeEntries[1]))).toEqual({
      parent: node,
      relativeLine: 2,
      originalMarkdown: '        - 2026-09-18T14:05:32+03:00 →',
    });
  });

  it('keeps an entry tail out of the presentation link count', async () => {
    const { root } = await projectedRoot();
    expect(root.presentation.linkCount).toBe(0);

    const stack = await indexed(
      [
        '- [ ] Linked',
        '    - 2026-09-17T09:12:00+03:00 → 2026-09-17T10:40:51+03:00 read [[Tail Note]]',
        '    - see [[Comment Note]]',
      ].join('\n'),
      [{ task: ' ', parent: -1, line: 0 }],
    );
    expect(expectDefined(stack.index.list()[0]).presentation.linkCount).toBe(1);
  });

  it('shares one frozen entry array across clones and repeated reads', async () => {
    const { stack, root } = await projectedRoot();
    expect(Object.isFrozen(root.timeEntries)).toBe(true);
    expect(root.timeEntries.every((entry) => Object.isFrozen(entry))).toBe(true);
    expect(cloneTaskSnapshot(root).timeEntries).toBe(root.timeEntries);
    expect(expectDefined(stack.index.list()[0]).timeEntries).toBe(root.timeEntries);
  });

  it('shares one frozen empty array with every node that has no entries', async () => {
    const stack = await indexed(
      ['- [ ] First', '    - a note', '- [ ] Second', '    - [ ] Child'].join('\n'),
      [
        { task: ' ', parent: -1, line: 0 },
        { task: ' ', parent: -1, line: 2 },
        { task: ' ', parent: 2, line: 3 },
      ],
    );
    const first = expectDefined(stack.index.list()[0]);
    const second = expectDefined(stack.index.list()[1]);
    expect(first.timeEntries).toHaveLength(0);
    expect(Object.isFrozen(first.timeEntries)).toBe(true);
    expect(second.timeEntries).toBe(first.timeEntries);
    expect(expectDefined(second.subtasks[0]).timeEntries).toBe(first.timeEntries);
  });

  it('places an offset-less stamp with the configured zone offset', async () => {
    const index = await offsetIndex(() => 180);
    const entry = onlyEntry(index.list());
    expect(entry.state).toBe('closed');
    expect(entry.startMs).toBe(Date.parse('2026-09-17T09:12:00+03:00'));
    expect(entry.endMs).toBe(Date.parse('2026-09-17T10:40:00+03:00'));
    // The preview path builds its own parse context, so it has to carry the same resolver.
    expect(onlyEntry(index.snapshotsFromContent(FILE, OFFSETLESS_CONTENT)).startMs).toBe(
      entry.startMs,
    );
  });

  it('reads the offset from the configured option rather than a fixed zone', async () => {
    const entry = onlyEntry((await offsetIndex(() => -300)).list());
    expect(entry.startMs).toBe(Date.parse('2026-09-17T09:12:00-05:00'));
    expect(entry.endMs).toBe(Date.parse('2026-09-17T10:40:00-05:00'));
  });

  /**
   * Two devices rather than one, so the assertion holds whatever zone the host runs in: a fallback
   * that silently resolved to a constant would read the same instant on both.
   */
  it.each([
    ['+05:30', -330],
    ['-08:00', 480],
  ])(
    'falls back to the device zone offset %s when no option is configured',
    async (zone, minutes) => {
      vi.spyOn(Date.prototype, 'getTimezoneOffset').mockReturnValue(minutes);

      const entry = onlyEntry((await offsetIndex()).list());

      // A bare date and time is the device-local wall clock, which is what the default resolver
      // `-new Date(epochMs).getTimezoneOffset()` reports at the resolved instant.
      expect(entry.startMs).toBe(Date.parse(`2026-09-17T09:12:00${zone}`));
      expect(entry.endMs).toBe(Date.parse(`2026-09-17T10:40:00${zone}`));
    },
  );

  it('keeps entries JSON-stable so the index still compares files by serialization', async () => {
    const { root } = await projectedRoot();
    const child = expectDefined(root.subtasks[0]);
    for (const entries of [root.timeEntries, child.timeEntries]) {
      expect(JSON.parse(JSON.stringify(entries))).toEqual([...entries]);
    }
  });

  it('parses each candidate line once and rejects nested lines without an arrow', async () => {
    parsedLines.length = 0;
    await indexed(
      ['- [ ] Task', '    - first note', '    - second note', '    - third note'].join('\n'),
      [{ task: ' ', parent: -1, line: 0 }],
    );
    expect(parsedLines).toEqual([]);

    await indexed(
      ['- [ ] Task', '    - 2026-09-17T09:12:00+03:00 → 2026-09-17T10:40:51+03:00'].join('\n'),
      [{ task: ' ', parent: -1, line: 0 }],
    );
    expect(parsedLines).toEqual(['    - 2026-09-17T09:12:00+03:00 → 2026-09-17T10:40:51+03:00']);
  });
});
