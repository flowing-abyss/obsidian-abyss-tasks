import { normalizePath, TFile, type App } from 'obsidian';
import { computeWorkNotePresetFingerprint, isAuditAccepted } from './compatibility';
import type {
  RelationWriteCommand,
  WorkNoteAuditResult,
  WorkNoteCommandResult,
  WorkNoteCompatibilityPreset,
  WorkNoteRelationCommands,
  WorkNoteSnapshot,
} from './types';
import type { WorkNoteIndex } from './WorkNoteIndex';

type PresetProvider = WorkNoteCompatibilityPreset | (() => WorkNoteCompatibilityPreset);
type RelationField = 'milestone' | 'blockedBy' | 'related';
type RelationOperation = 'set' | 'add' | 'remove';

export interface WorkNoteRelationAuthority {
  /** Settles the application workspace before a queued relation transaction audits it. */
  refresh(): Promise<void>;
}

const vaultTransactionTails = new WeakMap<App, Promise<void>>();

class AbortRelationWrite extends Error {
  constructor(readonly result: WorkNoteCommandResult) {
    super('Work Note relation command aborted');
  }
}

function sameRawValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
}

function isStringList(raw: unknown): raw is readonly string[] {
  return Array.isArray(raw) && raw.every((entry) => typeof entry === 'string');
}

function supportedCarrier(raw: unknown): raw is undefined | null | string | readonly string[] {
  return raw === undefined || raw === null || typeof raw === 'string' || isStringList(raw);
}

function wikiLink(path: string): string {
  return `[[${path.replace(/\.md$/u, '')}]]`;
}

function relationPath(app: App, entry: string, sourcePath: string): string | null {
  const match = /^!?\[\[([^\]]+)\]\]$/u.exec(entry.trim());
  const linkpath = match?.[1]?.split('|', 1)[0]?.split('#', 1)[0]?.trim();
  if (!linkpath) return null;
  return app.metadataCache.getFirstLinkpathDest(linkpath, sourcePath)?.path ?? null;
}

function reaches(
  notes: ReadonlyMap<string, WorkNoteSnapshot>,
  start: string,
  wanted: string,
  projectPath: string,
  seen = new Set<string>(),
): boolean {
  if (start === wanted) return true;
  if (seen.has(start)) return false;
  seen.add(start);
  const note = notes.get(start);
  if (!note || note.projectPath !== projectPath) return false;
  return note.blockedByPaths.some((path) => reaches(notes, path, wanted, projectPath, seen));
}

export class WorkNoteRelationCommandService implements WorkNoteRelationCommands {
  constructor(
    private readonly app: App,
    private readonly presetProvider: PresetProvider,
    private readonly index: WorkNoteIndex,
    private readonly authority?: WorkNoteRelationAuthority,
  ) {}

  setMilestone(command: RelationWriteCommand<string | null>): Promise<WorkNoteCommandResult> {
    return this.write('milestone', 'set', command);
  }

  clearMilestone(command: RelationWriteCommand<null>): Promise<WorkNoteCommandResult> {
    return this.write('milestone', 'set', command);
  }

  addRelated(command: RelationWriteCommand<string>): Promise<WorkNoteCommandResult> {
    return this.write('related', 'add', command);
  }

  removeRelated(command: RelationWriteCommand<string>): Promise<WorkNoteCommandResult> {
    return this.write('related', 'remove', command);
  }

  addBlockedBy(command: RelationWriteCommand<string>): Promise<WorkNoteCommandResult> {
    return this.write('blockedBy', 'add', command);
  }

  removeBlockedBy(command: RelationWriteCommand<string>): Promise<WorkNoteCommandResult> {
    return this.write('blockedBy', 'remove', command);
  }

  private preset(): WorkNoteCompatibilityPreset {
    return typeof this.presetProvider === 'function' ? this.presetProvider() : this.presetProvider;
  }

  private compatibility(command: RelationWriteCommand<unknown>): WorkNoteCommandResult | undefined {
    const preset = this.preset();
    if (!preset.enabled) return { type: 'compatibility-conflict', reason: 'preset-disabled' };
    if (command.expectedPresetRevision !== String(preset.revision)) {
      return { type: 'compatibility-conflict', reason: 'preset-revision-changed' };
    }
    if (command.expectedPresetFingerprint !== computeWorkNotePresetFingerprint(preset)) {
      return { type: 'compatibility-conflict', reason: 'preset-fingerprint-changed' };
    }
    if (!isAuditAccepted(preset)) {
      return { type: 'compatibility-conflict', reason: 'audit-not-accepted' };
    }
    if (preset.acceptedAudit?.capabilities.update !== true) {
      return { type: 'compatibility-conflict', reason: 'update-not-accepted' };
    }
    return undefined;
  }

  private sourceFromAudit(
    audit: WorkNoteAuditResult,
    command: RelationWriteCommand<unknown>,
  ): WorkNoteSnapshot | WorkNoteCommandResult {
    const source = audit.snapshots.find(({ path }) => path === command.notePath);
    if (source) return source;
    const diagnostics = audit.diagnosticsByPath[command.notePath] ?? [];
    if (
      diagnostics.some(({ type }) =>
        ['multiple-projects', 'ambiguous-project', 'invalid-project-entry'].includes(type),
      )
    ) {
      return { type: 'compatibility-conflict', reason: 'ambiguous-ownership' };
    }
    return { type: 'invalid', field: 'path', reason: 'missing-source' };
  }

  private validateTarget(
    field: RelationField,
    operation: RelationOperation,
    source: WorkNoteSnapshot,
    value: unknown,
    audit: WorkNoteAuditResult,
  ): WorkNoteCommandResult | undefined {
    if (value === null) return undefined;
    if (typeof value !== 'string') return { type: 'invalid', field, reason: 'invalid-target' };
    const targetPath = normalizePath(value);
    if (targetPath === source.path) return { type: 'invalid', field, reason: 'self' };
    const notes = new Map(audit.snapshots.map((note) => [note.path, note]));
    const target = notes.get(targetPath);
    if (!target) return { type: 'invalid', field, reason: 'missing-target' };
    if (target.projectPath !== source.projectPath) {
      return { type: 'invalid', field, reason: 'cross-project' };
    }
    if (field === 'milestone' && target.kind !== 'milestone') {
      return { type: 'invalid', field, reason: 'wrong-kind' };
    }
    if (
      field === 'blockedBy' &&
      operation === 'add' &&
      reaches(notes, targetPath, source.path, source.projectPath)
    ) {
      return { type: 'invalid', field, reason: 'cycle' };
    }
    return undefined;
  }

  private nextRaw(
    field: RelationField,
    operation: RelationOperation,
    raw: undefined | null | string | readonly string[],
    value: string | null,
    sourcePath: string,
  ): { readonly changed: boolean; readonly remove?: boolean; readonly value?: unknown } {
    if (field === 'milestone') {
      if (value === null) {
        if (isStringList(raw)) return { changed: raw.length > 0, value: [] };
        return { changed: raw !== undefined && raw !== null, remove: true };
      }
      const link = wikiLink(normalizePath(value));
      if (isStringList(raw)) {
        const same = raw.length === 1 && relationPath(this.app, raw[0] ?? '', sourcePath) === value;
        return { changed: !same, value: [link] };
      }
      const same = typeof raw === 'string' && relationPath(this.app, raw, sourcePath) === value;
      return { changed: !same, value: link };
    }

    const target = normalizePath(value ?? '');
    let entries: readonly string[] = [];
    if (isStringList(raw)) entries = raw;
    else if (typeof raw === 'string') entries = [raw];
    const matching = (entry: string) => relationPath(this.app, entry, sourcePath) === target;
    if (operation === 'add') {
      if (entries.some(matching)) return { changed: false, value: raw };
      const link = wikiLink(target);
      if (isStringList(raw)) return { changed: true, value: [...raw, link] };
      if (typeof raw === 'string') return { changed: true, value: [raw, link] };
      return { changed: true, value: link };
    }
    if (!entries.some(matching)) return { changed: false, value: raw };
    if (isStringList(raw)) {
      return { changed: true, value: raw.filter((entry) => !matching(entry)) };
    }
    return { changed: true, remove: true };
  }

  private async write(
    field: RelationField,
    operation: RelationOperation,
    command: RelationWriteCommand<string | null>,
  ): Promise<WorkNoteCommandResult> {
    return this.enqueue(() => this.writeInTransaction(field, operation, command));
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const previous = vaultTransactionTails.get(this.app) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    vaultTransactionTails.set(
      this.app,
      current.then(
        () => undefined,
        () => undefined,
      ),
    );
    return current;
  }

  private async writeInTransaction(
    field: RelationField,
    operation: RelationOperation,
    command: RelationWriteCommand<string | null>,
  ): Promise<WorkNoteCommandResult> {
    const blocked = this.compatibility(command);
    if (blocked) return blocked;
    try {
      await this.authority?.refresh();
      this.index.refresh();
      await this.index.flushPending();
    } catch {
      return { type: 'io-error' };
    }
    const preset = this.preset();
    const audit = await this.index.audit();
    const source = this.sourceFromAudit(audit, command);
    if ('type' in source) return source;
    const targetBlocked = this.validateTarget(field, operation, source, command.value, audit);
    if (targetBlocked) return targetBlocked;
    if (!supportedCarrier(command.expectedRaw)) {
      return { type: 'invalid', field, reason: 'unsupported-shape' };
    }
    if (
      field === 'milestone' &&
      isStringList(command.expectedRaw) &&
      command.expectedRaw.length > 1
    ) {
      return { type: 'invalid', field, reason: 'invalid-cardinality' };
    }
    const file = this.app.vault.getAbstractFileByPath(command.notePath);
    if (!(file instanceof TFile))
      return { type: 'invalid', field: 'path', reason: 'missing-source' };

    const property = preset.fields[field];
    const guardedProperties = new Set([
      preset.fields.project,
      preset.fields.milestone,
      preset.fields.blockedBy,
      preset.fields.related,
      'tags',
    ]);
    const cachedFrontmatter: Record<string, unknown> | undefined =
      this.app.metadataCache.getFileCache(file)?.frontmatter;
    const observedCarriers = new Map(
      [...guardedProperties].map((name) => [name, cachedFrontmatter?.[name]] as const),
    );
    try {
      let changed = false;
      await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
        const values = frontmatter as Record<string, unknown>;
        const transactionBlocked = this.compatibility(command);
        if (transactionBlocked) throw new AbortRelationWrite(transactionBlocked);
        for (const [name, observed] of observedCarriers) {
          if (!sameRawValue(values[name], observed)) {
            throw new AbortRelationWrite({
              type: 'conflict',
              field: name === preset.fields.project ? 'project' : field,
            });
          }
        }
        const current = values[property];
        if (!sameRawValue(current, command.expectedRaw)) {
          throw new AbortRelationWrite({ type: 'conflict', field });
        }
        if (!supportedCarrier(current)) {
          throw new AbortRelationWrite({ type: 'invalid', field, reason: 'unsupported-shape' });
        }
        if (field === 'milestone' && isStringList(current) && current.length > 1) {
          throw new AbortRelationWrite({ type: 'invalid', field, reason: 'invalid-cardinality' });
        }
        const next = this.nextRaw(field, operation, current, command.value, command.notePath);
        if (!next.changed) return;
        changed = true;
        if (next.remove) delete values[property];
        else values[property] = next.value;
      });
      if (!changed) return { type: 'unchanged', path: command.notePath };
      this.index.refresh();
      await this.index.flushPending();
      return { type: 'ok', path: command.notePath };
    } catch (error) {
      if (error instanceof AbortRelationWrite) return error.result;
      return { type: 'io-error' };
    }
  }
}
