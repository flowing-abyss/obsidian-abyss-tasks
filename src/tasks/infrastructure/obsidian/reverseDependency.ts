import { TFile, type App } from 'obsidian';
import type {
  DependencyReversalPhase,
  ReverseDependencyRequest,
  TaskEditBatchRequest,
  TaskRepositoryResult,
} from '../../application/TaskRepository';
import type { DependencyCommandOutcome } from '../../domain/commands';
import type { TaskSnapshot } from '../../domain/types';
import { taskEditBatchIssues, type PreparedTaskEditBatch } from '../TaskEditBatch';
import type {
  ExactSourceMutation,
  OwnedSourceMutation,
  RootRevisionOverride,
  TaskRefAuthority,
  TaskSnapshotState,
} from '../TaskRefAuthority';

interface ReversalOptions {
  readonly authority: TaskRefAuthority | undefined;
  readonly state: TaskSnapshotState | undefined;
  readonly processFile: (file: TFile, transform: (content: string) => string) => Promise<void>;
  readonly parse: (path: string, content: string) => readonly TaskSnapshot[];
  readonly prepare: (
    batch: TaskEditBatchRequest,
    content: string,
  ) => PreparedTaskEditBatch | TaskRepositoryResult;
  readonly capture: (
    path: string,
    content: string,
  ) => { readonly roots: readonly RootRevisionOverride[] } | undefined;
}

interface Source extends ExactSourceMutation {
  readonly file: TFile;
}

class ReversalFailure extends Error {
  constructor(readonly result?: TaskRepositoryResult) {
    super('Dependency reversal failed');
  }
}

function failure(contentState: 'unchanged' | 'unknown'): TaskRepositoryResult {
  return { type: 'io-error', cause: 'dependency-reversal-error', contentState };
}

function uncommittedFailure(error: unknown): TaskRepositoryResult {
  return error instanceof ReversalFailure && error.result !== undefined
    ? error.result
    : failure('unchanged');
}

/** Only this operation owns the multi-file write/compensation lifecycle. */
interface ReversalContext extends ReversalOptions {
  readonly app: App;
  readonly request: ReverseDependencyRequest;
  readonly sources: Source[];
  owner: OwnedSourceMutation | undefined;
  phase: DependencyReversalPhase;
}

async function runReversal(
  app: App,
  request: ReverseDependencyRequest,
  options: ReversalOptions,
): Promise<TaskRepositoryResult> {
  return await run({
    ...options,
    app,
    request,
    sources: [],
    owner: undefined,
    phase: 'reservation',
  });
}

function enterPhase(context: ReversalContext, phase: DependencyReversalPhase): void {
  context.phase = phase;
}

async function run(context: ReversalContext): Promise<TaskRepositoryResult> {
  try {
    await write(context);
    enterPhase(context, 'postcondition');
    const contents = await readExact(context, 'after');
    const roots = install(context, contents);
    if (!confirmRoots(context, roots, 'after')) throw new ReversalFailure();
    const outcome = prove(context, roots);
    if (context.owner?.complete(contents) !== true) throw new ReversalFailure();
    return { type: 'committed', changed: true, outcome };
  } catch (error) {
    diagnose(
      context,
      context.phase,
      error instanceof ReversalFailure ? 'proof-rejected' : 'io-error',
    );
    if (context.owner === undefined) return uncommittedFailure(error);
    return failure((await restore(context)) ? 'unchanged' : 'unknown');
  } finally {
    context.owner?.release();
  }
}

async function write(context: ReversalContext): Promise<void> {
  const batches = [...context.request.batches].sort((a, b) => a.filePath.localeCompare(b.filePath));
  const first = batches[0];
  if (batches.length === 1 && first !== undefined) {
    const file = resolveFile(context, first.filePath);
    await context.processFile(file, (content) => {
      prepare(context, first, file, content);
      reserve(context);
      enterPhase(context, 'first-write');
      return forward(context, context.sources[0], content);
    });
    return;
  }
  for (const batch of batches) {
    const file = resolveFile(context, batch.filePath);
    prepare(context, batch, file, await context.app.vault.read(file));
  }
  reserve(context);
  for (const [index, source] of context.sources.entries()) {
    enterPhase(context, index === 0 ? 'first-write' : 'second-write');
    resolveFile(context, source.filePath, source.file);
    await context.processFile(source.file, (content) => forward(context, source, content));
  }
}

function resolveFile(context: ReversalContext, path: string, expected?: TFile): TFile {
  const file = context.app.vault.getAbstractFileByPath(path);
  if (!(file instanceof TFile) || (expected !== undefined && file !== expected))
    throw new ReversalFailure();
  return file;
}

function prepare(
  context: ReversalContext,
  batch: TaskEditBatchRequest,
  file: TFile,
  before: string,
): void {
  const prepared = context.prepare(batch, before);
  if (prepared.type !== 'prepared') throw new ReversalFailure(prepared);
  const basis = context.capture(batch.filePath, before);
  const authority = context.authority;
  if (basis === undefined || authority === undefined) throw new ReversalFailure();
  const roots = prepared.roots.map(({ before: root, block }) => {
    const revision = authority.successor(root.ref.revision, block.source);
    if (revision === undefined) throw new ReversalFailure();
    return {
      line: block.line,
      source: block.source,
      revision,
      previousRevision: root.ref.revision,
    };
  });
  context.sources.push({
    file,
    filePath: batch.filePath,
    before,
    after: prepared.content,
    predecessors: basis.roots,
    roots,
  });
}

function reserve(context: ReversalContext): void {
  if (!context.sources.every((source) => predecessorsCurrent(context, source, source.before)))
    throw new ReversalFailure();
  context.owner = context.authority?.reserveMutation(context.sources);
  if (context.owner === undefined) throw new ReversalFailure();
  prove(
    context,
    context.sources.flatMap(({ filePath, after }) => context.parse(filePath, after)),
  );
}

function prove(context: ReversalContext, roots: readonly TaskSnapshot[]): DependencyCommandOutcome {
  const outcome = context.request.proveReversal(roots);
  if (outcome === undefined) throw new ReversalFailure();
  return outcome;
}

function forward(context: ReversalContext, source: Source | undefined, content: string): string {
  if (source === undefined) throw new ReversalFailure();
  resolveFile(context, source.filePath, source.file);
  const candidate = context.owner?.forward(source.filePath, content);
  if (candidate === undefined) throw new ReversalFailure();
  if (!predecessorsCurrent(context, source, content)) {
    context.owner?.rejectSource(source.filePath);
    throw new ReversalFailure();
  }
  return candidate;
}

function predecessorsCurrent(context: ReversalContext, source: Source, content: string): boolean {
  const current = context.capture(source.filePath, content)?.roots;
  return (
    current?.length === source.predecessors.length &&
    current.every((root, index) => {
      const before = source.predecessors[index];
      return (
        before?.revision === root.revision &&
        before.line === root.line &&
        before.source === root.source
      );
    })
  );
}

function diagnose(
  context: ReversalContext,
  failedPhase: DependencyReversalPhase,
  cause: string,
): void {
  try {
    context.request.diagnostic(failedPhase, cause);
  } catch {
    console.error('[abyss-tasks] Dependency reversal diagnostic failed', {
      phase: failedPhase,
      cause: 'diagnostic-error',
    });
  }
}

async function readExact(
  context: ReversalContext,
  which: 'before' | 'after',
): Promise<Map<string, string>> {
  const contents = new Map<string, string>();
  for (const source of context.sources) {
    resolveFile(context, source.filePath, source.file);
    const content = await context.app.vault.read(source.file);
    if (content !== source[which]) {
      context.owner?.rejectSource(source.filePath);
      throw new ReversalFailure();
    }
    contents.set(source.filePath, content);
  }
  return contents;
}

function install(
  context: ReversalContext,
  contents: ReadonlyMap<string, string>,
): readonly TaskSnapshot[] {
  const state = context.state;
  if (state === undefined) throw new ReversalFailure();
  // Parse all sources before publishing either file to the read model.
  const parsed = [...contents].flatMap(([path, content]) => context.parse(path, content));
  if (context.phase === 'postcondition') prove(context, parsed);
  return [...contents].flatMap(([path, content]) => state.installCommittedContent(path, content));
}

async function restore(context: ReversalContext): Promise<boolean> {
  const restored = new Set<string>();
  for (const [index, source] of [...context.sources].reverse().entries()) {
    enterPhase(context, index === 0 ? 'first-rollback' : 'second-rollback');
    try {
      resolveFile(context, source.filePath, source.file);
      await context.processFile(source.file, (content) => {
        resolveFile(context, source.filePath, source.file);
        const original = context.owner?.restore(source.filePath, content);
        if (original === undefined) throw new ReversalFailure();
        restored.add(source.filePath);
        return original;
      });
    } catch {
      diagnose(context, context.phase, 'restoration-rejected');
    }
  }
  enterPhase(context, 'restoration-proof');
  try {
    if (!(await reconcileOriginals(context, restored))) throw new ReversalFailure();
    return true;
  } catch {
    diagnose(context, context.phase, 'restoration-unproven');
    return false;
  } finally {
    for (const batch of context.request.batches)
      for (const { baseRoot } of batch.edits)
        context.state?.discardAuthoritySuccessor?.(baseRoot.ref);
  }
}

async function reconcileOriginals(
  context: ReversalContext,
  restored: ReadonlySet<string>,
): Promise<boolean> {
  const contents = await readCurrent(context);
  const exact = context.sources.every(
    (source) => restored.has(source.filePath) && contents.get(source.filePath) === source.before,
  );
  if (!exact) context.owner?.release();
  const roots = reconcile(context, contents);
  if (
    exact &&
    confirmRoots(context, roots, 'before') &&
    context.owner?.completeRestoration(contents) === true
  )
    return true;
  if (exact) {
    context.owner?.release();
    reconcile(context, await readCurrent(context));
  }
  return false;
}

function reconcile(
  context: ReversalContext,
  contents: ReadonlyMap<string, string>,
): readonly TaskSnapshot[] {
  const roots: TaskSnapshot[] = [];
  for (const [path, content] of contents) {
    try {
      context.parse(path, content);
      const state = context.state;
      if (state === undefined) throw new ReversalFailure();
      roots.push(...state.installCommittedContent(path, content));
    } catch {
      diagnose(context, 'restoration-proof', 'reconciliation-error');
    }
  }
  return roots;
}

async function readCurrent(context: ReversalContext): Promise<Map<string, string>> {
  const contents = new Map<string, string>();
  for (const source of context.sources) {
    try {
      resolveFile(context, source.filePath, source.file);
      contents.set(source.filePath, await context.app.vault.read(source.file));
    } catch {
      diagnose(context, 'restoration-proof', 'read-error');
    }
  }
  return contents;
}

function confirmRoots(
  context: ReversalContext,
  roots: readonly TaskSnapshot[],
  which: 'before' | 'after',
): boolean {
  return context.sources.every((source) => {
    const installed = roots.filter((root) => root.ref.filePath === source.filePath);
    return (
      installed.length === source.predecessors.length &&
      source.predecessors.every((before, index) => {
        const expected =
          which === 'before'
            ? before
            : (source.roots.find(({ line }) => line === before.line) ?? before);
        const root = installed[index];
        return (
          root?.ref.revision === expected.revision &&
          root.source.line === expected.line &&
          root.source.originalBlock === expected.source
        );
      })
    );
  });
}

export async function reverseDependency(
  app: App,
  request: ReverseDependencyRequest,
  options: ReversalOptions,
): Promise<TaskRepositoryResult> {
  const batches = request.batches;
  const issues = batches.flatMap(taskEditBatchIssues);
  if (
    batches.length < 1 ||
    batches.length > 2 ||
    new Set(batches.map(({ filePath }) => filePath)).size !== batches.length ||
    issues.length > 0
  )
    return {
      type: 'invalid',
      issues:
        issues.length > 0 ? issues : [{ code: 'invalid-target', field: 'dependency-reversal' }],
    };
  return await runReversal(app, request, options);
}
