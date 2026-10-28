import { afterEach, expect, it, vi } from 'vitest';
import {
  ProjectMutationSession,
  type ProjectMutationSessionChange,
} from '../src/projects/ProjectMutationSession';
import type { ProjectSourceObservation } from '../src/projects/ProjectStore';
import { ProjectEditValidationError } from '../src/projects/projectEditError';
import {
  createOwnedInferredPropertyClear,
  type AppliedProjectCellChange,
} from '../src/projects/projectEdits';
import type { Project } from '../src/projects/types';
import { buildDefaultProjectsSettings } from '../src/settings/defaults';
import { deferred, expectDefined, flushMicrotasks } from './helpers';

const project: Project = {
  path: 'Projects/A.md',
  name: 'A',
  frontmatter: { Budget: 10 },
  tags: [],
  statusId: null,
  rawStatus: null,
  stats: {
    total: 0,
    done: 0,
    cancelled: 0,
    inProgress: 0,
    tracked: { closedMs: 0, openStartsMs: [] },
  },
};
const receipt: AppliedProjectCellChange = {
  path: project.path,
  field: { id: 'property:Budget', property: 'Budget', label: 'Budget', type: 'number' },
  value: 20,
  previousValue: 10,
  expectedValue: 10,
  sourceProperty: 'Budget',
  sourceKey: 'Budget',
  previousExists: true,
  appliedExists: true,
};
const settings = buildDefaultProjectsSettings();
const sessions: ProjectMutationSession[] = [];
function setup(
  revalidateSourceObservation: (
    observation: ProjectSourceObservation,
  ) => Promise<boolean> = async () => false,
) {
  const changes: ProjectMutationSessionChange[] = [];
  const session = new ProjectMutationSession({
    revalidateSourceObservation,
    onChange: (change) => changes.push(change),
  });
  sessions.push(session);
  return {
    session,
    changes,
    budget: () => session.project([project], settings)[0]?.frontmatter['Budget'],
  };
}
afterEach(() => {
  for (const session of sessions) session.dispose();
  sessions.length = 0;
  vi.restoreAllMocks();
});

// Removing queue chaining must let "second" run before the held first write settles.
it('serializes mutations and continues after the first rejects', async () => {
  const gate = deferred<Error>();
  const order: string[] = [];
  const { session, changes } = setup();
  const first = session.run(async () => {
    order.push('first');
    throw await gate.promise;
  });
  const observedFailure = first.catch((error: unknown) => error);
  const second = session.run(async () => {
    order.push('second');
    return 2;
  });
  await flushMicrotasks();
  expect(order).toEqual(['first']);
  expect(session.active).toBe(true);
  const failure = new Error('first write failed');
  gate.resolve(failure);
  expect(await observedFailure).toBe(failure);
  expect(await second).toBe(2);
  expect(order).toEqual(['first', 'second']);
  expect(session.active).toBe(false);
  expect(changes).toEqual([{ type: 'settled' }, { type: 'settled' }]);
});

it('keeps receipts through snapshots and unrelated, equal or older observations until newer source arrives', () => {
  const { session, changes, budget } = setup();
  session.observe({ path: project.path, revision: 2, project });
  session.publish([receipt]);
  expect(budget()).toBe(20);
  expect(session.project([{ ...project }], settings)[0]?.frontmatter['Budget']).toBe(20);
  const count = changes.length;
  session.observe({ path: project.path, revision: 1, project });
  session.observe({ path: project.path, revision: 2, project });
  expect(changes).toHaveLength(count);
  session.observe({ path: 'Projects/B.md', revision: 3, project: undefined });
  expect(budget()).toBe(20);
  const external = { ...project, frontmatter: { Budget: 30 } };
  session.observe({ path: project.path, revision: 3, project: external });
  expect(session.project([external], settings)[0]?.frontmatter['Budget']).toBe(30);
  expect(changes[changes.length - 1]).toEqual({
    type: 'source',
    path: project.path,
    projectionChanged: true,
  });
});

it('acknowledges a matching observation that first arrives during a mutation without revalidation', async () => {
  const revalidate = vi.fn(async () => false);
  const { session, budget } = setup(revalidate);
  await session.run(async () => {
    session.observe({
      path: project.path,
      revision: 1,
      project: { ...project, frontmatter: { Budget: 20 } },
    });
    session.publish([receipt]);
  });
  expect(budget()).toBe(10); // No retained projection on an ordinary stale snapshot.
  expect(revalidate).not.toHaveBeenCalled();
});

for (const current of [false, true]) {
  it(`retains a differing observation projection until revalidation returns ${String(current)}`, async () => {
    const gate = deferred<boolean | Error>();
    const { session, budget } = setup(async () => {
      const value = await gate.promise;
      if (value instanceof Error) throw value;
      return value;
    });
    await session.run(async () => {
      session.observe({ path: project.path, revision: 1, project });
      session.publish([receipt]);
    });
    expect(budget()).toBe(20);
    gate.resolve(current);
    await flushMicrotasks();
    expect(budget()).toBe(current ? 10 : 20);
  });
}

// Removing the receipt identity guard must erase the later value when this gate resolves.
it('does not retire a newer receipt when an older revalidation completes', async () => {
  const gate = deferred<boolean | Error>();
  const { session, budget } = setup(async () => {
    const value = await gate.promise;
    if (value instanceof Error) throw value;
    return value;
  });
  await session.run(async () => {
    session.observe({ path: project.path, revision: 1, project });
    session.publish([receipt]);
  });
  session.publish([{ ...receipt, value: 40 }]);
  gate.resolve(true);
  await flushMicrotasks();
  expect(budget()).toBe(40);
});

it('does not emit a stale revalidation change after a newer observation', async () => {
  const gate = deferred<boolean | Error>();
  const { session, changes, budget } = setup(async () => {
    const value = await gate.promise;
    if (value instanceof Error) throw value;
    return value;
  });
  await session.run(async () => {
    session.observe({ path: project.path, revision: 1, project });
    session.publish([receipt]);
  });
  session.observe({ path: project.path, revision: 2, project });
  const count = changes.length;
  gate.resolve(true);
  await flushMicrotasks();
  expect(changes).toHaveLength(count);
  expect(budget()).toBe(10);
});

it('logs failed revalidation with path and cause while retaining the projection', async () => {
  const gate = deferred<boolean | Error>();
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  const { session, budget } = setup(async () => {
    const value = await gate.promise;
    if (value instanceof Error) throw value;
    return value;
  });
  await session.run(async () => {
    session.observe({ path: project.path, revision: 1, project });
    session.publish([receipt]);
  });
  const failure = new Error('read failed');
  gate.resolve(failure);
  await flushMicrotasks();
  expect(budget()).toBe(20);
  expect(log).toHaveBeenCalledExactlyOnceWith(
    '[abyss-tasks] Could not revalidate project receipt projection',
    { path: project.path, cause: failure },
  );
});

it.each(['rename', 'delete', 'membership loss'])('retires only the verified old path on %s', () => {
  const { session, budget } = setup();
  const other = { ...project, path: 'Projects/B.md' };
  session.publish([receipt, { ...receipt, path: other.path, value: 50 }]);
  session.observe({ path: project.path, revision: 1, project: undefined });
  expect(budget()).toBe(10);
  expect(session.project([other], settings)[0]?.frontmatter['Budget']).toBe(50);
});

it('projects successful receipts in publication order and copies input and output arrays', () => {
  const { session } = setup();
  const value = ['one', ['two']];
  const applied = {
    ...receipt,
    field: { ...receipt.field },
    value,
    expectedValue: ['old'],
    previousValue: ['old'],
  };
  session.publish([
    applied,
    { ...receipt, field: { ...receipt.field, id: 'another-role' }, value: ['last'] },
  ]);
  expect(session.project([project], settings)[0]?.frontmatter['Budget']).toEqual(['last']);
  session.publish([applied]);
  value[0] = 'changed';
  (value[1] as string[])[0] = 'changed';
  applied.sourceKey = 'Wrong';
  applied.field.id = 'changed';
  const first = session.project([project], settings)[0]?.frontmatter['Budget'] as unknown[];
  expect(first).toEqual(['one', ['two']]);
  first[0] = 'output changed';
  (first[1] as string[])[0] = 'output changed';
  expect(session.project([project], settings)[0]?.frontmatter['Budget']).toEqual(['one', ['two']]);
});

it('clears exact keys, refills inferred fields and resolves status from current explicit settings', () => {
  const { session } = setup();
  const ownedClear = createOwnedInferredPropertyClear({
    path: project.path,
    fieldId: receipt.field.id,
    sourceProperty: 'Budget',
    sourceKey: 'Budget',
    type: 'number',
  });
  session.publish([{ ...receipt, value: undefined, appliedExists: false, ownedClear }]);
  expect(session.project([project], settings)[0]?.frontmatter).toEqual({});
  session.publish([{ ...receipt, value: 40, previousExists: false, ownedClear }]);
  expect(session.project([project], settings)[0]?.frontmatter['Budget']).toBe(40);
  const status = expectDefined(settings.statuses[0]);
  session.publish([
    {
      ...receipt,
      sourceKey: 'Status',
      sourceProperty: 'Status',
      field: { id: 'status', type: 'status', label: 'Status' },
      value: status.name,
    },
  ]);
  expect(session.project([project], { ...settings, statusProperty: 'Status' })[0]?.statusId).toBe(
    status.id,
  );
  expect(
    session.project([project], { ...settings, statusProperty: 'Other' })[0]?.statusId,
  ).toBeNull();
});

it('checks pending source properties case insensitively without exposing receipts', () => {
  const { session } = setup();
  session.publish([{ ...receipt, sourceKey: 'TaGs' }]);
  expect(session.hasPendingSourceProperty(project.path, ['tag', 'tags'])).toBe(true);
  expect(session.hasPendingSourceProperty('Projects/B.md', ['tag', 'tags'])).toBe(false);
  expect(session.hasPendingSourceProperty(project.path, ['Budget'])).toBe(false);
});

it('lets an active write return its real result but never starts queued work or publishes after disposal', async () => {
  const gate = deferred<number>();
  const { session, changes, budget } = setup();
  const queued = vi.fn(async () => 2);
  const running = session.run(async () => {
    const result = await gate.promise;
    session.publish([receipt]);
    return result;
  });
  const pending = session.run(queued).catch((error: unknown) => error);
  await flushMicrotasks();
  session.dispose();
  gate.resolve(7);
  expect(await running).toBe(7);
  expect(await pending).toEqual(
    new ProjectEditValidationError('The project session is no longer available.'),
  );
  expect(queued).not.toHaveBeenCalled();
  expect(session.active).toBe(false);
  session.observe({ path: project.path, revision: 1, project });
  expect(changes).toEqual([]);
  expect(budget()).toBe(10);
});

it.each([true, false])(
  'retires pending revalidation callbacks on disposal (success: %s)',
  async (success) => {
    const gate = deferred<boolean | Error>();
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { session, changes, budget } = setup(async () => {
      const value = await gate.promise;
      if (value instanceof Error) throw value;
      return value;
    });
    await session.run(async () => {
      session.observe({ path: project.path, revision: 1, project });
      session.publish([receipt]);
    });
    const count = changes.length;
    session.dispose();
    if (success) gate.resolve(true);
    else gate.resolve(new Error('retired'));
    await flushMicrotasks();
    expect(changes).toHaveLength(count);
    expect(log).not.toHaveBeenCalled();
    expect(budget()).toBe(10);
  },
);
