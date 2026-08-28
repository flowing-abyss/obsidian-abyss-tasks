import { WorkspaceLeaf, type App } from 'obsidian';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppState } from '../src/app/AppState';
import type { Project, ProjectWorkspaceSnapshot } from '../src/projects/types';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import type { CalendarSettings } from '../src/settings/types';
import { TagManager } from '../src/tags/TagManager';
import type { TaskApplicationApi, TaskCaptureApplicationApi } from '../src/tasks';
import { PanelView } from '../src/views/PanelView';
import { configuredTaskApplication, createAppWithFiles, task, useRealMoment } from './helpers';

useRealMoment();

function makeTagManager(app: App, settings: CalendarSettings): TagManager {
  return new TagManager(app, settings, vi.fn().mockResolvedValue(undefined));
}

function projectSnapshot(): ProjectWorkspaceSnapshot {
  const project: Project = {
    path: 'Projects/A.md',
    name: 'A',
    frontmatter: {},
    tags: [],
    statusId: DEFAULT_SETTINGS.projects.statuses[0]!.id,
    rawStatus: null,
    range: {},
    stats: { total: 1, done: 0, cancelled: 0, inProgress: 0, open: 1, progress: 0 },
  };
  const snapshot = task({
    title: 'Joined task',
    ref: { filePath: 'Work/A.md', line: 0, revision: 'joined-1' },
    source: { filePath: 'Work/A.md', line: 0 },
  });
  return {
    project,
    tasks: [
      {
        task: snapshot,
        projectPath: project.path,
        dependency: { type: 'allowed' },
        owner: { type: 'work-note', path: 'Work/A.md' },
      },
    ],
    workNotes: [],
    milestones: [],
    taskRollup: { total: 1, done: 0, cancelled: 0, inProgress: 0, open: 1, progress: 0 },
    workNoteRollup: { active: 0, completed: 0, dropped: 0 },
    milestoneRollups: new Map(),
    workNoteRelations: [],
    overdue: { tasks: 0, workNotes: 0 },
    dependencies: { blocked: 0, invalid: 0, diagnostics: [] },
    diagnostics: [],
  };
}

interface ProjectPublicationHarness {
  readonly view: PanelView;
  readonly publish: () => void;
  readonly activeSubscriptionCount: () => number;
  readonly close: () => Promise<void>;
}

async function openProjectPublicationHarness(): Promise<ProjectPublicationHarness> {
  const app = await createAppWithFiles({});
  const settings = structuredClone(DEFAULT_SETTINGS);
  const application = configuredTaskApplication(app, settings);
  await application.index.initialize();
  const snapshot = projectSnapshot();
  const listeners = new Set<
    (snapshots: readonly ProjectWorkspaceSnapshot[], event: unknown) => void
  >();
  const projectStore = {
    list: () => [snapshot.project],
    get: () => snapshot.project,
    activeForLeftPanel: () => [snapshot.project],
    onUpdate: () => () => undefined,
    refresh: () => undefined,
  } as never;
  const projectWorkspace = {
    list: () => [snapshot],
    get: () => snapshot,
    onUpdate: (
      listener: (snapshots: readonly ProjectWorkspaceSnapshot[], event: unknown) => void,
    ) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    absorbOwnCommit: () => undefined,
  } as never;
  const leaf = new (WorkspaceLeaf as unknown as { new (app: App): WorkspaceLeaf })(app);
  const view = new PanelView(
    leaf,
    settings,
    makeTagManager(app, settings),
    application.index,
    application.tasks as TaskApplicationApi & TaskCaptureApplicationApi,
    application.statusRegistry,
    undefined,
    undefined,
    undefined,
    undefined,
    projectStore,
    projectWorkspace,
  );
  await view.onOpen();
  activeDocument.body.append(view.contentEl);
  const state = (view as unknown as { state: AppState }).state;
  state.set('mode', 'projects');

  return {
    view,
    publish: () => {
      for (const listener of [...listeners]) {
        listener([snapshot], { snapshots: [snapshot], projectPaths: [snapshot.project.path] });
      }
    },
    activeSubscriptionCount: () => listeners.size,
    close: async () => {
      await view.onClose();
      view.contentEl.remove();
      application.index.destroy();
    },
  };
}

describe('PanelView Project publications', () => {
  const closers: Array<() => Promise<void>> = [];

  afterEach(async () => {
    await Promise.all(closers.splice(0).map((close) => close()));
  });

  it('refreshes the mounted CenterPanel once for one coordinator publication', async () => {
    const harness = await openProjectPublicationHarness();
    closers.push(harness.close);
    const center = (harness.view as unknown as { center: { refresh(): void } }).center;
    const refresh = vi.spyOn(center, 'refresh');
    refresh.mockClear();

    harness.publish();

    expect(refresh).toHaveBeenCalledOnce();
  });

  it('keeps one coordinator subscription after the PanelView is reopened', async () => {
    const harness = await openProjectPublicationHarness();
    closers.push(harness.close);

    expect(harness.activeSubscriptionCount()).toBe(1);
    await harness.view.onClose();
    expect(harness.activeSubscriptionCount()).toBe(0);
    await harness.view.onOpen();

    expect(harness.activeSubscriptionCount()).toBe(1);
  });

  it('removes the coordinator publication path when the PanelView closes', async () => {
    const harness = await openProjectPublicationHarness();
    const center = (harness.view as unknown as { center: { refresh(): void } }).center;
    const refresh = vi.spyOn(center, 'refresh');
    refresh.mockClear();

    await harness.close();
    harness.publish();

    expect(harness.activeSubscriptionCount()).toBe(0);
    expect(refresh).not.toHaveBeenCalled();
  });
});
