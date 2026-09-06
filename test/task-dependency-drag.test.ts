import { Notice, requireApiVersion, TFile } from 'obsidian';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppState } from '../src/app/AppState';
import { CenterPanel } from '../src/panels/CenterPanel';
import { RightPanel } from '../src/panels/RightPanel';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import { localDate, type DependencyDirection, type TaskApplicationApi } from '../src/tasks';
import { TaskApplicationService } from '../src/tasks/application/TaskApplicationService';
import { TaskDependencyService } from '../src/tasks/application/TaskDependencyService';
import { TaskIndex } from '../src/tasks/infrastructure/TaskIndex';
import { TaskRefAuthority } from '../src/tasks/infrastructure/TaskRefAuthority';
import { TaskBlockEditor } from '../src/tasks/infrastructure/markdown/TaskBlockEditor';
import { TaskLocator } from '../src/tasks/infrastructure/markdown/TaskLocator';
import { TaskMarkdownCodec } from '../src/tasks/infrastructure/markdown/TaskMarkdownCodec';
import { ObsidianTaskRepository } from '../src/tasks/infrastructure/obsidian/ObsidianTaskRepository';
import { startTaskNodeDrag } from '../src/ui/taskNodeDrag';
import {
  canonicalStatusCatalog,
  createAppWithFiles,
  expectDefined,
  flushMicrotasks,
  testStatusRegistry,
  useRealMoment,
} from './helpers';

useRealMoment();
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  activeDocument.body.empty();
  vi.restoreAllMocks();
});

async function harness(markdown: string, selected = 'B', additionalFiles = {}) {
  const app = await createAppWithFiles({ 'tasks.md': `\n${markdown}`, ...additionalFiles });
  const statuses = canonicalStatusCatalog();
  const authority = new TaskRefAuthority('dependency-drag');
  const index = new TaskIndex(app, {
    statusCatalog: statuses,
    dailyNoteFormat: 'YYYY-MM-DD',
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
  const application = new TaskApplicationService(
    index,
    repository,
    statuses,
    { today: () => localDate('2026-09-05') },
    undefined,
    undefined,
    new TaskDependencyService(
      index,
      repository,
      () => 'generate',
      () => {},
    ),
  );
  const execute = vi.fn<TaskApplicationApi['execute']>((command) => application.execute(command));
  const api: TaskApplicationApi = { queries: index, execute };
  const node = (title: string) =>
    expectDefined(index.listNodes().find(({ node: candidate }) => candidate.title === title));
  const state = new AppState();
  const location = node(selected);
  state.set('taskStack', [location.root, ...location.path]);
  state.set('selectedList', { type: 'project', path: 'tasks.md' });
  const centerEl = activeDocument.body.createDiv();
  const center = new CenterPanel(
    state,
    app,
    DEFAULT_SETTINGS,
    index,
    testStatusRegistry(),
    undefined,
    null,
    null,
    api,
  );
  center.mount(centerEl);
  const el = activeDocument.body.createDiv();
  const panel = new RightPanel(state, app, testStatusRegistry(), DEFAULT_SETTINGS, undefined, api);
  panel.mount(el);
  cleanups.push(() => {
    center.destroy();
    panel.destroy();
    index.destroy();
  });
  const file = app.vault.getAbstractFileByPath('tasks.md');
  if (!(file instanceof TFile)) throw new Error('Missing fixture');
  const read = async () => (await app.vault.read(file)).slice(1);
  const card = (title: string) => {
    state.set('selectedList', { type: 'project', path: node(title).root.ref.filePath });
    return expectDefined(
      [...centerEl.querySelectorAll<HTMLElement>('.abyss-task-card')].find(
        (item) => item.querySelector('.abyss-task-title')?.textContent === title,
      ),
    );
  };
  const sub = (title: string) =>
    expectDefined(
      [...el.querySelectorAll<HTMLElement>('.abyss-subtask-section .abyss-subtask-row')].find(
        (item) => item.querySelector('.abyss-subtask-label')?.textContent === title,
      ),
    );
  const section = (direction: DependencyDirection) =>
    expectDefined(el.querySelector<HTMLElement>(`[data-dependency-direction="${direction}"]`));
  return {
    app,
    file,
    panel,
    center,
    centerEl,
    el,
    state,
    index,
    node,
    api,
    execute,
    read,
    card,
    sub,
    section,
  };
}

function drag(element: HTMLElement, type: string, init: MouseEventInit = {}) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, ...init });
  const data = new Map<string, string>();
  Object.defineProperty(event, 'dataTransfer', {
    value: {
      setData: (format: string, value: string) => data.set(format, value),
      dropEffect: 'none',
    },
  });
  element.dispatchEvent(event);
  return { event, data };
}

function finishDrag(
  h: Awaited<ReturnType<typeof harness>>,
  source: HTMLElement,
  kind: 'center' | 'subtask',
  ending: 'dragend' | 'escape' | 'detach' | 'detach-panel' | 'destroy',
): void {
  const panelElement = kind === 'center' ? h.centerEl : h.el;
  const panel = kind === 'center' ? h.center : h.panel;
  switch (ending) {
    case 'dragend':
      drag(source, 'dragend');
      break;
    case 'escape':
      activeDocument.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      break;
    case 'detach':
      source.remove();
      break;
    case 'detach-panel':
      panelElement.remove();
      break;
    case 'destroy':
      panel.destroy();
      break;
  }
}

describe('canonical task-node drag sources', () => {
  it('uses the source document observer and releases its subscription when the source disappears', async () => {
    const h = await harness('- [ ] A 🆔 a\n- [ ] B 🆔 b\n');
    const iframe = activeDocument.body.createEl('iframe');
    const document = expectDefined(iframe.contentDocument);
    const owner = expectDefined(document.defaultView);
    const observe = vi.spyOn(owner, 'MutationObserver');
    const source = document.adoptNode(createDiv());
    document.body.append(source);
    const end = startTaskNodeDrag(h.state, document.body, source, {
      payload: { source: 'center-card', task: h.node('A') },
      onEnd: () => {},
    });
    expect(observe).toHaveBeenCalledOnce();
    source.remove();
    await flushMicrotasks();
    expect(h.state.get('draggingTaskNode')).toBeNull();
    end();
  });

  it('does not publish a native drag for a document without a window', async () => {
    const h = await harness('- [ ] A 🆔 a\n- [ ] B 🆔 b\n');
    const document = activeDocument.implementation.createHTMLDocument();
    const source = document.adoptNode(createDiv());
    document.body.append(source);
    const end = startTaskNodeDrag(h.state, document.body, source, {
      payload: { source: 'center-card', task: h.node('A') },
      onEnd: () => {},
    });
    expect(h.state.get('draggingTaskNode')).toBeNull();
    end();
  });

  it('publishes a detached center root and clears it on dragend without adding drag UI or formats', async () => {
    const h = await harness('- [ ] A 🆔 a\n- [ ] B 🆔 b\n');
    const card = h.card('A');
    const before = card.innerHTML;
    const selection = h.state.get('taskStack');
    const { data } = drag(card, 'dragstart');
    const payload = expectDefined(h.state.get('draggingTaskNode'));
    expect(payload.source).toBe('center-card');
    expect(payload.task).toEqual(h.node('A'));
    expect(payload.task.path).toEqual([]);
    expect(payload.task.node).toBe(payload.task.root);
    expect(Reflect.set(payload.task.node, 'title', 'tampered')).toBe(false);
    expect(card.innerHTML).toBe(before);
    expect(data.size).toBe(0);
    expect(h.state.get('taskStack')).toBe(selection);
    drag(card, 'dragend');
    expect(h.state.get('draggingTaskNode')).toBeNull();
    expect(card.classList.contains('abyss-dragging')).toBe(false);
  });

  it('publishes the full nested subtask path without replacing the dragged DOM or changing its existing format', async () => {
    const h = await harness('- [ ] Root\n  - [ ] B 🆔 b\n    - [ ] A 🆔 a\n', 'B');
    const row = h.sub('A');
    const before = row.innerHTML;
    const { data } = drag(row, 'dragstart');
    const payload = expectDefined(h.state.get('draggingTaskNode'));
    expect(payload.source).toBe('inspector-subtask');
    expect(payload.task).toEqual(h.node('A'));
    expect(payload.task.path.map((node) => node.title)).toEqual(['B', 'A']);
    expect(payload.task.node).toBe(payload.task.path[1]);
    expect(h.el.querySelector('.abyss-dep-section')).toBeNull();
    expect(h.sub('A')).toBe(row);
    expect(row.isConnected).toBe(true);
    expect(row.innerHTML).toBe(before);
    expect([...data]).toEqual([['text/plain', '1']]);
    drag(row, 'dragend');
    expect(h.state.get('draggingTaskNode')).toBeNull();
    expect(row.classList.contains('is-dragging')).toBe(false);
  });

  it.each(['dragend', 'escape', 'detach', 'detach-panel', 'destroy'] as const)(
    'clears a %s source and temporary sections for both source kinds',
    async (ending) => {
      for (const kind of ['center', 'subtask'] as const) {
        const h = await harness('- [ ] A 🆔 a\n- [ ] B 🆔 b\n  - [ ] Child 🆔 child\n');
        if (kind === 'subtask')
          expectDefined(h.el.querySelector<HTMLButtonElement>('.abyss-dep-badge-add')).click();
        const source = kind === 'center' ? h.card('A') : h.sub('Child');
        drag(source, 'dragstart');
        drag(h.section('blocked-by'), 'dragover');
        expect(h.el.querySelector('.is-drop-target')).not.toBeNull();
        finishDrag(h, source, kind, ending);
        await flushMicrotasks();
        expect(h.state.get('draggingTaskNode')).toBeNull();
        expect(h.el.querySelector('.is-drop-target, .is-drop-disabled')).toBeNull();
        if (kind === 'center' || ending === 'destroy')
          expect(h.el.querySelector('.abyss-dep-section')).toBeNull();
        else expect(h.el.querySelectorAll('.abyss-dep-section')).toHaveLength(2);
        expect(h.execute).not.toHaveBeenCalled();
      }
    },
  );
});

describe('dependency section drops', () => {
  it.each([
    ['center', 'blocked-by', false],
    ['center', 'blocks', false],
    ['center', 'blocked-by', true],
    ['center', 'blocks', true],
    ['subtask', 'blocked-by', false],
    ['subtask', 'blocks', false],
  ] as const)(
    'links %s on %s (cross-file %s) without movement, selection or history changes',
    async (kind, direction, crossFile) => {
      const centerSource = crossFile ? '' : '- [ ] A 🆔 a\n';
      const body =
        kind === 'subtask'
          ? '- [ ] Root\n  - [ ] B 🆔 b\n    - [ ] A 🆔 a\n    - [ ] Sibling\n'
          : `${centerSource}- [ ] Root\n  - [ ] B 🆔 b\n`;
      const h = await harness(
        `${body}- [ ] History\n`,
        'History',
        crossFile ? { 'other.md': '\n- [ ] A 🆔 a\n' } : {},
      );
      h.state.openInspectorDependency(h.node('B'));
      const selection = h.state.get('taskStack');
      const history = h.state.get('inspectorBackStack');
      const location = h.node('A');
      const order = h.index.listNodes().map(({ node }) => node.title);
      const source = kind === 'center' ? h.card('A') : h.sub('A');
      if (kind === 'subtask')
        expectDefined(h.el.querySelector<HTMLButtonElement>('.abyss-dep-badge-add')).click();
      const centerOrder = h.centerEl.textContent;
      drag(source, 'dragstart');
      const target = h.section(direction);
      const preview = drag(target, 'dragover');
      expect(preview.event.defaultPrevented).toBe(true);
      expect(target.classList.contains('is-drop-target')).toBe(true);
      expect(h.el.querySelectorAll('.is-drop-target')).toHaveLength(1);
      const dropped = drag(target, 'drop');
      expect(dropped.event.defaultPrevented).toBe(true);
      await flushMicrotasks(40);
      expect(h.execute.mock.calls.map(([command]) => command.type)).toEqual(['add-dependency']);
      expect(h.node(direction === 'blocked-by' ? 'B' : 'A').node.dependsOn).toEqual([
        direction === 'blocked-by' ? 'a' : 'b',
      ]);
      expect(h.index.listNodes().map(({ node }) => node.title)).toEqual(order);
      expect(h.node('A').path.map((node) => node.title)).toEqual(
        location.path.map((node) => node.title),
      );
      expect(h.centerEl.textContent).toBe(centerOrder);
      expect(h.state.get('taskStack')).toBe(selection);
      expect(h.state.get('inspectorBackStack')).toBe(history);
      expect(h.state.get('draggingTaskNode')).toBeNull();
      expect(h.el.querySelector('.is-drop-target, .is-drop-disabled')).toBeNull();
    },
  );

  it('adds a dependency by drop without a success Notice or local Undo', async () => {
    const prototype = Notice.prototype as unknown as {
      constructor__(this: Notice, message: string | DocumentFragment): void;
    };
    const notice = vi.spyOn(prototype, 'constructor__').mockImplementation(function (this: Notice) {
      if (requireApiVersion('1.8.7')) activeDocument.body.append(this.containerEl);
    });
    const h = await harness('- [ ] A 🆔 a\n- [ ] B 🆔 b\n');
    drag(h.card('A'), 'dragstart');
    drag(h.section('blocked-by'), 'drop');
    await flushMicrotasks(40);
    expect(await h.read()).toBe('- [ ] A 🆔 a\n- [ ] B 🆔 b ⛔ a\n');
    expect(notice).not.toHaveBeenCalled();
    expect(h.el.querySelector('.abyss-undo-row')).toBeNull();
  });

  it('refreshes only an affected history frame through the existing authority transition', async () => {
    const h = await harness('- [ ] A 🆔 a\n- [ ] B 🆔 b\n', 'A');
    h.state.openInspectorDependency(h.node('B'));
    const frame = expectDefined(h.state.get('inspectorBackStack')[0]);
    const selection = h.state.get('taskStack');
    drag(h.card('A'), 'dragstart');
    drag(h.section('blocks'), 'drop');
    await flushMicrotasks(40);
    const successor = expectDefined(h.state.get('inspectorBackStack')[0]);
    expect(successor).not.toBe(frame);
    expect(successor.taskStack[0]?.dependsOn).toEqual(['b']);
    expect(frame.taskStack[0]?.dependsOn).toEqual([]);
    expect(Object.isFrozen(frame.taskStack[0])).toBe(true);
    expect(h.state.get('taskStack')).toBe(selection);
  });

  it('keeps the exact existing subtask reorder placement', async () => {
    const h = await harness('- [ ] B\n  - [ ] A\n  - [ ] C\n');
    drag(h.sub('C'), 'dragstart');
    const row = h.sub('A');
    vi.spyOn(row, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 10, 100, 20));
    drag(row, 'dragover', { clientY: 11 });
    expect(row.classList.contains('drop-above')).toBe(true);
    drag(row, 'drop');
    await flushMicrotasks(40);
    expect(await h.read()).toBe('- [ ] B\n  - [ ] C\n  - [ ] A\n');
    expect(h.execute.mock.calls.map(([command]) => command.type)).toEqual(['reorder-subtask']);
    expect(h.state.get('draggingTaskNode')).toBeNull();
  });
});

describe('dependency drop disclosure and eligibility', () => {
  it('preserves plus-first section geometry when native pointer focus reaches a subtask before dragstart', async () => {
    const h = await harness('- [ ] A 🆔 a\n- [ ] B 🆔 b\n  - [ ] Child\n');
    expectDefined(h.el.querySelector<HTMLButtonElement>('.abyss-dep-badge-add')).click();
    const sections = [...h.el.querySelectorAll('.abyss-dep-section')];
    const source = h.sub('Child');
    expect(source.getAttribute('tabindex')).toBe('-1');
    source.focus();
    expect(activeDocument.activeElement).toBe(source);
    expect([...h.el.querySelectorAll('.abyss-dep-section')]).toEqual(sections);
    drag(source, 'dragstart');
    expect(h.state.get('draggingTaskNode')?.source).toBe('inspector-subtask');
    expect([...h.el.querySelectorAll('.abyss-dep-section')]).toEqual(sections);
    drag(source, 'dragend');
    expect([...h.el.querySelectorAll('.abyss-dep-section')]).toEqual(sections);
    const comment = expectDefined(h.el.querySelector<HTMLTextAreaElement>('.abyss-comment-input'));
    comment.focus();
    expect([...h.el.querySelectorAll('.abyss-dep-section')]).toEqual(sections);
  });

  it.each([
    ['center', 'blocked-by'],
    ['center', 'blocks'],
    ['subtask', 'blocked-by'],
    ['subtask', 'blocks'],
  ] as const)(
    'keeps explicit add disclosure after a %s drop on %s commits',
    async (kind, direction) => {
      const h = await harness('- [ ] A 🆔 a\n- [ ] B 🆔 b\n  - [ ] Child 🆔 child\n');
      expectDefined(h.el.querySelector<HTMLButtonElement>('.abyss-dep-badge-add')).click();
      const sourceTitle = kind === 'center' ? 'A' : 'Child';
      drag(kind === 'center' ? h.card(sourceTitle) : h.sub(sourceTitle), 'dragstart');
      drag(h.section(direction), 'drop');
      expect(h.el.querySelectorAll('.abyss-dep-section')).toHaveLength(2);

      await flushMicrotasks(40);

      const dependent = h.node(direction === 'blocked-by' ? 'B' : sourceTitle);
      expect(dependent.node.dependsOn).toEqual([
        direction === 'blocked-by' ? h.node(sourceTitle).node.dependencyId : 'b',
      ]);
      expect(h.execute).toHaveBeenCalledOnce();
      expect(h.section(direction).querySelectorAll('.abyss-dep-row')).toHaveLength(1);
      expect(h.el.querySelectorAll('.abyss-dep-section')).toHaveLength(2);
      expect(h.state.get('draggingTaskNode')).toBeNull();
    },
  );

  it.each(['center', 'subtask'] as const)(
    'keeps explicit add disclosure when a %s drop fails to commit',
    async (kind) => {
      const markdown = '- [ ] A 🆔 a\n- [ ] B 🆔 b\n  - [ ] Child 🆔 child\n';
      const h = await harness(markdown);
      h.execute.mockResolvedValueOnce({
        type: 'io-error',
        cause: 'repository-error',
        contentState: 'unknown',
      });
      expectDefined(h.el.querySelector<HTMLButtonElement>('.abyss-dep-badge-add')).click();
      drag(kind === 'center' ? h.card('A') : h.sub('Child'), 'dragstart');
      drag(h.section('blocked-by'), 'drop');

      await flushMicrotasks(40);

      expect(h.execute).toHaveBeenCalledOnce();
      expect(h.el.querySelectorAll('.abyss-dep-section')).toHaveLength(2);
      expect(h.el.querySelector('.abyss-dep-row')).toBeNull();
      expect(h.el.querySelector('.abyss-dep-badge-add')).toBeNull();
      expect(h.state.get('draggingTaskNode')).toBeNull();
      expect(await h.read()).toBe(markdown);
    },
  );

  it('does not close another task disclosure when an earlier drop finishes', async () => {
    const h = await harness('- [ ] A 🆔 a\n- [ ] B 🆔 b\n- [ ] Other 🆔 other\n');
    const execute = expectDefined(h.execute.getMockImplementation());
    let commit: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => {
      commit = resolve;
    });
    h.execute.mockImplementationOnce(async (command) => {
      await pending;
      return execute(command);
    });
    expectDefined(h.el.querySelector<HTMLButtonElement>('.abyss-dep-badge-add')).click();
    drag(h.card('A'), 'dragstart');
    drag(h.section('blocked-by'), 'drop');
    h.state.openInspectorDependency(h.node('Other'));
    expectDefined(h.el.querySelector<HTMLButtonElement>('.abyss-dep-badge-add')).click();

    expectDefined(commit)();
    await flushMicrotasks(40);

    expect(h.node('B').node.dependsOn).toEqual(['a']);
    expect(h.el.querySelectorAll('.abyss-dep-section')).toHaveLength(2);
    expect(h.el.querySelector('.abyss-dep-row')).toBeNull();
  });

  it('preserves visible relation section DOM during subtask start and cancellation', async () => {
    const h = await harness('- [ ] A 🆔 a\n- [ ] B 🆔 b ⛔ a\n  - [ ] Child 🆔 child\n');
    const section = h.section('blocked-by');
    const otherSection = h.section('blocks');
    const child = h.sub('Child');
    drag(child, 'dragstart');
    expect(h.section('blocked-by')).toBe(section);
    expect(h.section('blocks')).toBe(otherSection);
    drag(section, 'dragover');
    expect(section.classList.contains('is-drop-target')).toBe(true);
    drag(child, 'dragend');
    expect(h.section('blocked-by')).toBe(section);
    expect(h.section('blocks')).toBe(otherSection);
    expect(section.classList.contains('is-drop-target')).toBe(false);
    expect(section.classList.contains('is-drop-disabled')).toBe(false);
  });

  it('uses the whole existing section grammar and restores the integrated plus when the drag ends', async () => {
    const h = await harness('- [ ] A 🆔 a\n- [ ] B 🆔 b\n');
    expect(h.el.querySelector('.abyss-dep-section')).toBeNull();
    expect(h.el.querySelector('.abyss-dep-badge-add')).not.toBeNull();
    const card = h.card('A');
    drag(card, 'dragstart');
    expect(
      [...h.el.querySelectorAll('.abyss-dep-section')].map((section) => section.textContent),
    ).toEqual(['Blocked by+Add dependency', 'Blocks+Add dependency']);
    expect(h.el.querySelector('.abyss-dep-badge-add')).toBeNull();
    const section = h.section('blocks');
    const markup = section.innerHTML;
    drag(section.querySelector<HTMLElement>('.abyss-dep-add') ?? section, 'dragenter');
    expect(section.classList.contains('is-drop-target')).toBe(true);
    expect(h.section('blocked-by').classList.contains('is-drop-target')).toBe(false);
    expect(section.innerHTML).toBe(markup);
    drag(section, 'dragleave', { relatedTarget: section.firstElementChild });
    expect(section.classList.contains('is-drop-target')).toBe(true);
    drag(section, 'dragleave', { relatedTarget: h.el });
    expect(section.classList.contains('is-drop-target')).toBe(false);
    drag(card, 'dragend');
    expect(h.el.querySelector('.abyss-dep-section')).toBeNull();
    expect(h.el.querySelector('.abyss-dep-badge-add')).not.toBeNull();
  });

  it.each(['center', 'subtask'] as const)(
    'preserves explicit add disclosure when a %s drag is cancelled and the badge body still opens search',
    async (kind) => {
      const h = await harness('- [ ] A 🆔 a\n- [ ] B 🆔 b\n  - [ ] Child\n');
      expectDefined(h.el.querySelector<HTMLButtonElement>('.abyss-dep-badge-add')).click();
      drag(kind === 'center' ? h.card('A') : h.sub('Child'), 'dragstart');
      activeDocument.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      expect(h.state.get('draggingTaskNode')).toBeNull();
      expect(h.el.querySelectorAll('.abyss-dep-section')).toHaveLength(2);
      expectDefined(h.el.querySelector<HTMLButtonElement>('.abyss-dep-badge-body')).click();
      expect(h.el.querySelector('.abyss-dep-search input')).not.toBeNull();
    },
  );

  it.each([
    ['self', '- [ ] B 🆔 b\n', 'B'],
    ['duplicate', '- [ ] A 🆔 a\n- [ ] B 🆔 b ⛔ a\n', 'A'],
    ['inverse', '- [ ] A 🆔 a ⛔ b\n- [ ] B 🆔 b\n', 'A'],
    ['cycle', '- [ ] A 🆔 a ⛔ c\n- [ ] B 🆔 b\n- [ ] C 🆔 c ⛔ b\n', 'A'],
    ['ambiguous', '- [ ] A 🆔 a\n- [ ] Other 🆔 a\n- [ ] B 🆔 b\n', 'A'],
  ] as const)(
    'marks %s disabled without accepting or dispatching a drop',
    async (_reason, markdown, title) => {
      const h = await harness(markdown);
      drag(h.card(title), 'dragstart');
      const section = h.section('blocked-by');
      const over = drag(section, 'dragover');
      expect(over.event.defaultPrevented).toBe(false);
      expect(section.classList.contains('is-drop-disabled')).toBe(true);
      expect(section.classList.contains('is-drop-target')).toBe(false);
      const dropped = drag(section, 'drop');
      await flushMicrotasks();
      expect(dropped.event.defaultPrevented).toBe(false);
      expect(h.execute).not.toHaveBeenCalled();
      expect(await h.read()).toBe(markdown);
      expect(h.state.get('draggingTaskNode')).toBeNull();
      expect(h.el.querySelector('.is-drop-target, .is-drop-disabled')).toBeNull();
    },
  );

  it.each(['stale', 'unavailable'] as const)(
    'rechecks a %s source between preview and drop',
    async (reason) => {
      const h = await harness('- [ ] A 🆔 a\n- [ ] B 🆔 b\n');
      const source = h.card('A');
      drag(source, 'dragstart');
      expect(drag(h.section('blocked-by'), 'dragover').event.defaultPrevented).toBe(true);
      const changed =
        reason === 'stale' ? '\n- [ ] A changed 🆔 a\n- [ ] B 🆔 b\n' : '\n- [ ] B 🆔 b\n';
      await h.app.vault.modify(h.file, changed);
      await flushMicrotasks(20);
      const section = h.section('blocked-by');
      expect(drag(section, 'dragover').event.defaultPrevented).toBe(false);
      expect(section.classList.contains('is-drop-disabled')).toBe(true);
      drag(section, 'drop');
      await flushMicrotasks();
      expect(h.execute).not.toHaveBeenCalled();
      expect(await h.read()).toBe(changed.slice(1));
    },
  );

  it('rechecks eligibility at drop even when no new dragover followed the index change', async () => {
    const h = await harness('- [ ] A 🆔 a\n- [ ] B 🆔 b\n');
    const source = h.card('A');
    drag(source, 'dragstart');
    expect(drag(h.section('blocked-by'), 'dragover').event.defaultPrevented).toBe(true);
    await h.app.vault.modify(h.file, '\n- [ ] A 🆔 a ⛔ b\n- [ ] B 🆔 b\n');
    await flushMicrotasks(20);
    expect(source.isConnected).toBe(true);
    const result = drag(h.section('blocked-by'), 'drop');
    expect(result.event.defaultPrevented).toBe(false);
    expect(h.execute).not.toHaveBeenCalled();
    expect(h.state.get('draggingTaskNode')).toBeNull();
    expect(await h.read()).toBe('- [ ] A 🆔 a ⛔ b\n- [ ] B 🆔 b\n');
  });

  it('does not accept unrelated drag data or turn relation rows into reorder targets', async () => {
    const h = await harness('- [ ] A 🆔 a\n- [ ] B 🆔 b ⛔ a\n  - [ ] Child\n');
    const section = h.section('blocked-by');
    expect(drag(section, 'dragover').event.defaultPrevented).toBe(false);
    expect(drag(section, 'drop').event.defaultPrevented).toBe(false);
    drag(h.sub('Child'), 'dragstart');
    const row = expectDefined(h.section('blocked-by').querySelector<HTMLElement>('.abyss-dep-row'));
    expect(row.getAttribute('draggable')).toBeNull();
    drag(row, 'dragover');
    expect(row.classList.contains('drop-above')).toBe(false);
    expect(row.classList.contains('drop-below')).toBe(false);
    expect(h.execute).not.toHaveBeenCalled();
  });
});
