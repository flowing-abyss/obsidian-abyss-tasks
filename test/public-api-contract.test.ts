// @vitest-environment node
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
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

  it.each([
    ['readonly dates', "task.dates.due = '2026-11-04';", 2540],
    ['readonly pages', 'page.items.push(task);', 2339],
    ['private raw source', 'task.rawBlock;', 2339],
    ['unsupported status', "const status: TaskDtoV1['status'] = 'waiting';", 2322],
  ])(
    'rejects %s in external consumer code',
    (_name, expression, expectedCode) => {
      const source = [
        "import type { TaskDtoV1, TaskPageV1 } from '../../../api';",
        'declare const task: TaskDtoV1;',
        'declare const page: TaskPageV1;',
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
