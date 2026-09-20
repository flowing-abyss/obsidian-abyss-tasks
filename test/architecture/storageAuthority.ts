import ts from 'typescript';

const ROOT = ts.sys.resolvePath(`${import.meta.dirname}/../..`);

export interface StorageAccess {
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly api: string;
  readonly owner: string;
}

export interface StorageAuthorization {
  readonly file: string;
  readonly api: string;
  readonly owner: string;
  readonly reason: string;
}

// The existing architecture-boundaries inventory remains authoritative for task
// transactions. This adds the raw settings port and resolves the actual APIs.
export const STORAGE_AUTHORIZATIONS: readonly StorageAuthorization[] = [
  {
    file: 'src/projects/ProjectManager.ts',
    owner: 'ProjectManager.applyEditsGuarded',
    api: 'Vault.process',
    reason:
      'Validates fresh expected project metadata and applies the prepared batch for that file.',
  },
  {
    file: 'src/projects/ProjectManager.ts',
    owner: 'ProjectManager.createProjectFile',
    api: 'Vault.process',
    reason: 'Adds the task section only to the newly owned, template-free project note.',
  },
  {
    file: 'src/projects/ProjectManager.ts',
    owner: 'ProjectManager.writeStatusRename',
    api: 'Vault.process',
    reason: 'Renames status only on fresh qualifying notes carrying the expected literal.',
  },
  {
    file: 'src/projects/ProjectManager.ts',
    owner: 'ProjectManager.restoreStatusRename',
    api: 'Vault.process',
    reason: 'Compensates only values still matching the failed rename operation.',
  },
  {
    file: 'src/notes/NoteTemplateService.ts',
    owner: 'NoteTemplateService.createPreparedNote',
    api: 'Vault.create',
    reason: 'Creates the owned destination before applying an optional template.',
  },
  {
    file: 'src/notes/NoteTemplateService.ts',
    owner: 'NoteTemplateService.applyTemplate',
    api: 'Vault.process',
    reason: 'Applies output only while the destination matches the owned preparation snapshot.',
  },
  {
    file: 'src/tags/TagManager.ts',
    owner: 'TagManager.applyVaultRenames',
    api: 'Vault.process',
    reason: 'Global tag rename intentionally updates task and non-task vault text.',
  },
  {
    file: 'src/tasks/infrastructure/obsidian/ObsidianTaskRepository.ts',
    owner: 'ObsidianTaskRepository.processFile_abyssPrivate',
    api: 'Vault.process',
    reason: 'Sole revision-confirming task transaction boundary.',
  },
  {
    file: 'src/main.ts',
    owner: 'TaskCalendarPlugin.persistencePort.saveStatic',
    api: 'Plugin.saveData',
    reason:
      'Composition-root callback persists static preferences for SettingsPersistenceCoordinator.',
  },
  {
    file: 'src/main.ts',
    owner: 'TaskCalendarPlugin.persistencePort.write',
    api: 'DataAdapter.write',
    reason: 'Composition-root callback persists state.json for SettingsPersistenceCoordinator.',
  },
];

const SINKS = new Set([
  'Vault.process',
  'Vault.modify',
  'Vault.append',
  'Vault.create',
  'DataAdapter.write',
  'DataAdapter.append',
  'FileManager.processFrontMatter',
  'Plugin.saveData',
]);

function arrowOwner(node: ts.ArrowFunction): string {
  const parent = node.parent;
  if (
    ts.isPropertyAssignment(parent) ||
    ts.isVariableDeclaration(parent) ||
    ts.isPropertyDeclaration(parent)
  )
    return parent.name.getText();
  return '<callback>';
}

function ownerPart(node: ts.Node): string | undefined {
  if (ts.isClassDeclaration(node) || ts.isClassExpression(node))
    return node.name === undefined ? '<anonymous-class>' : node.name.text;
  if (
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  )
    return node.name.getText();
  if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node))
    return node.name === undefined ? '<anonymous-function>' : node.name.text;
  return undefined;
}

function ownerOf(node: ts.Node): string {
  const names: string[] = [];
  for (let current = node.parent; !ts.isSourceFile(current); current = current.parent) {
    const name = ts.isArrowFunction(current) ? arrowOwner(current) : ownerPart(current);
    if (name !== undefined) names.unshift(name);
  }
  return names.length > 0 ? names.join('.') : '<module>';
}

function bindingSymbol(node: ts.BindingElement, checker: ts.TypeChecker): ts.Symbol | undefined {
  if (!ts.isObjectBindingPattern(node.parent)) return undefined;
  const name = node.propertyName ?? node.name;
  const key = ts.isComputedPropertyName(name) ? name.expression : name;
  if (ts.isIdentifier(key) || ts.isStringLiteralLike(key))
    return checker.getPropertyOfType(checker.getTypeAtLocation(node.parent), key.text);
  return undefined;
}

function referenceSymbol(node: ts.Node, checker: ts.TypeChecker): ts.Symbol | undefined {
  if (ts.isPropertyAccessExpression(node)) return checker.getSymbolAtLocation(node.name);
  if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression)) {
    return checker.getPropertyOfType(
      checker.getNonNullableType(checker.getTypeAtLocation(node.expression)),
      node.argumentExpression.text,
    );
  }
  if (ts.isBindingElement(node)) return bindingSymbol(node, checker);
  return undefined;
}

function canonicalPath(file: string): string {
  return ts.sys.realpath?.(file) ?? file;
}

function storageApi(symbol: ts.Symbol | undefined, declarationPath: string): string | undefined {
  if (symbol === undefined) return undefined;
  for (const declaration of symbol.declarations ?? []) {
    const parent = declaration.parent;
    if (!(ts.isClassDeclaration(parent) || ts.isInterfaceDeclaration(parent))) continue;
    if (canonicalPath(declaration.getSourceFile().fileName) !== declarationPath) continue;
    const api = `${parent.name?.text ?? ''}.${symbol.name}`;
    if (SINKS.has(api)) return api;
  }
  return undefined;
}

/** Enumerate API references at acquisition, including extraction and binding.
 * This intentionally does not attempt whole-program taint/dataflow analysis.
 */
export function collectStorageAccesses(
  program: ts.Program,
  files: readonly ts.SourceFile[],
): readonly StorageAccess[] {
  const checker = program.getTypeChecker();
  const resolved = ts.resolveModuleName(
    'obsidian',
    `${ROOT}/src/main.ts`,
    program.getCompilerOptions(),
    ts.sys,
  ).resolvedModule;
  if (resolved === undefined)
    throw new Error('Storage authority requires installed Obsidian declarations.');
  const declarationPath = canonicalPath(resolved.resolvedFileName);
  const accesses: StorageAccess[] = [];
  for (const file of files) {
    const visit = (node: ts.Node): void => {
      const api = storageApi(referenceSymbol(node, checker), declarationPath);
      if (api !== undefined) {
        const location = file.getLineAndCharacterOfPosition(node.getStart(file));
        accesses.push({
          file: file.fileName.startsWith(`${ROOT}/`)
            ? file.fileName.slice(ROOT.length + 1)
            : file.fileName,
          line: location.line + 1,
          column: location.character + 1,
          api,
          owner: ownerOf(node),
        });
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
  }
  return accesses;
}

function keyOf(value: Pick<StorageAccess, 'file' | 'owner' | 'api'>): string {
  return `${value.file}#${value.owner}#${value.api}`;
}

/** Each authorization permits exactly one acquisition, not an entire method/file. */
export function storageAuthorityViolations(
  accesses: readonly StorageAccess[],
  authorizations: readonly StorageAuthorization[],
): readonly string[] {
  const violations: string[] = [];
  const remaining = new Set<string>();
  for (const authorization of authorizations) {
    const key = keyOf(authorization);
    if (remaining.has(key)) violations.push(`storage/duplicate ${key}`);
    if (authorization.reason.trim().length === 0) violations.push(`storage/missing-reason ${key}`);
    remaining.add(key);
  }
  for (const access of accesses) {
    if (!remaining.delete(keyOf(access))) {
      violations.push(
        `storage/unauthorized ${access.file}:${access.line}:${access.column} ${access.owner} ${access.api}`,
      );
    }
  }
  for (const key of remaining) violations.push(`storage/stale ${key}`);
  return violations;
}
