import { ESLint } from 'eslint';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const root = ts.sys.resolvePath(`${import.meta.dirname}/..`);
const eslint = new ESLint({ cwd: root, overrideConfigFile: `${root}/eslint.config.mts` });
const pureFiles = [
  'src/projects/projectTableModel.ts',
  'src/projects/projectKanbanModel.ts',
  'src/projects/projectTimelineModel.ts',
  'src/projects/projectTimelineAxis.ts',
  'src/projects/projectTimelineEdits.ts',
  'src/panels/projects/projectTableViewport.ts',
];
async function check(file: string, source: string) {
  const [result] = await eslint.lintText(source, { filePath: `${root}/${file}` });
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
    30_000,
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
  ])('rejects UI global value %s', async (name) => {
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
  });

  it.each(['fetch', 'XMLHttpRequest', 'WebSocket', 'performance', 'globalThis', 'self', 'Date'])(
    'rejects pure capability escapes %s',
    async (name) => {
      expect(await check(pureFiles[0] ?? '', `void ${name};`)).toHaveLength(1);
    },
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
  );

  it.each([
    ['Date["now"]();', 1, 5],
    ['const clock = Date.now;', 15, 19],
    ['new Date(Date.now());', 10, 14],
    ['Date();', 1, 5],
    ['Date[UTC]();', 1, 5],
    ['const { now } = Date;', 17, 21],
  ])('rejects ambient aliases and nested clock access: %s', async (source, column, endColumn) => {
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
  });

  it('accepts imported value bindings that share ambient names', async () => {
    expect(
      await check(
        'src/projects/projectTableModel.ts',
        `
      import { window, document, Date, setTimeout } from 'local-capabilities';
      window.dayCount; document.title; Date.now(); setTimeout();
    `,
      ),
    ).toEqual([]);
  });

  it('accepts owner capabilities and local shadowing in UI', async () => {
    expect(
      await check(
        'src/panels/projects/ProjectCellEditor.ts',
        `
      function schedule(ownerWindow: Window, window: Window) {
        ownerWindow.setTimeout(() => {}, 0); window.requestAnimationFrame(() => {});
      }
      type Types = [Window, Document, ResizeObserver];
    `,
      ),
    ).toEqual([]);
  });
});
