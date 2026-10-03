import { TFile, type App } from 'obsidian';
import { rebaseMarkdownSourceReferences } from '../../../markdown/sourceReferences';
import type {
  RevisionPrecondition,
  TaskHierarchyPhase,
  TaskHierarchyRequest,
  TaskRepositoryResult,
} from '../../application/TaskRepository';
import {
  taskNodeAtSourcePath,
  taskNodeChain,
  taskNodeRootRef,
} from '../../domain/taskCommandTargets';
import { enumerateTaskNodes, type TaskNodeSnapshot } from '../../domain/taskDependencies';
import {
  hierarchySource,
  hierarchyWouldCycle,
  type TaskHierarchyOutcome,
} from '../../domain/taskHierarchy';
import { sameTaskNodeRef, type TaskNodeRef, type TaskSnapshot } from '../../domain/types';
import { invalidTaskTarget } from '../../domain/validation';
import type { TaskBlockEditor, TaskRootBlock } from '../markdown/TaskBlockEditor';
import {
  prepareHierarchyTransfer,
  type HierarchyEndpoint,
  type PreparedHierarchyTransfer,
} from '../markdown/taskHierarchyTransfer';
import type {
  OwnedSourceMutation,
  RootRevisionOverride,
  StructuralSourceMutation,
  TaskRefAuthority,
  TaskSnapshotState,
} from '../TaskRefAuthority';

interface HierarchyOptions {
  readonly authority: TaskRefAuthority | undefined;
  readonly state: TaskSnapshotState | undefined;
  readonly editor: TaskBlockEditor;
  readonly processFile: (file: TFile, transform: (content: string) => string) => Promise<void>;
  readonly parse: (path: string, content: string) => readonly TaskSnapshot[];
}
interface Source extends StructuralSourceMutation {
  readonly file: TFile;
}
type HierarchyCapabilities = HierarchyOptions & {
  readonly authority: TaskRefAuthority;
  readonly state: TaskSnapshotState &
    Required<Pick<TaskSnapshotState, 'currentRoots' | 'installCommittedBatch'>>;
};
interface Context extends HierarchyCapabilities {
  readonly app: App;
  readonly request: TaskHierarchyRequest;
  readonly sources: Source[];
  owner: OwnedSourceMutation | undefined;
  prepared?: PreparedHierarchyTransfer;
  phase: TaskHierarchyPhase;
  path?: string;
}
class HierarchyFailure extends Error {
  constructor(readonly result?: TaskRepositoryResult) {
    super('Hierarchy transfer could not be proved');
  }
}
function fileAt(context: Context, path: string, expected?: TFile): TFile {
  const file = context.app.vault.getAbstractFileByPath(path);
  if (!(file instanceof TFile) || (expected !== undefined && file !== expected))
    throw new HierarchyFailure();
  return file;
}
function diagnose(context: Context, cause: string): void {
  try {
    context.request.diagnostic?.(context.phase, cause, context.path);
  } catch {
    console.error('[abyss-tasks] Hierarchy diagnostic failed', {
      phase: context.phase,
      cause: 'diagnostic-error',
    });
  }
}
function enter(context: Context, phase: TaskHierarchyPhase, path?: string): void {
  context.phase = phase;
  if (path === undefined) delete context.path;
  else context.path = path;
}
function samePopulation(
  left: readonly RootRevisionOverride[],
  right: readonly RootRevisionOverride[],
): boolean {
  return (
    left.length === right.length &&
    left.every((root, index) => {
      const other = right[index];
      return (
        root.line === other?.line &&
        root.source === other.source &&
        root.revision === other.revision
      );
    })
  );
}
function currentBlock(
  context: Context,
  basis: RevisionPrecondition,
  target: TaskNodeRef,
  content: string,
): TaskRootBlock {
  const ref = taskNodeRootRef(target);
  if (
    (basis.baseTarget.type !== 'task' && basis.baseTarget.type !== 'subtask') ||
    !sameTaskNodeRef(basis.baseTarget, target) ||
    !sameTaskNodeRef({ type: 'task', ref: basis.baseRoot.ref }, { type: 'task', ref })
  )
    throw new HierarchyFailure(invalidTaskTarget('hierarchy'));
  const block = context.editor
    .rootBlocks(content)
    .find(
      (candidate) =>
        candidate.line === ref.line && candidate.source === basis.baseRoot.source.originalBlock,
    );
  const current = context.state.currentRoots(ref.filePath).find((root) => root.line === ref.line);
  if (
    block === undefined ||
    current?.revision !== ref.revision ||
    current.source !== block.source
  ) {
    const task = context
      .parse(ref.filePath, content)
      .find((candidate) => candidate.source.line === ref.line);
    throw new HierarchyFailure(
      task === undefined ? { type: 'not-found', target } : { type: 'conflict', current: task },
    );
  }
  return block;
}
function endpoint(
  context: Context,
  basis: RevisionPrecondition,
  target: TaskNodeRef,
  contents: ReadonlyMap<string, string>,
): HierarchyEndpoint {
  const ref = taskNodeRootRef(target);
  const content = contents.get(ref.filePath);
  if (content === undefined) throw new HierarchyFailure();
  const block = currentBlock(context, basis, target, content);
  const root = context
    .parse(ref.filePath, content)
    .find(
      (candidate) => candidate.ref.revision === ref.revision && candidate.source.line === ref.line,
    );
  const node = root === undefined ? undefined : taskNodeAtSourcePath(root, target);
  if (node === undefined) throw new HierarchyFailure(invalidTaskTarget('hierarchy'));
  const relativeLine = taskNodeChain(target).reduce((line, child) => line + child.relativeLine, 0);
  return {
    filePath: ref.filePath,
    block,
    target: {
      relativeLine,
      lineCount: ('source' in node ? node.source.originalBlock : node.ref.originalBlock).split(
        /\r?\n/u,
      ).length,
      childRanges: node.subtasks.map((child) => ({
        from: child.ref.relativeLine,
        to: child.ref.relativeLine + child.ref.originalBlock.split(/\r?\n/u).length - 1,
      })),
      ...(node.description !== undefined && { description: node.description }),
    },
  };
}
function prepare(context: Context, contents: ReadonlyMap<string, string>): void {
  const { request } = context;
  const source = endpoint(context, request.source, hierarchySource(request.command), contents);
  const parent =
    request.command.type === 'reparent-task' && request.parent !== undefined
      ? endpoint(context, request.parent, request.command.parent, contents)
      : undefined;
  if ((request.command.type === 'reparent-task') !== (parent !== undefined))
    throw new HierarchyFailure(invalidTaskTarget('hierarchy'));
  const prepared = prepareHierarchyTransfer({
    contents,
    source,
    ...(parent !== undefined && { parent }),
    editor: context.editor,
    rewrite: (text, from, to, anchors) =>
      rebaseMarkdownSourceReferences(text, {
        sourcePath: from,
        destinationPath: to,
        movedAnchors: anchors,
        resolver: {
          resolve: (target, sourcePath) =>
            context.app.metadataCache.getFirstLinkpathDest(target, sourcePath)?.path,
          linktext: (path, destinationPath) =>
            context.app.metadataCache.fileToLinktext(fileAt(context, path), destinationPath, true),
        },
      }),
  });
  if (prepared.type !== 'prepared') throw new HierarchyFailure(invalidTaskTarget('hierarchy'));
  context.prepared = prepared;
  capturePopulations(context, prepared, contents);
  enter(context, 'reservation');
  context.owner = context.authority.reserveStructuralMutation(context.sources, (path) =>
    context.state.currentRoots(path),
  );
  if (context.owner === undefined) throw new HierarchyFailure();
  prove(
    context,
    context.sources.flatMap(({ filePath, after }) => context.parse(filePath, after)),
  );
}
function capturePopulations(
  context: Context,
  prepared: PreparedHierarchyTransfer,
  contents: ReadonlyMap<string, string>,
): void {
  const authority = context.authority;
  for (const [path, after] of prepared.contents) {
    const before = contents.get(path);
    if (before === undefined) throw new HierarchyFailure();
    const predecessors = context.state.currentRoots(path);
    const survivors = prepared.survivingRoots.get(path) ?? [];
    const transitions: Array<Source['transitions'][number]> = [];
    const roots = context.editor.rootBlocks(after).map((block) => {
      const previousLine = survivors.find(({ line }) => line === block.line)?.beforeLine;
      const previous = predecessors.find(({ line }) => line === previousLine);
      const root = {
        line: block.line,
        source: block.source,
        revision: authority.mintRevision(block.source),
      };
      if (previous !== undefined)
        transitions.push({ ...root, previousRevision: previous.revision });
      return root;
    });
    context.sources.push({
      filePath: path,
      file: fileAt(context, path),
      before,
      after,
      predecessors,
      roots,
      transitions,
    });
  }
}
function confirmPopulations(
  context: Context,
  roots: readonly TaskSnapshot[],
  kind: 'roots' | 'predecessors',
): void {
  for (const source of context.sources) {
    const population = roots
      .filter((root) => root.ref.filePath === source.filePath)
      .map((root) => ({
        line: root.source.line,
        source: root.source.originalBlock,
        revision: root.ref.revision,
      }));
    if (!samePopulation(source[kind], population)) throw new HierarchyFailure();
  }
}
function prove(context: Context, roots: readonly TaskSnapshot[]): TaskHierarchyOutcome {
  confirmPopulations(context, roots, 'roots');
  const prepared = context.prepared;
  const moved = enumerateTaskNodes(roots).find(
    (node) =>
      node.root.ref.filePath === prepared?.moved.filePath &&
      node.root.source.line +
        node.path.reduce((line, child) => line + child.ref.relativeLine, 0) ===
        prepared.moved.line,
  );
  if (moved === undefined) throw new HierarchyFailure();
  proveParent(context, moved);
  const command = context.request.command;
  return {
    type: 'hierarchy',
    source: hierarchySource(command),
    moved: { root: moved.root, target: moved.target },
    affectedRoots: roots,
  };
}
function parentLineAfterRemoval(request: TaskHierarchyRequest): number {
  const command = request.command;
  if (command.type !== 'reparent-task') throw new HierarchyFailure();
  const oldParent = taskNodeRootRef(command.parent);
  const parentRelative = taskNodeChain(command.parent).reduce(
    (line, child) => line + child.relativeLine,
    0,
  );
  const sourceRef = taskNodeRootRef(hierarchySource(command));
  const sourceRelative = taskNodeChain(hierarchySource(command)).reduce(
    (line, child) => line + child.relativeLine,
    0,
  );
  const sourceTarget = hierarchySource(command);
  const sourceLines = (
    sourceTarget.type === 'task'
      ? request.source.baseRoot.source.originalBlock
      : sourceTarget.ref.originalBlock
  ).split(/\r?\n/u).length;
  const removedBeforeParent =
    sourceRef.filePath === oldParent.filePath &&
    sourceRef.line + sourceRelative < oldParent.line + parentRelative
      ? sourceLines
      : 0;
  return oldParent.line + parentRelative - removedBeforeParent;
}
function proveParent(context: Context, moved: TaskNodeSnapshot): void {
  const command = context.request.command;
  if (command.type === 'promote-subtask' && moved.target.type !== 'task')
    throw new HierarchyFailure();
  if (command.type === 'reparent-task') {
    if (moved.target.type !== 'subtask') throw new HierarchyFailure();
    const oldParent = taskNodeRootRef(command.parent);
    const parentRootLine = context.prepared?.survivingRoots
      .get(oldParent.filePath)
      ?.find(({ beforeLine }) => beforeLine === oldParent.line)?.line;
    if (moved.root.source.line !== parentRootLine) throw new HierarchyFailure();
    // The parser must attach the moved node to the exact transformed parent, not a sibling.
    const expectedParentLine = parentLineAfterRemoval(context.request);
    const actualParentLine =
      moved.root.source.line +
      taskNodeChain(moved.target.ref.parent).reduce((line, child) => line + child.relativeLine, 0);
    if (expectedParentLine !== actualParentLine) throw new HierarchyFailure();
  }
}
function forward(context: Context, source: Source, content: string): string {
  fileAt(context, source.filePath, source.file);
  if (!samePopulation(source.predecessors, context.state.currentRoots(source.filePath))) {
    context.owner?.rejectSource(source.filePath);
    throw new HierarchyFailure();
  }
  const candidate = context.owner?.forward(source.filePath, content);
  if (candidate === undefined) throw new HierarchyFailure();
  return candidate;
}
async function write(context: Context): Promise<void> {
  const command = context.request.command;
  const sourcePath = context.request.source.baseRoot.ref.filePath;
  const targetPath = context.request.parent?.baseRoot.ref.filePath ?? sourcePath;
  if (command.type === 'reparent-task' && hierarchyWouldCycle(command.source, command.parent))
    throw new HierarchyFailure(invalidTaskTarget('hierarchy'));
  if (sourcePath === targetPath) {
    const file = fileAt(context, sourcePath);
    await context.processFile(file, (content) => {
      fileAt(context, sourcePath, file);
      prepare(context, new Map([[sourcePath, content]]));
      const source = context.sources[0];
      if (source === undefined) throw new HierarchyFailure();
      enter(context, 'source-write', sourcePath);
      return forward(context, source, content);
    });
    return;
  }
  const contents = new Map<string, string>();
  const files = new Map<string, TFile>();
  for (const path of [targetPath, sourcePath]) {
    const file = fileAt(context, path);
    files.set(path, file);
    contents.set(path, await context.app.vault.read(file));
  }
  for (const [path, file] of files) fileAt(context, path, file);
  prepare(context, contents);
  for (const source of context.sources) {
    enter(
      context,
      source.filePath === targetPath ? 'destination-write' : 'source-write',
      source.filePath,
    );
    fileAt(context, source.filePath, source.file);
    await context.processFile(source.file, (content) => forward(context, source, content));
  }
}
async function readCurrent(context: Context): Promise<Map<string, string>> {
  const contents = new Map<string, string>();
  for (const source of context.sources) {
    try {
      fileAt(context, source.filePath, source.file);
      contents.set(source.filePath, await context.app.vault.read(source.file));
    } catch {
      diagnose(context, 'read-error');
    }
  }
  return contents;
}
async function restoreFile(context: Context, source: Source): Promise<void> {
  enter(context, 'rollback', source.filePath);
  try {
    fileAt(context, source.filePath, source.file);
    await context.processFile(source.file, (content) => {
      fileAt(context, source.filePath, source.file);
      const original = context.owner?.restore(source.filePath, content);
      if (original === undefined) throw new HierarchyFailure();
      return original;
    });
  } catch {
    diagnose(context, 'restoration-rejected');
  }
}
async function restore(context: Context): Promise<boolean> {
  for (const source of [...context.sources].reverse()) await restoreFile(context, source);
  enter(context, 'restoration-proof');
  const contents = await readCurrent(context);
  const exact = context.sources.every((source) => contents.get(source.filePath) === source.before);
  try {
    if (!exact) throw new HierarchyFailure();
    context.state.installCommittedBatch(contents, (roots) => {
      confirmPopulations(context, roots, 'predecessors');
      if (context.owner?.completeRestoration(contents) !== true) throw new HierarchyFailure();
    });
    return true;
  } catch {
    diagnose(context, 'restoration-unproven');
    context.owner?.release();
    for (const [path, content] of contents) {
      try {
        context.state.installCommittedContent(path, content);
      } catch {
        diagnose(context, 'reconciliation-error');
      }
    }
    return false;
  } finally {
    discardSuccessors(context);
  }
}
function discardSuccessors(context: Context): void {
  for (const basis of [context.request.source, context.request.parent])
    if (basis !== undefined) context.state.discardAuthoritySuccessor?.(basis.baseRoot.ref);
}
function hasCapabilities(options: HierarchyOptions): options is HierarchyCapabilities {
  return (
    options.state?.installCommittedBatch !== undefined &&
    options.state.currentRoots !== undefined &&
    options.authority !== undefined
  );
}
export async function taskHierarchyTransaction(
  app: App,
  request: TaskHierarchyRequest,
  options: HierarchyOptions,
): Promise<TaskRepositoryResult> {
  if (
    !hasCapabilities(options) ||
    (request.command.type === 'reparent-task') !== (request.parent !== undefined)
  )
    return invalidTaskTarget('hierarchy');
  return run({ ...options, app, request, sources: [], owner: undefined, phase: 'preflight' });
}
function install(context: Context, contents: ReadonlyMap<string, string>): TaskRepositoryResult {
  let outcome: TaskHierarchyOutcome | undefined;
  context.state.installCommittedBatch(contents, (roots) => {
    outcome = prove(context, roots);
    if (context.owner?.complete(contents) !== true) throw new HierarchyFailure();
  });
  if (outcome === undefined) throw new HierarchyFailure();
  return { type: 'committed', changed: true, outcome };
}
function preflightFailure(error: unknown): TaskRepositoryResult {
  return (
    (error instanceof HierarchyFailure ? error.result : undefined) ?? {
      type: 'io-error',
      cause: 'hierarchy-error',
      contentState: 'unchanged',
    }
  );
}
async function sameParentResult(context: Context): Promise<TaskRepositoryResult | undefined> {
  const { command, parent } = context.request;
  if (
    command.type !== 'reparent-task' ||
    command.source.type !== 'subtask' ||
    !sameTaskNodeRef(command.source.ref.parent, command.parent) ||
    parent === undefined
  )
    return undefined;
  const path = taskNodeRootRef(command.source).filePath;
  const file = fileAt(context, path);
  const contents = new Map([[path, await context.app.vault.read(file)]]);
  fileAt(context, path, file);
  endpoint(context, context.request.source, command.source, contents);
  endpoint(context, parent, command.parent, contents);
  return {
    type: 'committed',
    changed: false,
    outcome: {
      type: 'hierarchy',
      source: command.source,
      moved: { root: context.request.source.baseRoot, target: command.source },
      affectedRoots: [context.request.source.baseRoot],
    },
  };
}
async function run(context: Context): Promise<TaskRepositoryResult> {
  try {
    const unchanged = await sameParentResult(context);
    if (unchanged !== undefined) return unchanged;
    await write(context);
    enter(context, 'postcondition');
    const contents = await readCurrent(context);
    if (context.sources.some((source) => contents.get(source.filePath) !== source.after))
      throw new HierarchyFailure();
    return install(context, contents);
  } catch (error) {
    return await failed(context, error);
  } finally {
    context.owner?.release();
  }
}

async function failed(context: Context, error: unknown): Promise<TaskRepositoryResult> {
  diagnose(context, error instanceof HierarchyFailure ? 'proof-rejected' : 'io-error');
  if (context.owner === undefined) return preflightFailure(error);
  if (await restore(context))
    return { type: 'io-error', cause: 'hierarchy-error', contentState: 'unchanged' };
  return {
    type: 'partial',
    operation: 'hierarchy',
    recovery: {
      source: hierarchySource(context.request.command),
      sourcePath: context.request.source.baseRoot.ref.filePath,
      destinationPath:
        context.request.parent?.baseRoot.ref.filePath ??
        context.request.source.baseRoot.ref.filePath,
      state: 'unknown',
      cause: 'io-error',
    },
  };
}
