import type { ProjectFieldCatalogItem } from '../../projects/projectFields';
import type { ProjectStatus } from '../../settings/types';

export interface ProjectTableDragGroup {
  readonly key: string;
  readonly value: unknown;
  readonly sourcePath?: string;
}

export interface ProjectGroupDropInput {
  readonly field: ProjectFieldCatalogItem;
  readonly currentValue: unknown;
  readonly projectPath?: string;
  readonly source: ProjectTableDragGroup;
  readonly target: ProjectTableDragGroup;
  readonly statuses: ReadonlyArray<Pick<ProjectStatus, 'id' | 'name'>>;
  readonly groupIdentity?: (value: string, sourcePath: string) => string | undefined;
  readonly rebase?: (value: unknown, sourcePath: string, destinationPath: string) => unknown;
}

function isEmptyGroup(group: ProjectTableDragGroup): boolean {
  return group.key === 'empty' || group.key === 'none';
}

function scalarGroupIdentity(
  value: unknown,
  sourcePath: string,
  identifyLink: ProjectGroupDropInput['groupIdentity'],
): string {
  if (value === undefined || value === null || value === '') return 'empty';
  if (typeof value === 'object') throw new Error('Group values must be scalar');
  let text: string;
  if (typeof value === 'string') text = value;
  else if (typeof value === 'number' || typeof value === 'boolean') text = `${value}`;
  else throw new Error('Group values must be scalar');
  return identifyLink?.(text, sourcePath) ?? `value:${text.toLocaleLowerCase()}`;
}

function uniqueValues(
  values: readonly unknown[],
  sourcePath: string,
  identifyLink: ProjectGroupDropInput['groupIdentity'],
): unknown[] {
  const seen = new Set<string>();
  const unique: unknown[] = [];
  for (const value of values) {
    const identity = scalarGroupIdentity(value, sourcePath, identifyLink);
    if (seen.has(identity)) continue;
    seen.add(identity);
    unique.push(value);
  }
  return unique;
}

function targetValue(input: ProjectGroupDropInput): unknown {
  const { target, projectPath = '', rebase } = input;
  if (target.sourcePath === undefined || rebase === undefined) return target.value;
  return rebase(target.value, target.sourcePath, projectPath);
}

export function planProjectGroupDrop(input: ProjectGroupDropInput): unknown {
  const { field, currentValue, source, target } = input;
  validateDropField(field);
  if (source.key === target.key) {
    return Array.isArray(currentValue) ? Array.from(currentValue as unknown[]) : currentValue;
  }
  const targetEmpty = isEmptyGroup(target);
  if (field.type === 'status') return statusDropValue(input, targetEmpty);
  if (targetEmpty) return field.type === 'list' || field.type === 'tags' ? [] : undefined;
  const replacement = targetValue(input);
  if (field.type !== 'list' && field.type !== 'tags') return replacement;
  return listDropValue(input, replacement);
}

function validateDropField(field: ProjectFieldCatalogItem): void {
  if (field.type === null) throw new Error(`${field.label} is read-only`);
  if (field.type === 'name' || field.type === 'progress') {
    throw new Error(`${field.label} cannot be changed by moving a group`);
  }
}

function statusDropValue(input: ProjectGroupDropInput, targetEmpty: boolean): string | undefined {
  if (targetEmpty) return undefined;
  if (input.target.key.startsWith('raw:')) {
    const raw = input.target.value;
    if (typeof raw !== 'string' || raw.trim().length === 0 || input.target.key !== `raw:${raw}`) {
      throw new Error('Unknown project status target is invalid');
    }
    return raw;
  }
  const status = input.target.key.startsWith('id:')
    ? input.statuses.find(({ id }) => id === input.target.key.slice(3))
    : undefined;
  if (status === undefined) throw new Error('Unknown project statuses cannot be assigned');
  return status.name;
}

function currentListValue(value: unknown): unknown[] {
  if (Array.isArray(value)) return Array.from(value as unknown[]);
  return value === undefined || value === null || value === '' ? [] : [value];
}

function listDropValue(input: ProjectGroupDropInput, replacement: unknown): unknown[] {
  const { source, projectPath = '', groupIdentity } = input;
  const current = currentListValue(input.currentValue);
  let next: unknown[];
  if (isEmptyGroup(source)) next = [...current, replacement];
  else {
    next = current.map((value) =>
      scalarGroupIdentity(value, projectPath, groupIdentity) === source.key ? replacement : value,
    );
  }
  return uniqueValues(next, projectPath, groupIdentity);
}
