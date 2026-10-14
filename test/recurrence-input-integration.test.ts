import { afterEach, expect, it, vi } from 'vitest';
import { CenterPanel } from '../src/panels/CenterPanel';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import { StatusRegistry } from '../src/status/StatusRegistry';
import { RecurrenceTextInputParser } from '../src/tasks/infrastructure/input/RecurrenceTextInputParser';
import { TaskModal } from '../src/ui/TaskModal';
import { expectDefined, useRealMoment } from './helpers';
import { inspectorCleanups, inspectorHarness } from './support/inspectorHarness';
useRealMoment();
afterEach(() => {
  for (const cleanup of inspectorCleanups.splice(0)) cleanup();
  activeDocument.body.empty();
  vi.restoreAllMocks();
});
function button(root: ParentNode, label: string): HTMLButtonElement {
  return expectDefined(
    [...root.querySelectorAll<HTMLButtonElement>('button')].find(
      (candidate) => candidate.textContent.trim() === label,
    ),
  );
}
function translatedPreview(root: ParentNode): void {
  button(root, 'Custom').click();
  const input = expectDefined(root.querySelector<HTMLInputElement>('.abyss-recurrence-raw'));
  input.value = 'каждые 3 дня после выполнения';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  expect(root.querySelector('.abyss-recurrence-preview-rule')?.textContent).toBe(
    'every 3 days when done',
  );
  expect(button(root, 'Save repeat').disabled).toBe(false);
}
it.each(['Current', 'Child'])(
  'injects the parser through root/subtask inspector and saves English Markdown: %s',
  async (selected) => {
    const h = await inspectorHarness(
      '- [ ] Current 📅 2026-08-09\n  - [ ] Child 📅 2026-08-09',
      selected,
      {},
      DEFAULT_SETTINGS,
      new RecurrenceTextInputParser(),
    );
    expectDefined(h.el.querySelector<HTMLButtonElement>('.abyss-repeat-chip')).click();
    translatedPreview(h.el);
    button(h.el, 'Save repeat').click();
    await vi.waitFor(async () => {
      expect(await h.read()).toContain(`${selected} 🔁 every 3 days when done 📅 2026-08-09`);
    });
  },
);
it('uses canonical labels in the inspector while preserving invalid authored rules', async () => {
  const h = await inspectorHarness(
    '- [ ] Current 📅 2026-08-09 🔁 every month on the first Monday',
  );
  expect(h.el.querySelector('.abyss-repeat-chip-label')?.textContent).toBe(
    'every month on the 1st Monday',
  );
  const invalid = await inspectorHarness('- [ ] Current 📅 2026-08-09 🔁 tomorrow');
  expect(invalid.el.querySelector('.abyss-repeat-chip-label')?.textContent).toBe('tomorrow');
});
it.each(['Current', 'Child'])(
  'injects the parser through the modal inspector: %s',
  async (selected) => {
    const recurrenceInput = new RecurrenceTextInputParser();
    const h = await inspectorHarness('- [ ] Current 📅 2026-08-09\n  - [ ] Child 📅 2026-08-09');
    const modal = new TaskModal({
      app: h.app,
      statusRegistry: new StatusRegistry(DEFAULT_SETTINGS.taskStatuses),
      settings: DEFAULT_SETTINGS,
      tasks: h.api,
      queries: h.index,
      recurrenceInput,
    });
    inspectorCleanups.unshift(() => {
      modal.close();
    });
    const node = h.node(selected);
    const target = node.path[node.path.length - 1];
    modal.open(
      node.root,
      undefined,
      target === undefined ? undefined : { type: 'subtask', ref: target.ref },
    );
    const root = expectDefined(activeDocument.querySelector<HTMLElement>('.abyss-modal'));
    expectDefined(root.querySelector<HTMLButtonElement>('.abyss-repeat-chip')).click();
    translatedPreview(root);
  },
);
it.each(['task-menu', 'calendar-source'] as const)(
  'injects the parser through the central anchored editor: %s',
  async (entry) => {
    const recurrenceInput = new RecurrenceTextInputParser();
    const h = await inspectorHarness('- [ ] Current 📅 2026-08-09');
    const panel = new CenterPanel({
      state: h.state,
      app: h.app,
      settings: DEFAULT_SETTINGS,
      statusRegistry: new StatusRegistry(DEFAULT_SETTINGS.taskStatuses),
      tasks: h.api,
      queries: h.index,
      recurrenceInput,
    });
    inspectorCleanups.unshift(() => {
      panel.destroy();
    });
    const anchor = activeDocument.body.createEl('button');
    const root = h.node('Current').root;
    const methods = panel as unknown as {
      openRecurrenceEditor_abyssPrivate(anchor: HTMLElement, task: typeof root): void;
      openForecastRecurrenceEditor_abyssPrivate(
        anchor: HTMLElement,
        source: { root: typeof root; target: { type: 'task'; ref: typeof root.ref } },
      ): void;
    };
    if (entry === 'task-menu') methods.openRecurrenceEditor_abyssPrivate(anchor, root);
    else
      methods.openForecastRecurrenceEditor_abyssPrivate(anchor, {
        root,
        target: { type: 'task', ref: root.ref },
      });
    translatedPreview(
      expectDefined(activeDocument.querySelector<HTMLElement>('.abyss-recurrence-popover')),
    );
  },
);
