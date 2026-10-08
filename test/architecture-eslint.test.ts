// @vitest-environment node
import { ESLint } from 'eslint';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { LINTER_TIMEOUT_MS } from './support/timeouts';

const ROOT = ts.sys.resolvePath(`${import.meta.dirname}/..`);
const eslint = new ESLint({
  cwd: ROOT,
  overrideConfigFile: ts.sys.resolvePath(`${ROOT}/eslint.config.mts`),
});
const ARCHITECTURE_RULES = new Set([
  'no-restricted-imports',
  'no-restricted-syntax',
  'no-restricted-globals',
]);

interface Diagnostic {
  readonly ruleId: string | null;
  readonly message: string;
  readonly fatal?: boolean;
}

async function diagnostics(path: string, source: string): Promise<readonly Diagnostic[]> {
  const [result] = await eslint.lintText(source, {
    filePath: ts.sys.resolvePath(`${ROOT}/${path}`),
  });
  return (
    result?.messages.map(({ ruleId, message, fatal }) => ({
      ruleId,
      message,
      ...(fatal === undefined ? {} : { fatal }),
    })) ?? []
  );
}

function architectureDiagnostics(items: readonly Diagnostic[]) {
  return items
    .filter((item) => item.ruleId !== null && ARCHITECTURE_RULES.has(item.ruleId))
    .map(({ ruleId, message }) => ({ ruleId, message }));
}

function expectParseSafe(items: readonly Diagnostic[]): void {
  expect(items.some((item) => item.fatal === true || item.ruleId === null)).toBe(false);
}

describe('task architecture ESLint boundaries', () => {
  it.each([
    ['src/tasks/infrastructure/TaskIndex.ts', "import '@vendor/ui/widget';"],
    ['src/ui/StatusMarker.ts', "import '@vendor/tasks/domain';"],
  ])(
    'does not classify an external package as a local layer from %s',
    async (path, source) => {
      const items = await diagnostics(path, source);
      expectParseSafe(items);
      expect(architectureDiagnostics(items)).toEqual([]);
    },
    LINTER_TIMEOUT_MS,
  );

  it.each([
    [
      'src/tasks/infrastructure/TaskIndex.ts',
      "import '../../ui/StatusMarker';",
      {
        ruleId: 'no-restricted-imports',
        message:
          "'../../ui/StatusMarker' import is restricted from being used by a pattern. Task infrastructure must not depend on presentation modules.",
      },
    ],
    [
      'src/ui/StatusMarker.ts',
      "import '../tasks/domain/types';",
      {
        ruleId: 'no-restricted-imports',
        message:
          "'../tasks/domain/types' import is restricted from being used by a pattern. Presentation imports task contracts only through src/tasks/index.ts.",
      },
    ],
    [
      'src/settings/sections/ShortcutSettings.ts',
      "import '../../tasks/domain/types';",
      {
        ruleId: 'no-restricted-imports',
        message:
          "'../../tasks/domain/types' import is restricted from being used by a pattern. Presentation imports task contracts only through src/tasks/index.ts.",
      },
    ],
    [
      'src/settings/sections/TaskStatusSettings.ts',
      "import '../../tasks/domain/types';",
      {
        ruleId: 'no-restricted-imports',
        message:
          "'../../tasks/domain/types' import is restricted from being used by a pattern. Presentation imports task contracts only through src/tasks/index.ts.",
      },
    ],
    [
      'src/tasks/domain/taskSearchProjection.ts',
      "import '../application/TaskSearchApi';",
      {
        ruleId: 'no-restricted-imports',
        message:
          "'../application/TaskSearchApi' import is restricted from being used by a pattern. Task domain may import sibling domain modules and shared pure tag syntax.",
      },
    ],
    [
      'src/panels/center/TaskSearch.ts',
      "import '../../tasks/application/TaskSearchSource';",
      {
        ruleId: 'no-restricted-imports',
        message:
          "'../../tasks/application/TaskSearchSource' import is restricted from being used by a pattern. Presentation imports task contracts only through src/tasks/index.ts.",
      },
    ],
    [
      'src/tasks/domain/validation.ts',
      "import { Notice } from 'obsidian';",
      {
        ruleId: 'no-restricted-imports',
        message:
          "'obsidian' import is restricted from being used by a pattern. Task domain may import sibling domain modules and shared pure tag syntax.",
      },
    ],
    [
      'src/tasks/application/TaskApplicationApi.ts',
      "import { Notice } from 'obsidian';",
      {
        ruleId: 'no-restricted-imports',
        message:
          "'obsidian' import is restricted from being used by a pattern. Task application may depend only on domain contracts and application ports.",
      },
    ],
  ])(
    'rejects a forbidden import at the %s boundary',
    async (path, source, expected) => {
      const items = await diagnostics(path, source);
      expectParseSafe(items);
      expect(architectureDiagnostics(items)).toEqual([expected]);
    },
    LINTER_TIMEOUT_MS,
  );

  it.each([
    [
      'src/tasks/domain/validation.ts',
      'Task domain receives time through explicit values or a Clock port.',
      'Task domain cannot depend on browser ambient state.',
    ],
    [
      'src/tasks/application/TaskApplicationApi.ts',
      'Task application receives time through its Clock port.',
      'Task application cannot depend on browser ambient state.',
    ],
  ])(
    'rejects ambient time and DOM access in %s',
    async (path, timeMessage, domMessage) => {
      const items = await diagnostics(
        path,
        'new Date(); Date(); Date.now(); window.location; document.title;',
      );
      expectParseSafe(items);
      expect(architectureDiagnostics(items)).toEqual([
        { ruleId: 'no-restricted-syntax', message: timeMessage },
        { ruleId: 'no-restricted-syntax', message: timeMessage },
        { ruleId: 'no-restricted-syntax', message: timeMessage },
        {
          ruleId: 'no-restricted-globals',
          message: `Unexpected use of 'window'. ${domMessage}`,
        },
        {
          ruleId: 'no-restricted-globals',
          message: `Unexpected use of 'document'. ${domMessage}`,
        },
      ]);
    },
    LINTER_TIMEOUT_MS,
  );

  it.each([
    'adapter.process(value);',
    "adapter['process'](value);",
    '(adapter.process)(value);',
    'adapter.process!(value);',
    '(adapter.process as (value: unknown) => void)(value);',
    "(adapter['process'])(value);",
    "adapter['process']!(value);",
    "(adapter['process'] as (value: unknown) => void)(value);",
    'adapter?.process?.(value);',
  ])(
    'rejects a presentation-side process reference: %s',
    async (source) => {
      const items = await diagnostics('src/ui/StatusMarker.ts', source);
      expectParseSafe(items);
      expect(architectureDiagnostics(items)).toEqual([
        {
          ruleId: 'no-restricted-syntax',
          message:
            'Presentation sends task commands through TaskApplicationApi; it does not write.',
        },
      ]);
    },
    LINTER_TIMEOUT_MS,
  );
});

// The project lexical policy rows lint through the same instance, so the project service's cold
// start is paid once for both suites. Their rule reads scopes, not types.
const pureFiles = [
  'src/collectionSteps.ts',
  'src/task-lists/TaskListSelector.ts',
  'src/task-lists/taskNodeMembership.ts',
  'src/tasks/domain/taskOccupiedDates.ts',
  'src/tags/effectiveTagGroups.ts',
  'src/task-lists/taskSearchOrganization.ts',
  'src/panels/center/taskSearchDestination.ts',
  'src/tasks/infrastructure/search/taskSearchContext.ts',
  'src/tasks/domain/taskSearchMetadata.ts',
  'src/task-lists/todayTaskCategory.ts',
  'src/tasks/domain/taskSearchTypes.ts',
  'src/tasks/domain/searchMatchPolicy.ts',
  'src/markdown/searchText.ts',
  'src/markdown/searchTextTypes.ts',
  'src/tasks/domain/taskSearchProjection.ts',
  'src/tasks/domain/taskDuration.ts',
  'src/tasks/domain/taskHierarchy.ts',
  'src/tasks/infrastructure/markdown/taskHierarchyTransfer.ts',
  'src/markdown/sourceReferences.ts',
  'src/markdown/fences.ts',
  'src/projects/projectTableModel.ts',
  'src/projects/projectKanbanModel.ts',
  'src/projects/projectTimelineModel.ts',
  'src/projects/projectTimelineAxis.ts',
  'src/projects/projectTimelineEdits.ts',
  'src/panels/projects/projectOverviewCells.ts',
  'src/panels/projects/projectTableSelection.ts',
  'src/panels/projects/projectTableViewport.ts',
  'src/panels/projects/projectKanbanRows.ts',
  'src/panels/projects/projectTimelineRowModel.ts',
  'src/panels/virtualization/rowViewport.ts',
  'src/views/taskGrouping.ts',
  'src/panels/task-list/taskListRows.ts',
  'src/panels/task-list/taskDailyRows.ts',
  'src/panels/task-list/taskRevealRows.ts',
  'src/task-lists/taskLinkValues.ts',
  'src/markdown/linkTarget.ts',
  'src/panels/task-list/taskRowSelection.ts',
  'src/settings/viewStatePaths.ts',
  'src/settings/tagViewState.ts',
  'src/markdown/tagSyntax.ts',
];
async function check(file: string, source: string) {
  const [result] = await eslint.lintText(source, { filePath: `${ROOT}/${file}` });
  expect(result?.messages.filter((item) => item.fatal === true || item.ruleId === null)).toEqual(
    [],
  );
  return result?.messages
    .filter((item) => item.ruleId?.startsWith('project-policy/') === true)
    .map(({ ruleId, messageId, line, column, endLine, endColumn }) => ({
      ruleId,
      messageId,
      line,
      column,
      endLine,
      endColumn,
    }));
}

describe('project lexical policy', () => {
  it.each(pureFiles)(
    'rejects ambient time and browser effects in %s',
    async (file) => {
      const source = 'Date.now();\nnew Date();\ndocument.title;\nsetTimeout(fn, 0);';
      expect(await check(file, source)).toEqual([
        {
          ruleId: 'project-policy/ambient',
          messageId: 'pure',
          line: 1,
          column: 1,
          endLine: 1,
          endColumn: 5,
        },
        {
          ruleId: 'project-policy/ambient',
          messageId: 'pure',
          line: 2,
          column: 5,
          endLine: 2,
          endColumn: 9,
        },
        {
          ruleId: 'project-policy/ambient',
          messageId: 'pure',
          line: 3,
          column: 1,
          endLine: 3,
          endColumn: 9,
        },
        {
          ruleId: 'project-policy/ambient',
          messageId: 'pure',
          line: 4,
          column: 1,
          endLine: 4,
          endColumn: 11,
        },
      ]);
    },
    LINTER_TIMEOUT_MS,
  );

  it(
    'accepts explicit duration and time inputs in the duration domain helper',
    async () => {
      expect(
        await check(
          'src/tasks/domain/taskDuration.ts',
          'export function bounded(duration: number, remaining: number): number { return Math.min(duration, remaining); }',
        ),
      ).toEqual([]);
    },
    LINTER_TIMEOUT_MS,
  );

  it(
    'accepts explicit Today planning and date inputs without ambient state',
    async () => {
      expect(
        await check(
          'src/task-lists/todayTaskCategory.ts',
          'export function category(due: string, today: string): boolean { return due < today; }',
        ),
      ).toEqual([]);
    },
    LINTER_TIMEOUT_MS,
  );

  it.each([
    'window',
    'document',
    'setTimeout',
    'clearTimeout',
    'setInterval',
    'clearInterval',
    'requestAnimationFrame',
    'cancelAnimationFrame',
    'ResizeObserver',
    'queueMicrotask',
  ])(
    'rejects UI global value %s',
    async (name) => {
      expect(await check('src/panels/projects/ProjectCellEditor.ts', `void ${name};`)).toEqual([
        {
          ruleId: 'project-policy/ambient',
          messageId: 'owner',
          line: 1,
          column: 6,
          endLine: 1,
          endColumn: 6 + name.length,
        },
      ]);
    },
    LINTER_TIMEOUT_MS,
  );

  it.each(['ShortcutSettings', 'TaskStatusSettings'])(
    'rejects an ambient window in Settings section %s',
    async (name) => {
      expect(await check(`src/settings/sections/${name}.ts`, 'void window;')).toEqual([
        {
          ruleId: 'project-policy/ambient',
          messageId: 'owner',
          line: 1,
          column: 6,
          endLine: 1,
          endColumn: 12,
        },
      ]);
    },
    LINTER_TIMEOUT_MS,
  );

  it(
    'rejects a bare window in the shared project actions',
    async () => {
      expect(await check('src/ui/projectActions.ts', 'void window;')).toEqual([
        {
          ruleId: 'project-policy/ambient',
          messageId: 'owner',
          line: 1,
          column: 6,
          endLine: 1,
          endColumn: 12,
        },
      ]);
    },
    LINTER_TIMEOUT_MS,
  );

  it(
    'rejects a bare matchMedia call in a project surface',
    async () => {
      expect(
        await check(
          'src/panels/projects/ProjectCellEditor.ts',
          "matchMedia('(prefers-reduced-motion: reduce)').matches;",
        ),
      ).toEqual([
        {
          ruleId: 'project-policy/ambient',
          messageId: 'owner',
          line: 1,
          column: 1,
          endLine: 1,
          endColumn: 11,
        },
      ]);
    },
    LINTER_TIMEOUT_MS,
  );

  it.each(['fetch', 'XMLHttpRequest', 'WebSocket', 'performance', 'globalThis', 'self', 'Date'])(
    'rejects pure capability escapes %s',
    async (name) => {
      expect(await check(pureFiles[0] ?? '', `void ${name};`)).toHaveLength(1);
    },
    LINTER_TIMEOUT_MS,
  );

  it.each(pureFiles)(
    'accepts explicit dates, lexical names and type-only references in %s',
    async (file) => {
      expect(
        await check(
          file,
          `
      const value = new Date(1234);
      Date.UTC(2026, 8, 20); Date.parse('2026-09-20');
      function local(window: { dayCount: number }, document: number, Date: { now(): number }) {
        return window.dayCount + document + Date.now();
      }
      type Types = [Date, Window, Document, ResizeObserver];
      type Scheduler = typeof setTimeout;
      type Observer = typeof ResizeObserver;
    `,
        ),
      ).toEqual([]);
    },
    LINTER_TIMEOUT_MS,
  );

  it.each([
    ['Date["now"]();', 1, 5],
    ['const clock = Date.now;', 15, 19],
    ['new Date(Date.now());', 10, 14],
    ['Date();', 1, 5],
    ['Date[UTC]();', 1, 5],
    ['const { now } = Date;', 17, 21],
  ])(
    'rejects ambient aliases and nested clock access: %s',
    async (source, column, endColumn) => {
      expect(await check('src/projects/projectTableModel.ts', source)).toEqual([
        {
          ruleId: 'project-policy/ambient',
          messageId: 'pure',
          line: 1,
          column,
          endLine: 1,
          endColumn,
        },
      ]);
    },
    LINTER_TIMEOUT_MS,
  );

  it(
    'accepts imported value bindings that share ambient names',
    async () => {
      expect(
        await check(
          'src/projects/projectTableModel.ts',
          `
      import { window, document, Date, setTimeout } from 'local-capabilities';
      window.dayCount; document.title; Date.now(); setTimeout();
    `,
        ),
      ).toEqual([]);
    },
    LINTER_TIMEOUT_MS,
  );

  it(
    'accepts owner capabilities and local shadowing in UI',
    async () => {
      expect(
        await check(
          'src/panels/projects/ProjectCellEditor.ts',
          `
      function schedule(ownerWindow: Window, window: Window) {
        ownerWindow.setTimeout(() => {}, 0); window.requestAnimationFrame(() => {});
        ownerWindow.matchMedia('(prefers-reduced-motion: reduce)');
      }
      type Types = [Window, Document, ResizeObserver];
    `,
        ),
      ).toEqual([]);
    },
    LINTER_TIMEOUT_MS,
  );
});
