import { getAllTags, type App, type EventRef } from 'obsidian';
import type { ProjectPropertyInfo, ProjectPropertyType } from './projectFields';
import { findFrontmatterProperty } from './projectFields';

export interface ProjectPropertyCatalog {
  list(): readonly ProjectPropertyInfo[] | null;
  inspect(property: string): ProjectNativePropertySnapshot;
  values(property: string): readonly string[];
  onChange(callback: () => void): () => void;
}

export type ProjectNativePropertySnapshot =
  | { kind: 'unavailable' }
  | {
      kind: 'available';
      property: ProjectPropertyInfo | undefined;
      assignment:
        | { kind: 'none' }
        | { kind: 'assigned'; nativeType: string; type: ProjectPropertyType | null };
    };

interface MetadataTypeManager {
  getAllProperties(): unknown;
  getTypeInfo(name: string): unknown;
  getAssignedWidget?: (name: string) => unknown;
  on(event: 'changed', callback: (property: string) => void): EventRef;
  offref(ref: EventRef): void;
}

const NATIVE_TYPES: Readonly<Record<string, ProjectPropertyType>> = {
  text: 'text',
  multitext: 'list',
  aliases: 'list',
  number: 'number',
  checkbox: 'checkbox',
  date: 'date',
  datetime: 'datetime',
  tags: 'tags',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function metadataTypeManager(app: App): MetadataTypeManager | undefined {
  let candidate: unknown;
  try {
    candidate = (app as unknown as { metadataTypeManager?: unknown }).metadataTypeManager;
  } catch {
    return undefined;
  }
  if (!isRecord(candidate)) return undefined;
  if (
    typeof candidate['getAllProperties'] !== 'function' ||
    typeof candidate['getTypeInfo'] !== 'function' ||
    typeof candidate['on'] !== 'function' ||
    typeof candidate['offref'] !== 'function'
  ) {
    return undefined;
  }
  return candidate as unknown as MetadataTypeManager;
}

function nativeTypeFrom(typeInfo: unknown): ProjectPropertyType | null {
  if (!isRecord(typeInfo) || !isRecord(typeInfo['expected'])) return null;
  const nativeType = typeInfo['expected']['type'];
  if (typeof nativeType !== 'string') return null;
  return NATIVE_TYPES[nativeType] ?? null;
}

function propertyNames(properties: unknown): string[] | undefined {
  if (!isRecord(properties)) return undefined;
  const names: string[] = [];
  for (const value of Object.values(properties)) {
    if (!isRecord(value) || typeof value['name'] !== 'string' || value['name'].length === 0) {
      return undefined;
    }
    names.push(value['name']);
  }
  return names;
}

function sameProperty(left: string, right: string): boolean {
  return left.localeCompare(right, undefined, { sensitivity: 'accent' }) === 0;
}

type NativeAssignment = Extract<ProjectNativePropertySnapshot, { kind: 'available' }>['assignment'];

function nativeAssignment(
  manager: MetadataTypeManager,
  property: string,
): NativeAssignment | undefined {
  const assigned = manager.getAssignedWidget?.(property);
  if (assigned === null) return { kind: 'none' };
  if (typeof assigned !== 'string' || assigned.length === 0) return undefined;
  return {
    kind: 'assigned',
    nativeType: assigned,
    type: NATIVE_TYPES[assigned] ?? null,
  };
}

function addValue(values: Map<string, string>, value: unknown): void {
  if (typeof value !== 'string' && !(typeof value === 'number' && Number.isFinite(value))) return;
  const text = String(value);
  const normalized = text.toLocaleLowerCase();
  if (!values.has(normalized)) values.set(normalized, text);
}

function compareSuggestions(left: string, right: string): number {
  return left.localeCompare(right, undefined, { sensitivity: 'base', numeric: true });
}

function collectFrontmatterValues(
  values: Map<string, string>,
  frontmatter: Record<string, unknown> | undefined,
  property: string,
): void {
  if (frontmatter === undefined) return;
  const found = findFrontmatterProperty(frontmatter, property)?.value;
  if (!Array.isArray(found)) {
    addValue(values, found);
    return;
  }
  for (const value of found) addValue(values, value);
}

function collectTags(
  values: Map<string, string>,
  normalizedProperty: string,
  cache: ReturnType<App['metadataCache']['getFileCache']>,
): void {
  if (normalizedProperty !== 'tags' || cache === null) return;
  for (const tag of getAllTags(cache) ?? []) addValue(values, tag);
}

/**
 * Narrow compatibility boundary around Obsidian's internal property type manager.
 * No property type is inferred locally when that manager cannot be read.
 */
export class ObsidianProjectProperties implements ProjectPropertyCatalog {
  private readonly valuesCache_abyssPrivate = new Map<string, readonly string[]>();

  constructor(private readonly app_abyssPrivate: App) {}

  list(): readonly ProjectPropertyInfo[] | null {
    const manager = metadataTypeManager(this.app_abyssPrivate);
    if (manager === undefined) return null;
    try {
      const names = propertyNames(manager.getAllProperties());
      if (names === undefined) return null;
      return names.map((name) => ({ name, type: nativeTypeFrom(manager.getTypeInfo(name)) }));
    } catch {
      return null;
    }
  }

  inspect(property: string): ProjectNativePropertySnapshot {
    try {
      const manager = metadataTypeManager(this.app_abyssPrivate);
      if (manager === undefined || typeof manager.getAssignedWidget !== 'function') {
        return { kind: 'unavailable' };
      }
      const names = propertyNames(manager.getAllProperties());
      if (names === undefined) return { kind: 'unavailable' };
      const matches = names.filter((name) => sameProperty(name, property));
      if (matches.length > 1) return { kind: 'unavailable' };
      const name = matches[0];
      const assignment = nativeAssignment(manager, name ?? property);
      if (assignment === undefined) return { kind: 'unavailable' };
      const nativeProperty =
        name === undefined ? undefined : { name, type: nativeTypeFrom(manager.getTypeInfo(name)) };
      return {
        kind: 'available',
        property: nativeProperty,
        assignment,
      };
    } catch {
      return { kind: 'unavailable' };
    }
  }

  values(property: string): readonly string[] {
    const normalized = property.toLocaleLowerCase();
    const cached = this.valuesCache_abyssPrivate.get(normalized);
    if (cached !== undefined) return [...cached];

    const values = new Map<string, string>();
    for (const file of this.app_abyssPrivate.vault.getMarkdownFiles()) {
      const cache = this.app_abyssPrivate.metadataCache.getFileCache(file);
      collectFrontmatterValues(values, cache?.frontmatter, property);
      collectTags(values, normalized, cache);
    }
    const result = [...values.values()].sort(compareSuggestions);
    this.valuesCache_abyssPrivate.set(normalized, result);
    return [...result];
  }

  onChange(callback: () => void): () => void {
    const cleanups: Array<() => void> = [];
    const changed = (): void => {
      this.valuesCache_abyssPrivate.clear();
      callback();
    };
    const manager = metadataTypeManager(this.app_abyssPrivate);
    if (manager !== undefined) {
      try {
        const ref = manager.on('changed', changed);
        cleanups.push(() => {
          manager.offref(ref);
        });
      } catch {
        // The private event API is optional; public metadata events still invalidate values.
      }
    }
    const changedRef = this.app_abyssPrivate.metadataCache.on('changed', changed);
    const deletedRef = this.app_abyssPrivate.metadataCache.on('deleted', changed);
    cleanups.push(() => {
      this.app_abyssPrivate.metadataCache.offref(changedRef);
    });
    cleanups.push(() => {
      this.app_abyssPrivate.metadataCache.offref(deletedRef);
    });

    let active = true;
    return () => {
      if (!active) return;
      active = false;
      for (const cleanup of cleanups) cleanup();
    };
  }
}
