import type {
  AppliedProjectCellChange,
  ProjectCellChange,
  ProjectEditResult,
} from './projectEdits';

const MAX_HISTORY_OPERATIONS = 50;

function copyValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(copyValue);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        key,
        copyValue(entry),
      ]),
    );
  }
  return value;
}

function copyApplied(edit: AppliedProjectCellChange): AppliedProjectCellChange {
  return {
    ...edit,
    field: { ...edit.field },
    value: copyValue(edit.value),
    expectedValue: copyValue(edit.expectedValue),
    previousValue: copyValue(edit.previousValue),
  };
}

function reverse(edit: AppliedProjectCellChange): ProjectCellChange {
  return {
    path: edit.path,
    field: { ...edit.field },
    value: copyValue(edit.previousValue),
    expectedValue: copyValue(edit.value),
    sourceProperty: edit.sourceProperty,
    sourceKey: edit.sourceKey,
    expectedExists: edit.appliedExists,
    valueExists: edit.previousExists,
    restoreSourceValue: true,
  };
}

function replay(edit: AppliedProjectCellChange): ProjectCellChange {
  return {
    path: edit.path,
    field: { ...edit.field },
    value: copyValue(edit.value),
    expectedValue: copyValue(edit.previousValue),
    sourceProperty: edit.sourceProperty,
    sourceKey: edit.sourceKey,
    expectedExists: edit.previousExists,
    valueExists: edit.appliedExists,
    restoreSourceValue: true,
  };
}

/** Session-only guarded Undo/Redo for receipts returned by project batch edits. */
export class ProjectEditHistory {
  private readonly undoStack: AppliedProjectCellChange[][] = [];
  private readonly redoStack: AppliedProjectCellChange[][] = [];
  private busy = false;

  constructor(
    private readonly apply: (changes: readonly ProjectCellChange[]) => Promise<ProjectEditResult>,
  ) {}

  record(result: ProjectEditResult): void {
    this.assertIdle();
    if (result.applied.length === 0) return;
    this.undoStack.push(result.applied.map(copyApplied));
    if (this.undoStack.length > MAX_HISTORY_OPERATIONS) this.undoStack.shift();
    this.redoStack.length = 0;
  }

  undo(): Promise<ProjectEditResult> {
    return this.runExclusive(() => this.move(this.undoStack, this.redoStack, reverse));
  }

  redo(): Promise<ProjectEditResult> {
    return this.runExclusive(() => this.move(this.redoStack, this.undoStack, replay));
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  private assertIdle(): void {
    if (this.busy) throw new Error('A project edit history operation is already in progress.');
  }

  private async runExclusive(
    operation: () => Promise<ProjectEditResult>,
  ): Promise<ProjectEditResult> {
    this.assertIdle();
    this.busy = true;
    try {
      return await operation();
    } finally {
      this.busy = false;
    }
  }

  private async move(
    source: AppliedProjectCellChange[][],
    destination: AppliedProjectCellChange[][],
    buildChange: (edit: AppliedProjectCellChange) => ProjectCellChange,
  ): Promise<ProjectEditResult> {
    const operation = source.pop();
    if (operation === undefined) return { applied: [], failed: [] };
    try {
      const result = await this.apply(operation.map(buildChange));
      const appliedPaths = new Set(result.applied.map(({ path }) => path));
      const moved = operation.filter(({ path }) => appliedPaths.has(path));
      const remaining = operation.filter(({ path }) => !appliedPaths.has(path));
      if (remaining.length > 0) source.push(remaining);
      if (moved.length > 0) destination.push(moved);
      return result;
    } catch (error) {
      source.push(operation);
      throw error;
    }
  }
}
