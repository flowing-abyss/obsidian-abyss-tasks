import { Platform } from 'obsidian';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

async function loadDesktopNodeModules() {
  if (!Platform.isDesktop) throw new Error('Task consumer contracts require a desktop test host');
  return { fs: await import('node:fs'), path: await import('node:path') };
}

const node = await loadDesktopNodeModules();
const resolve = (...paths: string[]): string => node.path.resolve(...paths);
const dirname = (path: string): string => node.path.dirname(path);
const existsSync = (path: string): boolean => node.fs.existsSync(path);

const ROOT = resolve(import.meta.dirname, '../..');

const FINAL_CONSUMERS = [
  'src/main.ts',
  'src/code-block/registerCodeBlock.ts',
  'src/settings/SettingsTab.ts',
  'src/projects/ProjectStore.ts',
  'src/views/PanelView.ts',
  'src/panels/CenterPanel.ts',
  'src/panels/LeftPanel.ts',
  'src/panels/RightPanel.ts',
  'src/ui/CalendarRenderer.ts',
  'src/ui/TaskModal.ts',
] as const;

const LEGACY_TESTS = [
  'test/task-store.test.ts',
  'test/task-store-deep.test.ts',
  'test/task-store-notice.test.ts',
  'test/task-date-index.test.ts',
  'test/blockquote-tasks.test.ts',
  'test/panel-view.test.ts',
  'test/register-code-block-deep.test.ts',
  'test/center-panel-integration.test.ts',
] as const;

const REMOVED_COMPATIBILITY_FILES = [
  'src/store/TaskStore.ts',
  'src/store/TaskDateIndex.ts',
  'src/tasks/compat/legacyTaskView.ts',
] as const;

const REMOVED_COMPATIBILITY_BINDINGS = new Set([
  'TaskStore',
  'LegacyTaskCommentView',
  'LegacySubtaskView',
  'LegacyTaskView',
  'legacyTaskView',
  'legacyTaskViews',
  'taskRefOf',
  'rebuildLegacyTaskStack',
  'configuredTaskStore',
]);

const PARSER_GRAMMAR_TESTS = new Set([
  'test/blockquote-tasks.test.ts',
  'test/duration-field.test.ts',
  'test/parser.test.ts',
  'test/status-symbol-validation.test.ts',
  'test/subitem-parser-deep.test.ts',
  'test/subitem-parser.test.ts',
  'test/task-parser-deep.test.ts',
]);

const CALENDAR_PROJECTION_CONSUMERS = new Set([
  'src/panels/CenterPanel.ts',
  'src/ui/CalendarRenderer.ts',
]);

function source(path: string): string {
  return node.fs.readFileSync(resolve(ROOT, path), 'utf8');
}

function matchingFiles(paths: readonly string[], pattern: RegExp): string[] {
  return paths.filter((path) => pattern.test(source(path)));
}

function typeScriptFiles(directory: string): string[] {
  return node.fs.readdirSync(resolve(ROOT, directory), { withFileTypes: true }).flatMap((entry) => {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) return typeScriptFiles(path);
    return entry.isFile() && entry.name.endsWith('.ts') ? [path] : [];
  });
}

function sourceFile(path: string, candidate: string): ts.SourceFile {
  return ts.createSourceFile(path, candidate, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function moduleSpecifiers(path: string, candidate: string): string[] {
  const specifiers: string[] = [];
  const record = (node: ts.Node | undefined): void => {
    if (node != null && ts.isStringLiteralLike(node)) specifiers.push(node.text);
  };
  const visit = (node: ts.Node): void => {
    record(moduleSpecifierNode(node));
    ts.forEachChild(node, visit);
  };

  visit(sourceFile(path, candidate));
  return specifiers;
}

function moduleSpecifierNode(node: ts.Node): ts.Node | undefined {
  return declarationModuleSpecifier(node) ?? typeModuleSpecifier(node) ?? callModuleSpecifier(node);
}

function declarationModuleSpecifier(node: ts.Node): ts.Node | undefined {
  if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return node.moduleSpecifier;
  if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
    return node.moduleReference.expression;
  }
  if (ts.isModuleDeclaration(node) && ts.isStringLiteral(node.name)) return node.name;
  return undefined;
}

function typeModuleSpecifier(node: ts.Node): ts.Node | undefined {
  if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument))
    return node.argument.literal;
  return undefined;
}

function callModuleSpecifier(node: ts.Node): ts.Node | undefined {
  if (!ts.isCallExpression(node)) return undefined;
  const dynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
  const commonJsRequire = ts.isIdentifier(node.expression) && node.expression.text === 'require';
  return dynamicImport || commonJsRequire ? node.arguments[0] : undefined;
}

function namedImports(path: string, candidate: string): string[] {
  const names: string[] = [];
  const module = sourceFile(path, candidate);
  for (const statement of module.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings == null || !ts.isNamedImports(bindings)) continue;
    for (const binding of bindings.elements)
      names.push(binding.propertyName?.text ?? binding.name.text);
  }
  return names;
}

function moduleStem(path: string): string {
  return path.replace(/\.(?:[cm]?[jt]sx?)$/u, '');
}

const REMOVED_MODULE_STEMS = new Set(
  REMOVED_COMPATIBILITY_FILES.map((path) => moduleStem(resolve(ROOT, path))),
);

function resolvedModuleStem(path: string, specifier: string): string | undefined {
  let absolute: string;
  if (specifier.startsWith('.')) {
    absolute = resolve(dirname(resolve(ROOT, path)), specifier);
  } else if (specifier.startsWith('@/')) {
    absolute = resolve(ROOT, 'src', specifier.slice(2));
  } else if (specifier.startsWith('src/')) {
    absolute = resolve(ROOT, specifier);
  } else if (specifier.startsWith('/')) {
    absolute = resolve(specifier);
  } else {
    return undefined;
  }
  return moduleStem(absolute);
}

function removedModuleReferences(path: string, candidate: string): string[] {
  return moduleSpecifiers(path, candidate).filter((specifier) => {
    const resolved = resolvedModuleStem(path, specifier);
    return resolved !== undefined && REMOVED_MODULE_STEMS.has(resolved);
  });
}

function isRemovedBindingIdentifier(node: ts.Identifier): boolean {
  if (!REMOVED_COMPATIBILITY_BINDINGS.has(node.text)) return false;
  const parent = node.parent;
  if (!REMOVED_BINDING_PARENT_KINDS.has(parent.kind)) return false;
  return (parent as ts.Node & { readonly name?: ts.Node }).name === node;
}

const REMOVED_BINDING_PARENT_KINDS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.ImportClause,
  ts.SyntaxKind.ImportSpecifier,
  ts.SyntaxKind.NamespaceImport,
  ts.SyntaxKind.ImportEqualsDeclaration,
  ts.SyntaxKind.ClassDeclaration,
  ts.SyntaxKind.ClassExpression,
  ts.SyntaxKind.InterfaceDeclaration,
  ts.SyntaxKind.TypeAliasDeclaration,
  ts.SyntaxKind.FunctionDeclaration,
  ts.SyntaxKind.FunctionExpression,
  ts.SyntaxKind.EnumDeclaration,
  ts.SyntaxKind.ModuleDeclaration,
  ts.SyntaxKind.VariableDeclaration,
  ts.SyntaxKind.BindingElement,
  ts.SyntaxKind.Parameter,
]);

function knipIgnoreEntries(): readonly unknown[] {
  const parsed = ts.parseConfigFileTextToJson('knip.jsonc', source('knip.jsonc'));
  if (parsed.error !== undefined) throw new Error('knip.jsonc must be valid JSONC');
  const config: unknown = parsed.config;
  if (config == null || typeof config !== 'object') return [];
  const ignore: unknown = (config as Record<string, unknown>)['ignore'];
  return Array.isArray(ignore) ? ignore : [];
}

function removedBindings(path: string, candidate: string): string[] {
  const bindings: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && isRemovedBindingIdentifier(node)) bindings.push(node.text);
    ts.forEachChild(node, visit);
  };
  visit(sourceFile(path, candidate));
  return bindings;
}

describe('final task consumer contract', () => {
  const productionFiles = typeScriptFiles('src');
  const testFiles = typeScriptFiles('test').filter(
    (path) => path !== 'test/tasks/task-consumer-contract.test.ts',
  );
  const productionConsumers = productionFiles;
  const presentationConsumers = productionConsumers.filter((path) =>
    /^(?:src\/main\.ts|src\/(?:app|code-block|domain|panels|projects|settings|ui|views)\/)/u.test(
      path,
    ),
  );
  const taskMutationConsumers = presentationConsumers.filter(
    (path) =>
      /^(?:src\/main\.ts|src\/(?:code-block|panels|ui|views)\/)/u.test(path) ||
      path === 'src/settings/SettingsTab.ts' ||
      path === 'src/projects/ProjectStore.ts',
  );

  it('permanently removes compatibility files and their Knip ignores', () => {
    const existingCompatibilityFiles = REMOVED_COMPATIBILITY_FILES.filter((path) =>
      existsSync(resolve(ROOT, path)),
    );
    const knipIgnores = knipIgnoreEntries();

    expect({ existingCompatibilityFiles, knipIgnores }).toEqual({
      existingCompatibilityFiles: [],
      knipIgnores: [],
    });
  });

  it('keeps production and tests independent of the exact removed module paths', () => {
    const references = [...productionFiles, ...testFiles].flatMap((path) =>
      removedModuleReferences(path, source(path)).map((specifier) => `${path}: ${specifier}`),
    );

    expect(references).toEqual([]);
  }, 15_000);

  it('recognizes removed paths through aliases, source suffixes, and TypeScript module forms', () => {
    const candidates = [
      ['src/example.ts', "import { createStore as oldStore } from './store/TaskStore.js';"],
      ['src/example.ts', "export { oldIndex as Index } from './store/TaskDateIndex.mjs';"],
      ['test/example.ts', "import type { OldView } from '../src/tasks/compat/legacyTaskView';"],
      ['test/example.ts', "import Old = require('../src/store/TaskStore.cjs');"],
      ['test/example.ts', "type Old = import('../src/store/TaskDateIndex.mts').Index;"],
      ['test/example.ts', "void import('../src/tasks/compat/legacyTaskView.js');"],
      ['test/example.ts', "require('../src/store/TaskStore.ts');"],
      ['test/example.ts', "declare module '../src/store/TaskDateIndex.js' {}"],
    ] as const;

    expect(
      candidates.flatMap(([path, candidate]) => removedModuleReferences(path, candidate)),
    ).toHaveLength(candidates.length);
  });

  it('rejects actual removed compatibility bindings without matching properties or text', () => {
    expect(
      removedBindings(
        'src/example.ts',
        'class TaskStore {}\ninterface LegacyTaskView {}\nconst configuredTaskStore = {};',
      ),
    ).toEqual(['TaskStore', 'LegacyTaskView', 'configuredTaskStore']);

    const harmless = `
      // import { TaskStore } from './store/TaskStore';
      const documentation = 'TaskStore and LegacyTaskView';
      const metadata = { TaskStore: documentation, LegacyTaskView: true };
    `;
    expect(removedModuleReferences('src/example.ts', harmless)).toEqual([]);
    expect(removedBindings('src/example.ts', harmless)).toEqual([]);
  });

  it('keeps production and tests free of recreated removed compatibility bindings', () => {
    const bindings = [...productionFiles, ...testFiles].flatMap((path) =>
      removedBindings(path, source(path)).map((binding) => `${path}: ${binding}`),
    );

    expect(bindings).toEqual([]);
  }, 15_000);

  it('keeps the final read model independent of legacy parser projections and task shapes', () => {
    const finalReadModel = productionFiles.filter((path) =>
      /^src\/tasks\/(?:application|domain|infrastructure)\//u.test(path),
    );
    const forbidden =
      /(?:parser\/legacyTaskProjection|parser\/SubItemParser|from ['"][^'"]*parser\/types['"])/u;

    expect(matchingFiles(finalReadModel, forbidden)).toEqual([]);
  });

  it('keeps applicable presentation consumers independent of legacy parser task views', () => {
    expect(matchingFiles(presentationConsumers, /from ['"][^'"]*parser\/types['"]/u)).toEqual([]);
    expect(FINAL_CONSUMERS.every((path) => presentationConsumers.includes(path))).toBe(true);
  });

  it('ports every named legacy behavioral suite off compatibility modules', () => {
    const references = LEGACY_TESTS.flatMap((path) =>
      removedModuleReferences(path, source(path)).map((specifier) => `${path}: ${specifier}`),
    );
    const bindings = LEGACY_TESTS.flatMap((path) =>
      removedBindings(path, source(path)).map((binding) => `${path}: ${binding}`),
    );

    expect({ references, bindings }).toEqual({ references: [], bindings: [] });
  });

  it('keeps non-parser tests and shared fixtures on final snapshot shapes only', () => {
    const consumers = testFiles.filter((path) => !PARSER_GRAMMAR_TESTS.has(path));
    const forbidden =
      /(?:from ['"][^'"]*parser\/types['"]|\bTask\s*&\s*TaskSnapshot\b|\bSubTask\s*&\s*SubtaskSnapshot\b|\bTaskComment\s*&\s*TaskCommentSnapshot\b)/u;

    expect(matchingFiles(consumers, forbidden)).toEqual([]);
  });

  it('keeps task-scoped vault writes out of production consumers', () => {
    expect(matchingFiles(taskMutationConsumers, /\.vault\.process\s*\(/u)).toEqual([]);
  });

  it('confines projection adapters to the two calendar composition roots', () => {
    const projectionBindings = new Set([
      'projectCalendarOccurrences',
      'taskSnapshotForCalendarOccurrence',
    ]);
    const consumers = productionFiles.filter((path) =>
      namedImports(path, source(path)).some((name) => projectionBindings.has(name)),
    );

    expect(new Set(consumers)).toEqual(CALENDAR_PROJECTION_CONSUMERS);
    expect(
      [...CALENDAR_PROJECTION_CONSUMERS].every(
        (path) =>
          namedImports(path, source(path)).filter((name) => projectionBindings.has(name)).length ===
          projectionBindings.size,
      ),
    ).toBe(true);
  });

  it('keeps premature statistics and time-tracking presentation absent', () => {
    const production = productionFiles.map(source).join('\n');
    expect(production).not.toMatch(/estimateMin|spentMin|formatMinutes/u);
  });
});
