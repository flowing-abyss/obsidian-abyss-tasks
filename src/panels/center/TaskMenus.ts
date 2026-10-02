import { Menu, type App, type MenuItem } from 'obsidian';
import { sameTag } from '../../markdown/tagSyntax';
import { moment } from '../../obsidianMoment';
import { PRIORITY_LEVELS } from '../../priority';
import type { CalendarSettings, PropertyFilter } from '../../settings/types';
import type { StatusRegistry } from '../../status/StatusRegistry';
import type { EffectiveTagGroup } from '../../tags/effectiveTagGroups';
import { collectTaskTags } from '../../tags/taskTagCatalog';
import {
  localDate,
  shiftLocalDate,
  subtreeRunning,
  type LocalDate,
  type TaskNodeSnapshot,
  type TaskPriority,
  type TaskSnapshot,
} from '../../tasks';
import { TagPickerModal } from '../../ui/TagPickerModal';
import type { InteractionOwnershipPort } from '../../ui/interactionOwnership';
import { runAsyncAction } from '../../ui/runAsyncAction';
import { buildStatusSubmenu } from '../../ui/statusMenu';
import { openInFile } from '../../ui/taskNavigation';
import type { TrackingSurface } from '../../ui/timeTracking/TimeBadge';
import { calendarMutationTarget } from '../../views/calendarOccurrences';
import type { TaskCommands } from './TaskCommands';

interface TaskMenusHost {
  showTaskMenu(menu: Menu, event: MouseEvent, card: HTMLElement): void;
  applyBulkDuePreset(card: HTMLElement, tasks: readonly TaskSnapshot[], value: LocalDate): void;
  openDatePicker(anchor: HTMLElement, tasks: readonly TaskSnapshot[]): void;
  openRecurrenceEditor(anchor: HTMLElement, task: TaskSnapshot): void;
  addFilter(filter: PropertyFilter): void;
  tagCatalog(): {
    readonly nodes: readonly TaskNodeSnapshot[];
    readonly groups: readonly EffectiveTagGroup[];
  };
  tagColor(tag: string, groups: readonly EffectiveTagGroup[]): string | undefined;
}

interface TaskMenusOptions {
  readonly app: App;
  readonly settings: CalendarSettings;
  readonly statusRegistry: StatusRegistry;
  readonly interactionOwnership: InteractionOwnershipPort;
  readonly timeTracking?: TrackingSurface | undefined;
  readonly commands: TaskCommands;
  readonly host: TaskMenusHost;
}

/**
 * Colors a priority-submenu flag icon to match the rest of the UI (status
 * popover flags, flag settings, etc.) by tagging the item's undocumented
 * `.dom` element — Obsidian doesn't expose per-item icon styling otherwise.
 */
function applyPriorityFlagColor(si: MenuItem, value: TaskPriority): void {
  const dom = (si as unknown as { dom?: HTMLElement }).dom;
  if (dom != null) {
    dom.addClass('abyss-menu-priority-flag');
    dom.setAttribute('data-abyss-priority', value);
  }
}

/** Obsidian's MenuItem.setSubmenu() is undocumented; reach it via one shared cast. */
function getSubmenu(item: MenuItem): Menu {
  return (item as unknown as { setSubmenu(): Menu }).setSubmenu();
}

export class TaskMenus {
  readonly #options: TaskMenusOptions;

  constructor(options: TaskMenusOptions) {
    this.#options = options;
  }

  /** Obsidian orders sections by their first registered item, so helper order is menu group order. */
  createTaskContextMenu(card: HTMLElement, task: TaskSnapshot): Menu {
    const today = localDate(moment().format('YYYY-MM-DD'));
    const menu = new Menu();
    this.#addTaskDuePresetMenuItems(menu, task, today);
    this.#addTrackingMenuItem(menu, task);
    this.#addTaskTagMenuItems(menu, task);
    this.#addTaskDatePickerMenuItem(menu, card, task);
    this.#addTaskEditMenuItems(menu, card, task);
    this.#addTaskPropertyMenuItems(menu, task);
    this.#addTaskOpenMenuItem(menu, task);
    this.#addTaskDangerMenuItems(menu, task);
    return menu;
  }

  #addTaskDuePresetMenuItems(menu: Menu, task: TaskSnapshot, today: LocalDate): void {
    const tomorrow = shiftLocalDate(today, 1);
    menu.addItem((item) =>
      item
        .setTitle('Today')
        .setIcon('calendar')
        .setSection('today')
        .setChecked(task.planning.due === today)
        .onClick(() => {
          runAsyncAction(this.#options.commands.toggleTaskDuePreset(task, today));
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
            runAsyncAction(this.#options.commands.toggleTaskDuePreset(task, tomorrow));
          }),
      );
    }
  }

  #addTaskDatePickerMenuItem(menu: Menu, card: HTMLElement, task: TaskSnapshot): void {
    menu.addItem((item) =>
      item
        .setTitle('Set date…')
        .setIcon('calendar-cog')
        .setSection('edit')
        .onClick(() => {
          this.#options.host.openDatePicker(card, [task]);
        }),
    );
  }

  #addTaskTagMenuItems(menu: Menu, task: TaskSnapshot): void {
    for (const pinnedTag of this.#options.settings.pinnedTags) {
      const hasTag = [...this.#getTaskTags(task)].some((tag) => sameTag(tag, pinnedTag));
      menu.addItem((item) =>
        item
          .setTitle(pinnedTag)
          .setIcon('tag')
          .setSection('tags')
          .setChecked(hasTag)
          .onClick(() => {
            runAsyncAction(
              this.#options.commands.patchTaskTags(
                task,
                hasTag ? [] : [pinnedTag],
                hasTag ? [pinnedTag] : [],
              ),
            );
          }),
      );
    }
  }

  #addTaskPropertyMenuItems(menu: Menu, task: TaskSnapshot): void {
    menu.addItem((item) => {
      item.setTitle('Priority').setIcon('arrow-up-narrow-wide').setSection('priority');
      const sub = getSubmenu(item);
      this.#buildPrioritySubmenu(sub, task);
    });

    // ── Status (submenu) ──────────────────────────────────
    menu.addItem((item) => {
      item.setTitle('Status').setIcon('check-square').setSection('priority');
      const sub = getSubmenu(item);
      buildStatusSubmenu(sub, task, this.#options.statusRegistry, (c) => {
        runAsyncAction(this.#options.commands.setTaskStatus(task, c));
      });
    });

    menu.addItem((item) =>
      item
        .setTitle('Filter by this priority')
        .setIcon('filter')
        .setSection('priority')
        .onClick(() => {
          this.#options.host.addFilter({ type: 'priority', value: task.priority });
        }),
    );

    menu.addItem((item) =>
      item
        .setTitle('Filter by this status')
        .setIcon('filter')
        .setSection('priority')
        .onClick(() => {
          this.#options.host.addFilter({ type: 'status', value: task.statusSymbol });
        }),
    );
  }

  #addTaskEditMenuItems(menu: Menu, card: HTMLElement, task: TaskSnapshot): void {
    menu.addItem((item) =>
      item
        .setTitle('Set tag…')
        .setIcon('hash')
        .setSection('edit')
        .onClick(() => {
          this.#openTagPicker(task);
        }),
    );

    menu.addItem((item) => {
      item
        .setTitle('Edit repeat…')
        .setIcon('repeat-2')
        .setSection('edit')
        .onClick(() => {
          this.#options.host.openRecurrenceEditor(card, task);
        });
    });
  }

  #addTaskOpenMenuItem(menu: Menu, task: TaskSnapshot): void {
    menu.addItem((item) =>
      item
        .setTitle('Open in note')
        .setIcon('file-text')
        .setSection('open')
        .onClick(() => {
          runAsyncAction(openInFile(this.#options.app, task));
        }),
    );
  }

  #addTaskDangerMenuItems(menu: Menu, task: TaskSnapshot): void {
    menu.addItem((item) =>
      item
        .setTitle('Archive')
        .setIcon('archive')
        .setSection('danger')
        .onClick(() => {
          runAsyncAction(this.#options.commands.archiveTasks([task]));
        }),
    );

    menu.addItem((item) =>
      item
        .setTitle('Delete')
        .setIcon('trash-2')
        .setSection('danger')
        .onClick(() => {
          runAsyncAction(this.#options.commands.deleteTask(task));
        }),
    );
  }

  /**
   * Start or pause the timer on the card the menu was opened from. It stands in a section of its
   * own under the due presets because it is the one item here that sets something running rather
   * than editing the task, and it only ever means one card, which is why the bulk menu has none.
   * The section is registered by the item, so a menu without it shows no empty band.
   *
   * A forecast occurrence has no line to write to, and a finished node is refused unless something
   * under it is still running, which is the one case that still needs a way to stop.
   */
  #addTrackingMenuItem(menu: Menu, task: TaskSnapshot): void {
    const tracking = this.#options.timeTracking;
    const target = calendarMutationTarget(task);
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

  #bulkTagIndicator(count: number, total: number): string {
    if (count === total) return '✓ ';
    if (count > 0) return '~ ';
    return '';
  }

  #makeBulkTagRemoveHandler(selectedTasks: TaskSnapshot[], pinnedTag: string): () => void {
    return () => {
      runAsyncAction(
        Promise.all(
          selectedTasks.map((task) => this.#options.commands.patchTaskTags(task, [], [pinnedTag])),
        ),
      );
    };
  }

  #makeBulkTagAddHandler(selectedTasks: TaskSnapshot[], pinnedTag: string): () => void {
    return () => {
      runAsyncAction(
        Promise.all(
          selectedTasks.map((task) => this.#options.commands.patchTaskTags(task, [pinnedTag], [])),
        ),
      );
    };
  }

  #addBulkTagItem(menu: Menu, pinnedTag: string, selectedTasks: TaskSnapshot[]): void {
    const count = selectedTasks.filter((task) => task.tags.includes(pinnedTag)).length;
    const allHave = count === selectedTasks.length;
    const indicator = this.#bulkTagIndicator(count, selectedTasks.length);
    const clickHandler = allHave
      ? this.#makeBulkTagRemoveHandler(selectedTasks, pinnedTag)
      : this.#makeBulkTagAddHandler(selectedTasks, pinnedTag);
    menu.addItem((item) =>
      item
        .setTitle(`${indicator}${pinnedTag}  (${count}/${selectedTasks.length})`)
        .setIcon('tag')
        .setSection('tags')
        .onClick(clickHandler),
    );
  }

  #buildPrioritySubmenu(sub: Menu, task: TaskSnapshot): void {
    for (const level of PRIORITY_LEVELS) {
      sub.addItem((si) => {
        si.setTitle(level.label)
          .setIcon('flag')
          .setChecked(task.priority === level.value)
          .onClick(() => {
            runAsyncAction(this.#options.commands.setPriority(task, level.value));
          });
        applyPriorityFlagColor(si, level.value);
      });
    }
  }

  #buildBulkPrioritySubmenu(sub: Menu, selectedTasks: TaskSnapshot[]): void {
    for (const level of PRIORITY_LEVELS) {
      sub.addItem((si) => {
        si.setTitle(level.label)
          .setIcon('flag')
          .onClick(() => {
            runAsyncAction(
              Promise.all(
                selectedTasks.map((t) => this.#options.commands.setPriority(t, level.value)),
              ),
            );
          });
        applyPriorityFlagColor(si, level.value);
      });
    }
  }

  #getTaskTags(task: TaskSnapshot): Set<string> {
    return new Set(task.tags);
  }

  #openTagPicker(task: TaskSnapshot): void {
    const currentTags = this.#getTaskTags(task);
    const catalog = this.#options.host.tagCatalog();
    const handleCommit = (toAdd: string[], toRemove: string[]): void => {
      runAsyncAction(this.#options.commands.patchTaskTags(task, toAdd, toRemove));
    };
    new TagPickerModal(
      this.#options.app,
      (tag) => this.#options.host.tagColor(tag, catalog.groups),
      currentTags,
      new Set(),
      collectTaskTags(catalog.nodes, this.#options.settings, [...currentTags]),
      handleCommit,
      this.#options.interactionOwnership,
    ).open();
  }

  #openBulkTagPicker(selectedTasks: TaskSnapshot[]): void {
    const tagSets = selectedTasks.map((t) => this.#getTaskTags(t));
    const allTags = new Set(tagSets.flatMap((s) => [...s]));
    const hasAll = (tag: string): boolean =>
      tagSets.every((s) => [...s].some((candidate) => sameTag(candidate, tag)));
    const currentTags = new Set([...allTags].filter(hasAll));
    const partialTags = new Set([...allTags].filter((tag) => !hasAll(tag)));
    const catalog = this.#options.host.tagCatalog();
    const handleBulkCommit = (toAdd: string[], toRemove: string[]): void => {
      runAsyncAction(
        Promise.all(
          selectedTasks.map((task) => this.#options.commands.patchTaskTags(task, toAdd, toRemove)),
        ),
      );
    };
    new TagPickerModal(
      this.#options.app,
      (tag) => this.#options.host.tagColor(tag, catalog.groups),
      currentTags,
      partialTags,
      collectTaskTags(catalog.nodes, this.#options.settings, [...currentTags, ...partialTags]),
      handleBulkCommit,
      this.#options.interactionOwnership,
    ).open();
  }

  showBulkContextMenu(event: MouseEvent, card: HTMLElement, selectedTasks: TaskSnapshot[]): void {
    const firstSelectedTask = selectedTasks[0];
    if (firstSelectedTask === undefined) return;
    const menu = new Menu();
    menu.addItem((item) =>
      item
        .setTitle(`${selectedTasks.length} tasks selected`)
        .setSection('header')
        .setDisabled(true),
    );
    this.#addBulkDateMenuItems(menu, selectedTasks, card);
    for (const pinnedTag of this.#options.settings.pinnedTags) {
      this.#addBulkTagItem(menu, pinnedTag, selectedTasks);
    }
    this.#addBulkPropertyMenuItems(menu, selectedTasks, firstSelectedTask);
    this.#addBulkActionMenuItems(menu, selectedTasks);
    this.#options.host.showTaskMenu(menu, event, card);
  }

  #addBulkDateMenuItems(menu: Menu, selectedTasks: TaskSnapshot[], card: HTMLElement): void {
    const today = localDate(moment().format('YYYY-MM-DD'));
    const tomorrow = shiftLocalDate(today, 1);
    const allHaveToday = selectedTasks.every((t) => t.planning.due === today);
    menu.addItem((item) =>
      item
        .setTitle('Today')
        .setIcon('calendar')
        .setSection('today')
        .setChecked(allHaveToday)
        .onClick(() => {
          this.#options.host.applyBulkDuePreset(card, selectedTasks, today);
        }),
    );

    if (tomorrow !== undefined) {
      const allHaveTomorrow = selectedTasks.every((task) => task.planning.due === tomorrow);
      menu.addItem((item) =>
        item
          .setTitle('Tomorrow')
          .setIcon('calendar-plus')
          .setSection('today')
          .setChecked(allHaveTomorrow)
          .onClick(() => {
            this.#options.host.applyBulkDuePreset(card, selectedTasks, tomorrow);
          }),
      );
    }
    menu.addItem((item) =>
      item
        .setTitle('Set date…')
        .setIcon('calendar-cog')
        .setSection('actions')
        .onClick(() => {
          this.#options.host.openDatePicker(card, selectedTasks);
        }),
    );
  }

  #addBulkPropertyMenuItems(
    menu: Menu,
    selectedTasks: TaskSnapshot[],
    firstSelectedTask: TaskSnapshot,
  ): void {
    menu.addItem((item) => {
      item.setTitle('Priority').setIcon('arrow-up-narrow-wide').setSection('priority');
      const sub = getSubmenu(item);
      this.#buildBulkPrioritySubmenu(sub, selectedTasks);
    });

    menu.addItem((item) => {
      item.setTitle('Status').setIcon('check-square').setSection('priority');
      const sub = getSubmenu(item);
      buildStatusSubmenu(sub, firstSelectedTask, this.#options.statusRegistry, (c) => {
        runAsyncAction(
          Promise.all(selectedTasks.map((t) => this.#options.commands.setTaskStatus(t, c))),
        );
      });
    });
  }

  #addBulkActionMenuItems(menu: Menu, selectedTasks: TaskSnapshot[]): void {
    menu.addItem((item) =>
      item
        .setTitle('Set tag…')
        .setIcon('hash')
        .setSection('actions')
        .onClick(() => {
          this.#openBulkTagPicker(selectedTasks);
        }),
    );

    menu.addItem((item) =>
      item
        .setTitle('Archive all')
        .setIcon('archive')
        .setSection('danger')
        .onClick(() => {
          runAsyncAction(this.#options.commands.archiveTasks(selectedTasks));
        }),
    );

    menu.addItem((item) =>
      item
        .setTitle('Delete all')
        .setIcon('trash-2')
        .setSection('danger')
        .onClick(() => {
          runAsyncAction(this.#options.commands.deleteBulkTasks(selectedTasks));
        }),
    );
  }
}
