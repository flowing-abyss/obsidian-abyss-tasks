// eslint-disable-next-line import/no-nodejs-modules -- responsive geometry contract loads shipped CSS.
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { AppState } from '../src/app/AppState';
import {
  renderContainerResponsiveTimeline,
  renderProjectsTimeline,
  renderTasksTimeline,
  renderTimeline,
  renderWorkNotesTimeline,
  TIMELINE_MARKER_DOM_CAP,
  type TimelineEntry,
} from '../src/panels/projects/ProjectsTimelineView';
import type { LogicalViewportSession } from '../src/panels/projects/ProjectWorkspaceSession';
import type { TimelineItem } from '../src/panels/projects/timelineProjection';
import { ProjectCommandService } from '../src/projects/ProjectCommandService';
import { parseProjectRange } from '../src/projects/projectDates';
import type { Project, ProjectWorkspaceSnapshot } from '../src/projects/types';
import type { WorkNoteSnapshot } from '../src/projects/work-notes/types';
import { createAppWithFiles, deferred, flushMicrotasks, freshContainer, task } from './helpers';

const shippedStyles = readFileSync(`${import.meta.dirname}/../styles.css`, 'utf8');

interface Fixture {
  readonly id: string;
}

function point(id: string, date = '2026-08-27'): TimelineEntry<Fixture> {
  return {
    value: { id },
    label: id,
    item: {
      kind: 'point',
      key: `task:${id}`,
      atMs: Date.parse(`${date}T00:00:00.000Z`),
      role: 'due',
    },
    dateByRole: { due: date },
  };
}

function entry(item: TimelineItem, id: string): TimelineEntry<Fixture> {
  return { value: { id }, label: id, item, dateByRole: {} };
}

function range(id: string): TimelineEntry<Fixture> {
  return {
    value: { id },
    label: id,
    item: {
      kind: 'range',
      key: `task:${id}`,
      startMs: Date.UTC(2026, 7, 27),
      endMs: Date.UTC(2026, 7, 29),
    },
    dateByRole: { start: '2026-08-27', end: '2026-08-29' },
  };
}

function workNote(path: string, overrides: Partial<WorkNoteSnapshot> = {}): WorkNoteSnapshot {
  return {
    path,
    presetRevision: 1,
    presetFingerprint: 'fingerprint',
    kind: 'ordinary',
    projectPath: 'Projects/Launch.md',
    statusId: null,
    rawStatus: null,
    writableStatusShape: true,
    range: {},
    blockedByPaths: [],
    relatedPaths: [],
    diagnostics: [],
    ...overrides,
  };
}

function workspaceSnapshot(
  project: Project,
  input: {
    readonly tasks?: ProjectWorkspaceSnapshot['tasks'];
    readonly workNotes?: readonly WorkNoteSnapshot[];
    readonly milestones?: readonly WorkNoteSnapshot[];
  } = {},
): ProjectWorkspaceSnapshot {
  return {
    project,
    tasks: input.tasks ?? [],
    workNotes: input.workNotes ?? [],
    milestones: input.milestones ?? [],
    taskRollup: project.stats,
    workNoteRollup: { active: 0, completed: 0, dropped: 0 },
    milestoneRollups: new Map(),
    workNoteRelations: [],
    overdue: { tasks: 0, workNotes: 0 },
    dependencies: { blocked: 0, invalid: 0, diagnostics: [] },
    diagnostics: [],
  };
}

function pointerEvent(
  type: string,
  values: { readonly pointerId: number; readonly clientX: number; readonly clientY?: number },
): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    pointerId: { value: values.pointerId },
    button: { value: 0 },
    isPrimary: { value: true },
    clientX: { value: values.clientX },
    clientY: { value: values.clientY ?? 0 },
  });
  return event;
}

describe('shared Timeline view', () => {
  it('opens a portfolio Project dashboard from its one native title button', () => {
    const container = freshContainer();
    const state = new AppState();
    const project: Project = {
      path: 'Projects/Launch.md',
      name: 'Launch',
      frontmatter: { start: '2026-08-27' },
      tags: [],
      statusId: null,
      rawStatus: null,
      range: {
        start: {
          raw: '2026-08-27',
          precision: 'date',
          instantMs: Date.UTC(2026, 7, 27),
        },
      },
      stats: { total: 0, done: 0, cancelled: 0, inProgress: 0, open: 0, progress: null },
    };
    const options = {
      projects: [project],
      commands: { observeRange: vi.fn(), setRange: vi.fn() } as never,
      openProject: (path: string) => state.set('projectsPanel', { view: 'dashboard', path }),
    } as Parameters<typeof renderProjectsTimeline>[1] & {
      openProject(path: string): void;
    };
    renderProjectsTimeline(container, options);

    const identity = container.querySelector<HTMLButtonElement>('[data-project-identity-control]')!;
    expect(identity.tagName).toBe('BUTTON');
    expect(identity.type).toBe('button');
    expect(identity.textContent).toContain('Launch');
    expect(container.querySelectorAll('[data-project-identity-control]')).toHaveLength(1);
    expect(container.querySelectorAll('[aria-label^="Open project"]')).toHaveLength(1);

    identity.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 0 }));

    expect(state.get('projectsPanel')).toEqual({
      view: 'dashboard',
      path: 'Projects/Launch.md',
    });
  });

  it('renders a quiet Project identity rail with priority and compact health but no path or endpoint labels', () => {
    const container = freshContainer();
    const project: Project = {
      path: 'Projects/Launch.md',
      name: 'Launch',
      frontmatter: { start: '2026-08-27', end: '2026-08-29', priority: 'A' },
      tags: [],
      statusId: null,
      rawStatus: null,
      priority: 'A',
      range: parseProjectRange('2026-08-27', '2026-08-29'),
      stats: { total: 0, done: 0, cancelled: 0, inProgress: 0, open: 0, progress: null },
    };
    renderProjectsTimeline(container, {
      projects: [project],
      snapshots: [workspaceSnapshot(project)],
      commands: { observeRange: vi.fn(), setRange: vi.fn() } as never,
      today: '2026-08-27',
      openProject: vi.fn(),
    });

    const identity = container.querySelector<HTMLElement>('.abyss-project-timeline-identity')!;
    expect(identity.querySelector('.abyss-project-health')).not.toBeNull();
    expect(identity.querySelector('[data-priority="A"]')?.textContent).toBe('A');
    expect(identity.textContent).toContain('Launch');
    expect(identity.textContent).not.toContain('Projects/Launch.md');
    expect(container.textContent).not.toMatch(/\bStart\b|\bEnd\b/u);
  });

  it('renders joined milestones as typed portfolio rows and routes selection to the Work Note action', () => {
    const container = freshContainer();
    const project: Project = {
      path: 'Projects/Launch.md',
      name: 'Launch',
      frontmatter: { start: '2026-08-27' },
      tags: [],
      statusId: null,
      rawStatus: null,
      range: parseProjectRange('2026-08-27', undefined),
      stats: { total: 0, done: 0, cancelled: 0, inProgress: 0, open: 0, progress: null },
    };
    const ordinary = workNote('Work Notes/Ordinary.md', {
      range: parseProjectRange('2026-08-28', undefined),
    });
    const milestone = workNote('Work Notes/Launch milestone.md', {
      kind: 'milestone',
      updated: '2026-08-29',
    });
    const ownedTask = task({
      title: 'Excluded portfolio task',
      source: { filePath: 'Projects/Launch.md', line: 11 },
      planning: { due: '2026-08-29' },
    });
    const ownedAction: ProjectWorkspaceSnapshot['tasks'][number] = {
      task: ownedTask,
      projectPath: project.path,
      dependency: { type: 'allowed' },
      owner: { type: 'project', path: project.path },
    };
    const onSelectMilestone = vi.fn();
    renderProjectsTimeline(container, {
      projects: [project],
      snapshots: [
        workspaceSnapshot(project, {
          tasks: [ownedAction],
          workNotes: [ordinary],
          milestones: [milestone],
        }),
      ],
      commands: { observeRange: vi.fn(), setRange: vi.fn() } as never,
      onSelectMilestone,
    });

    expect(container.textContent).not.toContain('Ordinary');
    expect(container.textContent).not.toContain('Excluded portfolio task');
    expect(container.querySelector('[data-timeline-key^="task:"]')).toBeNull();
    const control = container.querySelector<HTMLButtonElement>(
      '[data-project-milestone-identity-control]',
    )!;
    expect(control.textContent).toContain('Launch milestone');
    expect(control.closest('[data-timeline-key]')?.getAttribute('data-timeline-key')).toBe(
      'work-note:Work Notes/Launch milestone.md',
    );
    control.click();
    expect(onSelectMilestone).toHaveBeenCalledWith(milestone, control);
  });

  it('keeps a fully undated Project actionable and creates only its owned start field', async () => {
    const container = freshContainer();
    const project: Project = {
      path: 'Projects/Undated.md',
      name: 'Undated',
      frontmatter: { unrelated: 'keep' },
      tags: [],
      statusId: null,
      rawStatus: null,
      range: {},
      stats: { total: 0, done: 0, cancelled: 0, inProgress: 0, open: 0, progress: null },
    };
    const setRange = vi
      .fn()
      .mockResolvedValue({ type: 'ok', range: parseProjectRange('2026-08-30', undefined) });
    renderProjectsTimeline(container, {
      projects: [project],
      commands: { observeRange: () => ({ path: project.path }), setRange } as never,
    });

    const planning = container.querySelector<HTMLDetailsElement>(
      '[data-timeline-tray="planning"]',
    )!;
    expect(planning.open).toBe(true);
    const schedule = planning.querySelector<HTMLInputElement>('[data-timeline-schedule]')!;
    schedule.value = '2026-08-30';
    schedule.dispatchEvent(new Event('change', { bubbles: true }));
    await flushMicrotasks();

    expect(setRange).toHaveBeenCalledWith(
      { path: project.path },
      { start: expect.objectContaining({ raw: '2026-08-30' }) },
    );
  });

  it('shows an exact reversed-range repair preview and mutates only after confirmation', async () => {
    const app = await createAppWithFiles({
      'Projects/Reversed.md': '---\nstart: 2026-08-30\nend: 2026-08-20\n---\n# Reversed\n',
    });
    const project: Project = {
      path: 'Projects/Reversed.md',
      name: 'Reversed',
      frontmatter: { start: '2026-08-30', end: '2026-08-20' },
      tags: [],
      statusId: null,
      rawStatus: null,
      range: parseProjectRange('2026-08-30', '2026-08-20'),
      stats: { total: 0, done: 0, cancelled: 0, inProgress: 0, open: 0, progress: null },
    };
    const writes = vi.spyOn(app.vault, 'modify');
    const container = freshContainer();
    renderProjectsTimeline(container, {
      projects: [project],
      commands: new ProjectCommandService(app, () => []),
    });

    const invalid = container.querySelector<HTMLDetailsElement>('[data-timeline-tray="invalid"]')!;
    invalid.open = true;
    expect(invalid.textContent).toContain('reversed');
    expect(invalid.querySelector('[data-timeline-repair-preview]')?.textContent).toContain(
      '2026-08-20 – 2026-08-30',
    );
    expect(writes).not.toHaveBeenCalled();

    invalid.querySelector<HTMLButtonElement>('[data-timeline-repair-confirm]')!.click();
    await flushMicrotasks();
    const file = app.vault.getMarkdownFiles().find(({ path }) => path === project.path)!;
    const markdown = await app.vault.read(file);
    expect(markdown).toContain('start: 2026-08-20');
    expect(markdown).toContain('end: 2026-08-30');
    expect(writes).toHaveBeenCalledOnce();
  });

  it('opens a Work Note from its native title button when date mutation is disabled', () => {
    const container = freshContainer();
    const onSelect = vi.fn();
    const note: WorkNoteSnapshot = {
      path: 'Work Notes/Read only.md',
      presetRevision: 1,
      presetFingerprint: 'fingerprint',
      kind: 'ordinary',
      projectPath: 'Projects/Launch.md',
      statusId: null,
      rawStatus: null,
      writableStatusShape: false,
      range: {
        start: {
          raw: '2026-08-27',
          precision: 'date',
          instantMs: Date.UTC(2026, 7, 27),
        },
      },
      blockedByPaths: [],
      relatedPaths: [],
      diagnostics: [],
    };
    const options = {
      notes: [note],
      commandsEnabled: false,
      commands: { observeRange: vi.fn(), setRange: vi.fn() } as never,
      onSelect,
    } as Parameters<typeof renderWorkNotesTimeline>[1] & {
      onSelect(note: WorkNoteSnapshot, origin: HTMLElement): void;
    };
    renderWorkNotesTimeline(container, options);

    const identity = container.querySelector<HTMLButtonElement>(
      '[data-work-note-identity-control]',
    )!;
    expect(identity.tagName).toBe('BUTTON');
    expect(identity.type).toBe('button');
    expect(identity.textContent).toContain('Read only');
    expect(container.querySelectorAll('[data-work-note-identity-control]')).toHaveLength(1);
    expect(container.querySelectorAll('[aria-label^="Work note details"]')).toHaveLength(1);

    identity.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 0 }));

    expect(onSelect).toHaveBeenCalledWith(note, identity);
  });

  it('falls back to opening a Work Note when no common-host selection adapter is supplied', () => {
    const container = freshContainer();
    const openNote = vi.fn();
    const note: WorkNoteSnapshot = {
      path: 'Work Notes/Legacy.md',
      presetRevision: 1,
      presetFingerprint: 'fingerprint',
      kind: 'ordinary',
      projectPath: 'Projects/Launch.md',
      statusId: null,
      rawStatus: null,
      writableStatusShape: false,
      range: {
        start: {
          raw: '2026-08-27',
          precision: 'date',
          instantMs: Date.UTC(2026, 7, 27),
        },
      },
      blockedByPaths: [],
      relatedPaths: [],
      diagnostics: [],
    };
    renderWorkNotesTimeline(container, {
      notes: [note],
      commandsEnabled: false,
      commands: { observeRange: vi.fn(), setRange: vi.fn() } as never,
      openNote,
    });

    container.querySelector<HTMLButtonElement>('[data-work-note-identity-control]')!.click();

    expect(openNote).toHaveBeenCalledWith(note.path);
  });

  it('keeps the shared noninteractive identity fallback out of the tab order without a dead opener', () => {
    const container = freshContainer();
    renderTimeline(container, { entries: [point('Fallback')] });

    const identity = container.querySelector<HTMLElement>('.abyss-timeline-identity')!;
    expect(identity.hasAttribute('tabindex')).toBe(false);
    expect(identity.querySelector('button, a[href], [role="button"]')).toBeNull();
    expect(container.querySelector('[aria-label^="Open "]')).toBeNull();
  });

  it('draws ranges and retained-role points against the shared date spine', () => {
    const container = freshContainer();
    renderTimeline(container, {
      entries: [
        {
          value: { id: 'Range' },
          label: 'Range',
          item: {
            kind: 'range',
            key: 'project:Range',
            startMs: Date.UTC(2026, 7, 27),
            endMs: Date.UTC(2026, 7, 29),
          },
          dateByRole: { start: '2026-08-27', end: '2026-08-29' },
        },
        point('Point', '2026-08-28'),
      ],
      dateWindow: { from: '2026-08-26', to: '2026-08-30' },
    });

    expect(container.querySelector('[data-timeline-range]')).not.toBeNull();
    expect(container.querySelector('[data-timeline-point="due"]')).not.toBeNull();
  });

  it('exposes every civil date in a 90-day continuous coordinate space without drop cells', () => {
    const container = freshContainer();
    renderTimeline(container, {
      entries: [
        {
          value: { id: 'Quarter' },
          label: 'Quarter',
          item: {
            kind: 'range',
            key: 'project:Quarter',
            startMs: Date.UTC(2026, 5, 1),
            endMs: Date.UTC(2026, 7, 29),
          },
          dateByRole: { start: '2026-06-01', end: '2026-08-29' },
        },
      ],
      dateWindow: { from: '2026-06-01', to: '2026-08-29' },
    });

    const coordinates = Array.from(
      container.querySelectorAll<HTMLElement>('[data-timeline-date-coordinate]'),
      (marker) => marker.dataset.timelineDateCoordinate,
    );
    expect(coordinates).toHaveLength(92);
    expect(new Set(coordinates).size).toBe(92);
    expect(coordinates[0]).toBe('2026-05-31');
    expect(coordinates[91]).toBe('2026-08-30');
    expect(container.querySelector('[data-timeline-drop-date]')).toBeNull();
    expect(container.querySelector('[data-timeline-range]')).not.toBeNull();
  });

  it('keeps a long desktop date axis scannable instead of rendering overlapping daily labels', () => {
    const container = freshContainer();
    renderTimeline(container, {
      entries: [
        {
          value: { id: 'Long range' },
          label: 'Long range',
          item: {
            kind: 'range',
            key: 'project:Long range',
            startMs: Date.UTC(2026, 7, 1),
            endMs: Date.UTC(2026, 8, 11),
          },
          dateByRole: { start: '2026-08-01', end: '2026-09-11' },
        },
      ],
      dateWindow: { from: '2026-08-01', to: '2026-09-11' },
    });

    const labels = Array.from(
      container.querySelectorAll('.abyss-timeline-axis-dates > span'),
      (label) => label.textContent,
    ).filter((label): label is string => Boolean(label));
    const coordinates = container.querySelectorAll('[data-timeline-date-coordinate]');

    expect(labels.length).toBeGreaterThanOrEqual(2);
    expect(labels.length).toBeLessThanOrEqual(8);
    expect(labels[0]).toBe('07-31');
    expect(labels[labels.length - 1]).toBe('09-12');
    expect(coordinates).toHaveLength(44);
  });

  it('fills the available desktop plot and spaces exact axis labels away from the grips', () => {
    const container = freshContainer();
    const session = {
      firstKey: null,
      firstIndex: 0,
      focusedKey: null,
      restoreFocus: false,
      focalDate: '2026-08-28',
      scrollLeft: 0,
      scale: 'quarter',
      identityWidth: 240,
      focusedInteraction: null,
    };
    renderTimeline(container, {
      entries: [range('A')],
      dateWindow: { from: '2026-08-27', to: '2026-08-29' },
      scope: 'portfolio',
      session,
    } as Parameters<typeof renderTimeline<Fixture>>[1]);
    const scroll = container.querySelector<HTMLElement>('.abyss-timeline-scroll')!;
    Object.defineProperty(scroll, 'clientWidth', { configurable: true, value: 1_200 });

    const scale = container.querySelector<HTMLSelectElement>('[data-timeline-scale]')!;
    scale.value = 'quarter';
    scale.dispatchEvent(new Event('change', { bubbles: true }));

    const canvas = container.querySelector<HTMLElement>('.abyss-timeline-canvas')!;
    const plotWidth = Number.parseFloat(
      canvas.style.getPropertyValue('--abyss-timeline-plot-width'),
    );
    const labels = Array.from(
      container.querySelectorAll<HTMLElement>('[data-timeline-axis-label-date]'),
    );
    const positions = labels
      .map((label) => Number.parseFloat(label.style.insetInlineStart))
      .sort((left, right) => left - right);

    expect(plotWidth).toBeGreaterThanOrEqual(960);
    expect(labels.map(({ dataset }) => dataset.timelineAxisLabelDate)).toContain('2026-08-28');
    expect(labels[0]?.dataset.timelineAxisLabelAlign).toBe('start');
    expect(labels[labels.length - 1]?.dataset.timelineAxisLabelAlign).toBe('end');
    for (let index = 1; index < positions.length; index += 1) {
      expect(positions[index]! - positions[index - 1]!).toBeGreaterThanOrEqual(48);
    }

    scale.value = 'week';
    scale.dispatchEvent(new Event('change', { bubbles: true }));
    const weekWidth = Number.parseFloat(
      canvas.style.getPropertyValue('--abyss-timeline-plot-width'),
    );
    expect(weekWidth).toBeGreaterThanOrEqual(960);
    expect(weekWidth).toBeLessThan(2_000);
  });

  it('commits a whole-range move atomically while keeping edge resizes role-scoped', async () => {
    const container = freshContainer();
    const onSetDate = vi.fn().mockResolvedValue({ type: 'ok' });
    const onSetRange = vi.fn().mockResolvedValue({ type: 'ok' });
    renderTimeline(container, {
      entries: [range('A')],
      onSetDate,
      onSetRange,
      dateWindow: { from: '2026-08-26', to: '2026-08-30' },
    });
    const move = container.querySelector<HTMLElement>('[data-timeline-target="range-move"]')!;
    const start = container.querySelector<HTMLElement>('[data-timeline-target="start-edge"]')!;
    const end = container.querySelector<HTMLElement>('[data-timeline-target="end-edge"]')!;

    for (const [target, delta] of [
      [move, 12],
      [start, -12],
      [end, 12],
    ] as const) {
      target.dispatchEvent(pointerEvent('pointerdown', { pointerId: 3, clientX: 100 }));
      activeDocument.dispatchEvent(
        pointerEvent('pointermove', { pointerId: 3, clientX: 100 + delta }),
      );
      activeDocument.dispatchEvent(
        pointerEvent('pointerup', { pointerId: 3, clientX: 100 + delta }),
      );
      await flushMicrotasks();
    }

    expect(onSetRange).toHaveBeenCalledOnce();
    expect(onSetRange).toHaveBeenCalledWith(
      expect.objectContaining({ label: 'A' }),
      '2026-08-28',
      '2026-08-30',
      move,
    );
    expect(onSetDate.mock.calls.map((call) => call.slice(1, 3))).toEqual([
      ['start', '2026-08-26'],
      ['end', '2026-08-30'],
    ]);
  });

  it('explicitly disables whole-range movement when an adapter has no atomic range command', () => {
    const container = freshContainer();
    renderTimeline(container, {
      entries: [range('A')],
      onSetDate: () => ({ type: 'ok' }),
      dateWindow: { from: '2026-08-26', to: '2026-08-30' },
    });

    const move = container.querySelector<HTMLButtonElement>('[data-timeline-target="range-move"]')!;
    expect(move.disabled).toBe(true);
    expect(move.getAttribute('aria-disabled')).toBe('true');
    expect(container.querySelectorAll('[data-timeline-target="start-edge"]')).toHaveLength(1);
    expect(container.querySelectorAll('[data-timeline-target="end-edge"]')).toHaveLength(1);
  });

  it('preserves focal date while changing scale and centers Today without changing metadata', () => {
    const container = freshContainer();
    const session = {
      firstKey: null,
      firstIndex: 0,
      focusedKey: null,
      restoreFocus: false,
      focalDate: '2026-08-20',
      scrollLeft: 120,
      scale: 'month',
      identityWidth: 240,
      focusedInteraction: null,
    };
    renderTimeline(container, {
      entries: [range('A')],
      dateWindow: { from: '2026-08-01', to: '2026-09-30' },
      scope: 'portfolio',
      today: '2026-08-30',
      session,
    } as Parameters<typeof renderTimeline<Fixture>>[1]);

    const scale = container.querySelector<HTMLSelectElement>('[data-timeline-scale]')!;
    scale.value = 'week';
    scale.dispatchEvent(new Event('change', { bubbles: true }));

    expect(session.scale).toBe('week');
    expect(session.focalDate).toBe('2026-08-20');
    expect(session.scrollLeft).toBeGreaterThanOrEqual(0);

    container.querySelector<HTMLButtonElement>('[data-timeline-today]')!.click();
    expect(session.focalDate).toBe('2026-08-30');
    expect(range('A').dateByRole).toEqual({ start: '2026-08-27', end: '2026-08-29' });
  });

  it('keeps Today durable when a Year fill contains it outside the immutable content window', () => {
    const container = freshContainer();
    const focalEntry = point('Winter project', '2026-01-15');
    const originalMetadata = { ...focalEntry.dateByRole };
    const session = {
      firstKey: null,
      firstIndex: 0,
      focusedKey: null,
      restoreFocus: false,
      focalDate: '2026-01-15',
      scrollLeft: 0,
      scale: 'year',
      identityWidth: 240,
      focusedInteraction: null,
    };
    renderTimeline(container, {
      entries: [focalEntry],
      dateWindow: { from: '2026-01-14', to: '2026-01-16' },
      scope: 'portfolio',
      today: '2026-06-15',
      session,
    } as Parameters<typeof renderTimeline<Fixture>>[1]);
    const scroll = container.querySelector<HTMLElement>('.abyss-timeline-scroll')!;
    Object.defineProperties(scroll, {
      clientWidth: { configurable: true, value: 1_200 },
      scrollWidth: { configurable: true, value: 20_000 },
    });
    const scale = container.querySelector<HTMLSelectElement>('[data-timeline-scale]')!;
    scale.value = 'year';
    scale.dispatchEvent(new Event('change', { bubbles: true }));

    expect(container.querySelector('[data-timeline-today-line]')).not.toBeNull();
    container.querySelector<HTMLButtonElement>('[data-timeline-today]')!.click();
    scale.value = 'week';
    scale.dispatchEvent(new Event('change', { bubbles: true }));

    expect(session.focalDate).toBe('2026-06-15');
    expect(container.querySelector('[data-timeline-today-line]')).not.toBeNull();
    expect(
      Array.from(
        container.querySelectorAll<HTMLElement>('[data-timeline-axis-label-date]'),
        ({ dataset }) => dataset.timelineAxisLabelDate,
      ),
    ).toContain('2026-06-15');
    expect(focalEntry.dateByRole).toEqual(originalMetadata);
  });

  it.each([
    ['historical', '1926-01-02', 0],
    ['future', '2126-12-30', 300_000],
  ] as const)(
    'virtualizes coordinates while keeping a %s item recoverable in the same canvas',
    (_, itemDate, minimumDistantX) => {
      const container = freshContainer();
      const session = {
        firstKey: null,
        firstIndex: 0,
        focusedKey: null,
        restoreFocus: false,
        focalDate: itemDate,
        scrollLeft: 0,
        scale: 'month',
        identityWidth: 240,
        focusedInteraction: null,
      };
      renderTimeline(container, {
        entries: [point('Distant', itemDate)],
        today: '2026-08-30',
        session,
      } as Parameters<typeof renderTimeline<Fixture>>[1]);
      const scroll = container.querySelector<HTMLElement>('.abyss-timeline-scroll')!;
      Object.defineProperties(scroll, {
        clientWidth: { configurable: true, value: 600 },
        scrollWidth: { configurable: true, value: 20_000_000 },
      });

      container.querySelector<HTMLButtonElement>('[data-timeline-today]')!.click();

      const coordinates = Array.from(
        container.querySelectorAll<HTMLElement>('[data-timeline-date-coordinate]'),
        (marker) => marker.dataset.timelineDateCoordinate,
      );
      expect(coordinates.length).toBeLessThanOrEqual(TIMELINE_MARKER_DOM_CAP);
      expect(coordinates).toContain('2026-08-30');
      expect(coordinates).not.toContain(itemDate);
      expect(container.querySelector('[data-timeline-today-line]')).not.toBeNull();
      const distantPoint = container.querySelector<HTMLElement>(
        '[data-timeline-key="task:Distant"][data-timeline-point]',
      )!;
      expect(distantPoint).not.toBeNull();
      expect(
        container.querySelector(
          '[data-timeline-key="task:Distant"][data-timeline-date-picker="due"]',
        ),
      ).not.toBeNull();
      expect(session.focalDate).toBe('2026-08-30');
      expect(session.scrollLeft).toBe(scroll.scrollLeft);
      expect(scroll.scrollLeft).toBeGreaterThan(0);

      const canvas = container.querySelector<HTMLElement>('.abyss-timeline-canvas')!;
      const plotWidth = Number.parseFloat(
        canvas.style.getPropertyValue('--abyss-timeline-plot-width'),
      );
      const distantX = Number.parseFloat(distantPoint.style.insetInlineStart);
      expect(plotWidth).toBeGreaterThan(300_000);
      expect(distantX).toBeGreaterThan(minimumDistantX);
      expect(distantX).toBeLessThan(plotWidth);

      const distantScrollLeft = Math.max(0, 240 + distantX - 180);
      scroll.scrollLeft = distantScrollLeft;
      expect(scroll.scrollLeft).toBe(distantScrollLeft);
      scroll.dispatchEvent(new Event('scroll'));
      expect(session.scrollLeft).toBe(distantScrollLeft);

      const localCoordinates = Array.from(
        container.querySelectorAll<HTMLElement>('[data-timeline-date-coordinate]'),
        (marker) => marker.dataset.timelineDateCoordinate,
      );
      expect(localCoordinates.length).toBeLessThanOrEqual(TIMELINE_MARKER_DOM_CAP);
      expect(localCoordinates).toContain(itemDate);
      expect(
        Array.from(
          container.querySelectorAll<HTMLElement>('.abyss-timeline-axis-dates > span'),
        ).some((label) => label.textContent?.startsWith(itemDate.slice(5, 7))),
      ).toBe(true);
      expect(
        container.querySelector('[data-timeline-key="task:Distant"][data-timeline-point]'),
      ).toBe(distantPoint);
    },
  );

  it.each(
    (
      [
        ['portfolio', 'week'],
        ['portfolio', 'month'],
        ['portfolio', 'quarter'],
        ['portfolio', 'year'],
        ['tasks', 'day'],
        ['tasks', 'week'],
        ['tasks', 'month'],
        ['workNotes', 'day'],
        ['workNotes', 'week'],
        ['workNotes', 'month'],
        ['workNotes', 'quarter'],
        ['workNotes', 'year'],
      ] as const
    ).flatMap(([scope, scale]) =>
      ([600, 1200] as const).map((width) => [scope, scale, width] as const),
    ),
  )(
    'caps %s %s coordinate markers at %ipx while retaining the active date',
    (scope, scale, width) => {
      const container = freshContainer();
      renderTimeline(container, {
        entries: [point('Active date', '2026-08-30')],
        dateWindow: { from: '1926-01-02', to: '2026-08-30' },
        scope,
        scale,
      });
      const scroll = container.querySelector<HTMLElement>('.abyss-timeline-scroll')!;
      const canvas = container.querySelector<HTMLElement>('.abyss-timeline-canvas')!;
      const pointControl = container.querySelector<HTMLElement>('[data-timeline-point="due"]')!;
      const plotWidth = Number.parseFloat(
        canvas.style.getPropertyValue('--abyss-timeline-plot-width'),
      );
      const pointX = Number.parseFloat(pointControl.style.insetInlineStart);
      Object.defineProperties(scroll, {
        clientWidth: { configurable: true, value: width },
        scrollWidth: { configurable: true, value: plotWidth + 240 },
      });
      scroll.scrollLeft = Math.max(0, 240 + pointX - (width - 240) / 2);
      scroll.dispatchEvent(new Event('scroll'));

      const coordinates = Array.from(
        container.querySelectorAll<HTMLElement>('[data-timeline-date-coordinate]'),
        (marker) => marker.dataset.timelineDateCoordinate,
      );
      expect(coordinates.length).toBeLessThanOrEqual(TIMELINE_MARKER_DOM_CAP);
      expect(coordinates).toContain('2026-08-30');
      expect(
        Array.from(
          container.querySelectorAll<HTMLElement>('[data-timeline-axis-label-date]'),
          (label) => label.dataset.timelineAxisLabelDate,
        ),
      ).toContain('2026-08-30');
      expect(plotWidth).toBeGreaterThan(70_000);
      expect(pointX).toBeGreaterThan(0);
      expect(pointX).toBeLessThan(plotWidth);
    },
  );

  it('renders viewport geometry for same-day ranges, points, and diamond milestones', () => {
    const container = freshContainer();
    renderTimeline(container, {
      entries: [
        {
          ...range('Same day'),
          item: {
            kind: 'range',
            key: 'task:Same day',
            startMs: Date.UTC(2026, 7, 27),
            endMs: Date.UTC(2026, 7, 27),
          },
          dateByRole: { start: '2026-08-27', end: '2026-08-27' },
        },
        point('Point'),
        {
          value: { id: 'Milestone' },
          label: 'Milestone',
          item: {
            kind: 'point',
            key: 'work-note:Milestone',
            atMs: Date.UTC(2026, 7, 28),
            role: 'milestone',
          },
          dateByRole: { milestone: '2026-08-28' },
        },
      ],
      dateWindow: { from: '2026-08-26', to: '2026-08-30' },
    });

    const sameDay = container.querySelector<HTMLElement>('[data-timeline-range]')!;
    expect(Number.parseFloat(sameDay.style.inlineSize)).toBeGreaterThanOrEqual(6);
    expect(sameDay.title).toContain('2026-08-27 – 2026-08-27');
    expect(container.querySelector('[data-timeline-point="due"]')).not.toBeNull();
    expect(container.querySelector('[data-timeline-milestone="diamond"]')).not.toBeNull();
    expect(container.querySelectorAll('[data-timeline-target="start-edge"]')).toHaveLength(1);
    expect(container.querySelectorAll('[data-timeline-target="end-edge"]')).toHaveLength(1);
    expect(container.textContent).not.toMatch(/\bStart\b|\bEnd\b/u);
  });

  it('keeps every first/last endpoint cell and one-date shape fully inside the canvas', () => {
    const container = freshContainer();
    renderTimeline(container, {
      entries: [
        {
          ...range('Boundary'),
          dateByRole: { start: '2026-08-27', end: '2026-08-29' },
        },
        point('First', '2026-08-27'),
        {
          ...point('Last', '2026-08-29'),
          item: {
            kind: 'point',
            key: 'work-note:Last',
            atMs: Date.UTC(2026, 7, 29),
            role: 'milestone',
          },
          dateByRole: { milestone: '2026-08-29' },
        },
      ],
      dateWindow: { from: '2026-08-27', to: '2026-08-29' },
    });

    const canvas = container.querySelector<HTMLElement>('.abyss-timeline-canvas')!;
    const plotWidth = Number.parseFloat(
      canvas.style.getPropertyValue('--abyss-timeline-plot-width'),
    );
    const rangeShape = container.querySelector<HTMLElement>('[data-timeline-range]')!;
    const rangeLeft = Number.parseFloat(rangeShape.style.insetInlineStart);
    expect(rangeLeft).toBeGreaterThan(0);
    expect(rangeLeft + Number.parseFloat(rangeShape.style.inlineSize)).toBeLessThan(plotWidth);
    for (const shape of container.querySelectorAll<HTMLElement>(
      '[data-timeline-point], [data-timeline-milestone]',
    )) {
      const center = Number.parseFloat(shape.style.insetInlineStart);
      const radius = Number.parseFloat(shape.style.inlineSize) / 2;
      expect(center - radius).toBeGreaterThan(0);
      expect(center + radius).toBeLessThan(plotWidth);
    }
  });

  it('collapses bounded Planning and Invalid trays and promotes all-undated planning', () => {
    const container = freshContainer();
    renderTimeline(container, {
      entries: [
        entry({ kind: 'undated', key: 'project:Undated' }, 'Undated'),
        entry({ kind: 'invalid', key: 'project:Broken', reason: 'reversed' }, 'Broken'),
      ],
      onSetDate: () => ({ type: 'ok' }),
    });

    const planning = container.querySelector<HTMLDetailsElement>(
      '[data-timeline-tray="planning"]',
    )!;
    const invalid = container.querySelector<HTMLDetailsElement>('[data-timeline-tray="invalid"]')!;
    expect(planning.open).toBe(true);
    expect(planning.querySelector('summary')?.textContent).toContain('Planning · 1');
    expect(invalid.open).toBe(false);
    expect(invalid.querySelector('summary')?.textContent).toContain('Invalid · 1');
    expect(planning.querySelector('[data-timeline-schedule]')).not.toBeNull();
    expect(invalid.textContent).toContain('reversed');
    expect(container.querySelector('.abyss-timeline-toolbar')).toBeNull();
  });

  it('renders a title-first narrow agenda without duplicate endpoint prose or a date grid', () => {
    const container = freshContainer();
    renderTimeline(container, {
      entries: [point('A'), entry({ kind: 'undated', key: 'task:B' }, 'B')],
      isNarrow: true,
    });

    const root = container.querySelector<HTMLElement>('.abyss-timeline')!;
    expect(root.classList.contains('is-agenda')).toBe(true);
    expect(container.querySelector('.abyss-timeline-axis')).toBeNull();
    const identity = container.querySelector<HTMLElement>('.abyss-timeline-identity')!;
    expect(identity.firstElementChild?.textContent).toBe('A');
    expect(identity.querySelector('.abyss-timeline-agenda-date')).toBeNull();
    expect(identity.textContent).not.toMatch(/\b(?:Start|End|Due|Scheduled)\b/u);
    expect(
      container.querySelector<HTMLInputElement>('[data-timeline-date-picker="due"]')?.value,
    ).toBe('2026-08-27');
    for (const control of container.querySelectorAll<HTMLElement>(
      '.abyss-timeline-agenda-row button, .abyss-timeline-agenda-row input',
    )) {
      expect(control.classList.contains('abyss-timeline-touch-target')).toBe(true);
    }
    expect(
      container.querySelector<HTMLInputElement>('[data-timeline-date-picker="due"]')?.tabIndex,
    ).toBe(0);
    expect(root.scrollWidth).toBeLessThanOrEqual(root.clientWidth);
  });

  it('keeps invisible desktop editors out of sequential focus while preserving Enter editing', () => {
    const container = freshContainer();
    activeDocument.body.append(container);
    renderTimeline(container, { entries: [point('A')], onSetDate: () => ({ type: 'ok' }) });
    const primary = container.querySelector<HTMLElement>('[data-timeline-primary]')!;
    const picker = container.querySelector<HTMLInputElement>('[data-timeline-date-picker="due"]')!;

    expect(picker.tabIndex).toBe(-1);
    primary.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(activeDocument.activeElement).toBe(picker);
    container.remove();
  });

  it('supports keyboard move, editor, cancel, and coarse menu fallback on the focused item', async () => {
    const container = freshContainer();
    activeDocument.body.append(container);
    const onSetDate = vi.fn().mockResolvedValue({ type: 'ok' });
    renderTimeline(container, {
      entries: [point('A')],
      onSetDate,
      coarsePointer: true,
    } as Parameters<typeof renderTimeline<Fixture>>[1]);
    const pointControl = container.querySelector<HTMLElement>(
      '[data-timeline-target="point-move"]',
    )!;
    const picker = container.querySelector<HTMLInputElement>('[data-timeline-date-picker="due"]')!;

    pointControl.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }),
    );
    pointControl.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    );
    await flushMicrotasks();
    expect(onSetDate).toHaveBeenLastCalledWith(
      expect.objectContaining({ label: 'A' }),
      'due',
      '2026-08-28',
      pointControl,
    );

    pointControl.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    );
    expect(activeDocument.activeElement).toBe(picker);
    pointControl.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true }),
    );
    pointControl.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    );
    expect(container.querySelector('[data-timeline-preview]')).toBeNull();

    container
      .querySelector<HTMLButtonElement>('[data-timeline-coarse-action="move-next"]')!
      .click();
    await flushMicrotasks();
    expect(onSetDate).toHaveBeenCalledTimes(2);
    container.remove();
  });

  it('offers whole-range and individual edge actions in the coarse menu', async () => {
    const container = freshContainer();
    const onSetDate = vi.fn().mockResolvedValue({ type: 'ok' });
    const onSetRange = vi.fn().mockResolvedValue({ type: 'ok' });
    renderTimeline(container, {
      entries: [range('A')],
      onSetDate,
      onSetRange,
      coarsePointer: true,
    });

    const actions = Array.from(
      container.querySelectorAll<HTMLElement>('[data-timeline-coarse-action]'),
      (button) => button.dataset.timelineCoarseAction,
    );
    expect(actions).toEqual([
      'range-previous',
      'range-next',
      'start-previous',
      'start-next',
      'end-previous',
      'end-next',
    ]);
    container
      .querySelector<HTMLButtonElement>('[data-timeline-coarse-action="start-next"]')!
      .click();
    await flushMicrotasks();
    expect(onSetDate).toHaveBeenCalledOnce();
    expect(onSetDate).toHaveBeenCalledWith(
      expect.objectContaining({ label: 'A' }),
      'start',
      '2026-08-28',
      expect.objectContaining({
        dataset: expect.objectContaining({ timelineCoarseAction: 'start-next' }),
      }),
    );
    expect(onSetRange).not.toHaveBeenCalled();
  });

  it('keeps agenda coarse actions focused on their visible initiator', async () => {
    const container = freshContainer();
    activeDocument.body.append(container);
    const onSetRange = vi.fn().mockResolvedValue({ type: 'ok' });
    try {
      renderTimeline(container, {
        entries: [range('A')],
        onSetDate: vi.fn().mockResolvedValue({ type: 'ok' }),
        onSetRange,
        isNarrow: true,
      });
      const menu = container.querySelector<HTMLDetailsElement>('.abyss-timeline-coarse-menu')!;
      menu.open = true;
      const action = menu.querySelector<HTMLButtonElement>(
        '[data-timeline-coarse-action="range-next"]',
      )!;
      action.focus();
      action.click();
      await flushMicrotasks();

      expect(onSetRange).toHaveBeenCalledOnce();
      expect(activeDocument.activeElement).toBe(action);
      expect(action.closest('.abyss-timeline-plot')).toBeNull();
    } finally {
      container.remove();
    }
  });

  it('shows the live exact range in the interaction preview instead of only the original dates', () => {
    const container = freshContainer();
    renderTimeline(container, {
      entries: [range('A')],
      onSetDate: () => ({ type: 'ok' }),
      onSetRange: () => ({ type: 'ok' }),
    });
    const move = container.querySelector<HTMLElement>('[data-timeline-target="range-move"]')!;

    move.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));

    const preview = container.querySelector<HTMLElement>('[data-timeline-preview]')!;
    expect(preview.dataset).toMatchObject({
      timelinePreviewStart: '2026-08-28',
      timelinePreviewEnd: '2026-08-30',
    });
    expect(preview.title).toBe('2026-08-28 – 2026-08-30');
    expect(preview.textContent).toContain('2026-08-28 – 2026-08-30');
  });

  it('deduplicates all controller announcement phases through the live region', async () => {
    const container = freshContainer();
    const pending = deferred<{ readonly type: 'ok' }>();
    renderTimeline(container, {
      entries: [point('A')],
      onSetDate: () => pending.promise,
      coarsePointer: true,
    });
    const feedback = container.querySelector<HTMLElement>('[data-timeline-feedback]')!;
    const setText = vi.spyOn(feedback, 'setText');
    const primary = container.querySelector<HTMLElement>('[data-timeline-primary]')!;

    primary.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(setText.mock.calls.map(([message]) => message)).toEqual([
      'Picked up due date.',
      'Destination: 2026-08-28.',
    ]);
    primary.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(feedback.textContent).toBe('Saving timeline change.');
    pending.resolve({ type: 'ok' });
    await flushMicrotasks();
    expect(feedback.textContent).toBe('Timeline change saved.');

    container
      .querySelector<HTMLButtonElement>('[data-timeline-identity-preset="compact"]')!
      .click();
    expect(feedback.textContent).toBe('Identity width 160 pixels, minimum.');
    const callsAtBoundary = setText.mock.calls.length;
    container
      .querySelector<HTMLButtonElement>('[data-timeline-identity-preset="compact"]')!
      .click();
    expect(setText).toHaveBeenCalledTimes(callsAtBoundary);
  });

  it('clamps identity resize to 160/240/360 and removes document interaction on destroy', async () => {
    const container = freshContainer();
    const onSetDate = vi.fn().mockResolvedValue({ type: 'ok' });
    const session = {
      firstKey: null,
      firstIndex: 0,
      focusedKey: null,
      restoreFocus: false,
      focalDate: '2026-08-27',
      scrollLeft: 0,
      scale: 'month',
      identityWidth: 240,
      focusedInteraction: null,
    };
    const handle = renderTimeline(container, {
      entries: [point('A')],
      onSetDate,
      coarsePointer: true,
      session,
    } as Parameters<typeof renderTimeline<Fixture>>[1]);
    const root = container.querySelector<HTMLElement>('.abyss-timeline')!;
    const resize = container.querySelector<HTMLElement>('[data-timeline-identity-resize]')!;

    expect(root.style.getPropertyValue('--abyss-timeline-identity-width')).toBe('240px');
    for (const [preset, width] of [
      ['compact', 160],
      ['default', 240],
      ['wide', 360],
    ] as const) {
      container
        .querySelector<HTMLButtonElement>(`[data-timeline-identity-preset="${preset}"]`)!
        .click();
      expect(session.identityWidth).toBe(width);
      expect(root.style.getPropertyValue('--abyss-timeline-identity-width')).toBe(
        `${String(width)}px`,
      );
    }

    resize.dispatchEvent(pointerEvent('pointerdown', { pointerId: 9, clientX: 100 }));
    handle.destroy();
    activeDocument.dispatchEvent(pointerEvent('pointermove', { pointerId: 9, clientX: 220 }));
    activeDocument.dispatchEvent(pointerEvent('pointerup', { pointerId: 9, clientX: 220 }));
    await flushMicrotasks();
    expect(container.childElementCount).toBe(0);
    expect(onSetDate).not.toHaveBeenCalled();
  });

  it('reflows a committed identity width in place without changing focal date, rows, or focus', () => {
    const container = freshContainer();
    activeDocument.body.append(container);
    const session = {
      firstKey: null,
      firstIndex: 0,
      focusedKey: null,
      restoreFocus: false,
      focalDate: '2026-08-27',
      scrollLeft: 0,
      scale: 'month',
      identityWidth: 240,
      focusedInteraction: null,
    };
    try {
      renderTimeline(container, {
        entries: [point('A')],
        onSetDate: () => ({ type: 'ok' }),
        coarsePointer: true,
        session,
      } as Parameters<typeof renderTimeline<Fixture>>[1]);
      const scroll = container.querySelector<HTMLElement>('.abyss-timeline-scroll')!;
      Object.defineProperty(scroll, 'clientWidth', { configurable: true, value: 1_200 });
      const scale = container.querySelector<HTMLSelectElement>('[data-timeline-scale]')!;
      scale.value = 'month';
      scale.dispatchEvent(new Event('change', { bubbles: true }));
      const canvas = container.querySelector<HTMLElement>('.abyss-timeline-canvas')!;
      const row = container.querySelector<HTMLElement>('.abyss-timeline-row')!;
      const control = container.querySelector<HTMLButtonElement>('[data-timeline-point]')!;
      control.focus();
      const focalDate = session.focalDate;

      container.querySelector<HTMLButtonElement>('[data-timeline-identity-preset="wide"]')!.click();

      expect(Number.parseFloat(canvas.style.getPropertyValue('--abyss-timeline-plot-width'))).toBe(
        840,
      );
      expect(container.querySelector('.abyss-timeline-row')).toBe(row);
      expect(container.querySelector('[data-timeline-point]')).toBe(control);
      expect(activeDocument.activeElement).toBe(control);
      expect(session.focalDate).toBe(focalDate);
    } finally {
      container.remove();
    }
  });

  it('reflows a same-mode wide host resize in place without remounting controls or losing focus', () => {
    const container = freshContainer();
    activeDocument.body.append(container);
    const ownerWindow = container.ownerDocument.defaultView!;
    const originalResizeObserver = Object.getOwnPropertyDescriptor(ownerWindow, 'ResizeObserver');
    let triggerResize = (): void => {
      throw new Error('Resize observer was not installed');
    };
    class TestResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        triggerResize = () => callback([], this as unknown as ResizeObserver);
      }
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
    Object.defineProperty(ownerWindow, 'ResizeObserver', {
      configurable: true,
      value: TestResizeObserver,
    });
    let containerWidth = 1_200;
    Object.defineProperty(container, 'clientWidth', {
      configurable: true,
      get: () => containerWidth,
    });
    const session = {
      firstKey: null,
      firstIndex: 0,
      focusedKey: null,
      restoreFocus: false,
      focalDate: '2026-08-27',
      scrollLeft: 0,
      scale: 'month',
      identityWidth: 240,
      focusedInteraction: null,
    };
    let renderCount = 0;
    const handle = renderContainerResponsiveTimeline(container, (isNarrow) => {
      renderCount += 1;
      return renderTimeline(container, {
        entries: [point('A')],
        onSetDate: () => ({ type: 'ok' }),
        isNarrow,
        session,
      } as Parameters<typeof renderTimeline<Fixture>>[1]);
    });
    try {
      const scroll = container.querySelector<HTMLElement>('.abyss-timeline-scroll')!;
      let scrollWidth = 1_200;
      Object.defineProperty(scroll, 'clientWidth', {
        configurable: true,
        get: () => scrollWidth,
      });
      const scale = container.querySelector<HTMLSelectElement>('[data-timeline-scale]')!;
      scale.value = 'month';
      scale.dispatchEvent(new Event('change', { bubbles: true }));
      const canvas = container.querySelector<HTMLElement>('.abyss-timeline-canvas')!;
      const row = container.querySelector<HTMLElement>('.abyss-timeline-row')!;
      const control = container.querySelector<HTMLButtonElement>('[data-timeline-point]')!;
      control.focus();
      const focalDate = session.focalDate;

      containerWidth = 1_400;
      scrollWidth = 1_400;
      triggerResize();

      const plotWidth = Number.parseFloat(
        canvas.style.getPropertyValue('--abyss-timeline-plot-width'),
      );
      expect(plotWidth).toBeGreaterThanOrEqual(1_160);
      expect(plotWidth).toBeLessThan(1_200);
      expect(renderCount).toBe(1);
      expect(container.querySelector('.abyss-timeline-row')).toBe(row);
      expect(container.querySelector('[data-timeline-point]')).toBe(control);
      expect(activeDocument.activeElement).toBe(control);
      expect(session.focalDate).toBe(focalDate);
    } finally {
      handle.destroy();
      if (originalResizeObserver) {
        Object.defineProperty(ownerWindow, 'ResizeObserver', originalResizeObserver);
      } else {
        Reflect.deleteProperty(ownerWindow, 'ResizeObserver');
      }
      container.remove();
    }
  });

  it('previews identity width ephemerally and clears interaction session state on cancel, commit, and destroy', async () => {
    const container = freshContainer();
    const session = {
      firstKey: null,
      firstIndex: 0,
      focusedKey: null,
      restoreFocus: false,
      focalDate: '2026-08-27',
      scrollLeft: 0,
      scale: 'month',
      identityWidth: 240,
      focusedInteraction: { itemKey: 'stale', role: 'range' },
    };
    const handle = renderTimeline(container, {
      entries: [point('A')],
      onSetDate: () => ({ type: 'ok' }),
      session,
    } as Parameters<typeof renderTimeline<Fixture>>[1]);
    const root = container.querySelector<HTMLElement>('.abyss-timeline')!;
    const resize = container.querySelector<HTMLElement>('[data-timeline-identity-resize]')!;

    expect(resize.closest('[aria-hidden="true"]')).toBeNull();
    expect(session.focusedInteraction).toBeNull();
    resize.dispatchEvent(pointerEvent('pointerdown', { pointerId: 15, clientX: 100 }));
    activeDocument.dispatchEvent(pointerEvent('pointermove', { pointerId: 15, clientX: 160 }));
    expect(root.style.getPropertyValue('--abyss-timeline-identity-width')).toBe('300px');
    expect(session.identityWidth).toBe(240);
    resize.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(root.style.getPropertyValue('--abyss-timeline-identity-width')).toBe('240px');
    expect(session.identityWidth).toBe(240);
    expect(session.focusedInteraction).toBeNull();

    resize.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    resize.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await flushMicrotasks();
    expect(session.identityWidth).toBe(248);
    expect(session.focusedInteraction).toBeNull();

    resize.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(session.focusedInteraction).toMatchObject({ role: 'identity-column' });
    handle.destroy();
    expect(session.identityWidth).toBe(248);
    expect(session.focusedInteraction).toBeNull();
  });

  it('uses bounded reduced-motion autoscroll and stops it when the shell is destroyed', () => {
    const container = freshContainer();
    activeDocument.body.append(container);
    const ownerWindow = container.ownerDocument.defaultView!;
    const originalMatchMedia = ownerWindow.matchMedia;
    ownerWindow.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: query === '(prefers-reduced-motion: reduce)',
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
    try {
      const handle = renderTimeline(container, {
        entries: [point('A')],
        onSetDate: () => ({ type: 'ok' }),
        dateWindow: { from: '2026-08-01', to: '2026-09-30' },
      });
      const scroll = container.querySelector<HTMLElement>('.abyss-timeline-scroll')!;
      Object.defineProperties(scroll, {
        clientWidth: { configurable: true, value: 300 },
        scrollWidth: { configurable: true, value: 1000 },
      });
      scroll.getBoundingClientRect = () =>
        ({
          left: 0,
          right: 300,
          top: 0,
          bottom: 300,
          width: 300,
          height: 300,
          x: 0,
          y: 0,
          toJSON: () => ({}),
        }) as DOMRect;
      const item = container.querySelector<HTMLElement>('[data-timeline-target="point-move"]')!;
      item.dispatchEvent(pointerEvent('pointerdown', { pointerId: 11, clientX: 200 }));
      activeDocument.dispatchEvent(pointerEvent('pointermove', { pointerId: 11, clientX: 295 }));

      expect(scroll.scrollLeft).toBeGreaterThan(0);
      const stoppedAt = scroll.scrollLeft;
      handle.destroy();
      activeDocument.dispatchEvent(pointerEvent('pointermove', { pointerId: 11, clientX: 299 }));
      expect(scroll.scrollLeft).toBe(stoppedAt);
    } finally {
      ownerWindow.matchMedia = originalMatchMedia;
      container.remove();
    }
  });

  it('restores deep logical focus and scroll from stable keys after a remount', () => {
    const entries = Array.from({ length: 160 }, (_, index) => point(String(index)));
    const session: LogicalViewportSession = {
      firstKey: 'task:118',
      firstIndex: 118,
      focusedKey: 'task:123',
      restoreFocus: true,
    };
    const first = freshContainer();
    activeDocument.body.append(first);
    const firstHandle = renderTimeline(first, { entries, session });
    const firstScroll = first.querySelector<HTMLElement>('.abyss-timeline-scroll')!;

    expect(first.querySelectorAll('.abyss-timeline-row').length).toBeLessThan(40);
    expect(firstScroll.scrollTop).toBeGreaterThan(0);
    expect(first.ownerDocument.activeElement?.getAttribute('data-timeline-key')).toBe('task:123');
    firstHandle.destroy();

    const second = freshContainer();
    activeDocument.body.append(second);
    renderTimeline(second, { entries, session });
    expect(second.querySelector<HTMLElement>('.abyss-timeline-scroll')!.scrollTop).toBe(
      firstScroll.scrollTop,
    );
    expect(second.ownerDocument.activeElement?.getAttribute('data-timeline-key')).toBe('task:123');
    first.remove();
    second.remove();
  });

  it('restores pure deep scroll after browser clamping without requiring a focused row', () => {
    const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollTop');
    const positions = new WeakMap<HTMLElement, number>();
    Object.defineProperty(HTMLElement.prototype, 'scrollTop', {
      configurable: true,
      get() {
        return positions.get(this as HTMLElement) ?? 0;
      },
      set(value: number) {
        const element = this as HTMLElement;
        const hasExtent = element.querySelector('[data-bounded-window-edge]') !== null;
        positions.set(element, hasExtent ? value : 0);
      },
    });
    try {
      const entries = Array.from({ length: 180 }, (_, index) => point(String(index)));
      const session: LogicalViewportSession = {
        firstKey: 'task:132',
        firstIndex: 132,
        focusedKey: null,
        restoreFocus: false,
      };
      const container = freshContainer();

      renderTimeline(container, { entries, session });

      const scroll = container.querySelector<HTMLElement>('.abyss-timeline-scroll')!;
      expect(scroll.scrollTop).toBeGreaterThan(0);
      expect(container.querySelector('[data-timeline-key="task:132"]')).not.toBeNull();
      expect(session.firstIndex).toBe(132);
    } finally {
      if (original) Object.defineProperty(HTMLElement.prototype, 'scrollTop', original);
      else delete (HTMLElement.prototype as Partial<HTMLElement>).scrollTop;
    }
  });

  it('keeps a deep restored row and control mounted on the first horizontal-only scroll', () => {
    const entries = Array.from({ length: 80 }, (_, index) => point(String(index)));
    const session: LogicalViewportSession = {
      firstKey: 'task:40',
      firstIndex: 40,
      focusedKey: 'task:42',
      restoreFocus: true,
    };
    const container = freshContainer();
    activeDocument.body.append(container);
    try {
      renderTimeline(container, { entries, session, onSetDate: () => ({ type: 'ok' }) });
      const scroll = container.querySelector<HTMLElement>('.abyss-timeline-scroll')!;
      const restoredRow = container.querySelector<HTMLElement>(
        '.abyss-timeline-row[data-timeline-key="task:42"]',
      )!;
      const restoredControl = restoredRow.querySelector<HTMLElement>('[data-timeline-primary]')!;
      Object.defineProperties(scroll, {
        clientHeight: { configurable: true, value: 4 * 72 },
        clientWidth: { configurable: true, value: 600 },
        scrollWidth: { configurable: true, value: 2_000 },
      });

      scroll.scrollLeft = 120;
      scroll.dispatchEvent(new Event('scroll'));

      expect(container.querySelector('.abyss-timeline-row[data-timeline-key="task:42"]')).toBe(
        restoredRow,
      );
      expect(
        container.querySelector(
          '.abyss-timeline-row[data-timeline-key="task:42"] [data-timeline-primary]',
        ),
      ).toBe(restoredControl);
      expect(container.ownerDocument.activeElement).toBe(restoredControl);
      expect(session.firstIndex).toBe(40);
    } finally {
      container.remove();
    }
  });

  it('restores agenda focus to a visible picker through remount and virtual scroll', () => {
    const entries = Array.from({ length: 80 }, (_, index) => point(String(index)));
    const session: LogicalViewportSession = {
      firstKey: 'task:40',
      firstIndex: 40,
      focusedKey: 'task:42',
      restoreFocus: true,
    };
    const first = freshContainer();
    activeDocument.body.append(first);
    const firstHandle = renderTimeline(first, {
      entries,
      session,
      isNarrow: true,
      onSetDate: () => ({ type: 'ok' }),
    });
    const firstPicker = first.querySelector<HTMLInputElement>(
      '[data-timeline-key="task:42"] [data-timeline-date-picker="due"]',
    )!;
    expect(activeDocument.activeElement).toBe(firstPicker);
    firstHandle.destroy();
    first.remove();

    const second = freshContainer();
    activeDocument.body.append(second);
    try {
      renderTimeline(second, {
        entries,
        session,
        isNarrow: true,
        onSetDate: () => ({ type: 'ok' }),
      });
      const scroll = second.querySelector<HTMLElement>('.abyss-timeline-scroll')!;
      const restoredPicker = second.querySelector<HTMLInputElement>(
        '[data-timeline-key="task:42"] [data-timeline-date-picker="due"]',
      )!;
      expect(activeDocument.activeElement).toBe(restoredPicker);
      expect(restoredPicker.closest('.abyss-timeline-plot')).toBeNull();

      Object.defineProperties(scroll, {
        clientHeight: { configurable: true, value: 4 * 144 },
        clientWidth: { configurable: true, value: 440 },
      });
      scroll.scrollLeft = 0;
      scroll.dispatchEvent(new Event('scroll'));

      expect(activeDocument.activeElement).toBe(restoredPicker);
      expect(session.firstIndex).toBe(40);
    } finally {
      second.remove();
    }
  });

  it('retains the logical row when a date control initiates a successful remount', async () => {
    const entries = Array.from({ length: 40 }, (_, index) => point(String(index)));
    const session: LogicalViewportSession = {
      firstKey: null,
      firstIndex: 0,
      focusedKey: null,
      restoreFocus: false,
    };
    const first = freshContainer();
    activeDocument.body.append(first);
    const firstHandle = renderTimeline(first, {
      entries,
      session,
      onSetDate: () => ({ type: 'ok' }),
    });
    const picker = first.querySelector<HTMLInputElement>(
      '[data-timeline-key="task:4"] [data-timeline-date-picker="due"]',
    )!;
    picker.focus();
    picker.value = '2026-08-30';
    picker.dispatchEvent(new Event('change', { bubbles: true }));
    await flushMicrotasks();
    firstHandle.destroy();

    const second = freshContainer();
    activeDocument.body.append(second);
    renderTimeline(second, { entries, session });

    expect(session.focusedKey).toBe('task:4');
    expect(second.ownerDocument.activeElement?.getAttribute('data-timeline-key')).toBe('task:4');
    first.remove();
    second.remove();
  });

  it('uses one measured fixed row extent for wrapped mobile ranges and deep spacers', () => {
    const style = activeDocument.head.createEl('style');
    style.textContent = shippedStyles;
    const entries = Array.from({ length: 180 }, (_, index) => range(String(index)));
    const session: LogicalViewportSession = {
      firstKey: 'task:120',
      firstIndex: 120,
      focusedKey: null,
      restoreFocus: false,
    };
    const container = freshContainer();
    activeDocument.body.append(container);
    try {
      renderTimeline(container, { entries, session, isNarrow: true });
      const scroll = container.querySelector<HTMLElement>('.abyss-timeline-scroll')!;
      const row = container.querySelector<HTMLElement>('[data-timeline-key="task:120"]')!;
      const startSpacer = container.querySelector<HTMLElement>(
        '[data-bounded-window-edge="start"]',
      )!;

      expect(getComputedStyle(row).blockSize).toBe('144px');
      expect(getComputedStyle(row).overflow).not.toBe('hidden');
      expect(scroll.scrollTop).toBe(120 * 144);
      expect(Number.parseInt(startSpacer.style.blockSize, 10) % 144).toBe(0);
      for (const control of row.querySelectorAll<HTMLElement>('button, input, summary')) {
        expect(Number.parseFloat(getComputedStyle(control).minBlockSize)).toBeGreaterThanOrEqual(
          44,
        );
      }
      expect(container.querySelectorAll('.abyss-timeline-row').length).toBeLessThan(40);
    } finally {
      container.remove();
      style.remove();
    }
  });

  it('keeps large undated and invalid mobile backlogs reachable through bounded scrollers', () => {
    const entries = [
      ...Array.from({ length: 180 }, (_, index) =>
        entry({ kind: 'undated', key: `task:u${String(index)}` }, `Undated ${String(index)}`),
      ),
      ...Array.from({ length: 180 }, (_, index) =>
        entry(
          { kind: 'invalid', key: `task:i${String(index)}`, reason: 'invalid-due' },
          `Invalid ${String(index)}`,
        ),
      ),
    ];
    const container = freshContainer();
    renderTimeline(container, { entries, isNarrow: true });
    const scrollers = container.querySelectorAll<HTMLElement>('.abyss-timeline-diagnostic-scroll');

    expect(scrollers).toHaveLength(2);
    for (const scroll of scrollers) {
      Object.defineProperty(scroll, 'clientHeight', { configurable: true, value: 160 });
      scroll.scrollTop = 150 * 88;
      scroll.dispatchEvent(new Event('scroll'));
    }
    expect(container.textContent).toContain('Undated 150');
    expect(container.textContent).toContain('Invalid 150');
    expect(container.querySelectorAll('.abyss-timeline-diagnostic-row').length).toBeLessThan(50);
  });

  it('presents failed mutation results and returns focus to the initiating control', async () => {
    const container = freshContainer();
    activeDocument.body.append(container);
    renderTimeline(container, {
      entries: [point('A')],
      onSetDate: () => Promise.resolve({ type: 'conflict' }),
    });
    const handle = container.querySelector<HTMLElement>('[data-timeline-role="due"]')!;

    handle.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }),
    );
    handle.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    );
    await flushMicrotasks();

    expect(container.querySelector<HTMLElement>('[data-timeline-feedback]')?.dataset).toMatchObject(
      {
        resultType: 'conflict',
      },
    );
    expect(activeDocument.activeElement).toBe(handle);
    container.remove();
  });

  it('uses the retained milestone role to create the guarded Work Note end field', async () => {
    const container = freshContainer();
    const note: WorkNoteSnapshot = {
      path: 'Work Notes/Milestone.md',
      presetRevision: 1,
      presetFingerprint: 'fingerprint',
      kind: 'milestone',
      projectPath: 'Projects/A.md',
      statusId: null,
      rawStatus: null,
      writableStatusShape: true,
      updated: '2026-08-27',
      range: {},
      blockedByPaths: [],
      relatedPaths: [],
      diagnostics: [],
    };
    const observed = {
      path: note.path,
      presetRevision: 1,
      presetFingerprint: 'fingerprint',
      projectPath: note.projectPath,
      kind: note.kind,
      fields: { Updated: '2026-08-27T09:15:00+07:00' },
    };
    const setRange = vi.fn().mockResolvedValue({ type: 'ok', path: note.path });
    renderWorkNotesTimeline(container, {
      notes: [note],
      commands: {
        observeRange: () => ({
          observed,
          updated: {
            raw: '2026-08-27T09:15:00+07:00',
            precision: 'datetime',
            instantMs: Date.parse('2026-08-27T09:15:00+07:00'),
          },
        }),
        setRange,
      } as never,
    });

    container
      .querySelector<HTMLElement>('[data-timeline-role="milestone"]')!
      .dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }),
      );
    container
      .querySelector<HTMLElement>('[data-timeline-role="milestone"]')!
      .dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
      );
    await flushMicrotasks();

    expect(setRange).toHaveBeenCalledWith(observed, {
      end: expect.objectContaining({
        raw: '2026-08-28T09:15:00+07:00',
        precision: 'datetime',
      }),
    });
  });

  it('uses one render-time Work Note observation for both exact raw movement and guarding', async () => {
    const container = freshContainer();
    const note: WorkNoteSnapshot = {
      path: 'Work Notes/Race.md',
      presetRevision: 1,
      presetFingerprint: 'fingerprint',
      kind: 'ordinary',
      projectPath: 'Projects/A.md',
      statusId: null,
      rawStatus: null,
      writableStatusShape: true,
      range: {
        start: {
          raw: '2026-08-27T14:30:15+07:00',
          precision: 'datetime',
          instantMs: Date.parse('2026-08-27T14:30:15+07:00'),
        },
      },
      blockedByPaths: [],
      relatedPaths: [],
      diagnostics: [],
    };
    const renderedGuard = { path: note.path, fields: { Start: note.range.start!.raw } };
    const freshGuard = { path: note.path, fields: { Start: '2026-08-28T09:00:00+02:00' } };
    const observe = vi.fn().mockReturnValue(freshGuard);
    const observeRange = vi.fn().mockReturnValue({
      observed: renderedGuard,
      start: note.range.start,
    });
    const setRange = vi.fn().mockResolvedValue({ type: 'conflict', field: 'start' });
    renderWorkNotesTimeline(container, {
      notes: [note],
      commands: { observe, observeRange, setRange } as never,
    });

    const picker = container.querySelector<HTMLInputElement>(
      '[data-timeline-date-picker="start"]',
    )!;
    picker.value = '2026-08-30';
    picker.dispatchEvent(new Event('change', { bubbles: true }));
    await flushMicrotasks();

    expect(observeRange).toHaveBeenCalledOnce();
    expect(observe).not.toHaveBeenCalled();
    expect(setRange).toHaveBeenCalledWith(renderedGuard, {
      start: expect.objectContaining({ raw: '2026-08-30T14:30:15+07:00' }),
    });
  });

  it('keeps Work Note Timeline date controls disabled without accepted update capability', async () => {
    const container = freshContainer();
    const note: WorkNoteSnapshot = {
      path: 'Work Notes/Guarded.md',
      presetRevision: 1,
      presetFingerprint: 'fingerprint',
      kind: 'ordinary',
      projectPath: 'Projects/A.md',
      statusId: null,
      rawStatus: null,
      writableStatusShape: true,
      range: {
        start: {
          raw: '2026-08-27',
          precision: 'date',
          instantMs: Date.UTC(2026, 7, 27),
        },
      },
      blockedByPaths: [],
      relatedPaths: [],
      diagnostics: [],
    };
    const setRange = vi.fn();
    renderWorkNotesTimeline(container, {
      notes: [note],
      commandsEnabled: false,
      commands: { observe: vi.fn(), setRange } as never,
    });
    const handle = container.querySelector<HTMLButtonElement>('[data-timeline-role="start"]')!;

    expect(handle.disabled).toBe(true);
    expect(
      container.querySelector<HTMLInputElement>('[data-timeline-date-picker="start"]')?.disabled,
    ).toBe(true);
    handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    await flushMicrotasks();
    expect(setRange).not.toHaveBeenCalled();
  });

  it('moves a Project range through one real guarded command transaction and one vault write', async () => {
    const app = await createAppWithFiles({
      'Projects/Atomic.md': '---\nstart: 2026-08-27\nend: 2026-08-29\n---\n# Atomic\n',
    });
    const commands = new ProjectCommandService(app, () => []);
    const project: Project = {
      path: 'Projects/Atomic.md',
      name: 'Atomic',
      frontmatter: { start: '2026-08-27', end: '2026-08-29' },
      tags: [],
      statusId: null,
      rawStatus: null,
      range: parseProjectRange('2026-08-27', '2026-08-29'),
      stats: { total: 0, done: 0, cancelled: 0, inProgress: 0, open: 0, progress: null },
    };
    const writes = vi.spyOn(app.vault, 'modify');
    const container = freshContainer();
    renderProjectsTimeline(container, { projects: [project], commands });

    const move = container.querySelector<HTMLElement>('[data-timeline-target="range-move"]')!;
    move.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    move.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await flushMicrotasks();

    const file = app.vault.getMarkdownFiles().find(({ path }) => path === project.path)!;
    const markdown = await app.vault.read(file);
    expect(markdown).toContain('start: 2026-08-28');
    expect(markdown).toContain('end: 2026-08-30');
    expect(writes).toHaveBeenCalledOnce();
  });

  it('preserves Project datetime precision and offsets during a whole-range move', async () => {
    const container = freshContainer();
    const project: Project = {
      path: 'Projects/Atom.md',
      name: 'Atom',
      frontmatter: {
        start: '2026-08-11T09:30:00+07:00',
        end: '2026-09-15T17:00:00+07:00',
      },
      tags: [],
      statusId: null,
      rawStatus: null,
      range: parseProjectRange('2026-08-11T09:30:00+07:00', '2026-09-15T17:00:00+07:00'),
      stats: { total: 0, done: 0, cancelled: 0, inProgress: 0, open: 0, progress: null },
    };
    const observed = {
      path: project.path,
      start: project.frontmatter['start'],
      end: project.frontmatter['end'],
    };
    const setRange = vi.fn().mockResolvedValue({ type: 'ok', range: project.range });
    renderProjectsTimeline(container, {
      projects: [project],
      commands: {
        observeRange: () => observed,
        setRange,
      } as never,
    });

    const move = container.querySelector<HTMLElement>('[data-timeline-target="range-move"]')!;
    move.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    move.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await flushMicrotasks();

    expect(setRange).toHaveBeenCalledWith(observed, {
      start: expect.objectContaining({
        raw: '2026-08-12T09:30:00+07:00',
        precision: 'datetime',
        offsetMinutes: 420,
      }),
      end: expect.objectContaining({
        raw: '2026-09-16T17:00:00+07:00',
        precision: 'datetime',
        offsetMinutes: 420,
      }),
    });
  });

  it('rejects a stale Work Note whole-range move without applying either endpoint', async () => {
    const container = freshContainer();
    const note: WorkNoteSnapshot = {
      path: 'Work Notes/Atomic.md',
      presetRevision: 1,
      presetFingerprint: 'fingerprint',
      kind: 'ordinary',
      projectPath: 'Projects/A.md',
      statusId: null,
      rawStatus: null,
      writableStatusShape: true,
      range: parseProjectRange('2026-08-27', '2026-08-29'),
      blockedByPaths: [],
      relatedPaths: [],
      diagnostics: [],
    };
    const state = { start: '2026-08-27', end: '2026-08-29', writes: 0 };
    const observed = {
      path: note.path,
      presetRevision: 1,
      presetFingerprint: 'fingerprint',
      projectPath: note.projectPath,
      kind: note.kind,
      fields: { Start: state.start, End: state.end },
    };
    renderWorkNotesTimeline(container, {
      notes: [note],
      commands: {
        observeRange: () => ({
          observed,
          start: note.range.start,
          end: note.range.end,
        }),
        setRange: (_guard: unknown, patch: { start?: { raw: string }; end?: { raw: string } }) => {
          if (state.start !== observed.fields.Start || state.end !== observed.fields.End) {
            return { type: 'conflict', field: 'end' };
          }
          state.start = patch.start?.raw ?? state.start;
          state.end = patch.end?.raw ?? state.end;
          state.writes += 1;
          return { type: 'ok', path: note.path };
        },
      } as never,
    });
    state.end = '2026-09-10';

    const move = container.querySelector<HTMLElement>('[data-timeline-target="range-move"]')!;
    move.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    move.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await flushMicrotasks();

    expect(state).toEqual({ start: '2026-08-27', end: '2026-09-10', writes: 0 });
    expect(container.querySelector<HTMLElement>('[data-timeline-feedback]')?.dataset).toMatchObject(
      {
        resultType: 'conflict',
      },
    );
  });

  it('passes a Task range through one atomic adapter operation', async () => {
    const container = freshContainer();
    const snapshot = task({
      title: 'Atomic task',
      planning: { start: '2026-08-27' as never, due: '2026-08-29' as never },
      source: { filePath: 'Projects/A.md', line: 4 },
    });
    const state = { start: snapshot.planning.start!, due: snapshot.planning.due!, writes: 0 };
    renderTasksTimeline(container, {
      actions: [
        {
          task: snapshot,
          projectPath: 'Projects/A.md',
          dependency: { type: 'allowed' },
          owner: { type: 'project', path: 'Projects/A.md' },
        },
      ],
      onSetDate: () => ({ type: 'invalid', issues: [] }),
      onSetRange: (_task, start, end) => {
        state.start = start as never;
        state.due = end as never;
        state.writes += 1;
        return { type: 'ok', changed: true, outcome: { type: 'task', task: snapshot } };
      },
    });

    const move = container.querySelector<HTMLElement>('[data-timeline-target="range-move"]')!;
    move.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    move.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await flushMicrotasks();

    expect(state).toEqual({ start: '2026-08-28', due: '2026-08-30', writes: 1 });
  });
});
