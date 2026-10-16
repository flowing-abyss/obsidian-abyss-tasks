import { createHash } from 'node:crypto';
import { FIXTURE_FOLDER } from './types.ts';
export { FIXTURE_FOLDER } from './types.ts';

export interface Fixture {
  version: 1;
  anchor: string;
  files: Record<string, string>;
  digest: string;
  roots: 4000;
  nodes: 6000;
  archiveRoots: 300;
  projects: 100;
  settings: Record<string, unknown>;
}

function dateAt(anchor: string, offset: number): string {
  return new Date(Date.parse(`${anchor}T12:00:00Z`) + offset * 86400000).toISOString().slice(0, 10);
}

function planningTokens(anchor: string, id: number, offset: number, date: string): string[] {
  const parts: string[] = [];
  if (id % 5 !== 4) parts.push(`📅 ${date}`);
  if (id % 3 === 0) parts.push(`⏳ ${date} ⏰ ${String(8 + (id % 10)).padStart(2, '0')}:00`);
  if (id % 20 === 3) parts.push(`🛫 ${dateAt(anchor, offset - 2 - (id % 3))}`);
  return parts;
}

function taskBlock(anchor: string, id: number): string {
  const symbol = [' ', '/', 'x', '-'][id % 4] ?? ' ';
  const offset = symbol === 'x' || symbol === '-' ? -(id % 300) - 1 : (id % 365) - 300;
  const date = dateAt(anchor, offset);
  const created = dateAt(anchor, offset - (id % 120) - 31);
  const parts = [
    `- [${symbol}] Profile task ${id} ${id % 2 === 0 ? 'database' : 'планирование'} #profile/group${id % 8}`,
  ];
  if (id % 20 === 0) parts.push('🔁 every week');
  parts.push(`➕ ${created} ⏱️ 45m`);
  parts.push(...planningTokens(anchor, id, offset, date));
  if (symbol === 'x') parts.push(`✅ ${date}`);
  if (symbol === '-') parts.push(`❌ ${date}`);
  parts.push(`🆔 profile-${id}`);
  if (id % 4 === 1) parts.push(`⛔ profile-${id - 1}`);
  const lines = [
    parts.join(' '),
    `  - > Description **rich text** with [[Profile reference]] and scope ${id}.`,
    `  - ${date}: Review evidence and benchmark notes ${id}.`,
  ];
  if (id % 2 === 0) {
    lines.push(`  - ${date}T09:00:00Z → ${date}T09:45:00Z`);
    lines.push(`  - [ ] Child ${id} #profile/child 📅 ${date}`);
  }
  return lines.join('\n');
}

function projectFile(anchor: string, project: number): string {
  const status = ['inbox', 'todo', 'wip', 'done'][project % 4] ?? 'todo';
  const lines = [
    '---',
    `status: ${status}`,
    `start: ${dateAt(anchor, -30 + (project % 20))}`,
    `end: ${dateAt(anchor, 10 + (project % 30))}`,
    'tags: [profile-project]',
    `budget: ${1000 + project * 50}`,
    'description: Reproducible performance project',
    '---',
    '# Tasks',
  ];
  for (let i = 0; i < 40; i++) lines.push(taskBlock(anchor, project * 40 + i));
  return `${lines.join('\n')}\n`;
}

export function createFixture(anchor: string): Fixture {
  if (
    !/^\d{4}-\d{2}-\d{2}$/u.test(anchor) ||
    !Number.isFinite(Date.parse(`${anchor}T12:00:00Z`)) ||
    dateAt(anchor, 0) !== anchor
  )
    throw new Error('Anchor must be a real YYYY-MM-DD date');
  const files: Record<string, string> = {};
  for (let i = 0; i < 100; i++)
    files[`${FIXTURE_FOLDER}/projects/Project-${String(i).padStart(3, '0')}.md`] = projectFile(
      anchor,
      i,
    );
  files[`${FIXTURE_FOLDER}/archive.md`] = Array.from(
    { length: 300 },
    (_, i) =>
      `- [x] Archived ${i} #profile/archive ➕ ${dateAt(anchor, -180)} ✅ ${dateAt(anchor, -i % 90)}\n  - ${dateAt(anchor, -i % 90)}T10:00:00Z → ${dateAt(anchor, -i % 90)}T10:30:00Z`,
  ).join('\n');
  files[`${FIXTURE_FOLDER}/inbox.md`] = '# Performance command sandbox\n';
  return {
    version: 1,
    anchor,
    files,
    digest: createHash('sha256').update(JSON.stringify(files)).digest('hex'),
    roots: 4000,
    nodes: 6000,
    archiveRoots: 300,
    projects: 100,
    settings: {
      taskIgnoreQuery: `NOT "${FIXTURE_FOLDER}/"`,
      taskFilePath: `${FIXTURE_FOLDER}/inbox.md`,
      taskArchivePath: `${FIXTURE_FOLDER}/archive.md`,
      taskInsertionMode: 'append',
      taskPrefix: '',
      applyTaskPrefixToSubtasks: false,
      pinnedTags: ['#profile/child'],
      projects: {
        membershipQuery: `"${FIXTURE_FOLDER}/projects/"`,
        createFolder: `${FIXTURE_FOLDER}/projects`,
        statusProperty: 'status',
        startProperty: 'start',
        endProperty: 'end',
        overviewView: 'table',
      },
    },
  };
}
