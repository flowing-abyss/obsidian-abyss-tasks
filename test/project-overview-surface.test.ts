import { Component, MarkdownRenderer, Notice } from 'obsidian';
import { Component as MockComponent } from 'obsidian-test-mocks/obsidian';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppState } from '../src/app/AppState';
import type {
  ProjectsOverviewSurface,
  RenderedCellContext,
} from '../src/panels/projects/ProjectsOverviewSurface';
import { ProjectsTableView } from '../src/panels/projects/ProjectsTableView';
import type { ProjectPropertyCatalog } from '../src/projects/ObsidianProjectProperties';
import { ProjectEditHistory } from '../src/projects/projectEditHistory';
import type { ProjectEditResult } from '../src/projects/projectEdits';
import { buildDefaultProjectKanbanSettings } from '../src/projects/projectKanbanSettings';
import { buildDefaultProjectTimelineSettings } from '../src/projects/projectTimelineSettings';
import type { Project } from '../src/projects/types';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import type { ProjectsSettings } from '../src/settings/types';
import {
  appWithFiles,
  expectDefined,
  flushMicrotasks,
  freshContainer,
  objectMatching,
} from './helpers';
import { recordVirtualSurfaceResources } from './support/virtualSurfaceResources';

type Surface = ProjectsOverviewSurface<RenderedCellContext>;

interface SurfaceInternals {
  readonly tableSurface_abyssPrivate?: Surface;
  readonly kanbanView_abyssPrivate?: Surface;
  readonly timelineView_abyssPrivate?: Surface;
}

interface SurfaceCase {
  readonly mode: 'Table' | 'Kanban' | 'Timeline';
  /** Groups the view so that A's group can collapse on its own. */
  group(projects: ProjectsSettings): void;
  surface(view: ProjectsTableView): Surface | undefined;
  groupHeader(host: HTMLElement, path: string): HTMLElement;
  /** The areas `scrollCellIntoView` scrolls for a cell, and the header that covers their top. */
  viewport(
    surface: Surface,
    cell: HTMLElement,
  ): {
    readonly horizontal: HTMLElement;
    readonly vertical: HTMLElement;
    readonly header: HTMLElement;
  };
  /** Today's editor frame for a cell: the element it stays inside and the header it stays below. */
  editorFrame(
    surface: Surface,
    cell: HTMLElement,
  ): { readonly boundary: HTMLElement; readonly stickyHeader: HTMLElement };
  readonly restoresScrollAfterHide: boolean;
  /** The listener `destroy` removes, as its target and event type. */
  listener(surface: Surface): readonly [EventTarget, string];
  readonly observesScroll: boolean;
  /** Whether the view mounts only a window of its rows, so a listed cell can start unmounted. */
  readonly windowed: boolean;
}

interface RecordedObserver {
  readonly targets: Element[];
  disconnected: boolean;
}

const mounted = new Set<ProjectsTableView>();

afterEach(() => {
  for (const view of mounted) view.destroy();
  mounted.clear();
  activeDocument.body.empty();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function project(over: Partial<Project> = {}): Project {
  const status = expectDefined(DEFAULT_SETTINGS.projects.statuses[0]);
  return {
    path: 'Projects/A.md',
    name: 'A planning project',
    frontmatter: {
      start: '2026-09-01',
      end: '2026-09-30',
      description: 'A concise project description',
      Budget: 42,
    },
    tags: [],
    statusId: status.id,
    rawStatus: null,
    stats: {
      total: 10,
      done: 6,
      cancelled: 0,
      inProgress: 0,
      tracked: { closedMs: 0, openStartsMs: [] },
    },
    ...over,
  };
}

/** A and B share the first status with different budgets; C has the second status. */
function projects(): Project[] {
  const second = expectDefined(DEFAULT_SETTINGS.projects.statuses[1]);
  return [
    project(),
    project({ path: 'Projects/B.md', name: 'B project', frontmatter: { Budget: 7 } }),
    project({
      path: 'Projects/C.md',
      name: 'C project',
      statusId: second.id,
      frontmatter: { start: '2026-09-15', end: '2026-10-01', Budget: 42 },
    }),
  ];
}

/** Projects without dates or a budget in the first status, which only lengthen the list. */
function fillers(count: number): Project[] {
  return Array.from({ length: count }, (_, index) => {
    const name = `Filler ${String(index).padStart(2, '0')}`;
    return project({ path: `Projects/${name}.md`, name, frontmatter: {} });
  });
}

function catalog(): ProjectPropertyCatalog {
  const properties = [
    { name: 'start', type: 'date' as const },
    { name: 'end', type: 'date' as const },
    { name: 'description', type: 'text' as const },
    { name: 'Budget', type: 'number' as const },
  ];
  return {
    list: () => properties,
    inspect: (property) => ({
      kind: 'available',
      property: properties.find(({ name }) => name === property),
      assignment: { kind: 'none' },
    }),
    values: () => [],
    onChange: () => () => {},
  };
}

/** Mounts the overview on three projects and `extra` fillers, and switches to the case's view. */
function mountSurface(
  testCase: SurfaceCase,
  extra = 0,
  configure?: (settings: ProjectsSettings) => void,
) {
  const originalHeight = Object.getOwnPropertyDescriptor(Element.prototype, 'clientHeight');
  vi.spyOn(Element.prototype, 'clientHeight', 'get').mockImplementation(function (
    this: HTMLElement,
  ) {
    return [
      'abyss-project-timeline-scroll',
      ...(configure === undefined
        ? []
        : ['abyss-project-table-scroll', 'abyss-project-kanban-column-body']),
    ].some((name) => this.classList.contains(name))
      ? 400
      : Number(originalHeight?.get?.call(this) ?? 0);
  });
  const host = freshContainer();
  activeDocument.body.append(host);
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.projects.propertyDefinitions['property:Budget'] = { type: 'number' };
  testCase.group(settings.projects);
  configure?.(settings.projects);
  const listed = [...projects(), ...fillers(extra)];
  const applyEdits = vi.fn(async (): Promise<ProjectEditResult> =>
    Promise.resolve({ applied: [], failed: [] }),
  );
  const contextApp = appWithFiles(Object.fromEntries(listed.map(({ path }) => [path, ''])));
  const view = new ProjectsTableView(host, {
    app: contextApp,
    state: new AppState(),
    settings,
    catalog: catalog(),
    saveViewState: vi.fn().mockResolvedValue(undefined),
    applyEdits,
    history: new ProjectEditHistory(applyEdits),
    createProject: vi.fn().mockResolvedValue(undefined),
    openProject: vi.fn(),
    revalidateSourceObservation: vi.fn().mockResolvedValue(false),
  });
  mounted.add(view);
  view.mount(listed);
  expectDefined(
    host.querySelector<HTMLButtonElement>(`[aria-label="${testCase.mode} view"]`),
  ).click();
  return {
    host,
    view,
    settings: settings.projects,
    app: contextApp,
    applyEdits,
    projects: listed,
    surface: expectDefined(testCase.surface(view)),
  };
}

function rectangle(left: number, top: number, right: number, bottom: number): DOMRect {
  return { left, top, right, bottom, width: right - left, height: bottom - top } as DOMRect;
}

function cellKeys(
  cells: ReadonlyArray<{
    readonly identity: { readonly occurrenceId: string; readonly columnId: string };
  }>,
): string[] {
  return cells.map(({ identity }) => `${identity.occurrenceId} ${identity.columnId}`);
}

/** Whether every key of `inner` appears in `outer`, in the same order. */
function orderedWithin(inner: readonly string[], outer: readonly string[]): boolean {
  let next = 0;
  for (const key of outer) if (key === inner[next]) next += 1;
  return next === inner.length;
}

function expectRenderedWithinListed(surface: Surface): void {
  const rendered = cellKeys(surface.renderedCells());
  expect(rendered.length).toBeGreaterThan(0);
  expect(orderedWithin(rendered, cellKeys(surface.cells().cells))).toBe(true);
}

function nameCell<TCell extends { readonly project: Project; readonly field: { id: string } }>(
  cells: readonly TCell[],
  path: string,
): TCell | undefined {
  return cells.find(({ project: owner, field }) => owner.path === path && field.id === 'name');
}

/** Replaces `ResizeObserver` with one that records what it observes and whether it disconnected. */
function recordResizeObservers(): RecordedObserver[] {
  const observers: RecordedObserver[] = [];
  class RecordingResizeObserver implements RecordedObserver {
    readonly targets: Element[] = [];
    disconnected = false;
    constructor() {
      observers.push(this);
    }
    observe(target: Element): void {
      this.targets.push(target);
    }
    unobserve(): void {}
    disconnect(): void {
      this.disconnected = true;
    }
  }
  vi.stubGlobal('ResizeObserver', RecordingResizeObserver);
  return observers;
}

function tableGroupToggle(host: HTMLElement, path: string): HTMLElement {
  const key = expectDefined(
    host.querySelector<HTMLElement>(`.abyss-project-table-row[data-project-path="${path}"]`)
      ?.dataset['groupKey'],
  );
  return expectDefined(
    Array.from(host.querySelectorAll<HTMLElement>('.abyss-project-table-group-toggle')).find(
      (toggle) => toggle.dataset['groupKey'] === key,
    ),
  );
}

function tableHead(surface: Surface): HTMLElement {
  return expectDefined(surface.scroll.querySelector<HTMLElement>('thead'));
}

function tableHeaderCell(surface: Surface): HTMLElement {
  return expectDefined(
    surface.scroll.querySelector<HTMLElement>('.abyss-project-table-header-cell'),
  );
}

function kanbanColumnHeader(cell: HTMLElement): HTMLElement {
  return expectDefined(
    cell
      .closest('.abyss-project-kanban-column')
      ?.querySelector<HTMLElement>('.abyss-project-kanban-column-header'),
  );
}

function timelineAxis(surface: Surface): HTMLElement {
  return expectDefined(surface.scroll.querySelector<HTMLElement>('.abyss-project-timeline-axis'));
}

const cases: readonly SurfaceCase[] = [
  {
    mode: 'Table',
    group: (settings) => {
      settings.table.groupBy = 'status';
    },
    surface: (view) => (view as unknown as SurfaceInternals).tableSurface_abyssPrivate,
    groupHeader: tableGroupToggle,
    viewport: (surface) => ({
      horizontal: surface.scroll,
      vertical: surface.scroll,
      header: tableHeaderCell(surface),
    }),
    editorFrame: (surface) => ({ boundary: surface.scroll, stickyHeader: tableHead(surface) }),
    restoresScrollAfterHide: true,
    listener: (surface) => [surface.scroll, 'scroll'],
    observesScroll: true,
    windowed: true,
  },
  {
    mode: 'Kanban',
    group: (settings) => {
      settings.kanban = buildDefaultProjectKanbanSettings(settings.table);
      settings.kanban.groupBy = 'property:Budget';
    },
    surface: (view) => (view as unknown as SurfaceInternals).kanbanView_abyssPrivate,
    groupHeader: (host, path) =>
      expectDefined(
        host
          .querySelector(`.abyss-project-kanban-card[data-project-path="${path}"]`)
          ?.closest('.abyss-project-kanban-group')
          ?.querySelector<HTMLElement>('.abyss-project-kanban-group-header'),
      ),
    viewport: (surface, cell) => ({
      horizontal: surface.scroll,
      vertical: expectDefined(cell.closest<HTMLElement>('.abyss-project-kanban-column-body')),
      header: kanbanColumnHeader(cell),
    }),
    editorFrame: (surface, cell) => ({
      boundary: surface.scroll,
      stickyHeader: kanbanColumnHeader(cell),
    }),
    restoresScrollAfterHide: true,
    listener: (surface) => [surface.scroll.ownerDocument, 'focusin'],
    observesScroll: false,
    windowed: false,
  },
  {
    mode: 'Timeline',
    group: (settings) => {
      settings.timeline = buildDefaultProjectTimelineSettings(settings.table);
      settings.timeline.groupBy = 'status';
    },
    surface: (view) => (view as unknown as SurfaceInternals).timelineView_abyssPrivate,
    groupHeader: (host) =>
      expectDefined(host.querySelector<HTMLElement>('.abyss-project-timeline-group-header')),
    viewport: (surface) => ({
      horizontal: surface.scroll,
      vertical: surface.scroll,
      header: timelineAxis(surface),
    }),
    editorFrame: (surface) => ({ boundary: surface.scroll, stickyHeader: timelineAxis(surface) }),
    restoresScrollAfterHide: true,
    listener: (surface) => [surface.scroll, 'scroll'],
    observesScroll: true,
    windowed: true,
  },
];

describe.each(cases)('project overview surface contract: $mode', (testCase) => {
  it('publishes the project count after each render', () => {
    const { host } = mountSurface(testCase);
    const count = expectDefined(host.querySelector<HTMLElement>('.abyss-project-table-count'));
    expect(count.textContent).toBe('3 projects');
    const search = expectDefined(host.querySelector<HTMLInputElement>('.abyss-center-search'));

    search.value = 'B project';
    search.dispatchEvent(new Event('input', { bubbles: true }));

    expect(count.textContent).toBe('1 project');
  });

  it('renders its cells within its list in order, also after revealing a collapsed group', async () => {
    const { host, surface } = mountSurface(testCase);
    expectRenderedWithinListed(surface);
    testCase.groupHeader(host, 'Projects/A.md').click();
    await flushMicrotasks();
    expect(nameCell(surface.cells().cells, 'Projects/A.md')).toBeUndefined();
    expectRenderedWithinListed(surface);

    surface.revealProject('Projects/A.md');

    expect(nameCell(surface.cells().cells, 'Projects/A.md')).toBeDefined();
    expect(nameCell(surface.renderedCells(), 'Projects/A.md')).toBeDefined();
    expectRenderedWithinListed(surface);
  });

  it('has a rendered cell for a listed identity once it reveals it', () => {
    // Only windowed views need fillers to make the last row's unmounted-to-mounted reveal nonvacuous.
    const { surface } = mountSurface(testCase, testCase.windowed ? 40 : 0);
    const { identities } = surface.cells();
    const last = expectDefined(identities[identities.length - 1]);
    const key = `${last.occurrenceId} ${last.columnId}`;
    expect(cellKeys(surface.renderedCells()).includes(key)).toBe(!testCase.windowed);

    surface.revealCell(last);

    expect(cellKeys(surface.renderedCells())).toContain(key);
  });

  it('scrolls each area the least that shows a cell below its header', () => {
    const { surface } = mountSurface(testCase);
    const cell = expectDefined(surface.renderedCells().find(({ field }) => field.id === 'start'));
    const { horizontal, vertical, header } = testCase.viewport(surface, cell.element);
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement,
    ) {
      if (this === cell.element) return rectangle(350, 20, 450, 50);
      if (this === header) return rectangle(0, 0, 300, 40);
      if (this === horizontal || this === vertical) return rectangle(0, 0, 300, 300);
      return rectangle(0, 0, 0, 0);
    });
    horizontal.scrollLeft = 0;
    vertical.scrollTop = 100;

    surface.scrollCellIntoView(cell);

    expect(horizontal.scrollLeft).toBe(150);
    expect(vertical.scrollTop).toBe(80);
  });

  it("frames a cell's editor inside the view and below the cell's header", () => {
    const { surface } = mountSurface(testCase);
    const cell = expectDefined(surface.renderedCells().find(({ field }) => field.id === 'start'));
    const expected = testCase.editorFrame(surface, cell.element);

    const frame = surface.editorFrame(cell);

    expect(frame.boundary).toBe(expected.boundary);
    expect(frame.stickyHeader).toBe(expected.stickyHeader);
  });

  it('hides and shows its scroll', () => {
    const { surface } = mountSurface(testCase);

    surface.hide();
    expect(surface.scroll.closest('[hidden]')).not.toBeNull();
    surface.show();

    expect(surface.scroll.closest('[hidden]')).toBeNull();
  });

  it('retains a captured scroll through detached updates until connected render', () => {
    const { view, projects: listed, surface } = mountSurface(testCase);
    surface.scroll.scrollLeft = 180;
    surface.scroll.scrollTop = 44;
    surface.captureViewportBeforeHide();
    surface.scroll.scrollLeft = 0;
    surface.scroll.scrollTop = 0;

    // A detached render cannot consume the native scroll restoration snapshot.
    {
      const parent = expectDefined(surface.scroll.parentElement);
      surface.scroll.remove();
      view.update(listed);
      surface.scroll.scrollLeft = 0;
      surface.scroll.scrollTop = 0;
      parent.append(surface.scroll);
    }
    view.update(listed);

    expect([surface.scroll.scrollLeft, surface.scroll.scrollTop]).toEqual(
      testCase.restoresScrollAfterHide ? [180, testCase.mode === 'Kanban' ? 0 : 44] : [0, 0],
    );
  });

  it('releases its cells, rows, listener, and observer on destroy', () => {
    const observers = recordResizeObservers();
    const { view, surface } = mountSurface(testCase);
    const { scroll } = surface;
    const [target, type] = testCase.listener(surface);
    const removed = vi.spyOn(target, 'removeEventListener');

    mounted.delete(view);
    view.destroy();

    expect(surface.cells().cells).toHaveLength(0);
    expect(surface.renderedCells()).toHaveLength(0);
    expect(scroll.isConnected).toBe(false);
    expect(removed).toHaveBeenCalledWith(type, expect.any(Function));
    expect(
      observers
        .filter(({ targets }) => targets.includes(scroll))
        .map(({ disconnected }) => disconnected),
    ).toEqual(testCase.observesScroll ? [true] : []);
  });
});

function mountHorizontalPicker(kind: 'status' | 'list' | 'tags') {
  const host = freshContainer();
  document.body.append(host);
  const settings = structuredClone(DEFAULT_SETTINGS);
  const base = expectDefined(settings.projects.statuses[0]);
  settings.projects.statuses = Array.from({ length: 6 }, (_, index) => ({
    ...base,
    id: `picker-${index}`,
    name: `Picker ${index}`,
  }));
  const property = kind === 'tags' ? 'tags' : 'Custom';
  const fieldId = kind === 'status' ? 'status' : `property:${property}`;
  settings.projects.propertyDefinitions[`property:${property}`] = {
    type: kind === 'status' ? 'list' : kind,
  };
  settings.projects.kanban = buildDefaultProjectKanbanSettings(settings.projects.table);
  settings.projects.kanban.fields = [{ id: fieldId, visible: true }];
  settings.projects.kanban.showEmptyFields = true;
  const listed = settings.projects.statuses.flatMap((status) =>
    Array.from({ length: 50 }, (_, index) =>
      project({
        path: `Projects/${status.id}-${index}.md`,
        name: `Project ${String(index).padStart(2, '0')}`,
        statusId: status.id,
        frontmatter: { status: status.name, [property]: [] },
      }),
    ),
  );
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement,
  ) {
    if (this.matches('.abyss-project-kanban-scroll')) return rectangle(0, 0, 400, 500);
    if (this.matches('.abyss-project-kanban-column')) {
      const index = settings.projects.statuses.findIndex(
        (status) => `id:${status.id}` === this.dataset['statusKey'],
      );
      const left = index * 200 - (this.parentElement?.scrollLeft ?? 0);
      return rectangle(left, 0, left + 200, 500);
    }
    return rectangle(0, 0, 0, 0);
  });
  const applyEdits = vi.fn(async (): Promise<ProjectEditResult> => ({
    applied: [],
    failed: [{ path: 'Projects/picker-0-0.md', message: 'Source changed' }],
  }));
  const view = new ProjectsTableView(host, {
    app: appWithFiles(Object.fromEntries(listed.map(({ path }) => [path, '']))),
    state: new AppState(),
    settings,
    catalog: {
      ...catalog(),
      list: () => [{ name: property, type: kind === 'status' ? 'list' : kind }],
      values: () => ['Next'],
    },
    saveViewState: vi.fn().mockResolvedValue(undefined),
    applyEdits,
    history: new ProjectEditHistory(applyEdits),
    createProject: vi.fn().mockResolvedValue(undefined),
    openProject: vi.fn(),
    revalidateSourceObservation: vi.fn().mockResolvedValue(false),
  });
  mounted.add(view);
  view.mount(listed);
  expectDefined(host.querySelector<HTMLButtonElement>('[aria-label="Kanban view"]')).click();
  const surface = expectDefined((view as unknown as SurfaceInternals).kanbanView_abyssPrivate);
  const rendered = expectDefined(surface.renderedCells().find((cell) => cell.field.id === fieldId));
  const column = expectDefined(
    rendered.element.closest<HTMLElement>('.abyss-project-kanban-column'),
  );
  const unloaded = vi.fn();
  expectDefined(rendered.markdown).register(() => {
    unloaded(host.querySelector('.abyss-project-cell-editor') !== null);
  });
  rendered.element.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  const input = expectDefined(host.querySelector<HTMLInputElement>('[role="combobox"]'));
  const editorHost = expectDefined(input.closest<HTMLElement>('.abyss-project-cell-editor-host'));
  expect(column.contains(input)).toBe(false);
  expect(document.activeElement).toBe(input);
  return {
    host,
    view,
    settings,
    surface,
    rendered,
    column,
    input,
    editorHost,
    applyEdits,
    unloaded,
  };
}

it.each(['status', 'list', 'tags'] as const)(
  'retains the root-level %s picker anchor and failed draft across horizontal deactivation',
  async (kind) => {
    const {
      host,
      view,
      settings,
      surface,
      rendered,
      column,
      input,
      editorHost,
      applyEdits,
      unloaded,
    } = mountHorizontalPicker(kind);
    surface.scroll.scrollLeft = 600;
    surface.scroll.dispatchEvent(new Event('scroll'));
    expect(rendered.element.isConnected).toBe(true);
    expect(column.querySelectorAll('.abyss-project-kanban-card')).toHaveLength(1);
    expect(unloaded).not.toHaveBeenCalled();
    expect(
      surface.renderedCells().find((cell) => cell.element === rendered.element)?.markdown,
    ).toBe(rendered.markdown);
    const fieldId = { status: 'status', list: 'property:Custom', tags: 'property:tags' }[kind];
    const chosen = kind === 'status' ? 'Picker 1' : 'Next';
    const option = expectDefined(
      Array.from(editorHost.querySelectorAll<HTMLElement>('[role="option"]')).find(
        (element) => element.dataset['value'] === chosen,
      ),
    );
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    option.click();
    await flushMicrotasks();
    expect(applyEdits).toHaveBeenCalledOnce();
    expect(applyEdits).toHaveBeenCalledWith([
      objectMatching({
        path: 'Projects/picker-0-0.md',
        field: objectMatching({
          id: fieldId,
        }),
        value: kind === 'status' ? 'Picker 1' : ['Next'],
        expectedValue: kind === 'status' ? 'Picker 0' : [],
      }),
    ]);
    expect(error).toHaveBeenCalledOnce();
    expect(editorHost.querySelector('.abyss-project-editor-error')?.textContent).toContain(
      'Source changed',
    );
    expect(option.getAttribute('aria-selected')).toBe('true');
    expect(input.isConnected).toBe(true);
    expect(rendered.element.isConnected).toBe(true);
    expect(unloaded).not.toHaveBeenCalled();
    if (kind !== 'status') {
      delete settings.projects.propertyDefinitions[fieldId];
      view.refreshFields();
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
      await flushMicrotasks();
      expect(applyEdits).toHaveBeenCalledOnce();
      expect(editorHost.querySelector('.abyss-project-editor-error')?.textContent).toContain(
        'configuration changed',
      );
    }
    view.destroy();
    expect(unloaded).toHaveBeenCalledExactlyOnceWith(false);
    expect(input.isConnected).toBe(false);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await flushMicrotasks();
    expect(applyEdits).toHaveBeenCalledOnce();
    expect(host.querySelector('.abyss-project-kanban-card')).toBeNull();
  },
);

it.each(['Escape', 'Tab'])(
  'releases a horizontally offscreen picker anchor after %s closes it',
  async (key) => {
    const { host, surface, rendered, input, unloaded, applyEdits } =
      mountHorizontalPicker('status');
    surface.scroll.scrollLeft = 600;
    surface.scroll.dispatchEvent(new Event('scroll'));
    expect(rendered.element.isConnected).toBe(true);
    input.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
    await flushMicrotasks();
    expect(input.isConnected).toBe(false);
    expect(host.querySelector('.abyss-project-cell-editor-host')).toBeNull();
    expect(unloaded).toHaveBeenCalledExactlyOnceWith(false);
    expect(applyEdits).not.toHaveBeenCalled();
    // Normal close can reveal a fresh focused cell; moving away evicts it without a stale pin.
    surface.scroll.scrollLeft = 600;
    surface.scroll.dispatchEvent(new Event('scroll'));
    expect(rendered.element.isConnected).toBe(false);
  },
);

it('releases an offscreen picker without revealing over later outside focus', async () => {
  const { surface, input, rendered, unloaded } = mountHorizontalPicker('status');
  surface.scroll.scrollLeft = 600;
  surface.scroll.dispatchEvent(new Event('scroll'));
  const outside = document.body.createEl('button', { text: 'Outside' });
  outside.focus();
  await flushMicrotasks();
  expect(input.isConnected).toBe(false);
  expect(rendered.element.isConnected).toBe(false);
  expect(unloaded).toHaveBeenCalledExactlyOnceWith(false);
  expect(document.activeElement).toBe(outside);
  expect(surface.scroll.scrollLeft).toBe(600);
});

function dispatchRetiredCellEvents(cell: HTMLElement): void {
  for (const type of ['mousedown', 'click', 'focus', 'dblclick', 'contextmenu']) {
    const event =
      type === 'focus'
        ? new FocusEvent(type, { cancelable: true })
        : new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, shiftKey: true });
    cell.dispatchEvent(event);
    expect(event.defaultPrevented, type).toBe(false);
  }
}

describe.each(cases)('shared cell lifetime in $mode', (testCase) => {
  it('makes held cells inert after repeated eviction and unloads each owner once', () => {
    const { surface, view, host } = mountSurface(testCase, 80);
    const first = expectDefined(
      surface
        .cells()
        .identities.find(
          (cell) => cell.projectPath === 'Projects/A.md' && cell.columnId === 'start',
        ),
    );
    const last = expectDefined(
      surface
        .cells()
        .identities.find(
          (cell) => cell.projectPath === 'Projects/Filler 79.md' && cell.columnId === 'name',
        ),
    );
    const held: HTMLElement[] = [];
    for (let cycle = 0; cycle < 3; cycle++) {
      surface.revealCell(first);
      const rendered = expectDefined(
        surface
          .renderedCells()
          .find(
            (cell) =>
              cell.identity.projectPath === 'Projects/A.md' && cell.identity.columnId === 'start',
          ),
      );
      const unload = vi.spyOn(expectDefined(rendered.markdown), 'unload');
      held.push(rendered.element);
      surface.revealCell(last);
      expect(rendered.element.isConnected).toBe(false);
      expect(unload).toHaveBeenCalledOnce();
      const selection = view.selectedProjectPath();
      for (const cell of held) dispatchRetiredCellEvents(cell);
      expect(view.selectedProjectPath()).toBe(selection);
      expect(host.querySelector('.abyss-project-cell-editor')).toBeNull();
      expect(surface.renderedCells().length).toBeLessThan(150);
    }
  });

  it('keeps patched hosts live once with current source and makes destruction final', () => {
    const { surface, view, projects: listed, host } = mountSurface(testCase);
    const first = expectDefined(
      surface
        .renderedCells()
        .find(
          (cell) =>
            cell.identity.projectPath === 'Projects/A.md' && cell.identity.columnId === 'start',
        ),
    );
    const unload = vi.spyOn(expectDefined(first.markdown), 'unload');
    for (let revision = 2; revision < 5; revision++)
      view.update(
        listed.map((item) =>
          item.path === 'Projects/A.md'
            ? { ...item, frontmatter: { ...item.frontmatter, start: `2026-09-0${revision}` } }
            : item,
        ),
      );
    const select = vi.spyOn(
      view as unknown as {
        selectCell_abyssPrivate(cell: RenderedCellContext, extend: boolean): void;
      },
      'selectCell_abyssPrivate',
    );
    first.element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(select).toHaveBeenCalledOnce();
    expect(select.mock.calls[0]?.[0].project.frontmatter['start']).toBe('2026-09-04');
    expect(unload).not.toHaveBeenCalled();
    view.destroy();
    expect(unload).toHaveBeenCalledOnce();
    const calls = select.mock.calls.length;
    dispatchRetiredCellEvents(first.element);
    expect(select.mock.calls).toHaveLength(calls);
    expect(host.querySelector('.abyss-project-cell-editor')).toBeNull();
  });
});

function lifetimeFields(settings: ProjectsSettings): void {
  settings.propertyDefinitions['property:Link'] = { type: 'text' };
  settings.propertyDefinitions['property:Flag'] = { type: 'checkbox' };
  settings.propertyDefinitions['property:Items'] = { type: 'list' };
  settings.propertyDefinitions['property:tags'] = { type: 'tags' };
  const fields = ['property:Link', 'property:Flag', 'property:Items', 'property:tags'].map(
    (id) => ({ id, visible: true }),
  );
  settings.table.columns.push(...fields);
  expectDefined(settings.kanban).fields.push(...fields);
  expectDefined(settings.timeline).fields = [...(settings.timeline?.fields ?? []), ...fields];
}
function configureLifetimeFields(settings: ProjectsSettings): void {
  settings.kanban ??= buildDefaultProjectKanbanSettings(settings.table);
  settings.timeline ??= buildDefaultProjectTimelineSettings(settings.table);
  lifetimeFields(settings);
}
function lifetimeProjects(listed: readonly Project[], revision = 0): Project[] {
  return listed.map((item) => ({
    ...item,
    frontmatter: {
      ...item.frontmatter,
      Link: `[[Target${revision}]]`,
      Flag: revision % 2 === 0,
      Items: [`Item${revision}`],
      tags: [`tag${revision}`],
    },
  }));
}
function setLifetimeVisibility(settings: ProjectsSettings, visible: boolean): void {
  for (const field of [
    ...settings.table.columns,
    ...expectDefined(settings.kanban).fields,
    ...(settings.timeline?.fields ?? []),
  ])
    if (['property:Link', 'property:Flag', 'property:Items', 'property:tags'].includes(field.id))
      field.visible = visible;
}
function recordOwnerFrames() {
  const pending = new Map<number, FrameRequestCallback>();
  let next = 0;
  let executed = 0;
  const callbacks: FrameRequestCallback[] = [];
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
    callbacks.push(callback);
    pending.set(++next, callback);
    return next;
  });
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => pending.delete(id));
  return {
    flush() {
      const frames = [...pending.values()];
      pending.clear();
      for (const callback of frames) {
        callback(0);
        executed++;
      }
    },
    executed: () => executed,
    callbacks,
  };
}
function ownedComponentCounts(component: Component): { children: number; cleanups: number } {
  const observed = MockComponent.fromOriginalType__(component);
  let children = observed._children.length;
  let cleanups = observed.cleanups__.length;
  for (const child of observed._children) {
    const nested = ownedComponentCounts(child.asOriginalType__());
    children += nested.children;
    cleanups += nested.cleanups;
  }
  return { children, cleanups };
}
function ownedMarkdownResources(
  groupResources?: Set<Component>,
  groupContent?: Set<Component>,
): Set<Component> {
  const live = new Set<Component>();
  vi.spyOn(MarkdownRenderer, 'render').mockImplementation(async (...args) => {
    const [, , holder, , owner] = args;
    const resource = owner.addChild(new Component());
    live.add(resource);
    if (holder.closest('.abyss-projects-group-label') !== null) {
      groupResources?.add(resource);
      groupContent?.add(owner);
    }
    resource.register(() => {
      live.delete(resource);
      groupResources?.delete(resource);
    });
    holder.createEl('a', {
      cls: 'internal-link',
      text: 'Target',
      attr: { 'data-href': 'Target' },
    });
  });
  return live;
}
async function finishMarkdown(): Promise<void> {
  await flushMicrotasks();
  await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
}
function heldLifetimeCells(surface: Surface): RenderedCellContext[] {
  return surface
    .renderedCells()
    .filter(
      (cell) =>
        cell.project.path === 'Projects/A.md' &&
        ['property:Link', 'property:Flag', 'property:Items', 'property:tags'].includes(
          cell.field.id,
        ),
    );
}

describe.each(cases)('retained row field/content resources in $mode', (testCase) => {
  it('retires held field hosts and descendants without unloading their surviving row', async () => {
    const frames = recordOwnerFrames();
    ownedMarkdownResources();
    const h = mountSurface(testCase, 0, configureLifetimeFields);
    h.view.update(lifetimeProjects(h.projects));
    frames.flush();
    await finishMarkdown();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const cells = heldLifetimeCells(h.surface);
    expect(cells).toHaveLength(4);
    const row = expectDefined(cells[0]?.markdown);
    const fieldUnloads = cells.map((cell) => vi.spyOn(cell.resources, 'unload'));
    const contentUnloads = cells.map((cell) =>
      vi.spyOn(expectDefined(cell.contentMarkdown), 'unload'),
    );
    const unload = vi.spyOn(row, 'unload');
    const name = expectDefined(nameCell(h.surface.renderedCells(), 'Projects/A.md'));
    const held = cells.flatMap((cell) =>
      Array.from(cell.element.querySelectorAll<HTMLElement>('a, button, input')),
    );
    expect(held.length).toBeGreaterThanOrEqual(4);
    const open = vi.spyOn(h.app.workspace, 'openLinkText');
    const hover = vi.spyOn(h.app.workspace, 'trigger');
    const selection = vi.spyOn(
      h.view as unknown as {
        selectCell_abyssPrivate(cell: RenderedCellContext, extend: boolean): void;
      },
      'selectCell_abyssPrivate',
    );
    setLifetimeVisibility(h.settings, false);
    h.view.update(lifetimeProjects(h.projects));
    expect(nameCell(h.surface.renderedCells(), 'Projects/A.md')).toBe(name);
    expect(name.markdown).toBe(row);
    expect(unload).not.toHaveBeenCalled();
    for (const cell of cells)
      expect(MockComponent.fromOriginalType__(row)._children).not.toContain(cell.resources);
    for (const retired of [...fieldUnloads, ...contentUnloads])
      expect(retired).toHaveBeenCalledOnce();
    const calls = selection.mock.calls.length;
    for (const cell of cells) {
      expect(cell.element.isConnected).toBe(false);
      for (const type of ['mousedown', 'click', 'focus', 'dblclick', 'contextmenu']) {
        const event = new MouseEvent(type, { cancelable: true, shiftKey: true });
        cell.element.dispatchEvent(event);
        expect.soft(event.defaultPrevented, `${cell.field.id}:${type}`).toBe(false);
      }
    }
    for (const node of held) {
      for (const type of ['click', 'mouseover', 'change']) {
        const event = new MouseEvent(type, { cancelable: true });
        node.dispatchEvent(event);
        expect.soft(event.defaultPrevented, `${node.tagName}:${type}`).toBe(false);
      }
    }
    await flushMicrotasks();
    expect.soft(selection.mock.calls).toHaveLength(calls);
    expect.soft(open).not.toHaveBeenCalled();
    expect.soft(hover.mock.calls.filter(([type]) => type === 'hover-link')).toEqual([]);
    expect.soft(h.applyEdits).not.toHaveBeenCalled();
    expect.soft(errors).not.toHaveBeenCalled();
    expect.soft(h.host.querySelector('.abyss-project-cell-editor')).toBeNull();
    h.view.destroy();
    mounted.delete(h.view);
    expect(unload).toHaveBeenCalledOnce();
    for (const retired of [...fieldUnloads, ...contentUnloads])
      expect(retired).toHaveBeenCalledOnce();
  });

  it('retires only old content while stable hosts use current fields exactly once', async () => {
    const frames = recordOwnerFrames();
    ownedMarkdownResources();
    const h = mountSurface(testCase, 0, configureLifetimeFields);
    h.view.update(lifetimeProjects(h.projects));
    frames.flush();
    await finishMarkdown();
    const cells = heldLifetimeCells(h.surface);
    const name = expectDefined(nameCell(h.surface.renderedCells(), 'Projects/A.md'));
    const oldName = expectDefined(name.element.querySelector('button'));
    const old = cells.flatMap((cell) =>
      Array.from(cell.element.querySelectorAll('a, button, input')),
    );
    const open = vi.spyOn(h.app.workspace, 'openLinkText');
    const hover = vi.spyOn(h.app.workspace, 'trigger');
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const select = vi.spyOn(
      h.view as unknown as {
        selectCell_abyssPrivate(cell: RenderedCellContext, extend: boolean): void;
      },
      'selectCell_abyssPrivate',
    );
    h.view.update(
      lifetimeProjects(h.projects, 1).map((item) => ({ ...item, name: `${item.name} updated` })),
    );
    frames.flush();
    await finishMarkdown();
    expect(heldLifetimeCells(h.surface)).toEqual(cells);
    for (const node of [...old, oldName]) {
      expect(node.isConnected).toBe(false);
      for (const type of ['click', 'mouseover', 'change']) {
        const event = new MouseEvent(type, { cancelable: true });
        node.dispatchEvent(event);
        expect.soft(event.defaultPrevented).toBe(false);
      }
    }
    await flushMicrotasks();
    expect.soft(h.applyEdits).not.toHaveBeenCalled();
    expect.soft(open).not.toHaveBeenCalled();
    expect.soft(hover.mock.calls.filter(([type]) => type === 'hover-link')).toEqual([]);
    expect.soft(errors).not.toHaveBeenCalled();
    select.mockClear();
    const flag = expectDefined(cells.find((cell) => cell.field.id === 'property:Flag'));
    flag.element.dispatchEvent(new MouseEvent('click'));
    expect(select).toHaveBeenCalledOnce();
    expect(select.mock.calls[0]?.[0].project.frontmatter['Flag']).toBe(false);
    const input = expectDefined(flag.element.querySelector('input'));
    input.checked = true;
    input.dispatchEvent(new Event('change'));
    await flushMicrotasks();
    expect(h.applyEdits).toHaveBeenCalledOnce();
  });

  it.each([false, true])(
    'does not wire or report retired Markdown after late callbacks (group labels=%s)',
    async (groupLabels) => {
      const frames = recordOwnerFrames();
      const pending: Array<{
        holder: HTMLElement;
        readonly reject: (error: Error) => void;
        readonly finish: () => void;
      }> = [];
      vi.spyOn(MarkdownRenderer, 'render').mockImplementation(
        (_app, _text, holder) =>
          new Promise<void>((resolve, reject) => {
            holder.createEl('a', {
              cls: 'internal-link',
              text: 'Old',
              attr: { 'data-href': 'Old' },
            });
            pending.push({
              holder,
              reject,
              finish: () => {
                holder.append('Late renderer content');
                resolve();
              },
            });
          }),
      );
      const h = mountSurface(testCase, 0, (settings) => {
        configureLifetimeFields(settings);
        if (groupLabels) {
          settings.table.groupBy = 'property:Link';
          expectDefined(settings.kanban).groupBy = 'property:Link';
          expectDefined(settings.timeline).groupBy = 'property:Link';
        }
      });
      const callbacks: Array<() => void> = [];
      const setTimer = setTimeout;
      vi.spyOn(window, 'setTimeout').mockImplementation((handler, timeout) => {
        callbacks.push(() => {
          handler();
        });
        return setTimer(handler, timeout);
      });
      h.view.update(lifetimeProjects(h.projects));
      frames.flush();
      expect(pending).toHaveLength(groupLabels ? 6 : 3);
      const retired = pending.splice(0);
      const late = callbacks.splice(0);
      if (groupLabels)
        h.settings.propertyDefinitions['property:Link'] = {
          type: 'text',
          presets: [{ value: '[[Target0]]', displayName: 'New group label' }],
        };
      h.view.update(lifetimeProjects(h.projects, groupLabels ? 0 : 1));
      frames.flush();
      const current = expectDefined(
        heldLifetimeCells(h.surface).find((cell) => cell.field.id === 'property:Link'),
      );
      await finishMarkdown();
      const html = current.element.innerHTML;
      const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
      const open = vi.spyOn(h.app.workspace, 'openLinkText');
      const hover = vi.spyOn(h.app.workspace, 'trigger');
      for (const [index, { holder, reject, finish }] of retired.entries()) {
        // A captured native callback may arrive even after cancellation. Reconnection must not
        // grant a retired render permission to wire links or publish its failure.
        document.body.append(holder);
        if (index % 2 === 0) reject(new Error('retired Markdown failure'));
        else finish();
      }
      for (const callback of late) callback();
      for (const { holder } of retired) {
        const anchor = expectDefined(holder.querySelector('a'));
        anchor.dispatchEvent(new MouseEvent('click', { cancelable: true }));
        anchor.dispatchEvent(new MouseEvent('mouseover'));
      }
      await finishMarkdown();
      expect.soft(errors).not.toHaveBeenCalled();
      expect.soft(open).not.toHaveBeenCalled();
      expect.soft(hover.mock.calls.filter(([type]) => type === 'hover-link')).toEqual([]);
      expect(current.element.innerHTML).toBe(html);
      h.view.destroy();
      mounted.delete(h.view);
      for (const { reject } of pending) reject(new Error('unloaded Markdown failure'));
      await flushMicrotasks();
      expect.soft(errors).not.toHaveBeenCalled();
    },
  );

  it('bounds settled Markdown child membership over twenty content and field replacements', async () => {
    const frames = recordOwnerFrames();
    const live = ownedMarkdownResources();
    const h = mountSurface(testCase, 0, configureLifetimeFields);
    h.view.update(lifetimeProjects(h.projects));
    frames.flush();
    await finishMarkdown();
    const name = expectDefined(nameCell(h.surface.renderedCells(), 'Projects/A.md'));
    const retained = live.size;
    const row = name.markdown;
    const baseline = ownedComponentCounts(row);
    expect(retained).toBeGreaterThan(0);
    for (let cycle = 1; cycle <= 20; cycle++) {
      h.view.update(lifetimeProjects(h.projects, cycle));
      setLifetimeVisibility(h.settings, false);
      h.view.update(lifetimeProjects(h.projects, cycle));
      setLifetimeVisibility(h.settings, true);
      h.view.update(lifetimeProjects(h.projects, cycle));
      frames.flush();
      await finishMarkdown();
      expect(nameCell(h.surface.renderedCells(), 'Projects/A.md')).toBe(name);
      const settled = ownedComponentCounts(row);
      expect.soft(settled.children).toBeLessThanOrEqual(baseline.children);
      expect.soft(settled.cleanups).toBeLessThanOrEqual(baseline.cleanups);
    }
    if (testCase.mode !== 'Table') expect(frames.executed()).toBeGreaterThan(0);
    expect.soft(live.size).toBeLessThanOrEqual(retained);
    h.view.destroy();
    mounted.delete(h.view);
    expect(live.size).toBe(0);
    expect(ownedComponentCounts(row)).toEqual({ children: 0, cleanups: 0 });
  });
});

describe.each(cases)('retained group label resources in $mode', (testCase) => {
  it('retires replaced label anchors and children while retaining the header', async () => {
    const frames = recordOwnerFrames();
    const groups = new Set<Component>();
    const groupContent = new Set<Component>();
    const children = vi.spyOn(Component.prototype, 'addChild');
    const live = ownedMarkdownResources(groups, groupContent);
    const h = mountSurface(testCase, 0, (settings) => {
      configureLifetimeFields(settings);
      settings.table.groupBy = 'property:Link';
      expectDefined(settings.kanban).groupBy = 'property:Link';
      expectDefined(settings.timeline).groupBy = 'property:Link';
    });
    const listed = lifetimeProjects(h.projects);
    h.view.update(listed);
    frames.flush();
    await finishMarkdown();
    const labelHeader = () =>
      testCase.mode === 'Kanban'
        ? expectDefined(
            h.host.querySelector<HTMLElement>('.abyss-project-kanban-group-header:not([hidden])'),
          )
        : testCase.groupHeader(h.host, 'Projects/A.md');
    const header = labelHeader();
    const anchor = expectDefined(header.querySelector<HTMLElement>('a.internal-link'));
    const retained = live.size;
    const retainedGroups = groups.size;
    const groupOwners = [...groupContent].map((content) => {
      const index = children.mock.calls.findIndex(([child]) => child === content);
      const owner = children.mock.contexts[index];
      if (!(owner instanceof Component)) throw new Error('Group content was not parent-owned');
      return { owner, counts: ownedComponentCounts(owner) };
    });
    expect(retainedGroups).toBeGreaterThan(0);
    const open = vi.spyOn(h.app.workspace, 'openLinkText');
    const hover = vi.spyOn(h.app.workspace, 'trigger');
    for (let revision = 1; revision <= 20; revision++) {
      h.settings.propertyDefinitions['property:Link'] = {
        type: 'text',
        presets: [{ value: '[[Target0]]', displayName: `Label ${revision}` }],
      };
      h.view.update(listed);
      frames.flush();
      await finishMarkdown();
      expect(labelHeader()).toBe(header);
      for (const { owner, counts } of groupOwners) {
        const settled = ownedComponentCounts(owner);
        expect.soft(settled.children).toBeLessThanOrEqual(counts.children);
        expect.soft(settled.cleanups).toBeLessThanOrEqual(counts.cleanups);
      }
    }
    expect(anchor.isConnected).toBe(false);
    anchor.dispatchEvent(new MouseEvent('click', { cancelable: true }));
    anchor.dispatchEvent(new MouseEvent('mouseover'));
    await flushMicrotasks();
    expect.soft(open).not.toHaveBeenCalled();
    expect.soft(hover.mock.calls.filter(([type]) => type === 'hover-link')).toEqual([]);
    if (testCase.mode !== 'Table') expect(frames.executed()).toBeGreaterThan(0);
    expect.soft(live.size).toBeLessThanOrEqual(retained);
    expect.soft(groups.size).toBeLessThanOrEqual(retainedGroups);
    h.view.destroy();
    mounted.delete(h.view);
    expect(live.size).toBe(0);
    expect(groups.size).toBe(0);
    for (const { owner } of groupOwners)
      expect(ownedComponentCounts(owner)).toEqual({ children: 0, cleanups: 0 });
  });
});

describe.each(cases)('full-range resource audit in $mode', (testCase) => {
  it('plateaus actual mounted owners over twenty cycles at 1000 and 10000 projects', async () => {
    const mountedCounts: number[] = [];
    for (const count of [1000, 10000]) {
      const frames = recordOwnerFrames();
      const resources = recordVirtualSurfaceResources();
      const markdown = ownedMarkdownResources();
      const h = mountSurface(testCase, count - 3, (settings) => {
        configureLifetimeFields(settings);
        settings.table.groupBy = 'none';
        if (settings.kanban !== undefined) settings.kanban.groupBy = 'none';
        if (settings.timeline !== undefined) settings.timeline.groupBy = 'none';
      });
      h.view.update(lifetimeProjects(h.projects));
      frames.flush();
      await finishMarkdown();
      expect(h.surface.cells().rowIds).toHaveLength(count);
      const first = expectDefined(h.surface.renderedCells()[0]);
      const last = expectDefined(
        h.surface.cells().identities[h.surface.cells().identities.length - 1],
      );
      let release: () => void;
      if (testCase.mode === 'Table') {
        first.element.addClass('is-editor-anchor');
        release = () => {
          first.element.removeClass('is-editor-anchor');
        };
      } else if (testCase.mode === 'Kanban') {
        release = (
          h.surface as Surface & { pinEditorCell(el: HTMLElement): () => void }
        ).pinEditorCell(first.element);
      } else {
        const timeline = h.surface as Surface & {
          setEditingCell(el: HTMLElement | undefined): void;
        };
        timeline.setEditingCell(first.element);
        release = () => {
          timeline.setEditingCell(undefined);
        };
      }
      const retained = resources.counts();
      const initial = h.surface.renderedCells().length;
      const retainedMarkdown = markdown.size;
      mountedCounts.push(initial);
      expect(retained.components).toBeGreaterThan(0);
      expect(retained.observers).toBeGreaterThan(0);
      expect(retainedMarkdown).toBeGreaterThan(0);
      for (let cycle = 0; cycle < 20; cycle++) {
        h.surface.revealCell(last);
        frames.flush();
        h.surface.revealCell(first.identity);
        frames.flush();
        await finishMarkdown();
        expect(first.element.isConnected).toBe(true);
        expect(resources.counts()).toEqual(retained);
        expect(markdown.size).toBeLessThanOrEqual(retainedMarkdown);
        expect(h.surface.renderedCells().length).toBeLessThanOrEqual(initial);
      }
      release();
      h.view.destroy();
      mounted.delete(h.view);
      frames.flush();
      expect(resources.counts()).toEqual({ components: 0, listeners: 0, observers: 0, targets: 0 });
      expect(markdown.size).toBe(0);
      h.host.remove();
      vi.restoreAllMocks();
    }
    expect(expectDefined(mountedCounts[1])).toBeLessThanOrEqual(
      expectDefined(mountedCounts[0]) * 1.1,
    );
  });

  it('keeps a large collapsed group header-only and reveals its last logical project', async () => {
    const frames = recordOwnerFrames();
    const h = mountSurface(testCase, 9997, (settings) => {
      settings.table.groupBy = 'status';
      if (settings.kanban !== undefined) settings.kanban.groupBy = 'property:Budget';
      if (settings.timeline !== undefined) settings.timeline.groupBy = 'status';
    });
    // One real group contains every project, independent of the extra status columns.
    const all = h.projects.map((item) => ({
      ...item,
      frontmatter: { Budget: 42 },
      statusId: expectDefined(h.projects[0]).statusId,
    }));
    h.view.update(all);
    frames.flush();
    const toggle =
      testCase.mode === 'Kanban'
        ? expectDefined(
            h.host.querySelector<HTMLElement>('.abyss-project-kanban-group-header:not([hidden])'),
          )
        : testCase.groupHeader(h.host, 'Projects/A.md');
    toggle.click();
    await finishMarkdown();
    frames.flush();
    expect(h.surface.cells().rowIds).toHaveLength(0);
    expect(h.surface.renderedCells()).toHaveLength(0);
    expect(toggle.isConnected).toBe(true);
    expect(h.host.querySelector('.abyss-project-table-count')?.textContent).toBe('10000 projects');
    const last = expectDefined(all[all.length - 1]);
    h.surface.revealProject(last.path);
    frames.flush();
    expect(h.surface.cells().rowIds).toHaveLength(10000);
    h.surface.revealCell(expectDefined(nameCell(h.surface.cells().cells, last.path)).identity);
    frames.flush();
    expect(nameCell(h.surface.renderedCells(), last.path)).toBeDefined();
    expect(h.surface.renderedCells().length).toBeLessThan(200);
  });
});

describe.each(cases)('native layout audit in $mode', (testCase) => {
  it.each([
    'style',
    'font completion',
    'font-weight',
    'font-style',
    'letter-spacing',
    'width',
    'resume',
    ...(testCase.mode === 'Table' ? ['column preview'] : []),
  ])('invalidates an offscreen measured row after %s', (change) => {
    Object.defineProperty(document, 'fonts', { value: new EventTarget(), configurable: true });
    let width = 600;
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(() => width);
    const frames = recordOwnerFrames();
    const resources = recordVirtualSurfaceResources();
    const resize = (): void => {
      for (const callback of resources.callbacks) callback([], {} as ResizeObserver);
    };
    let tall = true;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement,
    ) {
      const isRow = [
        'abyss-project-table-row',
        'abyss-project-kanban-group',
        'abyss-project-timeline-row',
      ].some((name) => this.classList.contains(name));
      const path =
        this.dataset['projectPath'] ??
        this.querySelector<HTMLElement>('.abyss-project-kanban-card')?.dataset['projectPath'];
      let height = 0;
      if (isRow && path === 'Projects/A.md') height = tall ? 10000 : 80;
      return rectangle(0, 0, 600, height);
    });
    const h = mountSurface(testCase, 997, (settings) => {
      settings.table.groupBy = 'none';
      if (settings.kanban !== undefined) settings.kanban.groupBy = 'none';
      if (settings.timeline !== undefined) settings.timeline.groupBy = 'none';
    });
    frames.flush();
    expect(h.surface.renderedCells().some((cell) => cell.project.path === 'Projects/A.md')).toBe(
      true,
    );
    const last = expectDefined(
      nameCell(h.surface.cells().cells, expectDefined(h.projects[h.projects.length - 1]).path),
    ).identity;
    h.surface.revealCell(last);
    frames.flush();
    h.surface.revealCell(last);
    const lastCell = expectDefined(
      h.surface.renderedCells().find((cell) => cell.identity.occurrenceId === last.occurrenceId),
    );
    const scroll = testCase.viewport(h.surface, lastCell.element).vertical;
    const before = scroll.scrollTop;
    const currentElement = lastCell.element;
    scroll.scrollLeft = 17.25;
    resize();
    frames.flush();
    expect(scroll.scrollTop).toBe(before);
    expect(lastCell.element).toBe(currentElement);
    expect(scroll.scrollLeft).toBe(17.25);
    tall = false;
    const root = expectDefined(
      h.host.querySelector<HTMLElement>(
        {
          Table: '.abyss-project-table',
          Kanban: '.abyss-project-kanban-window',
          Timeline: '.abyss-project-timeline',
        }[testCase.mode],
      ),
    );
    const priorFont = window.getComputedStyle(root).fontSize;
    if (change === 'style') {
      const layoutStyle = { 'font-size': `${24}px` };
      root.setCssProps(layoutStyle);
      expect(window.getComputedStyle(root).fontSize).not.toBe(priorFont);
      resize();
    } else if (['font-weight', 'font-style', 'letter-spacing'].includes(change)) {
      const property = change;
      const beforeMetric = window.getComputedStyle(root).getPropertyValue(property);
      const values: Record<string, string> = {
        'font-weight': '900',
        'font-style': 'italic',
        'letter-spacing': '2px',
      };
      const value = values[property];
      root.setCssProps({ [property]: expectDefined(value) });
      expect(window.getComputedStyle(root).getPropertyValue(property)).not.toBe(beforeMetric);
      resize();
    } else if (change === 'width') {
      width = 500;
      resize();
    } else if (change === 'column preview') {
      const columns = JSON.stringify(h.settings.table.columns);
      const handle = expectDefined(
        h.host.querySelector<HTMLElement>('.abyss-project-column-resize'),
      );
      handle.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: 100 }));
      document.dispatchEvent(new PointerEvent('pointermove', { clientX: 200 }));
      resize();
      frames.flush();
      expect(JSON.stringify(h.settings.table.columns)).toBe(columns);
    } else if (change === 'resume') {
      h.surface.captureViewportBeforeHide();
      h.surface.hide();
      h.surface.show();
      h.view.update(h.projects);
    } else {
      expect(window.getComputedStyle(root).fontSize).toBe(priorFont);
      root.ownerDocument.fonts.dispatchEvent(new Event('loadingdone'));
    }
    frames.flush();
    h.surface.revealCell(last);
    frames.flush();
    expect(scroll.scrollTop).toBeLessThan(before);
  });
});

function invokeHeldListeners(
  listeners: ReadonlyArray<EventListenerOrEventListenerObject | null>,
  type: string,
): void {
  for (const listener of listeners) if (typeof listener === 'function') listener(new Event(type));
}

describe.each(cases)('live native document audit in $mode', (testCase) => {
  it('recreates the active native size observer after adopting its real mounted host', async () => {
    const oldFonts = new EventTarget();
    Object.defineProperty(document, 'fonts', { value: oldFonts, configurable: true });
    const oldFontAdds = vi.spyOn(oldFonts, 'addEventListener');
    const oldFontRemoves = vi.spyOn(oldFonts, 'removeEventListener');
    const oldWindowAdds = vi.spyOn(window, 'addEventListener');
    const mainFrames = recordOwnerFrames();
    const resources = recordVirtualSurfaceResources();
    const h = mountSurface(testCase, 97, (settings) => {
      settings.table.groupBy = 'none';
      if (settings.kanban !== undefined) settings.kanban.groupBy = 'none';
      if (settings.timeline !== undefined) settings.timeline.groupBy = 'none';
    });
    mainFrames.flush();
    const oldCallbacks = [...resources.callbacks];
    for (const callback of oldCallbacks) callback([], {} as ResizeObserver);
    const oldFrames = [...mainFrames.callbacks];
    const oldResizeListeners = oldWindowAdds.mock.calls.filter(([type]) => type === 'resize');
    const iframe = document.body.createEl('iframe');
    const doc = expectDefined(iframe.contentDocument);
    const win = expectDefined(iframe.contentWindow);
    const FontTarget = Reflect.get(win, 'EventTarget') as typeof EventTarget;
    const newFonts = new FontTarget();
    const newFontAdds = vi.spyOn(newFonts, 'addEventListener');
    const newFontRemoves = vi.spyOn(newFonts, 'removeEventListener');
    Object.defineProperty(doc, 'fonts', { value: newFonts, configurable: true });
    Object.defineProperty(win, 'ResizeObserver', {
      value: window.ResizeObserver,
      configurable: true,
    });
    const construct = vi.fn();
    const Observer = window.ResizeObserver;
    Object.defineProperty(win, 'ResizeObserver', {
      configurable: true,
      value: class extends Observer {
        constructor(callback: ResizeObserverCallback) {
          super(callback);
          construct();
        }
      },
    });
    const pending: FrameRequestCallback[] = [];
    vi.spyOn(win, 'requestAnimationFrame').mockImplementation((callback) => {
      pending.push(callback);
      return pending.length;
    });
    vi.spyOn(win, 'cancelAnimationFrame').mockImplementation(() => {});
    doc.body.append(h.host);
    h.view.update(h.projects);
    for (const callback of pending.splice(0)) callback(0);
    await finishMarkdown();
    expect(construct).toHaveBeenCalled();
    const bindings = construct.mock.calls.length;
    for (const callback of resources.callbacks.slice(oldCallbacks.length))
      callback([], {} as ResizeObserver);
    const newPending = pending.length;
    expect(newPending).toBeGreaterThan(0);
    for (const callback of oldCallbacks) callback([], {} as ResizeObserver);
    for (const callback of oldFrames) callback(0);
    invokeHeldListeners(
      oldFontAdds.mock.calls.map(([, listener]) => listener),
      'loadingdone',
    );
    invokeHeldListeners(
      oldResizeListeners.map(([, listener]) => listener),
      'resize',
    );
    expect(oldFontRemoves.mock.calls).toHaveLength(oldFontAdds.mock.calls.length);
    mainFrames.flush();
    expect(pending).toHaveLength(newPending);
    for (const callback of pending.splice(0)) callback(0);
    newFonts.dispatchEvent(new Event('loadingdone'));
    expect(pending.length).toBeGreaterThan(0);
    for (const callback of pending.splice(0)) callback(0);
    h.view.update(h.projects);
    expect(construct).toHaveBeenCalledTimes(bindings);
    const mountedBefore = h.surface.renderedCells().length;
    expect(mountedBefore).toBeGreaterThan(0);
    h.view.destroy();
    mounted.delete(h.view);
    expect(newFontRemoves.mock.calls).toHaveLength(newFontAdds.mock.calls.length);
    invokeHeldListeners(
      newFontAdds.mock.calls.map(([, listener]) => listener),
      'loadingdone',
    );
    for (const callback of pending.splice(0)) callback(0);
    for (const callback of resources.callbacks) callback([], {} as ResizeObserver);
    mainFrames.flush();
    expect(resources.observers.size).toBe(0);
    expect(resources.observed.size).toBe(0);
    expect(resources.liveComponents.size).toBe(0);
    expect(pending).toHaveLength(0);
  });
});

describe.each(cases)('owning background text failure in $mode', (testCase) => {
  it.each(['initial', 'later'] as const)(
    'reports a live %s rejected text render once in the owning visible alert',
    async (phase) => {
      const frames = recordOwnerFrames();
      const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => {});
      const render = vi.spyOn(MarkdownRenderer, 'render').mockResolvedValue(undefined);
      const h = mountSurface(testCase, 997, configureLifetimeFields);
      let reject!: (error: Error) => void;
      const failNext = () =>
        render.mockImplementationOnce(
          () =>
            new Promise<void>((_resolve, fail) => {
              reject = fail;
            }),
        );
      if (phase === 'initial') failNext();
      h.view.update(lifetimeProjects(h.projects));
      frames.flush();
      await finishMarkdown();
      if (phase === 'later') {
        failNext();
        const target = expectDefined(
          nameCell(h.surface.cells().cells, expectDefined(h.projects[h.projects.length - 1]).path),
        );
        h.surface.revealCell(target.identity);
        frames.flush();
      }
      const error = new Error('project text unavailable');
      reject(error);
      await finishMarkdown();
      expect(diagnostic).toHaveBeenCalledTimes(1);
      expect(diagnostic.mock.calls[0]?.[0]).toMatch(/^\[abyss-tasks\]/u);
      expect(
        h.host.querySelector('.abyss-project-table-feedback[role="alert"]')?.textContent,
      ).toContain(error.message);
      expect(h.applyEdits).not.toHaveBeenCalled();
    },
  );
});

describe.each(cases)('owning thrown mount failure in $mode', (testCase) => {
  it.each(['initial', 'later'] as const)(
    'contains a live %s thrown mounted-field render and reports once visibly',
    async (phase) => {
      const frames = recordOwnerFrames();
      const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => {});
      const render = vi.spyOn(MarkdownRenderer, 'render').mockResolvedValue(undefined);
      const h = mountSurface(testCase, 997, configureLifetimeFields);
      const error = new Error('project mount unavailable');
      const failNext = () =>
        render.mockImplementationOnce(() => {
          throw error;
        });
      if (phase === 'initial') {
        failNext();
        expect(() => {
          h.view.update(lifetimeProjects(h.projects));
        }).not.toThrow();
      } else {
        h.view.update(lifetimeProjects(h.projects));
        frames.flush();
        await finishMarkdown();
        failNext();
        const target = expectDefined(
          nameCell(h.surface.cells().cells, expectDefined(h.projects[h.projects.length - 1]).path),
        );
        expect(() => {
          h.surface.revealCell(target.identity);
        }).not.toThrow();
      }
      await finishMarkdown();
      expect(diagnostic).toHaveBeenCalledTimes(1);
      expect(diagnostic.mock.calls[0]?.[0]).toMatch(/^\[abyss-tasks\]/u);
      expect(
        h.host.querySelector('.abyss-project-table-feedback[role="alert"]')?.textContent,
      ).toContain(error.message);
      expect(h.applyEdits).not.toHaveBeenCalled();
    },
  );
});

it.each([1200.25, -0.75])('never writes ordinary Table native scroll %s', (top) => {
  const frames = recordOwnerFrames();
  const h = mountSurface(expectDefined(cases[0]), 997);
  frames.flush();
  const scroll = expectDefined(h.host.querySelector<HTMLElement>('.abyss-project-table-scroll'));
  const write = vi.fn();
  Object.defineProperty(scroll, 'scrollTop', { configurable: true, get: () => top, set: write });
  scroll.scrollLeft = 17.25;
  scroll.dispatchEvent(new Event('scroll'));
  frames.flush();
  expect(write).not.toHaveBeenCalled();
  expect(scroll.scrollLeft).toBe(17.25);
});

function recordedNotices() {
  return vi
    .spyOn(
      Notice.prototype as unknown as { constructor__(message: unknown): void },
      'constructor__',
    )
    .mockImplementation(() => {});
}

describe.each(cases)('finite failure recovery in $mode', (testCase) => {
  it.each([false, true])(
    'reports and retries one failed content generation (group=%s)',
    async (group) => {
      const frames = recordOwnerFrames();
      const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => {});
      const notices = recordedNotices();
      const h = mountSurface(testCase, 0, (settings) => {
        configureLifetimeFields(settings);
        if (group) {
          settings.table.groupBy = 'property:Link';
          expectDefined(settings.kanban).groupBy = 'property:Link';
          expectDefined(settings.timeline).groupBy = 'property:Link';
        }
      });
      let failure:
        { holder: HTMLElement; owner: Component; reject: (error: Error) => void } | undefined;
      let failed = false;
      const render = vi.spyOn(MarkdownRenderer, 'render').mockImplementation(async (...args) => {
        const [, , holder, , owner] = args;
        const label = holder.closest('.abyss-projects-group-label') !== null;
        if (!failed && label === group) {
          failed = true;
          await new Promise<void>((_resolve, reject) => {
            failure = { holder, owner, reject };
          });
        } else holder.createSpan({ text: 'rendered successfully' });
      });
      const listed = lifetimeProjects(h.projects);
      h.view.update(listed);
      frames.flush();
      await finishMarkdown();
      const pending = expectDefined(failure);
      const unload = vi.spyOn(pending.owner, 'unload');
      pending.reject(new Error('retry this generation'));
      await finishMarkdown();
      expect(diagnostic).toHaveBeenCalledOnce();
      expect(notices).toHaveBeenCalledOnce();
      expect(notices.mock.calls[0]?.[0]).toContain(testCase.mode);
      expect(h.host.querySelector('[role="alert"]')?.textContent).toContain(
        'retry this generation',
      );
      const previousCalls = render.mock.calls.length;
      h.view.update(listed);
      frames.flush();
      await finishMarkdown();
      expect(render.mock.calls.length).toBeGreaterThan(previousCalls);
      expect(pending.holder.isConnected).toBe(false);
      expect(unload).toHaveBeenCalledOnce();
      expect(h.host.textContent).toContain('rendered successfully');
      expect(diagnostic).toHaveBeenCalledOnce();
      expect(notices).toHaveBeenCalledOnce();
      expect(h.applyEdits).not.toHaveBeenCalled();
    },
  );
});

it.each(['update', 'reveal', 'frame'] as const)(
  'Table cleans failed content during %s and recovers around a pinned editor',
  async (entry) => {
    const frames = recordOwnerFrames();
    const resources = recordVirtualSurfaceResources();
    const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => {});
    const notices = recordedNotices();
    const render = vi.spyOn(MarkdownRenderer, 'render').mockResolvedValue(undefined);
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(600);
    const h = mountSurface(expectDefined(cases[0]), 997, configureLifetimeFields);
    const listed = lifetimeProjects(h.projects);
    h.view.update(listed);
    frames.flush();
    await finishMarkdown();
    const pinned = expectDefined(nameCell(h.surface.renderedCells(), 'Projects/A.md'));
    pinned.element.addClass('is-editor-anchor', 'is-editing');
    const input = pinned.element.createEl('input');
    input.value = 'ongoing draft';
    input.focus();
    const rowOwner = pinned.markdown;
    const healthyField = pinned.resources;
    const priorOwnerCount = ownedComponentCounts(healthyField);
    let failedOwner: Component | undefined;
    render.mockImplementationOnce((...args) => {
      const owner = args[4];
      failedOwner = owner;
      owner.addChild(new Component());
      throw new Error('partial mount unavailable');
    });
    const scroll = expectDefined(h.host.querySelector<HTMLElement>('.abyss-project-table-scroll'));
    if (entry === 'update') h.view.update(lifetimeProjects(h.projects, 1));
    else if (entry === 'reveal')
      h.surface.revealCell(
        expectDefined(nameCell(h.surface.cells().cells, expectDefined(listed[900]).path)).identity,
      );
    else {
      scroll.scrollTop = 30000;
      for (const callback of resources.callbacks) callback([], {} as ResizeObserver);
      expect(() => {
        frames.flush();
      }).not.toThrow();
    }
    expect(diagnostic).toHaveBeenCalledOnce();
    expect(notices).toHaveBeenCalledOnce();
    const failedContent = expectDefined(failedOwner);
    expect(resources.liveComponents.has(failedContent)).toBe(false);
    expect(ownedComponentCounts(failedContent).children).toBe(0);
    expect(pinned.element.isConnected).toBe(true);
    expect(pinned.markdown).toBe(rowOwner);
    expect(pinned.resources).toBe(healthyField);
    expect(ownedComponentCounts(healthyField)).toEqual(priorOwnerCount);
    expect(document.activeElement).toBe(input);
    expect(input.value).toBe('ongoing draft');
    const attempts = render.mock.calls.length;
    for (const callback of resources.callbacks) callback([], {} as ResizeObserver);
    scroll.dispatchEvent(new Event('scroll'));
    frames.flush();
    expect(render).toHaveBeenCalledTimes(attempts);
    expect(diagnostic).toHaveBeenCalledOnce();
    h.view.update(lifetimeProjects(h.projects, 2));
    frames.flush();
    await finishMarkdown();
    expect(render.mock.calls.length).toBeGreaterThan(attempts);
    expect(pinned.element.isConnected).toBe(true);
    expect(input.isConnected).toBe(true);
    expect(input.value).toBe('ongoing draft');
    expect(h.applyEdits).not.toHaveBeenCalled();
    h.view.destroy();
    mounted.delete(h.view);
    expect(resources.liveComponents.size).toBe(0);
  },
);

it('Table native failure leaves the actual controller editor and its draft focused', async () => {
  const frames = recordOwnerFrames();
  const render = vi.spyOn(MarkdownRenderer, 'render').mockResolvedValue(undefined);
  const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => {});
  const h = mountSurface(expectDefined(cases[0]), 997, configureLifetimeFields);
  h.view.update(lifetimeProjects(h.projects));
  frames.flush();
  await finishMarkdown();
  const cell = expectDefined(
    h.surface.renderedCells().find((item) => item.field.id === 'property:Link'),
  );
  cell.element.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  const editor = expectDefined(
    h.host.querySelector<HTMLInputElement | HTMLTextAreaElement>('.abyss-project-editor-input'),
  );
  editor.value = 'Unsubmitted draft';
  editor.focus();
  render.mockImplementationOnce(() => {
    throw new Error('new distant row failed');
  });
  h.surface.revealCell(
    expectDefined(nameCell(h.surface.cells().cells, expectDefined(h.projects[900]).path)).identity,
  );
  expect(diagnostic).toHaveBeenCalledOnce();
  expect(cell.element.isConnected).toBe(true);
  expect(document.activeElement).toBe(editor);
  expect(editor.value).toBe('Unsubmitted draft');
  expect(h.applyEdits).not.toHaveBeenCalled();
});

describe.each(cases)('native fractional anchor in $mode', (testCase) => {
  it('preserves a surviving fractional offset and pinned node across font completion', () => {
    Object.defineProperty(document, 'fonts', { value: new EventTarget(), configurable: true });
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(600);
    const frames = recordOwnerFrames();
    let tall = true;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement,
    ) {
      const path =
        this.dataset['projectPath'] ??
        this.querySelector<HTMLElement>('.abyss-project-kanban-card')?.dataset['projectPath'];
      const isRow = [
        'abyss-project-table-row',
        'abyss-project-kanban-group',
        'abyss-project-timeline-row',
      ].some((name) => this.classList.contains(name));
      return rectangle(0, 0, 600, isRow && path === 'Projects/A.md' && tall ? 10000 : 0);
    });
    const h = mountSurface(testCase, 997, (settings) => {
      settings.table.groupBy = 'none';
      if (settings.kanban !== undefined) settings.kanban.groupBy = 'none';
      if (settings.timeline !== undefined) settings.timeline.groupBy = 'none';
    });
    frames.flush();
    const target = expectDefined(
      nameCell(h.surface.cells().cells, expectDefined(h.projects[700]).path),
    );
    h.surface.revealCell(target.identity);
    frames.flush();
    const mountedCell = expectDefined(
      h.surface
        .renderedCells()
        .find((cell) => cell.identity.occurrenceId === target.identity.occurrenceId),
    );
    const element = mountedCell.element;
    element.focus();
    const scroll = testCase.viewport(h.surface, element).vertical;
    scroll.scrollTop += 0.25;
    scroll.scrollLeft = 17.25;
    const before = scroll.scrollTop;
    tall = false;
    document.fonts.dispatchEvent(new Event('loadingdone'));
    frames.flush();
    expect(scroll.scrollTop).toBeLessThan(before);
    expect(scroll.scrollTop % 1).toBe(0.25);
    expect(scroll.scrollLeft).toBe(17.25);
    expect(element.isConnected).toBe(true);
    expect(document.activeElement).toBe(element);
    expect(h.applyEdits).not.toHaveBeenCalled();
  });
});

it('Table removes a newly failed group content owner and retries its original group', async () => {
  const frames = recordOwnerFrames();
  const resources = recordVirtualSurfaceResources();
  const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => {});
  const notices = recordedNotices();
  const h = mountSurface(expectDefined(cases[0]), 0, (settings) => {
    configureLifetimeFields(settings);
    settings.table.groupBy = 'property:Link';
  });
  let failedOwner: Component | undefined;
  const render = vi.spyOn(MarkdownRenderer, 'render').mockImplementation((...args) => {
    const [, , holder, , owner] = args;
    if (failedOwner === undefined && holder.closest('.abyss-projects-group-label') !== null) {
      failedOwner = owner;
      owner.addChild(new Component());
      throw new Error('group mount failed');
    }
    return Promise.resolve();
  });
  const listed = lifetimeProjects(h.projects);
  expect(() => {
    h.view.update(listed);
  }).not.toThrow();
  expect(diagnostic).toHaveBeenCalledOnce();
  expect(notices).toHaveBeenCalledOnce();
  const failed = expectDefined(failedOwner);
  expect(resources.liveComponents.has(failed)).toBe(false);
  expect(ownedComponentCounts(failed).children).toBe(0);
  const calls = render.mock.calls.length;
  h.view.update(listed);
  frames.flush();
  await finishMarkdown();
  expect(render.mock.calls.length).toBeGreaterThan(calls);
  expect(h.surface.renderedCells().length).toBeGreaterThan(0);
  expect(diagnostic).toHaveBeenCalledOnce();
  expect(h.applyEdits).not.toHaveBeenCalled();
  h.view.destroy();
  mounted.delete(h.view);
  expect(resources.liveComponents.size).toBe(0);
});
