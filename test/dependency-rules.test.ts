import { cruise, type ICruiseResult } from 'dependency-cruiser';
import extractDepcruiseOptions from 'dependency-cruiser/config-utl/extract-depcruise-options';
import path from 'node:path';
import { expect, it } from 'vitest';

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
    'task-application-depends-inward',
    'task-domain-is-pure',
    'task-infrastructure-depends-inward',
    'task-presentation-uses-public-entry',
    'task-presentation-uses-public-entry',
  ]);
  expect(
    graph.summary.violations
      .map(({ rule, from, to }) => `${rule.name}:${from}->${to}`)
      .sort((left, right) => left.localeCompare(right)),
  ).toEqual([
    'task-application-depends-inward:src/tasks/application/invalid-outward.ts->src/tasks/infrastructure/valid.ts',
    'task-domain-is-pure:src/tasks/domain/invalid-external.ts->src/settings/value.ts',
    'task-infrastructure-depends-inward:src/tasks/infrastructure/invalid-outward.ts->src/settings/value.ts',
    'task-presentation-uses-public-entry:src/panels/invalid-deep-dynamic.ts->src/tasks/domain/value.ts',
    'task-presentation-uses-public-entry:src/panels/invalid-deep-type.ts->src/tasks/domain/value.ts',
  ]);
  expect(graph.summary.error).toBe(5);
  expect(graph.summary.warn).toBe(0);
});
