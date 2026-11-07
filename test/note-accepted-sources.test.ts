import type * as Obsidian from 'obsidian';
import { TFile, type CachedMetadata } from 'obsidian';
import { afterEach, expect, it, vi } from 'vitest';
import type { ApiResultV1 } from '../api';
import { flushMicrotasks, metadataChangedEmitter } from './helpers';
import { publicApiHarness, type PublicApiHarness } from './support/publicApiHarness';
vi.mock('obsidian', async (original) => {
  const host = await original<typeof Obsidian>();
  return {
    ...host,
    resolveSubpath: (cache: CachedMetadata, subpath: string) => {
      if (subpath === '#Topic' && cache.headings?.[0] !== undefined)
        return {
          type: 'heading',
          current: cache.headings[0],
          start: cache.headings[0].position.start,
          end: null,
        };
      if (subpath === '#^phone' && cache.blocks?.['phone'] !== undefined)
        return {
          type: 'block',
          block: cache.blocks['phone'],
          start: cache.blocks['phone'].position.start,
          end: cache.blocks['phone'].position.end,
        };
      return null;
    },
  };
});
const owners: PublicApiHarness[] = [];
afterEach(() => {
  owners.splice(0).forEach((h) => {
    h.dispose();
  });
});
function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('Missing fixture value');
  return value;
}
function ok<T>(r: ApiResultV1<T>): T {
  if (!r.ok) throw new Error(r.error.code);
  return r.value;
}
async function setup(files: Record<string, string>) {
  const h = await publicApiHarness(files);
  owners.push(h);
  const client = h.client();
  if (client.notes === undefined) throw new Error('Missing notes');
  return { ...h, client, notes: client.notes };
}
it('publishes zero-task body changes and expires cursors while retaining note incarnation', async () => {
  const h = await setup({ 'contact.md': 'Contact\nDetails\n' });
  const page = ok(await h.notes.read({ selector: { path: 'contact.md' }, limitCharacters: 4 }));
  const observation = h.reads.capture();
  await h.external('contact.md', 'Different body\n');
  expect(h.reads.capture().generation).toBeGreaterThan(observation.generation);
  expect(
    await h.notes.read({
      selector: { path: 'contact.md' },
      limitCharacters: 4,
      cursor: required(page.nextCursor),
    }),
  ).toMatchObject({ ok: false, error: { code: 'STALE_CURSOR' } });
  expect(ok(await h.notes.read({ selector: { target: page.note.target } })).note.revision).not.toBe(
    page.note.revision,
  );
});
it('never discloses excluded or malformed sources', async () => {
  const h = await setup({
    'a.md': 'Visible contact\n',
    'malformed.md': '---\n[broken\n---\nSecret contact\n',
  });
  expect(await h.notes.search({ query: 'contact' })).toMatchObject({
    ok: false,
    error: { code: 'INCOMPLETE_READ' },
  });
  await h.index.refreshSourceExclusion(
    (source) => source.filePath === 'malformed.md',
    (path) => path === 'malformed.md',
  );
  expect(
    ok(await h.notes.search({ query: 'contact' })).items.map((item) => item.note.path),
  ).toEqual(['a.md']);
  expect(await h.notes.read({ selector: { path: 'malformed.md' } })).toMatchObject({ ok: false });
});
it('uses exact event structure for relative aliases, heading/block selections and host link generation', async () => {
  const content = '# Topic\nEmail ada@example.org\n\nPhone 123 ^phone\n';
  const h = await setup({
    'a/from.md': 'From\n',
    'a/contact.md': content,
    'b/contact.md': '# Other\n',
  });
  const origin = ok(await h.notes.read({ selector: { path: 'a/from.md' } })).note;
  const file = h.app.vault.getAbstractFileByPath('a/contact.md');
  if (!(file instanceof TFile)) throw new Error('Missing contact');
  const resolve = vi.spyOn(h.app.metadataCache, 'getFirstLinkpathDest').mockReturnValue(file);
  const selector = {
    link: {
      from: origin.target,
      expectedFromRevision: origin.revision,
      wikiLink: '[[contact#Topic|Ada]]',
    },
  };
  expect(await h.notes.read({ selector })).toMatchObject({
    ok: false,
    error: { code: 'INCOMPLETE_READ' },
  });
  const blockFrom = content.indexOf('Phone');
  const cache: CachedMetadata = {
    headings: [
      {
        heading: 'Topic',
        level: 1,
        position: { start: { line: 0, col: 0, offset: 0 }, end: { line: 0, col: 7, offset: 7 } },
      },
    ],
    blocks: {
      phone: {
        id: 'phone',
        position: {
          start: { line: 3, col: 0, offset: blockFrom },
          end: { line: 3, col: 16, offset: content.length - 1 },
        },
      },
    },
  };
  metadataChangedEmitter(h.app)(file, content, cache);
  await flushMicrotasks();
  const page = ok(await h.notes.read({ selector }));
  expect(page.selection).toBe('heading');
  expect(page.segments.map((part) => part.text).join('')).toBe(content);
  expect(resolve).toHaveBeenCalledWith('contact', 'a/from.md');
  const block = ok(
    await h.notes.read({
      selector: { link: { ...selector.link, wikiLink: '[[contact#^phone|Phone]]' } },
    }),
  );
  expect(block.selection).toBe('block');
  expect(block.segments.map((part) => part.text).join('')).toContain('Phone 123');
  const clipped = block.segments.find((part) => part.text.includes('Phone 123'));
  if (clipped === undefined) throw new Error('Missing block prose');
  expect(clipped.section.canReplace).toBe(false);
  expect(
    await h.notes.prepare({
      kind: 'edit',
      target: block.note.target,
      expectedRevision: block.note.revision,
      operation: { type: 'replace-section', section: clipped.section.target, text: 'Replacement' },
    }),
  ).toMatchObject({ ok: false });
  const generate = vi
    .spyOn(h.app.fileManager, 'generateMarkdownLink')
    .mockReturnValue('[[contact#Topic|Ada]]');
  expect(
    ok(
      await h.notes.read({
        selector,
        linkFor: { from: origin.target, expectedFromRevision: origin.revision, alias: 'Ada' },
      }),
    ).markdownLink,
  ).toBe('[[contact#Topic|Ada]]');
  expect(generate).toHaveBeenCalledWith(file, 'a/from.md', '#Topic', 'Ada');
  expect(
    await h.notes.read({
      selector: { link: { ...selector.link, wikiLink: '[[contact#Missing]]' } },
    }),
  ).toMatchObject({ ok: false, error: { code: 'SUBPATH_NOT_FOUND' } });
});
it('uses bounded whole-source search pages, including far-apart query terms', async () => {
  const h = await setup({
    'a.md': 'ordinary',
    'b.md': `alpha ${'x'.repeat(300000)} omega`,
    'c.md': 'alpha omega',
  });
  const first = ok(await h.notes.search({ query: 'alpha omega' }));
  expect(first.items).toHaveLength(0);
  expect(first.complete).toBe(false);
  const second = ok(
    await h.notes.search({ query: 'alpha omega', cursor: required(first.nextCursor) }),
  );
  expect(second.items.map((item) => item.note.path)).toEqual(['b.md']);
  expect(second.complete).toBe(false);
  const third = ok(
    await h.notes.search({ query: 'alpha omega', cursor: required(second.nextCursor) }),
  );
  expect(third.items.map((item) => item.note.path)).toEqual(['c.md']);
  expect(third.complete).toBe(true);
});
it('refuses a source over the hard search ceiling while keeping paged reads', async () => {
  const h = await setup({ 'large.md': 'x'.repeat(4194305) });
  expect(await h.notes.search({ query: 'missing' })).toMatchObject({
    ok: false,
    error: { code: 'RESOURCE_LIMIT' },
  });
  const page = ok(await h.notes.read({ selector: { path: 'large.md' }, limitCharacters: 32 }));
  expect(page.segments[0]?.text).toHaveLength(32);
  expect(page.complete).toBe(false);
});

it.each([
  [' ', true],
  [' ', false],
  ['\t', true],
  ['\t', false],
  ['\n', true],
  ['\n', false],
  ['\r\n', true],
  ['\r\n', false],
] as const)('preserves block-anchor separator %j when append=%s', async (separator, append) => {
  const content = `Phone 123${separator}^phone\r\n`;
  const h = await setup({ 'contact.md': content });
  const file = h.app.vault.getFileByPath('contact.md');
  if (file === null) throw new Error('Missing source');
  metadataChangedEmitter(h.app)(file, content, {
    blocks: {
      phone: {
        id: 'phone',
        position: {
          start: { line: 0, col: 0, offset: 0 },
          end: {
            line: separator.includes('\n') ? 1 : 0,
            col: separator.includes('\n') ? 6 : content.length - 2,
            offset: content.length - 2,
          },
        },
      },
    },
  });
  await flushMicrotasks();
  let cursor: string | undefined;
  let reconstructed = '';
  do {
    const page = ok(
      await h.notes.read({
        selector: { path: 'contact.md' },
        limitCharacters: 2,
        ...(cursor === undefined ? {} : { cursor }),
      }),
    );
    reconstructed += page.segments.map((part) => part.text).join('');
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  expect(reconstructed).toBe(content);
  const read = await h.noteService.sources.acquire('contact.md');
  if (read.type !== 'ok' || read.value === undefined) throw new Error('Missing source');
  const range = h.noteService.sections(read.value).find((part) => part.editable);
  if (range === undefined) throw new Error('Missing prose');
  expect(content.slice(range.to)).toBe(`${separator}^phone\r\n`);
  const plan = h.noteService.prepareEdit(read.value, range, 'Mobile', append);
  expect(await plan.commit()).toMatchObject({ noteEffects: 'committed' });
  expect(await h.read('contact.md')).toContain(`Mobile${separator}^phone`);
});

it('uses source policy for config paths and refuses traversal or absolute note paths', async () => {
  const h = await publicApiHarness({ 'visible.md': 'Contact' });
  await h.index.refreshSourceExclusion(
    () => false,
    (path) => path.startsWith(`${h.app.vault.configDir}/`),
  );
  owners.push(h);
  const notes = required(h.client().notes);
  const writes = vi.spyOn(h.app.vault, 'create');
  for (const path of [
    `${h.app.vault.configDir}/private.md`,
    '../outside.md',
    'C:/outside.md',
    '/outside.md',
  ]) {
    expect(
      await notes.prepare({ kind: 'create', path, title: 'Denied', text: 'Contact' }),
    ).toMatchObject({ ok: false });
  }
  expect(writes).not.toHaveBeenCalled();
});

it.each([2, 64])(
  'finishes a task-child block selection with %i-character pages',
  async (limitCharacters) => {
    const content = '- [ ] Root\n  - [ ] Child ^phone\n  - [ ] Sibling\n';
    const selectedText = '- [ ] Child ^phone';
    const h = await setup({ 'tasks.md': content });
    const file = required(h.app.vault.getFileByPath('tasks.md') ?? undefined);
    metadataChangedEmitter(h.app)(file, content, {
      blocks: {
        phone: {
          id: 'phone',
          position: {
            start: { line: 1, col: 2, offset: 13 },
            end: { line: 1, col: 20, offset: 31 },
          },
        },
      },
    });
    await flushMicrotasks();
    const origin = ok(await h.notes.read({ selector: { path: 'tasks.md' } })).note;
    const selector = {
      link: { from: origin.target, expectedFromRevision: origin.revision, wikiLink: '[[#^phone]]' },
    };
    let cursor: string | undefined;
    let text = '';
    let complete = false;
    for (let count = 0; count < 20; count++) {
      const page = ok(
        await h.notes.read({
          selector,
          limitCharacters,
          ...(cursor === undefined ? {} : { cursor }),
        }),
      );
      const part = page.segments.map((segment) => segment.text).join('');
      expect(part.length).toBeGreaterThan(0);
      expect(
        page.segments.every((segment) => !segment.section.canAppend && !segment.section.canReplace),
      ).toBe(true);
      text += part;
      cursor = page.nextCursor;
      complete = page.complete;
      if (complete) break;
    }
    expect(text).toBe(selectedText);
    expect(complete).toBe(true);
    expect(cursor).toBeUndefined();
  },
);

it.each([
  { underline: '=======', level: 1, newline: '\n', bom: '' },
  { underline: '-------', level: 2, newline: '\r\n', bom: '\uFEFF' },
])(
  'protects the complete verified Setext anchor: $level',
  async ({ underline, level, newline, bom }) => {
    const normalized = `Topic${newline}${underline}${newline}Phone 123${newline}`;
    const content = bom + normalized;
    const h = await setup({ 'contact.md': content });
    const origin = ok(await h.notes.read({ selector: { path: 'contact.md' } })).note;
    const selector = {
      link: { from: origin.target, expectedFromRevision: origin.revision, wikiLink: '[[#Topic]]' },
    };
    expect(await h.notes.read({ selector })).toMatchObject({
      ok: false,
      error: { code: 'INCOMPLETE_READ' },
    });
    const file = required(h.app.vault.getFileByPath('contact.md') ?? undefined);
    metadataChangedEmitter(h.app)(file, normalized, {
      headings: [
        {
          heading: 'Topic',
          level,
          position: {
            start: { line: 0, col: 0, offset: 0 },
            end: { line: 1, col: 7, offset: 5 + newline.length + 7 },
          },
        },
      ],
    });
    await flushMicrotasks();
    const page = ok(await h.notes.read({ selector }));
    expect(page.selection).toBe('heading');
    expect(page.complete).toBe(true);
    expect(page.segments.map((part) => part.text).join('')).toBe(normalized);
    const heading = required(page.segments.find((part) => part.section.kind === 'heading'));
    expect(heading.text).toBe(`Topic${newline}${underline}${newline}`);
    expect(heading.section).toMatchObject({ canAppend: false, canReplace: false });
    expect(
      await h.notes.prepare({
        kind: 'edit',
        target: page.note.target,
        expectedRevision: page.note.revision,
        operation: { type: 'replace-section', section: heading.section.target, text: 'Changed' },
      }),
    ).toMatchObject({ ok: false });
    const whole = ok(await h.notes.read({ selector: { path: 'contact.md' } }));
    expect(whole.segments.find((part) => part.section.kind === 'heading')?.text).toBe(heading.text);
    const prose = required(whole.segments.find((part) => part.section.canAppend));
    const plan = ok(
      await h.notes.prepare({
        kind: 'edit',
        target: whole.note.target,
        expectedRevision: whole.note.revision,
        operation: { type: 'append', section: prose.section.target, text: 'Mobile 456' },
      }),
    );
    expect(plan.after.text).not.toContain(underline);
  },
);
