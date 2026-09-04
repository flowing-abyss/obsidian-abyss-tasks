// src/tags/TagManager.ts
import type { App, TFile } from 'obsidian';
import type { ListSelection } from '../app/AppState';
import { beginSettingsSave, latestSettingsSaveRevision } from '../settings/settingsSaveRevision';
import type { CalendarSettings } from '../settings/types';
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

function updateTagGroups(
  settings: CalendarSettings,
  replace: (value: string) => string,
  scope: TagRenameScope,
  rollbacks: Array<() => void>,
): void {
  for (const group of settings.tagGroups) {
    if (updateManualTagGroup(group, replace, rollbacks)) continue;
    updatePrefixTagGroup(group, replace, scope, rollbacks);
  }
}

type TagGroup = CalendarSettings['tagGroups'][number];

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
  replace: (value: string) => string,
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
  const updated = replace(`#${previous}`).slice(1);
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
    replaceSettingTag(value, oldTag, newTag, scope);
  const rollbacks: Array<() => void> = [];
  const applyPinnedTags = (values: string[]): void => {
    settings.pinnedTags = values;
  };
  const applyArchivedTags = (values: string[]): void => {
    settings.archivedTags = values;
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
  updateTagGroups(settings, replaceReference, scope, rollbacks);

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
    this.settings.pinnedTags.push(tag);
    await this.persistSettings();
  }

  async unpinTag(tag: string): Promise<void> {
    const idx = this.settings.pinnedTags.indexOf(tag);
    if (idx < 0) return;
    this.settings.pinnedTags.splice(idx, 1);
    await this.persistSettings();
  }

  async archiveTag(tag: string): Promise<void> {
    if (this.settings.archivedTags.includes(tag)) return;
    this.settings.archivedTags.push(tag);
    // also unpin
    const pi = this.settings.pinnedTags.indexOf(tag);
    if (pi >= 0) this.settings.pinnedTags.splice(pi, 1);
    await this.persistSettings();
  }

  async unarchiveTag(tag: string): Promise<void> {
    const idx = this.settings.archivedTags.indexOf(tag);
    if (idx < 0) return;
    this.settings.archivedTags.splice(idx, 1);
    await this.persistSettings();
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
    for (const state of this.selectedListStates) {
      const selected = state.getSelectedList();
      if (typeof selected !== 'object' || selected.type !== 'tag') continue;
      const tag = replaceSettingTag(selected.tag, oldTag, newTag, scope);
      if (tag !== selected.tag) state.setSelectedList({ type: 'tag', tag });
    }
  }
}
