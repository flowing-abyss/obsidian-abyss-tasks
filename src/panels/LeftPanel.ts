import { Menu, Notice, setIcon, TFile, type App } from 'obsidian';
import type { AppState, ListSelection } from '../app/AppState';
import { isListViewCustomized, listSelectionToKey } from '../app/listViewState';
import type { ProjectManager } from '../projects/ProjectManager';
import type { ProjectStore } from '../projects/ProjectStore';
import { beginSettingsSave, latestSettingsSaveRevision } from '../settings/settingsSaveRevision';
import type { CalendarSettings, TagGroup } from '../settings/types';
import { RenameTagModal } from '../tags/RenameTagModal';
import type { TagManager } from '../tags/TagManager';
import type { TaskApplicationApi, TaskQueryApi, TaskSnapshot } from '../tasks';
import {
  TagGroupAppearanceModal,
  type TagGroupAppearanceResult,
} from '../ui/TagGroupAppearanceModal';
import { moveTaskToProjectWithRecovery } from '../ui/moveTaskToProject';
import { showMenuAtMouseEventWithFocus } from '../ui/nativeMenuFocus';
import { runAsyncAction } from '../ui/runAsyncAction';
import { presentTaskCommandResult } from '../ui/taskCommandResult';
import { PanelNavigator, type PanelNavigationActions } from '../views/panelNavigation';

const PROJECTS_CAP = 10;

type LeftPanelConstructorArgs = [
  state: AppState,
  settings: CalendarSettings,
  tagManager: TagManager,
  app: App,
  queries: TaskQueryApi,
  tasks: TaskApplicationApi,
  onSaveSettings?: () => Promise<void>,
  projectStore?: ProjectStore | null,
  projectManager?: ProjectManager | null,
  navigation?: PanelNavigationActions,
];

interface TagGroupRenderContext {
  readonly group: TagGroup;
  readonly tags: readonly string[];
  readonly allTasks: readonly TaskSnapshot[];
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

export class LeftPanel {
  private readonly state: AppState;
  private readonly settings: CalendarSettings;
  private readonly tagManager: TagManager;
  private readonly app: App;
  private readonly queries: TaskQueryApi;
  private readonly tasks: TaskApplicationApi;
  private readonly onSaveSettings: () => Promise<void>;
  private readonly projectStore: ProjectStore | null;
  private readonly projectManager: ProjectManager | null;
  private el!: HTMLElement;
  private readonly offs: Array<() => void> = [];
  private readonly expandedGroups = new Set<string>();
  private readonly explicitlyCollapsed = new Set<string>();
  private showAllProjects = false;
  // When a tag is opened from the Pinned section, don't auto-expand the group
  // that contains it in the Tags tree — the pin exists precisely to avoid that.
  private tagSelectedFromPinned = false;
  private readonly navigation: PanelNavigationActions;

  constructor(...args: LeftPanelConstructorArgs) {
    const [
      state,
      settings,
      tagManager,
      app,
      queries,
      tasks,
      onSaveSettings = async () => {},
      projectStore = null,
      projectManager = null,
      navigation,
    ] = args;
    this.state = state;
    this.settings = settings;
    this.tagManager = tagManager;
    this.app = app;
    this.queries = queries;
    this.tasks = tasks;
    this.onSaveSettings = onSaveSettings;
    this.projectStore = projectStore;
    this.projectManager = projectManager;
    this.navigation =
      navigation ??
      new PanelNavigator(
        state,
        settings,
        {
          calendarView: () => 'month',
          setCalendarView: () => {},
          openQuickCapture: () => {},
        },
        onSaveSettings,
      );
  }

  mount(container: HTMLElement): void {
    this.el = container;
    this.offs.push(
      this.state.on('selectedList', () => {
        this.render();
      }),
      this.state.on('mode', () => {
        this.render();
      }),
      // Re-render when the active container's view state changes so the
      // "customized" dot appears/disappears live as filters/sort/group change.
      this.state.on('centerListViewState', () => {
        this.render();
      }),
    );
    this.render();
  }

  refresh(): void {
    this.render();
  }

  destroy(): void {
    this.offs.forEach((f) => {
      f();
    });
    this.el.empty();
  }

  /** Append the "customized" dot after a container label when its saved view
   *  state differs from defaults (group/sort/show changed or any filter set). */
  private appendCustomDot(labelParent: HTMLElement, sel: ListSelection): void {
    const key = listSelectionToKey(sel);
    const vs = this.settings.listViewStates?.[key];
    if (vs != null && isListViewCustomized(vs, key)) {
      labelParent.createSpan({
        cls: 'abyss-left-custom-dot',
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

    this.el.createDiv({ cls: 'abyss-left-section' }, (section) => {
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
        this.projectManager != null
          ? (): void => {
              this.startInlineAdd('projects', 'Project name…', (name) => this.createProject(name));
            }
          : null,
        (body) => {
          this.renderProjectsList(body, activeProjects);
        },
      );
    }

    // Tag groups (collapsible; archived tags filtered out). The section always
    // renders so the "+" (zero-friction tag entry) stays discoverable.
    const groups = this.settings.tagGroups;
    this.renderCollapsibleSection(
      'tags',
      'Tags',
      (): void => {
        this.startInlineAdd('tags', 'Tag name…', (name) => this.tagManager.createManualGroup(name));
      },
      (body) => {
        for (const group of groups) {
          this.renderTagGroup(body, group, allTasks);
        }
      },
    );
  }

  private async createProject(name: string): Promise<void> {
    if (this.projectManager == null) return;
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
    const section = this.el.createDiv({ cls: `abyss-left-section abyss-left-section--${key}` });

    const header = section.createDiv({
      cls: 'abyss-left-section-header abyss-left-section-header--collapsible',
    });
    const chevron = header.createSpan({ cls: 'abyss-left-section-chevron' });
    setIcon(chevron, collapsed ? 'chevron-right' : 'chevron-down');
    header.createSpan({ cls: 'abyss-left-section-title', text: title });

    if (addAction != null) {
      const add = header.createSpan({
        cls: 'abyss-left-add',
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
      runAsyncAction(this.onSaveSettings(), 'Could not complete UI action');
      this.render();
    });

    if (!collapsed) {
      const bodyEl = section.createDiv({ cls: 'abyss-left-section-body' });
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
        cls: `abyss-left-item abyss-project-item${isActive ? ' is-active' : ''}`,
      });
      row.createDiv({ cls: 'abyss-left-item-left' }, (l) => {
        // Diamond colour indicator — deliberately not round, to read differently
        // from the round tag dots. Colour comes from the project's status.
        const status =
          project.statusId !== null && project.statusId !== ''
            ? statusById.get(project.statusId)
            : undefined;
        const dot = l.createSpan({ cls: 'abyss-project-dot' });
        if (status?.color !== undefined && status.color !== '') {
          dot.style.background = status.color;
        }
        l.createSpan({ cls: 'abyss-left-label', text: project.name });
        this.appendCustomDot(l, { type: 'project', path: project.path });
      });
      this.attachProjectDropZone(row, project.path);
      this.attachProjectDragSource(row, project.path);
      if (openCount > 0) {
        row.createSpan({ cls: 'abyss-left-count', text: String(openCount) });
      }
      row.addEventListener('click', () => {
        this.navigation.openList({ type: 'project', path: project.path });
      });
      row.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        this.showProjectMenu(e, project);
      });
    }

    if (!this.showAllProjects && projects.length > PROJECTS_CAP) {
      const more = parent.createDiv({ cls: 'abyss-left-item abyss-left-showmore' });
      more.createSpan({
        cls: 'abyss-left-label',
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
      runAsyncAction(this.onSaveSettings(), 'Could not complete UI action');
      this.render();
    }
    const section = this.el.querySelector(`.abyss-left-section--${key}`);
    if (section == null) return;
    const existing = section.querySelector('.abyss-left-add-input');
    if (existing != null) {
      (existing as HTMLInputElement).focus();
      return;
    }
    const body =
      section.querySelector('.abyss-left-section-body') ??
      section.createDiv({ cls: 'abyss-left-section-body' });
    const input = body.createEl('input', {
      cls: 'abyss-left-add-input',
      attr: { type: 'text', placeholder },
    });
    // Place it directly under the header, above existing rows.
    body.insertBefore(input, body.firstChild);

    let committed = false;
    const commit = (): void => {
      if (committed) return;
      committed = true;
      const value = input.value.trim();
      if (value.length > 0)
        runAsyncAction(
          onCommit(value).then(() => {
            this.render();
          }),
          'Could not complete UI action',
        );
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
    window.setTimeout(() => {
      input.focus();
    }, 0);
  }

  private showProjectMenu(
    e: MouseEvent,
    project: ReturnType<ProjectStore['activeForLeftPanel']>[number],
  ): void {
    const menu = new Menu();
    const statuses = this.settings.projects.statuses;
    if (statuses.length > 0 && this.projectManager != null) {
      menu.addItem((item) => {
        item.setTitle('Change status').setIcon('circle-dot');
        // setSubmenu is available at runtime but not in the public typings.
        const sub = (item as unknown as { setSubmenu: () => Menu }).setSubmenu();
        for (const s of statuses) {
          sub.addItem((si) =>
            si
              .setTitle(s.label)
              .setChecked(s.id === project.statusId)
              .onClick(() => {
                this.changeProjectStatus(project.path, s.id);
              }),
          );
        }
      });
    }
    menu.addItem((item) =>
      item
        .setTitle('Open note')
        .setIcon('file-text')
        .onClick(() => {
          this.openProjectNote(project.path);
        }),
    );
    showMenuAtMouseEventWithFocus(menu, e);
  }

  private changeProjectStatus(path: string, statusId: string): void {
    const projectManager = this.projectManager;
    if (projectManager === null) return;
    runAsyncAction(
      projectManager.setStatus(path, statusId).then(() => {
        this.projectStore?.refresh();
        this.render();
      }),
      'Could not complete UI action',
    );
  }

  private openProjectNote(path: string): void {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (file instanceof TFile)
      runAsyncAction(
        this.app.workspace.getLeaf(false).openFile(file),
        'Could not complete UI action',
      );
  }

  private renderPinnedTag(parent: HTMLElement, tag: string, allTasks: TaskSnapshot[]): void {
    const sel = this.state.get('selectedList');
    const isActive = typeof sel === 'object' && sel.type === 'tag' && sel.tag === tag;
    const count = allTasks.filter((t) => isActiveTask(t) && t.tags.includes(tag)).length;

    const row = parent.createDiv({
      cls: `abyss-left-item abyss-pinned-tag${isActive ? ' is-active' : ''}`,
    });
    row.createDiv({ cls: 'abyss-left-item-left' }, (l) => {
      l.createSpan({ cls: 'abyss-left-label', text: tag });
      this.appendCustomDot(l, { type: 'tag', tag });
    });
    if (count > 0) row.createSpan({ cls: 'abyss-left-count', text: String(count) });

    row.addEventListener('click', () => {
      this.tagSelectedFromPinned = true;
      this.navigation.openList({ type: 'tag', tag });
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
    const count = allTasks.filter((t) => isActiveTask(t) && t.tags.includes(tag)).length;

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
      this.appendCustomDot(l, { type: 'tag', tag });
    });
    if (count > 0) row.createSpan({ cls: 'abyss-left-count', text: String(count) });

    row.addEventListener('click', () => {
      this.tagSelectedFromPinned = false;
      this.navigation.openList({ type: 'tag', tag });
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

  private renderSmartList(...args: [HTMLElement, ListSelection, string, string, number]): void {
    const [parent, selection, label, icon, count] = args;
    const current = this.state.get('selectedList');
    const isActive = current === selection;
    const row = parent.createDiv({ cls: `abyss-left-item${isActive ? ' is-active' : ''}` });

    const left = row.createDiv({ cls: 'abyss-left-item-left' });
    const iconEl = left.createSpan({ cls: 'abyss-left-icon' });
    setIcon(iconEl, icon);
    left.createSpan({ cls: 'abyss-left-label', text: label });
    this.appendCustomDot(left, selection);

    if (count > 0) {
      row.createSpan({ cls: 'abyss-left-count', text: String(count) });
    }

    row.addEventListener('click', () => {
      this.navigation.openList(selection);
    });
  }

  private renderTagGroup(parent: HTMLElement, group: TagGroup, allTasks: TaskSnapshot[]): void {
    if (this.renderSingleTagGroup(parent, group, allTasks)) return;
    const sel = this.state.get('selectedList');
    const isGroupActive =
      typeof sel === 'object' && sel.type === 'group' && sel.groupId === group.id;
    const tags = this.resolveGroupTags(group, allTasks).filter(
      (t) => !this.settings.archivedTags.includes(t),
    );
    const hasActiveChild = tags.some(
      (t) => typeof sel === 'object' && sel.type === 'tag' && sel.tag === t,
    );
    this.expandActiveTagGroup(group.id, hasActiveChild);
    const isExpanded = this.expandedGroups.has(group.id);
    const container = parent.createDiv({ cls: 'abyss-tag-group' });
    const context = { group, tags, allTasks, isExpanded, isGroupActive };
    this.renderTagGroupHeader(container, context);
    if (isExpanded) this.renderTagGroupChildren(container, context);
  }

  private renderSingleTagGroup(
    parent: HTMLElement,
    group: TagGroup,
    allTasks: TaskSnapshot[],
  ): boolean {
    const soleTag = group.mode === 'manual' && group.tags?.length === 1 ? group.tags[0] : undefined;
    if (soleTag === undefined) return false;
    if (!this.settings.archivedTags.includes(soleTag)) {
      this.renderTagLeaf(parent, group, soleTag, allTasks);
    }
    return true;
  }

  private expandActiveTagGroup(groupId: string, hasActiveChild: boolean): void {
    if (!hasActiveChild || this.explicitlyCollapsed.has(groupId) || this.tagSelectedFromPinned) {
      return;
    }
    this.expandedGroups.add(groupId);
  }

  private renderTagGroupHeader(container: HTMLElement, context: TagGroupRenderContext): void {
    const { group, tags, allTasks, isExpanded, isGroupActive } = context;
    const header = container.createDiv({
      cls: `abyss-tag-group-header${isGroupActive ? ' is-active' : ''}`,
    });
    this.attachGroupReorder(header, group.id);
    const chevron = header.createSpan({
      cls: `abyss-left-icon abyss-group-arrow${isExpanded ? ' is-open' : ''}`,
    });
    setIcon(chevron, isExpanded ? 'chevron-down' : 'chevron-right');
    chevron.addEventListener('click', (e) => {
      e.stopPropagation();
      this.toggleTagGroup(group.id);
      this.render();
    });
    if (group.color !== undefined && group.color !== '') {
      const dot = header.createSpan({ cls: 'abyss-group-dot' });
      dot.style.background = group.color;
    }
    header.createSpan({ cls: 'abyss-left-label', text: group.name });
    this.appendCustomDot(header, { type: 'group', groupId: group.id });

    const groupCount = this.tagGroupTaskCount(group, tags, allTasks);
    if (groupCount > 0) {
      header.createSpan({ cls: 'abyss-left-count', text: String(groupCount) });
    }
    header.addEventListener('click', () => {
      this.navigation.openList({ type: 'group', groupId: group.id });
    });
    header.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.showTagGroupMenu(e, group);
    });
  }

  private tagGroupTaskCount(
    group: TagGroup,
    tags: readonly string[],
    allTasks: readonly TaskSnapshot[],
  ): number {
    const prefix = group.mode === 'prefix' ? group.prefix : undefined;
    const allGroupTags = prefix !== undefined && prefix.length > 0 ? [`#${prefix}`, ...tags] : tags;
    return allTasks.filter(
      (task) => isActiveTask(task) && allGroupTags.some((tag) => task.tags.includes(tag)),
    ).length;
  }

  private toggleTagGroup(groupId: string): void {
    if (this.expandedGroups.has(groupId)) {
      this.expandedGroups.delete(groupId);
      this.explicitlyCollapsed.add(groupId);
    } else {
      this.expandedGroups.add(groupId);
      this.explicitlyCollapsed.delete(groupId);
    }
  }

  private renderTagGroupChildren(container: HTMLElement, context: TagGroupRenderContext): void {
    const children = container.createDiv({ cls: 'abyss-tag-group-children' });
    for (const tag of context.tags) {
      this.renderTagGroupChild(children, context.group, tag, context.allTasks);
    }
  }

  private renderTagGroupChild(
    parent: HTMLElement,
    group: TagGroup,
    tag: string,
    allTasks: readonly TaskSnapshot[],
  ): void {
    const prefix = group.mode === 'prefix' ? group.prefix : undefined;
    const label = prefix !== undefined && prefix.length > 0 ? tag.replace(`#${prefix}/`, '') : tag;
    const selected = this.state.get('selectedList');
    const isActive =
      typeof selected === 'object' && selected.type === 'tag' && selected.tag === tag;
    const count = allTasks.filter((task) => task.tags.includes(tag) && isActiveTask(task)).length;
    const child = parent.createDiv({
      cls: `abyss-left-item abyss-tag-child${isActive ? ' is-active' : ''}`,
    });
    child.createDiv({ cls: 'abyss-left-item-left' }, (left) => {
      left.createSpan({ cls: 'abyss-left-label', text: label });
      this.appendCustomDot(left, { type: 'tag', tag });
    });
    if (count > 0) child.createSpan({ cls: 'abyss-left-count', text: String(count) });
    child.addEventListener('click', (event) => {
      event.stopPropagation();
      this.tagSelectedFromPinned = false;
      this.navigation.openList({ type: 'tag', tag });
    });
    child.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      this.showChildTagMenu(event, tag);
    });
    this.attachTagDragSource(child, tag);
    this.attachDropZone(child, tag);
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
          new RenameTagModal(this.app, this.tagManager, tag, () => {
            this.render();
          }).open();
        }),
    );
    showMenuAtMouseEventWithFocus(menu, e);
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
          new RenameTagModal(this.app, this.tagManager, tag, () => {
            this.render();
          }).open();
        }),
    );
    showMenuAtMouseEventWithFocus(menu, e);
  }

  private showTagGroupMenu(e: MouseEvent, group: TagGroup, flattenedTag?: string): void {
    const menu = new Menu();
    menu.addItem((item) =>
      item
        .setTitle('Rename display name…')
        .setIcon('pencil')
        .onClick(() => {
          this.openTagGroupAppearance(group, 'name');
        }),
    );
    menu.addItem((item) =>
      item
        .setTitle('Change color…')
        .setIcon('palette')
        .onClick(() => {
          this.openTagGroupAppearance(group, 'color');
        }),
    );

    if (group.mode === 'prefix' && group.prefix !== undefined && group.prefix !== '') {
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
              () => {
                this.render();
              },
              'prefix',
            ).open();
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
              new RenameTagModal(this.app, this.tagManager, tag, () => {
                this.render();
              }).open();
            }),
        );
      }
    }

    if (flattenedTag !== undefined && flattenedTag !== '') {
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
    showMenuAtMouseEventWithFocus(menu, e);
  }

  private openTagGroupAppearance(group: TagGroup, field: 'name' | 'color'): void {
    new TagGroupAppearanceModal(
      this.app,
      { name: group.name, ...(group.color !== undefined && { color: group.color }) },
      (result) => {
        this.applyTagGroupAppearance(group, result);
      },
      field,
    ).open();
  }

  private applyTagGroupAppearance(group: TagGroup, result: TagGroupAppearanceResult): void {
    if (result.name === undefined && result.color === undefined) return;
    const previous = { name: group.name, color: group.color };
    if (result.name !== undefined) group.name = result.name;
    if (result.color !== undefined) {
      if (result.color === null) delete group.color;
      else group.color = result.color;
    }
    const applied = { name: group.name, color: group.color };
    beginSettingsSave(this.settings);
    const save = this.onSaveSettings();
    const saveRevision = latestSettingsSaveRevision(this.settings);
    void save
      .then(() => {
        this.render();
      })
      .catch(() => {
        let rolledBack = false;
        if (latestSettingsSaveRevision(this.settings) === saveRevision) {
          if (group.name === applied.name) group.name = previous.name;
          if (group.color === applied.color) {
            if (previous.color === undefined) delete group.color;
            else group.color = previous.color;
          }
          rolledBack = true;
        }
        new Notice(
          rolledBack
            ? 'Tag group appearance was not saved. Your changes were rolled back.'
            : 'An earlier tag group appearance change was not saved. Newer changes were kept.',
        );
        this.render();
      });
  }

  private makeTagOp(op: () => Promise<void>): () => void {
    return () => {
      runAsyncAction(
        op().then(() => {
          this.render();
        }),
        'Could not complete UI action',
      );
    };
  }

  private static readonly GROUP_DND = 'application/x-abyss-taggroup';

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
      el.classList.add('abyss-dragging');
    });
    el.addEventListener('dragend', () => {
      el.classList.remove('abyss-dragging');
    });
    el.addEventListener('dragover', (e) => {
      if (!(e.dataTransfer?.types.includes(LeftPanel.GROUP_DND) ?? false)) return;
      e.preventDefault();
      el.classList.add('abyss-reorder-target');
    });
    el.addEventListener('dragleave', () => {
      el.classList.remove('abyss-reorder-target');
    });
    el.addEventListener('drop', (e) => {
      const draggedId = e.dataTransfer?.getData(LeftPanel.GROUP_DND);
      el.classList.remove('abyss-reorder-target');
      if (draggedId === undefined || draggedId === '' || draggedId === groupId) return;
      e.preventDefault();
      e.stopPropagation();
      runAsyncAction(this.reorderTagGroups(draggedId, groupId), 'Could not complete UI action');
    });
  }

  private async reorderTagGroups(draggedId: string, targetId: string): Promise<void> {
    const groups = this.settings.tagGroups;
    const from = groups.findIndex((g) => g.id === draggedId);
    const to = groups.findIndex((g) => g.id === targetId);
    if (from < 0 || to < 0) return;
    const [item] = groups.splice(from, 1);
    if (item != null) groups.splice(to, 0, item);
    await this.onSaveSettings();
    this.render();
  }

  private attachTagDragSource(el: HTMLElement, tag: string): void {
    el.setAttribute('draggable', 'true');
    el.addEventListener('dragstart', (e) => {
      e.stopPropagation();
      this.state.set('draggingTag', tag);
      el.classList.add('abyss-dragging');
    });
    el.addEventListener('dragend', () => {
      this.state.set('draggingTag', null);
      el.classList.remove('abyss-dragging');
    });
  }

  /** A project row accepts a dragged task: dropping physically moves the task's
   *  markdown block into the project note (membership == file location). */
  private attachProjectDropZone(el: HTMLElement, projectPath: string): void {
    el.addEventListener('dragover', (e) => {
      const task = this.draggedCenterRoot();
      if (this.projectManager == null || task == null || task.source.filePath === projectPath)
        return;
      e.preventDefault();
      el.classList.add('abyss-drop-target');
    });
    el.addEventListener('dragleave', () => {
      el.classList.remove('abyss-drop-target');
    });
    el.addEventListener('drop', (e) => {
      el.classList.remove('abyss-drop-target');
      const task = this.draggedCenterRoot();
      if (task == null || task.source.filePath === projectPath || this.projectManager == null)
        return;
      e.preventDefault();
      runAsyncAction(
        moveTaskToProjectWithRecovery(
          this.app,
          this.tasks,
          this.projectManager,
          task.ref,
          projectPath,
        ),
        'Could not complete UI action',
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
      el.classList.add('abyss-dragging');
    });
    el.addEventListener('dragend', () => {
      this.state.set('draggingProject', null);
      el.classList.remove('abyss-dragging');
    });
  }

  private attachDropZone(el: HTMLElement, tag: string): void {
    el.addEventListener('dragover', (e) => {
      if (this.draggedCenterRoot() == null) return;
      e.preventDefault();
      el.classList.add('abyss-drop-target');
    });
    el.addEventListener('dragleave', () => {
      el.classList.remove('abyss-drop-target');
    });
    el.addEventListener('drop', (e) => {
      el.classList.remove('abyss-drop-target');
      const dragging = this.draggedCenterRoot();
      if (dragging == null) return;
      e.preventDefault();
      runAsyncAction(this.assignTagFromInbox(dragging, tag), 'Could not complete UI action');
    });
  }

  private draggedCenterRoot(): TaskSnapshot | undefined {
    const payload = this.state.get('draggingTaskNode');
    return payload?.source === 'center-card' &&
      payload.task.target.type === 'task' &&
      payload.task.path.length === 0
      ? payload.task.root
      : undefined;
  }

  private async assignTagFromInbox(task: TaskSnapshot, tag: string): Promise<void> {
    const inboxTag = this.settings.inbox.tag;
    const tags = new Set(task.tags);
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
    if (group.mode === 'prefix' && group.prefix !== undefined && group.prefix.length > 0) {
      return this.collectPrefixTags(group.prefix, allTasks);
    }
    return group.tags ?? [];
  }

  private collectPrefixTags(prefix: string, allTasks: readonly TaskSnapshot[]): string[] {
    const found = new Set<string>();
    const nestedPrefix = `#${prefix}/`;
    for (const task of allTasks) {
      for (const tag of task.tags) {
        if (tag.startsWith(nestedPrefix)) found.add(tag);
      }
    }
    return Array.from(found).sort((left, right) => left.localeCompare(right));
  }

  private countInbox(tasks: TaskSnapshot[]): number {
    const { inbox } = this.settings;
    const allOpen = tasks.filter((t) => t.status === 'open');
    const withTag =
      inbox.mode !== 'untagged' ? allOpen.filter((t) => t.tags.includes(inbox.tag)) : [];
    const includeUntagged = inbox.mode !== 'tag';
    const untagged = includeUntagged ? allOpen.filter((t) => t.tags.length === 0) : [];
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
