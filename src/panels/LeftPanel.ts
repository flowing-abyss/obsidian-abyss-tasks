import { Menu, Notice, setIcon, type App, type TFile } from 'obsidian';
import type { AppState, ListSelection } from '../app/AppState';
import { isListViewCustomized, resolveListViewStateKey } from '../app/listViewState';
import { sameTag } from '../markdown/tagSyntax';
import type { ProjectManager } from '../projects/ProjectManager';
import type { ProjectStore } from '../projects/ProjectStore';
import {
  isProjectCreationError,
  projectCreationFailureNotice,
  withFailureCause,
} from '../projects/projectCreation';
import { projectStatusDisplayName } from '../projects/status';
import type { CalendarSettings } from '../settings/types';
import { TagGroupValidationError, type TagManager } from '../tags/TagManager';
import { isTagNavigationArchived, resolveEffectiveTagGroups } from '../tags/effectiveTagGroups';
import { tagSettingsFailureNotice } from '../tags/tagSettingsFailure';
import { collectTaskNodeTags } from '../tags/taskTagCatalog';
import { todayTaskCategory } from '../task-lists/todayTaskCategory';
import {
  localDate,
  normalizeTaskTagInput,
  type LocalDate,
  type TaskApplicationApi,
  type TaskQueryApi,
  type TaskSnapshot,
} from '../tasks';
import { isImeOwnedEvent } from '../ui/ime';
import { moveTaskToProjectWithRecovery } from '../ui/moveTaskToProject';
import { showMenuAtMouseEventWithFocus } from '../ui/nativeMenuFocus';
import { changeProjectStatus, openProjectNote } from '../ui/projectActions';
import { runAsyncAction } from '../ui/runAsyncAction';
import { presentTaskCommandResult } from '../ui/taskCommandResult';
import { PanelNavigator, type PanelNavigationActions } from '../views/panelNavigation';
import { TagNavigation } from './left/TagNavigation';

const PROJECTS_CAP = 10;

/** A sidebar section; each keeps its collapse state under this key in `sectionCollapse`. */
type SectionKey = keyof CalendarSettings['sectionCollapse'];
type InlineAddKey = 'tags' | 'projects';

/** A section's reading of its failed create: whether it left nothing behind, and the Notice. */
interface InlineAddFailure {
  readonly retryable: boolean;
  readonly notice: string;
}

/** One create a commit started, with the failure policy of the section that owns it. */
interface InlineAddAttempt {
  readonly created: Promise<void>;
  readonly failure: (error: unknown) => InlineAddFailure;
}

/** One open "+" name input; it outlives re-renders until it commits, cancels, or is dropped. */
interface InlineAddSession {
  readonly key: InlineAddKey;
  readonly input: HTMLInputElement;
  readonly attempt: (name: string) => InlineAddAttempt;
  phase: 'editing' | 'committing' | 'ended';
  /** The panel's render count when the create started; a retry renders only if it moved. */
  rendersAtCommit: number;
}

/** The session's focus and caret, read before a render detaches its input. */
interface InlineAddHold {
  readonly session: InlineAddSession;
  readonly hadFocus: boolean;
  readonly selectionStart: number | null;
  readonly selectionEnd: number | null;
  readonly selectionDirection: 'forward' | 'backward' | 'none' | null;
}

export interface LeftPanelOptions {
  readonly state: AppState;
  readonly settings: CalendarSettings;
  readonly tagManager: TagManager;
  readonly app: App;
  readonly queries: TaskQueryApi;
  readonly tasks: TaskApplicationApi;
  readonly projectStore?: ProjectStore | null | undefined;
  readonly projectManager?: ProjectManager | null | undefined;
  readonly navigation?: PanelNavigationActions | undefined;
  readonly onSaveViewState?: (() => Promise<void>) | undefined;
}

export class LeftPanel {
  private readonly state_abyssPrivate: AppState;
  private readonly settings_abyssPrivate: CalendarSettings;
  private readonly tagManager_abyssPrivate: TagManager;
  private readonly app_abyssPrivate: App;
  private readonly queries_abyssPrivate: TaskQueryApi;
  private readonly tasks_abyssPrivate: TaskApplicationApi;
  private readonly onSaveViewState_abyssPrivate: () => Promise<void>;
  private readonly projectStore_abyssPrivate: ProjectStore | null;
  private readonly projectManager_abyssPrivate: ProjectManager | null;
  private el_abyssPrivate!: HTMLElement;
  private readonly offs_abyssPrivate: Array<() => void> = [];
  private showAllProjects_abyssPrivate = false;
  private inlineAdd_abyssPrivate: InlineAddSession | undefined;
  // Every session that has not ended, including one a newer "+" replaced as the record and one an
  // Escape dismissed while its create runs.
  private readonly inlineAddSessions_abyssPrivate = new Set<InlineAddSession>();
  // Advanced by every full render, so a failed create can tell whether one ran while it was pending.
  private renderCount_abyssPrivate = 0;
  private readonly tagNavigation_abyssPrivate: TagNavigation;
  private readonly navigation_abyssPrivate: PanelNavigationActions;

  constructor(options: LeftPanelOptions) {
    const {
      state,
      settings,
      tagManager,
      app,
      queries,
      tasks,
      projectStore = null,
      projectManager = null,
      navigation,
      onSaveViewState = async () => {},
    } = options;
    this.state_abyssPrivate = state;
    this.settings_abyssPrivate = settings;
    this.tagManager_abyssPrivate = tagManager;
    this.app_abyssPrivate = app;
    this.queries_abyssPrivate = queries;
    this.tasks_abyssPrivate = tasks;
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
    this.tagNavigation_abyssPrivate = new TagNavigation({
      state,
      settings,
      tagManager,
      app,
      navigation: this.navigation_abyssPrivate,
      queries: tasks.queries,
      host: {
        render: () => {
          this.render_abyssPrivate();
        },
        appendCustomDot: (parent, selection) => {
          this.appendCustomDot_abyssPrivate(parent, selection);
        },
        draggedCenterRoot: () => this.draggedCenterRoot_abyssPrivate(),
        assignTagFromInbox: (task, tag) => this.assignTagFromInbox_abyssPrivate(task, tag),
      },
    });
  }

  mount(container: HTMLElement): void {
    this.el_abyssPrivate = container;
    this.offs_abyssPrivate.push(
      this.state_abyssPrivate.onCommit((changed) => {
        if (
          changed.has('selectedList') ||
          changed.has('mode') ||
          changed.has('centerListViewState')
        ) {
          this.render_abyssPrivate();
        }
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
    const hold = this.holdInlineAdd_abyssPrivate();
    this.replaceProjectsSection_abyssPrivate();
    this.settleInlineAdd_abyssPrivate(hold);
  }

  private replaceProjectsSection_abyssPrivate(): void {
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

  /** Ends every live inline add first, so no pending create or blur check touches the panel. */
  destroy(): void {
    for (const session of [...this.inlineAddSessions_abyssPrivate]) {
      this.closeInlineAdd_abyssPrivate(session);
    }
    this.offs_abyssPrivate.forEach((f) => {
      f();
    });
    this.el_abyssPrivate.empty();
  }

  /** Append the "customized" dot after a container label when its saved view
   *  state differs from defaults (group/sort/show changed or any filter set). */
  private appendCustomDot_abyssPrivate(labelParent: HTMLElement, sel: ListSelection): void {
    const key = resolveListViewStateKey(
      sel,
      this.settings_abyssPrivate.listViewStates,
      new Set(this.settings_abyssPrivate.tagGroups.map((g) => g.id)),
    );
    const vs = this.settings_abyssPrivate.listViewStates?.[key];
    if (vs != null && isListViewCustomized(vs, key)) {
      labelParent.createSpan({
        cls: 'abyss-left-custom-dot',
        attr: { role: 'img', 'aria-label': 'Custom view applied' },
      });
    }
  }

  private render_abyssPrivate(): void {
    this.renderCount_abyssPrivate += 1;
    const hold = this.holdInlineAdd_abyssPrivate();
    this.el_abyssPrivate.empty();
    this.renderSections_abyssPrivate();
    this.settleInlineAdd_abyssPrivate(hold);
  }

  private renderSections_abyssPrivate(): void {
    const mode = this.state_abyssPrivate.get('mode');
    // The projects mode is a self-contained deep view; search hides the left panel too.
    if (mode === 'search' || mode === 'projects') return;

    const allTasks = [...this.queries_abyssPrivate.list()];
    const allNodes = this.tasks_abyssPrivate.queries.listNodes();
    const today = localDate(window.moment().format('YYYY-MM-DD'));
    const { todayCount, overdue } = this.countToday_abyssPrivate(allTasks, today);

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
        overdue > 0 ? `${todayCount}+${overdue}` : String(todayCount),
        `${todayCount} today, ${overdue} overdue`,
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
            if (isTagNavigationArchived(this.settings_abyssPrivate, tag)) continue;
            this.tagNavigation_abyssPrivate.renderPinnedTag(body, tag, allNodes);
          }
        },
      });
    }

    // Projects section (collapsible) — only active (onLeftPanel) projects
    this.renderProjectsSection_abyssPrivate(this.el_abyssPrivate);

    // Tag groups (collapsible; archived tags filtered out). The section always
    // renders so the "+" (zero-friction tag entry) stays discoverable.
    const groups = resolveEffectiveTagGroups(
      this.settings_abyssPrivate,
      collectTaskNodeTags(allNodes),
    ).filter((group) => !group.archived);
    this.renderCollapsibleSection_abyssPrivate('tags', 'Tags', {
      addAction: (): void => {
        this.startInlineAdd_abyssPrivate('tags', 'Tag name…', (name) =>
          this.addTagGroup_abyssPrivate(name),
        );
      },
      body: (body) => {
        for (const group of groups) {
          this.tagNavigation_abyssPrivate.renderTagGroup(body, group, allNodes);
        }
      },
    });
  }

  /**
   * `addGroup` rolls back a failed save only when no newer settings save started after it. So the
   * array read just before the create means the add left nothing behind; any other array means a
   * newer save kept the group, and a retry would add it a second time.
   */
  private addTagGroup_abyssPrivate(name: string): InlineAddAttempt {
    const before = this.settings_abyssPrivate.tagGroups;
    return {
      created: this.tagManager_abyssPrivate.createManualGroup(name),
      failure: (error) =>
        this.settings_abyssPrivate.tagGroups === before
          ? {
              retryable: true,
              notice: withFailureCause('Could not add the tag group.', error),
            }
          : { retryable: false, notice: tagSettingsFailureNotice('add tag group', false) },
    };
  }

  /** A `ProjectCreationError` means the note exists: the store rescans, and a retry is unsafe. */
  private addProject_abyssPrivate(name: string): InlineAddAttempt {
    return {
      created: this.createProject_abyssPrivate(name),
      failure: (error) => {
        const created = isProjectCreationError(error);
        if (created) this.projectStore_abyssPrivate?.refresh();
        return { retryable: !created, notice: projectCreationFailureNotice(error) };
      },
    };
  }

  private async createProject_abyssPrivate(name: string): Promise<void> {
    if (this.projectManager_abyssPrivate == null) return;
    // The panel opens the note itself, so an open failure cannot look like a failed create.
    const file = await this.projectManager_abyssPrivate.create(name);
    if (file !== null) await this.openCreatedProject_abyssPrivate(file);
    this.projectStore_abyssPrivate?.refresh();
  }

  /** Opens a created project note; a failure names the note, which already exists. */
  private async openCreatedProject_abyssPrivate(file: TFile): Promise<void> {
    try {
      await this.app_abyssPrivate.workspace.getLeaf(false).openFile(file);
    } catch (error) {
      console.error('[abyss-tasks] Could not open the created project', { path: file.path, error });
      new Notice(withFailureCause(`Created ${file.path}, but could not open it.`, error));
    }
  }

  private renderProjectsSection_abyssPrivate(root: HTMLElement): void {
    const activeProjects = this.projectStore_abyssPrivate?.activeForLeftPanel() ?? [];
    if (activeProjects.length === 0) return;
    this.renderCollapsibleSection_abyssPrivate('projects', 'Projects', {
      addAction:
        this.projectManager_abyssPrivate != null
          ? (): void => {
              this.startInlineAdd_abyssPrivate('projects', 'Project name…', (name) =>
                this.addProject_abyssPrivate(name),
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
    key: SectionKey,
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
      this.placeInlineAdd_abyssPrivate(key, bodyEl);
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
   * Shows an inline text input directly under a section header (not at the bottom, which breaks
   * with many rows). Used for both tag and project entry so the "+" affordance behaves identically
   * everywhere. The session keeps the input across re-renders until it commits or cancels.
   */
  private startInlineAdd_abyssPrivate(
    key: InlineAddKey,
    placeholder: string,
    attempt: (name: string) => InlineAddAttempt,
  ): void {
    // Ensure the section is expanded so the input is visible.
    if (this.settings_abyssPrivate.sectionCollapse[key]) {
      this.settings_abyssPrivate.sectionCollapse[key] = false;
      runAsyncAction(this.onSaveViewState_abyssPrivate(), 'Could not save section state');
      this.render_abyssPrivate();
    }
    const section = this.el_abyssPrivate.querySelector(`.abyss-left-section--${key}`);
    if (section == null) return;
    const existing = section.querySelector<HTMLInputElement>('.abyss-left-add-input');
    if (existing != null) {
      existing.focus();
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
    const session: InlineAddSession = {
      key,
      input,
      attempt,
      phase: 'editing',
      rendersAtCommit: this.renderCount_abyssPrivate,
    };
    this.inlineAdd_abyssPrivate = session;
    this.inlineAddSessions_abyssPrivate.add(session);
    input.addEventListener('keydown', (event) => {
      this.handleInlineAddKey_abyssPrivate(session, event);
    });
    input.addEventListener('blur', () => {
      window.setTimeout(() => {
        if (activeDocument.activeElement !== input) this.commitInlineAdd_abyssPrivate(session);
      }, 150);
    });
    window.setTimeout(() => {
      input.focus();
    }, 0);
  }

  private handleInlineAddKey_abyssPrivate(session: InlineAddSession, event: KeyboardEvent): void {
    if (isImeOwnedEvent(event)) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      // A held Enter repeats its keydown; only the first press commits or cancels.
      if (!event.repeat) this.commitInlineAdd_abyssPrivate(session);
      return;
    }
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    if (session.phase === 'committing') this.dismissInlineAdd_abyssPrivate(session);
    else this.finishInlineAdd_abyssPrivate(session);
  }

  private commitInlineAdd_abyssPrivate(session: InlineAddSession): void {
    if (session.phase !== 'editing') return;
    const value = session.input.value.trim();
    if (value.length === 0) {
      this.finishInlineAdd_abyssPrivate(session);
      return;
    }
    session.phase = 'committing';
    session.rendersAtCommit = this.renderCount_abyssPrivate;
    const attempt = session.attempt(value);
    runAsyncAction(
      attempt.created.then(
        () => {
          this.finishInlineAdd_abyssPrivate(session);
        },
        (error: unknown) => {
          this.failInlineAdd_abyssPrivate(session, attempt.failure(error), error);
        },
      ),
    );
  }

  /**
   * A failed create that may be retried keeps its input. It re-renders only when a render ran while
   * the create was pending, since that render may have drawn a group the failure rolled back. The
   * held input keeps its focus, value, and caret either way. Any other failure ends the session.
   */
  private failInlineAdd_abyssPrivate(
    session: InlineAddSession,
    failure: InlineAddFailure,
    error: unknown,
  ): void {
    if (!(error instanceof TagGroupValidationError))
      console.error('[abyss-tasks] Could not finish the inline add', error);
    new Notice(failure.notice);
    if (!this.canRetryInlineAdd_abyssPrivate(session, failure)) {
      this.finishInlineAdd_abyssPrivate(session);
      return;
    }
    session.phase = 'editing';
    if (session.rendersAtCommit !== this.renderCount_abyssPrivate) this.render_abyssPrivate();
  }

  /**
   * A retry is safe only while the session is still the panel's committing record, its input is
   * connected and focused, and its section says the create left nothing behind. Otherwise a retry
   * would repeat a kept create, or the blur check of an input that the user left or a render
   * dropped would create on its own.
   */
  private canRetryInlineAdd_abyssPrivate(
    session: InlineAddSession,
    failure: InlineAddFailure,
  ): boolean {
    const { input } = session;
    return (
      this.inlineAdd_abyssPrivate === session &&
      session.phase === 'committing' &&
      input.isConnected &&
      input.ownerDocument.activeElement === input &&
      failure.retryable
    );
  }

  /**
   * Ends the session and releases its input. A session that already ended leaves the panel alone:
   * destroy() ends every live session, and a render that could not place a focused input ends
   * that one.
   */
  private finishInlineAdd_abyssPrivate(session: InlineAddSession): void {
    if (session.phase === 'ended') return;
    this.closeInlineAdd_abyssPrivate(session);
    this.releaseInlineAdd_abyssPrivate(session);
  }

  /**
   * An Escape while a create is pending. The create cannot be withdrawn, so only the input goes:
   * the session stays committing and live until its create settles, which ends it and re-renders.
   */
  private dismissInlineAdd_abyssPrivate(session: InlineAddSession): void {
    if (this.inlineAdd_abyssPrivate === session) this.inlineAdd_abyssPrivate = undefined;
    this.releaseInlineAdd_abyssPrivate(session);
  }

  /** Focus the input holds moves to the panel, then the re-render removes the input. */
  private releaseInlineAdd_abyssPrivate(session: InlineAddSession): void {
    const { input } = session;
    if (input.ownerDocument.activeElement === input && this.el_abyssPrivate.isConnected)
      this.el_abyssPrivate.focus({ preventScroll: true });
    this.render_abyssPrivate();
  }

  /**
   * Ends the session and drops it from the live set without touching the DOM; a pending blur check
   * or create then leaves the panel alone. The record clears only while it is still this session.
   */
  private closeInlineAdd_abyssPrivate(session: InlineAddSession): void {
    session.phase = 'ended';
    this.inlineAddSessions_abyssPrivate.delete(session);
    if (this.inlineAdd_abyssPrivate === session) this.inlineAdd_abyssPrivate = undefined;
  }

  private holdInlineAdd_abyssPrivate(): InlineAddHold | undefined {
    const session = this.inlineAdd_abyssPrivate;
    if (session === undefined) return undefined;
    const { input } = session;
    return {
      session,
      hadFocus: input.ownerDocument.activeElement === input,
      selectionStart: input.selectionStart,
      selectionEnd: input.selectionEnd,
      selectionDirection: input.selectionDirection,
    };
  }

  private placeInlineAdd_abyssPrivate(key: SectionKey, body: HTMLElement): void {
    const session = this.inlineAdd_abyssPrivate;
    if (session?.key === key) body.insertBefore(session.input, body.firstChild);
  }

  /**
   * A rebuilt panel gives the held input back its focus and caret. When the rebuilt panel has no
   * place for it, a focused session ends without a commit; a blurred one keeps its blur commit.
   */
  private settleInlineAdd_abyssPrivate(hold: InlineAddHold | undefined): void {
    if (hold === undefined || this.inlineAdd_abyssPrivate !== hold.session) return;
    const { input } = hold.session;
    if (!input.isConnected) {
      if (hold.hadFocus) this.closeInlineAdd_abyssPrivate(hold.session);
      return;
    }
    if (!hold.hadFocus || input.ownerDocument.activeElement === input) return;
    input.focus({ preventScroll: true });
    input.setSelectionRange(
      hold.selectionStart,
      hold.selectionEnd,
      hold.selectionDirection ?? undefined,
    );
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
      changeProjectStatus(projectManager, { path, statusId }, () => {
        this.projectStore_abyssPrivate?.refresh();
        this.render_abyssPrivate();
      }),
    );
  }

  private openProjectNote_abyssPrivate(path: string): void {
    runAsyncAction(openProjectNote(this.app_abyssPrivate, path));
  }

  private renderSmartList_abyssPrivate(
    ...args: [HTMLElement, ListSelection, string, string, number | string, string?]
  ): void {
    const [parent, selection, label, icon, count, tooltip] = args;
    const current = this.state_abyssPrivate.get('selectedList');
    const isActive = current === selection;
    const row = parent.createDiv({ cls: `abyss-left-item${isActive ? ' is-active' : ''}` });

    const left = row.createDiv({ cls: 'abyss-left-item-left' });
    const iconEl = left.createSpan({ cls: 'abyss-left-icon' });
    setIcon(iconEl, icon);
    left.createSpan({ cls: 'abyss-left-label', text: label });
    this.appendCustomDot_abyssPrivate(left, selection);

    if (typeof count === 'string' ? count !== '0' : count > 0) {
      row.createSpan({
        cls: 'abyss-left-count',
        text: String(count),
        ...(tooltip === undefined ? {} : { attr: { 'aria-label': tooltip } }),
      });
    }

    row.addEventListener('click', () => {
      this.navigation_abyssPrivate.openList(selection);
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

  private draggedCenterRoot_abyssPrivate(): TaskSnapshot | undefined {
    const payload = this.state_abyssPrivate.get('draggingTaskNode');
    return payload?.source === 'center-card' &&
      payload.task.target.type === 'task' &&
      payload.task.path.length === 0
      ? payload.task.root
      : undefined;
  }

  private async assignTagFromInbox_abyssPrivate(task: TaskSnapshot, tag: string): Promise<void> {
    presentTaskCommandResult(
      await this.tasks_abyssPrivate.execute({
        type: 'patch',
        target: { type: 'task', ref: task.ref },
        patch: { tags: { add: [tag] } },
      }),
    );
  }

  private countInbox_abyssPrivate(tasks: TaskSnapshot[]): number {
    const { inbox } = this.settings_abyssPrivate;
    const allOpen = tasks.filter((t) => t.status === 'open');
    const normalized = normalizeTaskTagInput(inbox.tag);
    const inboxTag = normalized?.length === 1 ? normalized[0] : undefined;
    const withTag =
      inbox.mode !== 'untagged' && inboxTag !== undefined
        ? allOpen.filter((t) => t.tags.some((candidate) => sameTag(candidate, inboxTag)))
        : [];
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

  private countToday_abyssPrivate(
    tasks: readonly TaskSnapshot[],
    today: LocalDate,
  ): { todayCount: number; overdue: number } {
    let todayCount = 0;
    let overdue = 0;
    const activeStatuses = ['open', 'in-progress'];
    const seen = new Set<string>();
    for (const task of tasks) {
      if (!activeStatuses.includes(task.status)) continue;
      const category = todayTaskCategory(task, today);
      if (category === undefined) continue;
      const key = `${task.source.filePath}:${task.source.line}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (category === 'overdue') overdue += 1;
      else todayCount += 1;
    }
    return { todayCount, overdue };
  }

  private countUpcoming_abyssPrivate(tasks: TaskSnapshot[], today: string): number {
    return tasks.filter((t) => {
      if (t.status !== 'open') return false;
      const d = t.planning.due ?? t.planning.scheduled;
      return d !== undefined && d > today;
    }).length;
  }
}
