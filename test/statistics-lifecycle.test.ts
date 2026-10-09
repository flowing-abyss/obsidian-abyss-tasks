import { SuggestModal, WorkspaceLeaf, type App } from 'obsidian';
import { expect, it, vi } from 'vitest';
import type { AppState } from '../src/app/AppState';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import type { StatisticsScope } from '../src/statistics';
import { TagManager } from '../src/tags/TagManager';
import { PanelView } from '../src/views/PanelView';
import {
  configuredTaskApplication,
  createAppWithFiles,
  expectDefined,
  useRealMoment,
} from './helpers';
useRealMoment();

it('renders selected live evidence and opens the exact matched child through the shared inspector', async () => {
  const app = await createAppWithFiles({
    'evidence.md':
      '- [ ] Parent ➕ 2026-10-01\n  - [ ] Matched child ➕ 2026-10-02\n  - [ ] Matched child ➕ 2026-10-02\n',
  });
  const settings = structuredClone(DEFAULT_SETTINGS);
  const application = configuredTaskApplication(app, settings);
  await application.index.initialize();
  const root = expectDefined(application.index.list()[0]);
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
    application.tasks,
    application.statusRegistry,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    application.index,
  );
  document.body.append(view.containerEl);
  try {
    await view.onOpen();
    const state = (view as unknown as { state_abyssPrivate: AppState }).state_abyssPrivate;
    state.set('taskStack', [root]);
    state.set('mode', 'statistics');
    await vi.waitFor(() => {
      expect(view.contentEl.querySelector('.abyss-statistics-section')).not.toBeNull();
    });
    expectDefined(
      [
        ...view.contentEl.querySelectorAll<HTMLButtonElement>('.abyss-statistics-metrics button'),
      ].find((button) => button.textContent.includes('Open now')),
    ).click();
    expect(view.contentEl.querySelectorAll('.abyss-statistics .abyss-task-card')).toHaveLength(3);
    expect(view.contentEl.querySelector('.abyss-statistics-chart')?.closest('[hidden]')).toBeNull();
    expect(
      view.contentEl.querySelector('.abyss-statistics .abyss-task-card.is-selected'),
    ).not.toBeNull();
    const cards = [
      ...view.contentEl.querySelectorAll<HTMLElement>('.abyss-statistics .abyss-task-card'),
    ];
    expect(cards.map((card) => card.querySelector('.abyss-task-title')?.textContent)).toEqual([
      'Parent',
      'Matched child',
      'Matched child',
    ]);
    const childCard = expectDefined(cards[2]);
    expect(childCard.dataset['line']).toBe('2');
    expect(childCard.querySelector('.abyss-task-parent-btn')?.getAttribute('aria-label')).toContain(
      'Parent',
    );
    childCard.click();
    expect([
      ...view.contentEl.querySelectorAll('.abyss-statistics .abyss-task-card.is-selected'),
    ]).toEqual([childCard]);
    expect(state.get('taskStack').map((node) => node.title)).toEqual(['Parent', 'Matched child']);
    expect(state.get('taskStack')[1]?.ref).toEqual(root.subtasks[1]?.ref);
    expect(state.get('taskStack')[1]?.ref).toMatchObject({ relativeLine: 2 });
    expect(view.contentEl.querySelector('.abyss-right')?.textContent).toContain('Matched child');
    expect(state.get('mode')).toBe('statistics');
    const card = expectDefined(
      view.contentEl.querySelector<HTMLElement>('.abyss-statistics .abyss-task-card'),
    );
    card.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    );
    expect(state.get('taskStack')).toEqual([root]);
    const opened: Array<SuggestModal<readonly [StatisticsScope, string, string]>> = [];
    let modalReturn: Element | null = null;
    vi.spyOn(SuggestModal.prototype, 'open').mockImplementation(function (
      this: SuggestModal<readonly [StatisticsScope, string, string]>,
    ) {
      opened.push(this);
      modalReturn = document.activeElement;
      document.body.append(this.containerEl);
      this.inputEl.focus();
    });
    const scopeRow = expectDefined(
      view.contentEl.querySelector<HTMLButtonElement>('.abyss-left [aria-label="Scope"]'),
    );
    scopeRow.click();
    expect(modalReturn).toBe(scopeRow);
    const docked = expectDefined(opened[0]);
    docked.onClose();
    docked.containerEl.remove();
    expect(document.activeElement).toBe(
      view.contentEl.querySelector('.abyss-left [aria-label="Scope"]'),
    );
    const layout = expectDefined(view.contentEl.querySelector<HTMLElement>('.abyss-layout'));
    const left = expectDefined(layout.querySelector<HTMLElement>('.abyss-left'));
    const toggle = expectDefined(
      layout.querySelector<HTMLButtonElement>('.abyss-compact-pane-button--left'),
    );
    expect(left.querySelectorAll('[data-statistics-view]')).toHaveLength(11);
    vi.spyOn(layout, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      width: 430,
      height: 640,
      right: 430,
      bottom: 640,
      toJSON: () => ({}),
    });
    window.dispatchEvent(new Event('resize'));
    expect(toggle.getAttribute('aria-label')).toBe('Show Analysis navigation');
    toggle.click();
    left.scrollTop = 80;
    const row = expectDefined(
      left.querySelector<HTMLButtonElement>('[data-statistics-view="rhythm"]'),
    );
    row.focus();
    row.click();
    expect(left.classList.contains('is-compact-open')).toBe(false);
    expect(document.activeElement).toBe(toggle);
    expect(left.scrollTop).toBe(80);
    toggle.click();
    expect(left.classList.contains('is-compact-open')).toBe(true);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expectDefined(left.querySelector<HTMLButtonElement>('[aria-label="Scope"]')).click();
    expect(left.classList.contains('is-compact-open')).toBe(false);
    expect(modalReturn).toBe(toggle);
    const canceled = expectDefined(opened[1]);
    expect(document.activeElement).toBe(canceled.inputEl);
    canceled.onClose();
    canceled.containerEl.remove();
    expect(document.activeElement).toBe(toggle);
    expect(left.querySelector('[aria-label="Scope"]')?.textContent).toBe('Entire vault');
    toggle.click();
    expectDefined(left.querySelector<HTMLButtonElement>('[aria-label="Scope"]')).click();
    const accepted = expectDefined(opened[2]);
    const option = expectDefined((await accepted.getSuggestions('Priority A'))[0]);
    accepted.onChooseSuggestion(option, new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(document.activeElement).toBe(accepted.inputEl);
    accepted.onClose();
    accepted.containerEl.remove();
    expect(document.activeElement).toBe(toggle);
    await vi.waitFor(() => {
      expect(left.querySelector('[aria-label="Scope"]')?.textContent).toBe('Priority A');
    });
  } finally {
    await view.onClose();
    application.index.destroy();
    view.containerEl.remove();
  }
});

it('moves and clears live evidence highlights without enabling delete controls', async () => {
  const app = await createAppWithFiles({
    'evidence.md': '- [ ] First root ➕ 2026-10-01\n- [ ] Second root ➕ 2026-10-01\n',
  });
  const settings = structuredClone(DEFAULT_SETTINGS);
  const application = configuredTaskApplication(app, settings);
  await application.index.initialize();
  const [firstRoot, secondRoot] = application.index.list();
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
    application.tasks,
    application.statusRegistry,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    application.index,
  );
  document.body.append(view.containerEl);
  try {
    await view.onOpen();
    const state = (view as unknown as { state_abyssPrivate: AppState }).state_abyssPrivate;
    state.set('taskStack', [expectDefined(firstRoot)]);
    state.set('mode', 'statistics');
    await vi.waitFor(() => {
      expect(view.contentEl.querySelector('.abyss-statistics-section')).not.toBeNull();
    });
    expectDefined(
      [
        ...view.contentEl.querySelectorAll<HTMLButtonElement>('.abyss-statistics-metrics button'),
      ].find((button) => button.textContent.includes('Open now')),
    ).click();
    const evidence = expectDefined(view.contentEl.querySelector<HTMLElement>('.abyss-statistics'));
    const [firstCard, secondCard] = evidence.querySelectorAll<HTMLElement>('.abyss-task-card');
    const actions = [...evidence.querySelectorAll<HTMLElement>('.abyss-task-card')];
    expect(actions).toHaveLength(2);
    expect([...evidence.querySelectorAll('.abyss-task-card.is-selected')]).toEqual([firstCard]);
    expectDefined(actions[1]).click();
    expect(state.get('taskStack')[0]?.ref).toEqual(expectDefined(secondRoot).ref);
    expect
      .soft(
        [...evidence.querySelectorAll('.abyss-task-card.is-selected')],
        'selection moves to the second exact root',
      )
      .toEqual([secondCard]);
    expect(evidence.querySelector('.abyss-task-delete-btn')).toBeNull();
    expectDefined(actions[0]).click();
    expect(state.get('taskStack')[0]?.ref).toEqual(expectDefined(firstRoot).ref);
    expect
      .soft(
        [...evidence.querySelectorAll('.abyss-task-card.is-selected')],
        'selection returns to the first exact root',
      )
      .toEqual([firstCard]);
    state.set('taskStack', []);
    expect
      .soft(
        evidence.querySelectorAll('.abyss-task-card.is-selected'),
        'clearing the inspector clears evidence selection',
      )
      .toHaveLength(0);
    expect(evidence.querySelector('.abyss-task-delete-btn')).toBeNull();
    expect(view.contentEl.querySelector('.abyss-statistics')).toBe(evidence);
    expect(state.get('mode')).toBe('statistics');
  } finally {
    await view.onClose();
    application.index.destroy();
    view.containerEl.remove();
  }
});

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
    application.tasks,
    application.statusRegistry,
    undefined,
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
    const root = expectDefined(
      view.contentEl.querySelector<HTMLElement>('.abyss-statistics-content'),
    );
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
      expect(
        view.contentEl.querySelector<HTMLElement>('.abyss-statistics-content')?.scrollTop,
      ).toBe(263.5);
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
