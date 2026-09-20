import {
  type App,
  getIconIds,
  Notice,
  Platform,
  type Plugin,
  PluginSettingTab,
  setIcon,
  Setting,
  type SettingDefinitionItem,
} from 'obsidian';
import { extractMarkdownBodyTags } from '../markdown/markdownTagRename';
import {
  ObsidianProjectProperties,
  type ProjectPropertyCatalog,
} from '../projects/ObsidianProjectProperties';
import { sameProjectPropertyName } from '../projects/projectPropertyNames';
import { projectStatusDisplayName } from '../projects/status';
import { StatusRegistry } from '../status/StatusRegistry';
import { TYPE_LABELS, TYPE_ORDER } from '../status/statusConstants';
import { type TagGroupUpdate, type TagManager } from '../tags/TagManager';
import { type EffectiveTagGroup, resolveEffectiveTagGroups } from '../tags/effectiveTagGroups';
import { collectTaskNodeTags } from '../tags/taskTagCatalog';
import { normalizeTaskTagInput, type TaskDependencyQueryApi, type TaskStatusType } from '../tasks';
import { renderStatusMarker } from '../ui/StatusMarker';
import { runAsyncAction } from '../ui/runAsyncAction';
import { renderProjectTableSettings } from './projectTableSettings';
import { type ProjectValueRowControls, renderProjectValueRow } from './projectValueRow';
import { renderSettingsCard } from './settingsCard';
import { captureSettingsRenderContext, restoreSettingsRenderContext } from './settingsRenderState';
import { saveSettingsDraft } from './settingsSaveFailure';
import { SettingsValueCommit } from './settingsValueCommit';
import {
  type ParsedShortcutAlternative,
  SHORTCUT_ACTION_IDS,
  SHORTCUT_ACTIONS,
  type ShortcutActionId,
  type ShortcutIssue,
  type ShortcutPlatform,
  validateShortcuts,
} from './shortcuts';
import { type TaskStorageSettings, validateTaskStorageDraft } from './taskStorageSettings';
import type { CalendarSettings, ProjectStatus, TaskStatusDef } from './types';

const IGNORED_SOURCE_EXAMPLE = '#private';
const IGNORED_SOURCE_DESCRIPTION =
  'Exclude note paths, tags, or frontmatter from all task views. Example: archive/ OR #private.';

interface TaskCalendarPlugin extends Plugin {
  settings: CalendarSettings;
  tagManager?: TagManager;
  queries?: Pick<TaskDependencyQueryApi, 'listNodes'>;
  rebuildTaskStatusSemantics(): void;
  saveSettings(): Promise<void>;
  saveTaskStorageSettings?(draft: TaskStorageSettings): Promise<void>;
  saveViewState(): Promise<void>;
  refreshProjectTableSettings(): void;
  renameProjectStatus(id: string, name: string, expectedName: string): Promise<void>;
}

interface TagSettingsActionCallbacks {
  readonly onSuccess?: () => void;
  readonly onFailure?: () => void;
}

interface CardListOptions<T> {
  listKey: string;
  id: (item: T) => string;
  title: (item: T) => string;
  accent?: (item: T) => string | undefined;
  badge?: (item: T) => string | undefined;
  preview?: (headerEl: HTMLElement, item: T) => void;
  body: (bodyEl: HTMLElement, item: T) => void;
  onReorder: (draggedId: string, targetId: string) => boolean;
  groupKey?: string;
  onCrossGroupDrop?: (draggedId: string, targetGroupKey: string) => void;
}

interface CardDragPayload {
  id: string;
  listKey: string;
  groupKey?: string;
}

type ReorderItemsOptions<T> = readonly [
  idFor: (item: T) => string,
  persist: () => Promise<void>,
  action: string,
];

function parseCardDragPayload(raw: string | undefined): CardDragPayload | null {
  if (raw === undefined || raw === '') return null;
  try {
    const payload = JSON.parse(raw) as Partial<CardDragPayload>;
    return typeof payload.id === 'string' && typeof payload.listKey === 'string'
      ? (payload as CardDragPayload)
      : null;
  } catch {
    return null;
  }
}

interface ShortcutIssueView {
  inputs: ReadonlyMap<ShortcutActionId, HTMLInputElement>;
  messages: ReadonlyMap<ShortcutActionId, HTMLElement>;
  announcementEl: HTMLElement;
}

interface ShortcutIssueUpdate extends ShortcutIssueView {
  announce: boolean;
  announcedAction?: ShortcutActionId;
}

interface ShortcutIssueRender {
  action: ShortcutActionId;
  input: HTMLInputElement;
  messageEl: HTMLElement;
  issues: readonly ShortcutIssue[];
  active: readonly ParsedShortcutAlternative[];
}

interface TaskStatusIconResults {
  host: HTMLElement;
  def: TaskStatusDef;
  iconIds: readonly string[];
  query: string;
  focusIcon?: string;
  selectIcon: (iconId: string) => void;
}

interface ProjectMetadataSourceSetting {
  readonly description: string;
  readonly key: 'statusProperty' | 'startProperty' | 'endProperty';
  readonly name: string;
}

interface PendingProjectStatusRename {
  readonly expectedName: string;
  readonly requestedName: string;
}

let nextSettingsTabScope = 0;

/** Returns an error message if `symbol` is invalid for a status, else null. */
export function validateStatusSymbol(
  symbol: string,
  all: Array<{ id: string; symbol: string }>,
  selfId: string,
): string | null {
  // Use UTF-16 code-unit length (not [...symbol] codepoint length): the bracket
  // symbol is matched by parser regexes without the `u` flag (`\[(.)\]`), so a
  // surrogate-pair emoji (2 code units) would pass validation here but then never
  // match as a task at all. Multi-codepoint icons are fine elsewhere (e.g. the
  // status icon), just not for this bracket symbol.
  if (symbol.length !== 1) return 'Symbol must be a single character';
  if (all.some((s) => s.id !== selfId && s.symbol === symbol))
    return 'Symbol already used by another status';
  return null;
}

function describeShortcutIssues(
  action: ShortcutActionId,
  issues: readonly ShortcutIssue[],
  active: readonly ParsedShortcutAlternative[],
): string {
  let activeText = 'No alternatives remain active.';
  if (active.length > 0) {
    const verb = active.length === 1 ? 'remains' : 'remain';
    activeText = `${active.map((binding) => binding.fragment).join(' and ')} ${verb} active.`;
  }
  const labelFor = (actionId: ShortcutActionId): string =>
    SHORTCUT_ACTIONS.find((candidate) => candidate.id === actionId)?.label ?? actionId;
  const descriptions = issues.map((issue) => {
    let message: string;
    switch (issue.kind) {
      case 'empty':
        message = `Alternative ${issue.fragmentIndex + 1} is empty and is disabled.`;
        break;
      case 'invalid':
        message = `${issue.fragment} is invalid and is disabled.`;
        break;
      case 'duplicate':
        message = `${issue.fragment} duplicates ${issue.duplicateOf} and is disabled.`;
        break;
      case 'conflict':
        message = `${issue.fragment} conflicts with ${issue.conflictingActions
          .filter((actionId) => actionId !== action)
          .map(labelFor)
          .join(' and ')} and is disabled.`;
        break;
    }
    return { issue, message };
  });
  const sortedDescriptions = [...descriptions];
  sortedDescriptions.sort(
    (left, right) =>
      Number(left.issue.kind === 'conflict') - Number(right.issue.kind === 'conflict'),
  );
  return `${sortedDescriptions.map(({ message }) => message).join(' ')} ${activeText}`;
}

export class CalendarSettingsTab extends PluginSettingTab {
  /** Ids of cards (statuses / tag groups) currently expanded — persists across re-renders. */
  private readonly expandedCards_abyssPrivate = new Set<string>();
  /** Status id → its collapsed-card header preview chip host, so an icon edit can refresh it live. */
  private readonly statusHeaderPreviewEls_abyssPrivate = new Map<string, HTMLElement>();
  /** A Hotkeys edit waits for the active write, then persists only the latest pending value. */
  private shortcutSaveInFlight_abyssPrivate: Promise<void> | undefined = undefined;
  private shortcutSaveQueued_abyssPrivate = false;
  private shortcutSaveFailed_abyssPrivate = false;
  private shortcutSaveStatusEl_abyssPrivate: HTMLElement | undefined;
  private shortcutSaveRetryEl_abyssPrivate: HTMLButtonElement | undefined;
  private readonly openSections_abyssPrivate = new Set<string>();
  private readonly sectionScope_abyssPrivate = ++nextSettingsTabScope;
  private projectSettingsCleanup_abyssPrivate: (() => void) | undefined = undefined;
  private settingsValueCommit_abyssPrivate: SettingsValueCommit | undefined = undefined;
  private settingsVisible_abyssPrivate = false;
  private readonly pendingProjectStatusRenames_abyssPrivate = new Map<
    string,
    PendingProjectStatusRename
  >();
  private propertyCatalogCleanup_abyssPrivate: (() => void) | undefined = undefined;
  private propertyCatalogSignature_abyssPrivate: string | undefined = undefined;

  constructor(
    app: App,
    private readonly plugin_abyssPrivate: TaskCalendarPlugin,
    private readonly projectProperties_abyssPrivate: ProjectPropertyCatalog = new ObsidianProjectProperties(
      app,
    ),
  ) {
    super(app, plugin_abyssPrivate);
    this.containerEl.addClass('abyss-settings-tab');
  }

  override getSettingDefinitions(): SettingDefinitionItem[] {
    return [];
  }

  /**
   * Renders a list of collapsible, drag-to-reorder cards. Collapsed by default
   * (title only) so the whole set can be scanned at a glance; click to expand
   * and edit. Shared by statuses and tag groups for a consistent UI.
   */
  private renderCardList_abyssPrivate<T>(
    containerEl: HTMLElement,
    items: T[],
    opts: CardListOptions<T>,
  ): void {
    items.forEach((item) => {
      this.renderCard_abyssPrivate(containerEl, item, opts);
    });
  }

  private renderCard_abyssPrivate<T>(
    containerEl: HTMLElement,
    item: T,
    opts: CardListOptions<T>,
  ): void {
    renderSettingsCard({
      container: containerEl,
      item,
      expandedIds: this.expandedCards_abyssPrivate,
      id: opts.id,
      listKey: opts.listKey,
      ...(opts.groupKey === undefined ? {} : { groupKey: opts.groupKey }),
      title: opts.title,
      renderSummary: (header, value) => {
        opts.preview?.(header, value);
        const accent = opts.accent?.(value);
        if (accent !== undefined && accent !== '') {
          const dot = header.createSpan({ cls: 'abyss-status-dot' });
          dot.style.background = accent;
        }
        header.createSpan({ cls: 'abyss-settings-card-title', text: opts.title(value) });
        const badge = opts.badge?.(value);
        if (badge !== undefined && badge !== '') {
          header.createSpan({ cls: 'abyss-settings-card-badge', text: badge });
        }
      },
      renderBody: opts.body,
      onReorder: opts.onReorder,
      ...(opts.onCrossGroupDrop === undefined ? {} : { onCrossGroupDrop: opts.onCrossGroupDrop }),
    });
  }

  private reorderItems_abyssPrivate<T>(
    items: T[],
    draggedId: string,
    targetId: string,
    options: ReorderItemsOptions<T>,
  ): boolean {
    const [idFor, persist, action] = options;
    const from = items.findIndex((item) => idFor(item) === draggedId);
    const to = items.findIndex((item) => idFor(item) === targetId);
    if (from < 0 || to < 0 || from === to) return false;
    items.splice(to, 0, ...items.splice(from, 1));
    saveSettingsDraft({ action, save: persist });
    return true;
  }

  private commitDraft_abyssPrivate(
    action: string,
    focus?: () => HTMLElement | null,
    rebuildStatuses = false,
  ): void {
    if (rebuildStatuses) this.plugin_abyssPrivate.rebuildTaskStatusSemantics();
    this.render_abyssPrivate(focus);
    saveSettingsDraft({
      action,
      save: () =>
        rebuildStatuses
          ? this.persistStatuses_abyssPrivate()
          : this.plugin_abyssPrivate.saveSettings(),
    });
  }

  override display(): void {
    this.settingsVisible_abyssPrivate = true;
    this.propertyCatalogSignature_abyssPrivate = this.projectCatalogSignature_abyssPrivate();
    this.propertyCatalogCleanup_abyssPrivate ??= this.projectProperties_abyssPrivate.onChange(
      () => {
        const signature = this.projectCatalogSignature_abyssPrivate();
        if (signature === this.propertyCatalogSignature_abyssPrivate) return;
        this.propertyCatalogSignature_abyssPrivate = signature;
        this.render_abyssPrivate();
      },
    );
    this.render_abyssPrivate();
  }

  override hide(): void {
    this.settingsVisible_abyssPrivate = false;
    const valueCommit = this.settingsValueCommit_abyssPrivate;
    this.settingsValueCommit_abyssPrivate = undefined;
    valueCommit?.flush();
    valueCommit?.dispose();
    this.projectSettingsCleanup_abyssPrivate?.();
    this.projectSettingsCleanup_abyssPrivate = undefined;
    this.propertyCatalogCleanup_abyssPrivate?.();
    this.propertyCatalogCleanup_abyssPrivate = undefined;
    super.hide();
  }

  private render_abyssPrivate(focus?: () => HTMLElement | null): void {
    if (!this.settingsVisible_abyssPrivate) return;
    const { containerEl } = this;
    const renderContext = captureSettingsRenderContext(containerEl);
    const previousValueCommit = this.settingsValueCommit_abyssPrivate;
    this.settingsValueCommit_abyssPrivate = undefined;
    previousValueCommit?.dispose();
    const previousCleanup = this.projectSettingsCleanup_abyssPrivate;
    this.projectSettingsCleanup_abyssPrivate = undefined;
    this.statusHeaderPreviewEls_abyssPrivate.clear();
    const nextContainer = containerEl.ownerDocument.adoptNode(createFragment().createDiv());
    const valueCommit = new SettingsValueCommit(containerEl);
    this.settingsValueCommit_abyssPrivate = valueCommit;

    this.addSection_abyssPrivate(nextContainer, 'General', 'sliders-horizontal', (body) => {
      this.renderGeneralSettings_abyssPrivate(body);
    });
    this.addSection_abyssPrivate(nextContainer, 'Inbox', 'inbox', (body) => {
      this.renderInboxSettings_abyssPrivate(body);
    });
    this.addSection_abyssPrivate(nextContainer, 'Tags', 'tags', (body) => {
      this.renderTagGroupSettings_abyssPrivate(body);
    });
    this.addSection_abyssPrivate(nextContainer, 'Projects', 'folder-kanban', (body) => {
      this.renderProjectsSettings_abyssPrivate(body);
    });
    this.addSection_abyssPrivate(nextContainer, 'Custom statuses', 'list-checks', (body) => {
      this.renderTaskStatusesSettings_abyssPrivate(body);
    });
    this.addSection_abyssPrivate(nextContainer, 'Hotkeys', 'keyboard', (body) => {
      this.renderShortcutSettings_abyssPrivate(body);
    });
    previousCleanup?.();
    containerEl.replaceChildren(...nextContainer.childNodes);
    restoreSettingsRenderContext(containerEl, renderContext, focus);
  }

  private projectCatalogSignature_abyssPrivate(): string {
    return JSON.stringify(this.projectProperties_abyssPrivate.list() ?? null);
  }

  private addSection_abyssPrivate(
    containerEl: HTMLElement,
    title: string,
    icon: string,
    renderFn: (bodyEl: HTMLElement) => void,
  ): void {
    const isOpen = this.openSections_abyssPrivate.has(title);
    const section = containerEl.createDiv({
      cls: `abyss-settings-section${isOpen ? ' is-open' : ''}`,
      attr: { 'data-section-title': title },
    });
    const bodyId = `abyss-settings-section-${this.sectionScope_abyssPrivate}-${title
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, '-')}`;

    const header = section.createEl('button', {
      cls: 'abyss-settings-section-header',
      attr: {
        type: 'button',
        'aria-expanded': String(isOpen),
        'aria-controls': bodyId,
      },
    });

    const iconEl = header.createDiv({ cls: 'abyss-settings-section-icon' });
    setIcon(iconEl, icon);

    header.createSpan({ cls: 'abyss-settings-section-label', text: title });

    const chevronEl = header.createDiv({ cls: 'abyss-settings-section-chevron' });
    setIcon(chevronEl, 'chevron-right');

    const body = section.createDiv({
      cls: 'abyss-settings-section-body',
      attr: { id: bodyId },
    });
    body.hidden = !isOpen;
    const bodyInner = body.createDiv({ cls: 'abyss-settings-section-body-inner' });
    renderFn(bodyInner);

    header.addEventListener('click', () => {
      const opening = !section.classList.contains('is-open');
      section.classList.toggle('is-open', opening);
      header.setAttribute('aria-expanded', String(opening));
      body.hidden = !opening;
      if (opening) this.openSections_abyssPrivate.add(title);
      else this.openSections_abyssPrivate.delete(title);
    });
  }

  private renderGeneralSettings_abyssPrivate(containerEl: HTMLElement): void {
    new Setting(containerEl).setName('First day of week').addDropdown((dropdown) =>
      dropdown
        .addOptions({
          '0': 'Sunday',
          '1': 'Monday',
          '2': 'Tuesday',
          '3': 'Wednesday',
          '4': 'Thursday',
          '5': 'Friday',
          '6': 'Saturday',
        })
        .setValue(String(this.plugin_abyssPrivate.settings.firstDayOfWeek))
        .onChange(async (value) => {
          this.plugin_abyssPrivate.settings.firstDayOfWeek = Number(
            value,
          ) as CalendarSettings['firstDayOfWeek'];
          await this.plugin_abyssPrivate.saveSettings();
        }),
    );
    this.renderTaskCreationSettings_abyssPrivate(containerEl);
    this.renderTaskDestinationSettings_abyssPrivate(containerEl);
    this.renderTaskLifecycleSettings_abyssPrivate(containerEl);
    this.renderRecurrenceSettings_abyssPrivate(containerEl);
  }

  private renderTaskCreationSettings_abyssPrivate(containerEl: HTMLElement): void {
    const taskPrefixDescription = (): string => {
      const taggedPrefixInUntaggedInbox =
        this.plugin_abyssPrivate.settings.inbox.mode === 'untagged' &&
        extractMarkdownBodyTags(this.plugin_abyssPrivate.settings.taskPrefix).length > 0;
      return `Prepended when adding a new task (e.g. #Task/one-off). Tasks added from Inbox skip this prefix.${taggedPrefixInUntaggedInbox ? ' Tasks created elsewhere with this prefix do not appear in an untagged inbox.' : ''}`;
    };
    const taskPrefixSetting = new Setting(containerEl)
      .setName('Task prefix')
      .setDesc(taskPrefixDescription())
      .addText((t) =>
        t
          .setPlaceholder('#Task/one-off')
          .setValue(this.plugin_abyssPrivate.settings.taskPrefix)
          .onChange(async (v) => {
            this.plugin_abyssPrivate.settings.taskPrefix = v;
            await this.plugin_abyssPrivate.saveSettings();
            taskPrefixSetting.setDesc(taskPrefixDescription());
          }),
      );

    new Setting(containerEl)
      .setName('Source note display')
      .setDesc('Show which note a task comes from, before the tag chip in list view.')
      .addDropdown((d) =>
        d
          .addOptions({
            never: 'Never',
            'non-default': 'Non-default notes',
            always: 'Always',
          })
          .setValue(this.plugin_abyssPrivate.settings.sourceNoteDisplay)
          .onChange(async (v) => {
            this.plugin_abyssPrivate.settings.sourceNoteDisplay =
              v as CalendarSettings['sourceNoteDisplay'];
            await this.plugin_abyssPrivate.saveSettings();
          }),
      );
  }

  private renderTaskLifecycleSettings_abyssPrivate(containerEl: HTMLElement): void {
    new Setting(containerEl)
      .setName('Add created date')
      .setDesc('Add a created date to newly created tasks.')
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin_abyssPrivate.settings.taskLifecycle.addCreatedDate)
          .onChange(async (value) => {
            this.plugin_abyssPrivate.settings.taskLifecycle.addCreatedDate = value;
            await this.plugin_abyssPrivate.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Add completion date')
      .setDesc('Add a completion date when a task is completed.')
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin_abyssPrivate.settings.taskLifecycle.addCompletionDate)
          .onChange(async (value) => {
            this.plugin_abyssPrivate.settings.taskLifecycle.addCompletionDate = value;
            await this.plugin_abyssPrivate.saveSettings();
          }),
      );
  }

  private renderRecurrenceSettings_abyssPrivate(containerEl: HTMLElement): void {
    new Setting(containerEl)
      .setName('New occurrence placement')
      .setDesc('Place recurring task occurrences before or after the completed task.')
      .addDropdown((dropdown) =>
        dropdown
          .addOptions({ before: 'Before completed task', after: 'After completed task' })
          .setValue(this.plugin_abyssPrivate.settings.recurrence.newOccurrencePlacement)
          .onChange(async (value) => {
            this.plugin_abyssPrivate.settings.recurrence.newOccurrencePlacement = value as
              'before' | 'after';
            await this.plugin_abyssPrivate.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Remove scheduled date')
      .setDesc('Remove the scheduled date from a newly generated recurring task.')
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin_abyssPrivate.settings.recurrence.removeScheduledDate)
          .onChange(async (value) => {
            this.plugin_abyssPrivate.settings.recurrence.removeScheduledDate = value;
            await this.plugin_abyssPrivate.saveSettings();
          }),
      );
  }

  private renderTaskDestinationSettings_abyssPrivate(containerEl: HTMLElement): void {
    new Setting(containerEl)
      .setName('Task file')
      .setDesc('New tasks are captured here. For dated files, use tasks/{{YYYY-MM-DD}}.md.')
      .addText((text) =>
        text
          .setPlaceholder('tasks/active.md')
          .setValue(this.plugin_abyssPrivate.settings.taskFilePath)
          .onChange(async (value) => {
            this.plugin_abyssPrivate.settings.taskFilePath = value;
            await this.plugin_abyssPrivate.saveSettings();
          }),
      );

    this.renderArchiveSettings_abyssPrivate(containerEl);

    new Setting(containerEl)
      .setName('Note template')
      .setDesc('Optional template for a task file created during capture.')
      .addText((text) =>
        text
          .setPlaceholder('templates/task.md')
          .setValue(this.plugin_abyssPrivate.settings.taskTemplatePath)
          .onChange(async (value) => {
            this.plugin_abyssPrivate.settings.taskTemplatePath = value;
            await this.plugin_abyssPrivate.saveSettings();
          }),
      );

    this.renderTaskInsertionSettings_abyssPrivate(containerEl);
  }

  private renderArchiveSettings_abyssPrivate(containerEl: HTMLElement): void {
    let archiveInput!: HTMLInputElement;
    let ignoreInput!: HTMLInputElement;
    const archiveSetting = new Setting(containerEl)
      .setName('Archive file')
      .setDesc('Tasks are archived here. Use {{YYYY-MM-DD}} for a local date.')
      .addText((text) => {
        text
          .setPlaceholder('tasks/archive.md')
          .setValue(this.plugin_abyssPrivate.settings.taskArchivePath);
        archiveInput = text.inputEl;
      });
    const ignoreSetting = new Setting(containerEl)
      .setName('Ignored task sources')
      .setDesc(IGNORED_SOURCE_DESCRIPTION)
      .addText((text) => {
        text
          .setPlaceholder(IGNORED_SOURCE_EXAMPLE)
          .setValue(this.plugin_abyssPrivate.settings.taskIgnoreQuery);
        ignoreInput = text.inputEl;
      });
    const storageDraft = (): TaskStorageSettings => ({
      taskArchivePath: archiveInput.value,
      taskIgnoreQuery: ignoreInput.value,
    });
    const commitStorage = (): boolean => {
      archiveSetting.setDesc('Tasks are archived here. Use {{YYYY-MM-DD}} for a local date.');
      ignoreSetting.setDesc(IGNORED_SOURCE_DESCRIPTION);
      const validation = validateTaskStorageDraft(
        {
          taskArchivePath: this.plugin_abyssPrivate.settings.taskArchivePath,
          taskIgnoreQuery: this.plugin_abyssPrivate.settings.taskIgnoreQuery,
        },
        storageDraft(),
      );
      if (validation.type === 'invalid') {
        const target = validation.field === 'taskArchivePath' ? archiveSetting : ignoreSetting;
        target.setDesc(validation.message);
        return false;
      }
      saveSettingsDraft({
        action: 'save task storage settings',
        save: async () => {
          if (this.plugin_abyssPrivate.saveTaskStorageSettings !== undefined) {
            await this.plugin_abyssPrivate.saveTaskStorageSettings(storageDraft());
          } else {
            this.plugin_abyssPrivate.settings.taskArchivePath = validation.settings.taskArchivePath;
            this.plugin_abyssPrivate.settings.taskIgnoreQuery = validation.settings.taskIgnoreQuery;
            await this.plugin_abyssPrivate.saveSettings();
          }
          archiveInput.value = this.plugin_abyssPrivate.settings.taskArchivePath;
          ignoreInput.value = this.plugin_abyssPrivate.settings.taskIgnoreQuery;
          this.settingsValueCommit_abyssPrivate?.synchronize(archiveInput);
          this.settingsValueCommit_abyssPrivate?.synchronize(ignoreInput);
        },
      });
      return true;
    };
    this.settingsValueCommit_abyssPrivate?.register(archiveInput, commitStorage);
    this.settingsValueCommit_abyssPrivate?.register(ignoreInput, commitStorage);
  }

  private renderTaskInsertionSettings_abyssPrivate(containerEl: HTMLElement): void {
    new Setting(containerEl)
      .setName('Insert position')
      .setDesc('Where in the task file to add new tasks.')
      .addDropdown((dropdown) =>
        dropdown
          .addOptions({
            append: 'End of file',
            prepend: 'Start of file',
            section: 'In section',
          })
          .setValue(this.plugin_abyssPrivate.settings.taskInsertionMode)
          .onChange(async (value) => {
            this.plugin_abyssPrivate.settings.taskInsertionMode =
              value as typeof this.plugin_abyssPrivate.settings.taskInsertionMode;
            await this.plugin_abyssPrivate.saveSettings();
            this.render_abyssPrivate();
          }),
      );
    if (this.plugin_abyssPrivate.settings.taskInsertionMode !== 'section') return;
    new Setting(containerEl)
      .setName('Section heading')
      .setDesc('Tasks are inserted under this heading. Created if absent.')
      .addText((text) =>
        text
          .setPlaceholder('## Tasks')
          .setValue(this.plugin_abyssPrivate.settings.taskInsertionSection)
          .onChange(async (value) => {
            this.plugin_abyssPrivate.settings.taskInsertionSection = value;
            await this.plugin_abyssPrivate.saveSettings();
          }),
      );
    new Setting(containerEl)
      .setName('Section position')
      .setDesc('Place new tasks at the top or bottom of this section.')
      .addDropdown((dropdown) =>
        dropdown
          .addOptions({ top: 'Top of section', bottom: 'Bottom of section' })
          .setValue(this.plugin_abyssPrivate.settings.taskInsertionSectionPosition)
          .onChange(async (value) => {
            this.plugin_abyssPrivate.settings.taskInsertionSectionPosition = value as
              'top' | 'bottom';
            await this.plugin_abyssPrivate.saveSettings();
          }),
      );
  }

  private shortcutPlatform_abyssPrivate(): ShortcutPlatform {
    return { mod: Platform.isMacOS ? 'meta' : 'ctrl' };
  }

  private renderShortcutSettings_abyssPrivate(containerEl: HTMLElement): void {
    const inputEls = new Map<ShortcutActionId, HTMLInputElement>();
    const issueEls = new Map<ShortcutActionId, HTMLElement>();
    containerEl.createDiv({
      cls: 'abyss-shortcut-help',
      text: 'Use A–Z or 0–9 with optional Alt, Ctrl, Meta, Shift, or Mod. Separate alternatives with |, for example Q | shift 7.',
    });
    const validationStatus = containerEl.createDiv({
      cls: 'abyss-shortcut-validation-status abyss-sr-only',
      attr: { role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' },
    });
    const saveFeedback = containerEl.createDiv({ cls: 'abyss-shortcut-save-feedback' });
    this.shortcutSaveStatusEl_abyssPrivate = saveFeedback.createSpan({
      cls: 'abyss-shortcut-save-status',
      attr: { role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' },
    });
    this.shortcutSaveRetryEl_abyssPrivate = saveFeedback.createEl('button', {
      cls: 'abyss-shortcut-save-retry',
      attr: { type: 'button' },
      text: 'Retry',
    });
    this.shortcutSaveRetryEl_abyssPrivate.addEventListener('click', () => {
      this.queueShortcutSave_abyssPrivate();
    });
    this.updateShortcutSavePresentation_abyssPrivate();
    const list = containerEl.createDiv({ cls: 'abyss-shortcuts-list' });

    for (const actionId of SHORTCUT_ACTION_IDS) {
      const action = SHORTCUT_ACTIONS.find((candidate) => candidate.id === actionId);
      if (action == null) continue;
      const row = list.createDiv({ cls: 'abyss-shortcut-row' });
      const label = row.createEl('label', {
        cls: 'abyss-shortcut-label',
        text: action.label,
      });
      const input = row.createEl('input', {
        cls: 'abyss-shortcut-input',
        attr: {
          id: `abyss-shortcut-${action.id}`,
          type: 'text',
          autocomplete: 'off',
          spellcheck: 'false',
          'data-shortcut-action': action.id,
        },
      });
      label.htmlFor = input.id;
      input.value = this.plugin_abyssPrivate.settings.shortcuts[action.id];
      const issue = row.createDiv({
        cls: 'abyss-shortcut-issue',
        attr: { id: `abyss-shortcut-issue-${this.sectionScope_abyssPrivate}-${action.id}` },
      });
      inputEls.set(action.id, input);
      issueEls.set(action.id, issue);

      input.addEventListener('input', () => {
        this.plugin_abyssPrivate.settings.shortcuts[action.id] = input.value;
        this.updateShortcutIssues_abyssPrivate({
          inputs: inputEls,
          messages: issueEls,
          announcementEl: validationStatus,
          announce: false,
        });
        this.queueShortcutSave_abyssPrivate();
      });
      input.addEventListener('blur', () => {
        this.updateShortcutIssues_abyssPrivate({
          inputs: inputEls,
          messages: issueEls,
          announcementEl: validationStatus,
          announce: true,
          announcedAction: action.id,
        });
      });
    }

    this.updateShortcutIssues_abyssPrivate({
      inputs: inputEls,
      messages: issueEls,
      announcementEl: validationStatus,
      announce: false,
    });
  }

  private queueShortcutSave_abyssPrivate(): void {
    this.shortcutSaveQueued_abyssPrivate = true;
    if (this.shortcutSaveInFlight_abyssPrivate != null) return;
    this.shortcutSaveInFlight_abyssPrivate = this.flushShortcutSaves_abyssPrivate();
  }

  private async flushShortcutSaves_abyssPrivate(): Promise<void> {
    let failed = false;
    try {
      while (this.shortcutSaveQueued_abyssPrivate) {
        this.shortcutSaveQueued_abyssPrivate = false;
        try {
          await this.plugin_abyssPrivate.saveSettings();
          this.shortcutSaveFailed_abyssPrivate = false;
          this.updateShortcutSavePresentation_abyssPrivate();
        } catch (error) {
          console.error('[abyss-tasks] Could not save shortcut settings', error);
          this.shortcutSaveQueued_abyssPrivate = true;
          this.shortcutSaveFailed_abyssPrivate = true;
          this.updateShortcutSavePresentation_abyssPrivate();
          failed = true;
          break;
        }
      }
    } finally {
      this.shortcutSaveInFlight_abyssPrivate = undefined;
      if (this.shortcutSaveQueued_abyssPrivate && !failed) this.queueShortcutSave_abyssPrivate();
    }
  }

  private updateShortcutIssues_abyssPrivate(update: ShortcutIssueUpdate): void {
    const validation = validateShortcuts(
      this.plugin_abyssPrivate.settings.shortcuts,
      this.shortcutPlatform_abyssPrivate(),
    );
    const messages = new Set<string>();
    if (!update.announce) update.announcementEl.empty();
    for (const action of SHORTCUT_ACTIONS) {
      const message = this.shortcutIssueMessage_abyssPrivate(action.id, update, validation);
      const shouldAnnounce = update.announce && action.id === update.announcedAction;
      if (shouldAnnounce && message !== undefined) {
        messages.add(message);
      }
    }
    if (update.announce) update.announcementEl.setText([...messages].join(' '));
  }

  private shortcutIssueMessage_abyssPrivate(
    action: ShortcutActionId,
    update: ShortcutIssueUpdate,
    validation: ReturnType<typeof validateShortcuts>,
  ): string | undefined {
    const input = update.inputs.get(action);
    const messageEl = update.messages.get(action);
    if (input == null || messageEl == null) return undefined;
    return this.renderShortcutIssue_abyssPrivate({
      action,
      input,
      messageEl,
      issues: validation.issues.get(action) ?? [],
      active: validation.bindings.get(action) ?? [],
    });
  }

  private renderShortcutIssue_abyssPrivate(view: ShortcutIssueRender): string | undefined {
    if (view.issues.length === 0) {
      view.input.removeAttribute('aria-invalid');
      view.input.removeAttribute('aria-describedby');
      view.messageEl.empty();
      return undefined;
    }
    view.input.setAttribute('aria-invalid', 'true');
    view.input.setAttribute('aria-describedby', view.messageEl.id);
    const message = describeShortcutIssues(view.action, view.issues, view.active);
    view.messageEl.empty();
    const icon = view.messageEl.createSpan({ cls: 'abyss-shortcut-warning-icon' });
    setIcon(icon, 'triangle-alert');
    icon.setAttribute('aria-hidden', 'true');
    view.messageEl.appendText(message);
    return message;
  }

  private updateShortcutSavePresentation_abyssPrivate(): void {
    if (this.shortcutSaveStatusEl_abyssPrivate != null) {
      this.shortcutSaveStatusEl_abyssPrivate.setText(
        this.shortcutSaveFailed_abyssPrivate ? 'Shortcut changes were not saved.' : '',
      );
    }
    if (this.shortcutSaveRetryEl_abyssPrivate != null)
      this.shortcutSaveRetryEl_abyssPrivate.hidden = !this.shortcutSaveFailed_abyssPrivate;
  }

  private renderInboxSettings_abyssPrivate(containerEl: HTMLElement): void {
    new Setting(containerEl)
      .setName('Inbox source')
      .setDesc('What appears in your inbox list. Tasks added from inbox follow this rule.')
      .addDropdown((d) =>
        d
          .addOptions({
            tag: 'With inbox tag',
            untagged: 'Untagged tasks',
            both: 'Both',
          })
          .setValue(this.plugin_abyssPrivate.settings.inbox.mode)
          .onChange(async (v) => {
            const mode = v as 'tag' | 'untagged' | 'both';
            this.plugin_abyssPrivate.settings.inbox.mode = mode;
            if (mode !== 'untagged') {
              const tags = normalizeTaskTagInput(this.plugin_abyssPrivate.settings.inbox.tag);
              this.plugin_abyssPrivate.settings.inbox.tag =
                tags?.length === 1 ? (tags[0] ?? '#inbox') : '#inbox';
            }
            await this.plugin_abyssPrivate.saveSettings();
            this.render_abyssPrivate();
          }),
      );

    if (this.plugin_abyssPrivate.settings.inbox.mode !== 'untagged') {
      const inboxTagSetting = new Setting(containerEl)
        .setName('Inbox tag')
        .setDesc('Tasks with this tag appear in inbox.');
      const feedback = inboxTagSetting.descEl.createDiv({ cls: 'abyss-tag-input-feedback' });
      feedback.id = 'abyss-inbox-tag-feedback';
      inboxTagSetting.addText((text) => {
        text.inputEl.setAttribute('aria-describedby', feedback.id);
        return text
          .setPlaceholder('#Task/inbox')
          .setValue(this.plugin_abyssPrivate.settings.inbox.tag)
          .onChange(async (value) => {
            const tags = normalizeTaskTagInput(value);
            if (tags?.length !== 1) {
              text.inputEl.setAttribute('aria-invalid', 'true');
              feedback.setText('Enter one inbox tag.');
              return;
            }
            text.inputEl.removeAttribute('aria-invalid');
            feedback.setText('');
            this.plugin_abyssPrivate.settings.inbox.tag = tags[0] ?? '';
            await this.plugin_abyssPrivate.saveSettings();
          });
      });
      new Setting(containerEl)
        .setName('Remove inbox tag when assigning another tag')
        .setDesc('When another tag is assigned, the inbox tag is removed automatically.')
        .addToggle((t) =>
          t
            .setValue(this.plugin_abyssPrivate.settings.inbox.removeTagOnAssign)
            .onChange(async (v) => {
              this.plugin_abyssPrivate.settings.inbox.removeTagOnAssign = v;
              await this.plugin_abyssPrivate.saveSettings();
            }),
        );
    }
  }

  private renderTagGroupSettings_abyssPrivate(containerEl: HTMLElement): void {
    const groups = this.effectiveTagGroups_abyssPrivate().filter((group) => !group.archived);
    this.renderCardList_abyssPrivate(containerEl, groups, {
      listKey: 'tag-groups',
      id: (g) => g.id,
      title: (g) => g.name,
      accent: (g) => g.color,
      badge: (g) => (g.mode === 'prefix' ? 'prefix' : 'manual'),
      body: (bodyEl, group) => {
        this.renderTagGroupCard_abyssPrivate(bodyEl, group);
      },
      onReorder: (draggedId, targetId) => {
        const tagManager = this.plugin_abyssPrivate.tagManager;
        if (tagManager !== undefined) {
          if (draggedId === targetId) return false;
          const previousOrder = this.plugin_abyssPrivate.settings.tagGroups.map(({ id }) => id);
          runAsyncAction(
            this.runTagSettingsAction_abyssPrivate(
              tagManager.reorderGroups(draggedId, targetId, groups),
              'reorder tags',
              () =>
                previousOrder.join('\0') ===
                this.plugin_abyssPrivate.settings.tagGroups.map(({ id }) => id).join('\0'),
            ),
          );
          return true;
        }
        return this.reorderItems_abyssPrivate(
          this.plugin_abyssPrivate.settings.tagGroups,
          draggedId,
          targetId,
          [
            (group) => group.id,
            () => this.plugin_abyssPrivate.saveSettings(),
            'reorder tag groups',
          ],
        );
      },
    });

    this.renderArchivedTags_abyssPrivate(containerEl);

    new Setting(containerEl).addButton((b) =>
      b
        .setButtonText('+ add group')
        .setCta()
        .onClick(() => {
          this.addTagGroup_abyssPrivate();
        }),
    );
  }

  private addTagGroup_abyssPrivate(): void {
    const id = `group-${Date.now()}`;
    const group = { id, name: 'New group', mode: 'prefix' as const, prefix: '' };
    const tagManager = this.plugin_abyssPrivate.tagManager;
    if (tagManager === undefined) {
      this.plugin_abyssPrivate.settings.tagGroups.push(group);
      this.expandedCards_abyssPrivate.add(id);
      this.commitDraft_abyssPrivate('add tag group');
      return;
    }
    const action = tagManager.addGroup(group);
    this.expandedCards_abyssPrivate.add(id);
    this.render_abyssPrivate();
    runAsyncAction(
      this.runTagSettingsAction_abyssPrivate(
        action,
        'add tag group',
        () => !this.hasConfiguredTagGroup_abyssPrivate(id),
        { onFailure: () => this.expandedCards_abyssPrivate.delete(id) },
      ),
    );
  }

  private renderArchivedTags_abyssPrivate(containerEl: HTMLElement): void {
    const archivedGroups = this.effectiveTagGroups_abyssPrivate().filter(
      (group) => group.archived && (group.origin === 'configured' || group.mode === 'prefix'),
    );
    const archivedTags = this.plugin_abyssPrivate.settings.archivedTags;
    if (archivedGroups.length > 0 || archivedTags.length > 0) {
      new Setting(containerEl).setName('Archived').setHeading();
      for (const group of archivedGroups) {
        new Setting(containerEl).setName(group.name).addButton((button) =>
          button.setButtonText('Unarchive').onClick(() => {
            const tagManager = this.plugin_abyssPrivate.tagManager;
            if (tagManager === undefined) return;
            runAsyncAction(
              this.runTagSettingsAction_abyssPrivate(
                tagManager.unarchiveGroup(group.id),
                'unarchive tag group',
                () => this.isEffectiveGroupArchived_abyssPrivate(group.id),
              ),
            );
          }),
        );
      }
      for (const tag of archivedTags) {
        new Setting(containerEl).setName(tag).addButton((b) =>
          b.setButtonText('Unarchive').onClick(() => {
            const tagManager = this.plugin_abyssPrivate.tagManager;
            if (tagManager === undefined) return;
            runAsyncAction(
              this.runTagSettingsAction_abyssPrivate(
                tagManager.unarchiveTag(tag),
                'unarchive tag',
                () => this.plugin_abyssPrivate.settings.archivedTags.includes(tag),
              ),
            );
          }),
        );
      }
    }
  }

  private renderTagGroupCard_abyssPrivate(card: HTMLElement, group: EffectiveTagGroup): void {
    new Setting(card).setName('Group name').addText((t) =>
      t.setValue(group.name).onChange(async (v) => {
        await this.updateTagGroup_abyssPrivate(group, { name: v });
      }),
    );

    new Setting(card).setName('Mode').addDropdown((d) =>
      d
        .addOptions({ prefix: 'Prefix', manual: 'Manual' })
        .setValue(group.mode)
        .onChange(async (v) => {
          await this.updateTagGroup_abyssPrivate(group, { mode: v as 'prefix' | 'manual' });
          this.render_abyssPrivate();
        }),
    );

    new Setting(card).setName('Color').addColorPicker((cp) =>
      cp.setValue(group.color ?? '#888888').onChange(async (v) => {
        await this.updateTagGroup_abyssPrivate(group, { color: v });
      }),
    );

    this.renderTagGroupMatchSetting_abyssPrivate(card, group);

    new Setting(card).addButton((b) =>
      b
        .setButtonText(group.origin === 'configured' ? 'Delete group' : 'Archive')
        .setClass('mod-warning')
        .onClick(() => {
          this.applyTagGroupCardAction_abyssPrivate(group);
        }),
    );
  }

  private renderTagGroupMatchSetting_abyssPrivate(
    card: HTMLElement,
    group: EffectiveTagGroup,
  ): void {
    if (group.mode === 'prefix') {
      const prefixSetting = new Setting(card)
        .setName('Prefix')
        .setDesc('E.g. "work" matches #work and #work/dev');
      const feedback = prefixSetting.descEl.createDiv({ cls: 'abyss-tag-input-feedback' });
      feedback.id = `abyss-tag-prefix-feedback-${group.id}`;
      prefixSetting.addText((t) => {
        t.inputEl.setAttribute('aria-describedby', feedback.id);
        return t
          .setPlaceholder('Work')
          .setValue(group.prefix ?? '')
          .onChange(async (v) => {
            const tags = normalizeTaskTagInput(v);
            if (tags?.length !== 1) {
              t.inputEl.setAttribute('aria-invalid', 'true');
              feedback.setText('Enter one tag prefix.');
              return;
            }
            t.inputEl.removeAttribute('aria-invalid');
            feedback.setText('');
            await this.updateTagGroup_abyssPrivate(group, {
              prefix: (tags[0] ?? '').slice(1),
            });
          });
      });
    } else {
      const tagsSetting = new Setting(card)
        .setName('Tags')
        .setDesc('Comma-separated, e.g. #Work, #side-project');
      const feedback = tagsSetting.descEl.createDiv({ cls: 'abyss-tag-input-feedback' });
      feedback.id = `abyss-tag-list-feedback-${group.id}`;
      tagsSetting.addText((t) => {
        t.inputEl.setAttribute('aria-describedby', feedback.id);
        return t
          .setPlaceholder('#Work, #side-project')
          .setValue((group.tags ?? []).join(', '))
          .onChange(async (v) => {
            const segments = v
              .split(',')
              .map((segment) => segment.trim())
              .filter(Boolean);
            const normalized = segments.map((segment) => normalizeTaskTagInput(segment));
            if (normalized.some((tags) => tags === undefined)) {
              t.inputEl.setAttribute('aria-invalid', 'true');
              feedback.setText('Enter comma-separated task tags.');
              return;
            }
            t.inputEl.removeAttribute('aria-invalid');
            feedback.setText('');
            await this.updateTagGroup_abyssPrivate(group, {
              tags: [...new Set(normalized.flatMap((tags) => tags ?? []))],
            });
          });
      });
    }
  }

  private applyTagGroupCardAction_abyssPrivate(group: EffectiveTagGroup): void {
    const tagManager = this.plugin_abyssPrivate.tagManager;
    if (group.origin === 'discovered') {
      if (tagManager === undefined) return;
      const current =
        this.effectiveTagGroups_abyssPrivate().find((candidate) => candidate.id === group.id) ??
        group;
      runAsyncAction(
        this.runTagSettingsAction_abyssPrivate(
          tagManager.archiveGroup(current),
          'archive tag group',
          () => !this.isEffectiveGroupArchived_abyssPrivate(group.id),
        ),
      );
      return;
    }
    if (tagManager === undefined) {
      const configured = this.plugin_abyssPrivate.settings.tagGroups;
      const index = configured.findIndex((candidate) => candidate.id === group.id);
      const removed = index < 0 ? undefined : configured.splice(index, 1)[0];
      if (removed != null) this.expandedCards_abyssPrivate.delete(removed.id);
      this.commitDraft_abyssPrivate('delete tag group');
      return;
    }
    const action = tagManager.deleteGroup(group.id);
    this.render_abyssPrivate();
    runAsyncAction(
      this.runTagSettingsAction_abyssPrivate(
        action,
        'delete tag group',
        () => this.hasConfiguredTagGroup_abyssPrivate(group.id),
        { onSuccess: () => this.expandedCards_abyssPrivate.delete(group.id) },
      ),
    );
  }

  private hasConfiguredTagGroup_abyssPrivate(groupId: string): boolean {
    return this.plugin_abyssPrivate.settings.tagGroups.some(
      (candidate) => candidate.id === groupId,
    );
  }

  private effectiveTagGroups_abyssPrivate(): readonly EffectiveTagGroup[] {
    return resolveEffectiveTagGroups(
      this.plugin_abyssPrivate.settings,
      collectTaskNodeTags(this.plugin_abyssPrivate.queries?.listNodes() ?? []),
    );
  }

  private isEffectiveGroupArchived_abyssPrivate(groupId: string): boolean {
    return (
      this.effectiveTagGroups_abyssPrivate().find((group) => group.id === groupId)?.archived ===
      true
    );
  }

  private async updateTagGroup_abyssPrivate(
    group: EffectiveTagGroup,
    update: TagGroupUpdate,
  ): Promise<void> {
    const tagManager = this.plugin_abyssPrivate.tagManager;
    if (tagManager !== undefined) {
      const previous = this.plugin_abyssPrivate.settings.tagGroups.find(
        (candidate) => candidate.id === group.id,
      );
      const previousSnapshot = previous === undefined ? undefined : structuredClone(previous);
      try {
        await tagManager.updateGroup(group, update);
      } catch (error) {
        console.error('[abyss-tasks] Could not update tag group', error);
        const current = this.plugin_abyssPrivate.settings.tagGroups.find(
          (candidate) => candidate.id === group.id,
        );
        const rolledBack = JSON.stringify(current) === JSON.stringify(previousSnapshot);
        new Notice(this.tagSettingsFailureMessage_abyssPrivate('update tag group', rolledBack));
        this.render_abyssPrivate();
      }
      return;
    }
    const configured = this.plugin_abyssPrivate.settings.tagGroups.find(
      (candidate) => candidate.id === group.id,
    );
    if (configured === undefined) return;
    Object.assign(configured, update);
    await this.plugin_abyssPrivate.saveSettings();
  }

  private async runTagSettingsAction_abyssPrivate(
    action: Promise<void>,
    description: string,
    rolledBack: () => boolean,
    callbacks: TagSettingsActionCallbacks = {},
  ): Promise<void> {
    try {
      await action;
      callbacks.onSuccess?.();
    } catch (error) {
      console.error(`[abyss-tasks] Could not ${description}`, error);
      new Notice(this.tagSettingsFailureMessage_abyssPrivate(description, rolledBack()));
      callbacks.onFailure?.();
    }
    this.render_abyssPrivate();
  }

  private tagSettingsFailureMessage_abyssPrivate(description: string, rolledBack: boolean): string {
    return rolledBack
      ? `Could not ${description}. Your changes were rolled back.`
      : `Could not save an earlier ${description}. Newer changes were kept.`;
  }

  private renderProjectsSettings_abyssPrivate(containerEl: HTMLElement): void {
    this.renderProjectDefinitionSettings_abyssPrivate(containerEl);
    this.renderProjectTaskInsertionSettings_abyssPrivate(containerEl);
    const valueCommit = this.settingsValueCommit_abyssPrivate;
    this.projectSettingsCleanup_abyssPrivate = renderProjectTableSettings({
      app: this.app,
      container: containerEl,
      projects: this.plugin_abyssPrivate.settings.projects,
      catalog: this.projectProperties_abyssPrivate,
      saveStatic: () => this.plugin_abyssPrivate.saveSettings(),
      saveViewState: async () => {
        await this.plugin_abyssPrivate.saveViewState();
        this.plugin_abyssPrivate.refreshProjectTableSettings();
      },
      expandedCards: this.expandedCards_abyssPrivate,
      renderStatusSettings: (host) => {
        this.renderProjectStatusesSettings_abyssPrivate(host, false);
      },
      refresh: (focusCardId) => {
        this.render_abyssPrivate(
          focusCardId === undefined
            ? undefined
            : () =>
                Array.from(this.containerEl.querySelectorAll<HTMLElement>('[data-card-id]'))
                  .find((card) => card.dataset['cardId'] === focusCardId)
                  ?.querySelector<HTMLButtonElement>('.abyss-project-property-toggle') ?? null,
        );
      },
      ...(valueCommit === undefined ? {} : { valueCommit }),
    });
  }

  private renderProjectDefinitionSettings_abyssPrivate(containerEl: HTMLElement): void {
    const projects = this.plugin_abyssPrivate.settings.projects;
    new Setting(containerEl)
      .setName('Membership query')
      .setDesc('What counts as a project. Syntax: folder/, #tag, key=value, and / or / not / ( ).')
      .addText((text) =>
        text
          .setPlaceholder('Projects/')
          .setValue(projects.membershipQuery)
          .onChange(async (value) => {
            projects.membershipQuery = value;
            await this.plugin_abyssPrivate.saveSettings();
          }),
      );
    new Setting(containerEl)
      .setName('Create folder')
      .setDesc('Where new project notes are created.')
      .addText((text) =>
        text
          .setPlaceholder('Projects')
          .setValue(projects.createFolder)
          .onChange(async (value) => {
            projects.createFolder = value;
            await this.plugin_abyssPrivate.saveSettings();
          }),
      );
    new Setting(containerEl)
      .setName('Template path')
      .setDesc('Optional template for new projects. Templater is used when installed.')
      .addText((text) =>
        text
          .setPlaceholder('Templates/Project.md')
          .setValue(projects.templatePath)
          .onChange(async (value) => {
            projects.templatePath = value;
            await this.plugin_abyssPrivate.saveSettings();
          }),
      );
  }

  private renderProjectTaskInsertionSettings_abyssPrivate(containerEl: HTMLElement): void {
    const projects = this.plugin_abyssPrivate.settings.projects;
    new Setting(containerEl)
      .setName('Task insert position')
      .setDesc('Where a task is placed in a project note when created there or moved in.')
      .addDropdown((d) =>
        d
          .addOptions({
            append: 'End of note',
            prepend: 'Start of note',
            section: 'In section',
          })
          .setValue(projects.taskInsertionMode)
          .onChange(async (v) => {
            projects.taskInsertionMode = v as typeof projects.taskInsertionMode;
            await this.plugin_abyssPrivate.saveSettings();
            this.render_abyssPrivate();
          }),
      );

    if (projects.taskInsertionMode === 'section') {
      new Setting(containerEl)
        .setName('Task section heading')
        .setDesc('Tasks are inserted under this heading in the project note. Created if absent.')
        .addText((t) =>
          t
            .setPlaceholder('## Tasks')
            .setValue(projects.taskInsertionSection)
            .onChange(async (v) => {
              projects.taskInsertionSection = v;
              await this.plugin_abyssPrivate.saveSettings();
            }),
        );
      new Setting(containerEl)
        .setName('Task section position')
        .setDesc('Place new tasks at the top or bottom of this section.')
        .addDropdown((dropdown) =>
          dropdown
            .addOptions({ top: 'Top of section', bottom: 'Bottom of section' })
            .setValue(projects.taskInsertionSectionPosition)
            .onChange(async (value) => {
              projects.taskInsertionSectionPosition = value as 'top' | 'bottom';
              await this.plugin_abyssPrivate.saveSettings();
            }),
        );
    }
  }

  private renderStatusMigration_abyssPrivate(containerEl: HTMLElement): void {
    const projects = this.plugin_abyssPrivate.settings.projects;
    const migration = projects.statusMigration;
    if (migration === undefined) return;
    const setting = new Setting(containerEl)
      .setName('Status migration needs attention')
      .setDesc(
        migration.issue === 'conflicting-properties'
          ? 'Legacy statuses used several properties. Choose the one property that now defines every status; note properties are not renamed.'
          : 'Some legacy status definitions were malformed or duplicated. Valid definitions remain available; discard the invalid entries to continue.',
      );
    if (migration.propertyCandidates.length > 0) {
      setting.addDropdown((dropdown) => {
        dropdown.addOption('', 'Choose source');
        for (const property of migration.propertyCandidates) dropdown.addOption(property, property);
        dropdown.onChange(async (property) => {
          if (property.length === 0) return;
          projects.statusProperty = property;
          delete projects.statusMigration;
          await this.plugin_abyssPrivate.saveSettings();
          this.render_abyssPrivate();
        });
      });
    } else {
      setting.addButton((button) =>
        button.setButtonText('Discard invalid entries').onClick(async () => {
          projects.statusProperty = 'status';
          delete projects.statusMigration;
          await this.plugin_abyssPrivate.saveSettings();
          this.render_abyssPrivate();
        }),
      );
    }
  }

  private renderProjectMetadataSource_abyssPrivate(
    containerEl: HTMLElement,
    source: ProjectMetadataSourceSetting,
  ): void {
    const { description, key, name } = source;
    const projects = this.plugin_abyssPrivate.settings.projects;
    const current = projects[key];
    const setting = new Setting(containerEl).setName(name).setDesc(description);
    setting.addText((text) => {
      const siblingKeys = (['statusProperty', 'startProperty', 'endProperty'] as const).filter(
        (candidate) => candidate !== key,
      );
      const input = text.setValue(current).inputEl;
      input.setAttribute('aria-label', name);
      const commit = async (): Promise<void> => {
        const property = input.value.trim();
        if (property !== '' && this.sameProperty_abyssPrivate(property, current)) {
          input.value = current;
          return;
        }
        if (
          property === '' ||
          this.sameProperty_abyssPrivate(property, 'tags') ||
          this.sameProperty_abyssPrivate(property, 'description') ||
          siblingKeys.some((candidate) =>
            this.sameProperty_abyssPrivate(projects[candidate], property),
          )
        ) {
          new Notice(`${name} must use a different property from the other curated fields.`);
          this.render_abyssPrivate();
          return;
        }
        projects[key] = property;
        await this.plugin_abyssPrivate.saveSettings();
        this.render_abyssPrivate();
      };
      this.settingsValueCommit_abyssPrivate?.register(input, () => {
        runAsyncAction(commit(), `Could not save ${name.toLowerCase()}`);
      });
    });
  }

  private sameProperty_abyssPrivate(left: string, right: string): boolean {
    return sameProjectPropertyName(left, right);
  }

  private renderProjectStatusesSettings_abyssPrivate(
    containerEl: HTMLElement,
    includeHeading = true,
  ): void {
    const projects = this.plugin_abyssPrivate.settings.projects;
    if (includeHeading) new Setting(containerEl).setName('Statuses').setHeading();
    this.renderStatusMigration_abyssPrivate(containerEl);
    this.renderProjectMetadataSource_abyssPrivate(containerEl, {
      name: 'Status property',
      description: 'The single frontmatter property used for every project status.',
      key: 'statusProperty',
    });
    const list = containerEl.createDiv({ cls: 'abyss-project-value-list' });
    for (const status of projects.statuses) {
      this.renderProjectStatusRow_abyssPrivate(list, status);
    }

    const add = containerEl.createEl('button', {
      cls: 'abyss-project-value-add',
      text: '+ add status',
      attr: { type: 'button', 'aria-label': 'Add project status' },
    });
    add.addEventListener('click', () => {
      // Collision-proof id: smallest status-N not already taken.
      let n = projects.statuses.length + 1;
      while (
        projects.statuses.some(
          (status) => status.id === `status-${n}` || status.name === `status ${n}`,
        )
      ) {
        n++;
      }
      const id = `status-${n}`;
      projects.statuses.push({
        id,
        name: `status ${n}`,
        color: '#888888',
        onLeftPanel: false,
      });
      this.commitDraft_abyssPrivate('add project status', () =>
        this.containerEl.querySelector<HTMLInputElement>(
          `[data-settings-item-id="${id}"] .abyss-project-value-raw`,
        ),
      );
    });

    const firstStatus = projects.statuses[0];
    if (firstStatus !== undefined)
      this.renderDefaultProjectStatusSetting_abyssPrivate(containerEl, firstStatus);
  }

  private renderDefaultProjectStatusSetting_abyssPrivate(
    containerEl: HTMLElement,
    firstStatus: ProjectStatus,
  ): void {
    const projects = this.plugin_abyssPrivate.settings.projects;
    new Setting(containerEl)
      .setName('Default status')
      .setDesc('Applied to newly created projects.')
      .addDropdown((dropdown) => {
        dropdown.selectEl.setAttribute('aria-label', 'Default status');
        for (const status of projects.statuses) {
          dropdown.addOption(status.id, projectStatusDisplayName(status));
        }
        dropdown
          .setValue(projects.defaultStatusId === '' ? firstStatus.id : projects.defaultStatusId)
          .onChange(async (value) => {
            projects.defaultStatusId = value;
            await this.plugin_abyssPrivate.saveSettings();
          });
      });
  }

  private renderProjectStatusRow_abyssPrivate(
    containerEl: HTMLElement,
    status: ProjectStatus,
  ): void {
    const projects = this.plugin_abyssPrivate.settings.projects;
    const statuses = projects.statuses;
    const label = projectStatusDisplayName(status);
    const controls = renderProjectValueRow({
      container: containerEl,
      id: status.id,
      listKey: 'project-statuses',
      label,
      value: status.name,
      valueType: 'text',
      ...(status.displayName === undefined ? {} : { displayName: status.displayName }),
      ...(status.color === undefined ? {} : { color: status.color }),
      ...(status.display === undefined ? {} : { display: status.display }),
      onLeftPanel: status.onLeftPanel,
      removeDisabled: statuses.length <= 1,
      onReorder: (draggedId, targetId) =>
        this.reorderItems_abyssPrivate(statuses, draggedId, targetId, [
          (candidate) => candidate.id,
          () => this.plugin_abyssPrivate.saveSettings(),
          'reorder project statuses',
        ]),
    });
    const pendingRename = this.pendingProjectStatusRenames_abyssPrivate.get(status.id);
    if (pendingRename !== undefined) {
      controls.value.value = pendingRename.requestedName;
      controls.value.disabled = true;
    }
    const expectedName = pendingRename?.expectedName ?? status.name;
    this.registerProjectStatusName_abyssPrivate(status, controls, expectedName);
    this.registerProjectStatusPresentation_abyssPrivate(status, controls);
    controls.remove.addEventListener('click', () => {
      const index = statuses.findIndex((candidate) => candidate.id === status.id);
      const removed = index < 0 ? undefined : statuses.splice(index, 1)[0];
      if (removed?.id === projects.defaultStatusId) {
        projects.defaultStatusId = statuses[0]?.id ?? '';
      }
      this.commitDraft_abyssPrivate('delete project status');
    });
  }

  private registerProjectStatusName_abyssPrivate(
    status: ProjectStatus,
    controls: ProjectValueRowControls,
    expectedName: string,
  ): void {
    const commitName = (): void => {
      if (controls.value.value === expectedName || controls.value.disabled) return;
      const requestedName = controls.value.value;
      const pendingRename = { expectedName, requestedName };
      this.pendingProjectStatusRenames_abyssPrivate.set(status.id, pendingRename);
      controls.value.disabled = true;
      runAsyncAction(
        this.plugin_abyssPrivate.renameProjectStatus(status.id, requestedName, expectedName).then(
          () => {
            if (this.pendingProjectStatusRenames_abyssPrivate.get(status.id) !== pendingRename) {
              return;
            }
            this.pendingProjectStatusRenames_abyssPrivate.delete(status.id);
            this.render_abyssPrivate();
          },
          (error: unknown) => {
            if (this.pendingProjectStatusRenames_abyssPrivate.get(status.id) === pendingRename) {
              this.pendingProjectStatusRenames_abyssPrivate.delete(status.id);
              this.render_abyssPrivate();
            }
            const message = error instanceof Error ? error.message : String(error);
            console.error('[abyss-tasks] Could not rename project status', {
              statusId: status.id,
              expectedName,
              requestedName,
              cause: error,
            });
            new Notice(`Could not rename project status: ${message}`);
          },
        ),
      );
    };
    this.settingsValueCommit_abyssPrivate?.register(controls.value, commitName);
  }

  private registerProjectStatusPresentation_abyssPrivate(
    status: ProjectStatus,
    controls: ProjectValueRowControls,
  ): void {
    const commitDisplayName = (): void => {
      const displayName = controls.displayName.value.trim();
      if (displayName === (status.displayName?.trim() ?? '')) return;
      if (displayName === '') delete status.displayName;
      else status.displayName = displayName;
      const label = projectStatusDisplayName(status);
      controls.updateLabel(label);
      const statusCard = controls.row.closest<HTMLElement>('[data-column-id="status"]');
      const defaultStatus = statusCard?.querySelector<HTMLSelectElement>(
        'select[aria-label="Default status"]',
      );
      const defaultOption = Array.from(defaultStatus?.options ?? []).find(
        (option) => option.value === status.id,
      );
      if (defaultOption !== undefined) defaultOption.textContent = label;
      saveSettingsDraft({
        action: 'save project status display name',
        save: () => this.plugin_abyssPrivate.saveSettings(),
      });
    };
    const commitColor = (): void => {
      if (status.color === controls.color.value) return;
      status.color = controls.color.value;
      saveSettingsDraft({
        action: 'save project status color',
        save: () => this.plugin_abyssPrivate.saveSettings(),
      });
    };
    this.settingsValueCommit_abyssPrivate?.register(controls.displayName, commitDisplayName);
    this.settingsValueCommit_abyssPrivate?.register(controls.color, commitColor);
    controls.appearance.addEventListener('change', () => {
      const display =
        controls.appearance.value === 'text' || controls.appearance.value === 'dot'
          ? controls.appearance.value
          : 'badge';
      if ((status.display ?? 'badge') === display) return;
      status.display = display;
      saveSettingsDraft({
        action: 'save project status appearance',
        save: () => this.plugin_abyssPrivate.saveSettings(),
      });
    });
    const onLeftPanel = controls.onLeftPanel;
    onLeftPanel?.addEventListener('change', () => {
      status.onLeftPanel = onLeftPanel.checked;
      saveSettingsDraft({
        action: 'save project status left panel visibility',
        save: () => this.plugin_abyssPrivate.saveSettings(),
      });
    });
  }

  /** Persists a taskStatuses mutation and rebuilds the store's registry so open panels update. */
  private async persistStatuses_abyssPrivate(): Promise<void> {
    await this.plugin_abyssPrivate.saveSettings();
    this.plugin_abyssPrivate.rebuildTaskStatusSemantics();
  }

  private moveStatusToGroup_abyssPrivate(id: string, targetType: TaskStatusType): void {
    const statuses = this.plugin_abyssPrivate.settings.taskStatuses;
    const def = statuses.find((s) => s.id === id);
    if (def == null || def.type === targetType) return;
    if (def.core) return; // core cards cannot leave their own type group
    def.type = targetType;
    this.commitDraft_abyssPrivate('move task status', undefined, true);
  }

  private reorderStatusWithinType_abyssPrivate(
    type: TaskStatusType,
    draggedId: string,
    targetId: string,
  ): boolean {
    const statuses = this.plugin_abyssPrivate.settings.taskStatuses;
    if (
      statuses.find((status) => status.id === draggedId)?.type !== type ||
      statuses.find((status) => status.id === targetId)?.type !== type
    ) {
      return false;
    }
    const reordered = this.reorderItems_abyssPrivate(statuses, draggedId, targetId, [
      (status) => status.id,
      () => this.persistStatuses_abyssPrivate(),
      'reorder task statuses',
    ]);
    if (reordered) this.plugin_abyssPrivate.rebuildTaskStatusSemantics();
    return reordered;
  }

  private renderTaskStatusesSettings_abyssPrivate(containerEl: HTMLElement): void {
    const statuses = this.plugin_abyssPrivate.settings.taskStatuses;
    const groupDefs: Array<{ type: TaskStatusType; label: string }> = TYPE_ORDER.map((type) => ({
      type,
      label: TYPE_LABELS[type],
    }));

    for (const { type, label } of groupDefs) {
      const groupEl = containerEl.createDiv({ cls: 'abyss-status-type-group' });
      groupEl.createDiv({ cls: 'abyss-status-type-group-label', text: label });
      const items = statuses.filter((s) => s.type === type);

      // Group-level drop zone catches drops on empty space (not over any card),
      // including into an otherwise-empty group.
      groupEl.addEventListener('dragover', (e) => {
        e.preventDefault();
      });
      groupEl.addEventListener('drop', (e) => {
        e.preventDefault();
        const payload = parseCardDragPayload(e.dataTransfer?.getData('text/plain'));
        if (payload?.listKey !== 'task-statuses') return;
        if (payload.groupKey === type) return; // handled by a card's own drop listener
        this.moveStatusToGroup_abyssPrivate(payload.id, type);
      });

      this.renderCardList_abyssPrivate(groupEl, items, {
        listKey: 'task-statuses',
        id: (s) => s.id,
        title: (s) => s.name,
        badge: (s) => s.symbol,
        preview: (headerEl, s) => {
          const previewEl = headerEl.createSpan({ cls: 'abyss-status-header-preview' });
          this.statusHeaderPreviewEls_abyssPrivate.set(s.id, previewEl);
          this.renderStatusHeaderPreview_abyssPrivate(s.id);
        },
        groupKey: type,
        onCrossGroupDrop: (id, targetType) => {
          this.moveStatusToGroup_abyssPrivate(id, targetType as TaskStatusType);
        },
        body: (bodyEl, item) => {
          this.renderTaskStatusCardBody_abyssPrivate(bodyEl, item);
        },
        onReorder: (draggedId, targetId) =>
          this.reorderStatusWithinType_abyssPrivate(type, draggedId, targetId),
      });
    }

    new Setting(containerEl).addButton((b) =>
      b
        .setButtonText('+ add status')
        .setCta()
        .onClick(() => {
          let n = statuses.length + 1;
          while (statuses.some((s) => s.id === `status-${n}`)) n++;
          const id = `status-${n}`;
          const used = new Set(statuses.map((s) => s.symbol));
          const printable =
            '!"#$%&\'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~';
          const symbol = [...printable].find((c) => !used.has(c)) ?? '?';
          statuses.push({
            id,
            symbol,
            name: 'New status',
            type: 'todo',
            icon: '',
            core: false,
          });
          this.expandedCards_abyssPrivate.add(id);
          this.commitDraft_abyssPrivate('add task status', undefined, true);
        }),
    );
  }

  /** Re-renders a status's collapsed-card header preview chip (e.g. after an icon edit). */
  private renderStatusHeaderPreview_abyssPrivate(statusId: string): void {
    const previewEl = this.statusHeaderPreviewEls_abyssPrivate.get(statusId);
    if (previewEl == null) return;
    const statuses = this.plugin_abyssPrivate.settings.taskStatuses;
    const def = statuses.find((s) => s.id === statusId);
    if (def == null) return;
    previewEl.empty();
    const registry = new StatusRegistry(statuses);
    renderStatusMarker(previewEl, {
      task: { statusSymbol: def.symbol, priority: 'D' },
      registry,
      interactive: false,
      onLeftClick: () => {},
      onContextMenu: () => {},
    });
  }

  private renderTaskStatusCardBody_abyssPrivate(bodyEl: HTMLElement, def: TaskStatusDef): void {
    const statuses = this.plugin_abyssPrivate.settings.taskStatuses;
    let updatePreview: () => void = () => {};
    const refreshPreview = (): void => {
      updatePreview();
    };

    this.renderTaskStatusNameSetting_abyssPrivate(bodyEl, def, refreshPreview);
    this.renderTaskStatusSymbolSetting_abyssPrivate(bodyEl, def, statuses, refreshPreview);
    this.renderTaskStatusIconSetting_abyssPrivate(bodyEl, def, refreshPreview);
    updatePreview = this.renderTaskStatusPreview_abyssPrivate(bodyEl, def, statuses);
    updatePreview();
    if (!def.core) this.renderDeleteTaskStatusSetting_abyssPrivate(bodyEl, def, statuses);
  }

  private renderTaskStatusNameSetting_abyssPrivate(
    bodyEl: HTMLElement,
    def: TaskStatusDef,
    updatePreview: () => void,
  ): void {
    new Setting(bodyEl).setName('Name').addText((t) =>
      t.setValue(def.name).onChange(async (v) => {
        def.name = v;
        await this.persistStatuses_abyssPrivate();
        updatePreview();
      }),
    );
  }

  private renderTaskStatusSymbolSetting_abyssPrivate(
    bodyEl: HTMLElement,
    def: TaskStatusDef,
    statuses: TaskStatusDef[],
    updatePreview: () => void,
  ): void {
    const symbolSetting = new Setting(bodyEl).setName('Symbol');
    let symbolErrorEl: HTMLElement | null = null;
    if (def.core) {
      const lockEl = symbolSetting.nameEl.createSpan({ cls: 'abyss-status-symbol-lock' });
      setIcon(lockEl, 'lock');
      symbolSetting.setTooltip('Core status — symbol is fixed');
    }
    symbolSetting.addText((t) => {
      t.setValue(def.symbol).setDisabled(def.core);
      if (def.core) t.inputEl.addClass('abyss-status-symbol-locked');
      t.onChange(async (v) => {
        if (def.core) return;
        const err = validateStatusSymbol(v, statuses, def.id);
        if (err !== null && err !== '') {
          symbolErrorEl ??= symbolSetting.descEl.createDiv({ cls: 'abyss-status-symbol-error' });
          symbolErrorEl.setText(err);
          return;
        }
        if (symbolErrorEl != null) {
          symbolErrorEl.remove();
          symbolErrorEl = null;
        }
        def.symbol = v;
        await this.persistStatuses_abyssPrivate();
        updatePreview();
      });
      return t;
    });
  }

  private renderTaskStatusIconSetting_abyssPrivate(
    bodyEl: HTMLElement,
    def: TaskStatusDef,
    updatePreview: () => void,
  ): void {
    if (def.core) this.renderLockedTaskStatusIcon_abyssPrivate(bodyEl, def);
    else this.renderEditableTaskStatusIcon_abyssPrivate(bodyEl, def, updatePreview);
  }

  private renderLockedTaskStatusIcon_abyssPrivate(bodyEl: HTMLElement, def: TaskStatusDef): void {
    const iconSetting = new Setting(bodyEl).setName('Icon');
    const lockEl = iconSetting.nameEl.createSpan({ cls: 'abyss-status-icon-lock' });
    setIcon(lockEl, 'lock');
    iconSetting.setTooltip('Core status — icon is fixed');
    const lockedPreview = iconSetting.controlEl.createDiv({
      cls: 'abyss-status-icon-locked-preview',
    });
    if (def.icon !== '') setIcon(lockedPreview, def.icon);
    else lockedPreview.createSpan({ cls: 'abyss-status-icon-result-icon', text: '—' });
  }

  private availableStatusIconIds_abyssPrivate(): string[] {
    const seen = new Set<string>();
    const iconIds: string[] = [];
    for (const raw of getIconIds()) {
      const iconId = raw.startsWith('lucide-') ? raw.slice('lucide-'.length) : raw;
      if (seen.has(iconId)) continue;
      seen.add(iconId);
      iconIds.push(iconId);
    }
    return iconIds;
  }

  private renderEditableTaskStatusIcon_abyssPrivate(
    bodyEl: HTMLElement,
    def: TaskStatusDef,
    updatePreview: () => void,
  ): void {
    const iconWrap = bodyEl.createDiv({ cls: 'abyss-status-icon-field' });
    const inputHost = iconWrap.createDiv({ cls: 'abyss-status-icon-input-host' });
    const iconIds = this.availableStatusIconIds_abyssPrivate();
    let renderResults: (query: string, focusIcon?: string) => void = () => {};
    new Setting(inputHost).setName('Search icons').addText((text) =>
      text
        .setPlaceholder('Search lucide icons…')
        .setValue('')
        .onChange((query) => {
          renderResults(query);
        }),
    );
    const resultsHost = inputHost.createDiv({ cls: 'abyss-status-icon-results' });
    renderResults = (query, focusIcon) => {
      const selectIcon = (iconId: string): void => {
        def.icon = iconId;
        runAsyncAction(this.persistStatuses_abyssPrivate());
        renderResults(query, iconId);
        updatePreview();
        this.renderStatusHeaderPreview_abyssPrivate(def.id);
      };
      this.renderTaskStatusIconResults_abyssPrivate({
        host: resultsHost,
        def,
        iconIds,
        query,
        ...(focusIcon === undefined ? {} : { focusIcon }),
        selectIcon,
      });
    };
    renderResults('');
  }

  private renderTaskStatusIconResults_abyssPrivate(results: TaskStatusIconResults): void {
    results.host.empty();
    this.renderClearTaskStatusIcon_abyssPrivate(results);
    const query = results.query.trim().toLowerCase();
    const matchingIds = results.iconIds
      .filter((iconId) => query === '' || iconId.toLowerCase().includes(query))
      .slice(0, 48);
    if (matchingIds.length === 0) {
      results.host.createDiv({ cls: 'abyss-status-icon-empty', text: 'No icons found' });
    } else {
      for (const iconId of matchingIds)
        this.renderTaskStatusIconResult_abyssPrivate(results, iconId);
    }
    this.focusTaskStatusIconResult_abyssPrivate(results);
  }

  private renderClearTaskStatusIcon_abyssPrivate(results: TaskStatusIconResults): void {
    const clearCell = results.host.createEl('button', {
      cls: `abyss-status-icon-result abyss-status-icon-clear${results.def.icon === '' ? ' is-selected' : ''}`,
      attr: {
        type: 'button',
        title: 'No icon',
        'data-icon': '',
        'aria-label': 'Clear icon',
        'aria-pressed': String(results.def.icon === ''),
      },
    });
    clearCell.createSpan({ cls: 'abyss-status-icon-result-icon', text: '—' });
    clearCell.addEventListener('click', () => {
      results.selectIcon('');
    });
  }

  private renderTaskStatusIconResult_abyssPrivate(
    results: TaskStatusIconResults,
    iconId: string,
  ): void {
    const cell = results.host.createEl('button', {
      cls: `abyss-status-icon-result${iconId === results.def.icon ? ' is-selected' : ''}`,
      attr: {
        type: 'button',
        title: iconId,
        'data-icon': iconId,
        'aria-label': `Select icon ${iconId}`,
        'aria-pressed': String(iconId === results.def.icon),
      },
    });
    const iconPreview = cell.createSpan({ cls: 'abyss-status-icon-result-icon' });
    setIcon(iconPreview, iconId);
    cell.addEventListener('click', () => {
      results.selectIcon(iconId);
    });
  }

  private focusTaskStatusIconResult_abyssPrivate(results: TaskStatusIconResults): void {
    if (results.focusIcon === undefined) return;
    const cell = Array.from(
      results.host.querySelectorAll<HTMLButtonElement>('.abyss-status-icon-result'),
    ).find((button) => button.dataset['icon'] === results.focusIcon);
    cell?.focus({ preventScroll: true });
  }

  private renderTaskStatusPreview_abyssPrivate(
    bodyEl: HTMLElement,
    def: TaskStatusDef,
    statuses: TaskStatusDef[],
  ): () => void {
    const previewSetting = new Setting(bodyEl).setName('Preview');
    const previewHost = previewSetting.controlEl.createDiv({ cls: 'abyss-status-preview' });
    return () => {
      previewHost.empty();
      const registry = new StatusRegistry(statuses);
      renderStatusMarker(previewHost, {
        task: { statusSymbol: def.symbol, priority: 'D' },
        registry,
        interactive: false,
        onLeftClick: () => {},
        onContextMenu: () => {},
      });
      previewHost.createSpan({
        cls: 'abyss-status-preview-title',
        text: def.name !== '' ? def.name : 'Sample task',
      });
    };
  }

  private renderDeleteTaskStatusSetting_abyssPrivate(
    bodyEl: HTMLElement,
    def: TaskStatusDef,
    statuses: TaskStatusDef[],
  ): void {
    let armed = false;
    new Setting(bodyEl).addButton((button) =>
      button
        .setButtonText('Delete status')
        .setClass('mod-warning')
        .onClick(() => {
          if (!armed) {
            armed = true;
            button.setButtonText('Click again to confirm');
            new Notice('Deleting this status: tasks using it will fall back to plain to-do.');
            window.setTimeout(() => {
              armed = false;
              button.setButtonText('Delete status');
            }, 4000);
            return;
          }
          const index = statuses.findIndex((status) => status.id === def.id);
          if (index >= 0) statuses.splice(index, 1);
          this.expandedCards_abyssPrivate.delete(def.id);
          this.commitDraft_abyssPrivate('delete task status', undefined, true);
        }),
    );
  }
}
