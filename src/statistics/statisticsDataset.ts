import {
  localDate,
  type SubtaskSnapshot,
  type TaskNodeRef,
  type TaskSnapshot,
  type TaskStatisticsSnapshot,
} from '../tasks';
import { required, StatisticsCancelled, WorkBudget } from './statisticsWork';
import type {
  StatisticsDataset,
  StatisticsEntry,
  StatisticsProject,
  StatisticsScope,
  StatisticsScopedCoverage,
  StatisticsTask,
  StatisticsWork,
} from './types';
const NO_PROJECT = 'unassigned';
const ARCHIVE_PROJECT = 'archive:unknown';
function projectKey(path: string): string {
  return `project:${path}`;
}
function verified(
  value: string | undefined,
  invalid: boolean,
): ReturnType<typeof localDate> | undefined {
  if (value === undefined || invalid) return undefined;
  try {
    return localDate(value);
  } catch {
    return undefined;
  }
}
function validInstant(ms: number | undefined): ms is number {
  return ms !== undefined && Number.isFinite(ms) && ms >= -62167219200000 && ms < 253402300800000;
}
type TaskStatisticsDateIssue = TaskStatisticsSnapshot['files'][number]['dateIssues'][number];
type SourceFile = TaskStatisticsSnapshot['files'][number];
interface PendingNode {
  node: TaskSnapshot | SubtaskSnapshot;
  ref: TaskNodeRef;
  path: readonly number[];
  line: number;
  recurring: boolean;
  rootLine: number;
}
class DatasetBuilder {
  readonly tasks: StatisticsTask[] = [];
  readonly entries: StatisticsEntry[] = [];
  private brokenEntries = 0;
  private dateIssues = 0;
  private live = 0;
  private archive = 0;
  private readonly projects = new Map<string, StatisticsProject>();
  constructor(private readonly budget: WorkBudget) {}
  async prepareProjects(projects: readonly StatisticsProject[]): Promise<StatisticsProject[]> {
    const result: StatisticsProject[] = [];
    for (const p of projects) {
      this.projects.set(p.path, p);
      result.push(Object.freeze({ ...p }));
      await this.budget.step();
    }
    return result;
  }
  private async issueFields(
    file: SourceFile,
  ): Promise<
    Map<number, { fields: Set<string>; count: number; issues: TaskStatisticsDateIssue[] }>
  > {
    const result = new Map<
      number,
      { fields: Set<string>; count: number; issues: TaskStatisticsDateIssue[] }
    >();
    for (const issue of file.dateIssues) {
      const fields = result.get(issue.line) ?? { fields: new Set<string>(), count: 0, issues: [] };
      fields.fields.add(issue.field);
      fields.count++;
      fields.issues.push(Object.freeze({ ...issue }));
      result.set(issue.line, fields);
      this.dateIssues++;
      await this.budget.step();
    }
    return result;
  }
  private membership(
    file: SourceFile,
  ): Pick<StatisticsTask, 'projectKey' | 'projectName' | 'projectStatus'> {
    if (file.kind === 'archive')
      return { projectKey: ARCHIVE_PROJECT, projectName: 'Unknown project · archive' };
    const project = this.projects.get(file.path);
    return project === undefined
      ? { projectKey: NO_PROJECT, projectName: 'No project' }
      : {
          projectKey: projectKey(file.path),
          projectName: project.name,
          projectStatus: project.statusKey ?? 'none',
        };
  }
  private record(
    item: PendingNode,
    file: SourceFile,
    issues: Map<number, { fields: Set<string>; count: number; issues: TaskStatisticsDateIssue[] }>,
  ): StatisticsTask {
    const n = item.node,
      issue = issues.get(item.line) ?? { count: 0, fields: new Set<string>(), issues: [] },
      fields = issue.fields;
    const key = JSON.stringify([file.kind, file.path, item.rootLine, item.path]);
    return Object.freeze({
      index: this.tasks.length,
      key,
      ref: item.ref,
      filePath: file.path,
      fileKind: file.kind,
      sourceRevision: file.revision,
      dateIssueCount: issue.count,
      dateIssues: Object.freeze(issue.issues),
      nodePath: Object.freeze(item.path),
      title: n.title,
      status: n.status,
      priority: n.priority,
      tags: Object.freeze([...new Set(n.tags.map((t) => t.replace(/^#/u, '').toLowerCase()))]),
      recurring: item.recurring || n.recurrence !== undefined,
      ...this.membership(file),
      created: verified(n.planning.created, fields.has('created') === true),
      completion: verified(n.planning.completion, fields.has('completion') === true),
      cancelled: verified(n.planning.cancelled, fields.has('cancelled') === true),
      due: verified(n.planning.due, fields.has('due') === true),
      dependencyId: n.dependencyId,
      dependsOn: Object.freeze([...new Set(n.dependsOn)]),
    });
  }
  private async entriesFor(item: PendingNode, owner: number): Promise<void> {
    for (const entry of item.node.timeEntries) {
      const valid = validEntry(entry);
      if (!valid) this.brokenEntries++;
      this.entries.push(
        Object.freeze({
          index: this.entries.length,
          key: JSON.stringify([required(this.tasks[owner]).key, entry.relativeLine]),
          owner,
          ref: Object.freeze({
            parent: item.ref,
            relativeLine: entry.relativeLine,
            originalMarkdown: entry.originalMarkdown,
          }),
          state: valid ? entry.state : 'broken',
          startMs: valid ? entry.startMs : undefined,
          endMs: valid ? entry.endMs : undefined,
        }),
      );
      await this.budget.step();
    }
  }
  private async children(
    item: PendingNode,
    recurring: boolean,
    stack: PendingNode[],
  ): Promise<void> {
    for (let i = item.node.subtasks.length - 1; i >= 0; i--) {
      const child = required(item.node.subtasks[i]);
      stack.push({
        node: child,
        ref: { type: 'subtask', ref: child.ref },
        path: [...item.path, child.ref.relativeLine],
        line: item.line + child.ref.relativeLine,
        recurring,
        rootLine: item.rootLine,
      });
      await this.budget.step();
    }
  }
  async file(file: SourceFile): Promise<void> {
    const issues = await this.issueFields(file);
    for (const root of file.roots) {
      const stack: PendingNode[] = [
        {
          node: root,
          ref: { type: 'task', ref: root.ref },
          path: [],
          line: root.ref.line,
          rootLine: root.ref.line,
          recurring: false,
        },
      ];
      while (stack.length > 0) {
        const item = required(stack.pop()),
          record = this.record(item, file, issues);
        this.tasks.push(record);
        if (file.kind === 'live') this.live++;
        else this.archive++;
        await this.budget.step();
        await this.entriesFor(item, record.index);
        await this.children(item, record.recurring, stack);
      }
    }
  }
  finish(
    snapshot: TaskStatisticsSnapshot,
    projects: readonly StatisticsProject[],
  ): StatisticsDataset {
    return Object.freeze({
      revision: snapshot.revision,
      tasks: Object.freeze(this.tasks),
      entries: Object.freeze(this.entries),
      projects: Object.freeze(projects),
      coverage: Object.freeze({
        countingUnit: 'Tasks & subtasks',
        recurrence: 'Node or ancestor; retained instances only',
        nodes: this.tasks.length,
        live: this.live,
        archive: this.archive,
        entries: this.entries.length,
        brokenEntries: this.brokenEntries,
        dateIssues: this.dateIssues,
        ready: snapshot.ready,
        sourceIssues: snapshot.issues,
      }),
    });
  }
}
export async function prepareStatisticsDataset(
  snapshot: TaskStatisticsSnapshot,
  projects: readonly StatisticsProject[],
  work: StatisticsWork,
): Promise<StatisticsDataset | undefined> {
  const budget = new WorkBudget(work);
  try {
    budget.check();
    const builder = new DatasetBuilder(budget),
      identities = await builder.prepareProjects(projects);
    for (const file of snapshot.files) await builder.file(file);
    return builder.finish(snapshot, identities);
  } catch (error) {
    if (error instanceof StatisticsCancelled) return undefined;
    throw error;
  }
}
export function inScope(
  task: StatisticsTask,
  scope: StatisticsScope,
  projectStatus?: string,
): boolean {
  if (projectStatus !== undefined && task.projectStatus !== projectStatus) return false;
  switch (scope.type) {
    case 'all':
      return true;
    case 'archive':
      return task.fileKind === 'archive';
    case 'project':
      return task.projectKey === projectKey(scope.path);
    case 'unassigned':
      return task.projectKey === NO_PROJECT;
    case 'tag':
      return task.tags.includes(scope.tag.replace(/^#/u, '').toLowerCase());
    case 'priority':
      return task.priority === scope.priority;
  }
}
export function active(task: StatisticsTask): boolean {
  return task.status === 'open' || task.status === 'in-progress';
}

function validEntry(entry: TaskSnapshot['timeEntries'][number]): boolean {
  if (entry.state === 'broken' || !validInstant(entry.startMs)) return false;
  return entry.state === 'running' || (validInstant(entry.endMs) && entry.endMs >= entry.startMs);
}

export async function scopedCoverage(
  dataset: StatisticsDataset,
  scope: StatisticsScope,
  budget: WorkBudget,
  projectStatus?: string,
): Promise<StatisticsScopedCoverage> {
  let nodes = 0,
    entries = 0,
    brokenEntries = 0,
    dateIssues = 0;
  const owners = new Set<number>(),
    kinds = { live: 0, archive: 0 };
  for (const task of dataset.tasks) {
    if (inScope(task, scope, projectStatus)) {
      owners.add(task.index);
      nodes++;
      dateIssues += task.dateIssueCount;
      kinds[task.fileKind]++;
    }
    await budget.step();
  }
  for (const entry of dataset.entries) {
    if (owners.has(entry.owner)) {
      entries++;
      if (entry.state === 'broken') brokenEntries++;
    }
    await budget.step();
  }
  return Object.freeze({ nodes, ...kinds, entries, brokenEntries, dateIssues });
}
