import { Notice, Platform, requireApiVersion, TFile } from 'obsidian';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppState } from '../src/app/AppState';
import { RightPanel } from '../src/panels/RightPanel';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import { localDate, type TaskApplicationApi, type TaskCommandResult } from '../src/tasks';
import { TaskApplicationService } from '../src/tasks/application/TaskApplicationService';
import { TaskDependencyService } from '../src/tasks/application/TaskDependencyService';
import { TaskIndex } from '../src/tasks/infrastructure/TaskIndex';
import { TaskRefAuthority } from '../src/tasks/infrastructure/TaskRefAuthority';
import { TaskBlockEditor } from '../src/tasks/infrastructure/markdown/TaskBlockEditor';
import { TaskLocator } from '../src/tasks/infrastructure/markdown/TaskLocator';
import { TaskMarkdownCodec } from '../src/tasks/infrastructure/markdown/TaskMarkdownCodec';
import { ObsidianTaskRepository } from '../src/tasks/infrastructure/obsidian/ObsidianTaskRepository';
import { TaskModal } from '../src/ui/TaskModal';
import { rebuildTaskSelection } from '../src/ui/taskSelection';
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

useRealMoment();
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) {
    cleanup();
  }
  activeDocument.body.empty();
  vi.restoreAllMocks();
});

async function harness(markdown: string, selected = 'Current') {
  // The mock metadata parser uses -0 for a root list beginning on line zero.
  const app = await createAppWithFiles({ 'tasks.md': `\n${markdown}` });
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

function notices(): Notice[] {
  const captured: Notice[] = [];
  const prototype = Notice.prototype as unknown as {
    constructor__(this: Notice, message: string | DocumentFragment): void;
  };
  vi.spyOn(prototype, 'constructor__').mockImplementation(function (this: Notice) {
    captured.push(this);
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
  const input = expectDefined(el.querySelector<HTMLInputElement>('.abyss-dependency-search input'));
  input.value = query;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  return input;
}

describe('TaskModal dependency selection', () => {
  it.each([
    ['nested', '- [ ] Parent\n  - [ ] Current\n  - [ ] Current\n- [ ] Candidate 🆔 candidate\n'],
    [
      'deep',
      '- [ ] Parent\n  - [ ] Middle\n    - [ ] Current\n    - [ ] Current\n- [ ] Candidate 🆔 candidate\n',
    ],
  ])(
    'retains the exact %s duplicate through add, remove and restore dependency events',
    async (_location, source) => {
      const h = await harness(source, 'Parent');
      h.panel.destroy();
      const modal = new TaskModal(h.app, testStatusRegistry(), DEFAULT_SETTINGS, h.index, h.api);
      cleanups.unshift(() => {
        modal.close();
      });
      modal.open(h.node('Parent').root);
      const el = expectDefined(activeDocument.querySelector<HTMLElement>('.abyss-modal-body'));
      if (_location === 'deep') button(el, '.abyss-subtask-label').click();
      const duplicates = el.querySelectorAll<HTMLElement>('.abyss-subtask-label');
      expectDefined(duplicates[1]).click();
      expect(el.querySelector('.abyss-right-title')?.textContent).toBe('Current');
      button(el, '.abyss-dependency-badge-add').click();
      button(el, '[aria-label="Add dependency: Blocked by"]').click();
      search(el, 'Candidate').dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
      );
      await flushMicrotasks(30);
      expect(el.querySelector('.abyss-right-title')?.textContent).toBe('Current');
      expect(button(el, '.abyss-dependency-badge-body').getAttribute('aria-label')).toBe(
        'Dependencies: blocked by 1; blocks 0',
      );
      const current = expectDefined(
        h.index.listNodes().filter(({ node }) => node.title === 'Current')[1],
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
      expect(button(el, '.abyss-dependency-badge-body').getAttribute('aria-label')).toBe(
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
      button(h.el, '.abyss-dependency-badge-add').click();
      button(h.el, '[aria-label="Add dependency: Blocked by"]').click();
      search(h.el, 'Candidate').dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
      );
      await flushMicrotasks(50);
      expect(await execute.mock.results[0]?.value).toMatchObject({ type: 'ok' });
      expect(await h.read()).toBe(wanted);
      expect(button(h.el, '.abyss-dependency-badge-body').getAttribute('aria-label')).toBe(
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
    const oldBadge = h.el.querySelector<HTMLButtonElement>('.abyss-dependency-badge-body');
    oldBadge?.click();
    expect(h.el.querySelectorAll('.abyss-dependency-search-option:not([disabled])')).toHaveLength(
      0,
    );
    expect(await h.read()).toBe(changed.slice(1));
  });

  it.each(['focus', 'success', 'destroy', 'selection', 'refresh'] as const)(
    'releases search document listeners after %s',
    async (mode) => {
      const h = await harness('- [ ] Current\n- [ ] Candidate\n');
      const add = vi.spyOn(h.el.ownerDocument, 'addEventListener');
      const remove = vi.spyOn(h.el.ownerDocument, 'removeEventListener');
      button(h.el, '.abyss-dependency-badge-body').click();
      const input = search(h.el, 'Candidate');
      if (mode === 'focus') activeDocument.body.createEl('button').focus();
      if (mode === 'destroy') h.panel.destroy();
      if (mode === 'selection') h.state.set('taskStack', [h.node('Candidate').root]);
      if (mode === 'success') {
        button(h.el, '.abyss-dependency-search-option').click();
        button(h.el, '[data-direction="blocks"]').click();
        await flushMicrotasks(50);
      }
      if (mode === 'refresh') {
        h.state.set('taskStack', [h.node('Current').root]);
        expect(h.el.querySelector('.abyss-dependency-search input')).toBe(input);
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
      button(h.el, '.abyss-dependency-badge-body').click();
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
    const css = fs.readFileSync(`${import.meta.dirname}/../styles.css`, 'utf8');
    const value = (selector: string, property: string) =>
      cssDeclarationValue(cssDeclarationsFor(css, selector), property);
    expect(value('.abyss-dependency-remove', 'opacity')).toBe('0');
    expect(value('.abyss-dependency-remove', 'position')).not.toBe('absolute');
    expect(value('.abyss-dependency-row:hover .abyss-dependency-remove', 'opacity')).toBe('1');
    expect(value('.abyss-dependency-row:focus-within .abyss-dependency-remove', 'opacity')).toBe(
      '1',
    );
    expect(value('.abyss-dependency-row.is-unavailable .abyss-dependency-remove', 'opacity')).toBe(
      '1',
    );
    expect(value('.abyss-dependency-title', 'text-overflow')).toBe('ellipsis');
    for (const selector of [
      '.abyss-dependency-row .abyss-dependency-remove',
      '.abyss-dependency-section .abyss-dependency-add',
      '.abyss-dependency-search .abyss-dependency-search-option',
    ])
      expect(value(selector, 'background')).toBe('transparent');
    expect(css).toMatch(
      /@media\s*\(pointer: coarse\)\s*\{\s*\.abyss-dependency-remove\s*\{\s*opacity: 1;/u,
    );
  });

  it('keeps a search draft through a proven selection refresh and drops it on another task', async () => {
    const h = await harness('- [ ] Current\n- [ ] Candidate\n');
    button(h.el, '.abyss-dependency-badge-body').click();
    const input = search(h.el, 'Candidate');
    button(h.el, '.abyss-dependency-search-option').click();
    expect(activeDocument.activeElement?.getAttribute('data-direction')).toBe('blocked-by');
    h.state.set('taskStack', [h.node('Current').root]);
    expect(h.el.querySelectorAll('[data-direction]')).toHaveLength(0);
    expect(activeDocument.activeElement).toBe(input);
    await h.api.execute({
      type: 'patch',
      target: { type: 'task', ref: h.node('Current').root.ref },
      patch: { priority: { type: 'set', value: 'A' } },
    });
    h.state.set('taskStack', [h.node('Current').root]);
    expect(h.el.querySelector('.abyss-dependency-search input')).toBe(input);
    expect(input.value).toBe('Candidate');
    expect(activeDocument.activeElement).toBe(input);
    h.state.set('taskStack', [h.node('Candidate').root]);
    expect(h.el.querySelector('.abyss-dependency-search')).toBeNull();
  });

  it('reconciles counterpart completion and missing IDs through normal index events without discarding an editing draft', async () => {
    const h = await harness('- [ ] Current ⛔ blocker\n- [ ] Blocker 🆔 blocker\n');
    button(h.el, '.abyss-dependency-badge-body').click();
    const input = search(h.el, 'Keep this query');
    await h.api.execute({ type: 'toggle-completion', target: h.node('Blocker').target });
    await flushMicrotasks();
    expect(button(h.el, '.abyss-dependency-badge-body').getAttribute('aria-label')).toBe(
      'Dependencies: blocked by 0; blocks 0',
    );
    expect(h.el.querySelector('.abyss-dependency-row .is-done')).not.toBeNull();
    expect(input.value).toBe('Keep this query');
    await h.app.vault.modify(h.file, '\n- [ ] Current ⛔ blocker\n');
    await flushMicrotasks(20);
    expect(h.el.querySelector('.abyss-dependency-row')?.textContent).toBe(
      'Task unavailableblocker',
    );
  });

  it('renders compact direct relations in order with done and raw-ID recovery rows', async () => {
    const h = await harness(
      '- [ ] Current 🆔 current ⛔ active, done, missing, duplicate\n  - > Own description\n- [ ] Active 🆔 active\n  - > Hidden prerequisite description\n- [x] Done 🆔 done\n- [ ] First 🆔 duplicate\n- [x] Second 🆔 duplicate\n- [ ] Waiting ⛔ current\n',
    );
    expect(h.node('Active').node.description).toBe('Hidden prerequisite description');
    expect(h.el.textContent).toContain('Own description');
    expect(labels(h.el)).toEqual(['Description', 'Blocked by', 'Blocks', 'Sub-tasks', 'Comments']);
    expect(button(h.el, '.abyss-dependency-badge-body').getAttribute('aria-label')).toBe(
      'Dependencies: blocked by 2; blocks 1',
    );
    expect(h.el.querySelector('.abyss-dependency-badge-add')).toBeNull();
    const rows = [...h.el.querySelectorAll('.abyss-dependency-row')];
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
    for (const section of h.el.querySelectorAll('.abyss-dependency-section'))
      expect(section.lastElementChild?.textContent).toBe('+Add dependency');
  });

  it('separates badge search from temporary add disclosure and dismisses empty sections with focus return', async () => {
    const h = await harness('- [ ] Current\n- [ ] Candidate\n');
    expect(labels(h.el)).toEqual(['Description', 'Sub-tasks', 'Comments']);
    const badge = button(h.el, '.abyss-dependency-badge-body');
    const plus = button(h.el, '.abyss-dependency-badge-add');
    expect([badge.tabIndex, plus.tabIndex]).toEqual([0, 0]);
    badge.click();
    expect(h.el.querySelector('.abyss-dependency-search')).not.toBeNull();
    expect(labels(h.el)).toEqual(['Description', 'Sub-tasks', 'Comments']);
    search(h.el, '').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(activeDocument.activeElement).toBe(badge);
    plus.click();
    expect(labels(h.el)).toEqual(['Description', 'Blocked by', 'Blocks', 'Sub-tasks', 'Comments']);
    expect(h.el.querySelector('.abyss-dependency-search')).toBeNull();
    expect(h.el.querySelector('.abyss-dependency-badge-add')).toBeNull();
    h.el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(labels(h.el)).toEqual(['Description', 'Sub-tasks', 'Comments']);
    expect(activeDocument.activeElement).toBe(h.el.querySelector('.abyss-dependency-badge-add'));
    button(h.el, '.abyss-dependency-badge-add').click();
    const outside = activeDocument.body.createEl('button');
    outside.focus();
    await flushMicrotasks();
    expect(labels(h.el)).toEqual(['Description', 'Sub-tasks', 'Comments']);
    expect(activeDocument.activeElement).toBe(outside);
  });

  it.each(['blocked-by', 'blocks'] as const)(
    'adds from the %s section through the real command and offers Undo',
    async (direction) => {
      const captured = notices();
      const h = await harness('- [ ] Current\n- [ ] Candidate\n');
      button(h.el, '.abyss-dependency-badge-add').click();
      button(h.el, `[data-dependency-direction="${direction}"] .abyss-dependency-add`).click();
      const input = search(h.el, 'Candidate');
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await flushMicrotasks(50);
      expect(await h.read()).toContain(
        direction === 'blocked-by' ? 'Current ⛔ generate' : 'Candidate ⛔ generate',
      );
      expect(h.el.querySelector('.abyss-dependency-search')).toBeNull();
      expect(h.el.querySelectorAll('.abyss-dependency-section')).toHaveLength(1);
      expect(h.el.querySelector('.abyss-dependency-row')?.textContent).toBe('Candidate');
      expect(captured).toHaveLength(1);
      button(activeDocument.body, '.mod-cta').click();
      await flushMicrotasks(50);
      expect(await h.read()).not.toContain('⛔');
      expect(await h.read()).toContain('🆔 generate');
      expect(h.el.querySelectorAll('.abyss-dependency-section')).toHaveLength(0);
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
      button(h.el, '.abyss-dependency-remove').click();
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
      button(h.el, '.abyss-dependency-badge-body').click();
      search(h.el, 'Candidate');
      button(h.el, '.abyss-dependency-search-option').click();
      button(h.el, '[data-direction="blocks"]').click();
      await flushMicrotasks(20);
      expect(h.el.querySelector('.abyss-dependency-search input')).toHaveProperty(
        'value',
        'Candidate',
      );
      expect(h.el.querySelectorAll('.abyss-dependency-row')).toHaveLength(0);
      expect(captured).toHaveLength(1);
      expect(await h.read()).toBe('- [ ] Current\n- [ ] Candidate\n');
    },
  );

  it('logs one unexpected handler failure and keeps the search and authoritative relations', async () => {
    const captured = notices();
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const h = await harness('- [ ] Current\n- [ ] Candidate\n');
    vi.spyOn(h.api, 'execute').mockRejectedValue(new Error('Unexpected'));
    button(h.el, '.abyss-dependency-badge-body').click();
    search(h.el, 'Candidate');
    button(h.el, '.abyss-dependency-search-option').click();
    button(h.el, '[data-direction="blocks"]').click();
    await flushMicrotasks(20);
    expect(log).toHaveBeenCalledOnce();
    expect(log.mock.calls[0]?.[0]).toContain('[abyss-tasks]');
    expect(captured).toHaveLength(1);
    expect(h.el.querySelector('.abyss-dependency-search input')).toHaveProperty(
      'value',
      'Candidate',
    );
    expect(h.el.querySelectorAll('.abyss-dependency-row')).toHaveLength(0);
  });
});
