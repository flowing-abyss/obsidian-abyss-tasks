import * as obsidian from 'obsidian';
import { Platform } from 'obsidian';
import ts from 'typescript';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type TaskCalendarPlugin from '../src/main';
import { useRealMoment } from './helpers';

const loadNodeTools = async () => {
  if (!Platform.isDesktop) throw new Error('Artifact tests require a desktop runtime');
  return Promise.all([
    import('node:child_process'),
    import('node:fs'),
    import('node:os'),
    import('node:path'),
    import('node:vm'),
  ]);
};
const [
  { spawnSync },
  { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync },
  { tmpdir },
  path,
  { compileFunction },
] = await loadNodeTools();

useRealMoment();

const root = process.cwd();
const suffix = '_abyssPrivate';
const privateOwners = new Set([
  'AsyncEditLifecycle',
  'CenterPanel',
  'RightPanel',
  'PanelView',
  'CalendarSettingsTab',
  'ObsidianTaskRepository',
  'CalendarRenderer',
  'RecurrenceEditorController',
  'AnchoredRecurrenceEditorController',
  'LeftPanel',
  'TaskIndex',
  'TaskApplicationService',
  'TaskModal',
  'TaskMoveRecoveryModal',
  'DatePickerLifecycle',
  'StatusPopoverLifecycle',
  'LinkEditModal',
  'NoteSuggest',
  'TagPickerModal',
  'TagGroupAppearanceModal',
]);

function privateOwner(node: ts.Node): string | undefined {
  if (!ts.canHaveModifiers(node)) return undefined;
  if (!(
    ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.PrivateKeyword) ??
    false
  )) {
    return undefined;
  }
  const owner = ts.isParameter(node) ? node.parent.parent : node.parent;
  return ts.isClassDeclaration(owner) ? owner.name?.text : undefined;
}

function suffixSymbol(node: ts.Node, checker: ts.TypeChecker): ts.Symbol | undefined {
  if (ts.isIdentifier(node)) return checker.getSymbolAtLocation(node);
  if (!ts.isStringLiteralLike(node) || !ts.isLiteralTypeNode(node.parent)) return undefined;
  const access = node.parent.parent;
  return ts.isIndexedAccessTypeNode(access)
    ? checker.getTypeFromTypeNode(access.objectType).getProperty(node.text)
    : undefined;
}

function auditedOwner(declaration: ts.Declaration): boolean {
  const owner = privateOwner(declaration);
  return owner !== undefined && privateOwners.has(owner);
}

function suffixText(node: ts.Node): string | undefined {
  if (
    ts.isIdentifier(node) ||
    ts.isStringLiteralLike(node) ||
    ts.isTemplateHead(node) ||
    ts.isTemplateMiddle(node) ||
    ts.isTemplateTail(node)
  ) {
    return node.text.includes(suffix) ? node.text : undefined;
  }
  return undefined;
}

function reflectedOwners(node: ts.Node, checker: ts.TypeChecker): boolean {
  let expressions: readonly ts.Expression[] = [];
  if (ts.isSpreadAssignment(node) || ts.isSpreadElement(node)) expressions = [node.expression];
  if (
    ts.isCallExpression(node) &&
    /^(?:Object\.(?:assign|keys|values|entries|getOwnPropertyNames|defineProperty)|JSON\.stringify|Reflect\.)/u.test(
      node.expression.getText(),
    )
  ) {
    expressions = node.arguments;
  }
  return expressions.some((expression) =>
    checker
      .getTypeAtLocation(expression)
      .getProperties()
      .some((property) => property.name.endsWith(suffix)),
  );
}

describe('production private member boundary', () => {
  let files: string[];
  let program: ts.Program;
  let checker: ts.TypeChecker;

  beforeAll(() => {
    files = ts.sys.readDirectory(path.join(root, 'src'), ['.ts']);
    const config = ts.readConfigFile(path.join(root, 'tsconfig.json'), (file) =>
      ts.sys.readFile(file),
    ) as {
      config: object;
    };
    const options = ts.parseJsonConfigFileContent(config.config, ts.sys, root).options;
    program = ts.createProgram(files, options);
    checker = program.getTypeChecker();
  });

  it('reserves the mangling suffix for explicit private declarations in audited owners', () => {
    const foundOwners = new Set<string>();
    const violations: string[] = [];
    for (const source of program.getSourceFiles().filter((file) => files.includes(file.fileName))) {
      const file = source.fileName;
      function visit(node: ts.Node): void {
        if (reflectedOwners(node, checker)) violations.push(`${file}: reflected private owner`);
        const text = suffixText(node);
        if (text !== undefined) {
          const declarations = suffixSymbol(node, checker)?.getDeclarations() ?? [];
          if (declarations.length === 0 || !declarations.every(auditedOwner)) {
            violations.push(`${file}: unresolved, quoted or public private key ${text}`);
          }
          for (const declaration of declarations) {
            const owner = privateOwner(declaration);
            if (owner !== undefined) foundOwners.add(owner);
          }
        }
        ts.forEachChild(node, visit);
      }
      visit(source);
    }
    expect(violations).toEqual([]);
    expect(foundOwners).toEqual(privateOwners);
  });
});

describe('production JavaScript artifact', () => {
  let directory: string;
  let code: string;
  let buildStatus: number | null;
  let buildError: string;

  beforeAll(() => {
    directory = mkdtempSync(path.join(tmpdir(), 'abyss-production-artifact-'));
    for (const file of ['src', 'tsconfig.json']) {
      symlinkSync(path.join(root, file), path.join(directory, file));
    }
    writeFileSync(
      path.join(directory, 'package.json'),
      readFileSync(path.join(root, 'package.json')),
    );
    const result = spawnSync(
      process.execPath,
      [path.join(root, 'esbuild.config.mjs'), 'production'],
      {
        cwd: directory,
        encoding: 'utf8',
      },
    );
    buildStatus = result.status;
    buildError = result.stderr;
    code = readFileSync(path.join(directory, 'main.js'), 'utf8');
  });

  afterAll(() => {
    rmSync(directory, { recursive: true, force: true });
    delete (window as unknown as Record<string, unknown>)['renderCalendar'];
  });

  it('builds the complete plugin within the shared release budget', () => {
    const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as {
      release: { mainJsBudgetBytes: number };
    };
    expect(buildStatus, buildError).toBe(0);
    expect(Buffer.byteLength(code)).toBeLessThanOrEqual(pkg.release.mainJsBudgetBytes);
    expect(code).not.toContain(suffix);
  });

  it('keeps lifecycle, task API, and persisted property names in the bundle', () => {
    for (const key of [
      'onload',
      'onunload',
      'onOpen',
      'onClose',
      'getViewType',
      'getDisplayText',
      'display',
      'execute',
      'editBatch',
      'listNodes',
      'dependencies',
      'dependsOn',
      'dependencyId',
      'revision',
      'outcomeTarget',
      'taskStatuses',
      'taskLifecycle',
      'recurrence',
    ]) {
      expect(new RegExp(`\\b${key}\\b`, 'u').test(code), key).toBe(true);
    }
  });

  it('loads the actual CommonJS artifact through the Obsidian entry point', async () => {
    type LoadedModule = { exports: { default: typeof TaskCalendarPlugin } };
    const module = { exports: {} } as LoadedModule;
    const execute = compileFunction(code, ['module', 'exports', 'require']) as (
      module: LoadedModule,
      exports: LoadedModule['exports'],
      require: (id: string) => typeof obsidian,
    ) => void;
    execute(module, module.exports, (id) => {
      if (id !== 'obsidian') throw new Error(`Unexpected runtime dependency: ${id}`);
      return obsidian;
    });
    const app = new obsidian.App();
    (app.workspace as unknown as { layoutReady: boolean }).layoutReady = false;
    const plugin = new module.exports.default(app, {
      id: 'abyss-tasks',
      name: 'Abyss Tasks',
      author: 'Fixture',
      version: '1.0.0',
      minAppVersion: '1.0.0',
      description: 'Production artifact test',
    });
    try {
      await plugin.onload();
      expect(plugin.queries.list()).toEqual([]);
      expect(plugin.queries.listNodes()).toEqual([]);
      expect(plugin.settings.taskStatuses.length).toBeGreaterThan(0);
      expect(typeof plugin.tasks.execute).toBe('function');
      expect((window as unknown as Record<string, unknown>)['renderCalendar']).toBeTypeOf(
        'function',
      );
    } finally {
      plugin.onunload();
    }
  });
});
