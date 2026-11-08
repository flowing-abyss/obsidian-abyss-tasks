import type { z } from 'zod';
import type {
  ContentPlanV1,
  EffectStateV1,
  NotePlanV1,
  NoteReadPageV1,
  ProjectDtoV1,
  ProjectFieldAssignmentV1,
  TaskTreePageV1,
  TaskTreeV1,
  TasksApiV1,
} from '../../api';
import type { notePrepareSchema, prepareSchema } from './commandSchemas';

export type CommandStatusKind =
  'thinking' | 'searching' | 'ready' | 'question' | 'writing' | 'saved' | 'error';
export interface CommandStatus {
  readonly kind: CommandStatusKind;
  readonly message: string;
}
export type CommandFocus =
  | {
      readonly kind: 'task';
      readonly target: string;
      readonly revision?: string;
      readonly plan?: string;
      readonly expectedPlanRevision?: string;
    }
  | { readonly kind: 'project' | 'note'; readonly target: string; readonly revision?: string };
export type CommandFocusContinuations = ReadonlyMap<
  string,
  { target: string; revision: string } | null
>;
export type CommandChange =
  | { readonly kind: 'task'; readonly plan: ContentPlanV1 }
  | { readonly kind: 'note'; readonly plan: NotePlanV1 }
  | {
      readonly kind: 'project';
      readonly before: ProjectDtoV1;
      readonly fields?: readonly ProjectFieldAssignmentV1[];
      readonly statusId?: string | null;
    }
  | {
      readonly kind: 'status';
      readonly target: string;
      readonly revision: string;
      readonly symbol: string;
      readonly plan?: string;
      readonly nuance: string;
    }
  | {
      readonly kind: 'link';
      readonly plan: ContentPlanV1;
      readonly notePlan: string;
      readonly target: string;
      readonly field: 'description' | 'markdownTitle';
      readonly template: string;
      readonly placeholder: string;
      readonly sourcePath: string;
      readonly alias: string;
    }
  | {
      readonly kind: 'cleanup';
      readonly plan: ContentPlanV1;
      readonly destinationPlan: string;
      readonly destinationRevision: string;
    };
export interface CommandProposal {
  readonly revision: number;
  readonly operations: number;
  readonly changes: readonly CommandChange[];
}
export interface CommandJournalEntry {
  readonly id: string;
  readonly proposalRevision: number;
  readonly change: CommandChange;
  readonly request: { readonly requestId: string; readonly expiresAt: number };
  readonly state: 'admitted' | 'settled';
  readonly effects?: EffectStateV1;
  readonly receipt?: unknown;
  readonly error?: string;
}
export interface CommandExchange {
  readonly role: 'user' | 'agent';
  readonly text: string;
}
export interface CommandSubmissionBasis {
  readonly sessionId: string;
  readonly proposalRevision: number;
}
export type CommandPendingTransition =
  | {
      readonly kind: 'focus';
      readonly target: readonly CommandFocus[];
      readonly previousQuestion?: string | null;
    }
  | { readonly kind: 'new-session'; readonly previousQuestion?: string | null };
export type CommandTransitionDisposition = 'save' | 'keep' | 'discard' | 'cancel';
export type CommandPreparation =
  | { readonly kind: 'task'; readonly input: z.output<typeof prepareSchema> }
  | { readonly kind: 'note'; readonly input: z.output<typeof notePrepareSchema> };
export interface CommandSessionSnapshot {
  readonly recovery?: 'live' | 'historical' | 'reviewing' | 'uncertain';
  readonly preparations?: readonly CommandPreparation[];
  readonly recoveryEvidence?: {
    readonly proposal: CommandProposal;
    readonly focus: readonly CommandFocus[];
    readonly preparations: readonly CommandPreparation[];
  };
  readonly pendingTransition?: CommandPendingTransition | null;
  readonly submissionBasis?: CommandSubmissionBasis;
  readonly id: string;
  readonly input: string;
  readonly focus: readonly CommandFocus[];
  readonly context: string;
  readonly trees: ReadonlyArray<{
    readonly before: TaskTreeV1 | null;
    readonly after: TaskTreeV1 | null;
  }>;
  readonly entities: {
    readonly tasks: readonly TaskTreePageV1[];
    readonly projects: readonly ProjectDtoV1[];
    readonly notes: readonly NoteReadPageV1[];
  };
  readonly exchanges: readonly CommandExchange[];
  readonly activeQuestion: string | null;
  readonly status: CommandStatus;
  readonly proposal: CommandProposal;
  readonly journal: readonly CommandJournalEntry[];
  readonly actual: readonly TaskTreeV1[];
  readonly blocked: boolean;
}
export interface CommandAgentPort {
  run(input: { text: string; signal: AbortSignal; session: CommandSessionSnapshot }): Promise<void>;
}
/** Required awaited durability boundary. Task9 supplies device/vault persistence; never default to a no-op. */
export interface CommandJournalPort {
  save(snapshot: CommandSessionSnapshot): Promise<void>;
}
export interface CommandSessionTransitions {
  start(
    previous: CommandSessionSnapshot,
    next: CommandSessionSnapshot,
    current: () => boolean,
  ): Promise<void>;
}
export interface CommandSessionOptions {
  readonly api: TasksApiV1;
  readonly agent: CommandAgentPort;
  readonly journal: CommandJournalPort;
  readonly now: () => number;
  readonly id: () => string;
  readonly context?: string;
  readonly transitions?: CommandSessionTransitions;
  readonly onDispose?: () => void;
}
export interface CommandResearchResult {
  readonly query: string;
  readonly summary: string;
  readonly sources: ReadonlyArray<{
    readonly url: string;
    readonly title: string | null;
    readonly snippet: string | null;
    readonly content: string | null;
    readonly evidence: 'citation' | 'retrieved-url' | 'provider-excerpt';
  }>;
  readonly truncated: boolean;
}
export interface CommandResearchPort {
  search(query: string, signal: AbortSignal): Promise<CommandResearchResult>;
}
export class CommandFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'CommandFailure';
  }
}
export function required<T>(value: T | undefined): T {
  if (value === undefined)
    throw new CommandFailure('UNSUPPORTED', 'This operation is unavailable.');
  return value;
}
