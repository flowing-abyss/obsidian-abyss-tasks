// @vitest-environment node
import { cruise, type ICruiseResult } from 'dependency-cruiser';
import extractDepcruiseOptions from 'dependency-cruiser/config-utl/extract-depcruise-options';
import { Platform } from 'obsidian';
import { expect, it } from 'vitest';

const loadPath = async () => {
  if (!Platform.isDesktop) throw new Error('Dependency rule tests require a desktop runtime');
  return import('node:path');
};
const path = await loadPath();

const ROOT = path.resolve(import.meta.dirname, '..');
const FIXTURE_ROOT = path.join(ROOT, 'test/fixtures/task-architecture');

it('rejects each task boundary by its stable rule name', async () => {
  const options = await extractDepcruiseOptions(path.join(ROOT, 'dependency-cruiser.config.cjs'));
  const result = await cruise(['src'], {
    ...options,
    baseDir: FIXTURE_ROOT,
    tsConfig: { fileName: path.join(ROOT, 'tsconfig.json') },
  });
  expect(typeof result.output).not.toBe('string');
  const graph = result.output as ICruiseResult;
  expect(
    graph.summary.violations
      .map(({ rule }) => rule.name)
      .sort((left, right) => left.localeCompare(right)),
  ).toEqual([
    'markdown-imports-no-task-layer',
    'markdown-imports-no-task-layer',
    'task-application-depends-inward',
    'task-domain-is-pure',
    'task-domain-is-pure',
    'task-infrastructure-depends-inward',
    'task-infrastructure-depends-inward',
    'task-infrastructure-depends-inward',
    'task-presentation-uses-public-entry',
    'task-presentation-uses-public-entry',
  ]);
  expect(
    graph.summary.violations
      .map(({ rule, from, to }) => `${rule.name}:${from}->${to}`)
      .sort((left, right) => left.localeCompare(right)),
  ).toEqual([
    'markdown-imports-no-task-layer:src/markdown/invalid-task-entry.ts->src/tasks/index.ts',
    'markdown-imports-no-task-layer:src/markdown/invalid-task-layer.ts->src/tasks/domain/value.ts',
    'task-application-depends-inward:src/tasks/application/invalid-outward.ts->src/tasks/infrastructure/valid.ts',
    'task-domain-is-pure:src/tasks/domain/invalid-external.ts->src/settings/value.ts',
    'task-domain-is-pure:src/tasks/domain/invalid-markdown.ts->src/markdown/valid.ts',
    'task-infrastructure-depends-inward:src/tasks/infrastructure/invalid-outward.ts->src/settings/value.ts',
    'task-infrastructure-depends-inward:src/tasks/infrastructure/invalid-package.ts->../../../node_modules/.pnpm/minisearch@7.2.0/node_modules/minisearch/dist/umd/index.js',
    'task-infrastructure-depends-inward:src/tasks/infrastructure/search/invalid-package.ts->../../../node_modules/.pnpm/rrule@2.8.1/node_modules/rrule/dist/es5/rrule.js',
    'task-presentation-uses-public-entry:src/panels/invalid-deep-dynamic.ts->src/tasks/domain/value.ts',
    'task-presentation-uses-public-entry:src/panels/invalid-deep-type.ts->src/tasks/domain/value.ts',
  ]);
  expect(graph.summary.error).toBe(10);
  expect(graph.summary.warn).toBe(0);
});

it('allows only the neutral browser scheduler bridge and rejects reversed ownership', async () => {
  const options = await extractDepcruiseOptions(path.join(ROOT, 'dependency-cruiser.config.cjs'));
  const result = await cruise(['src'], {
    ...options,
    baseDir: path.join(ROOT, 'test/fixtures/organization-architecture'),
    tsConfig: { fileName: path.join(ROOT, 'tsconfig.json') },
  });
  const graph = result.output as ICruiseResult;
  const violations = graph.summary.violations.map(
    ({ rule, from, to }) => `${rule.name}:${from}->${to}`,
  );
  expect(violations).toContain(
    'browser-task-scheduler-is-neutral:src/browserTaskScheduler.ts->src/tasks/infrastructure/invalid.ts',
  );
  expect(violations).toContain(
    'task-infrastructure-depends-inward:src/tasks/infrastructure/invalid.ts->src/browserTaskScheduler.ts',
  );
  expect(violations).toContain(
    'task-presentation-uses-public-entry:src/panels/invalid.ts->src/tasks/infrastructure/search/BrowserTaskSearchBackend.ts',
  );
  expect(violations.some((v) => v.includes(':src/panels/valid.ts->'))).toBe(false);
  expect(violations.some((v) => v.startsWith('task-browser-scheduler-adapter:'))).toBe(false);
});
