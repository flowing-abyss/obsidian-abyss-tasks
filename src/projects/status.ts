import type { ProjectsSettings, ProjectStatus } from '../settings/types';
import { findFrontmatterProperty } from './projectFields';
import type { Project } from './types';

export interface StatusGroup {
  key: string;
  label: string;
  color?: string;
  statusId: string | null; // null for discovered/none groups
}

export function projectStatusDisplayName(status: ProjectStatus): string {
  const displayName = status.displayName?.trim();
  return displayName === undefined || displayName === '' ? status.name : displayName;
}

function toPropertyString(val: unknown): string {
  if (val == null) return '';
  if (typeof val === 'string' || typeof val === 'number' || typeof val === 'boolean') {
    return String(val);
  }
  return JSON.stringify(val);
}

export function resolveStatus(
  projects: Pick<ProjectsSettings, 'statusProperty' | 'statuses'>,
  frontmatter: Record<string, unknown>,
): { statusId: string | null; rawStatus: string | null } {
  if (projects.statusProperty.length === 0) return { statusId: null, rawStatus: null };
  const value = findFrontmatterProperty(frontmatter, projects.statusProperty)?.value;
  const rawStatus = toPropertyString(value);
  if (rawStatus.length === 0) return { statusId: null, rawStatus: null };
  const status = projects.statuses.find(({ name }) => name === rawStatus);
  if (status !== undefined) return { statusId: status.id, rawStatus: null };
  return { statusId: null, rawStatus };
}

export function orderedGroups(statuses: ProjectStatus[], projects: Project[]): StatusGroup[] {
  const groups: StatusGroup[] = statuses.map((s) => ({
    key: `id:${s.id}`,
    label: projectStatusDisplayName(s),
    ...(s.color !== undefined && { color: s.color }),
    statusId: s.id,
  }));
  const discovered = new Set<string>();
  let hasNone = false;
  for (const p of projects) {
    if (p.statusId !== null && p.statusId.length > 0) continue;
    if (p.rawStatus !== null && p.rawStatus.length > 0) discovered.add(p.rawStatus);
    else hasNone = true;
  }
  for (const raw of Array.from(discovered).sort((a, b) => a.localeCompare(b))) {
    groups.push({ key: `raw:${raw}`, label: raw, statusId: null });
  }
  if (hasNone) groups.push({ key: 'none', label: 'No status', statusId: null });
  return groups;
}
