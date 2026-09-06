import { Notice, Platform, requireApiVersion, TFile } from 'obsidian';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppState } from '../src/app/AppState';
import { RightPanel } from '../src/panels/RightPanel';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import {
  localDate,
  type SubtaskSnapshot,
  type TaskApplicationApi,
  type TaskCommandResult,
  type TaskResolution,
} from '../src/tasks';
import { TaskApplicationService } from '../src/tasks/application/TaskApplicationService';
import { TaskDependencyService } from '../src/tasks/application/TaskDependencyService';
import { TaskIndex } from '../src/tasks/infrastructure/TaskIndex';
import { TaskRefAuthority } from '../src/tasks/infrastructure/TaskRefAuthority';
import { TaskBlockEditor } from '../src/tasks/infrastructure/markdown/TaskBlockEditor';
import { TaskLocator } from '../src/tasks/infrastructure/markdown/TaskLocator';
import { TaskMarkdownCodec } from '../src/tasks/infrastructure/markdown/TaskMarkdownCodec';
import { ObsidianTaskRepository } from '../src/tasks/infrastructure/obsidian/ObsidianTaskRepository';
import { TaskModal } from '../src/ui/TaskModal';
import { rebuildTaskSelection, rootTaskRef } from '../src/ui/taskSelection';
import {
  canonicalStatusCatalog,
  createAppWithFiles,
  cssDeclarationsFor,
  cssDeclarationValue,
  expectDefined,
  flushMicrotasks,
  testStatusRegistry,
  useRealMoment,
} from './helpers';
import { expandCompoundSelectorLists } from './support/expandedCss';

useRealMoment();
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) {
    cleanup();
  }
  activeDocument.body.empty();
  vi.restoreAllMocks();
});

async function harness(markdown: string, selected = 'Current', additionalFiles = {}) {
  // The mock metadata parser uses -0 for a root list beginning on line zero.
  const app = await createAppWithFiles({ 'tasks.md': `\n${markdown}`, ...additionalFiles });
  const statuses = canonicalStatusCatalog();
  const authority = new TaskRefAuthority('inspector-dependencies');
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
  const panel = new RightPanel(state, app, testStatusRegistry(), DEFAULT_SETTINGS, undefined, api);
  panel.mount(el);
  cleanups.push(() => {
    panel.destroy();
    index.destroy();
  });
  const file = app.vault.getAbstractFileByPath('tasks.md');
  if (!(file instanceof TFile)) throw new Error('Missing fixture');
  const read = async () => {
    const content = await app.vault.read(file);
    expect(content.startsWith('\n')).toBe(true);
    return content.slice(1);
  };
  return { app, file, panel, el, state, index, node, api, read };
}

function notices(messages?: string[]): Notice[] {
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

function labels(el: HTMLElement): Array<string | null> {
  return [...el.querySelectorAll('.abyss-right-section-label')].map(
    (element) => element.textContent,
  );
}
function button(el: HTMLElement, selector: string): HTMLButtonElement {
  return expectDefined(el.querySelector<HTMLButtonElement>(selector));
}
function search(el: HTMLElement, query: string): HTMLInputElement {
  const input = expectDefined(el.querySelector<HTMLInputElement>('.abyss-dep-search input'));
  input.value = query;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  return input;
}

function modalRootPosition(location: string): number {
  if (location.includes('middle')) return 1;
  return location.includes('last') ? 2 : 0;
}

describe('inspector subtask row removal', () => {
  it('keeps row removal in normal flow and exposes it to hover, focus and touch', async () => {
    if (!Platform.isDesktop) throw new Error('CSS contract requires desktop filesystem access');
    const fs = await import('node:fs');
    const css = expandCompoundSelectorLists(
      fs.readFileSync(`${import.meta.dirname}/../styles.css`, 'utf8'),
    );
    const value = (selector: string, property: string) =>
      cssDeclarationValue(cssDeclarationsFor(css, selector), property);
    expect(value('.abyss-subtask-remove', 'opacity')).toBe('0');
    expect(value('.abyss-subtask-remove', 'position')).not.toBe('absolute');
    expect(value('.abyss-subtask-row:hover .abyss-subtask-remove', 'opacity')).toBe('1');
    expect(value('.abyss-subtask-row:focus-within .abyss-subtask-remove', 'opacity')).toBe('1');
    expect(value('.abyss-subtask-remove:focus-visible', 'outline')).toBe(
      '2px solid var(--interactive-accent)',
    );
    expect(value('.abyss-subtask-title-row', 'display')).toBe('flex');
    expect(value('.abyss-subtask-title-row', 'align-items')).toBe('center');
    expect(css).toMatch(
      /@media\s*\(pointer: coarse\)\s*\{[^}]*\}[^}]*\.abyss-subtask-remove\s*\{\s*opacity: 1;/u,
    );
  });

  it('deletes a nested subtree from its row and Undo restores exact bytes without navigation', async () => {
    const markdown =
      '- [ ] Source\n- [ ] Current\n  - [ ] Branch\n    - [ ] Remove me 🆔 child ⛔ missing\n      - > Keep **description**\n      - [ ] Grandchild\n      - 2026-09-05: Keep comment\n    - [ ] Keep sibling\n';
    const captured = notices();
    const h = await harness(markdown, 'Source');
    h.state.openInspectorDependency(h.node('Branch'));
    const row = button(h.el, '.abyss-subtask-section .abyss-subtask-row');
    const remove = button(row, '.abyss-subtask-remove');
    expect(remove.type).toBe('button');
    expect(remove.tabIndex).toBe(0);
    expect(remove.getAttribute('aria-label')).toBe('Delete sub-task');
    expect(row.draggable).toBe(true);
    expect(remove.parentElement?.className).toBe('abyss-subtask-title-row');
    expect(remove.parentElement?.querySelector('.abyss-subtask-label')?.textContent).toBe(
      'Remove me',
    );
    expect(remove.parentElement?.querySelector('.abyss-subtask-meta')).toBeNull();
    remove.focus();
    remove.click();
    expect(remove.disabled).toBe(true);
    remove.click();
    await flushMicrotasks(50);
    expect(await h.read()).toBe(
      '- [ ] Source\n- [ ] Current\n  - [ ] Branch\n    - [ ] Keep sibling\n',
    );
    expect(h.state.get('taskStack').map((node) => node.title)).toEqual(['Current', 'Branch']);
    expect(h.state.get('inspectorBackStack').map((frame) => frame.taskStack[0]?.title)).toEqual([
      'Source',
    ]);
    expect(captured).toHaveLength(1);
    button(activeDocument.body, '.mod-cta').click();
    await flushMicrotasks(50);
    expect(await h.read()).toBe(markdown);
    expect(h.state.get('taskStack').map((node) => node.title)).toEqual(['Current', 'Branch']);
  });

  it('keeps a failed row deletion available for retry with one Notice and no write', async () => {
    const markdown = '- [ ] Current\n  - [ ] Child\n';
    const captured = notices();
    const h = await harness(markdown);
    vi.spyOn(h.api, 'execute').mockResolvedValue({
      type: 'io-error',
      cause: 'repository-error',
      contentState: 'unknown',
    });
    const remove = button(h.el, '.abyss-subtask-remove');
    remove.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 0 }));
    await flushMicrotasks(30);
    expect(await h.read()).toBe(markdown);
    expect(captured).toHaveLength(1);
    expect(remove.isConnected).toBe(true);
    expect(remove.disabled).toBe(false);
    expect(h.state.get('taskStack').map((node) => node.title)).toEqual(['Current']);
  });
});

describe('inspector dependency navigation', () => {
  const source =
    '- [ ] A\n  - [ ] A.1\n    - [ ] A.1.a 🆔 a ⛔ b\n- [ ] B\n  - [ ] B.2 🆔 b ⛔ c\n    - [ ] B.2.child\n- [ ] C 🆔 c\n';

  it.each(['label', 'row', 'label child', 'keyboard activation'])(
    'opens the full nested inspector from a resolved %s and restores two frames',
    async (target) => {
      const h = await harness(source, 'A.1.a');
      const original = h.state.get('taskStack');
      const row = button(h.el, '.abyss-dep-row');
      const label = button(h.el, '.abyss-dep-title');
      expect(label.tagName).toBe('BUTTON');
      expect(label.tabIndex).toBe(0);
      label.focus();
      expect(activeDocument.activeElement).toBe(label);
      if (target === 'row') row.click();
      else if (target === 'label child') label.createSpan({ text: 'B.2' }).click();
      // Native buttons dispatch a detail-zero click after keyboard activation.
      else if (target === 'keyboard activation')
        label.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 0 }));
      else label.click();
      expect(h.state.get('taskStack').map((node) => node.title)).toEqual(['B', 'B.2']);
      const firstBack = button(h.el, '[aria-label="Back to previous task"]');
      expect(firstBack.title).toBe('Back to previous task');
      expect(firstBack.tabIndex).toBe(0);
      expect(activeDocument.activeElement).toBe(firstBack);
      button(h.el, '[data-dependency-direction="blocked-by"] .abyss-dep-title').click();
      expect(h.state.get('taskStack').map((node) => node.title)).toEqual(['C']);
      button(h.el, '[aria-label="Back to previous task"]').click();
      expect(h.state.get('taskStack').map((node) => node.title)).toEqual(['B', 'B.2']);
      button(h.el, '[aria-label="Back to previous task"]').click();
      expect(h.state.get('taskStack')).toEqual(original);
      expect(h.el.querySelector('[aria-label="Back to previous task"]')).toBeNull();
    },
  );

  it('navigates inverse relations and keeps breadcrumb/subtask navigation inside the current frame', async () => {
    const h = await harness(source, 'B.2');
    button(h.el, '[data-dependency-direction="blocks"] .abyss-dep-title').click();
    expect(h.state.get('taskStack').map((node) => node.title)).toEqual(['A', 'A.1', 'A.1.a']);
    button(h.el, '.abyss-breadcrumb-item').click();
    expect(h.state.get('taskStack').map((node) => node.title)).toEqual(['A']);
    button(h.el, '.abyss-subtask-label').click();
    expect(h.state.get('taskStack').map((node) => node.title)).toEqual(['A', 'A.1']);
    button(h.el, '[aria-label="Back to previous task"]').click();
    expect(h.state.get('taskStack').map((node) => node.title)).toEqual(['B', 'B.2']);
  });

  it('keeps status/remove actions out of navigation and preserves history through removal', async () => {
    const h = await harness(source, 'A.1.a');
    h.state.openInspectorDependency(h.node('B.2'));
    const previous = h.state.get('inspectorBackStack');
    const unrelatedFocus = button(h.el, '[aria-label="More actions"]');
    unrelatedFocus.focus();
    button(h.el, '.abyss-dep-row .abyss-status-marker').click();
    expect(h.state.get('taskStack').map((node) => node.title)).toEqual(['B', 'B.2']);
    expect(activeDocument.activeElement).toBe(unrelatedFocus);
    expect(await h.read()).toBe(source);
    button(h.el, '.abyss-dep-remove').click();
    expect(activeDocument.activeElement).toBe(unrelatedFocus);
    await flushMicrotasks(30);
    expect(h.state.get('taskStack').map((node) => node.title)).toEqual(['B', 'B.2']);
    expect(h.state.get('inspectorBackStack')).toBe(previous);
    expect(await h.read()).toBe(source.replace('🆔 b ⛔ c', '🆔 b'));
    expect(h.el.querySelector('[aria-label="Back to previous task"]')).not.toBeNull();
  });

  it('never makes unavailable or ambiguous rows navigation controls', async () => {
    const h = await harness(
      '- [ ] Current ⛔ missing, duplicate\n- [ ] One 🆔 duplicate\n- [ ] Two 🆔 duplicate\n',
    );
    for (const row of h.el.querySelectorAll<HTMLElement>('.abyss-dep-row')) {
      expect(row.querySelector('.abyss-dep-title')?.tagName).toBe('SPAN');
      expect(row.getAttribute('role')).toBeNull();
      row.click();
      expect(h.state.get('taskStack')[0]?.title).toBe('Current');
      expect(h.state.get('inspectorBackStack')).toEqual([]);
    }
  });

  it('removes Back when explicitly reselecting the same current stack or closing the inspector', async () => {
    const h = await harness(source, 'A.1.a');
    for (const close of [false, true]) {
      h.state.openInspectorDependency(h.node(close ? 'B.2' : 'C'));
      expect(h.el.querySelector('[aria-label="Back to previous task"]')).not.toBeNull();
      h.state.set('taskStack', close ? [] : h.state.get('taskStack'));
      expect(h.el.querySelector('[aria-label="Back to previous task"]')).toBeNull();
    }
  });

  it.each(['ordinary', 'dependency'] as const)(
    'retains %s modal selection through index refresh and destination editing',
    async (mode) => {
      const h = await harness(source, 'A.1.a');
      const outer = h.state.get('taskStack');
      const modal = new TaskModal(h.app, testStatusRegistry(), DEFAULT_SETTINGS, h.index, h.api);
      cleanups.unshift(() => {
        modal.close();
      });
      modal.open(h.node(mode === 'ordinary' ? 'B' : 'C').root);
      const el = button(activeDocument.body, '.abyss-modal-body');
      button(el, mode === 'ordinary' ? '.abyss-subtask-label' : '.abyss-dep-title').click();
      expect(el.querySelector('.abyss-right-title')?.textContent).toBe('B.2');
      button(el, '.abyss-right-title-view').click();
      const editor = expectDefined(
        el.querySelector<HTMLTextAreaElement>('.abyss-right-title-edit'),
      );
      editor.value = 'Edited B.2';
      editor.dispatchEvent(new Event('input', { bubbles: true }));
      editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await flushMicrotasks(40);
      expect(await h.read()).toBe(source.replace('B.2 🆔', 'Edited B.2 🆔'));
      expect(el.querySelector('.abyss-right-title')?.textContent).toBe('Edited B.2');
      if (mode === 'dependency') {
        button(el, '[aria-label="Back to previous task"]').click();
        expect(el.querySelector('.abyss-right-title')?.textContent).toBe('C');
      }
      expect(h.state.get('taskStack')).toBe(outer);
      modal.close();
      modal.open(h.node('C').root);
      expect(
        activeDocument.querySelector('.abyss-modal-body [aria-label="Back to previous task"]'),
      ).toBeNull();
    },
  );
});

describe('owned dependency destination editing', () => {
  const source = '- [ ] B\n  - [ ] B.2 🆔 b\n    - [ ] Deep\n- [ ] C ⛔ b\n';
  it.each(['description', 'planning', 'status'] as const)(
    'keeps a related nested selection and Back after %s editing',
    async (kind) => {
      const h = await harness(source, 'C');
      const modal = new TaskModal(h.app, testStatusRegistry(), DEFAULT_SETTINGS, h.index, h.api);
      cleanups.unshift(() => {
        modal.close();
      });
      modal.open(h.node('C').root);
      const el = button(activeDocument.body, '.abyss-modal-body');
      button(el, '.abyss-dep-title').click();
      const local = modal as unknown as {
        innerState: AppState;
        innerPanel: {
          updateDescription_abyssPrivate(task: SubtaskSnapshot, text: string): Promise<boolean>;
          updatePriority_abyssPrivate(task: SubtaskSnapshot, priority: string): Promise<void>;
          commitStatus_abyssPrivate(task: SubtaskSnapshot, symbol: string): Promise<void>;
        };
      };
      const selected = expectDefined(h.node('B.2').path[0]);
      const history = local.innerState.get('inspectorBackStack');
      const originalHistory = JSON.stringify(history);
      if (kind === 'description')
        await local.innerPanel.updateDescription_abyssPrivate(selected, 'First line\nSecond line');
      else if (kind === 'planning')
        await local.innerPanel.updatePriority_abyssPrivate(selected, 'A');
      else await local.innerPanel.commitStatus_abyssPrivate(selected, '/');
      await flushMicrotasks(30);
      expect(local.innerState.get('taskStack').map((node) => node.title)).toEqual(['B', 'B.2']);
      expect(JSON.stringify(history)).toBe(originalHistory);
      expect(local.innerState.get('inspectorBackStack')[0]?.taskStack[0]?.ref).toEqual(
        h.node('C').root.ref,
      );
      const fresh = h.node('B.2');
      if (kind === 'description') expect(fresh.node.description).toBe('First line\nSecond line');
      else if (kind === 'planning') expect(fresh.node.priority).toBe('A');
      else expect(fresh.node.statusSymbol).toBe('/');
      button(el, '[aria-label="Back to previous task"]').click();
      expect(local.innerState.get('taskStack').map((node) => node.title)).toEqual(['C']);
      expect(local.innerState.get('taskStack')[0]?.ref).toEqual(h.node('C').root.ref);
      expect(button(el, '.abyss-dep-title').textContent).toBe('B.2');
    },
  );

  it('does not retain a child through a concurrent insertion while its title edit is pending', async () => {
    const h = await harness(source, 'C');
    const modal = new TaskModal(h.app, testStatusRegistry(), DEFAULT_SETTINGS, h.index, h.api);
    cleanups.unshift(() => {
      modal.close();
    });
    modal.open(h.node('C').root);
    const el = button(activeDocument.body, '.abyss-modal-body');
    button(el, '.abyss-dep-title').click();
    const original = h.api.execute.bind(h.api);
    vi.spyOn(h.api, 'execute').mockImplementation(async (command) => {
      await original({ type: 'add-subtask', parent: h.node('B').target, text: 'Concurrent child' });
      return original(command);
    });
    const local = modal as unknown as { innerState: AppState; innerPanel: RightPanel };
    await local.innerPanel.updateTaskTitle(expectDefined(h.node('B.2').path[0]), 'Edited B.2');
    await flushMicrotasks(30);
    expect(local.innerState.get('taskStack').map((node) => node.title)).toEqual(['B']);
    expect(await h.read()).toContain('Concurrent child');
    expect(await h.read()).toContain('Edited B.2');
    expect(local.innerState.backInspectorDependency()).toBe(true);
    expect(local.innerState.get('taskStack').map((node) => node.title)).toEqual(['C']);
  });
});

describe('live dependency history restoration', () => {
  const source = '- [ ] B\n  - [ ] B.2 🆔 b\n- [ ] C ⛔ b\n';

  it.each(['panel', 'modal'] as const)(
    'keeps %s history current through sequential shifts and later dependency mutations',
    async (surface) => {
      const h = await harness(source.replace('🆔 b', '🆔 b ⛔ missing'), 'C');
      const modal = new TaskModal(h.app, testStatusRegistry(), DEFAULT_SETTINGS, h.index, h.api);
      cleanups.unshift(() => {
        modal.close();
      });
      if (surface === 'modal') modal.open(h.node('C').root);
      const local = modal as unknown as { innerState: AppState; innerPanel: RightPanel };
      const state = surface === 'modal' ? local.innerState : h.state;
      const el = surface === 'modal' ? button(activeDocument.body, '.abyss-modal-body') : h.el;
      button(el, '.abyss-dep-title').click();
      const original = state.get('inspectorBackStack');
      const originalJSON = JSON.stringify(original);
      const edited = h.node('B.2').target;
      if (edited.type !== 'subtask') throw new Error('Expected nested target');
      await h.api.execute({
        type: 'patch',
        target: edited,
        patch: { markdownTitle: { type: 'set', value: 'Edited B.2' } },
      });
      for (const text of [
        'First\nSecond',
        'First\nSecond\nThird',
        'First\nSecond\nThird\nFourth',
      ]) {
        await h.api.execute({ type: 'set-description', target: h.node('Edited B.2').target, text });
        expect(state.get('inspectorBackStack')[0]?.taskStack[0]?.ref).toEqual(h.node('C').root.ref);
      }
      await h.api.execute({
        type: 'remove-dependency',
        dependent: h.node('Edited B.2').target,
        dependencyId: 'missing',
      });
      await flushMicrotasks(30);
      expect(JSON.stringify(original)).toBe(originalJSON);
      button(el, '[aria-label="Back to previous task"]').click();
      expect(state.get('taskStack')[0]?.ref).toEqual(h.node('C').root.ref);
      expect(button(el, '.abyss-dep-title').textContent).toBe('Edited B.2');
    },
  );

  it('captures successive synchronous relocation evidence before deferred query refresh', async () => {
    const h = await harness(source, 'C');
    button(h.el, '.abyss-dep-title').click();
    const initial = h.state.get('inspectorBackStack');
    button(h.el, '.abyss-right-title-view').click();
    const editor = expectDefined(
      h.el.querySelector<HTMLTextAreaElement>('.abyss-right-title-edit'),
    );
    editor.value = 'Unsaved current draft';
    for (const blankLines of ['\n', '\n\n', '\n\n\n']) {
      const relocated = source.replace('- [ ] C', `${blankLines}- [ ] C`);
      h.index.installCommittedContent('tasks.md', `\n${relocated}`);
      // Deliver each installed query transition before RightPanel's queued DOM work.
      (
        h.index as unknown as {
          publish_abyssPrivate(event: { type: 'changed'; files: string[] }): void;
        }
      ).publish_abyssPrivate({
        type: 'changed',
        files: ['tasks.md'],
      });
      expect(h.state.get('inspectorBackStack')[0]?.taskStack[0]?.ref).toEqual(h.node('C').root.ref);
      expect(editor.isConnected).toBe(true);
      expect(editor.value).toBe('Unsaved current draft');
    }
    await flushMicrotasks(20);
    expect(initial[0]?.taskStack[0]?.ref).not.toEqual(h.node('C').root.ref);
    button(h.el, '[aria-label="Back to previous task"]').click();
    expect(h.state.get('taskStack')[0]?.ref).toEqual(h.node('C').root.ref);
  });

  it.each(['same-file', 'cross-file'] as const)(
    'restores a live editable prior task after a %s multiline destination edit',
    async (location) => {
      const h = await harness(
        location === 'same-file' ? source : source.replace('- [ ] C ⛔ b\n', ''),
        'C',
        location === 'cross-file' ? { 'other.md': '\n- [ ] C ⛔ b\n' } : {},
      );
      const previous = h.state.get('taskStack');
      button(h.el, '.abyss-dep-title').click();
      const result = await h.api.execute({
        type: 'set-description',
        target: h.node('B.2').target,
        text: 'First line\nSecond line',
      });
      expect(result.type).toBe('ok');
      const live = h.node('C').root;
      if (location === 'same-file')
        expect(live.ref.line).not.toBe(rootTaskRef(expectDefined(previous[0])).line);
      button(h.el, '[aria-label="Back to previous task"]').click();
      expect(h.state.get('taskStack')[0]?.ref).toEqual(live.ref);
      expect(button(h.el, '.abyss-dep-title').textContent).toBe('B.2');
      expect(h.state.get('inspectorBackStack')).toEqual([]);
      await h.panel.updateTaskTitle(expectDefined(h.state.get('taskStack')[0]), 'Edited C');
      expect(h.node('Edited C').root.ref.filePath).toBe(live.ref.filePath);
      expect(h.node('B.2').node.description).toBe('First line\nSecond line');
    },
  );

  it.each(['not-found', 'uncertain', 'ambiguous', 'visual'] as const)(
    'keeps a retryable history and current task for an unproven %s previous root',
    async (kind) => {
      const h = await harness(source, 'C');
      const messages: string[] = [];
      notices(messages);
      const original = h.node('C').root;
      button(h.el, '.abyss-dep-title').click();
      const selected = h.state.get('taskStack');
      const history = h.state.get('inspectorBackStack');
      const fallback = h.node('B').root;
      let resolution: TaskResolution = { type: 'ambiguous', candidates: [] };
      if (kind === 'visual')
        resolution = {
          type: 'visual',
          stale: original.ref,
          current: fallback,
          evidence: 'same-line',
        };
      else if (kind !== 'ambiguous') resolution = { type: kind, ref: original.ref };
      const resolve = vi.spyOn(h.index, 'resolve').mockReturnValue(resolution);
      button(h.el, '[aria-label="Back to previous task"]').click();
      expect(h.state.get('taskStack')).toBe(selected);
      expect(h.state.get('inspectorBackStack')).toBe(history);
      expect(messages[0]).toContain('previous task');
      resolve.mockRestore();
      button(h.el, '[aria-label="Back to previous task"]').click();
      expect(h.state.get('taskStack')[0]?.title).toBe('C');
    },
  );

  it('does not replace an ambiguous saved child with its root or a positional sibling', async () => {
    const h = await harness('- [ ] C\n  - [ ] Same\n  - [ ] Same\n- [ ] B 🆔 b\n', 'C');
    const before = h.node('C').root;
    h.state.set('taskStack', [before, expectDefined(before.subtasks[1])]);
    h.state.openInspectorDependency(h.node('B'));
    const selected = h.state.get('taskStack');
    const history = h.state.get('inspectorBackStack');
    await h.api.execute({
      type: 'set-description',
      target: h.node('C').target,
      text: 'Shift children',
    });
    button(h.el, '[aria-label="Back to previous task"]').click();
    expect(h.state.get('taskStack')).toBe(selected);
    expect(h.state.get('inspectorBackStack')).toBe(history);
  });

  it.each(['deleted', 'duplicated'] as const)(
    'keeps the current task and saved frame when the actual prior root is %s',
    async (change) => {
      const h = await harness(source, 'C');
      const messages: string[] = [];
      notices(messages);
      const original = h.node('C').root;
      button(h.el, '.abyss-dep-title').click();
      const selected = h.state.get('taskStack');
      const history = h.state.get('inspectorBackStack');
      if (change === 'deleted') {
        expect((await h.api.execute({ type: 'delete', ref: original.ref })).type).toBe('ok');
      } else {
        await h.app.vault.modify(h.file, `\n${source}- [ ] C ⛔ b\n`);
        await flushMicrotasks(20);
      }
      button(h.el, '[aria-label="Back to previous task"]').click();
      expect(h.state.get('taskStack')).toBe(selected);
      expect(h.state.get('inspectorBackStack')).toBe(history);
      expect(messages[0]).toContain('previous task');
    },
  );
});

describe('TaskModal dependency selection', () => {
  it.each([
    ['nested', '- [ ] Parent\n  - [ ] Current\n  - [ ] Current\n- [ ] Candidate 🆔 candidate\n'],
    [
      'deep',
      '- [ ] Parent\n  - [ ] Middle\n    - [ ] Current\n    - [ ] Current\n- [ ] Candidate 🆔 candidate\n',
    ],
    ...['first', 'middle', 'last'].flatMap((position) => [
      [
        `three-root ${position} nested`,
        `${'- [ ] Parent\n  - [ ] Current\n  - [ ] Current\n'.repeat(3)}- [ ] Candidate 🆔 candidate\n`,
      ],
      [
        `three-root ${position} deep`,
        `${'- [ ] Parent\n  - [ ] Middle\n    - [ ] Current\n    - [ ] Current\n'.repeat(3)}- [ ] Candidate 🆔 candidate\n`,
      ],
    ]),
  ])(
    'retains the exact %s duplicate through add, remove and restore dependency events',
    async (_location, source) => {
      const h = await harness(source, 'Parent');
      h.panel.destroy();
      const modal = new TaskModal(h.app, testStatusRegistry(), DEFAULT_SETTINGS, h.index, h.api);
      cleanups.unshift(() => {
        modal.close();
      });
      const rootPosition = modalRootPosition(_location);
      modal.open(expectDefined(h.index.list({ filePath: 'tasks.md' })[rootPosition]));
      const el = expectDefined(activeDocument.querySelector<HTMLElement>('.abyss-modal-body'));
      if (_location.endsWith('deep')) button(el, '.abyss-subtask-label').click();
      const duplicates = el.querySelectorAll<HTMLElement>('.abyss-subtask-label');
      expectDefined(duplicates[1]).click();
      expect(el.querySelector('.abyss-right-title')?.textContent).toBe('Current');
      button(el, '.abyss-dep-badge-add').click();
      button(el, '[aria-label="Add dependency: Blocked by"]').click();
      const input = search(el, 'Candidate');
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await flushMicrotasks(30);
      expect(el.querySelector('.abyss-right-title')?.textContent).toBe('Current');
      expect(button(el, '.abyss-dep-badge-body').getAttribute('aria-label')).toBe(
        'Dependencies: blocked by 1; blocks 0',
      );
      const current = expectDefined(
        h.index
          .listNodes()
          .find(({ node }) => node.title === 'Current' && node.dependsOn.includes('candidate')),
      );
      const removed = await h.api.execute({
        type: 'remove-dependency',
        dependent: current.target,
        dependencyId: 'candidate',
      });
      if (
        removed.type !== 'ok' ||
        removed.outcome.type !== 'dependency' ||
        removed.outcome.removalRecovery === undefined
      )
        throw new Error('Expected dependency removal');
      await flushMicrotasks(30);
      expect(el.querySelector('.abyss-right-title')?.textContent).toBe('Current');
      expect(
        (
          await h.api.execute({
            type: 'restore-dependency',
            dependent: removed.outcome.dependent.target,
            recovery: removed.outcome.removalRecovery,
          })
        ).type,
      ).toBe('ok');
      await flushMicrotasks(30);
      expect(el.querySelector('.abyss-right-title')?.textContent).toBe('Current');
      expect(button(el, '.abyss-dep-badge-body').getAttribute('aria-label')).toBe(
        'Dependencies: blocked by 1; blocks 0',
      );
    },
  );

  it('does not preserve duplicate selection through an unrelated structural authority transition', async () => {
    const h = await harness('- [ ] Parent\n  - [ ] Current\n  - [ ] Current\n', 'Parent');
    h.panel.destroy();
    const modal = new TaskModal(h.app, testStatusRegistry(), DEFAULT_SETTINGS, h.index, h.api);
    cleanups.unshift(() => {
      modal.close();
    });
    modal.open(h.node('Parent').root);
    const el = expectDefined(activeDocument.querySelector<HTMLElement>('.abyss-modal-body'));
    expectDefined(el.querySelectorAll<HTMLElement>('.abyss-subtask-label')[1]).click();
    const first = h.node('Current').target;
    if (first.type !== 'subtask') throw new Error('Expected nested task');

    expect((await h.api.execute({ type: 'delete-subtask', subtask: first.ref })).type).toBe('ok');
    await flushMicrotasks(30);

    expect(el.querySelector('.abyss-right-title')?.textContent).toBe('Parent');
    expect(await h.read()).toBe('- [ ] Parent\n  - [ ] Current\n');
  });
});

describe('RightPanel dependency inspector', () => {
  it.each([
    {
      location: 'root',
      source: '- [ ] Current\n- [ ] Current\n- [ ] Candidate 🆔 candidate\n',
      wanted: '- [ ] Current\n- [ ] Current ⛔ candidate\n- [ ] Candidate 🆔 candidate\n',
    },
    {
      location: 'nested',
      source: '- [ ] Parent\n  - [ ] Current\n  - [ ] Current\n- [ ] Candidate 🆔 candidate\n',
      wanted:
        '- [ ] Parent\n  - [ ] Current\n  - [ ] Current ⛔ candidate\n- [ ] Candidate 🆔 candidate\n',
    },
    {
      location: 'deep',
      source:
        '- [ ] Parent\n  - [ ] Middle\n    - [ ] Current\n    - [ ] Current\n- [ ] Candidate 🆔 candidate\n',
      wanted:
        '- [ ] Parent\n  - [ ] Middle\n    - [ ] Current\n    - [ ] Current ⛔ candidate\n- [ ] Candidate 🆔 candidate\n',
    },
  ])(
    'keeps exact $location duplicate identity in shared selection and inspector actions',
    async ({ source, wanted }) => {
      const h = await harness(source);
      const selected = expectDefined(
        h.index.listNodes().filter(({ node }) => node.title === 'Current')[1],
      );
      const stack = [selected.root, ...selected.path];
      expect(rebuildTaskSelection(selected.root, stack)).toEqual(stack);
      h.state.set('taskStack', stack);
      const execute = vi.spyOn(h.api, 'execute');
      button(h.el, '.abyss-dep-badge-add').click();
      button(h.el, '[aria-label="Add dependency: Blocked by"]').click();
      const input = search(h.el, 'Candidate');
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await flushMicrotasks(50);
      expect(await execute.mock.results[0]?.value).toMatchObject({ type: 'ok' });
      expect(await h.read()).toBe(wanted);
      expect(button(h.el, '.abyss-dep-badge-body').getAttribute('aria-label')).toBe(
        'Dependencies: blocked by 1; blocks 0',
      );
    },
  );

  it('does not rebind a stale nested selection to either newly ambiguous sibling', async () => {
    const h = await harness('- [ ] Parent\n  - [ ] Current\n- [ ] Candidate 🆔 candidate\n');
    const changed =
      '\n- [ ] Parent\n  - [ ] Current\n  - [ ] Current\n- [ ] Candidate 🆔 candidate\n';
    await h.app.vault.modify(h.file, changed);
    await flushMicrotasks(20);
    const oldBadge = h.el.querySelector<HTMLButtonElement>('.abyss-dep-badge-body');
    oldBadge?.click();
    expect(h.el.querySelectorAll('.abyss-dep-search-option:not([disabled])')).toHaveLength(0);
    expect(await h.read()).toBe(changed.slice(1));
  });

  it.each(['focus', 'success', 'destroy', 'selection', 'refresh'] as const)(
    'releases search document listeners after %s',
    async (mode) => {
      const h = await harness('- [ ] Current\n- [ ] Candidate\n');
      const add = vi.spyOn(h.el.ownerDocument, 'addEventListener');
      const remove = vi.spyOn(h.el.ownerDocument, 'removeEventListener');
      button(h.el, '.abyss-dep-badge-body').click();
      const input = search(h.el, 'Candidate');
      if (mode === 'focus') activeDocument.body.createEl('button').focus();
      if (mode === 'destroy') h.panel.destroy();
      if (mode === 'selection') h.state.set('taskStack', [h.node('Candidate').root]);
      if (mode === 'success') {
        button(h.el, '[data-direction="blocks"]').click();
        button(h.el, '.abyss-dep-search-option').click();
        await flushMicrotasks(50);
      }
      if (mode === 'refresh') {
        h.state.set('taskStack', [h.node('Current').root]);
        expect(h.el.querySelector('.abyss-dep-search input')).toBe(input);
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      }
      const owned = add.mock.calls.filter(([type]) =>
        ['scroll', 'focusin', 'pointerdown'].includes(type),
      );
      expect(owned.length).toBeGreaterThan(0);
      for (const [type, listener] of owned)
        expect(
          remove.mock.calls.filter(
            ([removedType, removedListener]) =>
              removedType === type && removedListener === listener,
          ),
        ).toHaveLength(1);
    },
  );

  it('releases search positioning listeners on Escape, including repeated open and close', async () => {
    const h = await harness('- [ ] Current\n- [ ] Candidate\n');
    const add = vi.spyOn(h.el.ownerDocument, 'addEventListener');
    const remove = vi.spyOn(h.el.ownerDocument, 'removeEventListener');
    for (let count = 0; count < 2; count++) {
      button(h.el, '.abyss-dep-badge-body').click();
      search(h.el, '').dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    }
    const scrollCallbacks = add.mock.calls
      .filter(([type]) => type === 'scroll')
      .map(([, callback]) => callback);
    expect(scrollCallbacks.length).toBeGreaterThan(0);
    for (const callback of scrollCallbacks)
      expect(
        remove.mock.calls.some(([type, listener]) => type === 'scroll' && listener === callback),
      ).toBe(true);
  });

  it('keeps remove actions in the row flow with hover, focus and coarse-pointer access', async () => {
    if (!Platform.isDesktop) throw new Error('CSS fixture needs desktop runtime');
    const fs = await import('node:fs');
    const css = expandCompoundSelectorLists(
      fs.readFileSync(`${import.meta.dirname}/../styles.css`, 'utf8'),
    );
    const value = (selector: string, property: string) =>
      cssDeclarationValue(cssDeclarationsFor(css, selector), property);
    expect(value('.abyss-dep-remove', 'opacity')).toBe('0');
    expect(value('.abyss-dep-remove', 'position')).not.toBe('absolute');
    expect(value('.abyss-dep-row:hover .abyss-dep-remove', 'opacity')).toBe('1');
    expect(value('.abyss-dep-row:focus-within .abyss-dep-remove', 'opacity')).toBe('1');
    expect(value('.abyss-dep-row.is-unavailable .abyss-dep-remove', 'opacity')).toBe('1');
    expect(value('.abyss-dep-title', 'text-overflow')).toBe('ellipsis');
    for (const selector of [
      '.abyss-dep-row .abyss-dep-remove',
      '.abyss-dep-section .abyss-dep-add',
      '.abyss-dep-search .abyss-dep-search-option',
    ])
      expect(value(selector, 'background')).toBe('transparent');
    expect(css).toMatch(
      /@media\s*\(pointer: coarse\)\s*\{\s*\.abyss-dep-remove\s*\{\s*opacity: 1;/u,
    );
  });

  it('renders a chrome-free compact dependency control with complete accessible names', async () => {
    const h = await harness('- [ ] Current\n- [ ] Candidate\n');
    const badge = expectDefined(h.el.querySelector<HTMLElement>('.abyss-dep-badge'));
    const body = button(badge, '.abyss-dep-badge-body');
    const plus = button(badge, '.abyss-dep-badge-add');

    expect([...body.children].map((child) => child.className)).toEqual([
      'abyss-dep-lock',
      'abyss-dep-count-blocked-by',
      'abyss-dep-divider',
      'abyss-dep-count-blocks',
    ]);
    expect(body.textContent).toBe('00');
    expect(body.querySelector('.abyss-dep-divider')?.textContent).toBe('');
    expect(body.getAttribute('aria-label')).toBe('Dependencies: blocked by 0; blocks 0');
    expect(body.title).toBe('Dependencies: blocked by 0; blocks 0');
    expect(plus.parentElement).toBe(badge);
    expect(body.contains(plus)).toBe(false);
    expect(plus.getAttribute('aria-label')).toBe('Add dependency sections');
    expect(plus.title).toBe('Add dependency');
  });

  it('opens the general picker blocked-by with a direction selector and fixes section pickers', async () => {
    const h = await harness('- [ ] Current\n- [ ] Candidate\n');
    button(h.el, '.abyss-dep-badge-body').click();
    expect(button(h.el, '[data-direction="blocked-by"]').getAttribute('aria-pressed')).toBe('true');
    expect(button(h.el, '[data-direction="blocks"]').getAttribute('aria-pressed')).toBe('false');
    button(h.el, '[data-direction="blocks"]').click();
    expect(button(h.el, '[data-direction="blocks"]').getAttribute('aria-pressed')).toBe('true');
    search(h.el, '').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

    button(h.el, '.abyss-dep-badge-add').click();
    button(h.el, '[aria-label="Add dependency: Blocks"]').click();
    expect(h.el.querySelector('[aria-label="Dependency direction"]')).toBeNull();
  });

  it('keeps unavailable creation inline without running a task command or showing a Notice', async () => {
    const captured = notices();
    const h = await harness('- [ ] Current\n- [ ] Candidate\n');
    const execute = vi.spyOn(h.api, 'execute');
    button(h.el, '.abyss-dep-badge-body').click();
    const input = search(h.el, 'Brand new');
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await flushMicrotasks();

    expect(h.el.querySelector('[role="status"]')?.textContent).toBe(
      'Creating a new dependency is not available yet.',
    );
    expect(input.value).toBe('Brand new');
    expect(activeDocument.activeElement).toBe(input);
    expect(execute).not.toHaveBeenCalled();
    expect(captured).toHaveLength(0);
    expect(await h.read()).toBe('- [ ] Current\n- [ ] Candidate\n');
  });

  it('keeps shared chip sizing and interaction rhythm without dependency pill chrome', async () => {
    if (!Platform.isDesktop) throw new Error('CSS fixture needs desktop runtime');
    const fs = await import('node:fs');
    const css = expandCompoundSelectorLists(
      fs.readFileSync(`${import.meta.dirname}/../styles.css`, 'utf8'),
    );
    const value = (selector: string, property: string) =>
      cssDeclarationValue(cssDeclarationsFor(css, selector), property);

    expect(value('.abyss-chip', 'height')).toBe('24px');
    expect(value('.abyss-chip', 'font-size')).toBe('var(--font-ui-smaller)');
    expect(value('.abyss-dep-badge.abyss-chip', 'height')).toBe('24px');
    expect(value('.abyss-dep-badge.abyss-chip', 'border')).toBe('0');
    expect(value('.abyss-dep-badge.abyss-chip', 'background')).toBe('transparent');
    expect(value('.abyss-dep-badge > button', 'height')).toBe('24px');
    expect(value('.abyss-dep-badge > button', 'gap')).toBe('4px');
    expect(value('.abyss-dep-badge > button', 'font')).toBe('inherit');
    expect(value('.abyss-dep-lock', 'color')).toBe('var(--text-muted)');
    expect(value('.abyss-dep-count-blocked-by', 'color')).toBe(
      'var(--abyss-dependency-blocked-by)',
    );
    expect(value('.abyss-dep-count-blocks', 'color')).toBe('var(--abyss-dependency-blocks)');
    expect(value('.abyss-dep-badge > button:hover', 'background')).toBe(
      'var(--background-modifier-hover)',
    );
    expect(value('.abyss-dep-badge > button:focus-visible', 'outline')).toBe(
      '2px solid var(--interactive-accent)',
    );
  });

  it('keeps a search draft through a proven selection refresh and drops it on another task', async () => {
    const h = await harness('- [ ] Current\n- [ ] Candidate\n');
    button(h.el, '.abyss-dep-badge-body').click();
    const input = search(h.el, 'Candidate');
    button(h.el, '[data-direction="blocks"]').click();
    input.focus();
    h.state.set('taskStack', [h.node('Current').root]);
    expect(h.el.querySelectorAll('[data-direction]')).toHaveLength(2);
    expect(button(h.el, '[data-direction="blocks"]').getAttribute('aria-pressed')).toBe('true');
    expect(activeDocument.activeElement).toBe(input);
    await h.api.execute({
      type: 'patch',
      target: { type: 'task', ref: h.node('Current').root.ref },
      patch: { priority: { type: 'set', value: 'A' } },
    });
    h.state.set('taskStack', [h.node('Current').root]);
    expect(h.el.querySelector('.abyss-dep-search input')).toBe(input);
    expect(input.value).toBe('Candidate');
    expect(activeDocument.activeElement).toBe(input);
    h.state.set('taskStack', [h.node('Candidate').root]);
    expect(h.el.querySelector('.abyss-dep-search')).toBeNull();
  });

  it.each([
    { location: 'task header', selected: 'Current', selector: '.abyss-right-header' },
    { location: 'nested header', selected: 'Child', selector: '.abyss-right-header' },
    { location: 'subtask row', selected: 'Current', selector: '.abyss-subtask-row' },
  ])(
    'retains $location status focus through prerequisite selection reconciliation',
    async ({ selected, selector }) => {
      const h = await harness(
        '- [ ] Current ⛔ blocker\n  - [ ] Child ⛔ blocker\n- [ ] Blocker 🆔 blocker\n',
        selected,
      );
      cleanups.unshift(
        h.index.subscribe(() => {
          const current = h.node(selected);
          h.state.updateInspectorSelection([current.root, ...current.path]);
        }),
      );
      const status = () => button(h.el, `${selector} [role="checkbox"]`);
      let control = status();
      control.focus();
      expect(h.el.ownerDocument.activeElement).toBe(control);
      expect(control.getAttribute('aria-disabled')).toBe('true');

      for (const blocked of [false, true]) {
        expect(
          await h.api.execute({ type: 'toggle-completion', target: h.node('Blocker').target }),
        ).toMatchObject({ type: 'ok' });
        await flushMicrotasks();
        expect(control.isConnected).toBe(false);
        control = status();
        expect(h.el.ownerDocument.activeElement).toBe(control);
        expect(control.classList.contains('abyss-status-control')).toBe(blocked);
        expect(control.getAttribute('aria-disabled')).toBe(blocked ? 'true' : null);
        expect(h.el.querySelectorAll(`${selector} [role="checkbox"][tabindex="0"]`)).toHaveLength(
          1,
        );
      }
    },
  );

  it.each(['Child', 'Blocker', undefined])(
    'does not transfer status focus when navigating to %s',
    async (selected) => {
      const h = await harness(
        '- [ ] Current ⛔ blocker\n  - [ ] Child\n- [ ] Blocker 🆔 blocker\n',
      );
      button(h.el, '.abyss-right-header [role="checkbox"]').focus();
      const destination = selected === undefined ? undefined : h.node(selected);

      h.state.updateInspectorSelection(
        destination === undefined ? [] : [destination.root, ...destination.path],
      );

      expect(h.el.ownerDocument.activeElement).toBe(h.el.ownerDocument.body);
    },
  );

  it('leaves outside focus in place when refreshing the selected task', async () => {
    const h = await harness('- [ ] Current ⛔ blocker\n- [ ] Blocker 🆔 blocker\n');
    const outside = h.el.ownerDocument.body.createEl('button');
    outside.focus();

    h.state.updateInspectorSelection([h.node('Current').root]);

    expect(h.el.ownerDocument.activeElement).toBe(outside);
  });

  it('reconciles counterpart completion and missing IDs through normal index events without discarding an editing draft', async () => {
    const h = await harness('- [ ] Current ⛔ blocker\n- [ ] Blocker 🆔 blocker\n');
    button(h.el, '.abyss-dep-badge-body').click();
    const input = search(h.el, 'Keep this query');
    await h.api.execute({ type: 'toggle-completion', target: h.node('Blocker').target });
    await flushMicrotasks();
    expect(button(h.el, '.abyss-dep-badge-body').getAttribute('aria-label')).toBe(
      'Dependencies: blocked by 0; blocks 0',
    );
    expect(h.el.querySelector('.abyss-dep-row .is-done')).not.toBeNull();
    expect(input.value).toBe('Keep this query');
    await h.app.vault.modify(h.file, '\n- [ ] Current ⛔ blocker\n');
    await flushMicrotasks(20);
    expect(h.el.querySelector('.abyss-dep-row')?.textContent).toBe('Task unavailableblocker');
  });

  it('renders compact direct relations in order with done and raw-ID recovery rows', async () => {
    const h = await harness(
      '- [ ] Current 🆔 current ⛔ active, done, missing, duplicate\n  - > Own description\n- [ ] Active 🆔 active\n  - > Hidden prerequisite description\n- [x] Done 🆔 done\n- [ ] First 🆔 duplicate\n- [x] Second 🆔 duplicate\n- [ ] Waiting ⛔ current\n',
    );
    expect(h.node('Active').node.description).toBe('Hidden prerequisite description');
    expect(h.el.textContent).toContain('Own description');
    expect(labels(h.el)).toEqual(['Description', 'Blocked by', 'Blocks', 'Sub-tasks', 'Comments']);
    expect(button(h.el, '.abyss-dep-badge-body').getAttribute('aria-label')).toBe(
      'Dependencies: blocked by 2; blocks 1',
    );
    expect(h.el.querySelector('.abyss-dep-badge-add')).toBeNull();
    const rows = [...h.el.querySelectorAll('.abyss-dep-row')];
    expect(rows.map((row) => row.textContent)).toEqual([
      'Active',
      'Done',
      'Task unavailablemissing',
      'Multiple tasks use this IDduplicate',
      'Waiting',
    ]);
    expect(rows[1]?.querySelector('.abyss-subtask-label.is-done')).not.toBeNull();
    expect(rows[1]?.querySelector('[data-status-type="done"]')).not.toBeNull();
    expect(rows[2]?.classList.contains('is-unavailable')).toBe(true);
    expect(rows[3]?.getAttribute('data-state')).toBe('active');
    expect(rows[2]?.querySelector('[aria-label="Remove unavailable dependency"]')).not.toBeNull();
    expect(rows[3]?.querySelector('[aria-label="Remove ambiguous dependency"]')).not.toBeNull();
    expect(h.el.textContent).not.toContain('Hidden prerequisite description');
    for (const section of h.el.querySelectorAll('.abyss-dep-section'))
      expect(section.lastElementChild?.textContent).toBe('+Add dependency');
  });

  it('latches top-plus disclosure through search, focus and drag changes until selection changes', async () => {
    const h = await harness('- [ ] Current\n- [ ] Candidate\n');
    expect(labels(h.el)).toEqual(['Description', 'Sub-tasks', 'Comments']);
    const badge = button(h.el, '.abyss-dep-badge-body');
    const plus = button(h.el, '.abyss-dep-badge-add');
    expect([badge.tabIndex, plus.tabIndex]).toEqual([0, 0]);
    badge.click();
    expect(h.el.querySelector('.abyss-dep-search')).not.toBeNull();
    expect(labels(h.el)).toEqual(['Description', 'Sub-tasks', 'Comments']);
    search(h.el, '').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(activeDocument.activeElement).toBe(badge);
    plus.click();
    expect(labels(h.el)).toEqual(['Description', 'Blocked by', 'Blocks', 'Sub-tasks', 'Comments']);
    expect(h.el.querySelector('.abyss-dep-search')).toBeNull();
    expect(h.el.querySelector('.abyss-dep-badge-add')).toBeNull();
    button(h.el, '[aria-label="Add dependency: Blocked by"]').click();
    search(h.el, '').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(labels(h.el)).toEqual(['Description', 'Blocked by', 'Blocks', 'Sub-tasks', 'Comments']);
    const outside = activeDocument.body.createEl('button');
    outside.focus();
    await flushMicrotasks();
    expect(labels(h.el)).toEqual(['Description', 'Blocked by', 'Blocks', 'Sub-tasks', 'Comments']);
    expect(activeDocument.activeElement).toBe(outside);
    h.state.set('draggingTaskNode', { source: 'center-card', task: h.node('Candidate') });
    expect(labels(h.el)).toEqual(['Description', 'Blocked by', 'Blocks', 'Sub-tasks', 'Comments']);
    h.state.set('draggingTaskNode', null);
    expect(labels(h.el)).toEqual(['Description', 'Blocked by', 'Blocks', 'Sub-tasks', 'Comments']);

    h.state.set('taskStack', [h.node('Candidate').root]);

    expect(labels(h.el)).toEqual(['Description', 'Sub-tasks', 'Comments']);
    expect(h.el.querySelector('.abyss-dep-badge-add')).not.toBeNull();
  });

  it('temporarily discloses both empty sections only for a center-card drag', async () => {
    const h = await harness('- [ ] Current\n  - [ ] Child\n- [ ] Candidate\n');
    expect(labels(h.el)).toEqual(['Description', 'Sub-tasks', 'Comments']);

    h.state.set('draggingTaskNode', { source: 'center-card', task: h.node('Candidate') });
    expect(labels(h.el)).toEqual(['Description', 'Blocked by', 'Blocks', 'Sub-tasks', 'Comments']);
    h.state.set('draggingTaskNode', null);
    expect(labels(h.el)).toEqual(['Description', 'Sub-tasks', 'Comments']);

    h.state.set('draggingTaskNode', { source: 'inspector-subtask', task: h.node('Child') });
    expect(labels(h.el)).toEqual(['Description', 'Sub-tasks', 'Comments']);
    h.state.set('draggingTaskNode', null);
  });

  it('latches both directions after observing one relation and keeps them after final removal', async () => {
    notices();
    const h = await harness('- [ ] Current ⛔ blocker\n- [ ] Blocker 🆔 blocker\n');
    expect(labels(h.el)).toEqual(['Description', 'Blocked by', 'Blocks', 'Sub-tasks', 'Comments']);

    button(h.el, '.abyss-dep-remove').click();
    await flushMicrotasks(50);

    expect(h.el.querySelector('.abyss-dep-row')).toBeNull();
    expect(labels(h.el)).toEqual(['Description', 'Blocked by', 'Blocks', 'Sub-tasks', 'Comments']);
    expect(h.el.querySelector('.abyss-dep-badge-add')).toBeNull();
  });

  it.each(['blocked-by', 'blocks'] as const)(
    'adds from the %s section through the real command and offers Undo',
    async (direction) => {
      const captured = notices();
      const h = await harness('- [ ] Current\n- [ ] Candidate\n');
      button(h.el, '.abyss-dep-badge-add').click();
      button(h.el, `[data-dependency-direction="${direction}"] .abyss-dep-add`).click();
      expect(h.el.querySelector('[aria-label="Dependency direction"]')).toBeNull();
      const input = search(h.el, 'Candidate');
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await flushMicrotasks(50);
      expect(await h.read()).toContain(
        direction === 'blocked-by' ? 'Current ⛔ generate' : 'Candidate ⛔ generate',
      );
      expect(h.el.querySelector('.abyss-dep-search')).toBeNull();
      expect(h.el.querySelectorAll('.abyss-dep-section')).toHaveLength(2);
      expect(h.el.querySelector('.abyss-dep-row')?.textContent).toBe('Candidate');
      expect(captured).toHaveLength(1);
      button(activeDocument.body, '.mod-cta').click();
      await flushMicrotasks(50);
      expect(await h.read()).not.toContain('⛔');
      expect(await h.read()).toContain('🆔 generate');
      expect(h.el.querySelectorAll('.abyss-dep-section')).toHaveLength(2);
    },
  );

  it.each([
    ['Current', 'Blocked by'],
    ['Prerequisite', 'Blocks'],
  ])(
    'removes against the actual dependent from %s / %s and restores exact metadata',
    async (selected) => {
      const markdown =
        '- [ ] Current ⛔ prerequisite, prerequisite\n- [ ] Prerequisite 🆔 prerequisite\n';
      const captured = notices();
      const h = await harness(markdown, selected);
      button(h.el, '.abyss-dep-remove').click();
      await flushMicrotasks(50);
      expect(await h.read()).toBe('- [ ] Current\n- [ ] Prerequisite 🆔 prerequisite\n');
      expect(captured).toHaveLength(1);
      button(activeDocument.body, '.mod-cta').click();
      await flushMicrotasks(50);
      expect(await h.read()).toBe(markdown);
    },
  );

  it.each([
    ['missing', 'Remove unavailable dependency', ''],
    [
      'duplicate',
      'Remove ambiguous dependency',
      '- [ ] One 🆔 duplicate\n- [ ] Two 🆔 duplicate\n',
    ],
  ])(
    'removes and undoes %s by raw ID without requiring a unique blocker',
    async (id, label, tail) => {
      notices();
      const markdown = `- [ ] Current ⛔ ${id}, ${id}\n${tail}`;
      const h = await harness(markdown);
      button(h.el, `[aria-label="${label}"]`).click();
      await flushMicrotasks(50);
      expect(await h.read()).toBe(`- [ ] Current\n${tail}`);
      button(activeDocument.body, '.mod-cta').click();
      await flushMicrotasks(50);
      expect(await h.read()).toBe(markdown);
    },
  );

  it.each(['conflict', 'not-found', 'invalid', 'blocked', 'io-error'] as const)(
    'keeps search and draft after %s with exactly one Notice',
    async (type) => {
      const captured = notices();
      const h = await harness('- [ ] Current\n- [ ] Candidate\n');
      const target = h.node('Current').target;
      const results: Record<typeof type, TaskCommandResult> = {
        conflict: { type: 'conflict', current: h.node('Current').root },
        'not-found': { type: 'not-found', target },
        invalid: { type: 'invalid', issues: [] },
        blocked: { type: 'blocked', target, blockers: [] },
        'io-error': { type: 'io-error', cause: 'repository-error', contentState: 'unknown' },
      };
      vi.spyOn(h.api, 'execute').mockResolvedValue(results[type]);
      button(h.el, '.abyss-dep-badge-body').click();
      search(h.el, 'Candidate');
      button(h.el, '[data-direction="blocks"]').click();
      button(h.el, '.abyss-dep-search-option').click();
      await flushMicrotasks(20);
      expect(h.el.querySelector('.abyss-dep-search input')).toHaveProperty('value', 'Candidate');
      expect(h.el.querySelectorAll('.abyss-dep-row')).toHaveLength(0);
      expect(captured).toHaveLength(1);
      expect(await h.read()).toBe('- [ ] Current\n- [ ] Candidate\n');
    },
  );

  it('logs one unexpected handler failure and keeps the search and authoritative relations', async () => {
    const captured = notices();
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const h = await harness('- [ ] Current\n- [ ] Candidate\n');
    vi.spyOn(h.api, 'execute').mockRejectedValue(new Error('Unexpected'));
    button(h.el, '.abyss-dep-badge-body').click();
    search(h.el, 'Candidate');
    button(h.el, '[data-direction="blocks"]').click();
    button(h.el, '.abyss-dep-search-option').click();
    await flushMicrotasks(20);
    expect(log).toHaveBeenCalledOnce();
    expect(log.mock.calls[0]?.[0]).toContain('[abyss-tasks]');
    expect(captured).toHaveLength(1);
    expect(h.el.querySelector('.abyss-dep-search input')).toHaveProperty('value', 'Candidate');
    expect(h.el.querySelectorAll('.abyss-dep-row')).toHaveLength(0);
  });
});
