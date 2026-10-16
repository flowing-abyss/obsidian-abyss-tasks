import { describe, expect, it } from 'vitest';
import type { TaskNodeRef, TaskPlanning, TaskSnapshot } from '../../src/tasks/domain/types';
import { durationMinutes, localDate, localTime } from '../../src/tasks/domain/validation';
import { TaskMarkdownCodec } from '../../src/tasks/infrastructure/markdown/TaskMarkdownCodec';
import { projectTaskSnapshot } from '../../src/tasks/infrastructure/markdown/TaskSnapshotProjector';
import { sameTaskSnapshots } from '../../src/tasks/infrastructure/taskSnapshotEquality';
import { canonicalStatusCatalog, expectDefined, useRealMoment } from '../helpers';

useRealMoment();

function canonicalSnapshot(): TaskSnapshot {
  const source = [
    '- [ ] Root ➕ 2026-10-01 📅 2026-10-20 ⏳ 2026-10-18 🛫 2026-10-17 ⏰ 09:00 ⏱️ 30m',
    '  - Root comment',
    '  - 2026-10-17T09:00:00+00:00 → 2026-10-17T09:30:00+00:00',
    '  - [ ] Child',
    '    - Child comment',
    '    - [ ] Grandchild',
    '      - Grandchild comment',
  ].join('\n');
  const statusCatalog = canonicalStatusCatalog();
  return expectDefined(
    projectTaskSnapshot({
      codec: new TaskMarkdownCodec(statusCatalog),
      statusCatalog,
      filePath: 'tasks.md',
      lines: source.split('\n'),
      line: 0,
      exactBlock: source,
      ref: { filePath: 'tasks.md', line: 0, revision: 'observed-revision' },
      presentation: { linkCount: 0 },
      offsetAt: () => 0,
    }),
  );
}

function detached(snapshot: TaskSnapshot): TaskSnapshot {
  return JSON.parse(JSON.stringify(snapshot)) as TaskSnapshot;
}

const equalByJson = (left: readonly TaskSnapshot[], right: readonly TaskSnapshot[]) =>
  JSON.stringify(left) === JSON.stringify(right);

describe('task snapshot JSON-value equality', () => {
  it('matches serialization for complete canonical snapshots and explicit plain-data variants', () => {
    const root = canonicalSnapshot();
    const copy = detached(root);
    const child = expectDefined(root.subtasks[0]);
    const comment = expectDefined(root.comments[0]);
    const entry = expectDefined(root.timeEntries[0]);
    const sparseSlots: unknown[] = [undefined];
    sparseSlots.length = 3;
    sparseSlots[2] = null;
    const extended = (value: unknown): TaskSnapshot => Object.assign({}, root, { future: value });
    const pair = (
      right: TaskSnapshot,
    ): readonly [readonly TaskSnapshot[], readonly TaskSnapshot[]] => [[root], [right]];
    const canonicalSnapshotPairs: Array<
      readonly [readonly TaskSnapshot[], readonly TaskSnapshot[]]
    > = [
      [[], []],
      [[], [root]],
      pair(root),
      pair(copy),
      pair({ ...root, status: 'done' }),
      pair({ ...root, statusSymbol: 'x' }),
      pair({ ...root, ref: { ...root.ref, revision: 'reissued-revision' } }),
      pair({ ...root, comments: [{ ...comment, text: 'Edited comment' }] }),
      pair({ ...root, timeEntries: [{ ...entry, originalMarkdown: 'Edited time entry' }] }),
      pair({ ...root, subtasks: [{ ...child, status: 'done' }] }),
      // A detached comment's changed parent remains part of the snapshot value.
      pair({
        ...copy,
        comments: [
          {
            ...expectDefined(copy.comments[0]),
            ref: {
              ...comment.ref,
              parent: { type: 'task', ref: { ...root.ref, revision: 'different-parent' } },
            },
          },
        ],
      }),
      [[extended({ nested: ['new'] })], [extended({ nested: ['changed'] })]],
      [
        [extended([root.ref, root.ref])],
        [extended([{ ...root.ref, revision: 'changed' }, { ...root.ref }])],
      ],
      [[extended({ first: 1, hidden: undefined, last: 2 })], [extended({ first: 1, last: 2 })]],
      [[extended({ first: 1, last: 2 })], [extended({ last: 2, first: 1 })]],
      [[extended(sparseSlots)], [extended([null, null, null])]],
      [[extended([null])], [extended([])]],
      [[extended([-0, NaN, Infinity, -Infinity])], [extended([0, null, null, null])]],
      [[extended({ value: NaN })], [extended({ value: null })]],
      [[extended({ value: NaN })], [extended({ value: undefined })]],
      [[extended({ value: undefined })], [root]],
      [[extended(undefined)], [root]],
      [[extended([])], [extended({})]],
      [[extended(Object.assign(['same'], { ignored: 'left' }))], [extended(['same'])]],
    ];
    const planningVariants: TaskPlanning[] = [
      { created: localDate('2026-10-02') },
      { due: localDate('2026-10-21') },
      { scheduled: localDate('2026-10-19') },
      { start: localDate('2026-10-16') },
      { completion: localDate('2026-10-22') },
      { cancelled: localDate('2026-10-23') },
      { time: localTime('10:00') },
      { duration: durationMinutes(45) },
    ];
    for (const planning of planningVariants)
      canonicalSnapshotPairs.push(pair({ ...root, planning: { ...root.planning, ...planning } }));

    expect(root.comments).toHaveLength(1);
    expect(root.timeEntries).toHaveLength(1);
    expect(child.ref.parent.ref).toBe(root.ref);
    expect(copy.subtasks[0]?.ref.parent.ref).not.toBe(copy.ref);
    for (const [first, second] of canonicalSnapshotPairs) {
      expect(sameTaskSnapshots(first, second)).toBe(equalByJson(first, second));
      expect(sameTaskSnapshots(second, first)).toBe(equalByJson(second, first));
    }
  });

  it('compares deep parent ancestry without using the JavaScript call stack', () => {
    const root = canonicalSnapshot();
    const child = expectDefined(root.subtasks[0]);
    const ancestry = (revision: string): TaskNodeRef => {
      let parent: TaskNodeRef = { type: 'task', ref: { ...root.ref, revision } };
      for (let depth = 0; depth < 15_000; depth++) {
        parent = {
          type: 'subtask',
          ref: { parent, relativeLine: 1, originalBlock: '  - [ ] Child' },
        };
      }
      return parent;
    };
    const snapshot = (revision: string): TaskSnapshot => ({
      ...root,
      subtasks: [{ ...child, ref: { ...child.ref, parent: ancestry(revision) } }],
    });
    expect(sameTaskSnapshots([snapshot('same')], [snapshot('same')])).toBe(true);
    expect(sameTaskSnapshots([snapshot('same')], [snapshot('changed')])).toBe(false);
  });
});
