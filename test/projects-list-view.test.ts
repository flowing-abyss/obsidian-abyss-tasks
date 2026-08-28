import { describe, expect, it, vi } from 'vitest';
import { AppState } from '../src/app/AppState';
import {
  renderProjectsList,
  showNewProjectInput,
  type ProjectCaptureSession,
} from '../src/panels/projects/ProjectsListView';
import type { ProjectWorkspaceSnapshot } from '../src/projects/types';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import { deferred, freshContainer, task } from './helpers';

function captureSession(over: Partial<ProjectCaptureSession> = {}): ProjectCaptureSession {
  return { open: true, draft: '', pending: false, createdPath: null, ...over };
}

function snapshot(over: Partial<ProjectWorkspaceSnapshot> = {}): ProjectWorkspaceSnapshot {
  return {
    project: {
      path: 'Projects/Portfolio.md',
      name: 'Portfolio',
      frontmatter: {},
      tags: [],
      statusId: DEFAULT_SETTINGS.projects.statuses[0]!.id,
      rawStatus: null,
      range: {},
      priority: 'A',
      stats: { total: 2, done: 1, cancelled: 0, inProgress: 0, open: 1, progress: 0.5 },
    },
    tasks: [],
    workNotes: [],
    milestones: [],
    taskRollup: { total: 2, done: 1, cancelled: 0, inProgress: 0, open: 1, progress: 0.5 },
    workNoteRollup: { active: 0, completed: 0, dropped: 0 },
    milestoneRollups: new Map(),
    workNoteRelations: [],
    overdue: { tasks: 0, workNotes: 0 },
    dependencies: { blocked: 0, invalid: 0, diagnostics: [] },
    diagnostics: [],
    ...over,
  };
}

function context() {
  return {
    state: new AppState(),
    settings: structuredClone(DEFAULT_SETTINGS),
    onSaveSettings: vi.fn().mockResolvedValue(undefined),
    onCreate: vi.fn(),
    onSetStatus: vi.fn(),
    openNote: vi.fn(),
    today: () => '2026-08-28',
  };
}

describe('showNewProjectInput', () => {
  it('mounts an anchored non-modal overlay inside the toolbar root', () => {
    const toolbar = freshContainer();
    toolbar.addClass('abyss-projects-toolbar');
    const trigger = toolbar.createEl('button');
    const host = toolbar.createDiv({ cls: 'abyss-projects-new-input-host' });
    const live = toolbar.createDiv({ attr: { 'aria-live': 'polite' } });

    showNewProjectInput(host, vi.fn(), {
      session: captureSession(),
      trigger,
      liveRegion: live,
    });

    const capture = host.querySelector<HTMLElement>('.abyss-project-capture')!;
    expect(capture).not.toBeNull();
    expect(capture.getAttribute('role')).toBe('dialog');
    expect(capture.getAttribute('aria-modal')).toBe('false');
    expect(capture.closest('.abyss-projects-toolbar')).toBe(toolbar);
    expect(capture.querySelector('input')).not.toBeNull();
  });

  it('keeps a dirty draft on outside pointer and blur, then Escape explicitly clears it', async () => {
    const toolbar = freshContainer();
    activeDocument.body.appendChild(toolbar);
    const trigger = toolbar.createEl('button');
    const host = toolbar.createDiv();
    const live = toolbar.createDiv();
    const session = captureSession();
    showNewProjectInput(host, vi.fn(), { session, trigger, liveRegion: live });
    const input = host.querySelector<HTMLInputElement>('input')!;
    input.value = 'Новый проект';
    input.dispatchEvent(new InputEvent('input', { bubbles: true }));
    input.dispatchEvent(new FocusEvent('blur', { bubbles: true }));
    activeDocument.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    await Promise.resolve();

    expect(session.draft).toBe('Новый проект');
    expect(host.querySelector('input')).not.toBeNull();

    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(session.draft).toBe('');
    expect(session.open).toBe(false);
    expect(host.querySelector('input')).toBeNull();
    expect(activeDocument.activeElement).toBe(trigger);
    toolbar.remove();
  });

  it('ignores composing Enter and submits exactly once while pending with live feedback', async () => {
    const pending = deferred<{
      type: 'file-created';
      path: string;
      indexed: boolean;
      status: 'applied';
    }>();
    const onCreate = vi.fn().mockReturnValue(pending.promise);
    const toolbar = freshContainer();
    const trigger = toolbar.createEl('button');
    const host = toolbar.createDiv();
    const live = toolbar.createDiv({ attr: { 'aria-live': 'polite' } });
    const session = captureSession({ draft: 'Focus plan' });
    showNewProjectInput(host, onCreate, { session, trigger, liveRegion: live });
    const input = host.querySelector<HTMLInputElement>('input')!;

    input.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, isComposing: true }),
    );
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    input.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, repeat: true }),
    );

    expect(onCreate).toHaveBeenCalledOnce();
    expect(session.pending).toBe(true);
    expect(input.disabled).toBe(true);
    expect(live.textContent).toBe('Creating project…');

    pending.resolve({
      type: 'file-created',
      path: 'Projects/Focus plan.md',
      indexed: true,
      status: 'applied',
    });
    await pending.promise;
    await Promise.resolve();

    expect(session.createdPath).toBe('Projects/Focus plan.md');
    expect(session.open).toBe(false);
    expect(live.textContent).toBe('Project created.');
  });

  it('preserves a failed-before-create draft and reports a submit-ready failure', async () => {
    const toolbar = freshContainer();
    const trigger = toolbar.createEl('button');
    const host = toolbar.createDiv();
    const live = toolbar.createDiv({ attr: { 'aria-live': 'polite' } });
    const session = captureSession({ draft: 'Retry me' });
    showNewProjectInput(
      host,
      vi.fn().mockResolvedValue({ type: 'failed-before-create', reason: 'Template missing' }),
      { session, trigger, liveRegion: live },
    );
    const input = host.querySelector<HTMLInputElement>('input')!;

    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await Promise.resolve();
    await Promise.resolve();

    expect(session.open).toBe(true);
    expect(session.pending).toBe(false);
    expect(session.draft).toBe('Retry me');
    expect(input.disabled).toBe(false);
    expect(live.textContent).toBe('Template missing');
  });

  it('keeps a not-indexed partial success terminal and links to the created note', async () => {
    const toolbar = freshContainer();
    const trigger = toolbar.createEl('button');
    const host = toolbar.createDiv();
    const live = toolbar.createDiv({ attr: { 'aria-live': 'polite' } });
    const openNote = vi.fn();
    const session = captureSession({ draft: 'Outside query' });
    const onCreate = vi.fn().mockResolvedValue({
      type: 'file-created',
      path: 'Projects/Outside query.md',
      indexed: false,
      status: 'conflict',
    });
    showNewProjectInput(host, onCreate, { session, trigger, liveRegion: live, openNote });
    const input = host.querySelector<HTMLInputElement>('input')!;

    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await Promise.resolve();
    await Promise.resolve();

    expect(session.open).toBe(true);
    expect(session.pending).toBe(false);
    expect(session.terminalResult).toEqual({
      type: 'file-created',
      path: 'Projects/Outside query.md',
      indexed: false,
      status: 'conflict',
    });
    expect(host.querySelector('input')).toBeNull();
    expect(live.textContent).toContain('not visible in Projects');
    const recovery = host.querySelector<HTMLButtonElement>('.abyss-project-capture-open-note')!;
    expect(recovery.textContent).toBe('Open created note');

    recovery.click();
    expect(openNote).toHaveBeenCalledOnce();
    expect(openNote).toHaveBeenCalledWith('Projects/Outside query.md');
    expect(onCreate).toHaveBeenCalledOnce();
  });

  it('restores not-indexed recovery across remounts and repeated plus does not duplicate it', async () => {
    const trigger = freshContainer().createEl('button');
    const firstHost = freshContainer();
    const live = freshContainer();
    const session = captureSession({ draft: 'Outside query' });
    const onCreate = vi.fn().mockResolvedValue({
      type: 'file-created',
      path: 'Projects/Outside query.md',
      indexed: false,
      status: 'not-requested',
    });
    const firstCleanup = showNewProjectInput(firstHost, onCreate, {
      session,
      trigger,
      liveRegion: live,
      openNote: vi.fn(),
    });
    firstHost
      .querySelector<HTMLInputElement>('input')!
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await Promise.resolve();
    await Promise.resolve();
    firstCleanup();

    const remountedHost = freshContainer();
    const options = { session, trigger, liveRegion: live, openNote: vi.fn() };
    showNewProjectInput(remountedHost, onCreate, options);
    showNewProjectInput(remountedHost, onCreate, options);

    expect(remountedHost.querySelectorAll('.abyss-project-capture')).toHaveLength(1);
    expect(remountedHost.querySelector('input')).toBeNull();
    expect(
      remountedHost.querySelector<HTMLButtonElement>('.abyss-project-capture-open-note')
        ?.textContent,
    ).toBe('Open created note');
    expect(onCreate).toHaveBeenCalledOnce();
  });

  it('settles one pending submission after the portfolio renderer remounts', async () => {
    const pending = deferred<{
      type: 'file-created';
      path: string;
      indexed: boolean;
      status: 'applied';
    }>();
    const onCreate = vi.fn().mockReturnValue(pending.promise);
    const session = captureSession({ draft: 'Survives refresh' });
    const trigger = freshContainer().createEl('button');
    const onSettled = vi.fn();
    const firstHost = freshContainer();
    const firstLive = freshContainer();
    const cleanup = showNewProjectInput(firstHost, onCreate, {
      session,
      trigger,
      liveRegion: firstLive,
    });
    firstHost
      .querySelector<HTMLInputElement>('input')!
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    cleanup();

    const remountedHost = freshContainer();
    const remountedLive = freshContainer();
    showNewProjectInput(remountedHost, onCreate, {
      session,
      trigger,
      liveRegion: remountedLive,
      onSettled,
    });
    expect(remountedHost.querySelector<HTMLInputElement>('input')?.disabled).toBe(true);

    pending.resolve({
      type: 'file-created',
      path: 'Projects/Survives refresh.md',
      indexed: true,
      status: 'applied',
    });
    await pending.promise;
    await Promise.resolve();
    await Promise.resolve();

    expect(onCreate).toHaveBeenCalledOnce();
    expect(session.pending).toBe(false);
    expect(session.open).toBe(false);
    expect(session.createdPath).toBe('Projects/Survives refresh.md');
    expect(remountedHost.querySelector('.abyss-project-capture')).toBeNull();
    expect(remountedLive.textContent).toBe('Project created.');
    expect(onSettled).toHaveBeenCalledOnce();
  });
});

describe('renderProjectsList production Overview rows', () => {
  it('keeps outside-pointer dismissal armed after New project is pressed twice', () => {
    const root = freshContainer();
    activeDocument.body.appendChild(root);
    const cleanup = renderProjectsList(root, [snapshot()], context());
    const trigger = root.querySelector<HTMLButtonElement>('[aria-label="New project"]')!;

    trigger.click();
    trigger.click();
    expect(root.querySelectorAll('.abyss-project-capture')).toHaveLength(1);
    activeDocument.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));

    expect(root.querySelector('.abyss-project-capture')).toBeNull();
    cleanup();
    root.remove();
  });

  it('temporarily reveals and focuses an indexed created project excluded by filters', () => {
    const root = freshContainer();
    activeDocument.body.appendChild(root);
    const ctx = context();
    ctx.settings.projects.view.visibleStatusIds = [];
    ctx.settings.projects.view.includeUnmapped = false;
    const session = captureSession({ open: false, createdPath: 'Projects/Portfolio.md' });

    const cleanup = renderProjectsList(root, [snapshot()], { ...ctx, captureSession: session });

    const row = root.querySelector<HTMLElement>('.abyss-project-row')!;
    expect(row).not.toBeNull();
    expect(row.classList.contains('is-just-created')).toBe(true);
    expect(activeDocument.activeElement).toBe(row.querySelector('[data-project-identity-control]'));
    expect(session.createdPath).toBeNull();
    cleanup();
    root.remove();
  });

  it('renders health/title/exceptional priority/progress then Next Action and one date signal', () => {
    const next = task({
      title: 'Ship the migration',
      tags: ['#task/next_action'],
      planning: { due: '2026-08-30' },
    });
    const root = freshContainer();
    renderProjectsList(
      root,
      [
        snapshot({
          tasks: [
            {
              task: next,
              projectPath: 'Projects/Portfolio.md',
              dependency: { type: 'allowed' },
              owner: { type: 'project', path: 'Projects/Portfolio.md' },
            },
          ],
        }),
      ],
      context(),
    );

    const row = root.querySelector<HTMLElement>('.abyss-project-row')!;
    expect(row.querySelectorAll('.abyss-project-row-line')).toHaveLength(2);
    expect(row.querySelector('[aria-label^="Project health: On track"]')).not.toBeNull();
    expect(row.querySelector('.abyss-project-name')?.textContent).toBe('Portfolio');
    expect(row.querySelector('.abyss-project-priority')?.textContent).toBe('A');
    expect(row.querySelector('[role="progressbar"]')?.textContent).toContain('1/2');
    expect(row.querySelector('.abyss-project-next-action-title')?.textContent).toBe(
      'Ship the migration',
    );
    expect(row.querySelector('.abyss-project-date-signal')?.textContent).toContain('2026-08-30');
    expect(row.textContent).not.toMatch(/Projects\/Portfolio\.md|\bTasks\b|\bWork Notes\b/u);
  });

  it('uses one calm reason and No tasks for an empty Project without a metadata scroller', () => {
    const root = freshContainer();
    renderProjectsList(
      root,
      [
        snapshot({
          project: {
            ...snapshot().project,
            priority: null,
            stats: { total: 0, done: 0, cancelled: 0, inProgress: 0, open: 0, progress: null },
          },
          taskRollup: {
            total: 0,
            done: 0,
            cancelled: 0,
            inProgress: 0,
            open: 0,
            progress: null,
          },
        }),
      ],
      context(),
    );

    const row = root.querySelector<HTMLElement>('.abyss-project-row')!;
    expect(row.querySelectorAll('.abyss-project-row-line')).toHaveLength(2);
    expect(row.textContent).toContain('No tasks');
    expect(row.textContent).toContain('No actionable next action');
    expect(row.querySelector('.abyss-project-row-meta')).toBeNull();
    expect(row.querySelector('.abyss-project-folder')).toBeNull();
  });

  it('keeps long multilingual titles in one title node and bounds 100+ rows', () => {
    const snapshots = Array.from({ length: 120 }, (_, index) =>
      snapshot({
        project: {
          ...snapshot().project,
          path: `Projects/${String(index)}.md`,
          name:
            index === 0
              ? 'Очень длинное название проекта для проверки предсказуемого усечения without one-character columns'
              : `Project ${String(index)}`,
        },
      }),
    );
    const root = freshContainer();
    renderProjectsList(root, snapshots, context());

    const title = root.querySelector<HTMLElement>('.abyss-project-name')!;
    expect(title.childElementCount).toBe(0);
    expect(title.textContent).toContain('Очень длинное название');
    expect(root.querySelectorAll('[data-bounded-key]').length).toBeLessThan(30);
  });
});
