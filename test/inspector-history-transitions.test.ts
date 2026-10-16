import { MarkdownRenderer, Notice, TFile, WorkspaceLeaf, type App } from 'obsidian';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppState } from '../src/app/AppState';
import type { RightPanel } from '../src/panels/RightPanel';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import { TagManager } from '../src/tags/TagManager';
import { TaskModal } from '../src/ui/TaskModal';
import { PanelView } from '../src/views/PanelView';
import {
  configuredTaskApplication,
  createAppWithFiles,
  DataTransferStub,
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
      new TagManager(app, DEFAULT_SETTINGS, async () => {}, {
        check: () => 'ready',
        apply: async (_change, applyLive) => {
          applyLive();
        },
      }),
      application.index,
      application.tasks,
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
    const modal = new TaskModal({
      app,
      statusRegistry: application.statusRegistry,
      settings: DEFAULT_SETTINGS,
      queries: application.index,
      tasks: application.tasks,
    });
    modal.open(node(selected).root);
    const local = modal as unknown as {
      innerState_abyssPrivate: AppState;
      innerPanel_abyssPrivate: RightPanel;
    };
    state = local.innerState_abyssPrivate;
    panel = local.innerPanel_abyssPrivate;
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

function reorderRows(
  element: HTMLElement,
  moved: number,
  target: number,
  placement: 'before' | 'after',
) {
  const rows = element.querySelectorAll<HTMLElement>('.abyss-subtask-row');
  const source = expectDefined(rows[moved]);
  const destination = expectDefined(rows[target]);
  const dataTransfer = new DataTransferStub();
  for (const [row, type] of [
    [source, 'dragstart'],
    [destination, 'dragover'],
    [destination, 'drop'],
    [source, 'dragend'],
  ] as const) {
    const event = new MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      clientY: placement === 'before' ? -1 : 1,
    });
    Object.defineProperty(event, 'dataTransfer', { value: dataTransfer });
    row.dispatchEvent(event);
  }
}
const onlyChildSource = {
  'LF, adjacent, final newline': '- [ ] Source\n- [ ] Root\n  - [ ] Parent\n    - [ ] Only\n',
  'LF, adjacent, no final newline': '- [ ] Source\n- [ ] Root\n  - [ ] Parent\n    - [ ] Only',
  'LF, gap, final newline': '- [ ] Source\n- [ ] Root\n  - [ ] Parent\n\n    - [ ] Only\n',
  'LF, gap, no final newline': '- [ ] Source\n- [ ] Root\n  - [ ] Parent\n\n    - [ ] Only',
  'CRLF, adjacent, final newline':
    '- [ ] Source\r\n- [ ] Root\r\n  - [ ] Parent\r\n    - [ ] Only\r\n',
  'CRLF, adjacent, no final newline':
    '- [ ] Source\r\n- [ ] Root\r\n  - [ ] Parent\r\n    - [ ] Only',
  'CRLF, gap, final newline':
    '- [ ] Source\r\n- [ ] Root\r\n  - [ ] Parent\r\n\r\n    - [ ] Only\r\n',
  'CRLF, gap, no final newline':
    '- [ ] Source\r\n- [ ] Root\r\n  - [ ] Parent\r\n\r\n    - [ ] Only',
} as const;

describe.each(['panel', 'modal'] as const)('%s saved dependency frames', (surface) => {
  it.each([
    { moved: 0, target: 1, placement: 'before' as const },
    { moved: 1, target: 0, placement: 'after' as const },
  ])(
    'keeps the inspector untouched for an unchanged $placement drop',
    async ({ moved, target, placement }) => {
      const h = await harness(
        surface,
        '- [ ] Root\n  - [ ] Parent\n    - > Description\n    - First comment line\n      Second comment line\n    - [ ] First\n    - [ ] Second\n',
        'Parent',
      );
      h.click('.abyss-comment-disclosure');
      h.click('.abyss-right-desc-view');
      await flushMicrotasks(5);
      const editor = expectDefined(
        h.el.querySelector<HTMLTextAreaElement>('.abyss-right-desc-edit'),
      );
      editor.value = 'Unchanged drop draft';
      editor.focus();
      editor.setSelectionRange(2, 7);
      const stack = h.state.get('taskStack');
      reorderRows(h.el, moved, target, placement);
      await flushMicrotasks(50);
      expect(h.el.querySelector('.abyss-right-desc-edit')).toBe(editor);
      expect(activeDocument.activeElement).toBe(editor);
      expect([editor.selectionStart, editor.selectionEnd]).toEqual([2, 7]);
      expect(h.el.querySelector('.abyss-comment-disclosure')?.getAttribute('aria-expanded')).toBe(
        'true',
      );
      expect(h.state.get('taskStack')).toBe(stack);
    },
  );

  it.each([
    {
      kind: 'date',
      selector: '.abyss-date-input',
      value: '2031-02-12',
      expected: { planning: { due: '2031-02-12' } },
    },
    {
      kind: 'time',
      selector: '.abyss-time-input',
      value: '10:45',
      expected: { planning: { time: '10:45' } },
    },
    {
      kind: 'tag',
      selector: '.abyss-tag-input',
      value: 'retained',
      expected: { tags: ['#retained'] },
    },
  ])(
    'saves an already open $kind popup after sibling reorder',
    async ({ kind, selector, value, expected }) => {
      const h = await harness(
        surface,
        '- [ ] Root\n  - [ ] Parent\n    - [ ] First\n    - [ ] Second\n',
        'Parent',
      );
      if (kind === 'date')
        expectDefined(
          [...h.el.querySelectorAll<HTMLButtonElement>('.abyss-chips-row > button')].find(
            (button) => button.textContent.startsWith('📅'),
          ),
        ).click();
      else h.click(kind === 'time' ? '.abyss-chip-time' : '[aria-label="Add tag"]');
      await flushMicrotasks(5);
      const input = expectDefined(h.el.querySelector<HTMLInputElement>(selector));
      input.dispatchEvent(new KeyboardEvent('keydown', { key: '1', bubbles: true }));
      input.value = value;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      reorderRows(h.el, 1, 0, 'before');
      await flushMicrotasks(50);
      expect(h.el.querySelector(selector)).toBe(input);
      expect(input.value).toBe(value);
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await flushMicrotasks(50);
      expect(h.node('Parent').node).toMatchObject(expected);
      expect(h.node('Root').node).toMatchObject({ priority: 'D', tags: [], planning: {} });
      expect(h.state.get('taskStack')).toEqual(h.liveStack('Parent'));
    },
  );

  it('saves a priority choice from a popup opened before sibling reorder', async () => {
    const h = await harness(
      surface,
      '- [ ] Root\n  - [ ] Parent\n    - [ ] First\n    - [ ] Second\n',
      'Parent',
    );
    h.click('.abyss-priority-chip');
    const popup = expectDefined(h.el.querySelector('.abyss-priority-popover'));
    reorderRows(h.el, 1, 0, 'before');
    await flushMicrotasks(50);
    expect(h.el.querySelector('.abyss-priority-popover')).toBe(popup);
    h.click('.abyss-priority-option[data-priority="A"]');
    await flushMicrotasks(50);
    expect(h.node('Parent').node.priority).toBe('A');
    expect(h.node('Root').node.priority).toBe('D');
    expect(h.state.get('taskStack')).toEqual(h.liveStack('Parent'));
  });

  it('opens the correct date target from an add-date menu retained through reorder', async () => {
    const h = await harness(
      surface,
      '- [ ] Root\n  - [ ] Parent\n    - [ ] First\n    - [ ] Second\n',
      'Parent',
    );
    h.click('[aria-label="Add start or plan date"]');
    reorderRows(h.el, 1, 0, 'before');
    await flushMicrotasks(50);
    expectDefined(
      [...h.el.querySelectorAll<HTMLElement>('.abyss-add-date-menu-item')].find(
        (item) => item.textContent === '🛫 Start',
      ),
    ).click();
    const input = expectDefined(h.el.querySelector<HTMLInputElement>('.abyss-date-input'));
    input.value = '2031-02-12';
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await flushMicrotasks(50);
    expect(h.node('Parent').node.planning.start).toBe('2031-02-12');
    expect(h.node('Root').node.planning.start).toBeUndefined();
    expect(h.state.get('taskStack')).toEqual(h.liveStack('Parent'));
  });

  it('keeps an unsaved recurrence editor mounted and saves it after reorder', async () => {
    const h = await harness(
      surface,
      '- [ ] Root\n  - [ ] Parent 📅 2031-02-10\n    - [ ] First\n    - [ ] Second\n',
      'Parent',
    );
    h.click('.abyss-repeat-chip');
    await flushMicrotasks(5);
    const interval = expectDefined(
      h.el.querySelector<HTMLInputElement>('.abyss-recurrence-interval'),
    );
    interval.value = '7';
    interval.dispatchEvent(new Event('input', { bubbles: true }));
    interval.focus();
    reorderRows(h.el, 1, 0, 'before');
    await flushMicrotasks(50);
    expect(h.el.querySelector('.abyss-recurrence-interval')).toBe(interval);
    expect(interval.value).toBe('7');
    expect(activeDocument.activeElement).toBe(interval);
    expectDefined(
      [...h.el.querySelectorAll<HTMLButtonElement>('.abyss-recurrence-editor button')].find(
        (button) => button.textContent === 'Save repeat',
      ),
    ).click();
    await flushMicrotasks(50);
    expect(h.node('Parent').node.recurrence).toBe('every 7 days');
    expect(h.node('Root').node.recurrence).toBeUndefined();
    expect(h.state.get('taskStack')).toEqual(h.liveStack('Parent'));
  });

  it('closes a non-draft actions menu after sibling reorder', async () => {
    const h = await harness(
      surface,
      '- [ ] Root\n  - [ ] Parent\n    - [ ] First\n    - [ ] Second\n',
      'Parent',
    );
    h.click('[aria-label="More actions"]');
    expect(h.el.querySelector('.abyss-task-context-menu')).not.toBeNull();
    reorderRows(h.el, 1, 0, 'before');
    await flushMicrotasks(50);
    expect(h.el.querySelector('.abyss-task-context-menu')).toBeNull();
    expect(h.state.get('taskStack')).toEqual(h.liveStack('Parent'));
  });

  it.each(['date', 'time'] as const)(
    'clears an already open %s popup after sibling reorder',
    async (kind) => {
      const h = await harness(
        surface,
        '- [ ] Root\n  - [ ] Parent 📅 2031-02-10 ⏰ 09:00\n    - [ ] First\n    - [ ] Second\n',
        'Parent',
      );
      if (kind === 'date')
        expectDefined(
          [...h.el.querySelectorAll<HTMLButtonElement>('.abyss-chips-row > button')].find(
            (button) => button.textContent.startsWith('📅'),
          ),
        ).click();
      else h.click('.abyss-chip-time');
      await flushMicrotasks(5);
      reorderRows(h.el, 1, 0, 'before');
      await flushMicrotasks(50);
      h.click(`[aria-label="Clear ${kind}"]`);
      await flushMicrotasks(50);
      expect(h.node('Parent').node.planning[kind === 'date' ? 'due' : 'time']).toBeUndefined();
      expect(h.state.get('taskStack')).toEqual(h.liveStack('Parent'));
    },
  );

  it('saves root duration from an already open popup after sibling reorder', async () => {
    const h = await harness(surface, '- [ ] Root\n  - [ ] First\n  - [ ] Second\n', 'Root');
    h.click('.abyss-chip-time');
    await flushMicrotasks(5);
    reorderRows(h.el, 1, 0, 'before');
    await flushMicrotasks(50);
    const input = expectDefined(h.el.querySelector<HTMLInputElement>('.abyss-duration-input'));
    input.value = '1h30m';
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await flushMicrotasks(50);
    expect(h.node('Root').node.planning.duration).toBe(90);
    expect(h.state.get('taskStack')).toEqual(h.liveStack('Root'));
  });

  it('preserves expanded comments when sibling order changes', async () => {
    const h = await harness(
      surface,
      '- [ ] Root\n  - [ ] Parent\n    - First comment line\n      Second comment line\n    - [ ] First\n    - [ ] Second\n',
      'Parent',
    );
    h.click('.abyss-comment-disclosure');
    expect(h.el.querySelector('.abyss-comment-disclosure')?.getAttribute('aria-expanded')).toBe(
      'true',
    );
    reorderRows(h.el, 1, 0, 'before');
    await flushMicrotasks(50);
    expect(h.state.get('taskStack')).toEqual(h.liveStack('Parent'));
    expect(h.node('Parent').node.subtasks.map((child) => child.title)).toEqual(['Second', 'First']);
    expect(h.el.querySelector('.abyss-comment-disclosure')?.getAttribute('aria-expanded')).toBe(
      'true',
    );
  });

  it('keeps unchanged Markdown visible while a reorder settles', async () => {
    let hold = false;
    const pending: Array<() => void> = [];
    vi.spyOn(MarkdownRenderer, 'render').mockImplementation(async (_app, source, holder) => {
      if (hold) await new Promise<void>((resolve) => pending.push(resolve));
      holder.setText(source);
    });
    const h = await harness(
      surface,
      '- [ ] Root\n  - [ ] Parent\n    - > **Formatted** description\n    - [ ] First\n    - [ ] Second\n',
      'Parent',
    );
    await flushMicrotasks(5);
    expect(h.el.querySelector('.abyss-right-desc-view')?.textContent).toBe(
      '**Formatted** description',
    );
    hold = true;
    reorderRows(h.el, 1, 0, 'before');
    await flushMicrotasks(50);
    const visible = h.el.querySelector('.abyss-right-desc-view')?.textContent;
    for (const resolve of pending.splice(0)) resolve();
    await flushMicrotasks(5);
    expect(h.state.get('taskStack')).toEqual(h.liveStack('Parent'));
    expect(visible).toBe('**Formatted** description');
  });

  it.each([
    { label: 'EOF', quote: '', ending: '\n', following: '', trailing: '' },
    { label: 'LF', quote: '', ending: '\n', following: '', trailing: '\n' },
    {
      label: 'following root',
      quote: '',
      ending: '\n',
      following: '- [ ] Following\n',
      trailing: '\n',
    },
    { label: 'quoted CRLF', quote: '> ', ending: '\r\n', following: '', trailing: '\r\n' },
  ])(
    'retains selection when a gap becomes trailing source: $label',
    async ({ quote, ending, following, trailing }) => {
      const head = `${quote}- [ ] Root${ending}${quote}  - [ ] Parent${ending}`;
      const first = `${quote}    - [ ] First${ending}`;
      const middle = `${quote}    - [ ] Middle${ending}`;
      const gap = `${quote}\t `;
      const last = `${quote}    - [ ] Last`;
      const h = await harness(
        surface,
        `${head}${first}${middle}${gap}${ending}${last}${trailing}${following}`,
        'Parent',
      );
      const file = h.app.vault.getFileByPath('tasks.md');
      if (!(file instanceof TFile)) throw new Error('Missing fixture');
      reorderRows(h.el, 2, 0, 'before');
      await flushMicrotasks(50);
      expect(await h.app.vault.read(file)).toBe(
        `\n${head}${last}${ending}${first}${middle}${gap}${trailing}${following}`,
      );
      expect(h.state.get('taskStack')).toEqual(h.liveStack('Parent'));
    },
  );

  it.each([
    {
      label: 'mixed child endings',
      source: '- [ ] Root\n  - [ ] Parent\n    - [ ] First\r\n    - [ ] Last\n',
      reordered: '- [ ] Root\n  - [ ] Parent\n    - [ ] Last\n    - [ ] First\r\n',
      reversed: '- [ ] Root\n  - [ ] Parent\n    - [ ] First\r\n    - [ ] Last\n',
    },
    {
      label: 'CRLF children under LF parent',
      source: '- [ ] Root\n  - [ ] Parent\n    - [ ] First\r\n    - [ ] Last\r\n',
      reordered: '- [ ] Root\n  - [ ] Parent\n    - [ ] Last\r\n    - [ ] First\r\n',
      reversed: '- [ ] Root\n  - [ ] Parent\n    - [ ] First\r\n    - [ ] Last\r\n',
    },
    {
      label: 'LF parent without final newline',
      source: '- [ ] Root\n  - [ ] Parent\n    - [ ] First\r\n    - [ ] Last',
      reordered: '- [ ] Root\n  - [ ] Parent\n    - [ ] Last\n    - [ ] First',
      reversed: '- [ ] Root\n  - [ ] Parent\n    - [ ] First\n    - [ ] Last',
    },
    {
      label: 'CRLF parent without final newline',
      source: '- [ ] Root\r\n  - [ ] Parent\r\n    - [ ] First\n    - [ ] Last',
      reordered: '- [ ] Root\r\n  - [ ] Parent\r\n    - [ ] Last\r\n    - [ ] First',
      reversed: '- [ ] Root\r\n  - [ ] Parent\r\n    - [ ] First\r\n    - [ ] Last',
    },
    {
      label: 'mixed endings before another root',
      source:
        '- [ ] Root\r\n  - [ ] Parent\r\n    - [ ] First\r\n    - [ ] Last\n- [ ] Following\n',
      reordered:
        '- [ ] Root\r\n  - [ ] Parent\r\n    - [ ] Last\n    - [ ] First\r\n- [ ] Following\n',
      reversed:
        '- [ ] Root\r\n  - [ ] Parent\r\n    - [ ] First\r\n    - [ ] Last\n- [ ] Following\n',
    },
  ])('retains selection with $label', async ({ source, reordered, reversed }) => {
    const h = await harness(surface, source, 'Parent');
    const file = h.app.vault.getFileByPath('tasks.md');
    if (!(file instanceof TFile)) throw new Error('Missing fixture');
    reorderRows(h.el, 1, 0, 'before');
    await flushMicrotasks(50);
    expect(await h.app.vault.read(file)).toBe(`\n${reordered}`);
    expect(h.state.get('taskStack')).toEqual(h.liveStack('Parent'));
    reorderRows(h.el, 0, 1, 'after');
    await flushMicrotasks(50);
    expect(await h.app.vault.read(file)).toBe(`\n${reversed}`);
    expect(h.state.get('taskStack')).toEqual(h.liveStack('Parent'));
  });

  it.each(['\n', '    - Parent comment\n', '    - > Parent description\n'])(
    'preserves selection when reorder crosses the parent separator %j',
    async (separator) => {
      const prefix = '- [ ] Root\n  - [ ] Parent\n';
      const first = '    - [ ] First\n';
      const middle = '    - [ ] Middle\n';
      const last = '    - [ ] Last\n';
      const h = await harness(surface, prefix + first + middle + separator + last, 'Parent');
      const file = h.app.vault.getFileByPath('tasks.md');
      if (!(file instanceof TFile)) throw new Error('Missing fixture');
      reorderRows(h.el, 0, 2, 'before');
      await flushMicrotasks(50);
      expect(await h.app.vault.read(file)).toBe(`\n${prefix}${middle}${separator}${first}${last}`);
      expect(h.state.get('taskStack')).toEqual(h.liveStack('Parent'));
      reorderRows(h.el, 2, 0, 'after');
      await flushMicrotasks(50);
      expect(await h.app.vault.read(file)).toBe(`\n${prefix}${middle}${last}${separator}${first}`);
      expect(h.state.get('taskStack')).toEqual(h.liveStack('Parent'));
    },
  );

  it('retains the nested inspector when a CRLF tracked subtree moves to and from EOF', async () => {
    const prefix = '- [ ] Root\r\n  - [ ] Parent\r\n';
    const first = '    - [ ] First';
    const last = '    - [ ] Last\r\n      - 2026-10-06T12:00:00Z → 2026-10-06T13:00:00Z';
    const h = await harness(surface, `${prefix}${first}\r\n${last}`, 'Parent');
    const file = h.app.vault.getFileByPath('tasks.md');
    if (!(file instanceof TFile)) throw new Error('Missing fixture');
    reorderRows(h.el, 1, 0, 'before');
    await flushMicrotasks(50);
    expect(await h.app.vault.read(file)).toBe(`\n${prefix}${last}\r\n${first}`);
    expect(h.state.get('taskStack')).toEqual(h.liveStack('Parent'));
    reorderRows(h.el, 0, 1, 'after');
    await flushMicrotasks(50);
    expect(await h.app.vault.read(file)).toBe(`\n${prefix}${first}\r\n${last}`);
    expect(h.state.get('taskStack')).toEqual(h.liveStack('Parent'));
  });

  it.each([
    { ending: '\n', trailing: '', prefix: '', indent: '  ' },
    { ending: '\r\n', trailing: '\r\n', prefix: '', indent: '  ' },
    { ending: '\r\n', trailing: '', prefix: '', indent: '  ' },
    { ending: '\r\n', trailing: '\r\n', prefix: '> ', indent: '\t' },
  ])(
    'keeps the nested inspector across source formatting $ending/$trailing/$prefix/$indent',
    async ({ ending, trailing, prefix, indent }) => {
      const format = (lines: string[]) =>
        lines.map((line) => prefix + line).join(ending) + trailing;
      const head = ['- [ ] Root', `${indent}- [ ] Parent`];
      const first = [`${indent}${indent}- [ ] First`, `${indent}${indent}${indent}- > Description`];
      const second = `${indent}${indent}- [ ] Second`;
      const h = await harness(surface, format([...head, ...first, second]), 'Parent');
      const file = h.app.vault.getFileByPath('tasks.md');
      if (!(file instanceof TFile)) throw new Error('Missing fixture');
      reorderRows(h.el, 1, 0, 'before');
      await flushMicrotasks(50);
      expect(await h.app.vault.read(file)).toBe(`\n${format([...head, second, ...first])}`);
      expect(h.state.get('taskStack')).toEqual(h.liveStack('Parent'));
      reorderRows(h.el, 0, 1, 'after');
      await flushMicrotasks(50);
      expect(await h.app.vault.read(file)).toBe(`\n${format([...head, ...first, second])}`);
      expect(h.state.get('taskStack')).toEqual(h.liveStack('Parent'));
    },
  );

  it('keeps the title draft and saved navigation frames attached to the reordered owner', async () => {
    const source = '- [ ] Source\n- [ ] Root\n  - [ ] Parent\n    - [ ] First\n    - [ ] Second\n';
    const h = await harness(surface, source, 'Source');
    h.state.openInspectorDependency(h.node('Parent'));
    h.state.openInspectorDependency(h.node('Source'));
    h.state.openInspectorDependency(h.node('Parent'));
    h.click('.abyss-right-title-view');
    await flushMicrotasks(5);
    const editor = expectDefined(
      h.el.querySelector<HTMLTextAreaElement>('.abyss-right-title-edit'),
    );
    editor.value = 'Parent draft';
    editor.dispatchEvent(new Event('input', { bubbles: true }));
    reorderRows(h.el, 1, 0, 'before');
    await flushMicrotasks(50);
    const restored = expectDefined(
      h.el.querySelector<HTMLTextAreaElement>('.abyss-right-title-edit'),
    );
    expect(restored.value).toBe('Parent draft');
    expect(h.state.get('taskStack')).toEqual(h.liveStack('Parent'));
    expect(h.state.get('inspectorBackStack')[1]?.taskStack).toEqual(h.liveStack('Parent'));
    restored.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await flushMicrotasks(50);
    expect(h.state.get('taskStack')).toEqual(h.liveStack('Parent draft'));
    h.click(back);
    h.click(back);
    expect(h.state.get('taskStack')).toEqual(h.liveStack('Parent draft'));
    expect(h.node('Root').node.title).toBe('Root');
  });

  it.each([
    { field: 'description', view: '.abyss-right-desc-view', editor: '.abyss-right-desc-edit' },
    { field: 'comment', view: '.abyss-comment-text', editor: '.abyss-comment-edit-input' },
  ] as const)(
    'saves a retained $field draft after reorder to its current owner',
    async ({ field, view, editor }) => {
      const source =
        '- [ ] Root\n  - [ ] Parent\n    - > Description before\n    - Existing comment\n    - [ ] First\n    - [ ] Second\n';
      const h = await harness(surface, source, 'Parent');
      h.click(view);
      await flushMicrotasks(5);
      const textarea = expectDefined(h.el.querySelector<HTMLTextAreaElement>(editor));
      textarea.value = 'Retained draft';
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      textarea.focus();
      textarea.setSelectionRange(2, 7);
      reorderRows(h.el, 1, 0, 'before');
      await flushMicrotasks(50);
      const retained = expectDefined(h.el.querySelector<HTMLTextAreaElement>(editor));
      expect(retained).toBe(textarea);
      expect(retained.value).toBe('Retained draft');
      expect([retained.selectionStart, retained.selectionEnd]).toEqual([2, 7]);
      retained.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await flushMicrotasks(50);
      const parent = h.node('Parent').node;
      expect(field === 'description' ? parent.description : parent.comments[0]?.text).toBe(
        'Retained draft',
      );
      expect(parent.subtasks.map((child) => child.title)).toEqual(['Second', 'First']);
      expect(h.state.get('taskStack')).toEqual(h.liveStack('Parent'));
    },
  );

  it.each([
    { prefix: '- [ ] Parent\n', indent: '  ', titles: ['Parent'] },
    { prefix: '- [ ] Root\n  - [ ] Parent\n', indent: '    ', titles: ['Root', 'Parent'] },
    {
      prefix: '- [ ] Root\n  - [ ] Middle\n    - [ ] Parent\n',
      indent: '      ',
      titles: ['Root', 'Middle', 'Parent'],
    },
  ])(
    'retains $titles during repeated subtree reorder and subsequent editing',
    async ({ prefix, indent, titles }) => {
      const first = `${indent}- [ ] First\n${indent}  - > Keep description\n${indent}  - [ ] Deep\n`;
      const second = `${indent}- [ ] Second\n`;
      const third = `${indent}- [ ] Third\n`;
      const h = await harness(surface, prefix + first + second + third, 'Parent');
      const file = h.app.vault.getFileByPath('tasks.md');
      if (!(file instanceof TFile)) throw new Error('Missing fixture');
      const history = h.state.get('inspectorBackStack');
      const publications: string[][] = [];
      const unsubscribe = h.state.on('taskStack', (stack) => {
        publications.push(stack.map((node) => node.title));
      });
      cleanups.push(unsubscribe);

      reorderRows(h.el, 2, 0, 'before');
      await flushMicrotasks(50);
      expect(await h.app.vault.read(file)).toBe(`\n${prefix}${third}${first}${second}`);
      expect(h.state.get('taskStack')).toEqual(h.liveStack('Parent'));
      expect(publications.length).toBeGreaterThan(0);
      expect(publications.every((stack) => JSON.stringify(stack) === JSON.stringify(titles))).toBe(
        true,
      );
      expect(h.el.querySelector('.abyss-right-title')?.textContent).toBe('Parent');
      expect(h.state.get('inspectorBackStack')).toEqual(history);

      reorderRows(h.el, 1, 2, 'after');
      await flushMicrotasks(50);
      expect(await h.app.vault.read(file)).toBe(`\n${prefix}${third}${second}${first}`);
      expect(h.state.get('taskStack')).toEqual(h.liveStack('Parent'));
      expectDefined(
        h.el
          .querySelectorAll<HTMLElement>('.abyss-subtask-row')[2]
          ?.querySelector<HTMLElement>('.abyss-subtask-label'),
      ).click();
      expect(h.state.get('taskStack')).toEqual(h.liveStack('First'));
      h.click('.abyss-right-title-view');
      const editor = expectDefined(
        h.el.querySelector<HTMLTextAreaElement>('.abyss-right-title-edit'),
      );
      editor.value = 'Edited First';
      editor.dispatchEvent(new Event('input', { bubbles: true }));
      editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await flushMicrotasks(50);
      expect(await h.app.vault.read(file)).toBe(
        `\n${prefix}${third}${second}${first.replace('First', 'Edited First')}`,
      );
      expect(h.state.get('taskStack')).toEqual(h.liveStack('Edited First'));
    },
  );

  it.each([
    {
      label: 'root',
      source:
        '- [ ] Source\n- [ ] Parent\n  - [ ] Before\n  - [ ] Remove\n    - > Exact **description**\n    - [ ] Leaf\n  - [ ] After\n',
      removed: '- [ ] Source\n- [ ] Parent\n  - [ ] Before\n  - [ ] After\n',
      titles: ['Parent'],
    },
    {
      label: 'nested',
      source:
        '- [ ] Source\n- [ ] Root\n  - [ ] Parent\n    - [ ] Before\n    - [ ] Remove\n      - > Exact **description**\n      - [ ] Leaf\n    - [ ] After\n  - [ ] Root sibling\n',
      removed:
        '- [ ] Source\n- [ ] Root\n  - [ ] Parent\n    - [ ] Before\n    - [ ] After\n  - [ ] Root sibling\n',
      titles: ['Root', 'Parent'],
    },
    {
      label: 'deep',
      source:
        '- [ ] Source\n- [ ] Root\n  - [ ] Middle\n    - [ ] Parent\n      - [ ] Before\n      - [ ] Remove\n        - > Exact **description**\n        - [ ] Leaf\n      - [ ] After\n  - [ ] Root sibling\n',
      removed:
        '- [ ] Source\n- [ ] Root\n  - [ ] Middle\n    - [ ] Parent\n      - [ ] Before\n      - [ ] After\n  - [ ] Root sibling\n',
      titles: ['Root', 'Middle', 'Parent'],
    },
  ])(
    'keeps the $label parent and local Undo through indexed subtree deletion and restoration',
    async ({ source, removed, titles }) => {
      const h = await harness(surface, source, 'Source');
      h.state.openInspectorDependency(h.node('Parent'));
      h.state.openInspectorDependency(h.node('Source'));
      h.state.openInspectorDependency(h.node('Parent'));
      const history = h.state.get('inspectorBackStack');
      const historyJSON = JSON.stringify(history);
      const file = h.app.vault.getAbstractFileByPath('tasks.md');
      if (!(file instanceof TFile)) throw new Error('Missing fixture');
      h.click('.abyss-subtask-section .abyss-subtask-row:nth-child(2) .abyss-subtask-remove');
      await flushMicrotasks(50);
      expect(await h.app.vault.read(file)).toBe(`\n${removed}`);
      expect(h.state.get('taskStack').map((node) => node.title)).toEqual(titles);
      expect(h.state.get('taskStack')).toEqual(h.liveStack('Parent'));
      expect(h.state.get('inspectorBackStack').map(({ taskStack }) => taskStack)).toEqual([
        h.liveStack('Source'),
        h.liveStack('Parent'),
        h.liveStack('Source'),
      ]);
      const undo = expectDefined(h.el.querySelector<HTMLButtonElement>('.abyss-undo-row button'));
      expect(undo.closest('.abyss-undo-row')?.textContent).toBe('Sub-task deletedUndo(5s)');
      expect(undo.closest('.abyss-undo-row')?.previousElementSibling?.textContent).toContain(
        'Before',
      );
      expect(undo.closest('.abyss-undo-row')?.nextElementSibling?.textContent).toContain('After');
      expect(activeDocument.activeElement).toBe(undo);
      undo.click();
      await flushMicrotasks(50);
      expect(await h.app.vault.read(file)).toBe(`\n${source}`);
      expect(h.state.get('taskStack')).toEqual(h.liveStack('Parent'));
      expect(h.state.get('inspectorBackStack').map(({ taskStack }) => taskStack)).toEqual([
        h.liveStack('Source'),
        h.liveStack('Parent'),
        h.liveStack('Source'),
      ]);
      expect(h.el.querySelector('.abyss-undo-row')).toBeNull();
      expect(activeDocument.activeElement?.closest('.abyss-subtask-row')?.textContent).toContain(
        'Remove',
      );
      expect(JSON.stringify(history)).toBe(historyJSON);
      h.click(back);
      h.click(back);
      expect(h.state.get('taskStack')).toEqual(h.liveStack('Parent'));
    },
  );

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

  it.each(Object.keys(onlyChildSource) as Array<keyof typeof onlyChildSource>)(
    'restores the only nested child with %s source layout',
    async (layout) => {
      const source = onlyChildSource[layout];
      const h = await harness(surface, source, 'Source');
      h.state.openInspectorDependency(h.node('Parent'));
      const file = h.app.vault.getAbstractFileByPath('tasks.md');
      if (!(file instanceof TFile)) throw new Error('Missing fixture');
      h.click('.abyss-subtask-remove');
      await flushMicrotasks(50);
      expect(h.state.get('taskStack')).toEqual(h.liveStack('Parent'));
      expect(h.node('Parent').node.subtasks).toEqual([]);
      h.click('.abyss-undo-row button');
      await flushMicrotasks(50);
      expect(await h.app.vault.read(file)).toBe(`\n${source}`);
      expect(h.state.get('taskStack')).toEqual(h.liveStack('Parent'));
      expect(activeDocument.activeElement?.closest('.abyss-subtask-row')?.textContent).toContain(
        'Only',
      );
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
