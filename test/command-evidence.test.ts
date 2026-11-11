import { expect, it } from 'vitest';
import { CommandEvidence } from '../src/ai/CommandEvidence';
it('requires an accepted current result rather than a catalog or item observation', () => {
  const evidence = new CommandEvidence();
  expect(() => evidence.ready()).toThrow();
  evidence.accept({ action: 'inspect', entity: 'catalog', complete: true });
  evidence.accept({
    action: 'find',
    entity: 'task',
    target: 'root',
    complete: true,
  });
  expect(() => evidence.ready()).toThrow();
  evidence.accept({
    action: 'inspect',
    entity: 'task',
    target: 'root',
    complete: true,
  });
  expect(evidence.ready()).toBe('observed');
});
it('invalidates removed state without turning an old inspection into a mutation acknowledgement', () => {
  const evidence = new CommandEvidence();
  evidence.accept({
    action: 'inspect',
    entity: 'task',
    target: 'root',
    complete: true,
  });
  expect(evidence.ready()).toBe('observed');
  evidence.remove('root');
  evidence.accept({
    action: 'inspect',
    entity: 'task',
    target: 'root',
    complete: true,
  });
  expect(() => evidence.ready()).toThrow();
  evidence.accept({
    action: 'change',
    entity: 'task',
    target: 'root',
    removal: true,
  });
  expect(evidence.ready()).toBe('prepared');
});
it('records exact selection replacement including an empty accepted selection', () => {
  const evidence = new CommandEvidence();
  evidence.clearFocus();
  evidence.accept({ action: 'focus', entity: 'task', target: 'root' });
  evidence.clearFocus();
  expect(evidence.ready()).toBe('selected');
});
it.each(['task', 'note', 'project'] as const)(
  'keeps %s item observation distinct from aggregate query coverage',
  (entity) => {
    const evidence = new CommandEvidence();
    evidence.accept({ action: 'find', entity, target: 'root', complete: true });
    const partial = evidence.discovery({
      entity,
      query: 'Root',
      scope: { path: 'a.md' },
      count: 1,
      complete: false,
    });
    expect(() => evidence.ready()).toThrow();
    expect(evidence.ready('page')).toBe('found');
    expect(() => evidence.question('not-found', partial)).toThrow();
    evidence.discovery({
      entity,
      query: 'Root',
      scope: { path: 'a.md' },
      count: 1,
      complete: true,
    });
    expect(evidence.ready()).toBe('found');
    expect(() => evidence.question('incomplete', partial)).toThrow();
  },
);
it('binds questions to immutable actual queries, scopes and completeness', () => {
  const evidence = new CommandEvidence();
  const root = evidence.discovery({
    entity: 'task',
    query: 'Root',
    scope: { inbox: true },
    count: 0,
    complete: true,
  });
  const contact = evidence.discovery({
    entity: 'task',
    query: 'Contact',
    scope: {},
    count: 2,
    complete: false,
  });
  expect(evidence.question('not-found', root)).toEqual({
    entity: 'task',
    query: 'Root',
    scope: { inbox: true },
    count: 0,
    complete: true,
  });
  expect(() => evidence.question('not-found', contact)).toThrow();
  expect(() => evidence.question('ambiguous', contact)).toThrow();
  expect(() => evidence.question('not-found', 'invented')).toThrow();
  const complete = evidence.discovery({
    entity: 'task',
    query: 'Contact',
    scope: {},
    count: 2,
    complete: true,
  });
  expect(evidence.question('ambiguous', complete).query).toBe('Contact');
});
it('offers only current unused empty lookup retries and complete change corrections', () => {
  const evidence = new CommandEvidence();
  const query = { entity: 'task' as const, query: 'Proof', scope: {}, count: 0, complete: true };
  evidence.discovery({ ...query, entity: 'note' });
  const partial = evidence.discovery({ ...query, complete: false });
  evidence.expectTaskChange(partial, 'change', undefined, []);
  expect(evidence.retryableFindEvidence()).toEqual([]);
  const empty = evidence.discovery(query);
  evidence.expectTaskChange(empty, 'remove', undefined, []);
  expect(evidence.retryableFindEvidence()).toEqual([empty]);
  const alternative = evidence.discovery({ ...query, query: 'Homework' });
  evidence.retryTaskLookup(empty, alternative, 'remove');
  evidence.expectTaskChange(alternative, 'remove', undefined, []);
  expect(evidence.retryableFindEvidence()).toEqual([]);
  const row = { target: 'root', revision: '1' };
  const old = evidence.discovery({ ...query, count: 1 });
  evidence.expectTaskChange(old, 'change', row, [row]);
  const current = evidence.discovery({ ...query, count: 1 });
  evidence.expectTaskChange(current, 'change', row, [row]);
  expect(evidence.retryableFindEvidence()).toEqual([current]);
});
it('requires actual specific unsupported capability evidence, never just any catalog', () => {
  const evidence = new CommandEvidence();
  const catalog = evidence.discovery({
    entity: 'catalog',
    query: 'statuses',
    scope: {},
    count: 0,
    complete: true,
  });
  expect(() => evidence.question('unsupported', catalog)).toThrow();
  const field = evidence.discovery({
    entity: 'catalog',
    query: 'tracking',
    scope: { catalog: 'project-schema' },
    count: 0,
    complete: true,
    unsupported: true,
  });
  expect(evidence.question('unsupported', field).query).toBe('tracking');
});

it('rejects superseded evidence after the same query is refreshed', () => {
  const evidence = new CommandEvidence();
  const fact = { entity: 'task' as const, query: 'Root', scope: {}, count: 0, complete: true };
  const old = evidence.discovery(fact);
  expect(evidence.question('not-found', old).query).toBe('Root');
  evidence.discovery({ ...fact, count: 1 });
  expect(() => evidence.question('not-found', old)).toThrow();
});
it('invalidates removed focus while retaining an explicit empty selection', () => {
  const evidence = new CommandEvidence();
  evidence.clearFocus(false);
  evidence.accept({ action: 'focus', entity: 'task', target: 'root' });
  evidence.remove('root');
  expect(() => evidence.ready()).toThrow();
  evidence.clearFocus(true);
  expect(evidence.ready()).toBe('selected');
});
it('keeps an unresolved scoped mutation when another scope contains the same title', () => {
  const evidence = new CommandEvidence();
  const page = {
    entity: 'task' as const,
    query: 'Homework',
    scope: { path: 'a.md' },
    count: 2,
    complete: false,
  };
  evidence.expectTaskChange(evidence.discovery(page), 'remove', undefined, [
    { target: 'a', revision: '1' },
  ]);
  const other = evidence.discovery({ ...page, scope: { path: 'b.md' }, count: 1, complete: true });
  evidence.expectTaskChange(other, 'remove', { target: 'b', revision: '2' }, []);
  evidence.accept({ action: 'change', entity: 'task', target: 'b', revision: '2', removal: true });
  expect(() => {
    evidence.checkTaskChanges();
  }).toThrow(/unique/);
});
it('requires a fresh correction for a newly declared edit of the same saved version', () => {
  const evidence = new CommandEvidence(),
    row = { target: 'task', revision: '1' };
  const query = { entity: 'task' as const, query: 'Homework', scope: {}, count: 1, complete: true };
  const original = evidence.discovery(query);
  evidence.expectTaskChange(original, 'change', row, [row]);
  evidence.correctDisplayLookup(original, evidence.discovery(query), [row]);
  evidence.checkTaskChanges([row]);
  evidence.expectTaskChange(evidence.discovery(query), 'change', row, [row]);
  expect(() => {
    evidence.checkTaskChanges([row]);
  }).toThrow(/no preview/);
  expect(() => {
    evidence.correctDisplayLookup(original, evidence.discovery(query), [row]);
  }).toThrow();
});
it('does not retry an old empty search once the same scope has reported a match', () => {
  const evidence = new CommandEvidence();
  const query = {
    entity: 'task' as const,
    query: 'Study',
    scope: { path: 'a.md' },
    count: 0,
    complete: true,
  };
  const empty = evidence.discovery(query);
  evidence.expectTaskChange(empty, 'remove', undefined, []);
  evidence.discovery({ ...query, count: 1 });
  const alternative = evidence.discovery({ ...query, query: 'Homework', count: 1 });
  expect(() => {
    evidence.retryTaskLookup(empty, alternative, 'remove');
  }).toThrow();
});
it('binds corrected descendants to their saved branch and original change only', () => {
  const evidence = new CommandEvidence();
  const root = { target: 'Orbit', revision: '1' };
  const child = { target: 'Echo', revision: '2', children: [] };
  const query = { entity: 'task' as const, query: 'Orbit', scope: {}, count: 1, complete: true };
  const original = evidence.discovery(query);
  evidence.expectTaskChange(original, 'change', root, [root]);
  evidence.correctDisplayLookup(original, evidence.discovery(query), [root]);
  evidence.observeSavedBranch({ ...root, revision: 'different', children: [child] });
  expect(() => {
    evidence.checkTaskChanges([child]);
  }).toThrow(/no preview/);
  evidence.observeSavedBranch({ ...root, children: [child] });
  evidence.checkTaskChanges([child]);
  expect(() => {
    evidence.checkTaskChanges([{ ...child, revision: 'different' }]);
  }).toThrow(/no preview/);
  const removal = evidence.discovery({ ...query, query: 'Echo' });
  evidence.expectTaskChange(removal, 'remove', child, [child]);
  expect(() => {
    evidence.checkTaskChanges([child]);
  }).toThrow(/removal has no preview/);
  expect(() => {
    evidence.correctDisplayLookup(removal, evidence.discovery({ ...query, query: 'Echo' }), [
      child,
    ]);
  }).toThrow();
});
it('allows a parent lookup correction only for a prepared change on the observed descendant version', () => {
  const evidence = new CommandEvidence();
  const parent = { target: 'Relay', revision: 'parent-revision' };
  const child = { target: 'North', revision: 'child-revision', children: [] };
  const query = { entity: 'task' as const, query: 'Relay', scope: {}, count: 1, complete: true };
  const lookup = evidence.discovery(query);
  evidence.expectTaskChange(lookup, 'change', parent, [parent]);
  evidence.observeSavedBranch({ ...parent, children: [child] });
  const repeated = evidence.discovery(query);
  evidence.correctParentLookup(lookup, repeated, [parent]);
  for (const fact of [
    { action: 'inspect' as const, ...child },
    { action: 'change' as const, ...child, revision: 'other-revision' },
    { action: 'change' as const, target: 'unrelated', revision: 'child-revision' },
  ]) {
    evidence.accept({ entity: 'task', ...fact });
    expect(() => {
      evidence.checkTaskChanges();
    }).toThrow(/no preview/u);
  }
  evidence.accept({ action: 'change', entity: 'task', ...child });
  evidence.checkTaskChanges();
  evidence.expectTaskChange(evidence.discovery(query), 'change', parent, [parent]);
  expect(() => {
    evidence.checkTaskChanges();
  }).toThrow(/no preview/u);
});
it('keeps another ambiguous change unresolved when a corrected display search shares one candidate', () => {
  const evidence = new CommandEvidence();
  const north = { target: 'north', revision: 'n1' },
    south = { target: 'south', revision: 's1' };
  const query = { entity: 'task' as const, query: 'Proof', scope: {}, count: 2, complete: true };
  evidence.expectTaskChange(evidence.discovery(query), 'change', undefined, [north, south]);
  const scoped = { ...query, query: 'North', count: 1 };
  const lookup = evidence.discovery(scoped);
  evidence.expectTaskChange(lookup, 'change', north, [north]);
  evidence.correctDisplayLookup(lookup, evidence.discovery(scoped), [north]);
  expect(() => {
    evidence.checkTaskChanges([north]);
  }).toThrow(/unique/u);
});
it('rejects a parent lookup correction when repeating it finds an additional candidate', () => {
  const evidence = new CommandEvidence();
  const root = { target: 'root', revision: 'r1' },
    child = { target: 'north', revision: 'n1', children: [] };
  const query = { entity: 'task' as const, query: 'Relay', scope: {}, count: 1, complete: true };
  const lookup = evidence.discovery(query);
  evidence.expectTaskChange(lookup, 'change', root, [root]);
  evidence.observeSavedBranch({ ...root, children: [child] });
  expect(() => {
    evidence.correctParentLookup(lookup, evidence.discovery({ ...query, count: 2 }), [
      root,
      { target: 'other', revision: 'o1' },
    ]);
  }).toThrow(/verified parent/u);
});
