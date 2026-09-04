import type { TaskRef } from '../../domain/types';
import { TaskRefAuthority } from '../TaskRefAuthority';
import type { TaskRootBlock } from './TaskBlockEditor';

type LocateResult =
  | { readonly type: 'exact'; readonly block: TaskRootBlock }
  | { readonly type: 'conflict'; readonly block: TaskRootBlock }
  | { readonly type: 'not-found' }
  | { readonly type: 'ambiguous'; readonly blocks: readonly TaskRootBlock[] };

function defaultFingerprint(source: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < source.length; index++) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

export class TaskLocator {
  private readonly authority: TaskRefAuthority | undefined;
  private readonly fingerprint: (source: string) => string;

  constructor(authorityOrFingerprint?: TaskRefAuthority | ((source: string) => string)) {
    this.authority =
      authorityOrFingerprint instanceof TaskRefAuthority ? authorityOrFingerprint : undefined;
    this.fingerprint =
      typeof authorityOrFingerprint === 'function' ? authorityOrFingerprint : defaultFingerprint;
  }

  revision(source: string): string {
    if (this.authority != null) return this.authority.revision(source);
    return `block:${this.fingerprint(source)}:${JSON.stringify(source)}`;
  }

  exactSource(revision: string): string | undefined {
    if (this.authority != null) return this.authority.evidence(revision)?.source;
    if (!revision.startsWith('block:')) return undefined;
    const payload = revision.slice('block:'.length);
    const separator = payload.indexOf(':');
    const encoded = separator >= 0 ? payload.slice(separator + 1) : payload;
    try {
      const source = JSON.parse(encoded) as unknown;
      return typeof source === 'string' ? source : undefined;
    } catch {
      return undefined;
    }
  }

  locate(blocks: readonly TaskRootBlock[], ref: TaskRef): LocateResult {
    const expected = this.exactSource(ref.revision);
    const hinted = blocks.find((block) => block.line === ref.line);
    const exact = expected === undefined ? [] : blocks.filter((block) => block.source === expected);
    if (exact.length > 1) return { type: 'ambiguous', blocks: exact };
    if (expected !== undefined && hinted?.source === expected)
      return { type: 'exact', block: hinted };
    const exactBlock = exact[0];
    if (exact.length === 1 && exactBlock !== undefined) return { type: 'exact', block: exactBlock };
    if (hinted != null) return { type: 'conflict', block: hinted };
    return { type: 'not-found' };
  }
}
