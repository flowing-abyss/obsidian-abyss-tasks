import { expect, it, vi } from 'vitest';
import { drainCollectionSteps } from '../src/collectionSteps';
import { withTaskRevealRows } from '../src/panels/task-list/taskRevealRows';
import { TaskRowSelection } from '../src/panels/task-list/taskRowSelection';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import { organizeTaskSearch } from '../src/task-lists/taskSearchOrganization';
import { localDate, type TaskOrganizationRecord } from '../src/tasks';
import { expectDefined } from './helpers';
import { createCanonicalSearchHarness } from './support/taskSearchHarness';

it('appends only a finite receipt-scoped reveal to a full-domain daily base', async () => {
  const h = await createCanonicalSearchHarness(
    {
      'reveal.md':
        '- [ ] Range 🛫 0000-01-01 📅 9999-12-31\n  - [ ] Parent #hidden 🛫 0000-01-01 📅 0000-01-01\n    - [ ] Child',
    },
    DEFAULT_SETTINGS,
  );
  try {
    const source = h.index.searchSource().subscribe(() => {}),
      generation = source.state.generation;
    source.unsubscribe();
    const records: TaskOrganizationRecord[] = [];
    for await (const batch of h.index.organization(
      { expectedGeneration: generation, scope: 'nodes' },
      new AbortController().signal,
    ))
      records.push(...batch.items);
    const input = {
      generation,
      records,
      scope: 'nodes' as const,
      hits: null,
      selection: 'upcoming' as const,
      view: {
        relevance: false,
        list: {
          groupBy: 'date' as const,
          sortBy: { field: 'date' as const, dir: 'asc' as const },
          filters: [],
        },
      },
      settings: DEFAULT_SETTINGS,
      today: localDate('0000-01-01'),
      nowMs: 0,
      outgoingLinks: new Map(),
    };
    const base = drainCollectionSteps(organizeTaskSearch(input));
    const revealed = drainCollectionSteps(
      organizeTaskSearch({
        ...input,
        reveal: expectDefined(records[1]).address,
        revealKind: 'navigation',
        revealReceiptId: 'r7',
      }),
    );
    expect(revealed.rows.rowCount).toBe(base.rows.rowCount + 2);
    expect(revealed.revealIndex).toBe(base.rows.taskCount);
    const key = expectDefined(revealed.rows.taskKeyAt(base.rows.taskCount));
    expect(revealed.rows.indexOf(key)).toBe(base.rows.taskCount);
    expect(revealed.rows.rowIndexOf(key)).toBe(base.rows.rowCount + 1);
    expect(revealed.rows.physicalKey(key)).toBe('reveal.md:1');
    expect(revealed.rows.task(key)?.address).toEqual(expectDefined(records[1]).address);
    expect(revealed.rows.task(key)).toMatchObject({
      taskKey: 'reveal.md:1',
      presentation: { kind: 'node', completion: { kind: 'allowed' } },
    });
    expect(revealed.rows.task(key)?.presentation.displayDate).toBeUndefined();
    const ranges = revealed.rows.captureSelection({
      spans: [{ from: 0, to: revealed.rows.taskCount - 1 }],
      include: [],
      exclude: [],
    });
    expect(revealed.rows.selectedCount(ranges)).toBe(base.rows.taskCount + 1);
    expect(base.rows.selectedCount(ranges)).toBe(base.rows.taskCount);
    expect(revealed.scope === 'nodes' ? revealed.nodeTotal : -1).toBe(2);
    expect(revealed.rows.estimatedOffset(revealed.rows.rowCount, { group: 30, task: 80 })).toBe(
      base.rows.estimatedOffset(base.rows.rowCount, { group: 30, task: 80 }) + 110,
    );
    const slice = vi.spyOn(base.rows, 'slice');
    const rowAt = vi.spyOn(base.rows, 'rowAt');
    const parent = expectDefined(revealed.rows.task(key));
    const overlay = withTaskRevealRows(base.rows, {
      occurrence: parent,
      kind: 'creation',
      receiptId: 'r8',
      generation,
      ownerRootPresent: true,
    });
    expect(slice).not.toHaveBeenCalled();
    expect(rowAt).not.toHaveBeenCalled();
    expect([...overlay.rows.slice(base.rows.rowCount - 1, base.rows.rowCount + 2)]).toHaveLength(3);
    expect(slice).toHaveBeenCalledExactlyOnceWith(base.rows.rowCount - 1, base.rows.rowCount);
    expect(overlay.addedRootCount).toBe(0);
    expect(overlay.rows.rowAt(base.rows.rowCount)).toMatchObject({
      kind: 'group',
      count: 1,
      first: false,
      label: 'Created task',
    });
    const tailKey = expectDefined(overlay.rows.taskKeyAt(base.rows.taskCount));
    const tailAnchors = overlay.rows.anchorRanges().slice(base.rows.anchorRanges().length);
    expect(tailAnchors).toEqual([
      { kind: 'key', key: overlay.rows.rowAt(base.rows.rowCount)?.key },
      { kind: 'key', key: tailKey },
    ]);
    const current = {
      length: base.rows.rowCount,
      rowAt: (index: number) => {
        const row = base.rows.rowAt(index);
        return row === undefined
          ? undefined
          : { key: row.key, estimatedHeight: 80, measurementRevision: base.rows.revision };
      },
      indexOf: (value: string) => base.rows.rowIndexOf(value),
      estimatedOffset: (index: number) => base.rows.estimatedOffset(index, { group: 30, task: 80 }),
      anchorRanges: () => base.rows.anchorRanges(),
      survivingNeighbor: base.rows.survivingNeighbor.bind(base.rows),
    };
    expect(overlay.rows.survivingNeighbor(base.rows.rowCount + 1, 1, current)).toBeUndefined();
    expect(overlay.rows.survivingNeighbor(base.rows.rowCount + 1, -1, current)).toBe(
      base.rows.rowAt(base.rows.rowCount - 1)?.key,
    );
    expect(overlay.rows.firstSelectedKey(ranges)).toBe(base.rows.taskKeyAt(0));
    expect(overlay.rows.task(tailKey)?.presentation).toEqual({
      kind: 'node',
      completion: { kind: 'allowed' },
      interval: { start: '0000-01-01', due: '0000-01-01' },
    });
    const selection = new TaskRowSelection();
    selection.bind(overlay.rows);
    selection.collapseTo(expectDefined(overlay.rows.taskKeyAt(0)));
    selection.extendTo(tailKey, overlay.rows);
    expect(selection.size).toBe(base.rows.taskCount + 1);
    expect(selection.selectedNodes(overlay.rows)).toHaveLength(2);
    selection.bind(base.rows, { physicalKeys: new Map([['reveal.md:0', 'reveal.md:0']]) });
    expect(selection.size).toBe(base.rows.taskCount);
    expect(selection.ranges()).toHaveLength(1);
    const present = expectDefined(base.rows.task(expectDefined(base.rows.taskKeyAt(0))));
    expect(
      withTaskRevealRows(base.rows, {
        occurrence: present,
        kind: 'navigation',
        receiptId: 'same',
        generation,
        ownerRootPresent: true,
      }).rows,
    ).toBe(base.rows);
    expect(() =>
      withTaskRevealRows(base.rows, {
        occurrence: {
          ...present,
          address: { ...present.address, version: present.address.version + 1 },
        },
        kind: 'navigation',
        receiptId: 'stale',
        generation,
        ownerRootPresent: true,
      }),
    ).toThrow('Reveal target changed');
    const roots = drainCollectionSteps(
      organizeTaskSearch({
        ...input,
        scope: 'roots',
        selection: null,
        reveal: parent.address,
        revealKind: 'navigation',
        revealReceiptId: 'root-scope',
      }),
    );
    expect(roots.scope === 'roots' ? roots.rootTotal : -1).toBe(1);
    expect(roots.rows.taskCount).toBe(2);
    expect(() =>
      drainCollectionSteps(
        organizeTaskSearch({
          ...input,
          reveal: { ...parent.address, version: parent.address.version + 1 },
        }),
      ),
    ).toThrow('Reveal target changed');
  } finally {
    h.close();
  }
});
