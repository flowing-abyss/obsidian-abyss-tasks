import { Menu, type App } from 'obsidian';
import { sameTag } from '../../markdown/tagSyntax';
import { moment } from '../../obsidianMoment';
import { PRIORITY_LEVELS } from '../../priority';
import type { CalendarSettings, PropertyFilter } from '../../settings/types';
import type { StatusRegistry } from '../../status/StatusRegistry';
import type { EffectiveTagGroup } from '../../tags/effectiveTagGroups';
import { collectTaskTags } from '../../tags/taskTagCatalog';
import type { TaskSearchMenuSummary } from '../../task-lists/taskSearchOrganization';
import {
  localDate,
  shiftLocalDate,
  taskNodeSourceLine,
  TaskSearchError,
  type LocalDate,
  type TaskOccurrenceCompletion,
  type TaskQueryApi,
} from '../../tasks';
import { TagPickerModal } from '../../ui/TagPickerModal';
import type { InteractionOwnershipPort } from '../../ui/interactionOwnership';
import { runAsyncAction } from '../../ui/runAsyncAction';
import { buildStatusSubmenu } from '../../ui/statusMenu';
import {
  applyPriorityFlagColor,
  createTaskContextMenu,
  getSubmenu,
} from '../../ui/taskContextMenu';
import { openInFile } from '../../ui/taskNavigation';
import type { TrackingSurface } from '../../ui/timeTracking/TimeBadge';
import {
  commandNode,
  commandSource,
  commandTarget,
  type TaskCommands,
  type TaskCommandSubject,
} from './TaskCommands';
import type { TaskSelectedNode } from './taskNodeBatch';

export interface TaskMenuTargets {
  readonly signal: AbortSignal;
  readonly summaries: ReadonlyArray<
    TaskSearchMenuSummary & {
      readonly depth?: number;
      readonly completion?: TaskOccurrenceCompletion;
    }
  >;
  resolve(signal: AbortSignal): Promise<readonly TaskSelectedNode[]>;
}
interface TaskMenusHost {
  beginBulkResolution(card: HTMLElement): () => void;
  reportTargetFailure(error: unknown): void;
  showTaskMenu(menu: Menu, event: MouseEvent, card: HTMLElement): void;
  applyBulkDuePreset(
    card: HTMLElement,
    tasks: readonly TaskCommandSubject[],
    value: LocalDate,
  ): void;
  applyBulkTaskTags(
    card: HTMLElement,
    tasks: readonly TaskCommandSubject[],
    add: readonly string[],
    remove: readonly string[],
  ): void;
  openDatePicker(
    anchor: HTMLElement,
    tasks: readonly TaskCommandSubject[],
    targets?: TaskMenuTargets,
  ): void;
  openRecurrenceEditor(anchor: HTMLElement, task: TaskCommandSubject): void;
  addFilter(filter: PropertyFilter): void;
  tagCatalog(): {
    readonly tags: readonly string[];
    readonly groups: readonly EffectiveTagGroup[];
  };
  tagColor(tag: string, groups: readonly EffectiveTagGroup[]): string | undefined;
}

interface TaskMenusOptions {
  readonly app: App;
  readonly queries: TaskQueryApi;
  readonly settings: CalendarSettings;
  readonly statusRegistry: StatusRegistry;
  readonly interactionOwnership: InteractionOwnershipPort;
  readonly timeTracking?: TrackingSurface | undefined;
  readonly commands: TaskCommands;
  readonly host: TaskMenusHost;
}

export class TaskMenus {
  readonly #options: TaskMenusOptions;

  constructor(options: TaskMenusOptions) {
    this.#options = options;
  }

  createTaskContextMenu(
    card: HTMLElement,
    task: TaskCommandSubject,
    representedTags: readonly string[] = [],
  ): Menu {
    return createTaskContextMenu({
      node: commandNode(task),
      target: commandTarget(task),
      anchor: card,
      statusRegistry: this.#options.statusRegistry,
      pinnedTags: this.#options.settings.pinnedTags,
      timeTracking: this.#options.timeTracking,
      filters: {
        representedTags,
        addFilter: (filter) => {
          this.#options.host.addFilter(filter);
        },
      },
      actions: {
        toggleDue: (date) => this.#options.commands.toggleTaskDuePreset(task, date),
        patchTags: (add, remove) => this.#options.commands.patchTaskTags(task, add, remove),
        setStatus: (symbol) => this.#options.commands.setTaskStatus(task, symbol),
        setPriority: (priority) => this.#options.commands.setPriority(task, priority),
        openDatePicker: (anchor) => {
          this.#options.host.openDatePicker(anchor, [task]);
        },
        openTagPicker: () => {
          this.#openTagPicker(task);
        },
        openRecurrenceEditor: (anchor) => {
          this.#options.host.openRecurrenceEditor(anchor, task);
        },
        openInNote: () => {
          const target = commandTarget(task);
          if (target === undefined) return;
          const source = commandSource(task, this.#options.queries);
          if (source !== undefined)
            runAsyncAction(openInFile(this.#options.app, source.root, taskNodeSourceLine(target)));
        },
        promote: () => this.#options.commands.promoteTask(task),
        archive: () => this.#options.commands.archiveTasks([task]),
        delete: () => this.#options.commands.deleteTask(task),
      },
    });
  }

  #bulkTagIndicator(count: number, total: number): string {
    if (count === total) return '✓ ';
    if (count > 0) return '~ ';
    return '';
  }

  #addBulkTagItem(
    menu: Menu,
    pinnedTag: string,
    targets: TaskMenuTargets,
    card: HTMLElement,
  ): void {
    const count = targets.summaries.filter((task) =>
      task.tags.some((tag) => sameTag(tag, pinnedTag)),
    ).length;
    const allHave = count === targets.summaries.length;
    menu.addItem((item) =>
      item
        .setTitle(
          `${this.#bulkTagIndicator(count, targets.summaries.length)}${pinnedTag}  (${count}/${targets.summaries.length})`,
        )
        .setIcon('tag')
        .setSection('tags')
        .onClick(() => {
          this.#runTargets(
            targets,
            (tasks) => {
              this.#options.host.applyBulkTaskTags(
                card,
                tasks.map((entry) => entry.task),
                allHave ? [] : [pinnedTag],
                allHave ? [pinnedTag] : [],
              );
            },
            card,
          );
        }),
    );
  }
  #runTargets(
    targets: TaskMenuTargets,
    action: (tasks: readonly TaskSelectedNode[]) => void | Promise<unknown>,
    card?: HTMLElement,
  ): void {
    const release = card === undefined ? undefined : this.#options.host.beginBulkResolution(card);
    runAsyncAction(
      (async () => {
        let tasks: readonly TaskSelectedNode[];
        try {
          if (!this.#targetsCurrent(targets)) return;
          tasks = await targets.resolve(targets.signal);
          if (!this.#targetsCurrent(targets)) return;
        } catch (error) {
          if (
            !targets.signal.aborted &&
            !(error instanceof TaskSearchError && error.code === 'aborted')
          )
            this.#options.host.reportTargetFailure(error);
          return;
        }
        await action(tasks);
      })().finally(() => release?.()),
    );
  }

  #targetsCurrent(targets: TaskMenuTargets): boolean {
    return !targets.signal.aborted;
  }

  #buildBulkPrioritySubmenu(sub: Menu, targets: TaskMenuTargets): void {
    for (const level of PRIORITY_LEVELS) {
      sub.addItem((si) => {
        si.setTitle(level.label)
          .setIcon('flag')
          .onClick(() => {
            this.#runTargets(targets, (tasks) =>
              this.#options.commands.setBulkPriority(
                tasks.map((entry) => entry.task),
                level.value,
              ),
            );
          });
        applyPriorityFlagColor(si, level.value);
      });
    }
  }

  #getTaskTags(task: TaskCommandSubject): Set<string> {
    return new Set(commandNode(task).tags);
  }

  #openTagPicker(task: TaskCommandSubject): void {
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
      collectTaskTags(catalog.tags, this.#options.settings, [...currentTags]),
      handleCommit,
      this.#options.interactionOwnership,
    ).open();
  }

  #openBulkTagPicker(targets: TaskMenuTargets): void {
    const tagSets = targets.summaries.map((t) => new Set(t.tags));
    const allTags = new Set(tagSets.flatMap((s) => [...s]));
    const hasAll = (tag: string): boolean =>
      tagSets.every((s) => [...s].some((candidate) => sameTag(candidate, tag)));
    const currentTags = new Set([...allTags].filter(hasAll));
    const partialTags = new Set([...allTags].filter((tag) => !hasAll(tag)));
    const catalog = this.#options.host.tagCatalog();
    const handleBulkCommit = (toAdd: string[], toRemove: string[]): void => {
      this.#runTargets(targets, (tasks) =>
        this.#options.commands.applyBulkTaskTags(
          tasks.map((entry) => entry.task),
          toAdd,
          toRemove,
        ),
      );
    };
    new TagPickerModal(
      this.#options.app,
      (tag) => this.#options.host.tagColor(tag, catalog.groups),
      currentTags,
      partialTags,
      collectTaskTags(catalog.tags, this.#options.settings, [...currentTags, ...partialTags]),
      handleBulkCommit,
      this.#options.interactionOwnership,
    ).open();
  }

  showBulkContextMenu(event: MouseEvent, card: HTMLElement, targets: TaskMenuTargets): void {
    const firstSelectedTask = targets.summaries[0];
    if (firstSelectedTask === undefined) return;
    const menu = new Menu();
    menu.addItem((item) =>
      item
        .setTitle(`${targets.summaries.length} tasks selected`)
        .setSection('header')
        .setDisabled(true),
    );
    this.#addBulkDateMenuItems(menu, targets, card);
    for (const pinnedTag of this.#options.settings.pinnedTags) {
      this.#addBulkTagItem(menu, pinnedTag, targets, card);
    }
    this.#addBulkPropertyMenuItems(menu, targets, firstSelectedTask);
    this.#addBulkActionMenuItems(menu, targets);
    this.#options.host.showTaskMenu(menu, event, card);
  }

  #addBulkDateMenuItems(menu: Menu, targets: TaskMenuTargets, card: HTMLElement): void {
    const today = localDate(moment().format('YYYY-MM-DD'));
    const tomorrow = shiftLocalDate(today, 1);
    const allHaveToday = targets.summaries.every((t) => t.planning.due === today);
    menu.addItem((item) =>
      item
        .setTitle('Today')
        .setIcon('calendar')
        .setSection('today')
        .setChecked(allHaveToday)
        .onClick(() => {
          this.#runTargets(
            targets,
            (tasks) => {
              this.#options.host.applyBulkDuePreset(
                card,
                tasks.map((entry) => entry.task),
                today,
              );
            },
            card,
          );
        }),
    );

    if (tomorrow !== undefined) {
      const allHaveTomorrow = targets.summaries.every((task) => task.planning.due === tomorrow);
      menu.addItem((item) =>
        item
          .setTitle('Tomorrow')
          .setIcon('calendar-plus')
          .setSection('today')
          .setChecked(allHaveTomorrow)
          .onClick(() => {
            this.#runTargets(
              targets,
              (tasks) => {
                this.#options.host.applyBulkDuePreset(
                  card,
                  tasks.map((entry) => entry.task),
                  tomorrow,
                );
              },
              card,
            );
          }),
      );
    }
    menu.addItem((item) =>
      item
        .setTitle('Set date…')
        .setIcon('calendar-cog')
        .setSection('actions')
        .onClick(() => {
          this.#runTargets(targets, (tasks) => {
            this.#options.host.openDatePicker(
              card,
              tasks.map((entry) => entry.task),
              targets,
            );
          });
        }),
    );
  }

  #addBulkPropertyMenuItems(
    menu: Menu,
    targets: TaskMenuTargets,
    firstSelectedTask: TaskSearchMenuSummary,
  ): void {
    menu.addItem((item) => {
      item.setTitle('Priority').setIcon('arrow-up-narrow-wide').setSection('priority');
      const sub = getSubmenu(item);
      this.#buildBulkPrioritySubmenu(sub, targets);
    });

    menu.addItem((item) => {
      item.setTitle('Status').setIcon('check-square').setSection('priority');
      const sub = getSubmenu(item);
      buildStatusSubmenu(sub, firstSelectedTask, this.#options.statusRegistry, (c) => {
        this.#runTargets(targets, (tasks) => this.#options.commands.setBulkTaskStatus(tasks, c));
      });
    });
  }

  #addBulkActionMenuItems(menu: Menu, targets: TaskMenuTargets): void {
    menu.addItem((item) =>
      item
        .setTitle('Set tag…')
        .setIcon('hash')
        .setSection('actions')
        .onClick(() => {
          this.#openBulkTagPicker(targets);
        }),
    );

    menu.addItem((item) =>
      item
        .setTitle('Archive all')
        .setDisabled(targets.summaries.some((task) => (task.depth ?? 0) > 0))
        .setIcon('archive')
        .setSection('danger')
        .onClick(() => {
          this.#runTargets(targets, (tasks) =>
            this.#options.commands.archiveTasks(tasks.map((entry) => entry.task)),
          );
        }),
    );

    menu.addItem((item) =>
      item
        .setTitle('Delete all')
        .setIcon('trash-2')
        .setSection('danger')
        .onClick(() => {
          this.#runTargets(targets, (tasks) =>
            this.#options.commands.deleteBulkTasks(tasks.map((entry) => entry.task)),
          );
        }),
    );
  }
}
