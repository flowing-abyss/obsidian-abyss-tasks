import { Menu, type MenuItem } from 'obsidian';
import { sameTag } from '../markdown/tagSyntax';
import { moment } from '../obsidianMoment';
import { PRIORITY_LEVELS } from '../priority';
import type { PropertyFilter } from '../settings/types';
import type { StatusRegistry } from '../status/StatusRegistry';
import {
  localDate,
  shiftLocalDate,
  subtreeRunning,
  type LocalDate,
  type TaskNodeRef,
  type TaskPriority,
} from '../tasks';
import { runAsyncAction } from './runAsyncAction';
import { buildStatusSubmenu } from './statusMenu';
import type { TaskSelectionNode } from './taskSelection';
import type { TrackingSurface } from './timeTracking/TimeBadge';

interface TaskContextMenuOptions {
  readonly node: TaskSelectionNode;
  readonly target: TaskNodeRef | undefined;
  readonly anchor: HTMLElement;
  readonly statusRegistry: StatusRegistry;
  readonly pinnedTags: readonly string[];
  readonly timeTracking?: TrackingSurface | undefined;
  readonly filters?: {
    readonly representedTags: readonly string[];
    readonly addFilter: (filter: PropertyFilter) => void;
  };
  readonly actions: {
    readonly toggleDue: (date: LocalDate) => Promise<unknown>;
    readonly patchTags: (add: readonly string[], remove: readonly string[]) => Promise<unknown>;
    readonly setStatus: (symbol: string) => Promise<unknown>;
    readonly setPriority: (priority: TaskPriority) => Promise<unknown>;
    readonly openDatePicker: (anchor: HTMLElement) => void;
    readonly openTagPicker: () => void;
    readonly openRecurrenceEditor: (anchor: HTMLElement) => void;
    readonly openInNote: () => void;
    readonly promote: () => Promise<unknown>;
    readonly archive: () => Promise<unknown>;
    readonly delete: () => Promise<unknown>;
  };
}

/**
 * Colors a priority-submenu flag icon to match the rest of the UI (status
 * popover flags, flag settings, etc.) by tagging the item's undocumented
 * `.dom` element — Obsidian doesn't expose per-item icon styling otherwise.
 */
export function applyPriorityFlagColor(si: MenuItem, value: TaskPriority): void {
  const dom = (si as unknown as { dom?: HTMLElement }).dom;
  if (dom != null) {
    dom.addClass('abyss-menu-priority-flag');
    dom.setAttribute('data-abyss-priority', value);
  }
}

/** Obsidian's MenuItem.setSubmenu() is undocumented; reach it via one shared cast. */
export function getSubmenu(item: MenuItem): Menu {
  return (item as unknown as { setSubmenu(): Menu }).setSubmenu();
}

/** Obsidian orders sections by their first item; registration order is menu group order. */
export function createTaskContextMenu(options: TaskContextMenuOptions): Menu {
  const { node: task, target, actions, filters } = options;
  const menu = new Menu();
  addDuePresetMenuItems(menu, options);
  addTrackingMenuItem(menu, options);
  addPinnedTagMenuItems(menu, options);
  addEditMenuItems(menu, options);
  addPropertyMenuItems(menu, options);
  addTagFilterMenuItems(menu, [...task.tags, ...(filters?.representedTags ?? [])], filters);

  menu.addItem((item) =>
    item
      .setTitle('Open in note')
      .setIcon('file-text')
      .setSection('open')
      .onClick(() => {
        actions.openInNote();
      }),
  );

  if (target?.type === 'subtask')
    menu.addItem((item) =>
      item
        .setTitle('Make independent task')
        .setIcon('list-plus')
        .setSection('danger')
        .onClick(() => {
          runAsyncAction(actions.promote());
        }),
    );
  menu.addItem((item) =>
    item
      .setTitle('Archive')
      .setDisabled(target?.type !== 'task')
      .setIcon('archive')
      .setSection('danger')
      .onClick(() => {
        runAsyncAction(actions.archive());
      }),
  );

  menu.addItem((item) =>
    item
      .setTitle('Delete')
      .setIcon('trash-2')
      .setSection('danger')
      .onClick(() => {
        runAsyncAction(actions.delete());
      }),
  );

  return menu;
}

function addDuePresetMenuItems(menu: Menu, options: TaskContextMenuOptions): void {
  const { node: task, actions } = options;
  const today = localDate(moment().format('YYYY-MM-DD'));
  const tomorrow = shiftLocalDate(today, 1);
  menu.addItem((item) =>
    item
      .setTitle('Today')
      .setIcon('calendar')
      .setSection('today')
      .setChecked(task.planning.due === today)
      .onClick(() => {
        runAsyncAction(actions.toggleDue(today));
      }),
  );

  if (tomorrow !== undefined) {
    menu.addItem((item) =>
      item
        .setTitle('Tomorrow')
        .setIcon('calendar-plus')
        .setSection('today')
        .setChecked(task.planning.due === tomorrow)
        .onClick(() => {
          runAsyncAction(actions.toggleDue(tomorrow));
        }),
    );
  }
}

function addPinnedTagMenuItems(menu: Menu, options: TaskContextMenuOptions): void {
  const { node: task, actions } = options;
  for (const pinnedTag of options.pinnedTags) {
    const hasTag = task.tags.some((tag) => sameTag(tag, pinnedTag));
    menu.addItem((item) =>
      item
        .setTitle(pinnedTag)
        .setIcon('tag')
        .setSection('tags')
        .setChecked(hasTag)
        .onClick(() => {
          runAsyncAction(actions.patchTags(hasTag ? [] : [pinnedTag], hasTag ? [pinnedTag] : []));
        }),
    );
  }
}

function addEditMenuItems(menu: Menu, options: TaskContextMenuOptions): void {
  const { anchor: card, actions } = options;
  menu.addItem((item) =>
    item
      .setTitle('Set date…')
      .setIcon('calendar-cog')
      .setSection('edit')
      .onClick(() => {
        actions.openDatePicker(card);
      }),
  );

  menu.addItem((item) =>
    item
      .setTitle('Set tag…')
      .setIcon('hash')
      .setSection('edit')
      .onClick(() => {
        actions.openTagPicker();
      }),
  );

  menu.addItem((item) => {
    item
      .setTitle('Edit repeat…')
      .setIcon('repeat-2')
      .setSection('edit')
      .onClick(() => {
        actions.openRecurrenceEditor(card);
      });
  });
}

function addPropertyMenuItems(menu: Menu, options: TaskContextMenuOptions): void {
  const { node: task, actions, filters } = options;
  menu.addItem((item) => {
    item.setTitle('Priority').setIcon('arrow-up-narrow-wide').setSection('priority');
    const sub = getSubmenu(item);
    for (const level of PRIORITY_LEVELS) {
      sub.addItem((si) => {
        si.setTitle(level.label)
          .setIcon('flag')
          .setChecked(task.priority === level.value)
          .onClick(() => {
            runAsyncAction(actions.setPriority(level.value));
          });
        applyPriorityFlagColor(si, level.value);
      });
    }
  });

  menu.addItem((item) => {
    item.setIcon('check-square').setSection('priority');
    item.setTitle('Status');
    buildStatusSubmenu(getSubmenu(item), task, options.statusRegistry, (c) => {
      runAsyncAction(actions.setStatus(c));
    });
  });

  if (filters !== undefined) {
    menu.addItem((item) =>
      item
        .setTitle('Filter by this priority')
        .setIcon('filter')
        .setSection('priority')
        .onClick(() => {
          filters.addFilter({ type: 'priority', value: task.priority });
        }),
    );

    menu.addItem((item) =>
      item
        .setTitle('Filter by this status')
        .setIcon('filter')
        .setSection('priority')
        .onClick(() => {
          filters.addFilter({ type: 'status', value: task.statusSymbol });
        }),
    );
  }
}

function addTrackingMenuItem(menu: Menu, options: TaskContextMenuOptions): void {
  const task = options.node;
  const tracking = options.timeTracking;
  const target = options.target;
  if (tracking === undefined || target === undefined) return;
  const running = subtreeRunning(task);
  if (!running && (task.status === 'done' || task.status === 'cancelled')) return;
  menu.addItem((item) =>
    item
      .setTitle(running ? 'Pause tracking' : 'Start tracking')
      .setIcon(running ? 'pause' : 'play')
      .setSection('tracking')
      .onClick(() => {
        runAsyncAction(
          running ? tracking.actions.pause() : tracking.actions.start(target),
          'Could not change time tracking',
        );
      }),
  );
}

function addTagFilterMenuItems(
  menu: Menu,
  choices: readonly string[],
  filters: TaskContextMenuOptions['filters'],
): void {
  if (filters === undefined) return;
  const tags: string[] = [];
  for (const choice of choices) if (!tags.some((tag) => sameTag(tag, choice))) tags.push(choice);
  if (tags.length === 0) return;
  for (const type of ['tag', 'tag-exclude'] as const) {
    menu.addItem((item) => {
      item
        .setTitle(type === 'tag' ? 'Include tag' : 'Exclude tag')
        .setIcon('filter')
        .setSection('priority');
      const add = (value: string): void => {
        filters.addFilter({ type, value });
      };
      const tag = tags[0];
      if (tags.length === 1 && tag !== undefined)
        item.onClick(() => {
          add(tag);
        });
      else {
        const choices = getSubmenu(item);
        for (const value of tags)
          choices.addItem((choice) =>
            choice
              .setTitle(value)
              .setIcon('tag')
              .onClick(() => {
                add(value);
              }),
          );
      }
    });
  }
}
