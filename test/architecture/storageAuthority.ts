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
    file: 'src/main.ts',
    owner: 'TaskCalendarPlugin.commandSessionStorage.ensureDirectory',
    api: 'DataAdapter.mkdir',
    reason:
      'Creates only the sessions directory under the actual plugin directory for scoped history files.',
  },
  {
    file: 'src/main.ts',
    owner: 'TaskCalendarPlugin.commandSessionStorage.write',
    api: 'DataAdapter.write',
    reason:
      'Creates only a UUID session file or command-session-state.json after absence checking; CommandSessionStore validates exact readback before admitting native writes.',
  },
  {
    file: 'src/main.ts',
    owner: 'TaskCalendarPlugin.commandSessionStorage.write',
    api: 'DataAdapter.process',
    reason:
      'Updates only a scoped history file after comparing the exact previous bytes inside the native process callback.',
  },
  {
    file: 'src/main.ts',
    owner: 'TaskCalendarPlugin.commandSessionStorage.remove',
    api: 'DataAdapter.remove',
    reason:
      'Removes only a validated UUID session file after the store has durably verified its deletion marker.',
  },
  {
    file: 'src/main.ts',
    owner: 'TaskCalendarPlugin.commandSessionStorage.clearLegacy',
    api: 'App.saveLocalStorage',
    reason:
      'Retires only the legacy command-session key after every imported JSON file and its import marker pass readback verification.',
  },
  {
    file: 'src/ai/providers/ChatGptPlan.ts',
    owner: 'ChatGptPlan.read',
    api: 'SecretStorage.getSecret',
    reason:
      'Reads only the plugin-owned local OAuth registration, including its active account and rotating grant.',
  },
  {
    file: 'src/ai/providers/ChatGptPlan.ts',
    owner: 'ChatGptPlan.write',
    api: 'SecretStorage.setSecret',
    reason:
      'Atomically replaces only the plugin-owned ChatGPT registration, preserving other accounts and sign-in host identity.',
  },
  {
    file: 'src/ai/providers/ProviderSecrets.ts',
    owner: 'ProviderSecrets.store',
    api: 'SecretStorage.setSecret',
    reason:
      'Stores or clears only the six fixed plugin credential IDs through vault-scoped host secret storage.',
  },
  {
    file: 'src/ai/providers/ProviderSecrets.ts',
    owner: 'ProviderSecrets.read',
    api: 'SecretStorage.getSecret',
    reason:
      'Resolves only a selected plugin credential for provider requests or presence-only settings feedback; never enumerates unrelated secrets.',
  },
  {
    file: 'src/notes/NoteApplicationService.ts',
    owner: 'NoteApplicationService.commitPreparedSection',
    api: 'Vault.process',
    reason:
      'Writes one previously read prose section only after exact note identity, revision, live bytes, source policy and unchanged frontmatter/task ownership checks.',
  },
  {
    file: 'src/tasks/infrastructure/obsidian/ObsidianTaskRepository.ts',
    owner: 'ObsidianTaskRepository.cleanupEmptyTaskNote_abyssPrivate',
    api: 'FileManager.trashFile',
    reason:
      'Removes only an empty configured task note after explicit root deletion, fresh byte and identity proof, and unchanged policy.',
  },
  {
    file: 'src/projects/ProjectManager.ts',
    owner: 'ProjectManager.updateIntegrationProject',
    api: 'Vault.process',
    reason:
      'Applies one typed metadata batch only to the pinned file after live and candidate project scope checks.',
  },
  {
    file: 'src/notes/NoteTemplateService.ts',
    owner: 'NoteTemplateService.commitStaticNote',
    api: 'Vault.create',
    reason:
      'Creates one final note after rechecking the static template, settings, destination and permitted source scope.',
  },
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
    reason:
      'Creates the owned destination for eager capture or confirmed template-first creation before optional guarded template application.',
  },
  {
    file: 'src/notes/NoteTemplateService.ts',
    owner: 'NoteTemplateService.applyTemplate',
    api: 'Vault.process',
    reason:
      'Applies output only while the destination matches the owned preparation snapshot; confirmed creation also checks the frozen template and current destination/source policy.',
  },
  {
    file: 'src/tags/TagManager.ts',
    owner: 'TagManager.applyVaultRenames',
    api: 'Vault.process',
    reason: 'Global tag rename intentionally updates task and non-task vault text.',
  },
  {
    file: 'src/tasks/infrastructure/obsidian/ObsidianTaskRepository.ts',
    owner: 'ObsidianTaskRepository.processFile_abyssPrivate.work',
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
  'App.saveLocalStorage',
  'SecretStorage.setSecret',
  'SecretStorage.getSecret',
  'SecretStorage.listSecrets',
  'Vault.process',
  'Vault.modify',
  'Vault.append',
  'Vault.create',
  'DataAdapter.process',
  'DataAdapter.remove',
  'DataAdapter.mkdir',
  'DataAdapter.write',
  'DataAdapter.append',
  'FileManager.processFrontMatter',
  'FileManager.trashFile',
  'Plugin.saveData',
]);
const SINK_NAMES = new Set([...SINKS].map((api) => api.slice(api.indexOf('.') + 1)));

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
  if ((ts.isIdentifier(key) || ts.isStringLiteralLike(key)) && SINK_NAMES.has(key.text))
    return checker.getPropertyOfType(checker.getTypeAtLocation(node.parent), key.text);
  return undefined;
}

function assignmentPropertyName(name: ts.PropertyName): string | undefined {
  if (ts.isComputedPropertyName(name)) {
    return ts.isStringLiteralLike(name.expression) ? name.expression.text : undefined;
  }
  return ts.isIdentifier(name) || ts.isStringLiteralLike(name) ? name.text : undefined;
}

// Only walk the local assignment pattern to its RHS, never variable dataflow.
function assignmentSourceType(
  pattern: ts.ObjectLiteralExpression,
  checker: ts.TypeChecker,
): ts.Type | undefined {
  const parent = pattern.parent;
  if (
    ts.isBinaryExpression(parent) &&
    parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    parent.left === pattern
  ) {
    return checker.getTypeAtLocation(parent.right);
  }
  if (ts.isPropertyAssignment(parent)) {
    const symbol = assignmentSymbol(parent, checker);
    if (symbol !== undefined) return checker.getTypeOfSymbolAtLocation(symbol, parent);
  }
  return undefined;
}

function assignmentSymbol(
  node: ts.PropertyAssignment | ts.ShorthandPropertyAssignment,
  checker: ts.TypeChecker,
): ts.Symbol | undefined {
  if (!ts.isObjectLiteralExpression(node.parent)) return undefined;
  const sourceType = assignmentSourceType(node.parent, checker);
  const name = assignmentPropertyName(node.name);
  if (sourceType === undefined || name === undefined) return undefined;
  return checker.getPropertyOfType(sourceType, name);
}

function elementSymbol(
  node: ts.ElementAccessExpression,
  checker: ts.TypeChecker,
): ts.Symbol | undefined {
  const key = node.argumentExpression;
  if (ts.isStringLiteralLike(key) && SINK_NAMES.has(key.text)) {
    return checker.getPropertyOfType(
      checker.getNonNullableType(checker.getTypeAtLocation(node.expression)),
      key.text,
    );
  }
  return undefined;
}

function referenceSymbol(node: ts.Node, checker: ts.TypeChecker): ts.Symbol | undefined {
  // Names only prefilter candidates; declaration identity below still proves authority.
  if (ts.isPropertyAccessExpression(node) && SINK_NAMES.has(node.name.text))
    return checker.getSymbolAtLocation(node.name);
  if (ts.isElementAccessExpression(node)) return elementSymbol(node, checker);
  if (ts.isBindingElement(node)) return bindingSymbol(node, checker);
  if (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) {
    const name = assignmentPropertyName(node.name);
    // Keep recursive assignmentSymbol resolution unfiltered: ancestors such as
    // `vault` in ({ vault: { modify } } = app) need not themselves be sinks.
    if (name !== undefined && SINK_NAMES.has(name)) return assignmentSymbol(node, checker);
  }
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
