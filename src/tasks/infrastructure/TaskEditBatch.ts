import {
  dependencyMetadataIssues,
  type TaskEditBatchRequest,
  type TaskEditCommand,
  type TaskEditRequest,
  type TaskRepositoryResult,
} from '../application/TaskRepository';
import { taskNodeChain } from '../domain/taskCommandTargets';
import type { ProvenRootRevisionOverride } from '../domain/taskReconciliation';
import {
  sameTaskNodeRef,
  type TaskNodeRef,
  type TaskRef,
  type TaskSnapshot,
} from '../domain/types';
import type { TaskIssue } from '../domain/validation';
import { invalidTaskSyntax, invalidTaskTarget } from '../domain/validation';
import { applyTaskCommand } from './markdown/applyTaskCommand';
import type { TaskBlockEditor, TaskRootBlock } from './markdown/TaskBlockEditor';
import type { TaskMarkdownCodec } from './markdown/TaskMarkdownCodec';
import {
  taskRefContentFingerprint,
  type TaskRefAuthority,
  type TaskSnapshotState,
} from './TaskRefAuthority';

type MetadataCommand = Extract<
  TaskEditCommand,
  { readonly type: 'set-dependency-id' | 'set-depends-on' }
>;

interface BatchRoot {
  readonly before: TaskSnapshot;
  readonly block: TaskRootBlock;
}

export interface PreparedTaskEditBatch {
  readonly type: 'prepared';
  readonly content: string;
  readonly roots: readonly BatchRoot[];
  readonly outcomeBefore: TaskSnapshot;
  readonly outcomeRoot: TaskSnapshot;
}

interface BatchOptions {
  readonly codec: TaskMarkdownCodec;
  readonly editor: TaskBlockEditor;
  readonly snapshotsFromContent: (path: string, content: string) => readonly TaskSnapshot[];
  readonly resolve: (
    request: TaskEditRequest,
  ) =>
    | { readonly type: 'result'; readonly result: TaskRepositoryResult }
    | { readonly type: 'ready'; readonly block: TaskRootBlock };
}

interface ResolvedBatchEdit {
  readonly request: TaskEditRequest;
  readonly command: MetadataCommand;
  readonly block: TaskRootBlock;
  readonly relativeLine: number;
}

function metadataCommand(command: TaskEditCommand): command is MetadataCommand {
  return command.type === 'set-dependency-id' || command.type === 'set-depends-on';
}

function rootOf(target: TaskNodeRef): Extract<TaskNodeRef, { readonly type: 'task' }> {
  let node = target;
  while (node.type === 'subtask') node = node.ref.parent;
  return node;
}

function invalid(field: string): readonly TaskIssue[] {
  return [{ code: 'invalid-target', field }];
}

function editIssues(edit: TaskEditRequest, filePath: string): readonly TaskIssue[] {
  if (!metadataCommand(edit.command)) return invalid('batch-command');
  const issues = dependencyMetadataIssues(edit.command);
  if (issues.length > 0) return issues;
  const root = rootOf(edit.command.target);
  if (root.ref.filePath !== filePath) return invalid('batch-file');
  if (
    !sameTaskNodeRef(root, { type: 'task', ref: edit.baseRoot.ref }) ||
    edit.baseTarget.type === 'comment' ||
    !sameTaskNodeRef(edit.command.target, edit.baseTarget)
  )
    return invalid('batch-precondition');
  return [];
}

/** Batch scope is deliberately limited to line-preserving dependency metadata writes. */
export function taskEditBatchIssues(request: TaskEditBatchRequest): readonly TaskIssue[] {
  if (request.edits.length === 0) return invalid('batch');
  for (const edit of request.edits) {
    const issues = editIssues(edit, request.filePath);
    if (issues.length > 0) return issues;
  }
  const outcomeRoot = rootOf(request.outcomeTarget);
  return request.edits.some((edit) =>
    sameTaskNodeRef(outcomeRoot, { type: 'task', ref: edit.baseRoot.ref }),
  )
    ? []
    : invalid('batch-outcome');
}

function confirmedLine(target: TaskNodeRef, block: TaskRootBlock): number | undefined {
  const chain = taskNodeChain(target);
  const lines = block.source.split(/\r?\n/u);
  let line = 0;
  for (const child of chain) {
    line += child.relativeLine;
    const expected = child.originalBlock
      .split(/\r?\n/u)
      .map((source) => source.replace(/\r$/u, ''));
    if (child.relativeLine <= 0 || expected.some((source, index) => source !== lines[line + index]))
      return undefined;
  }
  return line;
}

function resolveEdits(
  request: TaskEditBatchRequest,
  options: BatchOptions,
): readonly ResolvedBatchEdit[] | TaskRepositoryResult {
  const resolved: ResolvedBatchEdit[] = [];
  for (const edit of request.edits) {
    if (!metadataCommand(edit.command)) return invalidTaskTarget('batch-command');
    const location = options.resolve(edit);
    if (location.type === 'result') return location.result;
    const relativeLine = confirmedLine(edit.command.target, location.block);
    if (relativeLine === undefined) return { type: 'conflict', current: edit.baseRoot };
    resolved.push({ request: edit, command: edit.command, block: location.block, relativeLine });
  }
  return resolved;
}

/** All refs are confirmed against original content before any candidate edits are applied. */
export function prepareTaskEditBatch(
  request: TaskEditBatchRequest,
  content: string,
  options: BatchOptions,
): PreparedTaskEditBatch | TaskRepositoryResult {
  const resolved = resolveEdits(request, options);
  if ('type' in resolved) return resolved;
  const outcome = resolved.find((edit) =>
    sameTaskNodeRef(rootOf(request.outcomeTarget), {
      type: 'task',
      ref: edit.request.baseRoot.ref,
    }),
  );
  if (outcome === undefined) return invalidTaskTarget('batch-outcome');
  if (confirmedLine(request.outcomeTarget, outcome.block) === undefined)
    return { type: 'conflict', current: outcome.request.baseRoot };
  let candidate = content;
  for (const edit of resolved) {
    const source = candidate.split(/\r?\n/u)[edit.block.line + edit.relativeLine];
    if (source === undefined) return invalidTaskSyntax();
    const changed = applyTaskCommand(options.codec, source, edit.command);
    if (changed.type === 'invalid') return changed;
    if (changed.type === 'changed')
      candidate = options.editor.replaceLine(
        candidate,
        edit.block,
        edit.relativeLine,
        changed.content,
      ).content;
  }
  return preparedCandidate(
    { content: candidate, path: request.filePath, edits: resolved, outcome },
    options,
  );
}

function preparedCandidate(
  input: {
    readonly content: string;
    readonly path: string;
    readonly edits: readonly ResolvedBatchEdit[];
    readonly outcome: ResolvedBatchEdit;
  },
  options: BatchOptions,
): PreparedTaskEditBatch | TaskRepositoryResult {
  const { content, path, edits, outcome } = input;
  const finalBlocks = new Map(
    options.editor.rootBlocks(content).map((block) => [block.line, block]),
  );
  const roots = new Map<number, BatchRoot>();
  for (const edit of edits) {
    const block = finalBlocks.get(edit.block.line);
    if (block === undefined) return invalidTaskSyntax();
    roots.set(block.line, { before: edit.request.baseRoot, block });
  }
  const outcomeRoot = options
    .snapshotsFromContent(path, content)
    .find((root) => root.source.line === outcome.block.line);
  return outcomeRoot === undefined
    ? invalidTaskSyntax()
    : {
        type: 'prepared',
        content,
        roots: [...roots.values()],
        outcomeBefore: outcome.request.baseRoot,
        outcomeRoot,
      };
}

export function stageTaskEditBatch(
  path: string,
  prepared: PreparedTaskEditBatch,
  authority: TaskRefAuthority | undefined,
  state: TaskSnapshotState | undefined,
): { readonly type: 'staged'; readonly token: object | undefined } | TaskRepositoryResult {
  if (authority === undefined || state === undefined) return { type: 'staged', token: undefined };
  const roots: ProvenRootRevisionOverride[] = [];
  const currentRevisions: string[] = [];
  for (const { before, block } of prepared.roots) {
    const consumed: TaskRef = before.ref;
    const evidence = authority.evidence(consumed.revision);
    const current =
      evidence === undefined ? undefined : state.currentRoot(path, consumed.line, evidence.source);
    if (current?.revision !== consumed.revision) return { type: 'conflict', current: before };
    const revision = authority.successor(consumed.revision, block.source);
    if (revision === undefined) return { type: 'conflict', current: before };
    roots.push({
      line: block.line,
      source: block.source,
      revision,
      previousRevision: consumed.revision,
    });
    currentRevisions.push(current.revision);
  }
  const staged = authority.stageBatch(
    {
      filePath: path,
      candidateFingerprint: taskRefContentFingerprint(prepared.content),
      candidateLength: prepared.content.length,
      roots,
    },
    currentRevisions,
  );
  return staged.type === 'staged' ? staged : { type: 'conflict', current: prepared.outcomeBefore };
}
