import { TFile, type App } from 'obsidian';
import type { ProjectPropertyWrite } from './ProjectPropertyAdapter';

export type ProjectPropertyWriteResult =
  | { readonly type: 'ok'; readonly value: unknown }
  | { readonly type: 'unchanged' }
  | { readonly type: 'conflict'; readonly current: unknown }
  | { readonly type: 'invalid'; readonly field: 'path' | 'property' }
  | { readonly type: 'io-error' };

class AbortWrite extends Error {
  constructor(readonly result: ProjectPropertyWriteResult) {
    super('Project property write aborted');
  }
}

function sameValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
}

/** Guarded public `processFrontMatter` writer for fields not owned by a specialised command. */
export class ProjectPropertyCommands {
  constructor(private readonly app: App) {}

  async write(write: ProjectPropertyWrite): Promise<ProjectPropertyWriteResult> {
    if (!write.propertyId || write.propertyId === '__proto__' || write.propertyId === 'constructor')
      return { type: 'invalid', field: 'property' };
    const file = this.app.vault.getAbstractFileByPath(write.path);
    if (!(file instanceof TFile)) return { type: 'invalid', field: 'path' };
    try {
      await this.app.fileManager.processFrontMatter(
        file,
        (frontmatter: Record<string, unknown>) => {
          const current = frontmatter[write.propertyId];
          if (!sameValue(current, write.expected))
            throw new AbortWrite({ type: 'conflict', current });
          if (sameValue(current, write.next)) throw new AbortWrite({ type: 'unchanged' });
          if (write.next === undefined || write.next === null) delete frontmatter[write.propertyId];
          else frontmatter[write.propertyId] = write.next;
        },
      );
      return { type: 'ok', value: write.next };
    } catch (error) {
      if (error instanceof AbortWrite) return error.result;
      return { type: 'io-error' };
    }
  }
}
