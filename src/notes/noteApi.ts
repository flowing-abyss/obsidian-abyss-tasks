import { frontmatterRange } from '../markdown/frontmatterRange';
import type { AcceptedNoteSource, NoteSourceReadApi, TaskReadObservation } from './NoteSourceApi';

export interface NoteRange {
  readonly from: number;
  readonly to: number;
  readonly kind: 'prose' | 'heading' | 'block' | 'frontmatter' | 'task' | 'other';
  readonly label?: string;
  readonly editable: boolean;
  readonly appendOnly?: true;
}
export interface NoteSelection {
  readonly source: AcceptedNoteSource;
  readonly range: { readonly from: number; readonly to: number };
  readonly selection: 'note' | 'heading' | 'block' | 'section';
  readonly subpath?: string;
}
export class NoteFailure extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
export interface NoteTaskStage {
  forward(live: string): string | undefined;
  install(file: object): Promise<boolean>;
  reject(file: object): Promise<void>;
  release(): void;
}
export interface NoteReplacement {
  readonly range: NoteRange;
  readonly replacement: string;
}
export interface NoteTaskProtection {
  preservesAll(before: string, after: string, edits: readonly NoteReplacement[]): boolean;
  stageAll(
    source: AcceptedNoteSource,
    candidate: string,
    edits: readonly NoteReplacement[],
  ): NoteTaskStage | undefined;
  ranges(content: string): readonly NoteRange[];
  preserves(before: string, after: string, range: NoteRange, replacement: string): boolean;
  stage(
    source: AcceptedNoteSource,
    candidate: string,
    range: NoteRange,
    replacement: string,
  ): NoteTaskStage | undefined;
}
export interface NoteCommitOutcome {
  readonly code?: string;
  readonly noteEffects: 'unchanged' | 'committed' | 'unknown';
  readonly destinationEffects: 'unchanged' | 'committed' | 'unknown';
  readonly source?: AcceptedNoteSource;
  readonly noop?: boolean;
  readonly section?: NoteRange;
}
export interface PreparedNote {
  readonly kind: 'edit' | 'create';
  readonly path: string;
  readonly before: string | null;
  readonly after: string;
  readonly retainedBytes: number;
  readonly source?: AcceptedNoteSource;
  readonly sections?: ReadonlyArray<{
    readonly range: NoteRange;
    readonly before: string;
    readonly after: string;
  }>;
  readonly refineSection?: (range: NoteRange, text: string, append: boolean) => PreparedNote;
  readonly refineBody?: (text: string) => PreparedNote;
  validate(): void;
  commit(): Promise<NoteCommitOutcome>;
}
export interface NoteApplicationApi {
  readonly sources: NoteSourceReadApi;
  capture(): TaskReadObservation;
  sections(source: AcceptedNoteSource): readonly NoteRange[];
  resolve(from: AcceptedNoteSource, wikiLink: string): Promise<NoteSelection>;
  link(selection: NoteSelection, from: AcceptedNoteSource, alias?: string): string;
  linkFromPath(selection: NoteSelection, fromPath: string, alias?: string): string;
  matcher(
    query: string,
  ): (text: string) => { readonly matches: ReadonlyArray<readonly [number, number]> } | null;
  prepareEdit(
    source: AcceptedNoteSource,
    range: NoteRange,
    text: string,
    append: boolean,
  ): PreparedNote;
  prepareCreate(
    path: string,
    title: string,
    text: string,
    options?: { readonly template?: AcceptedNoteSource; readonly collision?: 'reject' | 'suffix' },
  ): Promise<PreparedNote>;
}

export const NOTE_LIMITS = Object.freeze({
  defaultPageCharacters: 16_384,
  maxPageCharacters: 65_536,
  maxSectionsPerPage: 64,
  maxEditsPerPlan: 20,
  defaultSearchMatches: 50,
  maxSearchMatches: 100,
  searchSourceCharacterTarget: 262_144,
  maxSingleSearchSourceCharacters: 4_194_304,
  maxSearchQueryCharacters: 4096,
  maxSearchSources: 128,
  snippetCharacters: 512,
  cursorTtlMs: 60_000,
  maxCursors: 1024,
  handleTtlMs: 1_800_000,
  maxNoteHandles: 50_000,
  maxSectionHandles: 50_000,
  maxPlanTextBytes: 262_144,
  maxInputBytes: 262_144,
  maxRetainedPlanBytes: 4 * 1024 * 1024,
  maxRetainedRequestBytes: 4 * 1024 * 1024,
  planTtlMs: 300_000,
  maxPlans: 128,
});

export function noteBody(source: AcceptedNoteSource): string {
  return source.content.slice(frontmatterRange(source.content)?.bodyFrom ?? 0);
}
