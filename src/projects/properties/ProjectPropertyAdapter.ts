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

const DATE = /^\d{4}-\d{2}-\d{2}$/u;
const DATETIME = /^\d{4}-\d{2}-\d{2}[T ]/u;

function titleCase(id: string): string {
  return id.replace(/[-_]/gu, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

/** Public, Bases-optional adapter. It never imports Obsidian internals or normalizes unknown values. */
export class ProjectPropertyAdapter {
  describe(id: string, value: unknown, bases?: PublicBasesDescriptor): ProjectPropertyDescriptor {
    if (bases?.id === id) {
      return {
        id,
        displayName: bases.displayName ?? titleCase(id),
        kind: bases.kind ?? this.infer(value),
        writable: bases.writable ?? this.infer(value) !== 'unsupported',
      };
    }
    const kind = this.infer(value);
    return { id, displayName: titleCase(id), kind, writable: kind !== 'unsupported' };
  }

  describeAll(
    frontmatter: Readonly<Record<string, unknown>>,
  ): readonly ProjectPropertyDescriptor[] {
    return Object.keys(frontmatter)
      .sort((left, right) => left.localeCompare(right))
      .map((id) => this.describe(id, frontmatter[id]));
  }

  display(value: unknown): string {
    if (value === undefined || value === null) return '';
    if (Array.isArray(value)) return value.map((entry) => this.display(entry)).join(', ');
    return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
      ? String(value)
      : '';
  }

  private infer(value: unknown): ProjectPropertyKind {
    if (typeof value === 'number') return 'number';
    if (typeof value === 'boolean') return 'checkbox';
    if (Array.isArray(value)) {
      if (!value.every((entry) => typeof entry === 'string')) return 'unsupported';
      return value.every((entry) => entry.startsWith('#')) ? 'tags' : 'list';
    }
    if (typeof value === 'string') {
      if (DATETIME.test(value)) return 'datetime';
      if (DATE.test(value)) return 'date';
      if (/^\[\[.+\]\]$/u.test(value)) return 'link';
      return 'text';
    }
    return value === undefined || value === null ? 'text' : 'unsupported';
  }
}
