export interface ProjectsScaleTaskRecord {
  readonly key: string;
  readonly ref: {
    readonly filePath: string;
    readonly line: number;
    readonly revision: string;
  };
  readonly line: number;
  readonly markdown: string;
  readonly originalBlock: string;
  readonly status: 'open' | 'in-progress' | 'done' | 'cancelled';
  readonly priority: 'A' | 'B' | 'C' | 'D' | 'E';
  readonly projectPath: string;
  readonly ownerPath: string;
  readonly title: string;
  readonly taskId?: string;
  readonly dependsOn: readonly string[];
  readonly scheduled?: string;
  readonly due?: string;
}

export interface ProjectsScaleWorkNote {
  readonly path: string;
  readonly kind: 'ordinary' | 'milestone';
  readonly projectPath: string;
  readonly rawStatus: string;
  readonly milestonePath?: string;
  readonly tags: readonly string[];
  readonly frontmatter: Readonly<Record<string, unknown>>;
  readonly tasks: readonly ProjectsScaleTaskRecord[];
  readonly taskCount: number;
  readonly anomaly?: 'unknown-status' | 'broken-project' | 'duplicate-project-basename';
}

export interface ProjectsScaleOwnership {
  readonly path: string;
  readonly projectPath: string;
  readonly kind: 'ordinary' | 'milestone';
  readonly milestonePath: string | null;
}

const SCALE_SEED = 0x51ca1e;
const PROJECT_PATHS = Object.freeze(
  Array.from(
    { length: 5 },
    (_, index) => `Projects/Project ${String(index + 1).padStart(2, '0')}.md`,
  ),
);
const PROJECT_LIFECYCLES = Object.freeze([
  'active',
  'completed',
  'dropped',
  'published',
  'unmapped',
] as const);
const TASK_STATUSES = Object.freeze(['open', 'in-progress', 'done', 'cancelled'] as const);
const TASK_PRIORITIES = Object.freeze(['A', 'B', 'C', 'D', 'E'] as const);

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
}

function deepFreeze<T>(value: T, seen = new Set<unknown>()): Readonly<T> {
  if (value === null || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child, seen);
  return Object.freeze(value);
}

const random = seededRandom(SCALE_SEED);
const allTasks: ProjectsScaleTaskRecord[] = [];

function dependencyProfile(taskOrdinal: number): {
  readonly status?: ProjectsScaleTaskRecord['status'];
  readonly taskId?: string;
  readonly dependsOn: readonly string[];
} {
  switch (taskOrdinal) {
    case 1:
      return { status: 'done', taskId: 'ready-prerequisite', dependsOn: [] };
    case 2:
      return { status: 'open', taskId: 'blocked-prerequisite', dependsOn: [] };
    case 3:
    case 4:
      return { status: 'open', taskId: 'duplicate-id', dependsOn: [] };
    case 5:
      return { status: 'open', taskId: 'ready-consumer', dependsOn: ['ready-prerequisite'] };
    case 6:
      return { status: 'open', taskId: 'blocked-consumer', dependsOn: ['blocked-prerequisite'] };
    case 7:
      return { status: 'open', taskId: 'duplicate-consumer', dependsOn: ['duplicate-id'] };
    case 8:
      return { status: 'open', taskId: 'missing-consumer', dependsOn: ['missing-id'] };
    case 9:
      return { status: 'open', taskId: 'self-id', dependsOn: ['self-id'] };
    case 10:
      return { status: 'open', taskId: 'cycle-a', dependsOn: ['cycle-b'] };
    case 11:
      return { status: 'open', taskId: 'cycle-b', dependsOn: ['cycle-a'] };
    case 12:
      return { status: 'done', taskId: 'cross-project-ready', dependsOn: [] };
    case 21:
      return {
        status: 'open',
        taskId: 'cross-project-consumer',
        dependsOn: ['cross-project-ready'],
      };
    default:
      return {
        ...(taskOrdinal % 5 === 0 && {
          taskId: `task-${String(taskOrdinal).padStart(4, '0')}`,
        }),
        dependsOn: [],
      };
  }
}

const workNotes: ProjectsScaleWorkNote[] = Array.from({ length: 250 }, (_, index) => {
  const ordinal = index + 1;
  const path = `Work Notes/Work note ${String(ordinal).padStart(3, '0')}.md`;
  const kind = index < 25 ? 'milestone' : 'ordinary';
  const anomaly =
    ordinal === 231
      ? 'unknown-status'
      : ordinal === 232
        ? 'broken-project'
        : ordinal === 233
          ? 'duplicate-project-basename'
          : undefined;
  const projectPath = PROJECT_PATHS[index % PROJECT_PATHS.length]!;
  const rawStatus = anomaly === 'unknown-status' ? 'Review' : index % 5 === 0 ? 'Done' : 'Active';
  const milestonePath =
    kind === 'ordinary' && index % 4 === 0
      ? `Work Notes/Work note ${String((index % 25) + 1).padStart(3, '0')}.md`
      : undefined;
  const tasks = Array.from({ length: index < 50 ? 20 : 0 }, (_, taskIndex) => {
    const taskOrdinal = allTasks.length + taskIndex + 1;
    const dependency = dependencyProfile(taskOrdinal);
    const status = dependency.status ?? TASK_STATUSES[taskOrdinal % TASK_STATUSES.length]!;
    const priority = TASK_PRIORITIES[Math.floor(random() * TASK_PRIORITIES.length)]!;
    const taskId = dependency.taskId;
    const dependsOn = Object.freeze([...dependency.dependsOn]);
    const title =
      taskOrdinal % 97 === 0
        ? 'Repeated localized title — очень длинная задача для проверки устойчивого эллипсиса'
        : taskOrdinal % 31 === 0
          ? 'Repeated title'
          : `Task ${String(taskOrdinal).padStart(4, '0')}`;
    const scheduled = taskOrdinal % 13 === 0 ? '2026-09-10' : undefined;
    const due =
      taskOrdinal % 7 === 0
        ? 'invalid-date'
        : taskOrdinal % 11 === 0
          ? '2026-09-20T14:30:00+07:00'
          : undefined;
    const marker =
      status === 'done' ? 'x' : status === 'cancelled' ? '-' : status === 'in-progress' ? '/' : ' ';
    const markdown = `- [${marker}] ${title}${taskId ? ` 🆔 ${taskId}` : ''}${dependsOn.length ? ` ⛔ ${dependsOn.join(', ')}` : ''} ^scale-${String(taskOrdinal).padStart(4, '0')}`;
    const revision = `scale:${path}:${String(taskIndex)}:${String(taskOrdinal)}`;
    return {
      key: `${path}\0${String(taskIndex + 1)}`,
      ref: { filePath: path, line: taskIndex, revision },
      line: taskIndex,
      title,
      markdown,
      originalBlock: markdown,
      status,
      priority,
      projectPath,
      ownerPath: path,
      ...(taskId && { taskId }),
      dependsOn,
      ...(scheduled && { scheduled }),
      ...(due && { due }),
    } satisfies ProjectsScaleTaskRecord;
  });
  allTasks.push(...tasks);
  const rawProject =
    anomaly === 'broken-project'
      ? '[[Projects/Missing]]'
      : anomaly === 'duplicate-project-basename'
        ? '[[A]]'
        : `[[${projectPath.replace(/\.md$/u, '')}]]`;
  return {
    path,
    kind,
    projectPath,
    rawStatus,
    ...(milestonePath && { milestonePath }),
    tags: [`#work-note/${kind === 'milestone' ? 'milestone' : 'task'}`],
    frontmatter: {
      Project: rawProject,
      Status: rawStatus,
      ID: `WN-${ordinal}`,
      ...(milestonePath && { Milestone: `[[${milestonePath.replace(/\.md$/u, '')}]]` }),
      ...(ordinal % 23 === 0 && { start: '2026-09-30', end: '2026-09-01' }),
      ...(ordinal % 19 === 0 && { start: 'invalid-date' }),
    },
    tasks,
    taskCount: tasks.length,
    ...(anomaly && { anomaly }),
  };
});

const expectedEligible = workNotes.filter(
  ({ anomaly }) => anomaly !== 'broken-project' && anomaly !== 'duplicate-project-basename',
);
const expectedExcluded = workNotes
  .filter(({ anomaly }) => anomaly === 'broken-project' || anomaly === 'duplicate-project-basename')
  .map(({ path, anomaly }) => ({ path, reason: anomaly! }));
const expectedTaskKeys = workNotes.flatMap(({ tasks }) => tasks.map(({ key }) => key));

const directProjectTasks: ProjectsScaleTaskRecord[] = Array.from({ length: 100 }, (_, index) => {
  const projectPath = PROJECT_PATHS[index % PROJECT_PATHS.length]!;
  const line = 100 + index;
  const title = `Direct project task ${String(index + 1).padStart(3, '0')}`;
  const status = TASK_STATUSES[index % TASK_STATUSES.length]!;
  const marker =
    status === 'done' ? 'x' : status === 'cancelled' ? '-' : status === 'in-progress' ? '/' : ' ';
  const markdown = `- [${marker}] ${title}`;
  return {
    key: `${projectPath}\0${String(line)}`,
    ref: {
      filePath: projectPath,
      line,
      revision: `scale:${projectPath}:${String(line)}:direct`,
    },
    line,
    markdown,
    originalBlock: markdown,
    status,
    priority: TASK_PRIORITIES[index % TASK_PRIORITIES.length]!,
    projectPath,
    ownerPath: projectPath,
    title,
    dependsOn: [],
    ...(index % 9 === 0 && { scheduled: '2026-09-12' }),
  };
});

// The legacy compatibility corpus remains 1,000 Work-Note-owned Tasks. Task 16 exercises an exact
// 1,000-action projection containing 100 direct Project Tasks plus 900 inherited Tasks.
const executionTasks = [...directProjectTasks, ...allTasks.slice(0, 900)];

function ownership(note: ProjectsScaleWorkNote): ProjectsScaleOwnership {
  return {
    path: note.path,
    projectPath: note.projectPath,
    kind: note.kind,
    milestonePath: note.milestonePath ?? null,
  };
}

const projectFiles = PROJECT_PATHS.map((path, index) => ({
  path,
  lifecycle: PROJECT_LIFECYCLES[index]!,
  tags: [],
  frontmatter:
    PROJECT_LIFECYCLES[index] === 'unmapped' ? {} : { status: PROJECT_LIFECYCLES[index] },
}));

const scaleFixture = {
  seed: SCALE_SEED,
  projectPaths: PROJECT_PATHS,
  projects: projectFiles,
  projectLifecycles: PROJECT_LIFECYCLES,
  taskStatuses: TASK_STATUSES,
  taskPriorities: TASK_PRIORITIES,
  workNotes,
  tasks: allTasks,
  directProjectTasks,
  executionTasks,
  milestones: workNotes.filter(({ kind }) => kind === 'milestone'),
  allWorkNotePaths: workNotes.map(({ path }) => path),
  expectedWorkNotePaths: expectedEligible.map(({ path }) => path),
  expectedEligibleWorkNotePaths: expectedEligible.map(({ path }) => path),
  expectedExcludedWorkNotes: expectedExcluded,
  expectedEligibleCounts: Object.fromEntries(
    expectedEligible.map(({ path }) => [path, 1] as const),
  ),
  expectedTaskKeys,
  deltas: {
    sameBucketWorkNote: {
      path: workNotes[100]!.path,
      before: ownership(workNotes[100]!),
      after: ownership(workNotes[100]!),
    },
    ownerMove: {
      path: workNotes[101]!.path,
      before: ownership(workNotes[101]!),
      after: { ...ownership(workNotes[101]!), projectPath: PROJECT_PATHS[4]! },
    },
    milestoneMove: {
      path: workNotes[104]!.path,
      before: ownership(workNotes[104]!),
      after: { ...ownership(workNotes[104]!), milestonePath: workNotes[1]!.path },
    },
    directTask: {
      key: directProjectTasks[0]!.key,
      ownerPath: PROJECT_PATHS[0]!,
      projectPath: PROJECT_PATHS[0]!,
    },
    inheritedTask: {
      key: workNotes[0]!.tasks[0]!.key,
      ownerPath: workNotes[0]!.path,
      projectPath: PROJECT_PATHS[0]!,
    },
    crossProjectDependency: {
      prerequisiteProjectPath: PROJECT_PATHS[0]!,
      dependentProjectPath: PROJECT_PATHS[1]!,
      prerequisiteKey: workNotes[0]!.tasks[11]!.key,
      dependentKey: workNotes[1]!.tasks[0]!.key,
      causalTaskPaths: [workNotes[0]!.path],
    },
    semanticNoOp: {
      path: workNotes[102]!.path,
      before: ownership(workNotes[102]!),
      after: ownership(workNotes[102]!),
    },
    storm: Array.from({ length: 40 }, () => ({
      path: workNotes[103]!.path,
      projectPath: workNotes[103]!.projectPath,
    })),
  },
  serviceFalsePositives: [
    {
      path: 'Aggregates/Service rollup.md',
      tags: [],
      frontmatter: {
        Project: `[[${PROJECT_PATHS[0]!.replace(/\.md$/u, '')}]]`,
        Status: 'Active',
      },
    },
    {
      path: 'Templates/Work note service.md',
      tags: [],
      frontmatter: {
        Project: `[[${PROJECT_PATHS[1]!.replace(/\.md$/u, '')}]]`,
        Status: 'Active',
      },
    },
  ],
  projectFiles: [
    ...projectFiles.map(({ path, tags, frontmatter }) => ({
      path,
      tags: [...tags],
      frontmatter: { ...frontmatter },
    })),
    { path: 'Projects/A.md', tags: [], frontmatter: {} },
    { path: 'Archive/A.md', tags: [], frontmatter: {} },
  ],
  duplicateProjectBasenames: ['Projects/A.md', 'Archive/A.md'],
  brokenProjectLinks: ['[[Projects/Missing]]'],
};

type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly (infer Item)[]
    ? readonly DeepReadonly<Item>[]
    : T extends object
      ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
      : T;

export type ProjectsScaleFixture = DeepReadonly<typeof scaleFixture>;

export function assertProjectsScaleFixture(
  fixture: ProjectsScaleFixture = PROJECTS_SCALE_FIXTURE,
): void {
  const fail = (message: string): never => {
    throw new Error(`Invalid Projects scale fixture: ${message}`);
  };
  if (fixture.projects.length !== 5) fail('expected exactly 5 Projects');
  if (fixture.workNotes.length !== 250) fail('expected exactly 250 Work Notes');
  if (fixture.tasks.length !== 1_000) fail('expected exactly 1,000 inline Tasks');
  if (fixture.directProjectTasks.length !== 100) fail('expected exactly 100 direct Project Tasks');
  if (fixture.executionTasks.length !== 1_000) fail('expected exactly 1,000 execution actions');
  if (fixture.milestones.length !== 25) fail('expected exactly 25 milestones');
  if (new Set(fixture.expectedTaskKeys).size !== 1_000) fail('Task keys are not unique');
  if (
    fixture.expectedTaskKeys.some((key, index) => key !== fixture.tasks[index]?.key) ||
    fixture.expectedTaskKeys.length !== fixture.tasks.length
  ) {
    fail('expected Task keys do not exactly match the flattened compatibility corpus');
  }
  if (new Set(fixture.executionTasks.map(({ key }) => key)).size !== 1_000) {
    fail('execution Task keys are not unique');
  }
  if (
    new Set(fixture.executionTasks.map(({ ref }) => JSON.stringify(ref))).size !== 1_000 ||
    new Set(fixture.executionTasks.map(({ originalBlock }) => originalBlock)).size !== 1_000
  ) {
    fail('execution Task refs/revisions/original blocks are not unique');
  }
  if (
    fixture.directProjectTasks.some(
      ({ ownerPath, projectPath, ref }) =>
        ownerPath !== projectPath || ref.filePath !== projectPath,
    )
  ) {
    fail('direct Project Task ownership is inconsistent');
  }
  if (
    fixture.executionTasks.filter(({ ownerPath, projectPath }) => ownerPath === projectPath)
      .length !== 100
  ) {
    fail('execution projection direct/inherited ownership distribution changed');
  }
  if (new Set(fixture.workNotes.map(({ path }) => path)).size !== 250) {
    fail('Work Note paths are not unique');
  }
  if (new Set(fixture.projects.map(({ path }) => path)).size !== 5) {
    fail('Project paths are not unique');
  }
  if (fixture.workNotes.filter(({ taskCount }) => taskCount === 0).length !== 200) {
    fail('expected 200 empty Work Note checklists');
  }
  if (
    !fixture.taskStatuses.every((status) => fixture.tasks.some((task) => task.status === status))
  ) {
    fail('not every configured Task status is represented');
  }
  if (
    !fixture.taskPriorities.every((priority) =>
      fixture.tasks.some((task) => task.priority === priority),
    )
  ) {
    fail('not every configured Task priority is represented');
  }
  const ids = new Map<string, ProjectsScaleTaskRecord[]>();
  for (const task of fixture.executionTasks) {
    if (!task.taskId) continue;
    const candidates = ids.get(task.taskId) ?? [];
    candidates.push(task);
    ids.set(task.taskId, candidates);
  }
  const resolutionKind = (taskId: string): 'ready' | 'blocked' | 'duplicate' | 'missing' => {
    const consumer = fixture.executionTasks.find(({ taskId: candidate }) => candidate === taskId);
    const dependencyId = consumer?.dependsOn[0];
    if (!dependencyId) return 'ready';
    const candidates = ids.get(dependencyId) ?? [];
    if (candidates.length === 0) return 'missing';
    if (candidates.length > 1) return 'duplicate';
    return candidates[0]!.status === 'done' ? 'ready' : 'blocked';
  };
  const actualDependencyBuckets = {
    ready: resolutionKind('ready-consumer'),
    blocked: resolutionKind('blocked-consumer'),
    duplicate: resolutionKind('duplicate-consumer'),
    missing: resolutionKind('missing-consumer'),
    crossProject: resolutionKind('cross-project-consumer'),
  };
  if (
    JSON.stringify(actualDependencyBuckets) !==
    JSON.stringify({
      ready: 'ready',
      blocked: 'blocked',
      duplicate: 'duplicate',
      missing: 'missing',
      crossProject: 'ready',
    })
  ) {
    fail(`dependency semantic buckets changed: ${JSON.stringify(actualDependencyBuckets)}`);
  }
  const taskById = (id: string): ProjectsScaleTaskRecord | undefined =>
    fixture.executionTasks.find(({ taskId }) => taskId === id);
  const self = taskById('self-id');
  const cycleA = taskById('cycle-a');
  const cycleB = taskById('cycle-b');
  const crossPrerequisite = taskById('cross-project-ready');
  const crossConsumer = taskById('cross-project-consumer');
  if (!self || self.dependsOn.length !== 1 || self.dependsOn[0] !== self.taskId) {
    fail('self dependency topology changed');
  }
  if (
    !cycleA ||
    !cycleB ||
    cycleA.dependsOn[0] !== cycleB.taskId ||
    cycleB.dependsOn[0] !== cycleA.taskId
  ) {
    fail('cycle dependency topology changed');
  }
  if (
    !crossPrerequisite ||
    !crossConsumer ||
    crossPrerequisite.projectPath === crossConsumer.projectPath ||
    crossConsumer.dependsOn[0] !== crossPrerequisite.taskId ||
    fixture.deltas.crossProjectDependency.causalTaskPaths[0] !== crossPrerequisite.ownerPath
  ) {
    fail('cross-Project dependency topology changed');
  }
  if ((ids.get('duplicate-id')?.length ?? 0) !== 2) {
    fail('duplicate dependency candidate distribution changed');
  }
  const dated = fixture.executionTasks.filter(
    ({ scheduled, due }) => scheduled !== undefined || due !== undefined,
  );
  const invalidDated = fixture.executionTasks.filter(({ due }) => due === 'invalid-date');
  const minimumWindowBucket = 61;
  if (
    dated.length < minimumWindowBucket ||
    invalidDated.length < minimumWindowBucket ||
    fixture.executionTasks.length - dated.length < minimumWindowBucket
  ) {
    fail('dated, undated, and invalid-date execution buckets must all be represented');
  }
  for (const status of fixture.taskStatuses) {
    if (
      fixture.executionTasks.filter((task) => task.status === status).length < minimumWindowBucket
    ) {
      fail(`Task status bucket ${status} does not exceed a rendered window`);
    }
  }
  for (const priority of fixture.taskPriorities) {
    if (
      fixture.executionTasks.filter((task) => task.priority === priority).length <
      minimumWindowBucket
    ) {
      fail(`Task priority bucket ${priority} does not exceed a rendered window`);
    }
  }
  for (const task of fixture.executionTasks) {
    if (
      task.ref.filePath !== task.ownerPath ||
      task.ref.line !== task.line ||
      task.ref.revision.length === 0 ||
      task.originalBlock !== task.markdown
    ) {
      fail(`TaskRef/source evidence mismatch for ${task.key}`);
    }
  }
  const objectIdentities = new Set<object>();
  for (const value of [
    ...fixture.projects,
    ...fixture.workNotes,
    ...fixture.tasks,
    ...fixture.directProjectTasks,
  ]) {
    if (objectIdentities.has(value)) fail('accidental object aliasing');
    objectIdentities.add(value);
  }
  if (
    !Object.isFrozen(fixture) ||
    !Object.isFrozen(fixture.workNotes[0]?.frontmatter) ||
    !fixture.executionTasks.every(
      (task) =>
        Object.isFrozen(task) && Object.isFrozen(task.ref) && Object.isFrozen(task.dependsOn),
    ) ||
    !fixture.projects.every(
      (project) => Object.isFrozen(project) && Object.isFrozen(project.frontmatter),
    )
  ) {
    fail('fixture is not deeply frozen');
  }
}

export const PROJECTS_SCALE_FIXTURE = deepFreeze(scaleFixture);
assertProjectsScaleFixture(PROJECTS_SCALE_FIXTURE);
