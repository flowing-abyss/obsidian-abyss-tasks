import { describe, expect, it } from 'vitest';
import { buildTaskDependencyGraph, enumerateTaskNodes } from '../src/tasks/domain/taskDependencies';
import {
  dependencyCountPresentation,
  dependencyIndicatorPresentation,
} from '../src/ui/taskDependencyPresentation';
import { canonicalStatusCatalog, task } from './helpers';

describe('dependency count presentation', () => {
  it('names both active directions without counting satisfied or missing relations', () => {
    const current = task({ dependencyId: 'current', dependsOn: ['a', 'b', 'done', 'missing'] });
    const roots = [
      current,
      ...['a', 'b', 'done', 'one', 'two', 'three', 'finished'].map((title) =>
        task({
          title,
          dependencyId: title,
          dependsOn: ['one', 'two', 'three', 'finished'].includes(title) ? ['current'] : [],
          statusSymbol: ['done', 'finished'].includes(title) ? 'x' : ' ',
          source: { filePath: `${title}.md` },
        }),
      ),
    ];
    const catalog = canonicalStatusCatalog();
    const projection = buildTaskDependencyGraph(enumerateTaskNodes(roots), (symbol) =>
      catalog.statusForSymbol(symbol),
    ).dependencies({ type: 'task', ref: current.ref });
    expect(dependencyCountPresentation(projection)).toEqual({
      blockedBy: 2,
      blocks: 3,
      ariaLabel: 'Dependencies: blocked by 2; blocks 3',
      title: 'Dependencies: blocked by 2; blocks 3',
    });
  });
});

describe('active dependency indicator', () => {
  it.each([
    { dependsOn: ['done', 'missing'], inverse: false, expected: { type: 'none' } },
    {
      dependsOn: ['a', 'duplicate'],
      inverse: false,
      expected: {
        type: 'blocked-by',
        blockedBy: 2,
        ariaLabel: 'Dependencies: blocked by 2; blocks 0',
      },
    },
    {
      dependsOn: ['done'],
      inverse: true,
      expected: { type: 'blocks', blocks: 1, ariaLabel: 'Dependencies: blocked by 0; blocks 1' },
    },
    {
      dependsOn: ['a', 'duplicate'],
      inverse: true,
      expected: {
        type: 'both',
        blockedBy: 2,
        blocks: 1,
        ariaLabel: 'Dependencies: blocked by 2; blocks 1',
      },
    },
  ])(
    'derives $expected.type from active graph relations only',
    ({ dependsOn, inverse, expected }) => {
      const current = task({ dependencyId: 'current', dependsOn });
      const roots = [
        current,
        ...[
          { title: 'a', dependencyId: 'a', statusSymbol: ' ' },
          { title: 'done', dependencyId: 'done', statusSymbol: 'x' },
          { title: 'duplicate-done', dependencyId: 'duplicate', statusSymbol: 'x' },
          { title: 'duplicate-open', dependencyId: 'duplicate', statusSymbol: ' ' },
          { title: 'dependent', dependsOn: inverse ? ['current'] : [], statusSymbol: ' ' },
          { title: 'finished-dependent', dependsOn: ['current'], statusSymbol: 'x' },
        ].map((node) =>
          task({
            ...node,
            description: 'Must never become an indicator subtitle',
            source: { filePath: `${node.title}.md` },
          }),
        ),
      ];
      const catalog = canonicalStatusCatalog();
      const projection = buildTaskDependencyGraph(enumerateTaskNodes(roots), (symbol) =>
        catalog.statusForSymbol(symbol),
      ).dependencies({ type: 'task', ref: current.ref });
      expect(dependencyIndicatorPresentation(projection)).toEqual(expected);
    },
  );
});
