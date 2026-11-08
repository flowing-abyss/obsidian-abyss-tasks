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

it('preserves exact-path rejection and freezes an opted-in collision suffix before writing', async () => {
  const h = await setup('Keep original\n', {
    'Folder/Research.md': 'Unrelated\n',
    'Folder/Research 2.md': 'Also keep\n',
  });
  expect(h.client.info.capabilities).toContain('notes.create.collision');
  expect(h.client.info.capabilities).toContain('notes.apply.section');
  const input = {
    kind: 'create' as const,
    path: 'Folder/Research.md',
    title: 'Research',
    text: 'New evidence',
  };
  for (const collision of [undefined, 'reject'] as const)
    expect(
      await h.notes.prepare({ ...input, ...(collision === undefined ? {} : { collision }) }),
    ).toMatchObject({ ok: false, error: { code: 'DESTINATION_EXISTS' } });
  const plan = ok(await h.notes.prepare({ ...input, collision: 'suffix' }));
  expect(plan.path).toBe('Folder/Research 3.md');
  expect(h.app.vault.getFileByPath(plan.path)).toBeNull();
  expect(await h.notes.create(h.commit(plan))).toMatchObject({
    ok: true,
    receipt: { noteEffects: 'committed' },
  });
  expect(await h.read(plan.path)).toContain('New evidence');
  expect(await h.read('Folder/Research.md')).toBe('Unrelated\n');
  expect(await h.read('Folder/Research 2.md')).toBe('Also keep\n');
});
it('rejects later collisions at the frozen note path and keeps canonical note protection', async () => {
  const h = await setup('Keep original\n', { 'Research.md': 'Existing\n' });
  const input = {
    kind: 'create' as const,
    path: 'Research.md',
    title: 'Research',
    text: 'Evidence',
    collision: 'suffix' as const,
  };
  const plan = ok(await h.notes.prepare(input));
  await h.app.vault.create(plan.path, 'Intervening owner\n');
  expect(await h.notes.create(h.commit(plan))).toMatchObject({ ok: false, effects: 'unchanged' });
  expect(await h.read(plan.path)).toBe('Intervening owner\n');
  expect(h.app.vault.getFileByPath('Research 3.md')).toBeNull();
  expect(await h.notes.prepare({ ...input, text: '- [ ] Unauthorized task' })).toMatchObject({
    ok: false,
  });
  expect(await h.notes.prepare({ ...input, path: '../escape.md' })).toMatchObject({ ok: false });
});
it('bounds suffix candidates and rejects unknown collision policies', async () => {
  const h = await setup(
    'Keep\n',
    Object.fromEntries(
      Array.from({ length: 101 }, (_, i) => [
        i === 0 ? 'Research.md' : `Research ${i + 1}.md`,
        'Keep',
      ]),
    ),
  );
  const input = {
    kind: 'create' as const,
    path: 'Research.md',
    title: 'Research',
    text: 'Evidence',
  };
  expect(await h.notes.prepare({ ...input, collision: 'suffix' })).toMatchObject({
    ok: false,
    error: { code: 'RESOURCE_LIMIT' },
  });
  expect(await h.notes.prepare({ ...input, collision: 'overwrite' } as never)).toMatchObject({
    ok: false,
    error: { code: 'INVALID_ARGUMENT' },
  });
});

it('returns an exact fresh edited-range handle and rejects stale, invalid and wrong-note scopes', async () => {
  const h = await setup('Contact\n\n- [ ] Protected\n', { 'Other.md': 'Other prose\n' });
  const previous = h.page.segments[0]?.section.target;
  const plan = ok(await h.prepare('Changed prose\n\n'));
  const saved = await h.notes.apply(h.commit(plan));
  if (!saved.ok || saved.receipt.section === undefined) throw new Error('Missing edited scope');
  expect(saved.receipt.section).not.toBe(previous);
  const current = ok(await h.notes.read({ selector: { section: saved.receipt.section } }));
  expect(current.selection).toBe('section');
  expect(current.note).toMatchObject(saved.receipt.note ?? {});
  expect(current.segments.map((segment) => segment.text).join('')).toBe('Changed prose\n\n');
  expect(await h.notes.read({ selector: { section: 'invented' } })).toMatchObject({ ok: false });
  if (previous === undefined) throw new Error('Missing old scope');
  expect(await h.notes.read({ selector: { section: previous } })).toMatchObject({ ok: false });
  const other = ok(await h.notes.read({ selector: { path: 'Other.md' } }));
  expect(
    await h.notes.prepare({
      kind: 'edit',
      target: other.note.target,
      expectedRevision: other.note.revision,
      operation: { type: 'replace-section', section: saved.receipt.section, text: 'Unauthorized' },
    }),
  ).toMatchObject({ ok: false });
  expect(await h.read('Other.md')).toBe('Other prose\n');
  await h.external('a.md', 'External\n\n- [ ] Protected\n');
  expect(await h.notes.read({ selector: { section: saved.receipt.section } })).toMatchObject({
    ok: false,
  });
  const replay = await h.notes.apply(h.commit(plan));
  expect(replay.receipt).not.toHaveProperty('section');
  expect(replay.receipt).not.toHaveProperty('note');
});
it('withholds edited scope when a concurrent native write prevents exact accepted readback', async () => {
  const h = await setup();
  const plan = ok(await h.prepare('Changed\n\n'));
  const process = h.app.vault.process.bind(h.app.vault);
  vi.spyOn(h.app.vault, 'process').mockImplementationOnce(async (file, callback) => {
    const written = await process(file, callback);
    await h.app.vault.modify(file, 'Concurrent\n');
    return written;
  });
  const result = await h.notes.apply(h.commit(plan));
  expect(result.receipt).toMatchObject({ noteEffects: 'committed', recovery: 'reread' });
  expect(result.receipt).not.toHaveProperty('section');
  expect(result.receipt).not.toHaveProperty('note');
  expect(await h.read('a.md')).toBe('Concurrent\n');
});

it('rechecks scope for a suffixed path and before its frozen creation commits', async () => {
  const h = await setup('Keep original\n', { 'Research.md': 'Occupied\n' });
  const input = {
    kind: 'create' as const,
    path: 'Research.md',
    title: 'Research',
    text: 'Evidence',
    collision: 'suffix' as const,
  };
  await h.index.refreshSourceExclusion((source) => source.filePath === 'Research 2.md');
  expect(await h.notes.prepare(input)).toMatchObject({
    ok: false,
    error: { code: 'TARGET_UNAVAILABLE' },
  });
  expect(h.app.vault.getFileByPath('Research 2.md')).toBeNull();
  await h.index.refreshSourceExclusion(() => false);
  const plan = ok(await h.notes.prepare(input));
  await h.index.refreshSourceExclusion(() => true);
  expect(await h.notes.create(h.commit(plan))).toMatchObject({ ok: false, effects: 'unchanged' });
  expect(h.app.vault.getFileByPath(plan.path)).toBeNull();
});

it('composes exact independent note sections and same-section refinements into one protected write', async () => {
  const original =
    '---\nkeep: true\n---\nFirst prose\n\n- [ ] Same\n  - [ ] Child\n\nMiddle prose\n\n- [ ] Same\n  - [ ] Child\n\nLast prose\n';
  const h = await setup(original, { 'Other.md': 'Other prose\n' });
  const first = h.page.segments.find((part) => part.text.includes('First prose'));
  const middle = h.page.segments.find((part) => part.text.includes('Middle prose'));
  if (first === undefined || middle === undefined) throw new Error('Missing editable scopes');
  const one = ok(await h.prepare(`${first.text}First addition\n`));
  const refine = (plan: NotePlanV1, operation: unknown, options?: { signal: AbortSignal }) =>
    h.notes.prepare(
      {
        kind: 'refine',
        plan: plan.target,
        expectedPlanRevision: plan.revision,
        operation,
      } as Parameters<typeof h.notes.prepare>[0],
      options,
    );
  const two = ok(
    await refine(one, { type: 'append', section: first.section.target, text: 'Second addition' }),
  );
  expect(two.target).toBe(one.target);
  expect(two.revision).not.toBe(one.revision);
  expect(two.after.text).toContain('First addition\nSecond addition');
  const three = ok(
    await refine(two, {
      type: 'replace-section',
      section: middle.section.target,
      text: middle.text.replace('Middle prose', 'Changed middle'),
    }),
  );
  const final = ok(
    await refine(three, {
      type: 'replace-section',
      section: first.section.target,
      text: first.text.replace('First prose', 'Corrected first'),
    }),
  );
  expect(final.sections).toHaveLength(2);
  expect(final.after.text).toContain('Changed middle');
  expect(final.after.text).not.toContain('First addition');
  expect(
    await refine(one, { type: 'append', section: first.section.target, text: 'Stale' }),
  ).toMatchObject({ ok: false });
  const protectedPart = h.page.segments.find((part) => part.section.kind === 'task');
  if (protectedPart === undefined) throw new Error('Missing task scope');
  expect(
    await refine(final, {
      type: 'replace-section',
      section: protectedPart.section.target,
      text: 'Unauthorized',
    }),
  ).toMatchObject({ ok: false });
  const other = ok(await h.notes.read({ selector: { path: 'Other.md' } }));
  expect(
    await refine(final, {
      type: 'append',
      section: other.segments[0]?.section.target,
      text: 'Wrong owner',
    }),
  ).toMatchObject({ ok: false });
  const cancelled = new AbortController();
  const pending = refine(
    final,
    { type: 'append', section: first.section.target, text: 'Cancelled' },
    { signal: cancelled.signal },
  );
  cancelled.abort();
  expect(await pending).toMatchObject({ ok: false });
  expect(await h.read('a.md')).toBe(original);
  const write = vi.spyOn(h.app.vault, 'process');
  expect(await h.notes.apply(h.commit(one, 'stale'))).toMatchObject({
    ok: false,
    effects: 'unchanged',
  });
  const saved = await h.notes.apply(h.commit(final));
  expect(saved.ok).toBe(true);
  expect(write).toHaveBeenCalledTimes(1);
  expect(await h.read('a.md')).toBe(
    original.replace('First prose', 'Corrected first').replace('Middle prose', 'Changed middle'),
  );
  if (saved.receipt?.section === undefined) throw new Error('Missing composed readback');
  const current = ok(await h.notes.read({ selector: { section: saved.receipt.section } }));
  expect(current.segments.map((part) => part.text).join('')).toContain('Changed middle');
  expect(current.segments.map((part) => part.text).join('')).toContain('Corrected first');
});
it('refines only a new note body while retaining its frozen collision path and static template', async () => {
  const h = await setup('Keep\n', {
    'Research.md': 'Existing\n',
    'Template.md': '# {{title}}\n\nFixed template\n',
  });
  const template = ok(await h.notes.read({ selector: { path: 'Template.md' } }));
  const created = ok(
    await h.notes.prepare({
      kind: 'create',
      path: 'Research.md',
      collision: 'suffix',
      title: 'Research title',
      text: 'Long conclusions',
      template: template.note.target,
      expectedTemplateRevision: template.note.revision,
    }),
  );
  const refine = (text: string) =>
    h.notes.prepare({
      kind: 'refine',
      plan: created.target,
      expectedPlanRevision: created.revision,
      operation: { type: 'replace-body', text },
    });
  expect(await refine('- [ ] Forbidden task')).toMatchObject({ ok: false });
  const revised = ok(await refine('Short conclusions'));
  expect(revised.target).toBe(created.target);
  expect(revised.path).toBe('Research 2.md');
  expect(revised.after.text).toContain('Research title');
  expect(revised.after.text).toContain('Fixed template');
  expect(revised.after.text).toContain('Short conclusions');
  expect(revised.after.text).not.toContain('Long conclusions');
  expect(h.app.vault.getFileByPath(revised.path)).toBeNull();
  expect(await h.notes.create(h.commit(created, 'stale-create'))).toMatchObject({ ok: false });
  expect((await h.notes.create(h.commit(revised))).ok).toBe(true);
  expect(await h.read(revised.path)).toBe(revised.after.text);
  expect(await h.read('Research.md')).toBe('Existing\n');
});

it('bounds composed note edits at twenty ranges and retains the previous valid plan after overflow', async () => {
  const content = Array.from({ length: 21 }, (_, i) => `Prose ${i}\n\n- [ ] Task ${i}\n\n`).join(
    '',
  );
  const h = await setup(content);
  const parts = h.page.segments.filter(
    (part) => part.section.canReplace && part.text.includes('Prose'),
  );
  expect(parts).toHaveLength(21);
  const first = parts[0];
  if (first === undefined) throw new Error('Missing first range');
  let plan = ok(await h.prepare(first.text.replace('Prose', 'Edited')));
  for (const part of parts.slice(1, 20))
    plan = ok(
      await h.notes.prepare({
        kind: 'refine',
        plan: plan.target,
        expectedPlanRevision: plan.revision,
        operation: {
          type: 'replace-section',
          section: part.section.target,
          text: part.text.replace('Prose', 'Edited'),
        },
      }),
    );
  const overflow = parts[20];
  if (overflow === undefined) throw new Error('Missing overflow range');
  expect(
    await h.notes.prepare({
      kind: 'refine',
      plan: plan.target,
      expectedPlanRevision: plan.revision,
      operation: { type: 'append', section: overflow.section.target, text: 'Overflow' },
    }),
  ).toMatchObject({ ok: false, error: { code: 'RESOURCE_LIMIT' } });
  expect((await h.notes.apply(h.commit(plan))).ok).toBe(true);
  expect(await h.read('a.md')).toContain('Prose 20');
  expect(await h.read('a.md')).not.toContain('Overflow');
});

it('publishes only one competing refinement and leaves its current revision committable', async () => {
  const h = await setup();
  const plan = ok(await h.prepare('Changed\n\n'));
  const section = h.page.segments.find((part) => part.section.canReplace)?.section.target;
  if (section === undefined) throw new Error('Missing section');
  const results = await Promise.all(
    ['A', 'B'].map((text) =>
      h.notes.prepare({
        kind: 'refine',
        plan: plan.target,
        expectedPlanRevision: plan.revision,
        operation: { type: 'append', section, text },
      }),
    ),
  );
  expect(results.filter((result) => result.ok)).toHaveLength(1);
  const success = results.find((result) => result.ok);
  if (!success?.ok) throw new Error('Missing winner');
  expect((await h.notes.apply(h.commit(success.value))).ok).toBe(true);
  expect(await h.read('a.md')).toContain(success.value.after.text);
});
