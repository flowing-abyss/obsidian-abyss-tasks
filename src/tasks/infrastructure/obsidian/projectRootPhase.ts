import type { ProjectTaskEffect, ProjectTaskFailure } from '../../application/TaskProjectCommands';
import { recurrenceOwnedSubtree } from '../../domain/recurrenceIteration';
import type { TaskOccurrenceAddress, TaskOccurrenceWitness } from '../../domain/taskOccurrence';
import type {
  ProvenRootRevisionOverride,
  RootRevisionOverride,
} from '../../domain/taskReconciliation';
import type { TaskSnapshot } from '../../domain/types';
import type { TaskBlockEditor } from '../markdown/TaskBlockEditor';
import type { OwnedSourceMutation, TaskRefAuthority, TaskSnapshotState } from '../TaskRefAuthority';

export interface ProjectRootEdit {
  readonly content: string;
  readonly line: number;
  readonly kind: 'insert' | 'remove';
}

function occurrence(path: string, root: RootRevisionOverride, offset = 0): TaskOccurrenceAddress {
  return { filePath: path, rootRevision: root.revision, rootLine: root.line, nodeOffset: offset };
}

interface Population {
  readonly roots: RootRevisionOverride[];
  readonly transitions: ProvenRootRevisionOverride[];
  readonly occurrences: TaskOccurrenceWitness[];
  inserted?: RootRevisionOverride;
}
interface PhaseOptions {
  readonly editor: TaskBlockEditor;
  readonly refAuthority?: TaskRefAuthority;
  readonly snapshotState?: TaskSnapshotState;
}
function offsets(root: RootRevisionOverride): readonly number[] {
  const subtree = recurrenceOwnedSubtree(root.source, 0);
  if (subtree === undefined) throw new Error('Unproven task subtree');
  return subtree.taskLines;
}

/** Inserting or deleting one physical block preserves the order of all other roots. */
function population(
  path: string,
  before: readonly RootRevisionOverride[],
  edit: ProjectRootEdit,
  options: Pick<PhaseOptions, 'editor'> & { authority: TaskRefAuthority },
): Population | undefined {
  const blocks = options.editor.rootBlocks(edit.content);
  const result: Population = { roots: [], transitions: [], occurrences: [] };
  const changed =
    edit.kind === 'insert'
      ? blocks.find((b) => b.line === edit.line)
      : before.find((b) => b.line === edit.line);
  if (changed === undefined) return;
  const survivors = before.filter((root) => root !== changed);
  const remaining = blocks.filter((block) => block !== changed);
  if (survivors.length !== remaining.length) return;
  for (const [i, block] of remaining.entries()) {
    const prior = survivors[i];
    if (prior?.source !== block.source) return;
    const next = { ...prior, line: block.line };
    result.roots.push(next);
    result.transitions.push({ ...next, previousRevision: prior.revision });
    if (next.line === prior.line) continue;
    for (const offset of offsets(prior))
      result.occurrences.push({
        kind: 'continued',
        before: occurrence(path, prior, offset),
        after: occurrence(path, next, offset),
      });
  }
  recordChangedRoot(path, changed, result, options.authority);
  return result;
}
function recordChangedRoot(
  path: string,
  changed: { line: number; source: string } | RootRevisionOverride,
  result: Population,
  authority: TaskRefAuthority,
): void {
  if ('revision' in changed) {
    for (const offset of offsets(changed))
      result.occurrences.push({ kind: 'removed', before: occurrence(path, changed, offset) });
    return;
  }
  const inserted = {
    line: changed.line,
    source: changed.source,
    revision: authority.mintRevision(changed.source),
  };
  result.inserted = inserted;
  result.roots.push(inserted);
  result.roots.sort((a, b) => a.line - b.line);
  for (const offset of offsets(inserted))
    result.occurrences.push({ kind: 'created', after: occurrence(path, inserted, offset) });
}

/** One native file operation. Storage acknowledgement and occurrence installation are independent. */
export class ProjectRootPhase {
  effect: ProjectTaskEffect = 'unchanged';
  reason: ProjectTaskFailure = 'stale';
  content?: string;
  task?: TaskSnapshot;
  private owner?: OwnedSourceMutation;
  private inserted: RootRevisionOverride | undefined;
  constructor(
    readonly path: string,
    private readonly operation: object,
  ) {}

  forward(
    live: string,
    edit: ProjectRootEdit,
    { editor, refAuthority: authority, snapshotState: state }: PhaseOptions,
  ): string {
    if (
      authority === undefined ||
      state?.currentRoots === undefined ||
      state.installCommittedBatch === undefined ||
      state.reconcileCommittedSource === undefined
    ) {
      this.reason = 'unsupported';
      return live;
    }
    const currentRoots = state.currentRoots.bind(state);
    const predecessors = currentRoots(this.path);
    const next = population(this.path, predecessors, edit, { editor, authority });
    if (next === undefined) return live;
    const owner = authority.reserveStructuralMutation(
      [
        {
          filePath: this.path,
          before: live,
          after: edit.content,
          predecessors,
          roots: next.roots,
          transitions: next.transitions,
          occurrences: next.occurrences,
          operation: this.operation,
        },
      ],
      currentRoots,
    );
    if (owner === undefined) return live;
    this.owner = owner;
    const content = owner.forward(this.path, live);
    if (content === undefined) return live;
    this.content = content;
    this.inserted = next.inserted;
    this.effect = 'unknown';
    this.reason = 'io';
    return content;
  }

  install(state: TaskSnapshotState): void {
    if (this.content === undefined) return;
    const contents = new Map([[this.path, this.content]]);
    const roots = state.installCommittedBatch?.(contents, (projected) => {
      if (this.inserted !== undefined && this.created(projected) === undefined)
        throw new Error('Created occurrence unavailable');
      if (this.owner?.complete(contents) !== true) throw new Error('Lost structural ownership');
    });
    const task = this.created(roots ?? []);
    if (task !== undefined) this.task = task;
  }

  private created(roots: readonly TaskSnapshot[]): TaskSnapshot | undefined {
    return roots.find(
      (root) =>
        root.ref.filePath === this.path &&
        root.ref.line === this.inserted?.line &&
        root.ref.revision === this.inserted.revision,
    );
  }

  release(): void {
    this.owner?.release();
  }
}
