import { moment, App as ObsidianApp, Platform, type CachedMetadata, type TFile } from 'obsidian';
import { afterEach, beforeEach, expect, vi } from 'vitest';
import type { AppState } from '../src/app/AppState';
import { CenterPanel } from '../src/panels/CenterPanel';
import { LeftPanel } from '../src/panels/LeftPanel';
import type { ProjectManager } from '../src/projects/ProjectManager';
import type { ProjectStore } from '../src/projects/ProjectStore';
import { DailyNoteResolver } from '../src/resolvers/DailyNoteResolver';
import { buildDefaultTaskStatuses, DEFAULT_VIEW_CONFIG } from '../src/settings/defaults';
import { toStatusRules } from '../src/settings/statusCatalogAdapter';
import type { CalendarSettings, ResolvedConfig } from '../src/settings/types';
import { StatusRegistry } from '../src/status/StatusRegistry';
import type { TagManager } from '../src/tags/TagManager';
import type {
  SubtaskSnapshot,
  TaskApplicationApi,
  TaskCommentSnapshot,
  TaskIndexEvent,
  TaskNodeRef,
  TaskQueryApi,
  TaskSnapshot,
} from '../src/tasks';
import { TaskApplicationService } from '../src/tasks/application/TaskApplicationService';
import { systemClock } from '../src/tasks/domain/clock';
import type { CommentTimestamp } from '../src/tasks/domain/commentTimestamp';
import { StatusCatalog } from '../src/tasks/domain/StatusCatalog';
import { localDate } from '../src/tasks/domain/validation';
import { TaskBlockEditor } from '../src/tasks/infrastructure/markdown/TaskBlockEditor';
import { TaskLocator } from '../src/tasks/infrastructure/markdown/TaskLocator';
import { TaskMarkdownCodec } from '../src/tasks/infrastructure/markdown/TaskMarkdownCodec';
import { ObsidianTaskDestinationProvider } from '../src/tasks/infrastructure/obsidian/ObsidianTaskDestinationProvider';
import { ObsidianTaskRepository } from '../src/tasks/infrastructure/obsidian/ObsidianTaskRepository';
import { TaskIndex } from '../src/tasks/infrastructure/TaskIndex';
import { TaskRefAuthority } from '../src/tasks/infrastructure/TaskRefAuthority';

export async function loadPluginStyles(): Promise<string> {
  if (!Platform.isDesktop) return '';
  const { readFileSync } = await import('node:fs');
  const path = await import('node:path');
  return readFileSync(path.resolve(import.meta.dirname, '..', 'styles.css'), 'utf8');
}

/**
 * Narrow a value that a test fixture or DOM query requires to exist.
 *
 * Unlike a non-null assertion, this keeps the test's precondition observable: a missing fixture
 * fails at the point where it is first consumed instead of producing a later, unrelated error.
 */
export function expectDefined<T>(
  value: T | null | undefined,
  message = 'Expected test value to be defined',
): T {
  if (value === null || value === undefined) {
    throw new Error(message);
  }
  return value;
}

/** Read a method as a value in tests that intentionally inspect, replace, or pass it around. */
export function methodOf<T extends object, K extends keyof T>(object: T, key: K): T[K] {
  return object[key];
}

export function objectMatching<T extends object>(expected: Partial<T>): T {
  return expect.objectContaining(expected as never) as T;
}

export function parseJson<T>(source: string): T {
  return JSON.parse(source) as T;
}

export interface CssRuleParts {
  readonly selector: string;
  readonly declarations: string;
}

export function cssRuleParts(source: string): readonly CssRuleParts[] {
  const rules: CssRuleParts[] = [];
  for (const segment of stripCssComments(source).split('}')) {
    const openingBrace = segment.lastIndexOf('{');
    if (openingBrace < 0) continue;
    rules.push({
      selector: segment.slice(0, openingBrace).trim(),
      declarations: segment.slice(openingBrace + 1),
    });
  }
  return rules;
}

export function cssSelectorList(selectorList: string): readonly string[] {
  const selectors: string[] = [];
  let start = 0;
  let parenthesisDepth = 0;
  for (let index = 0; index < selectorList.length; index += 1) {
    const character = selectorList[index];
    if (character === '(') parenthesisDepth += 1;
    if (character === ')') parenthesisDepth = Math.max(0, parenthesisDepth - 1);
    if (character !== ',' || parenthesisDepth !== 0) continue;
    selectors.push(selectorList.slice(start, index).trim());
    start = index + 1;
  }
  selectors.push(selectorList.slice(start).trim());
  return selectors;
}

export function cssDeclarationsFor(source: string, selector: string): string {
  const declarations: string[] = [];
  for (const rule of cssRuleParts(source)) {
    if (rule.selector === selector || cssSelectorList(rule.selector).includes(selector)) {
      declarations.push(rule.declarations);
    }
  }
  return declarations.join('\n');
}

export function stripCssComments(source: string): string {
  let result = '';
  let cursor = 0;
  while (cursor < source.length) {
    const opening = source.indexOf('/*', cursor);
    if (opening < 0) return result + source.slice(cursor);
    result += source.slice(cursor, opening);
    const closing = source.indexOf('*/', opening + 2);
    if (closing < 0) return result;
    cursor = closing + 2;
  }
  return result;
}

export function cssDeclarationValue(declarations: string, property: string): string | undefined {
  for (const declaration of declarations.split(';')) {
    const colon = declaration.indexOf(':');
    if (colon < 0 || declaration.slice(0, colon).trim() !== property) continue;
    return declaration.slice(colon + 1).trim();
  }
  return undefined;
}

export function queryApiForTasks(
  getTasks: () => readonly TaskSnapshot[],
  onSubscribe?: (listener: (event: TaskIndexEvent) => void) => () => void,
): TaskQueryApi {
  return taskQueryApi({
    list: (query) =>
      getTasks()
        .filter((task) => query?.filePath === undefined || task.source.filePath === query.filePath)
        .filter(
          (task) => query?.folder === undefined || task.source.filePath.startsWith(query.folder),
        )
        .filter((task) => query?.tag === undefined || task.tags.includes(query.tag))
        .filter((task) => query?.statuses === undefined || query.statuses.includes(task.status))
        .filter((task) => {
          if (query?.dateRange == null) return true;
          const date =
            task.planning.due ??
            task.planning.scheduled ??
            task.planning.start ??
            task.presentation.dailyNoteDate;
          return date !== undefined && date >= query.dateRange.from && date <= query.dateRange.to;
        }),
    forCalendarProjection: (dates) => {
      const wanted = new Set<string>(dates);
      const sources = getTasks().map((root) => ({
        root,
        target: { type: 'task' as const, ref: root.ref },
        node: root,
      }));
      return {
        materialized: sources.filter(({ node }) => {
          const { start, scheduled, due } = node.planning;
          if (start != null && due != null)
            return dates.some((date) => date >= start && date <= due);
          return [scheduled, due, rootDailyNoteDate(node)].some(
            (date) => date !== undefined && wanted.has(date),
          );
        }),
        recurringSources: sources.filter(
          ({ node }) =>
            node.recurrence !== undefined &&
            (node.status === 'open' || node.status === 'in-progress'),
        ),
      };
    },
    resolve: (ref) => {
      const found = getTasks().find(
        (task) => task.ref.filePath === ref.filePath && task.ref.line === ref.line,
      );
      return found != null
        ? { type: 'exact', task: found, basis: { observed: found } }
        : { type: 'not-found', ref };
    },
    ...(onSubscribe === undefined ? {} : { subscribe: onSubscribe }),
  });
}

function rootDailyNoteDate(task: TaskSnapshot): TaskSnapshot['presentation']['dailyNoteDate'] {
  return task.presentation.dailyNoteDate;
}

export function taskQueryApi(overrides: Partial<TaskQueryApi> = {}): TaskQueryApi {
  return {
    list: () => [],
    forCalendarProjection: () => ({ materialized: [], recurringSources: [] }),
    resolve: (ref) => ({ type: 'not-found', ref: { ...ref } }),
    subscribe: () => () => {},
    ...overrides,
  };
}

export interface TestTaskHarness extends TaskApplicationApi {
  readonly taskQueries: TaskQueryApi;
  readonly statusRegistry: StatusRegistry;
  readonly toggleTask: ReturnType<typeof vi.fn>;
  readonly setPriority: ReturnType<typeof vi.fn>;
  readonly setTaskStatus: ReturnType<typeof vi.fn>;
}

type CenterPanelTestArgs = readonly [
  state: AppState,
  taskHarness: TestTaskHarness,
  app: ObsidianApp,
  settings: CalendarSettings,
  tagManager: TagManager,
  onSaveSettings?: () => Promise<void>,
  projectStore?: ProjectStore | null,
  projectManager?: ProjectManager | null,
  tasks?: TaskApplicationApi,
];

export function makeCenterPanelForTest(
  ...[
    state,
    taskHarness,
    app,
    settings,
    _tagManager,
    onSaveSettings = async () => {},
    projectStore = null,
    projectManager = null,
    tasks,
  ]: CenterPanelTestArgs
): CenterPanel {
  const application = tasks ?? taskHarness;
  return new CenterPanel(
    state,
    app,
    settings,
    taskHarness.queries,
    taskHarness.statusRegistry,
    onSaveSettings,
    projectStore,
    projectManager,
    application,
  );
}

type LeftPanelTestArgs = readonly [
  state: AppState,
  taskHarness: TestTaskHarness,
  settings: CalendarSettings,
  tagManager: TagManager,
  app: ObsidianApp,
  onSaveSettings?: () => Promise<void>,
  projectStore?: ProjectStore | null,
  projectManager?: ProjectManager | null,
  tasks?: TaskApplicationApi,
];

export function makeLeftPanelForTest(
  ...[
    state,
    taskHarness,
    settings,
    tagManager,
    app,
    onSaveSettings = async () => {},
    projectStore = null,
    projectManager = null,
    tasks,
  ]: LeftPanelTestArgs
): LeftPanel {
  const application = tasks ?? taskHarness;
  return new LeftPanel(
    state,
    settings,
    tagManager,
    app,
    taskHarness.queries,
    application,
    onSaveSettings,
    projectStore,
    projectManager,
  );
}

/** Canonical semantic status catalog for parser/codec compatibility tests. */
export function canonicalStatusCatalog(): StatusCatalog {
  return new StatusCatalog(toStatusRules(buildDefaultTaskStatuses()));
}

export function testStatusRegistry(): StatusRegistry {
  return new StatusRegistry(buildDefaultTaskStatuses());
}

/** Install real moment as window.moment for date-aware tests. Idempotent; restores in afterEach. */
export function useRealMoment(): void {
  let prev: unknown;
  beforeEach(() => {
    prev = (window as unknown as { moment?: unknown }).moment;
    (window as unknown as { moment?: unknown }).moment = moment;
  });
  afterEach(() => {
    (window as unknown as { moment?: unknown }).moment = prev;
  });
}

/** Toggle Platform.isMobile for a block; restores previous value in afterEach. */
export function withMobile(value: boolean): void {
  let prev: boolean;
  beforeEach(() => {
    prev = Platform.isMobile;
    (Platform as unknown as { isMobile: boolean }).isMobile = value;
  });
  afterEach(() => {
    (Platform as unknown as { isMobile: boolean }).isMobile = prev;
  });
}

export type TaskFixture = TaskSnapshot;
export type SubtaskFixture = SubtaskSnapshot;
export type TaskCommentFixture = TaskCommentSnapshot;

export type TaskFixtureInput = Omit<
  Partial<TaskSnapshot>,
  'planning' | 'presentation' | 'ref' | 'source'
> & {
  readonly planning?: {
    readonly created?: string;
    readonly due?: string;
    readonly scheduled?: string;
    readonly start?: string;
    readonly completion?: string;
    readonly cancelled?: string;
    readonly time?: string;
    readonly duration?: number;
  };
  readonly presentation?: Omit<Partial<TaskSnapshot['presentation']>, 'dailyNoteDate'> & {
    readonly dailyNoteDate?: string;
  };
  readonly ref?: Partial<TaskSnapshot['ref']>;
  readonly source?: Partial<TaskSnapshot['source']>;
};

/** Build one detached final-contract snapshot without legacy parser fields. */
export function task(overrides: TaskFixtureInput = {}): TaskSnapshot {
  const title = overrides.title ?? 't';
  const source = {
    filePath: 'f.md',
    line: 0,
    originalMarkdown: `- [ ] ${title}`,
    originalBlock: `- [ ] ${title}`,
    ...overrides.source,
  };
  const ref = {
    filePath: source.filePath,
    line: source.line,
    revision: `test:${source.filePath}:${source.line}:${source.originalBlock}`,
    ...overrides.ref,
  };
  const base: TaskSnapshot = {
    ref,
    title,
    markdownTitle: overrides.markdownTitle ?? title,
    status: 'open',
    statusSymbol: ' ',
    priority: 'D',
    onCompletion: 'keep' as const,
    onCompletionExplicit: false,
    planning: {},
    tags: [],
    subtasks: [],
    comments: [],
    source,
    presentation: { linkCount: 0 },
  };
  return {
    ...base,
    ...overrides,
    ref,
    source,
    planning: { ...overrides.planning } as TaskSnapshot['planning'],
    presentation: { linkCount: 0, ...overrides.presentation } as TaskSnapshot['presentation'],
    tags: [...(overrides.tags ?? [])],
    subtasks: [...(overrides.subtasks ?? [])],
    comments: [...(overrides.comments ?? [])],
  };
}

export interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

/** Control an asynchronous result without timers so pending-state tests stay deterministic. */
export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Build a render-test snapshot from the real markdown codec's title/link projection. */
export function taskFromCodecLine(
  sourceLine: string,
  overrides: TaskFixtureInput = {},
): TaskSnapshot {
  const source = {
    filePath: overrides.source?.filePath ?? 'f.md',
    line: overrides.source?.line ?? 0,
  };
  const parsed = new TaskMarkdownCodec(canonicalStatusCatalog()).parseLine(sourceLine, source);
  if (parsed == null) throw new Error(`Expected a task line: ${sourceLine}`);
  return task({
    ...overrides,
    title: parsed.title,
    markdownTitle: parsed.markdownTitle,
    planning: parsed.planning,
    priority: parsed.priority,
    ...(parsed.recurrence === undefined ? {} : { recurrence: parsed.recurrence }),
    onCompletion: parsed.onCompletion,
    onCompletionExplicit: parsed.onCompletionExplicit,
    tags: [...parsed.tags],
    statusSymbol: parsed.statusSymbol,
    source: {
      ...overrides.source,
      originalMarkdown: sourceLine,
      originalBlock: sourceLine,
    },
  });
}

export type SubtaskFixtureInput = Omit<Partial<SubtaskSnapshot>, 'planning' | 'ref'> & {
  readonly planning?: {
    readonly created?: string;
    readonly due?: string;
    readonly scheduled?: string;
    readonly start?: string;
    readonly completion?: string;
    readonly cancelled?: string;
    readonly time?: string;
  };
  readonly ref?: Partial<Omit<SubtaskSnapshot['ref'], 'parent'>> & {
    readonly parent?: TaskNodeRef;
  };
  readonly root?: Partial<TaskSnapshot['ref']>;
};

function normalizedSubtaskFields(overrides: SubtaskFixtureInput): {
  readonly title: string;
  readonly markdownTitle: string;
  readonly status: SubtaskSnapshot['status'];
  readonly statusSymbol: string;
  readonly priority: SubtaskSnapshot['priority'];
  readonly planning: NonNullable<SubtaskFixtureInput['planning']>;
  readonly tags: readonly string[];
  readonly subtasks: readonly SubtaskSnapshot[];
  readonly comments: readonly TaskCommentSnapshot[];
} {
  const {
    title = 'subtask',
    markdownTitle = title,
    status = 'open',
    statusSymbol = ' ',
    priority = 'D',
    planning = {},
    tags = [],
    subtasks = [],
    comments = [],
  } = overrides;
  return {
    title,
    markdownTitle,
    status,
    statusSymbol,
    priority,
    planning,
    tags,
    subtasks,
    comments,
  };
}

/** Build one detached final-contract subtask snapshot. */
export function subtask(overrides: SubtaskFixtureInput = {}): SubtaskSnapshot {
  const {
    title,
    markdownTitle,
    status,
    statusSymbol,
    priority,
    planning,
    tags,
    subtasks,
    comments,
  } = normalizedSubtaskFields(overrides);
  const refOverrides = { ...overrides.ref };
  const { originalBlock = `  - [ ] ${title}`, relativeLine = 1 } = refOverrides;
  const rootOverrides = { ...overrides.root };
  const { filePath = 'f.md', line = 0 } = rootOverrides;
  const baseRoot = task({
    source: {
      filePath,
      line,
      originalBlock,
    },
  }).ref;
  const { parent = { type: 'task', ref: { ...baseRoot, ...overrides.root } } } = refOverrides;
  return {
    ref: {
      parent,
      relativeLine,
      originalBlock,
    },
    title,
    markdownTitle,
    status,
    statusSymbol,
    priority,
    onCompletion: 'keep' as const,
    onCompletionExplicit: false,
    planning: { ...planning } as SubtaskSnapshot['planning'],
    tags: [...tags],
    subtasks: [...subtasks],
    comments: [...comments],
    ...(overrides.recurrence === undefined ? {} : { recurrence: overrides.recurrence }),
    ...(overrides.description === undefined ? {} : { description: overrides.description }),
  };
}

export type TaskCommentFixtureInput = Omit<Partial<TaskCommentSnapshot>, 'timestamp' | 'ref'> & {
  readonly timestamp?: CommentTimestamp;
  /** Concise fixture shorthand for a legacy day-precision comment. */
  readonly date?: string;
  readonly ref?: Partial<Omit<TaskCommentSnapshot['ref'], 'parent'>> & {
    readonly parent?: TaskNodeRef;
  };
};

function commentTimestampFields(
  timestamp: CommentTimestamp | undefined,
  date: string | undefined,
): Pick<TaskCommentSnapshot, 'timestamp'> | Record<never, never> {
  if (timestamp != null) return { timestamp };
  if (date === undefined || date.length === 0) return {};
  return { timestamp: { precision: 'day', value: localDate(date), raw: date } };
}

/** Build one detached final-contract comment snapshot. */
export function taskComment(overrides: TaskCommentFixtureInput = {}): TaskCommentSnapshot {
  const { text = 'comment', timestamp, date } = overrides;
  const refOverrides = { ...overrides.ref };
  const { originalMarkdown = `  - ${text}`, relativeLine = 1 } = refOverrides;
  const {
    parent = {
      type: 'task',
      ref: task({ source: { originalBlock: originalMarkdown } }).ref,
    },
  } = refOverrides;
  return {
    ref: {
      parent,
      relativeLine,
      originalMarkdown,
    },
    ...commentTimestampFields(timestamp, date),
    text,
  };
}

/** Create a fresh App with pre-populated files and flushed async metadata parsing. */
export async function createAppWithFiles(files: Record<string, string>): Promise<ObsidianApp> {
  const app = (
    ObsidianApp as unknown as {
      createConfigured__: (params: { files: Record<string, string> }) => ObsidianApp;
    }
  ).createConfigured__({ files });
  // Flush the mock's async parseFileMetadata for each file
  await Promise.all(app.vault.getMarkdownFiles().map((f) => app.vault.cachedRead(f)));
  await flushMicrotasks();
  return app;
}

/** Wait for the mock's async metadata parsing to settle. */
export async function flushMicrotasks(ms = 10): Promise<void> {
  await new Promise<void>((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

/** Seed a file's metadata cache with task listItems + optional frontmatter (parent=-1 for root items). */
export function seedTaskCache(
  app: ObsidianApp,
  path: string,
  items: Array<{ task: string; parent: number; line: number }>,
  frontmatter?: Record<string, unknown>,
): void {
  const cache = {
    listItems: items.map((i) => ({
      task: i.task,
      parent: i.parent,
      // Only `start.line` is read by the task index; col/offset complete the cache shape.
      position: {
        start: { line: i.line, col: 0, offset: 0 },
        end: { line: i.line, col: 80, offset: 80 },
      },
    })),
    ...(frontmatter != null ? { frontmatter } : {}),
  };
  (
    app.metadataCache as unknown as { setCache__: (path: string, cache: unknown) => void }
  ).setCache__(path, cache);
}

/**
 * Capture the `changed` callback the task index registers on metadataCache, so tests can invoke it
 * directly with a crafted (TFile, content, CachedMetadata). Needed because setCache__ fires
 * `changed` with zero args (which would crash the handler). Call before index initialization
 * so registerEvents's metadataCache.on('changed', cb) is captured.
 */
export function captureChangedCallback(
  app: ObsidianApp,
): (file: TFile, content: string, cache: CachedMetadata) => void {
  let captured: ((file: TFile, content: string, cache: CachedMetadata) => void) | null = null;
  const origOn = app.metadataCache.on.bind(app.metadataCache) as (
    name: string,
    cb: (...args: unknown[]) => void,
  ) => unknown;
  app.metadataCache.on = ((name: string, cb: (...args: unknown[]) => void) => {
    if (name === 'changed') {
      captured = cb;
    }
    return origOn(name, cb);
  }) as typeof app.metadataCache.on;
  return (file: TFile, content: string, cache: CachedMetadata) => {
    if (captured == null) throw new Error('captureChangedCallback: no changed handler registered');
    captured(file, content, cache);
  };
}

/** Build a full ResolvedConfig with sane defaults; overrides win. */
export function resolvedConfig(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
  return {
    ...DEFAULT_VIEW_CONFIG,
    isMobile: false,
    sourceNoteDisplay: 'non-default',
    customFilePath: '',
    ...overrides,
  };
}

/**
 * Minimal DataTransfer shim — jsdom does not define DataTransfer.
 */
export class DataTransferStub {
  private readonly store = new Map<string, string>();
  setData(format: string, data: string): void {
    this.store.set(format, data);
  }
  getData(format: string): string {
    return this.store.get(format) ?? '';
  }
  clearData(format?: string): void {
    if (format !== undefined && format.length > 0) this.store.delete(format);
    else this.store.clear();
  }
  get dropEffect(): string {
    return 'move';
  }
  set dropEffect(_: string) {
    /* no-op */
  }
  get effectAllowed(): string {
    return 'move';
  }
  set effectAllowed(_: string) {
    /* no-op */
  }
  get types(): string[] {
    return [...this.store.keys()];
  }
  get items(): never[] {
    return [];
  }
  get files(): never[] {
    return [];
  }
}

/**
 * Dispatch a DOM DnD event with DataTransfer support.
 * jsdom lacks DragEvent; use MouseEvent (its superclass) + defineProperty.
 */
export function dispatchDnD(
  el: HTMLElement,
  type: 'dragstart' | 'dragover' | 'dragleave' | 'drop' | 'dragend',
  payload?: string,
  relatedTarget: Node | null = null,
): DataTransferStub {
  const dt = new DataTransferStub();
  if (payload !== undefined) dt.setData('text/plain', payload);
  const ev = new MouseEvent(type, { bubbles: true, cancelable: true, relatedTarget });
  Object.defineProperty(ev, 'dataTransfer', { value: dt, configurable: true });
  el.dispatchEvent(ev);
  return dt;
}

/** Fresh detached div for view render tests. */
export function freshContainer(): HTMLElement {
  return createFragment().createDiv();
}

/**
 * Minimal task-application harness paired with a detached TaskQueryApi.
 *
 * Command methods are inert spies; mutation integrations inject TaskApplicationApi separately.
 */
export function makeStubStore(tasks: TaskSnapshot[], _app?: ObsidianApp): TestTaskHarness {
  const registry = new StatusRegistry(buildDefaultTaskStatuses());
  const queries = queryApiForTasks(() => tasks);
  return {
    statusRegistry: registry,
    queries,
    taskQueries: queries,
    execute: vi.fn().mockResolvedValue({
      type: 'invalid',
      issues: [{ code: 'invalid-target' }],
    }),
    toggleTask: vi.fn().mockResolvedValue(undefined),
    setPriority: vi.fn().mockResolvedValue(undefined),
    setTaskStatus: vi.fn().mockResolvedValue(undefined),
  };
}

export function configuredTaskApplication(
  app: ObsidianApp,
  settings: CalendarSettings,
  options: { readonly authority?: boolean } = {},
): {
  readonly index: TaskIndex;
  readonly tasks: TaskApplicationApi;
  readonly statusCatalog: StatusCatalog;
  readonly statusRegistry: StatusRegistry;
} {
  const statusCatalog = new StatusCatalog(toStatusRules(settings.taskStatuses));
  const refAuthority =
    options.authority === true ? new TaskRefAuthority('configured-test-session') : undefined;
  const index = new TaskIndex(app, {
    statusCatalog,
    dailyNoteFormat: settings.desktop.dailyNoteFormat,
    ...(settings.desktop.globalTaskFilter.length > 0 && {
      globalTaskFilter: settings.desktop.globalTaskFilter,
    }),
    ...(refAuthority === undefined ? {} : { refAuthority }),
  });
  const repository = new ObsidianTaskRepository(app, {
    codec: new TaskMarkdownCodec(statusCatalog),
    editor: new TaskBlockEditor(),
    locator: new TaskLocator(refAuthority),
    snapshotsFromContent: (path, content) => index.snapshotsFromContent(path, content),
    ...(refAuthority === undefined ? {} : { refAuthority, snapshotState: index }),
  });
  const dailyNotes = new DailyNoteResolver(app, settings);
  const tasks = new TaskApplicationService(
    index,
    repository,
    statusCatalog,
    systemClock(
      () => Date.now(),
      (epochMs) => -new Date(epochMs).getTimezoneOffset(),
    ),
    new ObsidianTaskDestinationProvider(
      app,
      () => ({
        addToToday: settings.addToToday,
        customFilePath: settings.customFilePath,
        insertion:
          settings.taskInsertionMode === 'section' &&
          settings.taskInsertionSection.trim().length > 0
            ? { type: 'section', heading: settings.taskInsertionSection }
            : { type: 'append' },
      }),
      () => dailyNotes.planDailyNoteDestination(),
    ),
  );
  return {
    index,
    tasks,
    statusCatalog,
    statusRegistry: new StatusRegistry(settings.taskStatuses),
  };
}

/**
 * Freeze window.moment to a known date for deterministic date-dependent tests.
 * Uses fake timers + the real moment module (which reads system time via Date).
 * Restores real timers in afterEach.
 */
export function fixedToday(dateStr: string): void {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(`${dateStr}T12:00:00Z`));
    (window as unknown as { moment: unknown }).moment = moment;
  });
  afterEach(() => {
    vi.useRealTimers();
  });
}
