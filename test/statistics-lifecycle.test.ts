import { WorkspaceLeaf, type App } from 'obsidian';
import { expect, it, vi } from 'vitest';
import type { AppState } from '../src/app/AppState';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import { TagManager } from '../src/tags/TagManager';
import type { TaskApplicationApi, TaskCaptureApplicationApi } from '../src/tasks';
import { PanelView } from '../src/views/PanelView';
import {
  configuredTaskApplication,
  createAppWithFiles,
  expectDefined,
  useRealMoment,
} from './helpers';
useRealMoment();

it('captures scroll before mode layout changes and remounts Statistics through owner migration', async () => {
  const app = await createAppWithFiles({}),
    settings = structuredClone(DEFAULT_SETTINGS);
  const application = configuredTaskApplication(app, settings);
  await application.index.initialize();
  const leaf = new (WorkspaceLeaf as unknown as { new (app: App): WorkspaceLeaf })(app);
  const tags = new TagManager(app, settings, async () => {}, {
    check: () => 'ready',
    apply: async (_change, live) => {
      live();
    },
  });
  const view = new PanelView(
    leaf,
    settings,
    tags,
    application.index,
    application.tasks as TaskApplicationApi & TaskCaptureApplicationApi,
    application.statusRegistry,
    undefined,
    undefined,
    undefined,
    undefined,
    application.index,
  );
  let migrate: (owner: Window) => unknown = () => {};
  vi.spyOn(view.contentEl, 'onWindowMigrated').mockImplementation((listener) => {
    migrate = listener;
    return () => {};
  });
  document.body.append(view.containerEl);
  const frame = document.body.createEl('iframe'),
    destination = expectDefined(frame.contentWindow);
  // Obsidian installs its DOM helpers in every native owner realm; jsdom does not.
  const targetNode = Reflect.get(destination, 'Node') as typeof Node;
  for (const name of Object.getOwnPropertyNames(Node.prototype)) {
    if (name === 'constructor' || name in targetNode.prototype) continue;
    Object.defineProperty(
      targetNode.prototype,
      name,
      expectDefined(Object.getOwnPropertyDescriptor(Node.prototype, name)),
    );
  }
  const targetElement = Reflect.get(destination, 'HTMLElement') as typeof HTMLElement;
  for (const name of Object.getOwnPropertyNames(HTMLElement.prototype)) {
    if (name === 'constructor' || name in targetElement.prototype) continue;
    Object.defineProperty(
      targetElement.prototype,
      name,
      expectDefined(Object.getOwnPropertyDescriptor(HTMLElement.prototype, name)),
    );
  }
  try {
    await view.onOpen();
    (view as unknown as { state_abyssPrivate: AppState }).state_abyssPrivate.set(
      'mode',
      'statistics',
    );
    await vi.waitFor(() => {
      expect(view.contentEl.querySelectorAll('svg').length).toBeGreaterThan(0);
    });
    const root = expectDefined(view.contentEl.querySelector<HTMLElement>('.abyss-statistics'));
    const layout = expectDefined(view.contentEl.querySelector('.abyss-layout'));
    // Native proof showed the outgoing layout clamps 263.5 to 257.5 before onCommit renders.
    Object.defineProperty(root, 'scrollTop', {
      get: () => (layout.classList.contains('abyss-layout--statistics') ? 263.5 : 257.5),
    });
    const state = (view as unknown as { state_abyssPrivate: AppState }).state_abyssPrivate;
    state.set('mode', 'tasks');
    expect(root.isConnected).toBe(false);
    state.set('mode', 'statistics');
    await vi.waitFor(() => {
      expect(view.contentEl.querySelector<HTMLElement>('.abyss-statistics')?.scrollTop).toBe(263.5);
    });
    const oldCharts = [...view.contentEl.querySelectorAll('.abyss-statistics-chart-svg')];
    expect(oldCharts).toHaveLength(3);
    destination.document.body.append(view.containerEl);
    migrate(destination);
    await vi.waitFor(() => {
      expect(oldCharts.every((svg) => !svg.isConnected)).toBe(true);
      expect(view.contentEl.querySelectorAll('.abyss-statistics-chart-svg')).toHaveLength(3);
    });
    expect(view.contentEl.querySelector('.abyss-statistics-chart-svg')?.ownerDocument).toBe(
      destination.document,
    );
  } finally {
    await view.onClose();
    application.index.destroy();
    view.containerEl.remove();
    frame.remove();
    vi.restoreAllMocks();
  }
});
