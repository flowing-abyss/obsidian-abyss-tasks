import { describe, expect, it, vi } from 'vitest';
import { ProjectEditHistory } from '../src/projects/projectEditHistory';
import type {
  AppliedProjectCellChange,
  ProjectCellChange,
  ProjectEditResult,
} from '../src/projects/projectEdits';
import { createOwnedInferredPropertyClear } from '../src/projects/projectEdits';
import type { ProjectField } from '../src/projects/projectFields';

const field: ProjectField = {
  id: 'property:Owners',
  property: 'Owners',
  label: 'Owners',
  type: 'list',
};

function applied(path: string, value: unknown, previousValue: unknown): AppliedProjectCellChange {
  return {
    path,
    field: { ...field },
    value,
    expectedValue: previousValue,
    previousValue,
    sourceProperty: 'Owners',
    sourceKey: 'Owners',
    previousExists: true,
    appliedExists: true,
  };
}

function successful(changes: readonly ProjectCellChange[]): ProjectEditResult {
  return {
    applied: changes.map((change) => ({
      ...change,
      previousValue: change.expectedValue,
      sourceProperty: change.field.property ?? 'status',
      sourceKey: change.field.property ?? 'status',
      previousExists: true,
      appliedExists: true,
    })),
    failed: [],
  };
}

function ownedClear(path: string) {
  return createOwnedInferredPropertyClear({
    path,
    fieldId: field.id,
    sourceProperty: 'Owners',
    sourceKey: 'OWNERS',
    type: 'list',
  });
}

describe('ProjectEditHistory', () => {
  it('undoes with the owned new value and redoes with the owned old value', async () => {
    const apply = vi.fn(async (changes: readonly ProjectCellChange[]) => successful(changes));
    const history = new ProjectEditHistory(apply);
    history.record({ applied: [applied('A.md', ['new'], ['old'])], failed: [] });

    const undone = await history.undo();
    expect(undone.failed).toEqual([]);
    expect(apply.mock.calls[0]?.[0]).toEqual([
      expect.objectContaining({
        path: 'A.md',
        field,
        value: ['old'],
        expectedValue: ['new'],
        sourceProperty: 'Owners',
        expectedExists: true,
        valueExists: true,
      }),
    ]);
    expect(history.canUndo).toBe(false);
    expect(history.canRedo).toBe(true);

    await history.redo();
    expect(apply.mock.calls[1]?.[0]).toEqual([
      expect.objectContaining({
        path: 'A.md',
        field,
        value: ['new'],
        expectedValue: ['old'],
        sourceProperty: 'Owners',
        expectedExists: true,
        valueExists: true,
      }),
    ]);
    expect(history.canUndo).toBe(true);
    expect(history.canRedo).toBe(false);
  });

  it('copies receipt arrays so later mutations cannot corrupt history', async () => {
    const apply = vi.fn(async (changes: readonly ProjectCellChange[]) => successful(changes));
    const history = new ProjectEditHistory(apply);
    const before = ['old'];
    const after = ['new'];
    const receipt = applied('A.md', after, before);
    history.record({ applied: [receipt], failed: [] });

    before.push('mutated');
    after.push('mutated');
    receipt.field.property = 'Changed';

    await history.undo();
    const submitted = apply.mock.calls[0]?.[0][0];
    expect(submitted?.value).toEqual(['old']);
    expect(submitted?.expectedValue).toEqual(['new']);
    expect(submitted?.field.property).toBe('Owners');
  });

  it('reuses the exact owned key and absence provenance across clear undo and redo', async () => {
    const apply = vi.fn(async (changes: readonly ProjectCellChange[]) => successful(changes));
    const history = new ProjectEditHistory(apply);
    history.record({
      applied: [
        {
          ...applied('A.md', undefined, ['old']),
          sourceKey: 'OWNERS',
          appliedExists: false,
        },
      ],
      failed: [],
    });

    await history.undo();
    expect(apply.mock.calls[0]?.[0]).toEqual([
      expect.objectContaining({
        sourceKey: 'OWNERS',
        expectedExists: false,
        valueExists: true,
        value: ['old'],
      }),
    ]);

    await history.redo();
    expect(apply.mock.calls[1]?.[0]).toEqual([
      expect.objectContaining({
        sourceKey: 'OWNERS',
        expectedExists: true,
        valueExists: false,
        expectedValue: ['old'],
      }),
    ]);
  });

  it('keeps failed undo cells owned while making successful cells redoable', async () => {
    const apply = vi.fn(
      async (changes: readonly ProjectCellChange[]): Promise<ProjectEditResult> => ({
        applied: successful(changes.slice(0, 1)).applied,
        failed: [{ path: changes[1]?.path ?? 'missing', message: 'changed externally' }],
      }),
    );
    const history = new ProjectEditHistory(apply);
    history.record({
      applied: [applied('A.md', 'new-a', 'old-a'), applied('B.md', 'new-b', 'old-b')],
      failed: [],
    });

    const result = await history.undo();

    expect(result.applied).toHaveLength(1);
    expect(result.failed).toEqual([{ path: 'B.md', message: 'changed externally' }]);
    expect(history.canUndo).toBe(true);
    expect(history.canRedo).toBe(true);
  });

  it('does not record empty results and keeps at most fifty operations', async () => {
    const apply = vi.fn(async (changes: readonly ProjectCellChange[]) => successful(changes));
    const history = new ProjectEditHistory(apply);
    history.record({ applied: [], failed: [{ path: 'A.md', message: 'failed' }] });
    expect(history.canUndo).toBe(false);

    for (let index = 0; index < 51; index += 1) {
      history.record({ applied: [applied(`${index}.md`, index, index - 1)], failed: [] });
    }
    for (let index = 50; index >= 1; index -= 1) await history.undo();

    expect(history.canUndo).toBe(false);
    expect(apply).toHaveBeenCalledTimes(50);
    expect(apply.mock.calls[49]?.[0][0]?.path).toBe('1.md');
  });

  it('copies and evicts owned clear capabilities with their bounded receipts', () => {
    const history = new ProjectEditHistory(async (changes) => successful(changes));
    const owned = ownedClear('A.md');
    history.record({
      applied: [
        {
          ...applied('A.md', undefined, ['old']),
          sourceKey: 'OWNERS',
          appliedExists: false,
          ownedClear: owned,
        },
      ],
      failed: [],
    });

    const copied = history.ownedClear('A.md', field);
    expect(copied).toEqual(owned);
    expect(copied).not.toBe(owned);
    expect(Object.isFrozen(copied)).toBe(true);

    for (let index = 0; index < 50; index += 1) {
      history.record({ applied: [applied(`${index}.md`, index, index - 1)], failed: [] });
    }
    expect(history.ownedClear('A.md', field)).toBeUndefined();
  });

  it('tracks a final-occurrence clear created by Undo and forwards it to Redo', async () => {
    const apply = vi.fn(
      async (changes: readonly ProjectCellChange[]): Promise<ProjectEditResult> => ({
        applied: changes.map((change) => {
          const appliedExists = change.valueExists ?? true;
          return {
            ...change,
            previousValue: change.expectedValue,
            sourceProperty: change.sourceProperty ?? 'Owners',
            sourceKey: change.sourceKey ?? 'OWNERS',
            previousExists: change.expectedExists ?? true,
            appliedExists,
            ...(appliedExists ? {} : { ownedClear: ownedClear(change.path) }),
          };
        }),
        failed: [],
      }),
    );
    const history = new ProjectEditHistory(apply);
    history.record({
      applied: [
        {
          ...applied('A.md', ['new'], undefined),
          sourceKey: 'OWNERS',
          previousExists: false,
        },
      ],
      failed: [],
    });

    await history.undo();
    expect(history.ownedClear('A.md', field)?.sourceKey).toBe('OWNERS');

    await history.redo();
    expect(apply.mock.calls[1]?.[0][0]?.ownedClear?.sourceKey).toBe('OWNERS');
    expect(history.ownedClear('A.md', field)).toBeUndefined();
  });

  it('discards owned clear capabilities and rejects discard while history is busy', async () => {
    let release: (result: ProjectEditResult) => void = () => {};
    const pending = new Promise<ProjectEditResult>((resolve) => {
      release = resolve;
    });
    const history = new ProjectEditHistory(() => {
      return pending;
    });
    history.record({
      applied: [
        {
          ...applied('A.md', undefined, ['old']),
          appliedExists: false,
          ownedClear: ownedClear('A.md'),
        },
      ],
      failed: [],
    });
    const undo = history.undo();

    expect(() => {
      history.discard();
    }).toThrow(/already in progress/u);
    release({ applied: [], failed: [{ path: 'A.md', message: 'failed' }] });
    await undo;
    expect(history.ownedClear('A.md', field)).toBeDefined();

    history.discard();
    expect(history.ownedClear('A.md', field)).toBeUndefined();
    expect(history.canUndo).toBe(false);
    expect(history.canRedo).toBe(false);
  });

  it('returns an empty receipt when there is nothing to undo or redo', async () => {
    const apply = vi.fn(async (changes: readonly ProjectCellChange[]) => successful(changes));
    const history = new ProjectEditHistory(apply);

    await expect(history.undo()).resolves.toEqual({ applied: [], failed: [] });
    await expect(history.redo()).resolves.toEqual({ applied: [], failed: [] });
    expect(apply).not.toHaveBeenCalled();
  });

  it('rejects overlapping history actions so pending results cannot reorder the stacks', async () => {
    let release: (result: ProjectEditResult) => void = () => {};
    const pendingResult = new Promise<ProjectEditResult>((resolve) => {
      release = resolve;
    });
    const apply = vi.fn(() => pendingResult);
    const history = new ProjectEditHistory(apply);
    history.record({ applied: [applied('A.md', 'new', 'old')], failed: [] });

    const pendingUndo = history.undo();

    expect(() => {
      history.record({ applied: [applied('B.md', 'new', 'old')], failed: [] });
    }).toThrow(/already in progress/u);
    await expect(history.redo()).rejects.toThrow(/already in progress/u);
    release(successful([{ path: 'A.md', field, value: 'old', expectedValue: 'new' }]));
    await expect(pendingUndo).resolves.toMatchObject({ failed: [] });
    expect(history.canUndo).toBe(false);
    expect(history.canRedo).toBe(true);
  });
});
