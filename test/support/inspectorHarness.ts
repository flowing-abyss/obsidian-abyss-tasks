import { Notice, requireApiVersion, TFile } from 'obsidian';
import { expect, vi } from 'vitest';
import { AppState } from '../../src/app/AppState';
import { RightPanel } from '../../src/panels/RightPanel';
import { buildDefaultTaskStatuses, DEFAULT_SETTINGS } from '../../src/settings/defaults';
import { toStatusRules } from '../../src/settings/statusCatalogAdapter';
import type { CalendarSettings, TaskStatusDef } from '../../src/settings/types';
import { StatusRegistry } from '../../src/status/StatusRegistry';
import type { TaskApplicationApi } from '../../src/tasks';
import { TaskApplicationService } from '../../src/tasks/application/TaskApplicationService';
import {
  TaskDependencyService,
  type TaskDiagnosticSink,
} from '../../src/tasks/application/TaskDependencyService';
import { clockFrom } from '../../src/tasks/domain/clock';
import { StatusCatalog } from '../../src/tasks/domain/StatusCatalog';
import { TaskBlockEditor } from '../../src/tasks/infrastructure/markdown/TaskBlockEditor';
import { TaskLocator } from '../../src/tasks/infrastructure/markdown/TaskLocator';
import { TaskMarkdownCodec } from '../../src/tasks/infrastructure/markdown/TaskMarkdownCodec';
import { ObsidianTaskRepository } from '../../src/tasks/infrastructure/obsidian/ObsidianTaskRepository';
import { TaskIndex } from '../../src/tasks/infrastructure/TaskIndex';
import { TaskRefAuthority } from '../../src/tasks/infrastructure/TaskRefAuthority';
import { createTaskDependencySearchProvider } from '../../src/ui/TaskDependencySearchProvider';
import {
  isCurrentTaskSelectionSnapshot,
  rebuildTaskSelection,
  rootTaskRef,
} from '../../src/ui/taskSelection';
import { createAppWithFiles, expectDefined } from '../helpers';
import { canonicalSearchForIndex, ControlledSearchScheduler } from './taskSearchHarness';

/** Teardown for every harness a test built; each suite drains it in its `afterEach`. */
export const inspectorCleanups: Array<() => void> = [];

/** A mounted RightPanel over a real index, repository, and ref authority, attached to the body. */
export async function inspectorHarness(
  markdown: string,
  selected = 'Current',
  additionalFiles = {},
  settingsOrStatuses: CalendarSettings | readonly TaskStatusDef[] = buildDefaultTaskStatuses(),
) {
  const settings = 'taskStatuses' in settingsOrStatuses ? settingsOrStatuses : DEFAULT_SETTINGS;
  const statusDefinitions =
    'taskStatuses' in settingsOrStatuses ? settingsOrStatuses.taskStatuses : settingsOrStatuses;
  // The mock metadata parser uses -0 for a root list beginning on line zero.
  const app = await createAppWithFiles({ 'tasks.md': `\n${markdown}`, ...additionalFiles });
  const statuses = new StatusCatalog(toStatusRules(statusDefinitions));
  const authority = new TaskRefAuthority('inspector-dependencies');
  const index = new TaskIndex(app, {
    statusCatalog: statuses,

    refAuthority: authority,
  });
  await index.initialize();
  const repository = new ObsidianTaskRepository(app, {
    codec: new TaskMarkdownCodec(statuses),
    editor: new TaskBlockEditor(),
    locator: new TaskLocator(authority),
    snapshotsFromContent: (path, content) => index.snapshotsFromContent(path, content),
    refAuthority: authority,
    snapshotState: index,
  });
  const diagnostics = vi.fn<TaskDiagnosticSink>();
  let generated = 0;
  const application = new TaskApplicationService(
    index,
    repository,
    statuses,
    clockFrom(Date.parse('2026-09-05T12:00:00Z'), 0),
    undefined,
    () => ({
      taskPrefix: settings.taskPrefix,
      applyTaskPrefixToSubtasks: settings.applyTaskPrefixToSubtasks,
      inbox: settings.inbox,
      taskLifecycle: settings.taskLifecycle,
      recurrence: settings.recurrence,
    }),
    new TaskDependencyService(
      index,
      repository,
      () => (++generated === 1 ? 'generate' : `gen${String(generated).padStart(5, '0')}`),
      diagnostics,
    ),
    diagnostics,
  );
  const api: TaskApplicationApi = {
    queries: index,
    execute: (command) => application.execute(command),
  };
  const node = (title: string) =>
    expectDefined(
      index.listNodes().find(({ node: candidate }) => candidate.title === title),
      `Missing ${title}; nodes: ${index
        .listNodes()
        .map(({ node: item }) => item.title)
        .join(', ')}`,
    );
  const state = new AppState();
  const location = node(selected);
  state.set('taskStack', [location.root, ...location.path]);
  const el = activeDocument.body.createDiv();
  const search = canonicalSearchForIndex(index);
  const panel = new RightPanel({
    state,
    app,
    statusRegistry: new StatusRegistry([...statusDefinitions]),
    settings,
    tasks: api,
    search,
    dependencySearch: createTaskDependencySearchProvider(
      search,
      index,
      new ControlledSearchScheduler(),
    ),
  });
  panel.mount(el);
  inspectorCleanups.push(() => {
    panel.destroy();
    search.dispose();
    index.destroy();
  });
  const file = app.vault.getAbstractFileByPath('tasks.md');
  if (!(file instanceof TFile)) throw new Error('Missing fixture');
  const read = async () => {
    const content = await app.vault.read(file);
    expect(content.startsWith('\n')).toBe(true);
    return content.slice(1);
  };
  return { app, file, search, panel, el, state, index, node, api, read, repository, diagnostics };
}

export type InspectorHarness = Awaited<ReturnType<typeof inspectorHarness>>;

/** Captures every Notice; appends each container to the body where the host API shows them. */
export function notices(messages?: string[]): Notice[] {
  const captured: Notice[] = [];
  const prototype = Notice.prototype as unknown as {
    constructor__(this: Notice, message: string | DocumentFragment): void;
  };
  vi.spyOn(prototype, 'constructor__').mockImplementation(function (this: Notice, message) {
    captured.push(this);
    messages?.push(typeof message === 'string' ? message : message.textContent);
    if (requireApiVersion('1.8.7')) activeDocument.body.append(this.containerEl);
  });
  return captured;
}

/** What the sidebar and the modal do on an index change: rebuild the selection, carry drafts. */
export function subscribeInspectorReconciliation(h: InspectorHarness): () => void {
  return h.index.subscribe(() => {
    const stack = h.state.get('taskStack');
    const root = expectDefined(stack[0]);
    const resolution = h.index.resolve(rootTaskRef(root));
    if (resolution.type !== 'exact' && resolution.type !== 'rebased') return;
    const current = resolution.type === 'exact' ? resolution.task : resolution.current;
    if (resolution.type === 'exact' && isCurrentTaskSelectionSnapshot(current, stack)) return;
    const ownedRef =
      resolution.type === 'rebased' && resolution.evidence === 'authority-transition'
        ? resolution.previous.ref
        : undefined;
    const ownedSelection = h.panel.selectionForOwnedTransition(
      ownedRef,
      current,
      stack,
      completionWitness(resolution),
    );
    const draft =
      ownedRef === undefined
        ? h.panel.captureDraftState()
        : h.panel.captureDraftStateForOwnedTransition(ownedRef, current.ref);
    h.state.updateInspectorSelection(
      ownedSelection ??
        rebuildTaskSelection(current, stack, { preserveDependencyChanges: ownedRef !== undefined }),
    );
    h.panel.restoreDraftState(draft, current);
  });
}

function completionWitness(
  resolution: Extract<
    ReturnType<InspectorHarness['index']['resolve']>,
    { type: 'exact' | 'rebased' }
  >,
) {
  return resolution.basis.authorityTransition?.completionTracking;
}
