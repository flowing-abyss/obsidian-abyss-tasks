import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RecurrencePolicy, TaskCommandResult, TaskPatch } from '../src/tasks';
import {
  mountAnchoredRecurrenceEditor,
  mountRecurrenceEditor,
  type RecurrenceEditorHandle,
} from '../src/ui/recurrence/RecurrenceEditor';
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

  it('keeps advanced validation inline and reserves a polite live status line', () => {
    const { container } = mount();
    click(button(container, 'Advanced'));
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
    click(button(container, 'Advanced'));
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
    click(button(container, 'Advanced'));
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
      click(button(container, 'Advanced'));
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
    click(button(container, 'Advanced'));
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

    click(button(container, 'Advanced'));
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
