import { describe, expect, it, vi } from 'vitest';
import { AppState } from '../src/app/AppState';
import { renderProgressBar } from '../src/panels/projects/progressBar';
import { renderBoard } from '../src/panels/projects/ProjectsBoardView';
import { renderProjectsList } from '../src/panels/projects/ProjectsListView';
import { renderTimeline } from '../src/panels/projects/ProjectsTimelineView';
import { renderProjectTasksTable } from '../src/panels/projects/ProjectTasksTableView';
import { renderWorkNoteInspector } from '../src/panels/projects/WorkNoteInspector';
import { renderWorkNotesView } from '../src/panels/projects/WorkNotesView';
import type { ProjectAction, ProjectWorkspaceSnapshot } from '../src/projects/types';
import type { WorkNoteSnapshot } from '../src/projects/work-notes/types';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import { StatusRegistry } from '../src/status/StatusRegistry';
import type { DependencyCompletionDecision } from '../src/tasks/application/DependencyPolicyPort';
import { renderCollectionControls } from '../src/ui/collection/CollectionControls';
import { renderDependencyBadge } from '../src/ui/dependencyPresentation';
import { mountInspectorShell } from '../src/ui/inspector/InspectorShell';
import { renderStatusMarker } from '../src/ui/StatusMarker';
import { freshContainer, task } from './helpers';

const registry = new StatusRegistry(DEFAULT_SETTINGS.taskStatuses);
const blocked: DependencyCompletionDecision = {
  type: 'blocked',
  prerequisites: [{ filePath: 'Prep.md', line: 0, revision: 'prep' }],
};

describe('Project dependency accessibility', () => {
  it('marks only an open root completion control aria-disabled without suppressing activation', () => {
    const host = freshContainer();
    const activate = vi.fn();
    const marker = renderStatusMarker(host, {
      task: { status: 'open', statusSymbol: ' ', priority: 'D' },
      registry,
      completionDecision: blocked,
      onLeftClick: activate,
      onContextMenu: vi.fn(),
    });

    expect(marker.getAttribute('aria-disabled')).toBe('true');
    expect(marker.classList.contains('abyss-status-marker--completion-blocked')).toBe(true);
    expect(marker.hasAttribute('disabled')).toBe(false);
    marker.click();
    marker.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    );
    marker.dispatchEvent(
      new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true }),
    );
    expect(activate).toHaveBeenCalledTimes(3);
  });

  it.each([
    ['already Done root', { status: 'done', statusSymbol: 'x' }, blocked, true],
    ['subtask without a root projection', { status: 'open', statusSymbol: ' ' }, undefined, true],
    ['forecast-only inert marker', { status: 'open', statusSymbol: ' ' }, blocked, false],
  ] as const)('does not aria-disable the %s', (_label, task, decision, interactive) => {
    const marker = renderStatusMarker(freshContainer(), {
      task,
      registry,
      interactive,
      ...(decision && { completionDecision: decision }),
      onLeftClick: vi.fn(),
      onContextMenu: vi.fn(),
    });

    expect(marker.getAttribute('aria-disabled')).not.toBe('true');
  });

  it('gives an inert status marker explicit non-interactive state semantics', () => {
    const marker = renderStatusMarker(freshContainer(), {
      task: { status: 'done', statusSymbol: 'x', priority: 'D' },
      registry,
      interactive: false,
      onLeftClick: vi.fn(),
      onContextMenu: vi.fn(),
    });

    expect(marker.getAttribute('role')).toBe('img');
    expect(marker.getAttribute('aria-label')).toBe('Task status: Done');
    expect(marker.hasAttribute('tabindex')).toBe(false);
    expect(marker.hasAttribute('aria-checked')).toBe(false);
  });

  it('uses the existing compact count-badge dialect for blocked and invalid dependency state', () => {
    const host = freshContainer();
    const blockedBadge = renderDependencyBadge(host, blocked)!;
    const invalidBadge = renderDependencyBadge(host, {
      type: 'invalid',
      diagnostics: [{ type: 'missing-prerequisite', id: 'missing' }],
    })!;

    expect(blockedBadge.classList.contains('abyss-task-count-badge')).toBe(true);
    expect(blockedBadge.classList.contains('abyss-task-dependency-badge')).toBe(true);
    expect(blockedBadge.textContent?.trim()).toBe('1');
    expect(blockedBadge.getAttribute('aria-label')).toBe('Blocked by 1 prerequisite');
    expect(blockedBadge.getAttribute('title')).toBe('Blocked by 1 prerequisite');
    expect(invalidBadge.textContent?.trim()).toBe('1');
    expect(invalidBadge.getAttribute('aria-label')).toBe('Dependency issue');
    expect(invalidBadge.getAttribute('title')).toBe('Dependency issue');
  });
});

function workNote(): WorkNoteSnapshot {
  return {
    path: 'Work Notes/Accessible.md',
    presetRevision: 1,
    presetFingerprint: 'accepted',
    kind: 'ordinary',
    projectPath: 'Projects/Accessible.md',
    statusId: DEFAULT_SETTINGS.projects.statuses[0]!.id,
    rawStatus: null,
    writableStatusShape: true,
    priority: 'High',
    range: {},
    blockedByPaths: [],
    relatedPaths: [],
    diagnostics: [],
  };
}

function workspace(): ProjectWorkspaceSnapshot {
  return {
    project: {
      path: 'Projects/Accessible.md',
      name: 'Accessible',
      frontmatter: {},
      tags: [],
      statusId: DEFAULT_SETTINGS.projects.statuses[0]!.id,
      rawStatus: null,
      range: {},
      stats: { total: 4, done: 1, cancelled: 0, inProgress: 1, open: 2, progress: 0.25 },
    },
    tasks: [],
    workNotes: [workNote()],
    milestones: [],
    taskRollup: { total: 4, done: 1, cancelled: 0, inProgress: 1, open: 2, progress: 0.25 },
    workNoteRollup: { active: 1, completed: 0, dropped: 0 },
    milestoneRollups: new Map(),
    workNoteRelations: [],
    overdue: { tasks: 2, workNotes: 0 },
    dependencies: { blocked: 0, invalid: 0, diagnostics: [] },
    diagnostics: [
      {
        type: 'work-note',
        path: 'Work Notes/Accessible.md',
        diagnostic: { type: 'unknown-status' },
      },
    ],
  };
}

const INTERACTIVE_SELECTOR =
  'button, a[href], input, select, textarea, [contenteditable="true"], [role="button"], [role="checkbox"], [role="link"], [role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"], [role="radio"], [role="switch"], [role="tab"], [tabindex]:not([tabindex="-1"])';

function interactiveDescendants(root: HTMLElement): Element[] {
  return Array.from(root.querySelectorAll(INTERACTIVE_SELECTOR)).filter(
    (control) => control.closest('[hidden], [aria-hidden="true"]') === null,
  );
}

function expectNoNestedInteractive(root: HTMLElement): void {
  for (const control of interactiveDescendants(root)) {
    expect(control.parentElement?.closest(INTERACTIVE_SELECTOR), control.outerHTML).toBeNull();
  }
}

function visibleText(control: Element): string {
  const clone = control.cloneNode(true) as Element;
  clone
    .querySelectorAll('svg, .abyss-sr-only, [hidden], [aria-hidden="true"]')
    .forEach((element) => element.remove());
  return clone.textContent?.trim() ?? '';
}

function expectIconOnlyControlsNamed(root: HTMLElement): void {
  for (const control of interactiveDescendants(root)) {
    if (visibleText(control)) continue;
    expect(control.getAttribute('aria-label'), control.outerHTML).toBeTruthy();
    expect(control.getAttribute('title'), control.outerHTML).toBeTruthy();
    if (control.classList.contains('abyss-timeline-date-picker')) {
      expect((control as HTMLElement).tabIndex, control.outerHTML).toBe(-1);
      continue;
    }
    expect((control as HTMLElement).tabIndex, control.outerHTML).toBeGreaterThanOrEqual(0);
  }
}

describe('Projects collection accessibility', () => {
  it('renders Work Note rows as listitems with one dedicated identity control and no nested interactive ancestry', () => {
    const root = freshContainer();
    renderWorkNotesView(root, {
      notes: [workNote()],
      statuses: DEFAULT_SETTINGS.projects.statuses,
      layout: 'list',
      onSetStatus: vi.fn(),
      openNote: vi.fn(),
    });

    const row = root.querySelector<HTMLElement>('.abyss-work-note-row')!;
    expect(row.closest('[role="list"]')).not.toBeNull();
    expect(
      root.querySelectorAll('[data-bounded-window-edge]:not([aria-hidden="true"])'),
    ).toHaveLength(0);
    expect(row.getAttribute('role')).toBe('listitem');
    expect(row.hasAttribute('tabindex')).toBe(false);
    expect(row.querySelector('[data-work-note-identity-control]')).not.toBeNull();
    expect(row.querySelectorAll('[data-work-note-identity-control]')).toHaveLength(1);
    expectNoNestedInteractive(row);
    expectIconOnlyControlsNamed(row);
  });

  it('renders Project rows as listitems with separate lifecycle, health, and progress names', () => {
    const root = freshContainer();
    renderProjectsList(root, [workspace()], {
      state: new AppState(),
      settings: structuredClone(DEFAULT_SETTINGS),
      onSaveSettings: vi.fn().mockResolvedValue(undefined),
      onCreate: vi.fn().mockResolvedValue(undefined),
      onSetStatus: vi.fn(),
      openNote: vi.fn(),
    });

    const row = root.querySelector<HTMLElement>('.abyss-project-row')!;
    expect(row.closest('[role="list"]')).not.toBeNull();
    expect(row.getAttribute('role')).toBe('listitem');
    expect(row.hasAttribute('tabindex')).toBe(false);
    expect(
      row.querySelector('[data-project-identity-control]')?.getAttribute('aria-label'),
    ).toMatch(/status/u);
    expect(row.querySelector('[aria-label^="Project health:"]')).not.toBeNull();
    expect(row.querySelector('[role="progressbar"]')?.getAttribute('aria-label')).toMatch(
      /task progress/u,
    );
    expect(row.querySelector('.abyss-project-row-meta')).toBeNull();
    expect(row.querySelectorAll('[data-project-identity-control]')).toHaveLength(1);
    expectNoNestedInteractive(row);
    expectIconOnlyControlsNamed(row);
  });

  it('exposes task progress as a fully named progressbar while retaining compact text', () => {
    const root = freshContainer();
    renderProgressBar(root, 3, 8, 'Project task progress');

    const progress = root.querySelector<HTMLElement>('[role="progressbar"]')!;
    expect(progress.getAttribute('aria-label')).toBe('Project task progress');
    expect(progress.getAttribute('aria-valuemin')).toBe('0');
    expect(progress.getAttribute('aria-valuemax')).toBe('8');
    expect(progress.getAttribute('aria-valuenow')).toBe('3');
    expect(progress.textContent).toContain('3/8');
  });

  it('keeps Board, Timeline, and Work Note inspector controls free of interactive ancestry', () => {
    const board = freshContainer();
    renderBoard(board, {
      columns: [
        { key: 'active', label: 'Active', role: 'regular', items: [workNote()] },
        { key: 'done', label: 'Done', role: 'regular', items: [] },
      ],
      mutation: {
        move: vi.fn().mockResolvedValue({ type: 'ok' }),
        menuItems: () => [],
      },
      itemKey: ({ path }) => path,
      renderItem: (host, note) => {
        const group = host.createDiv({ attr: { role: 'group' } });
        group.createEl('button', { text: note.path, attr: { type: 'button', title: note.path } });
        group.createEl('button', {
          attr: { type: 'button', title: 'Open', 'aria-label': 'Open Work Note' },
        });
        return group;
      },
    });
    const timeline = freshContainer();
    renderTimeline(timeline, {
      entries: [
        {
          value: workNote(),
          label: 'Accessible Work Note',
          item: {
            kind: 'point',
            key: 'work-note:accessible',
            atMs: Date.parse('2026-08-28T00:00:00Z'),
            role: 'end',
          },
          dateByRole: { end: '2026-08-28' },
        },
      ],
      onSetDate: vi.fn().mockResolvedValue({ type: 'ok' }),
    });
    const inspector = freshContainer();
    renderWorkNoteInspector(inspector, workNote(), {
      statuses: DEFAULT_SETTINGS.projects.statuses,
      onSetStatus: vi.fn().mockResolvedValue({ type: 'ok', path: workNote().path }),
      openNote: vi.fn(),
      onClose: vi.fn(),
    });

    expectNoNestedInteractive(board);
    expectNoNestedInteractive(timeline);
    expectNoNestedInteractive(inspector);
    expectIconOnlyControlsNamed(board);
    expectIconOnlyControlsNamed(timeline);
    expectIconOnlyControlsNamed(inspector);
  });

  it('uses valid zero-total progress semantics', () => {
    const root = freshContainer();
    renderProgressBar(root, 0, 0, 'Empty Project task progress');
    const progress = root.querySelector<HTMLElement>('[role="progressbar"]')!;

    expect(progress.getAttribute('aria-valuemin')).toBe('0');
    expect(progress.getAttribute('aria-valuemax')).toBe('100');
    expect(progress.getAttribute('aria-valuenow')).toBe('0');
    expect(progress.getAttribute('aria-valuetext')).toBe('No tasks');
  });
});

describe('Projects keyboard route accessibility', () => {
  it('exposes exactly one named collection toolbar with keyboard-native controls', () => {
    const root = freshContainer();
    const activate = vi.fn();
    const query = vi.fn();
    renderCollectionControls(root, {
      query: '',
      searchLabel: 'Search projects',
      toolbarLabel: 'Projects controls',
      actions: [
        {
          kind: 'filter',
          label: 'Filter projects',
          icon: 'filter',
          onActivate: activate,
        },
      ],
      onQueryInput: query,
    });

    expect(root.querySelectorAll('[role="toolbar"]')).toHaveLength(1);
    expect(root.querySelector('[role="toolbar"]')?.getAttribute('aria-label')).toBe(
      'Projects controls',
    );
    const filter = root.querySelector<HTMLButtonElement>('[aria-label="Filter projects"]')!;
    const search = root.querySelector<HTMLInputElement>('[aria-label="Search projects"]')!;
    expect(filter.tabIndex).toBe(0);
    expect(search.tabIndex).toBe(0);
    filter.click();
    search.value = 'ship';
    search.dispatchEvent(new Event('input', { bubbles: true }));
    expect(activate).toHaveBeenCalledOnce();
    expect(query).toHaveBeenCalledWith('ship');
  });

  it('closes a narrow inspector with Escape and restores the invoking control', () => {
    const fixture = document.createElement('div');
    document.body.appendChild(fixture);
    const trigger = fixture.createEl('button', { text: 'Open project' });
    const host = fixture.createDiv();
    const close = vi.fn();
    const shell = mountInspectorShell(host, {
      label: 'Project inspector',
      narrow: true,
      returnFocus: trigger,
      onRequestClose: close,
      render: (content) => {
        content.createEl('input', { attr: { 'aria-label': 'Project title' } });
      },
    });

    shell.element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

    expect(close).toHaveBeenCalledOnce();
    expect(shell.element.isConnected).toBe(false);
    expect(document.activeElement).toBe(trigger);
    fixture.remove();
  });

  it('activates the focused Task table cell with Enter', () => {
    const root = freshContainer();
    document.body.appendChild(root);
    const action: ProjectAction = {
      task: task({ title: 'Keyboard task' }),
      projectPath: 'Projects/Accessible.md',
      dependency: { type: 'allowed' },
      owner: { type: 'project', path: 'Projects/Accessible.md' },
    };
    const activate = vi.fn();
    renderProjectTasksTable(root, [action], {
      settings: structuredClone(DEFAULT_SETTINGS),
      path: action.projectPath,
      onActivate: activate,
    });
    const cell = root.querySelector<HTMLElement>('[role="cell"][data-table-column="task"]')!;

    cell.focus();
    cell.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    );

    expect(document.activeElement).toBe(cell);
    expect(activate).toHaveBeenCalledWith(action);
    root.remove();
  });

  it('moves a focused Board card entirely from the keyboard', async () => {
    const root = freshContainer();
    const item = { id: 'keyboard-card', label: 'Keyboard card' };
    const move = vi.fn().mockResolvedValue({ type: 'ok' });
    renderBoard(root, {
      columns: [
        { key: 'todo', label: 'To-do', role: 'regular', items: [item] },
        { key: 'doing', label: 'Doing', role: 'regular', items: [] },
      ],
      mutation: { move, menuItems: () => [] },
      itemKey: ({ id }) => id,
      itemLabel: ({ label }) => label,
      renderItem: (host, { label }) => host.createEl('button', { text: label }),
      interactionController: true,
    });
    const card = root.querySelector<HTMLElement>('[data-board-item-focus="keyboard-card"]')!;

    card.focus();
    card.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true }));
    card.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }),
    );
    card.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true }));
    await Promise.resolve();
    await Promise.resolve();

    expect(move).toHaveBeenCalledWith(item, 'doing');
  });

  it('opens and commits a Timeline date editor from the keyboard', async () => {
    const fixture = document.createElement('div');
    document.body.appendChild(fixture);
    const onSetDate = vi.fn().mockResolvedValue({ type: 'ok' });
    renderTimeline(fixture, {
      entries: [
        {
          value: workNote(),
          label: 'Keyboard timeline item',
          item: {
            kind: 'point',
            key: 'work-note:keyboard',
            atMs: Date.parse('2026-08-28T00:00:00Z'),
            role: 'end',
          },
          dateByRole: { end: '2026-08-28' },
        },
      ],
      onSetDate,
    });
    const trigger = fixture.querySelector<HTMLElement>('[data-timeline-primary]')!;
    const editor = fixture.querySelector<HTMLInputElement>('[data-timeline-date-picker="end"]')!;

    trigger.focus();
    trigger.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    );
    expect(document.activeElement).toBe(editor);
    editor.value = '2026-08-29';
    editor.dispatchEvent(new Event('change', { bubbles: true }));
    await Promise.resolve();
    await Promise.resolve();
    expect(onSetDate).toHaveBeenCalledWith(
      expect.objectContaining({ label: 'Keyboard timeline item' }),
      'end',
      '2026-08-29',
      editor,
    );
    fixture.remove();
  });
});
