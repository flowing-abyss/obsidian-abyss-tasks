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
function mountSurface(testCase: SurfaceCase, extra = 0) {
  const originalHeight = Object.getOwnPropertyDescriptor(Element.prototype, 'clientHeight');
  vi.spyOn(Element.prototype, 'clientHeight', 'get').mockImplementation(function (
    this: HTMLElement,
  ) {
    return this.classList.contains('abyss-project-timeline-scroll')
      ? 400
      : Number(originalHeight?.get?.call(this) ?? 0);
  });
  const host = freshContainer();
  activeDocument.body.append(host);
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.projects.propertyDefinitions['property:Budget'] = { type: 'number' };
  testCase.group(settings.projects);
  const listed = [...projects(), ...fillers(extra)];
  const applyEdits = vi.fn(async (): Promise<ProjectEditResult> =>
    Promise.resolve({ applied: [], failed: [] }),
  );
  const view = new ProjectsTableView(host, {
    app: appWithFiles(Object.fromEntries(listed.map(({ path }) => [path, '']))),
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
  return { host, view, projects: listed, surface: expectDefined(testCase.surface(view)) };
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
