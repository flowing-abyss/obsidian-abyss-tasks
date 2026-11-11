import { afterEach, expect, it, vi } from 'vitest';
import type { ApiResultV1 } from '../api';
import { publicApiHarness, type PublicApiHarness } from './support/publicApiHarness';

const owners: PublicApiHarness[] = [];
afterEach(() => {
  owners.splice(0).forEach((owner) => {
    owner.dispose();
  });
});
async function setup(files: Record<string, string>) {
  const h = await publicApiHarness(files);
  owners.push(h);
  const notes = h.client().notes;
  if (notes === undefined) throw new Error('Missing notes capability');
  return { ...h, notes };
}
function ok<T>(result: ApiResultV1<T>): T {
  if (!result.ok) throw new Error(result.error.code);
  return result.value;
}
it('finds body-only contacts in zero-task notes and keeps duplicate basenames distinct', async () => {
  const h = await setup({
    'a/contact.md': 'Email: ada@example.org\n',
    'b/contact.md': 'Elsewhere\n',
  });
  const page = ok(await h.notes.search({ query: 'ada@example.org', fields: 'body' }));
  expect(page.items.map((item) => item.note.path)).toEqual(['a/contact.md']);
  expect(page.complete).toBe(true);
  expect(ok(await h.notes.search({ query: 'contact', fields: 'name' })).items).toHaveLength(2);
});
it('pages every authored character without splitting CRLF or surrogate pairs', async () => {
  const text = `\uFEFF---\r\naliases: [Ada]\r\n---\r\n${'Contact 🙂\r\n'.repeat(10000)}`;
  const h = await setup({ 'a.md': text });
  let cursor: string | undefined;
  let combined = '';
  do {
    const page = ok(
      await h.notes.read({
        selector: { path: 'a.md' },
        limitCharacters: 127,
        ...(cursor === undefined ? {} : { cursor }),
      }),
    );
    const chunk = page.segments.map((segment) => segment.text).join('');
    expect(chunk.endsWith('\r')).toBe(false);
    expect(/[\uD800-\uDBFF]$/u.test(chunk)).toBe(false);
    combined += chunk;
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  expect(combined).toBe(text);
});
it('prepares exact prose edits preserving frontmatter and task bytes, and deduplicates writes', async () => {
  const text =
    '\uFEFF---\r\naliases: [Ada]\r\n---\r\nContact\r\n\r\n- [ ] Root\r\n  - [ ] Child\r\n';
  const h = await setup({ 'a.md': text });
  const page = ok(await h.notes.read({ selector: { path: 'a.md' } }));
  const section = page.segments.find((segment) => segment.section.canReplace);
  if (section === undefined) throw new Error('Missing prose');
  const plan = ok(
    await h.notes.prepare({
      kind: 'edit',
      target: page.note.target,
      expectedRevision: page.note.revision,
      operation: {
        type: 'replace-section',
        section: section.section.target,
        text: 'New contact\r\n\r\n',
      },
    }),
  );
  expect(await h.read('a.md')).toBe(text);
  const input = {
    plan: plan.target,
    expectedPlanRevision: plan.revision,
    requestId: 'edit',
    expiresAt: Date.UTC(2026, 7, 1, 12) + 60000,
  };
  const receipt = await h.notes.apply(input);
  expect(receipt).toMatchObject({ ok: true, receipt: { noteEffects: 'committed' } });
  expect(await h.notes.apply(input)).toEqual(receipt);
  expect(await h.read('a.md')).toBe(text.replace('Contact', 'New contact'));
});
it('refuses generic task insertion and stale section handles', async () => {
  const h = await setup({ 'a.md': 'Contact\n' });
  const page = ok(await h.notes.read({ selector: { path: 'a.md' } }));
  const section = page.segments[0]?.section.target;
  if (section === undefined) throw new Error('Missing section');
  const input = {
    kind: 'edit' as const,
    target: page.note.target,
    expectedRevision: page.note.revision,
    operation: { type: 'append' as const, section, text: '- [ ] bypass' },
  };
  expect(await h.notes.prepare(input)).toMatchObject({
    ok: false,
    error: { code: 'TASK_CONTENT_REQUIRES_TASK_API' },
  });
  await h.external('a.md', 'External\n');
  expect(
    await h.notes.prepare({ ...input, operation: { ...input.operation, text: 'safe' } }),
  ).toMatchObject({ ok: false });
});
it('rechecks policy immediately before delivering an already-computed page', async () => {
  const h = await setup({ 'a.md': 'Secret contact\n' });
  const pending = h.notes.read({ selector: { path: 'a.md' } });
  await Promise.resolve();
  const refresh = h.index.refreshSourceExclusion(
    () => true,
    () => true,
  );
  expect(await pending).toMatchObject({ ok: false });
  await refresh;
});
it('rejects a same-byte native replacement after section projection returns', async () => {
  const h = await setup({ 'a.md': 'Same bytes\n', 'b.md': 'Same bytes\n' });
  const sections = h.noteService.sections.bind(h.noteService);
  const lookup = h.app.vault.getAbstractFileByPath.bind(h.app.vault);
  const replacement = lookup('b.md');
  vi.spyOn(h.noteService, 'sections').mockImplementationOnce((source) => {
    const result = sections(source);
    vi.spyOn(h.app.vault, 'getAbstractFileByPath').mockImplementation((path) =>
      path === 'a.md' ? replacement : lookup(path),
    );
    return result;
  });
  expect(await h.notes.read({ selector: { path: 'a.md' } })).toMatchObject({ ok: false });
});
it.each(['dispose', 'abort'])(
  'retire unpublished preparations at final %s delivery',
  async (action) => {
    const h = await setup({ 'a.md': 'Contact\n' });
    const client = h.client('delivery');
    const notes = client.notes;
    if (notes === undefined) throw new Error('Missing notes');
    const page = ok(await notes.read({ selector: { path: 'a.md' } }));
    const section = page.segments[0]?.section.target;
    if (section === undefined) throw new Error('Missing section');
    const controller = new AbortController();
    const prepare = h.noteService.prepareEdit.bind(h.noteService);
    vi.spyOn(h.noteService, 'prepareEdit').mockImplementationOnce((...args) => {
      const plan = prepare(...args);
      queueMicrotask(() => {
        if (action === 'dispose') client.dispose();
        else controller.abort();
      });
      return plan;
    });
    expect(
      await notes.prepare(
        {
          kind: 'edit',
          target: page.note.target,
          expectedRevision: page.note.revision,
          operation: { type: 'append', section, text: 'Later' },
        },
        { signal: controller.signal },
      ),
    ).toMatchObject({ ok: false, error: { code: action === 'dispose' ? 'DISPOSED' : 'ABORTED' } });
    expect(await h.read('a.md')).toBe('Contact\n');
  },
);
it('offers a safe append anchor after a frontmatter-only note without changing its closing bytes', async () => {
  const h = await setup({ 'a.md': '---\naliases: [Ada]\n---' });
  const page = ok(await h.notes.read({ selector: { path: 'a.md' } }));
  const section = page.segments.find((part) => part.section.canAppend)?.section;
  expect(section).toBeDefined();
  if (section === undefined) throw new Error('Missing append anchor');
  const plan = ok(
    await h.notes.prepare({
      kind: 'edit',
      target: page.note.target,
      expectedRevision: page.note.revision,
      operation: { type: 'append', section: section.target, text: 'Contact' },
    }),
  );
  expect(plan.after.text).toBe('\nContact');
});

it('stops a bounded scan after cancellation during source acquisition', async () => {
  const h = await setup({ 'a.md': 'Contact', 'b.md': 'Contact' });
  const abort = new AbortController();
  const acquire = h.noteService.sources.acquire.bind(h.noteService.sources);
  const reads = vi.spyOn(h.noteService.sources, 'acquire').mockImplementation(async (path) => {
    const result = await acquire(path);
    abort.abort();
    return result;
  });
  expect(await h.notes.search({ query: 'Contact' }, { signal: abort.signal })).toMatchObject({
    ok: false,
    error: { code: 'ABORTED' },
  });
  expect(reads).toHaveBeenCalledTimes(1);
});

it.each(['x'.repeat(262145), '🙂'.repeat(70000)])(
  'rejects oversized prepared input as a resource limit before acquisition',
  async (text) => {
    const h = await setup({ 'a.md': 'Contact' });
    const reads = vi.spyOn(h.noteService.sources, 'acquire');
    expect(
      await h.notes.prepare({ kind: 'create', path: 'new.md', title: 'New', text }),
    ).toMatchObject({ ok: false, error: { code: 'RESOURCE_LIMIT' } });
    expect(reads).not.toHaveBeenCalled();
  },
);

it.each(['dispose', 'abort'])('rejects the final read projection after %s', async (action) => {
  const h = await setup({ 'a.md': 'Contact\n' });
  const client = h.client('final-read');
  const notes = client.notes;
  if (notes === undefined) throw new Error('Missing notes');
  const controller = new AbortController();
  const sections = h.noteService.sections.bind(h.noteService);
  vi.spyOn(h.noteService, 'sections').mockImplementationOnce((source) => {
    const result = sections(source);
    queueMicrotask(() => {
      if (action === 'dispose') client.dispose();
      else controller.abort();
    });
    return result;
  });
  expect(
    await notes.read({ selector: { path: 'a.md' } }, { signal: controller.signal }),
  ).toMatchObject({ ok: false, error: { code: action === 'dispose' ? 'DISPOSED' : 'ABORTED' } });
});

it.each([['[[A/Research|Finding]]'], ['[Finding](A/Research.md)']])(
  'formats a host link from an absent source without reading or creating that source: %s',
  async (link) => {
    const h = await setup({ 'A/Research.md': 'Result', 'B/Research.md': 'Other' });
    const target = ok(await h.notes.read({ selector: { path: 'A/Research.md' } })).note;
    const reads = vi.spyOn(h.app.vault, 'read');
    const creates = vi.spyOn(h.app.vault, 'create');
    vi.spyOn(h.app.fileManager, 'generateMarkdownLink').mockReturnValue(link);
    vi.spyOn(h.app.metadataCache, 'getFirstLinkpathDest').mockImplementation((path) =>
      h.app.vault.getFileByPath(path.endsWith('.md') ? path : `${path}.md`),
    );
    const result = await h.notes.read({
      selector: { target: target.target, expectedRevision: target.revision },
      linkFor: { fromPath: 'B/Unwritten.md', alias: 'Finding' },
    });
    expect(result).toMatchObject({ ok: true, value: { markdownLink: link } });
    expect(reads.mock.calls.some(([file]) => file.path === 'B/Unwritten.md')).toBe(false);
    expect(creates).not.toHaveBeenCalled();
    expect(h.app.vault.getAbstractFileByPath('B/Unwritten.md')).toBeNull();
  },
);
it.each([
  { fromPath: '../escape.md' },
  { fromPath: '/absolute.md' },
  { fromPath: 'file:///private.md' },
  { fromPath: 'okay.md', from: 'mixed', expectedFromRevision: 'mixed' },
  { fromPath: 'okay.md', extra: true },
])('rejects invalid formatting context %j', async (linkFor) => {
  const h = await setup({ 'a.md': 'Result' });
  expect(await h.notes.read({ selector: { path: 'a.md' }, linkFor })).toMatchObject({
    ok: false,
    error: { code: 'INVALID_ARGUMENT' },
  });
});
it('rejects a generated link that resolves to a different destination', async () => {
  const h = await setup({ 'a.md': 'Result', 'b.md': 'Wrong' });
  vi.spyOn(h.app.fileManager, 'generateMarkdownLink').mockReturnValue('[[b]]');
  vi.spyOn(h.app.metadataCache, 'getFirstLinkpathDest').mockReturnValue(
    h.app.vault.getFileByPath('b.md'),
  );
  expect(
    await h.notes.read({
      selector: { path: 'a.md' },
      linkFor: { fromPath: 'missing.md' },
    }),
  ).toMatchObject({ ok: false });
});
