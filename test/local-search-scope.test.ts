import { Scope, WorkspaceLeaf, type App } from 'obsidian';
import { afterEach, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import { TagManager } from '../src/tags/TagManager';
import { bindLocalSearchScope, handleLocalSearchKey } from '../src/ui/localSearchKeys';
import { PanelView } from '../src/views/PanelView';
import {
  configuredTaskApplication,
  createAppWithFiles,
  expectDefined,
  useRealMoment,
} from './helpers';
useRealMoment();

afterEach(() => {
  document.body.empty();
  vi.restoreAllMocks();
});

it('registers only finite Find/Escape handles and releases each exactly once', () => {
  const scope = new Scope();
  const register = vi.spyOn(scope, 'register');
  const unregister = vi.spyOn(scope, 'unregister');
  const route = vi.fn(() => false);
  const dispose = bindLocalSearchScope(scope, route);
  expect(register.mock.calls.map(([mod, key]) => [mod, key])).toEqual([
    [['Mod'], 'f'],
    [[], 'Escape'],
  ]);
  const event = new KeyboardEvent('keydown', { key: 'f', ctrlKey: true });
  for (const call of register.mock.calls) {
    expect(call[2](event, { key: 'f', vkey: 'F', modifiers: 'Ctrl' })).toBeUndefined();
    route.mockReturnValueOnce(true);
    expect(call[2](event, { key: 'f', vkey: 'F', modifiers: 'Ctrl' })).toBe(false);
  }
  dispose();
  dispose();
  expect(unregister.mock.calls.map(([handle]) => handle)).toEqual(
    register.mock.results.map((result): unknown => result.value),
  );
});

it.each([
  { code: '', key: 'f' },
  { code: 'KeyF', key: 'а' },
])('focuses/selects eligible Find %j (synthetic routing only)', (init) => {
  const owner = document.body.createDiv();
  owner.tabIndex = -1;
  const input = owner.createEl('input');
  input.value = 'retained';
  expect(
    handleLocalSearchKey(
      new KeyboardEvent('keydown', { ...init, ctrlKey: true, cancelable: true }),
      { input, owner },
      'ctrl',
    ),
  ).toBe(true);
  expect(document.activeElement).toBe(input);
  expect([input.selectionStart, input.selectionEnd]).toEqual([0, 8]);
});

it.each(['hidden', 'detached', 'disabled', 'failed-focus'] as const)(
  'does not consume Find for %s input',
  (reason) => {
    const owner = document.body.createDiv();
    const input = owner.createEl('input');
    if (reason === 'hidden') owner.hidden = true;
    if (reason === 'detached') owner.remove();
    if (reason === 'disabled') input.disabled = true;
    if (reason === 'failed-focus') vi.spyOn(input, 'focus').mockImplementation(() => {});
    const event = new KeyboardEvent('keydown', { code: 'KeyF', ctrlKey: true, cancelable: true });
    expect(handleLocalSearchKey(event, { input, owner }, 'ctrl')).toBe(false);
    expect(event.defaultPrevented).toBe(false);
  },
);

it('owns one inherited View.scope without pushing it, restores its predecessor and disables retired callbacks', async () => {
  const app = await createAppWithFiles({});
  const settings = structuredClone(DEFAULT_SETTINGS);
  const tasks = configuredTaskApplication(app, settings);
  const tags = new TagManager(app, settings, async () => {}, {
    check: () => 'ready',
    apply: async (_change, applyLive) => {
      applyLive();
    },
  });
  const leaf = new (WorkspaceLeaf as unknown as { new (app: App): WorkspaceLeaf })(app);
  const view = new PanelView(leaf, settings, tags, tasks.index, tasks.tasks, tasks.statusRegistry);
  const prior = new Scope(app.scope);
  view.scope = prior;
  const push = vi.spyOn(app.keymap, 'pushScope');
  const register = vi.spyOn(Scope.prototype, 'register');
  const unregister = vi.spyOn(Scope.prototype, 'unregister');
  try {
    await view.onOpen();
    document.body.append(view.containerEl);
    expect(view.scope).not.toBe(prior);
    expect(push).not.toHaveBeenCalled();
    const own = register.mock.calls.slice(0, 2);
    expect(own.map(([mod, key]) => [mod, key])).toEqual([
      [['Mod'], 'f'],
      [[], 'Escape'],
    ]);
    const callback = expectDefined(own[0])[2];
    await view.onClose();
    expect(view.scope).toBe(prior);
    expect(unregister).toHaveBeenCalledTimes(2);
    expect(
      callback(new KeyboardEvent('keydown', { key: 'f', code: 'KeyF', ctrlKey: true }), {
        key: 'f',
        vkey: 'F',
        modifiers: 'Ctrl',
      }),
    ).toBeUndefined();
    await view.onOpen();
    expect(view.scope).not.toBe(prior);
    await view.onClose();
    expect(view.scope).toBe(prior);
    expect(unregister).toHaveBeenCalledTimes(4);
  } finally {
    view.containerEl.remove();
    tasks.index.destroy();
  }
});
