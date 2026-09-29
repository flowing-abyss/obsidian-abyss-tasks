import ts from 'typescript';

/**
 * A module another module loads at run time: the declaration or call that loads it, and its
 * specifier, which is undefined when the call names its module with anything but a string literal.
 */
export type RuntimeReference =
  | {
      readonly form: 'import' | 'export' | 'import-equals';
      readonly node: ts.Statement;
      readonly specifier: string | undefined;
    }
  | {
      readonly form: 'require' | 'dynamic-import';
      readonly node: ts.CallExpression;
      readonly specifier: string | undefined;
    };

/** Whether an import clause is `import type`, which loads nothing at run time. */
export function isTypeOnlyImport(clause: ts.ImportClause | undefined): boolean {
  return clause?.phaseModifier === ts.SyntaxKind.TypeKeyword;
}

function literalText(expression: ts.Expression | undefined): string | undefined {
  return expression !== undefined && ts.isStringLiteralLike(expression)
    ? expression.text
    : undefined;
}

/** An import or export declaration that loads its module: any but `import type` and `export type`. */
function declarationReference(statement: ts.Statement): RuntimeReference | undefined {
  if (ts.isImportDeclaration(statement)) {
    return isTypeOnlyImport(statement.importClause)
      ? undefined
      : { form: 'import', node: statement, specifier: literalText(statement.moduleSpecifier) };
  }
  if (ts.isExportDeclaration(statement)) {
    return statement.isTypeOnly || statement.moduleSpecifier === undefined
      ? undefined
      : { form: 'export', node: statement, specifier: literalText(statement.moduleSpecifier) };
  }
  if (
    ts.isImportEqualsDeclaration(statement) &&
    !statement.isTypeOnly &&
    ts.isExternalModuleReference(statement.moduleReference)
  ) {
    return {
      form: 'import-equals',
      node: statement,
      specifier: literalText(statement.moduleReference.expression),
    };
  }
  return undefined;
}

/** A `require()` or `import()` call, which can stand anywhere in a module. */
function callReference(call: ts.CallExpression): RuntimeReference | undefined {
  const [first] = call.arguments;
  if (call.expression.kind === ts.SyntaxKind.ImportKeyword) {
    return { form: 'dynamic-import', node: call, specifier: literalText(first) };
  }
  if (ts.isIdentifier(call.expression) && call.expression.text === 'require') {
    return { form: 'require', node: call, specifier: literalText(first) };
  }
  return undefined;
}

/**
 * Every module `file` loads at run time, in the order the file names them: import declarations
 * other than `import type` (an inline `import { type X }` still loads its module under
 * verbatimModuleSyntax), side-effect imports, `export … from` and `export * from` other than
 * `export type`, `import x = require()`, `require()`, and `import()`. `onNode`, when given,
 * sees every node the reader passes, types left out, so that a caller reads the file in one pass.
 */
export function runtimeReferences(
  file: ts.SourceFile,
  onNode?: (node: ts.Node) => void,
): RuntimeReference[] {
  const references: RuntimeReference[] = [];
  const visit = (node: ts.Node): void => {
    // A type loads nothing at run time; a class's `extends` clause is a value.
    if (ts.isTypeNode(node) && !ts.isExpressionWithTypeArguments(node)) return;
    onNode?.(node);
    const reference = ts.isCallExpression(node) ? callReference(node) : undefined;
    if (reference !== undefined) references.push(reference);
    ts.forEachChild(node, visit);
  };
  for (const statement of file.statements) {
    const reference = declarationReference(statement);
    if (reference !== undefined) references.push(reference);
    visit(statement);
  }
  return references;
}
