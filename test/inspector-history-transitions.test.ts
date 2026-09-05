import { Notice, TFile, WorkspaceLeaf, type App } from 'obsidian';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppState } from '../src/app/AppState';
import type { RightPanel } from '../src/panels/RightPanel';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import { TagManager } from '../src/tags/TagManager';
import type { TaskApplicationApi, TaskCaptureApplicationApi } from '../src/tasks';
import { TaskModal } from '../src/ui/TaskModal';
import { PanelView } from '../src/views/PanelView';
import {
  configuredTaskApplication,
  createAppWithFiles,
  expectDefined,
  flushMicrotasks,
  useRealMoment,
} from './helpers';

useRealMoment();
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  activeDocument.body.empty();
  vi.restoreAllMocks();
});

async function harness(surface: 'panel' | 'modal', source: string, selected: string) {
  const app = await createAppWithFiles({ 'tasks.md': `\n${source}` });
  const application = configuredTaskApplication(app, DEFAULT_SETTINGS, { authority: true });
  await application.index.initialize();
  const node = (title: string) =>
    expectDefined(application.index.listNodes().find(({ node }) => node.title === title));
  let state: AppState;
  let panel: RightPanel;
  let el: HTMLElement;
  if (surface === 'panel') {
    const leaf = new (WorkspaceLeaf as unknown as { new (app: App): WorkspaceLeaf })(app);
    const view = new PanelView(
      leaf,
      DEFAULT_SETTINGS,
      new TagManager(app, DEFAULT_SETTINGS, async () => {}),
      application.index,
      application.tasks as TaskApplicationApi & TaskCaptureApplicationApi,
      application.statusRegistry,
    );
    activeDocument.body.append(view.containerEl);
    await view.onOpen();
    const local = view as unknown as {
      state_abyssPrivate: AppState;
      right_abyssPrivate: RightPanel;
    };
    state = local.state_abyssPrivate;
    panel = local.right_abyssPrivate;
    el = expectDefined(view.contentEl.querySelector<HTMLElement>('.abyss-right'));
    cleanups.push(async () => {
      await view.onClose();
      view.containerEl.remove();
    });
  } else {
    const modal = new TaskModal(
      app,
      application.statusRegistry,
      DEFAULT_SETTINGS,
      application.index,
      application.tasks,
    );
    modal.open(node(selected).root);
    const local = modal as unknown as { innerState: AppState; innerPanel: RightPanel };
    state = local.innerState;
    panel = local.innerPanel;
    el = expectDefined(activeDocument.querySelector<HTMLElement>('.abyss-modal-body'));
    cleanups.push(() => {
      modal.close();
    });
  }
  cleanups.push(() => {
    application.index.destroy();
  });
  const initial = node(selected);
  state.set('taskStack', [initial.root, ...initial.path]);
  const click = (selector: string) => {
    expectDefined(el.querySelector<HTMLElement>(selector)).click();
  };
  const liveStack = (title: string) => {
    const current = node(title);
    return [current.root, ...current.path];
  };
  return { ...application, app, state, panel, el, node, click, liveStack };
}

const back = '[aria-label="Back to previous task"]';
const forward = '[data-dependency-direction="blocked-by"] .abyss-dep-title';
const inverse = '[data-dependency-direction="blocks"] .abyss-dep-title';

describe.each(['panel', 'modal'] as const)('%s saved dependency frames', (surface) => {
  it.each([
    ['nested', '- [ ] A\n  - [ ] A.1 🆔 a ⛔ b\n- [ ] B 🆔 b\n', ['A', 'A.1']],
    [
      'deep',
      '- [ ] A\n  - [ ] Middle\n    - [ ] A.1 🆔 a ⛔ b\n- [ ] B 🆔 b\n',
      ['A', 'Middle', 'A.1'],
    ],
  ] as const)(
    'restores the complete live %s frame after removing its edge from the inverse row',
    async (_name, source, titles) => {
      const h = await harness(surface, source, 'A.1');
      h.click(forward);
      const original = h.state.get('inspectorBackStack');
      const originalJSON = JSON.stringify(original);
      h.click('[data-dependency-direction="blocks"] .abyss-dep-remove');
      await flushMicrotasks(40);
      const file = h.app.vault.getAbstractFileByPath('tasks.md');
      if (!(file instanceof TFile)) throw new Error('Missing fixture');
      expect(await h.app.vault.read(file)).toBe(`\n${source.replace(' ⛔ b', '')}`);
      expect(h.node('A.1').node.dependsOn).toEqual([]);
      expect(h.state.get('taskStack')).toEqual(h.liveStack('B'));
      expect(h.state.get('inspectorBackStack')[0]?.taskStack).toEqual(h.liveStack('A.1'));
      expect(JSON.stringify(original)).toBe(originalJSON);
      expect(Object.isFrozen(original[0]?.taskStack)).toBe(true);
      h.click(back);
      expect(h.state.get('taskStack').map((node) => node.title)).toEqual(titles);
      expect(h.state.get('taskStack')).toEqual(h.liveStack('A.1'));
      expect(h.state.get('inspectorBackStack')).toEqual([]);
    },
  );

  it.each(['A.1', 'Deep', 'Sibling', 'A'])(
    'maintains multiple saved %s paths through repeated owned edits of an inverse target',
    async (origin) => {
      const source =
        '- [ ] A\n  - [ ] A.1 🆔 a ⛔ b\n    - [ ] Deep\n    - [ ] Sibling\n  - [ ] Other\n- [ ] B 🆔 b\n';
      const h = await harness(surface, source, origin);
      h.state.openInspectorDependency(h.node('B'));
      h.click(inverse);
      h.click(forward);
      h.click(inverse);
      const original = h.state.get('inspectorBackStack');
      const originalJSON = JSON.stringify(original);
      expect(original.map(({ taskStack }) => taskStack[taskStack.length - 1]?.title)).toEqual([
        origin,
        'B',
        'A.1',
        'B',
      ]);
      for (const title of ['Renamed A.1', 'Renamed again']) {
        h.click('.abyss-right-title-view');
        const editor = expectDefined(
          h.el.querySelector<HTMLTextAreaElement>('.abyss-right-title-edit'),
        );
        editor.value = title;
        editor.dispatchEvent(new Event('input', { bubbles: true }));
        editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        await flushMicrotasks(40);
        expect(h.state.get('taskStack')).toEqual(h.liveStack(title));
        expect(h.state.get('inspectorBackStack')[2]?.taskStack).toEqual(h.liveStack(title));
        expect(h.state.get('inspectorBackStack')[0]?.taskStack).toEqual(
          h.liveStack(origin === 'A.1' ? title : origin),
        );
      }
      for (const description of ['First\nSecond', 'First\nSecond\nThird']) {
        h.click('.abyss-right-desc-view');
        const editor = expectDefined(
          h.el.querySelector<HTMLTextAreaElement>('.abyss-right-desc-edit'),
        );
        editor.value = description;
        editor.dispatchEvent(new Event('input', { bubbles: true }));
        editor.dispatchEvent(new Event('blur'));
        await flushMicrotasks(40);
        expect(h.node('Renamed again').node.description).toBe(description);
        expect(h.state.get('taskStack')).toEqual(h.liveStack('Renamed again'));
        expect(h.state.get('inspectorBackStack').map(({ taskStack }) => taskStack)).toEqual([
          h.liveStack(origin === 'A.1' ? 'Renamed again' : origin),
          h.liveStack('B'),
          h.liveStack('Renamed again'),
          h.liveStack('B'),
        ]);
      }
      expect(JSON.stringify(original)).toBe(originalJSON);
      for (const target of [
        'B',
        'Renamed again',
        'B',
        origin === 'A.1' ? 'Renamed again' : origin,
      ]) {
        h.click(back);
        expect(h.state.get('taskStack')).toEqual(h.liveStack(target));
      }
      expect(h.state.get('inspectorBackStack')).toEqual([]);
    },
  );

  it('maintains a saved deep selected target through its owned title edit', async () => {
    const h = await harness(
      surface,
      '- [ ] A\n  - [ ] Middle\n    - [ ] A.1 🆔 a ⛔ b\n- [ ] B 🆔 b\n',
      'A.1',
    );
    h.click(forward);
    h.click(inverse);
    await h.panel.updateTaskTitle(h.node('A.1').node, 'Renamed');
    expect(h.state.get('taskStack').map((node) => node.title)).toEqual(['A', 'Middle', 'Renamed']);
    expect(h.state.get('inspectorBackStack')[0]?.taskStack).toEqual(h.liveStack('Renamed'));
    h.click(back);
    h.click(back);
    expect(h.state.get('taskStack')).toEqual(h.liveStack('Renamed'));
  });

  it.each(['unowned-title', 'delete', 'reorder', 'duplicate'] as const)(
    'retains a retryable saved nested frame after an unproven %s change',
    async (change) => {
      const source = '- [ ] A\n  - [ ] A.1 🆔 a ⛔ b\n  - [ ] Other\n- [ ] B 🆔 b\n';
      const h = await harness(surface, source, 'A.1');
      h.click(forward);
      const history = h.state.get('inspectorBackStack');
      const selected = h.node('A.1').target;
      if (selected.type !== 'subtask') throw new Error('Expected nested target');
      if (change === 'unowned-title') {
        await h.tasks.execute({
          type: 'patch',
          target: selected,
          patch: { markdownTitle: { type: 'set', value: 'Unowned rename' } },
        });
      } else if (change === 'delete') {
        await h.tasks.execute({ type: 'delete-subtask', subtask: selected.ref });
      } else {
        const file = h.app.vault.getAbstractFileByPath('tasks.md');
        if (!(file instanceof TFile)) throw new Error('Missing fixture');
        const content =
          change === 'duplicate'
            ? source.replace('  - [ ] Other', '  - [ ] A.1 🆔 a ⛔ b')
            : source.replace(
                '  - [ ] A.1 🆔 a ⛔ b\n  - [ ] Other',
                '  - [ ] Other\n  - [ ] A.1 🆔 a ⛔ b',
              );
        await h.app.vault.modify(file, `\n${content}`);
      }
      await flushMicrotasks(40);
      const beforeBack = h.state.get('taskStack');
      const notice = vi.spyOn(
        Notice.prototype as unknown as { constructor__(message: string): void },
        'constructor__',
      );
      h.click(back);
      expect(h.state.get('inspectorBackStack')).toBe(history);
      expect(h.state.get('taskStack')).toBe(beforeBack);
      expect(notice).toHaveBeenCalledOnce();
    },
  );

  it.each(['concurrent insertion', 'ambiguous selected sibling'] as const)(
    'does not grant an owned history successor through %s',
    async (change) => {
      const source = `- [ ] A\n  - [ ] A.1 🆔 a ⛔ b\n${change === 'ambiguous selected sibling' ? '  - [ ] A.1 🆔 a ⛔ b\n' : ''}- [ ] B 🆔 b\n`;
      const h = await harness(surface, source, 'A.1');
      h.click(forward);
      h.click(inverse);
      const original = h.state.get('inspectorBackStack');
      const originalJSON = JSON.stringify(original);
      if (change === 'concurrent insertion') {
        const execute = h.tasks.execute.bind(h.tasks);
        vi.spyOn(h.tasks, 'execute').mockImplementationOnce(async (command) => {
          await execute({ type: 'add-subtask', parent: h.node('A').target, text: 'Concurrent' });
          return execute(command);
        });
      }
      await h.panel.updateTaskTitle(h.node('A.1').node, 'Renamed');
      await flushMicrotasks(40);
      expect(h.node('Renamed').node.title).toBe('Renamed');
      expect(JSON.stringify(original)).toBe(originalJSON);
      expect(h.state.get('inspectorBackStack')[0]?.taskStack[1]?.title).toBe('A.1');
      h.click(back);
      const beforeBack = h.state.get('taskStack');
      const history = h.state.get('inspectorBackStack');
      h.click(back);
      expect(h.state.get('taskStack')).toBe(beforeBack);
      expect(h.state.get('inspectorBackStack')).toBe(history);
    },
  );
});
