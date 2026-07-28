// src/tags/TagManager.ts
import type { App } from 'obsidian';
import type { CalendarSettings } from '../settings/types';

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
      readonly type: 'invalid';
      readonly reason: 'invalid-tag' | 'same-tag';
    };

type RenameScope = 'exact' | 'prefix';

const VALID_TAG = /^#[\w-]+(?:\/[\w-]+)*$/u;

function normalizeTag(value: string): string | null {
  const trimmed = value.trim();
  const tag = trimmed.startsWith('#') ? trimmed : `#${trimmed}`;
  return VALID_TAG.test(tag) ? tag : null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function replacementPattern(tag: string, scope: RenameScope): RegExp {
  const suffix = scope === 'exact' ? '(?![\\w/-])' : '(?=/|[^\\w/-]|$)';
  return new RegExp(`(?<!#)${escapeRegExp(tag)}${suffix}`, 'gu');
}

function replaceSettingTag(
  value: string,
  oldTag: string,
  newTag: string,
  scope: RenameScope,
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

export class TagManager {
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
    await this.saveSettings();
  }

  async pinTag(tag: string): Promise<void> {
    if (this.settings.pinnedTags.includes(tag)) return;
    this.settings.pinnedTags.push(tag);
    await this.saveSettings();
  }

  async unpinTag(tag: string): Promise<void> {
    const idx = this.settings.pinnedTags.indexOf(tag);
    if (idx < 0) return;
    this.settings.pinnedTags.splice(idx, 1);
    await this.saveSettings();
  }

  async archiveTag(tag: string): Promise<void> {
    if (this.settings.archivedTags.includes(tag)) return;
    this.settings.archivedTags.push(tag);
    // also unpin
    const pi = this.settings.pinnedTags.indexOf(tag);
    if (pi >= 0) this.settings.pinnedTags.splice(pi, 1);
    await this.saveSettings();
  }

  async unarchiveTag(tag: string): Promise<void> {
    const idx = this.settings.archivedTags.indexOf(tag);
    if (idx < 0) return;
    this.settings.archivedTags.splice(idx, 1);
    await this.saveSettings();
  }

  async renameTagExact(oldTag: string, newTag: string): Promise<VaultTagRenameResult> {
    return this.renameAcrossVault(oldTag, newTag, 'exact');
  }

  async renameTagPrefix(oldPrefix: string, newPrefix: string): Promise<VaultTagRenameResult> {
    return this.renameAcrossVault(oldPrefix, newPrefix, 'prefix');
  }

  private async renameAcrossVault(
    oldValue: string,
    newValue: string,
    scope: RenameScope,
  ): Promise<VaultTagRenameResult> {
    const oldTag = normalizeTag(oldValue);
    const newTag = normalizeTag(newValue);
    if (!oldTag || !newTag) return { type: 'invalid', reason: 'invalid-tag' };
    if (oldTag === newTag) return { type: 'invalid', reason: 'same-tag' };

    const files = this.app.vault.getMarkdownFiles();
    const pattern = replacementPattern(oldTag, scope);
    const prepared: Array<{
      readonly file: (typeof files)[number];
      readonly transform: (content: string) => string;
    }> = [];
    const failedFiles: string[] = [];

    for (const file of files) {
      try {
        const content = await this.app.vault.cachedRead(file);
        const transform = (latest: string): string => latest.replace(pattern, newTag);
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

    const replaceReference = (value: string): string =>
      replaceSettingTag(value, oldTag, newTag, scope);
    let settingsChanged = false;
    const pinnedTags = uniqueInOrder(this.settings.pinnedTags.map(replaceReference));
    if (!sameValues(pinnedTags, this.settings.pinnedTags)) {
      this.settings.pinnedTags = pinnedTags;
      settingsChanged = true;
    }
    const archivedTags = uniqueInOrder(this.settings.archivedTags.map(replaceReference));
    if (!sameValues(archivedTags, this.settings.archivedTags)) {
      this.settings.archivedTags = archivedTags;
      settingsChanged = true;
    }
    for (const g of this.settings.tagGroups) {
      if (g.mode === 'manual' && g.tags) {
        const tags = uniqueInOrder(g.tags.map(replaceReference));
        if (!sameValues(tags, g.tags)) {
          g.tags = tags;
          settingsChanged = true;
        }
      } else if (scope === 'prefix' && g.mode === 'prefix' && g.prefix) {
        const prefixTag = replaceReference(`#${g.prefix}`);
        const prefix = prefixTag.slice(1);
        if (prefix !== g.prefix) {
          g.prefix = prefix;
          settingsChanged = true;
        }
      }
    }

    if (settingsChanged) await this.saveSettings();

    return failedFiles.length > 0
      ? { type: 'partial', changedFiles, failedFiles }
      : { type: 'ok', changedFiles };
  }
}
