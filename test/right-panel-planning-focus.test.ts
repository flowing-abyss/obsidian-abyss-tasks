import { addIcon, removeIcon } from 'obsidian';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TaskCommandResult } from '../src/tasks';
import {
  deferred,
  dropFocusFromDisabledButton,
  expectDefined,
  flushMicrotasks,
  useRealMoment,
} from './helpers';
import {
  inspectorCleanups,
  inspectorHarness,
  notices,
  subscribeInspectorReconciliation,
  type InspectorHarness,
} from './support/inspectorHarness';
import { searchUiCompleted } from './support/taskSearchUiHarness';

useRealMoment();

const PENDING_EDIT_NOTICE =
  'Another change to this task is still being saved. Try again in a moment.';

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

function menuItem(h: InspectorHarness, label: string): HTMLElement {
  return expectDefined(
    Array.from(
      h.el.querySelectorAll<HTMLElement>('.abyss-task-context-menu .abyss-context-item'),
    ).find((item) => item.textContent === label),
    `Missing ${label}`,
  );
}

interface HeldWriteOptions {
  /** The result the held write returns instead of running. */
  readonly outcome?: TaskCommandResult;
  /** The write first drops focus the way Chromium does when the submit disables Save. */
  readonly dropSaveFocus?: boolean;
}

/** Holds the next write until `release`, so a test can act while it is in flight. */
function holdNextWrite(h: InspectorHarness, { outcome, dropSaveFocus }: HeldWriteOptions = {}) {
  const gate = deferred<void>();
  const execute = h.api.execute.bind(h.api);
  const spy = vi.spyOn(h.api, 'execute').mockImplementationOnce(async (command) => {
    if (dropSaveFocus === true) dropFocusFromDisabledButton();
    await gate.promise;
    return outcome ?? execute(command);
  });
  return {
    spy,
    release: () => {
      gate.resolve();
    },
  };
}

describe('inspector planning focus continuity', () => {
  const childPlain = '- [ ] Current #parent\n  - [ ] Child #child\n  - [ ] Sibling #sibling\n';
  const childTagged = childPlain.replace('Child #child', 'Child #child #added');
  const childCompleted = childPlain.replace('- [ ] Child', '- [x] Child');

  it('retains the drilled child and Add tag focus after its exact tag addition', async () => {
    const h = await hosted(childPlain, 'Child');
    const opener = control(h, '[aria-label="Add tag"]');
    activate(opener);
    const input = control<HTMLInputElement>(h, '.abyss-tag-input');
    input.value = '#added';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(activeDocument.activeElement).toBe(input);
    expect(await h.read()).toBe(childPlain);
    key(input, 'Enter');
    await flushMicrotasks();
    expect(await h.read()).toBe(childTagged);
    const child = h.node('Child');
    expect(h.state.get('taskStack')).toEqual([child.root, ...child.path]);
    expectRebuiltFocus(opener, control(h, '[aria-label="Add tag"]'));
    expect(h.node('Current').node.tags).toEqual(['#parent']);
    expect(h.node('Current').node.statusSymbol).toBe(' ');
    expect(h.node('Sibling').node.tags).toEqual(['#sibling']);
    expect(h.node('Sibling').node.statusSymbol).toBe(' ');
  });

  it('retains the drilled child and Add tag focus after its exact tag removal', async () => {
    const h = await hosted(childTagged, 'Child');
    const chip = expectDefined(
      Array.from(h.el.querySelectorAll<HTMLElement>('.abyss-chip-tag')).find((candidate) =>
        candidate.textContent.startsWith('#added'),
      ),
    );
    const remove = expectDefined(chip.querySelector<HTMLElement>('.abyss-chip-remove'));
    activate(remove);
    await flushMicrotasks();
    expect(await h.read()).toBe(childPlain);
    const child = h.node('Child');
    expect(h.state.get('taskStack')).toEqual([child.root, ...child.path]);
    expectRebuiltFocus(remove, control(h, '[aria-label="Add tag"]'));
    expect(h.node('Current').node.tags).toEqual(['#parent']);
    expect(h.node('Current').node.statusSymbol).toBe(' ');
    expect(h.node('Sibling').node.tags).toEqual(['#sibling']);
    expect(h.node('Sibling').node.statusSymbol).toBe(' ');
  });

  it.each(['Current', 'Child'])(
    'retains the rebuilt child status focus under %s',
    async (selected) => {
      const h = await hosted(childCompleted, selected);
      const locate = () => {
        if (selected === 'Child')
          return control(h, '.abyss-right-header .abyss-status-marker[role="checkbox"]');
        const label = expectDefined(
          Array.from(h.el.querySelectorAll<HTMLElement>('.abyss-subtask-label')).find(
            (candidate) => candidate.textContent === 'Child',
          ),
        );
        return expectDefined(
          label
            .closest('.abyss-subtask-row')
            ?.querySelector<HTMLElement>('.abyss-status-marker[role="checkbox"]'),
        );
      };
      const marker = locate();
      marker.focus();
      expect(activeDocument.activeElement).toBe(marker);
      key(marker, ' ');
      await flushMicrotasks();
      expect(await h.read()).toBe(childPlain);
      const current = h.node(selected);
      expect(h.state.get('taskStack')).toEqual([current.root, ...current.path]);
      expectRebuiltFocus(marker, locate());
      expect(h.node('Child').node.statusSymbol).toBe(' ');
    },
  );

  it('does not steal outside focus when an owned child status write settles', async () => {
    const h = await hosted(childCompleted);
    const label = expectDefined(
      Array.from(h.el.querySelectorAll<HTMLElement>('.abyss-subtask-label')).find(
        (candidate) => candidate.textContent === 'Child',
      ),
    );
    const marker = expectDefined(
      label
        .closest('.abyss-subtask-row')
        ?.querySelector<HTMLElement>('.abyss-status-marker[role="checkbox"]'),
    );
    const held = holdNextWrite(h);
    marker.focus();
    key(marker, ' ');
    const outside = activeDocument.body.createEl('button', { text: 'Outside' });
    outside.focus();
    held.release();
    await flushMicrotasks();
    expect(await h.read()).toBe(childPlain);
    const current = h.node('Current');
    expect(h.state.get('taskStack')).toEqual([current.root, ...current.path]);
    expect(activeDocument.activeElement).toBe(outside);
  });

  const continuityBase = '- [ ] Current #qasp1aa 📅 2031-02-10\n- [ ] Other #qasp1aa\nSentinel.\n';
  const continuityExternal = continuityBase.replace('Other #qasp1aa', 'Other edited #qasp1aa');

  it.each([
    { kind: 'date', selector: '.abyss-date-input', value: '2031-02-12' },
    { kind: 'tag', selector: '.abyss-tag-input', value: 'qasp1aa-draft' },
  ])(
    'keeps actually typed $kind through real same-task reconciliation and saves its original target',
    async ({ kind, selector, value }) => {
      const h = await hosted(continuityBase);
      activate(kind === 'date' ? dateChip(h) : control(h, '[aria-label="Add tag"]'));
      await flushMicrotasks();
      const input = control<HTMLInputElement>(h, selector);
      if (kind === 'date') {
        key(input, '2');
        change(input, value);
      } else {
        input.value = value;
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
      expect(activeDocument.activeElement).toBe(input);
      expect(await h.read()).toBe(continuityBase);
      await h.app.vault.modify(h.file, `\n${continuityExternal}`);
      await flushMicrotasks(40);
      expect(h.el.querySelector(selector)).toBe(input);
      expect(input.value).toBe(value);
      expect(activeDocument.activeElement).toBe(input);
      expect(await h.read()).toBe(continuityExternal);
      let external = continuityExternal;
      if (kind === 'date') {
        external = continuityBase.replace('Other #qasp1aa', 'Other edited twice #qasp1aa');
        await h.app.vault.modify(h.file, `\n${external}`);
        await flushMicrotasks(40);
        expect(h.el.querySelector(selector)).toBe(input);
        expect(input.value).toBe(value);
        expect(activeDocument.activeElement).toBe(input);
        expect(await h.read()).toBe(external);
      }
      key(input, 'Enter');
      await flushMicrotasks(40);
      const expected =
        kind === 'date'
          ? external.replace('📅 2031-02-10', '📅 2031-02-12')
          : external.replace('#qasp1aa 📅', '#qasp1aa #qasp1aa-draft 📅');
      expect(await h.read()).toBe(expected);
      expect(selectedTitle(h)).toBe('Current');
      expect(h.el.querySelector(selector)).toBeNull();
      expect(activeDocument.activeElement).toBe(
        kind === 'date' ? dateChip(h) : control(h, '[aria-label="Add tag"]'),
      );
    },
  );

  it('keeps a normally opened date editor when a held tag releases its pending render', async () => {
    const h = await hosted(continuityBase);
    activate(control(h, '[aria-label="Add tag"]'));
    await flushMicrotasks();
    const tagInput = control<HTMLInputElement>(h, '.abyss-tag-input');
    tagInput.value = 'qasp1aa-draft';
    tagInput.dispatchEvent(new Event('input', { bubbles: true }));
    await h.app.vault.modify(h.file, `\n${continuityExternal}`);
    await flushMicrotasks(40);
    expect(h.el.querySelector('.abyss-tag-input')).toBe(tagInput);
    expect(activeDocument.activeElement).toBe(tagInput);
    expect(await h.read()).toBe(continuityExternal);

    const chip = dateChip(h);
    const header = control(h, '.abyss-right-title-view');
    const ownerDocument = chip.ownerDocument;
    // Two-phase unit model of the observed native capture→microtask→target ordering.
    // The production capture listener dismisses the tag; this later gate pauses only continuation.
    const pauseTargetHandler = (event: MouseEvent): void => {
      if (event.target === chip) event.stopPropagation();
    };
    ownerDocument.addEventListener('click', pauseTargetHandler, true);
    try {
      activate(chip);
      // Promise-only checkpoint: flushMicrotasks also advances timers and cannot model this phase.
      await Promise.resolve();
      await Promise.resolve();
      expect(tagInput.isConnected).toBe(false);
      expect(chip.isConnected).toBe(true);
      expect(dateChip(h)).toBe(chip);
      expect(header.isConnected).toBe(true);
      expect(control(h, '.abyss-right-title-view')).toBe(header);
    } finally {
      ownerDocument.removeEventListener('click', pauseTargetHandler, true);
    }
    chip.click();
    const dateInput = control<HTMLInputElement>(h, '.abyss-date-input');
    expect(tagInput.isConnected).toBe(false);
    await flushMicrotasks(40);
    expect(dateInput.isConnected).toBe(true);
    expect(h.el.querySelector('.abyss-date-input')).toBe(dateInput);
    expect(activeDocument.activeElement).toBe(dateInput);
    expect(await h.read()).toBe(continuityExternal);

    key(dateInput, 'Escape');
    await flushMicrotasks(40);
    expect(h.el.querySelector('.abyss-date-input')).toBeNull();
    expectRebuiltFocus(chip, dateChip(h));
    expect(await h.read()).toBe(continuityExternal);
  });

  it.each(['outside', 'switch', 'destroy'] as const)(
    'releases a held editor without stale writes or focus after %s',
    async (kind) => {
      const h = await hosted(continuityBase);
      const chip = dateChip(h);
      activate(chip);
      await flushMicrotasks();
      const input = control<HTMLInputElement>(h, '.abyss-date-input');
      key(input, '2');
      change(input, '2031-02-12');
      await h.app.vault.modify(h.file, `\n${continuityExternal}`);
      await flushMicrotasks(40);
      expect(h.el.querySelector('.abyss-date-input')).toBe(input);
      key(input, 'Escape');
      const outside = activeDocument.body.createEl('button', { text: 'Outside' });
      outside.focus();
      if (kind === 'switch') {
        const other = h.node('Other edited');
        h.state.set('taskStack', [other.root, ...other.path]);
      } else if (kind === 'destroy') h.panel.destroy();
      const focus = vi.spyOn(HTMLElement.prototype, 'focus');
      await flushMicrotasks(40);
      expect(h.el.querySelector('.abyss-date-input')).toBeNull();
      expect(await h.read()).toBe(continuityExternal);
      expect(activeDocument.activeElement).toBe(outside);
      expect(focus).not.toHaveBeenCalled();
      if (kind === 'switch') expect(selectedTitle(h)).toBe('Other edited');
      if (kind === 'outside') expect(dateChip(h)).not.toBe(chip);
    },
  );

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

describe('inspector repeat editor focus continuity', () => {
  it('returns focus to the rebuilt repeat chip after Save', async () => {
    const h = await hosted('- [ ] Current 📅 2026-09-23\n');
    const chip = control(h, '.abyss-repeat-chip');
    const held = holdNextWrite(h, { dropSaveFocus: true });

    activate(chip);
    await flushMicrotasks();
    activate(editorButton(h, 'Daily'));
    activate(editorButton(h, 'Save repeat'));
    held.release();
    await flushMicrotasks();

    expect(await h.read()).toBe('- [ ] Current 🔁 every day 📅 2026-09-23\n');
    expect(h.el.querySelector('.abyss-recurrence-editor')).toBeNull();
    expectRebuiltFocus(chip, control(h, '.abyss-repeat-chip'));
  });

  it('returns focus to the rebuilt actions button after Save from Edit repeat…', async () => {
    const h = await hosted('- [ ] Current 📅 2026-09-23\n');
    const actions = control(h, '[aria-label="More actions"]');
    const held = holdNextWrite(h, { dropSaveFocus: true });

    activate(actions);
    const item = menuItem(h, 'Edit repeat…');
    item.focus();
    key(item, 'Enter');
    await flushMicrotasks();
    activate(editorButton(h, 'Daily'));
    activate(editorButton(h, 'Save repeat'));
    held.release();
    await flushMicrotasks();

    expect(await h.read()).toBe('- [ ] Current 🔁 every day 📅 2026-09-23\n');
    expectRebuiltFocus(actions, control(h, '[aria-label="More actions"]'));
  });

  it('closes the repeat editor and refocuses the chip after a Save that changes nothing', async () => {
    const h = await hosted('- [ ] Current 🔁 every day 📅 2026-09-23\n');
    const chip = control(h, '.abyss-repeat-chip');
    const held = holdNextWrite(h, { dropSaveFocus: true });

    activate(chip);
    await flushMicrotasks();
    activate(editorButton(h, 'Weekly'));
    activate(editorButton(h, 'Daily'));
    activate(editorButton(h, 'Save repeat'));
    held.release();
    await flushMicrotasks();

    expect(await held.spy.mock.results[0]?.value).toMatchObject({ type: 'ok', changed: false });
    expect(await h.read()).toBe('- [ ] Current 🔁 every day 📅 2026-09-23\n');
    // Restoring the submitted editor draft after an unchanged result would reopen the editor.
    expect(h.el.querySelector('.abyss-recurrence-editor')).toBeNull();
    expectRebuiltFocus(chip, control(h, '.abyss-repeat-chip'));
  });

  it('returns focus to the rebuilt repeat chip of a drilled-in sub-task after Save', async () => {
    const h = await hosted('- [ ] Current\n  - [ ] Child 📅 2026-09-23\n', 'Child');
    const chip = control(h, '.abyss-repeat-chip');
    const held = holdNextWrite(h, { dropSaveFocus: true });

    activate(chip);
    await flushMicrotasks();
    activate(editorButton(h, 'Daily'));
    activate(editorButton(h, 'Save repeat'));
    held.release();
    await flushMicrotasks();

    expect(await h.read()).toBe('- [ ] Current\n  - [ ] Child 🔁 every day 📅 2026-09-23\n');
    expect(selectedTitle(h)).toBe('Child');
    expectRebuiltFocus(chip, control(h, '.abyss-repeat-chip'));
  });

  it('moves no focus when another task is selected while a repeat save is pending', async () => {
    const h = await hosted('- [ ] Current 📅 2026-09-23\n- [ ] Other\n');
    const held = holdNextWrite(h, { dropSaveFocus: true });

    activate(control(h, '.abyss-repeat-chip'));
    await flushMicrotasks();
    activate(editorButton(h, 'Daily'));
    activate(editorButton(h, 'Save repeat'));
    await flushMicrotasks();
    expect(activeDocument.activeElement).toBe(activeDocument.body);
    const other = h.node('Other');
    h.state.set('taskStack', [other.root, ...other.path]);
    held.release();
    await flushMicrotasks();

    expect(await h.read()).toBe('- [ ] Current 🔁 every day 📅 2026-09-23\n- [ ] Other\n');
    expect(selectedTitle(h)).toBe('Other');
    // Keeping the repeat intent across a selection change would focus the other task's repeat chip.
    expect(activeDocument.activeElement).toBe(activeDocument.body);
  });

  it('returns focus to the rebuilt repeat chip when the note changes elsewhere during a repeat save', async () => {
    const h = await hosted('- [ ] Current 📅 2026-09-23\n- [ ] Other\n');
    const chip = control(h, '.abyss-repeat-chip');
    const held = holdNextWrite(h, { dropSaveFocus: true });

    activate(chip);
    await flushMicrotasks();
    activate(editorButton(h, 'Daily'));
    activate(editorButton(h, 'Save repeat'));
    await flushMicrotasks();
    const editor = control<HTMLElement>(h, '.abyss-recurrence-editor');
    await h.app.vault.modify(h.file, '\n- [ ] Current 📅 2026-09-23\n- [ ] Other edited\n');
    await flushMicrotasks(40);
    expect(editor.isConnected).toBe(false);
    expect(h.el.querySelector('.abyss-recurrence-editor')).not.toBeNull();
    held.release();
    await flushMicrotasks();

    expect(await h.read()).toBe('- [ ] Current 🔁 every day 📅 2026-09-23\n- [ ] Other edited\n');
    expect(h.el.querySelector('.abyss-recurrence-editor')).toBeNull();
    // A restore that records a new intent orphans the pending editor's resolver, which leaves focus on body.
    expectRebuiltFocus(chip, control(h, '.abyss-repeat-chip'));
  });

  it('returns focus to the rebuilt actions button after a rebuild restored the editor Edit repeat… opened', async () => {
    const h = await hosted('- [ ] Current 📅 2026-09-23\n- [ ] Other\n');
    const actions = control(h, '[aria-label="More actions"]');
    const held = holdNextWrite(h, { dropSaveFocus: true });

    activate(actions);
    const item = menuItem(h, 'Edit repeat…');
    item.focus();
    key(item, 'Enter');
    await flushMicrotasks();
    activate(editorButton(h, 'Daily'));
    const editor = control<HTMLElement>(h, '.abyss-recurrence-editor');
    await h.app.vault.modify(h.file, '\n- [ ] Current 📅 2026-09-23\n- [ ] Other edited\n');
    await flushMicrotasks(40);
    expect(editor.isConnected).toBe(false);
    expect(h.el.querySelector('.abyss-recurrence-editor')).not.toBeNull();
    activate(editorButton(h, 'Save repeat'));
    held.release();
    await flushMicrotasks();

    expect(await h.read()).toBe('- [ ] Current 🔁 every day 📅 2026-09-23\n- [ ] Other edited\n');
    // A restore that records its intent from the repeat chip sends focus to the chip instead of the ⋯ that opened the editor.
    expectRebuiltFocus(actions, control(h, '[aria-label="More actions"]'));
  });

  it('returns focus to the rebuilt actions button when a rebuild restores the editor during a pending Save opened from Edit repeat…', async () => {
    const h = await hosted('- [ ] Current 📅 2026-09-23\n- [ ] Other\n');
    const actions = control(h, '[aria-label="More actions"]');
    const held = holdNextWrite(h, { dropSaveFocus: true });

    activate(actions);
    const item = menuItem(h, 'Edit repeat…');
    item.focus();
    key(item, 'Enter');
    await flushMicrotasks();
    activate(editorButton(h, 'Daily'));
    activate(editorButton(h, 'Save repeat'));
    await flushMicrotasks();
    const editor = control<HTMLElement>(h, '.abyss-recurrence-editor');
    await h.app.vault.modify(h.file, '\n- [ ] Current 📅 2026-09-23\n- [ ] Other edited\n');
    await flushMicrotasks(40);
    expect(editor.isConnected).toBe(false);
    expect(h.el.querySelector('.abyss-recurrence-editor')).not.toBeNull();
    held.release();
    await flushMicrotasks();

    expect(await h.read()).toBe('- [ ] Current 🔁 every day 📅 2026-09-23\n- [ ] Other edited\n');
    // A restore that focuses its anchor would leave focus on the repeat chip instead of the ⋯ that opened the editor.
    expectRebuiltFocus(actions, control(h, '[aria-label="More actions"]'));
  });

  it('keeps focus where the user moved it when a rebuild restores an edited repeat editor', async () => {
    const h = await hosted('- [ ] Current 📅 2026-09-23\n- [ ] Other\n');
    const outside = activeDocument.body.createEl('button', { text: 'Outside' });

    activate(control(h, '.abyss-repeat-chip'));
    await flushMicrotasks();
    activate(editorButton(h, 'Daily'));
    const editor = control<HTMLElement>(h, '.abyss-recurrence-editor');
    outside.focus();
    await h.app.vault.modify(h.file, '\n- [ ] Current 📅 2026-09-23\n- [ ] Other edited\n');
    await flushMicrotasks(40);

    expect(editor.isConnected).toBe(false);
    expect(h.el.querySelector('.abyss-recurrence-editor')).not.toBeNull();
    // A restore that focuses its anchor would pull focus back to the repeat chip.
    expect(activeDocument.activeElement).toBe(outside);
  });

  it('returns focus to the rebuilt repeat chip when a save that a rebuild outlived fails', async () => {
    const h = await hosted('- [ ] Current 📅 2026-09-23\n- [ ] Other\n');
    const messages: string[] = [];
    notices(messages);
    const chip = control(h, '.abyss-repeat-chip');
    const held = holdNextWrite(h, {
      dropSaveFocus: true,
      outcome: { type: 'io-error', cause: 'test', contentState: 'unchanged' },
    });

    activate(chip);
    await flushMicrotasks();
    activate(editorButton(h, 'Daily'));
    activate(editorButton(h, 'Save repeat'));
    await flushMicrotasks();
    const editor = control<HTMLElement>(h, '.abyss-recurrence-editor');
    await h.app.vault.modify(h.file, '\n- [ ] Current 📅 2026-09-23\n- [ ] Other edited\n');
    await flushMicrotasks(40);
    expect(editor.isConnected).toBe(false);
    expect(h.el.querySelector('.abyss-recurrence-editor')).not.toBeNull();
    held.release();
    await flushMicrotasks();

    expect(messages).toEqual(['Failed to update task. Please try again.']);
    expect(await h.read()).toBe('- [ ] Current 📅 2026-09-23\n- [ ] Other edited\n');
    expect(h.el.querySelector('.abyss-recurrence-editor')).not.toBeNull();
    // A replaced editor that looks only for its own Save leaves the dropped focus on body.
    expectRebuiltFocus(chip, control(h, '.abyss-repeat-chip'));
  });

  it("moves no focus when a restored editor's save completes after another task is selected", async () => {
    const h = await hosted('- [ ] Current 📅 2026-09-23\n- [ ] Other\n');
    const outside = activeDocument.body.createEl('button', { text: 'Outside' });

    activate(control(h, '.abyss-repeat-chip'));
    await flushMicrotasks();
    activate(editorButton(h, 'Daily'));
    outside.focus();
    await h.app.vault.modify(h.file, '\n- [ ] Current 📅 2026-09-23\n- [ ] Other edited\n');
    await flushMicrotasks(40);
    expect(h.el.querySelector('.abyss-recurrence-editor')).not.toBeNull();
    expect(activeDocument.activeElement).toBe(outside);
    const held = holdNextWrite(h, { dropSaveFocus: true });
    activate(editorButton(h, 'Save repeat'));
    await flushMicrotasks();
    expect(activeDocument.activeElement).toBe(activeDocument.body);
    const other = h.node('Other edited');
    h.state.set('taskStack', [other.root, ...other.path]);
    held.release();
    await flushMicrotasks();

    expect(await h.read()).toBe('- [ ] Current 🔁 every day 📅 2026-09-23\n- [ ] Other edited\n');
    expect(selectedTitle(h)).toBe('Other edited');
    // An editor restored while focus was elsewhere would fall back to that element after its intent ended.
    expect(activeDocument.activeElement).toBe(activeDocument.body);
  });

  it('returns focus to the rebuilt actions button on Escape after a rebuild restored the editor Edit repeat… opened', async () => {
    const h = await hosted('- [ ] Current 📅 2026-09-23\n- [ ] Other\n');
    const actions = control(h, '[aria-label="More actions"]');

    activate(actions);
    const item = menuItem(h, 'Edit repeat…');
    item.focus();
    key(item, 'Enter');
    await flushMicrotasks();
    activate(editorButton(h, 'Daily'));
    const editor = control<HTMLElement>(h, '.abyss-recurrence-editor');
    await h.app.vault.modify(h.file, '\n- [ ] Current 📅 2026-09-23\n- [ ] Other edited\n');
    await flushMicrotasks(40);
    expect(editor.isConnected).toBe(false);
    const daily = editorButton(h, 'Daily');
    expect(activeDocument.activeElement).toBe(daily);
    key(daily, 'Escape');

    expect(h.el.querySelector('.abyss-recurrence-editor')).toBeNull();
    // A restore anchored on the repeat chip would send Escape's focus to the chip.
    expectRebuiltFocus(actions, control(h, '[aria-label="More actions"]'));
  });

  it('returns focus to the rebuilt actions button after a submit from inside an editor restored from Edit repeat…', async () => {
    const h = await hosted('- [ ] Current 📅 2026-09-23\n- [ ] Other\n');
    const actions = control(h, '[aria-label="More actions"]');

    activate(actions);
    const item = menuItem(h, 'Edit repeat…');
    item.focus();
    key(item, 'Enter');
    await flushMicrotasks();
    activate(editorButton(h, 'Daily'));
    const editor = control<HTMLElement>(h, '.abyss-recurrence-editor');
    await h.app.vault.modify(h.file, '\n- [ ] Current 📅 2026-09-23\n- [ ] Other edited\n');
    await flushMicrotasks(40);
    expect(editor.isConnected).toBe(false);
    expect(h.el.querySelector('.abyss-recurrence-editor')).not.toBeNull();
    const interval = control<HTMLInputElement>(
      h,
      '.abyss-recurrence-editor [aria-label="Repeat interval"]',
    );
    interval.focus();
    key(interval, 'Enter');
    await flushMicrotasks();

    expect(await h.read()).toBe('- [ ] Current 🔁 every day 📅 2026-09-23\n- [ ] Other edited\n');
    // A restore anchored on the repeat chip maps a focus inside the editor to the chip.
    expectRebuiltFocus(actions, control(h, '[aria-label="More actions"]'));
  });
});

describe('recurrence draft recovery boundary', () => {
  it('forwards a recurrence submission to the current retained panel method', async () => {
    const h = await hosted('- [ ] Current 📅 2026-09-23\n');
    const initiating = h.state.get('taskStack')[0];
    const submit = vi
      .fn<(typeof h.panel)['executePlanningPatch_abyssPrivate']>()
      .mockResolvedValue({
        type: 'io-error',
        cause: 'test',
        contentState: 'unchanged',
      });
    h.panel['executePlanningPatch_abyssPrivate'] = submit;
    activate(control(h, '.abyss-repeat-chip'));
    await flushMicrotasks();
    activate(editorButton(h, 'Daily'));
    activate(editorButton(h, 'Save repeat'));
    await flushMicrotasks();
    expect(submit).toHaveBeenCalledWith(initiating, {
      recurrence: { type: 'set', value: 'every day' },
    });
    expect(await h.read()).toBe('- [ ] Current 📅 2026-09-23\n');
  });
  it('preserves a dirty recurrence draft in the detached tray when no rebuilt anchor exists', async () => {
    const h = await hosted('- [ ] Current\n');
    activate(control(h, '.abyss-repeat-chip'));
    await flushMicrotasks();
    activate(editorButton(h, 'Daily'));
    const bundle = expectDefined(h.panel.captureDraftState(), 'Missing recurrence draft');
    h.panel['planningSurfaces_abyssPrivate'].clearAnchoredSurfaces();
    h.panel['planningSurfaces_abyssPrivate'].resetRenderedControls();

    h.panel.restoreDraftState(bundle, h.node('Current').root);

    expect(h.el.querySelector('.abyss-detached-draft')).not.toBeNull();
    expect(h.el.querySelector('.abyss-detached-draft-label')?.textContent).toContain(
      'recurrence editor',
    );
    expect(await h.read()).toBe('- [ ] Current\n');
  });

  it('does not detach a dirty recurrence draft when its anchor exists but restoration returns no focus', async () => {
    const h = await hosted('- [ ] Current\n');
    activate(control(h, '.abyss-repeat-chip'));
    await flushMicrotasks();
    activate(editorButton(h, 'Daily'));
    const outside = activeDocument.body.createEl('button', { text: 'Outside' });
    outside.focus();
    const bundle = expectDefined(h.panel.captureDraftState(), 'Missing recurrence draft');
    expect(bundle.entries[0]?.hadFocus).toBe(false);
    h.panel['planningSurfaces_abyssPrivate'].clearAnchoredSurfaces();
    outside.focus();

    h.panel.restoreDraftState(bundle, h.node('Current').root);

    expect(h.el.querySelector('.abyss-recurrence-editor')).not.toBeNull();
    expect(h.el.querySelector('.abyss-detached-draft')).toBeNull();
    expect(activeDocument.activeElement).toBe(outside);
    expect(await h.read()).toBe('- [ ] Current\n');
  });
});

describe('inspector write outcomes', () => {
  it('presents a refused concurrent priority change and restores the label from before it', async () => {
    const h = await hosted('- [ ] Current\n');
    const messages: string[] = [];
    notices(messages);
    const held = holdNextWrite(h);

    activate(control(h, '.abyss-priority-chip'));
    activate(control(h, '.abyss-priority-option[data-priority="A"]'));
    activate(control(h, '.abyss-priority-chip'));
    activate(control(h, '.abyss-priority-option[data-priority="C"]'));
    await flushMicrotasks();

    const chip = control(h, '.abyss-priority-chip');
    expect(messages).toEqual([PENDING_EDIT_NOTICE]);
    // Keeping the optimistic label would show Medium, a priority that is never written.
    expect(chip.textContent).toBe('🚩 Highest');
    expect(chip.getAttribute('data-priority')).toBe('A');
    expect(held.spy).toHaveBeenCalledOnce();

    held.release();
    await flushMicrotasks();
    expect(await h.read()).toBe('- [ ] Current 🔺\n');
  });

  it('presents a refused dependency sub-task', async () => {
    const h = await hosted('- [ ] Current\n');
    const messages: string[] = [];
    notices(messages);
    const held = holdNextWrite(h);
    activate(control(h, '.abyss-priority-chip'));
    activate(control(h, '.abyss-priority-option[data-priority="A"]'));

    activate(control(h, '.abyss-dep-badge-body'));
    const input = control<HTMLInputElement>(h, '.abyss-dep-search input');
    input.value = 'Blocker';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await searchUiCompleted(control(h, '.abyss-dep-search'));
    activate(control(h, '.abyss-dep-search-create'));
    await flushMicrotasks();

    expect(messages).toEqual([PENDING_EDIT_NOTICE]);
    expect(held.spy).toHaveBeenCalledOnce();
    // A refusal answered as a validation error would show an inline error instead.
    expect(control<HTMLElement>(h, '.abyss-dep-search-error').hidden).toBe(true);
    expect(input.value).toBe('Blocker');
    expect(input.readOnly).toBe(false);

    held.release();
    await flushMicrotasks();
    expect(await h.read()).toBe('- [ ] Current 🔺\n');
  });

  it('presents a refused description save and keeps its text', async () => {
    const h = await hosted('- [ ] Current\n');
    const messages: string[] = [];
    notices(messages);
    const held = holdNextWrite(h);
    activate(control(h, '.abyss-priority-chip'));
    activate(control(h, '.abyss-priority-option[data-priority="A"]'));

    control<HTMLElement>(h, '.abyss-right-desc-view').click();
    await flushMicrotasks();
    const textarea = control<HTMLTextAreaElement>(h, '.abyss-right-desc-edit');
    // The editor focuses its textarea on the next task; the blur below is real only then.
    expect(activeDocument.activeElement).toBe(textarea);
    textarea.value = 'Refused text';
    // The module afterEach empties the body, which removes this button as well.
    activeDocument.body.createEl('button', { text: 'Outside' }).focus();
    await flushMicrotasks();

    expect(messages).toEqual([PENDING_EDIT_NOTICE]);
    expect(held.spy).toHaveBeenCalledOnce();
    expect(control<HTMLTextAreaElement>(h, '.abyss-right-desc-edit')).toBe(textarea);
    expect(textarea.value).toBe('Refused text');

    held.release();
    await flushMicrotasks();
    expect(await h.read()).toBe('- [ ] Current 🔺\n');
  });

  it('shows the recorded priority again when the change fails', async () => {
    const h = await hosted('- [ ] Current\n');
    const messages: string[] = [];
    notices(messages);
    vi.spyOn(h.api, 'execute').mockResolvedValueOnce({
      type: 'io-error',
      cause: 'test',
      contentState: 'unchanged',
    });
    const chip = control(h, '.abyss-priority-chip');

    activate(chip);
    activate(control(h, '.abyss-priority-option[data-priority="A"]'));
    await flushMicrotasks();

    expect(messages).toEqual(['Failed to update task. Please try again.']);
    expect(await h.read()).toBe('- [ ] Current\n');
    expect(chip.textContent).toBe('Priority');
    expect(chip.getAttribute('data-priority')).toBe('D');
    expect(chip.classList.contains('abyss-chip-empty')).toBe(true);
    expect(activeDocument.activeElement).toBe(chip);
  });

  it('re-marks a priority popover reopened during a change that fails', async () => {
    addIcon('check', '<path d="M20 6 9 17l-5-5" />');
    inspectorCleanups.push(() => {
      removeIcon('check');
    });
    const h = await hosted('- [ ] Current\n');
    const messages: string[] = [];
    notices(messages);
    const held = holdNextWrite(h, {
      outcome: { type: 'io-error', cause: 'test', contentState: 'unchanged' },
    });
    const chip = control(h, '.abyss-priority-chip');

    activate(chip);
    activate(control(h, '.abyss-priority-option[data-priority="A"]'));
    activate(chip);
    const highest = control(h, '.abyss-priority-option[data-priority="A"]');
    expect([
      highest.classList.contains('is-active'),
      highest.getAttribute('aria-selected'),
    ]).toEqual([true, 'true']);
    held.release();
    await flushMicrotasks();

    const none = control(h, '.abyss-priority-option[data-priority="D"]');
    expect(messages).toEqual(['Failed to update task. Please try again.']);
    expect(chip.textContent).toBe('Priority');
    expect(chip.getAttribute('data-priority')).toBe('D');
    // A rollback that updates only the chip leaves the open popover marking Highest.
    expect(none.classList.contains('is-active')).toBe(true);
    expect(none.getAttribute('aria-selected')).toBe('true');
    expect(none.querySelector('.abyss-priority-option-check svg.check')).not.toBeNull();
    expect(highest.classList.contains('is-active')).toBe(false);
    expect(highest.getAttribute('aria-selected')).toBe('false');
    expect(highest.querySelector('.abyss-priority-option-check')?.childElementCount).toBe(0);
    expect(activeDocument.activeElement).toBe(highest);
  });

  it('rolls a failed change back to the priority shown at its click, not at the popover opening', async () => {
    const h = await hosted('- [ ] Current\n');
    const messages: string[] = [];
    notices(messages);
    const gate = deferred<void>();
    const failure: TaskCommandResult = {
      type: 'io-error',
      cause: 'test',
      contentState: 'unchanged',
    };
    vi.spyOn(h.api, 'execute')
      .mockImplementationOnce(async () => {
        await gate.promise;
        return failure;
      })
      .mockResolvedValueOnce(failure);
    const chip = control(h, '.abyss-priority-chip');

    activate(chip);
    activate(control(h, '.abyss-priority-option[data-priority="A"]'));
    activate(chip);
    gate.resolve();
    await flushMicrotasks();
    expect(chip.textContent).toBe('Priority');
    activate(control(h, '.abyss-priority-option[data-priority="C"]'));
    await flushMicrotasks();

    expect(messages).toEqual([
      'Failed to update task. Please try again.',
      'Failed to update task. Please try again.',
    ]);
    expect(await h.read()).toBe('- [ ] Current\n');
    // Recording the priority when the popover opened would show Highest, which was never written.
    expect(chip.textContent).toBe('Priority');
    expect(chip.getAttribute('data-priority')).toBe('D');
  });

  it('writes a typed time once when focus leaves during its Enter write', async () => {
    const h = await hosted('- [ ] Current\n');
    const messages: string[] = [];
    notices(messages);
    const held = holdNextWrite(h);

    activate(control(h, '.abyss-chip-time'));
    await flushMicrotasks();
    const input = control<HTMLInputElement>(h, '.abyss-time-popover .abyss-time-input');
    key(input, '1');
    change(input, '10:45');
    key(input, 'Enter');
    activeDocument.body.createEl('button', { text: 'Outside' }).focus();
    await flushMicrotasks();

    // Dropping the written flag would submit the departure too, which the pending write refuses with a Notice.
    expect(messages).toEqual([]);
    expect(held.spy).toHaveBeenCalledOnce();

    held.release();
    await flushMicrotasks();
    expect(await h.read()).toBe('- [ ] Current ⏰ 10:45\n');
  });
});
