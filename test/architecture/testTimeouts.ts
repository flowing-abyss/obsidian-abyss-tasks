import ts from 'typescript';
import {
  CHILD_PROCESS_TIMEOUT_MS,
  LINTER_TIMEOUT_MS,
  SOURCE_WALK_TIMEOUT_MS,
  TYPESCRIPT_PROGRAM_TIMEOUT_MS,
} from '../support/timeouts';
import { isTypeOnlyImport, runtimeReferences, type RuntimeReference } from './runtimeReferences';

// The time limit check. Every row and hook of the files a gate runs names the limit of the largest
// kind of heavy work it reaches, imported by name from test/support/timeouts.ts, and light work
// names none. It reads source text only: it runs no test and measures no time.
//
// A row's or hook's work is every call in its body and its chain's arguments, nested functions
// included, and every declaration a name there binds to, followed transitively across the files
// the check reads: functions, classes, and values with their initializers. Names resolve through
// one TypeScript program over those files, so they bind as the language scopes them. The check
// follows no dynamic property call, no function passed in from a module it does not read, and no
// code in src/, which starts no linter, program, walk, or process.

// Signals, as bits of a mask of the work a row or hook reaches.
const LINTER = 1;
const PROGRAM = 2;
const CHILD = 4;
const LISTING = 8;
const PARSE = 16;

interface Kind {
  readonly work: string;
  readonly limit: string;
  readonly value: number;
  readonly signals: number;
}

/** The kinds of heavy work, in the order findings name them, with the limit each one needs. */
const KINDS: readonly Kind[] = [
  { work: 'linter', limit: 'LINTER_TIMEOUT_MS', value: LINTER_TIMEOUT_MS, signals: LINTER },
  {
    work: 'program',
    limit: 'TYPESCRIPT_PROGRAM_TIMEOUT_MS',
    value: TYPESCRIPT_PROGRAM_TIMEOUT_MS,
    signals: PROGRAM,
  },
  // A walk only where one row's or hook's work both lists a directory and parses TypeScript.
  {
    work: 'walk',
    limit: 'SOURCE_WALK_TIMEOUT_MS',
    value: SOURCE_WALK_TIMEOUT_MS,
    signals: LISTING | PARSE,
  },
  {
    work: 'child process',
    limit: 'CHILD_PROCESS_TIMEOUT_MS',
    value: CHILD_PROCESS_TIMEOUT_MS,
    signals: CHILD,
  },
];

/** Calls that signal their kind by the called name, whatever the name binds to. */
const CALL_SIGNALS: ReadonlyMap<string, number> = new Map([
  ['lintText', LINTER],
  ['lintFiles', LINTER],
  ['isPathIgnored', LINTER],
  ['calculateConfigForFile', LINTER],
  ['createProgram', PROGRAM],
  ['createLanguageService', PROGRAM],
  ['getTypeChecker', PROGRAM],
  ['transpileModule', PROGRAM],
  ['getPreEmitDiagnostics', PROGRAM],
  ['getSemanticDiagnostics', PROGRAM],
  ['getSyntacticDiagnostics', PROGRAM],
  ['getDeclarationDiagnostics', PROGRAM],
  ['getGlobalDiagnostics', PROGRAM],
  ['getTypeAtLocation', PROGRAM],
  ['getSymbolAtLocation', PROGRAM],
  ['getTypeOfSymbolAtLocation', PROGRAM],
  ['getResolvedSignature', PROGRAM],
  ['spawn', CHILD],
  ['spawnSync', CHILD],
  ['execFile', CHILD],
  ['execFileSync', CHILD],
  ['execSync', CHILD],
  ['fork', CHILD],
  ['readDirectory', LISTING],
  ['readdirSync', LISTING],
  ['readdir', LISTING],
  ['opendir', LISTING],
  ['opendirSync', LISTING],
  ['glob', LISTING],
  ['globSync', LISTING],
  ['createSourceFile', PARSE],
]);

const CHILD_PROCESS_EXEC = new Map([['exec', CHILD]]);
const WORKER = new Map([['Worker', CHILD]]);

/**
 * Calls whose names are common, which signal their kind only through a named import, or a
 * destructured `await import()`, of their module. esbuild's service is a child process.
 */
const IMPORTED_SIGNALS: ReadonlyMap<string, ReadonlyMap<string, number>> = new Map([
  ['node:child_process', CHILD_PROCESS_EXEC],
  ['child_process', CHILD_PROCESS_EXEC],
  ['node:worker_threads', WORKER],
  ['worker_threads', WORKER],
  [
    'esbuild',
    new Map([
      ['build', CHILD],
      ['transform', CHILD],
      ['context', CHILD],
    ]),
  ],
]);

const ROWS = new Set(['it', 'test']);
const SUITES = new Set(['describe', 'suite']);
const HOOKS = new Set([
  'beforeAll',
  'beforeEach',
  'afterAll',
  'afterEach',
  'aroundAll',
  'aroundEach',
  'onTestFinished',
  'onTestFailed',
]);
const CONTEXT_HOOKS = new Set(['onTestFinished', 'onTestFailed']);
/** The parameter where a hook's body takes the row's context, for the hooks that pass it. */
const HOOK_CONTEXT: ReadonlyMap<string, number> = new Map([
  ['beforeEach', 0],
  ['afterEach', 0],
  ['onTestFinished', 0],
  ['onTestFailed', 0],
  ['aroundEach', 1],
]);
const VITEST_NAMES = new Set([...ROWS, ...SUITES, ...HOOKS, 'vi']);

/** The module every limit comes from, relative to the repository root. */
const LIMITS_MODULE = 'test/support/timeouts.ts';

/** The configs whose files the check reads, relative to the repository root. */
const GATE_CONFIGS = ['vitest.config.ts', 'vitest.store.config.ts'];

const CODE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];
const READ_EXTENSIONS: ReadonlySet<string> = new Set<string>([
  ts.Extension.Ts,
  ts.Extension.Tsx,
  ts.Extension.Mts,
  ts.Extension.Cts,
  ts.Extension.Js,
  ts.Extension.Jsx,
  ts.Extension.Mjs,
  ts.Extension.Cjs,
]);

/**
 * The program that binds the names: no library files and no files beyond the check's own, the
 * repository's module resolution, and no type checking. Every file is a module, as in the
 * repository's tsconfig.json.
 */
const PROGRAM_OPTIONS: ts.CompilerOptions = {
  noLib: true,
  noResolve: true,
  types: [],
  allowJs: true,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  moduleDetection: ts.ModuleDetectionKind.Force,
  target: ts.ScriptTarget.ESNext,
  noEmit: true,
};

/** Where the check reads its files: a repository on disk, or fixture text for its own rows. */
export interface CheckedTree {
  readonly root: string;
  readonly host: ts.ModuleResolutionHost;
}

interface CheckedFile {
  readonly path: string;
  readonly relative: string;
  readonly source: ts.SourceFile;
  readonly references: readonly RuntimeReference[];
  /** The modules the check reads, by the specifier that loads them. */
  readonly modules: ReadonlyMap<string, ts.ResolvedModuleFull>;
  /** The identifiers outside types that spell a Vitest name, found as the file is read. */
  readonly vitestNames: readonly ts.Identifier[];
}

function isRelative(specifier: string): boolean {
  return specifier.startsWith('.') || specifier.startsWith('/');
}

/**
 * The module a specifier loads when the check reads it. A bare specifier names a package, and the
 * check reads neither packages nor src/, JSON modules, or declaration files.
 */
function readModule(
  tree: CheckedTree,
  from: string,
  specifier: string,
  cache: ts.ModuleResolutionCache,
): ts.ResolvedModuleFull | undefined {
  if (!isRelative(specifier)) return undefined;
  const { resolvedModule } = ts.resolveModuleName(
    specifier,
    from,
    PROGRAM_OPTIONS,
    tree.host,
    cache,
  );
  if (resolvedModule === undefined || resolvedModule.isExternalLibraryImport === true) {
    return undefined;
  }
  const inSource = resolvedModule.resolvedFileName.startsWith(`${tree.root}/src/`);
  return inSource || !READ_EXTENSIONS.has(resolvedModule.extension) ? undefined : resolvedModule;
}

function relativePath(tree: CheckedTree, path: string): string {
  return path.startsWith(`${tree.root}/`) ? path.slice(tree.root.length + 1) : path;
}

/** Parses every entry and every module outside src/ it loads at run time, transitively. */
function readFiles(tree: CheckedTree, entries: readonly string[]): Map<string, CheckedFile> {
  const cache = ts.createModuleResolutionCache(tree.root, (name) => name, PROGRAM_OPTIONS);
  const files = new Map<string, CheckedFile>();
  const pending = [...entries];
  for (let path = pending.pop(); path !== undefined; path = pending.pop()) {
    if (files.has(path)) continue;
    const text = tree.host.readFile(path);
    if (text === undefined) throw new Error(`The timeout check cannot read ${path}`);
    const source = ts.createSourceFile(path, text, ts.ScriptTarget.ESNext);
    const vitestNames: ts.Identifier[] = [];
    const references = runtimeReferences(source, (node) => {
      if (ts.isIdentifier(node) && VITEST_NAMES.has(node.text)) vitestNames.push(node);
    });
    const modules = new Map<string, ts.ResolvedModuleFull>();
    for (const { specifier } of references) {
      const module = specifier === undefined ? undefined : readModule(tree, path, specifier, cache);
      if (specifier === undefined || module === undefined) continue;
      modules.set(specifier, module);
      pending.push(module.resolvedFileName);
    }
    const relative = relativePath(tree, path);
    files.set(path, { path, relative, source, references, modules, vitestNames });
  }
  return files;
}

/**
 * One program over exactly the files the check reads, parsed once. The program's own module
 * detection marks each file a module before binding, as it would a file it parsed itself.
 */
function checkProgram(tree: CheckedTree, files: ReadonlyMap<string, CheckedFile>): ts.Program {
  const host: ts.CompilerHost = {
    getSourceFile: (fileName, options) => {
      const source = files.get(fileName)?.source;
      if (source !== undefined && typeof options === 'object') {
        options.setExternalModuleIndicator?.(source);
      }
      return source;
    },
    getDefaultLibFileName: () => `${tree.root}/lib.d.ts`,
    writeFile: () => undefined,
    getCurrentDirectory: () => tree.root,
    getCanonicalFileName: (fileName) => fileName,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => '\n',
    fileExists: (fileName) => files.has(fileName),
    readFile: (fileName) => files.get(fileName)?.source.text,
    resolveModuleNameLiterals: (literals, containingFile) =>
      literals.map((literal) => ({
        resolvedModule: files.get(containingFile)?.modules.get(literal.text),
      })),
  };
  return ts.createProgram({ rootNames: [...files.keys()], options: PROGRAM_OPTIONS, host });
}

// ---- Syntax

type FunctionNode = ts.ArrowFunction | ts.FunctionExpression | ts.FunctionDeclaration;

function isFunctionNode(node: ts.Node): node is FunctionNode {
  return (
    ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isFunctionDeclaration(node)
  );
}

/** The function a declaration binds: a function, or a variable a function initializes. */
function declaredFunction(declaration: ts.Node | undefined): FunctionNode | undefined {
  if (declaration === undefined || isFunctionNode(declaration)) return declaration;
  const initializer = ts.isVariableDeclaration(declaration) ? declaration.initializer : undefined;
  return initializer !== undefined && isFunctionNode(initializer) ? initializer : undefined;
}

/** Nodes that open a scope of their own: a module and every function-like body. */
const SCOPES: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.SourceFile,
  ts.SyntaxKind.FunctionDeclaration,
  ts.SyntaxKind.FunctionExpression,
  ts.SyntaxKind.ArrowFunction,
  ts.SyntaxKind.MethodDeclaration,
  ts.SyntaxKind.Constructor,
  ts.SyntaxKind.GetAccessor,
  ts.SyntaxKind.SetAccessor,
  ts.SyntaxKind.ClassStaticBlockDeclaration,
]);

/** Nodes that hold no work: types, and the imports and exports the program binds. */
const INERT: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.InterfaceDeclaration,
  ts.SyntaxKind.TypeAliasDeclaration,
  ts.SyntaxKind.ImportDeclaration,
  ts.SyntaxKind.ImportEqualsDeclaration,
  ts.SyntaxKind.ExportDeclaration,
]);

function isInert(node: ts.Node): boolean {
  return INERT.has(node.kind) || (ts.isTypeNode(node) && !ts.isExpressionWithTypeArguments(node));
}

/** Declarations whose `name` is the name they declare, and accesses whose `name` is a property. */
const NAMING: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.VariableDeclaration,
  ts.SyntaxKind.Parameter,
  ts.SyntaxKind.FunctionDeclaration,
  ts.SyntaxKind.FunctionExpression,
  ts.SyntaxKind.ClassDeclaration,
  ts.SyntaxKind.ClassExpression,
  ts.SyntaxKind.EnumDeclaration,
  ts.SyntaxKind.EnumMember,
  ts.SyntaxKind.ModuleDeclaration,
  ts.SyntaxKind.MethodDeclaration,
  ts.SyntaxKind.PropertyDeclaration,
  ts.SyntaxKind.PropertyAssignment,
  ts.SyntaxKind.GetAccessor,
  ts.SyntaxKind.SetAccessor,
  ts.SyntaxKind.BindingElement,
  ts.SyntaxKind.ImportSpecifier,
  ts.SyntaxKind.ImportClause,
  ts.SyntaxKind.NamespaceImport,
  ts.SyntaxKind.ImportEqualsDeclaration,
  ts.SyntaxKind.ExportSpecifier,
  ts.SyntaxKind.NamespaceExport,
  ts.SyntaxKind.TypeParameter,
  ts.SyntaxKind.JsxAttribute,
  ts.SyntaxKind.PropertyAccessExpression,
  ts.SyntaxKind.MetaProperty,
]);

/** Whether an identifier reads a binding, rather than declaring a name or naming a property. */
function isReference(id: ts.Identifier): boolean {
  const { parent } = id;
  if (NAMING.has(parent.kind) && 'name' in parent && parent.name === id) return false;
  if ('propertyName' in parent && parent.propertyName === id) return false;
  if ('label' in parent && parent.label === id) return false;
  return !ts.isQualifiedName(parent);
}

function memberName(node: ts.Node): string | undefined {
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression)) {
    return node.argumentExpression.text;
  }
  return undefined;
}

function isMemberAccess(
  node: ts.Node,
): node is ts.PropertyAccessExpression | ts.ElementAccessExpression {
  return ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node);
}

/** The name a call calls: an identifier, or the last member of an access. */
function calleeName(callee: ts.Expression): string | undefined {
  let expression = callee;
  while (ts.isParenthesizedExpression(expression)) expression = expression.expression;
  return ts.isIdentifier(expression) ? expression.text : memberName(expression);
}

type Call = ts.CallExpression | ts.NewExpression | ts.TaggedTemplateExpression;

const CALLS: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.CallExpression,
  ts.SyntaxKind.NewExpression,
  ts.SyntaxKind.TaggedTemplateExpression,
]);

function isCall(node: ts.Node): node is Call {
  return CALLS.has(node.kind);
}

function calleeOf(call: Call): ts.Expression {
  return ts.isTaggedTemplateExpression(call) ? call.tag : call.expression;
}

function isDynamicImport(node: ts.Node): node is ts.CallExpression {
  return ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword;
}

/**
 * The binding pattern of `const { a, b: c } = await import('literal')`, the one shape of a dynamic
 * import whose names the check resolves; undefined for any other use of the call.
 */
function destructuredImport(call: ts.CallExpression): ts.ObjectBindingPattern | undefined {
  const awaited = call.parent;
  if (!ts.isAwaitExpression(awaited)) return undefined;
  const declaration = awaited.parent;
  if (!ts.isVariableDeclaration(declaration) || declaration.initializer !== awaited)
    return undefined;
  const pattern = declaration.name;
  if (!ts.isObjectBindingPattern(pattern)) return undefined;
  const simple = pattern.elements.every(
    (element) => element.dotDotDotToken === undefined && ts.isIdentifier(element.name),
  );
  return simple ? pattern : undefined;
}

/** The local names a named import, or a destructured `await import()`, binds. */
function importedNames(reference: RuntimeReference): string[] {
  if (reference.form === 'dynamic-import') {
    const elements = destructuredImport(reference.node)?.elements ?? [];
    return elements.flatMap(({ name }) => (ts.isIdentifier(name) ? [name.text] : []));
  }
  const { node } = reference;
  const bindings = ts.isImportDeclaration(node) ? node.importClause?.namedBindings : undefined;
  return bindings !== undefined && ts.isNamedImports(bindings)
    ? bindings.elements.map(({ name }) => name.text)
    : [];
}

/** The name a destructured element takes from its object. */
function elementKey(element: ts.BindingElement): string | undefined {
  const key = element.propertyName ?? element.name;
  return ts.isIdentifier(key) || ts.isStringLiteralLike(key) ? key.text : undefined;
}

/** A call chain that starts at an identifier: its member accesses, calls, and tagged templates. */
interface Chain {
  readonly head: ts.Identifier;
  readonly links: readonly ts.Expression[];
  readonly outer: ts.Expression;
}

function linkAbove(node: ts.Expression): ts.Expression | undefined {
  const { parent } = node;
  if ((isMemberAccess(parent) || ts.isCallExpression(parent)) && parent.expression === node) {
    return parent;
  }
  return ts.isTaggedTemplateExpression(parent) && parent.tag === node ? parent : undefined;
}

function chainOf(head: ts.Identifier): Chain {
  const links: ts.Expression[] = [];
  let outer: ts.Expression = head;
  for (let link = linkAbove(outer); link !== undefined; link = linkAbove(outer)) {
    links.push(link);
    outer = link;
  }
  return { head, links, outer };
}

/** The outer call of a chain that stands as an expression statement. */
function statementCall(chain: Chain): ts.CallExpression | undefined {
  const { outer } = chain;
  return ts.isCallExpression(outer) && ts.isExpressionStatement(outer.parent) ? outer : undefined;
}

function chainMembers(chain: Chain): Array<string | undefined> {
  return chain.links.filter(isMemberAccess).map(memberName);
}

/** The arguments of a chain's calls and templates below its outer call, which count as work. */
function chainArguments(chain: Chain): ts.Node[] {
  return chain.links.flatMap((link) => {
    if (link === chain.outer) return [];
    if (ts.isCallExpression(link)) return [...link.arguments];
    return ts.isTaggedTemplateExpression(link) ? [link.template] : [];
  });
}

function nameText(name: ts.Expression | undefined): string {
  if (name === undefined) return '<unnamed>';
  return ts.isStringLiteralLike(name) ? `'${name.text}'` : name.getText();
}

// ---- Rows, suites, and hooks

interface Parts {
  readonly body?: ts.Expression;
  readonly limit?: ts.Expression;
  readonly retry?: boolean;
  readonly problem?: string;
}

/**
 * The limit and `retry` of an options object literal, or why the check cannot read them. Keys read
 * by their value, as Vitest reads them, so a quoted `'timeout'` is the same option.
 */
function optionParts(options: ts.ObjectLiteralExpression): Parts {
  let limit: ts.Expression | undefined;
  let retry = false;
  for (const property of options.properties) {
    if (ts.isSpreadAssignment(property) || ts.isComputedPropertyName(property.name)) {
      return { problem: 'options the check cannot read' };
    }
    const key = property.name.text;
    if (key === 'retry') retry = true;
    if (key !== 'timeout') continue;
    limit = ts.isPropertyAssignment(property) ? property.initializer : property.name;
  }
  return { ...(limit === undefined ? {} : { limit }), retry };
}

type FunctionOf = (node: ts.Expression) => FunctionNode | undefined;

/**
 * A row's or suite's parts after its name: `(name, body, limit)`, `(name, options, body)`, or the
 * name alone.
 */
function callParts(args: readonly ts.Expression[], functionOf: FunctionOf): Parts {
  if (args.some(ts.isSpreadElement)) return { problem: 'a spread argument' };
  if (args.length > 4) return { problem: 'more arguments than a name, a body, and a limit' };
  const [, first, second, third] = args;
  if (first === undefined) return {};
  if (ts.isObjectLiteralExpression(first)) return optionsFirstParts(first, second, third);
  return bodyFirstParts(first, second, third, functionOf);
}

/** `(name, options, body)`: the limit and `retry` of the options, and the body after them. */
function optionsFirstParts(
  options: ts.ObjectLiteralExpression,
  body: ts.Expression | undefined,
  extra: ts.Expression | undefined,
): Parts {
  if (extra !== undefined) return { problem: 'an argument after the body' };
  const parts = optionParts(options);
  return body === undefined ? parts : { ...parts, body };
}

/** `(name, body, limit)`, where options given by name before the body cannot be read. */
function bodyFirstParts(
  body: ts.Expression,
  limit: ts.Expression | undefined,
  extra: ts.Expression | undefined,
  functionOf: FunctionOf,
): Parts {
  if (functionOf(body) === undefined && limit !== undefined && functionOf(limit) !== undefined) {
    return { problem: 'options given by name' };
  }
  if (extra !== undefined) return { problem: 'an argument after the limit' };
  return limit === undefined ? { body } : { body, limit };
}

const UNREADABLE_BODY = 'a body that is neither a function nor a resolvable name';

/** A row's or suite's parts, with the function its body is or names. */
type BodyParts = Parts & { readonly fn?: FunctionNode };

/** Why a hook's arguments cannot be read: the check reads a body and a limit. */
function hookProblem(args: readonly ts.Expression[]): string | undefined {
  if (args.some(ts.isSpreadElement)) return 'a spread argument';
  return args.length > 2 ? 'more arguments than a body and a limit' : undefined;
}

/** The limit a row or hook names from the limits module, or the form it takes instead. */
interface LimitName {
  readonly name?: string;
  readonly form?: string;
}

/** The form of a limit that is not a name. */
function expressionForm(limit: ts.Expression): string {
  if (ts.isNumericLiteral(limit)) return 'a number';
  return isMemberAccess(limit) ? 'a property access' : 'an expression';
}

type Unit = ts.Node;

interface Facts {
  mask: number;
  readonly units: Set<Unit>;
}

/** Whether `inner` lies within `outer`, a node of `source`. */
function contains(outer: ts.Node, source: ts.SourceFile, inner: ts.Node): boolean {
  return inner.pos >= outer.pos && inner.end <= outer.end && inner.getSourceFile() === source;
}

/** The binding names a node declares: a name, or every name of a destructuring pattern. */
function addBindingNames(name: ts.BindingName, names: Set<string>): void {
  if (ts.isIdentifier(name)) {
    names.add(name.text);
    return;
  }
  for (const element of name.elements) {
    if (!ts.isOmittedExpression(element)) addBindingNames(element.name, names);
  }
}

/** Declarations whose names a scope holds. */
function addDeclaredName(node: ts.Node, names: Set<string>): void {
  if (ts.isVariableDeclaration(node) || ts.isParameter(node)) addBindingNames(node.name, names);
  else if (
    (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isEnumDeclaration(node)) &&
    node.name !== undefined
  ) {
    names.add(node.name.text);
  }
}

class TimeoutCheck {
  private readonly findings: Array<{
    readonly file: string;
    readonly at: number;
    readonly text: string;
  }> = [];
  private readonly declared = new Map<ts.Node, ReadonlySet<string>>();
  private readonly visible = new Map<ts.Node, ReadonlyArray<ReadonlySet<string>>>();
  private readonly facts = new Map<Unit, Facts>();
  private readonly masks = new Map<Unit, number>();
  private readonly order = new Map<Unit, number>();
  private readonly low = new Map<Unit, number>();
  private readonly stack: Unit[] = [];
  private readonly signalNames = new Map<ts.SourceFile, ReadonlySet<string>>();
  private readonly vitestSpecifiers = new Map<ts.ImportSpecifier, string>();
  // Fields, not parameter properties: the check's rows load this module in a worker thread through
  // Node's type stripping, which takes erasable syntax only.
  private readonly tree: CheckedTree;
  private readonly files: ReadonlyMap<string, CheckedFile>;
  private readonly checker: ts.TypeChecker;

  constructor(tree: CheckedTree, files: ReadonlyMap<string, CheckedFile>, checker: ts.TypeChecker) {
    this.tree = tree;
    this.files = files;
    this.checker = checker;
  }

  run(): string[] {
    for (const file of this.files.values()) this.checkFile(file);
    this.findings.sort((left, right) => {
      if (left.file !== right.file) return left.file < right.file ? -1 : 1;
      return left.at - right.at;
    });
    return this.findings.map(({ text }) => text);
  }

  private fileOf(node: ts.Node): CheckedFile {
    const file = this.files.get(node.getSourceFile().fileName);
    if (file === undefined) throw new Error(`The timeout check reached an unread file`);
    return file;
  }

  private report(node: ts.Node, label: string, text: string): void {
    const file = this.fileOf(node);
    const at = node.getStart(file.source);
    const { line } = file.source.getLineAndCharacterOfPosition(at);
    this.findings.push({
      file: file.relative,
      at,
      text: `${file.relative}:${line + 1} ${label}: ${text}`,
    });
  }

  private unreadable(node: ts.Node, label: string, reason: string): void {
    this.report(node, label, `unreadable, ${reason}`);
  }

  // ---- Names

  private symbolAt(id: ts.Identifier): ts.Symbol | undefined {
    return ts.isShorthandPropertyAssignment(id.parent)
      ? this.checker.getShorthandAssignmentValueSymbol(id.parent)
      : this.checker.getSymbolAtLocation(id);
  }

  private target(symbol: ts.Symbol): ts.Symbol {
    return (symbol.flags & ts.SymbolFlags.Alias) === 0
      ? symbol
      : this.checker.getAliasedSymbol(symbol);
  }

  /** A function, or the function a name binds to, directly or through an import. */
  private functionOf(node: ts.Expression): FunctionNode | undefined {
    if (isFunctionNode(node)) return node;
    const symbol = ts.isIdentifier(node) ? this.symbolAt(node) : undefined;
    return symbol === undefined
      ? undefined
      : declaredFunction(this.target(symbol).declarations?.[0]);
  }

  /** The module a dynamic import loads, when the check reads it. */
  private importedModule(call: ts.CallExpression): ts.Symbol | undefined {
    const [specifier] = call.arguments;
    if (specifier === undefined || !ts.isStringLiteralLike(specifier)) return undefined;
    if (!this.fileOf(call).modules.has(specifier.text)) return undefined;
    return this.checker.getSymbolAtLocation(specifier);
  }

  // ---- Work

  /** The units a module's export named `name` binds to. */
  private exportUnits(module: ts.Symbol, name: string | undefined): Unit[] {
    const exported = this.checker.getExportsOfModule(module).find((symbol) => symbol.name === name);
    return exported === undefined ? [] : this.symbolUnits(exported);
  }

  private moduleUnits(module: ts.Symbol): Unit[] {
    return this.checker.getExportsOfModule(module).flatMap((symbol) => this.symbolUnits(symbol));
  }

  private symbolUnits(symbol: ts.Symbol): Unit[] {
    return (this.target(symbol).declarations ?? []).flatMap((declaration) =>
      this.declarationUnits(declaration),
    );
  }

  /** The units a destructured name takes: an export of a dynamic import, or its declaration. */
  private elementUnits(element: ts.BindingElement): Unit[] {
    const root = bindingRoot(element);
    const call = element.parent.parent === root ? awaitedImport(root) : undefined;
    const module = call === undefined ? undefined : this.importedModule(call);
    return module === undefined
      ? this.declarationUnits(root)
      : this.exportUnits(module, elementKey(element));
  }

  /** The node whose work a declaration adds: itself, its value, or what it re-exports. */
  private declarationUnits(declaration: ts.Node): Unit[] {
    if (ts.isSourceFile(declaration)) {
      const module = this.checker.getSymbolAtLocation(declaration);
      return module === undefined ? [] : this.moduleUnits(module);
    }
    if (ts.isBindingElement(declaration)) return this.elementUnits(declaration);
    if (ts.isExportAssignment(declaration)) return [declaration.expression];
    const loop = ts.isVariableDeclaration(declaration) ? loopExpression(declaration) : undefined;
    if (loop !== undefined) return [loop];
    if (isMemberAccess(declaration) && ts.isBinaryExpression(declaration.parent)) {
      return [declaration.parent.right];
    }
    return UNIT_KINDS.has(declaration.kind) ? [declaration] : [];
  }

  /** The units a reference reaches; a member of a namespace reaches only that export. */
  private referenceUnits(id: ts.Identifier): Unit[] {
    const symbol = this.symbolAt(id);
    if (symbol === undefined) return [];
    const target = this.target(symbol);
    const [declaration] = target.declarations ?? [];
    if (declaration !== undefined && ts.isSourceFile(declaration) && isMemberAccess(id.parent)) {
      return this.exportUnits(target, memberName(id.parent));
    }
    return this.symbolUnits(symbol);
  }

  /** The names each scope around a node declares, innermost first, the node's own left out. */
  private visibleNames(node: ts.Node): ReadonlyArray<ReadonlySet<string>> {
    if (ts.isSourceFile(node)) return [];
    let scope = node.parent;
    while (!SCOPES.has(scope.kind)) scope = scope.parent;
    const known = this.visible.get(scope);
    if (known !== undefined) return known;
    const names = [this.declaredNames(scope), ...this.visibleNames(scope)];
    this.visible.set(scope, names);
    return names;
  }

  /**
   * The names a scope declares, nested functions left out: its parameters, variables, functions,
   * and classes, and, in a module, the names it imports from modules the check reads and through
   * `import x = require()`.
   */
  private declaredNames(scope: ts.Node): ReadonlySet<string> {
    const known = this.declared.get(scope);
    if (known !== undefined) return known;
    const names = new Set<string>();
    const visit = (node: ts.Node): void => {
      if (ts.isImportDeclaration(node)) {
        this.addImportedNames(node, names);
        return;
      }
      if (ts.isImportEqualsDeclaration(node)) {
        names.add(node.name.text);
        return;
      }
      if (isInert(node)) return;
      addDeclaredName(node, names);
      if (!SCOPES.has(node.kind) || node === scope) ts.forEachChild(node, visit);
    };
    visit(scope);
    this.declared.set(scope, names);
    return names;
  }

  private addImportedNames(declaration: ts.ImportDeclaration, names: Set<string>): void {
    const clause = declaration.importClause;
    const specifier = declaration.moduleSpecifier;
    if (clause === undefined || isTypeOnlyImport(clause) || !ts.isStringLiteral(specifier)) return;
    if (!this.fileOf(declaration).modules.has(specifier.text)) return;
    if (clause.name !== undefined) names.add(clause.name.text);
    const bindings = clause.namedBindings;
    if (bindings === undefined) return;
    if (ts.isNamespaceImport(bindings)) names.add(bindings.name.text);
    else for (const element of bindings.elements) names.add(element.name.text);
  }

  /** The kind a call signals: by its name, or through the import of its module. */
  private callSignal(call: Call, signalNames: ReadonlySet<string>): number {
    const callee = calleeOf(call);
    const name = calleeName(callee);
    if (name === undefined) return 0;
    const signal = CALL_SIGNALS.get(name) ?? 0;
    const imported = signalNames.has(name) && ts.isIdentifier(callee);
    return imported ? signal | this.importedSignal(callee) : signal;
  }

  /** The kind a callee signals through a named import or a destructured `await import()`. */
  private importedSignal(callee: ts.Identifier): number {
    const declaration = this.checker.getSymbolAtLocation(callee)?.declarations?.[0];
    if (declaration !== undefined && ts.isImportSpecifier(declaration)) {
      const module = literalValue(declaration.parent.parent.parent.moduleSpecifier);
      return importedSignal(module, (declaration.propertyName ?? declaration.name).text);
    }
    if (declaration === undefined || !ts.isBindingElement(declaration)) return 0;
    const root = bindingRoot(declaration);
    const call = declaration.parent.parent === root ? awaitedImport(root) : undefined;
    return importedSignal(literalValue(call?.arguments[0]), elementKey(declaration));
  }

  /** The local names a file binds to the calls of IMPORTED_SIGNALS, which only then signal. */
  private signalNamesOf(source: ts.SourceFile): ReadonlySet<string> {
    const known = this.signalNames.get(source);
    if (known !== undefined) return known;
    const names = new Set(
      this.fileOf(source)
        .references.filter(
          ({ specifier }) => specifier !== undefined && IMPORTED_SIGNALS.has(specifier),
        )
        .flatMap(importedNames),
    );
    this.signalNames.set(source, names);
    return names;
  }

  /** The signals a node holds and the units outside it that its names bind to. */
  private walk(node: ts.Node, scope: ts.Node): Facts {
    const names = this.visibleNames(scope);
    const source = node.getSourceFile();
    const signalNames = this.signalNamesOf(source);
    const facts: Facts = { mask: 0, units: new Set() };
    const add = (units: readonly Unit[]): void => {
      for (const unit of units) if (!contains(node, source, unit)) facts.units.add(unit);
    };
    const visit = (child: ts.Node): void => {
      if (isInert(child)) return;
      if (ts.isIdentifier(child)) {
        if (names.some((set) => set.has(child.text)) && isReference(child)) {
          add(this.referenceUnits(child));
        }
        return;
      }
      if (isCall(child)) facts.mask |= this.callSignal(child, signalNames);
      if (isDynamicImport(child)) add(this.importUnits(child));
      if (ts.isHeritageClause(child)) this.walkHeritage(child, visit);
      else ts.forEachChild(child, visit);
    };
    visit(node);
    return facts;
  }

  /** A class's `extends` names a value; its `implements` names types only. */
  private walkHeritage(clause: ts.HeritageClause, visit: (node: ts.Node) => void): void {
    if (clause.token !== ts.SyntaxKind.ExtendsKeyword || !ts.isClassLike(clause.parent)) return;
    for (const type of clause.types) visit(type.expression);
  }

  /** The exports a destructured dynamic import of a module the check reads takes. */
  private importUnits(call: ts.CallExpression): Unit[] {
    const pattern = destructuredImport(call);
    const module = pattern === undefined ? undefined : this.importedModule(call);
    if (pattern === undefined || module === undefined) return [];
    return pattern.elements.flatMap((element) => this.exportUnits(module, elementKey(element)));
  }

  private unitFacts(unit: Unit): Facts {
    let facts = this.facts.get(unit);
    if (facts === undefined) {
      facts = this.walk(unit, unit);
      this.facts.set(unit, facts);
    }
    return facts;
  }

  /** Everything a unit reaches, through Tarjan's components, so that a cycle shares its work. */
  private closure(unit: Unit): number {
    const known = this.masks.get(unit);
    if (known !== undefined) return known;
    this.connect(unit);
    return this.masks.get(unit) ?? 0;
  }

  private connect(unit: Unit): void {
    const index = this.order.size;
    this.order.set(unit, index);
    this.low.set(unit, index);
    this.stack.push(unit);
    for (const next of this.unitFacts(unit).units) {
      if (this.masks.has(next)) continue;
      if (!this.order.has(next)) this.connect(next);
      const nextLow = this.masks.has(next) ? Infinity : (this.low.get(next) ?? Infinity);
      this.low.set(unit, Math.min(this.low.get(unit) ?? index, nextLow));
    }
    if (this.low.get(unit) === index) this.finish(unit);
  }

  private finish(unit: Unit): void {
    const component = new Set<Unit>();
    for (let member = this.stack.pop(); member !== undefined; member = this.stack.pop()) {
      component.add(member);
      if (member === unit) break;
    }
    let mask = 0;
    for (const member of component) {
      const facts = this.unitFacts(member);
      mask |= facts.mask;
      for (const next of facts.units) {
        if (!component.has(next)) mask |= this.masks.get(next) ?? 0;
      }
    }
    for (const member of component) this.masks.set(member, mask);
  }

  /** The signals a row's or hook's own nodes reach, with everything their names bind to. */
  private reach(nodes: readonly ts.Node[], call: ts.CallExpression): number {
    let mask = 0;
    for (const node of nodes) {
      const facts = this.walk(node, call);
      mask |= facts.mask;
      for (const unit of facts.units) mask |= this.closure(unit);
    }
    return mask;
  }

  // ---- Limits

  private fromLimitsModule(specifier: ts.ImportSpecifier): boolean {
    const declaration = specifier.parent.parent.parent;
    const module = declaration.moduleSpecifier;
    if (!ts.isStringLiteral(module) || isTypeOnlyImport(declaration.importClause)) return false;
    const target = this.fileOf(declaration).modules.get(module.text)?.resolvedFileName;
    return target === `${this.tree.root}/${LIMITS_MODULE}`;
  }

  /** The limit a row or hook names, or the form that keeps it from being one. */
  private limitName(limit: ts.Expression): LimitName {
    if (!ts.isIdentifier(limit)) return { form: expressionForm(limit) };
    const declaration = this.symbolAt(limit)?.declarations?.[0];
    if (declaration === undefined) return { form: 'an unbound name' };
    if (!ts.isImportSpecifier(declaration)) {
      return { form: ts.isVariableDeclaration(declaration) ? 'a local constant' : 'a local name' };
    }
    if (declaration.propertyName !== undefined) return { form: 'an aliased import' };
    if (!this.fromLimitsModule(declaration)) return { form: 'a name from another module' };
    return { name: declaration.name.text };
  }

  private checkLimit(
    at: ts.Node,
    label: string,
    mask: number,
    limit: ts.Expression | undefined,
  ): void {
    const kinds = KINDS.filter(({ signals }) => (mask & signals) === signals);
    if (kinds.length === 0) {
      if (limit !== undefined) this.report(at, label, 'a limit on light work');
      return;
    }
    const largest = Math.max(...kinds.map(({ value }) => value));
    const allowed = kinds.filter(({ value }) => value === largest).map((kind) => kind.limit);
    const needs = `${kinds.map(({ work }) => work).join(' and ')} work needs ${allowed.join(' or ')}`;
    if (limit === undefined) {
      this.report(at, label, needs);
      return;
    }
    const { name, form } = this.limitName(limit);
    if (name === undefined) {
      this.report(at, label, `${needs} from ${LIMITS_MODULE}, not ${form ?? 'another expression'}`);
    } else if (!allowed.includes(name)) {
      this.report(at, label, `${needs}, not ${name}`);
    }
  }

  // ---- Vitest bindings

  /** Records the file's Vitest imports and reports every other way of reaching Vitest. */
  private checkVitestImports(file: CheckedFile): void {
    for (const statement of file.source.statements) {
      if (ts.isImportDeclaration(statement)) this.checkVitestImport(statement);
      else if (
        ts.isImportEqualsDeclaration(statement) &&
        ts.isExternalModuleReference(statement.moduleReference) &&
        literalValue(statement.moduleReference.expression) === 'vitest'
      ) {
        this.unreadable(statement, 'vitest', 'imported through require()');
      }
    }
    // Imports bind wherever the file writes them, so its re-exports are read after every import.
    for (const statement of file.source.statements.filter(ts.isExportDeclaration)) {
      this.checkVitestExport(statement);
    }
    for (const reference of file.references) {
      if (reference.form === 'dynamic-import' || reference.form === 'require') {
        this.checkModuleCall(file, reference.node, reference.form);
      }
    }
  }

  private checkVitestImport(declaration: ts.ImportDeclaration): void {
    const clause = declaration.importClause;
    const fromVitest = literalValue(declaration.moduleSpecifier) === 'vitest';
    if (!fromVitest || clause === undefined || isTypeOnlyImport(clause)) return;
    if (clause.name !== undefined) this.unreadable(clause, 'vitest', 'a default import');
    const bindings = clause.namedBindings;
    if (bindings === undefined) return;
    if (ts.isNamespaceImport(bindings)) {
      this.unreadable(bindings, 'vitest', 'a namespace import');
      return;
    }
    for (const element of bindings.elements) this.checkVitestSpecifier(element);
  }

  private checkVitestSpecifier(element: ts.ImportSpecifier): void {
    const imported = (element.propertyName ?? element.name).text;
    if (element.isTypeOnly || !VITEST_NAMES.has(imported)) return;
    if (element.propertyName === undefined) this.vitestSpecifiers.set(element, imported);
    else this.unreadable(element, imported, 'imported under another name');
  }

  private checkVitestExport(declaration: ts.ExportDeclaration): void {
    if (declaration.isTypeOnly) return;
    if (declaration.moduleSpecifier !== undefined) {
      if (literalValue(declaration.moduleSpecifier) === 'vitest') {
        this.unreadable(declaration, 'vitest', 're-exported');
      }
      return;
    }
    const clause = declaration.exportClause;
    if (clause === undefined || !ts.isNamedExports(clause)) return;
    for (const element of clause.elements) {
      const local = this.checker.getExportSpecifierLocalTargetSymbol(element);
      const name = local === undefined ? undefined : this.vitestName(local);
      if (name !== undefined) this.unreadable(element, name, 're-exported');
    }
  }

  /** Checks an `import()` or `require()` of Vitest or of a read module for a shape it resolves. */
  private checkModuleCall(file: CheckedFile, call: ts.CallExpression, form: string): void {
    const [specifier] = call.arguments;
    const how = form === 'require' ? 'require()' : 'import()';
    if (specifier === undefined || !ts.isStringLiteralLike(specifier)) {
      this.unreadable(call, how, 'a module named by an expression');
    } else if (specifier.text === 'vitest') {
      this.unreadable(call, 'vitest', `reached through ${how}`);
    } else if (
      file.modules.has(specifier.text) &&
      (form === 'require' || destructuredImport(call) === undefined)
    ) {
      this.unreadable(call, how, `${specifier.text} kept as a module object`);
    }
  }

  /** The Vitest name a symbol binds to, imported by name without an alias. */
  private vitestName(symbol: ts.Symbol): string | undefined {
    const declaration = symbol.declarations?.[0];
    return declaration !== undefined && ts.isImportSpecifier(declaration)
      ? this.vitestSpecifiers.get(declaration)
      : undefined;
  }

  private checkFile(file: CheckedFile): void {
    this.checkVitestImports(file);
    for (const id of file.vitestNames) {
      if (isReference(id) && ts.findAncestor(id, isInert) === undefined) this.checkBinding(id);
    }
  }

  private checkBinding(id: ts.Identifier): void {
    const symbol = this.symbolAt(id);
    const chain = chainOf(id);
    if (symbol === undefined) {
      if (chain.links.some(ts.isCallExpression)) {
        this.unreadable(id, id.text, 'a call to an unbound name');
      }
      return;
    }
    const name = this.vitestName(symbol);
    if (name === 'vi') this.checkVi(chain);
    else if (name !== undefined) this.checkChain(chain, name);
  }

  /** A chain from `it`, `test`, `describe`, `suite`, or a hook, which stands as a statement. */
  private checkChain(chain: Chain, name: string): void {
    const call = statementCall(chain);
    if (call === undefined) {
      this.unreadable(chain.head, name, 'used other than as the head of a call statement');
      return;
    }
    const hook = chainMembers(chain).find((member) => member !== undefined && HOOKS.has(member));
    if (hook !== undefined) this.checkHook(chain, call, hook);
    else if (ROWS.has(name)) this.checkRow(chain, call);
    else if (SUITES.has(name)) this.checkSuite(chain, call);
    else this.checkHook(chain, call, name);
  }

  /** `vi` heads a call through member accesses; `vi.setConfig` changes the limits of later rows. */
  private checkVi(chain: Chain): void {
    const firstCall = chain.links.findIndex((link) => !isMemberAccess(link));
    if (firstCall < 1 || !ts.isCallExpression(chain.links[firstCall] ?? chain.head)) {
      this.unreadable(chain.head, 'vi', 'used other than as the head of a call');
      return;
    }
    const members = chainMembers({ ...chain, links: chain.links.slice(0, firstCall) });
    if (members.includes(undefined)) {
      this.unreadable(chain.head, 'vi', 'a computed member');
    } else if (members.includes('setConfig')) {
      this.report(chain.head, 'vi.setConfig', 'changes the limits of the rows after it');
    }
  }

  /** A row's or suite's parts with the function of its body, unless it reports them unreadable. */
  private readParts(chain: Chain, call: ts.CallExpression, label: string): BodyParts | undefined {
    const parts = callParts(call.arguments, (node) => this.functionOf(node));
    const fn = parts.body === undefined ? undefined : this.functionOf(parts.body);
    const unreadableBody = parts.body !== undefined && fn === undefined;
    const problem = parts.problem ?? (unreadableBody ? UNREADABLE_BODY : undefined);
    if (problem !== undefined) {
      this.unreadable(chain.head, label, problem);
      return undefined;
    }
    return fn === undefined ? parts : { ...parts, fn };
  }

  private checkRow(chain: Chain, call: ts.CallExpression): void {
    const label = `row ${nameText(call.arguments[0])}`;
    const parts = this.readParts(chain, call, label);
    if (parts === undefined) return;
    if (parts.retry === true) this.report(chain.head, label, 'retry on a row');
    const mask = this.reach([...chainArguments(chain), ...call.arguments], call);
    this.checkLimit(chain.head, label, mask, parts.limit);
    const members = chainMembers(chain);
    if (parts.fn !== undefined && !members.includes('each')) {
      this.checkContext(parts.fn, members.includes('for') ? 1 : 0);
    }
  }

  private checkSuite(chain: Chain, call: ts.CallExpression): void {
    const label = `suite ${nameText(call.arguments[0])}`;
    const parts = this.readParts(chain, call, label);
    if (parts?.retry === true) this.report(chain.head, label, 'retry on a suite');
    if (parts?.limit !== undefined) this.report(chain.head, label, 'a limit on a suite');
  }

  private checkHook(chain: Chain, call: ts.CallExpression, name: string): void {
    const label = `hook ${name}`;
    const [body, limit] = call.arguments;
    const problem = hookProblem(call.arguments);
    const fn = problem === undefined && body !== undefined ? this.functionOf(body) : undefined;
    if (fn === undefined) {
      this.unreadable(chain.head, label, problem ?? UNREADABLE_BODY);
      return;
    }
    const mask = this.reach([...chainArguments(chain), ...call.arguments], call);
    this.checkLimit(chain.head, label, mask, limit);
    const context = HOOK_CONTEXT.get(name);
    if (context !== undefined) this.checkContext(fn, context);
  }

  // ---- Contexts

  /**
   * A row's or hook's context: its `onTestFinished` and `onTestFailed` are hooks, taken by name or
   * as members, and the context itself is never passed on.
   */
  private checkContext(fn: FunctionNode, index: number): void {
    const parameter = fn.parameters[index];
    if (parameter === undefined || fn.body === undefined) return;
    const { name } = parameter;
    if (ts.isIdentifier(name)) {
      this.checkContextObject(fn.body, name);
      return;
    }
    if (!ts.isObjectBindingPattern(name)) return;
    for (const element of name.elements) {
      const key = elementKey(element);
      if (element.dotDotDotToken !== undefined) {
        this.unreadable(element, 'context', 'passed on as a value');
      } else if (key !== undefined && CONTEXT_HOOKS.has(key)) {
        this.checkContextHook(fn.body, element, key);
      }
    }
  }

  private usesOf(body: ts.Node, name: ts.Identifier): ts.Identifier[] {
    const symbol = this.checker.getSymbolAtLocation(name);
    const uses: ts.Identifier[] = [];
    const visit = (node: ts.Node): void => {
      if (isInert(node)) return;
      if (
        ts.isIdentifier(node) &&
        node.text === name.text &&
        isReference(node) &&
        this.symbolAt(node) === symbol
      ) {
        uses.push(node);
      }
      ts.forEachChild(node, visit);
    };
    visit(body);
    return uses;
  }

  private checkContextObject(body: ts.Node, name: ts.Identifier): void {
    for (const use of this.usesOf(body, name)) {
      const member =
        isMemberAccess(use.parent) && use.parent.expression === use
          ? memberName(use.parent)
          : undefined;
      if (member === undefined) this.unreadable(use, 'context', 'passed on as a value');
      else if (CONTEXT_HOOKS.has(member)) this.checkContextUse(use, member);
    }
  }

  private checkContextHook(body: ts.Node, element: ts.BindingElement, key: string): void {
    if (element.propertyName !== undefined || !ts.isIdentifier(element.name)) {
      this.unreadable(element, key, 'taken under another name');
      return;
    }
    for (const use of this.usesOf(body, element.name)) this.checkContextUse(use, key);
  }

  /** A context hook, which heads a call statement as the hooks Vitest exports do. */
  private checkContextUse(use: ts.Identifier, hook: string): void {
    const chain = chainOf(use);
    const call = statementCall(chain);
    if (call === undefined) {
      this.unreadable(use, hook, 'used other than as the head of a call statement');
    } else {
      this.checkHook(chain, call, hook);
    }
  }
}

/** Declarations whose own node holds their work. */
const UNIT_KINDS: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.FunctionDeclaration,
  ts.SyntaxKind.FunctionExpression,
  ts.SyntaxKind.ArrowFunction,
  ts.SyntaxKind.MethodDeclaration,
  ts.SyntaxKind.Constructor,
  ts.SyntaxKind.GetAccessor,
  ts.SyntaxKind.SetAccessor,
  ts.SyntaxKind.ClassDeclaration,
  ts.SyntaxKind.ClassExpression,
  ts.SyntaxKind.EnumDeclaration,
  ts.SyntaxKind.ModuleDeclaration,
  ts.SyntaxKind.VariableDeclaration,
  ts.SyntaxKind.Parameter,
  ts.SyntaxKind.PropertyAssignment,
  ts.SyntaxKind.ShorthandPropertyAssignment,
  ts.SyntaxKind.PropertyDeclaration,
]);

function literalValue(expression: ts.Expression | undefined): string | undefined {
  return expression !== undefined && ts.isStringLiteralLike(expression)
    ? expression.text
    : undefined;
}

function importedSignal(module: string | undefined, name: string | undefined): number {
  if (module === undefined || name === undefined) return 0;
  return IMPORTED_SIGNALS.get(module)?.get(name) ?? 0;
}

/** The expression a `for … of` or `for … in` variable takes its values from. */
function loopExpression(declaration: ts.VariableDeclaration): ts.Expression | undefined {
  const loop = declaration.parent.parent;
  return ts.isForOfStatement(loop) || ts.isForInStatement(loop) ? loop.expression : undefined;
}

/** The declaration a destructured name belongs to: a variable or a parameter. */
function bindingRoot(element: ts.BindingElement): ts.Node {
  let root: ts.Node = element;
  while (
    ts.isBindingElement(root) ||
    ts.isObjectBindingPattern(root) ||
    ts.isArrayBindingPattern(root)
  ) {
    root = root.parent;
  }
  return root;
}

/** The dynamic import a variable's initializer awaits. */
function awaitedImport(root: ts.Node): ts.CallExpression | undefined {
  if (!ts.isVariableDeclaration(root) || root.initializer === undefined) return undefined;
  const { initializer } = root;
  return ts.isAwaitExpression(initializer) && isDynamicImport(initializer.expression)
    ? initializer.expression
    : undefined;
}

/**
 * Every row, suite, and hook of `entries` and the modules outside src/ they load at run time whose
 * limit does not match its work, and every shape the check cannot read.
 */
export function timeoutFindings(tree: CheckedTree, entries: readonly string[]): string[] {
  const files = readFiles(tree, entries);
  const checker = checkProgram(tree, files).getTypeChecker();
  return new TimeoutCheck(tree, files, checker).run();
}

// ---- The gates' files

/** The properties of an object literal in a config, which the check reads only when plain. */
function objectProperties(
  object: ts.ObjectLiteralExpression,
  config: string,
): Map<string, ts.Expression> {
  const properties = new Map<string, ts.Expression>();
  for (const property of object.properties) {
    if (
      !ts.isPropertyAssignment(property) ||
      !(ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))
    ) {
      throw new Error(`${config} holds ${property.getText()}, which the timeout check cannot read`);
    }
    properties.set(property.name.text, property.initializer);
  }
  return properties;
}

/** The `test` options of a Vitest config, read from its source text, by name. */
export function vitestTestOptions(
  root: string,
  config: string,
): ReadonlyMap<string, ts.Expression> {
  const text = ts.sys.readFile(`${root}/${config}`);
  if (text === undefined) throw new Error(`The timeout check cannot read ${config}`);
  const source = ts.createSourceFile(config, text, ts.ScriptTarget.ESNext, true);
  const exported = source.statements.find(ts.isExportAssignment)?.expression;
  const options =
    exported !== undefined && ts.isCallExpression(exported) ? exported.arguments[0] : exported;
  const test =
    options !== undefined && ts.isObjectLiteralExpression(options)
      ? objectProperties(options, config).get('test')
      : undefined;
  if (test === undefined || !ts.isObjectLiteralExpression(test)) {
    throw new Error(`${config} has no test options the timeout check can read`);
  }
  return objectProperties(test, config);
}

function literalOption(expression: ts.Expression, option: string): unknown {
  if (ts.isNumericLiteral(expression)) return Number(expression.text);
  if (ts.isStringLiteralLike(expression)) return expression.text;
  if (expression.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (expression.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (ts.isArrayLiteralExpression(expression)) {
    return expression.elements.map((element) => literalOption(element, option));
  }
  throw new Error(`${option} is ${expression.getText()}, which the pins cannot read`);
}

/**
 * A config option's value where the config writes it as a literal (a string, a number, `true`,
 * `false`, or a list of these), for the pins; undefined where the config leaves it out.
 */
export function configValue(
  options: ReadonlyMap<string, ts.Expression>,
  key: string,
  config: string,
): unknown {
  const value = options.get(key);
  return value === undefined ? undefined : literalOption(value, `${config} ${key}`);
}

/** A config option that lists strings; an option the config leaves out lists none. */
function configStrings(
  options: ReadonlyMap<string, ts.Expression>,
  key: string,
  config: string,
): string[] {
  const value = options.get(key);
  if (value === undefined) return [];
  const strings = ts.isArrayLiteralExpression(value)
    ? value.elements.filter(ts.isStringLiteralLike)
    : [];
  if (!ts.isArrayLiteralExpression(value) || strings.length !== value.elements.length) {
    throw new Error(`${config} sets ${key} to something other than a list of strings`);
  }
  return strings.map((element) => element.text);
}

/**
 * The timeout findings over every file a gate runs: the test files each config includes and does
 * not exclude, and the configs' local setup files. Every file is read and parsed.
 */
export function suiteTimeoutFindings(root: string): string[] {
  const entries = new Set<string>();
  for (const config of GATE_CONFIGS) {
    const options = vitestTestOptions(root, config);
    const include = configStrings(options, 'include', config);
    const exclude = configStrings(options, 'exclude', config);
    if (include.length === 0) throw new Error(`${config} names no test files the check can list`);
    for (const file of ts.sys.readDirectory(root, CODE_EXTENSIONS, exclude, include)) {
      entries.add(file);
    }
    for (const setup of configStrings(options, 'setupFiles', config)) {
      const file = ts.sys.resolvePath(`${root}/${setup}`);
      if (ts.sys.fileExists(file)) entries.add(file);
    }
  }
  return timeoutFindings({ root, host: ts.sys }, [...entries]);
}
