import { Menu, setIcon, TFile, type App } from 'obsidian';
import type { AppState, ListSelection } from '../app/AppState';
import { isListViewCustomized, listSelectionToKey } from '../app/listViewState';
import type { ProjectManager } from '../projects/ProjectManager';
import type { ProjectStore } from '../projects/ProjectStore';
import type { CalendarSettings, TagGroup } from '../settings/types';
import { RenameTagModal } from '../tags/RenameTagModal';
import type { TagManager } from '../tags/TagManager';
import type { TaskApplicationApi, TaskQueryApi, TaskSnapshot } from '../tasks';
import {
  TagGroupAppearanceModal,
  type TagGroupAppearanceResult,
} from '../ui/TagGroupAppearanceModal';
import { moveTaskToProjectWithRecovery } from '../ui/moveTaskToProject';
import { presentTaskCommandResult } from '../ui/taskCommandResult';

const PROJECTS_CAP = 10;

/** A task is "active" (actionable) when open or in-progress — the same set the
 *  center list shows by default, so left-panel badges match the opened list. */
function isActiveTask(t: TaskSnapshot): boolean {
  return t.status === 'open' || t.status === 'in-progress';
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}

export class LeftPanel {
  private el!: HTMLElement;
  private offs: Array<() => void> = [];
  private expandedGroups = new Set<string>();
  private explicitlyCollapsed = new Set<string>();
  private showAllProjects = false;
  // When a tag is opened from the Pinned section, don't auto-expand the group
  // that contains it in the Tags tree — the pin exists precisely to avoid that.
  private tagSelectedFromPinned = false;

  constructor(
    private state: AppState,
    private settings: CalendarSettings,
    private tagManager: TagManager,
    private app: App,
    private queries: TaskQueryApi,
    private tasks: TaskApplicationApi,
    private onSaveSettings: () => Promise<void> = async () => {},
    private projectStore: ProjectStore | null = null,
    private projectManager: ProjectManager | null = null,
  ) {}

  mount(container: HTMLElement): void {
    this.el = container;
    this.offs.push(
      this.state.on('selectedList', () => this.render()),
      this.state.on('mode', () => this.render()),
      // Re-render when the active container's view state changes so the
      // "customized" dot appears/disappears live as filters/sort/group change.
      this.state.on('centerListViewState', () => this.render()),
    );
    this.render();
  }

  refresh(): void {
    this.render();
  }

  destroy(): void {
    this.offs.forEach((f) => f());
    this.el?.empty();
  }

  /** Append the "customized" dot after a container label when its saved view
   *  state differs from defaults (group/sort/show changed or any filter set). */
  private appendCustomDot(labelParent: HTMLElement, sel: ListSelection): void {
    const key = listSelectionToKey(sel);
    const vs = this.settings.listViewStates?.[key];
    if (vs && isListViewCustomized(vs, key)) {
      labelParent.createEl('span', {
        cls: 'tc-left-custom-dot',
        attr: { role: 'img', 'aria-label': 'Custom view applied' },
      });
    }
  }

  private render(): void {
    this.el.empty();
    const mode = this.state.get('mode');
    // The projects mode is a self-contained deep view; search hides the left panel too.
    if (mode === 'search' || mode === 'projects') return;

    const allTasks = [...this.queries.list()];
    const today = window.moment().format('YYYY-MM-DD');

    this.el.createDiv({ cls: 'tc-left-section' }, (section) => {
      this.renderSmartList(section, 'inbox', 'Inbox', 'inbox', this.countInbox(allTasks));
      this.renderSmartList(section, 'today', 'Today', 'calendar', this.countToday(allTasks, today));
      this.renderSmartList(
        section,
        'upcoming',
        'Upcoming',
        'arrow-up-right',
        this.countUpcoming(allTasks, today),
      );
    });

    // Pinned section (collapsible)
    if (this.settings.pinnedTags.length > 0) {
      this.renderCollapsibleSection('pinned', 'Pinned', null, (body) => {
        for (const tag of this.settings.pinnedTags) {
          this.renderPinnedTag(body, tag, allTasks);
        }
      });
    }

    // Projects section (collapsible) — only active (onLeftPanel) projects
    const activeProjects = this.projectStore?.activeForLeftPanel() ?? [];
    if (activeProjects.length > 0) {
      this.renderCollapsibleSection(
        'projects',
        'Projects',
        this.projectManager
          ? (): void =>
              this.startInlineAdd('projects', 'Project name…', (name) => this.createProject(name))
          : null,
        (body) => this.renderProjectsList(body, activeProjects),
      );
    }

    // Tag groups (collapsible; archived tags filtered out). The section always
    // renders so the "+" (zero-friction tag entry) stays discoverable.
    const groups = this.settings.tagGroups;
    this.renderCollapsibleSection(
      'tags',
      'Tags',
      (): void =>
        this.startInlineAdd('tags', 'Tag name…', (name) => this.tagManager.createManualGroup(name)),
      (body) => {
        for (const group of groups) {
          this.renderTagGroup(body, group, allTasks);
        }
      },
    );
  }

  private async createProject(name: string): Promise<void> {
    if (!this.projectManager) return;
    await this.projectManager.create(name);
    this.projectStore?.refresh();
  }

  /**
   * A left-panel section with a persisted collapse state, an SVG chevron, and an
   * optional "+" add action. Collapse toggles `settings.sectionCollapse[key]`.
   */
  private renderCollapsibleSection(
    key: 'pinned' | 'projects' | 'tags',
    title: string,
    addAction: (() => void) | null,
    body: (bodyEl: HTMLElement) => void,
  ): void {
    const collapsed = this.settings.sectionCollapse[key];
    const section = this.el.createDiv({ cls: `tc-left-section tc-left-section--${key}` });

    const header = section.createDiv({
      cls: 'tc-left-section-header tc-left-section-header--collapsible',
    });
    const chevron = header.createSpan({ cls: 'tc-left-section-chevron' });
    setIcon(chevron, collapsed ? 'chevron-right' : 'chevron-down');
    header.createSpan({ cls: 'tc-left-section-title', text: title });

    if (addAction) {
      const add = header.createSpan({
        cls: 'tc-left-add',
        attr: { 'aria-label': `Add to ${title}` },
      });
      setIcon(add, 'plus');
      add.addEventListener('click', (e) => {
        e.stopPropagation();
        addAction();
      });
    }

    header.addEventListener('click', () => {
      this.settings.sectionCollapse[key] = !collapsed;
      void this.onSaveSettings();
      this.render();
    });

    if (!collapsed) {
      const bodyEl = section.createDiv({ cls: 'tc-left-section-body' });
      body(bodyEl);
    }
  }

  private renderProjectsList(
    parent: HTMLElement,
    projects: ReturnType<ProjectStore['activeForLeftPanel']>,
  ): void {
    const visible = this.showAllProjects ? projects : projects.slice(0, PROJECTS_CAP);
    const sel = this.state.get('selectedList');
    // Project colour is derived from its status colour (same source the Projects
    // overview uses); build the lookup once per render.
    const statusById = new Map(this.settings.projects.statuses.map((s) => [s.id, s]));
    for (const project of visible) {
      const isActive =
        typeof sel === 'object' && sel.type === 'project' && sel.path === project.path;
      // Active (open + in-progress) derived from precomputed stats — O(1), and
      // equals what the center list shows when you open the project.
      const openCount = project.stats.total - project.stats.done - project.stats.cancelled;
      const row = parent.createDiv({
        cls: `tc-left-item tc-project-item${isActive ? ' is-active' : ''}`,
      });
      row.createDiv({ cls: 'tc-left-item-left' }, (l) => {
        // Diamond colour indicator — deliberately not round, to read differently
        // from the round tag dots. Colour comes from the project's status.
        const status = project.statusId ? statusById.get(project.statusId) : undefined;
        const dot = l.createEl('span', { cls: 'tc-project-dot' });
        if (status?.color) dot.style.background = status.color;
        l.createEl('span', { cls: 'tc-left-label', text: project.name });
        this.appendCustomDot(l, { type: 'project', path: project.path });
      });
      this.attachProjectDropZone(row, project.path);
      this.attachProjectDragSource(row, project.path);
      if (openCount > 0) {
        row.createEl('span', { cls: 'tc-left-count', text: String(openCount) });
      }
      row.addEventListener('click', () => {
        this.state.set('selectedList', { type: 'project', path: project.path });
        this.state.set('mode', 'tasks');
      });
      row.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        this.showProjectMenu(e, project);
      });
    }

    if (!this.showAllProjects && projects.length > PROJECTS_CAP) {
      const more = parent.createDiv({ cls: 'tc-left-item tc-left-showmore' });
      more.createEl('span', {
        cls: 'tc-left-label',
        text: `Show ${projects.length - PROJECTS_CAP} more…`,
      });
      more.addEventListener('click', () => {
        this.showAllProjects = true;
        this.render();
      });
    }
  }

  /**
   * Shows an inline text input directly under a section header (not at the
   * bottom, which breaks with many rows). Used for both tag and project entry so
   * the "+" affordance behaves identically everywhere. A `committed` guard
   * prevents the Enter→re-render→blur sequence from firing twice.
   */
  private startInlineAdd(
    key: 'tags' | 'projects',
    placeholder: string,
    onCommit: (name: string) => Promise<void>,
  ): void {
    // Ensure the section is expanded so the input is visible.
    if (this.settings.sectionCollapse[key]) {
      this.settings.sectionCollapse[key] = false;
      void this.onSaveSettings();
      this.render();
    }
    const section = this.el.querySelector(`.tc-left-section--${key}`);
    if (!section) return;
    const existing = section.querySelector('.tc-left-add-input');
    if (existing) {
      (existing as HTMLInputElement).focus();
      return;
    }
    const body =
      section.querySelector('.tc-left-section-body') ??
      section.createDiv({ cls: 'tc-left-section-body' });
    const input = body.createEl('input', {
      cls: 'tc-left-add-input',
      attr: { type: 'text', placeholder },
    });
    // Place it directly under the header, above existing rows.
    body.insertBefore(input, body.firstChild);

    let committed = false;
    const commit = (): void => {
      if (committed) return;
      committed = true;
      const value = input.value.trim();
      if (value) void onCommit(value).then(() => this.render());
      else this.render();
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        commit();
      }
      if (e.key === 'Escape') {
        committed = true;
        this.render();
      }
    });
    input.addEventListener('blur', () => {
      window.setTimeout(() => {
        if (activeDocument.activeElement !== input) commit();
      }, 150);
    });
    window.setTimeout(() => input.focus(), 0);
  }

  private showProjectMenu(
    e: MouseEvent,
    project: ReturnType<ProjectStore['activeForLeftPanel']>[number],
  ): void {
    const menu = new Menu();
    const statuses = this.settings.projects.statuses;
    if (statuses.length > 0 && this.projectManager) {
      menu.addItem((item) => {
        item.setTitle('Change status').setIcon('circle-dot');
        // setSubmenu is available at runtime but not in the public typings.
        const sub = (item as unknown as { setSubmenu: () => Menu }).setSubmenu();
        for (const s of statuses) {
          sub.addItem((si) =>
            si
              .setTitle(s.label)
              .setChecked(s.id === project.statusId)
              .onClick(() => this.changeProjectStatus(project.path, s.id)),
          );
        }
      });
    }
    menu.addItem((item) =>
      item
        .setTitle('Open note')
        .setIcon('file-text')
        .onClick(() => this.openProjectNote(project.path)),
    );
    menu.showAtMouseEvent(e);
  }

  private changeProjectStatus(path: string, statusId: string): void {
    void this.projectManager?.setStatus(path, statusId).then(() => {
      this.projectStore?.refresh();
      this.render();
    });
  }

  private openProjectNote(path: string): void {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (file instanceof TFile) void this.app.workspace.getLeaf(false).openFile(file);
  }

  private renderPinnedTag(parent: HTMLElement, tag: string, allTasks: TaskSnapshot[]): void {
    const sel = this.state.get('selectedList');
    const isActive = typeof sel === 'object' && sel.type === 'tag' && sel.tag === tag;
    const count = allTasks.filter((t) => isActiveTask(t) && t.tags?.includes(tag) === true).length;

    const row = parent.createDiv({
      cls: `tc-left-item tc-pinned-tag${isActive ? ' is-active' : ''}`,
    });
    row.createDiv({ cls: 'tc-left-item-left' }, (l) => {
      l.createEl('span', { cls: 'tc-left-label', text: tag });
      this.appendCustomDot(l, { type: 'tag', tag });
    });
    if (count > 0) row.createEl('span', { cls: 'tc-left-count', text: String(count) });

    row.addEventListener('click', () => {
      this.tagSelectedFromPinned = true;
      this.state.set('selectedList', { type: 'tag', tag });
      this.state.set('mode', 'tasks');
    });

    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      this.showPinnedTagMenu(e, tag);
    });

    this.attachTagDragSource(row, tag);
    this.attachDropZone(row, tag);
  }

  /** A flat, non-expandable tag row (used for manual single-tag groups). */
  private renderTagLeaf(
    parent: HTMLElement,
    group: TagGroup,
    tag: string,
    allTasks: TaskSnapshot[],
  ): void {
    const sel = this.state.get('selectedList');
    const isActive = typeof sel === 'object' && sel.type === 'tag' && sel.tag === tag;
    const count = allTasks.filter((t) => isActiveTask(t) && t.tags?.includes(tag) === true).length;

    const row = parent.createDiv({
      cls: `tc-left-item tc-tag-leaf${isActive ? ' is-active' : ''}`,
    });
    row.createDiv({ cls: 'tc-left-item-left' }, (l) => {
      // Match group rows: a color dot + the group name (no leading '#').
      if (group.color) {
        const dot = l.createEl('span', { cls: 'tc-group-dot' });
        dot.style.background = group.color;
      }
      l.createEl('span', { cls: 'tc-left-label', text: group.name });
      this.appendCustomDot(l, { type: 'tag', tag });
    });
    if (count > 0) row.createEl('span', { cls: 'tc-left-count', text: String(count) });

    row.addEventListener('click', () => {
      this.tagSelectedFromPinned = false;
      this.state.set('selectedList', { type: 'tag', tag });
      this.state.set('mode', 'tasks');
    });
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.showTagGroupMenu(e, group, tag);
    });
    this.attachTagDragSource(row, tag);
    this.attachDropZone(row, tag);
    this.attachGroupReorder(row, group.id);
  }

  private renderSmartList(
    parent: HTMLElement,
    selection: ListSelection,
    label: string,
    icon: string,
    count: number,
  ): void {
    const current = this.state.get('selectedList');
    const isActive = current === selection;
    const row = parent.createDiv({ cls: `tc-left-item${isActive ? ' is-active' : ''}` });

    const left = row.createDiv({ cls: 'tc-left-item-left' });
    const iconEl = left.createEl('span', { cls: 'tc-left-icon' });
    setIcon(iconEl, icon);
    left.createEl('span', { cls: 'tc-left-label', text: label });
    this.appendCustomDot(left, selection);

    if (count > 0) {
      row.createEl('span', { cls: 'tc-left-count', text: String(count) });
    }

    row.addEventListener('click', () => {
      this.state.set('selectedList', selection);
      this.state.set('mode', 'tasks');
    });
  }

  private renderTagGroup(parent: HTMLElement, group: TagGroup, allTasks: TaskSnapshot[]): void {
    const sel = this.state.get('selectedList');

    // A manual group holding a single tag is a leaf, not an expandable group —
    // you can't nest more tags under it, so a chevron would be misleading.
    if (group.mode === 'manual' && (group.tags?.length ?? 0) === 1) {
      const soleTag = group.tags![0]!;
      if (!this.settings.archivedTags.includes(soleTag)) {
        this.renderTagLeaf(parent, group, soleTag, allTasks);
      }
      return;
    }

    const isGroupActive =
      typeof sel === 'object' && sel.type === 'group' && sel.groupId === group.id;

    const tags = this.resolveGroupTags(group, allTasks).filter(
      (t) => !this.settings.archivedTags.includes(t),
    );

    const hasActiveChild = tags.some(
      (t) => typeof sel === 'object' && sel.type === 'tag' && sel.tag === t,
    );
    // Auto-expand when a child is active, UNLESS the user explicitly collapsed
    // this group, or the tag was opened from the Pinned section (pinning exists
    // precisely to reach the tag without unfolding the tree).
    if (hasActiveChild && !this.explicitlyCollapsed.has(group.id) && !this.tagSelectedFromPinned) {
      this.expandedGroups.add(group.id);
    }

    const isExpanded = this.expandedGroups.has(group.id);

    const container = parent.createDiv({ cls: 'tc-tag-group' });
    const header = container.createDiv({
      cls: `tc-tag-group-header${isGroupActive ? ' is-active' : ''}`,
    });
    this.attachGroupReorder(header, group.id);

    // Chevron: toggles expand/collapse only, does NOT select the group
    const chevron = header.createEl('span', {
      cls: `tc-left-icon tc-group-arrow${isExpanded ? ' is-open' : ''}`,
    });
    setIcon(chevron, isExpanded ? 'chevron-down' : 'chevron-right');
    chevron.addEventListener('click', (e) => {
      e.stopPropagation();
      if (isExpanded) {
        this.expandedGroups.delete(group.id);
        this.explicitlyCollapsed.add(group.id);
      } else {
        this.expandedGroups.add(group.id);
        this.explicitlyCollapsed.delete(group.id);
      }
      this.render();
    });

    if (group.color) {
      const dot = header.createEl('span', { cls: 'tc-group-dot' });
      dot.style.background = group.color;
    }
    header.createEl('span', { cls: 'tc-left-label', text: group.name });
    this.appendCustomDot(header, { type: 'group', groupId: group.id });

    // Count all tasks matching any tag in this group (including root prefix tag)
    const rootTag = group.mode === 'prefix' && group.prefix ? `#${group.prefix}` : null;
    const allGroupTags = rootTag ? [rootTag, ...tags] : tags;
    const groupCount = allTasks.filter(
      (t) => isActiveTask(t) && allGroupTags.some((tag) => t.tags?.includes(tag) === true),
    ).length;
    if (groupCount > 0) {
      header.createEl('span', { cls: 'tc-left-count', text: String(groupCount) });
    }

    // Header click: select the group (expand/collapse is handled by the chevron above)
    header.addEventListener('click', () => {
      this.state.set('selectedList', { type: 'group', groupId: group.id });
      this.state.set('mode', 'tasks');
    });
    header.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.showTagGroupMenu(e, group);
    });

    if (isExpanded) {
      const children = container.createDiv({ cls: 'tc-tag-group-children' });
      for (const tag of tags) {
        // Strip the group prefix from display label: #work/dev → dev
        const label =
          group.mode === 'prefix' && group.prefix ? tag.replace(`#${group.prefix}/`, '') : tag;

        const tagSel = this.state.get('selectedList');
        const isTagActive =
          typeof tagSel === 'object' && tagSel.type === 'tag' && tagSel.tag === tag;
        const tagCount = allTasks.filter(
          (t) => t.tags?.includes(tag) === true && isActiveTask(t),
        ).length;

        const child = children.createDiv({
          cls: `tc-left-item tc-tag-child${isTagActive ? ' is-active' : ''}`,
        });
        child.createDiv({ cls: 'tc-left-item-left' }, (l) => {
          l.createEl('span', { cls: 'tc-left-label', text: label });
          this.appendCustomDot(l, { type: 'tag', tag });
        });
        if (tagCount > 0) child.createEl('span', { cls: 'tc-left-count', text: String(tagCount) });

        child.addEventListener('click', (e) => {
          e.stopPropagation();
          this.tagSelectedFromPinned = false;
          this.state.set('selectedList', { type: 'tag', tag });
          this.state.set('mode', 'tasks');
        });

        child.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          this.showChildTagMenu(e, tag);
        });

        this.attachTagDragSource(child, tag);
        this.attachDropZone(child, tag);
      }
    }
  }

  private showPinnedTagMenu(e: MouseEvent, tag: string): void {
    const menu = new Menu();
    menu.addItem((item) =>
      item
        .setTitle('Unpin')
        .setIcon('pin-off')
        .onClick(this.makeTagOp(() => this.tagManager.unpinTag(tag))),
    );
    menu.addItem((item) =>
      item
        .setTitle('Archive')
        .setIcon('archive')
        .onClick(this.makeTagOp(() => this.tagManager.archiveTag(tag))),
    );
    menu.addItem((item) =>
      item
        .setTitle('Rename tag across vault…')
        .setIcon('pencil')
        .onClick(() => {
          new RenameTagModal(this.app, this.tagManager, tag, () => this.render()).open();
        }),
    );
    menu.showAtMouseEvent(e);
  }

  private showChildTagMenu(e: MouseEvent, tag: string): void {
    const isPinned = this.settings.pinnedTags.includes(tag);
    const menu = new Menu();
    menu.addItem((item) =>
      item
        .setTitle(isPinned ? 'Unpin' : 'Pin')
        .setIcon(isPinned ? 'pin-off' : 'pin')
        .onClick(
          this.makeTagOp(() =>
            isPinned ? this.tagManager.unpinTag(tag) : this.tagManager.pinTag(tag),
          ),
        ),
    );
    menu.addItem((item) =>
      item
        .setTitle('Archive')
        .setIcon('archive')
        .onClick(this.makeTagOp(() => this.tagManager.archiveTag(tag))),
    );
    menu.addItem((item) =>
      item
        .setTitle('Rename tag across vault…')
        .setIcon('pencil')
        .onClick(() => {
          new RenameTagModal(this.app, this.tagManager, tag, () => this.render()).open();
        }),
    );
    menu.showAtMouseEvent(e);
  }

  private showTagGroupMenu(e: MouseEvent, group: TagGroup, flattenedTag?: string): void {
    const menu = new Menu();
    menu.addItem((item) =>
      item
        .setTitle('Rename display name…')
        .setIcon('pencil')
        .onClick(() => this.openTagGroupAppearance(group, 'name')),
    );
    menu.addItem((item) =>
      item
        .setTitle('Change color…')
        .setIcon('palette')
        .onClick(() => this.openTagGroupAppearance(group, 'color')),
    );

    if (flattenedTag) {
      const isPinned = this.settings.pinnedTags.includes(flattenedTag);
      menu.addItem((item) =>
        item
          .setTitle(isPinned ? 'Unpin' : 'Pin')
          .setIcon(isPinned ? 'pin-off' : 'pin')
          .onClick(
            this.makeTagOp(() =>
              isPinned
                ? this.tagManager.unpinTag(flattenedTag)
                : this.tagManager.pinTag(flattenedTag),
            ),
          ),
      );
      menu.addItem((item) =>
        item
          .setTitle('Archive')
          .setIcon('archive')
          .onClick(this.makeTagOp(() => this.tagManager.archiveTag(flattenedTag))),
      );
    }

    if (group.mode === 'prefix' && group.prefix) {
      const prefix = `#${group.prefix}`;
      menu.addItem((item) =>
        item
          .setTitle('Rename prefix across vault…')
          .setIcon('replace')
          .onClick(() => {
            new RenameTagModal(
              this.app,
              this.tagManager,
              prefix,
              () => this.render(),
              'prefix',
            ).open();
          }),
      );
    } else {
      const tags = uniqueStrings(flattenedTag ? [flattenedTag] : (group.tags ?? []));
      for (const tag of tags) {
        menu.addItem((item) =>
          item
            .setTitle(`Rename ${tag} across vault…`)
            .setIcon('replace')
            .onClick(() => {
              new RenameTagModal(this.app, this.tagManager, tag, () => this.render()).open();
            }),
        );
      }
    }
    menu.showAtMouseEvent(e);
  }

  private openTagGroupAppearance(group: TagGroup, field: 'name' | 'color'): void {
    new TagGroupAppearanceModal(
      this.app,
      { name: group.name, color: group.color },
      (result) => this.applyTagGroupAppearance(group, result),
      field,
    ).open();
  }

  private applyTagGroupAppearance(group: TagGroup, result: TagGroupAppearanceResult): void {
    if (result.name === undefined && result.color === undefined) return;
    if (result.name !== undefined) group.name = result.name;
    if (result.color !== undefined) {
      if (result.color === null) delete group.color;
      else group.color = result.color;
    }
    void this.onSaveSettings().then(() => this.render());
  }

  private makeTagOp(op: () => Promise<void>): () => void {
    return () => {
      void op().then(() => {
        this.render();
      });
    };
  }

  private static readonly GROUP_DND = 'application/x-tc-taggroup';

  /**
   * Makes a tag-group row a drag source AND drop target for reordering groups on
   * the left panel, persisting the new order. Uses a dedicated dataTransfer type
   * so it never collides with the tag→task assignment drag (`draggingTag`).
   */
  private attachGroupReorder(el: HTMLElement, groupId: string): void {
    el.setAttribute('draggable', 'true');
    el.addEventListener('dragstart', (e) => {
      e.stopPropagation();
      e.dataTransfer?.setData(LeftPanel.GROUP_DND, groupId);
      el.classList.add('tc-dragging');
    });
    el.addEventListener('dragend', () => el.classList.remove('tc-dragging'));
    el.addEventListener('dragover', (e) => {
      if (!e.dataTransfer?.types.includes(LeftPanel.GROUP_DND)) return;
      e.preventDefault();
      el.classList.add('tc-reorder-target');
    });
    el.addEventListener('dragleave', () => el.classList.remove('tc-reorder-target'));
    el.addEventListener('drop', (e) => {
      const draggedId = e.dataTransfer?.getData(LeftPanel.GROUP_DND);
      el.classList.remove('tc-reorder-target');
      if (!draggedId || draggedId === groupId) return;
      e.preventDefault();
      e.stopPropagation();
      void this.reorderTagGroups(draggedId, groupId);
    });
  }

  private async reorderTagGroups(draggedId: string, targetId: string): Promise<void> {
    const groups = this.settings.tagGroups;
    const from = groups.findIndex((g) => g.id === draggedId);
    const to = groups.findIndex((g) => g.id === targetId);
    if (from < 0 || to < 0) return;
    const [item] = groups.splice(from, 1);
    if (item) groups.splice(to, 0, item);
    await this.onSaveSettings();
    this.render();
  }

  private attachTagDragSource(el: HTMLElement, tag: string): void {
    el.setAttribute('draggable', 'true');
    el.addEventListener('dragstart', (e) => {
      e.stopPropagation();
      this.state.set('draggingTag', tag);
      el.classList.add('tc-dragging');
    });
    el.addEventListener('dragend', () => {
      this.state.set('draggingTag', null);
      el.classList.remove('tc-dragging');
    });
  }

  /** A project row accepts a dragged task: dropping physically moves the task's
   *  markdown block into the project note (membership == file location). */
  private attachProjectDropZone(el: HTMLElement, projectPath: string): void {
    el.addEventListener('dragover', (e) => {
      const task = this.state.get('draggingTask');
      if (!this.projectManager || !task || task.source.filePath === projectPath) return;
      e.preventDefault();
      el.classList.add('tc-drop-target');
    });
    el.addEventListener('dragleave', () => {
      el.classList.remove('tc-drop-target');
    });
    el.addEventListener('drop', (e) => {
      el.classList.remove('tc-drop-target');
      const task = this.state.get('draggingTask');
      if (!task || task.source.filePath === projectPath || !this.projectManager) return;
      e.preventDefault();
      void moveTaskToProjectWithRecovery(
        this.app,
        this.tasks,
        this.projectManager,
        task.ref,
        projectPath,
      );
    });
  }

  /** A project row can be dragged onto a task card to pull that task into the
   *  project — the mirror gesture of dropping a task onto the project. */
  private attachProjectDragSource(el: HTMLElement, projectPath: string): void {
    el.setAttribute('draggable', 'true');
    el.addEventListener('dragstart', (e) => {
      e.stopPropagation();
      this.state.set('draggingProject', projectPath);
      el.classList.add('tc-dragging');
    });
    el.addEventListener('dragend', () => {
      this.state.set('draggingProject', null);
      el.classList.remove('tc-dragging');
    });
  }

  private attachDropZone(el: HTMLElement, tag: string): void {
    el.addEventListener('dragover', (e) => {
      if (!this.state.get('draggingTask')) return;
      e.preventDefault();
      el.classList.add('tc-drop-target');
    });
    el.addEventListener('dragleave', () => {
      el.classList.remove('tc-drop-target');
    });
    el.addEventListener('drop', (e) => {
      e.preventDefault();
      el.classList.remove('tc-drop-target');
      const dragging = this.state.get('draggingTask');
      if (!dragging) return;
      void this.assignTagFromInbox(dragging, tag);
    });
  }

  private async assignTagFromInbox(task: TaskSnapshot, tag: string): Promise<void> {
    const inboxTag = this.settings.inbox.tag;
    const tags = new Set(task.tags ?? []);
    const remove = this.settings.inbox.removeTagOnAssign && tags.has(inboxTag) ? [inboxTag] : [];
    presentTaskCommandResult(
      await this.tasks.execute({
        type: 'patch',
        target: { type: 'task', ref: task.ref },
        patch: { tags: { add: [tag], remove } },
      }),
    );
  }

  private resolveGroupTags(group: TagGroup, allTasks: TaskSnapshot[]): string[] {
    if (group.mode === 'prefix' && group.prefix) {
      const prefix = group.prefix;
      const found = new Set<string>();
      for (const task of allTasks) {
        for (const tag of task.tags ?? []) {
          // Only include subtags (e.g. #work/dev), not the root tag (#work) itself
          if (tag.startsWith(`#${prefix}/`)) {
            found.add(tag);
          }
        }
      }
      return Array.from(found).sort((a, b) => a.localeCompare(b));
    }
    return group.tags ?? [];
  }

  private countInbox(tasks: TaskSnapshot[]): number {
    const { inbox } = this.settings;
    const allOpen = tasks.filter((t) => t.status === 'open');
    const withTag =
      inbox.mode !== 'untagged' ? allOpen.filter((t) => t.tags?.includes(inbox.tag) === true) : [];
    const includeUntagged = inbox.mode !== 'tag';
    const untagged = includeUntagged ? allOpen.filter((t) => (t.tags?.length ?? 0) === 0) : [];
    if (withTag.length === 0) return untagged.length;
    if (untagged.length === 0) return withTag.length;
    const seen = new Set<string>();
    return [...withTag, ...untagged].filter((t) => {
      const key = `${t.source.filePath}:${t.source.line}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).length;
  }

  private countToday(tasks: TaskSnapshot[], today: string): number {
    return tasks.filter((t) => {
      if (t.status !== 'open') return false;
      return String(t.planning.due) === today || String(t.planning.scheduled) === today;
    }).length;
  }

  private countUpcoming(tasks: TaskSnapshot[], today: string): number {
    return tasks.filter((t) => {
      if (t.status !== 'open') return false;
      const d = t.planning.due ?? t.planning.scheduled;
      return d !== undefined && d > today;
    }).length;
  }
}
