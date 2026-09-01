// eslint-disable-next-line import/no-nodejs-modules -- UI regression loads the shipped stylesheet.
import { readFileSync } from 'node:fs';
import { Menu, type MenuItem } from 'obsidian';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppState } from '../src/app/AppState';
import {
  createWorkNoteBoardMutation,
  workNoteBoardColumns,
} from '../src/panels/projects/boardProjection';
import { renderProjectDashboard } from '../src/panels/projects/ProjectsDashboardView';
import { ProjectWorkspaceSession } from '../src/panels/projects/ProjectWorkspaceSession';
import {
  WORK_NOTE_FALLBACK_VISIBLE_ROWS,
  WORK_NOTE_OVERSCAN,
  WORK_NOTE_ROW_EXTENT,
  renderWorkNotesView,
  selectWorkNotes,
} from '../src/panels/projects/WorkNotesView';
import type { ProjectWorkspaceSnapshot } from '../src/projects/types';
import type { WorkNoteSnapshot } from '../src/projects/work-notes/types';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import { flushMicrotasks, freshContainer } from './helpers';

const shippedStyles = readFileSync(`${import.meta.dirname}/../styles.css`, 'utf8');

interface CapturedMenuItem {
  title: string;
  click: () => unknown;
}

function captureMenuItems(): CapturedMenuItem[] {
  const captured: CapturedMenuItem[] = [];
  vi.spyOn(Menu.prototype, 'addItem').mockImplementation(function (this: Menu, build) {
    let title = '';
    let click = (): unknown => undefined;
    const item = {
      setTitle(value: string) {
        title = value;
        return this;
      },
      setIcon() {
        return this;
      },
      setChecked() {
        return this;
      },
      setDisabled() {
        return this;
      },
      onClick(callback: () => unknown) {
        click = callback;
        captured.push({
          get title() {
            return title;
          },
          click: () => click(),
        });
        return this;
      },
    } as unknown as MenuItem;
    build(item);
    return this;
  });
  return captured;
}

afterEach(() => vi.restoreAllMocks());

function note(index: number, over: Partial<WorkNoteSnapshot> = {}): WorkNoteSnapshot {
  const ordinal = String(index).padStart(3, '0');
  return {
    path: `Work Notes/Work note ${ordinal}.md`,
    presetRevision: 7,
    presetFingerprint: 'fixture-fingerprint',
    kind: 'ordinary',
    projectPath: 'Projects/P.md',
    statusId: DEFAULT_SETTINGS.projects.statuses[0]!.id,
    rawStatus: 'Active raw',
    writableStatusShape: true,
    priority: index % 2 === 0 ? 'High' : 'Normal',
    range: {},
    blockedByPaths: [],
    relatedPaths: [],
    diagnostics: [],
    ...over,
  };
}

describe('renderWorkNotesView', () => {
  it('shows physical Task progress and navigates from a Work Note to its filtered Tasks', () => {
    const root = freshContainer();
    const onShowTasks = vi.fn();
    const current = note(1);
    renderWorkNotesView(root, {
      notes: [current],
      statuses: DEFAULT_SETTINGS.projects.statuses,
      layout: 'list',
      taskRollups: new Map([
        [
          current.path,
          { total: 3, done: 2, cancelled: 0, inProgress: 0, open: 1, progress: 2 / 3 },
        ],
      ]),
      onShowTasks,
      onSetStatus: vi.fn(),
      openNote: vi.fn(),
    });

    expect(root.querySelector('[data-work-note-task-progress]')?.textContent).toBe('2/3');
    root.querySelector<HTMLButtonElement>('[aria-label="Show tasks in Work note 001"]')!.click();
    expect(onShowTasks).toHaveBeenCalledWith(current);
  });

  it('creates a first-class Milestone through a distinct collection action', () => {
    const root = freshContainer();
    const onCreateMilestone = vi.fn().mockResolvedValue({ type: 'ok', path: 'Work/M.md' });
    renderWorkNotesView(root, {
      notes: [],
      statuses: DEFAULT_SETTINGS.projects.statuses,
      layout: 'list',
      projectPath: 'Projects/P.md',
      onCreateMilestone,
      onSetStatus: vi.fn(),
      openNote: vi.fn(),
    });

    root.querySelector<HTMLButtonElement>('[aria-label="New milestone"]')!.click();
    const input = root.querySelector<HTMLInputElement>('[aria-label="Milestone title"]')!;
    input.value = 'Release';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(onCreateMilestone).toHaveBeenCalledWith({
      title: 'Release',
      projectPath: 'Projects/P.md',
    });
  });

  it.each([
    ['guarded failure', vi.fn().mockResolvedValue({ type: 'conflict', field: 'owner' })],
    ['rejection', vi.fn().mockRejectedValue(new Error('disk unavailable'))],
  ])('presents Milestone create %s once and keeps the draft mounted', async (_label, create) => {
    const root = freshContainer();
    renderWorkNotesView(root, {
      notes: [],
      statuses: DEFAULT_SETTINGS.projects.statuses,
      layout: 'list',
      projectPath: 'Projects/P.md',
      onCreateMilestone: create,
      onSetStatus: vi.fn(),
      openNote: vi.fn(),
    });

    root.querySelector<HTMLButtonElement>('[aria-label="New milestone"]')!.click();
    const input = root.querySelector<HTMLInputElement>('[aria-label="Milestone title"]')!;
    input.value = 'Release';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await flushMicrotasks();

    expect(root.querySelector('[data-work-note-feedback]')?.textContent).not.toBe('');
    expect(root.querySelector('[aria-label="Milestone title"]')).toBe(input);
    expect(create).toHaveBeenCalledOnce();
  });
  it.each([
    ['title', 'Release brief'],
    ['path', 'Research'],
    ['status', 'In progress'],
    ['priority', 'Urgent'],
    ['description', 'customer handoff'],
  ] as const)('searches Work Notes by %s through one selector', (_field, query) => {
    const statuses = [{ id: 'doing', label: 'In progress' }];
    const selected = selectWorkNotes({
      notes: [
        note(1, {
          path: 'Work Notes/Research/Release brief.md',
          statusId: 'doing',
          rawStatus: 'Doing',
          priority: 'Urgent',
          description: 'Prepare the customer handoff',
        }),
        note(2, { path: 'Work Notes/Archive.md', statusId: null, rawStatus: null }),
      ],
      statuses,
      textQuery: query,
      viewState: { groupBy: 'none', sortBy: { field: 'title', dir: 'asc' }, statusIds: [] },
    });

    expect(selected.map(({ path }) => path)).toEqual(['Work Notes/Research/Release brief.md']);
  });

  it('projects real priority groups before applying the configured within-group sort', () => {
    const selected = selectWorkNotes({
      notes: [
        note(1, { path: 'Work Notes/A low.md', priority: 'Low' }),
        note(2, { path: 'Work Notes/Z high.md', priority: 'High' }),
        note(3, { path: 'Work Notes/B high.md', priority: 'High' }),
      ],
      statuses: DEFAULT_SETTINGS.projects.statuses,
      viewState: {
        groupBy: 'priority',
        sortBy: { field: 'title', dir: 'asc' },
        statusIds: [],
      },
    });

    expect(selected.map(({ path }) => path)).toEqual([
      'Work Notes/B high.md',
      'Work Notes/Z high.md',
      'Work Notes/A low.md',
    ]);
  });

  it('routes Milestone query, lifecycle filter, and progress ordering through first-class projections', () => {
    const release = note(1, {
      path: 'Work Notes/Release.md',
      kind: 'milestone',
      statusId: 'active',
    });
    const archived = note(2, {
      path: 'Work Notes/Archived.md',
      kind: 'milestone',
      statusId: 'done',
    });
    const selected = selectWorkNotes({
      notes: [archived, release],
      statuses: [
        { id: 'active', label: 'Active' },
        { id: 'done', label: 'Done' },
      ],
      textQuery: 'release',
      milestoneRollups: new Map([
        [release.path, { active: 1, completed: 3, dropped: 0, progress: 0.75 }],
        [archived.path, { active: 0, completed: 1, dropped: 0, progress: 1 }],
      ]),
      viewState: {
        groupBy: 'status',
        sortBy: { field: 'progress', dir: 'desc' },
        statusIds: ['active'],
      },
    });

    expect(selected).toEqual([release]);
  });

  it('preserves first-class Milestone date ordering instead of re-sorting by the generic end carrier', () => {
    const firstByStart = note(1, {
      path: 'Work Notes/First by start.md',
      kind: 'milestone',
      range: {
        start: { raw: '2026-09-01', precision: 'date', instantMs: 1 },
        end: { raw: '2026-09-30', precision: 'date', instantMs: 30 },
      },
    });
    const secondByStart = note(2, {
      path: 'Work Notes/Second by start.md',
      kind: 'milestone',
      range: {
        start: { raw: '2026-09-02', precision: 'date', instantMs: 2 },
        end: { raw: '2026-09-03', precision: 'date', instantMs: 3 },
      },
    });

    const selected = selectWorkNotes({
      notes: [secondByStart, firstByStart],
      statuses: DEFAULT_SETTINGS.projects.statuses,
      viewState: {
        groupBy: 'none',
        sortBy: { field: 'end', dir: 'asc' },
        statusIds: [],
      },
    });

    expect(selected).toEqual([firstByStart, secondByStart]);
  });

  it('uses one transitive mixed collection order while preserving canonical Milestone rank', () => {
    const firstMilestone = note(1, {
      path: 'Work Notes/M1.md',
      kind: 'milestone',
      range: {
        start: { raw: '2026-09-01', precision: 'date', instantMs: 1 },
        end: { raw: '2026-09-30', precision: 'date', instantMs: 30 },
      },
    });
    const secondMilestone = note(2, {
      path: 'Work Notes/M2.md',
      kind: 'milestone',
      range: {
        start: { raw: '2026-09-02', precision: 'date', instantMs: 2 },
        end: { raw: '2026-09-03', precision: 'date', instantMs: 3 },
      },
    });
    const ordinary = note(3, {
      path: 'Work Notes/O.md',
      range: { end: { raw: '2026-09-10', precision: 'date', instantMs: 10 } },
    });

    const selected = selectWorkNotes({
      notes: [secondMilestone, ordinary, firstMilestone],
      statuses: DEFAULT_SETTINGS.projects.statuses,
      viewState: {
        groupBy: 'none',
        sortBy: { field: 'end', dir: 'asc' },
        statusIds: [],
      },
    });

    expect(selected).toEqual([firstMilestone, secondMilestone, ordinary]);
  });

  it('renders explicit ordered group sections from the selected Work Note projection', () => {
    const root = freshContainer();
    renderWorkNotesView(root, {
      notes: [
        note(1, { path: 'Work Notes/A low.md', priority: 'Low' }),
        note(2, { path: 'Work Notes/Z high.md', priority: 'High' }),
        note(3, { path: 'Work Notes/B high.md', priority: 'High' }),
      ],
      statuses: DEFAULT_SETTINGS.projects.statuses,
      layout: 'list',
      viewState: {
        groupBy: 'priority',
        sortBy: { field: 'title', dir: 'asc' },
        statusIds: [],
      },
      onSetStatus: vi.fn(),
      openNote: vi.fn(),
    });

    expect(
      [...root.querySelectorAll('[data-work-note-group]')].map((group) => group.textContent),
    ).toEqual(['High', 'Low']);
    expect(
      [...root.querySelectorAll('[data-work-note-path]')].map((row) => row.textContent),
    ).toEqual(
      expect.arrayContaining([
        expect.stringContaining('B high'),
        expect.stringContaining('Z high'),
        expect.stringContaining('A low'),
      ]),
    );
  });

  it('emits a common-host selection intent instead of creating a local inspector', () => {
    const root = freshContainer();
    const onSelect = vi.fn();
    renderWorkNotesView(root, {
      notes: [note(1)],
      statuses: DEFAULT_SETTINGS.projects.statuses,
      layout: 'list',
      onSetStatus: vi.fn(),
      openNote: vi.fn(),
      onSelect,
    });

    root.querySelector<HTMLButtonElement>('[data-work-note-identity-control]')!.click();
    expect(onSelect).toHaveBeenCalledWith(note(1), expect.any(HTMLElement));
    expect(root.querySelector('.abyss-work-note-inspector-host')).toBeNull();
  });

  it('renders hundreds of Work Notes as dense virtualized rows', () => {
    const root = freshContainer();
    const notes = Array.from({ length: 240 }, (_, index) => note(index));

    renderWorkNotesView(root, {
      notes,
      statuses: DEFAULT_SETTINGS.projects.statuses,
      layout: 'list',
      onSetStatus: vi.fn(),
      openNote: vi.fn(),
    });

    expect(root.querySelectorAll('.abyss-work-note-row')).toHaveLength(
      WORK_NOTE_FALLBACK_VISIBLE_ROWS + WORK_NOTE_OVERSCAN,
    );
    expect(root.textContent).not.toContain('No dates');
    expect(root.querySelector('[data-bounded-window-edge="end"]')).not.toBeNull();
  });

  it('keeps logical keyboard focus and exact row extent while deep scrolling remounts', () => {
    const root = freshContainer();
    activeDocument.body.appendChild(root);
    const notes = Array.from({ length: 150 }, (_, index) => note(index));
    try {
      const handle = renderWorkNotesView(root, {
        notes,
        statuses: DEFAULT_SETTINGS.projects.statuses,
        layout: 'list',
        onSetStatus: vi.fn(),
        openNote: vi.fn(),
      });
      const scroll = root.querySelector<HTMLElement>('.abyss-work-notes-scroll')!;
      Object.defineProperty(scroll, 'clientHeight', {
        configurable: true,
        value: WORK_NOTE_ROW_EXTENT * 5,
      });
      scroll.scrollTop = WORK_NOTE_ROW_EXTENT * 100;
      scroll.dispatchEvent(new Event('scroll'));
      const current = root.querySelector<HTMLElement>(
        '.abyss-work-note-row[data-work-note-path="Work Notes/Work note 100.md"] [data-work-note-identity-control]',
      )!;
      current.focus();
      for (let index = 0; index < 7; index += 1) {
        activeDocument.activeElement?.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }),
        );
      }

      expect(
        (activeDocument.activeElement as HTMLElement)
          .closest('.abyss-work-note-row')
          ?.getAttribute('data-work-note-path'),
      ).toBe('Work Notes/Work note 107.md');
      expect(scroll.scrollTop).toBe(WORK_NOTE_ROW_EXTENT * 103);
      expect(
        root.querySelector<HTMLElement>('[data-bounded-window-edge="start"]')?.style.blockSize,
      ).toBe(`${String((103 - WORK_NOTE_OVERSCAN) * WORK_NOTE_ROW_EXTENT)}px`);
    } finally {
      root.remove();
    }
  });

  it('restores a deep logical list viewport and focus after the renderer is replaced', () => {
    const root = freshContainer();
    activeDocument.body.appendChild(root);
    const notes = Array.from({ length: 150 }, (_, index) => note(index));
    const session = new ProjectWorkspaceSession();
    session.openProject('Projects/P.md');
    const options = {
      notes,
      statuses: DEFAULT_SETTINGS.projects.statuses,
      layout: 'list' as const,
      session: session.workNotes,
      onSetStatus: vi.fn(),
      openNote: vi.fn(),
    };
    try {
      let handle = renderWorkNotesView(root, options);
      let scroll = root.querySelector<HTMLElement>('.abyss-work-notes-scroll')!;
      Object.defineProperty(scroll, 'clientHeight', {
        configurable: true,
        value: WORK_NOTE_ROW_EXTENT * 5,
      });
      scroll.scrollTop = WORK_NOTE_ROW_EXTENT * 100;
      scroll.dispatchEvent(new Event('scroll'));
      root
        .querySelector<HTMLElement>(
          '.abyss-work-note-row[data-work-note-path="Work Notes/Work note 103.md"] [data-work-note-identity-control]',
        )!
        .focus();

      handle.destroy();
      handle = renderWorkNotesView(root, options);
      scroll = root.querySelector<HTMLElement>('.abyss-work-notes-scroll')!;

      expect(scroll.scrollTop).toBe(WORK_NOTE_ROW_EXTENT * 100);
      expect(
        (activeDocument.activeElement as HTMLElement)
          .closest('.abyss-work-note-row')
          ?.getAttribute('data-work-note-path'),
      ).toBe('Work Notes/Work note 103.md');
      handle.destroy();
    } finally {
      root.remove();
    }
  });

  it('uses the same row language to expose kind, status, project, and inspector selection', () => {
    const root = freshContainer();
    const onSelect = vi.fn();
    renderWorkNotesView(root, {
      notes: [
        note(1, {
          kind: 'milestone',
          statusId: null,
          rawStatus: 'Review',
          projectPath: 'Projects/Canonical.md',
        }),
      ],
      statuses: DEFAULT_SETTINGS.projects.statuses,
      layout: 'list',
      onSetStatus: vi.fn(),
      openNote: vi.fn(),
      onSelect,
    });

    const row = root.querySelector<HTMLElement>('.abyss-work-note-row')!;
    expect(row.textContent).toContain('Milestone');
    expect(row.textContent).toContain('Review');
    expect(row.textContent).toContain('Canonical');
    row.querySelector<HTMLButtonElement>('[data-work-note-identity-control]')!.click();
    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({ path: 'Work Notes/Work note 001.md' }),
      expect.any(HTMLElement),
    );
    expect(root.querySelector('.abyss-work-note-inspector-host')).toBeNull();
    expect(root.querySelector('input[type="checkbox"]')).toBeNull();
  });

  it('owns ordinary and milestone identity on the actual row and retains focus for status and open controls', () => {
    const root = freshContainer();
    activeDocument.body.appendChild(root);
    const session = new ProjectWorkspaceSession();
    session.openProject('Projects/P.md');
    const ordinary = note(1);
    const milestone = note(2, { kind: 'milestone' });
    try {
      const handle = renderWorkNotesView(root, {
        notes: [ordinary, milestone],
        statuses: DEFAULT_SETTINGS.projects.statuses,
        layout: 'list',
        session: session.workNotes,
        onSetStatus: vi.fn(),
        openNote: vi.fn(),
      });

      for (const current of [ordinary, milestone]) {
        expect(root.querySelectorAll(`[data-work-note-path="${current.path}"]`)).toHaveLength(1);
        const row = root.querySelector<HTMLElement>(
          `.abyss-work-note-row[data-work-note-path="${current.path}"]`,
        );
        expect(row).not.toBeNull();
        row?.querySelector<HTMLButtonElement>('.abyss-work-note-status')?.focus();
        expect(session.workNotes.list.focusedKey).toBe(current.path);
        expect(
          activeDocument.activeElement
            ?.closest('.abyss-work-note-row')
            ?.getAttribute('data-work-note-path'),
        ).toBe(current.path);
        row?.querySelector<HTMLButtonElement>('.abyss-work-note-open')?.focus();
        expect(session.workNotes.list.focusedKey).toBe(current.path);
      }
      handle.destroy();
    } finally {
      root.remove();
    }
  });

  it('announces milestone identity and useful automatic progress without inventing zero progress', () => {
    const root = freshContainer();
    const completed = note(1, { kind: 'milestone', path: 'Work Notes/Release.md' });
    let handle = renderWorkNotesView(root, {
      notes: [completed],
      statuses: DEFAULT_SETTINGS.projects.statuses,
      layout: 'list',
      milestoneRollups: new Map([
        [completed.path, { active: 1, completed: 2, dropped: 0, progress: 2 / 3 }],
      ]),
      onSetStatus: vi.fn(),
      openNote: vi.fn(),
    });

    expect(
      root
        .querySelector<HTMLElement>('[data-work-note-identity-control]')
        ?.getAttribute('aria-label'),
    ).toContain('Milestone');
    expect(
      root
        .querySelector<HTMLElement>('[data-work-note-identity-control]')
        ?.getAttribute('aria-label'),
    ).toContain('2 of 3 complete');

    handle.destroy();
    handle = renderWorkNotesView(root, {
      notes: [completed],
      statuses: DEFAULT_SETTINGS.projects.statuses,
      layout: 'list',
      milestoneRollups: new Map([
        [completed.path, { active: 0, completed: 0, dropped: 0, progress: null }],
      ]),
      onSetStatus: vi.fn(),
      openNote: vi.fn(),
    });
    expect(root.textContent).not.toContain('0/0');
    expect(
      root
        .querySelector<HTMLElement>('[data-work-note-identity-control]')
        ?.getAttribute('aria-label'),
    ).not.toContain('0 of 0 complete');
    handle.destroy();
  });

  it('keeps a long Work Note title and ordinary metadata separated inside the bounded identity', () => {
    const style = activeDocument.head.createEl('style');
    // Obsidian presents buttons as horizontal flex controls. The plugin must establish the
    // identity's own flow; otherwise the title and metadata groups paint as one merged label.
    style.textContent = `button { display: inline-flex; align-items: center; }\n${shippedStyles}`;
    const root = freshContainer();
    activeDocument.body.appendChild(root);
    try {
      renderWorkNotesView(root, {
        notes: [
          note(1, {
            path: 'Work Notes/A deliberately long ordinary Work Note title.md',
            kind: 'ordinary',
            projectPath: 'Projects/A deliberately long regular Project label.md',
            priority: 'High',
          }),
        ],
        statuses: DEFAULT_SETTINGS.projects.statuses,
        layout: 'list',
        onSetStatus: vi.fn(),
        openNote: vi.fn(),
      });

      const identity = root.querySelector<HTMLElement>('.abyss-work-note-identity')!;
      const title = identity.querySelector<HTMLElement>('.abyss-work-note-title')!;
      const meta = identity.querySelector<HTMLElement>('.abyss-work-note-meta')!;
      const kind = meta.querySelector<HTMLElement>('.abyss-work-note-kind')!;
      const project = meta.querySelector<HTMLElement>('.abyss-work-note-project')!;
      const priority = meta.querySelector<HTMLElement>('.abyss-work-note-priority')!;
      const row = identity.closest<HTMLElement>('.abyss-work-note-row')!;
      const identityStyle = getComputedStyle(identity);
      const titleStyle = getComputedStyle(title);
      const metaStyle = getComputedStyle(meta);
      let flowOwner = title.parentElement;
      while (flowOwner && !flowOwner.contains(meta)) flowOwner = flowOwner.parentElement;
      const flowStyle = getComputedStyle(flowOwner!);
      const positiveSpace = (...values: string[]): boolean =>
        values.some((value) => {
          const pixels = Number.parseFloat(value);
          return Number.isFinite(pixels)
            ? pixels > 0
            : value !== '' && value !== 'normal' && value !== '0';
        });
      const paintContained = (computed: CSSStyleDeclaration): boolean =>
        [computed.overflowX, computed.overflow].some((value) => ['hidden', 'clip'].includes(value));
      const flexLike = flowStyle.display === 'flex' || flowStyle.display === 'inline-flex';
      const gridLike = flowStyle.display === 'grid' || flowStyle.display === 'inline-grid';
      const horizontalGrid =
        flowStyle.gridAutoFlow.startsWith('column') ||
        flowStyle.gridTemplateColumns.split(' ').filter(Boolean).length > 1;
      const siblingSpace = positiveSpace(
        flowStyle.columnGap,
        flowStyle.gap,
        titleStyle.marginInlineEnd,
        metaStyle.marginInlineStart,
      );
      const separateFlow = flexLike
        ? flowStyle.flexDirection.startsWith('column') || siblingSpace
        : gridLike
          ? !horizontalGrid || siblingSpace
          : titleStyle.display === 'block';

      expect(title.compareDocumentPosition(meta) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
      expect(flowOwner).not.toBeNull();
      expect(identity.contains(flowOwner)).toBe(true);
      expect(kind.textContent).toBe('Ordinary');
      expect(project.textContent).toBe('A deliberately long regular Project label');
      expect(priority.textContent).toBe('High');
      expect(identityStyle.minWidth).toBe('0px');
      expect(paintContained(getComputedStyle(row))).toBe(true);
      expect(paintContained(titleStyle)).toBe(true);
      expect(titleStyle.textOverflow).toBe('ellipsis');
      expect(metaStyle.minWidth).toBe('0px');
      expect(paintContained(metaStyle)).toBe(true);
      expect(metaStyle.whiteSpace).toBe('nowrap');
      for (const element of [kind, project, priority]) {
        const computed = getComputedStyle(element);
        expect(paintContained(computed)).toBe(true);
        expect(computed.textOverflow).toBe('ellipsis');
      }
      expect(separateFlow).toBe(true);
    } finally {
      style.remove();
      root.remove();
    }
  });

  it('creates through one guarded inline control without introducing a task checkbox', () => {
    const root = freshContainer();
    const onCreate = vi.fn().mockResolvedValue({
      type: 'ok',
      path: 'Work Notes/New research.md',
    });
    renderWorkNotesView(root, {
      notes: [note(1)],
      statuses: DEFAULT_SETTINGS.projects.statuses,
      layout: 'list',
      projectPath: 'Projects/P.md',
      createEnabled: true,
      onCreate,
      onSetStatus: vi.fn(),
      openNote: vi.fn(),
    });

    root.querySelector<HTMLButtonElement>('[aria-label="New work note"]')!.click();
    const input = root.querySelector<HTMLInputElement>('.abyss-work-note-create-input')!;
    input.value = 'New research';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

    expect(onCreate).toHaveBeenCalledWith({
      title: 'New research',
      projectPath: 'Projects/P.md',
    });
    expect(root.querySelector('input[type="checkbox"]')).toBeNull();
  });

  it('announces successful creation once and focuses its stable row after projection settlement', async () => {
    const root = freshContainer();
    activeDocument.body.appendChild(root);
    const session = new ProjectWorkspaceSession();
    session.openProject('Projects/P.md');
    const created = note(999, { path: 'Work Notes/New research.md' });
    const existing = Array.from({ length: 249 }, (_, index) => note(index));
    const settled = [...existing.slice(0, 180), created, ...existing.slice(180)];
    const announce = vi.fn();
    const base = {
      statuses: DEFAULT_SETTINGS.projects.statuses,
      layout: 'list' as const,
      projectPath: 'Projects/P.md',
      createEnabled: true,
      session: session.workNotes,
      onCreate: vi.fn().mockResolvedValue({ type: 'ok', path: created.path }),
      onSetStatus: vi.fn(),
      openNote: vi.fn(),
      announce,
    };
    try {
      vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (
        this: HTMLElement,
      ) {
        return this.classList.contains('abyss-work-notes-scroll') ? WORK_NOTE_ROW_EXTENT * 5 : 0;
      });
      let handle = renderWorkNotesView(root, { ...base, notes: existing });
      root.querySelector<HTMLButtonElement>('[aria-label="New work note"]')!.click();
      const input = root.querySelector<HTMLInputElement>('.abyss-work-note-create-input')!;
      input.value = 'New research';
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await flushMicrotasks();

      expect(announce).toHaveBeenCalledOnce();
      expect(announce).toHaveBeenCalledWith('Created New research.');
      handle.destroy();
      handle = renderWorkNotesView(root, { ...base, notes: settled });
      const scroll = root.querySelector<HTMLElement>('.abyss-work-notes-scroll')!;
      expect(
        (activeDocument.activeElement as HTMLElement | null)
          ?.closest('.abyss-work-note-row')
          ?.getAttribute('data-work-note-path'),
      ).toBe(created.path);
      expect(scroll.scrollTop).toBeGreaterThan(0);
      expect(root.querySelectorAll('.abyss-work-note-row').length).toBeLessThanOrEqual(60);
      expect(root.querySelector(`[data-work-note-path="${created.path}"]`)).not.toBeNull();
      expect(announce).toHaveBeenCalledTimes(1);
      expect(session.workNotes.pendingCreatedPath).toBeNull();
      handle.destroy();
    } finally {
      root.remove();
    }
  });

  it('emits a selection intent from narrow rows without owning a second dialog', () => {
    const root = freshContainer();
    activeDocument.body.appendChild(root);
    const onSelect = vi.fn();
    try {
      renderWorkNotesView(root, {
        notes: [note(1)],
        statuses: DEFAULT_SETTINGS.projects.statuses,
        layout: 'list',
        onSetStatus: vi.fn(),
        openNote: vi.fn(),
        onSelect,
        isNarrow: true,
        coarsePointer: true,
      });
      const identity = root.querySelector<HTMLButtonElement>('[data-work-note-identity-control]')!;
      identity.focus();
      identity.click();
      expect(onSelect).toHaveBeenCalledWith(note(1), identity);
      expect(root.querySelector('[role="dialog"]')).toBeNull();
    } finally {
      root.remove();
    }
  });

  it('keeps a selected stable path across list replacement and reordering', () => {
    const root = freshContainer();
    activeDocument.body.appendChild(root);
    const session = new ProjectWorkspaceSession();
    session.openProject('Projects/P.md');
    const notes = [note(1), note(2), note(3)];
    const base = {
      statuses: DEFAULT_SETTINGS.projects.statuses,
      layout: 'list' as const,
      onSetStatus: vi.fn(),
      openNote: vi.fn(),
      session: session.workNotes,
      onSelect: vi.fn(),
    };
    try {
      let handle = renderWorkNotesView(root, { ...base, notes });
      root
        .querySelector<HTMLButtonElement>(
          '.abyss-work-note-row[data-work-note-path="Work Notes/Work note 002.md"] [data-work-note-identity-control]',
        )!
        .click();
      expect(session.workNotes.selection.inspectorKey).toBe('Work Notes/Work note 002.md');

      handle.destroy();
      handle = renderWorkNotesView(root, { ...base, notes: [notes[2]!, notes[1]!, notes[0]!] });
      expect(session.workNotes.selection.inspectorKey).toBe('Work Notes/Work note 002.md');
      handle.destroy();
    } finally {
      root.remove();
    }
  });

  it('keeps the creation input and surfaces a typed partial result', async () => {
    const root = freshContainer();
    renderWorkNotesView(root, {
      notes: [note(1)],
      statuses: DEFAULT_SETTINGS.projects.statuses,
      layout: 'list',
      projectPath: 'Projects/P.md',
      createEnabled: true,
      onCreate: vi.fn().mockResolvedValue({
        type: 'partial',
        path: 'Work Notes/Partial.md',
        reason: 'templater-failure',
      }),
      onSetStatus: vi.fn(),
      openNote: vi.fn(),
    });

    root.querySelector<HTMLButtonElement>('[aria-label="New work note"]')!.click();
    const input = root.querySelector<HTMLInputElement>('.abyss-work-note-create-input')!;
    input.value = 'Partial';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await vi.waitFor(() => expect(input.disabled).toBe(false));

    expect(root.contains(input)).toBe(true);
    expect(root.querySelector('[role="status"]')?.textContent).toContain('Partial');
  });

  it('sorts the default updated view by audited updated metadata', () => {
    const root = freshContainer();
    renderWorkNotesView(root, {
      notes: [note(1, { updated: '2026-08-01' }), note(2, { updated: '2026-08-20' })],
      statuses: DEFAULT_SETTINGS.projects.statuses,
      layout: 'list',
      viewState: {
        groupBy: 'none',
        sortBy: { field: 'updated', dir: 'desc' },
        statusIds: [],
      },
      onSetStatus: vi.fn(),
      openNote: vi.fn(),
    });

    expect(
      [...root.querySelectorAll('.abyss-work-note-title')].map(({ textContent }) => textContent),
    ).toEqual(['Work note 002', 'Work note 001']);
  });

  it('shows all Work Notes when every persisted status filter id is stale', () => {
    const root = freshContainer();
    const statuses = DEFAULT_SETTINGS.projects.statuses;
    renderWorkNotesView(root, {
      notes: [note(1, { statusId: statuses[0]!.id }), note(2, { statusId: statuses[1]!.id })],
      statuses,
      layout: 'list',
      viewState: {
        groupBy: 'none',
        sortBy: { field: 'title', dir: 'asc' },
        statusIds: ['legacy-active', 'legacy-done'],
      },
      onSetStatus: vi.fn(),
      openNote: vi.fn(),
    });

    expect(root.querySelectorAll('[data-work-note-path]')).toHaveLength(2);
  });

  it.each([
    ['compatibility-conflict', { type: 'compatibility-conflict', reason: 'latest-audit-rejected' }],
    ['conflict', { type: 'conflict', field: 'status' }],
    ['invalid', { type: 'invalid', field: 'status' }],
    ['partial', { type: 'partial', path: 'Work Notes/Partial.md', reason: 'shape-changed' }],
    ['io-error', { type: 'io-error' }],
  ] as const)(
    'presents a connected %s failure from the list and restores the initiating status button',
    async (resultType, result) => {
      const root = freshContainer();
      activeDocument.body.appendChild(root);
      const items = captureMenuItems();
      try {
        renderWorkNotesView(root, {
          notes: [note(1)],
          statuses: DEFAULT_SETTINGS.projects.statuses,
          layout: 'list',
          onSetStatus: vi.fn().mockResolvedValue(result),
          openNote: vi.fn(),
        });
        const trigger = root.querySelector<HTMLButtonElement>('.abyss-work-note-status')!;
        trigger.click();
        await items.find(({ title }) => title === 'Done')!.click();

        await vi.waitFor(() => {
          const feedback = root.querySelector<HTMLElement>('[data-work-note-feedback]');
          expect(feedback?.dataset['resultType']).toBe(resultType);
          expect(feedback?.getAttribute('role')).toBe('status');
          expect(feedback?.textContent).not.toBe('');
          expect(activeDocument.activeElement).toBe(trigger);
        });
      } finally {
        root.remove();
      }
    },
  );

  it('makes Work Notes selectable while every dashboard still opens in Tasks/List', async () => {
    const root = freshContainer();
    const session = new ProjectWorkspaceSession();
    const renderTasks = vi.fn((host: HTMLElement) => {
      host.createDiv({ text: 'Tasks list' });
      return { destroy: () => host.empty() };
    });
    const renderWorkNotes = vi.fn((host: HTMLElement) => {
      host.createDiv({ text: 'Work Notes list' });
      return { destroy: () => host.empty() };
    });
    const snapshot: ProjectWorkspaceSnapshot = {
      project: {
        path: 'Projects/P.md',
        name: 'P',
        frontmatter: {},
        tags: [],
        statusId: DEFAULT_SETTINGS.projects.statuses[0]!.id,
        rawStatus: null,
        range: {},
        stats: { total: 0, done: 0, cancelled: 0, inProgress: 0, open: 0, progress: null },
      },
      tasks: [],
      workNotes: [note(1)],
      milestones: [],
      taskRollup: { total: 0, done: 0, cancelled: 0, inProgress: 0, open: 0, progress: null },
      workNoteRollup: { active: 1, completed: 0, dropped: 0 },
      milestoneRollups: new Map(),
      workNoteRelations: [],
      overdue: { tasks: 0, workNotes: 0 },
      dependencies: { blocked: 0, invalid: 0, diagnostics: [] },
      diagnostics: [],
    };
    const context = {
      state: new AppState(),
      settings: DEFAULT_SETTINGS,
      workspaceSession: session,
      onSetStatus: vi.fn(),
      openNote: vi.fn(),
      renderTasks,
      renderWorkNotes,
      renderWorkNoteBoard: vi.fn(() => ({ destroy: () => undefined })),
    };
    let handle = renderProjectDashboard(root, snapshot, context);

    const workspace = root.querySelector<HTMLElement>('[data-project-workspace]')!;
    expect(workspace.dataset).toMatchObject({ scope: 'tasks', layout: 'list' });
    expect(root.querySelector('.abyss-project-tasks-title')?.textContent).toBe('Tasks');
    const scope = root.querySelector<HTMLButtonElement>('[data-project-scope="work-notes"]')!;
    expect(scope.disabled).toBe(false);
    scope.click();
    expect(workspace.dataset).toMatchObject({ scope: 'work-notes', layout: 'list' });
    expect(root.querySelector('.abyss-project-tasks-title')?.textContent).toBe('Work Notes');
    expect(renderWorkNotes).toHaveBeenCalledOnce();
    root.querySelector<HTMLButtonElement>('[data-project-layout="board"]')!.click();
    await flushMicrotasks();
    expect(workspace.dataset).toMatchObject({ scope: 'work-notes', layout: 'board' });
    handle.destroy();

    handle = renderProjectDashboard(root, snapshot, context);
    expect(root.querySelector<HTMLElement>('[data-project-workspace]')?.dataset).toMatchObject({
      scope: 'work-notes',
      layout: 'board',
    });
    expect(root.querySelector('.abyss-project-tasks-title')?.textContent).toBe('Work Notes');
    handle.destroy();
  });

  it('retains the same open Project workspace but resets a newly opened or different Project', async () => {
    const root = freshContainer();
    const session = new ProjectWorkspaceSession();
    const context = {
      state: new AppState(),
      settings: DEFAULT_SETTINGS,
      workspaceSession: session,
      onSetStatus: vi.fn(),
      openNote: vi.fn(),
      renderTasks: vi.fn(() => ({ destroy: () => undefined })),
      renderWorkNotes: vi.fn(() => ({ destroy: () => undefined })),
      renderWorkNoteBoard: vi.fn(() => ({ destroy: () => undefined })),
    };
    const snapshot = (path: string): ProjectWorkspaceSnapshot => ({
      project: {
        path,
        name: path,
        frontmatter: {},
        tags: [],
        statusId: null,
        rawStatus: null,
        range: {},
        stats: { total: 0, done: 0, cancelled: 0, inProgress: 0, open: 0, progress: null },
      },
      tasks: [],
      workNotes: [note(1, { projectPath: path })],
      milestones: [],
      taskRollup: { total: 0, done: 0, cancelled: 0, inProgress: 0, open: 0, progress: null },
      workNoteRollup: { active: 1, completed: 0, dropped: 0 },
      milestoneRollups: new Map(),
      workNoteRelations: [],
      overdue: { tasks: 0, workNotes: 0 },
      dependencies: { blocked: 0, invalid: 0, diagnostics: [] },
      diagnostics: [],
    });

    renderProjectDashboard(root, snapshot('Projects/P.md'), context);
    root.querySelector<HTMLButtonElement>('[data-project-scope="work-notes"]')!.click();
    root.querySelector<HTMLButtonElement>('[data-project-layout="board"]')!.click();
    await flushMicrotasks();
    root.empty();
    renderProjectDashboard(root, snapshot('Projects/P.md'), context);
    expect(root.querySelector<HTMLElement>('[data-project-workspace]')?.dataset).toMatchObject({
      scope: 'work-notes',
      layout: 'board',
    });

    root.empty();
    renderProjectDashboard(root, snapshot('Projects/Q.md'), context);
    expect(root.querySelector<HTMLElement>('[data-project-workspace]')?.dataset).toMatchObject({
      scope: 'tasks',
      layout: 'list',
    });
    session.closeProject();
    root.empty();
    renderProjectDashboard(root, snapshot('Projects/Q.md'), context);
    expect(root.querySelector<HTMLElement>('[data-project-workspace]')?.dataset).toMatchObject({
      scope: 'tasks',
      layout: 'list',
    });
  });

  it('keeps the real Work Notes scope available for creating a project first note', () => {
    const root = freshContainer();
    const renderWorkNotes = vi.fn();
    const project = {
      path: 'Projects/P.md',
      name: 'P',
      frontmatter: {},
      tags: [],
      statusId: null,
      rawStatus: null,
      range: {},
      stats: { total: 0, done: 0, cancelled: 0, inProgress: 0, open: 0, progress: null },
    };
    renderProjectDashboard(
      root,
      {
        project,
        tasks: [],
        workNotes: [],
        milestones: [],
        taskRollup: project.stats,
        workNoteRollup: { active: 0, completed: 0, dropped: 0 },
        milestoneRollups: new Map(),
        workNoteRelations: [],
        overdue: { tasks: 0, workNotes: 0 },
        dependencies: { blocked: 0, invalid: 0, diagnostics: [] },
        diagnostics: [],
      },
      {
        state: new AppState(),
        settings: DEFAULT_SETTINGS,
        onSetStatus: vi.fn(),
        openNote: vi.fn(),
        renderTasks: vi.fn(() => ({ destroy: () => undefined })),
        renderWorkNotes,
      },
    );

    const scope = root.querySelector<HTMLButtonElement>('[data-project-scope="work-notes"]')!;
    expect(scope).not.toBeNull();
    scope.click();
    expect(renderWorkNotes).toHaveBeenCalledWith(
      expect.any(HTMLElement),
      'Projects/P.md',
      [],
      DEFAULT_SETTINGS.projects.view.workNotes,
    );
  });
});

describe('Work Note board adapter', () => {
  it('reconciles a stable Work Note id across a rename publication', async () => {
    const root = freshContainer();
    const scope = {};
    const announcements: string[] = [];
    const statuses = DEFAULT_SETTINGS.projects.statuses;
    const original = note(1, { id: 'work-note-stable-id', statusId: statuses[0]!.id });
    let handle = renderWorkNotesView(root, {
      notes: [original],
      canonicalNotes: [original],
      publicationSequence: 1,
      statuses,
      layout: 'board',
      onSetStatus: vi.fn().mockResolvedValue({ type: 'ok', path: original.path }),
      openNote: vi.fn(),
      overlayScope: scope,
      announce: (message) => announcements.push(message),
    });
    const focus = root.querySelector<HTMLElement>('[data-board-item-focus]')!;
    focus.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    focus.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    focus.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    await flushMicrotasks();
    handle.destroy();

    const renamed = {
      ...original,
      path: 'Archive/Renamed work note.md',
      statusId: statuses[2]!.id,
    };
    handle = renderWorkNotesView(root, {
      notes: [renamed],
      canonicalNotes: [renamed],
      publicationSequence: 2,
      statuses,
      layout: 'board',
      onSetStatus: vi.fn(),
      openNote: vi.fn(),
      overlayScope: scope,
      announce: (message) => announcements.push(message),
    });

    expect(announcements.filter((message) => message === 'Item moved.')).toHaveLength(1);
    expect(root.querySelector(`[data-board-item-surface="${renamed.path}"]`)).not.toBeNull();
    handle.destroy();
  });

  it('uses the shared keyboard controller and canonical Work Note order', async () => {
    const root = freshContainer();
    const statuses = DEFAULT_SETTINGS.projects.statuses;
    const moving = note(1, { statusId: statuses[0]!.id });
    const later = note(2, { statusId: statuses[2]!.id });
    const onSetStatus = vi.fn().mockResolvedValue({ type: 'ok', path: moving.path });
    renderWorkNotesView(root, {
      notes: [moving, later],
      statuses,
      layout: 'board',
      onSetStatus,
      openNote: vi.fn(),
    });
    const card = root.querySelector<HTMLElement>('[data-board-item-surface]')!;
    expect(
      card.querySelector('.abyss-work-note-board-presentation [data-entity-slot="identity"]'),
    ).not.toBeNull();
    expect(
      card.querySelector('[data-work-note-identity-control]')?.getAttribute('aria-label'),
    ).toContain('Work note details');
    const focus = root.querySelector<HTMLElement>(`[data-board-item-focus="${moving.path}"]`)!;

    focus.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    focus.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    focus.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    await flushMicrotasks();

    expect(onSetStatus).toHaveBeenCalledOnce();
    expect(onSetStatus).toHaveBeenCalledWith(moving, statuses[2]!.id);
    expect(
      Array.from(
        root.querySelectorAll<HTMLElement>(
          `[data-board-column="${statuses[2]!.id}"] [data-board-item-surface]`,
        ),
        ({ dataset }) => dataset['boardItemSurface'],
      ),
    ).toEqual([moving.path, later.path]);
    expect(root.querySelector('.abyss-add-task-trigger')).toBeNull();
  });

  it('keeps read-only Board notes selectable while every mutation affordance is inert', async () => {
    const root = freshContainer();
    const onSelect = vi.fn();
    const onSetStatus = vi.fn();
    const handle = renderWorkNotesView(root, {
      notes: [note(1)],
      statuses: DEFAULT_SETTINGS.projects.statuses,
      layout: 'board',
      commandsEnabled: false,
      onSetStatus,
      openNote: vi.fn(),
      onSelect,
    });
    const identity = root.querySelector<HTMLButtonElement>('[data-work-note-identity-control]')!;
    const card = root.querySelector<HTMLElement>('.abyss-work-note-row[data-board-item]')!;
    const status = root.querySelector<HTMLButtonElement>('.abyss-board-status-menu')!;

    expect(identity.disabled).toBe(false);
    identity.click();
    expect(onSelect).toHaveBeenCalledWith(note(1), identity);
    expect(status.disabled).toBe(true);
    expect(status.title).toMatch(/accepted compatibility audit/iu);
    expect(card.getAttribute('draggable')).toBe('false');
    expect(card.closest('[aria-disabled="true"]')).toBeNull();
    const collapse = root.querySelector<HTMLButtonElement>('[data-board-collapse-column]')!;
    expect(collapse.disabled).toBe(false);
    collapse.click();
    expect(root.querySelector('[data-board-column].is-column-collapsed')).not.toBeNull();
    card.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    card.dispatchEvent(new Event('dragstart', { bubbles: true }));
    root
      .querySelector<HTMLElement>('[data-board-column]')!
      .dispatchEvent(new Event('drop', { bubbles: true, cancelable: true }));
    await flushMicrotasks();
    expect(root.querySelector('.abyss-board-columns')?.classList.contains('is-drag-active')).toBe(
      false,
    );
    expect(onSetStatus).not.toHaveBeenCalled();
    handle.destroy();
  });

  it('propagates a rejected Work Note Board preference save to the shared rollback contract', async () => {
    const root = freshContainer();
    const statuses = DEFAULT_SETTINGS.projects.statuses.slice(0, 2);
    const announcements: string[] = [];
    const handle = renderWorkNotesView(root, {
      notes: [note(1)],
      statuses,
      layout: 'board',
      onSetStatus: vi.fn(),
      openNote: vi.fn(),
      announce: (message) => announcements.push(message),
      boardPreference: {
        version: 1,
        terminalDefaultsApplied: true,
        columnOrder: statuses.map(({ id }) => id),
        collapsedColumnIds: [],
        hiddenColumnIds: [],
      },
      onBoardPreferenceChange: () => Promise.reject(new Error('disk unavailable')),
    });

    root
      .querySelector<HTMLButtonElement>(`[data-board-collapse-column="${statuses[0]!.id}"]`)!
      .click();
    await flushMicrotasks();

    expect(
      root
        .querySelector(`[data-board-column="${statuses[0]!.id}"]`)
        ?.classList.contains('is-column-collapsed'),
    ).toBe(false);
    expect(announcements.filter((message) => message.includes('not saved'))).toHaveLength(1);
    handle.destroy();
  });

  it('selects a Work Note exactly once from the enabled board identity button', () => {
    const root = freshContainer();
    const onSelect = vi.fn();
    const handle = renderWorkNotesView(root, {
      notes: [note(1)],
      statuses: DEFAULT_SETTINGS.projects.statuses,
      layout: 'board',
      onSetStatus: vi.fn(),
      openNote: vi.fn(),
      onSelect,
    });
    const identity = root.querySelector<HTMLButtonElement>('[data-work-note-identity-control]')!;

    expect(identity.type).toBe('button');
    expect(identity.disabled).toBe(false);
    expect(identity.getAttribute('aria-label')).toMatch(/details/iu);
    expect(root.querySelectorAll('.abyss-work-note-open')).toHaveLength(0);
    expect(root.querySelectorAll('.abyss-work-note-status')).toHaveLength(0);
    expect(root.querySelectorAll('.abyss-board-status-menu')).toHaveLength(1);
    identity.click();

    expect(onSelect).toHaveBeenCalledWith(note(1), identity);
    handle.destroy();
  });

  it('renders Board cards through the shared semantic slot hierarchy and action owner', () => {
    const root = freshContainer();
    const openNote = vi.fn();
    const workNote = note(1, {
      priority: 'high',
      description: 'A rendered secondary field',
      updated: '2026-09-01',
      blockedByPaths: ['Projects/Blocker.md'],
    });
    const handle = renderWorkNotesView(root, {
      notes: [workNote],
      statuses: DEFAULT_SETTINGS.projects.statuses,
      layout: 'board',
      onSetStatus: vi.fn(),
      openNote,
    });
    const card = root.querySelector<HTMLElement>('.abyss-work-note-board-presentation')!;

    expect(
      [
        'status',
        'identity',
        'priority',
        'date',
        'progress',
        'health',
        'relations',
        'secondary',
      ].map((slot) => card.querySelector(`[data-entity-slot="${slot}"]`) !== null),
    ).toEqual([true, true, true, false, false, false, true, true]);
    const action = card.querySelector<HTMLButtonElement>('[data-entity-slot="actions"] button')!;
    expect(action.getAttribute('aria-label')).toBe('Open work note');
    action.click();
    expect(openNote).toHaveBeenCalledWith(workNote.path);
    handle.destroy();
  });

  it('keeps list identity for details with one separate Open and status control', () => {
    const root = freshContainer();
    const handle = renderWorkNotesView(root, {
      notes: [note(1)],
      statuses: DEFAULT_SETTINGS.projects.statuses,
      layout: 'list',
      onSetStatus: vi.fn(),
      openNote: vi.fn(),
    });

    expect(
      root.querySelector('[data-work-note-identity-control]')?.getAttribute('aria-label'),
    ).toMatch(/details/iu);
    expect(root.querySelectorAll('.abyss-work-note-open')).toHaveLength(1);
    expect(root.querySelectorAll('.abyss-work-note-status')).toHaveLength(1);
    expect(root.querySelectorAll('.abyss-board-status-menu')).toHaveLength(0);
    handle.destroy();
  });

  it('uses the complete canonical status menu for both drag and menu commands', async () => {
    const statuses = DEFAULT_SETTINGS.projects.statuses;
    const workNote = note(1);
    const command = vi.fn().mockResolvedValue({ type: 'ok', path: workNote.path });
    const board = createWorkNoteBoardMutation(statuses, command);
    const done = statuses[2]!;

    expect(board.menuItems(workNote)).toEqual(
      statuses.map((status) => ({
        columnKey: status.id,
        label: status.label,
        icon: 'circle-dot',
        checked: status.id === workNote.statusId,
        disabled: status.id === workNote.statusId,
      })),
    );
    const drag = await board.move(workNote, done.id);
    const menu = await board.move(workNote, done.id);
    expect(drag).toEqual(menu);
    expect(command).toHaveBeenNthCalledWith(1, workNote, done.id);
    expect(command).toHaveBeenNthCalledWith(2, workNote, done.id);
  });

  it('keeps configured status order and one unmapped column', () => {
    const statuses = DEFAULT_SETTINGS.projects.statuses;
    const columns = workNoteBoardColumns(statuses, [note(1), note(2, { statusId: null })]);

    expect(columns.map(({ key }) => key)).toEqual([...statuses.map(({ id }) => id), 'unmapped']);
    expect(columns[columns.length - 1]?.items).toHaveLength(1);
  });

  it('keeps a failed board menu move visibly in place and restores the card focus', async () => {
    const root = freshContainer();
    activeDocument.body.appendChild(root);
    const items = captureMenuItems();
    try {
      renderWorkNotesView(root, {
        notes: [note(1)],
        statuses: DEFAULT_SETTINGS.projects.statuses,
        layout: 'board',
        onSetStatus: vi.fn().mockResolvedValue({ type: 'conflict', field: 'status' }),
        openNote: vi.fn(),
      });
      const card = root.querySelector<HTMLElement>('[data-board-item-focus]')!;
      const source = card.closest<HTMLElement>('[data-board-column]')!;
      card.focus();
      card.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
      await items.find(({ title }) => title === 'Done')!.click();

      await vi.waitFor(() => {
        expect(card.closest('[data-board-column]')).toBe(source);
        expect(root.querySelector<HTMLElement>('[data-work-note-feedback]')?.dataset).toMatchObject(
          {
            resultType: 'conflict',
          },
        );
        expect(activeDocument.activeElement).toBe(card);
      });
    } finally {
      root.remove();
    }
  });

  it('keeps a failed board drag visibly in place with accessible feedback and card focus', async () => {
    const root = freshContainer();
    activeDocument.body.appendChild(root);
    try {
      renderWorkNotesView(root, {
        notes: [note(1)],
        statuses: DEFAULT_SETTINGS.projects.statuses,
        layout: 'board',
        onSetStatus: vi
          .fn()
          .mockResolvedValue({ type: 'compatibility-conflict', reason: 'latest-audit-rejected' }),
        openNote: vi.fn(),
      });
      const card = root.querySelector<HTMLElement>('[data-board-item-focus]')!;
      const source = card.closest<HTMLElement>('[data-board-column]')!;
      const target = root.querySelector<HTMLElement>(
        `[data-board-column="${DEFAULT_SETTINGS.projects.statuses[2]!.id}"]`,
      )!;
      card.focus();
      card.dispatchEvent(new Event('dragstart', { bubbles: true }));
      target.dispatchEvent(new Event('drop', { bubbles: true, cancelable: true }));

      await vi.waitFor(() => {
        expect(card.closest('[data-board-column]')).toBe(source);
        expect(root.querySelector<HTMLElement>('[data-work-note-feedback]')?.dataset).toMatchObject(
          {
            resultType: 'compatibility-conflict',
          },
        );
        expect(activeDocument.activeElement).toBe(card);
      });
    } finally {
      root.remove();
    }
  });

  it('retains deep board scroll and logical card focus through a successful local move and outer replacement', async () => {
    const root = freshContainer();
    activeDocument.body.appendChild(root);
    const statuses = DEFAULT_SETTINGS.projects.statuses;
    const notes = Array.from({ length: 140 }, (_, index) => note(index));
    const session = new ProjectWorkspaceSession();
    session.openProject('Projects/P.md');
    const command = vi.fn().mockResolvedValue({ type: 'ok', path: notes[103]!.path });
    const render = (current: readonly WorkNoteSnapshot[]) =>
      renderWorkNotesView(root, {
        notes: current,
        statuses,
        layout: 'board',
        session: session.workNotes,
        onSetStatus: command,
        openNote: vi.fn(),
      });
    try {
      let handle = render(notes);
      let sourceScroll = root.querySelector<HTMLElement>(
        `[data-board-column="${statuses[0]!.id}"] .abyss-board-column-scroll`,
      )!;
      Object.defineProperty(sourceScroll, 'clientHeight', { configurable: true, value: 5 * 88 });
      sourceScroll.scrollTop = 100 * 88;
      sourceScroll.dispatchEvent(new Event('scroll'));
      const card = root.querySelector<HTMLElement>(
        '[data-board-item-focus="Work Notes/Work note 103.md"]',
      )!;
      card.focus();
      card.dispatchEvent(new Event('dragstart', { bubbles: true }));
      root
        .querySelector<HTMLElement>(`[data-board-column="${statuses[2]!.id}"]`)!
        .dispatchEvent(new Event('drop', { bubbles: true, cancelable: true }));
      await flushMicrotasks();

      expect((activeDocument.activeElement as HTMLElement).dataset['boardItem']).toBe(
        'Work Notes/Work note 103.md',
      );
      sourceScroll = root.querySelector<HTMLElement>(
        `[data-board-column="${statuses[0]!.id}"] .abyss-board-column-scroll`,
      )!;
      expect(sourceScroll.scrollTop).toBe(100 * 88);

      handle.destroy();
      const updated = notes.map((current) =>
        current.path === notes[103]!.path ? { ...current, statusId: statuses[2]!.id } : current,
      );
      handle = render(updated);
      expect((activeDocument.activeElement as HTMLElement).dataset['boardItem']).toBe(
        'Work Notes/Work note 103.md',
      );
      expect(
        root.querySelector<HTMLElement>(
          `[data-board-column="${statuses[0]!.id}"] .abyss-board-column-scroll`,
        )?.scrollTop,
      ).toBe(100 * 88);
      handle.destroy();
    } finally {
      root.remove();
    }
  });
});
