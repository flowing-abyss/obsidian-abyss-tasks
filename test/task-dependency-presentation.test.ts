import { describe, expect, it } from 'vitest';
import { buildTaskDependencyGraph, enumerateTaskNodes } from '../src/tasks/domain/taskDependencies';
import { dependencyCountPresentation } from '../src/ui/taskDependencyPresentation';
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
