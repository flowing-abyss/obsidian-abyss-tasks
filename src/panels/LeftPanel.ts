import { Menu, Notice, setIcon, TFile, type App } from 'obsidian';
import type { AppState, ListSelection } from '../app/AppState';
import { isListViewCustomized, listSelectionToKey } from '../app/listViewState';
import type { ProjectManager } from '../projects/ProjectManager';
import type { ProjectStore } from '../projects/ProjectStore';
import { projectStatusDisplayName } from '../projects/status';
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
  onSaveViewState?: () => Promise<void>,
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
  private readonly state_abyssPrivate: AppState;
  private readonly settings_abyssPrivate: CalendarSettings;
  private readonly tagManager_abyssPrivate: TagManager;
  private readonly app_abyssPrivate: App;
  private readonly queries_abyssPrivate: TaskQueryApi;
  private readonly tasks_abyssPrivate: TaskApplicationApi;
  private readonly onSaveSettings_abyssPrivate: () => Promise<void>;
  private readonly onSaveViewState_abyssPrivate: () => Promise<void>;
  private readonly projectStore_abyssPrivate: ProjectStore | null;
  private readonly projectManager_abyssPrivate: ProjectManager | null;
  private el_abyssPrivate!: HTMLElement;
  private readonly offs_abyssPrivate: Array<() => void> = [];
  private readonly expandedGroups_abyssPrivate = new Set<string>();
  private readonly explicitlyCollapsed_abyssPrivate = new Set<string>();
  private showAllProjects_abyssPrivate = false;
  // When a tag is opened from the Pinned section, don't auto-expand the group
  // that contains it in the Tags tree — the pin exists precisely to avoid that.
  private tagSelectedFromPinned_abyssPrivate = false;
  private readonly navigation_abyssPrivate: PanelNavigationActions;

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
      onSaveViewState = async () => {},
    ] = args;
    this.state_abyssPrivate = state;
    this.settings_abyssPrivate = settings;
    this.tagManager_abyssPrivate = tagManager;
    this.app_abyssPrivate = app;
    this.queries_abyssPrivate = queries;
    this.tasks_abyssPrivate = tasks;
    this.onSaveSettings_abyssPrivate = onSaveSettings;
    this.onSaveViewState_abyssPrivate = onSaveViewState;
    this.projectStore_abyssPrivate = projectStore;
    this.projectManager_abyssPrivate = projectManager;
    this.navigation_abyssPrivate =
      navigation ??
      new PanelNavigator(
        state,
        settings,
        {
          calendarView: () => 'month',
          setCalendarView: () => {},
          openQuickCapture: () => {},
        },
        onSaveViewState,
      );
  }

  mount(container: HTMLElement): void {
    this.el_abyssPrivate = container;
    this.offs_abyssPrivate.push(
      this.state_abyssPrivate.on('selectedList', () => {
        this.render_abyssPrivate();
      }),
      this.state_abyssPrivate.on('mode', () => {
        this.render_abyssPrivate();
      }),
      // Re-render when the active container's view state changes so the
      // "customized" dot appears/disappears live as filters/sort/group change.
      this.state_abyssPrivate.on('centerListViewState', () => {
        this.render_abyssPrivate();
      }),
    );
    this.render_abyssPrivate();
  }

  refresh(): void {
    this.render_abyssPrivate();
  }

  /** Rebuilds only the project section after presentation-only settings changes. */
  refreshProjectSettings(): void {
    const mode = this.state_abyssPrivate.get('mode');
    if (mode === 'search' || mode === 'projects') return;
    const existing = this.el_abyssPrivate.querySelector<HTMLElement>(
      '.abyss-left-section--projects',
    );
    const ownerWindow = this.el_abyssPrivate.ownerDocument.win as Window & {
      createDiv(): HTMLDivElement;
    };
    const staging = ownerWindow.createDiv();
    this.renderProjectsSection_abyssPrivate(staging);
    const fresh = staging.firstElementChild;
    if (existing !== null) {
      if (fresh === null) existing.remove();
      else existing.replaceWith(fresh);
      return;
    }
    if (fresh !== null) {
      const tags = this.el_abyssPrivate.querySelector('.abyss-left-section--tags');
      this.el_abyssPrivate.insertBefore(fresh, tags);
    }
  }

  destroy(): void {
    this.offs_abyssPrivate.forEach((f) => {
      f();
    });
    this.el_abyssPrivate.empty();
  }

  /** Append the "customized" dot after a container label when its saved view
   *  state differs from defaults (group/sort/show changed or any filter set). */
  private appendCustomDot_abyssPrivate(labelParent: HTMLElement, sel: ListSelection): void {
    const key = listSelectionToKey(sel);
    const vs = this.settings_abyssPrivate.listViewStates?.[key];
    if (vs != null && isListViewCustomized(vs, key)) {
      labelParent.createSpan({
        cls: 'abyss-left-custom-dot',
        attr: { role: 'img', 'aria-label': 'Custom view applied' },
      });
    }
  }

  private render_abyssPrivate(): void {
    this.el_abyssPrivate.empty();
    const mode = this.state_abyssPrivate.get('mode');
    // The projects mode is a self-contained deep view; search hides the left panel too.
    if (mode === 'search' || mode === 'projects') return;

    const allTasks = [...this.queries_abyssPrivate.list()];
    const today = window.moment().format('YYYY-MM-DD');

    this.el_abyssPrivate.createDiv({ cls: 'abyss-left-section' }, (section) => {
      this.renderSmartList_abyssPrivate(
        section,
        'inbox',
        'Inbox',
        'inbox',
        this.countInbox_abyssPrivate(allTasks),
      );
      this.renderSmartList_abyssPrivate(
        section,
        'today',
        'Today',
        'calendar',
        this.countToday_abyssPrivate(allTasks, today),
      );
      this.renderSmartList_abyssPrivate(
        section,
        'upcoming',
        'Upcoming',
        'arrow-up-right',
        this.countUpcoming_abyssPrivate(allTasks, today),
      );
    });

    // Pinned section (collapsible)
    if (this.settings_abyssPrivate.pinnedTags.length > 0) {
      this.renderCollapsibleSection_abyssPrivate('pinned', 'Pinned', {
        addAction: null,
        body: (body) => {
          for (const tag of this.settings_abyssPrivate.pinnedTags) {
            this.renderPinnedTag_abyssPrivate(body, tag, allTasks);
          }
        },
      });
    }

    // Projects section (collapsible) — only active (onLeftPanel) projects
    this.renderProjectsSection_abyssPrivate(this.el_abyssPrivate);

    // Tag groups (collapsible; archived tags filtered out). The section always
    // renders so the "+" (zero-friction tag entry) stays discoverable.
    const groups = this.settings_abyssPrivate.tagGroups;
    this.renderCollapsibleSection_abyssPrivate('tags', 'Tags', {
      addAction: (): void => {
        this.startInlineAdd_abyssPrivate('tags', 'Tag name…', (name) =>
          this.tagManager_abyssPrivate.createManualGroup(name),
        );
      },
      body: (body) => {
        for (const group of groups) {
          this.renderTagGroup_abyssPrivate(body, group, allTasks);
        }
      },
    });
  }

  private async createProject_abyssPrivate(name: string): Promise<void> {
    if (this.projectManager_abyssPrivate == null) return;
    await this.projectManager_abyssPrivate.create(name);
    this.projectStore_abyssPrivate?.refresh();
  }

  private renderProjectsSection_abyssPrivate(root: HTMLElement): void {
    const activeProjects = this.projectStore_abyssPrivate?.activeForLeftPanel() ?? [];
    if (activeProjects.length === 0) return;
    this.renderCollapsibleSection_abyssPrivate('projects', 'Projects', {
      addAction:
        this.projectManager_abyssPrivate != null
          ? (): void => {
              this.startInlineAdd_abyssPrivate('projects', 'Project name…', (name) =>
                this.createProject_abyssPrivate(name),
              );
            }
          : null,
      body: (body) => {
        this.renderProjectsList_abyssPrivate(body, activeProjects);
      },
      root,
    });
  }

  /**
   * A left-panel section with a persisted collapse state, an SVG chevron, and an
   * optional "+" add action. Collapse toggles `settings.sectionCollapse[key]`.
   */
  private renderCollapsibleSection_abyssPrivate(
    key: 'pinned' | 'projects' | 'tags',
    title: string,
    options: {
      readonly addAction: (() => void) | null;
      readonly body: (bodyEl: HTMLElement) => void;
      readonly root?: HTMLElement;
    },
  ): void {
    const { addAction, body, root = this.el_abyssPrivate } = options;
    const collapsed = this.settings_abyssPrivate.sectionCollapse[key];
    const section = root.createDiv({
      cls: `abyss-left-section abyss-left-section--${key}`,
    });

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
      this.settings_abyssPrivate.sectionCollapse[key] = !collapsed;
      runAsyncAction(this.onSaveViewState_abyssPrivate(), 'Could not save section state');
      this.render_abyssPrivate();
    });

    if (!collapsed) {
      const bodyEl = section.createDiv({ cls: 'abyss-left-section-body' });
      body(bodyEl);
    }
  }

  private renderProjectsList_abyssPrivate(
    parent: HTMLElement,
    projects: ReturnType<ProjectStore['activeForLeftPanel']>,
  ): void {
    const visible = this.showAllProjects_abyssPrivate ? projects : projects.slice(0, PROJECTS_CAP);
    const sel = this.state_abyssPrivate.get('selectedList');
    // Project colour is derived from its status colour (same source the Projects
    // overview uses); build the lookup once per render.
    const statusById = new Map(this.settings_abyssPrivate.projects.statuses.map((s) => [s.id, s]));
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
        this.appendCustomDot_abyssPrivate(l, { type: 'project', path: project.path });
      });
      this.attachProjectDropZone_abyssPrivate(row, project.path);
      this.attachProjectDragSource_abyssPrivate(row, project.path);
      if (openCount > 0) {
        row.createSpan({ cls: 'abyss-left-count', text: String(openCount) });
      }
      row.addEventListener('click', () => {
        this.navigation_abyssPrivate.openList({ type: 'project', path: project.path });
      });
      row.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        this.showProjectMenu_abyssPrivate(e, project);
      });
    }

    if (!this.showAllProjects_abyssPrivate && projects.length > PROJECTS_CAP) {
      const more = parent.createDiv({ cls: 'abyss-left-item abyss-left-showmore' });
      more.createSpan({
        cls: 'abyss-left-label',
        text: `Show ${projects.length - PROJECTS_CAP} more…`,
      });
      more.addEventListener('click', () => {
        this.showAllProjects_abyssPrivate = true;
        this.render_abyssPrivate();
      });
    }
  }

  /**
   * Shows an inline text input directly under a section header (not at the
   * bottom, which breaks with many rows). Used for both tag and project entry so
   * the "+" affordance behaves identically everywhere. A `committed` guard
   * prevents the Enter→re-render→blur sequence from firing twice.
   */
  private startInlineAdd_abyssPrivate(
    key: 'tags' | 'projects',
    placeholder: string,
    onCommit: (name: string) => Promise<void>,
  ): void {
    // Ensure the section is expanded so the input is visible.
    if (this.settings_abyssPrivate.sectionCollapse[key]) {
      this.settings_abyssPrivate.sectionCollapse[key] = false;
      runAsyncAction(this.onSaveViewState_abyssPrivate(), 'Could not save section state');
      this.render_abyssPrivate();
    }
    const section = this.el_abyssPrivate.querySelector(`.abyss-left-section--${key}`);
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
            this.render_abyssPrivate();
          }),
        );
      else this.render_abyssPrivate();
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        commit();
      }
      if (e.key === 'Escape') {
        committed = true;
        this.render_abyssPrivate();
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

  private showProjectMenu_abyssPrivate(
    e: MouseEvent,
    project: ReturnType<ProjectStore['activeForLeftPanel']>[number],
  ): void {
    const menu = new Menu();
    const statuses = this.settings_abyssPrivate.projects.statuses;
    if (statuses.length > 0 && this.projectManager_abyssPrivate != null) {
      menu.addItem((item) => {
        item.setTitle('Change status').setIcon('circle-dot');
        // setSubmenu is available at runtime but not in the public typings.
        const sub = (item as unknown as { setSubmenu: () => Menu }).setSubmenu();
        for (const s of statuses) {
          sub.addItem((si) =>
            si
              .setTitle(projectStatusDisplayName(s))
              .setChecked(s.id === project.statusId)
              .onClick(() => {
                this.changeProjectStatus_abyssPrivate(project.path, s.id);
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
          this.openProjectNote_abyssPrivate(project.path);
        }),
    );
    showMenuAtMouseEventWithFocus(menu, e);
  }

  private changeProjectStatus_abyssPrivate(path: string, statusId: string): void {
    const projectManager = this.projectManager_abyssPrivate;
    if (projectManager === null) return;
    runAsyncAction(
      projectManager.setStatus(path, statusId).then(() => {
        this.projectStore_abyssPrivate?.refresh();
        this.render_abyssPrivate();
      }),
    );
  }

  private openProjectNote_abyssPrivate(path: string): void {
    const file = this.app_abyssPrivate.vault.getAbstractFileByPath(path);
    if (file instanceof TFile)
      runAsyncAction(this.app_abyssPrivate.workspace.getLeaf(false).openFile(file));
  }

  private renderPinnedTag_abyssPrivate(
    parent: HTMLElement,
    tag: string,
    allTasks: TaskSnapshot[],
  ): void {
    const sel = this.state_abyssPrivate.get('selectedList');
    const isActive = typeof sel === 'object' && sel.type === 'tag' && sel.tag === tag;
    const count = allTasks.filter((t) => isActiveTask(t) && t.tags.includes(tag)).length;

    const row = parent.createDiv({
      cls: `abyss-left-item abyss-pinned-tag${isActive ? ' is-active' : ''}`,
    });
    row.createDiv({ cls: 'abyss-left-item-left' }, (l) => {
      l.createSpan({ cls: 'abyss-left-label', text: tag });
      this.appendCustomDot_abyssPrivate(l, { type: 'tag', tag });
    });
    if (count > 0) row.createSpan({ cls: 'abyss-left-count', text: String(count) });

    row.addEventListener('click', () => {
      this.tagSelectedFromPinned_abyssPrivate = true;
      this.navigation_abyssPrivate.openList({ type: 'tag', tag });
    });

    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      this.showPinnedTagMenu_abyssPrivate(e, tag);
    });

    this.attachTagDragSource_abyssPrivate(row, tag);
    this.attachDropZone_abyssPrivate(row, tag);
  }

  /** A flat, non-expandable tag row (used for manual single-tag groups). */
  private renderTagLeaf_abyssPrivate(
    parent: HTMLElement,
    group: TagGroup,
    tag: string,
    allTasks: TaskSnapshot[],
  ): void {
    const sel = this.state_abyssPrivate.get('selectedList');
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
      this.appendCustomDot_abyssPrivate(l, { type: 'tag', tag });
    });
    if (count > 0) row.createSpan({ cls: 'abyss-left-count', text: String(count) });

    row.addEventListener('click', () => {
      this.tagSelectedFromPinned_abyssPrivate = false;
      this.navigation_abyssPrivate.openList({ type: 'tag', tag });
    });
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.showTagGroupMenu_abyssPrivate(e, group, tag);
    });
    this.attachTagDragSource_abyssPrivate(row, tag);
    this.attachDropZone_abyssPrivate(row, tag);
    this.attachGroupReorder_abyssPrivate(row, group.id);
  }

  private renderSmartList_abyssPrivate(
    ...args: [HTMLElement, ListSelection, string, string, number]
  ): void {
    const [parent, selection, label, icon, count] = args;
    const current = this.state_abyssPrivate.get('selectedList');
    const isActive = current === selection;
    const row = parent.createDiv({ cls: `abyss-left-item${isActive ? ' is-active' : ''}` });

    const left = row.createDiv({ cls: 'abyss-left-item-left' });
    const iconEl = left.createSpan({ cls: 'abyss-left-icon' });
    setIcon(iconEl, icon);
    left.createSpan({ cls: 'abyss-left-label', text: label });
    this.appendCustomDot_abyssPrivate(left, selection);

    if (count > 0) {
      row.createSpan({ cls: 'abyss-left-count', text: String(count) });
    }

    row.addEventListener('click', () => {
      this.navigation_abyssPrivate.openList(selection);
    });
  }

  private renderTagGroup_abyssPrivate(
    parent: HTMLElement,
    group: TagGroup,
    allTasks: TaskSnapshot[],
  ): void {
    if (this.renderSingleTagGroup_abyssPrivate(parent, group, allTasks)) return;
    const sel = this.state_abyssPrivate.get('selectedList');
    const isGroupActive =
      typeof sel === 'object' && sel.type === 'group' && sel.groupId === group.id;
    const tags = this.resolveGroupTags_abyssPrivate(group, allTasks).filter(
      (t) => !this.settings_abyssPrivate.archivedTags.includes(t),
    );
    const hasActiveChild = tags.some(
      (t) => typeof sel === 'object' && sel.type === 'tag' && sel.tag === t,
    );
    this.expandActiveTagGroup_abyssPrivate(group.id, hasActiveChild);
    const isExpanded = this.expandedGroups_abyssPrivate.has(group.id);
    const container = parent.createDiv({ cls: 'abyss-tag-group' });
    const context = { group, tags, allTasks, isExpanded, isGroupActive };
    this.renderTagGroupHeader_abyssPrivate(container, context);
    if (isExpanded) this.renderTagGroupChildren_abyssPrivate(container, context);
  }

  private renderSingleTagGroup_abyssPrivate(
    parent: HTMLElement,
    group: TagGroup,
    allTasks: TaskSnapshot[],
  ): boolean {
    const soleTag = group.mode === 'manual' && group.tags?.length === 1 ? group.tags[0] : undefined;
    if (soleTag === undefined) return false;
    if (!this.settings_abyssPrivate.archivedTags.includes(soleTag)) {
      this.renderTagLeaf_abyssPrivate(parent, group, soleTag, allTasks);
    }
    return true;
  }

  private expandActiveTagGroup_abyssPrivate(groupId: string, hasActiveChild: boolean): void {
    if (
      !hasActiveChild ||
      this.explicitlyCollapsed_abyssPrivate.has(groupId) ||
      this.tagSelectedFromPinned_abyssPrivate
    ) {
      return;
    }
    this.expandedGroups_abyssPrivate.add(groupId);
  }

  private renderTagGroupHeader_abyssPrivate(
    container: HTMLElement,
    context: TagGroupRenderContext,
  ): void {
    const { group, tags, allTasks, isExpanded, isGroupActive } = context;
    const header = container.createDiv({
      cls: `abyss-tag-group-header${isGroupActive ? ' is-active' : ''}`,
    });
    this.attachGroupReorder_abyssPrivate(header, group.id);
    const chevron = header.createSpan({
      cls: `abyss-left-icon abyss-group-arrow${isExpanded ? ' is-open' : ''}`,
    });
    setIcon(chevron, isExpanded ? 'chevron-down' : 'chevron-right');
    chevron.addEventListener('click', (e) => {
      e.stopPropagation();
      this.toggleTagGroup_abyssPrivate(group.id);
      this.render_abyssPrivate();
    });
    if (group.color !== undefined && group.color !== '') {
      const dot = header.createSpan({ cls: 'abyss-group-dot' });
      dot.style.background = group.color;
    }
    header.createSpan({ cls: 'abyss-left-label', text: group.name });
    this.appendCustomDot_abyssPrivate(header, { type: 'group', groupId: group.id });

    const groupCount = this.tagGroupTaskCount_abyssPrivate(group, tags, allTasks);
    if (groupCount > 0) {
      header.createSpan({ cls: 'abyss-left-count', text: String(groupCount) });
    }
    header.addEventListener('click', () => {
      this.navigation_abyssPrivate.openList({ type: 'group', groupId: group.id });
    });
    header.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.showTagGroupMenu_abyssPrivate(e, group);
    });
  }

  private tagGroupTaskCount_abyssPrivate(
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

  private toggleTagGroup_abyssPrivate(groupId: string): void {
    if (this.expandedGroups_abyssPrivate.has(groupId)) {
      this.expandedGroups_abyssPrivate.delete(groupId);
      this.explicitlyCollapsed_abyssPrivate.add(groupId);
    } else {
      this.expandedGroups_abyssPrivate.add(groupId);
      this.explicitlyCollapsed_abyssPrivate.delete(groupId);
    }
  }

  private renderTagGroupChildren_abyssPrivate(
    container: HTMLElement,
    context: TagGroupRenderContext,
  ): void {
    const children = container.createDiv({ cls: 'abyss-tag-group-children' });
    for (const tag of context.tags) {
      this.renderTagGroupChild_abyssPrivate(children, context.group, tag, context.allTasks);
    }
  }

  private renderTagGroupChild_abyssPrivate(
    parent: HTMLElement,
    group: TagGroup,
    tag: string,
    allTasks: readonly TaskSnapshot[],
  ): void {
    const prefix = group.mode === 'prefix' ? group.prefix : undefined;
    const label = prefix !== undefined && prefix.length > 0 ? tag.replace(`#${prefix}/`, '') : tag;
    const selected = this.state_abyssPrivate.get('selectedList');
    const isActive =
      typeof selected === 'object' && selected.type === 'tag' && selected.tag === tag;
    const count = allTasks.filter((task) => task.tags.includes(tag) && isActiveTask(task)).length;
    const child = parent.createDiv({
      cls: `abyss-left-item abyss-tag-child${isActive ? ' is-active' : ''}`,
    });
    child.createDiv({ cls: 'abyss-left-item-left' }, (left) => {
      left.createSpan({ cls: 'abyss-left-label', text: label });
      this.appendCustomDot_abyssPrivate(left, { type: 'tag', tag });
    });
    if (count > 0) child.createSpan({ cls: 'abyss-left-count', text: String(count) });
    child.addEventListener('click', (event) => {
      event.stopPropagation();
      this.tagSelectedFromPinned_abyssPrivate = false;
      this.navigation_abyssPrivate.openList({ type: 'tag', tag });
    });
    child.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      this.showChildTagMenu_abyssPrivate(event, tag);
    });
    this.attachTagDragSource_abyssPrivate(child, tag);
    this.attachDropZone_abyssPrivate(child, tag);
  }

  private showPinnedTagMenu_abyssPrivate(e: MouseEvent, tag: string): void {
    const menu = new Menu();
    menu.addItem((item) =>
      item
        .setTitle('Unpin')
        .setIcon('pin-off')
        .onClick(this.makeTagOp_abyssPrivate(() => this.tagManager_abyssPrivate.unpinTag(tag))),
    );
    menu.addItem((item) =>
      item
        .setTitle('Archive')
        .setIcon('archive')
        .onClick(this.makeTagOp_abyssPrivate(() => this.tagManager_abyssPrivate.archiveTag(tag))),
    );
    menu.addItem((item) =>
      item
        .setTitle('Rename tag across vault…')
        .setIcon('pencil')
        .onClick(() => {
          new RenameTagModal(this.app_abyssPrivate, this.tagManager_abyssPrivate, tag, () => {
            this.render_abyssPrivate();
          }).open();
        }),
    );
    showMenuAtMouseEventWithFocus(menu, e);
  }

  private showChildTagMenu_abyssPrivate(e: MouseEvent, tag: string): void {
    const isPinned = this.settings_abyssPrivate.pinnedTags.includes(tag);
    const menu = new Menu();
    menu.addItem((item) =>
      item
        .setTitle(isPinned ? 'Unpin' : 'Pin')
        .setIcon(isPinned ? 'pin-off' : 'pin')
        .onClick(
          this.makeTagOp_abyssPrivate(() =>
            isPinned
              ? this.tagManager_abyssPrivate.unpinTag(tag)
              : this.tagManager_abyssPrivate.pinTag(tag),
          ),
        ),
    );
    menu.addItem((item) =>
      item
        .setTitle('Archive')
        .setIcon('archive')
        .onClick(this.makeTagOp_abyssPrivate(() => this.tagManager_abyssPrivate.archiveTag(tag))),
    );
    menu.addItem((item) =>
      item
        .setTitle('Rename tag across vault…')
        .setIcon('pencil')
        .onClick(() => {
          new RenameTagModal(this.app_abyssPrivate, this.tagManager_abyssPrivate, tag, () => {
            this.render_abyssPrivate();
          }).open();
        }),
    );
    showMenuAtMouseEventWithFocus(menu, e);
  }

  private showTagGroupMenu_abyssPrivate(
    e: MouseEvent,
    group: TagGroup,
    flattenedTag?: string,
  ): void {
    const menu = new Menu();
    menu.addItem((item) =>
      item
        .setTitle('Rename display name…')
        .setIcon('pencil')
        .onClick(() => {
          this.openTagGroupAppearance_abyssPrivate(group, 'name');
        }),
    );
    menu.addItem((item) =>
      item
        .setTitle('Change color…')
        .setIcon('palette')
        .onClick(() => {
          this.openTagGroupAppearance_abyssPrivate(group, 'color');
        }),
    );

    if (group.mode === 'prefix' && group.prefix !== undefined && group.prefix !== '') {
      const prefix = `#${group.prefix}`;
      menu.addItem((item) =>
        item
          .setTitle('Rename prefix across vault…')
          .setIcon('replace')
          .onClick(() => {
            this.openTagGroupPrefixRename_abyssPrivate(prefix);
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
              new RenameTagModal(this.app_abyssPrivate, this.tagManager_abyssPrivate, tag, () => {
                this.render_abyssPrivate();
              }).open();
            }),
        );
      }
    }

    if (flattenedTag !== undefined && flattenedTag !== '') {
      const isPinned = this.settings_abyssPrivate.pinnedTags.includes(flattenedTag);
      menu.addItem((item) =>
        item
          .setTitle(isPinned ? 'Unpin' : 'Pin')
          .setIcon(isPinned ? 'pin-off' : 'pin')
          .onClick(
            this.makeTagOp_abyssPrivate(() =>
              isPinned
                ? this.tagManager_abyssPrivate.unpinTag(flattenedTag)
                : this.tagManager_abyssPrivate.pinTag(flattenedTag),
            ),
          ),
      );
      menu.addItem((item) =>
        item
          .setTitle('Archive')
          .setIcon('archive')
          .onClick(
            this.makeTagOp_abyssPrivate(() =>
              this.tagManager_abyssPrivate.archiveTag(flattenedTag),
            ),
          ),
      );
    }
    showMenuAtMouseEventWithFocus(menu, e);
  }

  private openTagGroupPrefixRename_abyssPrivate(prefix: string): void {
    new RenameTagModal(
      this.app_abyssPrivate,
      this.tagManager_abyssPrivate,
      prefix,
      () => {
        this.render_abyssPrivate();
      },
      'prefix',
    ).open();
  }

  private openTagGroupAppearance_abyssPrivate(group: TagGroup, field: 'name' | 'color'): void {
    new TagGroupAppearanceModal(
      this.app_abyssPrivate,
      { name: group.name, ...(group.color !== undefined && { color: group.color }) },
      (result) => {
        this.applyTagGroupAppearance_abyssPrivate(group, result);
      },
      field,
    ).open();
  }

  private applyTagGroupAppearance_abyssPrivate(
    group: TagGroup,
    result: TagGroupAppearanceResult,
  ): void {
    if (result.name === undefined && result.color === undefined) return;
    const previous = { name: group.name, color: group.color };
    if (result.name !== undefined) group.name = result.name;
    if (result.color !== undefined) {
      if (result.color === null) delete group.color;
      else group.color = result.color;
    }
    const applied = { name: group.name, color: group.color };
    beginSettingsSave(this.settings_abyssPrivate);
    const save = this.onSaveSettings_abyssPrivate();
    const saveRevision = latestSettingsSaveRevision(this.settings_abyssPrivate);
    void save
      .then(() => {
        this.render_abyssPrivate();
      })
      .catch(() => {
        let rolledBack = false;
        if (latestSettingsSaveRevision(this.settings_abyssPrivate) === saveRevision) {
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
        this.render_abyssPrivate();
      });
  }

  private makeTagOp_abyssPrivate(op: () => Promise<void>): () => void {
    return () => {
      runAsyncAction(
        op().then(() => {
          this.render_abyssPrivate();
        }),
      );
    };
  }

  private static readonly GROUP_DND_abyssPrivate = 'application/x-abyss-taggroup';

  /**
   * Makes a tag-group row a drag source AND drop target for reordering groups on
   * the left panel, persisting the new order. Uses a dedicated dataTransfer type
   * so it never collides with the tag→task assignment drag (`draggingTag`).
   */
  private attachGroupReorder_abyssPrivate(el: HTMLElement, groupId: string): void {
    el.setAttribute('draggable', 'true');
    el.addEventListener('dragstart', (e) => {
      e.stopPropagation();
      e.dataTransfer?.setData(LeftPanel.GROUP_DND_abyssPrivate, groupId);
      el.classList.add('abyss-dragging');
    });
    el.addEventListener('dragend', () => {
      el.classList.remove('abyss-dragging');
    });
    el.addEventListener('dragover', (e) => {
      if (!(e.dataTransfer?.types.includes(LeftPanel.GROUP_DND_abyssPrivate) ?? false)) return;
      e.preventDefault();
      el.classList.add('abyss-reorder-target');
    });
    el.addEventListener('dragleave', () => {
      el.classList.remove('abyss-reorder-target');
    });
    el.addEventListener('drop', (e) => {
      const draggedId = e.dataTransfer?.getData(LeftPanel.GROUP_DND_abyssPrivate);
      el.classList.remove('abyss-reorder-target');
      if (draggedId === undefined || draggedId === '' || draggedId === groupId) return;
      e.preventDefault();
      e.stopPropagation();
      runAsyncAction(this.reorderTagGroups_abyssPrivate(draggedId, groupId));
    });
  }

  private async reorderTagGroups_abyssPrivate(draggedId: string, targetId: string): Promise<void> {
    const groups = this.settings_abyssPrivate.tagGroups;
    const from = groups.findIndex((g) => g.id === draggedId);
    const to = groups.findIndex((g) => g.id === targetId);
    if (from < 0 || to < 0) return;
    const [item] = groups.splice(from, 1);
    if (item != null) groups.splice(to, 0, item);
    await this.onSaveSettings_abyssPrivate();
    this.render_abyssPrivate();
  }

  private attachTagDragSource_abyssPrivate(el: HTMLElement, tag: string): void {
    el.setAttribute('draggable', 'true');
    el.addEventListener('dragstart', (e) => {
      e.stopPropagation();
      this.state_abyssPrivate.set('draggingTag', tag);
      el.classList.add('abyss-dragging');
    });
    el.addEventListener('dragend', () => {
      this.state_abyssPrivate.set('draggingTag', null);
      el.classList.remove('abyss-dragging');
    });
  }

  /** A project row accepts a dragged task: dropping physically moves the task's
   *  markdown block into the project note (membership == file location). */
  private attachProjectDropZone_abyssPrivate(el: HTMLElement, projectPath: string): void {
    el.addEventListener('dragover', (e) => {
      const task = this.draggedCenterRoot_abyssPrivate();
      if (
        this.projectManager_abyssPrivate == null ||
        task == null ||
        task.source.filePath === projectPath
      )
        return;
      e.preventDefault();
      el.classList.add('abyss-drop-target');
    });
    el.addEventListener('dragleave', () => {
      el.classList.remove('abyss-drop-target');
    });
    el.addEventListener('drop', (e) => {
      el.classList.remove('abyss-drop-target');
      const task = this.draggedCenterRoot_abyssPrivate();
      if (
        task == null ||
        task.source.filePath === projectPath ||
        this.projectManager_abyssPrivate == null
      )
        return;
      e.preventDefault();
      runAsyncAction(
        moveTaskToProjectWithRecovery(
          this.app_abyssPrivate,
          this.tasks_abyssPrivate,
          this.projectManager_abyssPrivate,
          task.ref,
          projectPath,
        ),
      );
    });
  }

  /** A project row can be dragged onto a task card to pull that task into the
   *  project — the mirror gesture of dropping a task onto the project. */
  private attachProjectDragSource_abyssPrivate(el: HTMLElement, projectPath: string): void {
    el.setAttribute('draggable', 'true');
    el.addEventListener('dragstart', (e) => {
      e.stopPropagation();
      this.state_abyssPrivate.set('draggingProject', projectPath);
      el.classList.add('abyss-dragging');
    });
    el.addEventListener('dragend', () => {
      this.state_abyssPrivate.set('draggingProject', null);
      el.classList.remove('abyss-dragging');
    });
  }

  private attachDropZone_abyssPrivate(el: HTMLElement, tag: string): void {
    el.addEventListener('dragover', (e) => {
      if (this.draggedCenterRoot_abyssPrivate() == null) return;
      e.preventDefault();
      el.classList.add('abyss-drop-target');
    });
    el.addEventListener('dragleave', () => {
      el.classList.remove('abyss-drop-target');
    });
    el.addEventListener('drop', (e) => {
      el.classList.remove('abyss-drop-target');
      const dragging = this.draggedCenterRoot_abyssPrivate();
      if (dragging == null) return;
      e.preventDefault();
      runAsyncAction(this.assignTagFromInbox_abyssPrivate(dragging, tag));
    });
  }

  private draggedCenterRoot_abyssPrivate(): TaskSnapshot | undefined {
    const payload = this.state_abyssPrivate.get('draggingTaskNode');
    return payload?.source === 'center-card' &&
      payload.task.target.type === 'task' &&
      payload.task.path.length === 0
      ? payload.task.root
      : undefined;
  }

  private async assignTagFromInbox_abyssPrivate(task: TaskSnapshot, tag: string): Promise<void> {
    const inboxTag = this.settings_abyssPrivate.inbox.tag;
    const tags = new Set(task.tags);
    const remove =
      this.settings_abyssPrivate.inbox.removeTagOnAssign && tags.has(inboxTag) ? [inboxTag] : [];
    presentTaskCommandResult(
      await this.tasks_abyssPrivate.execute({
        type: 'patch',
        target: { type: 'task', ref: task.ref },
        patch: { tags: { add: [tag], remove } },
      }),
    );
  }

  private resolveGroupTags_abyssPrivate(group: TagGroup, allTasks: TaskSnapshot[]): string[] {
    if (group.mode === 'prefix' && group.prefix !== undefined && group.prefix.length > 0) {
      return this.collectPrefixTags_abyssPrivate(group.prefix, allTasks);
    }
    return group.tags ?? [];
  }

  private collectPrefixTags_abyssPrivate(
    prefix: string,
    allTasks: readonly TaskSnapshot[],
  ): string[] {
    const found = new Set<string>();
    const nestedPrefix = `#${prefix}/`;
    for (const task of allTasks) {
      for (const tag of task.tags) {
        if (tag.startsWith(nestedPrefix)) found.add(tag);
      }
    }
    return Array.from(found).sort((left, right) => left.localeCompare(right));
  }

  private countInbox_abyssPrivate(tasks: TaskSnapshot[]): number {
    const { inbox } = this.settings_abyssPrivate;
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

  private countToday_abyssPrivate(tasks: TaskSnapshot[], today: string): number {
    return tasks.filter((t) => {
      if (t.status !== 'open') return false;
      return String(t.planning.due) === today || String(t.planning.scheduled) === today;
    }).length;
  }

  private countUpcoming_abyssPrivate(tasks: TaskSnapshot[], today: string): number {
    return tasks.filter((t) => {
      if (t.status !== 'open') return false;
      const d = t.planning.due ?? t.planning.scheduled;
      return d !== undefined && d > today;
    }).length;
  }
}
