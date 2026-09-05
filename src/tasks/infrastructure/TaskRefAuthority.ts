import type {
  ProvenRootRevisionOverride,
  RootRevisionOverride,
} from '../domain/taskReconciliation';
import { sameTaskNodeRef, type TaskRef, type TaskSnapshot } from '../domain/types';
import { TaskBlockEditor } from './markdown/TaskBlockEditor';

export type { RootRevisionOverride } from '../domain/taskReconciliation';

export interface TaskRefEvidence {
  readonly source: string;
  readonly session: string;
  readonly generation: string;
}

export interface TaskRefTransition {
  readonly filePath: string;
  readonly candidateFingerprint: string;
  readonly candidateLength: number;
  readonly expectedRevision: string;
  readonly roots: readonly RootRevisionOverride[];
}

export interface TaskRefAuthorityObservation {
  readonly roots: readonly RootRevisionOverride[];
  readonly transitions: readonly ProvenRootRevisionOverride[];
  readonly restored?: true;
}

export interface TaskRefBatchTransition {
  readonly filePath: string;
  readonly candidateFingerprint: string;
  readonly candidateLength: number;
  readonly roots: readonly ProvenRootRevisionOverride[];
}

export type TaskRefStageResult =
  { readonly type: 'staged'; readonly token: object } | { readonly type: 'conflict' };

export interface TaskSnapshotState {
  /** For duplicate sources, supplied transaction occurrence lines must match the indexed population. */
  currentRoot(
    filePath: string,
    line: number,
    source: string,
    sourceLines?: readonly number[],
  ): TaskRef | undefined;
  authoritySuccessor?(consumed: TaskRef): TaskRef | undefined;
  discardAuthoritySuccessor?(consumed: TaskRef): void;
  previewContent(filePath: string, content: string): readonly TaskSnapshot[];
  installCommittedContent(filePath: string, content: string): readonly TaskSnapshot[];
}

/** Failed duplicate-population proof must precede any unique-source relocation retry. */
export function hasUnconfirmedCurrentRoot(
  state: TaskSnapshotState | undefined,
  ref: TaskRef,
  evidence: TaskRefEvidence | undefined,
  confirmed: TaskRef | undefined,
): boolean {
  if (confirmed !== undefined || state === undefined || evidence === undefined) return false;
  const current = state.currentRoot(ref.filePath, ref.line, evidence.source);
  return (
    current !== undefined && sameTaskNodeRef({ type: 'task', ref: current }, { type: 'task', ref })
  );
}

const REVISION_PREFIX = 'task-ref:1:';

interface PendingTransition {
  readonly token: object;
  readonly filePath: string;
  readonly candidateFingerprint: string;
  readonly candidateLength: number;
  readonly roots: readonly RootRevisionOverride[];
  readonly transitions: readonly ProvenRootRevisionOverride[];
  phase: 'staged' | 'committed';
  observed: boolean;
  readonly restored: boolean;
  restoration?: {
    readonly content: string;
    readonly fingerprint: string;
    readonly length: number;
    readonly roots: readonly RootRevisionOverride[];
  };
}

function randomSession(): string {
  const values = new Uint32Array(2);
  window.crypto.getRandomValues(values);
  return [...values].map((value) => value.toString(36)).join('');
}

function fingerprint(source: string, reverse: boolean): number {
  let hash = 0x811c9dc5;
  for (let offset = 0; offset < source.length; offset++) {
    const index = reverse ? source.length - offset - 1 : offset;
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function taskRefContentFingerprint(source: string): string {
  return `${fingerprint(source, false).toString(36)}:${fingerprint(source, true).toString(36)}`;
}

function matches(transition: PendingTransition, content: string): boolean {
  return (
    transition.candidateLength === content.length &&
    transition.candidateFingerprint === taskRefContentFingerprint(content)
  );
}

export class TaskRefAuthority {
  private generation = 0;
  private readonly transitions = new Map<string, PendingTransition>();
  private readonly tokens = new WeakMap<object, PendingTransition>();

  constructor(private readonly session = randomSession()) {}

  revision(source: string): string {
    return this.encode(source, '0');
  }

  mintRevision(source: string): string {
    this.generation += 1;
    return this.encode(source, this.generation.toString(36));
  }

  successor(consumedRevision: string, source: string): string | undefined {
    const consumed = this.evidence(consumedRevision);
    if (consumed == null) return undefined;
    const numericGeneration = Number.parseInt(consumed.generation, 36);
    if (Number.isSafeInteger(numericGeneration)) {
      this.generation = Math.max(this.generation, numericGeneration);
    }
    this.generation += 1;
    return this.encode(source, this.generation.toString(36));
  }

  evidence(revision: string): TaskRefEvidence | undefined {
    if (!revision.startsWith(REVISION_PREFIX)) return undefined;
    try {
      const parsed = JSON.parse(revision.slice(REVISION_PREFIX.length)) as unknown;
      if (
        !Array.isArray(parsed) ||
        parsed.length !== 3 ||
        parsed.some((value) => typeof value !== 'string')
      ) {
        return undefined;
      }
      const [session, generation, source] = parsed as [string, string, string];
      if (session !== this.session || !/^[0-9a-z]+$/u.test(generation)) return undefined;
      return { source, session, generation };
    } catch {
      return undefined;
    }
  }

  stage(transition: TaskRefTransition, currentRevision: string): TaskRefStageResult {
    if (
      currentRevision !== transition.expectedRevision ||
      this.evidence(transition.expectedRevision) == null
    ) {
      return { type: 'conflict' };
    }
    return this.stageTransition({
      ...transition,
      roots: transition.roots.map((root) => ({
        ...root,
        previousRevision: transition.expectedRevision,
      })),
    });
  }

  stageBatch(
    transition: TaskRefBatchTransition,
    currentRevisions: readonly string[],
  ): TaskRefStageResult {
    if (
      transition.roots.length === 0 ||
      transition.roots.length !== currentRevisions.length ||
      transition.roots.some(
        (root, index) =>
          root.previousRevision !== currentRevisions[index] ||
          this.evidence(root.previousRevision) == null,
      )
    )
      return { type: 'conflict' };
    return this.stageTransition(transition);
  }

  /** Attach the repository's live, population-proven predecessors before publishing a candidate. */
  retainPredecessors(
    token: object,
    content: string,
    roots: readonly RootRevisionOverride[],
  ): boolean {
    const pending = this.activeStaged(token);
    if (
      pending === undefined ||
      pending.observed ||
      pending.restored ||
      pending.restoration !== undefined
    )
      return false;
    const blocks = new TaskBlockEditor().rootBlocks(content);
    if (
      blocks.length !== roots.length ||
      roots.some(
        (root, index) =>
          root.line !== blocks[index]?.line ||
          root.source !== blocks[index].source ||
          this.evidence(root.revision)?.source !== root.source,
      ) ||
      new Set(roots.map(({ revision }) => revision)).size !== roots.length
    )
      return false;
    if (
      pending.transitions.some(
        ({ previousRevision }) => !roots.some(({ revision }) => revision === previousRevision),
      )
    )
      return false;
    pending.restoration = Object.freeze({
      content,
      fingerprint: taskRefContentFingerprint(content),
      length: content.length,
      roots: Object.freeze(roots.map((root) => Object.freeze({ ...root }))),
    });
    return true;
  }

  /** Consumes only the original live transaction; restoration grants no successor evidence. */
  stageRestoration(token: object, content: string): TaskRefStageResult {
    const pending = this.activeStaged(token);
    if (pending === undefined) return { type: 'conflict' };
    const restoration = pending.restoration;
    this.abort(token);
    if (
      restoration?.content !== content ||
      restoration.length !== content.length ||
      restoration.fingerprint !== taskRefContentFingerprint(content)
    )
      return { type: 'conflict' };
    return this.stageContent(
      {
        filePath: pending.filePath,
        candidateFingerprint: restoration.fingerprint,
        candidateLength: restoration.length,
        roots: restoration.roots,
      },
      [],
      true,
    );
  }

  private activeStaged(token: object): PendingTransition | undefined {
    const pending = this.tokens.get(token);
    return pending?.phase === 'staged' && this.transitions.get(pending.filePath) === pending
      ? pending
      : undefined;
  }

  private stageTransition(transition: TaskRefBatchTransition): TaskRefStageResult {
    return this.stageContent(transition, transition.roots);
  }

  private stageContent(
    transition: Omit<TaskRefBatchTransition, 'roots'> & {
      readonly roots: readonly RootRevisionOverride[];
    },
    transitions: readonly ProvenRootRevisionOverride[],
    restored = false,
  ): TaskRefStageResult {
    if (this.transitions.has(transition.filePath)) return { type: 'conflict' };
    const token = Object.freeze({});
    const pending: PendingTransition = {
      token,
      filePath: transition.filePath,
      candidateFingerprint: transition.candidateFingerprint,
      candidateLength: transition.candidateLength,
      roots: Object.freeze(
        transition.roots.map(({ line, source, revision }) =>
          Object.freeze({ line, source, revision }),
        ),
      ),
      transitions: Object.freeze(transitions.map((root) => Object.freeze({ ...root }))),
      phase: 'staged',
      observed: false,
      restored,
    };
    this.transitions.set(transition.filePath, pending);
    this.tokens.set(token, pending);
    return { type: 'staged', token };
  }

  observe(filePath: string, content: string): readonly RootRevisionOverride[] {
    return this.observeTransition(filePath, content)?.roots ?? [];
  }

  observeTransition(filePath: string, content: string): TaskRefAuthorityObservation | undefined {
    const transition = this.transitions.get(filePath);
    if (transition == null || !matches(transition, content)) return undefined;
    transition.observed = true;
    return {
      roots: transition.roots,
      transitions: transition.transitions,
      ...(transition.restored && { restored: true }),
    };
  }

  commit(token: object): void {
    const transition = this.activeStaged(token);
    if (transition === undefined || transition.restored) return;
    transition.phase = 'committed';
    delete transition.restoration;
  }

  abort(token: object): void {
    const transition = this.activeStaged(token);
    if (transition === undefined) return;
    this.transitions.delete(transition.filePath);
    this.tokens.delete(token);
  }

  acknowledge(filePath: string, content: string): void {
    const transition = this.transitions.get(filePath);
    if (transition?.phase === 'committed' && matches(transition, content)) {
      this.transitions.delete(filePath);
      this.tokens.delete(transition.token);
    }
  }

  discard(filePath: string): void {
    const transition = this.transitions.get(filePath);
    if (transition !== undefined) this.tokens.delete(transition.token);
    this.transitions.delete(filePath);
  }

  clear(): void {
    for (const transition of this.transitions.values()) this.tokens.delete(transition.token);
    this.transitions.clear();
  }

  private encode(source: string, generation: string): string {
    return `${REVISION_PREFIX}${JSON.stringify([this.session, generation, source])}`;
  }
}
