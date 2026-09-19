// src/tags/TagManager.ts
import type { App, TFile } from 'obsidian';
import type { ListSelection } from '../app/AppState';
import { beginSettingsSave, latestSettingsSaveRevision } from '../settings/settingsSaveRevision';
import type { CalendarSettings } from '../settings/types';
import { normalizeTaskTagInput } from '../tasks';
import {
  discoveredPrefixGroupId,
  discoveredTagGroupId,
  normalizeTagPrefix,
  prefixForDiscoveredGroupId,
  type EffectiveTagGroup,
} from './effectiveTagGroups';
import { normalizeTag, transformMarkdownTags, type TagRenameScope } from './markdownTagRename';

export type VaultTagRenameResult =
  | {
      readonly type: 'ok';
      readonly changedFiles: readonly string[];
    }
  | {
      readonly type: 'partial';
      readonly changedFiles: readonly string[];
      readonly failedFiles: readonly string[];
    }
  | {
      readonly type: 'settings-error';
      readonly changedFiles: readonly string[];
      readonly failedFiles: readonly string[];
    }
  | {
      readonly type: 'invalid';
      readonly reason: 'invalid-tag' | 'same-tag';
    };

function replaceSettingTag(
  value: string,
  oldTag: string,
  newTag: string,
  scope: TagRenameScope,
): string {
  if (value === oldTag) return newTag;
  if (scope === 'prefix' && value.startsWith(`${oldTag}/`)) {
    return `${newTag}${value.slice(oldTag.length)}`;
  }
  return value;
}

function replaceConfiguredTag(
  value: string,
  oldTag: string,
  newTag: string,
  scope: TagRenameScope,
): string {
  const normalized = normalizeTaskTagInput(value);
  const tag = normalized?.length === 1 ? normalized[0] : undefined;
  if (tag === undefined) return value;
  const updated = replaceSettingTag(tag, oldTag, newTag, scope);
  return updated === tag ? value : updated;
}

function replaceConfiguredPrefix(
  value: string,
  oldTag: string,
  newTag: string,
  scope: TagRenameScope,
): string {
  const prefix = normalizeTagPrefix(value);
  if (prefix === undefined) return value;
  const tag = `#${prefix}`;
  const updated = replaceSettingTag(tag, oldTag, newTag, scope);
  return updated === tag ? value : updated.slice(1);
}

function uniqueInOrder(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function sameValues(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

interface SettingsRenameUpdate {
  readonly changed: boolean;
  readonly rollback: () => void;
}

export interface SelectedListState {
  readonly getSelectedList: () => ListSelection;
  readonly setSelectedList: (selection: ListSelection) => void;
}

interface PreparedTagRename {
  readonly file: TFile;
  readonly transform: (content: string) => string;
}

interface TagRenameFilesResult {
  readonly changedFiles: string[];
  readonly failedFiles: string[];
}

interface SettingListUpdate {
  readonly current: readonly string[];
  readonly apply: (values: string[]) => void;
  readonly latest: () => readonly string[];
  readonly replace: (value: string) => string;
  readonly rollbacks: Array<() => void>;
}

function updateSettingList(context: SettingListUpdate): void {
  const { current, apply, latest, replace, rollbacks } = context;
  const updated = uniqueInOrder(current.map(replace));
  if (sameValues(updated, current)) return;
  const applied = [...updated];
  apply(updated);
  rollbacks.push(() => {
    if (sameValues(latest(), applied)) apply([...current]);
  });
}

interface TagGroupRenameContext {
  readonly settings: CalendarSettings;
  readonly replace: (value: string) => string;
  readonly replacePrefix: (value: string) => string;
  readonly scope: TagRenameScope;
}

function updateTagGroups(context: TagGroupRenameContext, rollbacks: Array<() => void>): void {
  const { settings, replace, replacePrefix, scope } = context;
  for (const group of settings.tagGroups) {
    if (updateManualTagGroup(group, replace, rollbacks)) continue;
    updatePrefixTagGroup(group, replacePrefix, scope, rollbacks);
  }
}

type TagGroup = CalendarSettings['tagGroups'][number];
export interface TagGroupUpdate {
  readonly name?: string;
  readonly color?: string | undefined;
  readonly mode?: TagGroup['mode'];
  readonly prefix?: string | undefined;
  readonly tags?: string[] | undefined;
}

interface TagGroupSnapshot {
  readonly name: string;
  readonly color: string | undefined;
  readonly mode: TagGroup['mode'];
  readonly prefix: string | undefined;
  readonly tags: string[] | undefined;
}

function tagGroupFromEffective(group: EffectiveTagGroup): TagGroup {
  return {
    id: group.id,
    name: group.name,
    mode: group.mode,
    ...(group.color === undefined ? {} : { color: group.color }),
    ...(group.prefix === undefined ? {} : { prefix: group.prefix }),
    ...(group.tags === undefined ? {} : { tags: [...group.tags] }),
  };
}

function snapshotTagGroup(group: TagGroup): TagGroupSnapshot {
  return {
    name: group.name,
    color: group.color,
    mode: group.mode,
    prefix: group.prefix,
    tags: group.tags === undefined ? undefined : [...group.tags],
  };
}

function applyTagGroupUpdate(group: TagGroup, update: TagGroupUpdate): void {
  Object.assign(group, update);
  if ('color' in update && update.color === undefined) delete group.color;
  if ('prefix' in update && update.prefix === undefined) delete group.prefix;
  if ('tags' in update && update.tags === undefined) delete group.tags;
  else if (update.tags !== undefined) group.tags = [...update.tags];
}

function restoreOptionalString(
  group: TagGroup,
  key: 'color' | 'prefix',
  expected: string | undefined,
  previous: string | undefined,
): void {
  if (group[key] !== expected) return;
  if (previous === undefined) delete group[key];
  else group[key] = previous;
}

function rollbackTagGroupUpdate(
  group: TagGroup,
  update: TagGroupUpdate,
  previous: TagGroupSnapshot,
): void {
  if (update.name !== undefined && group.name === update.name) group.name = previous.name;
  if ('color' in update) restoreOptionalString(group, 'color', update.color, previous.color);
  if (update.mode !== undefined && group.mode === update.mode) group.mode = previous.mode;
  if ('prefix' in update) restoreOptionalString(group, 'prefix', update.prefix, previous.prefix);
  rollbackTagGroupTags(group, update.tags, previous.tags);
}

function rollbackTagGroupTags(
  group: TagGroup,
  expected: string[] | undefined,
  previous: string[] | undefined,
): void {
  if (expected === undefined || !sameValues(group.tags ?? [], expected)) return;
  if (previous === undefined) delete group.tags;
  else group.tags = previous;
}

interface TagRenameIdentity {
  readonly oldTag: string;
  readonly newTag: string;
  readonly scope: TagRenameScope;
}

function rebaseDiscoveredGroupSelection(
  state: SelectedListState,
  selected: Extract<ListSelection, { readonly type: 'group' }>,
  rename: TagRenameIdentity,
): void {
  const { oldTag, newTag, scope } = rename;
  if (scope === 'prefix' && selected.groupId === discoveredPrefixGroupId(oldTag.slice(1))) {
    state.setSelectedList({ type: 'group', groupId: discoveredPrefixGroupId(newTag.slice(1)) });
    return;
  }
  if (scope === 'exact' && selected.groupId === discoveredTagGroupId(oldTag)) {
    state.setSelectedList({ type: 'group', groupId: discoveredTagGroupId(newTag) });
  }
}

function rebaseTagSelection(
  state: SelectedListState,
  selected: Extract<ListSelection, { readonly type: 'tag' }>,
  rename: TagRenameIdentity,
): void {
  const tag = replaceSettingTag(selected.tag, rename.oldTag, rename.newTag, rename.scope);
  if (tag !== selected.tag) state.setSelectedList({ type: 'tag', tag });
}

function updateManualTagGroup(
  group: TagGroup,
  replace: (value: string) => string,
  rollbacks: Array<() => void>,
): boolean {
  if (group.mode !== 'manual' || group.tags == null) return false;
  const previous = group.tags;
  const updated = uniqueInOrder(previous.map(replace));
  if (sameValues(updated, previous)) return true;
  const applied = [...updated];
  group.tags = updated;
  rollbacks.push(() => {
    if (group.tags != null && sameValues(group.tags, applied)) group.tags = previous;
  });
  return true;
}

function updatePrefixTagGroup(
  group: TagGroup,
  replacePrefix: (value: string) => string,
  scope: TagRenameScope,
  rollbacks: Array<() => void>,
): void {
  if (
    scope !== 'prefix' ||
    group.mode !== 'prefix' ||
    group.prefix === undefined ||
    group.prefix.length === 0
  ) {
    return;
  }
  const previous = group.prefix;
  const updated = replacePrefix(previous);
  if (updated === previous) return;
  group.prefix = updated;
  rollbacks.push(() => {
    if (group.prefix === updated) group.prefix = previous;
  });
}

function updateTagSettings(
  settings: CalendarSettings,
  oldTag: string,
  newTag: string,
  scope: TagRenameScope,
): SettingsRenameUpdate {
  const replaceReference = (value: string): string =>
    replaceConfiguredTag(value, oldTag, newTag, scope);
  const replacePrefix = (value: string): string =>
    replaceConfiguredPrefix(value, oldTag, newTag, scope);
  const rollbacks: Array<() => void> = [];
  const applyPinnedTags = (values: string[]): void => {
    settings.pinnedTags = values;
  };
  const applyArchivedTags = (values: string[]): void => {
    settings.archivedTags = values;
  };
  const applyArchivedTagPrefixes = (values: string[]): void => {
    settings.archivedTagPrefixes = values;
  };

  updateSettingList({
    current: settings.pinnedTags,
    apply: applyPinnedTags,
    latest: () => settings.pinnedTags,
    replace: replaceReference,
    rollbacks,
  });
  updateSettingList({
    current: settings.archivedTags,
    apply: applyArchivedTags,
    latest: () => settings.archivedTags,
    replace: replaceReference,
    rollbacks,
  });
  updateSettingList({
    current: settings.archivedTagPrefixes,
    apply: applyArchivedTagPrefixes,
    latest: () => settings.archivedTagPrefixes,
    replace: (prefix) => replaceConfiguredPrefix(prefix, oldTag, newTag, scope),
    rollbacks,
  });
  updateTagGroups({ settings, replace: replaceReference, replacePrefix, scope }, rollbacks);

  const previousInboxTag = settings.inbox.tag;
  const nextInboxTag = replaceReference(previousInboxTag);
  if (nextInboxTag !== previousInboxTag) {
    settings.inbox.tag = nextInboxTag;
    rollbacks.push(() => {
      if (settings.inbox.tag === nextInboxTag) settings.inbox.tag = previousInboxTag;
    });
  }

  const previousTaskPrefix = settings.taskPrefix;
  const nextTaskPrefix = transformMarkdownTags(previousTaskPrefix, oldTag, newTag, scope);
  if (nextTaskPrefix !== previousTaskPrefix) {
    settings.taskPrefix = nextTaskPrefix;
    rollbacks.push(() => {
      if (settings.taskPrefix === nextTaskPrefix) settings.taskPrefix = previousTaskPrefix;
    });
  }

  return {
    changed: rollbacks.length > 0,
    rollback: () => {
      for (const rollback of rollbacks) rollback();
    },
  };
}

export class TagManager {
  private renameQueue: Promise<void> = Promise.resolve();
  private readonly selectedListStates = new Set<SelectedListState>();

  constructor(
    private readonly app: App,
    private readonly settings: CalendarSettings,
    private readonly saveSettings: () => Promise<void>,
  ) {}

  registerSelectedListState(state: SelectedListState): () => void {
    this.selectedListStates.add(state);
    return () => {
      this.selectedListStates.delete(state);
    };
  }

  /**
   * Zero-friction manual tag: creates a manual TagGroup holding one tag derived
   * from the name. Nested/prefix tags remain a settings-time configuration.
   */
  async createManualGroup(name: string): Promise<void> {
    const label = name.trim();
    if (label.length === 0) return;
    const slug = label
      .toLowerCase()
      .replace(/\s+/g, '-')
      .replace(/[^\w/-]/g, '');
    if (slug.length === 0) return;
    const tag = slug.startsWith('#') ? slug : `#${slug}`;
    // Collision-proof id (length-based ids repeat after add/delete cycles).
    const base = `group-${slug}`;
    let id = base;
    let n = 2;
    while (this.settings.tagGroups.some((g) => g.id === id)) id = `${base}-${n++}`;
    this.settings.tagGroups.push({ id, name: label, mode: 'manual', tags: [tag] });
    await this.persistSettings();
  }

  async pinTag(tag: string): Promise<void> {
    if (this.settings.pinnedTags.includes(tag)) return;
    const previous = this.settings.pinnedTags;
    const applied = [...previous, tag];
    this.settings.pinnedTags = applied;
    await this.persistMutation(() => {
      if (this.settings.pinnedTags === applied) this.settings.pinnedTags = previous;
    });
  }

  async unpinTag(tag: string): Promise<void> {
    const idx = this.settings.pinnedTags.indexOf(tag);
    if (idx < 0) return;
    const previous = this.settings.pinnedTags;
    const applied = previous.filter((_, index) => index !== idx);
    this.settings.pinnedTags = applied;
    await this.persistMutation(() => {
      if (this.settings.pinnedTags === applied) this.settings.pinnedTags = previous;
    });
  }

  async archiveTag(tag: string): Promise<void> {
    if (this.settings.archivedTags.includes(tag)) return;
    const previousArchived = this.settings.archivedTags;
    const previousPinned = this.settings.pinnedTags;
    const appliedArchived = [...previousArchived, tag];
    const appliedPinned = previousPinned.filter((candidate) => candidate !== tag);
    this.settings.archivedTags = appliedArchived;
    this.settings.pinnedTags = appliedPinned;
    await this.persistMutation(() => {
      if (this.settings.archivedTags === appliedArchived)
        this.settings.archivedTags = previousArchived;
      if (this.settings.pinnedTags === appliedPinned) this.settings.pinnedTags = previousPinned;
    });
  }

  async unarchiveTag(tag: string): Promise<void> {
    const idx = this.settings.archivedTags.indexOf(tag);
    if (idx < 0) return;
    const previous = this.settings.archivedTags;
    const applied = previous.filter((_, index) => index !== idx);
    this.settings.archivedTags = applied;
    await this.persistMutation(() => {
      if (this.settings.archivedTags === applied) this.settings.archivedTags = previous;
    });
  }

  async archiveGroup(group: EffectiveTagGroup): Promise<void> {
    if (group.origin === 'configured') {
      const configured = this.settings.tagGroups.find((candidate) => candidate.id === group.id);
      if (configured === undefined || configured.archived === true) return;
      configured.archived = true;
      await this.persistMutation(() => {
        if (configured.archived === true) delete configured.archived;
      });
      return;
    }
    if (group.mode === 'manual') {
      const tag = group.tags?.[0];
      if (tag !== undefined) await this.archiveTag(tag);
      return;
    }
    const prefix = group.prefix;
    if (
      prefix === undefined ||
      this.settings.archivedTagPrefixes.some(
        (candidate) => normalizeTagPrefix(candidate) === prefix,
      )
    ) {
      return;
    }
    const previous = this.settings.archivedTagPrefixes;
    const applied = [...previous, prefix];
    this.settings.archivedTagPrefixes = applied;
    await this.persistMutation(() => {
      if (this.settings.archivedTagPrefixes === applied)
        this.settings.archivedTagPrefixes = previous;
    });
  }

  async unarchiveGroup(groupId: string): Promise<void> {
    const configured = this.settings.tagGroups.find((candidate) => candidate.id === groupId);
    if (configured !== undefined) {
      if (configured.archived !== true) return;
      configured.archived = false;
      await this.persistMutation(() => {
        if (configured.archived === false) configured.archived = true;
      });
      return;
    }
    const prefix = prefixForDiscoveredGroupId(groupId);
    if (prefix === undefined) return;
    const previous = this.settings.archivedTagPrefixes;
    const applied = previous.filter((candidate) => normalizeTagPrefix(candidate) !== prefix);
    if (applied.length === previous.length) return;
    this.settings.archivedTagPrefixes = applied;
    await this.persistMutation(() => {
      if (this.settings.archivedTagPrefixes === applied)
        this.settings.archivedTagPrefixes = previous;
    });
  }

  async updateGroup(group: EffectiveTagGroup, update: TagGroupUpdate): Promise<void> {
    const previousGroups = this.settings.tagGroups;
    const existing = previousGroups.find((candidate) => candidate.id === group.id);
    const target = existing ?? tagGroupFromEffective(group);
    const previous = snapshotTagGroup(target);
    applyTagGroupUpdate(target, update);
    const promoted = existing === undefined;
    const appliedGroups = promoted ? [...previousGroups, target] : previousGroups;
    if (promoted) this.settings.tagGroups = appliedGroups;
    await this.persistMutation(() => {
      if (promoted) {
        if (this.settings.tagGroups === appliedGroups) this.settings.tagGroups = previousGroups;
        return;
      }
      rollbackTagGroupUpdate(target, update, previous);
    });
  }

  async reorderGroups(
    draggedId: string,
    targetId: string,
    effective: readonly EffectiveTagGroup[],
  ): Promise<void> {
    if (draggedId === targetId) return;
    const from = effective.findIndex((group) => group.id === draggedId);
    const to = effective.findIndex((group) => group.id === targetId);
    if (from < 0 || to < 0) return;
    const previous = this.settings.tagGroups;
    const desired = [...effective];
    const [dragged] = desired.splice(from, 1);
    if (dragged === undefined) return;
    desired.splice(to, 0, dragged);

    const configuredIds = new Set(previous.map((group) => group.id));
    let persistedEnd = desired.findIndex((group) => group.id === draggedId);
    for (let index = 0; index < desired.length; index++) {
      const group = desired[index];
      if (group !== undefined && configuredIds.has(group.id)) {
        persistedEnd = Math.max(persistedEnd, index);
      }
    }
    const persistedIds = new Set(desired.slice(0, persistedEnd + 1).map((group) => group.id));
    const next = [
      ...desired.slice(0, persistedEnd + 1).map((group) => ({
        id: group.id,
        name: group.name,
        mode: group.mode,
        ...(group.color === undefined ? {} : { color: group.color }),
        ...(group.prefix === undefined ? {} : { prefix: group.prefix }),
        ...(group.tags === undefined ? {} : { tags: [...group.tags] }),
      })),
      ...previous.filter((group) => !persistedIds.has(group.id)),
    ];
    this.settings.tagGroups = next;
    await this.persistMutation(() => {
      if (this.settings.tagGroups === next) this.settings.tagGroups = previous;
    });
  }

  async renameTagExact(oldTag: string, newTag: string): Promise<VaultTagRenameResult> {
    return this.enqueueRename(() => this.renameAcrossVault(oldTag, newTag, 'exact'));
  }

  async renameTagPrefix(oldPrefix: string, newPrefix: string): Promise<VaultTagRenameResult> {
    return this.enqueueRename(() => this.renameAcrossVault(oldPrefix, newPrefix, 'prefix'));
  }

  private enqueueRename(
    operation: () => Promise<VaultTagRenameResult>,
  ): Promise<VaultTagRenameResult> {
    const result = this.renameQueue.then(operation, operation);
    this.renameQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private persistSettings(): Promise<void> {
    beginSettingsSave(this.settings);
    return this.saveSettings();
  }

  private async persistMutation(rollback: () => void): Promise<void> {
    let saveRevision = latestSettingsSaveRevision(this.settings);
    try {
      const pendingSave = this.persistSettings();
      saveRevision = latestSettingsSaveRevision(this.settings);
      await pendingSave;
    } catch (error) {
      if (latestSettingsSaveRevision(this.settings) === saveRevision) rollback();
      throw error;
    }
  }

  private async prepareVaultRenames(
    oldTag: string,
    newTag: string,
    scope: TagRenameScope,
  ): Promise<{ readonly prepared: PreparedTagRename[]; readonly failedFiles: string[] }> {
    const prepared: PreparedTagRename[] = [];
    const failedFiles: string[] = [];
    for (const file of this.app.vault.getMarkdownFiles()) {
      try {
        const content = await this.app.vault.cachedRead(file);
        const transform = (latest: string): string =>
          transformMarkdownTags(latest, oldTag, newTag, scope);
        if (transform(content) !== content) prepared.push({ file, transform });
      } catch {
        failedFiles.push(file.path);
      }
    }
    return { prepared, failedFiles };
  }

  private async applyVaultRenames(
    prepared: readonly PreparedTagRename[],
    failedFiles: string[],
  ): Promise<string[]> {
    const changedFiles: string[] = [];
    for (const { file, transform } of prepared) {
      try {
        const changeState = { changed: false };
        await this.app.vault.process(file, (content) => {
          const updated = transform(content);
          changeState.changed = updated !== content;
          return updated;
        });
        if (changeState.changed) changedFiles.push(file.path);
      } catch {
        failedFiles.push(file.path);
      }
    }
    return changedFiles;
  }

  private async persistRenameSettings(
    settingsUpdate: SettingsRenameUpdate,
    files: TagRenameFilesResult,
  ): Promise<VaultTagRenameResult | undefined> {
    if (!settingsUpdate.changed) return undefined;
    let saveRevision = latestSettingsSaveRevision(this.settings);
    try {
      const pendingSave = this.persistSettings();
      saveRevision = latestSettingsSaveRevision(this.settings);
      await pendingSave;
      return undefined;
    } catch {
      if (latestSettingsSaveRevision(this.settings) === saveRevision) settingsUpdate.rollback();
      return { type: 'settings-error', ...files };
    }
  }

  private async renameAcrossVault(
    oldValue: string,
    newValue: string,
    scope: TagRenameScope,
  ): Promise<VaultTagRenameResult> {
    const oldTag = normalizeTag(oldValue);
    const newTag = normalizeTag(newValue);
    if (oldTag === null || newTag === null) return { type: 'invalid', reason: 'invalid-tag' };
    if (oldTag === newTag) return { type: 'invalid', reason: 'same-tag' };

    const preparation = await this.prepareVaultRenames(oldTag, newTag, scope);
    const { failedFiles } = preparation;
    const changedFiles = await this.applyVaultRenames(preparation.prepared, failedFiles);

    const settingsUpdate = updateTagSettings(this.settings, oldTag, newTag, scope);
    const settingsError = await this.persistRenameSettings(settingsUpdate, {
      changedFiles,
      failedFiles,
    });
    if (settingsError !== undefined) return settingsError;

    this.rebaseSelectedLists(oldTag, newTag, scope);

    return failedFiles.length > 0
      ? { type: 'partial', changedFiles, failedFiles }
      : { type: 'ok', changedFiles };
  }

  private rebaseSelectedLists(oldTag: string, newTag: string, scope: TagRenameScope): void {
    const rename = { oldTag, newTag, scope };
    for (const state of this.selectedListStates) {
      const selected = state.getSelectedList();
      if (typeof selected === 'string') continue;
      if (selected.type === 'tag') {
        rebaseTagSelection(state, selected, rename);
      } else if (selected.type === 'group') {
        if (this.settings.tagGroups.some((group) => group.id === selected.groupId)) continue;
        rebaseDiscoveredGroupSelection(state, selected, rename);
      }
    }
  }
}
