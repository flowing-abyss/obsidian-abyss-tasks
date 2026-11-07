import { afterEach, expect, it, vi } from 'vitest';
import type { ApiResultV1 } from '../api';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import type { TaskBehaviorSettingsProvider } from '../src/tasks/application/TaskBehaviorSettings';
import { deferred, flushMicrotasks, metadataChangedEmitter } from './helpers';
import { publicApiHarness, type PublicApiHarness } from './support/publicApiHarness';

const owners: PublicApiHarness[] = [];
afterEach(() => {
  owners.splice(0).forEach((owner) => {
    owner.dispose();
  });
});
function ok<T>(result: ApiResultV1<T>): T {
  if (!result.ok) throw new Error(result.error.code);
  return result.value;
}
function required<T>(value: T | undefined | null): T {
  if (value == null) throw new Error('Missing value');
  return value;
}
async function pendingSource(behaviorSettings?: TaskBehaviorSettingsProvider) {
  const content = '- [ ] Same\n  - [ ] Child\n- [ ] Same\n  - [ ] Child\n';
  const h = await publicApiHarness(
    { 'a.md': content },
    { ...(behaviorSettings === undefined ? {} : { behaviorSettings }) },
  );
  owners.push(h);
  const file = required(h.app.vault.getFileByPath('a.md'));
  const source = deferred<string>(),
    read = h.app.vault.read.bind(h.app.vault);
  vi.spyOn(h.app.vault, 'read').mockImplementationOnce(() => source.promise);
  metadataChangedEmitter(h.app)(file, content, {});
  const c = h.client(),
    root = required(ok(await c.tasks.list()).items[2]);
  expect(h.index.projectSources().get('a.md')).toMatchObject({
    type: 'error',
    reason: 'incomplete',
  });
  const writes = vi.spyOn(h.app.vault, 'process');
  return { h, c, root, source, content, read, file, writes };
}

it('awaits the current native source acquisition before preparing a first-use duplicate root', async () => {
  const { h, c, root, source, content, writes } = await pendingSource();
  let settled = false;
  const pending = required(c.tasks.prepare)({
    kind: 'edit',
    target: root.target,
    expectedRevision: root.revision,
  }).then((result) => {
    settled = true;
    return result;
  });
  await flushMicrotasks();
  expect(settled).toBe(false);
  source.resolve(content);
  const plan = ok(await pending);
  expect(plan.before?.target).toBe(root.target);
  expect(plan.before?.title).toBe('Same');
  expect(writes).not.toHaveBeenCalled();
  expect(await h.read('a.md')).toBe(content);
});

it('awaits the same native source acquisition before first-use creation without writing', async () => {
  const { c, source, content, writes } = await pendingSource();
  let settled = false;
  const pending = required(c.tasks.prepare)({
    kind: 'create',
    destination: { type: 'note', path: 'a.md', insertion: { type: 'prepend' } },
    tree: { markdownTitle: 'New root' },
  }).then((result) => {
    settled = true;
    return result;
  });
  await flushMicrotasks();
  expect(settled).toBe(false);
  source.resolve(content);
  expect(ok(await pending).after?.title).toBe('New root');
  expect(writes).not.toHaveBeenCalled();
});

it.each(['abort', 'dispose'] as const)(
  'releases pending acquisition preparation after %s',
  async (change) => {
    const { h, c, root, source, content, writes } = await pendingSource();
    const controller = new AbortController();
    const pending = required(c.tasks.prepare)(
      { kind: 'edit', target: root.target, expectedRevision: root.revision },
      { signal: controller.signal },
    );
    await flushMicrotasks();
    if (change === 'abort') controller.abort();
    else c.dispose();
    source.resolve(content);
    expect(await pending).toMatchObject({
      ok: false,
      error: { code: change === 'abort' ? 'ABORTED' : 'DISPOSED' },
    });
    const peer = h.client();
    expect(
      (
        await required(peer.tasks.prepare)({
          kind: 'edit',
          target: root.target,
          expectedRevision: root.revision,
        })
      ).ok,
    ).toBe(true);
    expect(writes).not.toHaveBeenCalled();
    expect(await h.read('a.md')).toBe(content);
  },
);

it.each(['replacement', 'observation', 'exclusion', 'semantics', 'settings', 'lifecycle'] as const)(
  'rejects a pending native source preparation after %s changes',
  async (change) => {
    let settings = structuredClone(DEFAULT_SETTINGS);
    const { h, c, root, source, content, file, writes } = await pendingSource(() => settings);
    const pending = required(c.tasks.prepare)({
      kind: 'edit',
      target: root.target,
      expectedRevision: root.revision,
    });
    await flushMicrotasks();
    let changed: Promise<unknown> | undefined;
    if (change === 'replacement') {
      await h.app.vault.rename(file, 'old.md');
      const replacement = await h.app.vault.create('a.md', content);
      metadataChangedEmitter(h.app)(replacement, content, {});
    } else if (change === 'observation') {
      metadataChangedEmitter(h.app)(file, content, {});
    } else if (change === 'exclusion') changed = h.index.refreshSourceExclusion(() => true);
    else if (change === 'semantics') h.index.updateIntegrationSemantics('changed');
    else if (change === 'settings') settings = { ...settings, taskPrefix: '#changed' };
    else h.index.destroy();
    source.resolve(content);
    await changed;
    expect((await pending).ok).toBe(false);
    expect(writes).not.toHaveBeenCalled();
    expect(await h.read('a.md')).toBe(content);
  },
);

async function insertionWithPendingEdit(queuedEcho = false) {
  const content =
    '- [ ] Same\n  - [ ] Child\n    - [ ] Deep\n- [ ] Same\n  - [ ] Child\n    - [ ] Deep\n';
  const h = await publicApiHarness({ 'a.md': content });
  owners.push(h);
  const c = h.client(),
    second = required(ok(await c.tasks.list()).items[3]);
  const original = structuredClone(required(h.index.list()[1]));
  const pending = ok(
    await required(c.tasks.prepare)({
      kind: 'edit',
      target: second.target,
      expectedRevision: second.revision,
      operation: { type: 'description', target: second.target, text: 'Only the second root' },
    }),
  );
  const creating = ok(
    await required(c.tasks.prepare)({
      kind: 'create',
      destination: { type: 'note', path: 'a.md', insertion: { type: 'prepend' } },
      tree: { markdownTitle: 'New', children: [{ markdownTitle: 'New child' }] },
    }),
  );
  let echoes = 0;
  if (queuedEcho) {
    const install = h.index.installCommittedBatch.bind(h.index);
    vi.spyOn(h.index, 'installCommittedBatch').mockImplementation((contents, prove) => {
      const roots = install(contents, prove);
      const file = required(h.app.vault.getFileByPath('a.md'));
      metadataChangedEmitter(h.app)(file, required(contents.get('a.md')), {});
      echoes++;
      return roots;
    });
  }
  expect(
    await required(c.tasks.create)({
      plan: creating.target,
      expectedPlanRevision: creating.revision,
      requestId: 'echo-create',
      expiresAt: Date.UTC(2026, 7, 1, 12) + 60000,
    }),
  ).toMatchObject({ ok: true });
  if (queuedEcho) expect(echoes).toBeGreaterThan(0);
  return { h, c, second, original, pending };
}

it.each(['queued', 'later'] as const)(
  'preserves insertion proof through a %s identical native metadata echo before refresh',
  async (timing) => {
    const { h, c, second, original, pending } = await insertionWithPendingEdit(timing === 'queued');
    await flushMicrotasks();
    const saved = await h.read('a.md'),
      file = required(h.app.vault.getFileByPath('a.md'));
    metadataChangedEmitter(h.app)(file, saved, {});
    await flushMicrotasks();
    expect(await c.tasks.get(second.target)).toMatchObject({ ok: true });
    const resolved = h.index.resolve(original.ref);
    expect(resolved.type).toBe('rebased');
    if (resolved.type === 'rebased') expect(resolved.basis.authorityTransition).toBeDefined();
    const refreshed = ok(
      await required(c.tasks.prepare)({
        kind: 'refresh',
        plan: pending.target,
        expectedPlanRevision: pending.revision,
      }),
    );
    expect(refreshed.after?.description).toBe('Only the second root');
    expect(await h.read('a.md')).toBe(saved);
  },
);

it.each(['source-bytes', 'source-install', 'file-replacement', 'generation'] as const)(
  'does not reuse an insertion proof after %s changes then echoes',
  async (change) => {
    const { h, c, second, original, pending } = await insertionWithPendingEdit();
    await flushMicrotasks();
    const file = required(h.app.vault.getFileByPath('a.md'));
    if (change === 'source-install') {
      const content = `${await h.read('a.md')}Outside task prose\n`;
      await h.app.vault.modify(file, content);
      h.index.installCommittedContent('a.md', content);
      expect(h.index.resolve(original.ref).type).toBe('ambiguous');
    } else if (change === 'source-bytes')
      await h.external('a.md', `${await h.read('a.md')}Outside task prose\n`);
    else if (change === 'file-replacement') {
      const content = await h.read('a.md');
      await h.app.vault.rename(file, 'old.md');
      const replacement = await h.app.vault.create('a.md', content);
      metadataChangedEmitter(h.app)(replacement, content, {});
    } else {
      const current = ok(await c.tasks.get(second.target));
      expect(
        await c.tasks.complete({
          target: current.target,
          expectedRevision: current.revision,
          requestId: 'changed-generation',
          expiresAt: Date.UTC(2026, 7, 1, 12) + 60000,
        }),
      ).toMatchObject({ ok: true });
    }
    await flushMicrotasks();
    const content = await h.read('a.md');
    metadataChangedEmitter(h.app)(required(h.app.vault.getFileByPath('a.md')), content, {});
    await flushMicrotasks();
    const writes = vi.spyOn(h.app.vault, 'process');
    expect(
      (
        await required(c.tasks.prepare)({
          kind: 'refresh',
          plan: pending.target,
          expectedPlanRevision: pending.revision,
        })
      ).ok,
    ).toBe(false);
    expect(writes).not.toHaveBeenCalled();
    expect(await h.read('a.md')).toBe(content);
  },
);
