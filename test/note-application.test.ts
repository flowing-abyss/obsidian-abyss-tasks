import { TFile } from 'obsidian';
import { afterEach, expect, it, vi } from 'vitest';
import type { ApiResultV1, NotePlanV1 } from '../api';
import { flushMicrotasks, metadataChangedEmitter, useRealMoment } from './helpers';
import { publicApiHarness, type PublicApiHarness } from './support/publicApiHarness';
useRealMoment();
const owners: PublicApiHarness[] = [];
afterEach(() => {
  owners.splice(0).forEach((h) => {
    h.dispose();
  });
});
function ok<T>(result: ApiResultV1<T>): T {
  if (!result.ok) throw new Error(result.error.code);
  return result.value;
}
async function setup(
  content = 'Contact\n\n- [ ] Same\n  - [ ] Child\n- [ ] Same\n  - [ ] Child\n',
  files: Record<string, string> = {},
) {
  const h = await publicApiHarness({ 'a.md': content, ...files });
  owners.push(h);
  const client = h.client(),
    notes = client.notes;
  if (notes === undefined) throw new Error('Missing notes');
  const page = ok(await notes.read({ selector: { path: 'a.md' } }));
  const section = page.segments.find((part) => part.section.canReplace);
  if (section === undefined) throw new Error('Missing prose');
  const prepare = (text: string) =>
    notes.prepare({
      kind: 'edit',
      target: page.note.target,
      expectedRevision: page.note.revision,
      operation: { type: 'replace-section', section: section.section.target, text },
    });
  const commit = (plan: NotePlanV1, requestId = 'save') => ({
    plan: plan.target,
    expectedPlanRevision: plan.revision,
    requestId,
    expiresAt: Date.UTC(2026, 7, 1, 12) + 60000,
  });
  return { ...h, client, notes, page, prepare, commit };
}
it.each(['```\n', 'Contact\n> ', 'Contact\n    ', '- [ ] Added\n'])(
  'rejects ownership-changing replacement %j',
  async (text) => {
    const h = await setup();
    const result = await h.prepare(text);
    expect(result.ok).toBe(false);
    expect(await h.read('a.md')).toContain('Contact');
  },
);
it('permits fenced task examples only when canonical ownership remains unchanged', async () => {
  const h = await setup();
  expect((await h.prepare('```md\n- [ ] Example\n```\n\n')).ok).toBe(true);
});
it('rejects a competing source inside the actual writer without mutating it', async () => {
  const h = await setup();
  const plan = ok(await h.prepare('Changed\n\n'));
  const process = h.app.vault.process.bind(h.app.vault);
  vi.spyOn(h.app.vault, 'process').mockImplementationOnce(async (file, callback) => {
    await h.app.vault.modify(file, 'Competing\n');
    return await process(file, callback);
  });
  expect(await h.notes.apply(h.commit(plan))).toMatchObject({ ok: false, effects: 'unchanged' });
  expect(await h.read('a.md')).toBe('Competing\n');
});
it.each([false, true])(
  'retains rejected write effects and never replays a write (%s)',
  async (writeFirst) => {
    const h = await setup();
    const plan = ok(await h.prepare('Changed\n\n'));
    const process = h.app.vault.process.bind(h.app.vault);
    const writes = vi
      .spyOn(h.app.vault, 'process')
      .mockImplementationOnce(async (file, callback) => {
        if (writeFirst) await process(file, callback);
        else callback(await h.app.vault.read(file));
        throw new Error('Secret I/O detail');
      });
    const result = await h.notes.apply(h.commit(plan));
    expect(result).toMatchObject({ ok: false, effects: writeFirst ? 'unknown' : 'unchanged' });
    expect(await h.notes.apply(h.commit(plan))).toEqual(result);
    expect(writes).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toContain('Secret');
  },
);
it('rejects replacement native files and stale cursors', async () => {
  const h = await setup();
  const plan = ok(await h.prepare('Changed\n\n'));
  const file = h.app.vault.getAbstractFileByPath('a.md');
  if (!(file instanceof TFile)) throw new Error('Missing file');
  await h.app.vault.rename(file, 'old.md');
  await h.app.vault.create('a.md', await h.app.vault.read(file));
  expect(await h.notes.apply(h.commit(plan))).toMatchObject({ ok: false, effects: 'unchanged' });
});
it('creates once, retains the note after a separate task-link failure, and shares request IDs', async () => {
  const h = await setup('Contact\n');
  const plan = ok(
    await h.notes.prepare({
      kind: 'create',
      path: 'contacts/new.md',
      title: 'Ada',
      text: 'ada@example.org',
    }),
  );
  expect(h.app.vault.getAbstractFileByPath('contacts')).toBeNull();
  const input = h.commit(plan, 'create');
  const saved = await h.notes.create(input);
  expect(saved).toMatchObject({
    ok: true,
    receipt: { noteEffects: 'committed', destinationEffects: 'committed' },
  });
  expect(
    await h.client.tasks.complete({
      target: 'absent',
      expectedRevision: 'absent',
      requestId: 'link',
      expiresAt: input.expiresAt,
    }),
  ).toMatchObject({ ok: false });
  expect(await h.notes.create(input)).toEqual(saved);
  expect(
    h.app.vault.getMarkdownFiles().filter((file) => file.path === 'contacts/new.md'),
  ).toHaveLength(1);
  expect(
    await h.client.tasks.complete({
      target: 'absent',
      expectedRevision: 'absent',
      requestId: 'create',
      expiresAt: input.expiresAt,
    }),
  ).toMatchObject({ ok: false, error: { code: 'REQUEST_ID_REUSED' } });
});
it('refuses executable and task-containing templates before creation', async () => {
  const h = await setup('Contact\n', {
    'exec.md': '<% execute() %>',
    'tasks.md': '- [ ] Bypass\n',
  });
  for (const path of ['exec.md', 'tasks.md']) {
    const template = ok(await h.notes.read({ selector: { path } })).note;
    expect(
      await h.notes.prepare({
        kind: 'create',
        path: 'new.md',
        title: 'New',
        text: 'Prose',
        template: template.target,
        expectedTemplateRevision: template.revision,
      }),
    ).toMatchObject({ ok: false });
  }
  expect(h.app.vault.getAbstractFileByPath('new.md')).toBeNull();
});
it('revokes speculative task continuity after unreadable rejected prose writes and later equal metadata', async () => {
  const h = await setup();
  const roots = ok(await h.client.tasks.list()).items;
  const second = roots[1];
  const prepare = h.client.tasks.prepare;
  if (second === undefined || prepare === undefined) throw new Error('Missing task preparation');
  const taskPlan = ok(
    await prepare({ kind: 'edit', target: second.target, expectedRevision: second.revision }),
  );
  const notePlan = ok(await h.prepare('Contact\nShift\n\n'));
  const process = h.app.vault.process.bind(h.app.vault),
    read = h.app.vault.read.bind(h.app.vault);
  let rejectReads = false;
  vi.spyOn(h.app.vault, 'read').mockImplementation((file) =>
    rejectReads ? Promise.reject(new Error('Unreadable')) : read(file),
  );
  vi.spyOn(h.app.vault, 'process').mockImplementationOnce(async (file, callback) => {
    const candidate = await process(file, callback);
    metadataChangedEmitter(h.app)(file, candidate, {});
    await flushMicrotasks();
    rejectReads = true;
    throw new Error('Rejected after possible write');
  });
  expect(await h.notes.apply(h.commit(notePlan))).toMatchObject({ ok: false, effects: 'unknown' });
  rejectReads = false;
  const candidate = await h.read('a.md');
  await h.external('a.md', candidate);
  expect(
    await prepare({
      kind: 'refresh',
      plan: taskPlan.target,
      expectedPlanRevision: taskPlan.revision,
    }),
  ).toMatchObject({ ok: false });
});
it('redacts replay handles under current policy while retaining committed effects', async () => {
  const h = await setup('Contact\n');
  const plan = ok(await h.prepare('Changed\n'));
  const input = h.commit(plan);
  const saved = await h.notes.apply(input);
  expect(saved.receipt?.note).toBeDefined();
  await h.index.refreshSourceExclusion(
    () => true,
    () => true,
  );
  const replay = await h.notes.apply(input);
  expect(replay.receipt?.note).toBeUndefined();
  expect(replay).toMatchObject({
    ok: true,
    receipt: { effects: 'committed', noteEffects: 'committed' },
  });
});
it('preserves destination folder effects when final note creation is refused', async () => {
  const h = await setup('Contact\n');
  const plan = ok(
    await h.notes.prepare({
      kind: 'create',
      path: 'new/contact.md',
      title: 'Ada',
      text: 'Contact',
    }),
  );
  const createFolder = h.app.vault.createFolder.bind(h.app.vault);
  vi.spyOn(h.app.vault, 'createFolder').mockImplementationOnce(async (path) => {
    const result = await createFolder(path);
    await h.index.refreshSourceExclusion(
      () => true,
      () => true,
    );
    return result;
  });
  expect(await h.notes.create(h.commit(plan))).toMatchObject({
    ok: false,
    effects: 'partial',
    receipt: { noteEffects: 'unchanged', destinationEffects: 'committed' },
  });
  expect(h.app.vault.getAbstractFileByPath('new')).not.toBeNull();
  expect(h.app.vault.getAbstractFileByPath('new/contact.md')).toBeNull();
});
it('retains an unknown create and does not duplicate the possibly created note', async () => {
  const h = await setup('Contact\n');
  const plan = ok(
    await h.notes.prepare({ kind: 'create', path: 'new.md', title: 'Ada', text: 'Contact' }),
  );
  const create = h.app.vault.create.bind(h.app.vault);
  const writes = vi.spyOn(h.app.vault, 'create').mockImplementationOnce(async (path, content) => {
    await create(path, content);
    throw new Error('Unacknowledged create');
  });
  const input = h.commit(plan),
    result = await h.notes.create(input);
  expect(result).toMatchObject({ ok: false, effects: 'unknown' });
  expect(await h.notes.create(input)).toEqual(result);
  expect(writes).toHaveBeenCalledTimes(1);
});

it.each(['Additional context', 'Additional context\r\n', ''])(
  'seals safe append line boundaries before a protected task: %j',
  async (text) => {
    const h = await setup('Contact\r\n\r\n- [ ] Root\r\n');
    const section = h.page.segments.find((part) => part.section.canAppend);
    if (section === undefined) throw new Error('Missing prose');
    const plan = ok(
      await h.notes.prepare({
        kind: 'edit',
        target: h.page.note.target,
        expectedRevision: h.page.note.revision,
        operation: { type: 'append', section: section.section.target, text },
      }),
    );
    const added = text === '' || text.endsWith('\n') ? text : `${text}\r\n`;
    expect(plan.after.text).toBe(`Contact\r\n\r\n${added}`);
    expect((await h.notes.apply(h.commit(plan))).ok).toBe(true);
    expect(await h.read('a.md')).toBe(`${plan.after.text}- [ ] Root\r\n`);
  },
);
