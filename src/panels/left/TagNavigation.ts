import { Menu, Notice, setIcon, type App } from 'obsidian';
import type { AppState, ListSelection } from '../../app/AppState';
import { resolveListViewStateKey } from '../../app/listViewState';
import { sameTag } from '../../markdown/tagSyntax';
import type { CalendarSettings } from '../../settings/types';
import { RenameTagModal } from '../../tags/RenameTagModal';
import type { TagManager } from '../../tags/TagManager';
import {
  isTagNavigationArchived,
  prefixForDiscoveredGroupId,
  resolveEffectiveTagGroups,
  tagMatchesGroup,
  type EffectiveTagGroup,
} from '../../tags/effectiveTagGroups';
import { tagSettingsFailureNotice } from '../../tags/tagSettingsFailure';
import { collectTaskNodeTags } from '../../tags/taskTagCatalog';
import type { TaskDependencyQueryApi, TaskNodeSnapshot, TaskSnapshot } from '../../tasks';
import {
  TagGroupAppearanceModal,
  type TagGroupAppearanceResult,
} from '../../ui/TagGroupAppearanceModal';
import { showMenuAtMouseEventWithFocus } from '../../ui/nativeMenuFocus';
import { runAsyncAction } from '../../ui/runAsyncAction';
import type { PanelNavigationActions } from '../../views/panelNavigation';

export interface TagNavigationHost {
  render(): void;
  appendCustomDot(parent: HTMLElement, selection: ListSelection): void;
  draggedCenterRoot(): TaskSnapshot | undefined;
  assignTagFromInbox(task: TaskSnapshot, tag: string): Promise<void>;
}

export interface TagNavigationOptions {
  readonly state: AppState;
  readonly settings: CalendarSettings;
  readonly tagManager: TagManager;
  readonly app: App;
  readonly navigation: PanelNavigationActions;
  readonly queries: Pick<TaskDependencyQueryApi, 'listNodes'>;
  readonly host: TagNavigationHost;
}

interface TagGroupRenderContext {
  readonly group: EffectiveTagGroup;
  readonly tags: readonly string[];
  readonly allNodes: readonly TaskNodeSnapshot[];
  readonly isExpanded: boolean;
  readonly isGroupActive: boolean;
}

/** A task is "active" (actionable) when open or in-progress — the same set the
 *  center list shows by default, so left-panel badges match the opened list. */
function isActiveTask(t: TaskSnapshot): boolean {
  return t.status === 'open' || t.status === 'in-progress';
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}

/** Tag rows, navigation origins, menus and drag; settings authority remains TagManager. */
export class TagNavigation {
  readonly #state: AppState;
  readonly #settings: CalendarSettings;
  readonly #tagManager: TagManager;
  readonly #app: App;
  readonly #navigation: PanelNavigationActions;
  readonly #queries: Pick<TaskDependencyQueryApi, 'listNodes'>;
  readonly #host: TagNavigationHost;
  readonly #expandedGroups = new Set<string>();
  readonly #explicitlyCollapsed = new Set<string>();
  // When a tag is opened from the Pinned section, don't auto-expand the group
  // that contains it in the Tags tree — the pin exists precisely to avoid that.
  #tagSelectedFromPinned = false;
  static readonly #GROUP_DND = 'application/x-abyss-taggroup';

  constructor(options: TagNavigationOptions) {
    this.#state = options.state;
    this.#settings = options.settings;
    this.#tagManager = options.tagManager;
    this.#app = options.app;
    this.#navigation = options.navigation;
    this.#queries = options.queries;
    this.#host = options.host;
  }

  renderPinnedTag(parent: HTMLElement, tag: string, allNodes: readonly TaskNodeSnapshot[]): void {
    const sel = this.#state.get('selectedList');
    const isActive = typeof sel === 'object' && sel.type === 'tag' && sameTag(sel.tag, tag);
    const count = this.#countMatchingRoots(allNodes, ({ node }) =>
      node.tags.some((candidate) => sameTag(candidate, tag)),
    );

    const row = parent.createDiv({
      cls: `abyss-left-item abyss-pinned-tag${isActive ? ' is-active' : ''}`,
    });
    row.createDiv({ cls: 'abyss-left-item-left' }, (l) => {
      l.createSpan({ cls: 'abyss-left-label', text: tag });
      this.#host.appendCustomDot(l, { type: 'tag', tag });
    });
    if (count > 0) row.createSpan({ cls: 'abyss-left-count', text: String(count) });

    row.addEventListener('click', () => {
      this.#tagSelectedFromPinned = true;
      this.#navigation.openList({ type: 'tag', tag });
    });

    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      this.#showPinnedTagMenu(e, tag);
    });

    this.#attachTagDragSource(row, tag);
    this.#attachDropZone(row, tag);
  }

  /** A flat, non-expandable tag row (used for manual single-tag groups). */
  #renderTagLeaf(
    parent: HTMLElement,
    group: EffectiveTagGroup,
    tag: string,
    allNodes: readonly TaskNodeSnapshot[],
  ): void {
    const sel = this.#state.get('selectedList');
    const isActive = typeof sel === 'object' && sel.type === 'tag' && sameTag(sel.tag, tag);
    const count = this.#countMatchingRoots(allNodes, ({ node }) =>
      node.tags.some((candidate) => sameTag(candidate, tag)),
    );

    const row = parent.createDiv({
      cls: `abyss-left-item abyss-tag-leaf${isActive ? ' is-active' : ''}`,
    });
    row.createDiv({ cls: 'abyss-left-item-left' }, (l) => {
      // Match group rows: a color dot + the group name (no leading '#').
      if (group.color !== undefined && group.color !== '') {
        const dot = l.createSpan({ cls: 'abyss-group-dot' });
        dot.style.background = group.color;
      }
      l.createSpan({ cls: 'abyss-left-label', text: group.name });
      this.#host.appendCustomDot(l, { type: 'tag', tag });
    });
    if (count > 0) row.createSpan({ cls: 'abyss-left-count', text: String(count) });

    row.addEventListener('click', () => {
      this.#tagSelectedFromPinned = false;
      this.#navigation.openList({ type: 'tag', tag });
    });
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.#showTagGroupMenu(e, group, tag);
    });
    this.#attachTagDragSource(row, tag);
    this.#attachDropZone(row, tag);
    this.#attachGroupReorder(row, group.id);
  }

  renderTagGroup(
    parent: HTMLElement,
    group: EffectiveTagGroup,
    allNodes: readonly TaskNodeSnapshot[],
  ): void {
    if (this.#renderSingleTagGroup(parent, group, allNodes)) return;
    const sel = this.#state.get('selectedList');
    const isGroupActive =
      typeof sel === 'object' && sel.type === 'group' && this.#selectionMatchesGroup(sel, group);
    const tags = this.#resolveGroupTags(group, allNodes).filter(
      (tag) => !isTagNavigationArchived(this.#settings, tag),
    );
    const hasActiveChild = tags.some(
      (t) => typeof sel === 'object' && sel.type === 'tag' && sameTag(sel.tag, t),
    );
    this.#expandActiveTagGroup(group.id, hasActiveChild);
    const isExpanded = this.#expandedGroups.has(group.id);
    const container = parent.createDiv({ cls: 'abyss-tag-group' });
    const context = { group, tags, allNodes, isExpanded, isGroupActive };
    this.#renderTagGroupHeader(container, context);
    if (isExpanded) this.#renderTagGroupChildren(container, context);
  }

  #renderSingleTagGroup(
    parent: HTMLElement,
    group: EffectiveTagGroup,
    allNodes: readonly TaskNodeSnapshot[],
  ): boolean {
    const soleTag = group.mode === 'manual' && group.tags?.length === 1 ? group.tags[0] : undefined;
    if (soleTag === undefined) return false;
    if (!this.#settings.archivedTags.some((candidate) => sameTag(candidate, soleTag))) {
      this.#renderTagLeaf(parent, group, soleTag, allNodes);
    }
    return true;
  }

  #expandActiveTagGroup(groupId: string, hasActiveChild: boolean): void {
    if (!hasActiveChild || this.#explicitlyCollapsed.has(groupId) || this.#tagSelectedFromPinned) {
      return;
    }
    this.#expandedGroups.add(groupId);
  }

  #renderTagGroupHeader(container: HTMLElement, context: TagGroupRenderContext): void {
    const { group, allNodes, isExpanded, isGroupActive } = context;
    const header = container.createDiv({
      cls: `abyss-tag-group-header${isGroupActive ? ' is-active' : ''}`,
    });
    this.#attachGroupReorder(header, group.id);
    const chevron = header.createSpan({
      cls: `abyss-left-icon abyss-group-arrow${isExpanded ? ' is-open' : ''}`,
    });
    setIcon(chevron, isExpanded ? 'chevron-down' : 'chevron-right');
    chevron.addEventListener('click', (e) => {
      e.stopPropagation();
      this.#toggleTagGroup(group.id);
      this.#host.render();
    });
    if (group.color !== undefined && group.color !== '') {
      const dot = header.createSpan({ cls: 'abyss-group-dot' });
      dot.style.background = group.color;
    }
    header.createSpan({ cls: 'abyss-left-label', text: group.name });
    this.#host.appendCustomDot(header, { type: 'group', groupId: group.id });

    const groupCount = this.#tagGroupTaskCount(group, allNodes);
    if (groupCount > 0) {
      header.createSpan({ cls: 'abyss-left-count', text: String(groupCount) });
    }
    header.addEventListener('click', () => {
      this.#navigation.openList({ type: 'group', groupId: group.id });
    });
    header.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.#showTagGroupMenu(e, group);
    });
  }

  #tagGroupTaskCount(group: EffectiveTagGroup, allNodes: readonly TaskNodeSnapshot[]): number {
    return this.#countMatchingRoots(allNodes, ({ node }) =>
      node.tags.some((tag) => tagMatchesGroup(tag, group)),
    );
  }

  #toggleTagGroup(groupId: string): void {
    if (this.#expandedGroups.has(groupId)) {
      this.#expandedGroups.delete(groupId);
      this.#explicitlyCollapsed.add(groupId);
    } else {
      this.#expandedGroups.add(groupId);
      this.#explicitlyCollapsed.delete(groupId);
    }
  }

  #renderTagGroupChildren(container: HTMLElement, context: TagGroupRenderContext): void {
    const children = container.createDiv({ cls: 'abyss-tag-group-children' });
    for (const tag of context.tags) {
      this.#renderTagGroupChild(children, context.group, tag, context.allNodes);
    }
  }

  #renderTagGroupChild(
    parent: HTMLElement,
    group: EffectiveTagGroup,
    tag: string,
    allNodes: readonly TaskNodeSnapshot[],
  ): void {
    const prefix = group.mode === 'prefix' ? group.prefix : undefined;
    const label = prefix !== undefined && prefix.length > 0 ? tag.replace(`#${prefix}/`, '') : tag;
    const selected = this.#state.get('selectedList');
    const isActive =
      typeof selected === 'object' && selected.type === 'tag' && sameTag(selected.tag, tag);
    const count = this.#countMatchingRoots(allNodes, ({ node }) =>
      node.tags.some((candidate) => sameTag(candidate, tag)),
    );
    const child = parent.createDiv({
      cls: `abyss-left-item abyss-tag-child${isActive ? ' is-active' : ''}`,
    });
    child.createDiv({ cls: 'abyss-left-item-left' }, (left) => {
      left.createSpan({ cls: 'abyss-left-label', text: label });
      this.#host.appendCustomDot(left, { type: 'tag', tag });
    });
    if (count > 0) child.createSpan({ cls: 'abyss-left-count', text: String(count) });
    child.addEventListener('click', (event) => {
      event.stopPropagation();
      this.#tagSelectedFromPinned = false;
      this.#navigation.openList({ type: 'tag', tag });
    });
    child.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      this.#showChildTagMenu(event, tag);
    });
    this.#attachTagDragSource(child, tag);
    this.#attachDropZone(child, tag);
  }

  #showPinnedTagMenu(e: MouseEvent, tag: string): void {
    const menu = new Menu();
    menu.addItem((item) =>
      item
        .setTitle('Unpin')
        .setIcon('pin-off')
        .onClick(this.#makeTagOp(() => this.#setTagPinned(tag, false))),
    );
    menu.addItem((item) =>
      item
        .setTitle('Archive')
        .setIcon('archive')
        .onClick(this.#makeTagOp(() => this.#archiveTagNavigation(tag))),
    );
    menu.addItem((item) =>
      item
        .setTitle('Rename tag across vault…')
        .setIcon('pencil')
        .onClick(() => {
          new RenameTagModal(this.#app, this.#tagManager, tag, () => {
            this.#host.render();
          }).open();
        }),
    );
    showMenuAtMouseEventWithFocus(menu, e);
  }

  #showChildTagMenu(e: MouseEvent, tag: string): void {
    const isPinned = this.#settings.pinnedTags.some((candidate) => sameTag(candidate, tag));
    const menu = new Menu();
    menu.addItem((item) =>
      item
        .setTitle(isPinned ? 'Unpin' : 'Pin')
        .setIcon(isPinned ? 'pin-off' : 'pin')
        .onClick(this.#makeTagOp(() => this.#setTagPinned(tag, !isPinned))),
    );
    menu.addItem((item) =>
      item
        .setTitle('Archive')
        .setIcon('archive')
        .onClick(this.#makeTagOp(() => this.#archiveTagNavigation(tag))),
    );
    menu.addItem((item) =>
      item
        .setTitle('Rename tag across vault…')
        .setIcon('pencil')
        .onClick(() => {
          new RenameTagModal(this.#app, this.#tagManager, tag, () => {
            this.#host.render();
          }).open();
        }),
    );
    showMenuAtMouseEventWithFocus(menu, e);
  }

  #showTagGroupMenu(e: MouseEvent, group: EffectiveTagGroup, flattenedTag?: string): void {
    const menu = new Menu();
    menu.addItem((item) =>
      item
        .setTitle('Rename display name…')
        .setIcon('pencil')
        .onClick(() => {
          this.#openTagGroupAppearance(group, 'name');
        }),
    );
    menu.addItem((item) =>
      item
        .setTitle('Change color…')
        .setIcon('palette')
        .onClick(() => {
          this.#openTagGroupAppearance(group, 'color');
        }),
    );

    if (group.mode === 'prefix' && group.prefix !== undefined && group.prefix !== '') {
      const prefix = `#${group.prefix}`;
      menu.addItem((item) =>
        item
          .setTitle('Rename prefix across vault…')
          .setIcon('replace')
          .onClick(() => {
            this.#openTagGroupPrefixRename(prefix);
          }),
      );
    } else {
      const tags = uniqueStrings(
        flattenedTag !== undefined && flattenedTag !== '' ? [flattenedTag] : (group.tags ?? []),
      );
      for (const tag of tags) {
        menu.addItem((item) =>
          item
            .setTitle(`Rename ${tag} across vault…`)
            .setIcon('replace')
            .onClick(() => {
              new RenameTagModal(this.#app, this.#tagManager, tag, () => {
                this.#host.render();
              }).open();
            }),
        );
      }
    }

    if (flattenedTag !== undefined && flattenedTag !== '') {
      const isPinned = this.#settings.pinnedTags.some((candidate) =>
        sameTag(candidate, flattenedTag),
      );
      menu.addItem((item) =>
        item
          .setTitle(isPinned ? 'Unpin' : 'Pin')
          .setIcon(isPinned ? 'pin-off' : 'pin')
          .onClick(this.#makeTagOp(() => this.#setTagPinned(flattenedTag, !isPinned))),
      );
    }
    menu.addItem((item) =>
      item
        .setTitle('Archive')
        .setIcon('archive')
        .onClick(this.#makeTagOp(() => this.#archiveGroupNavigation(group))),
    );
    showMenuAtMouseEventWithFocus(menu, e);
  }

  /**
   * Pin and Unpin share the tag settings failure policy. `pinTag` and `unpinTag` restore exactly
   * the array they replaced, and only when no newer save started, so the array read just before
   * the change means the rollback ran; any other array means a newer save kept the change.
   */
  async #setTagPinned(tag: string, pinned: boolean): Promise<void> {
    const before = this.#settings.pinnedTags;
    await this.#runTagSettingsAction(
      pinned ? this.#tagManager.pinTag(tag) : this.#tagManager.unpinTag(tag),
      pinned ? 'pin tag' : 'unpin tag',
      () => this.#settings.pinnedTags === before,
    );
  }

  async #archiveTagNavigation(tag: string): Promise<void> {
    const saved = await this.#runTagSettingsAction(
      this.#tagManager.archiveTag(tag),
      'archive tag',
      () => !this.#settings.archivedTags.some((candidate) => sameTag(candidate, tag)),
    );
    if (!saved) return;
    const selected = this.#state.get('selectedList');
    if (typeof selected === 'object' && selected.type === 'tag' && sameTag(selected.tag, tag)) {
      this.#navigation.openList('today');
    }
  }

  async #archiveGroupNavigation(group: EffectiveTagGroup): Promise<void> {
    const saved = await this.#runTagSettingsAction(
      this.#tagManager.archiveGroup(group),
      'archive tag group',
      () => !this.#isEffectiveGroupArchived(group.id),
    );
    if (!saved) return;
    const selected = this.#state.get('selectedList');
    if (this.#selectionMatchesGroup(selected, group)) {
      this.#navigation.openList('today');
    }
  }

  async #runTagSettingsAction(
    operation: Promise<void>,
    description: string,
    rolledBack: () => boolean,
  ): Promise<boolean> {
    try {
      await operation;
      return true;
    } catch (error) {
      console.error(`[abyss-tasks] Could not ${description}`, error);
      new Notice(tagSettingsFailureNotice(description, rolledBack()));
      return false;
    }
  }

  #isEffectiveGroupArchived(groupId: string): boolean {
    return (
      resolveEffectiveTagGroups(
        this.#settings,
        collectTaskNodeTags(this.#queries.listNodes()),
      ).find((group) => group.id === groupId)?.archived === true
    );
  }

  #selectionMatchesGroup(selected: ListSelection, group: EffectiveTagGroup): boolean {
    if (typeof selected !== 'object') return false;
    if (selected.type === 'group') {
      const ids = new Set(this.#settings.tagGroups.map((candidate) => candidate.id));
      return (
        resolveListViewStateKey(selected, undefined, ids) ===
        resolveListViewStateKey({ type: 'group', groupId: group.id }, undefined, ids)
      );
    }
    return (
      selected.type === 'tag' &&
      group.mode === 'manual' &&
      group.tags?.length === 1 &&
      sameTag(selected.tag, group.tags[0] ?? '')
    );
  }

  #openTagGroupPrefixRename(prefix: string): void {
    new RenameTagModal(
      this.#app,
      this.#tagManager,
      prefix,
      () => {
        this.#host.render();
      },
      'prefix',
    ).open();
  }

  #openTagGroupAppearance(group: EffectiveTagGroup, field: 'name' | 'color'): void {
    new TagGroupAppearanceModal(
      this.#app,
      { name: group.name, ...(group.color !== undefined && { color: group.color }) },
      (result) => {
        this.#applyTagGroupAppearance(group, result);
      },
      field,
    ).open();
  }

  #applyTagGroupAppearance(group: EffectiveTagGroup, result: TagGroupAppearanceResult): void {
    if (result.name === undefined && result.color === undefined) return;
    const previous = { name: group.name, color: group.color };
    const update = {
      ...(result.name === undefined ? {} : { name: result.name }),
      ...(result.color === undefined ? {} : { color: result.color ?? undefined }),
    };
    runAsyncAction(
      this.#runTagSettingsAction(
        this.#tagManager.updateGroup(group, update),
        'update tag group',
        () => {
          const current = this.#settings.tagGroups.find((candidate) => candidate.id === group.id);
          return (
            current === undefined ||
            (current.name === previous.name && current.color === previous.color)
          );
        },
      ).then(() => {
        this.#host.render();
      }),
    );
  }

  #makeTagOp(op: () => Promise<void>): () => void {
    return () => {
      runAsyncAction(
        op().then(() => {
          this.#host.render();
        }),
      );
    };
  }

  /**
   * Makes a tag-group row a drag source AND drop target for reordering groups on
   * the left panel, persisting the new order. Uses a dedicated dataTransfer type
   * so it never collides with the tag→task assignment drag (`draggingTag`).
   */
  #attachGroupReorder(el: HTMLElement, groupId: string): void {
    el.setAttribute('draggable', 'true');
    el.addEventListener('dragstart', (e) => {
      e.stopPropagation();
      e.dataTransfer?.setData(TagNavigation.#GROUP_DND, groupId);
      el.classList.add('abyss-dragging');
    });
    el.addEventListener('dragend', () => {
      el.classList.remove('abyss-dragging');
    });
    el.addEventListener('dragover', (e) => {
      if (!(e.dataTransfer?.types.includes(TagNavigation.#GROUP_DND) ?? false)) return;
      e.preventDefault();
      el.classList.add('abyss-reorder-target');
    });
    el.addEventListener('dragleave', () => {
      el.classList.remove('abyss-reorder-target');
    });
    el.addEventListener('drop', (e) => {
      const draggedId = e.dataTransfer?.getData(TagNavigation.#GROUP_DND);
      el.classList.remove('abyss-reorder-target');
      if (draggedId === undefined || draggedId === '' || draggedId === groupId) return;
      e.preventDefault();
      e.stopPropagation();
      runAsyncAction(this.#reorderTagGroups(draggedId, groupId));
    });
  }

  async #reorderTagGroups(draggedId: string, targetId: string): Promise<void> {
    const groups = resolveEffectiveTagGroups(
      this.#settings,
      collectTaskNodeTags(this.#queries.listNodes()),
    ).filter((group) => !group.archived);
    const previousOrder = this.#settings.tagGroups.map(({ id }) => id).join('\0');
    await this.#runTagSettingsAction(
      this.#tagManager.reorderGroups(draggedId, targetId, groups),
      'reorder tag groups',
      () => this.#settings.tagGroups.map(({ id }) => id).join('\0') === previousOrder,
    );
    this.#host.render();
  }

  #attachTagDragSource(el: HTMLElement, tag: string): void {
    el.setAttribute('draggable', 'true');
    el.addEventListener('dragstart', (e) => {
      e.stopPropagation();
      this.#state.set('draggingTag', tag);
      el.classList.add('abyss-dragging');
    });
    el.addEventListener('dragend', () => {
      this.#state.set('draggingTag', null);
      el.classList.remove('abyss-dragging');
    });
  }

  #attachDropZone(el: HTMLElement, tag: string): void {
    el.addEventListener('dragover', (e) => {
      if (this.#host.draggedCenterRoot() == null) return;
      e.preventDefault();
      el.classList.add('abyss-drop-target');
    });
    el.addEventListener('dragleave', () => {
      el.classList.remove('abyss-drop-target');
    });
    el.addEventListener('drop', (e) => {
      el.classList.remove('abyss-drop-target');
      const dragging = this.#host.draggedCenterRoot();
      if (dragging == null) return;
      e.preventDefault();
      runAsyncAction(this.#host.assignTagFromInbox(dragging, tag));
    });
  }

  #resolveGroupTags(group: EffectiveTagGroup, allNodes: readonly TaskNodeSnapshot[]): string[] {
    if (group.mode === 'prefix' && group.prefix !== undefined && group.prefix.length > 0) {
      return this.#collectPrefixTags(group, allNodes);
    }
    return group.tags ?? [];
  }

  #collectPrefixTags(group: EffectiveTagGroup, allNodes: readonly TaskNodeSnapshot[]): string[] {
    const found = new Set<string>();
    for (const { node } of allNodes) {
      for (const tag of node.tags) {
        if (
          tag.includes('/') &&
          tagMatchesGroup(tag, group) &&
          !this.#isClaimedAutomaticChild(group, tag) &&
          ![...found].some((candidate) => sameTag(candidate, tag))
        )
          found.add(tag);
      }
    }
    return Array.from(found).sort((left, right) => left.localeCompare(right));
  }

  #isClaimedAutomaticChild(group: EffectiveTagGroup, tag: string): boolean {
    if (prefixForDiscoveredGroupId(group.id) === undefined) return false;
    return this.#settings.tagGroups.some(
      (candidate) => candidate.id !== group.id && tagMatchesGroup(tag, candidate),
    );
  }

  #countMatchingRoots(
    allNodes: readonly TaskNodeSnapshot[],
    matches: (node: TaskNodeSnapshot) => boolean,
  ): number {
    const roots = new Set<string>();
    for (const candidate of allNodes) {
      if (!isActiveTask(candidate.root) || !matches(candidate)) continue;
      roots.add(
        `${candidate.root.source.filePath}:${candidate.root.source.line}:${candidate.root.ref.revision}`,
      );
    }
    return roots.size;
  }
}
