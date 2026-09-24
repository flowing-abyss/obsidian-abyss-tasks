import { afterEach, describe, expect, it, vi } from 'vitest';
import { deferred, expectDefined, flushMicrotasks, useRealMoment } from './helpers';
import {
  inspectorCleanups,
  inspectorHarness,
  notices,
  subscribeInspectorReconciliation,
  type InspectorHarness,
} from './support/inspectorHarness';

useRealMoment();

afterEach(() => {
  for (const cleanup of inspectorCleanups.splice(0)) cleanup();
  activeDocument.body.empty();
  vi.restoreAllMocks();
});

/** The production-wired inspector with a host that rebuilds the selection on each index change. */
async function hosted(markdown: string, selected = 'Current'): Promise<InspectorHarness> {
  const h = await inspectorHarness(markdown, selected);
  // Unsubscribe the host before the harness destroys the panel and the index.
  inspectorCleanups.unshift(subscribeInspectorReconciliation(h));
  return h;
}

function control<T extends HTMLElement = HTMLButtonElement>(
  h: InspectorHarness,
  selector: string,
): T {
  return expectDefined(h.el.querySelector<T>(selector), `Missing ${selector}`);
}

function dateChip(h: InspectorHarness): HTMLButtonElement {
  return expectDefined(
    Array.from(h.el.querySelectorAll<HTMLButtonElement>('.abyss-chips-row > button')).find(
      (candidate) => candidate.textContent.startsWith('📅'),
    ),
    'Missing date chip',
  );
}

function activate(element: HTMLElement): void {
  element.focus();
  element.click();
}

function key(target: HTMLElement, value: string): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event;
}

function change(input: HTMLInputElement, value: string): void {
  input.value = value;
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

function expectRebuiltFocus(before: HTMLElement, after: HTMLElement): void {
  expect(before.isConnected).toBe(false);
  expect(after).not.toBe(before);
  expect(activeDocument.activeElement).toBe(after);
}

function selectedTitle(h: InspectorHarness): string | undefined {
  const stack = h.state.get('taskStack');
  return stack[stack.length - 1]?.title;
}

function addDateItem(h: InspectorHarness, label: string): HTMLElement {
  return expectDefined(
    Array.from(h.el.querySelectorAll<HTMLElement>('.abyss-add-date-menu-item')).find(
      (item) => item.textContent === label,
    ),
    `Missing ${label}`,
  );
}

function editorButton(h: InspectorHarness, label: string): HTMLButtonElement {
  return expectDefined(
    Array.from(h.el.querySelectorAll<HTMLButtonElement>('.abyss-recurrence-editor button')).find(
      (candidate) => candidate.textContent.trim() === label,
    ),
    `Missing ${label}`,
  );
}

/** Holds the next write until `release`, so a test can act while it is in flight. */
function holdNextWrite(h: InspectorHarness) {
  const gate = deferred<void>();
  const execute = h.api.execute.bind(h.api);
  const spy = vi.spyOn(h.api, 'execute').mockImplementationOnce(async (command) => {
    await gate.promise;
    return execute(command);
  });
  return {
    spy,
    release: () => {
      gate.resolve();
    },
  };
}

describe('inspector planning focus continuity', () => {
  it('returns focus to the rebuilt priority chip after an option is chosen', async () => {
    const h = await hosted('- [ ] Current\n');
    const chip = control(h, '.abyss-priority-chip');

    activate(chip);
    activate(control(h, '.abyss-priority-option[data-priority="A"]'));
    await flushMicrotasks();

    expect(await h.read()).toBe('- [ ] Current 🔺\n');
    expectRebuiltFocus(chip, control(h, '.abyss-priority-chip'));
  });

  it('returns focus to the rebuilt date chip after a native date change', async () => {
    const h = await hosted('- [ ] Current\n');
    const chip = dateChip(h);

    activate(chip);
    await flushMicrotasks();
    change(control<HTMLInputElement>(h, '.abyss-date-popover .abyss-date-input'), '2026-09-24');
    await flushMicrotasks();

    expect(await h.read()).toBe('- [ ] Current 📅 2026-09-24\n');
    expectRebuiltFocus(chip, dateChip(h));
  });

  it('returns focus to the rebuilt date chip after a typed date and Enter', async () => {
    const h = await hosted('- [ ] Current\n');
    const chip = dateChip(h);

    activate(chip);
    await flushMicrotasks();
    const input = control<HTMLInputElement>(h, '.abyss-date-popover .abyss-date-input');
    key(input, '2');
    change(input, '2026-09-24');
    const enter = key(input, 'Enter');
    await flushMicrotasks();

    expect(enter.defaultPrevented).toBe(true);
    expect(await h.read()).toBe('- [ ] Current 📅 2026-09-24\n');
    expectRebuiltFocus(chip, dateChip(h));
  });

  it('returns focus to the rebuilt time chip after a time change', async () => {
    const h = await hosted('- [ ] Current\n');
    const chip = control(h, '.abyss-chip-time');

    activate(chip);
    await flushMicrotasks();
    change(control<HTMLInputElement>(h, '.abyss-time-popover .abyss-time-input'), '10:45');
    await flushMicrotasks();

    expect(await h.read()).toBe('- [ ] Current ⏰ 10:45\n');
    expectRebuiltFocus(chip, control(h, '.abyss-chip-time'));
  });

  it('returns focus to the rebuilt "+ date" after the plan date is cleared', async () => {
    const h = await hosted('- [ ] Current ⏳ 2026-09-25\n');
    const chip = control(h, '.abyss-chip-scheduled');

    activate(chip);
    await flushMicrotasks();
    activate(control(h, '.abyss-date-popover [aria-label="Clear date"]'));
    await flushMicrotasks();

    expect(await h.read()).toBe('- [ ] Current\n');
    expect(h.el.querySelector('.abyss-chip-scheduled')).toBeNull();
    expectRebuiltFocus(chip, control(h, '.abyss-chip-add-date'));
  });

  it('moves focus to the new plan chip when "+ date" → Plan removes "+ date"', async () => {
    const h = await hosted('- [ ] Current 🛫 2026-09-24\n');
    const add = control(h, '.abyss-chip-add-date');

    activate(add);
    activate(addDateItem(h, '⏳ Plan'));
    await flushMicrotasks();
    change(control<HTMLInputElement>(h, '.abyss-date-popover .abyss-date-input'), '2026-09-25');
    await flushMicrotasks();

    expect(await h.read()).toBe('- [ ] Current 🛫 2026-09-24 ⏳ 2026-09-25\n');
    expect(h.el.querySelector('.abyss-chip-add-date')).toBeNull();
    expectRebuiltFocus(add, control(h, '.abyss-chip-scheduled'));
  });

  it('returns focus to the rebuilt "+ date" after "+ date" → Plan while it stays', async () => {
    const h = await hosted('- [ ] Current\n');
    const add = control(h, '.abyss-chip-add-date');

    activate(add);
    activate(addDateItem(h, '⏳ Plan'));
    await flushMicrotasks();
    change(control<HTMLInputElement>(h, '.abyss-date-popover .abyss-date-input'), '2026-09-25');
    await flushMicrotasks();

    expect(await h.read()).toBe('- [ ] Current ⏳ 2026-09-25\n');
    expectRebuiltFocus(add, control(h, '.abyss-chip-add-date'));
  });

  it('returns focus to the rebuilt "+ tag" after a tag is added', async () => {
    const h = await hosted('- [ ] Current\n');
    const add = control(h, '[aria-label="Add tag"]');

    activate(add);
    const input = control<HTMLInputElement>(h, '.abyss-tag-input');
    input.value = '#work';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    key(input, 'Enter');
    await flushMicrotasks();

    expect(await h.read()).toBe('- [ ] Current #work\n');
    expectRebuiltFocus(add, control(h, '[aria-label="Add tag"]'));
  });

  it('returns focus to the rebuilt "+ tag" after a tag chip is removed', async () => {
    const h = await hosted('- [ ] Current #work\n');
    const remove = control(h, '.abyss-chip-tag .abyss-chip-remove');

    activate(remove);
    await flushMicrotasks();

    expect(await h.read()).not.toContain('#work');
    expectRebuiltFocus(remove, control(h, '[aria-label="Add tag"]'));
  });

  it('returns focus to the rebuilt priority chip of a drilled-in sub-task', async () => {
    const h = await hosted('- [ ] Current\n  - [ ] Child\n', 'Child');
    const chip = control(h, '.abyss-priority-chip');

    activate(chip);
    activate(control(h, '.abyss-priority-option[data-priority="A"]'));
    await flushMicrotasks();

    expect(await h.read()).toBe('- [ ] Current\n  - [ ] Child 🔺\n');
    expect(selectedTitle(h)).toBe('Child');
    expectRebuiltFocus(chip, control(h, '.abyss-priority-chip'));
  });

  it('returns focus to the rebuilt date chip of a drilled-in sub-task', async () => {
    const h = await hosted('- [ ] Current\n  - [ ] Child\n', 'Child');
    const chip = dateChip(h);

    activate(chip);
    await flushMicrotasks();
    change(control<HTMLInputElement>(h, '.abyss-date-popover .abyss-date-input'), '2026-09-24');
    await flushMicrotasks();

    expect(await h.read()).toBe('- [ ] Current\n  - [ ] Child 📅 2026-09-24\n');
    expect(selectedTitle(h)).toBe('Child');
    expectRebuiltFocus(chip, dateChip(h));
  });

  it('returns focus to the rebuilt time chip of a drilled-in sub-task', async () => {
    const h = await hosted('- [ ] Current\n  - [ ] Child\n', 'Child');
    const chip = control(h, '.abyss-chip-time');

    activate(chip);
    await flushMicrotasks();
    change(control<HTMLInputElement>(h, '.abyss-time-popover .abyss-time-input'), '10:45');
    await flushMicrotasks();

    expect(await h.read()).toBe('- [ ] Current\n  - [ ] Child ⏰ 10:45\n');
    expect(selectedTitle(h)).toBe('Child');
    expectRebuiltFocus(chip, control(h, '.abyss-chip-time'));
  });

  it('keeps focus on the date chip across an external edit to another line', async () => {
    const h = await hosted('- [ ] Current\n- [ ] Other\n');
    const chip = dateChip(h);

    chip.focus();
    await h.app.vault.modify(h.file, '\n- [ ] Current\n- [ ] Other edited\n');
    await flushMicrotasks(40);

    expectRebuiltFocus(chip, dateChip(h));
  });

  it('returns focus to the rebuilt repeat chip after Clear repeat', async () => {
    const h = await hosted('- [ ] Current 🔁 every day 📅 2026-09-23\n');
    const chip = control(h, '.abyss-repeat-chip');

    activate(chip);
    await flushMicrotasks();
    activate(editorButton(h, 'Clear repeat'));
    await flushMicrotasks();

    expect(await h.read()).toBe('- [ ] Current 📅 2026-09-23\n');
    expect(h.el.querySelector('.abyss-recurrence-editor')).toBeNull();
    expectRebuiltFocus(chip, control(h, '.abyss-repeat-chip'));
  });

  it('leaves focus where the user moved it while a change was pending', async () => {
    const h = await hosted('- [ ] Current\n');
    const outside = activeDocument.body.createEl('button', { text: 'Outside' });
    const held = holdNextWrite(h);

    activate(control(h, '.abyss-priority-chip'));
    activate(control(h, '.abyss-priority-option[data-priority="A"]'));
    outside.focus();
    held.release();
    await flushMicrotasks();

    expect(await h.read()).toBe('- [ ] Current 🔺\n');
    // Focusing the rebuilt control whatever the active element is would pull focus back here.
    expect(activeDocument.activeElement).toBe(outside);
  });

  it('moves no focus when another task is selected while a change is pending', async () => {
    const h = await hosted('- [ ] Current\n- [ ] Other\n');
    const held = holdNextWrite(h);

    activate(control(h, '.abyss-priority-chip'));
    activate(control(h, '.abyss-priority-option[data-priority="A"]'));
    const other = h.node('Other');
    h.state.set('taskStack', [other.root, ...other.path]);
    held.release();
    await flushMicrotasks();

    expect(await h.read()).toBe('- [ ] Current 🔺\n- [ ] Other\n');
    expect(selectedTitle(h)).toBe('Other');
    // A capture without the same-or-successor gate would carry the chip's focus over to Other.
    expect(activeDocument.activeElement).toBe(activeDocument.body);
  });

  it('focuses nothing when the inspector is destroyed while a change is pending', async () => {
    const h = await hosted('- [ ] Current\n');
    const held = holdNextWrite(h);

    activate(control(h, '.abyss-priority-chip'));
    activate(control(h, '.abyss-priority-option[data-priority="A"]'));
    h.panel.destroy();
    const focus = vi.spyOn(HTMLElement.prototype, 'focus');
    held.release();
    await flushMicrotasks();

    expect(await h.read()).toBe('- [ ] Current 🔺\n');
    // A restore that outlived destroy() would focus a control of the torn-down inspector.
    expect(focus).not.toHaveBeenCalled();
  });

  it('keeps focus on the date chip when the date change fails', async () => {
    const h = await hosted('- [ ] Current\n');
    const messages: string[] = [];
    notices(messages);
    vi.spyOn(h.api, 'execute').mockResolvedValueOnce({
      type: 'io-error',
      cause: 'test',
      contentState: 'unchanged',
    });
    const chip = dateChip(h);

    activate(chip);
    await flushMicrotasks();
    change(control<HTMLInputElement>(h, '.abyss-date-popover .abyss-date-input'), '2026-09-24');
    await flushMicrotasks();

    expect(messages).toEqual(['Failed to update task. Please try again.']);
    expect(await h.read()).toBe('- [ ] Current\n');
    expect(chip.isConnected).toBe(true);
    expect(activeDocument.activeElement).toBe(chip);
  });

  it('keeps focus on the time chip when the time change fails', async () => {
    const h = await hosted('- [ ] Current\n');
    const messages: string[] = [];
    notices(messages);
    vi.spyOn(h.api, 'execute').mockResolvedValueOnce({
      type: 'io-error',
      cause: 'test',
      contentState: 'unchanged',
    });
    const chip = control(h, '.abyss-chip-time');

    activate(chip);
    await flushMicrotasks();
    change(control<HTMLInputElement>(h, '.abyss-time-popover .abyss-time-input'), '10:45');
    await flushMicrotasks();

    expect(messages).toEqual(['Failed to update task. Please try again.']);
    expect(await h.read()).toBe('- [ ] Current\n');
    expect(chip.isConnected).toBe(true);
    expect(activeDocument.activeElement).toBe(chip);
  });
});
