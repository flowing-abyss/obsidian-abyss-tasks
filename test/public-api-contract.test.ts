// @vitest-environment node
import ts from 'typescript';
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { TasksApiV1 } from '../api';
import type { TaskReadClientV1 } from '../src/integrations/TaskApiProvider';
import { TYPESCRIPT_PROGRAM_TIMEOUT_MS } from './support/timeouts';

const fixture = ts.sys.resolvePath('test/fixtures/public-api-consumer/tsconfig.json');

function compileConsumer(extraSource?: string): readonly ts.Diagnostic[] {
  const config = ts.readConfigFile(fixture, (path) => ts.sys.readFile(path));
  const parsed = ts.parseJsonConfigFileContent(
    config.config,
    ts.sys,
    fixture.slice(0, fixture.lastIndexOf('/')),
  );
  const virtualFile = fixture.replace('tsconfig.json', 'negative.ts');
  const baseHost = ts.createCompilerHost(parsed.options);
  const host: ts.CompilerHost = {
    ...baseHost,
    getSourceFile: (fileName, languageVersion, onError, shouldCreateNewSourceFile) =>
      fileName === virtualFile && extraSource !== undefined
        ? ts.createSourceFile(fileName, extraSource, languageVersion, true)
        : baseHost.getSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile),
    fileExists: (path) => path === virtualFile || baseHost.fileExists(path),
  };
  const files = extraSource === undefined ? parsed.fileNames : [...parsed.fileNames, virtualFile];
  const program = ts.createProgram(files, parsed.options, host);
  return [...parsed.errors, ...ts.getPreEmitDiagnostics(program)];
}

describe('portable public API contract', () => {
  it(
    'compiles a strict consumer without DOM, host or implementation types',
    () => {
      expect(
        compileConsumer().map((item) => ts.flattenDiagnosticMessageText(item.messageText, '\n')),
      ).toEqual([]);
    },
    TYPESCRIPT_PROGRAM_TIMEOUT_MS,
  );

  it(
    'compiles every TypeScript example in the API guide as one strict consumer',
    () => {
      const guide = ts.sys.readFile('API.md') ?? '';
      const blocks = [...guide.matchAll(/```ts\n([\s\S]*?)```/g)];
      expect(blocks.length).toBeGreaterThan(0);
      const source = blocks
        .map((match) => match[1])
        .join('\n')
        .replace("from './api'", "from '../../../api'");
      expect(
        compileConsumer(source).map((item) =>
          ts.flattenDiagnosticMessageText(item.messageText, '\n'),
        ),
      ).toEqual([]);
    },
    TYPESCRIPT_PROGRAM_TIMEOUT_MS,
  );

  it.each([
    ['readonly project', "project.path = 'other.md';", 2540],
    [
      'invalid field value',
      "const assignment: ProjectFieldAssignmentV1 = { fieldId: 'start', value: { raw: 'x' } };",
      2353,
    ],
    ['readonly dates', "task.dates.due = '2026-11-04';", 2540],
    ['readonly pages', 'page.items.push(task);', 2339],
    ['private raw source', 'task.rawBlock;', 2339],
    ['unsupported status', "const status: TaskDtoV1['status'] = 'waiting';", 2322],
  ])(
    'rejects %s in external consumer code',
    (_name, expression, expectedCode) => {
      const source = [
        "import type { TaskDtoV1, TaskPageV1, ProjectDtoV1, ProjectFieldAssignmentV1 } from '../../../api';",
        'declare const task: TaskDtoV1;',
        'declare const page: TaskPageV1;',
        'declare const project: ProjectDtoV1;',
        expression,
      ].join('\n');
      expect(compileConsumer(source).map((diagnostic) => diagnostic.code)).toEqual([expectedCode]);
    },
    TYPESCRIPT_PROGRAM_TIMEOUT_MS,
  );

  it('imports only the standalone contract and keeps declarations self-contained', () => {
    const consumer = ts.createSourceFile(
      'consumer.ts',
      ts.sys.readFile(fixture.replace('tsconfig.json', 'consumer.ts')) ?? '',
      ts.ScriptTarget.Latest,
      true,
    );
    const imports = consumer.statements
      .filter(ts.isImportDeclaration)
      .map((node) => (ts.isStringLiteral(node.moduleSpecifier) ? node.moduleSpecifier.text : ''));
    expect(imports).toEqual(['../../../api']);
    const declaration = ts.createSourceFile(
      'api.d.ts',
      ts.sys.readFile('api.d.ts') ?? '',
      ts.ScriptTarget.Latest,
      true,
    );
    expect(
      declaration.statements.every(
        (node) => ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node),
      ),
    ).toBe(true);
  });
});

it('keeps the inward read-method projection limited to the canonical read contract', () => {
  expectTypeOf<TaskReadClientV1>().toEqualTypeOf<
    Omit<TasksApiV1, 'tasks'> & {
      readonly tasks: Pick<TasksApiV1['tasks'], 'list' | 'get' | 'resolve' | 'statuses'>;
    }
  >();
});
