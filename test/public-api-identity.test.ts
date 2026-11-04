import { afterEach, expect, it } from 'vitest';
import type { ApiResultV1 } from '../api';
import { TaskIdentityRegistry } from '../src/integrations/TaskIdentityRegistry';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import type { TaskReadNode } from '../src/tasks/application/TaskIntegrationReadApi';
import { flushMicrotasks } from './helpers';
import { publicApiHarness, type PublicApiHarness } from './support/publicApiHarness';

const harnesses: PublicApiHarness[] = [];
afterEach(() => {
  harnesses.splice(0).forEach((h) => {
    h.dispose();
  });
});
function ok<T>(result: ApiResultV1<T>): T {
  if (!result.ok) throw new Error(result.error.code);
  return result.value;
}
function row(h: PublicApiHarness, line = 0): TaskReadNode {
  const result = h.reads.resolve({ source: { path: 'secret.md', line } });
  if (result.type !== 'ok' || result.value.nodes[0] === undefined)
    throw new Error('Missing fixture node');
  return result.value.nodes[0];
}
async function setup(
  source = '- [ ] Secret title 🆔 private-id\n',
  maxTargets = 10,
  options?: Parameters<typeof publicApiHarness>[1],
) {
  const h = await publicApiHarness({ 'secret.md': source }, options);
  harnesses.push(h);
  let now = 0;
  const registry = new TaskIdentityRegistry({
    epoch: 'epoch',
    now: () => now,
    maxTargets,
    idleTtlMs: 100,
  });
  h.reads.activateOccurrences();
  h.reads.subscribe((e) => {
    if (e.type === 'accepted') registry.apply(e.change);
  });
  return {
    h,
    registry,
    clock: (value: number) => {
      now = value;
    },
  };
}
async function complete(h: PublicApiHarness, line = 0) {
  const node = row(h, line);
  return h.service.mutateStatus({
    root: node.value.root,
    target: node.value.target,
    observation: h.reads.capture(),
    intent: { type: 'complete' },
  });
}

it('keeps opaque target and revision on unchanged proof, changes revision on whole-root and semantics', async () => {
  const { h, registry } = await setup('- [ ] Secret title 🆔 private-id\n  - [ ] child\n');
  const first = ok(registry.project(row(h), 1));
  expect(ok(registry.project(row(h), 1))).toEqual(first);
  await h.external('secret.md', await h.read('secret.md'));
  expect(ok(registry.project(row(h), 1))).toEqual(first);
  await complete(h, 1);
  const changed = ok(registry.project(row(h), 1));
  expect(changed.target).toBe(first.target);
  expect(changed.revision).not.toBe(first.revision);
  const semantics = ok(registry.project(row(h), 2));
  expect(semantics.target).toBe(first.target);
  expect(semantics.revision).not.toBe(changed.revision);
  expect(JSON.stringify([first, changed, semantics])).not.toMatch(/secret|title|private-id|\[ \]/i);
  expect(Object.isFrozen(first)).toBe(true);
  const lookup = ok(registry.lookup(first.target));
  expect(Object.isFrozen(lookup.address)).toBe(true);
});

it.each(['keep', 'delete'] as const)(
  'uses actual %s recurrence witnesses for distinct descendant targets',
  async (policy) => {
    const { h, registry } = await setup(
      `- [ ] Repeat 🔁 every day 🛫 2026-08-01 🏁 ${policy}\n  - [ ] child\n`,
    );
    const before = ok(registry.project(row(h), 1));
    const child = ok(registry.project(row(h, 1), 1));
    const result = await complete(h);
    expect(result.type).toBe('result');
    if (result.type !== 'result' || result.occurrences.next?.current === undefined)
      throw new Error('Missing recurrence');
    const nextRead = h.reads.node(result.occurrences.next.current);
    if (nextRead.type !== 'ok') throw new Error('Missing next');
    const next = ok(registry.project(nextRead.value, 1));
    expect(next.target).not.toBe(before.target);
    const nextChild = ok(registry.project(row(h, nextRead.value.line + 1), 1));
    expect(nextChild.target).not.toBe(child.target);
    expect(nextChild.parentTarget).toBe(next.target);
    expect(ok(registry.lookup(before.target)).state).toBe(
      policy === 'keep' ? 'retained' : 'removed',
    );
    if (result.occurrences.original.current !== undefined) {
      const original = h.reads.node(result.occurrences.original.current);
      if (original.type !== 'ok') throw new Error('Missing original');
      expect(ok(registry.project(original.value, 1)).target).toBe(before.target);
    }
  },
);

it('does not resurrect tokens after external change, duplicate text, deletion or restoration', async () => {
  const { h, registry } = await setup();
  const original = row(h);
  const first = ok(registry.project(original, 1));
  await h.external('secret.md', '- [ ] Changed\n');
  expect(ok(registry.lookup(first.target)).state).toBe('unproven');
  await h.external('secret.md', '- [ ] Secret title 🆔 private-id\n');
  expect(ok(registry.project(row(h), 1)).target).not.toBe(first.target);
  const current = ok(registry.project(row(h), 1));
  registry.apply({
    sources: [],
    paths: ['secret.md'],
    before: [row(h).value.root],
    after: [row(h).value.root],
    witnesses: [],
    invalidated: [],
    restored: true,
  });
  expect(ok(registry.lookup(current.target)).state).toBe('unproven');
  const restored = ok(registry.project(row(h), 1));
  expect(restored.target).not.toBe(current.target);
  await h.external('secret.md', '- [ ] Same\n- [ ] Same\n');
  const duplicate = ok(registry.project(row(h), 1));
  await h.external('secret.md', 'heading\n- [ ] Same\n- [ ] Same\n');
  expect(ok(registry.lookup(duplicate.target)).state).toBe('unproven');
  const deleted = ok(registry.project(row(h, 1), 1));
  const file = h.app.vault.getFileByPath('secret.md');
  if (file === null) throw new Error('Missing file');
  await h.app.fileManager.trashFile(file);
  await h.app.vault.create('secret.md', 'heading\n- [ ] Same\n- [ ] Same\n');
  await flushMicrotasks();
  expect(ok(registry.lookup(deleted.target)).state).toBe('unproven');
  expect(ok(registry.project(row(h, 1), 1)).target).not.toBe(deleted.target);
});

it('allocates child and parent atomically without evicting live records', async () => {
  const { h, registry } = await setup('- [ ] root\n  - [ ] child\n- [ ] other\n', 1);
  expect(registry.project(row(h, 1), 1)).toMatchObject({
    ok: false,
    error: { code: 'RESOURCE_LIMIT' },
  });
  const other = ok(registry.project(row(h, 2), 1));
  expect(registry.project(row(h), 1)).toMatchObject({
    ok: false,
    error: { code: 'RESOURCE_LIMIT' },
  });
  expect(ok(registry.lookup(other.target)).state).toBe('retained');
});

it('does not renew lookup probes, but proven projection renews idle expiry', async () => {
  const { h, registry, clock } = await setup();
  const first = ok(registry.project(row(h), 1));
  clock(90);
  ok(registry.lookup(first.target));
  clock(100);
  expect(registry.lookup(first.target)).toMatchObject({
    ok: false,
    error: { code: 'EXPIRED_TARGET' },
  });
  const next = ok(registry.project(row(h), 1));
  clock(190);
  expect(ok(registry.project(row(h), 1)).target).toBe(next.target);
  clock(250);
  expect(ok(registry.lookup(next.target)).state).toBe('retained');
  expect(registry.lookup('another-epoch:t:1')).toMatchObject({
    ok: false,
    error: { code: 'EXPIRED_TARGET' },
  });
});

it('pins accepted authority past expiry without admitting stale probes or pins', async () => {
  const { h, registry, clock } = await setup(undefined, 1);
  const first = ok(registry.project(row(h), 1));
  const release = ok(registry.pin(first.target));
  clock(100);
  expect(registry.lookup(first.target)).toMatchObject({
    ok: false,
    error: { code: 'EXPIRED_TARGET' },
  });
  expect(registry.pin(first.target)).toMatchObject({
    ok: false,
    error: { code: 'EXPIRED_TARGET' },
  });
  expect(registry.reserveNext()).toMatchObject({ ok: false, error: { code: 'RESOURCE_LIMIT' } });
  await complete(h);
  expect(ok(registry.project(row(h), 1)).target).toBe(first.target);
  release();
  release();
  clock(200);
  ok(registry.reserveNext());
});

it('reserves capacity through unrelated projections and claims an unproven distinct next', async () => {
  const { h, registry } = await setup('- [ ] root\n- [ ] other\n', 3);
  const first = ok(registry.project(row(h), 1));
  const reservation = ok(registry.reserveNext());
  ok(registry.project(row(h, 1), 1));
  expect(registry.reserveNext()).toMatchObject({ ok: false, error: { code: 'RESOURCE_LIMIT' } });
  const claimed = registry.claimNext(reservation, { origin: row(h).address, state: 'unproven' });
  expect(claimed.target).not.toBe(first.target);
  expect(ok(registry.lookup(claimed.target)).state).toBe('unproven');
  registry.releaseReservation(reservation);
  expect(registry.reserveNext()).toMatchObject({ ok: false, error: { code: 'RESOURCE_LIMIT' } });
});

it('reuses a reentrant next projection after witnessed timer shifts and releases reserved capacity', async () => {
  const { h, registry } = await setup(
    '- [ ] root\n  - [ ] Repeat 🔁 every day 🛫 2026-08-01\n    - 2026-08-01T11:59:59+00:00 →\n',
    4,
  );
  const original = ok(registry.project(row(h, 1), 1));
  const reservation = ok(registry.reserveNext());
  let reentrant: string | undefined;
  h.reads.subscribe((e) => {
    if (e.type !== 'accepted' || reentrant !== undefined) return;
    const next = e.change.witnesses.find((w) => w.kind === 'created' && w.reason === 'recurrence');
    if (next?.kind !== 'created') return;
    const read = h.reads.node(next.after);
    if (read.type === 'ok') reentrant = ok(registry.project(read.value, 1)).target;
  });
  const result = await complete(h, 1);
  if (result.type !== 'result' || result.occurrences.next === undefined)
    throw new Error('Missing next');
  expect(reentrant).toBeDefined();
  expect(result.followUp).toMatchObject({
    discardedShortEntry: true,
    closed: 1,
    state: 'complete',
  });
  expect(result.occurrences.next.current).not.toEqual(result.occurrences.next.origin);
  const claimed = registry.claimNext(reservation, result.occurrences.next);
  expect(claimed.target).toBe(reentrant);
  expect(claimed.target).not.toBe(original.target);
  expect(ok(registry.lookup(claimed.target)).address).toEqual(result.occurrences.next.current);
  ok(registry.reserveNext());
});

it('keeps reservations settleable after disposal without reopening public access', async () => {
  const { h, registry } = await setup();
  const reservation = ok(registry.reserveNext());
  registry.dispose();
  registry.dispose();
  const claim = registry.claimNext(reservation, {
    origin: row(h).address,
    current: row(h).address,
    state: 'retained',
  });
  expect(claim.target).toContain('epoch');
  expect(Object.isFrozen(claim)).toBe(true);
  expect(registry.lookup(claim.target)).toMatchObject({ ok: false, error: { code: 'DISPOSED' } });
  expect(registry.project(row(h), 1)).toMatchObject({ ok: false, error: { code: 'DISPOSED' } });
  expect(registry.reserveNext()).toMatchObject({ ok: false, error: { code: 'DISPOSED' } });
});

it('releases unused reservations idempotently and refuses foreign reservations', async () => {
  const { h, registry } = await setup(undefined, 1);
  const reservation = ok(registry.reserveNext());
  registry.releaseReservation(reservation);
  registry.releaseReservation(reservation);
  ok(registry.project(row(h), 1));
  const other = new TaskIdentityRegistry({ epoch: 'other', now: () => 0 });
  expect(() =>
    other.claimNext(reservation, { origin: row(h).address, state: 'unproven' }),
  ).toThrow();
});

it('keeps byte-identical Delete recurrence and restored projections distinct from removed original', async () => {
  const source = '- [ ] Repeat 🔁 every day 🏁 delete\n';
  const { h, registry, clock } = await setup(source, 4, {
    behaviorSettings: () => ({
      ...DEFAULT_SETTINGS,
      taskLifecycle: { addCreatedDate: false, addCompletionDate: false },
    }),
  });
  const before = row(h);
  const original = ok(registry.project(before, 1));
  const reservation = ok(registry.reserveNext());
  const result = await complete(h);
  if (result.type !== 'result' || result.occurrences.next === undefined)
    throw new Error('Missing next');
  expect(await h.read('secret.md')).toBe(source);
  expect(ok(registry.lookup(original.target)).state).toBe('removed');
  const claimed = registry.claimNext(reservation, result.occurrences.next);
  expect(claimed.target).not.toBe(original.target);
  expect(ok(registry.project(row(h), 1)).target).toBe(claimed.target);
  registry.apply({
    sources: [],
    paths: ['secret.md'],
    before: [row(h).value.root],
    after: [before.value.root],
    witnesses: [],
    invalidated: [],
    restored: true,
  });
  expect(ok(registry.lookup(original.target)).state).toBe('removed');
  expect(ok(registry.lookup(claimed.target)).state).toBe('unproven');
  clock(99);
  ok(registry.lookup(original.target));
  clock(100);
  expect(registry.lookup(original.target)).toMatchObject({
    ok: false,
    error: { code: 'EXPIRED_TARGET' },
  });
});

it('changes revision but keeps target through exact external relocation', async () => {
  const { h, registry } = await setup();
  const before = ok(registry.project(row(h), 1));
  await h.external('secret.md', `heading\n${await h.read('secret.md')}`);
  const after = ok(registry.project(row(h, 1), 1));
  expect(after.target).toBe(before.target);
  expect(after.revision).not.toBe(before.revision);
});

it('does not revive an expired target when the injected wall clock moved backwards', async () => {
  const { h, registry, clock } = await setup('- [ ] first\n- [ ] second\n', 2);
  clock(100);
  const first = ok(registry.project(row(h), 1));
  clock(0);
  const second = ok(registry.project(row(h, 1), 1));
  clock(100);
  expect(ok(registry.project(row(h, 1), 1)).target).not.toBe(second.target);
  expect(ok(registry.lookup(first.target)).state).toBe('retained');
});
