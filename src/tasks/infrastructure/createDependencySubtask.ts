import type {
  CreateDependencySubtaskRequest,
  TaskEditRequest,
  TaskRepositoryResult,
} from '../application/TaskRepository';
import type { DependencySubtaskCreationOutcome } from '../domain/commands';
import { enumerateTaskNodes, type TaskNodeSnapshot } from '../domain/taskDependencies';
import { sameTaskNodeRef, type TaskSnapshot } from '../domain/types';
import { invalidTaskSyntax, invalidTaskTarget } from '../domain/validation';
import type { TaskBlockEditor, TaskRootBlock } from './markdown/TaskBlockEditor';
import type { TaskMarkdownCodec } from './markdown/TaskMarkdownCodec';
import type { PreparedTaskEditBatch } from './TaskEditBatch';

/** Reuses the ordinary parent/revision resolver; this command is never dispatched or written. */
export function dependencySubtaskResolutionRequest(
  request: CreateDependencySubtaskRequest,
): TaskEditRequest | undefined {
  if (
    request.baseTarget.type === 'comment' ||
    !['blocks', 'blocked-by'].includes(request.direction)
  )
    return undefined;
  return {
    ...request,
    command: {
      type: 'add-subtask',
      parent: request.baseTarget,
      text: request.text,
      today: request.today,
      addCreatedDate: request.addCreatedDate,
    },
  };
}

function nodeLine(node: TaskNodeSnapshot): number {
  return node.path.reduce((line, child) => line + child.ref.relativeLine, 0);
}

function uniqueNodeAt(
  nodes: readonly TaskNodeSnapshot[],
  line: number,
): TaskNodeSnapshot | undefined {
  const matches = nodes.filter((node) => nodeLine(node) === line);
  return matches.length === 1 ? matches[0] : undefined;
}

/** Fresh parsed positional evidence is valid only for this one known append transformation. */
function dependencySubtaskOutcome(
  request: CreateDependencySubtaskRequest,
  root: TaskSnapshot,
  currentLine: number,
  childLine: number,
): DependencySubtaskCreationOutcome | undefined {
  const nodes = enumerateTaskNodes([root]);
  const current = uniqueNodeAt(nodes, currentLine);
  const child = uniqueNodeAt(nodes, childLine);
  if (
    current === undefined ||
    child?.target.type !== 'subtask' ||
    !sameTaskNodeRef(child.target.ref.parent, current.target)
  )
    return undefined;
  const blocker = request.direction === 'blocks' ? current : child;
  const dependent = request.direction === 'blocks' ? child : current;
  const dependencyId = blocker.node.dependencyId;
  if (dependencyId === undefined || !dependent.node.dependsOn.includes(dependencyId))
    return undefined;
  return {
    type: 'dependency-subtask',
    change: 'created',
    direction: request.direction,
    dependencyId,
    current: { root: current.root, target: current.target },
    child: { root: child.root, target: child.target },
  };
}

export interface PreparedDependencySubtask extends PreparedTaskEditBatch {
  readonly currentLine: number;
  readonly childLine: number;
}

export function prepareDependencySubtask(
  request: CreateDependencySubtaskRequest,
  content: string,
  block: TaskRootBlock,
  options: {
    readonly codec: TaskMarkdownCodec;
    readonly editor: TaskBlockEditor;
    readonly snapshotsFromContent: (path: string, content: string) => readonly TaskSnapshot[];
  },
): PreparedDependencySubtask | TaskRepositoryResult {
  const current = enumerateTaskNodes([request.baseRoot]).find(
    (node) =>
      request.baseTarget.type !== 'comment' && sameTaskNodeRef(node.target, request.baseTarget),
  );
  if (current === undefined) return { type: 'conflict', current: request.baseRoot };
  const currentLine = nodeLine(current);
  const lineCount =
    current.target.type === 'task'
      ? block.toLine - block.line + 1
      : current.target.ref.originalBlock.split(/\r?\n/u).length;
  const edited = options.editor.createDependencySubtask(options.codec, content, block, {
    type: 'create-dependency-subtask',
    current: { relativeLine: currentLine, lineCount, childRanges: [] },
    direction: request.direction,
    text: request.text,
    ...(request.currentId !== undefined && { currentId: request.currentId }),
    ...(request.childId !== undefined && { childId: request.childId }),
    ...(request.addCreatedDate && { createdDate: request.today }),
  });
  if (edited.type === 'conflict') return { type: 'conflict', current: request.baseRoot };
  if (edited.type === 'invalid') return invalidTaskTarget(edited.field);
  const outcomeRoot = options
    .snapshotsFromContent(request.baseRoot.ref.filePath, edited.content)
    .find((root) => root.source.line === block.line);
  if (
    outcomeRoot === undefined ||
    dependencySubtaskOutcome(request, outcomeRoot, currentLine, edited.createdChildRelativeLine) ===
      undefined
  )
    return invalidTaskSyntax();
  return {
    type: 'prepared',
    content: edited.content,
    roots: [{ before: request.baseRoot, block: edited.block }],
    outcomeBefore: request.baseRoot,
    outcomeRoot,
    currentLine,
    childLine: edited.createdChildRelativeLine,
  };
}

function committedDependencySubtask(
  request: CreateDependencySubtaskRequest,
  prepared: PreparedDependencySubtask | undefined,
  result: Extract<TaskRepositoryResult, { readonly type: 'committed' }>,
  reparse?: (path: string, content: string) => readonly TaskSnapshot[],
): DependencySubtaskCreationOutcome | undefined {
  const root = result.outcome.type === 'task' ? result.outcome.task : undefined;
  const fresh =
    reparse !== undefined && prepared !== undefined
      ? reparse(request.baseRoot.ref.filePath, prepared.content).find(
          (candidate) => candidate.source.line === root?.source.line,
        )
      : root;
  return prepared !== undefined && fresh !== undefined
    ? dependencySubtaskOutcome(request, fresh, prepared.currentLine, prepared.childLine)
    : undefined;
}

export function finishDependencySubtask(
  request: CreateDependencySubtaskRequest,
  prepared: PreparedDependencySubtask | undefined,
  result: TaskRepositoryResult,
  reparse?: (path: string, content: string) => readonly TaskSnapshot[],
): TaskRepositoryResult {
  if (result.type !== 'committed') return result;
  try {
    const outcome = committedDependencySubtask(request, prepared, result, reparse);
    if (outcome !== undefined) return { type: 'committed', changed: true, outcome };
  } catch {
    console.error('[abyss-tasks] Linked subtask postcondition failed', {
      operation: 'create-dependency-subtask',
      phase: 'postcommit',
      cause: 'parser-error',
    });
  }
  return {
    type: 'io-error',
    cause: 'linked-subtask-postcondition',
    path: request.baseRoot.ref.filePath,
    contentState: 'unknown',
  };
}
