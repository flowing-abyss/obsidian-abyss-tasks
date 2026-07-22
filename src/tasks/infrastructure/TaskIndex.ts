import {
  parseYaml,
  TFile,
  type App,
  type CachedMetadata,
  type EventRef,
  type TAbstractFile,
} from 'obsidian';
import type {
  TaskIndexEvent,
  TaskQuery,
  TaskQueryApi,
  TaskResolution,
} from '../application/TaskApplicationApi';
import { cloneTaskSnapshot } from '../domain/cloneTaskSnapshot';
import type { TaskResolutionCandidate } from '../domain/commands';
import type { StatusCatalog } from '../domain/StatusCatalog';
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

export interface TaskIndexOptions {
  readonly statusCatalog: StatusCatalog;
  readonly dailyNoteFormat: string;
  readonly globalTaskFilter?: string;
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

export class TaskIndex implements TaskQueryApi {
  private readonly taskMap = new Map<string, readonly TaskSnapshot[]>();
  private readonly dateIndex = new TaskDateIndex<TaskSnapshot>(
    (task) => calendarDatesForPlanning(task.planning),
    (task) => calendarRangeForPlanning(task.planning),
  );
  private listeners: Listener[] = [];
  private readonly pendingFiles = new Set<string>();
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
  private readonly locator = new TaskLocator();

  constructor(
    private readonly app: App,
    private readonly options: TaskIndexOptions,
  ) {
    this.statusCatalog = options.statusCatalog;
  }

  setStatusCatalog(statusCatalog: StatusCatalog): void {
    this.statusCatalog = statusCatalog;
  }

  async initialize(): Promise<void> {
    if (this.initialized || this.destroyed) return;
    this.initialization ??= this.performInitialization();
    await this.initialization;
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
        const date =
          task.planning.due ??
          task.planning.scheduled ??
          task.planning.start ??
          task.presentation.dailyNoteDate;
        return date !== undefined && date >= from && date <= to;
      });
    }
    return [...filtered].sort(stableTaskOrder).map(cloneTaskSnapshot);
  }

  forCalendarDates(dates: readonly LocalDate[]): readonly TaskSnapshot[] {
    const seen = new Set<TaskSnapshot>();
    for (const date of dates) {
      for (const task of this.dateIndex.get(date)) seen.add(task);
    }
    return [...seen].sort(stableTaskOrder).map(cloneTaskSnapshot);
  }

  resolve(ref: TaskRef): TaskResolution {
    const tasks = this.taskMap.get(ref.filePath) ?? [];
    const current = tasks.find((task) => task.source.line === ref.line);
    const matches = tasks.filter((task) => task.ref.revision === ref.revision);
    if (matches.length > 1) {
      return { type: 'ambiguous', candidates: matches.map(cloneCandidate) };
    }
    if (current?.ref.revision === ref.revision) {
      return { type: 'exact', task: cloneTaskSnapshot(current) };
    }
    if (matches.length === 1) return { type: 'exact', task: cloneTaskSnapshot(matches[0]!) };
    if (current) return { type: 'conflict', current: cloneTaskSnapshot(current) };
    return { type: 'not-found', ref: { ...ref } };
  }

  subscribe(listener: Listener): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((candidate) => candidate !== listener);
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
    this.pendingFiles.clear();
    this.fileLifecycles = new WeakMap();
    this.pendingReads.clear();
    this.taskMap.clear();
    this.dateIndex.clear();
  }

  private async loadFile(
    file: TFile,
    path: string,
    forceContentFallback: boolean,
  ): Promise<boolean> {
    const observation = this.observe(file, path);
    if (!observation) return false;
    const cache = this.app.metadataCache.getFileCache(file);
    if (!forceContentFallback && !cache?.listItems?.some((item) => item.task !== undefined)) {
      if (!this.isCurrent(observation)) return false;
      this.replaceFile(path, []);
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
        ),
      );
      return true;
    } catch {
      if (!this.isCurrent(observation)) return false;
      this.replaceFile(path, []);
      return true;
    }
  }

  private parseFile(
    filePath: string,
    content: string,
    cache: CachedMetadata,
  ): readonly TaskSnapshot[] {
    if (!cache.listItems) return [];
    // Preserve the legacy raw-line shape (`\r` stays attached under CRLF) for compatibility
    // consumers while TaskBlockEditor independently owns exact block revision bytes.
    const lines = content.split('\n');
    const blockByLine = new Map(
      this.blockEditor.rootBlocks(content).map((block) => [block.line, block] as const),
    );
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
      const ref: TaskRef = { filePath, line, revision: this.locator.revision(exactBlock) };
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
    const cache = cacheWithContentFallback(content, null);
    const frontmatter = frontmatterFromContent(content);
    return this.parseFile(filePath, content, {
      ...cache,
      ...(frontmatter && { frontmatter }),
    });
  }

  private replaceFile(filePath: string, tasks: readonly TaskSnapshot[]): void {
    if (tasks.length > 0) this.taskMap.set(filePath, tasks);
    else this.taskMap.delete(filePath);
    this.dateIndex.updateFile(filePath, tasks);
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
        this.replaceFile(path, this.parseFile(path, data, cacheWithContentFallback(data, cache)));
        this.queueChanged(path);
      }),
    );
    this.vaultRefs.push(
      this.app.vault.on('create', (file: TAbstractFile) => {
        if (!(file instanceof TFile) || file.extension !== 'md' || this.destroyed) return;
        const path = file.path;
        if (this.app.vault.getAbstractFileByPath(path) !== file) return;
        this.advance(file, path);
        const read = this.loadFile(file, path, true).then((committed) => {
          if (committed) this.queueChanged(path);
        });
        this.trackRead(read);
      }),
      this.app.vault.on('rename', (file: TAbstractFile, oldPath: string) => {
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
        this.advance(file, isMarkdown ? newPath : undefined);
        this.replaceFile(oldPath, []);
        if (newPath !== oldPath) this.replaceFile(newPath, []);
        this.pendingFiles.delete(oldPath);
        this.pendingFiles.delete(newPath);

        if (wasMarkdown && isMarkdown) {
          if (tasks.length > 0) {
            const dailyNoteDate = dailyNoteDateForPath(newPath, this.options.dailyNoteFormat);
            this.replaceFile(
              newPath,
              tasks.map((task) => relocateSnapshot(task, newPath, dailyNoteDate)),
            );
            this.publish({ type: 'renamed', oldPath, newPath });
          } else {
            const read = this.loadFile(file, newPath, true).then((committed) => {
              if (committed || this.isFileAt(file, newPath)) {
                this.publish({ type: 'renamed', oldPath, newPath });
              }
            });
            this.trackRead(read);
          }
          return;
        }

        if (wasMarkdown) {
          this.publish({ type: 'renamed', oldPath, newPath });
          return;
        }

        const read = this.loadFile(file, newPath, true).then((committed) => {
          if (committed || this.isFileAt(file, newPath)) {
            this.publish({ type: 'renamed', oldPath, newPath });
          }
        });
        this.trackRead(read);
      }),
      this.app.vault.on('delete', (file: TAbstractFile) => {
        if (!(file instanceof TFile) || file.extension !== 'md' || this.destroyed) return;
        const path = file.path;
        const existed = this.taskMap.has(path);
        this.advance(file, undefined);
        this.replaceFile(path, []);
        this.pendingFiles.delete(path);
        if (existed) this.publish({ type: 'deleted', path });
      }),
    );
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
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    void Promise.resolve().then(() => {
      this.flushScheduled = false;
      if (this.destroyed || this.pendingFiles.size === 0) return;
      const files = [...this.pendingFiles].sort((left, right) => left.localeCompare(right));
      this.pendingFiles.clear();
      this.publish({ type: 'changed', files });
    });
  }

  private publish(event: TaskIndexEvent): void {
    if (this.destroyed || (!this.initialized && event.type !== 'initialized')) return;
    const detached = immutableEvent(event);
    for (const listener of [...this.listeners]) listener(detached);
  }
}
