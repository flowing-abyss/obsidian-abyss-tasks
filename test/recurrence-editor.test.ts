import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RecurrencePolicy, TaskCommandResult, TaskPatch } from '../src/tasks';
import {
  mountAnchoredRecurrenceEditor,
  mountRecurrenceEditor,
  type RecurrenceEditorHandle,
} from '../src/ui/recurrence/RecurrenceEditor';
import { draftPlainText, type RightPanelDraftState } from '../src/ui/taskDraftContinuity';
import { flushMicrotasks, freshContainer, task } from './helpers';

function click(element: Element): void {
  element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
}

function input(element: HTMLInputElement, value: string): void {
  element.value = value;
  element.dispatchEvent(new Event('input', { bubbles: true }));
}

function change(element: HTMLInputElement | HTMLSelectElement, value: string): void {
  element.value = value;
  element.dispatchEvent(new Event('change', { bubbles: true }));
}

function keydown(element: Element, key: string, metaKey = false): void {
  element.dispatchEvent(new KeyboardEvent('keydown', { key, metaKey, bubbles: true }));
}

function submitShortcut(
  element: Element,
  modifiers: { readonly metaKey?: boolean; readonly ctrlKey?: boolean },
): KeyboardEvent {
  const OwnerKeyboardEvent = element.ownerDocument.defaultView!.KeyboardEvent;
  const event = new OwnerKeyboardEvent('keydown', {
    key: 'Enter',
    ...modifiers,
    bubbles: true,
    cancelable: true,
  });
  element.dispatchEvent(event);
  return event;
}

interface MountedEditor {
  readonly container: HTMLElement;
  readonly handle: RecurrenceEditorHandle;
  readonly onSubmit: ReturnType<typeof vi.fn<(patch: TaskPatch) => Promise<TaskCommandResult>>>;
  readonly onClose: ReturnType<typeof vi.fn>;
}

const policy: RecurrencePolicy = { removeScheduledDate: false };
const mounted: RecurrenceEditorHandle[] = [];

function mount(
  overrides: Partial<{
    source: Parameters<typeof mountRecurrenceEditor>[0]['source'];
    policy: RecurrencePolicy;
    ownershipConflict: boolean;
    onSubmit: (patch: TaskPatch) => Promise<TaskCommandResult>;
  }> = {},
): MountedEditor {
  const root = task({ planning: { due: '2026-08-09' } });
  const container = freshContainer();
  const onSubmit = vi
    .fn<(patch: TaskPatch) => Promise<TaskCommandResult>>()
    .mockResolvedValue({ type: 'ok', changed: true, outcome: { type: 'task', task: root } });
  const onClose = vi.fn();
  const handle = mountRecurrenceEditor({
    container,
    source: { root, target: { type: 'task', ref: root.ref } },
    policy,
    ownershipConflict: false,
    onSubmit,
    onClose,
    ...overrides,
  });
  mounted.push(handle);
  return { container, handle, onSubmit, onClose };
}

function button(container: HTMLElement, label: string): HTMLButtonElement {
  const match = Array.from(container.querySelectorAll('button')).find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (!match) throw new Error(`Missing button: ${label}`);
  return match;
}

afterEach(() => {
  vi.useRealTimers();
  for (const handle of mounted.splice(0)) handle.destroy();
  activeDocument.body.empty();
});

describe('mountRecurrenceEditor', () => {
  it('presents presets and Custom as one pressed-state mode group', () => {
    const { container } = mount();
    const group = container.querySelector<HTMLElement>('.tc-recurrence-presets')!;

    expect(group.getAttribute('role')).toBe('group');
    expect(group.getAttribute('aria-label')).toBe('Repeat pattern');
    expect(Array.from(group.querySelectorAll('button')).map((item) => item.textContent)).toEqual([
      'Daily',
      'Weekdays',
      'Weekly',
      'Monthly',
      'Yearly',
      'Custom',
    ]);
    expect(button(container, 'Daily').getAttribute('aria-pressed')).toBe('true');

    click(button(container, 'Custom'));

    expect(button(container, 'Custom').getAttribute('aria-pressed')).toBe('true');
    expect(
      Array.from(
        container.querySelectorAll<HTMLButtonElement>(
          '.tc-recurrence-presets button[aria-pressed="true"]',
        ),
      ),
    ).toEqual([button(container, 'Custom')]);
  });

  it.each([
    ['Daily', 'Enter', 'preset:daily'],
    ['Daily', ' ', 'preset:daily'],
    ['Custom', 'Enter', 'custom-mode'],
    ['Custom', ' ', 'custom-mode'],
  ] as const)(
    'keeps focus on the replacement %s mode after native %s activation',
    (label, key, expectedFocusKey) => {
      const { container } = mount();
      activeDocument.body.append(container);
      const mode = button(container, label);
      mode.focus();

      mode.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
      click(mode);

      expect(activeDocument.activeElement?.getAttribute('data-recurrence-focus-key')).toBe(
        expectedFocusKey,
      );
    },
  );

  it.each([
    [
      'unit',
      (container: HTMLElement) =>
        container.querySelector<HTMLSelectElement>('[aria-label="Repeat unit"]')!,
      'weeks',
    ],
    [
      'monthly-pattern',
      (container: HTMLElement) => {
        click(button(container, 'Monthly'));
        return container.querySelector<HTMLSelectElement>('[aria-label="Monthly pattern"]')!;
      },
      'weekday',
    ],
    [
      'yearly-pattern',
      (container: HTMLElement) => {
        click(button(container, 'Yearly'));
        return container.querySelector<HTMLSelectElement>('[aria-label="Yearly pattern"]')!;
      },
      'date',
    ],
  ] as const)(
    'keeps focus on the %s select when its choice rerenders dependent controls',
    (expectedFocusKey, locate, value) => {
      const { container } = mount();
      activeDocument.body.append(container);
      const select = locate(container);
      select.focus();

      change(select, value);

      expect(activeDocument.activeElement?.getAttribute('data-recurrence-focus-key')).toBe(
        expectedFocusKey,
      );
    },
  );

  it.each([
    ['days', 'every 2 days'],
    ['weeks', 'every 2 weeks on Sunday'],
    ['months', 'every 2 months'],
  ] as const)(
    'keeps an arbitrary structured %s cadence distinct from canonical presets',
    (unitValue, expectedRule) => {
      const { container } = mount();
      input(container.querySelector<HTMLInputElement>('[aria-label="Repeat interval"]')!, '2');
      if (unitValue !== 'days') {
        change(
          container.querySelector<HTMLSelectElement>('[aria-label="Repeat unit"]')!,
          unitValue,
        );
      }

      expect(
        container.querySelectorAll('.tc-recurrence-presets [aria-pressed="true"]'),
      ).toHaveLength(0);
      expect(container.querySelector('.tc-recurrence-preview-rule')?.textContent).toBe(
        expectedRule,
      );
    },
  );

  it('preserves the exact Custom draft while presets are edited', () => {
    const { container } = mount();
    click(button(container, 'Custom'));
    const raw = container.querySelector<HTMLInputElement>('[aria-label="Recurrence rule"]')!;
    input(raw, 'every 3 weeks on Monday');

    click(button(container, 'Daily'));
    click(button(container, 'Custom'));

    expect(container.querySelector<HTMLInputElement>('[aria-label="Recurrence rule"]')?.value).toBe(
      'every 3 weeks on Monday',
    );
  });

  it.each([
    {
      initialRule: 'every 3 weeks on Monday',
      presetWhenDone: true,
      expectedCustom: 'every 3 weeks on Monday when done',
      expectedPreset: 'every month when done',
    },
    {
      initialRule: 'every 3 weeks on Monday when done',
      presetWhenDone: false,
      expectedCustom: 'every 3 weeks on Monday',
      expectedPreset: 'every month',
    },
    {
      initialRule: 'weekly   custom',
      presetWhenDone: true,
      expectedCustom: 'weekly   custom when done',
      expectedPreset: 'every month when done',
    },
    {
      initialRule: 'weekly   custom when   done',
      presetWhenDone: false,
      expectedCustom: 'weekly   custom',
      expectedPreset: 'every month',
    },
  ] as const)(
    'syncs preset when-done=$presetWhenDone into the preserved Custom rule and back',
    ({ initialRule, presetWhenDone, expectedCustom, expectedPreset }) => {
      const { container } = mount();
      click(button(container, 'Custom'));
      input(
        container.querySelector<HTMLInputElement>('[aria-label="Recurrence rule"]')!,
        initialRule,
      );
      click(button(container, 'Daily'));
      const whenDone = container.querySelector<HTMLInputElement>('.tc-recurrence-when-done')!;
      whenDone.checked = presetWhenDone;
      whenDone.dispatchEvent(new Event('change', { bubbles: true }));

      click(button(container, 'Custom'));

      expect(
        container.querySelector<HTMLInputElement>('[aria-label="Recurrence rule"]')?.value,
      ).toBe(expectedCustom);
      expect(container.querySelector<HTMLInputElement>('.tc-recurrence-when-done')?.checked).toBe(
        presetWhenDone,
      );

      click(button(container, 'Monthly'));
      expect(container.querySelector('.tc-recurrence-preview-rule')?.textContent).toBe(
        expectedPreset,
      );
    },
  );

  it('keeps empty diagnostics addressable without reserving visual rows', () => {
    const { container } = mount();
    const status = container.querySelector<HTMLElement>('.tc-recurrence-status')!;
    const warning = container.querySelector<HTMLElement>('.tc-recurrence-delete-warning')!;

    expect(status.id).not.toBe('');
    expect(status.hidden).toBe(true);
    expect(warning.hidden).toBe(true);

    click(button(container, 'Custom'));
    input(container.querySelector<HTMLInputElement>('.tc-recurrence-raw')!, 'weekly');
    expect(container.querySelector<HTMLElement>('.tc-recurrence-status')?.hidden).toBe(false);

    change(container.querySelector<HTMLSelectElement>('[aria-label="Completed task"]')!, 'delete');
    expect(container.querySelector<HTMLElement>('.tc-recurrence-delete-warning')?.hidden).toBe(
      false,
    );
  });

  it('serializes every structured draft field for detached display and copy', () => {
    const root = task();
    const draft: RightPanelDraftState = {
      kind: 'recurrence-editor',
      target: { type: 'task', ref: root.ref },
      hadFocus: true,
      editor: {
        mode: 'structured',
        intervalText: '03',
        unit: 'weeks',
        weekdays: ['Monday', 'Friday'],
        monthly: { type: 'same-date' },
        yearly: { type: 'same-date' },
        whenDone: true,
        onCompletion: 'delete',
        customDraft: 'stale custom value',
        dirty: true,
      },
    };

    expect(draftPlainText(draft)).toContain('every 3 weeks on Monday and Friday when done');
    expect(draftPlainText(draft)).toContain('interval: 03');
    expect(draftPlainText(draft)).toContain('on completion: delete');
    expect(draftPlainText(draft)).not.toContain('stale custom value');
  });

  it.each(['custom', 'structured'] as const)(
    'captures and restores a dirty %s draft with focus and selection',
    (mode) => {
      const first = mount();
      activeDocument.body.append(first.container);
      if (mode === 'custom') click(button(first.container, 'Custom'));
      const firstEdit = first.container.querySelector<HTMLInputElement>(
        mode === 'custom' ? '.tc-recurrence-raw' : '.tc-recurrence-interval',
      )!;
      input(firstEdit, mode === 'custom' ? 'every 13 days' : '12345');
      firstEdit.focus();
      firstEdit.setSelectionRange(2, 5);

      const draft = first.handle.captureDraftState();
      const second = mount();
      activeDocument.body.append(second.container);
      second.handle.restoreDraftState(draft);

      const restored = second.container.querySelector<HTMLInputElement>(
        mode === 'custom' ? '.tc-recurrence-raw' : '.tc-recurrence-interval',
      )!;
      expect(restored.value).toBe(mode === 'custom' ? 'every 13 days' : '12345');
      expect(restored.selectionStart).toBe(2);
      expect(restored.selectionEnd).toBe(5);
      expect(activeDocument.activeElement).toBe(restored);
    },
  );

  it.each([
    ['custom-mode', (container: HTMLElement) => button(container, 'Custom')],
    ['preset:daily', (container: HTMLElement) => button(container, 'Daily')],
    ['preset:weekdays', (container: HTMLElement) => button(container, 'Weekdays')],
    ['preset:weekly', (container: HTMLElement) => button(container, 'Weekly')],
    ['preset:monthly', (container: HTMLElement) => button(container, 'Monthly')],
    ['preset:yearly', (container: HTMLElement) => button(container, 'Yearly')],
    ['interval', (container: HTMLElement) => container.querySelector('.tc-recurrence-interval')!],
    ['unit', (container: HTMLElement) => container.querySelector('[aria-label="Repeat unit"]')!],
    [
      'weekday:Monday',
      (container: HTMLElement) => {
        click(button(container, 'Weekly'));
        return container.querySelector('[name="recurrence-weekday"][value="Monday"]')!;
      },
    ],
    [
      'monthly-pattern',
      (container: HTMLElement) => {
        click(button(container, 'Monthly'));
        return container.querySelector('[aria-label="Monthly pattern"]')!;
      },
    ],
    [
      'monthly-day',
      (container: HTMLElement) => {
        click(button(container, 'Monthly'));
        change(
          container.querySelector<HTMLSelectElement>('[aria-label="Monthly pattern"]')!,
          'day',
        );
        return container.querySelector('[aria-label="Month day"]')!;
      },
    ],
    [
      'monthly-ordinal',
      (container: HTMLElement) => {
        click(button(container, 'Monthly'));
        change(
          container.querySelector<HTMLSelectElement>('[aria-label="Monthly pattern"]')!,
          'weekday',
        );
        return container.querySelector('[aria-label="Weekday ordinal"]')!;
      },
    ],
    [
      'monthly-weekday',
      (container: HTMLElement) => {
        click(button(container, 'Monthly'));
        change(
          container.querySelector<HTMLSelectElement>('[aria-label="Monthly pattern"]')!,
          'weekday',
        );
        return container.querySelector('[aria-label="Monthly weekday"]')!;
      },
    ],
    [
      'yearly-pattern',
      (container: HTMLElement) => {
        click(button(container, 'Yearly'));
        return container.querySelector('[aria-label="Yearly pattern"]')!;
      },
    ],
    [
      'yearly-month',
      (container: HTMLElement) => {
        click(button(container, 'Yearly'));
        change(
          container.querySelector<HTMLSelectElement>('[aria-label="Yearly pattern"]')!,
          'date',
        );
        return container.querySelector('[aria-label="Yearly month"]')!;
      },
    ],
    [
      'yearly-day',
      (container: HTMLElement) => {
        click(button(container, 'Yearly'));
        change(
          container.querySelector<HTMLSelectElement>('[aria-label="Yearly pattern"]')!,
          'date',
        );
        return container.querySelector('[aria-label="Yearly day"]')!;
      },
    ],
    ['when-done', (container: HTMLElement) => container.querySelector('.tc-recurrence-when-done')!],
    [
      'completed-task',
      (container: HTMLElement) => container.querySelector('[aria-label="Completed task"]')!,
    ],
    [
      'custom',
      (container: HTMLElement) => {
        click(button(container, 'Custom'));
        return container.querySelector('.tc-recurrence-raw')!;
      },
    ],
    ['cancel', (container: HTMLElement) => button(container, 'Cancel')],
    ['save', (container: HTMLElement) => button(container, 'Save repeat')],
  ] as const)('round-trips the focused recurrence control key %s', (expectedKey, locate) => {
    const first = mount();
    activeDocument.body.append(first.container);
    const control = locate(first.container) as HTMLElement;
    control.focus();
    const draft = first.handle.captureDraftState();

    expect(draft.focusedControl).toBe(expectedKey);
    const second = mount();
    activeDocument.body.append(second.container);
    second.handle.restoreDraftState(draft);
    expect(activeDocument.activeElement?.getAttribute('data-recurrence-focus-key')).toBe(
      expectedKey,
    );
  });

  it('cancels anchored default autofocus when restoring a recorded recurrence control', () => {
    vi.useFakeTimers();
    const anchor = activeDocument.body.createEl('button', { text: 'Repeat marker' });
    const root = task({ planning: { due: '2026-08-09' } });
    const handle = mountAnchoredRecurrenceEditor({
      anchor,
      source: { root, target: { type: 'task', ref: root.ref } },
      policy,
      ownershipConflict: false,
      onSubmit: vi.fn().mockResolvedValue({
        type: 'ok',
        changed: true,
        outcome: { type: 'task', task: root },
      }),
    });
    mounted.push(handle);
    handle.restoreDraftState({
      mode: 'structured',
      preset: 'daily',
      intervalText: '1',
      unit: 'days',
      weekdays: ['Monday'],
      monthly: { type: 'same-date' },
      yearly: { type: 'same-date' },
      whenDone: false,
      onCompletion: 'keep',
      customDraft: 'every day',
      focusedControl: 'completed-task',
      dirty: false,
    });

    vi.runAllTimers();

    expect(activeDocument.activeElement?.getAttribute('data-recurrence-focus-key')).toBe(
      'completed-task',
    );
  });

  it('round-trips the focused clear action when an existing recurrence renders it', () => {
    const root = task({ planning: { due: '2026-08-09' }, recurrence: 'every day' });
    const first = mount({ source: { root, target: { type: 'task', ref: root.ref } } });
    activeDocument.body.append(first.container);
    button(first.container, 'Clear repeat').focus();
    const draft = first.handle.captureDraftState();

    expect(draft.focusedControl).toBe('clear');
    const second = mount({ source: { root, target: { type: 'task', ref: root.ref } } });
    activeDocument.body.append(second.container);
    second.handle.restoreDraftState(draft);
    expect(activeDocument.activeElement?.getAttribute('data-recurrence-focus-key')).toBe('clear');
  });

  it('turns presets into adaptive controls and one canonical preview line', () => {
    const { container } = mount();

    expect(
      Array.from(container.querySelectorAll<HTMLElement>('[data-recurrence-preset]')).map(
        (element) => element.textContent,
      ),
    ).toEqual(['Daily', 'Weekdays', 'Weekly', 'Monthly', 'Yearly']);

    click(button(container, 'Weekly'));
    expect(button(container, 'Weekly').getAttribute('aria-pressed')).toBe('true');
    expect(container.querySelector('.tc-recurrence-preview-rule')?.textContent).toBe(
      'every week on Sunday',
    );
    expect(
      container.querySelectorAll<HTMLInputElement>('[name="recurrence-weekday"]'),
    ).toHaveLength(7);

    const interval = container.querySelector<HTMLInputElement>('[aria-label="Repeat interval"]')!;
    input(interval, '2');
    const monday = container.querySelector<HTMLInputElement>(
      '[name="recurrence-weekday"][value="Monday"]',
    )!;
    monday.checked = true;
    monday.dispatchEvent(new Event('change', { bubbles: true }));
    expect(container.querySelector('.tc-recurrence-preview-rule')?.textContent).toBe(
      'every 2 weeks on Monday, Sunday',
    );

    const unit = container.querySelector<HTMLSelectElement>('[aria-label="Repeat unit"]')!;
    change(unit, 'months');
    expect(
      container.querySelector<HTMLSelectElement>('[aria-label="Monthly pattern"]')?.value,
    ).toBe('same-date');
    expect(container.querySelector('.tc-recurrence-preview-rule')?.textContent).toBe(
      'every 2 months',
    );

    change(
      container.querySelector<HTMLSelectElement>('[aria-label="Monthly pattern"]')!,
      'weekday',
    );
    expect(container.querySelector('[aria-label="Weekday ordinal"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="Monthly weekday"]')).not.toBeNull();

    change(unit, 'years');
    change(container.querySelector<HTMLSelectElement>('[aria-label="Yearly pattern"]')!, 'date');
    expect(container.querySelector('[aria-label="Yearly month"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="Yearly day"]')).not.toBeNull();
  });

  it('keeps Custom validation inline in a collapsible polite live status', () => {
    const { container } = mount();
    click(button(container, 'Custom'));
    const raw = container.querySelector<HTMLInputElement>('[aria-label="Recurrence rule"]')!;
    input(raw, 'weekly');

    const status = container.querySelector<HTMLElement>('.tc-recurrence-status')!;
    expect(status.getAttribute('aria-live')).toBe('polite');
    expect(status.textContent).toBe('Start the rule with “every”.');
    expect(button(container, 'Save repeat').disabled).toBe(true);

    input(raw, 'every 2 weeks on Thursday when done');
    expect(status.textContent).toBe('');
    expect(container.querySelector('.tc-recurrence-preview-rule')?.textContent).toBe(
      'every 2 weeks on Thursday when done',
    );
    expect(button(container, 'Save repeat').disabled).toBe(false);
  });

  it('requires a positive integer interval', () => {
    const { container } = mount();
    const interval = container.querySelector<HTMLInputElement>('[aria-label="Repeat interval"]')!;

    input(interval, '0');

    expect(container.querySelector('.tc-recurrence-status')?.textContent).toBe(
      'Use a whole number greater than zero.',
    );
    expect(button(container, 'Save repeat').disabled).toBe(true);
  });

  it.each([
    [task(), false, 'Add a date before setting a repeat.'],
    [task({ planning: { due: '2026-08-09' } }), true, 'Remove the nested repeat conflict first.'],
  ] as const)(
    'disables Save for an undated or ownership-conflicting task %#',
    (root, conflict, message) => {
      const { container } = mount({
        source: { root, target: { type: 'task', ref: root.ref } },
        ownershipConflict: conflict,
      });

      expect(container.querySelector('.tc-recurrence-status')?.textContent).toBe(message);
      expect(button(container, 'Save repeat').disabled).toBe(true);
    },
  );

  it('uses the active recurrence policy to select the required reference date', () => {
    const root = task({ planning: { scheduled: '2026-08-09', start: '2026-08-10' } });
    const { container } = mount({
      source: { root, target: { type: 'task', ref: root.ref } },
      policy: { removeScheduledDate: true },
    });

    click(button(container, 'Weekly'));

    expect(container.querySelector('.tc-recurrence-preview-rule')?.textContent).toBe(
      'every week on Monday',
    );
  });

  it('submits recurrence and completed-task policy in one patch from Cmd+Enter', async () => {
    const { container, onSubmit, onClose } = mount();
    click(button(container, 'Weekdays'));
    change(container.querySelector<HTMLSelectElement>('[aria-label="Completed task"]')!, 'delete');
    expect(container.querySelector('.tc-recurrence-delete-warning')?.textContent).toContain(
      'deletes the finished task and its owned sub-tasks',
    );

    keydown(container, 'Enter', true);
    await flushMicrotasks();

    expect(onSubmit).toHaveBeenCalledWith({
      recurrence: { type: 'set', value: 'every weekday' },
      onCompletion: { type: 'set', value: 'delete' },
    });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('owns Cmd+Enter before a host document shortcut can intercept it', async () => {
    const interceptHostShortcut = (event: KeyboardEvent): void => {
      if (event.key !== 'Enter' || !event.metaKey) return;
      event.preventDefault();
      event.stopPropagation();
    };
    activeDocument.addEventListener('keydown', interceptHostShortcut, true);
    try {
      const { container, onSubmit, onClose } = mount();
      activeDocument.body.appendChild(container);
      click(button(container, 'Weekdays'));
      const target = button(container, 'Weekdays');

      const shortcut = new KeyboardEvent('keydown', {
        key: 'Enter',
        metaKey: true,
        bubbles: true,
        cancelable: true,
      });
      target.dispatchEvent(shortcut);
      await flushMicrotasks();

      expect(shortcut.defaultPrevented).toBe(true);
      expect(onSubmit).toHaveBeenCalledWith({
        recurrence: { type: 'set', value: 'every weekday' },
      });
      expect(onClose).toHaveBeenCalledOnce();
    } finally {
      activeDocument.removeEventListener('keydown', interceptHostShortcut, true);
    }
  });

  it('submits a valid rule from Ctrl+Enter', async () => {
    const { container, onSubmit, onClose } = mount();
    activeDocument.body.appendChild(container);
    click(button(container, 'Weekdays'));

    const shortcut = submitShortcut(button(container, 'Weekdays'), { ctrlKey: true });
    await flushMicrotasks();

    expect(shortcut.defaultPrevented).toBe(true);
    expect(onSubmit).toHaveBeenCalledWith({
      recurrence: { type: 'set', value: 'every weekday' },
    });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it.each([
    ['Cmd+Enter', { metaKey: true }],
    ['Ctrl+Enter', { ctrlKey: true }],
  ] as const)('blocks invalid recurrence from %s without submitting', async (_name, modifiers) => {
    const { container, onSubmit, onClose } = mount();
    activeDocument.body.appendChild(container);
    click(button(container, 'Custom'));
    const raw = container.querySelector<HTMLInputElement>('[aria-label="Recurrence rule"]')!;
    input(raw, 'not a recurrence rule');

    const shortcut = submitShortcut(raw, modifiers);
    await flushMicrotasks();

    expect(shortcut.defaultPrevented).toBe(true);
    expect(container.querySelector('.tc-recurrence-status')?.textContent).not.toBe('');
    expect(button(container, 'Save repeat').disabled).toBe(true);
    expect(onSubmit).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('ignores a submit shortcut whose target is outside the mounted editor', async () => {
    const { container, onSubmit, onClose } = mount();
    activeDocument.body.appendChild(container);
    click(button(container, 'Weekdays'));
    const outside = activeDocument.body.createEl('button', { text: 'Outside' });

    const shortcut = submitShortcut(outside, { metaKey: true });
    await flushMicrotasks();

    expect(shortcut.defaultPrevented).toBe(false);
    expect(onSubmit).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('owns submit shortcuts in the editor owner realm', async () => {
    const frame = activeDocument.body.createEl('iframe');
    const ownerDocument = frame.contentDocument!;
    const ownerWindow = frame.contentWindow as Window & typeof globalThis;
    for (const method of ['createDiv', 'createEl', 'createSpan', 'empty'] as const) {
      Object.defineProperty(ownerWindow.HTMLElement.prototype, method, {
        configurable: true,
        value: HTMLElement.prototype[method],
      });
    }
    const root = task({ planning: { due: '2026-08-09' } });
    const container = ownerDocument.body.createDiv();
    const onSubmit = vi
      .fn<(patch: TaskPatch) => Promise<TaskCommandResult>>()
      .mockResolvedValue({ type: 'ok', changed: true, outcome: { type: 'task', task: root } });
    const onClose = vi.fn();
    const handle = mountRecurrenceEditor({
      container,
      source: { root, target: { type: 'task', ref: root.ref } },
      policy,
      ownershipConflict: false,
      onSubmit,
      onClose,
    });
    mounted.push(handle);

    click(button(container, 'Weekdays'));
    const shortcut = submitShortcut(button(container, 'Weekdays'), { metaKey: true });
    await flushMicrotasks();

    expect(shortcut).toBeInstanceOf(ownerWindow.KeyboardEvent);
    expect(shortcut.defaultPrevented).toBe(true);
    expect(onSubmit).toHaveBeenCalledWith({
      recurrence: { type: 'set', value: 'every weekday' },
    });
    expect(onClose).toHaveBeenCalledOnce();
    frame.remove();
  });

  it('removes the exact owner-window capture listener on destroy', async () => {
    const ownerWindow = activeDocument.defaultView!;
    const add = vi.spyOn(ownerWindow, 'addEventListener');
    const remove = vi.spyOn(ownerWindow, 'removeEventListener');
    const { container, handle, onSubmit } = mount();
    activeDocument.body.appendChild(container);
    const registration = add.mock.calls.find(
      ([type, _listener, options]) => type === 'keydown' && options === true,
    );
    expect(registration).toBeDefined();
    const listener = registration![1];

    handle.destroy();

    expect(remove).toHaveBeenCalledWith('keydown', listener, true);
    const replacement = container.createEl('button', { text: 'Replacement' });
    const shortcut = submitShortcut(replacement, { metaKey: true });
    await flushMicrotasks();
    expect(shortcut.defaultPrevented).toBe(false);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: 'default Keep',
      root: task({ planning: { due: '2026-08-09' } }),
      prepare: (container: HTMLElement) => click(button(container, 'Weekdays')),
      expected: { recurrence: { type: 'set', value: 'every weekday' } },
    },
    {
      name: 'Delete changed to Keep',
      root: task({
        recurrence: 'every day',
        onCompletion: 'delete',
        onCompletionExplicit: true,
        planning: { due: '2026-08-09' },
      }),
      prepare: (container: HTMLElement) =>
        change(
          container.querySelector<HTMLSelectElement>('[aria-label="Completed task"]')!,
          'keep',
        ),
      expected: {
        recurrence: { type: 'set', value: 'every day' },
        onCompletion: { type: 'clear' },
      },
    },
    {
      name: 'authored explicit Keep during a recurrence-only edit',
      root: task({
        recurrence: 'every day',
        onCompletion: 'keep',
        onCompletionExplicit: true,
        planning: { due: '2026-08-09' },
      }),
      prepare: (container: HTMLElement) =>
        input(
          container.querySelector<HTMLInputElement>('[aria-label="Recurrence rule"]')!,
          'every week',
        ),
      expected: { recurrence: { type: 'set', value: 'every week' } },
    },
  ])('preserves omission semantics for $name', async ({ root, prepare, expected }) => {
    const { container, onSubmit } = mount({
      source: { root, target: { type: 'task', ref: root.ref } },
    });

    prepare(container);
    click(button(container, 'Save repeat'));
    await flushMicrotasks();

    expect(onSubmit).toHaveBeenCalledWith(expected);
  });

  it('submits an advanced rule with Enter', async () => {
    const { container, onSubmit } = mount();
    click(button(container, 'Custom'));
    const raw = container.querySelector<HTMLInputElement>('[aria-label="Recurrence rule"]')!;
    input(raw, 'every month on the last Friday');

    keydown(raw, 'Enter');
    await flushMicrotasks();

    expect(onSubmit).toHaveBeenCalledWith({
      recurrence: { type: 'set', value: 'every month on the last Friday' },
    });
  });

  it('keeps the completion-date checkbox and advanced raw rule in one state', async () => {
    const { container, onSubmit } = mount();
    click(button(container, 'Custom'));
    const raw = container.querySelector<HTMLInputElement>('[aria-label="Recurrence rule"]')!;
    input(raw, 'every day');
    const whenDone = container.querySelector<HTMLInputElement>('.tc-recurrence-when-done')!;
    whenDone.checked = true;
    whenDone.dispatchEvent(new Event('change', { bubbles: true }));

    expect(raw.value).toBe('every day when done');
    expect(container.querySelector('.tc-recurrence-preview-rule')?.textContent).toBe(
      'every day when done',
    );

    keydown(raw, 'Enter');
    await flushMicrotasks();
    expect(onSubmit).toHaveBeenCalledWith({
      recurrence: { type: 'set', value: 'every day when done' },
    });
  });

  it.each([
    [false, 'every day when done', true, 'every week on Sunday when done'],
    [true, 'every day', false, 'every week on Sunday'],
  ] as const)(
    'carries valid advanced completion state into presets %#',
    (initialWhenDone, advancedRule, expectedChecked, expectedPresetRule) => {
      const { container } = mount();
      const controlsWhenDone = container.querySelector<HTMLInputElement>(
        '.tc-recurrence-when-done',
      )!;
      if (initialWhenDone) {
        controlsWhenDone.checked = true;
        controlsWhenDone.dispatchEvent(new Event('change', { bubbles: true }));
      }
      click(button(container, 'Custom'));
      const raw = container.querySelector<HTMLInputElement>('[aria-label="Recurrence rule"]')!;

      input(raw, advancedRule);

      expect(container.querySelector<HTMLInputElement>('.tc-recurrence-when-done')?.checked).toBe(
        expectedChecked,
      );
      click(button(container, 'Weekly'));
      expect(container.querySelector('.tc-recurrence-preview-rule')?.textContent).toBe(
        expectedPresetRule,
      );
    },
  );

  it('keeps completion suffix toggles idempotent for an invalid advanced rule', () => {
    const { container } = mount();
    click(button(container, 'Custom'));
    const raw = container.querySelector<HTMLInputElement>('[aria-label="Recurrence rule"]')!;
    const whenDone = container.querySelector<HTMLInputElement>('.tc-recurrence-when-done')!;
    input(raw, 'weekly');

    whenDone.checked = true;
    whenDone.dispatchEvent(new Event('change', { bubbles: true }));
    expect(raw.value).toBe('weekly when done');

    whenDone.checked = true;
    whenDone.dispatchEvent(new Event('change', { bubbles: true }));
    expect(raw.value).toBe('weekly when done');

    whenDone.checked = false;
    whenDone.dispatchEvent(new Event('change', { bubbles: true }));
    expect(raw.value).toBe('weekly');

    whenDone.checked = true;
    whenDone.dispatchEvent(new Event('change', { bubbles: true }));
    expect(raw.value).toBe('weekly when done');

    input(raw, 'weekly   when   done');
    whenDone.checked = false;
    whenDone.dispatchEvent(new Event('change', { bubbles: true }));
    expect(raw.value).toBe('weekly');
  });

  it('clears recurrence and on-completion atomically', async () => {
    const root = task({ recurrence: 'every day', onCompletion: 'delete' });
    const { container, onSubmit, onClose } = mount({
      source: { root, target: { type: 'task', ref: root.ref } },
    });

    click(button(container, 'Clear repeat'));
    await flushMicrotasks();

    expect(onSubmit).toHaveBeenCalledWith({
      recurrence: { type: 'clear' },
      onCompletion: { type: 'clear' },
    });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('keeps one diagnostic id wired to dynamic validity across controls and advanced rerenders', () => {
    const { container } = mount();
    const editor = container.querySelector<HTMLElement>('.tc-recurrence-editor')!;
    const title = container.querySelector<HTMLElement>('.tc-recurrence-title')!;
    const status = container.querySelector<HTMLElement>('.tc-recurrence-status')!;
    const diagnosticId = status.id;
    const interval = container.querySelector<HTMLInputElement>('[aria-label="Repeat interval"]')!;

    expect(editor.getAttribute('role')).toBe('region');
    expect(title.id).not.toBe('');
    expect(editor.getAttribute('aria-labelledby')).toBe(title.id);
    expect(diagnosticId).not.toBe('');
    expect(interval.getAttribute('aria-describedby')).toBe(diagnosticId);
    expect(interval.getAttribute('aria-invalid')).toBe('false');

    input(interval, '0');
    expect(interval.getAttribute('aria-invalid')).toBe('true');
    input(interval, '2');
    expect(interval.getAttribute('aria-invalid')).toBe('false');

    click(button(container, 'Custom'));
    const advancedStatus = container.querySelector<HTMLElement>('.tc-recurrence-status')!;
    const raw = container.querySelector<HTMLInputElement>('[aria-label="Recurrence rule"]')!;
    expect(advancedStatus.id).toBe(diagnosticId);
    expect(raw.getAttribute('aria-describedby')).toBe(diagnosticId);
    expect(raw.getAttribute('aria-invalid')).toBe('false');
    input(raw, 'weekly');
    expect(raw.getAttribute('aria-invalid')).toBe('true');
    input(raw, 'every week');
    expect(raw.getAttribute('aria-invalid')).toBe('false');
  });

  it('associates Month day validation with the stable diagnostic and only invalidates that field', () => {
    const { container } = mount();
    const diagnosticId = container.querySelector<HTMLElement>('.tc-recurrence-status')!.id;
    click(button(container, 'Monthly'));
    change(container.querySelector<HTMLSelectElement>('[aria-label="Monthly pattern"]')!, 'day');
    const day = container.querySelector<HTMLInputElement>('[aria-label="Month day"]')!;
    const interval = container.querySelector<HTMLInputElement>('[aria-label="Repeat interval"]')!;

    expect(day.getAttribute('aria-describedby')).toBe(diagnosticId);
    expect(day.getAttribute('aria-invalid')).toBe('false');
    input(day, '0');
    expect(day.getAttribute('aria-invalid')).toBe('true');
    expect(interval.getAttribute('aria-invalid')).toBe('false');
    expect(container.querySelector<HTMLElement>('.tc-recurrence-status')!.id).toBe(diagnosticId);
    input(day, '31');
    expect(day.getAttribute('aria-invalid')).toBe('false');
    expect(container.querySelector<HTMLElement>('.tc-recurrence-status')!.id).toBe(diagnosticId);
  });

  it('associates Yearly day validation with the stable diagnostic and only invalidates that field', () => {
    const { container } = mount();
    const diagnosticId = container.querySelector<HTMLElement>('.tc-recurrence-status')!.id;
    click(button(container, 'Yearly'));
    change(container.querySelector<HTMLSelectElement>('[aria-label="Yearly pattern"]')!, 'date');
    const day = container.querySelector<HTMLInputElement>('[aria-label="Yearly day"]')!;
    const interval = container.querySelector<HTMLInputElement>('[aria-label="Repeat interval"]')!;

    expect(day.getAttribute('aria-describedby')).toBe(diagnosticId);
    expect(day.getAttribute('aria-invalid')).toBe('false');
    input(day, '32');
    expect(day.getAttribute('aria-invalid')).toBe('true');
    expect(interval.getAttribute('aria-invalid')).toBe('false');
    expect(container.querySelector<HTMLElement>('.tc-recurrence-status')!.id).toBe(diagnosticId);
    input(day, '29');
    expect(day.getAttribute('aria-invalid')).toBe('false');
    expect(container.querySelector<HTMLElement>('.tc-recurrence-status')!.id).toBe(diagnosticId);
  });

  it('labels an anchored editor as a non-modal dialog without nested modal semantics', () => {
    const anchor = activeDocument.body.createEl('button', { text: 'Repeat marker' });
    const root = task({ planning: { due: '2026-08-09' } });
    const handle = mountAnchoredRecurrenceEditor({
      anchor,
      source: { root, target: { type: 'task', ref: root.ref } },
      policy,
      ownershipConflict: false,
      onSubmit: vi.fn().mockResolvedValue({
        type: 'ok',
        changed: true,
        outcome: { type: 'task', task: root },
      }),
    });
    mounted.push(handle);

    const popover = activeDocument.querySelector<HTMLElement>('.tc-recurrence-popover')!;
    const title = popover.querySelector<HTMLElement>('.tc-recurrence-title')!;
    expect(popover.getAttribute('role')).toBe('dialog');
    expect(popover.getAttribute('aria-modal')).toBe('false');
    expect(popover.getAttribute('aria-labelledby')).toBe(title.id);
    expect(popover.querySelector('[aria-modal="true"]')).toBeNull();
  });

  it('restores the previously focused anchor when Escape closes the editor', () => {
    const anchor = activeDocument.body.createEl('button', { text: '+ repeat' });
    anchor.focus();
    const { container, onClose } = mount();

    keydown(container, 'Escape');

    expect(onClose).toHaveBeenCalledOnce();
    expect(activeDocument.activeElement).toBe(anchor);
  });

  it('restores the previously focused anchor when Cancel closes the editor', () => {
    const anchor = activeDocument.body.createEl('button', { text: '+ repeat' });
    anchor.focus();
    const { container, handle, onClose } = mount();
    activeDocument.body.append(container);
    handle.focus();

    click(button(container, 'Cancel'));

    expect(onClose).toHaveBeenCalledOnce();
    expect(activeDocument.activeElement).toBe(anchor);
  });

  it('restores a connected anchor when an outside click dismisses the anchored editor', () => {
    vi.useFakeTimers();
    const previous = activeDocument.body.createEl('button', { text: 'Previous focus' });
    const anchor = activeDocument.body.createEl('button', { text: 'Repeat marker' });
    previous.focus();
    const root = task({ planning: { due: '2026-08-09' } });
    const handle = mountAnchoredRecurrenceEditor({
      anchor,
      source: { root, target: { type: 'task', ref: root.ref } },
      policy,
      ownershipConflict: false,
      onSubmit: vi.fn().mockResolvedValue({
        type: 'ok',
        changed: true,
        outcome: { type: 'task', task: root },
      }),
    });
    mounted.push(handle);
    vi.runAllTimers();

    activeDocument.body.dispatchEvent(
      new MouseEvent('mousedown', { bubbles: true, cancelable: true }),
    );

    expect(activeDocument.querySelector('.tc-recurrence-popover')).toBeNull();
    expect(activeDocument.activeElement).toBe(anchor);
    vi.useRealTimers();
  });
});
