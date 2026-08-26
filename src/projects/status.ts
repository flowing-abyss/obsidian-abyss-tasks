import type { ProjectStatus } from '../settings/types';
import { resolveProjectLifecycle } from './lifecycle';
import type { Project } from './types';

export interface StatusGroup {
  key: string;
  label: string;
  color?: string;
  statusId: string | null; // null for discovered/none groups
}

export function resolveStatus(
  statuses: ProjectStatus[],
  tags: string[],
  frontmatter: Record<string, unknown>,
): { statusId: string | null; rawStatus: string | null } {
  const { statusId, rawStatus } = resolveProjectLifecycle(statuses, tags, frontmatter);
  return { statusId, rawStatus };
}

export function orderedGroups(statuses: ProjectStatus[], projects: Project[]): StatusGroup[] {
  const groups: StatusGroup[] = statuses.map((s) => ({
    key: `id:${s.id}`,
    label: s.label,
    color: s.color,
    statusId: s.id,
  }));
  const discovered = new Set<string>();
  let hasNone = false;
  for (const p of projects) {
    if (p.statusId) continue;
    if (p.rawStatus) discovered.add(p.rawStatus);
    else hasNone = true;
  }
  for (const raw of Array.from(discovered).sort((a, b) => a.localeCompare(b))) {
    groups.push({ key: `raw:${raw}`, label: raw, statusId: null });
  }
  if (hasNone) groups.push({ key: 'none', label: 'No status', statusId: null });
  return groups;
}
