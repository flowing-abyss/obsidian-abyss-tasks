import { Notice, Platform, requireApiVersion, TFile } from 'obsidian';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppState } from '../src/app/AppState';
import { RightPanel } from '../src/panels/RightPanel';
import { buildDefaultTaskStatuses, DEFAULT_SETTINGS } from '../src/settings/defaults';
import { toStatusRules } from '../src/settings/statusCatalogAdapter';
import type { TaskStatusDef } from '../src/settings/types';
import { StatusRegistry } from '../src/status/StatusRegistry';
import {
  localDate,
  type SubtaskSnapshot,
  type TaskApplicationApi,
  type TaskCommandResult,
  type TaskResolution,
} from '../src/tasks';
import { TaskApplicationService } from '../src/tasks/application/TaskApplicationService';
import {
  TaskDependencyService,
  type TaskDiagnosticSink,
} from '../src/tasks/application/TaskDependencyService';
import { StatusCatalog } from '../src/tasks/domain/StatusCatalog';
import { TaskIndex } from '../src/tasks/infrastructure/TaskIndex';
import { TaskRefAuthority } from '../src/tasks/infrastructure/TaskRefAuthority';
import { TaskBlockEditor } from '../src/tasks/infrastructure/markdown/TaskBlockEditor';
import { TaskLocator } from '../src/tasks/infrastructure/markdown/TaskLocator';
import { TaskMarkdownCodec } from '../src/tasks/infrastructure/markdown/TaskMarkdownCodec';
import { ObsidianTaskRepository } from '../src/tasks/infrastructure/obsidian/ObsidianTaskRepository';
import { TaskModal } from '../src/ui/TaskModal';
import { rebuildTaskSelection, rootTaskRef } from '../src/ui/taskSelection';
import {
  createAppWithFiles,
  cssDeclarationsFor,
  cssDeclarationValue,
  deferred,
  expectDefined,
  flushMicrotasks,
  methodOf,
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

async function harness(
  markdown: string,
  selected = 'Current',
  additionalFiles = {},
  statusDefinitions: readonly TaskStatusDef[] = buildDefaultTaskStatuses(),
) {
  // The mock metadata parser uses -0 for a root list beginning on line zero.
  const app = await createAppWithFiles({ 'tasks.md': `\n${markdown}`, ...additionalFiles });
  const statuses = new StatusCatalog(toStatusRules(statusDefinitions));
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
  const diagnostics = vi.fn<TaskDiagnosticSink>();
  const application = new TaskApplicationService(
    index,
    repository,
    statuses,
    { today: () => localDate('2026-09-05') },
    undefined,
    undefined,
    new TaskDependencyService(index, repository, () => 'generate', diagnostics),
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
  const panel = new RightPanel(
    state,
    app,
    new StatusRegistry([...statusDefinitions]),
    DEFAULT_SETTINGS,
    undefined,
    api,
  );
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
  return { app, file, panel, el, state, index, node, api, read, repository, diagnostics };
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

describe('dependency picker visible containment', () => {
  const cases = [
    {
      name: 'wide docked',
      viewport: [1440, 900],
      panel: [1000, 20, 360, 740],
      anchor: [1320, 720],
      limit: [344, 688],
      position: [1048, 316],
    },
    {
      name: '940px docked',
      viewport: [940, 700],
      panel: [660, 20, 320, 740],
      anchor: [890, 640],
      limit: [264, 608],
      position: [668, 236],
    },
    {
      name: '420px clipped docked',
      viewport: [420, 300],
      panel: [300, -40, 400, 800],
      anchor: [390, 240],
      limit: [104, 228],
      position: [308, 8],
    },
    {
      name: 'wide floating',
      viewport: [1440, 900],
      panel: [490, -200, 460, 1300],
      overlay: [480, 220, 480, 440],
      anchor: [880, 600],
      limit: [444, 368],
      position: [638, 228],
    },
    {
      name: '940px floating',
      viewport: [940, 700],
      panel: [240, -200, 460, 1300],
      overlay: [230, 100, 480, 440],
      anchor: [630, 480],
      limit: [444, 368],
      position: [388, 108],
    },
    {
      name: '420px short floating',
      viewport: [420, 300],
      panel: [-10, -80, 500, 700],
      overlay: [20, 20, 380, 260],
      anchor: [360, 240],
      limit: [364, 208],
      position: [88, 28],
    },
    {
      name: '420px top-left floating',
      viewport: [420, 300],
      panel: [-10, -80, 500, 700],
      overlay: [20, 20, 380, 260],
      anchor: [22, 40],
      limit: [364, 204],
      position: [28, 68],
    },
  ];

  it.each(
    cases.flatMap((entry) =>
      ['badge', 'blocked-by', 'blocks'].map((source) => ({ ...entry, source })),
    ),
  )(
    'contains the $source picker in $name, using the actual containing block',
    async ({ viewport, panel, overlay, anchor, limit, position, source }) => {
      const h = await harness('- [ ] Current\n- [ ] Candidate\n');
      const ownerWindow = expectDefined(h.el.ownerDocument.defaultView);
      vi.spyOn(ownerWindow, 'innerWidth', 'get').mockReturnValue(expectDefined(viewport[0]));
      vi.spyOn(ownerWindow, 'innerHeight', 'get').mockReturnValue(expectDefined(viewport[1]));
      const block = h.el.ownerDocument.body.createDiv({
        cls: overlay !== undefined ? 'abyss-modal' : '',
      });
      block.append(h.el);
      Object.defineProperties(block, {
        clientLeft: { value: 3 },
        clientTop: { value: 5 },
        scrollLeft: { value: 11 },
        scrollTop: { value: 13 },
      });
      const containingBlock = overlay === undefined ? block : h.el;
      if (overlay !== undefined)
        Object.defineProperties(containingBlock, {
          clientLeft: { value: 7 },
          clientTop: { value: 9 },
          scrollLeft: { value: 17 },
          scrollTop: { value: 19 },
        });
      vi.spyOn(block, 'getBoundingClientRect').mockReturnValue(
        new DOMRect(...(overlay ?? [30, 20, 1000, 800])),
      );
      vi.spyOn(h.el, 'getBoundingClientRect').mockReturnValue(new DOMRect(...panel));
      if (source !== 'badge') button(h.el, '.abyss-dep-badge-add').click();
      const selector =
        source === 'badge'
          ? '.abyss-dep-badge-body'
          : `[data-dependency-direction="${source}"] .abyss-dep-add`;
      const trigger = button(h.el, selector);
      vi.spyOn(trigger, 'getBoundingClientRect').mockReturnValue(
        new DOMRect(anchor[0], anchor[1], 24, 24),
      );
      const real = methodOf(HTMLElement.prototype, 'getBoundingClientRect');
      vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
        this: HTMLElement,
      ) {
        if (!this.matches('.abyss-dep-search')) return real.call(this);
        return new DOMRect(
          0,
          0,
          Math.min(304, parseFloat(this.style.getPropertyValue('--abyss-pop-width'))),
          Math.min(400, parseFloat(this.style.getPropertyValue('--abyss-pop-height'))),
        );
      });
      vi.spyOn(HTMLElement.prototype, 'offsetParent', 'get').mockImplementation(function (
        this: HTMLElement,
      ) {
        return this.matches('.abyss-dep-search') ? containingBlock : null;
      });
      trigger.click();
      const picker = expectDefined(h.el.querySelector<HTMLElement>('.abyss-dep-search'));
      expect(picker.style.getPropertyValue('--abyss-pop-width')).toBe(`${limit[0]}px`);
      expect(picker.style.getPropertyValue('--abyss-pop-height')).toBe(`${limit[1]}px`);
      const blockRect = containingBlock.getBoundingClientRect();
      expect(
        parseFloat(picker.style.getPropertyValue('--abyss-pop-left')) +
          blockRect.left +
          (overlay === undefined ? 3 - 11 : 7 - 17),
      ).toBe(position[0]);
      expect(
        parseFloat(picker.style.getPropertyValue('--abyss-pop-top')) +
          blockRect.top +
          (overlay === undefined ? 5 - 13 : 9 - 19),
      ).toBe(position[1]);
      expect(picker.classList.contains('abyss-popover-anchored')).toBe(true);
      expect(picker.querySelectorAll('.abyss-dep-search-direction')).toHaveLength(
        source === 'badge' ? 2 : 0,
      );
      const input = search(h.el, 'New child');
      expect(h.el.ownerDocument.activeElement).toBe(input);
      expect(
        expectDefined(picker.querySelector<HTMLElement>('.abyss-dep-search-create')).hidden,
      ).toBe(false);
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      expect(picker.isConnected).toBe(false);
      expect(h.el.ownerDocument.activeElement).toBe(trigger);
    },
  );

  it('keeps picker chrome fixed while only results yield to a short boundary', async () => {
    if (!Platform.isDesktop) throw new Error('CSS fixture needs desktop runtime');
    const fs = await import('node:fs');
    const css = expandCompoundSelectorLists(
      fs.readFileSync(`${import.meta.dirname}/../styles.css`, 'utf8'),
    );
    const value = (selector: string, property: string) =>
      cssDeclarationValue(cssDeclarationsFor(css, selector), property);
    expect(value('.abyss-dep-search', 'max-width')).toBe(
      'var(--abyss-pop-width, calc(100% - 16px))',
    );
    expect(value('.abyss-dep-search', 'max-height')).toBe('var(--abyss-pop-height)');
    expect(value('.abyss-dep-search', 'display')).toBe('flex');
    expect(value('.abyss-dep-search', 'flex-direction')).toBe('column');
    expect(value('.abyss-dep-search > *', 'flex-shrink')).toBe('0');
    // The 104px outer picker leaves 86px after its padding and borders: the
    // two intrinsic button widths cannot share that row. Preserve their labels
    // and let the direction group grow vertically, which its ResizeObserver owns.
    expect(value('.abyss-dep-search-directions', 'flex-wrap')).toBe('wrap');
    expect(value('.abyss-dep-search-results', 'flex-shrink')).toBe('1');
    expect(value('.abyss-dep-search-results', 'overflow')).toBe('hidden auto');
    expect(value('.abyss-dep-search-results', 'min-height')).toBe('0');
    expect(value('.abyss-dep-search-create:not([hidden])', 'text-overflow')).toBe('ellipsis');
    expect(value('.abyss-modal', 'width')).toBe('min(480px, calc(100vw - 32px))');
  });

  it('positions before focusing, and never scrolls the inspector on search focus', async () => {
    const h = await harness('- [ ] Current\n- [ ] Candidate\n');
    const focus = methodOf(HTMLElement.prototype, 'focus');
    const calls: Array<{ positioned: boolean; preventScroll: boolean | undefined }> = [];
    vi.spyOn(HTMLElement.prototype, 'focus').mockImplementation(function (
      this: HTMLElement,
      options,
    ) {
      const picker = this.closest<HTMLElement>('.abyss-dep-search');
      if (picker !== null)
        calls.push({
          positioned: picker.style.getPropertyValue('--abyss-pop-top') !== '',
          preventScroll: options?.preventScroll,
        });
      focus.call(this, options);
    });
    button(h.el, '.abyss-dep-badge-body').click();
    expect(calls).toEqual([{ positioned: true, preventScroll: true }]);
    button(h.el, '[data-direction="blocks"]').click();
    search(h.el, 'Invalid 🆔 authored').dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
    );
    await flushMicrotasks(30);
    expect(calls).toHaveLength(3);
    expect(
      calls.every(({ positioned, preventScroll }) => positioned && preventScroll === true),
    ).toBe(true);
  });

  it('tracks content, anchor, boundary, window and captured scroll changes, then releases old owners', async () => {
    const h = await harness('- [ ] Current\n- [ ] Candidate\n');
    const doc = h.el.ownerDocument;
    const win = expectDefined(doc.defaultView);
    const observers: Array<{
      resize: () => void;
      targets: Element[];
      disconnect: ReturnType<typeof vi.fn>;
    }> = [];
    vi.stubGlobal(
      'ResizeObserver',
      class {
        record;
        constructor(callback: () => void) {
          this.record = { resize: callback, targets: [] as Element[], disconnect: vi.fn() };
          observers.push(this.record);
        }
        observe(target: Element) {
          this.record.targets.push(target);
        }
        disconnect() {
          this.record.disconnect();
        }
      },
    );
    cleanups.push(() => {
      vi.unstubAllGlobals();
    });
    const modal = doc.body.createDiv({ cls: 'abyss-modal' });
    const block = modal.createDiv();
    block.append(h.el);
    const blockRect = vi
      .spyOn(block, 'getBoundingClientRect')
      .mockReturnValue(new DOMRect(100, 100, 400, 900));
    vi.spyOn(HTMLElement.prototype, 'offsetParent', 'get').mockImplementation(function (
      this: HTMLElement,
    ) {
      return this.matches('.abyss-dep-search') ? block : null;
    });
    const calendar = doc.body.createDiv();
    vi.spyOn(modal, 'getBoundingClientRect').mockReturnValue(new DOMRect(100, 100, 400, 500));
    vi.spyOn(h.el, 'getBoundingClientRect').mockReturnValue(new DOMRect(100, 100, 400, 1000));
    let anchorTop = 500;
    let height = 100;
    const real = methodOf(HTMLElement.prototype, 'getBoundingClientRect');
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement,
    ) {
      if (this.matches('.abyss-dep-badge-body')) return new DOMRect(300, anchorTop, 24, 24);
      if (this.matches('.abyss-dep-search')) return new DOMRect(0, 0, 160, height);
      return real.call(this);
    });
    const addWindow = vi.spyOn(win, 'addEventListener');
    const removeWindow = vi.spyOn(win, 'removeEventListener');
    const addDocument = vi.spyOn(doc, 'addEventListener');
    const removeDocument = vi.spyOn(doc, 'removeEventListener');
    button(h.el, '.abyss-dep-badge-body').click();
    const picker = expectDefined(h.el.querySelector<HTMLElement>('.abyss-dep-search'));
    const first = expectDefined(observers[0]);
    expect(first.targets).toEqual(
      expect.arrayContaining([picker, modal, block, h.el, button(h.el, '.abyss-dep-badge-body')]),
    );
    expect(first.targets).toEqual(expect.arrayContaining([...picker.children]));
    expect(picker.style.getPropertyValue('--abyss-pop-top')).toBe('296px');
    search(h.el, 'New child');
    expect(picker.querySelectorAll('[role="option"]')).toHaveLength(0);
    expect(picker.querySelector<HTMLElement>('.abyss-dep-search-create')?.hidden).toBe(false);
    height = 200; // The DOM-only renderer does not measure the changed content.
    first.resize();
    expect(picker.style.getPropertyValue('--abyss-pop-top')).toBe('196px');
    for (const [target, type] of [
      [h.el, 'scroll'],
      [modal, 'scroll'],
      [calendar, 'scroll'],
      [doc, 'scroll'],
      [win, 'scroll'],
      [win, 'resize'],
    ] as const) {
      anchorTop -= 10;
      target.dispatchEvent(new Event(type));
      expect(parseFloat(picker.style.getPropertyValue('--abyss-pop-top'))).toBe(anchorTop - 304);
    }
    blockRect.mockReturnValue(new DOMRect(100, 120, 400, 900));
    first.resize();
    expect(picker.style.getPropertyValue('--abyss-pop-top')).toBe('116px');
    blockRect.mockReturnValue(new DOMRect(100, 100, 400, 900));
    search(h.el, 'Invalid 🆔 authored').dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
    );
    await flushMicrotasks(30);
    expect(picker.querySelector<HTMLElement>('.abyss-dep-search-error')?.hidden).toBe(false);
    height = 240;
    first.resize();
    expect(picker.style.getPropertyValue('--abyss-pop-top')).toBe('96px');
    search(h.el, 'Draft');
    height = 200;
    h.state.updateInspectorSelection([h.node('Current').root]);
    expect(h.el.querySelector('.abyss-dep-search')).toBe(picker);
    expect(picker.querySelector('input')?.value).toBe('Draft');
    expect(first.disconnect).toHaveBeenCalledTimes(1);
    expect(observers).toHaveLength(2);
    h.panel.destroy();
    expect(observers[1]?.disconnect).toHaveBeenCalledTimes(1);
    const before = picker.style.cssText;
    height = 10;
    for (const observer of observers) observer.resize();
    win.dispatchEvent(new Event('resize'));
    doc.dispatchEvent(new Event('scroll'));
    expect(picker.style.cssText).toBe(before);
    for (const [add, remove] of [
      [addWindow, removeWindow],
      [addDocument, removeDocument],
    ] as const) {
      for (const [type, callback, options] of add.mock.calls.filter(
        ([event]) => event === 'resize' || event === 'scroll',
      )) {
        expect(
          remove.mock.calls.filter(
            ([event, listener, config]) =>
              event === type && listener === callback && config === options,
          ),
        ).toHaveLength(1);
      }
    }
  });

  it('owns viewport and scroll listeners in the invoking control document', async () => {
    const h = await harness('- [ ] Current\n- [ ] Candidate\n');
    const frame = activeDocument.body.createEl('iframe');
    const doc = expectDefined(frame.contentDocument);
    const win = expectDefined(doc.defaultView);
    doc.body.append(h.el);
    const panelRect = vi
      .spyOn(h.el, 'getBoundingClientRect')
      .mockReturnValue(new DOMRect(100, 100, 400, 500));
    const trigger = button(h.el, '.abyss-dep-badge-body');
    vi.spyOn(trigger, 'getBoundingClientRect').mockReturnValue(new DOMRect(300, 300, 24, 24));
    trigger.click();
    const picker = expectDefined(h.el.querySelector<HTMLElement>('.abyss-dep-search'));
    const before = picker.style.getPropertyValue('--abyss-pop-top');
    panelRect.mockReturnValue(new DOMRect(100, 120, 400, 500));
    activeWindow.dispatchEvent(new Event('resize'));
    expect(picker.style.getPropertyValue('--abyss-pop-top')).toBe(before);
    win.dispatchEvent(new Event('resize'));
    expect(picker.style.getPropertyValue('--abyss-pop-top')).toBe(`${parseFloat(before) - 20}px`);
    panelRect.mockReturnValue(new DOMRect(100, 140, 400, 500));
    doc.dispatchEvent(new Event('scroll'));
    expect(picker.style.getPropertyValue('--abyss-pop-top')).toBe(`${parseFloat(before) - 40}px`);
    search(h.el, '').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(doc.activeElement).toBe(trigger);
    expect(picker.isConnected).toBe(false);
  });
});

describe('inspector subtask row removal', () => {
  it('offers local recovery after deleting the selected subtask through the modal menu', async () => {
    const markdown = '- [ ] Current\n  - [ ] Child\n  - [ ] Sibling\n';
    const h = await harness(markdown);
    const modal = new TaskModal(h.app, testStatusRegistry(), DEFAULT_SETTINGS, h.index, h.api);
    cleanups.unshift(() => {
      modal.close();
    });
    modal.open(h.node('Current').root);
    const el = button(activeDocument.body, '.abyss-modal-body');
    button(el, '.abyss-subtask-label').click();
    button(el, '[aria-label="More actions"]').click();
    button(el, '.abyss-context-danger').click();
    await flushMicrotasks(40);
    expect(await h.read()).toBe('- [ ] Current\n  - [ ] Sibling\n');
    button(el, '.abyss-undo-row button').click();
    await flushMicrotasks(40);
    expect(await h.read()).toBe(markdown);
    expect(activeDocument.activeElement?.textContent).toContain('Child');
  });

  it.each(['dependency', 'subtask'] as const)(
    'does not publish a late %s tombstone into another selection',
    async (kind) => {
      const h = await harness('- [ ] Current ⛔ missing\n  - [ ] Child\n- [ ] Other\n');
      const pending = deferred<void>();
      const execute = h.api.execute.bind(h.api);
      vi.spyOn(h.api, 'execute').mockImplementation(async (command) => {
        const result = await execute(command);
        await pending.promise;
        return result;
      });
      button(h.el, kind === 'dependency' ? '.abyss-dep-remove' : '.abyss-subtask-remove').click();
      await flushMicrotasks(30);
      h.state.set('taskStack', [h.node('Other').root]);
      pending.resolve();
      await flushMicrotasks(30);
      expect(h.el.querySelector('.abyss-undo-row')).toBeNull();
      expect(h.state.get('taskStack')[0]?.title).toBe('Other');
    },
  );

  it.each([false, true])(
    'revokes delayed modal deletion Undo after navigating away and back (selected child: %s)',
    async (selectedChild) => {
      const h = await harness('- [ ] Current\n  - [ ] Child\n  - [ ] Sibling\n');
      const pending = deferred<void>();
      const execute = h.api.execute.bind(h.api);
      vi.spyOn(h.api, 'execute').mockImplementation(async (command) => {
        const result = await execute(command);
        await pending.promise;
        return result;
      });
      const modal = new TaskModal(h.app, testStatusRegistry(), DEFAULT_SETTINGS, h.index, h.api);
      cleanups.unshift(() => {
        modal.close();
      });
      modal.open(h.node('Current').root);
      const el = button(activeDocument.body, '.abyss-modal-body');
      if (selectedChild) {
        button(el, '.abyss-subtask-label').click();
        button(el, '[aria-label="More actions"]').click();
        button(el, '.abyss-context-danger').click();
      } else button(el, '.abyss-subtask-remove').click();
      await flushMicrotasks(40);
      expect(await h.read()).toBe('- [ ] Current\n  - [ ] Sibling\n');
      button(el, '.abyss-subtask-label').click();
      button(el, '.abyss-breadcrumb-item').click();
      pending.resolve();
      await flushMicrotasks(40);
      expect(el.querySelector('.abyss-undo-row')).toBeNull();
      expect(button(el, '.abyss-subtask-label').textContent).toBe('Sibling');
      expect(await h.read()).toBe('- [ ] Current\n  - [ ] Sibling\n');
    },
  );

  it('keeps dependency Undo through a no-op mutation and failed validation', async () => {
    const h = await harness('- [ ] Current ⛔ missing\n');
    cleanups.unshift(
      h.index.subscribe(() => {
        h.state.updateInspectorSelection([h.node('Current').root]);
      }),
    );
    button(h.el, '.abyss-dep-remove').click();
    await flushMicrotasks(40);
    const undo = button(h.el, '.abyss-undo-row button');
    const target = { type: 'task' as const, ref: h.node('Current').root.ref };
    expect(
      await h.api.execute({
        type: 'patch',
        target,
        patch: { markdownTitle: { type: 'set', value: 'Current' } },
      }),
    ).toMatchObject({ type: 'ok', changed: false });
    expect(
      await h.api.execute({ type: 'add-dependency', blocker: target, dependent: target }),
    ).toMatchObject({ type: 'invalid' });
    h.state.updateInspectorSelection([h.node('Current').root]);
    expect(button(h.el, '.abyss-undo-row button')).toBe(undo);
    undo.click();
    await flushMicrotasks(40);
    expect(await h.read()).toBe('- [ ] Current ⛔ missing\n');
  });

  it.each(['missing', 'ambiguous'] as const)(
    'revokes dependency Undo if its structural address is %s',
    async (kind) => {
      const h = await harness('- [ ] Current ⛔ missing\n');
      button(h.el, '.abyss-dep-remove').click();
      await flushMicrotasks(40);
      const node = h.node('Current');
      vi.spyOn(h.index, 'listNodes').mockReturnValue(kind === 'missing' ? [] : [node, node]);
      h.state.updateInspectorSelection([node.root]);
      expect(h.el.querySelector('.abyss-undo-row')).toBeNull();
    },
  );

  it('validates the dependent subtask rather than its unchanged parent or inspected blocker', async () => {
    const h = await harness('- [ ] Current 🆔 current\n- [ ] Parent\n  - [ ] Child ⛔ current\n');
    button(h.el, '.abyss-dep-remove').click();
    await flushMicrotasks(40);
    const undo = button(h.el, '.abyss-undo-row button');
    await h.app.vault.modify(
      h.file,
      '\n- [ ] Current 🆔 current\n- [ ] Parent\n  - [ ] Child changed\n',
    );
    await flushMicrotasks(40);
    expect(h.el.querySelector('.abyss-undo-row')).toBeNull();
    undo.click();
    await flushMicrotasks();
    expect(await h.read()).toBe('- [ ] Current 🆔 current\n- [ ] Parent\n  - [ ] Child changed\n');
  });

  it('does not mistake navigation to the parent before deletion commits for owned convergence', async () => {
    const h = await harness('- [ ] Current\n  - [ ] Child\n  - [ ] Sibling\n');
    const pending = deferred<void>();
    const execute = h.api.execute.bind(h.api);
    vi.spyOn(h.api, 'execute').mockImplementation(async (command) => {
      await pending.promise;
      return execute(command);
    });
    const modal = new TaskModal(h.app, testStatusRegistry(), DEFAULT_SETTINGS, h.index, h.api);
    cleanups.unshift(() => {
      modal.close();
    });
    modal.open(h.node('Current').root);
    const el = button(activeDocument.body, '.abyss-modal-body');
    button(el, '.abyss-subtask-label').click();
    button(el, '[aria-label="More actions"]').click();
    button(el, '.abyss-context-danger').click();
    button(el, '.abyss-breadcrumb-item').click();
    pending.resolve();
    await flushMicrotasks(40);
    expect(await h.read()).toBe('- [ ] Current\n  - [ ] Sibling\n');
    expect(el.querySelector('.abyss-undo-row')).toBeNull();
    expect(button(el, '.abyss-subtask-label').textContent).toBe('Sibling');
  });

  it('replaces a prior removal and preserves the latest position and focus across refresh', async () => {
    const h = await harness('- [ ] Current ⛔ first, second, third\n  - [ ] Child\n');
    notices();
    button(h.el, '.abyss-dep-remove').click();
    await flushMicrotasks(40);
    const old = button(h.el, '.abyss-undo-row button');
    button(h.el, '.abyss-subtask-remove').click();
    await flushMicrotasks(40);
    const undo = button(h.el, '.abyss-undo-row button');
    expect(h.el.querySelectorAll('.abyss-undo-row')).toHaveLength(1);
    expect(undo.closest('.abyss-subtask-section')).not.toBeNull();
    old.click();
    await flushMicrotasks(40);
    expect(await h.read()).toBe('- [ ] Current ⛔ second, third\n');
    h.state.updateInspectorSelection([...h.state.get('taskStack')]);
    expect(button(h.el, '.abyss-undo-row button')).toBe(undo);
    expect(activeDocument.activeElement).toBe(undo);
    undo.click();
    await flushMicrotasks(40);
    expect(await h.read()).toBe('- [ ] Current ⛔ second, third\n  - [ ] Child\n');
    expect(activeDocument.activeElement?.closest('.abyss-subtask-row')?.textContent).toContain(
      'Child',
    );
  });

  it('keeps a middle dependency tombstone at its original position across refresh', async () => {
    const h = await harness('- [ ] Current ⛔ first, middle, last\n');
    button(h.el, '.abyss-dep-row:nth-child(2) .abyss-dep-remove').click();
    await flushMicrotasks(40);
    const undo = button(h.el, '.abyss-undo-row button');
    expect(undo.closest('.abyss-undo-row')?.previousElementSibling?.textContent).toContain('first');
    expect(undo.closest('.abyss-undo-row')?.nextElementSibling?.textContent).toContain('last');
    h.state.updateInspectorSelection([h.node('Current').root]);
    expect(activeDocument.activeElement).toBe(undo);
    undo.click();
    await flushMicrotasks(40);
    expect(activeDocument.activeElement?.textContent).toContain('middle');
  });

  it.each(['add', 'reverse', 'create', 'title', 'manual'] as const)(
    'revokes dependency Undo after a same-line %s change',
    async (change) => {
      const h = await harness(
        '- [ ] Current 🆔 current ⛔ missing, before\n- [ ] Before 🆔 before\n- [ ] Candidate 🆔 candidate\n',
      );
      button(h.el, '.abyss-dep-remove').click();
      await flushMicrotasks(40);
      const undo = button(h.el, '.abyss-undo-row button');
      if (change === 'add')
        await h.api.execute({
          type: 'add-dependency',
          blocker: h.node('Candidate').target,
          dependent: h.node('Current').target,
        });
      if (change === 'reverse')
        await h.api.execute({
          type: 'reverse-dependency',
          blocker: h.node('Before').target,
          dependent: h.node('Current').target,
          dependencyId: 'before',
        });
      if (change === 'create')
        await h.api.execute({
          type: 'create-dependency-subtask',
          current: h.node('Current').target,
          direction: 'blocked-by',
          text: 'Created child',
        });
      if (change === 'title') await h.panel.updateTaskTitle(h.node('Current').node, 'Renamed');
      if (change === 'manual')
        await h.app.vault.modify(
          h.file,
          '\n- [ ] Current  🆔 current ⛔ before\n- [ ] Before 🆔 before\n- [ ] Candidate 🆔 candidate\n',
        );
      await flushMicrotasks(40);
      const after = await h.read();
      expect(h.el.querySelector('.abyss-undo-row')).toBeNull();
      undo.click();
      await flushMicrotasks(40);
      expect(await h.read()).toBe(after);
    },
  );

  it.each([false, true])(
    'preserves dependency Undo on unrelated refresh and invalidates changed recovery evidence (legacy: %s)',
    async (legacy) => {
      const h = await harness('- [ ] Current ⛔ missing\n- [ ] Other\n');
      const execute = h.api.execute.bind(h.api);
      if (legacy)
        vi.spyOn(h.api, 'execute').mockImplementation(async (command) => {
          const result = await execute(command);
          if (
            result.type !== 'ok' ||
            result.outcome.type !== 'dependency' ||
            result.outcome.removalRecovery === undefined
          )
            return result;
          const { dependencyId, beforeIds, afterIds } = result.outcome.removalRecovery;
          const recovery = { dependencyId, beforeIds, afterIds };
          return { ...result, outcome: { ...result.outcome, removalRecovery: recovery } };
        });
      button(h.el, '.abyss-dep-remove').click();
      await flushMicrotasks(40);
      const undo = button(h.el, '.abyss-undo-row button');
      await h.api.execute({
        type: 'append-title',
        target: h.node('Other').target,
        markdown: 'changed',
      });
      await flushMicrotasks(40);
      expect(button(h.el, '.abyss-undo-row button')).toBe(undo);
      await h.app.vault.modify(h.file, '\n- [ ] Current ⛔ replacement\n- [ ] Other changed\n');
      await flushMicrotasks(40);
      expect(h.el.querySelector('.abyss-undo-row')).toBeNull();
    },
  );

  it('keeps failed Undo actionable and reports exactly one error before a successful retry', async () => {
    const h = await harness('- [ ] Current ⛔ missing\n');
    const captured = notices();
    button(h.el, '.abyss-dep-remove').click();
    await flushMicrotasks(40);
    vi.spyOn(h.api, 'execute').mockRejectedValueOnce(new Error('write unavailable'));
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const undo = button(h.el, '.abyss-undo-row button');
    undo.click();
    undo.click();
    await flushMicrotasks(40);
    expect(captured).toHaveLength(1);
    expect(log).toHaveBeenCalledOnce();
    expect(button(h.el, '.abyss-undo-row button').disabled).toBe(false);
    button(h.el, '.abyss-undo-row button').click();
    await flushMicrotasks(40);
    expect(await h.read()).toBe('- [ ] Current ⛔ missing\n');
    expect(h.el.querySelector('.abyss-undo-row')).toBeNull();
  });

  it.each(['timeout', 'selection', 'destroy'] as const)(
    'revokes local Undo on %s',
    async (reason) => {
      const h = await harness('- [ ] Current ⛔ missing\n- [ ] Other\n');
      notices();
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      button(h.el, '.abyss-dep-remove').click();
      await vi.advanceTimersByTimeAsync(100);
      const undo = button(h.el, '.abyss-undo-row button');
      if (reason === 'timeout') await vi.advanceTimersByTimeAsync(5000);
      else if (reason === 'selection') h.state.set('taskStack', [h.node('Other').root]);
      else h.panel.destroy();
      expect(h.el.querySelector('.abyss-undo-row')).toBeNull();
      undo.click();
      await vi.advanceTimersByTimeAsync(100);
      expect(await h.read()).toBe('- [ ] Current\n- [ ] Other\n');
      vi.useRealTimers();
    },
  );

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
    expect(value('.abyss-subtask-row.abyss-undo-row', 'cursor')).toBe('default');
    expect(value('.abyss-undo-row button', 'height')).toBe('24px');
    expect(value('.abyss-undo-row button', 'cursor')).toBe('pointer');
    expect(value('.abyss-undo-row button', 'color')).toBe('var(--text-accent)');
    expect(value('.abyss-undo-row span', 'color')).toBe('var(--text-muted)');
    expect(css).toContain(':is(.abyss-breadcrumb-item, .abyss-undo-row button):hover');
    expect(value('.abyss-undo-row button:focus-visible', 'outline')).toBe(
      '2px solid var(--interactive-accent)',
    );
    expect(value('.abyss-dep-badge:hover', 'background')).toBe('var(--background-modifier-hover)');
    expect(value('.abyss-dep-badge.abyss-chip', 'padding')).toBe('0');
    expect(value('.abyss-dep-badge > button', 'padding')).toBe('3px 6px');
    expect(value('.abyss-dep-badge > .abyss-dep-badge-body', 'padding-inline')).toBe('8px 4px');
    expect(value('.abyss-dep-badge > .abyss-dep-badge-add', 'padding-inline')).toBe('4px 8px');
    expect(value('.abyss-dep-badge > button', 'gap')).toBe('2px');
    expect(value('.abyss-dep-badge-add:hover', 'background')).toBe(
      'var(--background-modifier-active-hover)',
    );
    expect(value('.abyss-right-section-count', 'padding')).toBe('0 6px');
    expect(value('.abyss-dep-divider', 'background')).toBe('var(--text-muted)');
    expect(value('.abyss-dep-indicator', 'gap')).toBe('1px');
    expect(value('.abyss-dep-indicator', 'margin-inline-end')).toBe('-2px');
    expect(Number(value('.abyss-dep-indicator-divider', 'opacity'))).toBeLessThan(1);
    expect(value('.abyss-dep-count-blocked-by', 'color')).toBe(
      'var(--abyss-dependency-blocked-by)',
    );
    expect(value('.abyss-dep-count-blocks', 'color')).toBe('var(--abyss-dependency-blocks)');
    expect(value('.abyss-dep-indicator svg', 'width')).toBe('11px');
    expect(value('.abyss-dep-indicator svg', 'height')).toBe('11px');
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
    expect(captured).toHaveLength(0);
    const undo = button(h.el, '.abyss-undo-row button');
    expect(undo.getAttribute('aria-label')).toBe('Undo: Remove me');
    expect(activeDocument.activeElement).toBe(undo);
    expect(h.el.querySelector('.abyss-subtask-list .abyss-undo-row')?.textContent).toBe(
      'Sub-task deletedUndo(5s)',
    );
    undo.click();
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

  it('edits a blocked-by relation priority without changing the inspector selection or edge', async () => {
    const statusDefinitions = [
      ...buildDefaultTaskStatuses(),
      {
        id: 'status-waiting',
        symbol: 'w',
        name: 'Waiting',
        type: 'in-progress' as const,
        icon: 'pause',
        core: false,
      },
    ];
    const source = '- [ ] Previous\n- [ ] Current ⛔ related\n- [ ] Related 🆔 related\n';
    const h = await harness(source, 'Previous', {}, statusDefinitions);
    h.state.openInspectorDependency(h.node('Current'));
    const priorityMarker = expectDefined(
      h.el.querySelector<HTMLElement>(
        '[data-dependency-direction="blocked-by"] .abyss-status-marker',
      ),
    );

    priorityMarker.dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 12, clientY: 8 }),
    );
    button(activeDocument.body, '.abyss-status-popover-flag[data-abyss-priority="A"]').click();
    await flushMicrotasks(30);

    expect(await h.read()).toContain('- [ ] Related 🆔 related 🔺');
    expect(h.node('Related').node.priority).toBe('A');
    const statusMarker = expectDefined(
      h.el.querySelector<HTMLElement>(
        '[data-dependency-direction="blocked-by"] .abyss-status-marker[data-priority="A"]',
      ),
    );
    expect(statusMarker).not.toBe(priorityMarker);
    statusMarker.dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 12, clientY: 8 }),
    );
    expectDefined(
      [...activeDocument.body.querySelectorAll<HTMLElement>('.abyss-status-popover-row')].find(
        (row) => row.textContent.includes('Waiting'),
      ),
    ).click();
    await flushMicrotasks(30);

    expect(await h.read()).toBe(
      '- [ ] Previous\n- [ ] Current ⛔ related\n- [w] Related 🆔 related 🔺\n',
    );
    expect(h.node('Related').node.statusSymbol).toBe('w');
    expect(h.node('Current').node.statusSymbol).toBe(' ');
    expect(h.state.get('taskStack').map((node) => node.title)).toEqual(['Current']);
    expect(h.state.get('inspectorBackStack').map((frame) => frame.taskStack[0]?.title)).toEqual([
      'Previous',
    ]);
    expect(h.index.dependencies(h.node('Current').target).blockedBy).toMatchObject([
      { type: 'resolved', dependencyId: 'related', task: { node: { title: 'Related' } } },
    ]);
  });

  it('restores focus to a keyboard context-menu dependency trigger on Escape', async () => {
    const h = await harness('- [ ] Current ⛔ related\n- [ ] Related 🆔 related\n');
    const marker = expectDefined(
      h.el.querySelector<HTMLElement>(
        '[data-dependency-direction="blocked-by"] .abyss-status-marker',
      ),
    );
    vi.useFakeTimers();
    try {
      marker.focus();
      marker.dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, cancelable: true, detail: 0 }),
      );
      vi.runOnlyPendingTimers();

      expect(activeDocument.body.querySelector('.abyss-status-popover')).not.toBeNull();
      activeDocument.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

      expect(activeDocument.body.querySelector('.abyss-status-popover')).toBeNull();
      expect(activeDocument.activeElement).toBe(marker);
    } finally {
      vi.useRealTimers();
    }
  });

  it('closes a dependency status menu before refreshing its relation row', async () => {
    const h = await harness('- [ ] Current ⛔ related\n- [ ] Related 🆔 related\n');
    const marker = expectDefined(
      h.el.querySelector<HTMLElement>(
        '[data-dependency-direction="blocked-by"] .abyss-status-marker',
      ),
    );
    marker.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    const popover = expectDefined(
      activeDocument.body.querySelector<HTMLElement>('.abyss-status-popover'),
    );

    await h.api.execute({
      type: 'patch',
      target: { type: 'task', ref: h.node('Related').root.ref },
      patch: { priority: { type: 'set', value: 'A' } },
    });
    await flushMicrotasks(30);

    expect(marker.isConnected).toBe(false);
    expect(popover.isConnected).toBe(false);
  });

  it('replaces and clears a dependency status menu handle after closing and refreshing', async () => {
    const h = await harness('- [ ] Current ⛔ related\n- [ ] Related 🆔 related\n');
    const panel = h.panel as unknown as {
      dependencyStatusMenu_abyssPrivate: { element: HTMLElement } | undefined;
    };
    const marker = expectDefined(
      h.el.querySelector<HTMLElement>(
        '[data-dependency-direction="blocked-by"] .abyss-status-marker',
      ),
    );
    vi.useFakeTimers();
    try {
      marker.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
      vi.runOnlyPendingTimers();
      const firstMenu = expectDefined(panel.dependencyStatusMenu_abyssPrivate);
      expect(firstMenu.element.isConnected).toBe(true);

      activeDocument.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      expect(firstMenu.element.isConnected).toBe(false);

      vi.useRealTimers();
      marker.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
      const secondMenu = expectDefined(panel.dependencyStatusMenu_abyssPrivate);
      expect(secondMenu).not.toBe(firstMenu);
      await h.api.execute({
        type: 'patch',
        target: { type: 'task', ref: h.node('Related').root.ref },
        patch: { priority: { type: 'set', value: 'A' } },
      });
      await flushMicrotasks(30);

      expect(panel.dependencyStatusMenu_abyssPrivate).toBeUndefined();
      expect(secondMenu.element.isConnected).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('edits a blocks relation custom status without changing the inspector selection or edge', async () => {
    const statusDefinitions = [
      ...buildDefaultTaskStatuses(),
      {
        id: 'status-waiting',
        symbol: 'w',
        name: 'Waiting',
        type: 'in-progress' as const,
        icon: 'pause',
        core: false,
      },
    ];
    const source = '- [ ] Previous\n- [ ] Current 🆔 current\n- [ ] Related ⛔ current\n';
    const h = await harness(source, 'Previous', {}, statusDefinitions);
    h.state.openInspectorDependency(h.node('Current'));
    const marker = expectDefined(
      h.el.querySelector<HTMLElement>('[data-dependency-direction="blocks"] .abyss-status-marker'),
    );

    marker.click();
    expect(await h.read()).toBe(source);
    expect(h.state.get('taskStack').map((node) => node.title)).toEqual(['Current']);
    marker.dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 12, clientY: 8 }),
    );
    expect(activeDocument.body.querySelector('.abyss-status-popover')?.textContent).toContain(
      'Waiting',
    );
    expectDefined(
      [...activeDocument.body.querySelectorAll<HTMLElement>('.abyss-status-popover-row')].find(
        (row) => row.textContent.includes('Waiting'),
      ),
    ).click();
    await flushMicrotasks(30);

    expect(await h.read()).toContain('- [w] Related ⛔ current');
    expect(h.node('Related').node.statusSymbol).toBe('w');
    expect(h.state.get('taskStack').map((node) => node.title)).toEqual(['Current']);
    expect(h.state.get('inspectorBackStack').map((frame) => frame.taskStack[0]?.title)).toEqual([
      'Previous',
    ]);
    expect(h.index.dependencies(h.node('Current').target).blocks).toMatchObject([
      { type: 'resolved', dependencyId: 'current', task: { node: { title: 'Related' } } },
    ]);
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
  it('preserves nested current and both history frames through an owned linked child insertion', async () => {
    const h = await harness(source, 'C');
    const modal = new TaskModal(h.app, testStatusRegistry(), DEFAULT_SETTINGS, h.index, h.api);
    cleanups.unshift(() => {
      modal.close();
    });
    modal.open(h.node('C').root);
    const el = button(activeDocument.body, '.abyss-modal-body');
    button(el, '.abyss-dep-title').click();
    button(el, '.abyss-dep-title').click();
    button(el, '.abyss-dep-title').click();
    const local = modal as unknown as {
      innerState_abyssPrivate: AppState;
      innerPanel_abyssPrivate: RightPanel;
    };
    const history = local.innerState_abyssPrivate.get('inspectorBackStack');
    const original = JSON.stringify(history);
    button(el, '.abyss-dep-badge-body').click();
    const input = search(el, 'Created child');
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await flushMicrotasks(30);
    expect(local.innerState_abyssPrivate.get('taskStack').map((node) => node.title)).toEqual([
      'B',
      'B.2',
    ]);
    expect(local.innerState_abyssPrivate.get('taskStack')[1]?.ref).toEqual(h.node('B.2').node.ref);
    expect(JSON.stringify(history)).toBe(original);
    expect(local.innerState_abyssPrivate.get('inspectorBackStack')).toHaveLength(3);
    button(el, '[aria-label="Back to previous task"]').click();
    expect(local.innerState_abyssPrivate.get('taskStack').map((node) => node.title)).toEqual(['C']);
    button(el, '[aria-label="Back to previous task"]').click();
    expect(local.innerState_abyssPrivate.get('taskStack').map((node) => node.title)).toEqual([
      'B',
      'B.2',
    ]);
    expect(local.innerState_abyssPrivate.get('taskStack')[1]?.ref).toEqual(h.node('B.2').node.ref);
    expect(h.node('B.2').node.subtasks.map((child) => child.title)).toEqual([
      'Deep',
      'Created child',
    ]);
  });

  it('presents rejected committed evidence once without duplicating the application diagnostic', async () => {
    const h = await harness('- [ ] Current\n');
    const captured = notices();
    const consoleDiagnostic = vi.spyOn(console, 'error').mockImplementation(() => {});
    const write = h.repository.createDependencySubtask.bind(h.repository);
    vi.spyOn(h.repository, 'createDependencySubtask').mockImplementationOnce(async (request) => {
      const result = await write(request);
      if (result.type !== 'committed' || result.outcome.type !== 'dependency-subtask')
        throw new Error('Expected real committed creation');
      return { ...result, outcome: { ...result.outcome, dependencyId: 'unproven' } };
    });
    button(h.el, '.abyss-dep-badge-body').click();
    const input = search(h.el, 'Private draft');
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await flushMicrotasks();
    expect(captured).toHaveLength(1);
    expect(h.diagnostics).toHaveBeenCalledExactlyOnceWith({
      operation: 'create-dependency-subtask',
      phase: 'unexpected',
      cause: 'repository-error',
    });
    expect(consoleDiagnostic).not.toHaveBeenCalled();
    expect(JSON.stringify(h.diagnostics.mock.calls)).not.toMatch(/Private|Current|tasks\.md/u);
    expect(h.el.querySelector('.abyss-dep-search input')).toBe(input);
    expect(input.value).toBe('Private draft');
    expect(input.disabled).toBe(false);
  });

  it('keeps the creation draft with one Notice and diagnostic after an unexpected API throw', async () => {
    const h = await harness('- [ ] Current\n');
    const captured = notices();
    const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(h.api, 'execute').mockRejectedValueOnce(new Error('private content'));
    button(h.el, '.abyss-dep-badge-body').click();
    const input = search(h.el, 'Draft child');
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await flushMicrotasks();
    expect(captured).toHaveLength(1);
    expect(diagnostic).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(diagnostic.mock.calls)).not.toContain('private content');
    expect(h.el.querySelector('.abyss-dep-search input')).toBe(input);
    expect(input.value).toBe('Draft child');
    expect(input.disabled).toBe(false);
    expect(await h.read()).toBe('- [ ] Current\n');
  });
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
        innerState_abyssPrivate: AppState;
        innerPanel_abyssPrivate: {
          updateDescription_abyssPrivate(task: SubtaskSnapshot, text: string): Promise<boolean>;
          updatePriority_abyssPrivate(task: SubtaskSnapshot, priority: string): Promise<void>;
          commitStatus_abyssPrivate(task: SubtaskSnapshot, symbol: string): Promise<void>;
        };
      };
      const selected = expectDefined(h.node('B.2').path[0]);
      const history = local.innerState_abyssPrivate.get('inspectorBackStack');
      const originalHistory = JSON.stringify(history);
      if (kind === 'description')
        await local.innerPanel_abyssPrivate.updateDescription_abyssPrivate(
          selected,
          'First line\nSecond line',
        );
      else if (kind === 'planning')
        await local.innerPanel_abyssPrivate.updatePriority_abyssPrivate(selected, 'A');
      else await local.innerPanel_abyssPrivate.commitStatus_abyssPrivate(selected, '/');
      await flushMicrotasks(30);
      expect(local.innerState_abyssPrivate.get('taskStack').map((node) => node.title)).toEqual([
        'B',
        'B.2',
      ]);
      expect(JSON.stringify(history)).toBe(originalHistory);
      expect(local.innerState_abyssPrivate.get('inspectorBackStack')[0]?.taskStack[0]?.ref).toEqual(
        h.node('C').root.ref,
      );
      const fresh = h.node('B.2');
      if (kind === 'description') expect(fresh.node.description).toBe('First line\nSecond line');
      else if (kind === 'planning') expect(fresh.node.priority).toBe('A');
      else expect(fresh.node.statusSymbol).toBe('/');
      button(el, '[aria-label="Back to previous task"]').click();
      expect(local.innerState_abyssPrivate.get('taskStack').map((node) => node.title)).toEqual([
        'C',
      ]);
      expect(local.innerState_abyssPrivate.get('taskStack')[0]?.ref).toEqual(h.node('C').root.ref);
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
    const local = modal as unknown as {
      innerState_abyssPrivate: AppState;
      innerPanel_abyssPrivate: RightPanel;
    };
    await local.innerPanel_abyssPrivate.updateTaskTitle(
      expectDefined(h.node('B.2').path[0]),
      'Edited B.2',
    );
    await flushMicrotasks(30);
    expect(local.innerState_abyssPrivate.get('taskStack').map((node) => node.title)).toEqual(['B']);
    expect(await h.read()).toContain('Concurrent child');
    expect(await h.read()).toContain('Edited B.2');
    expect(local.innerState_abyssPrivate.backInspectorDependency()).toBe(true);
    expect(local.innerState_abyssPrivate.get('taskStack').map((node) => node.title)).toEqual(['C']);
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
      const local = modal as unknown as {
        innerState_abyssPrivate: AppState;
        innerPanel_abyssPrivate: RightPanel;
      };
      const state = surface === 'modal' ? local.innerState_abyssPrivate : h.state;
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
    expect(h.el.querySelectorAll('[role="option"]:not([disabled])')).toHaveLength(0);
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
        button(h.el, '[role="option"]').click();
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
    for (const selector of ['.abyss-dep-row .abyss-dep-remove', '.abyss-dep-add'])
      expect(value(selector, 'background')).toBe('transparent');
    expect(css).toMatch(
      /@media\s*\(pointer: coarse\)\s*\{\s*\.abyss-dep-remove\s*\{\s*opacity: 1;/u,
    );
  });

  it('renders a neutral empty dependency badge and restores directional counts after adding one', async () => {
    const h = await harness('- [ ] Current\n- [ ] Candidate\n');
    cleanups.unshift(
      h.index.subscribe(() => {
        h.state.updateInspectorSelection([h.node('Current').root]);
      }),
    );
    const badge = expectDefined(h.el.querySelector<HTMLElement>('.abyss-dep-badge'));
    const body = button(badge, '.abyss-dep-badge-body');
    const plus = button(badge, '.abyss-dep-badge-add');
    const lock = expectDefined(body.querySelector<HTMLElement>('.abyss-dep-lock'));
    const blockedBy = expectDefined(
      body.querySelector<HTMLElement>('[data-dependency-count="blocked-by"]'),
    );
    const divider = expectDefined(body.querySelector<HTMLElement>('.abyss-dep-divider'));
    const blocks = expectDefined(
      body.querySelector<HTMLElement>('[data-dependency-count="blocks"]'),
    );

    expect(body.children).toHaveLength(4);
    expect(lock.textContent).toBe('🔒');
    expect(lock.querySelector('svg')).toBeNull();
    expect(lock.getAttribute('aria-hidden')).toBe('true');
    expect(blockedBy.dataset['dependencyCount']).toBe('blocked-by');
    expect(blocks.dataset['dependencyCount']).toBe('blocks');
    expect([...body.children].filter((child) => !child.hasAttribute('hidden'))).toEqual([
      lock,
      blockedBy,
    ]);
    expect(lock.classList).not.toContain('abyss-dep-count-blocked-by');
    expect(lock.classList).not.toContain('abyss-dep-count-blocks');
    expect(blockedBy.classList).not.toContain('abyss-dep-count-blocked-by');
    expect(blockedBy.textContent).toBe('0');
    expect(divider.hidden).toBe(true);
    expect(blocks.hidden).toBe(true);
    expect(body.getAttribute('aria-label')).toBe('Dependencies: blocked by 0; blocks 0');
    expect(body.title).toBe('Dependencies: blocked by 0; blocks 0');
    expect(plus.parentElement).toBe(badge);
    expect(body.contains(plus)).toBe(false);
    expect(plus.getAttribute('aria-label')).toBe('Add dependency sections');
    expect(plus.title).toBe('Add dependency');

    const decoy = body.createSpan({ cls: 'abyss-dep-test-decoy' });
    body.insertBefore(decoy, blockedBy);
    body.click();
    expect(h.el.querySelector('.abyss-dep-search')).not.toBeNull();
    expect(decoy.className).toBe('abyss-dep-test-decoy');
    expect(blockedBy.textContent).toBe('0');
    expect(blockedBy.className).toBe('abyss-dep-count');
    expect(divider.hidden).toBe(true);
    expect(blocks.hidden).toBe(true);
    search(h.el, '').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

    await h.api.execute({
      type: 'add-dependency',
      blocker: h.node('Candidate').target,
      dependent: h.node('Current').target,
    });
    await flushMicrotasks(30);

    const updatedBody = button(h.el, '.abyss-dep-badge-body');
    const updatedDivider = expectDefined(
      updatedBody.querySelector<HTMLElement>('.abyss-dep-divider'),
    );
    const updatedBlockedBy = expectDefined(
      updatedBody.querySelector<HTMLElement>('[data-dependency-count="blocked-by"]'),
    );
    const updatedBlocks = expectDefined(
      updatedBody.querySelector<HTMLElement>('[data-dependency-count="blocks"]'),
    );
    expect(updatedDivider.hidden).toBe(false);
    expect(updatedBlocks.hidden).toBe(false);
    expect(updatedBlockedBy.classList).toContain('abyss-dep-count-blocked-by');
    expect(updatedBlocks.classList).toContain('abyss-dep-count-blocks');

    await h.api.execute({ type: 'toggle-completion', target: h.node('Candidate').target });
    await flushMicrotasks(30);

    const settledBody = button(h.el, '.abyss-dep-badge-body');
    const settledLock = expectDefined(settledBody.querySelector<HTMLElement>('.abyss-dep-lock'));
    const settledBlockedBy = expectDefined(
      settledBody.querySelector<HTMLElement>('[data-dependency-count="blocked-by"]'),
    );
    const settledDivider = expectDefined(
      settledBody.querySelector<HTMLElement>('.abyss-dep-divider'),
    );
    const settledBlocks = expectDefined(
      settledBody.querySelector<HTMLElement>('[data-dependency-count="blocks"]'),
    );
    expect([...settledBody.children].filter((child) => !child.hasAttribute('hidden'))).toEqual([
      settledLock,
      settledBlockedBy,
    ]);
    expect(settledLock.className).toBe('abyss-dep-lock');
    expect(settledBlockedBy.className).toBe('abyss-dep-count');
    expect(settledDivider.hidden).toBe(true);
    expect(settledBlocks.hidden).toBe(true);
  });

  it('keeps blank Create hidden without an author display override and exposes a focusable nonblank action', async () => {
    if (!Platform.isDesktop) throw new Error('CSS contract requires desktop filesystem access');
    const fs = await import('node:fs');
    const { parse } = await import('postcss');
    const sheet = parse(fs.readFileSync(`${import.meta.dirname}/../styles.css`, 'utf8'));
    const h = await harness('- [ ] Current\n');
    button(h.el, '.abyss-dep-badge-body').click();
    const create = button(h.el, '.abyss-dep-search-create');
    const authorDisplays = () => {
      const values: string[] = [];
      sheet.walkRules((rule) => {
        if (create.matches(rule.selector))
          rule.walkDecls('display', (declaration) => {
            values.push(declaration.value);
          });
      });
      return values;
    };
    expect(create.hidden).toBe(true);
    expect(authorDisplays()).toEqual([]);
    expect(activeWindow.getComputedStyle(create).display).toBe('none');
    search(h.el, 'New task');
    expect(create.hidden).toBe(false);
    expect(authorDisplays()).toContain('block');
    expect(activeWindow.getComputedStyle(create).display).not.toBe('none');
    expect(create.tabIndex).toBe(0);
    create.focus();
    expect(activeDocument.activeElement).toBe(create);
    search(h.el, '  ');
    expect(create.hidden).toBe(true);
    expect(authorDisplays()).toEqual([]);
    expect(activeWindow.getComputedStyle(create).display).toBe('none');
  });

  it('updates inspector lock color from active relations and retains completed rows', async () => {
    const h = await harness('- [ ] Current 🆔 current\n- [ ] Before 🆔 before\n- [ ] After\n');
    cleanups.unshift(
      h.index.subscribe(() => {
        h.state.updateInspectorSelection([h.node('Current').root]);
      }),
    );
    const check = (color: string | undefined, counts: string) => {
      const body = button(h.el, '.abyss-dep-badge-body');
      const lock = expectDefined(body.querySelector('.abyss-dep-lock'));
      expect(body.textContent).toBe(`🔒${counts}`);
      expect(lock.classList.contains('abyss-dep-count-blocked-by')).toBe(color === 'blocked-by');
      expect(lock.classList.contains('abyss-dep-count-blocks')).toBe(color === 'blocks');
      expect(lock.textContent).toBe('🔒');
    };
    check(undefined, '00');
    await h.api.execute({
      type: 'add-dependency',
      blocker: h.node('Current').target,
      dependent: h.node('After').target,
    });
    await flushMicrotasks(30);
    check('blocks', '01');
    await h.api.execute({
      type: 'add-dependency',
      blocker: h.node('Before').target,
      dependent: h.node('Current').target,
    });
    await flushMicrotasks(30);
    check('blocked-by', '11');
    await h.api.execute({ type: 'toggle-completion', target: h.node('Before').target });
    await flushMicrotasks(30);
    check('blocks', '01');
    await h.api.execute({ type: 'toggle-completion', target: h.node('Current').target });
    await flushMicrotasks(30);
    check(undefined, '00');
    expect(h.el.querySelectorAll('.abyss-dep-row')).toHaveLength(2);
    expect(h.el.querySelector('[data-dependency-direction="blocked-by"] .is-done')).not.toBeNull();
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

  it('keeps invalid creation inline with its draft and no Notice', async () => {
    const captured = notices();
    const h = await harness('- [ ] Current\n- [ ] Candidate\n');
    const execute = vi.spyOn(h.api, 'execute');
    button(h.el, '.abyss-dep-badge-body').click();
    const input = search(h.el, 'Brand new 🆔 authored');
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await flushMicrotasks();

    expect(h.el.querySelector('[role="status"]')?.textContent).toMatch(/invalid/i);
    expect(input.value).toBe('Brand new 🆔 authored');
    expect(activeDocument.activeElement).toBe(input);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(captured).toHaveLength(0);
    expect(await h.read()).toBe('- [ ] Current\n- [ ] Candidate\n');
  });

  it.each(['general', 'fixed'] as const)(
    'creates a linked child from the %s picker without a success Notice',
    async (context) => {
      const captured = notices();
      const h = await harness('- [ ] Current\n');
      if (context === 'general') {
        button(h.el, '.abyss-dep-badge-body').click();
        button(h.el, '[data-direction="blocks"]').click();
      } else {
        button(h.el, '.abyss-dep-badge-add').click();
        button(h.el, '[aria-label="Add dependency: Blocks"]').click();
      }
      const input = search(h.el, 'Brand new');
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await flushMicrotasks();
      expect(await h.read()).toBe(
        '- [ ] Current 🆔 generate\n  - [ ] Brand new ➕ 2026-09-05 ⛔ generate\n',
      );
      expect(h.el.querySelector('.abyss-dep-search')).toBeNull();
      expect(h.state.get('taskStack').map((node) => node.title)).toEqual(['Current']);
      expect(captured).toHaveLength(0);
    },
  );

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
    expect(value('.abyss-dep-badge > button', 'gap')).toBe('2px');
    expect(value('.abyss-dep-badge > button', 'font')).toBe('inherit');
    expect(value('.abyss-dep-lock', 'color')).toBe('var(--text-muted)');
    expect(value('.abyss-dep-count-blocked-by', 'color')).toBe(
      'var(--abyss-dependency-blocked-by)',
    );
    expect(value('.abyss-dep-count-blocks', 'color')).toBe('var(--abyss-dependency-blocks)');
    expect(value('.abyss-dep-badge:hover', 'background')).toBe('var(--background-modifier-hover)');
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

  it.each(['main', 'invoking'] as const)(
    'preserves native Create keyboard intent through a refresh in the %s document',
    async (realm) => {
      const h = await harness('- [ ] Current\n- [ ] Candidate\n');
      if (realm === 'invoking') {
        const frame = activeDocument.body.createEl('iframe');
        expectDefined(frame.contentDocument).body.append(h.el);
      }
      const doc = h.el.ownerDocument;
      const execute = vi.spyOn(h.api, 'execute');
      button(h.el, '.abyss-dep-badge-body').click();
      const input = search(h.el, 'Candidate');
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
      const selected = input.getAttribute('aria-activedescendant');
      const create = button(h.el, '.abyss-dep-search-create');
      create.focus();
      const focus = vi.spyOn(create, 'focus');

      h.state.set('taskStack', [h.node('Current').root]);

      expect(doc.activeElement).toBe(create);
      expect(focus).toHaveBeenLastCalledWith({ preventScroll: true });
      expect(input.getAttribute('aria-activedescendant')).toBe(selected);
      expect(create.type).toBe('button');
      const active = expectDefined(doc.activeElement);
      const enter = new KeyboardEvent('keydown', {
        key: 'Enter',
        bubbles: true,
        cancelable: true,
      });
      // jsdom does not supply the browser's default Enter activation for native buttons.
      if (active.dispatchEvent(enter) && active.tagName === 'BUTTON') {
        (active as HTMLButtonElement).click();
      }
      await flushMicrotasks();
      expect(execute).toHaveBeenCalledTimes(1);
      expect(execute).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'create-dependency-subtask',
          direction: 'blocked-by',
          text: 'Candidate',
        }),
      );
    },
  );

  it('preserves a direction control through refresh without changing its action', async () => {
    const h = await harness('- [ ] Current\n- [ ] Candidate\n');
    button(h.el, '.abyss-dep-badge-body').click();
    const input = search(h.el, 'Candidate');
    const direction = button(h.el, '[data-direction="blocks"]');
    direction.focus();
    const focus = vi.spyOn(direction, 'focus');

    h.state.set('taskStack', [h.node('Current').root]);

    expect(h.el.ownerDocument.activeElement).toBe(direction);
    expect(focus).toHaveBeenLastCalledWith({ preventScroll: true });
    expect(direction.getAttribute('aria-pressed')).toBe('false');
    direction.click();
    expect(direction.getAttribute('aria-pressed')).toBe('true');
    expect(h.el.ownerDocument.activeElement).toBe(input);
  });

  it('falls back to the input when the focused result is rebuilt without losing selection', async () => {
    const h = await harness('- [ ] Current\n- [ ] Candidate\n');
    button(h.el, '.abyss-dep-badge-body').click();
    const input = search(h.el, 'Candidate');
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    const option = button(h.el, '[aria-selected="true"]');
    option.focus();
    const focus = vi.spyOn(input, 'focus');

    h.state.set('taskStack', [h.node('Current').root]);

    expect(option.isConnected).toBe(false);
    expect(h.el.ownerDocument.activeElement).toBe(input);
    expect(focus).toHaveBeenLastCalledWith({ preventScroll: true });
    expect(button(h.el, '[aria-selected="true"]').id).toBe(
      input.getAttribute('aria-activedescendant'),
    );
  });

  it('falls back to the input if the retained Create control becomes hidden', async () => {
    const h = await harness('- [ ] Current\n');
    button(h.el, '.abyss-dep-badge-body').click();
    const input = search(h.el, 'Candidate');
    const create = button(h.el, '.abyss-dep-search-create');
    create.focus();
    input.value = '';

    h.state.set('taskStack', [h.node('Current').root]);

    expect(create.hidden).toBe(true);
    expect(h.el.ownerDocument.activeElement).toBe(input);
  });

  it('falls back to the input while the retained Create control is pending and disabled', async () => {
    const h = await harness('- [ ] Current\n');
    const pending = deferred<TaskCommandResult>();
    vi.spyOn(h.api, 'execute').mockReturnValue(pending.promise);
    button(h.el, '.abyss-dep-badge-body').click();
    const input = search(h.el, 'Candidate');
    const create = button(h.el, '.abyss-dep-search-create');
    create.focus();
    create.click();

    h.state.set('taskStack', [h.node('Current').root]);

    expect(create.disabled).toBe(true);
    expect(h.el.ownerDocument.activeElement).toBe(input);
    pending.resolve({ type: 'not-found', target: h.node('Current').target });
    await flushMicrotasks();
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
    'adds from the %s section through the real command without success feedback',
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
      expect(captured).toHaveLength(0);
      expect(h.el.querySelector('.abyss-undo-row')).toBeNull();
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
      expect(captured).toHaveLength(0);
      button(h.el, '.abyss-undo-row button').click();
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
      button(h.el, '.abyss-undo-row button').click();
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
      button(h.el, '[role="option"]').click();
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
    button(h.el, '[role="option"]').click();
    await flushMicrotasks(20);
    expect(log).toHaveBeenCalledOnce();
    expect(log.mock.calls[0]?.[0]).toContain('[abyss-tasks]');
    expect(captured).toHaveLength(1);
    expect(h.el.querySelector('.abyss-dep-search input')).toHaveProperty('value', 'Candidate');
    expect(h.el.querySelectorAll('.abyss-dep-row')).toHaveLength(0);
  });
});
