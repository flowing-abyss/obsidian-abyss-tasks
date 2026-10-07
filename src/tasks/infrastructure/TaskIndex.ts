import {
  getAllTags,
  TFile,
  type App,
  type CachedMetadata,
  type EventRef,
  type TAbstractFile,
} from 'obsidian';
import { extractMarkdownBodyTags } from '../../markdown/markdownTagRename';
import { sameTag } from '../../markdown/tagSyntax';
import type {
  CalendarProjectionSources,
  CalendarTaskSource,
  TaskDependencyQueryApi,
  TaskIndexEvent,
  TaskQuery,
  TaskQueryApi,
  TaskSearchEligibilityBatch,
  TaskSearchEligibilityRequest,
  TimeTrackingQueryApi,
} from '../application/TaskApplicationApi';
import type { TaskReadProjectionApi } from '../application/TaskSearchApi';
import type {
  TaskSearchDocument,
  TaskSearchFileVersion,
  TaskSearchSource,
  TaskSearchSourceEvent,
  TaskSearchSourceNode,
  TaskSearchSourceState,
} from '../application/TaskSearchSource';
import { cloneTaskSnapshot, taskSnapshotWithStatuses } from '../domain/cloneTaskSnapshot';
import type { TaskResolutionCandidate } from '../domain/commands';
import { readCommentBlock } from '../domain/commentSource';
import type { StatusCatalog } from '../domain/StatusCatalog';
import {
  assembleTaskDependencyGraphSteps,
  enumerateTaskNodes,
  type TaskDependencyEligibility,
  type TaskDependencyGraph,
  type TaskDependencyProjection,
  type TaskNodeSnapshot,
} from '../domain/taskDependencies';
import { readTaskLinePrefix } from '../domain/taskLineSourceModel';
import {
  reconcileRootTransitions,
  taskReconciliationKey,
  type ProvenRootRevisionOverride,
  type ProvenRootTransition,
  type RootReconciliationBasis,
  type TaskResolution,
  type VisualEvidence,
} from '../domain/taskReconciliation';
import {
  nodeAtSearchAddress,
  observedTaskTags,
  taskOrganizationRecord,
  taskTreeNodes,
} from '../domain/taskSearchProjection';
import {
  TaskSearchError,
  type TaskDependencySummary,
  type TaskOrganizationBatch,
  type TaskOrganizationRecord,
  type TaskOrganizationRequest,
  type TaskSearchAddress,
  type TaskSearchHit,
  type TaskSearchHydratedHit,
} from '../domain/taskSearchTypes';
import type { OffsetAt } from '../domain/timeEntry';
import type { TrackedEntry, TrackedTotal } from '../domain/timeTracking';
import {
  sameTaskNodeRef,
  type LocalDate,
  type SubtaskSnapshot,
  type TaskNodeRef,
  type TaskRef,
  type TaskSnapshot,
} from '../domain/types';
import { TaskBlockEditor } from './markdown/TaskBlockEditor';
import {
  consumeMarkdownFenceLine,
  parseMarkdownFrontmatter,
  type MarkdownFence,
} from './markdown/taskBlockSyntax';
import { TaskLocator } from './markdown/TaskLocator';
import { TaskMarkdownCodec } from './markdown/TaskMarkdownCodec';
import { projectTaskSnapshot } from './markdown/TaskSnapshotProjector';
import { taskSearchDocument } from './search/taskSearchDocuments';
import { calendarDatesForPlanning, calendarRangeForPlanning, TaskDateIndex } from './TaskDateIndex';
import {
  type RootRevisionOverride,
  type TaskRefAuthority,
  type TaskSnapshotState,
} from './TaskRefAuthority';
import { TimeEntryIndex } from './TimeEntryIndex';

export interface TaskIndexOptions {
  readonly readYield?: (signal: AbortSignal) => Promise<void>;
  readonly statusCatalog: StatusCatalog;
  readonly refAuthority?: TaskRefAuthority;
  readonly excludeSource?: (source: TaskSourceMetadata) => boolean;
  /**
   * Resolves a written time entry stamp that carries no offset of its own. Runtime uses the
   * device, so this is here for the tests that project a fixed zone across a daylight saving jump.
   */
  readonly timeZoneOffsetAt?: OffsetAt;
}

/** Detached note metadata available to the composition-root source exclusion policy. */
export interface TaskSourceMetadata {
  readonly filePath: string;
  readonly tags: readonly string[];
  readonly frontmatter: Readonly<Record<string, unknown>>;
}

/** Use the host random source already used by TaskRefAuthority, including mobile runtimes. */
function searchEpoch(): string {
  const values = new Uint32Array(4);
  window.crypto.getRandomValues(values);
  return [...values].map((value) => value.toString(36)).join('-');
}

function immutableSearchEvent(event: TaskSearchSourceEvent): TaskSearchSourceEvent {
  if (event.type === 'files')
    return Object.freeze({
      ...event,
      files: Object.freeze(event.files.map((file) => Object.freeze({ ...file }))),
    });
  if (event.type === 'state')
    return Object.freeze({ ...event, state: Object.freeze({ ...event.state }) });
  return Object.freeze({ ...event });
}

function freezeDetached<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeDetached(child);
    Object.freeze(value);
  }
  return value;
}

const deviceOffsetAt: OffsetAt = (epochMs) => -new Date(epochMs).getTimezoneOffset();

type Listener = (event: TaskIndexEvent) => void;

interface FileLifecycle {
  path: string | undefined;
  generation: number;
}

interface FileObservation {
  readonly file: TFile;
  readonly path: string;
  readonly generation: number;
}

interface WritableReconciliationTransition {
  readonly previous: TaskSnapshot;
  readonly current: TaskSnapshot;
  readonly evidence: ProvenRootTransition['evidence'];
  readonly basis: RootReconciliationBasis;
}

interface VisualReconciliationTransition {
  readonly stale: TaskRef;
  readonly current: TaskSnapshot;
  readonly evidence: VisualEvidence;
}

interface FileReconciliationTransition {
  readonly fromGeneration: number;
  readonly toGeneration: number;
  readonly writable: ReadonlyMap<string, WritableReconciliationTransition>;
  readonly visual: ReadonlyMap<string, VisualReconciliationTransition>;
}

function cloneCandidate(task: TaskSnapshot): TaskResolutionCandidate {
  const root = cloneTaskSnapshot(task);
  return {
    root,
    target: { type: 'task', ref: { ...root.ref } },
  };
}

function stableTaskOrder(left: TaskSnapshot, right: TaskSnapshot): number {
  const pathOrder = left.source.filePath.localeCompare(right.source.filePath);
  return pathOrder !== 0 ? pathOrder : left.source.line - right.source.line;
}

function targetPath(target: TaskNodeRef): readonly number[] {
  const path: number[] = [];
  let current = target;
  while (current.type === 'subtask') {
    path.push(current.ref.relativeLine);
    current = current.ref.parent;
  }
  path.reverse();
  return path;
}

function stableCalendarSourceOrder(left: CalendarTaskSource, right: CalendarTaskSource): number {
  const rootOrder = stableTaskOrder(left.root, right.root);
  if (rootOrder !== 0) return rootOrder;
  const leftPath = targetPath(left.target);
  const rightPath = targetPath(right.target);
  const shared = Math.min(leftPath.length, rightPath.length);
  for (let index = 0; index < shared; index++) {
    const leftPart = leftPath[index];
    const rightPart = rightPath[index];
    if (leftPart === undefined || rightPart === undefined) continue;
    const order = leftPart - rightPart;
    if (order !== 0) return order;
  }
  return leftPath.length - rightPath.length;
}

function calendarSources(tasks: readonly TaskSnapshot[]): readonly CalendarTaskSource[] {
  const sources: CalendarTaskSource[] = [];
  const visit = (root: TaskSnapshot, subtasks: readonly SubtaskSnapshot[]): void => {
    for (const node of subtasks) {
      const target: TaskNodeRef = { type: 'subtask', ref: node.ref };
      if (node.recurrence !== undefined) sources.push({ root, target, node });
      visit(root, node.subtasks);
    }
  };
  for (const root of tasks) {
    sources.push({ root, target: { type: 'task', ref: root.ref }, node: root });
    visit(root, root.subtasks);
  }
  return sources;
}

interface ClonedCalendarRoot {
  readonly root: TaskSnapshot;
  readonly nodes: ReadonlyMap<TaskSnapshot | SubtaskSnapshot, TaskSnapshot | SubtaskSnapshot>;
}

function cloneCalendarRoot(original: TaskSnapshot): ClonedCalendarRoot {
  const root = cloneTaskSnapshot(original);
  const nodes = new Map<TaskSnapshot | SubtaskSnapshot, TaskSnapshot | SubtaskSnapshot>([
    [original, root],
  ]);
  const pending: Array<{
    readonly originals: readonly SubtaskSnapshot[];
    readonly clones: readonly SubtaskSnapshot[];
  }> = [{ originals: original.subtasks, clones: root.subtasks }];
  while (pending.length > 0) {
    const pair = pending.pop();
    if (pair === undefined) break;
    if (pair.originals.length !== pair.clones.length) {
      throw new Error('calendar-source-clone-shape-mismatch');
    }
    for (let index = 0; index < pair.originals.length; index++) {
      const sourceNode = pair.originals[index];
      const clonedNode = pair.clones[index];
      if (sourceNode === undefined || clonedNode === undefined) {
        throw new Error('calendar-source-clone-shape-mismatch');
      }
      nodes.set(sourceNode, clonedNode);
      pending.push({ originals: sourceNode.subtasks, clones: clonedNode.subtasks });
    }
  }
  return { root, nodes };
}

function cloneCalendarTaskSource(
  source: CalendarTaskSource,
  roots: Map<TaskSnapshot, ClonedCalendarRoot>,
): CalendarTaskSource {
  let graph = roots.get(source.root);
  if (graph === undefined) {
    graph = cloneCalendarRoot(source.root);
    roots.set(source.root, graph);
  }
  const node = graph.nodes.get(source.node);
  if (node === undefined) throw new Error('calendar-source-node-missing');
  const target: TaskNodeRef =
    source.target.type === 'task'
      ? { type: 'task', ref: graph.root.ref }
      : { type: 'subtask', ref: (node as SubtaskSnapshot).ref };
  return { root: graph.root, target, node };
}

function immutableEvent(event: TaskIndexEvent): TaskIndexEvent {
  if (event.type === 'changed') {
    return Object.freeze({ type: 'changed', files: Object.freeze([...event.files]) });
  }
  return Object.freeze({ ...event });
}

/** Runs one subscriber; a throw is reported and does not stop delivery to the others. */
function deliverIsolated<T>(
  event: TaskIndexEvent['type'] | 'reconciled',
  listener: (value: T) => void,
  value: T,
): void {
  try {
    listener(value);
  } catch (error) {
    console.error('[abyss-tasks] task index listener failed', { event, error });
  }
}

interface FallbackListItem {
  readonly task?: string;
  readonly parent: number;
  readonly position: {
    readonly start: { readonly line: number; readonly col: number; readonly offset: number };
    readonly end: { readonly line: number; readonly col: number; readonly offset: number };
  };
}

interface FallbackListAncestor {
  readonly line: number;
  readonly indent: number;
}

interface FallbackFenceTransition {
  readonly active: MarkdownFence | undefined;
  readonly skip: boolean;
  readonly opening: boolean;
}

interface FallbackScanState {
  readonly items: FallbackListItem[];
  readonly ancestorsByQuoteDepth: Map<number, FallbackListAncestor[]>;
  offset: number;
  frontmatter: boolean;
  fence: MarkdownFence | undefined;
  previousQuoteDepth: number | undefined;
}

interface FallbackListLine {
  readonly line: string;
  readonly lineNumber: number;
  readonly quoteDepth: number;
  readonly prefix: string;
}

const FALLBACK_LIST_ITEM_RE = /^([\s>]*)(?:[-*+]|\d+[.)])\s+/u;
const FALLBACK_PREFIX_RE = /^([\s>]*)/u;

function fallbackFenceState(
  line: string,
  active: MarkdownFence | undefined,
): FallbackFenceTransition {
  const consumed = consumeMarkdownFenceLine(active, line);
  return { active: consumed.fence, skip: !consumed.isContent, opening: consumed.opened };
}

function transitionFallbackQuoteDepth(
  quoteDepth: number,
  previousQuoteDepth: number | undefined,
  ancestorsByQuoteDepth: Map<number, FallbackListAncestor[]>,
): number {
  if (previousQuoteDepth !== undefined && previousQuoteDepth !== quoteDepth) {
    ancestorsByQuoteDepth.clear();
  }
  return quoteDepth;
}

function transitionFallbackNonListBoundary(
  quoteDepth: number,
  indent: number,
  previousQuoteDepth: number | undefined,
  ancestorsByQuoteDepth: Map<number, FallbackListAncestor[]>,
): number {
  const nextQuoteDepth = transitionFallbackQuoteDepth(
    quoteDepth,
    previousQuoteDepth,
    ancestorsByQuoteDepth,
  );
  const ancestors = ancestorsByQuoteDepth.get(quoteDepth) ?? [];
  while ((ancestors[ancestors.length - 1]?.indent ?? Number.NEGATIVE_INFINITY) >= indent) {
    ancestors.pop();
  }
  ancestorsByQuoteDepth.set(quoteDepth, ancestors);
  return nextQuoteDepth;
}

function fallbackIndent(prefix: string): number {
  return prefix.replace(/\t/gu, '    ').length;
}

function advanceFallbackOffset(state: FallbackScanState, line: string): void {
  state.offset += line.length + 1;
}

function consumeFallbackFrontmatter(
  state: FallbackScanState,
  line: string,
  lineNumber: number,
): boolean {
  if (!state.frontmatter) return false;
  if (lineNumber > 0 && line.trim() === '---') state.frontmatter = false;
  advanceFallbackOffset(state, line);
  return true;
}

function transitionFallbackBoundary(
  state: FallbackScanState,
  quoteDepth: number,
  prefix: string,
): void {
  state.previousQuoteDepth = transitionFallbackNonListBoundary(
    quoteDepth,
    fallbackIndent(prefix),
    state.previousQuoteDepth,
    state.ancestorsByQuoteDepth,
  );
}

function consumeFallbackFence(
  state: FallbackScanState,
  line: string,
  quoteDepth: number,
  prefix: string,
): boolean {
  const transition = fallbackFenceState(line, state.fence);
  state.fence = transition.active;
  if (!transition.skip) return false;
  if (transition.opening) transitionFallbackBoundary(state, quoteDepth, prefix);
  advanceFallbackOffset(state, line);
  return true;
}

function fallbackParent(
  ancestors: FallbackListAncestor[],
  indent: number,
  lineNumber: number,
): number {
  while ((ancestors[ancestors.length - 1]?.indent ?? Number.NEGATIVE_INFINITY) >= indent) {
    ancestors.pop();
  }
  return ancestors[ancestors.length - 1]?.line ?? -(lineNumber + 1);
}

function appendFallbackListItem(state: FallbackScanState, item: FallbackListLine): void {
  const { line, lineNumber, quoteDepth, prefix } = item;
  state.previousQuoteDepth = transitionFallbackQuoteDepth(
    quoteDepth,
    state.previousQuoteDepth,
    state.ancestorsByQuoteDepth,
  );
  const indent = fallbackIndent(prefix);
  const ancestors = state.ancestorsByQuoteDepth.get(quoteDepth) ?? [];
  const task = readTaskLinePrefix(line)?.statusSymbol;
  state.items.push({
    ...(task !== undefined && { task }),
    parent: fallbackParent(ancestors, indent, lineNumber),
    position: {
      start: { line: lineNumber, col: prefix.length, offset: state.offset },
      end: { line: lineNumber, col: line.length, offset: state.offset + line.length },
    },
  });
  ancestors.push({ line: lineNumber, indent });
  state.ancestorsByQuoteDepth.set(quoteDepth, ancestors);
}

function consumeFallbackLine(state: FallbackScanState, line: string, lineNumber: number): void {
  if (consumeFallbackFrontmatter(state, line, lineNumber)) return;
  const leadingPrefix = FALLBACK_PREFIX_RE.exec(line)?.[1] ?? '';
  const quoteDepth = [...leadingPrefix].filter((character) => character === '>').length;
  if (consumeFallbackFence(state, line, quoteDepth, leadingPrefix)) return;
  if (/^[\s>]*$/u.test(line)) {
    advanceFallbackOffset(state, line);
    return;
  }
  const listMatch = FALLBACK_LIST_ITEM_RE.exec(line);
  if (listMatch == null) {
    transitionFallbackBoundary(state, quoteDepth, leadingPrefix);
    advanceFallbackOffset(state, line);
    return;
  }
  appendFallbackListItem(state, {
    line,
    lineNumber,
    quoteDepth,
    prefix: listMatch[1] ?? '',
  });
  advanceFallbackOffset(state, line);
}

function fallbackListItems(data: string): FallbackListItem[] {
  const lines = data.split('\n');
  const state: FallbackScanState = {
    items: [],
    ancestorsByQuoteDepth: new Map(),
    offset: 0,
    frontmatter: lines[0]?.trim() === '---',
    fence: undefined,
    previousQuoteDepth: undefined,
  };
  let lineNumber = 0;
  while (lineNumber < lines.length) {
    const comment =
      !state.frontmatter && state.fence === undefined
        ? readCommentBlock(lines, lineNumber)
        : undefined;
    consumeFallbackLine(state, lines[lineNumber] ?? '', lineNumber);
    // Accepted continuations belong to the list head even when quote spacing changes.
    // Their raw indentation must not pop the head's task ancestors.
    if (comment !== undefined) {
      for (let continuation = lineNumber + 1; continuation < comment.toExclusive; continuation++)
        advanceFallbackOffset(state, lines[continuation] ?? '');
      lineNumber = comment.toExclusive;
    } else lineNumber++;
  }
  return state.items;
}

function cacheWithContentFallback(
  data: string,
  cache: CachedMetadata | null | undefined,
): CachedMetadata {
  const fallbackItems = fallbackListItems(data);
  const cachedByLine = metadataItemsByLine(cache?.listItems ?? []);
  const listItems = fallbackItems.map((item) => ({
    ...cachedByLine.get(item.position.start.line),
    ...item,
  }));
  return { ...(cache ?? {}), listItems };
}

function frontmatterFromContent(data: string): Record<string, unknown> | undefined {
  const frontmatter = parseMarkdownFrontmatter(data.split(/\r?\n/u));
  return frontmatter.type === 'valid' ? frontmatter.value : undefined;
}

function extensionOf(path: string): string {
  const name = path.replace(/^.*\//u, '');
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot + 1) : '';
}

type MetadataListItem = NonNullable<CachedMetadata['listItems']>[number];

interface ParseFileInput {
  readonly filePath: string;
  readonly content: string;
  readonly cache: CachedMetadata;
  readonly allocateSuccessor?: boolean;
  readonly captureAuthorityTransitions?: (
    transitions: readonly ProvenRootRevisionOverride[],
    restored?: true,
  ) => void;
  readonly observedFile?: boolean;
}

interface ReconciledRevisionContext {
  readonly overrides: ReadonlyMap<number, RootRevisionOverride>;
  readonly priorByLine: ReadonlyMap<number, TaskSnapshot>;
  readonly priorBySource: ReadonlyMap<string, readonly TaskSnapshot[]>;
  readonly currentSourceCounts: ReadonlyMap<string, number>;
  readonly currentByLine: ReadonlyMap<number, { readonly source: string }>;
  readonly allocateSuccessor: boolean;
  readonly observedFile: boolean;
}

interface ReconciledRevisionInput extends ReconciledRevisionContext {
  readonly line: number;
  readonly source: string;
  readonly sourceCount: number;
}

interface FileParseContext {
  readonly filePath: string;
  readonly lines: readonly string[];
  readonly blockByLine: ReadonlyMap<number, { readonly source: string }>;
  readonly sourceCounts: ReadonlyMap<string, number>;
  readonly codec: TaskMarkdownCodec;
  readonly presentation: TaskSnapshot['presentation'];
  readonly itemByLine: ReadonlyMap<number, MetadataListItem>;
  readonly revision: ReconciledRevisionContext;
  readonly offsetAt: OffsetAt;
}

function reusablePriorRevision(input: ReconciledRevisionInput): string | undefined {
  const hinted = input.priorByLine.get(input.line);
  const prior = input.priorBySource.get(input.source) ?? [];
  const duplicateRevision = unchangedDuplicateRevision(input, hinted, prior);
  if (duplicateRevision !== undefined) return duplicateRevision;
  const uniqueCurrentSource = input.sourceCount === 1;
  const uniquePriorSource = prior.length === 1;
  if (hinted?.source.originalBlock === input.source && uniqueCurrentSource && uniquePriorSource) {
    return hinted.ref.revision;
  }
  const priorTask = prior[0];
  return uniqueCurrentSource && uniquePriorSource ? priorTask?.ref.revision : undefined;
}

function unchangedDuplicateRevision(
  input: ReconciledRevisionInput,
  hinted: TaskSnapshot | undefined,
  prior: readonly TaskSnapshot[],
): string | undefined {
  if (hinted === undefined || input.sourceCount < 2) return undefined;
  return prior.length === input.sourceCount &&
    hinted.source.originalBlock === input.source &&
    prior.every((task) => input.currentByLine.get(task.ref.line)?.source === input.source)
    ? hinted.ref.revision
    : undefined;
}

function hintedSourceWasRelocated(input: ReconciledRevisionInput, hinted: TaskSnapshot): boolean {
  const source = hinted.source.originalBlock;
  const uniqueCurrentSource = (input.currentSourceCounts.get(source) ?? 0) === 1;
  const uniquePriorSource = (input.priorBySource.get(source)?.length ?? 0) === 1;
  return uniqueCurrentSource && uniquePriorSource;
}

function shouldAllocateSuccessor(
  input: ReconciledRevisionInput,
  hinted: TaskSnapshot | undefined,
): hinted is TaskSnapshot {
  return (
    hinted !== undefined && input.allocateSuccessor && !hintedSourceWasRelocated(input, hinted)
  );
}

function shouldMintAuthorityRevision(input: ReconciledRevisionInput): boolean {
  return (input.observedFile || input.sourceCount > 1) && input.allocateSuccessor;
}

function mismatchedDuplicatePopulation(
  sourceMatches: readonly TaskSnapshot[],
  sourceLines: readonly number[] | undefined,
): boolean {
  if (sourceLines === undefined || Math.max(sourceMatches.length, sourceLines.length) < 2)
    return false;
  return (
    sourceMatches.length !== sourceLines.length ||
    sourceMatches.some((task, index) => task.ref.line !== sourceLines[index])
  );
}

function countBlockSources(
  blocks: Iterable<{ readonly source: string }>,
): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const block of blocks) counts.set(block.source, (counts.get(block.source) ?? 0) + 1);
  return counts;
}

function priorTasksBySource(
  tasks: readonly TaskSnapshot[],
): ReadonlyMap<string, readonly TaskSnapshot[]> {
  const tasksBySource = new Map<string, TaskSnapshot[]>();
  for (const task of tasks) {
    const matches = tasksBySource.get(task.source.originalBlock) ?? [];
    matches.push(task);
    tasksBySource.set(task.source.originalBlock, matches);
  }
  return tasksBySource;
}

function frontmatterText(
  frontmatter: CachedMetadata['frontmatter'],
  key: string,
): string | undefined {
  if (frontmatter == null) return undefined;
  const value: unknown = (frontmatter as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : undefined;
}

function taskPresentation(
  frontmatter: CachedMetadata['frontmatter'],
): TaskSnapshot['presentation'] {
  const noteColor = frontmatterText(frontmatter, 'color');
  const noteTextColor = frontmatterText(frontmatter, 'textColor');
  const noteIcon = frontmatterText(frontmatter, 'icon');
  const presentation: {
    linkCount: number;
    noteColor?: string;
    noteTextColor?: string;
    noteIcon?: string;
  } = { linkCount: 0 };
  if (nonEmpty(noteColor)) presentation.noteColor = noteColor;
  if (nonEmpty(noteTextColor)) presentation.noteTextColor = noteTextColor;
  if (nonEmpty(noteIcon)) presentation.noteIcon = noteIcon;
  return presentation;
}

function metadataItemsByLine(
  items: readonly MetadataListItem[],
): ReadonlyMap<number, MetadataListItem> {
  return new Map(items.map((item) => [item.position.start.line, item] as const));
}

function hasTaskAncestor(
  item: MetadataListItem,
  itemByLine: ReadonlyMap<number, MetadataListItem>,
): boolean {
  let parentLine = item.parent;
  const seen = new Set<number>();
  while (parentLine >= 0 && !seen.has(parentLine)) {
    if (parentLine === item.position.start.line) return false;
    seen.add(parentLine);
    const parent = itemByLine.get(parentLine);
    if (parent == null) return false;
    if (parent.task !== undefined) return true;
    parentLine = parent.parent;
  }
  return false;
}

function relocateSubtask(task: SubtaskSnapshot, parent: TaskNodeRef): SubtaskSnapshot {
  const ref = { ...task.ref, parent };
  const node: TaskNodeRef = { type: 'subtask', ref };
  return {
    ...task,
    ref,
    subtasks: task.subtasks.map((child) => relocateSubtask(child, node)),
    comments: task.comments.map((comment) => ({
      ...comment,
      ref: { ...comment.ref, parent: node },
    })),
  };
}

function relocateSnapshot(task: TaskSnapshot, filePath: string): TaskSnapshot {
  const ref = { ...task.ref, filePath };
  const node: TaskNodeRef = { type: 'task', ref };
  const { linkCount, noteColor, noteTextColor, noteIcon } = task.presentation;
  return {
    ...task,
    ref,
    source: { ...task.source, filePath },
    subtasks: task.subtasks.map((child) => relocateSubtask(child, node)),
    comments: task.comments.map((comment) => ({
      ...comment,
      ref: { ...comment.ref, parent: node },
    })),
    presentation: {
      linkCount,
      ...(Boolean(noteColor) && { noteColor }),
      ...(Boolean(noteTextColor) && { noteTextColor }),
      ...(Boolean(noteIcon) && { noteIcon }),
    },
  };
}

function nonEmpty(value: string | undefined): value is string {
  return value !== undefined && value.length > 0;
}

function hasOnlyFilePath(
  query: TaskQuery | undefined,
): query is TaskQuery & { readonly filePath: string } {
  return (
    query !== undefined &&
    nonEmpty(query.filePath) &&
    query.folder === undefined &&
    query.tag === undefined &&
    query.statuses === undefined &&
    query.dateRange === undefined
  );
}

function initialQueryTasks(
  taskMap: ReadonlyMap<string, readonly TaskSnapshot[]>,
  query: TaskQuery | undefined,
): readonly TaskSnapshot[] {
  if (hasOnlyFilePath(query)) return taskMap.get(query.filePath) ?? [];
  return [...taskMap.values()].flat();
}

function filterTasksByFile(
  tasks: readonly TaskSnapshot[],
  filePath: string | undefined,
): readonly TaskSnapshot[] {
  return nonEmpty(filePath) ? tasks.filter((task) => task.source.filePath === filePath) : tasks;
}

function filterTasksByFolder(
  tasks: readonly TaskSnapshot[],
  folder: string | undefined,
): readonly TaskSnapshot[] {
  return nonEmpty(folder) ? tasks.filter((task) => task.source.filePath.startsWith(folder)) : tasks;
}

function filterTasksByTag(
  tasks: readonly TaskSnapshot[],
  tag: string | undefined,
): readonly TaskSnapshot[] {
  return nonEmpty(tag)
    ? tasks.filter((task) => task.tags.some((candidate) => sameTag(candidate, tag)))
    : tasks;
}

function filterTasksByStatus(
  tasks: readonly TaskSnapshot[],
  statuses: TaskQuery['statuses'],
): readonly TaskSnapshot[] {
  return statuses !== undefined && statuses.length > 0
    ? tasks.filter((task) => statuses.includes(task.status))
    : tasks;
}

function filterTasksByDate(
  tasks: readonly TaskSnapshot[],
  dateRange: TaskQuery['dateRange'],
): readonly TaskSnapshot[] {
  if (dateRange == null) return tasks;
  const { from, to } = dateRange;
  return tasks.filter((task) => {
    const date = task.planning.due ?? task.planning.scheduled ?? task.planning.start;
    return date !== undefined && date >= from && date <= to;
  });
}

function filterQueryTasks(
  tasks: readonly TaskSnapshot[],
  query: TaskQuery | undefined,
): readonly TaskSnapshot[] {
  if (query === undefined) return tasks;
  const inFile = filterTasksByFile(tasks, query.filePath);
  const inFolder = filterTasksByFolder(inFile, query.folder);
  const withTag = filterTasksByTag(inFolder, query.tag);
  const withStatus = filterTasksByStatus(withTag, query.statuses);
  return filterTasksByDate(withStatus, query.dateRange);
}

function ambiguousResolution(tasks: readonly TaskSnapshot[]): TaskResolution {
  return { type: 'ambiguous', candidates: tasks.map(cloneCandidate) };
}

function clonedReconciliationBasis(basis: RootReconciliationBasis): RootReconciliationBasis {
  return {
    observed: cloneTaskSnapshot(basis.observed),
    ...(basis.previousRootAnchor != null && {
      previousRootAnchor: { ...basis.previousRootAnchor },
    }),
    ...(basis.nextRootAnchor != null && { nextRootAnchor: { ...basis.nextRootAnchor } }),
    ...(basis.authorityTransition != null && {
      authorityTransition: structuredClone(basis.authorityTransition),
    }),
  };
}

function transitionResolution(transition: WritableReconciliationTransition): TaskResolution {
  return {
    type: 'rebased',
    previous: cloneTaskSnapshot(transition.previous),
    current: cloneTaskSnapshot(transition.current),
    evidence: transition.evidence,
    basis: clonedReconciliationBasis(transition.basis),
  };
}

function legacyRelocationResolution(ref: TaskRef, match: TaskSnapshot): TaskResolution {
  const current = cloneTaskSnapshot(match);
  const observedSnapshot = cloneTaskSnapshot(current);
  const observed: TaskSnapshot = {
    ...observedSnapshot,
    ref: { ...ref },
    source: { ...observedSnapshot.source, line: ref.line },
  };
  return {
    type: 'rebased',
    previous: observed,
    current,
    evidence: 'byte-identical-relocation',
    basis: { observed },
  };
}

function visualResolution(
  ref: TaskRef,
  current: TaskSnapshot,
  evidence: VisualEvidence,
): TaskResolution {
  return {
    type: 'visual',
    stale: { ...ref },
    current: cloneTaskSnapshot(current),
    evidence,
  };
}

function authorityAmbiguityResolution(
  authority: TaskRefAuthority | undefined,
  sourceMatches: readonly TaskSnapshot[],
): TaskResolution | undefined {
  return authority != null && sourceMatches.length > 1
    ? ambiguousResolution(sourceMatches)
    : undefined;
}

function directRevisionResolution(
  ref: TaskRef,
  current: TaskSnapshot | undefined,
  matches: readonly TaskSnapshot[],
  authority: TaskRefAuthority | undefined,
): TaskResolution | undefined {
  if (matches.length > 1 && (authority === undefined || current?.ref.revision !== ref.revision))
    return ambiguousResolution(matches);
  if (current?.ref.revision !== ref.revision) return undefined;
  const task = cloneTaskSnapshot(current);
  return { type: 'exact', task, basis: { observed: cloneTaskSnapshot(task) } };
}

function writableRebaseResolution(
  authority: TaskRefAuthority | undefined,
  ref: TaskRef,
  matches: readonly TaskSnapshot[],
  transition: WritableReconciliationTransition | undefined,
): TaskResolution | undefined {
  if (transition != null) return transitionResolution(transition);
  if (authority != null || matches.length !== 1) return undefined;
  const match = matches[0];
  return match === undefined ? { type: 'not-found', ref } : legacyRelocationResolution(ref, match);
}

interface FallbackResolutionInput {
  readonly ref: TaskRef;
  readonly tasks: readonly TaskSnapshot[];
  readonly current: TaskSnapshot | undefined;
  readonly sourceMatches: readonly TaskSnapshot[];
  readonly visual: VisualReconciliationTransition | undefined;
}

function fallbackTaskResolution(input: FallbackResolutionInput): TaskResolution {
  const { ref, tasks, current, sourceMatches, visual } = input;
  if (sourceMatches.length > 1) return ambiguousResolution(sourceMatches);
  if (visual != null) return visualResolution(ref, visual.current, visual.evidence);
  if (current != null) return visualResolution(ref, current, 'same-line');
  if (sourceMatches.length === 1 || tasks.length > 0) {
    return { type: 'uncertain', ref: { ...ref } };
  }
  return { type: 'not-found', ref: { ...ref } };
}

function hasQueuedAuthorityTransition(
  filePath: string,
  changed: boolean,
  pendingFiles: ReadonlySet<string>,
  transition: FileReconciliationTransition | undefined,
): boolean {
  if (changed || !pendingFiles.has(filePath)) return false;
  return [...(transition?.writable.values() ?? [])].some(
    (candidate) => candidate.evidence === 'authority-transition',
  );
}

function activeRecurringSources(
  sources: readonly CalendarTaskSource[],
): readonly CalendarTaskSource[] {
  return sources.filter(
    ({ node }) =>
      node.recurrence !== undefined && (node.status === 'open' || node.status === 'in-progress'),
  );
}

type DependencyAssembly = Generator<void | 'boundary', TaskDependencyGraph | undefined>;
function drainDependencyAssembly(iterator: DependencyAssembly): TaskDependencyGraph {
  let step = iterator.next();
  while (step.done !== true) step = iterator.next();
  if (step.value === undefined)
    throw new TaskSearchError('unavailable', 'Dependency graph unavailable');
  return step.value;
}

interface DependencyPreparation {
  readonly generation: number;
  iterator: DependencyAssembly | undefined;
  readonly controller: AbortController;
  readonly waiters: Set<(error?: TaskSearchError) => void>;
  settled: boolean;
}

export class TaskIndex
  implements
    TaskQueryApi,
    TaskDependencyQueryApi,
    TimeTrackingQueryApi,
    TaskSnapshotState,
    TaskReadProjectionApi
{
  private readonly searchEpoch_abyssPrivate = searchEpoch();
  private searchGeneration_abyssPrivate = 0;
  private searchSemanticsRevision_abyssPrivate = 0;
  private nextSearchId_abyssPrivate = 1;
  private searchFailure_abyssPrivate: { readonly cause: unknown } | undefined;
  private readonly searchListeners_abyssPrivate = new Set<(event: TaskSearchSourceEvent) => void>();
  private readonly searchFiles_abyssPrivate = new Map<string, number>();
  private readonly searchTags_abyssPrivate = new Map<string, readonly string[]>();
  private readonly searchIdsByFile_abyssPrivate = new Map<string, number[]>();
  private readonly searchCoordinates_abyssPrivate = new Map<
    number,
    TaskSearchSourceNode & { readonly version: number; readonly rootOrdinal: number }
  >();
  private readonly taskMap_abyssPrivate = new Map<string, readonly TaskSnapshot[]>();
  private readonly timeEntryIndex_abyssPrivate = new TimeEntryIndex();
  private readonly calendarDateIndex_abyssPrivate = new TaskDateIndex<CalendarTaskSource>(
    (source) => calendarDatesForPlanning(source.node.planning),
    (source) => calendarRangeForPlanning(source.node.planning),
  );
  private readonly recurringSourcesByFile_abyssPrivate = new Map<
    string,
    readonly CalendarTaskSource[]
  >();
  private readonly fileGenerations_abyssPrivate = new Map<string, number>();
  private readonly committedContents_abyssPrivate = new Map<string, string>();
  private readonly reconciliationTransitions_abyssPrivate = new Map<
    string,
    FileReconciliationTransition
  >();
  private listeners_abyssPrivate: Listener[] = [];
  private reconciledListeners_abyssPrivate: Array<(files: readonly string[]) => void> = [];
  private readonly pendingFiles_abyssPrivate = new Set<string>();
  private readonly pendingReconciledFiles_abyssPrivate = new Set<string>();
  private fileLifecycles_abyssPrivate = new WeakMap<TFile, FileLifecycle>();
  private readonly pendingReads_abyssPrivate = new Set<Promise<void>>();
  private flushScheduled_abyssPrivate = false;
  private metadataCacheRefs_abyssPrivate: EventRef[] = [];
  private vaultRefs_abyssPrivate: EventRef[] = [];
  private initialization_abyssPrivate: Promise<void> | undefined;
  private initialized_abyssPrivate = false;
  private destroyed_abyssPrivate = false;
  private statusCatalog_abyssPrivate: StatusCatalog;
  private dependencyGraph_abyssPrivate: TaskDependencyGraph | undefined;
  private dependencyPreparation_abyssPrivate: DependencyPreparation | undefined;
  private readonly blockEditor_abyssPrivate = new TaskBlockEditor();
  private readonly locator_abyssPrivate: TaskLocator;
  private excludeSource_abyssPrivate: TaskIndexOptions['excludeSource'];

  constructor(
    private readonly app_abyssPrivate: App,
    private readonly options_abyssPrivate: TaskIndexOptions,
  ) {
    this.statusCatalog_abyssPrivate = options_abyssPrivate.statusCatalog;
    this.locator_abyssPrivate = new TaskLocator(options_abyssPrivate.refAuthority);
    this.excludeSource_abyssPrivate = options_abyssPrivate.excludeSource;
  }

  setStatusCatalog(statusCatalog: StatusCatalog): void {
    this.statusCatalog_abyssPrivate = statusCatalog;
    this.invalidateDependencies_abyssPrivate();
    this.publishSearch_abyssPrivate({
      type: 'semantics',
      generation: ++this.searchGeneration_abyssPrivate,
      semanticsRevision: ++this.searchSemanticsRevision_abyssPrivate,
    });
  }

  async refreshSourceExclusion(excludeSource: TaskIndexOptions['excludeSource']): Promise<void> {
    this.excludeSource_abyssPrivate = excludeSource;
    const files = [...this.app_abyssPrivate.vault.getMarkdownFiles()];
    await Promise.all(
      files.map(async (file) => {
        const changed = await this.loadFile_abyssPrivate(file, file.path, true);
        if (changed) this.queueChanged_abyssPrivate(file.path);
      }),
    );
    await this.drainPendingReads_abyssPrivate();
  }

  async initialize(): Promise<void> {
    if (this.initialized_abyssPrivate || this.destroyed_abyssPrivate) return;
    if (this.initialization_abyssPrivate === undefined) {
      this.initialization_abyssPrivate = Promise.resolve()
        .then(() => this.performInitialization_abyssPrivate())
        .catch((cause: unknown) => {
          if (!this.destroyed_abyssPrivate) {
            this.searchFailure_abyssPrivate = { cause };
            this.invalidateDependencies_abyssPrivate(
              new TaskSearchError('unavailable', 'Task index unavailable'),
            );
            this.publishSearch_abyssPrivate({
              type: 'state',
              state: this.searchState_abyssPrivate(),
            });
          }
          throw cause;
        })
        .finally(() => {
          this.initialization_abyssPrivate = undefined;
        });
      this.searchFailure_abyssPrivate = undefined;
      this.publishSearch_abyssPrivate({ type: 'state', state: this.searchState_abyssPrivate() });
    }
    await this.initialization_abyssPrivate;
  }

  private initializationActive_abyssPrivate(): boolean {
    return !this.destroyed_abyssPrivate;
  }

  private async performInitialization_abyssPrivate(): Promise<void> {
    if (!this.initializationActive_abyssPrivate()) return;
    this.registerEvents_abyssPrivate();
    const files = [...this.app_abyssPrivate.vault.getMarkdownFiles()]
      .map((file) => ({ file, path: file.path }))
      .sort((left, right) => left.path.localeCompare(right.path));
    const chunkSize = 50;
    for (let index = 0; index < files.length; index += chunkSize) {
      if (!this.initializationActive_abyssPrivate()) return;
      const settled = await Promise.allSettled(
        files
          .slice(index, index + chunkSize)
          .map(({ file, path }) => this.loadInitialFile_abyssPrivate(file, path)),
      );
      const rejected = settled.find((result) => result.status === 'rejected');
      if (rejected !== undefined) throw rejected.reason;
      if (index + chunkSize < files.length) {
        await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
      }
    }
    await this.drainPendingReads_abyssPrivate();
    if (this.destroyed_abyssPrivate) return;
    this.pruneMissingFiles_abyssPrivate();
    this.initialized_abyssPrivate = true;
    this.publishSearch_abyssPrivate({ type: 'state', state: this.searchState_abyssPrivate() });
    this.publish_abyssPrivate({ type: 'initialized' });
  }

  private async loadInitialFile_abyssPrivate(file: TFile, path: string): Promise<boolean> {
    const priorPath = this.fileLifecycles_abyssPrivate.get(file)?.path;
    if (
      priorPath !== undefined &&
      priorPath !== path &&
      this.app_abyssPrivate.vault.getAbstractFileByPath(path) === file
    ) {
      // Registration may have failed before the rename listener was acquired. Reuse its owner,
      // retaining accepted-command verification while the fresh bootstrap read reconciles content.
      const committed = this.committedContents_abyssPrivate.get(priorPath);
      this.handleVaultRename_abyssPrivate(file, priorPath);
      if (committed !== undefined && !this.committedContents_abyssPrivate.has(path))
        this.committedContents_abyssPrivate.set(path, committed);
    }
    return this.loadFile_abyssPrivate(file, path);
  }

  private pruneMissingFiles_abyssPrivate(): void {
    // A partial listener registration may have missed a deletion before the next attempt.
    for (const path of this.taskMap_abyssPrivate.keys()) {
      const file = this.app_abyssPrivate.vault.getAbstractFileByPath(path);
      if (!(file instanceof TFile) || file.extension !== 'md') this.removeFile_abyssPrivate(path);
    }
  }

  searchSource(): TaskSearchSource {
    return {
      ensureReady: () => this.initialize(),
      subscribe: (listener) => {
        this.searchListeners_abyssPrivate.add(listener);
        return {
          state: this.searchState_abyssPrivate(),
          unsubscribe: () => {
            this.searchListeners_abyssPrivate.delete(listener);
          },
        };
      },
      files: () => {
        this.checkSearchReady_abyssPrivate();
        return [...this.searchFiles_abyssPrivate]
          .map(([path, version]) => ({ path, version }))
          .sort((a, b) => a.path.localeCompare(b.path));
      },
      nodes: (file) => this.searchNodes_abyssPrivate(file),
      documents: (file) => this.searchDocuments_abyssPrivate(file),
      address: (id) => this.searchAddress_abyssPrivate(id),
    };
  }

  observedTags(): readonly string[] {
    return observedTaskTags(
      [...this.searchTags_abyssPrivate.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .flatMap(([, tags]) => tags),
    );
  }

  private searchState_abyssPrivate(): TaskSearchSourceState {
    const generation = this.searchGeneration_abyssPrivate;
    const semanticsRevision = this.searchSemanticsRevision_abyssPrivate;
    if (this.destroyed_abyssPrivate) return { type: 'disposed', generation, semanticsRevision };
    if (this.searchFailure_abyssPrivate !== undefined)
      return {
        type: 'failed',
        generation,
        semanticsRevision,
        cause: this.searchFailure_abyssPrivate.cause,
      };
    return {
      type: this.initialized_abyssPrivate ? 'ready' : 'initializing',
      generation,
      semanticsRevision,
    };
  }

  private publishSearch_abyssPrivate(event: TaskSearchSourceEvent): void {
    const detached = immutableSearchEvent(event);
    for (const listener of [...this.searchListeners_abyssPrivate]) {
      try {
        listener(detached);
      } catch {
        console.error('[abyss-tasks] task search source listener failed', {
          phase: 'source-publication',
          backend: 'canonical',
          generation: this.searchGeneration_abyssPrivate,
          pathCount: event.type === 'files' ? event.files.length : 0,
        });
      }
    }
  }

  private checkSearchReady_abyssPrivate(signal?: AbortSignal): void {
    if (signal?.aborted === true) throw new TaskSearchError('aborted', 'Search cancelled');
    const state = this.searchState_abyssPrivate();
    if (state.type === 'disposed') throw new TaskSearchError('disposed', 'Task index disposed');
    if (state.type !== 'ready') throw new TaskSearchError('unavailable', 'Task index unavailable');
  }

  private async awaitSearchReady_abyssPrivate(signal: AbortSignal): Promise<void> {
    if (this.searchState_abyssPrivate().type === 'initializing' && !signal.aborted) {
      await new Promise<void>((resolve, reject) => {
        const cleanup = (): void => {
          this.searchListeners_abyssPrivate.delete(listener);
          signal.removeEventListener('abort', abort);
        };
        const abort = (): void => {
          cleanup();
          reject(new TaskSearchError('aborted', 'Search cancelled'));
        };
        const listener = (): void => {
          if (this.searchState_abyssPrivate().type === 'initializing') return;
          cleanup();
          resolve();
        };
        this.searchListeners_abyssPrivate.add(listener);
        signal.addEventListener('abort', abort, { once: true });
      });
    }
    this.checkSearchReady_abyssPrivate(signal);
  }

  private checkSearchFile_abyssPrivate(file: TaskSearchFileVersion): void {
    this.checkSearchReady_abyssPrivate();
    if (this.searchFiles_abyssPrivate.get(file.path) !== file.version)
      throw new TaskSearchError('stale', 'Task file changed');
  }

  private *searchNodes_abyssPrivate(file: TaskSearchFileVersion): Iterable<TaskSearchSourceNode> {
    yield* this.projectSearchNodes_abyssPrivate(file, (coordinate) => coordinate);
  }

  private *projectSearchNodes_abyssPrivate<T>(
    file: TaskSearchFileVersion,
    project: (coordinate: TaskSearchSourceNode, node: TaskSnapshot | SubtaskSnapshot) => T,
  ): Iterable<T> {
    this.checkSearchFile_abyssPrivate(file);
    // A prefix is shared across partial/overlapping iterators; only the next requested node allocates.
    const ids = this.searchIdsByFile_abyssPrivate.get(file.path) ?? [];
    this.searchIdsByFile_abyssPrivate.set(file.path, ids);
    let offset = 0;
    for (const [rootOrdinal, root] of (this.taskMap_abyssPrivate.get(file.path) ?? []).entries()) {
      const rootId = ids[offset] ?? this.nextSearchId_abyssPrivate;
      for (const task of taskTreeNodes(root)) {
        this.checkSearchFile_abyssPrivate(file);
        let id = ids[offset++];
        if (id === undefined) {
          id = this.nextSearchId_abyssPrivate++;
          this.searchCoordinates_abyssPrivate.set(id, {
            id,
            rootId,
            version: file.version,
            rootOrdinal,
            order: {
              filePath: file.path,
              line: root.source.line,
              childLines: task.path.map((child) => child.ref.relativeLine),
            },
          });
          ids.push(id);
        }
        const coordinate = this.searchCoordinates_abyssPrivate.get(id);
        if (coordinate === undefined) throw new TaskSearchError('stale', 'Task changed');
        yield project(
          {
            id,
            rootId: coordinate.rootId,
            order: { ...coordinate.order, childLines: [...coordinate.order.childLines] },
          },
          task.node,
        );
      }
    }
    this.checkSearchFile_abyssPrivate(file);
  }

  private searchAddress_abyssPrivate(id: number): TaskSearchAddress | undefined {
    if (this.destroyed_abyssPrivate) return undefined;
    const coordinate = this.searchCoordinates_abyssPrivate.get(id);
    if (
      coordinate === undefined ||
      this.searchFiles_abyssPrivate.get(coordinate.order.filePath) !== coordinate.version
    )
      return undefined;
    return {
      epoch: this.searchEpoch_abyssPrivate,
      version: coordinate.version,
      rootId: coordinate.rootId,
      childLines: [...coordinate.order.childLines],
    };
  }

  private currentSearchRoot_abyssPrivate(address: TaskSearchAddress): TaskSnapshot | undefined {
    if (address.epoch !== this.searchEpoch_abyssPrivate) return undefined;
    const root = this.searchCoordinates_abyssPrivate.get(address.rootId);
    if (
      root === undefined ||
      root.rootId !== root.id ||
      root.order.childLines.length !== 0 ||
      root.version !== address.version ||
      this.searchFiles_abyssPrivate.get(root.order.filePath) !== address.version
    )
      return undefined;
    return this.taskMap_abyssPrivate.get(root.order.filePath)?.[root.rootOrdinal];
  }

  private *searchDocuments_abyssPrivate(file: TaskSearchFileVersion): Iterable<TaskSearchDocument> {
    yield* this.projectSearchNodes_abyssPrivate(file, (coordinate, node) =>
      taskSearchDocument(coordinate, node),
    );
  }

  async resolveSearchHits(
    hits: readonly TaskSearchHit[],
    signal: AbortSignal,
  ): Promise<readonly TaskSearchHydratedHit[]> {
    await this.awaitSearchReady_abyssPrivate(signal);
    if (hits.length > 200 || new Set(hits.map((hit) => hit.address.rootId)).size > 50)
      throw new TaskSearchError('invalid-request', 'Search batch too large');
    const roots = new Map<number, TaskSnapshot>();
    const output: TaskSearchHydratedHit[] = [];
    for (const hit of hits) {
      this.checkSearchReady_abyssPrivate(signal);
      const canonical = this.currentSearchRoot_abyssPrivate(hit.address);
      if (canonical === undefined) throw new TaskSearchError('stale', 'Task changed');
      let detached = roots.get(hit.address.rootId);
      if (detached === undefined) {
        detached = taskSnapshotWithStatuses(canonical, (symbol) =>
          this.statusCatalog_abyssPrivate.statusForSymbol(symbol),
        );
        roots.set(hit.address.rootId, detached);
      }
      output.push({
        hit: {
          score: hit.score,
          address: { ...hit.address, childLines: [...hit.address.childLines] },
        },
        task: nodeAtSearchAddress(detached, hit.address),
      });
    }
    return output;
  }

  private checkSearchGeneration_abyssPrivate(generation: number, signal: AbortSignal): void {
    this.checkSearchReady_abyssPrivate(signal);
    if (generation !== this.searchGeneration_abyssPrivate)
      throw new TaskSearchError('stale', 'Task generation changed');
  }

  private *allOrganizationAddresses_abyssPrivate(
    filePath: string | undefined,
  ): Iterable<TaskSearchAddress> {
    for (const file of this.searchSource().files()) {
      if (filePath !== undefined && file.path !== filePath) continue;
      for (const node of this.searchNodes_abyssPrivate(file)) {
        if (node.id !== node.rootId) continue;
        yield {
          epoch: this.searchEpoch_abyssPrivate,
          version: file.version,
          rootId: node.id,
          childLines: [],
        };
      }
    }
  }

  private *organizationAddresses_abyssPrivate(
    request: TaskOrganizationRequest,
  ): Iterable<TaskSearchAddress> {
    if (request.roots === undefined) {
      yield* this.allOrganizationAddresses_abyssPrivate(request.filePath);
      return;
    }
    const seen = new Set<number>();
    for (const address of request.roots) {
      if (address.childLines.length !== 0)
        throw new TaskSearchError('invalid-request', 'Expected root address');
      const root = this.currentSearchRoot_abyssPrivate(address);
      if (root === undefined) throw new TaskSearchError('stale', 'Task changed');
      if (seen.has(address.rootId)) continue;
      seen.add(address.rootId);
      if (request.filePath === undefined || root.source.filePath === request.filePath)
        yield address;
    }
  }

  async *organization(
    request: TaskOrganizationRequest,
    signal: AbortSignal,
  ): AsyncIterable<TaskOrganizationBatch> {
    await this.awaitSearchReady_abyssPrivate(signal);
    const generation = request.expectedGeneration;
    this.checkSearchGeneration_abyssPrivate(generation, signal);
    let items: TaskOrganizationRecord[] = [];
    let emitted = false;
    for (const address of this.organizationAddresses_abyssPrivate(request)) {
      this.checkSearchGeneration_abyssPrivate(generation, signal);
      const root = this.currentSearchRoot_abyssPrivate(address);
      if (root === undefined) throw new TaskSearchError('stale', 'Task changed');
      items.push(
        taskOrganizationRecord(
          root,
          address,
          this.statusCatalog_abyssPrivate.statusForSymbol(root.statusSymbol),
        ),
      );
      if (items.length < 200) continue;
      this.checkSearchGeneration_abyssPrivate(generation, signal);
      yield { generation, items };
      emitted = true;
      items = [];
      await (this.options_abyssPrivate.readYield?.(signal) ??
        new Promise<void>((resolve) => window.setTimeout(resolve, 0)));
      this.checkSearchGeneration_abyssPrivate(generation, signal);
    }
    this.checkSearchGeneration_abyssPrivate(generation, signal);
    if (items.length > 0 || !emitted) yield { generation, items };
    this.checkSearchGeneration_abyssPrivate(generation, signal);
  }

  private updateSearchFile_abyssPrivate(path: string, tasks: readonly TaskSnapshot[]): void {
    for (const id of this.searchIdsByFile_abyssPrivate.get(path) ?? [])
      this.searchCoordinates_abyssPrivate.delete(id);
    this.searchIdsByFile_abyssPrivate.delete(path);
    const generation = ++this.searchGeneration_abyssPrivate;
    const version = tasks.length > 0 ? generation : null;
    if (version === null) {
      this.searchFiles_abyssPrivate.delete(path);
      this.searchTags_abyssPrivate.delete(path);
    } else {
      this.searchFiles_abyssPrivate.set(path, version);
      this.searchTags_abyssPrivate.set(
        path,
        observedTaskTags(
          tasks.flatMap((root) => [...taskTreeNodes(root)].flatMap(({ node }) => node.tags)),
        ),
      );
    }
    this.publishSearch_abyssPrivate({
      type: 'files',
      generation,
      semanticsRevision: this.searchSemanticsRevision_abyssPrivate,
      files: [{ path, version }],
    });
  }

  private *dependencyAssembly_abyssPrivate(
    catalog: StatusCatalog,
    without?: Parameters<TaskDependencyQueryApi['dependencyEligibility']>[2],
  ): DependencyAssembly {
    const roots: TaskSnapshot[] = [];
    for (const file of this.taskMap_abyssPrivate.values()) {
      for (const root of file) {
        roots.push(root);
        yield;
      }
    }
    // Native stable sort is a measured synchronous limitation, isolated from adjacent batches.
    yield 'boundary';
    roots.sort(stableTaskOrder);
    yield 'boundary';
    function* nodes(): Iterable<TaskNodeSnapshot> {
      for (const root of roots) yield* taskTreeNodes(root);
    }
    return yield* assembleTaskDependencyGraphSteps(
      nodes(),
      (symbol) => catalog.statusForSymbol(symbol),
      without?.without,
    );
  }

  /** Inward readiness operation; callers must recheck generation before using synchronous reads. */
  async prepareDependencies(expectedGeneration: number, signal: AbortSignal): Promise<void> {
    await this.awaitSearchReady_abyssPrivate(signal);
    this.checkSearchGeneration_abyssPrivate(expectedGeneration, signal);
    if (this.dependencyGraph_abyssPrivate !== undefined) return;
    let record = this.dependencyPreparation_abyssPrivate;
    const start = record === undefined;
    if (record === undefined) {
      record = {
        generation: expectedGeneration,
        iterator: this.dependencyAssembly_abyssPrivate(this.statusCatalog_abyssPrivate),
        controller: new AbortController(),
        waiters: new Set(),
        settled: false,
      };
      this.dependencyPreparation_abyssPrivate = record;
    }
    const preparation = record;
    const waiting = new Promise<void>((resolve, reject) => {
      const settle = (error?: TaskSearchError): void => {
        signal.removeEventListener('abort', abort);
        preparation.waiters.delete(settle);
        if (error === undefined) resolve();
        else reject(error);
      };
      const abort = (): void => {
        settle(new TaskSearchError('aborted', 'Dependency preparation cancelled'));
        if (!preparation.settled && preparation.waiters.size === 0)
          this.settleDependencyPreparation_abyssPrivate(preparation);
      };
      preparation.waiters.add(settle);
      signal.addEventListener('abort', abort, { once: true });
    });
    if (start)
      this.driveDependencyPreparation_abyssPrivate(preparation).catch((cause: unknown) => {
        this.failDependencyPreparation_abyssPrivate(preparation, cause);
      });
    await waiting;
  }

  private invalidateDependencies_abyssPrivate(
    error = new TaskSearchError('stale', 'Task generation changed'),
  ): void {
    this.dependencyGraph_abyssPrivate = undefined;
    const record = this.dependencyPreparation_abyssPrivate;
    if (record !== undefined) this.settleDependencyPreparation_abyssPrivate(record, error);
  }

  private settleDependencyPreparation_abyssPrivate(
    record: DependencyPreparation,
    error?: TaskSearchError,
  ): void {
    if (record.settled) return;
    record.settled = true;
    if (this.dependencyPreparation_abyssPrivate === record)
      this.dependencyPreparation_abyssPrivate = undefined;
    const iterator = record.iterator;
    record.iterator = undefined;
    iterator?.return(undefined);
    for (const settle of record.waiters) settle(error);
    // Success and waiter settlement precede cancellation of a suspended scheduler continuation.
    record.controller.abort();
  }

  private advanceDependencyPreparation_abyssPrivate(
    record: DependencyPreparation,
  ): IteratorResult<void | 'boundary', TaskDependencyGraph | undefined> {
    this.checkSearchGeneration_abyssPrivate(record.generation, record.controller.signal);
    if (
      record.settled ||
      this.dependencyPreparation_abyssPrivate !== record ||
      record.iterator === undefined
    )
      throw new TaskSearchError('stale', 'Dependency preparation superseded');
    const step = record.iterator.next();
    if (step.done === true) {
      this.checkSearchGeneration_abyssPrivate(record.generation, record.controller.signal);
      if (step.value === undefined || this.dependencyPreparation_abyssPrivate !== record)
        throw new TaskSearchError('stale', 'Dependency preparation superseded');
      this.dependencyGraph_abyssPrivate = step.value;
      this.settleDependencyPreparation_abyssPrivate(record);
    }
    return step;
  }

  private async driveDependencyPreparation_abyssPrivate(
    record: DependencyPreparation,
  ): Promise<void> {
    while (!record.settled) {
      this.checkSearchGeneration_abyssPrivate(record.generation, record.controller.signal);
      await this.yieldDependencies_abyssPrivate(record.controller.signal);
      if (this.dependencyPreparation_abyssPrivate !== record) return;
      for (let unit = 0; unit < 128; unit++) {
        const step = this.advanceDependencyPreparation_abyssPrivate(record);
        if (step.done === true || step.value === 'boundary') break;
      }
    }
  }

  private yieldDependencies_abyssPrivate(signal: AbortSignal): Promise<void> {
    if (this.options_abyssPrivate.readYield !== undefined)
      return this.options_abyssPrivate.readYield(signal);
    return new Promise<void>((resolve, reject) => {
      const finish = (): void => {
        signal.removeEventListener('abort', abort);
        resolve();
      };
      const timer = window.setTimeout(finish, 0);
      const abort = (): void => {
        window.clearTimeout(timer);
        signal.removeEventListener('abort', abort);
        reject(new TaskSearchError('aborted', 'Dependency preparation cancelled'));
      };
      signal.addEventListener('abort', abort, { once: true });
    });
  }

  private failDependencyPreparation_abyssPrivate(
    record: DependencyPreparation,
    cause: unknown,
  ): TaskSearchError {
    const error =
      cause instanceof TaskSearchError
        ? cause
        : new TaskSearchError('unavailable', 'Dependency preparation failed');
    if (!record.settled) {
      if (error.code === 'unavailable')
        console.error('[abyss-tasks] dependency preparation failed', {
          phase: 'dependency-preparation',
          backend: 'canonical',
          generation: record.generation,
          pathCount: this.taskMap_abyssPrivate.size,
        });
      this.settleDependencyPreparation_abyssPrivate(record, error);
    }
    return error;
  }

  dependencySummary(target: TaskNodeRef): TaskDependencySummary {
    const { activeBlockedByCount, activeBlocksCount } =
      this.currentDependencyGraph_abyssPrivate().dependencies(target);
    return { activeBlockedByCount, activeBlocksCount };
  }

  list(query?: TaskQuery): readonly TaskSnapshot[] {
    const tasks = initialQueryTasks(this.taskMap_abyssPrivate, query);
    const filtered = filterQueryTasks(tasks, query);
    return [...filtered].sort(stableTaskOrder).map(cloneTaskSnapshot);
  }

  listNodes(query?: TaskQuery): readonly TaskNodeSnapshot[] {
    const roots = initialQueryTasks(this.taskMap_abyssPrivate, query).map((root) =>
      taskSnapshotWithStatuses(root, (symbol) =>
        this.statusCatalog_abyssPrivate.statusForSymbol(symbol),
      ),
    );
    return enumerateTaskNodes(filterQueryTasks(roots, query));
  }

  dependencies(target: TaskNodeRef): TaskDependencyProjection {
    const projection = this.currentDependencyGraph_abyssPrivate().dependencies(target);
    const roots = new Map<TaskSnapshot, TaskSnapshot>();
    const detach = (task: TaskNodeSnapshot): TaskNodeSnapshot => {
      let root = roots.get(task.root);
      if (root === undefined) {
        root = taskSnapshotWithStatuses(task.root, (symbol) =>
          this.statusCatalog_abyssPrivate.statusForSymbol(symbol),
        );
        roots.set(task.root, root);
      }
      return nodeAtSearchAddress(root, {
        epoch: '',
        version: 0,
        rootId: 0,
        childLines: task.path.map((child) => child.ref.relativeLine),
      });
    };
    return freezeDetached({
      ...projection,
      blockedBy: projection.blockedBy.map((row) => {
        if (row.type === 'resolved') return { ...row, task: detach(row.task) };
        if (row.type === 'ambiguous') return { ...row, candidates: row.candidates.map(detach) };
        return { ...row };
      }),
      blocks: projection.blocks.map((row) => ({ ...row, task: detach(row.task) })),
    });
  }

  async searchEligibility(
    request: TaskSearchEligibilityRequest,
    signal: AbortSignal,
  ): Promise<TaskSearchEligibilityBatch> {
    if (request.addresses.length > 200)
      throw new TaskSearchError('invalid-request', 'Dependency candidate batch too large');
    if (request.addresses.length === 0) {
      this.checkSearchGeneration_abyssPrivate(request.expectedGeneration, signal);
      this.checkSearchCurrent_abyssPrivate(request.current);
      return { generation: request.expectedGeneration, items: [] };
    }
    await this.prepareDependencies(request.expectedGeneration, signal);
    this.checkSearchGeneration_abyssPrivate(request.expectedGeneration, signal);
    this.checkSearchCurrent_abyssPrivate(request.current);
    const items: Array<TaskSearchEligibilityBatch['items'][number]> = [];
    for (const address of request.addresses) {
      this.checkSearchGeneration_abyssPrivate(request.expectedGeneration, signal);
      const root = this.currentSearchRoot_abyssPrivate(address);
      if (root === undefined) throw new TaskSearchError('stale', 'Task changed');
      const candidate = nodeAtSearchAddress(root, address).target;
      const eligibility =
        request.direction === 'blocks'
          ? this.dependencyEligibility(request.current, candidate)
          : this.dependencyEligibility(candidate, request.current);
      items.push({ address: { ...address, childLines: [...address.childLines] }, eligibility });
      await this.yieldDependencies_abyssPrivate(signal);
    }
    this.checkSearchGeneration_abyssPrivate(request.expectedGeneration, signal);
    return { generation: request.expectedGeneration, items };
  }

  private checkSearchCurrent_abyssPrivate(current: TaskNodeRef): void {
    const childLines: number[] = [];
    let target = current;
    while (target.type === 'subtask') {
      childLines.unshift(target.ref.relativeLine);
      target = target.ref.parent;
    }
    const ref = target.ref;
    const root = this.taskMap_abyssPrivate
      .get(ref.filePath)
      ?.find((task) => task.ref.line === ref.line);
    if (root === undefined) throw new TaskSearchError('stale', 'Task changed');
    const borrowed = nodeAtSearchAddress(root, { epoch: '', version: 0, rootId: 0, childLines });
    if (!sameTaskNodeRef(borrowed.target, current))
      throw new TaskSearchError('stale', 'Task changed');
  }

  dependencyEligibility(
    blocker: TaskNodeRef,
    dependent: TaskNodeRef,
    options?: Parameters<TaskDependencyQueryApi['dependencyEligibility']>[2],
  ): TaskDependencyEligibility {
    if (options === undefined)
      return this.currentDependencyGraph_abyssPrivate().eligibility(blocker, dependent);
    const original = options.without;
    const relation = this.currentDependencyGraph_abyssPrivate()
      .dependencies(original.dependent)
      .blockedBy.find((row) => row.dependencyId === original.dependencyId);
    if (
      relation?.type !== 'resolved' ||
      !sameTaskNodeRef(relation.task.target, original.blocker) ||
      !sameTaskNodeRef(blocker, original.dependent) ||
      !sameTaskNodeRef(dependent, original.blocker)
    )
      return { type: 'rejected', reason: 'unavailable' };
    return drainDependencyAssembly(
      this.dependencyAssembly_abyssPrivate(this.statusCatalog_abyssPrivate, options),
    ).eligibility(blocker, dependent);
  }

  private currentDependencyGraph_abyssPrivate(): TaskDependencyGraph {
    if (this.dependencyGraph_abyssPrivate !== undefined) return this.dependencyGraph_abyssPrivate;
    const pending = this.dependencyPreparation_abyssPrivate;
    if (pending !== undefined) {
      try {
        let step = this.advanceDependencyPreparation_abyssPrivate(pending);
        while (step.done !== true) step = this.advanceDependencyPreparation_abyssPrivate(pending);
        if (step.value !== undefined) return step.value;
      } catch (cause) {
        throw this.failDependencyPreparation_abyssPrivate(pending, cause);
      }
    }
    const graph = drainDependencyAssembly(
      this.dependencyAssembly_abyssPrivate(this.statusCatalog_abyssPrivate),
    );
    if (!this.destroyed_abyssPrivate && this.searchFailure_abyssPrivate === undefined)
      this.dependencyGraph_abyssPrivate = graph;
    return graph;
  }

  /** Frozen projections shared by reference; consumers read them and must not mutate them. */
  activeEntries(): readonly TrackedEntry[] {
    return this.timeEntryIndex_abyssPrivate.activeEntries();
  }

  entriesOverlapping(fromMs: number, toMs: number): readonly TrackedEntry[] {
    return this.timeEntryIndex_abyssPrivate.entriesOverlapping(fromMs, toMs);
  }

  fileTotal(filePath: string): TrackedTotal {
    return this.timeEntryIndex_abyssPrivate.fileTotal(filePath);
  }

  forCalendarProjection(dates: readonly LocalDate[]): CalendarProjectionSources {
    const seen = new Set<CalendarTaskSource>();
    for (const date of dates) {
      for (const source of this.calendarDateIndex_abyssPrivate.get(date)) seen.add(source);
    }
    const clonedRoots = new Map<TaskSnapshot, ClonedCalendarRoot>();
    const cloneSource = (source: CalendarTaskSource): CalendarTaskSource =>
      cloneCalendarTaskSource(source, clonedRoots);
    return {
      materialized: [...seen].sort(stableCalendarSourceOrder).map(cloneSource),
      recurringSources: [...this.recurringSourcesByFile_abyssPrivate.values()]
        .flat()
        .sort(stableCalendarSourceOrder)
        .map(cloneSource),
    };
  }

  resolve(ref: TaskRef): TaskResolution {
    const tasks = this.taskMap_abyssPrivate.get(ref.filePath) ?? [];
    const current = tasks.find((task) => task.source.line === ref.line);
    const expectedSource = this.locator_abyssPrivate.exactSource(ref.revision);
    const sourceMatches =
      expectedSource === undefined
        ? []
        : tasks.filter((task) => task.source.originalBlock === expectedSource);
    const matches = tasks.filter((task) => task.ref.revision === ref.revision);
    const directResolution = directRevisionResolution(
      ref,
      current,
      matches,
      this.options_abyssPrivate.refAuthority,
    );
    if (directResolution !== undefined) return directResolution;
    const fileTransition = this.reconciliationTransitions_abyssPrivate.get(ref.filePath);
    const transition = fileTransition?.writable.get(taskReconciliationKey(ref));
    if (transition?.evidence === 'authority-transition') return transitionResolution(transition);
    const authorityResolution = authorityAmbiguityResolution(
      this.options_abyssPrivate.refAuthority,
      sourceMatches,
    );
    if (authorityResolution !== undefined) return authorityResolution;
    const rebaseResolution = writableRebaseResolution(
      this.options_abyssPrivate.refAuthority,
      ref,
      matches,
      transition,
    );
    if (rebaseResolution !== undefined) return rebaseResolution;
    const visual = fileTransition?.visual.get(taskReconciliationKey(ref));
    return fallbackTaskResolution({ ref, tasks, current, sourceMatches, visual });
  }

  subscribe(listener: Listener): () => void {
    this.listeners_abyssPrivate.push(listener);
    return () => {
      this.listeners_abyssPrivate = this.listeners_abyssPrivate.filter(
        (candidate) => candidate !== listener,
      );
    };
  }

  subscribeReconciled(listener: (files: readonly string[]) => void): () => void {
    this.reconciledListeners_abyssPrivate.push(listener);
    return () => {
      this.reconciledListeners_abyssPrivate = this.reconciledListeners_abyssPrivate.filter(
        (candidate) => candidate !== listener,
      );
    };
  }

  destroy(): void {
    if (this.destroyed_abyssPrivate) return;
    this.destroyed_abyssPrivate = true;
    this.taskMap_abyssPrivate.clear();
    this.invalidateDependencies_abyssPrivate(
      new TaskSearchError('disposed', 'Task index disposed'),
    );
    this.publishSearch_abyssPrivate({ type: 'state', state: this.searchState_abyssPrivate() });
    this.searchListeners_abyssPrivate.clear();
    this.searchFiles_abyssPrivate.clear();
    this.searchTags_abyssPrivate.clear();
    this.searchCoordinates_abyssPrivate.clear();
    this.searchIdsByFile_abyssPrivate.clear();
    for (const ref of this.metadataCacheRefs_abyssPrivate)
      this.app_abyssPrivate.metadataCache.offref(ref);
    for (const ref of this.vaultRefs_abyssPrivate) this.app_abyssPrivate.vault.offref(ref);
    this.metadataCacheRefs_abyssPrivate = [];
    this.vaultRefs_abyssPrivate = [];
    this.listeners_abyssPrivate = [];
    this.reconciledListeners_abyssPrivate = [];
    this.pendingFiles_abyssPrivate.clear();
    this.pendingReconciledFiles_abyssPrivate.clear();
    this.fileLifecycles_abyssPrivate = new WeakMap();
    this.pendingReads_abyssPrivate.clear();
    this.fileGenerations_abyssPrivate.clear();
    this.committedContents_abyssPrivate.clear();
    this.reconciliationTransitions_abyssPrivate.clear();
    this.options_abyssPrivate.refAuthority?.clear();
    this.calendarDateIndex_abyssPrivate.clear();
    this.timeEntryIndex_abyssPrivate.clear();
    this.recurringSourcesByFile_abyssPrivate.clear();
  }

  private async loadFile_abyssPrivate(
    file: TFile,
    path: string,
    observedFile = false,
  ): Promise<boolean> {
    const observation = this.observe_abyssPrivate(file, path);
    if (observation == null) return false;
    const cache = this.app_abyssPrivate.metadataCache.getFileCache(file);
    return this.loadParsedFile_abyssPrivate(observation, cache, observedFile);
  }

  private commitEmptyObservation_abyssPrivate(observation: FileObservation): boolean {
    if (!this.isCurrent_abyssPrivate(observation)) return false;
    this.replaceFile_abyssPrivate(observation.path, [], [], true);
    return true;
  }

  private async loadParsedFile_abyssPrivate(
    observation: FileObservation,
    cache: CachedMetadata | null,
    observedFile: boolean,
  ): Promise<boolean> {
    try {
      const content = await this.app_abyssPrivate.vault.cachedRead(observation.file);
      if (!this.isCurrent_abyssPrivate(observation)) return false;
      if (
        this.observationNeedsVerification_abyssPrivate(observation.path, content) &&
        !(await this.observationMatchesVault_abyssPrivate(observation, content))
      )
        return false;
      if (!this.isCurrent_abyssPrivate(observation)) return false;
      if (
        this.options_abyssPrivate.refAuthority?.deferObservation(observation.path, content) === true
      )
        return false;
      const selectedCache = this.cacheWithFrontmatter_abyssPrivate(content, cache);
      if (this.sourceIsExcluded_abyssPrivate(observation.path, content)) {
        this.options_abyssPrivate.refAuthority?.discard(observation.path);
        return this.commitEmptyObservation_abyssPrivate(observation);
      }
      const tasks = this.parseFile_abyssPrivate({
        filePath: observation.path,
        content,
        cache: selectedCache,
        allocateSuccessor: true,
        observedFile,
      });
      this.replaceFile_abyssPrivate(observation.path, tasks, [], true);
      return true;
    } catch {
      return this.commitEmptyObservation_abyssPrivate(observation);
    }
  }

  private cacheWithFrontmatter_abyssPrivate(
    content: string,
    cache: CachedMetadata | null | undefined,
  ): CachedMetadata {
    const selected = cacheWithContentFallback(content, cache);
    const frontmatter = selected.frontmatter ?? frontmatterFromContent(content);
    return frontmatter === undefined ? selected : { ...selected, frontmatter };
  }

  private sourceIsExcluded_abyssPrivate(filePath: string, content: string): boolean {
    const exclude = this.excludeSource_abyssPrivate;
    if (exclude === undefined) return false;
    const frontmatter = frontmatterFromContent(content) ?? {};
    const frontmatterTags = getAllTags({ frontmatter }) ?? [];
    return exclude({
      filePath,
      tags: [...new Set([...frontmatterTags, ...extractMarkdownBodyTags(content)])],
      frontmatter: { ...frontmatter },
    });
  }

  private parseFile_abyssPrivate(input: ParseFileInput): readonly TaskSnapshot[] {
    const { cache } = input;
    const overrides = this.observeAuthorityTransition_abyssPrivate(input);
    if (cache.listItems == null) return [];
    const context = this.createParseContext_abyssPrivate(input, overrides);
    const snapshots: TaskSnapshot[] = [];
    for (const item of cache.listItems) {
      const snapshot = this.parseRootItem_abyssPrivate(item, context);
      if (snapshot != null) snapshots.push(snapshot);
    }
    return snapshots.sort(stableTaskOrder);
  }

  private observeAuthorityTransition_abyssPrivate(
    input: ParseFileInput,
  ): readonly RootRevisionOverride[] {
    const authorityObservation = this.options_abyssPrivate.refAuthority?.observeTransition(
      input.filePath,
      input.content,
    );
    const overrides = authorityObservation?.roots ?? [];
    if (authorityObservation != null) {
      input.captureAuthorityTransitions?.(
        authorityObservation.transitions,
        authorityObservation.restored,
      );
    }
    return overrides;
  }

  private createParseContext_abyssPrivate(
    input: ParseFileInput,
    overrides: readonly RootRevisionOverride[],
  ): FileParseContext {
    const { filePath, content, cache } = input;
    // Preserve the legacy raw-line shape (`\r` stays attached under CRLF) for compatibility
    // consumers while TaskBlockEditor independently owns exact block revision bytes.
    const lines = content.split('\n');
    const blockByLine = new Map(
      this.blockEditor_abyssPrivate
        .rootBlocks(content)
        .map((block) => [block.line, block] as const),
    );
    const sourceCounts = countBlockSources(blockByLine.values());
    const priorTasks = this.taskMap_abyssPrivate.get(filePath) ?? [];
    return {
      filePath,
      lines,
      blockByLine,
      sourceCounts,
      codec: new TaskMarkdownCodec(this.statusCatalog_abyssPrivate),
      presentation: taskPresentation(cache.frontmatter),
      itemByLine: metadataItemsByLine(cache.listItems ?? []),
      offsetAt: this.options_abyssPrivate.timeZoneOffsetAt ?? deviceOffsetAt,
      revision: {
        overrides: new Map(overrides.map((override) => [override.line, override] as const)),
        priorByLine: new Map(priorTasks.map((task) => [task.source.line, task] as const)),
        priorBySource: priorTasksBySource(priorTasks),
        currentSourceCounts: sourceCounts,
        currentByLine: blockByLine,
        allocateSuccessor: input.allocateSuccessor ?? false,
        observedFile: input.observedFile ?? false,
      },
    };
  }

  private parseRootItem_abyssPrivate(
    item: MetadataListItem,
    context: FileParseContext,
  ): TaskSnapshot | undefined {
    if (item.task === undefined || hasTaskAncestor(item, context.itemByLine)) return undefined;
    const line = item.position.start.line;
    const originalMarkdown = context.lines[line] ?? '';
    if (context.codec.parseLine(originalMarkdown, { filePath: context.filePath, line }) == null) {
      return undefined;
    }
    const exactBlock = context.blockByLine.get(line)?.source ?? originalMarkdown;
    const ref: TaskRef = {
      filePath: context.filePath,
      line,
      revision: this.reconciledRevision_abyssPrivate({
        ...context.revision,
        line,
        source: exactBlock,
        sourceCount: context.sourceCounts.get(exactBlock) ?? 1,
      }),
    };
    return projectTaskSnapshot({
      codec: context.codec,
      statusCatalog: this.statusCatalog_abyssPrivate,
      filePath: context.filePath,
      lines: context.lines,
      line,
      exactBlock,
      ref,
      presentation: context.presentation,
      offsetAt: context.offsetAt,
    });
  }

  /** Pure infrastructure collaborator used by the repository for immediate command outcomes. */
  snapshotsFromContent(filePath: string, content: string): readonly TaskSnapshot[] {
    return this.previewContent(filePath, content);
  }

  currentRoots(filePath: string): readonly RootRevisionOverride[] {
    return (this.taskMap_abyssPrivate.get(filePath) ?? []).map((root) => ({
      line: root.source.line,
      source: root.source.originalBlock,
      revision: root.ref.revision,
    }));
  }

  currentRoot(
    filePath: string,
    line: number,
    source: string,
    sourceLines?: readonly number[],
  ): TaskRef | undefined {
    const tasks = this.taskMap_abyssPrivate.get(filePath) ?? [];
    const sourceMatches = tasks.filter((task) => task.source.originalBlock === source);
    if (mismatchedDuplicatePopulation(sourceMatches, sourceLines)) return undefined;
    const hinted = tasks.find((task) => task.source.line === line);
    if (hinted?.source.originalBlock === source) return { ...hinted.ref };
    if (sourceMatches.length > 1) return undefined;
    const current = sourceMatches[0] ?? hinted;
    return current != null ? { ...current.ref } : undefined;
  }

  authoritySuccessor(consumed: TaskRef): TaskRef | undefined {
    const transition = this.reconciliationTransitions_abyssPrivate
      .get(consumed.filePath)
      ?.writable.get(taskReconciliationKey(consumed));
    return transition?.evidence === 'authority-transition'
      ? { ...transition.current.ref }
      : undefined;
  }

  discardAuthoritySuccessor(consumed: TaskRef): void {
    const transitions = this.reconciliationTransitions_abyssPrivate.get(consumed.filePath);
    const key = taskReconciliationKey(consumed);
    if (transitions?.writable.get(key)?.evidence !== 'authority-transition') return;
    const writable = new Map(transitions.writable);
    writable.delete(key);
    this.reconciliationTransitions_abyssPrivate.set(consumed.filePath, {
      ...transitions,
      writable,
    });
  }

  previewContent(filePath: string, content: string): readonly TaskSnapshot[] {
    const cache = this.cacheWithFrontmatter_abyssPrivate(content, null);
    return this.parseFile_abyssPrivate({
      filePath,
      content,
      cache,
    });
  }

  /** Installs authoritative content after an atomic repository transition. */
  installCommittedContent(filePath: string, content: string): readonly TaskSnapshot[] {
    return this.installCommittedBatch(new Map([[filePath, content]]), () => undefined);
  }

  installCommittedBatch(
    contents: ReadonlyMap<string, string>,
    prove: (roots: readonly TaskSnapshot[]) => void,
  ): readonly TaskSnapshot[] {
    const roots: TaskSnapshot[] = [];
    for (const filePath of contents.keys()) this.invalidatePendingRead_abyssPrivate(filePath);
    const prepared = [...contents].map(([filePath, content]) => {
      let restored = false;
      const cache = this.cacheWithFrontmatter_abyssPrivate(content, null);
      let authorityTransitions: readonly ProvenRootRevisionOverride[] = [];
      const rawTasks = this.parseFile_abyssPrivate({
        filePath,
        content,
        cache,
        allocateSuccessor: true,
        captureAuthorityTransitions: (transitions, restoration) => {
          authorityTransitions = transitions;
          restored = restoration === true;
        },
        observedFile: this.fileGenerations_abyssPrivate.has(filePath),
      });
      const tasks = this.sourceIsExcluded_abyssPrivate(filePath, content) ? [] : rawTasks;
      roots.push(...tasks);
      return () => {
        this.committedContents_abyssPrivate.set(filePath, content);
        if (this.replaceFile_abyssPrivate(filePath, tasks, authorityTransitions))
          this.queueChanged_abyssPrivate(filePath);
        if (restored) this.reconciliationTransitions_abyssPrivate.delete(filePath);
      };
    });
    prove(roots);
    for (const publish of prepared) publish();
    return roots.map(cloneTaskSnapshot);
  }

  private invalidatePendingRead_abyssPrivate(filePath: string): void {
    const file = this.app_abyssPrivate.vault.getAbstractFileByPath(filePath);
    if (!(file instanceof TFile) || file.extension !== 'md') return;
    this.advance_abyssPrivate(file, filePath);
  }

  private reconciledRevision_abyssPrivate(input: ReconciledRevisionInput): string {
    const override = input.overrides.get(input.line);
    if (override?.source === input.source) return override.revision;
    const authority = this.options_abyssPrivate.refAuthority;
    if (authority == null) return this.locator_abyssPrivate.revision(input.source);
    const reusableRevision = reusablePriorRevision(input);
    if (reusableRevision !== undefined) return reusableRevision;
    const hinted = input.priorByLine.get(input.line);
    if (shouldAllocateSuccessor(input, hinted)) {
      return (
        authority.successor(hinted.ref.revision, input.source) ??
        this.locator_abyssPrivate.revision(input.source)
      );
    }
    if (shouldMintAuthorityRevision(input)) return authority.mintRevision(input.source);
    return this.locator_abyssPrivate.revision(input.source);
  }

  private replaceFile_abyssPrivate(
    filePath: string,
    tasks: readonly TaskSnapshot[],
    authorityTransitions: readonly ProvenRootRevisionOverride[] = [],
    advanceGenerationOnUnchanged = false,
  ): boolean {
    const current = this.taskMap_abyssPrivate.get(filePath) ?? [];
    const changed = JSON.stringify(current) !== JSON.stringify(tasks);
    if (!changed && !advanceGenerationOnUnchanged) return false;
    // A repository install and Obsidian's matching metadata event can arrive in either order
    // before the already-queued notification is delivered. Keep that batch's proven transition
    // visible to subscribers instead of replacing it with an unchanged self-transition.
    const queuedTransition = this.reconciliationTransitions_abyssPrivate.get(filePath);
    if (
      hasQueuedAuthorityTransition(
        filePath,
        changed,
        this.pendingFiles_abyssPrivate,
        queuedTransition,
      )
    ) {
      return false;
    }
    this.recordReconciliation_abyssPrivate(filePath, current, tasks, authorityTransitions);
    if (!changed) return false;
    this.installFileTasks_abyssPrivate(filePath, tasks);
    return true;
  }

  private recordReconciliation_abyssPrivate(
    filePath: string,
    current: readonly TaskSnapshot[],
    tasks: readonly TaskSnapshot[],
    authorityTransitions: readonly ProvenRootRevisionOverride[],
  ): void {
    const fromGeneration = this.fileGenerations_abyssPrivate.get(filePath) ?? 0;
    const toGeneration = fromGeneration + 1;
    this.fileGenerations_abyssPrivate.set(filePath, toGeneration);
    const transitions = reconcileRootTransitions(current, tasks, authorityTransitions);
    this.reconciliationTransitions_abyssPrivate.set(filePath, {
      fromGeneration,
      toGeneration,
      writable: transitions.writable,
      visual: transitions.visual,
    });
  }

  private installFileTasks_abyssPrivate(filePath: string, tasks: readonly TaskSnapshot[]): void {
    if (tasks.length > 0) this.taskMap_abyssPrivate.set(filePath, tasks);
    else this.taskMap_abyssPrivate.delete(filePath);
    this.invalidateDependencies_abyssPrivate();
    this.updateSearchFile_abyssPrivate(filePath, tasks);
    const sources = calendarSources(tasks);
    this.calendarDateIndex_abyssPrivate.updateFile(filePath, sources);
    this.timeEntryIndex_abyssPrivate.updateFile(filePath, tasks);
    const recurringSources = activeRecurringSources(sources);
    if (recurringSources.length > 0)
      this.recurringSourcesByFile_abyssPrivate.set(filePath, recurringSources);
    else this.recurringSourcesByFile_abyssPrivate.delete(filePath);
  }

  private registerEvents_abyssPrivate(): void {
    if (this.metadataCacheRefs_abyssPrivate.length === 0)
      this.metadataCacheRefs_abyssPrivate.push(
        this.app_abyssPrivate.metadataCache.on(
          'changed',
          (file: TFile, data: string, cache: CachedMetadata) => {
            this.handleMetadataChanged_abyssPrivate(file, data, cache);
          },
        ),
      );
    // Keep each ref immediately: a later registration can throw without forfeiting ownership.
    if (this.vaultRefs_abyssPrivate.length === 0)
      this.vaultRefs_abyssPrivate.push(
        this.app_abyssPrivate.vault.on('create', (file: TAbstractFile) => {
          this.handleVaultCreate_abyssPrivate(file);
        }),
      );
    if (this.vaultRefs_abyssPrivate.length === 1)
      this.vaultRefs_abyssPrivate.push(
        this.app_abyssPrivate.vault.on('rename', (file: TAbstractFile, oldPath: string) => {
          this.handleVaultRename_abyssPrivate(file, oldPath);
        }),
      );
    if (this.vaultRefs_abyssPrivate.length === 2)
      this.vaultRefs_abyssPrivate.push(
        this.app_abyssPrivate.vault.on('delete', (file: TAbstractFile) => {
          this.handleVaultDelete_abyssPrivate(file);
        }),
      );
  }

  private handleMetadataChanged_abyssPrivate(
    file: TFile,
    data: string,
    cache: CachedMetadata,
  ): void {
    const path = file.path;
    if (
      file.extension !== 'md' ||
      this.destroyed_abyssPrivate ||
      this.app_abyssPrivate.vault.getAbstractFileByPath(path) !== file
    ) {
      return;
    }
    this.advance_abyssPrivate(file, path);
    const observation = this.observe_abyssPrivate(file, path);
    if (observation === undefined) return;
    if (this.observationNeedsVerification_abyssPrivate(path, data)) {
      const read = this.observationMatchesVault_abyssPrivate(observation, data).then((matches) => {
        if (matches && this.isCurrent_abyssPrivate(observation)) {
          this.applyMetadataChanged_abyssPrivate(path, data, cache);
        }
      });
      this.trackRead_abyssPrivate(read);
      return;
    }
    this.applyMetadataChanged_abyssPrivate(path, data, cache);
  }

  private applyMetadataChanged_abyssPrivate(
    path: string,
    data: string,
    cache: CachedMetadata,
  ): void {
    if (this.options_abyssPrivate.refAuthority?.deferObservation(path, data) === true) return;
    const selectedCache = this.cacheWithFrontmatter_abyssPrivate(data, cache);
    if (this.sourceIsExcluded_abyssPrivate(path, data)) {
      this.options_abyssPrivate.refAuthority?.discard(path);
      const changed = this.replaceFile_abyssPrivate(path, [], [], true);
      if (changed) this.queueChanged_abyssPrivate(path);
      else this.queueReconciled_abyssPrivate(path);
      return;
    }
    let authorityTransitions: readonly ProvenRootRevisionOverride[] = [];
    const tasks = this.parseFile_abyssPrivate({
      filePath: path,
      content: data,
      cache: selectedCache,
      allocateSuccessor: true,
      captureAuthorityTransitions: (transitions) => {
        authorityTransitions = transitions;
      },
      observedFile: this.fileGenerations_abyssPrivate.has(path),
    });
    const changed = this.replaceFile_abyssPrivate(path, tasks, authorityTransitions, true);
    if (changed) this.queueChanged_abyssPrivate(path);
    else this.queueReconciled_abyssPrivate(path);
  }

  private handleVaultCreate_abyssPrivate(file: TAbstractFile): void {
    if (!(file instanceof TFile) || file.extension !== 'md' || this.destroyed_abyssPrivate) return;
    const path = file.path;
    if (this.app_abyssPrivate.vault.getAbstractFileByPath(path) !== file) return;
    this.advance_abyssPrivate(file, path);
    const read = this.loadFile_abyssPrivate(file, path, true).then((committed) => {
      if (committed) this.queueChanged_abyssPrivate(path);
    });
    this.trackRead_abyssPrivate(read);
  }

  private handleVaultRename_abyssPrivate(file: TAbstractFile, oldPath: string): void {
    if (!(file instanceof TFile) || this.destroyed_abyssPrivate) return;
    const newPath = file.path;
    const wasMarkdown = extensionOf(oldPath) === 'md';
    const isMarkdown = file.extension === 'md';
    if (!wasMarkdown && !isMarkdown) return;
    if (this.app_abyssPrivate.vault.getAbstractFileByPath(newPath) !== file) return;
    const tasks = this.taskMap_abyssPrivate.get(oldPath) ?? [];
    this.advance_abyssPrivate(file, isMarkdown ? newPath : undefined);
    this.removeFile_abyssPrivate(oldPath);
    if (newPath !== oldPath) this.removeFile_abyssPrivate(newPath);
    this.finishVaultRename_abyssPrivate({ file, oldPath, newPath, tasks, wasMarkdown, isMarkdown });
  }

  private finishVaultRename_abyssPrivate(input: {
    readonly file: TFile;
    readonly oldPath: string;
    readonly newPath: string;
    readonly tasks: readonly TaskSnapshot[];
    readonly wasMarkdown: boolean;
    readonly isMarkdown: boolean;
  }): void {
    if (input.wasMarkdown && input.isMarkdown) {
      this.handleMarkdownRename_abyssPrivate(input.file, input.oldPath, input.newPath, input.tasks);
      return;
    }
    if (input.wasMarkdown) {
      this.publish_abyssPrivate({
        type: 'renamed',
        oldPath: input.oldPath,
        newPath: input.newPath,
      });
      return;
    }
    this.scheduleRenameLoad_abyssPrivate(input.file, input.oldPath, input.newPath);
  }

  private handleMarkdownRename_abyssPrivate(
    file: TFile,
    oldPath: string,
    newPath: string,
    tasks: readonly TaskSnapshot[],
  ): void {
    if (tasks.length === 0 || this.excludeSource_abyssPrivate !== undefined) {
      this.scheduleRenameLoad_abyssPrivate(file, oldPath, newPath);
      return;
    }
    this.replaceFile_abyssPrivate(
      newPath,
      tasks.map((task) => this.relocateRenamedTask_abyssPrivate(task, newPath)),
    );
    this.publish_abyssPrivate({ type: 'renamed', oldPath, newPath });
  }

  private relocateRenamedTask_abyssPrivate(task: TaskSnapshot, newPath: string): TaskSnapshot {
    const relocated = relocateSnapshot(task, newPath);
    const revision = this.options_abyssPrivate.refAuthority?.mintRevision(
      relocated.source.originalBlock,
    );
    if (!nonEmpty(revision)) return relocated;
    const revised = { ...relocated, ref: { ...relocated.ref, revision } };
    return relocateSnapshot(revised, newPath);
  }

  private scheduleRenameLoad_abyssPrivate(file: TFile, oldPath: string, newPath: string): void {
    const read = this.loadFile_abyssPrivate(file, newPath, true).then((committed) => {
      if (committed || this.isFileAt_abyssPrivate(file, newPath)) {
        this.publish_abyssPrivate({ type: 'renamed', oldPath, newPath });
      }
    });
    this.trackRead_abyssPrivate(read);
  }

  private handleVaultDelete_abyssPrivate(file: TAbstractFile): void {
    if (!(file instanceof TFile) || file.extension !== 'md' || this.destroyed_abyssPrivate) return;
    const path = file.path;
    const existed = this.taskMap_abyssPrivate.has(path);
    this.advance_abyssPrivate(file, undefined);
    this.removeFile_abyssPrivate(path);
    if (existed) this.publish_abyssPrivate({ type: 'deleted', path });
  }

  private removeFile_abyssPrivate(filePath: string): void {
    this.taskMap_abyssPrivate.delete(filePath);
    this.invalidateDependencies_abyssPrivate();
    if (this.searchFiles_abyssPrivate.has(filePath))
      this.updateSearchFile_abyssPrivate(filePath, []);
    this.calendarDateIndex_abyssPrivate.updateFile(filePath, []);
    this.timeEntryIndex_abyssPrivate.removeFile(filePath);
    this.recurringSourcesByFile_abyssPrivate.delete(filePath);
    this.fileGenerations_abyssPrivate.delete(filePath);
    this.committedContents_abyssPrivate.delete(filePath);
    this.reconciliationTransitions_abyssPrivate.delete(filePath);
    this.pendingFiles_abyssPrivate.delete(filePath);
    this.pendingReconciledFiles_abyssPrivate.delete(filePath);
    this.options_abyssPrivate.refAuthority?.discard(filePath);
  }

  private observe_abyssPrivate(file: TFile, path: string): FileObservation | undefined {
    if (
      this.destroyed_abyssPrivate ||
      this.app_abyssPrivate.vault.getAbstractFileByPath(path) !== file
    )
      return undefined;
    const existing = this.fileLifecycles_abyssPrivate.get(file);
    if (existing != null && existing.path !== path) return undefined;
    const lifecycle = existing ?? { path, generation: 0 };
    if (existing == null) this.fileLifecycles_abyssPrivate.set(file, lifecycle);
    return { file, path, generation: lifecycle.generation };
  }

  private advance_abyssPrivate(file: TFile, path: string | undefined): void {
    const lifecycle = this.fileLifecycles_abyssPrivate.get(file);
    this.fileLifecycles_abyssPrivate.set(file, {
      path,
      generation: (lifecycle?.generation ?? 0) + 1,
    });
  }

  private isCurrent_abyssPrivate(observation: FileObservation): boolean {
    const lifecycle = this.fileLifecycles_abyssPrivate.get(observation.file);
    return (
      !this.destroyed_abyssPrivate &&
      lifecycle?.path === observation.path &&
      lifecycle.generation === observation.generation &&
      observation.file.extension === 'md' &&
      this.app_abyssPrivate.vault.getAbstractFileByPath(observation.path) === observation.file
    );
  }

  private isFileAt_abyssPrivate(file: TFile, path: string): boolean {
    const lifecycle = this.fileLifecycles_abyssPrivate.get(file);
    return (
      !this.destroyed_abyssPrivate &&
      lifecycle?.path === path &&
      file.extension === 'md' &&
      this.app_abyssPrivate.vault.getAbstractFileByPath(path) === file
    );
  }

  private observationNeedsVerification_abyssPrivate(path: string, content: string): boolean {
    const committed = this.committedContents_abyssPrivate.get(path);
    return committed !== undefined && committed !== content;
  }

  private async observationMatchesVault_abyssPrivate(
    observation: FileObservation,
    content: string,
  ): Promise<boolean> {
    const committed = this.committedContents_abyssPrivate.get(observation.path);
    if (committed === undefined || committed === content) return true;
    try {
      const current = await this.app_abyssPrivate.vault.read(observation.file);
      if (!this.isCurrent_abyssPrivate(observation)) return false;
      if (current === committed) return false;
      if (current !== content) return false;
      this.committedContents_abyssPrivate.delete(observation.path);
      return true;
    } catch {
      return false;
    }
  }

  private trackRead_abyssPrivate(read: Promise<void>): void {
    this.pendingReads_abyssPrivate.add(read);
    read.finally(() => this.pendingReads_abyssPrivate.delete(read)).catch(() => undefined);
  }

  private async drainPendingReads_abyssPrivate(): Promise<void> {
    while (!this.destroyed_abyssPrivate && this.pendingReads_abyssPrivate.size > 0) {
      await Promise.all([...this.pendingReads_abyssPrivate]);
    }
  }

  private queueChanged_abyssPrivate(filePath: string): void {
    if (this.destroyed_abyssPrivate || !this.initialized_abyssPrivate) return;
    this.pendingFiles_abyssPrivate.add(filePath);
    this.pendingReconciledFiles_abyssPrivate.delete(filePath);
    this.scheduleFileEvents_abyssPrivate();
  }

  private queueReconciled_abyssPrivate(filePath: string): void {
    if (
      this.destroyed_abyssPrivate ||
      !this.initialized_abyssPrivate ||
      this.pendingFiles_abyssPrivate.has(filePath)
    )
      return;
    this.pendingReconciledFiles_abyssPrivate.add(filePath);
    this.scheduleFileEvents_abyssPrivate();
  }

  private scheduleFileEvents_abyssPrivate(): void {
    if (this.flushScheduled_abyssPrivate) return;
    this.flushScheduled_abyssPrivate = true;
    Promise.resolve()
      .then(() => {
        this.flushScheduled_abyssPrivate = false;
        if (this.destroyed_abyssPrivate) return;
        const files = [...this.pendingFiles_abyssPrivate].sort((left, right) =>
          left.localeCompare(right),
        );
        const reconciledFiles = [...this.pendingReconciledFiles_abyssPrivate]
          .filter((path) => !this.pendingFiles_abyssPrivate.has(path))
          .sort((left, right) => left.localeCompare(right));
        this.pendingFiles_abyssPrivate.clear();
        this.pendingReconciledFiles_abyssPrivate.clear();
        if (files.length > 0) this.publish_abyssPrivate({ type: 'changed', files });
        if (reconciledFiles.length > 0) this.publishReconciled_abyssPrivate(reconciledFiles);
      })
      .catch((error: unknown) => {
        console.error('[abyss-tasks] task index publication failed', error);
      });
  }

  private publish_abyssPrivate(event: TaskIndexEvent): void {
    if (
      this.destroyed_abyssPrivate ||
      (!this.initialized_abyssPrivate && event.type !== 'initialized')
    )
      return;
    const detached = immutableEvent(event);
    for (const listener of [...this.listeners_abyssPrivate]) {
      deliverIsolated(event.type, listener, detached);
    }
  }

  private publishReconciled_abyssPrivate(files: readonly string[]): void {
    if (this.destroyed_abyssPrivate || !this.initialized_abyssPrivate) return;
    const detached = Object.freeze([...files]);
    for (const listener of [...this.reconciledListeners_abyssPrivate]) {
      deliverIsolated('reconciled', listener, detached);
    }
  }
}
