import {
  App,
  getIconIds,
  Notice,
  Platform,
  Plugin,
  PluginSettingTab,
  setIcon,
  Setting,
} from 'obsidian';
import type {
  WorkNoteCompatibilityAcceptanceResult,
  WorkNoteCompatibilityPreview,
} from '../projects/work-notes/types';
import { DailyNoteResolver } from '../resolvers/DailyNoteResolver';
import { StatusRegistry } from '../status/StatusRegistry';
import { TYPE_LABELS, TYPE_ORDER } from '../status/statusConstants';
import type { TagManager } from '../tags/TagManager';
import type { TaskStatusType } from '../tasks';
import { renderStatusMarker } from '../ui/StatusMarker';
import {
  type ParsedShortcutAlternative,
  SHORTCUT_ACTION_IDS,
  SHORTCUT_ACTIONS,
  type ShortcutActionId,
  type ShortcutIssue,
  type ShortcutPlatform,
  validateShortcuts,
} from './shortcuts';
import type { CalendarSettings, TaskStatusDef } from './types';

interface TaskCalendarPlugin extends Plugin {
  settings: CalendarSettings;
  tagManager: TagManager;
  rebuildTaskStatusSemantics(): void;
  saveSettings(): Promise<void>;
  previewWorkNoteCompatibility(): Promise<WorkNoteCompatibilityPreview>;
  acceptWorkNoteCompatibility(token: string): Promise<WorkNoteCompatibilityAcceptanceResult>;
  disableWorkNoteCompatibility(): Promise<void>;
}

function counted(count: number, singular: string, plural = `${singular}s`): string {
  return `${String(count)} ${count === 1 ? singular : plural}`;
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
  private expandedCards = new Set<string>();
  /** Status id → its collapsed-card header preview chip host, so an icon edit can refresh it live. */
  private statusHeaderPreviewEls = new Map<string, HTMLElement>();
  /** A Hotkeys edit waits for the active write, then persists only the latest pending value. */
  private shortcutSaveInFlight: Promise<void> | undefined = undefined;
  private shortcutSaveQueued = false;
  private shortcutSaveFailed = false;
  private shortcutSaveStatusEl: HTMLElement | undefined;
  private shortcutSaveRetryEl: HTMLButtonElement | undefined;
  private readonly openSections = new Set<string>();
  private readonly sectionScope = ++nextSettingsTabScope;

  constructor(
    app: App,
    private plugin: TaskCalendarPlugin,
  ) {
    super(app, plugin);
  }

  /**
   * Renders a list of collapsible, drag-to-reorder cards. Collapsed by default
   * (title only) so the whole set can be scanned at a glance; click to expand
   * and edit. Shared by statuses and tag groups for a consistent UI.
   */
  private renderCardList<T>(
    containerEl: HTMLElement,
    items: T[],
    opts: {
      id: (item: T) => string;
      title: (item: T) => string;
      accent?: (item: T) => string | undefined;
      badge?: (item: T) => string | undefined;
      /** Rendered right after the grip, before the accent dot — e.g. a marker preview chip. */
      preview?: (headerEl: HTMLElement, item: T) => void;
      body: (bodyEl: HTMLElement, idx: number) => void;
      onReorder: (from: number, to: number) => void;
      /** Identifies which group this card list belongs to, for cross-group drag support. */
      groupKey?: string;
      /** Called when a card dragged from a DIFFERENT groupKey is dropped onto this list. */
      onCrossGroupDrop?: (draggedId: string, targetGroupKey: string) => void;
    },
  ): void {
    items.forEach((item, idx) => {
      const id = opts.id(item);
      const expanded = this.expandedCards.has(id);
      const card = containerEl.createDiv({
        cls: `abyss-settings-card${expanded ? ' is-open' : ''}`,
      });

      // The card is a drop target; only its header is the drag SOURCE, so text
      // selection inside expanded body inputs isn't hijacked by dragging.
      card.addEventListener('dragover', (e) => {
        e.preventDefault();
        card.addClass('abyss-drag-over');
      });
      card.addEventListener('dragleave', () => card.removeClass('abyss-drag-over'));
      card.addEventListener('drop', (e) => {
        e.preventDefault();
        e.stopPropagation();
        card.removeClass('abyss-drag-over');
        const raw = e.dataTransfer?.getData('text/plain');
        if (!raw) return;
        let payload: { idx: number; id: string; groupKey?: string };
        try {
          payload = JSON.parse(raw) as typeof payload;
        } catch {
          return;
        }
        if (opts.groupKey !== undefined && payload.groupKey !== opts.groupKey) {
          opts.onCrossGroupDrop?.(payload.id, opts.groupKey);
          return;
        }
        const from = payload.idx;
        if (!Number.isNaN(from) && from !== idx) opts.onReorder(from, idx);
      });

      const header = card.createDiv({
        cls: 'abyss-settings-card-header',
        attr: { draggable: 'true' },
      });
      header.addEventListener('dragstart', (e) => {
        e.dataTransfer?.setData('text/plain', JSON.stringify({ idx, id, groupKey: opts.groupKey }));
        card.addClass('abyss-dragging');
      });
      header.addEventListener('dragend', () => card.removeClass('abyss-dragging'));
      const grip = header.createSpan({ cls: 'abyss-settings-card-grip' });
      setIcon(grip, 'grip-vertical');
      opts.preview?.(header, item);
      const accent = opts.accent?.(item);
      if (accent) {
        const dot = header.createSpan({ cls: 'abyss-status-dot' });
        dot.style.background = accent;
      }
      header.createSpan({ cls: 'abyss-settings-card-title', text: opts.title(item) });
      const badge = opts.badge?.(item);
      if (badge) header.createSpan({ cls: 'abyss-settings-card-badge', text: badge });
      const chevron = header.createSpan({ cls: 'abyss-settings-card-chevron' });
      setIcon(chevron, expanded ? 'chevron-down' : 'chevron-right');
      header.addEventListener('click', () => {
        if (expanded) this.expandedCards.delete(id);
        else this.expandedCards.add(id);
        // eslint-disable-next-line @typescript-eslint/no-deprecated
        this.display();
      });

      if (expanded) {
        const bodyEl = card.createDiv({ cls: 'abyss-settings-card-body' });
        opts.body(bodyEl, idx);
      }
    });
  }

  private moveItem<T>(arr: T[], from: number, to: number): void {
    const item = arr[from];
    if (item === undefined) return;
    arr.splice(from, 1);
    arr.splice(to, 0, item);
  }

  display(): void {
    const { containerEl } = this;

    containerEl.empty();

    this.addSection(containerEl, 'General', 'sliders-horizontal', (body) =>
      this.renderGeneralSettings(body),
    );
    this.addSection(containerEl, 'Desktop', 'monitor', (body) =>
      this.renderViewConfigSettings(body, 'desktop'),
    );
    this.addSection(containerEl, 'Mobile', 'smartphone', (body) =>
      this.renderViewConfigSettings(body, 'mobile'),
    );
    this.addSection(containerEl, 'Inbox', 'inbox', (body) => this.renderInboxSettings(body));
    this.addSection(containerEl, 'Tag groups', 'tags', (body) => this.renderTagGroupSettings(body));
    this.addSection(containerEl, 'Projects', 'folder-kanban', (body) =>
      this.renderProjectsSettings(body),
    );
    this.addSection(containerEl, 'Custom statuses', 'list-checks', (body) =>
      this.renderTaskStatusesSettings(body),
    );
    this.addSection(containerEl, 'Hotkeys', 'keyboard', (body) =>
      this.renderShortcutSettings(body),
    );
  }

  private addSection(
    containerEl: HTMLElement,
    title: string,
    icon: string,
    renderFn: (bodyEl: HTMLElement) => void,
  ): void {
    const isOpen = this.openSections.has(title);
    const section = containerEl.createDiv({
      cls: `abyss-settings-section${isOpen ? ' is-open' : ''}`,
    });
    const bodyId = `abyss-settings-section-${this.sectionScope}-${title
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
      if (opening) this.openSections.add(title);
      else this.openSections.delete(title);
    });
  }

  private renderGeneralSettings(containerEl: HTMLElement): void {
    new Setting(containerEl)
      .setName('Task prefix')
      // eslint-disable-next-line obsidianmd/ui/sentence-case
      .setDesc('Prepended when adding a new task (e.g. #task/one-off).')
      .addText((t) =>
        t
          // eslint-disable-next-line obsidianmd/ui/sentence-case
          .setPlaceholder('#task/one-off')
          .setValue(this.plugin.settings.taskPrefix)
          .onChange(async (v) => {
            this.plugin.settings.taskPrefix = v;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Source note display')
      .setDesc('Show which note a task comes from, before the tag chip in list view.')
      .addDropdown((d) =>
        d
          .addOptions({
            never: 'Never',
            'non-default': 'Non-default notes only',
            always: 'Always',
          })
          .setValue(this.plugin.settings.sourceNoteDisplay)
          .onChange(async (v) => {
            this.plugin.settings.sourceNoteDisplay = v as CalendarSettings['sourceNoteDisplay'];
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Add to today's note")
      .setDesc('New tasks are added to the daily note for today.')
      .addToggle((t) =>
        t.setValue(this.plugin.settings.addToToday).onChange(async (v) => {
          this.plugin.settings.addToToday = v;
          await this.plugin.saveSettings();
          // eslint-disable-next-line @typescript-eslint/no-deprecated
          this.display();
        }),
      );

    new Setting(containerEl)
      .setName('Add created date')
      .setDesc('Add a created date to newly created tasks.')
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.taskLifecycle.addCreatedDate)
          .onChange(async (value) => {
            this.plugin.settings.taskLifecycle.addCreatedDate = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Add completion date')
      .setDesc('Add a completion date when a task is completed.')
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.taskLifecycle.addCompletionDate)
          .onChange(async (value) => {
            this.plugin.settings.taskLifecycle.addCompletionDate = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('New occurrence placement')
      .setDesc('Place recurring task occurrences before or after the completed task.')
      .addDropdown((dropdown) =>
        dropdown
          .addOptions({ before: 'Before completed task', after: 'After completed task' })
          .setValue(this.plugin.settings.recurrence.newOccurrencePlacement)
          .onChange(async (value) => {
            this.plugin.settings.recurrence.newOccurrencePlacement = value as 'before' | 'after';
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Remove scheduled date')
      .setDesc('Remove the scheduled date from a newly generated recurring task.')
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.recurrence.removeScheduledDate)
          .onChange(async (value) => {
            this.plugin.settings.recurrence.removeScheduledDate = value;
            await this.plugin.saveSettings();
          }),
      );

    if (this.plugin.settings.addToToday) {
      const resolver = new DailyNoteResolver(this.app, this.plugin.settings);
      const providers = resolver.getAvailableProviders();
      const providerOptions: Record<string, string> = {};
      for (const p of providers) {
        providerOptions[p.id] = p.label;
      }
      // Always include all providers so user can force a choice even if not detected
      if (!providerOptions['periodic-notes']) providerOptions['periodic-notes'] = 'Periodic Notes';
      if (!providerOptions['core']) providerOptions['core'] = 'Core Daily Notes';
      if (!providerOptions['obsidian-journal'])
        providerOptions['obsidian-journal'] = 'Obsidian Journal';
      if (!providerOptions['manual']) providerOptions['manual'] = 'Manual';

      const adapter = resolver.getActiveAdapter();
      const ps = adapter.getSettings(this.app, this.plugin.settings);
      const providerDesc = createFragment();
      providerDesc.appendText('Which plugin manages your daily notes.');
      try {
        const todayPath =
          (ps.folder ? `${ps.folder}/` : '') + window.moment().format(ps.format) + '.md';
        providerDesc.createEl('br');
        providerDesc.appendText('Today → ');
        providerDesc.createEl('code', { text: todayPath });
        if (ps.template) {
          providerDesc.appendText('  template: ');
          providerDesc.createEl('code', { text: ps.template });
        }
      } catch {
        // moment not available in test environment
      }

      new Setting(containerEl)
        .setName('Daily note provider')
        .setDesc(providerDesc)
        .addDropdown((d) =>
          d
            .addOptions(providerOptions)
            .setValue(this.plugin.settings.dailyNoteProvider)
            .onChange(async (v) => {
              this.plugin.settings.dailyNoteProvider =
                v as typeof this.plugin.settings.dailyNoteProvider;
              await this.plugin.saveSettings();
              // eslint-disable-next-line @typescript-eslint/no-deprecated
              this.display();
            }),
        );

      if (this.plugin.settings.dailyNoteProvider === 'manual') {
        new Setting(containerEl)
          .setName('Note path pattern')
          // eslint-disable-next-line obsidianmd/ui/sentence-case
          .setDesc('Folder + date format, e.g. Daily/YYYY-MM-DD or just YYYY-MM-DD.')
          .addText((t) =>
            t
              // eslint-disable-next-line obsidianmd/ui/sentence-case
              .setPlaceholder('YYYY-MM-DD')
              .setValue(this.plugin.settings.manualDailyNotePath)
              .onChange(async (v) => {
                this.plugin.settings.manualDailyNotePath = v;
                await this.plugin.saveSettings();
                // eslint-disable-next-line @typescript-eslint/no-deprecated
                this.display();
              }),
          );
      }

      new Setting(containerEl)
        .setName('Insert position')
        .setDesc('Where in the daily note to add new tasks.')
        .addDropdown((d) =>
          d
            .addOptions({ append: 'End of file', section: 'Under section heading' })
            .setValue(this.plugin.settings.taskInsertionMode)
            .onChange(async (v) => {
              this.plugin.settings.taskInsertionMode =
                v as typeof this.plugin.settings.taskInsertionMode;
              await this.plugin.saveSettings();
              // eslint-disable-next-line @typescript-eslint/no-deprecated
              this.display();
            }),
        );

      if (this.plugin.settings.taskInsertionMode === 'section') {
        new Setting(containerEl)
          .setName('Section heading')
          .setDesc('Tasks are inserted under this heading. Created if absent.')
          .addText((t) =>
            t
              .setPlaceholder('## Tasks')
              .setValue(this.plugin.settings.taskInsertionSection)
              .onChange(async (v) => {
                this.plugin.settings.taskInsertionSection = v;
                await this.plugin.saveSettings();
              }),
          );
      }
    } else {
      new Setting(containerEl)
        .setName('Custom file path')
        .setDesc('Add new tasks to this file instead.')
        .addText((t) =>
          t
            .setPlaceholder('Tasks/inbox.md')
            .setValue(this.plugin.settings.customFilePath)
            .onChange(async (v) => {
              this.plugin.settings.customFilePath = v;
              await this.plugin.saveSettings();
            }),
        );
    }
  }

  private shortcutPlatform(): ShortcutPlatform {
    return { mod: Platform.isMacOS ? 'meta' : 'ctrl' };
  }

  private renderShortcutSettings(containerEl: HTMLElement): void {
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
    this.shortcutSaveStatusEl = saveFeedback.createSpan({
      cls: 'abyss-shortcut-save-status',
      attr: { role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' },
    });
    this.shortcutSaveRetryEl = saveFeedback.createEl('button', {
      cls: 'abyss-shortcut-save-retry',
      attr: { type: 'button' },
      text: 'Retry',
    });
    this.shortcutSaveRetryEl.addEventListener('click', () => this.queueShortcutSave());
    this.updateShortcutSavePresentation();
    const list = containerEl.createDiv({ cls: 'abyss-shortcuts-list' });

    for (const actionId of SHORTCUT_ACTION_IDS) {
      const action = SHORTCUT_ACTIONS.find((candidate) => candidate.id === actionId);
      if (!action) continue;
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
      input.value = this.plugin.settings.shortcuts[action.id];
      const issue = row.createDiv({
        cls: 'abyss-shortcut-issue',
        attr: { id: `abyss-shortcut-issue-${this.sectionScope}-${action.id}` },
      });
      inputEls.set(action.id, input);
      issueEls.set(action.id, issue);

      input.addEventListener('input', () => {
        this.plugin.settings.shortcuts[action.id] = input.value;
        this.updateShortcutIssues(inputEls, issueEls, validationStatus, false);
        this.queueShortcutSave();
      });
      input.addEventListener('blur', () => {
        this.updateShortcutIssues(inputEls, issueEls, validationStatus, true, action.id);
      });
    }

    this.updateShortcutIssues(inputEls, issueEls, validationStatus, false);
  }

  private queueShortcutSave(): void {
    this.shortcutSaveQueued = true;
    if (this.shortcutSaveInFlight) return;
    this.shortcutSaveInFlight = this.flushShortcutSaves();
  }

  private async flushShortcutSaves(): Promise<void> {
    let failed = false;
    try {
      while (this.shortcutSaveQueued) {
        this.shortcutSaveQueued = false;
        try {
          await this.plugin.saveSettings();
          this.shortcutSaveFailed = false;
          this.updateShortcutSavePresentation();
        } catch (error) {
          console.error('[task-calendar] Could not save shortcut settings', error);
          this.shortcutSaveQueued = true;
          this.shortcutSaveFailed = true;
          this.updateShortcutSavePresentation();
          failed = true;
          break;
        }
      }
    } finally {
      this.shortcutSaveInFlight = undefined;
      if (this.shortcutSaveQueued && !failed) this.queueShortcutSave();
    }
  }

  private updateShortcutIssues(
    inputEls: ReadonlyMap<ShortcutActionId, HTMLInputElement>,
    issueEls: ReadonlyMap<ShortcutActionId, HTMLElement>,
    announcementEl: HTMLElement,
    announce: boolean,
    announcedAction?: ShortcutActionId,
  ): void {
    const validation = validateShortcuts(this.plugin.settings.shortcuts, this.shortcutPlatform());
    const messages = new Set<string>();
    if (!announce) announcementEl.empty();
    for (const action of SHORTCUT_ACTIONS) {
      const input = inputEls.get(action.id);
      const issueEl = issueEls.get(action.id);
      if (!input || !issueEl) continue;
      const issues = validation.issues.get(action.id) ?? [];
      if (issues.length === 0) {
        input.removeAttribute('aria-invalid');
        input.removeAttribute('aria-describedby');
        issueEl.empty();
        continue;
      }

      input.setAttribute('aria-invalid', 'true');
      input.setAttribute('aria-describedby', issueEl.id);
      const message = describeShortcutIssues(
        action.id,
        issues,
        validation.bindings.get(action.id) ?? [],
      );
      issueEl.empty();
      const icon = issueEl.createSpan({ cls: 'abyss-shortcut-warning-icon' });
      setIcon(icon, 'triangle-alert');
      icon.setAttribute('aria-hidden', 'true');
      issueEl.appendText(message);
      if (announce && action.id === announcedAction) messages.add(message);
    }
    if (announce) announcementEl.setText([...messages].join(' '));
  }

  private updateShortcutSavePresentation(): void {
    if (this.shortcutSaveStatusEl) {
      this.shortcutSaveStatusEl.setText(
        this.shortcutSaveFailed ? 'Shortcut changes were not saved.' : '',
      );
    }
    if (this.shortcutSaveRetryEl) this.shortcutSaveRetryEl.hidden = !this.shortcutSaveFailed;
  }

  private renderInboxSettings(containerEl: HTMLElement): void {
    new Setting(containerEl)
      .setName('Inbox source')
      // eslint-disable-next-line obsidianmd/ui/sentence-case
      .setDesc('What appears in your Inbox list.')
      .addDropdown((d) =>
        d
          .addOptions({
            tag: 'Tasks with inbox tag',
            untagged: 'Untagged tasks',
            both: 'Both',
          })
          .setValue(this.plugin.settings.inbox.mode)
          .onChange(async (v) => {
            this.plugin.settings.inbox.mode = v as 'tag' | 'untagged' | 'both';
            await this.plugin.saveSettings();
            // eslint-disable-next-line @typescript-eslint/no-deprecated
            this.display();
          }),
      );

    if (this.plugin.settings.inbox.mode !== 'untagged') {
      new Setting(containerEl)
        .setName('Inbox tag')

        .setDesc('Tasks with this tag appear in inbox.')
        .addText((t) =>
          t
            // eslint-disable-next-line obsidianmd/ui/sentence-case
            .setPlaceholder('#task/inbox')
            .setValue(this.plugin.settings.inbox.tag)
            .onChange(async (v) => {
              this.plugin.settings.inbox.tag = v.trim();
              await this.plugin.saveSettings();
            }),
        );
    }

    new Setting(containerEl)
      .setName('Remove inbox tag when assigning another tag')
      .setDesc('When you drag a task to a tag, the inbox tag is removed automatically.')
      .addToggle((t) =>
        t.setValue(this.plugin.settings.inbox.removeTagOnAssign).onChange(async (v) => {
          this.plugin.settings.inbox.removeTagOnAssign = v;
          await this.plugin.saveSettings();
        }),
      );
  }

  private renderTagGroupSettings(containerEl: HTMLElement): void {
    const groups = this.plugin.settings.tagGroups;
    this.renderCardList(containerEl, groups, {
      id: (g) => g.id,
      title: (g) => g.name,
      accent: (g) => g.color,
      badge: (g) => (g.mode === 'prefix' ? 'prefix' : 'manual'),
      body: (bodyEl, idx) => this.renderTagGroupCard(bodyEl, idx),
      onReorder: (from, to) => {
        this.moveItem(groups, from, to);
        void this.plugin.saveSettings();
        // eslint-disable-next-line @typescript-eslint/no-deprecated
        this.display();
      },
    });

    const archived = this.plugin.settings.archivedTags;
    if (archived.length > 0) {
      new Setting(containerEl).setName('Archived tags').setHeading();
      for (const tag of archived) {
        new Setting(containerEl).setName(tag).addButton((b) =>
          b.setButtonText('Unarchive').onClick(async () => {
            await this.plugin.tagManager.unarchiveTag(tag);
            // eslint-disable-next-line @typescript-eslint/no-deprecated
            this.display();
          }),
        );
      }
    }

    new Setting(containerEl).addButton((b) =>
      b
        // eslint-disable-next-line obsidianmd/ui/sentence-case
        .setButtonText('+ Add group')
        .setCta()
        .onClick(async () => {
          const id = `group-${Date.now()}`;
          this.plugin.settings.tagGroups.push({
            id,
            name: 'New group',
            mode: 'prefix',
            prefix: '',
          });
          this.expandedCards.add(id);
          await this.plugin.saveSettings();
          // eslint-disable-next-line @typescript-eslint/no-deprecated
          this.display();
        }),
    );
  }

  private renderTagGroupCard(card: HTMLElement, idx: number): void {
    const groups = this.plugin.settings.tagGroups;
    const group = groups[idx];
    if (!group) return;

    new Setting(card).setName('Group name').addText((t) =>
      t.setValue(group.name).onChange(async (v) => {
        group.name = v;
        await this.plugin.saveSettings();
      }),
    );

    new Setting(card).setName('Mode').addDropdown((d) =>
      d
        .addOptions({ prefix: 'Prefix', manual: 'Manual' })
        .setValue(group.mode)
        .onChange(async (v) => {
          group.mode = v as 'prefix' | 'manual';
          await this.plugin.saveSettings();
          // eslint-disable-next-line @typescript-eslint/no-deprecated
          this.display();
        }),
    );

    new Setting(card).setName('Color').addColorPicker((cp) =>
      cp.setValue(group.color ?? '#888888').onChange(async (v) => {
        group.color = v;
        await this.plugin.saveSettings();
      }),
    );

    if (group.mode === 'prefix') {
      new Setting(card)
        .setName('Prefix')
        // eslint-disable-next-line obsidianmd/ui/sentence-case
        .setDesc('e.g. "work" matches #work and #work/dev')
        .addText((t) =>
          t
            // eslint-disable-next-line obsidianmd/ui/sentence-case
            .setPlaceholder('work')
            .setValue(group.prefix ?? '')
            .onChange(async (v) => {
              group.prefix = v.trim();
              await this.plugin.saveSettings();
            }),
        );
    } else {
      new Setting(card)
        .setName('Tags')
        // eslint-disable-next-line obsidianmd/ui/sentence-case
        .setDesc('Comma-separated, e.g. #work, #side-project')
        .addText((t) =>
          t
            // eslint-disable-next-line obsidianmd/ui/sentence-case
            .setPlaceholder('#work, #side-project')
            .setValue((group.tags ?? []).join(', '))
            .onChange(async (v) => {
              group.tags = v
                .split(',')
                .map((s) => s.trim())
                .filter(Boolean);
              await this.plugin.saveSettings();
            }),
        );
    }

    new Setting(card).addButton((b) =>
      b
        .setButtonText('Delete group')
        .setClass('mod-warning')
        .onClick(async () => {
          const removed = groups.splice(idx, 1)[0];
          if (removed) this.expandedCards.delete(removed.id);
          await this.plugin.saveSettings();
          // eslint-disable-next-line @typescript-eslint/no-deprecated
          this.display();
        }),
    );
  }

  private renderProjectsSettings(containerEl: HTMLElement): void {
    const projects = this.plugin.settings.projects;

    new Setting(containerEl)
      .setName('Membership query')
      // eslint-disable-next-line obsidianmd/ui/sentence-case
      .setDesc('What counts as a project. Syntax: folder/, #tag, key=value, AND / OR / NOT / ( ).')
      .addText((t) =>
        t

          .setPlaceholder('Projects/')
          .setValue(projects.membershipQuery)
          .onChange(async (v) => {
            projects.membershipQuery = v;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Create folder')
      .setDesc('Where new project notes are created.')
      .addText((t) =>
        t

          .setPlaceholder('Projects')
          .setValue(projects.createFolder)
          .onChange(async (v) => {
            projects.createFolder = v;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Template path')
      .setDesc('Optional template for new projects. Templater is used when installed.')
      .addText((t) =>
        t
          .setPlaceholder('Templates/Project.md')
          .setValue(projects.templatePath)
          .onChange(async (v) => {
            projects.templatePath = v;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Task insert position')
      .setDesc('Where a task is placed in a project note when created there or moved in.')
      .addDropdown((d) =>
        d
          .addOptions({ append: 'End of note', section: 'Under section heading' })
          .setValue(projects.taskInsertionMode)
          .onChange(async (v) => {
            projects.taskInsertionMode = v as typeof projects.taskInsertionMode;
            await this.plugin.saveSettings();
            // eslint-disable-next-line @typescript-eslint/no-deprecated
            this.display();
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
              await this.plugin.saveSettings();
            }),
        );
    }

    const previewResult = containerEl.createDiv({
      cls: 'abyss-work-note-preview',
      attr: { 'aria-live': 'polite' },
    });
    new Setting(containerEl)
      .setName('Work note compatibility')
      .setDesc('Inspect aggregate compatibility without enabling or saving a preset.')
      .addButton((button) =>
        button.setButtonText('Preview work notes').onClick(async () => {
          button.setDisabled(true);
          previewResult.replaceChildren();
          previewResult.createDiv({ text: 'Reading metadata…' });
          try {
            const preview = await this.plugin.previewWorkNoteCompatibility();
            this.renderWorkNotePreview(previewResult, preview);
          } catch {
            previewResult.replaceChildren();
            previewResult.createDiv({ text: 'Preview unavailable.' });
          } finally {
            button.setDisabled(false);
          }
        }),
      );

    new Setting(containerEl).setName('Statuses').setHeading();
    this.renderCardList(containerEl, projects.statuses, {
      id: (s) => s.id,
      title: (s) => s.label,
      accent: (s) => s.color,
      badge: (s) => (s.match.kind === 'tag' ? 'tag' : 'property'),
      body: (bodyEl, idx) => this.renderStatusCard(bodyEl, idx),
      onReorder: (from, to) => {
        this.moveItem(projects.statuses, from, to);
        void this.plugin.saveSettings();
        // eslint-disable-next-line @typescript-eslint/no-deprecated
        this.display();
      },
    });

    new Setting(containerEl).addButton((b) =>
      b
        // eslint-disable-next-line obsidianmd/ui/sentence-case
        .setButtonText('+ Add status')
        .setCta()
        .onClick(async () => {
          // Collision-proof id: smallest status-N not already taken.
          let n = projects.statuses.length + 1;
          while (projects.statuses.some((s) => s.id === `status-${n}`)) n++;
          const id = `status-${n}`;
          projects.statuses.push({
            id,
            label: 'New status',
            color: '#888888',
            onLeftPanel: false,
            behavior: 'regular',
            match: { kind: 'property', property: 'status', value: '' },
          });
          this.expandedCards.add(id); // open the new card for editing
          await this.plugin.saveSettings();
          // eslint-disable-next-line @typescript-eslint/no-deprecated
          this.display();
        }),
    );

    // A single place to pick the default status — not a per-status toggle.
    if (projects.statuses.length > 0) {
      new Setting(containerEl)
        .setName('Default status')
        .setDesc('Applied to newly created projects.')
        .addDropdown((d) => {
          for (const s of projects.statuses) d.addOption(s.id, s.label);
          d.setValue(projects.defaultStatusId || projects.statuses[0]!.id).onChange(async (v) => {
            projects.defaultStatusId = v;
            await this.plugin.saveSettings();
          });
        });
    }
  }

  private renderWorkNotePreview(
    containerEl: HTMLElement,
    preview: WorkNoteCompatibilityPreview,
  ): void {
    containerEl.replaceChildren();
    containerEl.dataset['presetEnabled'] = String(preview.preset.enabled);
    containerEl.dataset['accepted'] = String(preview.preset.accepted);
    containerEl.dataset['capabilityUpdate'] = String(preview.capabilities.update);
    containerEl.dataset['capabilityCreate'] = String(preview.capabilities.create);
    const rows = [
      [
        counted(preview.notes.scanned, 'note'),
        counted(preview.notes.eligible, 'eligible', 'eligible'),
        counted(preview.notes.excluded, 'excluded', 'excluded'),
      ],
      [
        counted(preview.kinds.ordinary, 'ordinary', 'ordinary'),
        counted(preview.kinds.milestone, 'milestone'),
        counted(preview.kinds.ambiguous, 'ambiguous kind'),
        counted(preview.kinds.missing, 'missing kind'),
      ],
      [
        counted(preview.statuses.mapped, 'mapped status', 'mapped statuses'),
        counted(preview.statuses.unknown, 'unknown status', 'unknown statuses'),
        counted(preview.statuses.missing, 'missing status', 'missing statuses'),
        counted(preview.statuses.nonScalar, 'non-scalar status', 'non-scalar statuses'),
      ],
      [
        counted(preview.links.brokenProject, 'broken project link'),
        counted(preview.links.brokenRelation, 'broken relation'),
        counted(preview.links.invalidProjectEntry, 'invalid project entry'),
        counted(preview.links.invalidRelationEntry, 'invalid relation entry'),
      ],
      [
        counted(preview.cardinality.missingProject, 'missing project'),
        counted(preview.cardinality.multipleProjects, 'multiple-project diagnostic'),
        counted(preview.cardinality.multipleMilestones, 'multiple-milestone diagnostic'),
        counted(preview.duplicateBasenames.project, 'duplicate project basename'),
        counted(preview.duplicateBasenames.relation, 'duplicate relation basename'),
      ],
    ];
    for (const row of rows) {
      containerEl.createDiv({ cls: 'abyss-work-note-preview-row', text: row.join(' · ') });
    }
    const capability = containerEl.createDiv({ cls: 'abyss-work-note-preview-capabilities' });
    capability.createSpan({
      attr: { 'data-work-note-capability': 'update' },
      text: `Updates ${preview.capabilities.update ? 'enabled' : 'unavailable'}`,
    });
    capability.createSpan({
      attr: { 'data-work-note-capability': 'create' },
      text: `Creation ${preview.capabilities.create ? 'enabled' : 'unavailable'}`,
    });
    if (preview.preset.enabled && preview.preset.accepted) {
      containerEl.createDiv({
        cls: 'abyss-work-note-preview-guard',
        text:
          preview.capabilities.update && preview.capabilities.create
            ? 'Updates and creation enabled by the accepted compatibility audit.'
            : 'Work Notes enabled with only the audited capabilities shown above.',
      });
      const disable = containerEl.createEl('button', {
        text: 'Disable work notes',
        attr: { type: 'button', 'data-work-note-disable': '' },
      });
      disable.addEventListener('click', () => {
        disable.disabled = true;
        void this.plugin.disableWorkNoteCompatibility().then(
          () => {
            containerEl.replaceChildren();
            containerEl.createDiv({ text: 'Work Notes disabled.' });
          },
          () => {
            disable.disabled = false;
            containerEl.createDiv({ text: 'Could not disable Work Notes.' });
          },
        );
      });
      return;
    }
    containerEl.createDiv({
      cls: 'abyss-work-note-preview-guard',
      text: 'Read-only preview. Commands remain unavailable until this exact audit is accepted.',
    });
    if (preview.notes.eligible === 0 || !preview.acceptanceToken) return;
    const acceptanceToken = preview.acceptanceToken;
    const accept = containerEl.createEl('button', {
      text: 'Enable audited work notes',
      attr: { type: 'button', 'data-work-note-accept': '' },
    });
    accept.addEventListener('click', () => {
      accept.disabled = true;
      void this.plugin.acceptWorkNoteCompatibility(acceptanceToken).then(
        (accepted) => {
          if (accepted.type === 'ok') {
            this.renderWorkNotePreview(containerEl, accepted.preview);
            return;
          }
          containerEl.replaceChildren();
          containerEl.createDiv({
            text:
              accepted.type === 'stale-preview'
                ? 'Work note audit changed. Preview again before enabling.'
                : 'Audit acceptance unavailable.',
          });
        },
        () => {
          accept.disabled = false;
          containerEl.createDiv({ text: 'Audit acceptance unavailable.' });
        },
      );
    });
  }

  private renderStatusCard(card: HTMLElement, idx: number): void {
    const projects = this.plugin.settings.projects;
    const statuses = projects.statuses;
    const status = statuses[idx];
    if (!status) return;

    new Setting(card).setName('Label').addText((t) =>
      t.setValue(status.label).onChange(async (v) => {
        status.label = v;
        await this.plugin.saveSettings();
      }),
    );

    new Setting(card).setName('Defined by').addDropdown((d) =>
      d
        .addOptions({ property: 'Frontmatter property', tag: 'Tag' })
        .setValue(status.match.kind)
        .onChange(async (v) => {
          status.match =
            v === 'tag'
              ? { kind: 'tag', tag: '' }
              : { kind: 'property', property: 'status', value: '' };
          await this.plugin.saveSettings();
          // eslint-disable-next-line @typescript-eslint/no-deprecated
          this.display();
        }),
    );

    if (status.match.kind === 'property') {
      const match = status.match;
      new Setting(card).setName('Property').addText((t) =>
        t
          // eslint-disable-next-line obsidianmd/ui/sentence-case
          .setPlaceholder('status')
          .setValue(match.property)
          .onChange(async (v) => {
            match.property = v.trim();
            await this.plugin.saveSettings();
          }),
      );
      new Setting(card).setName('Value').addText((t) =>
        t
          // eslint-disable-next-line obsidianmd/ui/sentence-case
          .setPlaceholder('active')
          .setValue(match.value)
          .onChange(async (v) => {
            match.value = v.trim();
            await this.plugin.saveSettings();
          }),
      );
    } else {
      const match = status.match;
      new Setting(card).setName('Tag').addText((t) =>
        t
          // eslint-disable-next-line obsidianmd/ui/sentence-case
          .setPlaceholder('active')
          .setValue(match.tag)
          .onChange(async (v) => {
            match.tag = v.trim().replace(/^#/, '');
            await this.plugin.saveSettings();
          }),
      );
    }

    new Setting(card).setName('Color').addColorPicker((cp) =>
      cp.setValue(status.color ?? '#888888').onChange(async (v) => {
        status.color = v;
        await this.plugin.saveSettings();
      }),
    );

    new Setting(card).setName('Show on left panel').addToggle((tg) =>
      tg.setValue(status.onLeftPanel).onChange(async (v) => {
        status.onLeftPanel = v;
        await this.plugin.saveSettings();
      }),
    );

    new Setting(card).addButton((b) =>
      b
        .setButtonText('Delete status')
        .setClass('mod-warning')
        .setDisabled(statuses.length <= 1)
        .onClick(async () => {
          const removed = statuses.splice(idx, 1)[0];
          if (removed) {
            this.expandedCards.delete(removed.id);
            if (projects.defaultStatusId === removed.id) {
              projects.defaultStatusId = statuses[0]?.id ?? '';
            }
          }
          await this.plugin.saveSettings();
          // eslint-disable-next-line @typescript-eslint/no-deprecated
          this.display();
        }),
    );
  }

  private renderViewConfigSettings(container: HTMLElement, platform: 'desktop' | 'mobile'): void {
    const cfg = this.plugin.settings[platform];

    new Setting(container).setName('Default view').addDropdown((d) =>
      d
        .addOptions({ month: 'Month', week: 'Week', list: 'List' })
        .setValue(cfg.defaultView)
        .onChange(async (v) => {
          cfg.defaultView = v as typeof cfg.defaultView;
          await this.plugin.saveSettings();
        }),
    );

    new Setting(container).setName('First day of week').addDropdown((d) =>
      d
        .addOptions({ '0': 'Sunday', '1': 'Monday', '6': 'Saturday' })
        .setValue(String(cfg.firstDayOfWeek))
        .onChange(async (v) => {
          cfg.firstDayOfWeek = parseInt(v) as typeof cfg.firstDayOfWeek;
          await this.plugin.saveSettings();
        }),
    );

    if (this.plugin.settings.dailyNoteProvider === 'manual' || !this.plugin.settings.addToToday) {
      new Setting(container).setName('Daily note folder').addText((t) =>
        t.setValue(cfg.dailyNoteFolder).onChange(async (v) => {
          cfg.dailyNoteFolder = v;
          await this.plugin.saveSettings();
        }),
      );

      new Setting(container)
        .setName('Daily note format')
        .setDesc('Moment.js format, e.g. YYYY-MM-DD.')
        .addText((t) =>
          t.setValue(cfg.dailyNoteFormat).onChange(async (v) => {
            cfg.dailyNoteFormat = v;
            await this.plugin.saveSettings();
          }),
        );
    }

    new Setting(container)
      .setName('Global task filter')
      // eslint-disable-next-line obsidianmd/ui/sentence-case
      .setDesc('Tag to strip from task display text, e.g. #task.')
      .addText((t) =>
        t.setValue(cfg.globalTaskFilter).onChange(async (v) => {
          cfg.globalTaskFilter = v;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(container)
      .setName('Upcoming days')
      .setDesc('Number of days shown in list view.')
      .addText((text) =>
        text.setValue(String(cfg.upcomingDays)).onChange(async (value) => {
          const n = parseInt(value, 10);
          if (!isNaN(n) && n > 0) {
            cfg.upcomingDays = n;
            await this.plugin.saveSettings();
          }
        }),
      );
  }

  /** Persists a taskStatuses mutation and rebuilds the store's registry so open panels update. */
  private async persistStatuses(): Promise<void> {
    await this.plugin.saveSettings();
    this.plugin.rebuildTaskStatusSemantics();
  }

  /** Persists and fully re-renders — for structural changes (add/delete/type/group move). */
  private async persistAndRerenderStatuses(): Promise<void> {
    await this.persistStatuses();
    // eslint-disable-next-line @typescript-eslint/no-deprecated
    this.display();
  }

  private moveStatusToGroup(id: string, targetType: TaskStatusType): void {
    const statuses = this.plugin.settings.taskStatuses;
    const def = statuses.find((s) => s.id === id);
    if (!def || def.type === targetType) return;
    if (def.core) return; // core cards cannot leave their own type group
    def.type = targetType;
    void this.persistAndRerenderStatuses();
  }

  private reorderStatusWithinType(type: TaskStatusType, from: number, to: number): void {
    const statuses = this.plugin.settings.taskStatuses;
    const groupIndices = statuses
      .map((s, i) => ({ s, i }))
      .filter((x) => x.s.type === type)
      .map((x) => x.i);
    const fromAbs = groupIndices[from];
    const toAbs = groupIndices[to];
    if (fromAbs === undefined || toAbs === undefined) return;
    this.moveItem(statuses, fromAbs, toAbs);
    void this.persistAndRerenderStatuses();
  }

  private renderTaskStatusesSettings(containerEl: HTMLElement): void {
    const statuses = this.plugin.settings.taskStatuses;
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
      groupEl.addEventListener('dragover', (e) => e.preventDefault());
      groupEl.addEventListener('drop', (e) => {
        e.preventDefault();
        const raw = e.dataTransfer?.getData('text/plain');
        if (!raw) return;
        let payload: { id: string; groupKey?: string };
        try {
          payload = JSON.parse(raw) as typeof payload;
        } catch {
          return;
        }
        if (payload.groupKey === type) return; // handled by a card's own drop listener
        this.moveStatusToGroup(payload.id, type);
      });

      this.renderCardList(groupEl, items, {
        id: (s) => s.id,
        title: (s) => s.name,
        badge: (s) => s.symbol,
        preview: (headerEl, s) => {
          const previewEl = headerEl.createSpan({ cls: 'abyss-status-header-preview' });
          this.statusHeaderPreviewEls.set(s.id, previewEl);
          this.renderStatusHeaderPreview(s.id);
        },
        groupKey: type,
        onCrossGroupDrop: (id, targetType) =>
          this.moveStatusToGroup(id, targetType as TaskStatusType),
        body: (bodyEl, idx) => this.renderTaskStatusCardBody(bodyEl, items, idx),
        onReorder: (from, to) => this.reorderStatusWithinType(type, from, to),
      });
    }

    new Setting(containerEl).addButton((b) =>
      b
        // eslint-disable-next-line obsidianmd/ui/sentence-case
        .setButtonText('+ Add status')
        .setCta()
        .onClick(async () => {
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
          this.expandedCards.add(id);
          await this.persistAndRerenderStatuses();
        }),
    );
  }

  /** Re-renders a status's collapsed-card header preview chip (e.g. after an icon edit). */
  private renderStatusHeaderPreview(statusId: string): void {
    const previewEl = this.statusHeaderPreviewEls.get(statusId);
    if (!previewEl) return;
    const statuses = this.plugin.settings.taskStatuses;
    const def = statuses.find((s) => s.id === statusId);
    if (!def) return;
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

  private renderTaskStatusCardBody(
    bodyEl: HTMLElement,
    groupItems: TaskStatusDef[],
    idx: number,
  ): void {
    const def = groupItems[idx];
    if (!def) return;
    const statuses = this.plugin.settings.taskStatuses;

    let updatePreview: () => void = () => {};

    new Setting(bodyEl).setName('Name').addText((t) =>
      t.setValue(def.name).onChange(async (v) => {
        def.name = v;
        await this.persistStatuses();
        updatePreview();
      }),
    );

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
        if (err) {
          if (!symbolErrorEl) {
            symbolErrorEl = symbolSetting.descEl.createDiv({ cls: 'abyss-status-symbol-error' });
          }
          symbolErrorEl.setText(err);
          return;
        }
        if (symbolErrorEl) {
          symbolErrorEl.remove();
          symbolErrorEl = null;
        }
        def.symbol = v;
        await this.persistStatuses();
        updatePreview();
      });
      return t;
    });

    // Icon: core statuses are fully locked — their icon is part of the fixed,
    // predictable default appearance and is never user-editable. Only
    // custom (non-core) statuses get the searchable Lucide picker.
    if (def.core) {
      const iconSetting = new Setting(bodyEl).setName('Icon');
      const lockEl = iconSetting.nameEl.createSpan({ cls: 'abyss-status-icon-lock' });
      setIcon(lockEl, 'lock');
      iconSetting.setTooltip('Core status — icon is fixed');
      const lockedPreview = iconSetting.controlEl.createDiv({
        cls: 'abyss-status-icon-locked-preview',
      });
      if (def.icon) {
        setIcon(lockedPreview, def.icon);
      } else {
        lockedPreview.createSpan({ cls: 'abyss-status-icon-result-icon', text: '—' });
      }
    } else {
      const iconWrap = bodyEl.createDiv({ cls: 'abyss-status-icon-field' });
      const iconInputHost = iconWrap.createDiv({ cls: 'abyss-status-icon-input-host' });

      // getIconIds() returns ids prefixed with "lucide-" (e.g. "lucide-alert-triangle"),
      // but stored status icons use the short form (e.g. "alert-triangle") that setIcon
      // and renderStatusMarker expect. Normalize to short ids, deduping any collisions.
      const allIconIds = (() => {
        const seen = new Set<string>();
        const out: string[] = [];
        for (const raw of getIconIds()) {
          const short = raw.startsWith('lucide-') ? raw.slice('lucide-'.length) : raw;
          if (seen.has(short)) continue;
          seen.add(short);
          out.push(short);
        }
        return out;
      })();

      let renderResults: (query: string, focusIcon?: string) => void = () => {};

      new Setting(iconInputHost).setName('Search icons').addText((t) =>
        t
          .setPlaceholder('Search lucide icons…')
          .setValue('')
          .onChange((v) => renderResults(v)),
      );

      const resultsEl = iconInputHost.createDiv({ cls: 'abyss-status-icon-results' });
      renderResults = (query: string, focusIcon?: string) => {
        resultsEl.empty();

        const selectIcon = (iconId: string): void => {
          def.icon = iconId;
          void this.persistStatuses();
          renderResults(query, iconId);
          updatePreview();
          this.renderStatusHeaderPreview(def.id);
        };

        // "No icon" is always the first cell — the only way to clear a
        // previously-set icon back to the empty (plain to-do-style) chip.
        const clearCell = resultsEl.createEl('button', {
          cls: `abyss-status-icon-result abyss-status-icon-clear${def.icon === '' ? ' is-selected' : ''}`,
          attr: {
            type: 'button',
            title: 'No icon',
            'data-icon': '',
            'aria-label': 'Clear icon',
            'aria-pressed': String(def.icon === ''),
          },
        });
        clearCell.createSpan({ cls: 'abyss-status-icon-result-icon', text: '—' });
        clearCell.addEventListener('click', () => selectIcon(''));

        const q = query.trim().toLowerCase();
        const ids = allIconIds
          .filter((iconId) => !q || iconId.toLowerCase().includes(q))
          .slice(0, 48);
        if (ids.length === 0) {
          resultsEl.createDiv({ cls: 'abyss-status-icon-empty', text: 'No icons found' });
        } else {
          for (const iconId of ids) {
            const cell = resultsEl.createEl('button', {
              cls: `abyss-status-icon-result${iconId === def.icon ? ' is-selected' : ''}`,
              attr: {
                type: 'button',
                title: iconId,
                'data-icon': iconId,
                'aria-label': `Select icon ${iconId}`,
                'aria-pressed': String(iconId === def.icon),
              },
            });
            const iconPreview = cell.createSpan({ cls: 'abyss-status-icon-result-icon' });
            setIcon(iconPreview, iconId);
            cell.addEventListener('click', () => selectIcon(iconId));
          }
        }

        if (focusIcon !== undefined) {
          const cell = Array.from(
            resultsEl.querySelectorAll<HTMLButtonElement>('.abyss-status-icon-result'),
          ).find((button) => button.dataset['icon'] === focusIcon);
          cell?.focus({ preventScroll: true });
        }
      };
      renderResults('');
    }

    const previewSetting = new Setting(bodyEl).setName('Preview');
    const previewHost = previewSetting.controlEl.createDiv({ cls: 'abyss-status-preview' });
    updatePreview = () => {
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
        text: def.name || 'Sample task',
      });
    };
    updatePreview();

    if (!def.core) {
      let armed = false;
      new Setting(bodyEl).addButton((b) =>
        b
          .setButtonText('Delete status')
          .setClass('mod-warning')
          .onClick(async () => {
            if (!armed) {
              armed = true;
              b.setButtonText('Click again to confirm');
              new Notice('Deleting this status: tasks using it will fall back to plain to-do.');
              window.setTimeout(() => {
                armed = false;
                b.setButtonText('Delete status');
              }, 4000);
              return;
            }
            const i = statuses.findIndex((s) => s.id === def.id);
            if (i >= 0) statuses.splice(i, 1);
            this.expandedCards.delete(def.id);
            await this.persistAndRerenderStatuses();
          }),
      );
    }
  }
}
