import { TFile } from 'obsidian';
import { describe, expect, it, vi } from 'vitest';
import { AppState } from '../src/app/AppState';
import { RightPanel } from '../src/panels/RightPanel';
import { DependencyIndex } from '../src/projects/dependencies/DependencyIndex';
import { DependencyPolicy } from '../src/projects/dependencies/DependencyPolicy';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import { toStatusRules } from '../src/settings/statusCatalogAdapter';
import type { TaskApplicationApi, TaskCommandResult, TaskSnapshot } from '../src/tasks';
import type { DependencyProjectionPort } from '../src/tasks/application/DependencyPolicyPort';
import { TaskApplicationService } from '../src/tasks/application/TaskApplicationService';
import { StatusCatalog } from '../src/tasks/domain/StatusCatalog';
import type { CommentRef, TaskRef } from '../src/tasks/domain/types';
import { localDate } from '../src/tasks/domain/validation';
import { TaskIndex } from '../src/tasks/infrastructure/TaskIndex';
import { TaskBlockEditor } from '../src/tasks/infrastructure/markdown/TaskBlockEditor';
import { TaskLocator } from '../src/tasks/infrastructure/markdown/TaskLocator';
import { TaskMarkdownCodec } from '../src/tasks/infrastructure/markdown/TaskMarkdownCodec';
import { ObsidianTaskRepository } from '../src/tasks/infrastructure/obsidian/ObsidianTaskRepository';
import { noInteractionOwnership } from '../src/ui/interactionOwnership';
import {
  createAppWithFiles,
  flushMicrotasks,
  freshContainer,
  taskQueryApi,
  testStatusRegistry,
  useRealMoment,
} from './helpers';

useRealMoment();

function snapshot(revision: string, description = 'old description'): TaskSnapshot {
  const ref: TaskRef = { filePath: 'tasks.md', line: 0, revision };
  const parent = { type: 'task' as const, ref };
  return {
    ref,
    title: 'root',
    markdownTitle: 'root',
    status: 'open',
    statusSymbol: ' ',
    priority: 'D',
    onCompletion: 'keep' as const,
    onCompletionExplicit: false,
    planning: {},
    tags: [],
    subtasks: [],
    comments: [
      {
        ref: {
          parent,
          relativeLine: 2,
          originalMarkdown: '  - 2026-07-13: old comment',
        },
        timestamp: {
          precision: 'day',
          value: '2026-07-13' as never,
          raw: '2026-07-13',
        },
        text: 'old comment',
      },
    ],
    description,
    source: {
      filePath: 'tasks.md',
      line: 0,
      originalMarkdown: '- [ ] root',
      originalBlock: '- [ ] root',
    },
    presentation: { linkCount: 0 },
  };
}

async function realDependencyApplication(
  source: string,
  dependencyIdGenerator: () => string = () => 'generated-id',
) {
  const app = await createAppWithFiles({ 'Tasks.md': source });
  const statusCatalog = new StatusCatalog(toStatusRules(DEFAULT_SETTINGS.taskStatuses));
  const index = new TaskIndex(app, {
    statusCatalog,
    dailyNoteFormat: DEFAULT_SETTINGS.desktop.dailyNoteFormat,
  });
  await index.initialize();
  const graph = new DependencyIndex();
  graph.replace(index.list());
  const policy = new DependencyPolicy(graph);
  const repository = new ObsidianTaskRepository(app, {
    codec: new TaskMarkdownCodec(statusCatalog),
    editor: new TaskBlockEditor(),
    locator: new TaskLocator(),
    snapshotsFromContent: (path, content) => index.snapshotsFromContent(path, content),
  });
  const tasks = new TaskApplicationService(
    index,
    repository,
    statusCatalog,
    { today: () => localDate('2026-08-28') },
    undefined,
    undefined,
    graph,
    policy,
    dependencyIdGenerator,
  );
  return {
    app,
    graph,
    index,
    policy,
    tasks,
    read: async () => app.vault.read(app.vault.getAbstractFileByPath('Tasks.md') as TFile),
  };
}

function snapshotWithChildren(revision: string, titles: readonly string[]): TaskSnapshot {
  const root = { ...snapshot(revision), comments: [], description: undefined };
  const parent = { type: 'task' as const, ref: root.ref };
  return {
    ...root,
    subtasks: titles.map((title, index) => ({
      ref: {
        parent,
        relativeLine: index + 1,
        originalBlock: `  - [ ] ${title}`,
      },
      title,
      markdownTitle: title,
      status: 'open' as const,
      statusSymbol: ' ',
      priority: 'D' as const,
      onCompletion: 'keep' as const,
      onCompletionExplicit: false,
      planning: {},
      tags: [],
      subtasks: [],
      comments: [],
    })),
  };
}

function snapshotWithNestedChildren(revision: string): TaskSnapshot {
  const root = snapshotWithChildren(revision, ['branch', 'sibling']);
  const rootNode = { type: 'task' as const, ref: root.ref };
  const branchRef = {
    parent: rootNode,
    relativeLine: 1,
    originalBlock: '  - [ ] branch\n    - [ ] nested one\n    - [ ] nested two',
  };
  const branchNode = { type: 'subtask' as const, ref: branchRef };
  const nested = ['nested one', 'nested two'].map((title, index) => ({
    ref: {
      parent: branchNode,
      relativeLine: index + 1,
      originalBlock: `    - [ ] ${title}`,
    },
    title,
    markdownTitle: title,
    status: 'open' as const,
    statusSymbol: ' ',
    priority: 'D' as const,
    onCompletion: 'keep' as const,
    onCompletionExplicit: false,
    planning: {},
    tags: [],
    subtasks: [],
    comments: [],
  }));
  return {
    ...root,
    subtasks: [
      { ...root.subtasks[0]!, ref: branchRef, subtasks: nested },
      {
        ...root.subtasks[1]!,
        ref: { ...root.subtasks[1]!.ref, parent: rootNode, relativeLine: 4 },
      },
    ],
  };
}

function api(execute: TaskApplicationApi['execute']): TaskApplicationApi {
  return {
    queries: taskQueryApi(),
    execute,
  };
}

function call<T>(panel: RightPanel, method: string, ...args: unknown[]): T {
  const fn = (panel as unknown as Record<string, (...values: unknown[]) => T>)[method]!;
  return fn.call(panel, ...args);
}

async function panelWith(
  initial: TaskSnapshot,
  execute: TaskApplicationApi['execute'],
  acknowledge?: (ref?: TaskRef) => void,
) {
  const app = await createAppWithFiles({ 'tasks.md': '- [ ] root\n' });
  const state = new AppState();
  state.set('taskStack', [initial]);
  const panel = new RightPanel(
    state,
    app,
    testStatusRegistry(),
    DEFAULT_SETTINGS,
    acknowledge,
    api(execute),
  );
  return { app, state, panel };
}

describe('RightPanel block editing', () => {
  it.each(['click', 'Enter', ' '] as const)(
    'keeps a projected blocked completion marker focusable and dispatches %s through the common service',
    async (activation) => {
      const dependent = {
        ...snapshot('dependent'),
        dependency: { dependsOn: ['prep'] },
      } satisfies TaskSnapshot;
      const blocked: DependencyProjectionPort = {
        evaluateCompletion: () => ({
          type: 'blocked',
          prerequisites: [{ filePath: 'tasks.md', line: 0, revision: 'prep' }],
        }),
        inspect: () => ({
          decision: {
            type: 'blocked',
            prerequisites: [{ filePath: 'tasks.md', line: 0, revision: 'prep' }],
          },
          relations: [
            {
              id: 'prep',
              resolution: {
                type: 'resolved',
                prerequisite: { filePath: 'tasks.md', line: 0, revision: 'prep' },
                complete: false,
              },
            },
          ],
        }),
        subscribe: () => () => undefined,
      };
      const execute = vi.fn<TaskApplicationApi['execute']>().mockResolvedValue({
        type: 'blocked',
        operation: 'completion',
        dependency: blocked.evaluateCompletion(dependent) as never,
      });
      const { app, state } = await panelWith(dependent, execute);
      const panel = new RightPanel(
        state,
        app,
        testStatusRegistry(),
        DEFAULT_SETTINGS,
        undefined,
        api(execute),
        undefined,
        undefined,
        undefined,
        noInteractionOwnership,
        blocked,
      );
      const container = freshContainer();
      activeDocument.body.append(container);
      panel.mount(container);
      try {
        const marker = container.querySelector<HTMLElement>(
          '.abyss-right-header .abyss-status-marker',
        )!;
        expect(marker.getAttribute('aria-disabled')).toBe('true');
        expect(marker.getAttribute('tabindex')).toBe('0');
        expect(marker.hasAttribute('disabled')).toBe(false);

        if (activation === 'click') marker.click();
        else {
          marker.dispatchEvent(
            new KeyboardEvent('keydown', { key: activation, bubbles: true, cancelable: true }),
          );
        }
        await flushMicrotasks();

        expect(execute).toHaveBeenCalledOnce();
        expect(execute).toHaveBeenCalledWith({
          type: 'toggle-completion',
          target: { type: 'task', ref: dependent.ref },
        });
      } finally {
        panel.destroy();
        container.remove();
      }
    },
  );

  it('repairs one explicit missing dependency with its carrier ID and restores focus on Escape', async () => {
    const dependent = {
      ...snapshot('dependent'),
      dependency: { dependsOn: ['wanted'] },
    } satisfies TaskSnapshot;
    const candidate = {
      ...snapshot('candidate'),
      ref: { filePath: 'candidate.md', line: 0, revision: 'candidate' },
      title: 'Candidate without ID',
      markdownTitle: 'Candidate without ID',
    } satisfies TaskSnapshot;
    const newDependencyId = vi.fn(() => 'generated-id');
    const setDependency = vi.fn().mockResolvedValue({
      type: 'invalid' as const,
      issues: [{ code: 'invalid-target' as const, field: 'dependency' }],
    });
    const tasks = {
      queries: taskQueryApi({ list: () => [dependent, candidate] }),
      execute: vi.fn(),
      setDependency,
      newDependencyId,
    } satisfies TaskApplicationApi & { newDependencyId(): string };
    const projection: DependencyProjectionPort = {
      evaluateCompletion: (task) =>
        task === dependent
          ? {
              type: 'invalid',
              diagnostics: [{ type: 'missing-prerequisite', id: 'wanted' }],
            }
          : { type: 'allowed' },
      inspect: () => ({
        decision: {
          type: 'invalid',
          diagnostics: [{ type: 'missing-prerequisite', id: 'wanted' }],
        },
        relations: [{ id: 'wanted', resolution: { type: 'missing' } }],
      }),
      subscribe: () => () => undefined,
    };
    const app = await createAppWithFiles({
      'tasks.md': '- [ ] root ⛔ wanted\n',
      'candidate.md': '- [ ] Candidate without ID\n',
    });
    const state = new AppState();
    state.set('taskStack', [dependent]);
    const panel = new RightPanel(
      state,
      app,
      testStatusRegistry(),
      DEFAULT_SETTINGS,
      undefined,
      tasks,
      undefined,
      undefined,
      undefined,
      noInteractionOwnership,
      projection,
      () => ({ project: [candidate], other: [] }),
    );
    const container = freshContainer();
    activeDocument.body.append(container);
    panel.mount(container);
    const trigger = container.querySelector<HTMLButtonElement>('[data-dependency-trigger]')!;
    trigger.click();

    container.querySelector<HTMLButtonElement>('[data-dependency-repair="wanted"]')!.click();
    const search = container.querySelector<HTMLInputElement>('[data-dependency-search]')!;
    expect(activeDocument.activeElement).toBe(search);
    container.querySelector<HTMLButtonElement>('[data-dependency-candidate]')!.click();
    await flushMicrotasks();

    expect(newDependencyId).not.toHaveBeenCalled();
    expect(setDependency).toHaveBeenCalledWith({
      prerequisite: candidate.ref,
      dependent: dependent.ref,
      dependencyId: 'wanted',
      enabled: true,
    });
    activeDocument.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    );
    expect(container.querySelector('[data-dependency-editor]')).toBeNull();
    expect(activeDocument.activeElement).toBe(trigger);
    panel.destroy();
    container.remove();
  });

  it('orders dependency search Project-first, dispatches set/clear, and restores focus on Escape', async () => {
    const dependent = {
      ...snapshot('dependent'),
      title: 'Ship',
      markdownTitle: 'Ship',
      dependency: { dependsOn: ['prep'] },
    } satisfies TaskSnapshot;
    const projectCandidate = {
      ...snapshot('prep'),
      title: 'Prepare',
      markdownTitle: 'Prepare',
      dependency: { id: 'prep', dependsOn: [] },
    } satisfies TaskSnapshot;
    const outsideCandidate = {
      ...snapshot('outside'),
      ref: { filePath: 'outside.md', line: 3, revision: 'outside' },
      title: 'Outside task',
      markdownTitle: 'Outside task',
      dependency: { id: 'outside', dependsOn: [] },
      source: {
        filePath: 'outside.md',
        line: 3,
        originalMarkdown: '- [ ] Outside task 🆔 outside',
        originalBlock: '- [ ] Outside task 🆔 outside',
      },
    } satisfies TaskSnapshot;
    const fillerCandidates = Array.from({ length: 25 }, (_, index) => ({
      ...snapshot(`filler-${String(index)}`),
      ref: {
        filePath: `Filler-${String(index)}.md`,
        line: index,
        revision: `filler-${String(index)}`,
      },
      title: index === 0 ? 'Outside task' : `Filler ${String(index)}`,
      markdownTitle: index === 0 ? 'Outside task' : `Filler ${String(index)}`,
      source: {
        filePath: `Filler-${String(index)}.md`,
        line: index,
        originalMarkdown: `- [ ] Filler ${String(index)}`,
        originalBlock: `- [ ] Filler ${String(index)}`,
      },
    }));
    let notify:
      | ((event: { affected: readonly TaskRef[]; causalTaskPaths: readonly string[] }) => void)
      | undefined;
    const projection: DependencyProjectionPort = {
      evaluateCompletion: () => ({ type: 'blocked', prerequisites: [projectCandidate.ref] }),
      inspect: () => ({
        decision: { type: 'blocked', prerequisites: [projectCandidate.ref] },
        relations: [
          {
            id: 'prep',
            resolution: { type: 'resolved', prerequisite: projectCandidate.ref, complete: false },
          },
        ],
      }),
      subscribe: (listener) => {
        notify = listener;
        return () => undefined;
      },
    };
    const setDependency = vi.fn().mockImplementation(async () => {
      notify?.({ affected: [dependent.ref], causalTaskPaths: ['tasks.md'] });
      return {
        type: 'ok' as const,
        changed: false,
        outcome: { type: 'task' as const, task: dependent },
      };
    });
    const clearDependency = vi.fn().mockImplementation(async () => {
      notify?.({ affected: [dependent.ref], causalTaskPaths: ['tasks.md'] });
      return {
        type: 'ok' as const,
        changed: false,
        outcome: { type: 'task' as const, task: dependent },
      };
    });
    const execute = vi.fn<TaskApplicationApi['execute']>();
    const tasks: TaskApplicationApi = {
      queries: taskQueryApi({
        list: () => [outsideCandidate, projectCandidate, dependent, ...fillerCandidates],
      }),
      execute,
      setDependency,
      clearDependency,
    };
    const app = await createAppWithFiles({
      'tasks.md': '- [ ] Prepare 🆔 prep\n- [ ] Ship ⛔ prep\n',
      'outside.md': '- [ ] Outside task 🆔 outside\n',
    });
    const state = new AppState();
    state.set('taskStack', [dependent]);
    const panel = new RightPanel(
      state,
      app,
      testStatusRegistry(),
      DEFAULT_SETTINGS,
      undefined,
      tasks,
      undefined,
      undefined,
      undefined,
      noInteractionOwnership,
      projection,
      () => ({ project: [projectCandidate], other: [outsideCandidate, ...fillerCandidates] }),
    );
    const container = freshContainer();
    Object.defineProperty(container, 'getBoundingClientRect', {
      configurable: true,
      value: () => new DOMRect(0, 0, 240, 180),
    });
    activeDocument.body.append(container);
    panel.mount(container);
    try {
      const currentTrigger = (): HTMLButtonElement =>
        container.querySelector<HTMLButtonElement>('[aria-label="Edit blocked by"]')!;
      const trigger = currentTrigger();
      expect(trigger.textContent?.trim()).not.toContain('Blocked by');
      trigger.focus();
      trigger.click();

      const input = container.querySelector<HTMLInputElement>('[data-dependency-search]')!;
      expect(
        container
          .querySelector<HTMLElement>('[data-dependency-editor]')
          ?.style.getPropertyValue('--abyss-popover-max-block-size'),
      ).toBe('164px');
      const candidates = Array.from(
        container.querySelectorAll<HTMLButtonElement>('[data-dependency-candidate]'),
      );
      expect(activeDocument.activeElement).toBe(input);
      expect(
        candidates
          .slice(0, 3)
          .map(
            (candidate) =>
              candidate.querySelector('.abyss-dependency-candidate-title')?.textContent,
          ),
      ).toEqual(['Outside task', 'Outside task', 'Filler 1']);
      expect(candidates).toHaveLength(20);
      expect(candidates[0]?.getAttribute('aria-label')).toContain('outside.md, line 4');
      expect(
        candidates
          .slice(0, 2)
          .map(
            (candidate) =>
              candidate.querySelector('.abyss-dependency-candidate-source')?.textContent,
          ),
      ).toEqual(['outside.md:4', 'Filler-0.md:1']);
      expect(trigger.getAttribute('aria-expanded')).toBe('true');
      expect(trigger.getAttribute('aria-controls')).toBe(
        container.querySelector('[data-dependency-editor]')?.id,
      );
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
      expect(activeDocument.activeElement).toBe(candidates[0]);
      candidates[0]!.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }),
      );
      expect(activeDocument.activeElement).toBe(candidates[1]);
      candidates[1]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
      expect(activeDocument.activeElement).toBe(candidates[0]);

      candidates[0]!.click();
      await flushMicrotasks();
      expect(setDependency).toHaveBeenCalledWith({
        prerequisite: outsideCandidate.ref,
        dependent: dependent.ref,
        dependencyId: 'outside',
        enabled: true,
      });
      expect(activeDocument.activeElement).toBe(
        container.querySelector<HTMLInputElement>('[data-dependency-search]'),
      );
      container.querySelector<HTMLButtonElement>('[data-dependency-clear="prep"]')!.click();
      await flushMicrotasks();
      expect(clearDependency).toHaveBeenCalledWith({
        dependent: dependent.ref,
        dependencyId: 'prep',
      });
      expect(activeDocument.activeElement).toBe(
        container.querySelector<HTMLInputElement>('[data-dependency-search]'),
      );

      const finalTrigger = currentTrigger();
      activeDocument.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
      );
      expect(container.querySelector('[data-dependency-editor]')).toBeNull();
      expect(activeDocument.activeElement).toBe(finalTrigger);
      expect(finalTrigger.getAttribute('aria-expanded')).toBe('false');
    } finally {
      panel.destroy();
      container.remove();
    }
  });

  it('rerenders the selected root on a dependency-only projection update', async () => {
    const selected = snapshot('selected');
    let decision: ReturnType<DependencyProjectionPort['evaluateCompletion']> = { type: 'allowed' };
    let notify:
      | ((event: { affected: readonly TaskRef[]; causalTaskPaths: readonly string[] }) => void)
      | undefined;
    const projection: DependencyProjectionPort = {
      evaluateCompletion: () => decision,
      inspect: () => ({
        decision,
        relations:
          decision.type === 'invalid'
            ? [{ id: 'missing', resolution: { type: 'missing' as const } }]
            : [],
      }),
      subscribe: (listener) => {
        notify = listener;
        return () => undefined;
      },
    };
    const { app, state } = await panelWith(selected, vi.fn());
    const panel = new RightPanel(
      state,
      app,
      testStatusRegistry(),
      DEFAULT_SETTINGS,
      undefined,
      api(vi.fn()),
      undefined,
      undefined,
      undefined,
      noInteractionOwnership,
      projection,
    );
    const container = freshContainer();
    activeDocument.body.append(container);
    panel.mount(container);
    expect(container.querySelector('[aria-label="Edit blocked by"]')).not.toBeNull();
    expect(container.querySelector('.abyss-task-dependency-badge')).toBeNull();
    container.querySelector<HTMLElement>('.abyss-right-title-view')!.click();
    const draft = container.querySelector<HTMLTextAreaElement>('.abyss-right-title-edit')!;
    draft.value = 'unsaved local title';
    draft.focus();
    draft.setSelectionRange(2, 7);

    decision = { type: 'invalid', diagnostics: [{ type: 'unresolved-projection' }] };
    notify?.({ affected: [selected.ref], causalTaskPaths: [] });

    expect(container.querySelector('[aria-label="Edit blocked by"]')).not.toBeNull();
    expect(
      container.querySelector('.abyss-task-dependency-badge')?.getAttribute('aria-label'),
    ).toBe('Dependency issue');
    const restored = container.querySelector<HTMLTextAreaElement>('.abyss-right-title-edit')!;
    expect(restored.value).toBe('unsaved local title');
    expect(restored.selectionStart).toBe(2);
    expect(restored.selectionEnd).toBe(7);
    expect(activeDocument.activeElement).toBe(restored);
    panel.destroy();
    container.remove();
  });

  it('assigns an unlabelled prerequisite one generated ID when it is activated', async () => {
    const dependent = snapshot('dependent');
    const candidate = {
      ...snapshot('candidate'),
      ref: { filePath: 'candidate.md', line: 0, revision: 'candidate' },
      title: 'Candidate',
      markdownTitle: 'Candidate',
      source: {
        filePath: 'candidate.md',
        line: 0,
        originalMarkdown: '- [ ] Candidate',
        originalBlock: '- [ ] Candidate',
      },
    } satisfies TaskSnapshot;
    const newDependencyId = vi.fn(() => 'generated-id');
    const setDependency = vi.fn().mockResolvedValue({
      type: 'invalid' as const,
      issues: [{ code: 'invalid-target' as const, field: 'dependency' }],
    });
    const tasks = {
      queries: taskQueryApi({ list: () => [dependent, candidate] }),
      execute: vi.fn(),
      setDependency,
      newDependencyId,
    } satisfies TaskApplicationApi & { newDependencyId(): string };
    const projection: DependencyProjectionPort = {
      evaluateCompletion: () => ({ type: 'allowed' }),
      inspect: () => ({ decision: { type: 'allowed' }, relations: [] }),
      subscribe: () => () => undefined,
    };
    const app = await createAppWithFiles({
      'tasks.md': '- [ ] root\n',
      'candidate.md': '- [ ] Candidate\n',
    });
    const state = new AppState();
    state.set('taskStack', [dependent]);
    const panel = new RightPanel(
      state,
      app,
      testStatusRegistry(),
      DEFAULT_SETTINGS,
      undefined,
      tasks,
      undefined,
      undefined,
      undefined,
      noInteractionOwnership,
      projection,
      () => ({ project: [candidate], other: [] }),
    );
    const container = freshContainer();
    panel.mount(container);
    container.querySelector<HTMLButtonElement>('[data-dependency-trigger]')!.click();
    container.querySelector<HTMLButtonElement>('[data-dependency-candidate]')!.click();
    await flushMicrotasks();

    expect(newDependencyId).toHaveBeenCalledOnce();
    expect(setDependency).toHaveBeenCalledWith({
      prerequisite: candidate.ref,
      dependent: dependent.ref,
      dependencyId: 'generated-id',
      enabled: true,
    });
    panel.destroy();
  });

  it('retries an ID-less generated collision with one fresh ID on the next activation', async () => {
    const generateId = vi
      .fn<() => string>()
      .mockReturnValueOnce('collision')
      .mockReturnValueOnce('fresh');
    const source = [
      '- [ ] Existing 🆔 collision',
      '',
      '- [ ] Dependent',
      '',
      '- [ ] Candidate without ID',
      '',
    ].join('\n');
    const harness = await realDependencyApplication(source, generateId);
    expect(harness.index.list().map(({ title, source: item }) => [title, item.line])).toEqual([
      ['Existing', 0],
      ['Dependent', 2],
      ['Candidate without ID', 4],
    ]);
    const dependent = harness.index.list().find(({ source: item }) => item.line === 2)!;
    const candidate = harness.index.list().find(({ source: item }) => item.line === 4)!;
    const state = new AppState();
    state.set('taskStack', [dependent]);
    const panel = new RightPanel(
      state,
      harness.app,
      testStatusRegistry(),
      DEFAULT_SETTINGS,
      undefined,
      harness.tasks,
      undefined,
      undefined,
      undefined,
      noInteractionOwnership,
      harness.policy,
      () => ({ project: [candidate], other: [] }),
    );
    const container = freshContainer();
    activeDocument.body.append(container);
    activeDocument.querySelector('.abyss-task-command-live-region')?.remove();
    const process = vi.spyOn(harness.app.vault, 'process');
    panel.mount(container);
    container.querySelector<HTMLButtonElement>('[data-dependency-trigger]')!.click();
    const firstCandidate = container.querySelector<HTMLButtonElement>(
      '[data-dependency-candidate]',
    )!;

    expect(generateId).not.toHaveBeenCalled();
    firstCandidate.click();
    await flushMicrotasks(20);

    expect(generateId).toHaveBeenCalledOnce();
    expect(process).not.toHaveBeenCalled();
    expect(await harness.read()).toBe(source);
    expect(activeDocument.querySelectorAll('.abyss-task-command-live-region')).toHaveLength(0);

    firstCandidate.click();
    await flushMicrotasks(20);

    expect(generateId).toHaveBeenCalledTimes(2);
    expect(process).toHaveBeenCalledOnce();
    expect(await harness.read()).toContain('Candidate without ID 🆔 fresh');
    expect(await harness.read()).toContain('Dependent ⛔ fresh');
    panel.destroy();
    harness.index.destroy();
    container.remove();
  });

  it('surfaces a real prospective cycle in the dependency field and leaves the vault unchanged', async () => {
    const source = [
      '- [ ] Dependent 🆔 dependent',
      '',
      '- [ ] Candidate 🆔 candidate ⛔ dependent',
      '',
    ].join('\n');
    const harness = await realDependencyApplication(source);
    const dependent = harness.index.list().find(({ source: item }) => item.line === 0)!;
    const candidate = harness.index.list().find(({ source: item }) => item.line === 2)!;
    const state = new AppState();
    state.set('taskStack', [dependent]);
    const panel = new RightPanel(
      state,
      harness.app,
      testStatusRegistry(),
      DEFAULT_SETTINGS,
      undefined,
      harness.tasks,
      undefined,
      undefined,
      undefined,
      noInteractionOwnership,
      harness.policy,
      () => ({ project: [candidate], other: [] }),
    );
    const container = freshContainer();
    activeDocument.body.append(container);
    activeDocument.querySelector('.abyss-task-command-live-region')?.remove();
    const process = vi.spyOn(harness.app.vault, 'process');
    panel.mount(container);
    container.querySelector<HTMLButtonElement>('[data-dependency-trigger]')!.click();

    const candidateButton = container.querySelector<HTMLButtonElement>(
      '[data-dependency-candidate]',
    )!;
    expect(candidateButton.getAttribute('aria-disabled')).toBe('true');
    expect(candidateButton.textContent).toContain('Would create a cycle');
    candidateButton.click();
    await flushMicrotasks(20);

    expect(process).not.toHaveBeenCalled();
    expect(await harness.read()).toBe(source);
    expect(activeDocument.querySelectorAll('.abyss-task-command-live-region')).toHaveLength(0);
    expect(container.querySelector('[data-dependency-editor]')).not.toBeNull();
    panel.destroy();
    harness.index.destroy();
    container.remove();
  });

  it('repairs a real missing dependency by assigning the exact carrier ID', async () => {
    const generateId = vi.fn(() => 'generated-id');
    const source = ['- [ ] Dependent ⛔ wanted', '', '- [ ] Candidate without ID', ''].join('\n');
    const harness = await realDependencyApplication(source, generateId);
    const dependent = harness.index.list().find(({ source: item }) => item.line === 0)!;
    const candidate = harness.index.list().find(({ source: item }) => item.line === 2)!;
    const state = new AppState();
    state.set('taskStack', [dependent]);
    const panel = new RightPanel(
      state,
      harness.app,
      testStatusRegistry(),
      DEFAULT_SETTINGS,
      undefined,
      harness.tasks,
      undefined,
      undefined,
      undefined,
      noInteractionOwnership,
      harness.policy,
      () => ({ project: [candidate], other: [] }),
    );
    const container = freshContainer();
    activeDocument.body.append(container);
    panel.mount(container);
    container.querySelector<HTMLButtonElement>('[data-dependency-trigger]')!.click();
    container.querySelector<HTMLButtonElement>('[data-dependency-repair="wanted"]')!.click();

    container.querySelector<HTMLButtonElement>('[data-dependency-candidate]')!.click();
    await flushMicrotasks(30);

    expect(generateId).not.toHaveBeenCalled();
    expect(await harness.read()).toContain('- [ ] Candidate without ID 🆔 wanted');
    expect(await harness.read()).toContain('- [ ] Dependent ⛔ wanted');
    expect(container.querySelector('[data-dependency-editor]')).not.toBeNull();
    panel.destroy();
    harness.index.destroy();
    container.remove();
  });

  it('activates an ID-less safe prerequisite with one picker-stable generated ID', async () => {
    const generateId = vi.fn(() => 'generated-id');
    const source = ['- [ ] Dependent', '', '- [ ] Candidate without ID', ''].join('\n');
    const harness = await realDependencyApplication(source, generateId);
    const dependent = harness.index.list().find(({ source: item }) => item.line === 0)!;
    const candidate = harness.index.list().find(({ source: item }) => item.line === 2)!;
    const state = new AppState();
    state.set('taskStack', [dependent]);
    const panel = new RightPanel(
      state,
      harness.app,
      testStatusRegistry(),
      DEFAULT_SETTINGS,
      undefined,
      harness.tasks,
      undefined,
      undefined,
      undefined,
      noInteractionOwnership,
      harness.policy,
      () => ({ project: [candidate], other: [] }),
    );
    const container = freshContainer();
    activeDocument.body.append(container);
    panel.mount(container);

    container.querySelector<HTMLButtonElement>('[data-dependency-trigger]')!.click();
    const button = container.querySelector<HTMLButtonElement>('[data-dependency-candidate]')!;
    expect(button.getAttribute('aria-disabled')).toBeNull();
    button.click();
    await flushMicrotasks(30);

    expect(generateId).toHaveBeenCalledOnce();
    expect(await harness.read()).toContain('- [ ] Candidate without ID 🆔 generated-id');
    expect(await harness.read()).toContain('- [ ] Dependent ⛔ generated-id');
    panel.destroy();
    harness.index.destroy();
    container.remove();
  });

  it.each([
    ['direct', ['- [ ] Dependent 🆔 dependent', '', '- [ ] Candidate without ID ⛔ dependent', '']],
    [
      'transitive',
      [
        '- [ ] Dependent 🆔 dependent',
        '',
        '- [ ] Candidate without ID ⛔ middle',
        '',
        '- [ ] Middle 🆔 middle ⛔ dependent',
        '',
      ],
    ],
  ] as const)('keeps an ID-less %s cycle unavailable in the live picker', async (_kind, lines) => {
    const processSource = lines.join('\n');
    const harness = await realDependencyApplication(processSource, () => 'generated-id');
    const dependent = harness.index.list().find(({ source: item }) => item.line === 0)!;
    const candidate = harness.index.list().find(({ source: item }) => item.line === 2)!;
    const state = new AppState();
    state.set('taskStack', [dependent]);
    const panel = new RightPanel(
      state,
      harness.app,
      testStatusRegistry(),
      DEFAULT_SETTINGS,
      undefined,
      harness.tasks,
      undefined,
      undefined,
      undefined,
      noInteractionOwnership,
      harness.policy,
      () => ({ project: [candidate], other: [] }),
    );
    const container = freshContainer();
    activeDocument.body.append(container);
    const process = vi.spyOn(harness.app.vault, 'process');
    panel.mount(container);

    container.querySelector<HTMLButtonElement>('[data-dependency-trigger]')!.click();
    const button = container.querySelector<HTMLButtonElement>('[data-dependency-candidate]')!;
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(button.textContent).toContain('Would create a cycle');
    button.click();
    await flushMicrotasks();

    expect(process).not.toHaveBeenCalled();
    panel.destroy();
    harness.index.destroy();
    container.remove();
  });

  it.each(['click', 'Enter', ' '] as const)(
    'keeps a duplicate-ID candidate focusable and non-dispatchable on %s',
    async (activation) => {
      const dependent = snapshot('dependent');
      const candidate = {
        ...snapshot('candidate'),
        ref: { filePath: 'candidate.md', line: 0, revision: 'candidate' },
        title: 'Duplicate candidate',
        markdownTitle: 'Duplicate candidate',
        dependency: { id: 'duplicate', dependsOn: [] },
        source: {
          filePath: 'candidate.md',
          line: 0,
          originalMarkdown: '- [ ] Duplicate candidate 🆔 duplicate',
          originalBlock: '- [ ] Duplicate candidate 🆔 duplicate',
        },
      } satisfies TaskSnapshot;
      const setDependency = vi.fn();
      const tasks: TaskApplicationApi = {
        queries: taskQueryApi({ list: () => [dependent, candidate] }),
        execute: vi.fn(),
        setDependency,
      };
      const projection: DependencyProjectionPort = {
        evaluateCompletion: (task) =>
          task === candidate
            ? {
                type: 'invalid',
                diagnostics: [
                  { type: 'duplicate-id', id: 'duplicate', candidates: [candidate.ref] },
                ],
              }
            : { type: 'allowed' },
        inspect: () => ({ decision: { type: 'allowed' }, relations: [] }),
        subscribe: () => () => undefined,
      };
      const app = await createAppWithFiles({
        'tasks.md': '- [ ] root\n',
        'candidate.md': '- [ ] Duplicate candidate 🆔 duplicate\n',
      });
      const state = new AppState();
      state.set('taskStack', [dependent]);
      const panel = new RightPanel(
        state,
        app,
        testStatusRegistry(),
        DEFAULT_SETTINGS,
        undefined,
        tasks,
        undefined,
        undefined,
        undefined,
        noInteractionOwnership,
        projection,
        () => ({ project: [candidate], other: [] }),
      );
      const container = freshContainer();
      panel.mount(container);
      container.querySelector<HTMLButtonElement>('[data-dependency-trigger]')!.click();
      const button = container.querySelector<HTMLButtonElement>('[data-dependency-candidate]')!;

      expect(button.disabled).toBe(false);
      expect(button.getAttribute('aria-disabled')).toBe('true');
      expect(button.textContent).toContain('Duplicate ID');
      expect(button.getAttribute('aria-label')).toContain('Duplicate ID');
      button.dispatchEvent(
        activation === 'click'
          ? new MouseEvent('click', { bubbles: true, cancelable: true })
          : new KeyboardEvent('keydown', {
              key: activation,
              bubbles: true,
              cancelable: true,
            }),
      );
      await flushMicrotasks();

      expect(setDependency).not.toHaveBeenCalled();
      panel.destroy();
    },
  );

  it('routes the RightPanel Done status-menu item through the shared blocked command path', async () => {
    const selected = snapshot('selected');
    const execute = vi.fn<TaskApplicationApi['execute']>().mockResolvedValue({
      type: 'blocked',
      operation: 'completion',
      dependency: { type: 'blocked', prerequisites: [] },
    });
    const projection: DependencyProjectionPort = {
      evaluateCompletion: () => ({ type: 'blocked', prerequisites: [] }),
      inspect: () => ({ decision: { type: 'blocked', prerequisites: [] }, relations: [] }),
      subscribe: () => () => undefined,
    };
    const { app, state } = await panelWith(selected, execute);
    const registry = testStatusRegistry();
    const panel = new RightPanel(
      state,
      app,
      registry,
      DEFAULT_SETTINGS,
      undefined,
      api(execute),
      undefined,
      undefined,
      undefined,
      noInteractionOwnership,
      projection,
    );
    const container = freshContainer();
    activeDocument.body.append(container);
    panel.mount(container);
    try {
      const marker = container.querySelector<HTMLElement>('.abyss-status-marker')!;
      expect(marker.getAttribute('aria-disabled')).toBe('true');
      marker.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
      const done = DEFAULT_SETTINGS.taskStatuses.find(({ type }) => type === 'done')!;
      const doneItem = Array.from(
        activeDocument.querySelectorAll<HTMLElement>(
          '.abyss-status-popover [role="menuitemradio"]',
        ),
      ).find((item) => item.textContent?.includes(done.name));
      expect(doneItem).toBeDefined();
      doneItem!.click();
      await flushMicrotasks();

      expect(execute).toHaveBeenCalledWith({
        type: 'set-status',
        target: { type: 'task', ref: selected.ref },
        symbol: done.symbol,
      });
    } finally {
      panel.destroy();
      container.remove();
    }
  });

  it('renders resolved, missing, and duplicate direct relations from inspection without guessing', async () => {
    const ready = {
      ...snapshot('ready'),
      ref: { filePath: 'Ready.md', line: 0, revision: 'ready' },
      title: 'Ready prerequisite',
      markdownTitle: 'Ready prerequisite',
      status: 'done',
      statusSymbol: 'x',
    } satisfies TaskSnapshot;
    const open = {
      ...snapshot('open'),
      ref: { filePath: 'Open.md', line: 0, revision: 'open' },
      title: 'Open prerequisite',
      markdownTitle: 'Open prerequisite',
    } satisfies TaskSnapshot;
    const selected = {
      ...snapshot('selected'),
      dependency: { dependsOn: ['ready', 'open', 'missing', 'duplicate'] },
    } satisfies TaskSnapshot;
    const firstDuplicate: TaskRef = { filePath: 'A.md', line: 1, revision: 'a' };
    const secondDuplicate: TaskRef = { filePath: 'B.md', line: 2, revision: 'b' };
    const projection: DependencyProjectionPort = {
      evaluateCompletion: () => ({
        type: 'invalid',
        diagnostics: [
          { type: 'missing-prerequisite', id: 'missing' },
          {
            type: 'duplicate-id',
            id: 'duplicate',
            candidates: [firstDuplicate, secondDuplicate],
          },
          { type: 'self-edge', id: 'self' },
          { type: 'cycle', ids: ['a', 'b'] },
        ],
      }),
      inspect: () => ({
        decision: {
          type: 'invalid',
          diagnostics: [
            { type: 'missing-prerequisite', id: 'missing' },
            {
              type: 'duplicate-id',
              id: 'duplicate',
              candidates: [firstDuplicate, secondDuplicate],
            },
            { type: 'self-edge', id: 'self' },
            { type: 'cycle', ids: ['a', 'b'] },
          ],
        },
        relations: [
          {
            id: 'ready',
            resolution: {
              type: 'resolved',
              prerequisite: ready.ref,
              complete: true,
            },
          },
          {
            id: 'open',
            resolution: {
              type: 'resolved',
              prerequisite: open.ref,
              complete: false,
            },
          },
          { id: 'missing', resolution: { type: 'missing' } },
          {
            id: 'duplicate',
            resolution: { type: 'duplicate', candidates: [firstDuplicate, secondDuplicate] },
          },
        ],
      }),
      subscribe: () => () => undefined,
    };
    const clearDependency = vi.fn().mockResolvedValue({
      type: 'ok',
      changed: false,
      outcome: { type: 'task', task: selected },
    });
    const tasks: TaskApplicationApi = {
      queries: taskQueryApi({ list: () => [selected, ready, open] }),
      execute: vi.fn(),
      setDependency: vi.fn(),
      clearDependency,
    };
    const app = await createAppWithFiles({ 'tasks.md': '- [ ] root\n' });
    const state = new AppState();
    state.set('taskStack', [selected]);
    const panel = new RightPanel(
      state,
      app,
      testStatusRegistry(),
      DEFAULT_SETTINGS,
      undefined,
      tasks,
      undefined,
      undefined,
      undefined,
      noInteractionOwnership,
      projection,
      () => ({ project: [], other: [] }),
    );
    const container = freshContainer();
    panel.mount(container);
    container.querySelector<HTMLButtonElement>('[aria-label="Edit blocked by"]')!.click();

    const relations = Array.from(
      container.querySelectorAll<HTMLElement>('[data-dependency-relation]'),
    );
    expect(relations.map((row) => row.dataset['dependencyResolution'])).toEqual([
      'resolved',
      'resolved',
      'missing',
      'duplicate',
    ]);
    expect(relations[0]?.querySelector('.abyss-status-marker')?.getAttribute('aria-label')).toBe(
      'Prerequisite complete',
    );
    expect(relations[1]?.querySelector('.abyss-status-marker')?.getAttribute('aria-label')).toBe(
      'Prerequisite open',
    );
    expect(relations[0]?.querySelector('.abyss-status-marker--inert')).not.toBeNull();
    expect(relations[1]?.querySelector('.abyss-status-marker--inert')).not.toBeNull();
    expect(relations[2]?.textContent).toContain('Missing');
    expect(relations[3]?.textContent).toContain('2 matches');
    expect(
      container.querySelector('[data-dependency-diagnostic="self-edge"]')?.textContent,
    ).toContain('depends on itself');
    expect(container.querySelector('[data-dependency-diagnostic="cycle"]')?.textContent).toContain(
      'cycle',
    );
    expect(container.querySelectorAll('[data-dependency-candidate]')).toHaveLength(0);
    expect(tasks.setDependency).not.toHaveBeenCalled();

    container.querySelector<HTMLButtonElement>('[data-dependency-clear="missing"]')!.click();
    await flushMicrotasks();
    expect(clearDependency).toHaveBeenCalledWith({
      dependent: selected.ref,
      dependencyId: 'missing',
    });
    panel.destroy();
  });

  it('keeps unresolved dependency inspection read-only and explains how to recover', async () => {
    const selected = snapshot('selected');
    const candidate = {
      ...snapshot('candidate'),
      ref: { filePath: 'candidate.md', line: 0, revision: 'candidate' },
      source: {
        filePath: 'candidate.md',
        line: 0,
        originalMarkdown: '- [ ] candidate',
        originalBlock: '- [ ] candidate',
      },
    } satisfies TaskSnapshot;
    const setDependency = vi.fn();
    const tasks: TaskApplicationApi = {
      queries: taskQueryApi({ list: () => [selected, candidate] }),
      execute: vi.fn(),
      setDependency,
      clearDependency: vi.fn(),
    };
    const projection: DependencyProjectionPort = {
      evaluateCompletion: () => ({
        type: 'invalid',
        diagnostics: [{ type: 'unresolved-projection' }],
      }),
      inspect: () => ({
        decision: { type: 'invalid', diagnostics: [{ type: 'unresolved-projection' }] },
        relations: [],
      }),
      subscribe: () => () => undefined,
    };
    const app = await createAppWithFiles({ 'tasks.md': '- [ ] selected\n- [ ] candidate\n' });
    const state = new AppState();
    state.set('taskStack', [selected]);
    const panel = new RightPanel(
      state,
      app,
      testStatusRegistry(),
      DEFAULT_SETTINGS,
      undefined,
      tasks,
      undefined,
      undefined,
      undefined,
      noInteractionOwnership,
      projection,
      () => ({ project: [candidate], other: [] }),
    );
    const container = freshContainer();
    panel.mount(container);
    container.querySelector<HTMLButtonElement>('[data-dependency-trigger]')!.click();

    expect(
      container.querySelector('[data-dependency-diagnostic="unresolved-projection"]')?.textContent,
    ).toContain('Reopen and inspect');
    const candidateButton = container.querySelector<HTMLButtonElement>(
      '[data-dependency-candidate]',
    )!;
    expect(candidateButton.disabled).toBe(false);
    expect(candidateButton.getAttribute('aria-disabled')).toBe('true');
    expect(candidateButton.textContent).toContain('Resolve dependency issue');
    candidateButton.click();
    await flushMicrotasks();
    expect(setDependency).not.toHaveBeenCalled();
    panel.destroy();
  });
  it('preserves the full DOM draft bundle when an add-comment command is a no-op', async () => {
    const initial = snapshot('old');
    const execute = vi.fn<TaskApplicationApi['execute']>().mockResolvedValue({
      type: 'ok',
      changed: false,
      outcome: { type: 'task', task: initial },
    });
    const { panel } = await panelWith(initial, execute);
    const container = freshContainer();
    activeDocument.body.append(container);
    panel.mount(container);
    try {
      container.querySelector<HTMLElement>('.abyss-right-title-view')!.click();
      await flushMicrotasks();
      const title = container.querySelector<HTMLTextAreaElement>('.abyss-right-title-edit')!;
      title.value = 'unsaved title';
      title.focus();
      title.setSelectionRange(2, 7);
      const comment = container.querySelector<HTMLTextAreaElement>('.abyss-comment-input')!;
      comment.value = 'already present';
      comment.setSelectionRange(3, 10);

      comment.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
      );
      await flushMicrotasks(20);

      const restoredTitle =
        container.querySelector<HTMLTextAreaElement>('.abyss-right-title-edit')!;
      const restoredComment = container.querySelector<HTMLTextAreaElement>('.abyss-comment-input')!;
      expect(restoredTitle.value).toBe('unsaved title');
      expect(restoredTitle.selectionStart).toBe(2);
      expect(restoredTitle.selectionEnd).toBe(7);
      expect(restoredComment.value).toBe('already present');
      expect(restoredComment.selectionStart).toBe(3);
      expect(restoredComment.selectionEnd).toBe(10);
      expect(activeDocument.activeElement).toBe(restoredTitle);
      expect(execute).toHaveBeenCalledOnce();
    } finally {
      panel.destroy();
    }
  });

  it('preserves simultaneous dirty title and new-comment drafts across refresh', async () => {
    const initial = snapshot('old');
    const execute = vi.fn<TaskApplicationApi['execute']>().mockResolvedValue({
      type: 'invalid',
      issues: [{ code: 'invalid-target' }],
    });
    const { panel, state } = await panelWith(initial, execute);
    const container = freshContainer();
    activeDocument.body.append(container);
    panel.mount(container);
    container.querySelector<HTMLElement>('.abyss-right-title-view')!.click();
    await flushMicrotasks();
    const title = container.querySelector<HTMLTextAreaElement>('.abyss-right-title-edit')!;
    const comment = container.querySelector<HTMLTextAreaElement>('.abyss-comment-input')!;
    comment.focus();
    title.value = 'local title draft';
    comment.value = 'local comment draft';

    const drafts = panel.captureDraftState();
    title.remove();
    const current = {
      ...snapshot('current'),
      title: 'external title',
      markdownTitle: 'external title',
    };
    state.set('taskStack', [current]);
    panel.restoreDraftState(drafts, current);

    expect(container.querySelector<HTMLTextAreaElement>('.abyss-right-title-edit')?.value).toBe(
      'local title draft',
    );
    expect(container.querySelector<HTMLTextAreaElement>('.abyss-comment-input')?.value).toBe(
      'local comment draft',
    );
    expect(execute).not.toHaveBeenCalled();
    panel.destroy();
  });

  it('captures every dirty editor plus the focused clean editor in one bundle', async () => {
    const initial = snapshot('old');
    const execute = vi.fn<TaskApplicationApi['execute']>().mockResolvedValue({
      type: 'invalid',
      issues: [{ code: 'invalid-target' }],
    });
    const { panel, state } = await panelWith(initial, execute);
    const container = freshContainer();
    activeDocument.body.append(container);
    panel.mount(container);
    container.querySelector<HTMLElement>('.abyss-right-title-view')!.click();
    await flushMicrotasks();
    const title = container.querySelector<HTMLTextAreaElement>('.abyss-right-title-edit')!;
    const comment = container.querySelector<HTMLTextAreaElement>('.abyss-comment-input')!;
    title.value = 'dirty title';
    comment.focus();

    const bundle = panel.captureDraftState();
    title.remove();

    expect(bundle?.entries).toHaveLength(2);
    expect(
      bundle?.entries.map((entry) => [
        entry.kind,
        'dirty' in entry ? entry.dirty : entry.editor.dirty,
      ]),
    ).toEqual([
      ['title', true],
      ['new-comment', false],
    ]);
    const current = { ...snapshot('current'), title: 'external', markdownTitle: 'external' };
    state.set('taskStack', [current]);
    panel.restoreDraftState(bundle, current);
    expect(container.querySelector<HTMLTextAreaElement>('.abyss-right-title-edit')?.value).toBe(
      'dirty title',
    );
    expect(activeDocument.activeElement).toBe(
      container.querySelector<HTMLTextAreaElement>('.abyss-comment-input'),
    );
    panel.destroy();
  });

  it('preserves simultaneous dirty recurrence and new-comment drafts across refresh', async () => {
    const initial = snapshot('old');
    const execute = vi.fn<TaskApplicationApi['execute']>();
    const { panel, state } = await panelWith(initial, execute);
    const container = freshContainer();
    activeDocument.body.append(container);
    panel.mount(container);
    const comment = container.querySelector<HTMLTextAreaElement>('.abyss-comment-input')!;
    comment.value = 'local comment draft';
    container.querySelector<HTMLElement>('.abyss-repeat-chip')!.click();
    const interval = container.querySelector<HTMLInputElement>('.abyss-recurrence-interval')!;
    interval.value = '7';
    interval.dispatchEvent(new Event('input', { bubbles: true }));
    interval.focus();

    const drafts = panel.captureDraftState();
    const current = snapshot('current');
    state.set('taskStack', [current]);
    panel.restoreDraftState(drafts, current);

    expect(container.querySelector<HTMLInputElement>('.abyss-recurrence-interval')?.value).toBe(
      '7',
    );
    expect(container.querySelector<HTMLTextAreaElement>('.abyss-comment-input')?.value).toBe(
      'local comment draft',
    );
    expect(execute).not.toHaveBeenCalled();
    panel.destroy();
  });

  it.each([
    {
      kind: 'title',
      open: '.abyss-right-title-view',
      edit: '.abyss-right-title-edit',
    },
    {
      kind: 'description',
      open: '.abyss-right-desc-view',
      edit: '.abyss-right-desc-edit',
    },
    {
      kind: 'existing-comment',
      open: '.abyss-comment-text',
      edit: '.abyss-comment-edit-input',
    },
    {
      kind: 'new-subtask',
      open: '.abyss-subtask-add-row',
      edit: '.abyss-subtask-new-input',
    },
  ] as const)(
    'retains dirty $kind text, focus, and selection across a proven refresh',
    async (entry) => {
      const initial = snapshot('old');
      const execute = vi.fn<TaskApplicationApi['execute']>();
      const { panel, state } = await panelWith(initial, execute);
      const container = freshContainer();
      activeDocument.body.append(container);
      panel.mount(container);
      container.querySelector<HTMLElement>(entry.open)!.click();
      await flushMicrotasks();
      const edit = container.querySelector<HTMLInputElement | HTMLTextAreaElement>(entry.edit)!;
      edit.value = 'local unsaved';
      edit.focus();
      edit.setSelectionRange(3, 8);

      const draft = panel.captureDraftState();
      const current = {
        ...snapshot('current'),
        title: 'external title',
        markdownTitle: 'external title',
      };
      state.set('taskStack', [current]);
      panel.restoreDraftState(draft, current);

      const restored = container.querySelector<HTMLInputElement | HTMLTextAreaElement>(entry.edit)!;
      expect(restored).not.toBeNull();
      expect(restored.value).toBe('local unsaved');
      expect(restored.selectionStart).toBe(3);
      expect(restored.selectionEnd).toBe(8);
      expect(activeDocument.activeElement).toBe(restored);
      expect(execute).not.toHaveBeenCalled();
      panel.destroy();
    },
  );

  it('retains a dirty new-comment draft across a proven refresh', async () => {
    const initial = snapshot('old');
    const execute = vi.fn<TaskApplicationApi['execute']>();
    const { panel, state } = await panelWith(initial, execute);
    const container = freshContainer();
    activeDocument.body.append(container);
    panel.mount(container);
    const edit = container.querySelector<HTMLTextAreaElement>('.abyss-comment-input')!;
    edit.value = 'local unsaved';
    edit.focus();
    edit.setSelectionRange(3, 8);

    const draft = panel.captureDraftState();
    const current = snapshot('current');
    state.set('taskStack', [current]);
    panel.restoreDraftState(draft, current);

    const restored = container.querySelector<HTMLTextAreaElement>('.abyss-comment-input')!;
    expect(restored.value).toBe('local unsaved');
    expect(restored.selectionStart).toBe(3);
    expect(restored.selectionEnd).toBe(8);
    expect(activeDocument.activeElement).toBe(restored);
    expect(execute).not.toHaveBeenCalled();
    panel.destroy();
  });

  it('detaches a dirty draft when its target disappears', async () => {
    const initial = snapshot('old');
    const execute = vi.fn<TaskApplicationApi['execute']>();
    const { panel, state } = await panelWith(initial, execute);
    const container = freshContainer();
    activeDocument.body.append(container);
    panel.mount(container);
    container.querySelector<HTMLElement>('.abyss-comment-text')!.click();
    const edit = container.querySelector<HTMLTextAreaElement>('.abyss-comment-edit-input')!;
    edit.value = 'local unsaved';
    edit.focus();

    const draft = panel.captureDraftState();
    const current = { ...snapshot('current'), comments: [] };
    state.set('taskStack', [current]);
    panel.restoreDraftState(draft, current);

    const detached = container.querySelector<HTMLElement>('.abyss-detached-draft')!;
    const copy = container.querySelector<HTMLButtonElement>('.abyss-detached-draft-copy')!;
    expect(detached.textContent).toContain('local unsaved');
    expect(detached.getAttribute('aria-label')).toContain('root');
    expect(detached.getAttribute('aria-label')).toContain('existing comment');
    expect(detached.getAttribute('role')).toBe('group');
    expect(copy).not.toBeNull();
    expect(copy.getAttribute('aria-label')).toContain('root');
    expect(copy.getAttribute('aria-label')).toContain('existing comment');
    expect(
      container
        .querySelector<HTMLButtonElement>('.abyss-detached-draft-discard')
        ?.getAttribute('aria-label'),
    ).toContain('root');
    expect(container.querySelector('.abyss-detached-draft-discard')).not.toBeNull();
    expect(container.querySelector('[role="status"][aria-live="polite"]')?.textContent).toContain(
      'Draft preserved',
    );
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    expect(activeDocument.activeElement).toBe(copy);
    expect(execute).not.toHaveBeenCalled();
    panel.destroy();
  });

  it('upserts the newest value when the same draft detaches again', async () => {
    const initial = snapshot('old');
    const { panel, state } = await panelWith(initial, vi.fn<TaskApplicationApi['execute']>());
    const container = freshContainer();
    activeDocument.body.append(container);
    panel.mount(container);
    const input = container.querySelector<HTMLTextAreaElement>('.abyss-comment-input')!;
    input.value = 'first value';
    const first = panel.captureDraftState()!;
    panel.detachDraftState(first);
    input.value = 'newest value';
    const newest = panel.captureDraftState()!;
    panel.detachDraftState(newest);

    const detached = container.querySelectorAll<HTMLElement>('.abyss-detached-draft');
    expect(detached).toHaveLength(1);
    expect(detached[0]?.textContent).toContain('newest value');
    expect(detached[0]?.textContent).not.toContain('first value');
    state.set('taskStack', []);
    expect(container.querySelector('.abyss-detached-draft')?.textContent).toContain('newest value');
    panel.destroy();
  });

  it('keeps a detached draft visible across subsequent panel renders', async () => {
    const initial = snapshot('old');
    const execute = vi.fn<TaskApplicationApi['execute']>();
    const { panel, state } = await panelWith(initial, execute);
    const container = freshContainer();
    activeDocument.body.append(container);
    panel.mount(container);
    container.querySelector<HTMLElement>('.abyss-comment-text')!.click();
    const edit = container.querySelector<HTMLTextAreaElement>('.abyss-comment-edit-input')!;
    edit.value = 'persistent detached draft';

    const draft = panel.captureDraftState();
    const current = { ...snapshot('current'), comments: [] };
    state.set('taskStack', [current]);
    panel.restoreDraftState(draft, current);
    expect(container.querySelector('.abyss-detached-draft')?.textContent).toContain(
      'persistent detached draft',
    );

    state.set('taskStack', [{ ...current, presentation: { linkCount: 1 } }]);

    expect(container.querySelector('.abyss-detached-draft')?.textContent).toContain(
      'persistent detached draft',
    );
    expect(execute).not.toHaveBeenCalled();
    panel.destroy();
  });

  it('keeps an append-once tray whose copy is non-destructive and discard removes one entry', async () => {
    const initial = snapshot('old');
    const execute = vi.fn<TaskApplicationApi['execute']>();
    const { panel, state } = await panelWith(initial, execute);
    const container = freshContainer();
    activeDocument.body.append(container);
    panel.mount(container);
    container.querySelector<HTMLElement>('.abyss-comment-text')!.click();
    const existing = container.querySelector<HTMLTextAreaElement>('.abyss-comment-edit-input')!;
    existing.value = 'existing comment draft';
    const existingBundle = panel.captureDraftState();
    const withoutComment = { ...snapshot('current'), comments: [] };
    state.set('taskStack', [withoutComment]);
    panel.restoreDraftState(existingBundle, withoutComment);
    panel.detachDraftState(existingBundle);

    const newComment = container.querySelector<HTMLTextAreaElement>('.abyss-comment-input')!;
    newComment.value = 'new comment draft';
    const newBundle = panel.captureDraftState();
    panel.detachDraftState(newBundle);

    expect(container.querySelectorAll('.abyss-detached-drafts-title')).toHaveLength(1);
    expect(container.querySelectorAll('.abyss-detached-draft')).toHaveLength(2);
    const entries = [...container.querySelectorAll<HTMLElement>('.abyss-detached-draft')];
    expect(entries[0]?.textContent).toContain('existing comment draft');
    expect(entries[1]?.textContent).toContain('new comment draft');

    Object.defineProperty(container.ownerDocument.defaultView!.navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockRejectedValue(new Error('denied')) },
    });
    const copy = entries[1]!.querySelector<HTMLButtonElement>('.abyss-detached-draft-copy')!;
    copy.click();
    await flushMicrotasks();
    expect(container.querySelectorAll('.abyss-detached-draft')).toHaveLength(2);
    expect(entries[1]?.querySelector('[aria-live="polite"]')?.textContent).toContain(
      'Could not copy',
    );
    expect(activeDocument.activeElement).toBe(copy);

    entries[0]!.querySelector<HTMLButtonElement>('.abyss-detached-draft-discard')!.click();
    const remaining = [...container.querySelectorAll<HTMLElement>('.abyss-detached-draft')];
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.textContent).toContain('new comment draft');
    panel.destroy();
  });

  it('detaches instead of attaching a comment draft to a duplicate at the stale line', async () => {
    const initial = snapshot('old');
    const execute = vi.fn<TaskApplicationApi['execute']>();
    const { panel, state } = await panelWith(initial, execute);
    const container = freshContainer();
    activeDocument.body.append(container);
    panel.mount(container);
    container.querySelector<HTMLElement>('.abyss-comment-text')!.click();
    const edit = container.querySelector<HTMLTextAreaElement>('.abyss-comment-edit-input')!;
    edit.value = 'local duplicate-sensitive draft';

    const draft = panel.captureDraftState();
    const original = initial.comments[0]!;
    const current = {
      ...snapshot('current'),
      comments: [original, { ...original, ref: { ...original.ref, relativeLine: 4 } }],
    };
    state.set('taskStack', [current]);
    panel.restoreDraftState(draft, current);

    expect(container.querySelector('.abyss-detached-draft')?.textContent).toContain(
      'local duplicate-sensitive draft',
    );
    expect(execute).not.toHaveBeenCalled();
    panel.destroy();
  });

  it('retains a structured recurrence draft focus after deferred popover autofocus', async () => {
    const initial = { ...snapshot('old'), recurrence: 'every day' };
    const execute = vi.fn<TaskApplicationApi['execute']>();
    const { panel, state } = await panelWith(initial, execute);
    const container = freshContainer();
    activeDocument.body.append(container);
    panel.mount(container);
    try {
      container.querySelector<HTMLElement>('.abyss-repeat-chip')!.click();
      container.querySelector<HTMLButtonElement>('[data-recurrence-preset="daily"]')!.click();
      const interval = container.querySelector<HTMLInputElement>('.abyss-recurrence-interval')!;
      interval.value = '12345';
      interval.dispatchEvent(new Event('input', { bubbles: true }));
      interval.focus();
      interval.setSelectionRange(2, 5);

      const draft = panel.captureDraftState();
      const current = { ...snapshot('current'), recurrence: 'every day' };
      state.set('taskStack', [current]);
      panel.restoreDraftState(draft, current);
      await new Promise<void>((resolve) => {
        activeDocument.defaultView?.setTimeout(resolve, 0);
      });

      const restored = container.querySelector<HTMLInputElement>('.abyss-recurrence-interval')!;
      expect(restored.value).toBe('12345');
      expect(restored.selectionStart).toBe(2);
      expect(restored.selectionEnd).toBe(5);
      expect(activeDocument.activeElement).toBe(restored);
      expect(execute).not.toHaveBeenCalled();
    } finally {
      panel.destroy();
    }
  });

  it('deletes a root through the API and preserves newer navigation on a late result', async () => {
    const initial = snapshot('old');
    let resolve!: (result: TaskCommandResult) => void;
    const execute = vi
      .fn<TaskApplicationApi['execute']>()
      .mockImplementation(() => new Promise<TaskCommandResult>((done) => (resolve = done)));
    const { panel, state, app } = await panelWith(initial, execute);
    const root = state.get('taskStack')[0]!;
    const process = vi.spyOn(app.vault, 'process');

    const pending = call<Promise<void>>(panel, 'deleteTask', root);
    expect(execute).toHaveBeenCalledWith({ type: 'delete', ref: initial.ref });
    const newer = snapshot('newer');
    state.set('taskStack', [newer]);
    resolve({
      type: 'ok',
      changed: true,
      outcome: { type: 'deleted', ref: initial.ref },
    });
    await pending;

    expect(state.get('taskStack')).toEqual([newer]);
    expect(process).not.toHaveBeenCalled();
  });

  it('delegates all description/comment intents with their exact revisioned targets', async () => {
    const initial = snapshot('old');
    const fresh = snapshot('fresh', 'new description');
    const execute = vi.fn<TaskApplicationApi['execute']>().mockResolvedValue({
      type: 'ok',
      changed: true,
      outcome: { type: 'task', task: fresh },
    });
    const { panel, state } = await panelWith(initial, execute);
    const root = state.get('taskStack')[0]!;
    const comment = root.comments![0]!;

    await call<Promise<boolean>>(panel, 'updateDescription', root, 'new description');
    expect(execute).toHaveBeenLastCalledWith({
      type: 'set-description',
      target: { type: 'task', ref: initial.ref },
      text: 'new description',
    });
    expect(state.get('taskStack')[0]).toMatchObject({
      ref: fresh.ref,
      description: 'new description',
    });

    execute.mockClear();
    const current = state.get('taskStack')[0]!;
    const currentComment = current.comments![0]!;
    const input = freshContainer().createEl('textarea');
    input.value = 'draft';
    await call<Promise<boolean>>(panel, 'addComment', current, 'added', freshContainer(), input);
    expect(execute).toHaveBeenLastCalledWith({
      type: 'add-comment',
      parent: { type: 'task', ref: fresh.ref },
      text: 'added',
    });

    await call<Promise<boolean>>(panel, 'updateComment', current, currentComment, 'updated');
    expect(execute).toHaveBeenLastCalledWith({
      type: 'update-comment',
      comment: fresh.comments[0]!.ref as CommentRef,
      text: 'updated',
    });

    await call<Promise<boolean>>(panel, 'deleteComment', root, comment);
    expect(execute).toHaveBeenLastCalledWith({
      type: 'delete-comment',
      comment: initial.comments[0]!.ref as CommentRef,
    });
  });

  it('keeps add-comment input and DOM unchanged on a structured conflict', async () => {
    const initial = snapshot('old');
    const execute = vi.fn<TaskApplicationApi['execute']>().mockResolvedValue({
      type: 'conflict',
      current: snapshot('external'),
    });
    const { panel, state } = await panelWith(initial, execute);
    const input = freshContainer().createEl('textarea');
    const list = freshContainer();
    input.value = 'draft';

    await call<Promise<boolean>>(
      panel,
      'addComment',
      state.get('taskStack')[0]!,
      'draft',
      list,
      input,
    );

    expect(input.value).toBe('draft');
    expect(list.querySelectorAll('.abyss-comment-row')).toHaveLength(0);
    expect(state.get('taskStack')[0]).toMatchObject({ ref: initial.ref });
  });

  it.each([
    {
      label: 'conflict',
      result: { type: 'conflict', current: snapshot('external') } as TaskCommandResult,
    },
    {
      label: 'not-found',
      result: {
        type: 'not-found',
        target: { type: 'task', ref: snapshot('old').ref },
      } as TaskCommandResult,
    },
    {
      label: 'ambiguous',
      result: {
        type: 'ambiguous',
        candidates: [
          {
            root: snapshot('candidate'),
            target: { type: 'task', ref: snapshot('candidate').ref },
          },
        ],
      } as TaskCommandResult,
    },
    {
      label: 'invalid',
      result: {
        type: 'invalid',
        issues: [{ code: 'invalid-target', field: 'subtask' }],
      } as TaskCommandResult,
    },
    {
      label: 'io-error',
      result: {
        type: 'io-error',
        cause: 'process-error',
        contentState: 'unknown',
      } as TaskCommandResult,
    },
  ])('keeps the add-subtask editor and exact draft open on $label', async ({ result }) => {
    const initial = snapshot('old');
    const execute = vi.fn<TaskApplicationApi['execute']>().mockResolvedValue(result);
    const { panel } = await panelWith(initial, execute);
    const container = freshContainer();
    panel.mount(container);
    container.querySelector<HTMLElement>('.abyss-subtask-add-row')!.click();
    const input = container.querySelector<HTMLInputElement>('.abyss-subtask-new-input')!;
    input.value = 'keep this draft';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    await flushMicrotasks(20);

    expect(execute).toHaveBeenCalledWith({
      type: 'add-subtask',
      parent: { type: 'task', ref: initial.ref },
      text: 'keep this draft',
    });
    expect(container.querySelector('.abyss-subtask-new-input')).toBe(input);
    expect(input.value).toBe('keep this draft');
    expect(
      container.querySelector('.abyss-subtask-add-row')?.hasClass('abyss-subtask-add-row--hidden'),
    ).toBe(true);
    panel.destroy();
  });

  it('keeps the description textarea open when its save conflicts', async () => {
    const initial = snapshot('old');
    const execute = vi.fn<TaskApplicationApi['execute']>().mockResolvedValue({
      type: 'conflict',
      current: snapshot('external'),
    });
    const { panel } = await panelWith(initial, execute);
    const container = freshContainer();
    panel.mount(container);
    container.querySelector<HTMLElement>('.abyss-right-desc-view')!.click();
    const textarea = container.querySelector<HTMLTextAreaElement>('.abyss-right-desc-edit')!;
    textarea.value = 'attempted change';
    textarea.dispatchEvent(new FocusEvent('blur'));
    await flushMicrotasks(20);

    expect(execute).toHaveBeenCalledWith({
      type: 'set-description',
      target: { type: 'task', ref: initial.ref },
      text: 'attempted change',
    });
    expect(container.querySelector('.abyss-right-desc-edit')).toBe(textarea);
    panel.destroy();
  });

  it('keeps a comment textarea open when its exact comment ref conflicts', async () => {
    const initial = snapshot('old');
    const execute = vi.fn<TaskApplicationApi['execute']>().mockResolvedValue({
      type: 'conflict',
      current: snapshot('external'),
    });
    const { panel } = await panelWith(initial, execute);
    const container = freshContainer();
    panel.mount(container);
    vi.useFakeTimers();
    try {
      container.querySelector<HTMLElement>('.abyss-comment-text')!.click();
      const textarea = container.querySelector<HTMLTextAreaElement>('.abyss-comment-edit-input')!;
      textarea.value = 'attempted comment';
      textarea.dispatchEvent(new FocusEvent('blur'));
      await vi.advanceTimersByTimeAsync(151);

      expect(execute).toHaveBeenCalledWith({
        type: 'update-comment',
        comment: initial.comments[0]!.ref,
        text: 'attempted comment',
      });
      expect(container.querySelector('.abyss-comment-edit-input')).toBe(textarea);
    } finally {
      vi.useRealTimers();
      panel.destroy();
    }
  });

  it('does not restore a selection replaced while a structural result was in flight', async () => {
    const initial = snapshot('old');
    const other = { ...snapshot('other'), ref: { ...snapshot('other').ref, filePath: 'other.md' } };
    let resolve!: (result: TaskCommandResult) => void;
    const execute = vi.fn<TaskApplicationApi['execute']>().mockImplementation(
      () =>
        new Promise<TaskCommandResult>((done) => {
          resolve = done;
        }),
    );
    const acknowledge = vi.fn<(ref?: TaskRef) => void>();
    const { panel, state } = await panelWith(initial, execute, acknowledge);
    const pending = call<Promise<boolean>>(
      panel,
      'updateDescription',
      state.get('taskStack')[0]!,
      'new description',
    );
    state.set('taskStack', [other]);
    const fresh = snapshot('fresh', 'new description');
    resolve({ type: 'ok', changed: true, outcome: { type: 'task', task: fresh } });
    await pending;

    expect(state.get('taskStack')[0]).toMatchObject({ ref: other.ref });
    expect(acknowledge).toHaveBeenCalledWith(fresh.ref);
  });

  it('delegates add and sibling reorder through revisioned structural commands', async () => {
    const initial = snapshotWithChildren('old', ['first', 'second']);
    const afterAdd = snapshotWithChildren('after-add', ['first', 'second', 'new child']);
    const afterReorder = snapshotWithChildren('after-reorder', ['second', 'first', 'new child']);
    const execute = vi
      .fn<TaskApplicationApi['execute']>()
      .mockResolvedValueOnce({
        type: 'ok',
        changed: true,
        outcome: { type: 'task', task: afterAdd },
      })
      .mockResolvedValueOnce({
        type: 'ok',
        changed: true,
        outcome: { type: 'task', task: afterReorder },
      });
    const { panel, state } = await panelWith(initial, execute);
    const root = state.get('taskStack')[0]!;

    await call<Promise<void>>(panel, 'addSubTask', root, 'new child');
    expect(execute).toHaveBeenLastCalledWith({
      type: 'add-subtask',
      parent: { type: 'task', ref: initial.ref },
      text: 'new child',
    });

    const current = state.get('taskStack')[0]!;
    await call<Promise<void>>(
      panel,
      'reorderSubTask',
      current,
      current.subtasks![0]!,
      current.subtasks![1]!,
      'after',
    );
    expect(execute).toHaveBeenLastCalledWith({
      type: 'reorder-subtask',
      subtask: afterAdd.subtasks[0]!.ref,
      target: afterAdd.subtasks[1]!.ref,
      placement: 'after',
    });
    expect(state.get('taskStack')[0]!.subtasks.map((child) => child.title)).toEqual([
      'second',
      'first',
      'new child',
    ]);
  });

  it('deletes the selected nested task through the menu and converges selection to its parent', async () => {
    const initial = snapshotWithChildren('old', ['selected', 'sibling']);
    const afterDelete = snapshotWithChildren('fresh', ['sibling']);
    const execute = vi.fn<TaskApplicationApi['execute']>().mockResolvedValue({
      type: 'ok',
      changed: true,
      outcome: { type: 'task', task: afterDelete },
    });
    const { panel, state } = await panelWith(initial, execute);
    const root = initial;
    state.set('taskStack', [root, root.subtasks![0]!]);
    const container = freshContainer();
    panel.mount(container);

    container.querySelector<HTMLButtonElement>('[aria-label="More actions"]')!.click();
    const deleteItem = container.querySelector<HTMLElement>('.abyss-context-danger')!;
    expect(deleteItem.textContent).toBe('Delete sub-task');
    deleteItem.click();
    await flushMicrotasks(20);

    expect(execute).toHaveBeenCalledWith({
      type: 'delete-subtask',
      subtask: initial.subtasks[0]!.ref,
    });
    expect(state.get('taskStack')).toHaveLength(1);
    expect(state.get('taskStack')[0]).toMatchObject({ ref: afterDelete.ref, title: 'root' });
    panel.destroy();
  });

  it('does not overwrite a newer selection when a late reorder result arrives', async () => {
    const initial = snapshotWithChildren('old', ['first', 'second']);
    const other = { ...snapshot('other'), ref: { ...snapshot('other').ref, filePath: 'other.md' } };
    let resolve!: (result: TaskCommandResult) => void;
    const execute = vi.fn<TaskApplicationApi['execute']>().mockImplementation(
      () =>
        new Promise<TaskCommandResult>((done) => {
          resolve = done;
        }),
    );
    const { panel, state } = await panelWith(initial, execute);
    const root = state.get('taskStack')[0]!;
    const pending = call<Promise<void>>(
      panel,
      'reorderSubTask',
      root,
      root.subtasks![0]!,
      root.subtasks![1]!,
      'after',
    );
    state.set('taskStack', [other]);
    resolve({
      type: 'ok',
      changed: true,
      outcome: { type: 'task', task: snapshotWithChildren('fresh', ['second', 'first']) },
    });
    await pending;

    expect(state.get('taskStack')[0]).toMatchObject({ ref: other.ref });
  });

  it('does not overwrite newer navigation within the same root when a reorder resolves late', async () => {
    const initial = snapshotWithChildren('old', ['first', 'second']);
    let resolve!: (result: TaskCommandResult) => void;
    const execute = vi.fn<TaskApplicationApi['execute']>().mockImplementation(
      () =>
        new Promise<TaskCommandResult>((done) => {
          resolve = done;
        }),
    );
    const { panel, state } = await panelWith(initial, execute);
    const root = state.get('taskStack')[0]!;
    const pending = call<Promise<void>>(
      panel,
      'reorderSubTask',
      root,
      root.subtasks![0]!,
      root.subtasks![1]!,
      'after',
    );
    const selectedChild = root.subtasks![1]!;
    state.set('taskStack', [root, selectedChild]);
    resolve({
      type: 'ok',
      changed: true,
      outcome: { type: 'task', task: snapshotWithChildren('fresh', ['second', 'first']) },
    });
    await pending;

    expect(state.get('taskStack')).toEqual([root, selectedChild]);
  });

  it.each(['add', 'delete', 'reorder'] as const)(
    'keeps a newer sibling selection when a deferred nested %s completes',
    async (operation) => {
      const initial = snapshotWithNestedChildren('old');
      let resolve!: (result: TaskCommandResult) => void;
      const execute = vi.fn<TaskApplicationApi['execute']>().mockImplementation(
        () =>
          new Promise<TaskCommandResult>((done) => {
            resolve = done;
          }),
      );
      const { panel, state } = await panelWith(initial, execute);
      const root = initial;
      const branch = root.subtasks![0]!;
      const sibling = root.subtasks![1]!;
      state.set('taskStack', [root, branch]);

      let pending: Promise<unknown>;
      if (operation === 'add') {
        pending = call<Promise<boolean>>(panel, 'addSubTask', branch, 'new nested child');
      } else if (operation === 'delete') {
        pending = call<Promise<void>>(panel, 'deleteTask', branch);
      } else {
        pending = call<Promise<void>>(
          panel,
          'reorderSubTask',
          branch,
          branch.subtasks![0]!,
          branch.subtasks![1]!,
          'after',
        );
      }

      state.set('taskStack', [root, sibling]);
      resolve({
        type: 'ok',
        changed: true,
        outcome: { type: 'task', task: snapshotWithNestedChildren('fresh') },
      });
      await pending;

      expect(state.get('taskStack')).toEqual([root, sibling]);
    },
  );
});
