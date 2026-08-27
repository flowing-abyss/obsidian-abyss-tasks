import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '..');
const SRC_ROOT = resolve(ROOT, 'src');
const TASK_PUBLIC_ENTRY = 'src/tasks';
const RECURRENCE_ENGINE = 'src/tasks/domain/recurrence.ts';

const PRESENTATION_PATH = /^src\/(?:code-block|panels|ui|views)\//u;
const PRESENTATION_FILES = new Set(['src/settings/SettingsTab.ts']);
const LEGACY_BRIDGE_FILES = [
  'src/mutation/TaskLocator.ts',
  'src/mutation/TaskMutationService.ts',
  'src/mutation/insertTaskBlock.ts',
  'src/mutation/validateMutatedLine.ts',
] as const;

const CALENDAR_COMPOSITION_ROOTS = [
  'src/panels/CenterPanel.ts',
  'src/ui/CalendarRenderer.ts',
] as const;

const RECURRENCE_EDITOR_WRITE_CONSUMERS = [
  'src/panels/CenterPanel.ts',
  'src/panels/RightPanel.ts',
  'src/ui/CalendarRenderer.ts',
] as const;

interface AllowedWriter {
  readonly mutation:
    | 'single-task transaction'
    | 'destination provisioning'
    | 'project metadata'
    | 'work-note metadata'
    | 'vault-wide tag rename';
  readonly reason: string;
}

const ALLOWED_WRITER_CALLS: Record<string, AllowedWriter> = {
  'src/projects/work-notes/WorkNoteCommandService.ts#WorkNoteCommandService.setStatus#process#1': {
    mutation: 'work-note metadata',
    reason:
      'Atomically revalidates current Markdown eligibility and updates one accepted Work Note status property.',
  },
  'src/projects/work-notes/WorkNoteCommandService.ts#WorkNoteCommandService.performCreation#vault.create#1':
    {
      mutation: 'destination provisioning',
      reason:
        'Creates one collision-checked Work Note destination after the accepted creation capability is revalidated.',
    },
  'src/resolvers/DailyNoteResolver.ts#DailyNoteResolver.createNoteWithTemplate#vault.create#1': {
    mutation: 'destination provisioning',
    reason: 'Creates an empty Templater destination before template expansion.',
  },
  'src/resolvers/DailyNoteResolver.ts#DailyNoteResolver.createNoteWithTemplate#vault.create#2': {
    mutation: 'destination provisioning',
    reason: 'Creates a daily or project destination from a raw template.',
  },
  'src/resolvers/DailyNoteResolver.ts#DailyNoteResolver.createNoteWithTemplate#vault.create#3': {
    mutation: 'destination provisioning',
    reason: 'Creates an empty daily or project destination note.',
  },
  'src/tags/TagManager.ts#TagManager.renameAcrossVault#process#1': {
    mutation: 'vault-wide tag rename',
    reason: 'A global tag rename intentionally updates task and non-task text across the vault.',
  },
  'src/tasks/infrastructure/obsidian/ObsidianTaskDestinationProvider.ts#ObsidianTaskDestinationProvider.planExplicit#vault.create#1':
    {
      mutation: 'destination provisioning',
      reason: 'Provisions the configured destination without inserting task Markdown.',
    },
  'src/tasks/infrastructure/obsidian/ObsidianTaskRepository.ts#ObsidianTaskRepository.processFile#process#1':
    {
      mutation: 'single-task transaction',
      reason: 'The sole revision-confirming transaction boundary for task commands.',
    },
};

const PUBLIC_TASK_EXPORT_CONSUMERS: Record<string, readonly string[]> = {
  CalendarProjectionSources: ['src/views/calendarOccurrences.ts'],
  CalendarTaskSource: ['src/views/calendarOccurrences.ts'],
  CommentRef: ['src/panels/RightPanel.ts'],
  CommentTimeContext: ['src/panels/RightPanel.ts'],
  CommentTimeContextProvider: ['src/views/PanelView.ts'],
  CreateTaskCommandInitial: ['src/ui/taskCapture/CaptureTargetResolver.ts'],
  DateRange: ['src/views/calendarOccurrences.ts'],
  LocalDate: ['src/panels/CenterPanel.ts'],
  MoveRecovery: ['src/ui/TaskMoveRecoveryModal.ts'],
  PlanningTarget: ['src/panels/RightPanel.ts'],
  RecurrenceParseResult: ['src/ui/recurrence/RecurrenceEditor.ts'],
  RecurrencePolicy: ['src/ui/recurrence/RecurrenceEditor.ts'],
  SubtaskPatch: ['src/panels/RightPanel.ts'],
  SubtaskRef: ['src/panels/RightPanel.ts'],
  SubtaskSnapshot: ['src/panels/RightPanel.ts'],
  TaskApplicationApi: ['src/main.ts'],
  TaskCaptureApplicationApi: ['src/main.ts'],
  TaskCommand: ['src/panels/RightPanel.ts'],
  TaskCommandResult: ['src/projects/ProjectManager.ts'],
  TaskCommentSnapshot: ['src/panels/RightPanel.ts'],
  TaskCreateSession: ['src/ui/taskCapture/CaptureTargetResolver.ts'],
  TaskIndexEvent: ['src/projects/ProjectStore.ts'],
  TaskIndexSettledEvent: ['src/projects/ProjectStore.ts'],
  TaskNodeRef: ['src/panels/RightPanel.ts'],
  TaskPlanning: ['src/views/calendarOccurrences.ts'],
  TaskOccurrenceResult: ['src/ui/recurrence/RecurrenceEditor.ts'],
  TaskPatch: ['src/panels/RightPanel.ts'],
  TaskPriority: ['src/panels/CenterPanel.ts'],
  TaskQueryApi: ['src/main.ts'],
  TaskRef: ['src/projects/ProjectManager.ts'],
  TaskResolution: ['src/views/PanelView.ts'],
  TaskSnapshot: ['src/ui/TaskCard.ts'],
  TaskStatusType: ['src/settings/SettingsTab.ts'],
  TaskTextTarget: ['src/panels/RightPanel.ts'],
  daysBetweenLocalDates: ['src/panels/CenterPanel.ts', 'src/views/timegrid/dragGeometry.ts'],
  durationMinutes: ['src/panels/CenterPanel.ts'],
  expandRecurrenceReferences: ['src/views/calendarOccurrences.ts'],
  formatCommentTimeLabel: ['src/panels/RightPanel.ts'],
  localDate: ['src/main.ts'],
  localTime: ['src/panels/CenterPanel.ts'],
  parseRecurrenceRule: ['src/ui/recurrence/RecurrenceEditor.ts'],
  shiftLocalDate: ['src/ui/timedBlockKeyboardQueue.ts'],
  systemCommentTimeContext: ['src/code-block/registerCodeBlock.ts'],
  taskReconciliationKey: ['src/ui/taskPresentationIdentity.ts'],
};

const PUBLIC_INTERFACE_MEMBER_CONSUMERS: Record<string, string> = {
  'TaskApplicationApi.applyRootTagChanges': 'src/projects/NextActionService.ts',
  'TaskApplicationApi.execute': 'src/panels/CenterPanel.ts',
  'TaskApplicationApi.queries': 'src/ui/TaskMoveRecoveryModal.ts',
  'TaskQueryApi.isReady': 'src/projects/ProjectStore.ts',
  'TaskQueryApi.forCalendarProjection': 'src/panels/CenterPanel.ts',
  'TaskQueryApi.list': 'src/panels/CenterPanel.ts',
  'TaskQueryApi.resolve': 'src/views/PanelView.ts',
  'TaskQueryApi.subscribe': 'src/projects/ProjectStore.ts',
  'TaskQueryApi.subscribeSettled': 'src/projects/ProjectStore.ts',
};

function source(path: string): string {
  return readFileSync(resolve(ROOT, path), 'utf8');
}

function sourceFiles(directory = SRC_ROOT): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.isFile() && entry.name.endsWith('.ts') ? [path] : [];
  });
}

function typeScriptFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return typeScriptFiles(path);
    return entry.isFile() && entry.name.endsWith('.ts') ? [path] : [];
  });
}

function retiredNamespaceSites(): string[] {
  const retiredPrefix = ['t', 'c', '-'].join('');
  const files = [
    ...typeScriptFiles(SRC_ROOT),
    ...typeScriptFiles(resolve(ROOT, 'test')),
    resolve(ROOT, 'styles.css'),
  ];
  return files.flatMap((absolute) => {
    const path = repoPath(absolute);
    const matches = source(path).match(new RegExp(retiredPrefix, 'gu')) ?? [];
    return matches.map(() => path);
  });
}

function calendarModules(): string[] {
  return [...CALENDAR_COMPOSITION_ROOTS, ...sourceFiles(resolve(SRC_ROOT, 'views')).map(repoPath)];
}

function repoPath(path: string): string {
  return relative(ROOT, path).replace(/\\/gu, '/');
}

function syntax(path: string): ts.SourceFile {
  return syntaxFromText(path, source(path));
}

function syntaxFromText(path: string, text: string): ts.SourceFile {
  return ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function moduleStem(path: string): string {
  return path.replace(/\.[cm]?[jt]sx?$/u, '').replace(/\/index$/u, '');
}

function resolvedImport(path: string, specifier: string): string | undefined {
  if (!specifier.startsWith('.')) return undefined;
  return moduleStem(repoPath(resolve(dirname(resolve(ROOT, path)), specifier)));
}

interface ImportRecord {
  readonly specifier: string;
  readonly names: readonly string[];
}

function imports(path: string): ImportRecord[] {
  return importsFromSyntax(syntax(path));
}

function importsFromSyntax(module: ts.SourceFile): ImportRecord[] {
  const result: ImportRecord[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
      const names: string[] = [];
      const clause = node.importClause;
      if (clause?.name) names.push(clause.name.text);
      if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
        names.push(...clause.namedBindings.elements.map((item) => item.name.text));
      }
      if (clause?.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
        names.push('*');
      }
      result.push({ specifier: node.moduleSpecifier.text, names });
    }
    if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      result.push({ specifier: node.moduleSpecifier.text, names: [] });
    }
    if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      node.moduleReference.expression &&
      ts.isStringLiteralLike(node.moduleReference.expression)
    ) {
      result.push({
        specifier: node.moduleReference.expression.text,
        names: [node.name.text],
      });
    }
    if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteralLike(node.argument.literal)
    ) {
      result.push({
        specifier: node.argument.literal.text,
        names: node.qualifier ? [node.qualifier.getText()] : ['*'],
      });
    }
    if (
      ts.isCallExpression(node) &&
      node.arguments.length >= 1 &&
      ts.isStringLiteralLike(node.arguments[0]!) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (node.arguments.length === 1 &&
          ts.isIdentifier(node.expression) &&
          node.expression.text === 'require'))
    ) {
      result.push({ specifier: node.arguments[0]!.text, names: ['*'] });
    }
    ts.forEachChild(node, visit);
  };
  visit(module);
  return result;
}

function dependencyViolationsFor(path: string, records: readonly ImportRecord[]): string[] {
  const violations: string[] = [];
  if (path.startsWith('src/tasks/domain/')) {
    for (const record of records) {
      const target = resolvedImport(path, record.specifier);
      const allowedRecurrenceBoundary = path === RECURRENCE_ENGINE && record.specifier === 'rrule';
      if (
        !allowedRecurrenceBoundary &&
        (record.specifier === 'obsidian' ||
          target === undefined ||
          !target.startsWith('src/tasks/domain/'))
      ) {
        violations.push(`${path} -> ${record.specifier}`);
      }
    }
  }
  if (path.startsWith('src/tasks/application/')) {
    for (const record of records) {
      const target = resolvedImport(path, record.specifier);
      const allowed =
        target?.startsWith('src/tasks/application/') === true ||
        target?.startsWith('src/tasks/domain/') === true;
      if (!allowed) violations.push(`${path} -> ${record.specifier}`);
    }
  }
  if (path.startsWith('src/tasks/infrastructure/')) {
    for (const record of records) {
      const target = resolvedImport(path, record.specifier);
      if (target && /^(?:src\/(?:panels|ui|views))(?:\/|$)/u.test(target)) {
        violations.push(`${path} -> ${record.specifier}`);
      }
      if (
        record.specifier === 'obsidian' &&
        (record.names.includes('Notice') || record.names.includes('*'))
      ) {
        violations.push(`${path} -> obsidian:${record.names.join(',')}`);
      }
    }
  }
  if (PRESENTATION_PATH.test(path) || PRESENTATION_FILES.has(path)) {
    for (const record of records) {
      const target = resolvedImport(path, record.specifier);
      if (target?.startsWith('src/tasks/') && target !== TASK_PUBLIC_ENTRY) {
        violations.push(`${path} -> ${record.specifier}`);
      }
    }
  }
  return violations;
}

function dependencyViolations(): string[] {
  const violations = sourceFiles().flatMap((absolute) => {
    const path = repoPath(absolute);
    return dependencyViolationsFor(path, imports(path));
  });
  return violations.sort();
}

function ambientBoundarySitesFor(path: string, module: ts.SourceFile): string[] {
  const sites: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'Date' &&
      !(path === RECURRENCE_ENGINE && node.arguments?.length === 1)
    ) {
      sites.push(`${path}:new Date`);
    }
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'Date'
    ) {
      sites.push(`${path}:Date()`);
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === 'Date' &&
      node.expression.name.text === 'now'
    ) {
      sites.push(`${path}:Date.now`);
    }
    if (ts.isIdentifier(node) && (node.text === 'window' || node.text === 'document')) {
      sites.push(`${path}:${node.text}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(module);
  return sites;
}

function ambientBoundarySites(): string[] {
  return ['tasks/domain', 'tasks/application'].flatMap((layer) =>
    sourceFiles(resolve(SRC_ROOT, layer)).flatMap((absolute) => {
      const path = repoPath(absolute);
      return ambientBoundarySitesFor(path, syntax(path));
    }),
  );
}

function memberName(node: ts.Node): string | undefined {
  if (ts.isConstructorDeclaration(node)) return 'constructor';
  if (ts.isMethodDeclaration(node) && node.name) return node.name.getText();
  if (ts.isFunctionDeclaration(node)) return node.name?.text;
  return undefined;
}

function ownerName(node: ts.Node): string {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    const member = memberName(current);
    if (member) {
      const parent = current.parent;
      const className = ts.isClassDeclaration(parent) ? parent.name?.text : undefined;
      return className ? `${className}.${member}` : member;
    }
    current = current.parent;
  }
  return '<module>';
}

function unwrapCallTarget(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isPartiallyEmittedExpression(current) ||
    ts.isAwaitExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function writerSitesFor(path: string, module: ts.SourceFile): string[] {
  const sites: string[] = [];
  const occurrenceByOwner = new Map<string, number>();
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const target = unwrapCallTarget(node.expression);
      const operation = ts.isPropertyAccessExpression(target)
        ? target.name.text
        : ts.isElementAccessExpression(target) &&
            target.argumentExpression &&
            ts.isStringLiteralLike(target.argumentExpression)
          ? target.argumentExpression.text
          : undefined;
      const receiver =
        ts.isPropertyAccessExpression(target) || ts.isElementAccessExpression(target)
          ? target.expression
          : undefined;
      const directVaultReceiver =
        receiver !== undefined &&
        ((ts.isPropertyAccessExpression(receiver) && receiver.name.text === 'vault') ||
          (ts.isIdentifier(receiver) && receiver.text === 'vault'));
      if (operation === 'process' || (operation === 'create' && directVaultReceiver)) {
        const label = operation === 'process' ? 'process' : 'vault.create';
        const base = `${path}#${ownerName(node)}#${label}`;
        const ordinal = (occurrenceByOwner.get(base) ?? 0) + 1;
        occurrenceByOwner.set(base, ordinal);
        sites.push(`${base}#${ordinal}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(module);
  return sites;
}

function writerSites(): string[] {
  const sites = sourceFiles().flatMap((absolute) => {
    const path = repoPath(absolute);
    return writerSitesFor(path, syntax(path));
  });
  return sites.sort();
}

function calendarWriteSitesFor(path: string, module: ts.SourceFile): string[] {
  const sites: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const target = unwrapCallTarget(node.expression);
      if (ts.isPropertyAccessExpression(target) || ts.isElementAccessExpression(target)) {
        const operation = ts.isPropertyAccessExpression(target)
          ? target.name.text
          : target.argumentExpression && ts.isStringLiteralLike(target.argumentExpression)
            ? target.argumentExpression.text
            : undefined;
        const receiver = target.expression.getText(module);
        const isVaultWrite =
          /(?:^|\.)vault(?:\.|$)/u.test(receiver) &&
          operation !== undefined &&
          ['process', 'modify', 'create', 'delete', 'rename', 'write', 'append'].includes(
            operation,
          );
        const isRepositoryWrite =
          /(?:^|\.)repository(?:\.|$)/u.test(receiver) &&
          operation !== undefined &&
          ['edit', 'create', 'move', 'completeRecurrence'].includes(operation);
        if (isVaultWrite || isRepositoryWrite) sites.push(`${path}:${receiver}.${operation}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(module);
  return sites;
}

function unsafeForecastSnapshotCastsFor(path: string, module: ts.SourceFile): string[] {
  const sites: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) {
      const target = node.type.getText(module).replace(/\s+/gu, '');
      const expression = node.expression.getText(module);
      if (
        /^(?:readonly)?TaskSnapshot(?:\[\]|Array<TaskSnapshot>)?$/u.test(target) &&
        /forecast|occurrence|projection/iu.test(expression)
      ) {
        sites.push(`${path}:${expression} as ${target}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(module);
  return sites;
}

function recurrenceSubmitRoutesFor(path: string, module: ts.SourceFile): string[] {
  const routes: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const target = unwrapCallTarget(node.expression);
      const name = ts.isIdentifier(target)
        ? target.text
        : ts.isPropertyAccessExpression(target)
          ? target.name.text
          : undefined;
      if (name === 'mountRecurrenceEditor' || name === 'mountAnchoredRecurrenceEditor') {
        const options = node.arguments[0];
        if (!options || !ts.isObjectLiteralExpression(options)) return;
        const submit = options.properties.find(
          (property): property is ts.PropertyAssignment =>
            ts.isPropertyAssignment(property) && property.name.getText(module) === 'onSubmit',
        );
        if (!submit) {
          routes.push(`${path}:missing-onSubmit`);
          return;
        }
        let route = 'missing-application-route';
        const inspect = (candidate: ts.Node): void => {
          if (!ts.isCallExpression(candidate)) {
            ts.forEachChild(candidate, inspect);
            return;
          }
          const callTarget = unwrapCallTarget(candidate.expression);
          if (ts.isPropertyAccessExpression(callTarget)) {
            if (
              callTarget.name.text === 'execute' &&
              /(?:^|\.)tasks!?$/u.test(callTarget.expression.getText(module))
            ) {
              route = 'TaskApplicationApi.execute';
            } else if (callTarget.name.text === 'executePlanningPatch') {
              route = 'executePlanningPatch';
            }
          }
          ts.forEachChild(candidate, inspect);
        };
        inspect(submit.initializer);
        routes.push(`${path}:${route}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(module);
  return routes;
}

function memberApplicationExecuteCount(module: ts.SourceFile, member: string): number {
  let count = 0;
  const visit = (node: ts.Node): void => {
    if (
      ts.isMethodDeclaration(node) &&
      node.name.getText(module) === member &&
      node.body !== undefined
    ) {
      const inspect = (candidate: ts.Node): void => {
        if (ts.isCallExpression(candidate)) {
          const target = unwrapCallTarget(candidate.expression);
          if (
            ts.isPropertyAccessExpression(target) &&
            target.name.text === 'execute' &&
            /(?:^|\.)tasks!?$/u.test(target.expression.getText(module))
          ) {
            count++;
          }
        }
        ts.forEachChild(candidate, inspect);
      };
      inspect(node.body);
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(module);
  return count;
}

function barrelExports(): string[] {
  const names: string[] = [];
  for (const statement of syntax('src/tasks/index.ts').statements) {
    if (
      !ts.isExportDeclaration(statement) ||
      !statement.exportClause ||
      !ts.isNamedExports(statement.exportClause)
    )
      continue;
    names.push(...statement.exportClause.elements.map((item) => item.name.text));
  }
  return names.sort();
}

function publicTaskImports(path: string): ReadonlySet<string> {
  const names = imports(path)
    .filter((record) => resolvedImport(path, record.specifier) === TASK_PUBLIC_ENTRY)
    .flatMap((record) => record.names);
  return new Set(names);
}

function publicInterfaceMembers(): string[] {
  const result: string[] = [];
  for (const statement of syntax('src/tasks/application/TaskApplicationApi.ts').statements) {
    if (!ts.isInterfaceDeclaration(statement)) continue;
    if (statement.name.text !== 'TaskApplicationApi' && statement.name.text !== 'TaskQueryApi')
      continue;
    for (const member of statement.members) {
      if (member.name && ts.isIdentifier(member.name))
        result.push(`${statement.name.text}.${member.name.text}`);
    }
  }
  return result.sort();
}

function propertyAccesses(path: string): ReadonlySet<string> {
  const names = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node)) names.add(node.name.text);
    ts.forEachChild(node, visit);
  };
  visit(syntax(path));
  return names;
}

function projectStoreReadSites(path: string): string[] {
  const sites: string[] = [];
  const readMethods = new Set(['activeForLeftPanel', 'get', 'list']);
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      readMethods.has(node.expression.name.text) &&
      node.expression.expression.getText().includes('projectStore')
    ) {
      sites.push(`${path}:${node.expression.name.text}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(syntax(path));
  return sites;
}

describe('task architecture boundaries', () => {
  it('enforces domain, application, infrastructure, and presentation dependency direction', () => {
    expect(dependencyViolations()).toEqual([]);
    expect(ambientBoundarySites()).toEqual([]);
  });

  it('allows only the recurrence engine to import the deterministic rrule boundary', () => {
    const rruleImport = importsFromSyntax(
      syntaxFromText('src/tasks/domain/recurrence.ts', "import { RRule } from 'rrule';"),
    );
    expect(dependencyViolationsFor('src/tasks/domain/recurrence.ts', rruleImport)).toEqual([]);
    expect(dependencyViolationsFor('src/tasks/domain/validation.ts', rruleImport)).toEqual([
      'src/tasks/domain/validation.ts -> rrule',
    ]);

    const forbiddenImport = importsFromSyntax(
      syntaxFromText('src/tasks/domain/recurrence.ts', "import { Notice } from 'obsidian';"),
    );
    expect(dependencyViolationsFor('src/tasks/domain/recurrence.ts', forbiddenImport)).toEqual([
      'src/tasks/domain/recurrence.ts -> obsidian',
    ]);
  });

  it('allows only explicit Date construction in the recurrence engine', () => {
    const safe = syntaxFromText(
      'src/tasks/domain/recurrence.ts',
      'new Date(Date.UTC(2026, 7, 1)); new Date(explicitValue);',
    );
    expect(ambientBoundarySitesFor('src/tasks/domain/recurrence.ts', safe)).toEqual([]);
    expect(ambientBoundarySitesFor('src/tasks/domain/validation.ts', safe)).toEqual([
      'src/tasks/domain/validation.ts:new Date',
      'src/tasks/domain/validation.ts:new Date',
    ]);

    const unsafe = syntaxFromText(
      'src/tasks/domain/recurrence.ts',
      'new Date(); new Date(2026, 7, 1); Date(); Date.now(); window.location; document.title;',
    );
    expect(ambientBoundarySitesFor('src/tasks/domain/recurrence.ts', unsafe)).toEqual([
      'src/tasks/domain/recurrence.ts:new Date',
      'src/tasks/domain/recurrence.ts:new Date',
      'src/tasks/domain/recurrence.ts:Date()',
      'src/tasks/domain/recurrence.ts:Date.now',
      'src/tasks/domain/recurrence.ts:window',
      'src/tasks/domain/recurrence.ts:document',
    ]);
  });

  it('recognizes one- and two-argument dynamic imports before checking their layer', () => {
    const oneArgument = importsFromSyntax(
      syntaxFromText('src/ui/probe.ts', "void import('../tasks/domain/types');"),
    );
    const twoArguments = importsFromSyntax(
      syntaxFromText(
        'src/ui/probe.ts',
        "void import('../tasks/domain/types', { with: { type: 'json' } });",
      ),
    );

    expect(oneArgument.map((record) => record.specifier)).toEqual(['../tasks/domain/types']);
    expect(twoArguments.map((record) => record.specifier)).toEqual(['../tasks/domain/types']);
    expect(dependencyViolationsFor('src/ui/probe.ts', twoArguments)).toEqual([
      'src/ui/probe.ts -> ../tasks/domain/types',
    ]);
  });

  it('enumerates aliased and computed process calls and every forbidden ambient global', () => {
    const module = syntaxFromText(
      'src/ui/probe.ts',
      'const writer = app.vault; writer.process(value); writer["process"](value);',
    );
    expect(writerSitesFor('src/ui/probe.ts', module)).toEqual([
      'src/ui/probe.ts#<module>#process#1',
      'src/ui/probe.ts#<module>#process#2',
    ]);

    expect(
      ambientBoundarySitesFor(
        'src/tasks/application/probe.ts',
        syntaxFromText(
          'src/tasks/application/probe.ts',
          'new Date(); Date(); Date.now(); window.location; document.title;',
        ),
      ),
    ).toEqual([
      'src/tasks/application/probe.ts:new Date',
      'src/tasks/application/probe.ts:Date()',
      'src/tasks/application/probe.ts:Date.now',
      'src/tasks/application/probe.ts:window',
      'src/tasks/application/probe.ts:document',
    ]);
  });

  it('unwraps safe TypeScript call-target wrappers before enumerating process calls', () => {
    const path = 'src/ui/probe.ts';
    const module = syntaxFromText(
      path,
      [
        'type Fn = (value: unknown) => void;',
        '(writer.process)(value);',
        'writer.process!(value);',
        '(writer.process as Fn)(value);',
        '(<Fn>writer.process)(value);',
        '(writer.process satisfies Fn)(value);',
        '(writer["process"])(value);',
        'writer["process"]!(value);',
        '(writer["process"] as Fn)(value);',
        '(<Fn>writer["process"])(value);',
        '(writer["process"] satisfies Fn)(value);',
        'writer?.process?.(value);',
      ].join('\n'),
    );

    expect(writerSitesFor(path, module)).toEqual(
      Array.from({ length: 11 }, (_, index) => `${path}#<module>#process#${index + 1}`),
    );
  });

  it('removes every temporary mutation bridge and bridge marker', () => {
    const existing = LEGACY_BRIDGE_FILES.filter((path) => existsSync(resolve(ROOT, path)));
    const markers = sourceFiles()
      .map(repoPath)
      .filter((path) => source(path).includes('TASK-ARCH-BRIDGE'));

    expect({ existing, markers }).toEqual({ existing: [], markers: [] });
  });

  it('keeps every process or vault-create call on one exact, reasoned allowlist', () => {
    expect(writerSites()).toEqual(Object.keys(ALLOWED_WRITER_CALLS).sort());
    expect(
      Object.values(ALLOWED_WRITER_CALLS).every(
        (entry) => entry.mutation.length > 0 && entry.reason.trim().length > 0,
      ),
    ).toBe(true);
  });

  it('keeps exactly one single-task transaction boundary', () => {
    expect(
      Object.entries(ALLOWED_WRITER_CALLS)
        .filter(([, entry]) => entry.mutation === 'single-task transaction')
        .map(([site]) => site),
    ).toEqual([
      'src/tasks/infrastructure/obsidian/ObsidianTaskRepository.ts#ObsidianTaskRepository.processFile#process#1',
    ]);
  });

  it('keeps calendar modules free of repository and Vault writes', () => {
    const safe = syntaxFromText(
      'src/views/probe.ts',
      'tasks.execute(command); app.vault.cachedRead(file); taskSnapshotForCalendarOccurrence(occurrence);',
    );
    const unsafe = syntaxFromText(
      'src/views/probe.ts',
      'app.vault.process(file, update); app.vault.modify(file, text); repository.completeRecurrence(request);',
    );
    expect(calendarWriteSitesFor('src/views/probe.ts', safe)).toEqual([]);
    expect(calendarWriteSitesFor('src/views/probe.ts', unsafe)).toEqual([
      'src/views/probe.ts:app.vault.process',
      'src/views/probe.ts:app.vault.modify',
      'src/views/probe.ts:repository.completeRecurrence',
    ]);
    expect(calendarModules().flatMap((path) => calendarWriteSitesFor(path, syntax(path)))).toEqual(
      [],
    );
  });

  it('forbids forecast-to-snapshot casts while allowing the calendar occurrence adapter', () => {
    const probe = syntaxFromText(
      'src/views/probe.ts',
      [
        'const safe: TaskSnapshot = taskSnapshotForCalendarOccurrence(occurrence);',
        'const first = forecast as TaskSnapshot;',
        'const second = projectedOccurrence as unknown as TaskSnapshot;',
        'const third = <TaskSnapshot[]>forecastProjection;',
      ].join('\n'),
    );
    expect(unsafeForecastSnapshotCastsFor('src/views/probe.ts', probe)).toEqual([
      'src/views/probe.ts:forecast as TaskSnapshot',
      'src/views/probe.ts:projectedOccurrence as unknown as TaskSnapshot',
      'src/views/probe.ts:forecastProjection as TaskSnapshot[]',
    ]);
    expect(
      calendarModules().flatMap((path) => unsafeForecastSnapshotCastsFor(path, syntax(path))),
    ).toEqual([]);
  });

  it('routes every mounted recurrence editor write through TaskApplicationApi', () => {
    expect(
      RECURRENCE_EDITOR_WRITE_CONSUMERS.flatMap((path) =>
        recurrenceSubmitRoutesFor(path, syntax(path)),
      ),
    ).toEqual([
      'src/panels/CenterPanel.ts:TaskApplicationApi.execute',
      'src/panels/CenterPanel.ts:TaskApplicationApi.execute',
      'src/panels/RightPanel.ts:executePlanningPatch',
      'src/ui/CalendarRenderer.ts:TaskApplicationApi.execute',
      'src/ui/CalendarRenderer.ts:TaskApplicationApi.execute',
    ]);
    expect(
      memberApplicationExecuteCount(syntax('src/panels/RightPanel.ts'), 'executePlanningPatch'),
    ).toBe(2);
  });

  it('keeps the public task barrel exact and backed by named production consumers', () => {
    expect(barrelExports()).toEqual(Object.keys(PUBLIC_TASK_EXPORT_CONSUMERS).sort());
    for (const [exportName, consumers] of Object.entries(PUBLIC_TASK_EXPORT_CONSUMERS)) {
      expect(
        consumers.some((path) => publicTaskImports(path).has(exportName)),
        `${exportName} must have a named production import from src/tasks/index.ts`,
      ).toBe(true);
    }
  });

  it('keeps every public application/query member exercised by a named production consumer', () => {
    expect(publicInterfaceMembers()).toEqual(Object.keys(PUBLIC_INTERFACE_MEMBER_CONSUMERS).sort());
    for (const [member, path] of Object.entries(PUBLIC_INTERFACE_MEMBER_CONSUMERS)) {
      const name = member.slice(member.indexOf('.') + 1);
      expect(propertyAccesses(path).has(name)).toBe(true);
    }
  });

  it('keeps Project presentation reads on joined workspace snapshots', () => {
    expect(
      [
        'src/panels/LeftPanel.ts',
        'src/panels/CenterPanel.ts',
        'src/panels/projects/ProjectsPanel.ts',
      ]
        .flatMap(projectStoreReadSites)
        .sort(),
    ).toEqual([]);
  });

  it('rejects the retired tc UI namespace', () => {
    expect(retiredNamespaceSites()).toEqual([]);
  });
});
