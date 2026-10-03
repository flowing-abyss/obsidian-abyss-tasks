import { afterEach, describe, expect, it, vi } from 'vitest';
import * as cloning from '../../src/tasks/domain/cloneTaskSnapshot';
import { buildTaskDependencyGraph } from '../../src/tasks/domain/taskDependencies';
import { TaskIndex } from '../../src/tasks/infrastructure/TaskIndex';
import { canonicalStatusCatalog, createAppWithFiles, expectDefined } from '../helpers';

const indexes: TaskIndex[] = [];
afterEach(() => {
  for (const index of indexes.splice(0)) index.destroy();
});
async function setup() {
  const app = await createAppWithFiles({ 'a.md': '- [ ] Blocker 🆔 a\n- [ ] Dependent ⛔ a\n' });
  const index = new TaskIndex(app, { statusCatalog: canonicalStatusCatalog() });
  indexes.push(index);
  await index.initialize();
  return index;
}
describe('noncloning dependency reads', () => {
  it('summary and rich reads do not call list/listNodes; standalone and borrowed graph parity', async () => {
    const index = await setup();
    const nodes = index.listNodes();
    const graph = buildTaskDependencyGraph(nodes, (symbol) =>
      canonicalStatusCatalog().statusForSymbol(symbol),
    );
    vi.spyOn(index, 'list').mockImplementation(() => {
      throw new Error('full list');
    });
    vi.spyOn(index, 'listNodes').mockImplementation(() => {
      throw new Error('full nodes');
    });
    for (const node of nodes) {
      const expected = graph.dependencies(node.target);
      expect(index.dependencySummary(node.target)).toEqual({
        activeBlockedByCount: expected.activeBlockedByCount,
        activeBlocksCount: expected.activeBlocksCount,
      });
      expect(index.dependencies(node.target)).toEqual(expected);
    }
  });
  it('graph requested/byRevision keys never JSON-concatenate source-bearing revision', async () => {
    const index = await setup();
    const nodes = index.listNodes();
    const revision = expectDefined(nodes[0]).root.ref.revision;
    const stringify = vi.spyOn(JSON, 'stringify');
    const graph = buildTaskDependencyGraph(nodes, () => 'open');
    graph.dependencies(expectDefined(nodes[0]).target);
    const argumentsSeen = stringify.mock.calls.map((call): unknown => call[0]);
    stringify.mockRestore();
    const contains = (value: unknown): boolean => {
      if (typeof value === 'string') return value.includes(revision);
      return Array.isArray(value) && value.some(contains);
    };
    expect(argumentsSeen.some(contains)).toBe(false);
  });
  it('public relation mutation cannot affect the next query', async () => {
    const index = await setup();
    const target = expectDefined(index.listNodes()[1]).target;
    const first = index.dependencies(target);
    expect(first.activeBlockedByCount).toBe(1);
    expect(Object.isFrozen(first)).toBe(true);
    index.installCommittedContent('a.md', '- [x] Blocker 🆔 a\n- [ ] Dependent ⛔ a\n');
    const next = expectDefined(index.listNodes()[1]).target;
    expect(index.dependencySummary(next).activeBlockedByCount).toBe(0);
  });
  it('borrowed graph does not clone or freeze canonical roots; rich reads detach neighbors once', async () => {
    const index = await setup();
    const target = expectDefined(index.listNodes()[1]).target;
    const clone = vi.spyOn(cloning, 'cloneTaskSnapshot');
    const detach = vi.spyOn(cloning, 'taskSnapshotWithStatuses');
    expect(index.dependencySummary(target).activeBlockedByCount).toBe(1);
    expect(clone).not.toHaveBeenCalled();
    expect(detach).not.toHaveBeenCalled();
    const rich = index.dependencies(target);
    expect(detach).toHaveBeenCalledTimes(1);
    const canonical = expectDefined(detach.mock.calls[0])[0];
    expect(Object.isFrozen(canonical)).toBe(false);
    expect(Object.isFrozen(canonical.comments)).toBe(false);
    const relation = expectDefined(rich.blockedBy[0]);
    if (relation.type !== 'resolved') throw new Error('missing relation');
    expect(Reflect.set(relation.task.node, 'title', 'changed')).toBe(false);
    expect(index.dependencies(target)).toEqual(rich);
  });
});
