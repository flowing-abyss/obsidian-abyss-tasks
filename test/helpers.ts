// eslint-disable-next-line no-restricted-imports, import/no-extraneous-dependencies
import moment from 'moment';
import { App as ObsidianApp, Platform, TFile, type CachedMetadata } from 'obsidian';
import { afterEach, beforeEach, vi } from 'vitest';
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
          if (!query?.dateRange) return true;
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
          if (start && due) return dates.some((date) => date >= start && date <= due);
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
      return found
        ? { type: 'exact', task: found, basis: { observed: found } }
        : { type: 'not-found', ref };
    },
    ...(onSubscribe && { subscribe: onSubscribe }),
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

export function makeCenterPanelForTest(
  state: AppState,
  taskHarness: TestTaskHarness,
  app: ObsidianApp,
  settings: CalendarSettings,
  _tagManager: TagManager,
  onSaveSettings: () => Promise<void> = async () => {},
  projectStore: ProjectStore | null = null,
  projectManager: ProjectManager | null = null,
  tasks?: TaskApplicationApi,
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

export function makeLeftPanelForTest(
  state: AppState,
  taskHarness: TestTaskHarness,
  settings: CalendarSettings,
  tagManager: TagManager,
  app: ObsidianApp,
  onSaveSettings: () => Promise<void> = async () => {},
  projectStore: ProjectStore | null = null,
  projectManager: ProjectManager | null = null,
  tasks?: TaskApplicationApi,
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
  if (!parsed) throw new Error(`Expected a task line: ${sourceLine}`);
  return task({
    ...overrides,
    title: parsed.title,
    markdownTitle: parsed.markdownTitle,
    planning: parsed.planning,
    priority: parsed.priority,
    recurrence: parsed.recurrence,
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

/** Build one detached final-contract subtask snapshot. */
export function subtask(overrides: SubtaskFixtureInput = {}): SubtaskSnapshot {
  const title = overrides.title ?? 'subtask';
  const originalBlock = overrides.ref?.originalBlock ?? `  - [ ] ${title}`;
  const baseRoot = task({
    source: {
      filePath: overrides.root?.filePath ?? 'f.md',
      line: overrides.root?.line ?? 0,
      originalBlock,
    },
  }).ref;
  const parent =
    overrides.ref?.parent ??
    ({ type: 'task', ref: { ...baseRoot, ...overrides.root } } satisfies TaskNodeRef);
  return {
    ref: {
      parent,
      relativeLine: overrides.ref?.relativeLine ?? 1,
      originalBlock,
    },
    title,
    markdownTitle: overrides.markdownTitle ?? title,
    status: overrides.status ?? 'open',
    statusSymbol: overrides.statusSymbol ?? ' ',
    priority: overrides.priority ?? 'D',
    onCompletion: 'keep' as const,
    onCompletionExplicit: false,
    planning: { ...overrides.planning } as SubtaskSnapshot['planning'],
    tags: [...(overrides.tags ?? [])],
    recurrence: overrides.recurrence,
    subtasks: [...(overrides.subtasks ?? [])],
    comments: [...(overrides.comments ?? [])],
    description: overrides.description,
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

/** Build one detached final-contract comment snapshot. */
export function taskComment(overrides: TaskCommentFixtureInput = {}): TaskCommentSnapshot {
  const text = overrides.text ?? 'comment';
  const originalMarkdown = overrides.ref?.originalMarkdown ?? `  - ${text}`;
  const parent =
    overrides.ref?.parent ??
    ({
      type: 'task',
      ref: task({ source: { originalBlock: originalMarkdown } }).ref,
    } satisfies TaskNodeRef);
  return {
    ref: {
      parent,
      relativeLine: overrides.ref?.relativeLine ?? 1,
      originalMarkdown,
    },
    ...(overrides.timestamp
      ? { timestamp: overrides.timestamp }
      : overrides.date
        ? {
            timestamp: {
              precision: 'day' as const,
              value: localDate(overrides.date),
              raw: overrides.date,
            },
          }
        : {}),
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
    ...(frontmatter ? { frontmatter } : {}),
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
    if (!captured) throw new Error('captureChangedCallback: no changed handler registered');
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
  private store = new Map<string, string>();
  setData(format: string, data: string): void {
    this.store.set(format, data);
  }
  getData(format: string): string {
    return this.store.get(format) ?? '';
  }
  clearData(format?: string): void {
    if (format) this.store.delete(format);
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
  return activeDocument.createElement('div');
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
  const refAuthority = options.authority
    ? new TaskRefAuthority('configured-test-session')
    : undefined;
  const index = new TaskIndex(app, {
    statusCatalog,
    dailyNoteFormat: settings.desktop.dailyNoteFormat,
    ...(settings.desktop.globalTaskFilter && {
      globalTaskFilter: settings.desktop.globalTaskFilter,
    }),
    ...(refAuthority && { refAuthority }),
  });
  const repository = new ObsidianTaskRepository(app, {
    codec: new TaskMarkdownCodec(statusCatalog),
    editor: new TaskBlockEditor(),
    locator: new TaskLocator(refAuthority),
    snapshotsFromContent: (path, content) => index.snapshotsFromContent(path, content),
    ...(refAuthority && { refAuthority, snapshotState: index }),
  });
  const tasks = new TaskApplicationService(
    index,
    repository,
    statusCatalog,
    systemClock(
      () => Date.now(),
      (epochMs) => -new Date(epochMs).getTimezoneOffset(),
    ),
    new ObsidianTaskDestinationProvider(app, settings, new DailyNoteResolver(app, settings)),
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
    vi.setSystemTime(new Date(dateStr + 'T12:00:00Z'));
    (window as unknown as { moment: unknown }).moment = moment;
  });
  afterEach(() => {
    vi.useRealTimers();
  });
}
