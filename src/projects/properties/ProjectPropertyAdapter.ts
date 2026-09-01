import type { ProjectStatus } from '../../settings/types';
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
const ATOM_DATETIME_PARTS =
  /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/u;
const LOCAL_DATETIME_PARTS = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})(?::(\d{2})(?:\.(\d+))?)?$/u;
const WIKILINK = /^\[\[[^\]]+\]\]$/u;
const OWNED_PROJECT_PROPERTIES = new Set([
  'status',
  'tags',
  'priority',
  'start',
  'end',
  'description',
  'comments',
]);

function titleCase(id: string): string {
  return id.replace(/[-_]/gu, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function trimFraction(fraction: string | undefined): string | undefined {
  if (!fraction) return undefined;
  const limited = fraction.slice(0, 3);
  let end = limited.length;
  while (end > 0 && limited[end - 1] === '0') end -= 1;
  return limited.slice(0, end) || undefined;
}

function fractionSuffix(fraction: string | undefined, maxLength?: number): string {
  if (!fraction) return '';
  const displayed = maxLength === undefined ? fraction : trimFraction(fraction);
  return displayed ? `.${displayed}` : '';
}

function atomEditorLocal(parts: RegExpExecArray): string {
  return `${parts[1]}:${parts[2]}${fractionSuffix(parts[3], 3)}`;
}

function parseDateTimeEditorValue(raw: string, observed: unknown): ProjectPropertyEditorValue {
  const local = raw.trim();
  const localParts = LOCAL_DATETIME_PARTS.exec(local);
  if (!localParts) return { type: 'invalid' };
  const observedRaw = typeof observed === 'string' ? observed : undefined;
  const observedParts =
    observedRaw && parseProjectDate(observedRaw)?.precision === 'datetime'
      ? ATOM_DATETIME_PARTS.exec(observedRaw)
      : null;
  const observedEditorLocal = observedParts ? atomEditorLocal(observedParts) : undefined;
  const localSeconds = localParts[2] ? `:${localParts[2]}` : '';
  const normalizedLocal = `${localParts[1]}${localSeconds}${fractionSuffix(localParts[3], 3)}`;
  if (observedParts && observedRaw !== undefined && normalizedLocal === observedEditorLocal) {
    return { type: 'value', value: observedRaw };
  }
  const seconds = localParts[2] ?? observedParts?.[2] ?? '00';
  const visibleFraction = trimFraction(localParts[3]);
  const observedVisibleFraction = trimFraction(observedParts?.[3]);
  const fraction =
    observedParts?.[3] && visibleFraction === observedVisibleFraction
      ? observedParts[3]
      : visibleFraction;
  const value = `${localParts[1]}:${seconds}${fractionSuffix(fraction)}${observedParts?.[4] ?? 'Z'}`;
  return DATETIME.test(value) && parseProjectDate(value)?.precision === 'datetime'
    ? { type: 'value', value }
    : { type: 'invalid' };
}

export function isOwnedProjectProperty(
  id: string,
  statuses: readonly ProjectStatus[] = [],
): boolean {
  return (
    OWNED_PROJECT_PROPERTIES.has(id) ||
    statuses.some((status) => status.match.kind === 'property' && status.match.property === id)
  );
}

/**
 * Converts a safe editor carrier back into its frontmatter value. The conversion
 * is deliberately narrow: malformed values are rejected before a writer sees them.
 */
export function parseProjectPropertyEditorValue(
  descriptor: ProjectPropertyDescriptor,
  raw: string,
  checked?: boolean,
  observed?: unknown,
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
  if (descriptor.kind === 'datetime') return parseDateTimeEditorValue(raw, observed);
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
  if (descriptor.kind === 'datetime' && typeof value === 'string') {
    const parts = ATOM_DATETIME_PARTS.exec(value);
    return parts ? atomEditorLocal(parts) : value.slice(0, 16);
  }
  return typeof value === 'string' || typeof value === 'number' ? String(value) : '';
}

/** Public, Bases-optional adapter. It never imports Obsidian internals or normalizes unknown values. */
export class ProjectPropertyAdapter {
  constructor(private readonly statuses: readonly ProjectStatus[] = []) {}

  describe(id: string, value: unknown, bases?: PublicBasesDescriptor): ProjectPropertyDescriptor {
    if (bases?.id === id) {
      return {
        id,
        displayName: bases.displayName ?? titleCase(id),
        kind: bases.kind ?? this.infer(id, value),
        writable:
          !isOwnedProjectProperty(id, this.statuses) &&
          (bases.writable ?? this.infer(id, value) !== 'unsupported'),
      };
    }
    const kind = this.infer(id, value);
    return {
      id,
      displayName: titleCase(id),
      kind,
      writable: !isOwnedProjectProperty(id, this.statuses) && kind !== 'unsupported',
    };
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
