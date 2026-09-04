import { ESLint } from 'eslint';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const ROOT = ts.sys.resolvePath(`${import.meta.dirname}/..`);
const eslint = new ESLint({
  cwd: ROOT,
  overrideConfigFile: ts.sys.resolvePath(`${ROOT}/eslint.config.mts`),
});
const ARCHITECTURE_RULES = new Set([
  'no-restricted-imports',
  'no-restricted-syntax',
  'no-restricted-globals',
]);

interface Diagnostic {
  readonly ruleId: string | null;
  readonly message: string;
  readonly fatal?: boolean;
}

async function diagnostics(path: string, source: string): Promise<readonly Diagnostic[]> {
  const [result] = await eslint.lintText(source, {
    filePath: ts.sys.resolvePath(`${ROOT}/${path}`),
  });
  return (
    result?.messages.map(({ ruleId, message, fatal }) => ({
      ruleId,
      message,
      ...(fatal === undefined ? {} : { fatal }),
    })) ?? []
  );
}

function architectureDiagnostics(items: readonly Diagnostic[]) {
  return items
    .filter((item) => item.ruleId !== null && ARCHITECTURE_RULES.has(item.ruleId))
    .map(({ ruleId, message }) => ({ ruleId, message }));
}

function expectParseSafe(items: readonly Diagnostic[]): void {
  expect(items.some((item) => item.fatal === true || item.ruleId === null)).toBe(false);
}

describe('task architecture ESLint boundaries', () => {
  it.each([
    ['src/tasks/infrastructure/TaskIndex.ts', "import '@vendor/ui/widget';"],
    ['src/ui/StatusMarker.ts', "import '@vendor/tasks/domain';"],
  ])(
    'does not classify an external package as a local layer from %s',
    async (path, source) => {
      const items = await diagnostics(path, source);
      expectParseSafe(items);
      expect(architectureDiagnostics(items)).toEqual([]);
    },
    15_000,
  );

  it.each([
    [
      'src/tasks/infrastructure/TaskIndex.ts',
      "import '../../ui/StatusMarker';",
      {
        ruleId: 'no-restricted-imports',
        message:
          "'../../ui/StatusMarker' import is restricted from being used by a pattern. Task infrastructure must not depend on presentation modules.",
      },
    ],
    [
      'src/ui/StatusMarker.ts',
      "import '../tasks/domain/types';",
      {
        ruleId: 'no-restricted-imports',
        message:
          "'../tasks/domain/types' import is restricted from being used by a pattern. Presentation imports task contracts only through src/tasks/index.ts.",
      },
    ],
    [
      'src/tasks/domain/validation.ts',
      "import { Notice } from 'obsidian';",
      {
        ruleId: 'no-restricted-imports',
        message:
          "'obsidian' import is restricted from being used by a pattern. Task domain may import only sibling domain modules.",
      },
    ],
    [
      'src/tasks/application/TaskApplicationApi.ts',
      "import { Notice } from 'obsidian';",
      {
        ruleId: 'no-restricted-imports',
        message:
          "'obsidian' import is restricted from being used by a pattern. Task application may depend only on domain contracts and application ports.",
      },
    ],
  ])('rejects a forbidden import at the %s boundary', async (path, source, expected) => {
    const items = await diagnostics(path, source);
    expectParseSafe(items);
    expect(architectureDiagnostics(items)).toEqual([expected]);
  });

  it.each([
    [
      'src/tasks/domain/validation.ts',
      'Task domain receives time through explicit values or a Clock port.',
      'Task domain cannot depend on browser ambient state.',
    ],
    [
      'src/tasks/application/TaskApplicationApi.ts',
      'Task application receives time through its Clock port.',
      'Task application cannot depend on browser ambient state.',
    ],
  ])('rejects ambient time and DOM access in %s', async (path, timeMessage, domMessage) => {
    const items = await diagnostics(
      path,
      'new Date(); Date(); Date.now(); window.location; document.title;',
    );
    expectParseSafe(items);
    expect(architectureDiagnostics(items)).toEqual([
      { ruleId: 'no-restricted-syntax', message: timeMessage },
      { ruleId: 'no-restricted-syntax', message: timeMessage },
      { ruleId: 'no-restricted-syntax', message: timeMessage },
      {
        ruleId: 'no-restricted-globals',
        message: `Unexpected use of 'window'. ${domMessage}`,
      },
      {
        ruleId: 'no-restricted-globals',
        message: `Unexpected use of 'document'. ${domMessage}`,
      },
    ]);
  });

  it.each([
    'adapter.process(value);',
    "adapter['process'](value);",
    '(adapter.process)(value);',
    'adapter.process!(value);',
    '(adapter.process as (value: unknown) => void)(value);',
    "(adapter['process'])(value);",
    "adapter['process']!(value);",
    "(adapter['process'] as (value: unknown) => void)(value);",
    'adapter?.process?.(value);',
  ])('rejects a presentation-side process reference: %s', async (source) => {
    const items = await diagnostics('src/ui/StatusMarker.ts', source);
    expectParseSafe(items);
    expect(architectureDiagnostics(items)).toEqual([
      {
        ruleId: 'no-restricted-syntax',
        message: 'Presentation sends task commands through TaskApplicationApi; it does not write.',
      },
    ]);
  });
});
