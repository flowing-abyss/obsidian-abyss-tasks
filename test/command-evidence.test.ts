import { expect, it } from 'vitest';
import { CommandEvidence } from '../src/ai/CommandEvidence';
it('recognizes only retained non-removal task content as research preparation', () => {
  const evidence = new CommandEvidence();
  expect(evidence.requiresTaskContentPreparation()).toBe(false);
  evidence.accept({ action: 'research', entity: 'web', complete: true });
  expect(evidence.requiresTaskContentPreparation()).toBe(true);
  evidence.accept({ action: 'inspect', entity: 'task', target: 'old' });
  evidence.accept({ action: 'change', entity: 'note', target: 'note' });
  evidence.accept({ action: 'change', entity: 'project', target: 'project' });
  evidence.accept({ action: 'change', entity: 'task', target: 'removed', removal: true });
  evidence.accept({ action: 'change', entity: 'task', target: 'status-change', revision: 'r2' });
  expect(evidence.requiresTaskContentPreparation()).toBe(false);
  evidence.accept({ action: 'change', entity: 'task', target: 'status-change', removal: true });
  expect(evidence.requiresTaskContentPreparation()).toBe(true);
  evidence.accept({ action: 'change', entity: 'task', target: 'edited', revision: 'r1' });
  expect(evidence.requiresTaskContentPreparation()).toBe(false);
});
it('requires task preparation again when the only research draft is cancelled', () => {
  const evidence = new CommandEvidence();
  evidence.accept({ action: 'create', entity: 'task', target: 'draft', revision: 'r1' });
  expect(evidence.requiresTaskContentPreparation()).toBe(false);
  evidence.accept({ action: 'research', entity: 'web', complete: true });
  expect(evidence.requiresTaskContentPreparation()).toBe(false);
  evidence.accept({ action: 'change', entity: 'task', target: 'draft', removal: true });
  expect(evidence.requiresTaskContentPreparation()).toBe(true);
});
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
  }).toThrow(/Prepare change_task first/);
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
  }).toThrow(/Prepare change_task first/);
  evidence.observeSavedBranch({ ...root, children: [child] });
  evidence.checkTaskChanges([child]);
  expect(() => {
    evidence.checkTaskChanges([{ ...child, revision: 'different' }]);
  }).toThrow(/Prepare change_task first/);
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
it('offers an issued display retry only for the single saved version being selected', () => {
  const evidence = new CommandEvidence();
  const row = { target: 'row', revision: 'saved' };
  const query = { entity: 'task' as const, query: 'Review', scope: {}, count: 1, complete: true };
  const original = evidence.discovery(query);
  evidence.expectTaskChange(original, 'change', row, [row]);
  const references = { issuedFindEvidence: () => ['@1:q7'], issuedTaskEdit: () => '@1:b1' };
  const check = (displayed: (typeof row)[]) => () =>
    evidence.checkTaskChanges(displayed, references);
  expect(check([row])).toThrow(/purpose:"show-only".*retryOf:"@1:q7"/u);
  for (const displayed of [
    [],
    [{ ...row, revision: 'stale' }],
    [row, { ...row, target: 'other' }],
  ]) {
    expect(check(displayed)).toThrow(/change_task/u);
    expect(check(displayed)).not.toThrow(/show-only/u);
  }
  evidence.discovery({ ...query });
  expect(check([row])).not.toThrow(/show-only/u);
  evidence.expectTaskChange(evidence.discovery({ ...query }), 'change', row, [row]);
  expect(check([row])).toThrow(/show-only/u);
  const other = { target: 'other', revision: 'saved' };
  const otherLookup = evidence.discovery({ ...query, query: 'Other' });
  evidence.expectTaskChange(otherLookup, 'change', other, [other]);
  expect(check([row])).toThrow(/change_task/u);
  expect(check([row])).not.toThrow(/show-only/u);
});

it('allows a parent lookup correction only for a prepared change on the observed descendant version', () => {
  const evidence = new CommandEvidence();
  const parent = { target: 'Relay', revision: 'parent-revision' };
  const child = { target: 'North', revision: 'child-revision', children: [] };
  const query = { entity: 'task' as const, query: 'Relay', scope: {}, count: 1, complete: true };
  const lookup = evidence.discovery(query);
  evidence.expectTaskChange(lookup, 'change', parent, [parent]);
  evidence.observeSavedBranch({ ...parent, children: [child] });
  const references = { issuedFindEvidence: () => ['@turn:q1'] };
  for (const fact of [
    { action: 'inspect' as const, ...child },
    { action: 'change' as const, ...child, revision: 'other-revision' },
    { action: 'change' as const, target: 'unrelated', revision: 'child-revision' },
  ]) {
    evidence.accept({ entity: 'task', ...fact });
    expect(() => {
      evidence.checkTaskChanges([], references);
    }).toThrow(/Prepare change_task first/u);
  }
  evidence.accept({ action: 'change', entity: 'task', ...child });
  expect(() => {
    evidence.checkTaskChanges([], references);
  }).toThrow(/If parent only locates prepared child/u);
  const repeated = evidence.discovery(query);
  evidence.correctParentLookup(lookup, repeated, [parent]);
  evidence.checkTaskChanges();
  evidence.expectTaskChange(evidence.discovery(query), 'change', parent, [parent]);
  expect(() => {
    evidence.checkTaskChanges();
  }).toThrow(/Prepare change_task first/u);
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
it('keeps a second ambiguous mutation lookup blocking after one accepted edit is resolved', () => {
  const evidence = new CommandEvidence();
  const north = { target: 'north', revision: 'n1' },
    south = { target: 'south', revision: 's1' },
    east = { target: 'east', revision: 'e1' };
  const proof = { entity: 'task' as const, query: 'Proof', scope: {}, count: 2, complete: true };
  const relay = { ...proof, query: 'Relay' };
  evidence.expectTaskChange(evidence.discovery(proof), 'change', undefined, [north, south]);
  evidence.expectTaskChange(evidence.discovery(relay), 'change', undefined, [north, east]);
  evidence.accept({ action: 'change', entity: 'task', ...north });
  const narrowed = evidence.discovery({ ...proof, scope: { tagsAll: ['#north'] }, count: 1 });
  evidence.expectTaskChange(narrowed, 'change', north, [north]);
  expect(() => {
    evidence.checkTaskChanges();
  }).toThrow(/"Relay".*is ambiguous/iu);
});
it('resolves an ambiguous change after omitting only the complete status domain', () => {
  const evidence = new CommandEvidence();
  const north = { target: 'north', revision: 'n1' },
    south = { target: 'south', revision: 's1' };
  const original = evidence.discovery({
    entity: 'task',
    query: 'Proof',
    scope: { fields: 'all', statuses: ['open', 'in-progress', 'done', 'cancelled'] },
    count: 2,
    complete: true,
  });
  evidence.expectTaskChange(original, 'change', undefined, [north, south]);
  evidence.accept({ action: 'change', entity: 'task', ...north });
  const narrowed = evidence.discovery({
    entity: 'task',
    query: 'Proof',
    scope: { fields: 'all', tagsAll: ['#north'] },
    count: 1,
    complete: true,
  });
  evidence.expectTaskChange(narrowed, 'change', north, [north]);
  expect(() => {
    evidence.checkTaskChanges();
  }).not.toThrow();
});
it('does not reuse an accepted task edit from before the ambiguous lookup', () => {
  const evidence = new CommandEvidence();
  const north = { target: 'north', revision: 'n1' },
    south = { target: 'south', revision: 's1' };
  const query = {
    entity: 'task' as const,
    query: 'Proof',
    scope: { fields: 'all' },
    count: 2,
    complete: true,
  };
  evidence.accept({ action: 'change', entity: 'task', ...north });
  const original = evidence.discovery(query);
  evidence.expectTaskChange(original, 'change', undefined, [north, south]);
  const narrowed = evidence.discovery({
    ...query,
    scope: { ...query.scope, tagsAll: ['#north'] },
    count: 1,
  });
  evidence.expectTaskChange(narrowed, 'change', north, [north]);
  expect(() => {
    evidence.checkTaskChanges();
  }).toThrow(/Prepare change_task first/u);
});
it('keeps the original acceptance boundary across repeated ambiguous lookups', () => {
  const evidence = new CommandEvidence();
  const north = { target: 'north', revision: 'n1' },
    south = { target: 'south', revision: 's1' };
  const query = {
    entity: 'task' as const,
    query: 'Proof',
    scope: { fields: 'all' },
    count: 2,
    complete: true,
  };
  const original = evidence.discovery(query);
  evidence.expectTaskChange(original, 'change', undefined, [north, south]);
  evidence.accept({ action: 'change', entity: 'task', ...north });
  evidence.expectTaskChange(evidence.discovery(query), 'change', undefined, [north, south]);
  const narrowed = evidence.discovery({
    ...query,
    scope: { ...query.scope, tagsAll: ['#north'] },
    count: 1,
  });
  evidence.expectTaskChange(narrowed, 'change', north, [north]);
  expect(() => {
    evidence.checkTaskChanges();
  }).not.toThrow();
});
it('gives recovery guidance when an accepted edit still has an unresolved ambiguity', () => {
  const evidence = new CommandEvidence();
  const north = { target: 'north', revision: 'n1' },
    south = { target: 'south', revision: 's1' };
  const original = evidence.discovery({
    entity: 'task',
    query: 'Proof',
    scope: { fields: 'all', path: 'a.md' },
    count: 2,
    complete: true,
  });
  evidence.expectTaskChange(original, 'change', undefined, [north, south]);
  evidence.accept({ action: 'change', entity: 'task', ...north });
  expect(() => {
    evidence.checkTaskChanges();
  }).toThrow(
    /preview kept.*"Proof".*"path":"a\.md".*repeat with user's discriminator.*without repeating it.*ask with evidence/iu,
  );
});
it.each([
  ['inspection only', { action: 'inspect' as const, target: 'north', revision: 'n1' }, 'change'],
  ['another owner', { action: 'change' as const, target: 'south', revision: 's1' }, 'change'],
  ['another revision', { action: 'change' as const, target: 'north', revision: 'n2' }, 'change'],
  [
    'a removal operation',
    { action: 'change' as const, target: 'north', revision: 'n1', removal: true },
    'change',
  ],
  ['the wrong effect', { action: 'change' as const, target: 'north', revision: 'n1' }, 'remove'],
] as const)('does not inherit ambiguous progress from %s', (_label, accepted, effect) => {
  const evidence = new CommandEvidence();
  const north = { target: 'north', revision: 'n1' },
    south = { target: 'south', revision: 's1' };
  const query = {
    entity: 'task' as const,
    query: 'Proof',
    scope: { fields: 'all' },
    count: 2,
    complete: true,
  };
  evidence.expectTaskChange(evidence.discovery(query), effect, undefined, [north, south]);
  evidence.accept({ entity: 'task', ...accepted });
  const narrowed = evidence.discovery({
    ...query,
    scope: { ...query.scope, tagsAll: ['#north'] },
    count: 1,
  });
  evidence.expectTaskChange(narrowed, effect, north, [north]);
  expect(() => {
    evidence.checkTaskChanges();
  }).toThrow(/Prepare change_task first|still ambiguous|unique task|requested removal/u);
});
it('does not report removed accepted work as a retained preview', () => {
  const evidence = new CommandEvidence();
  const north = { target: 'north', revision: 'n1' },
    south = { target: 'south', revision: 's1' };
  const original = evidence.discovery({
    entity: 'task',
    query: 'Proof',
    scope: {},
    count: 2,
    complete: true,
  });
  evidence.expectTaskChange(original, 'change', undefined, [north, south]);
  evidence.accept({ action: 'change', entity: 'task', ...north });
  evidence.remove(north.target);
  expect(() => {
    evidence.checkTaskChanges();
  }).toThrow(/No unique task/u);
});
it('retains accepted progress when status filtering legitimately narrows the same query', () => {
  const evidence = new CommandEvidence();
  const north = { target: 'north', revision: 'n1' },
    south = { target: 'south', revision: 's1' };
  const original = evidence.discovery({
    entity: 'task',
    query: 'Proof',
    scope: { fields: 'all' },
    count: 2,
    complete: true,
  });
  evidence.expectTaskChange(original, 'change', undefined, [north, south]);
  evidence.accept({ action: 'change', entity: 'task', ...north });
  const narrowed = evidence.discovery({
    entity: 'task',
    query: 'Proof',
    scope: { fields: 'all', statuses: ['open'] },
    count: 1,
    complete: true,
  });
  evidence.expectTaskChange(narrowed, 'change', north, [north]);
  expect(() => {
    evidence.checkTaskChanges();
  }).not.toThrow();
});
it.each([
  {
    name: 'changed query',
    query: 'North',
    scope: { fields: 'all', path: 'a.md', tagsAll: ['#north'] },
    complete: true,
    broadComplete: true,
  },
  {
    name: 'dropped filter',
    query: 'Proof',
    scope: { fields: 'all', tagsAll: ['#north'] },
    complete: true,
    broadComplete: true,
  },
  {
    name: 'incomplete narrowed lookup',
    query: 'Proof',
    scope: { fields: 'all', path: 'a.md', tagsAll: ['#north'] },
    complete: false,
    broadComplete: true,
  },
])('does not recover accepted progress with $name', ({ query, scope, complete, broadComplete }) => {
  const evidence = new CommandEvidence();
  const north = { target: 'north', revision: 'n1' },
    south = { target: 'south', revision: 's1' };
  const original = evidence.discovery({
    entity: 'task',
    query: 'Proof',
    scope: { fields: 'all', path: 'a.md' },
    count: 2,
    complete: broadComplete,
  });
  evidence.expectTaskChange(original, 'change', undefined, [north, south]);
  evidence.accept({ action: 'change', entity: 'task', ...north });
  const narrowed = evidence.discovery({
    entity: 'task',
    query,
    scope,
    count: 1,
    complete,
  });
  evidence.expectTaskChange(narrowed, 'change', north, [north]);
  expect(() => {
    evidence.checkTaskChanges();
  }).toThrow(/ambiguous|Prepare change_task first/iu);
});
it('does not inherit a preview from an unsupported current discovery', () => {
  const evidence = new CommandEvidence();
  const north = { target: 'north', revision: 'n1' },
    south = { target: 'south', revision: 's1' };
  const original = evidence.discovery({
    entity: 'task',
    query: 'Proof',
    scope: {},
    count: 2,
    complete: true,
  });
  evidence.expectTaskChange(original, 'change', undefined, [north, south]);
  evidence.accept({ action: 'change', entity: 'task', ...north });
  const current = evidence.discovery({
    entity: 'task',
    query: 'Proof',
    scope: {},
    count: 1,
    complete: true,
    unsupported: true,
  });
  evidence.expectTaskChange(current, 'change', north, [north]);
  expect(() => {
    evidence.checkTaskChanges();
  }).toThrow(/Prepare change_task first/iu);
});
it('does not inherit a superseded accepted change fact', () => {
  const evidence = new CommandEvidence();
  const north = { target: 'north', revision: 'n1' },
    south = { target: 'south', revision: 's1' };
  const original = evidence.discovery({
    entity: 'task',
    query: 'Proof',
    scope: {},
    count: 2,
    complete: true,
  });
  evidence.expectTaskChange(original, 'change', undefined, [north, south]);
  evidence.accept({ action: 'change', entity: 'task', ...north });
  evidence.accept({ action: 'change', entity: 'task', target: north.target, revision: 'n2' });
  const current = evidence.discovery({
    entity: 'task',
    query: 'Proof',
    scope: { tagsAll: ['#north'] },
    count: 1,
    complete: true,
  });
  evidence.expectTaskChange(current, 'change', north, [north]);
  expect(() => {
    evidence.checkTaskChanges();
  }).toThrow(/Prepare change_task first/iu);
});
it.each([
  ['strict subset', ['open']],
  ['duplicate status', ['open', 'in-progress', 'done', 'done']],
  ['empty statuses', []],
  ['unknown status', ['open', 'in-progress', 'done', 'paused']],
] as const)('does not treat %s as the complete status domain', (_label, statuses) => {
  const evidence = new CommandEvidence();
  const north = { target: 'north', revision: 'n1' },
    south = { target: 'south', revision: 's1' };
  const original = evidence.discovery({
    entity: 'task',
    query: 'Proof',
    scope: { statuses },
    count: 2,
    complete: true,
  });
  evidence.expectTaskChange(original, 'change', undefined, [north, south]);
  const narrowed = evidence.discovery({
    entity: 'task',
    query: 'Proof',
    scope: { tagsAll: ['#north'] },
    count: 1,
    complete: true,
  });
  evidence.expectTaskChange(narrowed, 'change', north, [north]);
  evidence.accept({ action: 'change', entity: 'task', ...north });
  expect(() => {
    evidence.checkTaskChanges();
  }).toThrow(/preview kept/iu);
});
it('retains accepted progress after an incomplete broad lookup gets complete unique coverage', () => {
  const evidence = new CommandEvidence();
  const north = { target: 'north', revision: 'n1' },
    south = { target: 'south', revision: 's1' };
  const query = {
    entity: 'task' as const,
    query: 'Proof',
    scope: { fields: 'all' },
  };
  evidence.expectTaskChange(
    evidence.discovery({ ...query, count: 2, complete: false }),
    'change',
    undefined,
    [north, south],
  );
  evidence.accept({ action: 'change', entity: 'task', ...north });
  const complete = evidence.discovery({ ...query, count: 1, complete: true });
  evidence.expectTaskChange(complete, 'change', north, [north]);
  expect(() => {
    evidence.checkTaskChanges();
  }).not.toThrow();
});
it('retains accepted progress after a complete same-query unique lookup without a scope change', () => {
  const evidence = new CommandEvidence();
  const north = { target: 'north', revision: 'n1' },
    south = { target: 'south', revision: 's1' };
  const query = {
    entity: 'task' as const,
    query: 'Proof',
    scope: { fields: 'all' },
  };
  evidence.expectTaskChange(
    evidence.discovery({ ...query, count: 2, complete: true }),
    'change',
    undefined,
    [north, south],
  );
  evidence.accept({ action: 'change', entity: 'task', ...north });
  const unique = evidence.discovery({ ...query, count: 1, complete: true });
  evidence.expectTaskChange(unique, 'change', north, [north]);
  expect(() => {
    evidence.checkTaskChanges();
  }).not.toThrow();
});
it('does not resolve the complete-status ambiguity for a different candidate revision', () => {
  const evidence = new CommandEvidence();
  const north = { target: 'north', revision: 'n1' },
    south = { target: 'south', revision: 's1' };
  const original = evidence.discovery({
    entity: 'task',
    query: 'Proof',
    scope: { statuses: ['open', 'in-progress', 'done', 'cancelled'] },
    count: 2,
    complete: true,
  });
  evidence.expectTaskChange(original, 'change', undefined, [north, south]);
  const narrowed = evidence.discovery({
    entity: 'task',
    query: 'Proof',
    scope: { tagsAll: ['#north'] },
    count: 1,
    complete: true,
  });
  evidence.expectTaskChange(narrowed, 'change', { ...north, revision: 'n2' }, [
    { ...north, revision: 'n2' },
  ]);
  evidence.accept({ action: 'change', entity: 'task', ...north, revision: 'n2' });
  expect(() => {
    evidence.checkTaskChanges();
  }).toThrow(/unique task/u);
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
