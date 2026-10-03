import { WorkspaceLeaf, type App } from 'obsidian';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppState } from '../src/app/AppState';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import { TagManager } from '../src/tags/TagManager';
import type { TaskCommandResult } from '../src/tasks';
import { PanelView } from '../src/views/PanelView';
import {
  deferred,
  expectDefined,
  flushMicrotasks,
  testStatusRegistry,
  useRealMoment,
} from './helpers';
import { hierarchyHarness } from './support/taskHierarchyHarness';

useRealMoment();
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function compact() {
  const h = await hierarchyHarness({
    'source.md': '- [ ] Move\n  - [ ] Child\n    - [ ] Grandchild\n',
    'target.md': '- [ ] Parent\n',
  });
  const leaf = new (WorkspaceLeaf as unknown as { new (app: App): WorkspaceLeaf })(h.app);
  const tags = new TagManager(h.app, DEFAULT_SETTINGS, async () => {}, {
    check: () => 'ready',
    apply: async (_change, applyLive) => {
      applyLive();
    },
  });
  const run = h.service.execute.bind(h.service);
  const pending = deferred<TaskCommandResult>();
  const execute = vi.spyOn(h.service, 'execute').mockReturnValueOnce(pending.promise);
  const view = new PanelView(
    leaf,
    DEFAULT_SETTINGS,
    tags,
    h.index,
    h.service,
    testStatusRegistry(),
  );
  await view.onOpen();
  document.body.append(view.containerEl);
  const state = (view as unknown as { state_abyssPrivate: AppState }).state_abyssPrivate;
  state.set('mode', 'tasks');
  state.set('selectedList', 'inbox');
  const layout = expectDefined(view.contentEl.querySelector<HTMLElement>('.abyss-layout'));
  vi.spyOn(layout, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 390, 480));
  window.dispatchEvent(new Event('resize'));
  const right = expectDefined(layout.querySelector<HTMLElement>('.abyss-right'));
  const details = expectDefined(
    layout.querySelector<HTMLButtonElement>('[aria-label="Show task details"]'),
  );
  const child = expectDefined(h.source.subtasks[0]);
  const grand = expectDefined(child.subtasks[0]);
  state.set('taskStack', [h.source, child, grand]);
  if (right.classList.contains('is-compact-open')) details.click();
  details.click();
  expect(right.classList.contains('is-compact-open')).toBe(true);
  cleanups.push(async () => {
    await view.onClose();
    h.index.destroy();
    view.containerEl.remove();
  });
  return { ...h, run, view, state, right, details, child, grand, pending, execute };
}
function drag(surface: HTMLElement, type: string): void {
  surface.dispatchEvent(new Event(type, { bubbles: true, cancelable: true }));
}
describe('reachable hierarchy compact interactions', () => {
  it('dismisses explicit details on root pointerdown and leaves proven root-drop success hidden', async () => {
    const h = await compact();
    const card = (file: string) =>
      expectDefined(
        h.view.contentEl.querySelector<HTMLElement>(`.abyss-task-card[data-file-path="${file}"]`),
      );
    const source = card('source.md');
    const parent = card('target.md');
    source.dispatchEvent(
      new MouseEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 }),
    );
    expect(h.right.classList.contains('is-compact-open')).toBe(false);
    drag(source, 'dragstart');
    drag(parent, 'dragover');
    drag(parent, 'drop');
    const result = await h.run(h.command);
    await flushMicrotasks();
    expect(h.state.get('taskStack')).toEqual([]);
    h.pending.resolve(result);
    await flushMicrotasks(30);
    expect(h.state.get('taskStack').map((node) => node.title)).toEqual([
      'Parent',
      'Move',
      'Child',
      'Grandchild',
    ]);
    expect(h.right.classList.contains('is-compact-open')).toBe(false);
  });
  it.each([false, true])(
    'preserves compact visibility through early promotion publication with user hide=%s',
    async (hide) => {
      const h = await compact();
      expectDefined(h.right.querySelector<HTMLElement>('[aria-label="More actions"]')).click();
      expectDefined(
        [...h.right.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
          (el) => el.textContent === 'Make independent task',
        ),
      ).click();
      if (hide) h.details.click();
      const result = await h.run({ type: 'promote-subtask', subtask: h.grand.ref });
      await flushMicrotasks();
      expect(h.right.classList.contains('is-compact-open')).toBe(!hide);
      h.pending.resolve(result);
      await flushMicrotasks(30);
      expect(h.state.get('taskStack').map((node) => node.title)).toEqual(['Grandchild']);
      expect(h.right.classList.contains('is-compact-open')).toBe(!hide);
    },
  );
});
