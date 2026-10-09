import { describe, expect, it } from 'vitest';
import { planTaskNodeBatch } from '../src/panels/center/taskNodeBatch';
import { taskTreeNodes } from '../src/tasks/domain/taskSearchProjection';
import { expectDefined } from './helpers';
import { hierarchyHarness } from './support/taskHierarchyHarness';

describe('physical task node batch planning', () => {
  it('collapses selected subtrees, orders status deepest first, and retains independent patches', async () => {
    const h = await hierarchyHarness({
      'source.md': '- [ ] Parent\n  - [ ] Child\n    - [ ] Grandchild\n  - [ ] Child\n',
      'target.md': '- [ ] Other\n',
    });
    const nodes = [...taskTreeNodes(h.source)];
    const root = expectDefined(nodes[0]);
    const child = expectDefined(nodes[1]);
    const grandchild = expectDefined(nodes[2]);
    const sibling = expectDefined(nodes[3]);
    expect(planTaskNodeBatch([child, root, child], 'subtree').map((n) => n.node.title)).toEqual([
      'Parent',
    ]);
    expect(planTaskNodeBatch([root, child, child], 'status').map((n) => n.node.title)).toEqual([
      'Child',
      'Parent',
    ]);
    expect(planTaskNodeBatch([root, child, child], 'patch')).toHaveLength(2);
    expect(planTaskNodeBatch([child, sibling, grandchild], 'subtree')).toEqual([child, sibling]);
    expect(planTaskNodeBatch([root, sibling, grandchild], 'status')).toEqual([
      grandchild,
      sibling,
      root,
    ]);
    h.index.destroy();
  });
});
