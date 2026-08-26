export interface ProjectsScaleTaskRecord {
  readonly key: string;
  readonly line: number;
  readonly markdown: string;
}

export interface ProjectsScaleWorkNote {
  readonly path: string;
  readonly kind: 'ordinary' | 'milestone';
  readonly projectPath: string;
  readonly rawStatus: string;
  readonly tags: readonly string[];
  readonly frontmatter: Readonly<Record<string, unknown>>;
  readonly tasks: readonly ProjectsScaleTaskRecord[];
  readonly taskCount: number;
  readonly anomaly?: 'unknown-status' | 'broken-project' | 'duplicate-project-basename';
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
  const projectPath = `Projects/Project ${String((index % 40) + 1).padStart(2, '0')}.md`;
  const rawStatus = anomaly === 'unknown-status' ? 'Review' : index % 5 === 0 ? 'Done' : 'Active';
  const tasks = Object.freeze(
    Array.from({ length: index < 50 ? 20 : 0 }, (_, taskIndex) =>
      Object.freeze({
        key: `${path}\0${String(taskIndex + 1)}`,
        line: taskIndex,
        markdown: `- [ ] Task ${String(taskIndex + 1)} for work note ${String(ordinal)}`,
      }),
    ),
  );
  const rawProject =
    anomaly === 'broken-project'
      ? '[[Projects/Missing]]'
      : anomaly === 'duplicate-project-basename'
        ? '[[A]]'
        : `[[${projectPath.replace(/\.md$/u, '')}]]`;
  return Object.freeze({
    path,
    kind,
    projectPath,
    rawStatus,
    tags: Object.freeze([`#work-note/${kind === 'milestone' ? 'milestone' : 'task'}`]),
    frontmatter: Object.freeze({ Project: rawProject, Status: rawStatus, ID: `WN-${ordinal}` }),
    tasks,
    taskCount: tasks.length,
    ...(anomaly && { anomaly }),
  });
});

const expectedEligible = workNotes.filter(
  ({ anomaly }) => anomaly !== 'broken-project' && anomaly !== 'duplicate-project-basename',
);
const expectedExcluded = workNotes
  .filter(({ anomaly }) => anomaly === 'broken-project' || anomaly === 'duplicate-project-basename')
  .map(({ path, anomaly }) => Object.freeze({ path, reason: anomaly! }));
const expectedTaskKeys = workNotes.flatMap(({ tasks }) => tasks.map(({ key }) => key));

export const PROJECTS_SCALE_FIXTURE = Object.freeze({
  workNotes: Object.freeze(workNotes),
  allWorkNotePaths: Object.freeze(workNotes.map(({ path }) => path)),
  expectedWorkNotePaths: Object.freeze(expectedEligible.map(({ path }) => path)),
  expectedEligibleWorkNotePaths: Object.freeze(expectedEligible.map(({ path }) => path)),
  expectedExcludedWorkNotes: Object.freeze(expectedExcluded),
  expectedEligibleCounts: Object.freeze(
    Object.fromEntries(expectedEligible.map(({ path }) => [path, 1] as const)),
  ),
  expectedTaskKeys: Object.freeze(expectedTaskKeys),
  serviceFalsePositives: Object.freeze([
    Object.freeze({
      path: 'Aggregates/Service rollup.md',
      tags: Object.freeze([]),
      frontmatter: Object.freeze({
        Project: '[[Projects/Project 01]]',
        Status: 'Active',
      }),
    }),
    Object.freeze({
      path: 'Templates/Work note service.md',
      tags: Object.freeze([]),
      frontmatter: Object.freeze({
        Project: '[[Projects/Project 02]]',
        Status: 'Active',
      }),
    }),
  ]),
  projectFiles: Object.freeze([
    ...Array.from({ length: 40 }, (_, index) =>
      Object.freeze({
        path: `Projects/Project ${String(index + 1).padStart(2, '0')}.md`,
        tags: Object.freeze([]),
        frontmatter: Object.freeze({}),
      }),
    ),
    Object.freeze({
      path: 'Projects/A.md',
      tags: Object.freeze([]),
      frontmatter: Object.freeze({}),
    }),
    Object.freeze({
      path: 'Archive/A.md',
      tags: Object.freeze([]),
      frontmatter: Object.freeze({}),
    }),
  ]),
  duplicateProjectBasenames: Object.freeze(['Projects/A.md', 'Archive/A.md']),
  brokenProjectLinks: Object.freeze(['[[Projects/Missing]]']),
});
