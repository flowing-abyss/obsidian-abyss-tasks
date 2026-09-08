import {
  parseYaml,
  TFile,
  type App,
  type CachedMetadata,
  type EventRef,
  type TAbstractFile,
} from 'obsidian';
import type {
  CalendarProjectionSources,
  CalendarTaskSource,
  TaskDependencyQueryApi,
  TaskIndexEvent,
  TaskQuery,
  TaskQueryApi,
} from '../application/TaskApplicationApi';
import { cloneTaskSnapshot, taskSnapshotWithStatuses } from '../domain/cloneTaskSnapshot';
import type { TaskResolutionCandidate } from '../domain/commands';
import type { StatusCatalog } from '../domain/StatusCatalog';
import {
  buildTaskDependencyGraph,
  enumerateTaskNodes,
  type TaskDependencyEligibility,
  type TaskDependencyGraph,
  type TaskDependencyProjection,
  type TaskNodeSnapshot,
} from '../domain/taskDependencies';
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
  sameTaskNodeRef,
  type LocalDate,
  type SubtaskSnapshot,
  type TaskNodeRef,
  type TaskRef,
  type TaskSnapshot,
} from '../domain/types';
import { localDate } from '../domain/validation';
import { TaskBlockEditor } from './markdown/TaskBlockEditor';
import { TaskLocator } from './markdown/TaskLocator';
import { TaskMarkdownCodec } from './markdown/TaskMarkdownCodec';
import { projectTaskSnapshot } from './markdown/TaskSnapshotProjector';
import { calendarDatesForPlanning, calendarRangeForPlanning, TaskDateIndex } from './TaskDateIndex';
import {
  type RootRevisionOverride,
  type TaskRefAuthority,
  type TaskSnapshotState,
} from './TaskRefAuthority';

export interface TaskIndexOptions {
  readonly statusCatalog: StatusCatalog;
  readonly dailyNoteFormat: string;
  readonly globalTaskFilter?: string;
  readonly refAuthority?: TaskRefAuthority;
}

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

function momentToRegex(format: string): RegExp {
  const escaped = format
    .replace(/\./g, '\\.')
    .replace(/,/g, '\\,')
    .replace(/-/g, '\\-')
    .replace(/:/g, '\\:')
    .replace(/ /g, '\\s')
    .replace('dddd', '\\w{4,}')
    .replace('ddd', '\\w{1,3}')
    .replace('dd', '\\w{2}')
    .replace('YYYY', '\\d{4}')
    .replace('YY', '\\d{2}')
    .replace('MMMM', '\\w{4,}')
    .replace('MMM', '\\w{3}')
    .replace('MM', '\\d{2}')
    .replace('DD', '\\d{2}')
    .replace('D', '\\d{1,2}')
    .replace('ww', '\\d{1,2}');
  return new RegExp(`^(${escaped})$`);
}

function asLocalDate(value: string | undefined): LocalDate | undefined {
  if (value === undefined) return undefined;
  try {
    return localDate(value);
  } catch {
    return undefined;
  }
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

interface FallbackFence {
  readonly marker: '`' | '~';
  readonly length: number;
  readonly quoteDepth: number;
}

interface FallbackFenceTransition {
  readonly active: FallbackFence | undefined;
  readonly skip: boolean;
  readonly opening: boolean;
}

interface FallbackScanState {
  readonly items: FallbackListItem[];
  readonly ancestorsByQuoteDepth: Map<number, FallbackListAncestor[]>;
  offset: number;
  frontmatter: boolean;
  fence: FallbackFence | undefined;
  previousQuoteDepth: number | undefined;
}

interface FallbackListLine {
  readonly line: string;
  readonly lineNumber: number;
  readonly quoteDepth: number;
  readonly prefix: string;
}

const FALLBACK_LIST_ITEM_RE = /^([\s>]*)(?:[-*+]|\d+[.)])\s+/u;
const FALLBACK_TASK_RE = /^[\s>]*- \[(.)\]/u;
const FALLBACK_FENCE_RE = /^[\s>]*(`{3,}|~{3,})/u;
const FALLBACK_PREFIX_RE = /^([\s>]*)/u;

function closesFallbackFence(
  active: FallbackFence,
  quoteDepth: number,
  token: string | undefined,
): boolean {
  return (
    quoteDepth === active.quoteDepth &&
    token?.[0] === active.marker &&
    token.length >= active.length
  );
}

function fallbackFenceState(
  line: string,
  quoteDepth: number,
  active: FallbackFence | undefined,
): FallbackFenceTransition {
  const token = FALLBACK_FENCE_RE.exec(line)?.[1];
  if (active != null && quoteDepth >= active.quoteDepth) {
    return {
      active: closesFallbackFence(active, quoteDepth, token) ? undefined : active,
      skip: true,
      opening: false,
    };
  }
  if (token === undefined) return { active: undefined, skip: false, opening: false };
  const marker = token[0];
  return marker === '`' || marker === '~'
    ? {
        active: { marker, length: token.length, quoteDepth },
        skip: true,
        opening: true,
      }
    : { active: undefined, skip: false, opening: false };
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
  const transition = fallbackFenceState(line, quoteDepth, state.fence);
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
  const task = FALLBACK_TASK_RE.exec(line)?.[1];
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
  for (let lineNumber = 0; lineNumber < lines.length; lineNumber++) {
    consumeFallbackLine(state, lines[lineNumber] ?? '', lineNumber);
  }
  return state.items;
}

function cacheWithContentFallback(
  data: string,
  cache: CachedMetadata | null | undefined,
): CachedMetadata {
  const fallbackItems = fallbackListItems(data);
  const sourceHasTask = fallbackItems.some((item) => item.task !== undefined);
  if (
    cache?.listItems !== undefined &&
    (cache.listItems.some((item) => item.task !== undefined) || !sourceHasTask)
  ) {
    return cache;
  }
  return { ...(cache ?? {}), listItems: fallbackItems };
}

function frontmatterFromContent(data: string): Record<string, unknown> | undefined {
  const lines = data.split(/\r?\n/u);
  if (lines[0]?.replace(/^\uFEFF/u, '').trim() !== '---') return undefined;
  const closing = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
  if (closing < 0) return undefined;
  try {
    const parsed: unknown = parseYaml(lines.slice(1, closing).join('\n'));
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function extensionOf(path: string): string {
  const name = path.replace(/^.*\//u, '');
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot + 1) : '';
}

function dailyNoteDateForPath(filePath: string, format: string): LocalDate | undefined {
  const filename = filePath.replace(/^.*\//u, '').replace(/\.[^.]*$/u, '');
  return momentToRegex(format).test(filename)
    ? asLocalDate(window.moment(filename, format).format('YYYY-MM-DD'))
    : undefined;
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
  filePath: string,
  dailyNoteFormat: string,
  frontmatter: CachedMetadata['frontmatter'],
): TaskSnapshot['presentation'] {
  const dailyNoteDate = dailyNoteDateForPath(filePath, dailyNoteFormat);
  const noteColor = frontmatterText(frontmatter, 'color');
  const noteTextColor = frontmatterText(frontmatter, 'textColor');
  const noteIcon = frontmatterText(frontmatter, 'icon');
  const presentation: {
    linkCount: number;
    dailyNoteDate?: LocalDate;
    noteColor?: string;
    noteTextColor?: string;
    noteIcon?: string;
  } = { linkCount: 0 };
  if (nonEmpty(dailyNoteDate)) presentation.dailyNoteDate = dailyNoteDate;
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

function relocateSnapshot(
  task: TaskSnapshot,
  filePath: string,
  dailyNoteDate: LocalDate | undefined,
): TaskSnapshot {
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
      ...(dailyNoteDate != null && { dailyNoteDate }),
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
  return nonEmpty(tag) ? tasks.filter((task) => task.tags.includes(tag)) : tasks;
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
      authorityTransition: { ...basis.authorityTransition },
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

export class TaskIndex implements TaskQueryApi, TaskDependencyQueryApi, TaskSnapshotState {
  private readonly taskMap_abyssPrivate = new Map<string, readonly TaskSnapshot[]>();
  private readonly calendarDateIndex_abyssPrivate = new TaskDateIndex<CalendarTaskSource>(
    (source) => calendarDatesForPlanning(source.node.planning),
    (source) => calendarRangeForPlanning(source.node.planning),
  );
  private readonly recurringSourcesByFile_abyssPrivate = new Map<
    string,
    readonly CalendarTaskSource[]
  >();
  private readonly fileGenerations_abyssPrivate = new Map<string, number>();
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
  private readonly blockEditor_abyssPrivate = new TaskBlockEditor();
  private readonly locator_abyssPrivate: TaskLocator;

  constructor(
    private readonly app_abyssPrivate: App,
    private readonly options_abyssPrivate: TaskIndexOptions,
  ) {
    this.statusCatalog_abyssPrivate = options_abyssPrivate.statusCatalog;
    this.locator_abyssPrivate = new TaskLocator(options_abyssPrivate.refAuthority);
  }

  setStatusCatalog(statusCatalog: StatusCatalog): void {
    this.statusCatalog_abyssPrivate = statusCatalog;
    this.dependencyGraph_abyssPrivate = undefined;
  }

  async initialize(): Promise<void> {
    if (this.initialized_abyssPrivate || this.destroyed_abyssPrivate) return;
    this.initialization_abyssPrivate ??= this.performInitialization_abyssPrivate();
    await this.initialization_abyssPrivate;
  }

  private async performInitialization_abyssPrivate(): Promise<void> {
    this.registerEvents_abyssPrivate();
    const files = [...this.app_abyssPrivate.vault.getMarkdownFiles()]
      .map((file) => ({ file, path: file.path }))
      .sort((left, right) => left.path.localeCompare(right.path));
    const chunkSize = 50;
    for (let index = 0; index < files.length; index += chunkSize) {
      await Promise.all(
        files
          .slice(index, index + chunkSize)
          .map(({ file, path }) => this.loadFile_abyssPrivate(file, path, false)),
      );
      if (index + chunkSize < files.length) {
        await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
      }
    }
    await this.drainPendingReads_abyssPrivate();
    if (this.destroyed_abyssPrivate) return;
    this.initialized_abyssPrivate = true;
    this.publish_abyssPrivate({ type: 'initialized' });
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
    return this.currentDependencyGraph_abyssPrivate().dependencies(target);
  }

  dependencyEligibility(
    blocker: TaskNodeRef,
    dependent: TaskNodeRef,
    options?: Parameters<TaskDependencyQueryApi['dependencyEligibility']>[2],
  ): TaskDependencyEligibility {
    if (options === undefined)
      return this.currentDependencyGraph_abyssPrivate().eligibility(blocker, dependent);
    const nodes = this.listNodes();
    const status = (symbol: string): ReturnType<StatusCatalog['statusForSymbol']> =>
      this.statusCatalog_abyssPrivate.statusForSymbol(symbol);
    const original = options.without;
    const relation = buildTaskDependencyGraph(nodes, status)
      .dependencies(original.dependent)
      .blockedBy.find((row) => row.dependencyId === original.dependencyId);
    if (
      relation?.type !== 'resolved' ||
      !sameTaskNodeRef(relation.task.target, original.blocker) ||
      !sameTaskNodeRef(blocker, original.dependent) ||
      !sameTaskNodeRef(dependent, original.blocker)
    )
      return { type: 'rejected', reason: 'unavailable' };
    return buildTaskDependencyGraph(nodes, status, original).eligibility(blocker, dependent);
  }

  private currentDependencyGraph_abyssPrivate(): TaskDependencyGraph {
    this.dependencyGraph_abyssPrivate ??= buildTaskDependencyGraph(this.listNodes(), (symbol) =>
      this.statusCatalog_abyssPrivate.statusForSymbol(symbol),
    );
    return this.dependencyGraph_abyssPrivate;
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
    this.taskMap_abyssPrivate.clear();
    this.dependencyGraph_abyssPrivate = undefined;
    this.fileGenerations_abyssPrivate.clear();
    this.reconciliationTransitions_abyssPrivate.clear();
    this.options_abyssPrivate.refAuthority?.clear();
    this.calendarDateIndex_abyssPrivate.clear();
    this.recurringSourcesByFile_abyssPrivate.clear();
  }

  private async loadFile_abyssPrivate(
    file: TFile,
    path: string,
    forceContentFallback: boolean,
    observedFile = false,
  ): Promise<boolean> {
    const observation = this.observe_abyssPrivate(file, path);
    if (observation == null) return false;
    const cache = this.app_abyssPrivate.metadataCache.getFileCache(file);
    const hasCachedTasks = cache?.listItems?.some((item) => item.task !== undefined) ?? false;
    if (!forceContentFallback && !hasCachedTasks) {
      return this.loadEmptyFile_abyssPrivate(observation);
    }
    return this.loadParsedFile_abyssPrivate(observation, cache, forceContentFallback, observedFile);
  }

  private async loadEmptyFile_abyssPrivate(observation: FileObservation): Promise<boolean> {
    try {
      const authority = this.options_abyssPrivate.refAuthority;
      if (authority != null) {
        const content = await this.app_abyssPrivate.vault.cachedRead(observation.file);
        if (!this.isCurrent_abyssPrivate(observation)) return false;
        if (authority.deferObservation(observation.path, content)) return false;
      }
    } catch {
      // The empty replacement still wins for the observed lifecycle generation.
    }
    return this.commitEmptyObservation_abyssPrivate(observation);
  }

  private commitEmptyObservation_abyssPrivate(observation: FileObservation): boolean {
    if (!this.isCurrent_abyssPrivate(observation)) return false;
    this.replaceFile_abyssPrivate(observation.path, [], [], true);
    return true;
  }

  private async loadParsedFile_abyssPrivate(
    observation: FileObservation,
    cache: CachedMetadata | null,
    forceContentFallback: boolean,
    observedFile: boolean,
  ): Promise<boolean> {
    try {
      const content = await this.app_abyssPrivate.vault.cachedRead(observation.file);
      if (!this.isCurrent_abyssPrivate(observation)) return false;
      if (
        this.options_abyssPrivate.refAuthority?.deferObservation(observation.path, content) === true
      )
        return false;
      const selectedCache = forceContentFallback ? cacheWithContentFallback(content, cache) : cache;
      if (selectedCache == null) return false;
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
      presentation: taskPresentation(
        filePath,
        this.options_abyssPrivate.dailyNoteFormat,
        cache.frontmatter,
      ),
      itemByLine: metadataItemsByLine(cache.listItems ?? []),
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
    });
  }

  /** Pure infrastructure collaborator used by the repository for immediate command outcomes. */
  snapshotsFromContent(filePath: string, content: string): readonly TaskSnapshot[] {
    return this.previewContent(filePath, content);
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
    const cache = cacheWithContentFallback(content, null);
    const frontmatter = frontmatterFromContent(content);
    return this.parseFile_abyssPrivate({
      filePath,
      content,
      cache: { ...cache, ...(frontmatter != null && { frontmatter }) },
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
    const prepared = [...contents].map(([filePath, content]) => {
      let restored = false;
      const cache = cacheWithContentFallback(content, null);
      const frontmatter = frontmatterFromContent(content);
      let authorityTransitions: readonly ProvenRootRevisionOverride[] = [];
      const tasks = this.parseFile_abyssPrivate({
        filePath,
        content,
        cache: { ...cache, ...(frontmatter != null && { frontmatter }) },
        allocateSuccessor: true,
        captureAuthorityTransitions: (transitions, restoration) => {
          authorityTransitions = transitions;
          restored = restoration === true;
        },
        observedFile: this.fileGenerations_abyssPrivate.has(filePath),
      });
      roots.push(...tasks);
      return () => {
        if (this.replaceFile_abyssPrivate(filePath, tasks, authorityTransitions))
          this.queueChanged_abyssPrivate(filePath);
        if (restored) this.reconciliationTransitions_abyssPrivate.delete(filePath);
      };
    });
    prove(roots);
    for (const publish of prepared) publish();
    return roots.map(cloneTaskSnapshot);
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
    this.dependencyGraph_abyssPrivate = undefined;
    if (tasks.length > 0) this.taskMap_abyssPrivate.set(filePath, tasks);
    else this.taskMap_abyssPrivate.delete(filePath);
    const sources = calendarSources(tasks);
    this.calendarDateIndex_abyssPrivate.updateFile(filePath, sources);
    const recurringSources = activeRecurringSources(sources);
    if (recurringSources.length > 0)
      this.recurringSourcesByFile_abyssPrivate.set(filePath, recurringSources);
    else this.recurringSourcesByFile_abyssPrivate.delete(filePath);
  }

  private registerEvents_abyssPrivate(): void {
    const metadataChanged = this.app_abyssPrivate.metadataCache.on(
      'changed',
      (file: TFile, data: string, cache: CachedMetadata) => {
        this.handleMetadataChanged_abyssPrivate(file, data, cache);
      },
    );
    this.metadataCacheRefs_abyssPrivate.push(metadataChanged);
    const created = this.app_abyssPrivate.vault.on('create', (file: TAbstractFile) => {
      this.handleVaultCreate_abyssPrivate(file);
    });
    const renamed = this.app_abyssPrivate.vault.on(
      'rename',
      (file: TAbstractFile, oldPath: string) => {
        this.handleVaultRename_abyssPrivate(file, oldPath);
      },
    );
    const deleted = this.app_abyssPrivate.vault.on('delete', (file: TAbstractFile) => {
      this.handleVaultDelete_abyssPrivate(file);
    });
    this.vaultRefs_abyssPrivate.push(created, renamed, deleted);
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
    if (this.options_abyssPrivate.refAuthority?.deferObservation(path, data) === true) return;
    let authorityTransitions: readonly ProvenRootRevisionOverride[] = [];
    const tasks = this.parseFile_abyssPrivate({
      filePath: path,
      content: data,
      cache: cacheWithContentFallback(data, cache),
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
    const read = this.loadFile_abyssPrivate(file, path, true, true).then((committed) => {
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
    if (tasks.length === 0) {
      this.scheduleRenameLoad_abyssPrivate(file, oldPath, newPath);
      return;
    }
    const dailyNoteDate = dailyNoteDateForPath(newPath, this.options_abyssPrivate.dailyNoteFormat);
    this.replaceFile_abyssPrivate(
      newPath,
      tasks.map((task) => this.relocateRenamedTask_abyssPrivate(task, newPath, dailyNoteDate)),
    );
    this.publish_abyssPrivate({ type: 'renamed', oldPath, newPath });
  }

  private relocateRenamedTask_abyssPrivate(
    task: TaskSnapshot,
    newPath: string,
    dailyNoteDate: LocalDate | undefined,
  ): TaskSnapshot {
    const relocated = relocateSnapshot(task, newPath, dailyNoteDate);
    const revision = this.options_abyssPrivate.refAuthority?.mintRevision(
      relocated.source.originalBlock,
    );
    if (!nonEmpty(revision)) return relocated;
    const revised = { ...relocated, ref: { ...relocated.ref, revision } };
    return relocateSnapshot(revised, newPath, dailyNoteDate);
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
    this.dependencyGraph_abyssPrivate = undefined;
    this.taskMap_abyssPrivate.delete(filePath);
    this.calendarDateIndex_abyssPrivate.updateFile(filePath, []);
    this.recurringSourcesByFile_abyssPrivate.delete(filePath);
    this.fileGenerations_abyssPrivate.delete(filePath);
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
      .catch(() => undefined);
  }

  private publish_abyssPrivate(event: TaskIndexEvent): void {
    if (
      this.destroyed_abyssPrivate ||
      (!this.initialized_abyssPrivate && event.type !== 'initialized')
    )
      return;
    const detached = immutableEvent(event);
    for (const listener of [...this.listeners_abyssPrivate]) listener(detached);
  }

  private publishReconciled_abyssPrivate(files: readonly string[]): void {
    if (this.destroyed_abyssPrivate || !this.initialized_abyssPrivate) return;
    const detached = Object.freeze([...files]);
    for (const listener of [...this.reconciledListeners_abyssPrivate]) listener(detached);
  }
}
