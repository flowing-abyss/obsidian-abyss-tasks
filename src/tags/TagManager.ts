// src/tags/TagManager.ts
import type { App } from 'obsidian';
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

function updateTagSettings(
  settings: CalendarSettings,
  oldTag: string,
  newTag: string,
  scope: TagRenameScope,
): SettingsRenameUpdate {
  const replaceReference = (value: string): string =>
    replaceSettingTag(value, oldTag, newTag, scope);
  const rollbacks: Array<() => void> = [];
  const updateList = (
    current: readonly string[],
    apply: (values: string[]) => void,
    latest: () => readonly string[],
  ): void => {
    const updated = uniqueInOrder(current.map(replaceReference));
    if (sameValues(updated, current)) return;
    const applied = [...updated];
    apply(updated);
    rollbacks.push(() => {
      if (sameValues(latest(), applied)) apply([...current]);
    });
  };
  const applyPinnedTags = (values: string[]): void => {
    settings.pinnedTags = values;
  };
  const applyArchivedTags = (values: string[]): void => {
    settings.archivedTags = values;
  };

  updateList(settings.pinnedTags, applyPinnedTags, () => settings.pinnedTags);
  updateList(settings.archivedTags, applyArchivedTags, () => settings.archivedTags);
  for (const group of settings.tagGroups) {
    if (group.mode === 'manual' && group.tags) {
      const previous = group.tags;
      const updated = uniqueInOrder(previous.map(replaceReference));
      if (sameValues(updated, previous)) continue;
      const applied = [...updated];
      group.tags = updated;
      rollbacks.push(() => {
        if (group.tags && sameValues(group.tags, applied)) group.tags = previous;
      });
    } else if (scope === 'prefix' && group.mode === 'prefix' && group.prefix) {
      const previous = group.prefix;
      const updated = replaceReference(`#${previous}`).slice(1);
      if (updated === previous) continue;
      group.prefix = updated;
      rollbacks.push(() => {
        if (group.prefix === updated) group.prefix = previous;
      });
    }
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

  constructor(
    private app: App,
    private settings: CalendarSettings,
    private saveSettings: () => Promise<void>,
  ) {}

  /**
   * Zero-friction manual tag: creates a manual TagGroup holding one tag derived
   * from the name. Nested/prefix tags remain a settings-time configuration.
   */
  async createManualGroup(name: string): Promise<void> {
    const label = name.trim();
    if (!label) return;
    const slug = label
      .toLowerCase()
      .replace(/\s+/g, '-')
      .replace(/[^\w/-]/g, '');
    if (!slug) return;
    const tag = slug.startsWith('#') ? slug : `#${slug}`;
    // Collision-proof id (length-based ids repeat after add/delete cycles).
    const base = `group-${slug || 'tag'}`;
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

  private async renameAcrossVault(
    oldValue: string,
    newValue: string,
    scope: TagRenameScope,
  ): Promise<VaultTagRenameResult> {
    const oldTag = normalizeTag(oldValue);
    const newTag = normalizeTag(newValue);
    if (!oldTag || !newTag) return { type: 'invalid', reason: 'invalid-tag' };
    if (oldTag === newTag) return { type: 'invalid', reason: 'same-tag' };

    const files = this.app.vault.getMarkdownFiles();
    const prepared: Array<{
      readonly file: (typeof files)[number];
      readonly transform: (content: string) => string;
    }> = [];
    const failedFiles: string[] = [];

    for (const file of files) {
      try {
        const content = await this.app.vault.cachedRead(file);
        const transform = (latest: string): string =>
          transformMarkdownTags(latest, oldTag, newTag, scope);
        if (transform(content) !== content) prepared.push({ file, transform });
      } catch {
        failedFiles.push(file.path);
      }
    }

    const changedFiles: string[] = [];
    for (const { file, transform } of prepared) {
      try {
        let changed = false;
        await this.app.vault.process(file, (content) => {
          const updated = transform(content);
          changed = updated !== content;
          return updated;
        });
        if (changed) changedFiles.push(file.path);
      } catch {
        failedFiles.push(file.path);
      }
    }

    const settingsUpdate = updateTagSettings(this.settings, oldTag, newTag, scope);

    if (settingsUpdate.changed) {
      let saveRevision = latestSettingsSaveRevision(this.settings);
      try {
        const pendingSave = this.persistSettings();
        saveRevision = latestSettingsSaveRevision(this.settings);
        await pendingSave;
      } catch {
        if (latestSettingsSaveRevision(this.settings) === saveRevision) {
          settingsUpdate.rollback();
        }
        return { type: 'settings-error', changedFiles, failedFiles };
      }
    }

    return failedFiles.length > 0
      ? { type: 'partial', changedFiles, failedFiles }
      : { type: 'ok', changedFiles };
  }
}
