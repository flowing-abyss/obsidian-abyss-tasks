import type { AppState, TaskNodeDragPayload } from '../../app/AppState';
import type { StatusRegistry } from '../../status/StatusRegistry';
import {
  sameTaskNodeRef,
  type DependencyDirection,
  type TaskCommand,
  type TaskDependencyProjection,
  type TaskDependencyQueryApi,
  type TaskDependencyRelation,
  type TaskNodeRef,
} from '../../tasks';
import {
  dependencySearchOptions,
  focusWithoutScroll,
  mountDependencySearch,
  type DependencyPickerCommitResult,
  type DependencySearchHandle,
} from '../../ui/dependencySearch';
import type { InlineUndoPosition } from '../../ui/inlineTaskUndo';
import type { InteractionOwnershipPort } from '../../ui/interactionOwnership';
import { runAsyncAction } from '../../ui/runAsyncAction';
import { renderStatusMarker } from '../../ui/StatusMarker';
import {
  dependencyCountPresentation,
  dependencyDirectionLabel,
  dependencyRelationPresentation,
} from '../../ui/taskDependencyPresentation';
import { startTaskNodeDrag } from '../../ui/taskNodeDrag';
import { taskNodeRef } from '../../ui/taskSelection';
import type { InspectorPlanningSurfaces } from './InspectorPlanningSurfaces';
import { renderRowRemove } from './inspectorRowRemove';
import type { TaskLike } from './inspectorTypes';

interface InspectorDependenciesOptions {
  readonly state: AppState;
  readonly queries: TaskDependencyQueryApi | undefined;
  readonly statusRegistry: StatusRegistry;
  readonly interactionOwnership: InteractionOwnershipPort;
  readonly surfaces: Pick<
    InspectorPlanningSurfaces,
    | 'clearPopovers'
    | 'positionAnchoredSurface'
    | 'releasePlacement'
    | 'openDependencyStatusMenu'
    | 'refreshStatusMarkers'
    | 'closeDependencyStatusMenu'
  >;
  readonly host: {
    readonly root: () => HTMLElement;
    readonly mounted: () => boolean;
    readonly dependencyTask: (stack?: readonly TaskLike[]) => TaskLike | undefined;
    readonly isBlocked: (task: TaskLike) => boolean;
    readonly detachUndo: () => void;
    readonly renderUndo: () => void;
    readonly refreshTimeBadge: () => void;
    readonly finishTaskDrag: () => void;
    readonly setTaskDragCleanup: (cleanup: () => void) => void;
  };
  readonly commands: {
    readonly executeDependencyCommand: (
      command: Extract<
        TaskCommand,
        { type: 'add-dependency' | 'remove-dependency' | 'reverse-dependency' }
      >,
      position?: InlineUndoPosition,
    ) => Promise<boolean>;
    readonly createDependencySubtask: (
      text: string,
      direction: DependencyDirection,
    ) => Promise<DependencyPickerCommitResult>;
  };
}
interface DependencyDisclosureState {
  readonly selectionKey: string;
  readonly latched: boolean;
}

function updateDependencyBadgeCounts(
  body: HTMLButtonElement,
  counts: ReturnType<typeof dependencyCountPresentation>,
): void {
  const lock = body.querySelector<HTMLElement>('.abyss-dep-lock') as HTMLElement;
  const blockedBy = body.querySelector<HTMLElement>(
    '[data-dependency-count="blocked-by"]',
  ) as HTMLElement;
  const divider = body.querySelector<HTMLElement>('.abyss-dep-divider') as HTMLElement;
  const blocks = body.querySelector<HTMLElement>('[data-dependency-count="blocks"]') as HTMLElement;
  const isEmpty = counts.blockedBy === 0 && counts.blocks === 0;
  let lockClass = 'abyss-dep-lock';
  if (counts.blockedBy > 0) lockClass += ' abyss-dep-count-blocked-by';
  else if (counts.blocks > 0) lockClass += ' abyss-dep-count-blocks';
  lock.className = lockClass;
  blockedBy.setText(String(counts.blockedBy));
  blockedBy.className = isEmpty ? 'abyss-dep-count' : 'abyss-dep-count-blocked-by';
  divider.toggleAttribute('hidden', isEmpty);
  blocks.setText(String(counts.blocks));
  blocks.className = isEmpty ? 'abyss-dep-count' : 'abyss-dep-count-blocks';
  blocks.toggleAttribute('hidden', isEmpty);
}

export class InspectorDependencies {
  readonly #state: AppState;
  readonly #queries: TaskDependencyQueryApi | undefined;
  readonly #statusRegistry: StatusRegistry;
  readonly #interactionOwnership: InteractionOwnershipPort;
  readonly #surfaces: InspectorDependenciesOptions['surfaces'];
  readonly #host: InspectorDependenciesOptions['host'];
  readonly #commands: InspectorDependenciesOptions['commands'];
  #search: DependencySearchHandle | undefined;
  #searchAnchor = '.abyss-dep-badge-body';
  #disclosure: DependencyDisclosureState | undefined;
  #retainedSearch: DependencySearchHandle | undefined;
  #retainedFocus: HTMLElement | null = null;
  constructor(options: InspectorDependenciesOptions) {
    this.#state = options.state;
    this.#queries = options.queries;
    this.#statusRegistry = options.statusRegistry;
    this.#interactionOwnership = options.interactionOwnership;
    this.#surfaces = options.surfaces;
    this.#host = options.host;
    this.#commands = options.commands;
  }
  clearDisclosure(): void {
    this.#disclosure = undefined;
  }
  cancelSearch(): void {
    this.#search?.destroy();
    this.#search = undefined;
    this.#retainedSearch = undefined;
    this.#retainedFocus = null;
  }
  closeAttachedSearch(): void {
    if (this.#search?.element.parentElement != null) this.#search.close(false);
  }
  closeSearchSurface(surface: HTMLElement): void {
    if (surface === this.#search?.element) this.#search.close(false);
  }
  detachSearchForRender(): void {
    const search = this.#search;
    const focused = this.#host.root().ownerDocument.activeElement as HTMLElement | null;
    this.#retainedSearch = search;
    this.#retainedFocus = search?.element.contains(focused) === true ? focused : null;
    if (search !== undefined) {
      this.#surfaces.releasePlacement(search.element);
      search.element.remove();
    }
  }
  reattachSearchAfterRender(): void {
    const search = this.#retainedSearch;
    const focused = this.#retainedFocus;
    this.#retainedSearch = undefined;
    this.#retainedFocus = null;
    if (search !== undefined && search === this.#search) {
      this.#host.root().append(search.element);
      search.refresh();
      this.#positionDependencySearch(search.element, focused);
    }
  }
  updateDisclosureSelection(stack: readonly TaskLike[], preserveLatch: boolean): void {
    const selected = stack[stack.length - 1];
    if (selected === undefined) {
      this.#disclosure = undefined;
      return;
    }
    this.#disclosure = {
      selectionKey: JSON.stringify(taskNodeRef(selected)),
      latched: preserveLatch && this.#disclosure?.latched === true,
    };
  }

  #latchDependencyDisclosure(): void {
    const disclosure = this.#disclosure;
    if (disclosure === undefined || disclosure.latched) return;
    this.#disclosure = { ...disclosure, latched: true };
  }

  #dependencyProjection(): TaskDependencyProjection | undefined {
    const task = this.#host.dependencyTask();
    return task === undefined ? undefined : this.#queries?.dependencies(taskNodeRef(task));
  }

  updateBadge(): void {
    const badge = this.#host.root().querySelector<HTMLElement>('.abyss-dep-badge');
    const projection = this.#dependencyProjection();
    if (badge === null || projection === undefined) return;
    const body =
      badge.querySelector<HTMLButtonElement>('.abyss-dep-badge-body') ??
      this.#createDependencyBadgeBody(badge);
    const counts = dependencyCountPresentation(projection);
    body.setAttribute('aria-label', counts.ariaLabel);
    body.title = counts.title;
    body.setAttribute('aria-expanded', String(this.#search !== undefined));
    updateDependencyBadgeCounts(body, counts);
    this.#updateDependencyBadgeAdd(badge, projection);
  }

  #createDependencyBadgeBody(badge: HTMLElement): HTMLButtonElement {
    const body = badge.createEl('button', {
      cls: 'abyss-dep-badge-body',
      attr: { type: 'button', 'aria-haspopup': 'dialog' },
    });
    body.createSpan({ cls: 'abyss-dep-lock', text: '🔒', attr: { 'aria-hidden': 'true' } });
    for (const [name, direction] of [
      ['count-blocked-by', 'blocked-by'],
      ['divider', undefined],
      ['count-blocks', 'blocks'],
    ] as const)
      body.createSpan({
        cls: `abyss-dep-${name}`,
        attr: {
          'aria-hidden': 'true',
          ...(direction !== undefined && { 'data-dependency-count': direction }),
        },
      });
    body.addEventListener('click', () => {
      this.showSearch();
    });
    return body;
  }

  #updateDependencyBadgeAdd(badge: HTMLElement, projection: TaskDependencyProjection): void {
    const plus = badge.querySelector('.abyss-dep-badge-add');
    const sectionsExist =
      this.#dependencySectionsDisclosed() ||
      projection.blockedBy.length > 0 ||
      projection.blocks.length > 0;
    if (sectionsExist) plus?.remove();
    else if (plus === null) {
      const add = badge.createEl('button', {
        cls: 'abyss-dep-badge-add',
        text: '+',
        attr: { type: 'button', 'aria-label': 'Add dependency sections', title: 'Add dependency' },
      });
      add.addEventListener('click', () => {
        this.#search?.close(false);
        this.#latchDependencyDisclosure();
        this.refresh();
        this.#host.root().querySelector<HTMLButtonElement>('.abyss-dep-add')?.focus();
      });
    }
  }

  renderSections(): void {
    const task = this.#host.dependencyTask();
    const projection = this.#dependencyProjection();
    if (task === undefined || projection === undefined) return;
    if (projection.blockedBy.length > 0 || projection.blocks.length > 0)
      this.#latchDependencyDisclosure();
    for (const direction of ['blocked-by', 'blocks'] as const) {
      const relations = direction === 'blocked-by' ? projection.blockedBy : projection.blocks;
      if (relations.length === 0 && !this.#dependencySectionsDisclosed()) continue;
      this.#renderDependencySection(direction, relations, taskNodeRef(task));
    }
  }

  #dependencySectionsDisclosed(): boolean {
    return (
      this.#disclosure?.latched === true ||
      this.#state.get('draggingTaskNode')?.source === 'center-card'
    );
  }

  #renderDependencySection(
    direction: DependencyDirection,
    relations: readonly TaskDependencyRelation[],
    current: TaskNodeRef,
  ): void {
    const section = this.#host.root().createDiv({
      cls: 'abyss-right-section abyss-dep-section',
      attr: { 'data-dependency-direction': direction },
    });
    this.#bindDependencyDrop(section, direction);
    section
      .createDiv({ cls: 'abyss-right-section-header' })
      .createSpan({ cls: 'abyss-right-section-label', text: dependencyDirectionLabel(direction) });
    const list = section.createDiv({ cls: 'abyss-subtask-list' });
    for (const relation of relations) this.#renderDependencyRow(list, relation, direction, current);
    const add = section.createEl('button', {
      cls: 'abyss-subtask-add-row abyss-dep-add',
      attr: {
        type: 'button',
        'aria-label': `Add dependency: ${dependencyDirectionLabel(direction)}`,
        'aria-haspopup': 'dialog',
      },
    });
    add.createSpan({ cls: 'abyss-subtask-add-icon', text: '+' });
    add.createSpan({ cls: 'abyss-subtask-add-label', text: 'Add dependency' });
    add.addEventListener('click', () => {
      this.showSearch(direction);
    });
    const subtasks = this.#host.root().querySelector('.abyss-subtask-section');
    if (subtasks !== null) this.#host.root().insertBefore(section, subtasks);
  }

  #dependencyDropCommand(
    direction: DependencyDirection,
  ): Extract<TaskCommand, { type: 'add-dependency' | 'reverse-dependency' }> | undefined {
    const payload = this.#state.get('draggingTaskNode');
    const current = this.#host.dependencyTask();
    if (payload === null || current === undefined) return undefined;
    if (payload.source === 'inspector-relation') {
      const { relation } = payload;
      if (
        relation.direction === direction ||
        !sameTaskNodeRef(
          taskNodeRef(current),
          relation.direction === 'blocked-by' ? relation.dependent : relation.blocker,
        )
      )
        return undefined;
      return {
        type: 'reverse-dependency',
        blocker: relation.blocker,
        dependent: relation.dependent,
        dependencyId: relation.dependencyId,
      };
    }
    return {
      type: 'add-dependency',
      blocker: direction === 'blocked-by' ? payload.task.target : taskNodeRef(current),
      dependent: direction === 'blocked-by' ? taskNodeRef(current) : payload.task.target,
    };
  }

  #dependencyDropAllowed(
    command: Extract<TaskCommand, { type: 'add-dependency' | 'reverse-dependency' }> | undefined,
  ): boolean {
    if (command === undefined) return false;
    return (
      (command.type === 'reverse-dependency'
        ? this.#queries?.dependencyEligibility(command.dependent, command.blocker, {
            without: command,
          })
        : this.#queries?.dependencyEligibility(command.blocker, command.dependent)
      )?.type === 'allowed'
    );
  }

  clearDropClasses(): void {
    this.#host
      .root()
      .querySelectorAll('.abyss-dep-section')
      .forEach((section) => {
        section.removeClass('is-drop-target', 'is-drop-disabled');
      });
  }

  #bindDependencyDrop(section: HTMLElement, direction: DependencyDirection): void {
    let checked: TaskNodeDragPayload | null = null;
    let allowed = false;
    const preview = (event: DragEvent): void => {
      this.clearDropClasses();
      const command = this.#dependencyDropCommand(direction);
      if (command === undefined || this.#queries === undefined) return;
      const payload = this.#state.get('draggingTaskNode');
      if (checked !== payload) {
        checked = payload;
        allowed = this.#dependencyDropAllowed(command);
      }
      section.addClass(allowed ? 'is-drop-target' : 'is-drop-disabled');
      if (allowed) event.preventDefault();
    };
    section.addEventListener('dragenter', preview);
    section.addEventListener('dragover', preview);
    section.addEventListener('dragleave', (event) => {
      if (!section.contains(event.relatedTarget as Node | null))
        section.removeClass('is-drop-target', 'is-drop-disabled');
    });
    section.addEventListener('drop', (event) => {
      const command = this.#dependencyDropCommand(direction);
      this.clearDropClasses();
      if (command !== undefined && this.#dependencyDropAllowed(command)) {
        event.preventDefault();
        event.stopPropagation();
        runAsyncAction(this.#commitDependencyDrop(command), 'Could not update dependency');
      }
      if (this.#state.get('draggingTaskNode') !== null) this.#state.set('draggingTaskNode', null);
    });
  }

  async #commitDependencyDrop(
    command: Extract<TaskCommand, { type: 'add-dependency' | 'reverse-dependency' }>,
  ): Promise<void> {
    const selection = this.#state.get('taskStack');
    const committed = await this.#commands.executeDependencyCommand(command);
    if (!committed || !this.#host.mounted()) return;
    const submitted = this.#host.dependencyTask(selection);
    const current = this.#host.dependencyTask();
    if (
      submitted === undefined ||
      current === undefined ||
      !sameTaskNodeRef(taskNodeRef(submitted), taskNodeRef(current))
    )
      return;
    this.refresh();
  }

  #renderDependencyRow(
    container: HTMLElement,
    relation: TaskDependencyRelation,
    direction: DependencyDirection,
    current: TaskNodeRef,
  ): void {
    const presentation = dependencyRelationPresentation(relation);
    const row = container.createDiv({
      cls: `abyss-subtask-row abyss-dep-row${presentation.unavailable ? ' is-unavailable' : ''}`,
      attr: { 'data-state': presentation.state },
    });
    if (relation.type === 'resolved') {
      this.#bindRelationDrag(row, relation, direction, current);
      renderStatusMarker(row, {
        task: relation.task.node,
        registry: this.#statusRegistry,
        interactive: 'menu',
        onLeftClick: () => {},
        onContextMenu: (event) => {
          this.#surfaces.openDependencyStatusMenu(event, relation.task.node);
        },
      });
      row.addEventListener('click', (event) => {
        event.stopPropagation();
        const previous = this.#state.get('taskStack');
        this.#state.openInspectorDependency(relation.task);
        if (this.#state.get('taskStack') !== previous)
          this.#host.root().querySelector<HTMLElement>('.abyss-inspector-back')?.focus();
      });
    }
    row.createEl(relation.type === 'resolved' ? 'button' : 'span', {
      cls: `abyss-subtask-label abyss-dep-title${presentation.done ? ' is-done' : ''}`,
      text: presentation.title,
      attr: {
        title: presentation.title,
        ...(relation.type === 'resolved' ? { type: 'button' } : {}),
      },
    });
    if (presentation.unavailable)
      row.createSpan({
        cls: 'abyss-dep-id',
        text: relation.dependencyId,
        attr: { title: relation.dependencyId },
      });
    const dependent =
      direction === 'blocks' && relation.type === 'resolved' ? relation.task.target : current;
    renderRowRemove(
      row,
      'abyss-dep-remove',
      {
        label: presentation.removeLabel,
        title: presentation.removeLabel,
        failure: 'Could not remove dependency',
      },
      () =>
        this.#commands.executeDependencyCommand(
          {
            type: 'remove-dependency',
            dependent,
            dependencyId: relation.dependencyId,
          },
          {
            list: `[data-dependency-direction="${direction}"] .abyss-subtask-list`,
            index: [...container.querySelectorAll('.abyss-dep-row')].indexOf(row),
            title: relation.type === 'resolved' ? presentation.title : relation.dependencyId,
          },
        ),
    );
  }

  #bindRelationDrag(
    row: HTMLElement,
    relation: Extract<TaskDependencyRelation, { type: 'resolved' }>,
    direction: DependencyDirection,
    current: TaskNodeRef,
  ): void {
    row.draggable = true;
    row.addEventListener('dragstart', (event) => {
      event.stopPropagation();
      this.#host.finishTaskDrag();
      row.addClass('is-dragging');
      this.#host.setTaskDragCleanup(
        startTaskNodeDrag(this.#state, this.#host.root(), row, {
          payload: {
            source: 'inspector-relation',
            task: relation.task,
            relation: {
              direction,
              dependencyId: relation.dependencyId,
              blocker: direction === 'blocked-by' ? relation.task.target : current,
              dependent: direction === 'blocked-by' ? current : relation.task.target,
            },
          },
          onEnd: () => {
            row.removeClass('is-dragging');
          },
        }),
      );
    });
  }

  refresh(): void {
    this.#host.detachUndo();
    this.#surfaces.refreshStatusMarkers((task) => this.#host.isBlocked(task));
    this.updateBadge();
    this.#host.refreshTimeBadge();
    this.#surfaces.closeDependencyStatusMenu();
    this.#host
      .root()
      .querySelectorAll('.abyss-dep-section')
      .forEach((section) => {
        section.remove();
      });
    this.renderSections();
    this.#search?.refresh();
    this.#host.renderUndo();
    this.#positionDependencySearch();
  }

  showSearch(direction?: DependencyDirection): void {
    this.#surfaces.clearPopovers();
    this.#searchAnchor =
      direction === undefined
        ? '.abyss-dep-badge-body'
        : `[data-dependency-direction="${direction}"] .abyss-dep-add`;
    this.#search = mountDependencySearch(this.#host.root(), {
      direction: direction ?? 'blocked-by',
      canChangeDirection: direction === undefined,
      options: (query, chosen) => {
        const current = this.#host.dependencyTask();
        const queries = this.#queries;
        if (queries === undefined || current === undefined) return [];
        return dependencySearchOptions({
          current: taskNodeRef(current),
          direction: chosen,
          query,
          tasks: queries.listNodes(),
          eligibility: (blocker, dependent) => queries.dependencyEligibility(blocker, dependent),
        });
      },
      selectExisting: async (option, chosen) => {
        const current = this.#host.dependencyTask();
        if (current === undefined)
          return { type: 'validation-error', message: 'The current task is no longer available.' };
        const committed = await this.#commands.executeDependencyCommand({
          type: 'add-dependency',
          blocker: chosen === 'blocked-by' ? option.task.target : taskNodeRef(current),
          dependent: chosen === 'blocked-by' ? taskNodeRef(current) : option.task.target,
        });
        return { type: committed ? 'committed' : 'failed' };
      },
      createNew: (text, chosen) => this.#commands.createDependencySubtask(text, chosen),
      onClose: (restoreFocus) => {
        const surface = this.#search?.element;
        if (surface !== undefined) this.#surfaces.releasePlacement(surface);
        this.#search = undefined;
        this.updateBadge();
        if (restoreFocus) focusWithoutScroll(this.#dependencyAnchor());
      },
      ownership: this.#interactionOwnership,
      position: (element) => {
        this.#positionDependencySearch(element);
      },
    });
    this.updateBadge();
  }

  #dependencyAnchor(): HTMLElement | null {
    return (
      this.#host.root().querySelector<HTMLElement>(this.#searchAnchor) ??
      this.#host.root().querySelector<HTMLElement>('.abyss-dep-badge-body')
    );
  }

  #positionDependencySearch(element = this.#search?.element, focused?: HTMLElement | null): void {
    if (element === undefined) return;
    const anchor = this.#dependencyAnchor();
    if (anchor !== null) this.#surfaces.positionAnchoredSurface(element, anchor, 'below-start');
    if (focused != null) {
      focusWithoutScroll(
        element.contains(focused) && !focused.matches(':disabled,[hidden]')
          ? focused
          : element.querySelector<HTMLElement>('input'),
      );
    }
  }
}
