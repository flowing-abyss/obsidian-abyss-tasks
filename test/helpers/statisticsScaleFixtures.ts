import type { StatisticsProject } from '../../src/statistics';
import type { TaskSnapshot, TaskStatisticsSnapshot } from '../../src/tasks';
import { closed, date, task } from './statisticsFixtures';

// Independent ten-role oracle, authored before model inspection. N/10 identical blocks;
// role/date/entry tables are fixture inputs, never production reducer output.
const CREATED = [
  '09-28',
  '09-29',
  '09-28',
  '09-01',
  '09-30',
  '09-30',
  '10-01',
  '09-28',
  '09-28',
  undefined,
];
const DUE = [
  '10-03',
  '10-04',
  '10-01',
  '09-29',
  undefined,
  '10-01',
  '10-02',
  '10-04',
  '10-02',
  '10-03',
];
const COMPLETED = [
  undefined,
  undefined,
  '10-01',
  '09-30',
  undefined,
  '10-02',
  undefined,
  undefined,
  '10-03',
  undefined,
];
const STATUS = [
  'open',
  'in-progress',
  'done',
  'done',
  'open',
  'done',
  'cancelled',
  'open',
  'done',
  'open',
] as const;
export const scaleProjects: readonly StatisticsProject[] = [
  { path: 'projects/alpha.md', name: 'Same name' },
  { path: 'projects/beta.md', name: 'Same name' },
];
export const scaleTransitions: readonly number[] = Object.freeze([]);
export function scalePath(block: number, role: number): string {
  if (role >= 8) return 'archive.md';
  if (block % 10 < 8) return 'projects/alpha.md';
  return block % 10 === 8 ? 'projects/beta.md' : 'unassigned.md';
}
export function scaleNodeKey(block: number, role: number): string {
  return JSON.stringify([
    role >= 8 ? 'archive' : 'live',
    scalePath(block, role),
    block * 100 + (role === 5 ? 40 : role * 10),
    role === 5 ? [10] : [],
  ]);
}
function rolePlanning(role: number): TaskSnapshot['planning'] {
  const created = CREATED[role],
    due = DUE[role],
    completion = COMPLETED[role];
  return {
    ...(created === undefined ? {} : { created: date(`2026-${created}`) }),
    ...(due === undefined ? {} : { due: date(`2026-${due}`) }),
    ...(completion === undefined ? {} : { completion: date(`2026-${completion}`) }),
    ...(role === 6 ? { cancelled: date('2026-10-03') } : {}),
  };
}
function lastEntry(role: number) {
  if (role === 9) return closed('1926-10-04T12:00Z', '2026-10-04T12:00Z', 3);
  return closed('2026-10-04T11:45Z', role === 7 ? '2026-10-04T11:45Z' : '2026-10-04T12:15Z', 3);
}
function roleDependencies(block: number, role: number): string[] {
  if ([1, 4, 9].includes(role)) return [`A_${block}`];
  return role === 7 ? [`B_${block}`, `C_${block}`] : [];
}
function roleTask(block: number, role: number): TaskSnapshot {
  const filePath = scalePath(block, role),
    line = block * 100 + role * 10;
  const node = task(`Role ${role}`, {
    ref: { filePath, line, revision: '1' },
    status: STATUS[role] ?? 'open',
    priority: role % 2 === 0 ? 'A' : 'B',
    planning: rolePlanning(role),
    tags: role % 2 === 0 ? ['Common', 'Red', 'RED'] : ['Common'],
    timeEntries: [
      closed('2026-09-28T09:00Z', '2026-09-28T09:30Z'),
      closed('2026-10-01T23:50Z', '2026-10-02T00:10Z', 2),
      lastEntry(role),
    ],
    ...([0, 1, 4, 7].includes(role)
      ? { dependencyId: `${['A', 'B', '', '', 'C', '', '', 'D'][role]}_${block}` }
      : {}),
    dependsOn: roleDependencies(block, role),
  });
  return { ...node, source: { ...node.source, filePath, line } };
}
export function statisticsScaleFixture(size: number): TaskStatisticsSnapshot {
  if (size % 100 !== 0)
    throw new Error('Scale fixture requires complete 10-block project partitions');
  const files = ['projects/alpha.md', 'projects/beta.md', 'unassigned.md', 'archive.md'].map(
    (path) => ({
      path,
      revision: 1,
      kind: path === 'archive.md' ? ('archive' as const) : ('live' as const),
      roots: [] as TaskSnapshot[],
      dateIssues: [] as Array<{ line: number; field: 'created'; reason: 'ambiguous-date' }>,
    }),
  );
  for (let block = 0; block < size / 10; block++) {
    for (let role = 0; role < 10; role++) {
      if (role === 5) continue;
      let node = roleTask(block, role);
      if (role === 4)
        node = {
          ...node,
          recurrence: 'every day',
          subtasks: [
            {
              ...roleTask(block, 5),
              ref: {
                parent: { type: 'task', ref: node.ref },
                relativeLine: 10,
                originalBlock: 'child',
              },
            },
          ],
        };
      const file = files.find((file) => file.path === node.ref.filePath);
      if (file === undefined) throw new Error('Missing fixture file');
      file.roots.push(node);
      if (role === 7)
        file.dateIssues.push({ line: node.ref.line, field: 'created', reason: 'ambiguous-date' });
    }
  }
  return { revision: 1, ready: true, issues: [], files };
}
