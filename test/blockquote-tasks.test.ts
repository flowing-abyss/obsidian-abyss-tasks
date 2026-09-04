import { type CachedMetadata } from 'obsidian';
import { describe, expect, it } from 'vitest';
import { parseSubItems as parseSubItemsWithCatalog } from '../src/parser/SubItemParser';
import { formatTaskLine, parseTask as parseTaskWithCatalog } from '../src/parser/TaskParser';
import type { ParseContext } from '../src/parser/types';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import {
  canonicalStatusCatalog,
  configuredTaskApplication,
  createAppWithFiles,
  expectDefined,
  seedTaskCache,
  useRealMoment,
} from './helpers';

useRealMoment();

const statusCatalog = canonicalStatusCatalog();
const parseTask = (rawText: string, ctx: Omit<ParseContext, 'statusCatalog'>) =>
  parseTaskWithCatalog(rawText, { ...ctx, statusCatalog });
const parseSubItems = (lines: string[], taskLineIdx: number, filePath: string) =>
  parseSubItemsWithCatalog(lines, taskLineIdx, filePath, statusCatalog);
const CTX = { filePath: 'f.md', line: 0 };

/**
 * Contract for tasks written inside blockquotes and callouts (`> - [ ]`).
 *
 * Obsidian's metadata cache includes these lines in `listItems` with a `task`
 * property (verified against a real vault), so the plugin must parse, format,
 * nest, and toggle them exactly like plain-list tasks while preserving the `>`
 * prefix. This mirrors obsidian-tasks, whose task regex allows `>` in the
 * leading indentation group.
 */
describe('blockquote tasks — parseTask', () => {
  it('parses open / done / cancelled / in-progress inside a blockquote', () => {
    expect(parseTask('> - [ ] open', CTX)?.status).toBe('open');
    expect(parseTask('> - [x] done', CTX)?.status).toBe('done');
    expect(parseTask('> - [X] done caps', CTX)?.status).toBe('done');
    expect(parseTask('> - [-] cancelled', CTX)?.status).toBe('cancelled');
    expect(parseTask('> - [/] wip', CTX)?.status).toBe('in-progress');
  });

  it('accepts varied quote prefixes: ">>", "> >", extra spaces, no space', () => {
    expect(parseTask('>> - [ ] a', CTX)?.text).toBe('a');
    expect(parseTask('> > - [ ] b', CTX)?.text).toBe('b');
    expect(parseTask('>  - [ ] c', CTX)?.text).toBe('c');
    expect(parseTask('>- [ ] d', CTX)?.text).toBe('d');
    expect(parseTask('> \t- [ ] e', CTX)?.text).toBe('e');
  });

  it('extracts every metadata field from a blockquote task and strips it from text', () => {
    const t = parseTask(
      '> - [ ] #task/one-off Ship it ⏰ 09:30 ⏫ 🔁 every day 🛫 2026-06-20 ⏳ 2026-06-22 📅 2026-07-01',
      { filePath: 'f.md', line: 3 },
    );
    expect(t).not.toBeNull();
    expect(t?.due).toBe('2026-07-01');
    expect(t?.scheduled).toBe('2026-06-22');
    expect(t?.start).toBe('2026-06-20');
    expect(t?.time).toBe('09:30');
    expect(t?.recurrence).toBe('every day');
    expect(t?.priority).toBe('B');
    expect(t?.text).toBe('Ship it');
    expect(t?.line).toBe(3);
  });

  it('maps all five priority levels inside a blockquote', () => {
    expect(parseTask('> - [ ] a 🔺', CTX)?.priority).toBe('A');
    expect(parseTask('> - [ ] a ⏫', CTX)?.priority).toBe('B');
    expect(parseTask('> - [ ] a 🔼', CTX)?.priority).toBe('C');
    expect(parseTask('> - [ ] a', CTX)?.priority).toBe('D');
    expect(parseTask('> - [ ] a 🔽', CTX)?.priority).toBe('E');
    expect(parseTask('> - [ ] a ⏬', CTX)?.priority).toBe('F');
  });

  it('preserves the exact raw line as the locator fingerprint', () => {
    const raw = '> - [ ] Quoted task 📅 2026-07-01';
    expect(parseTask(raw, CTX)?.rawText).toBe(raw);
  });

  it('rejects blockquote lines that are not checkbox tasks', () => {
    expect(parseTask('> [!todo] Callout header', CTX)).toBeNull();
    expect(parseTask('> just a quote', CTX)).toBeNull();
    expect(parseTask('> - plain bullet, no checkbox', CTX)).toBeNull();
    expect(parseTask('>', CTX)).toBeNull();
  });

  it('does not treat a ">" inside the task text as a prefix', () => {
    const t = parseTask('- [ ] compare a > b in text', CTX);
    expect(t?.text).toBe('compare a > b in text');
  });
});

describe('blockquote tasks — formatTaskLine', () => {
  it('reorders metadata while preserving the "> " prefix', () => {
    expect(formatTaskLine('> - [ ] Task 📅 2026-07-01 #work')).toBe(
      '> - [ ] Task #work 📅 2026-07-01',
    );
  });

  it('preserves deeper / nested quote prefixes', () => {
    expect(formatTaskLine('>> - [ ] Task 📅 2026-07-01')).toBe('>> - [ ] Task 📅 2026-07-01');
    expect(formatTaskLine('> > - [ ] Task ⏰ 09:00')).toBe('> > - [ ] Task ⏰ 09:00');
  });

  it('is idempotent for blockquote tasks', () => {
    const input = '> - [ ] Task 📅 2026-07-01 ⏫ #work ⏰ 09:00 🔁 every day';
    const once = formatTaskLine(input);
    expect(formatTaskLine(once)).toBe(once);
  });

  it('leaves non-checkbox blockquote lines untouched', () => {
    expect(formatTaskLine('> [!todo] Header')).toBe('> [!todo] Header');
    expect(formatTaskLine('> plain quote')).toBe('> plain quote');
  });
});

describe('blockquote tasks — parseSubItems', () => {
  it('nests a "> \\t- [ ]" child under a "> - [ ]" parent', () => {
    const r = parseSubItems(['> - [x] Parent', '> \t- [x] Child'], 0, 'f.md');
    expect(r.subtasks).toHaveLength(1);
    expect(r.subtasks[0]).toMatchObject({ text: 'Child', status: 'done', line: 1 });
  });

  it('nests multiple levels deep within a blockquote', () => {
    const r = parseSubItems(
      ['> - [ ] Parent', '> \t- [ ] Child', '> \t\t- [ ] Grandchild'],
      0,
      'f.md',
    );
    expect(r.subtasks).toHaveLength(1);
    expect(r.subtasks[0]?.text).toBe('Child');
    expect(r.subtasks[0]?.subtasks?.[0]?.text).toBe('Grandchild');
  });

  it('treats flat sibling blockquote tasks as siblings, not sub-tasks', () => {
    const r = parseSubItems(['> - [ ] First', '> - [ ] Second', '> - [ ] Third'], 0, 'f.md');
    expect(r.subtasks).toHaveLength(0);
    expect(r.subtaskRange).toBeUndefined();
  });

  it('parses a blockquote description and comment line', () => {
    const r = parseSubItems(
      ['> - [ ] Parent', '> \t- > A description', '> \t- 2026-06-24: a dated note'],
      0,
      'f.md',
    );
    expect(r.description).toBe('A description');
    expect(r.comments).toHaveLength(1);
    expect(r.comments[0]).toMatchObject({
      timestamp: { precision: 'day', value: '2026-06-24', raw: '2026-06-24' },
      text: 'a dated note',
    });
  });

  // Regression: a "> " task following a plain-list task is a separate block, NOT a
  // child. Counting "> " toward indent depth once made it falsely nest here.
  it('does NOT nest a blockquote task under a preceding plain-list task', () => {
    const r = parseSubItems(['- [ ] plain task', '> - [ ] quoted task'], 0, 'f.md');
    expect(r.subtasks).toEqual([]);
    expect(r.subtaskRange).toBeUndefined();
  });

  it('does NOT nest a plain-list task under a preceding blockquote task', () => {
    const r = parseSubItems(['> - [ ] quoted task', '  - [ ] plain child?'], 0, 'f.md');
    expect(r.subtasks).toEqual([]);
  });

  it('does NOT nest a deeper-quote task (different container) as a sub-task', () => {
    const r = parseSubItems(['> - [ ] parent', '> > - [ ] deeper quote'], 0, 'f.md');
    expect(r.subtasks).toEqual([]);
  });

  it('keeps plain-list nesting unchanged (regression guard)', () => {
    const r = parseSubItems(['- [ ] Parent', '  - [ ] Child'], 0, 'f.md');
    expect(r.subtasks).toHaveLength(1);
    expect(r.subtasks[0]?.text).toBe('Child');
  });

  // Inside a blockquote, a "blank" line still carries the ">" marker ("> " or ">").
  // These must be treated as blank so a child after them is not dropped.
  it('captures a sub-task that follows a bare ">" blank separator', () => {
    const r = parseSubItems(['> - [ ] Parent', '>', '> \t- [ ] Child'], 0, 'f.md');
    expect(r.subtasks).toHaveLength(1);
    expect(r.subtasks[0]?.text).toBe('Child');
  });

  it('captures a sub-task that follows a "> " (marker + space) blank separator', () => {
    const r = parseSubItems(['> - [ ] Parent', '> ', '> \t- [ ] Child'], 0, 'f.md');
    expect(r.subtasks).toHaveLength(1);
    expect(r.subtasks[0]?.text).toBe('Child');
  });
});

/** Cast a partial cache object to CachedMetadata for setCache__. */
function cache(obj: unknown): CachedMetadata {
  return obj as CachedMetadata;
}

function setCache(app: Awaited<ReturnType<typeof createAppWithFiles>>, path: string, c: unknown) {
  (app.metadataCache as unknown as { setCache__: (p: string, c: unknown) => void }).setCache__(
    path,
    c,
  );
}

describe('blockquote tasks — TaskIndex integration', () => {
  it('parses a flat blockquote list as independent top-level tasks', async () => {
    const app = await createAppWithFiles({
      't.md': '> - [ ] one #category/a\n> - [ ] two #category/b\n> - [x] three',
    });
    // All three are root-level list items in the blockquote (negative parent).
    seedTaskCache(app, 't.md', [
      { task: ' ', parent: -1, line: 0 },
      { task: ' ', parent: -1, line: 1 },
      { task: 'x', parent: -1, line: 2 },
    ]);
    const stack = configuredTaskApplication(app, DEFAULT_SETTINGS);
    await stack.index.initialize();
    const tasks = stack.tasks.queries.list();
    expect(tasks).toHaveLength(3);
    expect(tasks.map((t) => t.title)).toEqual(['one', 'two', 'three']);
    expect(tasks.every((t) => t.subtasks.length === 0)).toBe(true);
  });

  it('parses a nested blockquote task as a parent with one sub-task', async () => {
    const app = await createAppWithFiles({ 't.md': '> - [x] Parent\n> \t- [x] Child' });
    seedTaskCache(app, 't.md', [
      { task: 'x', parent: -1, line: 0 },
      { task: 'x', parent: 0, line: 1 }, // child of line 0 → skipped in main loop
    ]);
    const stack = configuredTaskApplication(app, DEFAULT_SETTINGS);
    await stack.index.initialize();
    const tasks = stack.tasks.queries.list();
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.title).toBe('Parent');
    expect(tasks[0]?.subtasks).toHaveLength(1);
    expect(tasks[0]?.subtasks[0]?.title).toBe('Child');
  });

  it('does not phantom-nest a blockquote task after a plain-list task', async () => {
    const app = await createAppWithFiles({ 't.md': '- [ ] plain\n> - [ ] quoted' });
    // Two separate root blocks: both negative parent.
    seedTaskCache(app, 't.md', [
      { task: ' ', parent: -1, line: 0 },
      { task: ' ', parent: -2, line: 1 },
    ]);
    const stack = configuredTaskApplication(app, DEFAULT_SETTINGS);
    await stack.index.initialize();
    const tasks = stack.tasks.queries.list();
    expect(tasks).toHaveLength(2);
    expect(tasks.find((t) => t.title === 'plain')?.subtasks).toEqual([]);
  });

  it('ignores lines Obsidian excludes from listItems (e.g. fenced code blocks)', async () => {
    // A "> - [ ]" line inside a code fence is documentation, not a task. The index
    // only iterates cache.listItems, so an empty listItems ⇒ zero tasks.
    const app = await createAppWithFiles({
      't.md': '> ```md\n> - [ ] example in code block\n> ```',
    });
    setCache(app, 't.md', { listItems: [] });
    const stack = configuredTaskApplication(app, DEFAULT_SETTINGS);
    await stack.index.initialize();
    expect(stack.tasks.queries.list()).toEqual([]);
  });

  it('keeps a nested blockquote sub-task across a blockquote blank separator', async () => {
    const app = await createAppWithFiles({ 't.md': '> - [ ] Parent\n>\n> \t- [ ] Child' });
    // The bare ">" separator (line 1) is not a list item; the child at line 2 is a
    // cache-child of the parent (parent 0) and must be captured by parseSubItems.
    seedTaskCache(app, 't.md', [
      { task: ' ', parent: -1, line: 0 },
      { task: ' ', parent: 0, line: 2 },
    ]);
    const stack = configuredTaskApplication(app, DEFAULT_SETTINGS);
    await stack.index.initialize();
    const tasks = stack.tasks.queries.list();
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.subtasks).toHaveLength(1);
    expect(tasks[0]?.subtasks[0]?.title).toBe('Child');
  });

  it('emits a deeper-quote (> >) task as an independent top-level sibling', async () => {
    const app = await createAppWithFiles({ 't.md': '> - [ ] outer\n> > - [ ] inner' });
    // Obsidian records the deeper-quote task as a root sibling (negative parent).
    seedTaskCache(app, 't.md', [
      { task: ' ', parent: -1, line: 0 },
      { task: ' ', parent: -1, line: 1 },
    ]);
    const stack = configuredTaskApplication(app, DEFAULT_SETTINGS);
    await stack.index.initialize();
    const tasks = stack.tasks.queries.list();
    expect(tasks).toHaveLength(2);
    expect(tasks.find((t) => t.title === 'outer')?.subtasks).toEqual([]);
    expect(tasks.find((t) => t.title === 'inner')?.subtasks).toEqual([]);
  });

  it('does not hang on a cyclic parent chain and still emits the task', async () => {
    const app = await createAppWithFiles({ 't.md': '- a\n  - b\n    - [ ] cyclic task' });
    // Two non-task bullets referencing each other, plus a checkbox whose ancestor
    // walk enters the cycle. The visited-set guard must terminate the walk.
    setCache(
      app,
      't.md',
      cache({
        listItems: [
          { parent: 1, position: { start: { line: 0 }, end: { line: 0 } } },
          { parent: 0, position: { start: { line: 1 }, end: { line: 1 } } },
          { task: ' ', parent: 0, position: { start: { line: 2 }, end: { line: 2 } } },
        ],
      }),
    );
    const stack = configuredTaskApplication(app, DEFAULT_SETTINGS);
    await stack.index.initialize();
    const tasks = stack.tasks.queries.list();
    // No task ancestor exists (both parents are plain bullets) → emitted top-level.
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.title).toBe('cyclic task');
  });
});

describe('blockquote tasks — toggle write-path', () => {
  it('checks a "> - [ ]" task and preserves the prefix', async () => {
    const today = window.moment().format('YYYY-MM-DD');
    const app = await createAppWithFiles({ 't.md': '> - [ ] quoted' });
    seedTaskCache(app, 't.md', [{ task: ' ', parent: -1, line: 0 }]);
    const stack = configuredTaskApplication(app, DEFAULT_SETTINGS);
    await stack.index.initialize();
    const task = expectDefined(stack.tasks.queries.list()[0]);
    await stack.tasks.execute({
      type: 'toggle-completion',
      target: { type: 'task', ref: task.ref },
    });
    const content = await app.vault.cachedRead(expectDefined(app.vault.getMarkdownFiles()[0]));
    expect(content).toBe(`> - [x] quoted ✅ ${today}`);
  });

  it('unchecks a "> - [x]" task, strips ✅, and preserves the prefix', async () => {
    const app = await createAppWithFiles({ 't.md': '>> - [x] quoted ✅ 2026-06-22' });
    seedTaskCache(app, 't.md', [{ task: 'x', parent: -1, line: 0 }]);
    const stack = configuredTaskApplication(app, DEFAULT_SETTINGS);
    await stack.index.initialize();
    const task = expectDefined(stack.tasks.queries.list()[0]);
    await stack.tasks.execute({
      type: 'toggle-completion',
      target: { type: 'task', ref: task.ref },
    });
    const content = await app.vault.cachedRead(expectDefined(app.vault.getMarkdownFiles()[0]));
    expect(content).toBe('>> - [ ] quoted');
  });

  it('preserves a trailing CRLF when toggling a blockquote task', async () => {
    const today = window.moment().format('YYYY-MM-DD');
    const app = await createAppWithFiles({ 't.md': '> - [ ] quoted\r\n> - [ ] other\r\n' });
    seedTaskCache(app, 't.md', [
      { task: ' ', parent: -1, line: 0 },
      { task: ' ', parent: -1, line: 1 },
    ]);
    const stack = configuredTaskApplication(app, DEFAULT_SETTINGS);
    await stack.index.initialize();
    const task = expectDefined(stack.tasks.queries.list()[0]);
    await stack.tasks.execute({
      type: 'toggle-completion',
      target: { type: 'task', ref: task.ref },
    });
    const content = await app.vault.cachedRead(expectDefined(app.vault.getMarkdownFiles()[0]));
    expect(content).toContain(`> - [x] quoted ✅ ${today}\r\n`);
  });
});
