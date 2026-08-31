import { parseProjectDate } from '../projectDates';

export type ProjectPropertyKind =
  | 'text'
  | 'number'
  | 'checkbox'
  | 'date'
  | 'datetime'
  | 'list'
  | 'tags'
  | 'link'
  | 'unsupported';

export interface ProjectPropertyDescriptor {
  readonly id: string;
  readonly displayName: string;
  readonly kind: ProjectPropertyKind;
  readonly writable: boolean;
}

export interface ProjectPropertyWrite {
  readonly path: string;
  readonly propertyId: string;
  readonly expected: unknown;
  readonly next: unknown;
}

export interface PublicBasesDescriptor {
  readonly id: string;
  readonly displayName?: string;
  readonly kind?: ProjectPropertyKind;
  readonly writable?: boolean;
}

export type ProjectPropertyEditorValue =
  | { readonly type: 'value'; readonly value: string | number | boolean | readonly string[] | null }
  | { readonly type: 'invalid' };

const DATE = /^\d{4}-\d{2}-\d{2}$/u;
const DATETIME = /^\d{4}-\d{2}-\d{2}[T ]/u;
const WIKILINK = /^\[\[[^\]]+\]\]$/u;
const OWNED_PROJECT_PROPERTIES = new Set(['status', 'priority', 'start', 'end']);

function titleCase(id: string): string {
  return id.replace(/[-_]/gu, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function isOwnedProjectProperty(id: string): boolean {
  return OWNED_PROJECT_PROPERTIES.has(id);
}

/**
 * Converts a safe editor carrier back into its frontmatter value. The conversion
 * is deliberately narrow: malformed values are rejected before a writer sees them.
 */
export function parseProjectPropertyEditorValue(
  descriptor: ProjectPropertyDescriptor,
  raw: string,
  checked?: boolean,
): ProjectPropertyEditorValue {
  if (descriptor.kind === 'checkbox') return { type: 'value', value: checked === true };
  if (raw.trim() === '') return { type: 'value', value: null };
  if (descriptor.kind === 'number') {
    const value = Number(raw);
    return Number.isFinite(value) ? { type: 'value', value } : { type: 'invalid' };
  }
  if (descriptor.kind === 'list') {
    return {
      type: 'value',
      value: raw
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean),
    };
  }
  if (descriptor.kind === 'tags') {
    return {
      type: 'value',
      value: raw
        .split(',')
        .map((value) => value.trim().replace(/^#/u, ''))
        .filter(Boolean),
    };
  }
  if (descriptor.kind === 'link')
    return WIKILINK.test(raw.trim()) ? { type: 'value', value: raw.trim() } : { type: 'invalid' };
  if (descriptor.kind === 'date') {
    return DATE.test(raw) && parseProjectDate(raw)?.precision === 'date'
      ? { type: 'value', value: raw }
      : { type: 'invalid' };
  }
  if (descriptor.kind === 'datetime') {
    const value = raw.length === 16 ? `${raw}:00Z` : raw;
    return DATETIME.test(value) && parseProjectDate(value)?.precision === 'datetime'
      ? { type: 'value', value }
      : { type: 'invalid' };
  }
  return descriptor.kind === 'text' ? { type: 'value', value: raw } : { type: 'invalid' };
}

/** Formats storage values for native inputs without changing the stored carrier. */
export function projectPropertyEditorValue(
  descriptor: ProjectPropertyDescriptor,
  value: unknown,
): string {
  if (value === undefined || value === null) return '';
  if (descriptor.kind === 'list' || descriptor.kind === 'tags') {
    return Array.isArray(value) ? value.map(String).join(', ') : '';
  }
  if (descriptor.kind === 'datetime' && typeof value === 'string') return value.slice(0, 16);
  return typeof value === 'string' || typeof value === 'number' ? String(value) : '';
}

/** Public, Bases-optional adapter. It never imports Obsidian internals or normalizes unknown values. */
export class ProjectPropertyAdapter {
  describe(id: string, value: unknown, bases?: PublicBasesDescriptor): ProjectPropertyDescriptor {
    if (bases?.id === id) {
      return {
        id,
        displayName: bases.displayName ?? titleCase(id),
        kind: bases.kind ?? this.infer(id, value),
        writable: bases.writable ?? this.infer(id, value) !== 'unsupported',
      };
    }
    const kind = this.infer(id, value);
    return { id, displayName: titleCase(id), kind, writable: kind !== 'unsupported' };
  }

  describeAll(
    frontmatter: Readonly<Record<string, unknown>>,
    bases: readonly PublicBasesDescriptor[] = [],
  ): readonly ProjectPropertyDescriptor[] {
    const byId = new Map(bases.map((descriptor) => [descriptor.id, descriptor]));
    return [...new Set([...Object.keys(frontmatter), ...byId.keys()])]
      .sort((left, right) => left.localeCompare(right))
      .map((id) => this.describe(id, frontmatter[id], byId.get(id)));
  }

  display(value: unknown): string {
    if (value === undefined || value === null) return '';
    if (Array.isArray(value)) return value.map((entry) => this.display(entry)).join(', ');
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      return String(value);
    }
    try {
      return JSON.stringify(value) ?? '[Unsupported value]';
    } catch {
      return '[Unserializable value]';
    }
  }

  private infer(id: string, value: unknown): ProjectPropertyKind {
    if (typeof value === 'number') return 'number';
    if (typeof value === 'boolean') return 'checkbox';
    if (Array.isArray(value)) {
      if (!value.every((entry) => typeof entry === 'string')) return 'unsupported';
      return id === 'tags' || value.every((entry) => entry.startsWith('#')) ? 'tags' : 'list';
    }
    if (typeof value === 'string') {
      if (DATETIME.test(value)) return 'datetime';
      if (DATE.test(value)) return 'date';
      if (WIKILINK.test(value)) return 'link';
      return 'text';
    }
    return value === undefined || value === null ? 'text' : 'unsupported';
  }
}
