import { App } from 'obsidian';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { localDate, type CalendarTaskSource, type TaskCommandResult } from '../src/tasks';
import { showDatePickerPopover } from '../src/ui/DatePickerPopover';
import { InteractionRegistry } from '../src/ui/interactionOwnership';
import { LinkEditModal } from '../src/ui/LinkEditModal';
import { mountAnchoredRecurrenceEditor } from '../src/ui/recurrence/RecurrenceEditor';
import { showStatusMenuAt } from '../src/ui/statusMenu';
import { TagPickerModal } from '../src/ui/TagPickerModal';
import { TaskModal } from '../src/ui/TaskModal';
import type { CalendarOccurrence } from '../src/views/calendarOccurrences';
import { createForecastContextMenuOwner } from '../src/views/timegrid/renderTaskMeta';
import { task, testStatusRegistry } from './helpers';

interface OwnedSurface {
  readonly control: HTMLElement;
  close(): void;
}

const categories: ReadonlyArray<{
  readonly category: string;
  open(registry: InteractionRegistry<'navigate'>): OwnedSurface;
}> = [
  {
    category: 'custom status menu',
    open: (registry) => {
      const handle = showStatusMenuAt(new MouseEvent('contextmenu'), {
        task: task(),
        registry: testStatusRegistry(),
        onPickStatus: () => {},
        onPickPriority: () => {},
        interactionOwnership: registry,
      });
      return {
        control: handle.element.querySelector<HTMLElement>('.abyss-status-popover-flag')!,
        close: () => handle.close(),
      };
    },
  },
  {
    category: 'date picker popover',
    open: (registry) => {
      const owner = activeDocument.body.createDiv();
      const anchor = owner.createEl('button', { text: 'Pick date' });
      const cleanup = showDatePickerPopover({
        owner,
        anchor,
        boundary: owner,
        onPick: () => {},
        interactionOwnership: registry,
      });
      return {
        control: anchor,
        close: () => {
          cleanup();
          owner.remove();
        },
      };
    },
  },
  {
    category: 'anchored recurrence editor',
    open: (registry) => {
      const anchor = activeDocument.body.createEl('button', { text: 'Repeat' });
      const root = task({ recurrence: 'every day' });
      const handle = mountAnchoredRecurrenceEditor({
        anchor,
        source: { root, target: { type: 'task', ref: root.ref } },
        policy: { removeScheduledDate: false },
        ownershipConflict: false,
        onSubmit: async (): Promise<TaskCommandResult> => ({
          type: 'invalid',
          issues: [{ code: 'invalid-target' }],
        }),
        interactionOwnership: registry,
      });
      return {
        control: activeDocument.querySelector<HTMLElement>('.abyss-recurrence-presets button')!,
        close: () => {
          handle.destroy();
          anchor.remove();
        },
      };
    },
  },
  {
    category: 'plugin-owned tag modal',
    open: (registry) => {
      const app = new App();
      (app.metadataCache as unknown as { getTags(): Record<string, number> }).getTags = () => ({
        '#owned': 1,
      });
      const modal = new TagPickerModal(
        app,
        () => undefined,
        new Set(),
        new Set(),
        vi.fn(),
        registry,
      );
      activeDocument.body.append(modal.containerEl);
      modal.onOpen();
      return {
        control: modal.contentEl.querySelector<HTMLElement>('[data-tag="#owned"]')!,
        close: () => {
          modal.onClose();
          modal.containerEl.remove();
        },
      };
    },
  },
  {
    category: 'plugin-owned task modal',
    open: (registry) => {
      const modal = new TaskModal(
        new App(),
        testStatusRegistry(),
        undefined,
        undefined,
        undefined,
        undefined,
        registry,
      );
      modal.open(task());
      return {
        control: activeDocument.querySelector<HTMLElement>('.abyss-modal-close-btn')!,
        close: () => modal.close(),
      };
    },
  },
  {
    category: 'plugin-owned link modal',
    open: (registry) => {
      const modal = new LinkEditModal(
        new App(),
        {
          raw: '[Old](https://example.com)',
          type: 'md',
          target: 'https://example.com',
          display: 'Old',
          index: 0,
        },
        vi.fn(),
        '',
        registry,
      );
      activeDocument.body.append(modal.containerEl);
      modal.onOpen();
      return {
        control: Array.from(modal.contentEl.querySelectorAll<HTMLElement>('button')).find(
          (button) => button.textContent === 'Save',
        )!,
        close: () => {
          modal.onClose();
          modal.containerEl.remove();
        },
      };
    },
  },
  {
    category: 'forecast context menu',
    open: (registry) => {
      const anchor = activeDocument.body.createEl('button', { text: 'Forecast' });
      const root = task({ recurrence: 'every day', planning: { due: '2026-08-08' } });
      const source: CalendarTaskSource = {
        root,
        node: root,
        target: { type: 'task', ref: root.ref },
      };
      const occurrence: Extract<CalendarOccurrence, { readonly kind: 'forecast' }> = {
        kind: 'forecast',
        key: 'owned-forecast',
        source,
        planning: { due: localDate('2026-08-09') },
        referenceDate: localDate('2026-08-09'),
        ordinal: 1,
      };
      const owner = createForecastContextMenuOwner(activeDocument, registry);
      owner.open(anchor, new MouseEvent('contextmenu'), occurrence, {});
      return {
        control: activeDocument.querySelector<HTMLElement>(
          '.abyss-forecast-context-menu-edit-repeat',
        )!,
        close: () => {
          owner.dismiss({ restoreFocus: false });
          anchor.remove();
        },
      };
    },
  },
];

afterEach(() => {
  vi.useRealTimers();
  activeDocument.body.empty();
});

describe('PanelView interaction ownership categories', () => {
  it.each(categories)(
    'blocks semantic navigation from a non-editable control in the $category',
    ({ open }) => {
      const registry = new InteractionRegistry<'navigate'>();
      const semanticNavigator = vi.fn();
      const onKeydown = (event: KeyboardEvent): void => {
        if (event.key === 'n' && registry.allows('navigate')) semanticNavigator();
      };
      activeDocument.addEventListener('keydown', onKeydown);
      const surface = open(registry);

      try {
        surface.control.focus();
        surface.control.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', bubbles: true }));
        expect(semanticNavigator).not.toHaveBeenCalled();

        surface.close();
        activeDocument.body.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'n', bubbles: true }),
        );
        expect(semanticNavigator).toHaveBeenCalledOnce();
      } finally {
        activeDocument.removeEventListener('keydown', onKeydown);
        surface.close();
        registry.destroy();
      }
    },
  );
});
