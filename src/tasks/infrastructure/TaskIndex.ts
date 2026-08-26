import {
  parseYaml,
  TFile,
  TFolder,
  type App,
  type CachedMetadata,
  type EventRef,
  type TAbstractFile,
} from 'obsidian';
import type {
  CalendarProjectionSources,
  CalendarTaskSource,
  TaskIndexEvent,
  TaskIndexSettledEvent,
  TaskQuery,
  TaskQueryApi,
} from '../application/TaskApplicationApi';
import { cloneTaskSnapshot } from '../domain/cloneTaskSnapshot';
import type { TaskResolutionCandidate } from '../domain/commands';
import type { StatusCatalog } from '../domain/StatusCatalog';
import {
  reconcileRootTransitions,
  taskReconciliationKey,
  type ProvenRootRevisionOverride,
  type ProvenRootTransition,
  type RootReconciliationBasis,
  type TaskResolution,
  type VisualEvidence,
} from '../domain/taskReconciliation';
import type {
  LocalDate,
  SubtaskSnapshot,
  TaskNodeRef,
  TaskRef,
  TaskSnapshot,
} from '../domain/types';
import { localDate } from '../domain/validation';
import { TaskBlockEditor } from './markdown/TaskBlockEditor';
import { TaskLocator } from './markdown/TaskLocator';
import { TaskMarkdownCodec } from './markdown/TaskMarkdownCodec';
import { projectTaskSnapshot } from './markdown/TaskSnapshotProjector';
import { calendarDatesForPlanning, calendarRangeForPlanning, TaskDateIndex } from './TaskDateIndex';
import {
  TaskRefAuthority,
  type RootRevisionOverride,
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

interface FileReconciliationTransition {
  readonly fromGeneration: number;
  readonly toGeneration: number;
  readonly writable: ReadonlyMap<
    string,
    {
      readonly previous: TaskSnapshot;
      readonly current: TaskSnapshot;
      readonly evidence: ProvenRootTransition['evidence'];
      readonly basis: RootReconciliationBasis;
    }
  >;
  readonly visual: ReadonlyMap<
    string,
    { readonly stale: TaskRef; readonly current: TaskSnapshot; readonly evidence: VisualEvidence }
  >;
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
  return (
    left.source.filePath.localeCompare(right.source.filePath) ||
    left.source.line - right.source.line
  );
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
    const order = leftPath[index]! - rightPath[index]!;
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
    const pair = pending.pop()!;
    if (pair.originals.length !== pair.clones.length) {
      throw new Error('calendar-source-clone-shape-mismatch');
    }
    for (let index = 0; index < pair.originals.length; index++) {
      const sourceNode = pair.originals[index]!;
      const clonedNode = pair.clones[index]!;
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
  if (event.type === 'settled') {
    const files = Object.freeze(event.files.map((file) => Object.freeze({ ...file })));
    if (event.reason === 'topology') {
      return Object.freeze({
        type: 'settled',
        reason: 'topology',
        topology: Object.freeze({ ...event.topology }),
        files,
      });
    }
    return Object.freeze({
      type: 'settled',
      reason: event.reason,
      files,
    });
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

const FALLBACK_LIST_ITEM_RE = /^([\s>]*)(?:[-*+]|\d+[.)])\s+/u;
const FALLBACK_TASK_RE = /^[\s>]*- \[(.)\]/u;
const FALLBACK_FENCE_RE = /^[\s>]*(`{3,}|~{3,})/u;
const FALLBACK_PREFIX_RE = /^([\s>]*)/u;

function fallbackFenceState(
  line: string,
  quoteDepth: number,
  active: FallbackFence | undefined,
): FallbackFenceTransition {
  const token = FALLBACK_FENCE_RE.exec(line)?.[1];
  if (active && quoteDepth >= active.quoteDepth) {
    const closes =
      quoteDepth === active.quoteDepth &&
      token?.[0] === active.marker &&
      token.length >= active.length;
    return { active: closes ? undefined : active, skip: true, opening: false };
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
  while (ancestors.length > 0 && ancestors[ancestors.length - 1]!.indent >= indent) {
    ancestors.pop();
  }
  ancestorsByQuoteDepth.set(quoteDepth, ancestors);
  return nextQuoteDepth;
}

function fallbackListItems(data: string): FallbackListItem[] {
  const lines = data.split('\n');
  const items: FallbackListItem[] = [];
  const ancestorsByQuoteDepth = new Map<number, FallbackListAncestor[]>();
  let offset = 0;
  let frontmatter = lines[0]?.trim() === '---';
  let fence: FallbackFence | undefined;
  let previousQuoteDepth: number | undefined;

  for (let lineNumber = 0; lineNumber < lines.length; lineNumber++) {
    const line = lines[lineNumber] ?? '';
    if (frontmatter) {
      if (lineNumber > 0 && line.trim() === '---') frontmatter = false;
      offset += line.length + 1;
      continue;
    }

    const leadingPrefix = FALLBACK_PREFIX_RE.exec(line)?.[1] ?? '';
    const quoteDepth = [...leadingPrefix].filter((character) => character === '>').length;
    const nextFence = fallbackFenceState(line, quoteDepth, fence);
    fence = nextFence.active;
    if (nextFence.skip) {
      if (nextFence.opening) {
        const indent = leadingPrefix.replace(/\t/gu, '    ').length;
        previousQuoteDepth = transitionFallbackNonListBoundary(
          quoteDepth,
          indent,
          previousQuoteDepth,
          ancestorsByQuoteDepth,
        );
      }
      offset += line.length + 1;
      continue;
    }
    if (/^[\s>]*$/u.test(line)) {
      offset += line.length + 1;
      continue;
    }

    const listMatch = FALLBACK_LIST_ITEM_RE.exec(line);
    if (!listMatch) {
      const indent = leadingPrefix.replace(/\t/gu, '    ').length;
      previousQuoteDepth = transitionFallbackNonListBoundary(
        quoteDepth,
        indent,
        previousQuoteDepth,
        ancestorsByQuoteDepth,
      );
      offset += line.length + 1;
      continue;
    }
    previousQuoteDepth = transitionFallbackQuoteDepth(
      quoteDepth,
      previousQuoteDepth,
      ancestorsByQuoteDepth,
    );
    const prefix = listMatch[1] ?? '';
    const indent = prefix.replace(/\t/gu, '    ').length;
    const ancestors = ancestorsByQuoteDepth.get(quoteDepth) ?? [];
    while (ancestors.length > 0 && ancestors[ancestors.length - 1]!.indent >= indent) {
      ancestors.pop();
    }
    const parent = ancestors[ancestors.length - 1]?.line ?? -(lineNumber + 1);
    const task = FALLBACK_TASK_RE.exec(line)?.[1];
    items.push({
      ...(task !== undefined && { task }),
      parent,
      position: {
        start: { line: lineNumber, col: prefix.length, offset },
        end: { line: lineNumber, col: line.length, offset: offset + line.length },
      },
    });
    ancestors.push({ line: lineNumber, indent });
    ancestorsByQuoteDepth.set(quoteDepth, ancestors);
    offset += line.length + 1;
  }
  return items;
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

function isDescendant(path: string, folder: string): boolean {
  return path.startsWith(`${folder}/`);
}

function dailyNoteDateForPath(filePath: string, format: string): LocalDate | undefined {
  const filename = filePath.replace(/^.*\//u, '').replace(/\.[^.]*$/u, '');
  return momentToRegex(format).test(filename)
    ? asLocalDate(window.moment(filename, format).format('YYYY-MM-DD'))
    : undefined;
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
      ...(dailyNoteDate && { dailyNoteDate }),
      ...(noteColor && { noteColor }),
      ...(noteTextColor && { noteTextColor }),
      ...(noteIcon && { noteIcon }),
    },
  };
}

export class TaskIndex implements TaskQueryApi, TaskSnapshotState {
  private readonly taskMap = new Map<string, readonly TaskSnapshot[]>();
  private readonly calendarDateIndex = new TaskDateIndex<CalendarTaskSource>(
    (source) => calendarDatesForPlanning(source.node.planning),
    (source) => calendarRangeForPlanning(source.node.planning),
  );
  private readonly recurringSourcesByFile = new Map<string, readonly CalendarTaskSource[]>();
  private readonly fileGenerations = new Map<string, number>();
  private readonly reconciliationTransitions = new Map<string, FileReconciliationTransition>();
  private listeners: Listener[] = [];
  private settledListeners: Array<(event: TaskIndexSettledEvent) => void> = [];
  private readonly pendingFiles = new Set<string>();
  private readonly pendingSettledFiles = new Map<
    string,
    { readonly generation: number; readonly reason: 'index' | 'initialization' }
  >();
  private fileLifecycles = new WeakMap<TFile, FileLifecycle>();
  private readonly pendingReads = new Set<Promise<void>>();
  private flushScheduled = false;
  private metadataCacheRefs: EventRef[] = [];
  private vaultRefs: EventRef[] = [];
  private initialization: Promise<void> | undefined;
  private initialized = false;
  private destroyed = false;
  private statusCatalog: StatusCatalog;
  private readonly blockEditor = new TaskBlockEditor();
  private readonly locator: TaskLocator;

  constructor(
    private readonly app: App,
    private readonly options: TaskIndexOptions,
  ) {
    this.statusCatalog = options.statusCatalog;
    this.locator = new TaskLocator(options.refAuthority);
  }

  setStatusCatalog(statusCatalog: StatusCatalog): void {
    this.statusCatalog = statusCatalog;
  }

  async initialize(): Promise<void> {
    if (this.initialized || this.destroyed) return;
    this.initialization ??= this.performInitialization();
    await this.initialization;
  }

  isReady(): boolean {
    return this.initialized;
  }

  private async performInitialization(): Promise<void> {
    this.registerEvents();
    const files = [...this.app.vault.getMarkdownFiles()]
      .map((file) => ({ file, path: file.path }))
      .sort((left, right) => left.path.localeCompare(right.path));
    const chunkSize = 50;
    for (let index = 0; index < files.length; index += chunkSize) {
      await Promise.all(
        files
          .slice(index, index + chunkSize)
          .map(({ file, path }) => this.loadFile(file, path, false)),
      );
      if (index + chunkSize < files.length) {
        await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
      }
    }
    await this.drainPendingReads();
    if (this.destroyed) return;
    this.initialized = true;
    this.publish({ type: 'initialized' });
    this.publishSettled({
      type: 'settled',
      reason: 'initialization',
      files: [...this.fileGenerations]
        .map(([path, generation]) => ({ path, generation }))
        .sort((left, right) => left.path.localeCompare(right.path)),
    });
  }

  list(query?: TaskQuery): readonly TaskSnapshot[] {
    let tasks: readonly TaskSnapshot[];
    if (
      query?.filePath &&
      query.folder === undefined &&
      query.tag === undefined &&
      query.statuses === undefined &&
      query.dateRange === undefined
    ) {
      tasks = this.taskMap.get(query.filePath) ?? [];
    } else {
      tasks = [...this.taskMap.values()].flat();
    }
    let filtered = tasks;
    if (query?.filePath)
      filtered = filtered.filter((task) => task.source.filePath === query.filePath);
    if (query?.folder)
      filtered = filtered.filter((task) => task.source.filePath.startsWith(query.folder!));
    if (query?.tag) filtered = filtered.filter((task) => task.tags.includes(query.tag!));
    if (query?.statuses?.length) {
      filtered = filtered.filter((task) => query.statuses!.includes(task.status));
    }
    if (query?.dateRange) {
      const { from, to } = query.dateRange;
      filtered = filtered.filter((task) => {
        const date = task.planning.due ?? task.planning.scheduled ?? task.planning.start;
        return date !== undefined && date >= from && date <= to;
      });
    }
    return [...filtered].sort(stableTaskOrder).map(cloneTaskSnapshot);
  }

  forCalendarProjection(dates: readonly LocalDate[]): CalendarProjectionSources {
    const seen = new Set<CalendarTaskSource>();
    for (const date of dates) {
      for (const source of this.calendarDateIndex.get(date)) seen.add(source);
    }
    const clonedRoots = new Map<TaskSnapshot, ClonedCalendarRoot>();
    const cloneSource = (source: CalendarTaskSource): CalendarTaskSource =>
      cloneCalendarTaskSource(source, clonedRoots);
    return {
      materialized: [...seen].sort(stableCalendarSourceOrder).map(cloneSource),
      recurringSources: [...this.recurringSourcesByFile.values()]
        .flat()
        .sort(stableCalendarSourceOrder)
        .map(cloneSource),
    };
  }

  resolve(ref: TaskRef): TaskResolution {
    const tasks = this.taskMap.get(ref.filePath) ?? [];
    const current = tasks.find((task) => task.source.line === ref.line);
    const expectedSource = this.locator.exactSource(ref.revision);
    const sourceMatches =
      expectedSource === undefined
        ? []
        : tasks.filter((task) => task.source.originalBlock === expectedSource);
    if (this.options.refAuthority && sourceMatches.length > 1) {
      return { type: 'ambiguous', candidates: sourceMatches.map(cloneCandidate) };
    }
    const matches = tasks.filter((task) => task.ref.revision === ref.revision);
    if (matches.length > 1) {
      return { type: 'ambiguous', candidates: matches.map(cloneCandidate) };
    }
    if (current?.ref.revision === ref.revision) {
      const task = cloneTaskSnapshot(current);
      return { type: 'exact', task, basis: { observed: cloneTaskSnapshot(task) } };
    }
    const fileTransition = this.reconciliationTransitions.get(ref.filePath);
    const transition = fileTransition?.writable.get(taskReconciliationKey(ref));
    if (transition) {
      return {
        type: 'rebased',
        previous: cloneTaskSnapshot(transition.previous),
        current: cloneTaskSnapshot(transition.current),
        evidence: transition.evidence,
        basis: {
          observed: cloneTaskSnapshot(transition.basis.observed),
          ...(transition.basis.previousRootAnchor && {
            previousRootAnchor: { ...transition.basis.previousRootAnchor },
          }),
          ...(transition.basis.nextRootAnchor && {
            nextRootAnchor: { ...transition.basis.nextRootAnchor },
          }),
          ...(transition.basis.authorityTransition && {
            authorityTransition: { ...transition.basis.authorityTransition },
          }),
        },
      };
    }
    if (!this.options.refAuthority && matches.length === 1) {
      const currentTask = cloneTaskSnapshot(matches[0]!);
      const observedTask = cloneTaskSnapshot(currentTask);
      const observed: TaskSnapshot = {
        ...observedTask,
        ref: { ...ref },
        source: { ...observedTask.source, line: ref.line },
      };
      return {
        type: 'rebased',
        previous: observed,
        current: currentTask,
        evidence: 'byte-identical-relocation',
        basis: { observed },
      };
    }
    if (sourceMatches.length > 1) {
      return { type: 'ambiguous', candidates: sourceMatches.map(cloneCandidate) };
    }
    const visual = fileTransition?.visual.get(taskReconciliationKey(ref));
    if (visual) {
      return {
        type: 'visual',
        stale: { ...ref },
        current: cloneTaskSnapshot(visual.current),
        evidence: visual.evidence,
      };
    }
    if (current) {
      return {
        type: 'visual',
        stale: { ...ref },
        current: cloneTaskSnapshot(current),
        evidence: 'same-line',
      };
    }
    if (sourceMatches.length === 1 || tasks.length > 0) {
      return { type: 'uncertain', ref: { ...ref } };
    }
    return { type: 'not-found', ref: { ...ref } };
  }

  subscribe(listener: Listener): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((candidate) => candidate !== listener);
    };
  }

  subscribeSettled(listener: (event: TaskIndexSettledEvent) => void): () => void {
    this.settledListeners.push(listener);
    return () => {
      this.settledListeners = this.settledListeners.filter((candidate) => candidate !== listener);
    };
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const ref of this.metadataCacheRefs) this.app.metadataCache.offref(ref);
    for (const ref of this.vaultRefs) this.app.vault.offref(ref);
    this.metadataCacheRefs = [];
    this.vaultRefs = [];
    this.listeners = [];
    this.settledListeners = [];
    this.pendingFiles.clear();
    this.pendingSettledFiles.clear();
    this.fileLifecycles = new WeakMap();
    this.pendingReads.clear();
    this.taskMap.clear();
    this.fileGenerations.clear();
    this.reconciliationTransitions.clear();
    this.options.refAuthority?.clear();
    this.calendarDateIndex.clear();
    this.recurringSourcesByFile.clear();
  }

  private async loadFile(
    file: TFile,
    path: string,
    forceContentFallback: boolean,
    observedFile = false,
  ): Promise<boolean> {
    const observation = this.observe(file, path);
    if (!observation) return false;
    const cache = this.app.metadataCache.getFileCache(file);
    if (!forceContentFallback && !cache?.listItems?.some((item) => item.task !== undefined)) {
      try {
        if (this.options.refAuthority) {
          const content = await this.app.vault.cachedRead(file);
          if (!this.isCurrent(observation)) return false;
          this.options.refAuthority.observe(path, content);
        }
      } catch {
        // The empty replacement still wins for the observed lifecycle generation.
      }
      if (!this.isCurrent(observation)) return false;
      this.replaceFile(path, [], [], true);
      return true;
    }
    try {
      const content = await this.app.vault.cachedRead(file);
      if (!this.isCurrent(observation)) return false;
      this.replaceFile(
        path,
        this.parseFile(
          path,
          content,
          forceContentFallback ? cacheWithContentFallback(content, cache) : cache!,
          true,
          undefined,
          observedFile,
        ),
        [],
        true,
      );
      return true;
    } catch {
      if (!this.isCurrent(observation)) return false;
      this.replaceFile(path, [], [], true);
      return true;
    }
  }

  private parseFile(
    filePath: string,
    content: string,
    cache: CachedMetadata,
    allocateSuccessor = false,
    captureAuthorityTransitions?: (transitions: readonly ProvenRootRevisionOverride[]) => void,
    observedFile = false,
  ): readonly TaskSnapshot[] {
    const authorityObservation = this.options.refAuthority?.observeTransition(filePath, content);
    const overrides = authorityObservation?.roots ?? [];
    if (authorityObservation) {
      captureAuthorityTransitions?.(
        overrides.map((override) => ({
          ...override,
          previousRevision: authorityObservation.expectedRevision,
        })),
      );
    }
    if (!cache.listItems) return [];
    // Preserve the legacy raw-line shape (`\r` stays attached under CRLF) for compatibility
    // consumers while TaskBlockEditor independently owns exact block revision bytes.
    const lines = content.split('\n');
    const blockByLine = new Map(
      this.blockEditor.rootBlocks(content).map((block) => [block.line, block] as const),
    );
    const sourceCounts = new Map<string, number>();
    for (const block of blockByLine.values()) {
      sourceCounts.set(block.source, (sourceCounts.get(block.source) ?? 0) + 1);
    }
    const overrideByLine = new Map(overrides.map((override) => [override.line, override] as const));
    const priorByLine = new Map(
      (this.taskMap.get(filePath) ?? []).map((task) => [task.source.line, task] as const),
    );
    const priorBySource = new Map<string, TaskSnapshot[]>();
    for (const task of this.taskMap.get(filePath) ?? []) {
      const matches = priorBySource.get(task.source.originalBlock) ?? [];
      matches.push(task);
      priorBySource.set(task.source.originalBlock, matches);
    }
    const dailyNoteDate = dailyNoteDateForPath(filePath, this.options.dailyNoteFormat);
    const codec = new TaskMarkdownCodec(this.statusCatalog);
    const frontmatter = cache.frontmatter;
    const noteColor = typeof frontmatter?.['color'] === 'string' ? frontmatter['color'] : undefined;
    const noteTextColor =
      typeof frontmatter?.['textColor'] === 'string' ? frontmatter['textColor'] : undefined;
    const noteIcon = typeof frontmatter?.['icon'] === 'string' ? frontmatter['icon'] : undefined;
    const itemByLine = new Map<number, (typeof cache.listItems)[number]>();
    for (const item of cache.listItems) itemByLine.set(item.position.start.line, item);
    const hasTaskAncestor = (item: (typeof cache.listItems)[number]): boolean => {
      let parentLine = item.parent;
      const seen = new Set<number>();
      while (parentLine >= 0 && !seen.has(parentLine)) {
        if (parentLine === item.position.start.line) break;
        seen.add(parentLine);
        const parent = itemByLine.get(parentLine);
        if (!parent) break;
        if (parent.task !== undefined) return true;
        parentLine = parent.parent;
      }
      return false;
    };

    const snapshots: TaskSnapshot[] = [];
    for (const item of cache.listItems) {
      if (item.task === undefined || hasTaskAncestor(item)) continue;
      const line = item.position.start.line;
      const originalMarkdown = lines[line] ?? '';
      const parsed = codec.parseLine(originalMarkdown, { filePath, line });
      if (!parsed) continue;
      const exactBlock = blockByLine.get(line)?.source ?? originalMarkdown;
      const ref: TaskRef = {
        filePath,
        line,
        revision: this.reconciledRevision(
          line,
          exactBlock,
          sourceCounts.get(exactBlock) ?? 1,
          overrideByLine,
          priorByLine,
          priorBySource,
          sourceCounts,
          allocateSuccessor,
          observedFile,
        ),
      };
      const presentation = {
        linkCount: 0,
        ...(dailyNoteDate && { dailyNoteDate }),
        ...(noteColor && { noteColor }),
        ...(noteTextColor && { noteTextColor }),
        ...(noteIcon && { noteIcon }),
      };
      const snapshot = projectTaskSnapshot({
        codec,
        statusCatalog: this.statusCatalog,
        filePath,
        lines,
        line,
        exactBlock,
        ref,
        presentation,
      });
      if (snapshot) snapshots.push(snapshot);
    }
    return snapshots.sort(stableTaskOrder);
  }

  /** Pure infrastructure collaborator used by the repository for immediate command outcomes. */
  snapshotsFromContent(filePath: string, content: string): readonly TaskSnapshot[] {
    return this.previewContent(filePath, content);
  }

  currentRoot(filePath: string, line: number, source: string): TaskRef | undefined {
    const tasks = this.taskMap.get(filePath) ?? [];
    const sourceMatches = tasks.filter((task) => task.source.originalBlock === source);
    if (sourceMatches.length > 1) return undefined;
    const hinted = tasks.find((task) => task.source.line === line);
    const current = hinted?.source.originalBlock === source ? hinted : (sourceMatches[0] ?? hinted);
    return current ? { ...current.ref } : undefined;
  }

  authoritySuccessor(consumed: TaskRef): TaskRef | undefined {
    const transition = this.reconciliationTransitions
      .get(consumed.filePath)
      ?.writable.get(taskReconciliationKey(consumed));
    return transition?.evidence === 'authority-transition'
      ? { ...transition.current.ref }
      : undefined;
  }

  previewContent(filePath: string, content: string): readonly TaskSnapshot[] {
    const cache = cacheWithContentFallback(content, null);
    const frontmatter = frontmatterFromContent(content);
    return this.parseFile(filePath, content, {
      ...cache,
      ...(frontmatter && { frontmatter }),
    });
  }

  /** Installs authoritative content after an atomic repository transition. */
  installCommittedContent(filePath: string, content: string): readonly TaskSnapshot[] {
    const cache = cacheWithContentFallback(content, null);
    const frontmatter = frontmatterFromContent(content);
    let authorityTransitions: readonly ProvenRootRevisionOverride[] = [];
    const tasks = this.parseFile(
      filePath,
      content,
      { ...cache, ...(frontmatter && { frontmatter }) },
      true,
      (transitions) => {
        authorityTransitions = transitions;
      },
      this.fileGenerations.has(filePath),
    );
    if (this.replaceFile(filePath, tasks, authorityTransitions)) this.queueChanged(filePath);
    this.queueSettled(filePath);
    return tasks.map(cloneTaskSnapshot);
  }

  private reconciledRevision(
    line: number,
    source: string,
    sourceCount: number,
    overrides: ReadonlyMap<number, RootRevisionOverride>,
    priorByLine: ReadonlyMap<number, TaskSnapshot>,
    priorBySource: ReadonlyMap<string, readonly TaskSnapshot[]>,
    currentSourceCounts: ReadonlyMap<string, number>,
    allocateSuccessor: boolean,
    observedFile: boolean,
  ): string {
    const override = overrides.get(line);
    if (override?.source === source) return override.revision;
    if (this.options.refAuthority) {
      const hinted = priorByLine.get(line);
      const prior = priorBySource.get(source) ?? [];
      if (hinted?.source.originalBlock === source && sourceCount === 1 && prior.length === 1) {
        return hinted.ref.revision;
      }
      if (sourceCount === 1 && prior.length === 1) return prior[0]!.ref.revision;
      const hintedRelocated =
        hinted !== undefined &&
        (currentSourceCounts.get(hinted.source.originalBlock) ?? 0) === 1 &&
        (priorBySource.get(hinted.source.originalBlock)?.length ?? 0) === 1;
      if (hinted && !hintedRelocated && allocateSuccessor) {
        return (
          this.options.refAuthority.successor(hinted.ref.revision, source) ??
          this.locator.revision(source)
        );
      }
      if (observedFile && allocateSuccessor) {
        return this.options.refAuthority.mintRevision(source);
      }
    }
    return this.locator.revision(source);
  }

  private replaceFile(
    filePath: string,
    tasks: readonly TaskSnapshot[],
    authorityTransitions: readonly ProvenRootRevisionOverride[] = [],
    advanceGenerationOnUnchanged = false,
  ): boolean {
    const current = this.taskMap.get(filePath) ?? [];
    const changed = JSON.stringify(current) !== JSON.stringify(tasks);
    if (!changed && !advanceGenerationOnUnchanged) return false;
    // A repository install and Obsidian's matching metadata event can arrive in either order
    // before the already-queued notification is delivered. Keep that batch's proven transition
    // visible to subscribers instead of replacing it with an unchanged self-transition.
    const queuedTransition = this.reconciliationTransitions.get(filePath);
    if (
      !changed &&
      this.pendingFiles.has(filePath) &&
      [...(queuedTransition?.writable.values() ?? [])].some(
        (transition) => transition.evidence === 'authority-transition',
      )
    ) {
      return false;
    }
    const fromGeneration = this.fileGenerations.get(filePath) ?? 0;
    const toGeneration = fromGeneration + 1;
    this.fileGenerations.set(filePath, toGeneration);
    const transitions = reconcileRootTransitions(current, tasks, authorityTransitions);
    this.reconciliationTransitions.set(filePath, {
      fromGeneration,
      toGeneration,
      writable: transitions.writable,
      visual: transitions.visual,
    });
    if (!changed) return false;
    if (tasks.length > 0) this.taskMap.set(filePath, tasks);
    else this.taskMap.delete(filePath);
    const sources = calendarSources(tasks);
    this.calendarDateIndex.updateFile(filePath, sources);
    const recurringSources = sources.filter(
      ({ node }) =>
        node.recurrence !== undefined && (node.status === 'open' || node.status === 'in-progress'),
    );
    if (recurringSources.length > 0) this.recurringSourcesByFile.set(filePath, recurringSources);
    else this.recurringSourcesByFile.delete(filePath);
    return true;
  }

  private registerEvents(): void {
    this.metadataCacheRefs.push(
      this.app.metadataCache.on('changed', (file: TFile, data: string, cache: CachedMetadata) => {
        const path = file.path;
        if (
          file.extension !== 'md' ||
          this.destroyed ||
          this.app.vault.getAbstractFileByPath(path) !== file
        ) {
          return;
        }
        this.advance(file, path);
        let authorityTransitions: readonly ProvenRootRevisionOverride[] = [];
        const observedFile = this.fileGenerations.has(path);
        const tasks = this.parseFile(
          path,
          data,
          cacheWithContentFallback(data, cache),
          true,
          (transitions) => {
            authorityTransitions = transitions;
          },
          observedFile,
        );
        const changed = this.replaceFile(path, tasks, authorityTransitions, true);
        if (changed) this.queueChanged(path);
        this.queueSettled(path);
      }),
    );
    this.vaultRefs.push(
      this.app.vault.on('create', (file: TAbstractFile) => {
        if (!(file instanceof TFile) || file.extension !== 'md' || this.destroyed) return;
        const path = file.path;
        if (this.app.vault.getAbstractFileByPath(path) !== file) return;
        this.advance(file, path);
        const read = this.loadFile(file, path, true, true).then((committed) => {
          if (committed) {
            this.queueChanged(path);
            this.queueSettled(path);
          }
        });
        this.trackRead(read);
      }),
      this.app.vault.on('rename', (file: TAbstractFile, oldPath: string) => {
        if (file instanceof TFolder && !this.destroyed) {
          this.handleFolderRename(file, oldPath);
          return;
        }
        if (!(file instanceof TFile) || this.destroyed) return;
        const newPath = file.path;
        const wasMarkdown = extensionOf(oldPath) === 'md';
        const isMarkdown = file.extension === 'md';
        if (
          (!wasMarkdown && !isMarkdown) ||
          this.app.vault.getAbstractFileByPath(newPath) !== file
        ) {
          return;
        }
        const tasks = this.taskMap.get(oldPath) ?? [];
        const oldGeneration = (this.fileGenerations.get(oldPath) ?? 0) + 1;
        this.advance(file, isMarkdown ? newPath : undefined);
        this.removeFile(oldPath);
        if (newPath !== oldPath) this.removeFile(newPath);

        if (wasMarkdown && isMarkdown) {
          if (tasks.length > 0) {
            const dailyNoteDate = dailyNoteDateForPath(newPath, this.options.dailyNoteFormat);
            this.replaceFile(
              newPath,
              tasks.map((task) => {
                const relocated = relocateSnapshot(task, newPath, dailyNoteDate);
                const revision = this.options.refAuthority?.mintRevision(
                  relocated.source.originalBlock,
                );
                return revision
                  ? relocateSnapshot(
                      { ...relocated, ref: { ...relocated.ref, revision } },
                      newPath,
                      dailyNoteDate,
                    )
                  : relocated;
              }),
            );
            this.publish({ type: 'renamed', oldPath, newPath });
            this.queueSettled(oldPath, oldGeneration);
            this.queueSettled(newPath);
          } else {
            const read = this.loadFile(file, newPath, true).then((committed) => {
              if (committed || this.isFileAt(file, newPath)) {
                this.publish({ type: 'renamed', oldPath, newPath });
                this.queueSettled(oldPath, oldGeneration);
                this.queueSettled(newPath);
              }
            });
            this.trackRead(read);
          }
          return;
        }

        if (wasMarkdown) {
          this.publish({ type: 'renamed', oldPath, newPath });
          this.queueSettled(oldPath, oldGeneration);
          return;
        }

        const read = this.loadFile(file, newPath, true).then((committed) => {
          if (committed || this.isFileAt(file, newPath)) {
            this.publish({ type: 'renamed', oldPath, newPath });
            this.queueSettled(newPath);
          }
        });
        this.trackRead(read);
      }),
      this.app.vault.on('delete', (file: TAbstractFile) => {
        if (!(file instanceof TFile) || file.extension !== 'md' || this.destroyed) return;
        const path = file.path;
        const existed = this.taskMap.has(path);
        const generation = (this.fileGenerations.get(path) ?? 0) + 1;
        this.advance(file, undefined);
        this.removeFile(path);
        if (existed) this.publish({ type: 'deleted', path });
        this.queueSettled(path, generation);
      }),
    );
  }

  private removeFile(filePath: string): void {
    this.taskMap.delete(filePath);
    this.calendarDateIndex.updateFile(filePath, []);
    this.recurringSourcesByFile.delete(filePath);
    this.fileGenerations.delete(filePath);
    this.reconciliationTransitions.delete(filePath);
    this.pendingFiles.delete(filePath);
    this.options.refAuthority?.discard(filePath);
  }

  private handleFolderRename(folder: TFolder, oldPath: string): void {
    const newPath = folder.path;
    const oldFiles = [...this.fileGenerations]
      .filter(([path]) => isDescendant(path, oldPath))
      .map(([path, generation]) => ({ path, generation: generation + 1 }));
    const oldTaskPaths = [...this.taskMap.keys()].filter((path) => isDescendant(path, oldPath));
    const newFiles = this.app.vault
      .getMarkdownFiles()
      .filter((file) => isDescendant(file.path, newPath))
      .sort((left, right) => left.path.localeCompare(right.path));

    for (const { path } of oldFiles) this.removeFile(path);
    const read = Promise.all(
      newFiles.map(async (file) => {
        const path = file.path;
        this.advance(file, path);
        const committed = await this.loadFile(file, path, true, true);
        return { path, committed };
      }),
    ).then((results) => {
      if (this.destroyed) return;
      const newTaskPaths = results
        .filter(({ path, committed }) => committed && this.taskMap.has(path))
        .map(({ path }) => path);
      const changedPaths = [...new Set([...oldTaskPaths, ...newTaskPaths])].sort((left, right) =>
        left.localeCompare(right),
      );
      if (changedPaths.length > 0) this.publish({ type: 'changed', files: changedPaths });
      const files = [
        ...oldFiles,
        ...results
          .filter(({ committed }) => committed)
          .map(({ path }) => ({ path, generation: this.fileGenerations.get(path) ?? 1 })),
      ].sort((left, right) => left.path.localeCompare(right.path));
      this.publishSettled({
        type: 'settled',
        reason: 'topology',
        topology: { type: 'folder-rename', oldPath, newPath },
        files,
      });
    });
    this.trackRead(read);
  }

  private observe(file: TFile, path: string): FileObservation | undefined {
    if (this.destroyed || this.app.vault.getAbstractFileByPath(path) !== file) return undefined;
    const existing = this.fileLifecycles.get(file);
    if (existing && existing.path !== path) return undefined;
    const lifecycle = existing ?? { path, generation: 0 };
    if (!existing) this.fileLifecycles.set(file, lifecycle);
    return { file, path, generation: lifecycle.generation };
  }

  private advance(file: TFile, path: string | undefined): void {
    const lifecycle = this.fileLifecycles.get(file);
    this.fileLifecycles.set(file, {
      path,
      generation: (lifecycle?.generation ?? 0) + 1,
    });
  }

  private isCurrent(observation: FileObservation): boolean {
    const lifecycle = this.fileLifecycles.get(observation.file);
    return (
      !this.destroyed &&
      lifecycle?.path === observation.path &&
      lifecycle.generation === observation.generation &&
      observation.file.extension === 'md' &&
      this.app.vault.getAbstractFileByPath(observation.path) === observation.file
    );
  }

  private isFileAt(file: TFile, path: string): boolean {
    const lifecycle = this.fileLifecycles.get(file);
    return (
      !this.destroyed &&
      lifecycle?.path === path &&
      file.extension === 'md' &&
      this.app.vault.getAbstractFileByPath(path) === file
    );
  }

  private trackRead(read: Promise<void>): void {
    this.pendingReads.add(read);
    void read.finally(() => this.pendingReads.delete(read));
  }

  private async drainPendingReads(): Promise<void> {
    while (!this.destroyed && this.pendingReads.size > 0) {
      await Promise.all([...this.pendingReads]);
    }
  }

  private queueChanged(filePath: string): void {
    if (this.destroyed || !this.initialized) return;
    this.pendingFiles.add(filePath);
    this.schedulePublishedBatch();
  }

  private queueSettled(
    filePath: string,
    generation?: number,
    reason: 'index' | 'initialization' = 'index',
  ): void {
    if (this.destroyed || !this.initialized) return;
    this.pendingSettledFiles.set(filePath, {
      generation: generation ?? this.fileGenerations.get(filePath) ?? 1,
      reason,
    });
    this.schedulePublishedBatch();
  }

  private schedulePublishedBatch(): void {
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    void Promise.resolve().then(() => {
      this.flushScheduled = false;
      if (this.destroyed) return;
      if (this.pendingFiles.size > 0) {
        const files = [...this.pendingFiles].sort((left, right) => left.localeCompare(right));
        this.pendingFiles.clear();
        this.publish({ type: 'changed', files });
      }
      if (this.pendingSettledFiles.size > 0) {
        const pending = [...this.pendingSettledFiles];
        this.pendingSettledFiles.clear();
        for (const reason of ['initialization', 'index'] as const) {
          const files = pending
            .filter(([, value]) => value.reason === reason)
            .map(([path, value]) => ({ path, generation: value.generation }))
            .sort((left, right) => left.path.localeCompare(right.path));
          if (files.length > 0) this.publishSettled({ type: 'settled', reason, files });
        }
      }
    });
  }

  private publishSettled(event: TaskIndexSettledEvent): void {
    if (this.destroyed || !this.initialized) return;
    const detached = immutableEvent(event) as TaskIndexSettledEvent;
    for (const listener of [...this.settledListeners]) listener(detached);
  }

  private publish(event: TaskIndexEvent): void {
    if (this.destroyed || (!this.initialized && event.type !== 'initialized')) return;
    const detached = immutableEvent(event);
    for (const listener of [...this.listeners]) listener(detached);
  }
}
