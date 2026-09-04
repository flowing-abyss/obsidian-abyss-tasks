import type { ProjectStatus } from '../settings/types';
import type { Project } from './types';

export interface StatusGroup {
  key: string;
  label: string;
  color?: string;
  statusId: string | null; // null for discovered/none groups
}

function toPropertyString(val: unknown): string {
  if (val == null) return '';
  if (typeof val === 'string' || typeof val === 'number' || typeof val === 'boolean') {
    return String(val);
  }
  return JSON.stringify(val);
}

function matchesStatus(s: ProjectStatus, tags: string[], fm: Record<string, unknown>): boolean {
  if (s.match.kind === 'tag') {
    const want = s.match.tag.replace(/^#/, '').toLowerCase();
    return tags.some((t) => {
      const ft = t.replace(/^#/, '').toLowerCase();
      return ft === want || ft.startsWith(`${want}/`);
    });
  }
  const v = fm[s.match.property];
  return toPropertyString(v) === s.match.value;
}

export function resolveStatus(
  statuses: ProjectStatus[],
  tags: string[],
  frontmatter: Record<string, unknown>,
): { statusId: string | null; rawStatus: string | null } {
  for (const s of statuses) {
    if (matchesStatus(s, tags, frontmatter)) return { statusId: s.id, rawStatus: null };
  }
  // discovered: property-kind only
  const statusProps = new Set(
    statuses
      .filter((s) => s.match.kind === 'property')
      .map((s) => (s.match as { property: string }).property),
  );
  for (const prop of statusProps) {
    const v = frontmatter[prop];
    const str = toPropertyString(v);
    if (str !== '') {
      return { statusId: null, rawStatus: str };
    }
  }
  return { statusId: null, rawStatus: null };
}

export function orderedGroups(statuses: ProjectStatus[], projects: Project[]): StatusGroup[] {
  const groups: StatusGroup[] = statuses.map((s) => ({
    key: `id:${s.id}`,
    label: s.label,
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
