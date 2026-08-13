import { describe, expect, it } from 'vitest';
import { parseSubItems as parseSubItemsWithCatalog } from '../src/parser/SubItemParser';
import { StatusCatalog } from '../src/tasks/domain/StatusCatalog';
import { canonicalStatusCatalog } from './helpers';

const FILE = 'test.md';
const statusCatalog = canonicalStatusCatalog();
const parseSubItems = (lines: string[], taskLineIdx: number, filePath: string) =>
  parseSubItemsWithCatalog(lines, taskLineIdx, filePath, statusCatalog);

describe('parseSubItems', () => {
  it('returns empty result for task with no children', () => {
    const lines = ['- [ ] Task'];
    const r = parseSubItems(lines, 0, FILE);
    expect(r.subtasks).toEqual([]);
    expect(r.comments).toEqual([]);
    expect(r.description).toBe('');
    expect(r.subtaskRange).toBeUndefined();
  });

  it('parses open sub-task', () => {
    const lines = ['- [ ] Parent', '  - [ ] Child'];
    const r = parseSubItems(lines, 0, FILE);
    expect(r.subtasks).toHaveLength(1);
    expect(r.subtasks[0]).toMatchObject({ text: 'Child', status: 'open', line: 1 });
    expect(r.subtaskRange).toEqual({ from: 1, to: 1 });
  });

  it('preserves link markup in markdownText while text stays collapsed', () => {
    const lines = ['- [ ] Parent', '  - [ ] see [[Note]]'];
    const r = parseSubItems(lines, 0, FILE);
    expect(r.subtasks).toHaveLength(1);
    expect(r.subtasks[0]?.markdownText).toBe('see [[Note]]');
    expect(r.subtasks[0]?.text).toBe('see 🔗 Note');
  });

  it('parses a blockquote sub-task nested under a blockquote parent', () => {
    // Blockquote nesting: parent "> - [x]" (prefix length 2), child "> \t- [x]"
    // (prefix "> " + tab → deeper indent), matching Obsidian's cache layout.
    const lines = ['> - [x] Parent', '> \t- [x] Quoted child'];
    const r = parseSubItems(lines, 0, FILE);
    expect(r.subtasks).toHaveLength(1);
    expect(r.subtasks[0]).toMatchObject({ text: 'Quoted child', status: 'done', line: 1 });
  });

  it('does not consume a sibling blockquote task as a sub-task', () => {
    const lines = ['> - [ ] First', '> - [ ] Second'];
    const r = parseSubItems(lines, 0, FILE);
    expect(r.subtasks).toHaveLength(0);
  });

  it('parses done sub-task', () => {
    const lines = ['- [ ] Parent', '  - [x] Done child'];
    const r = parseSubItems(lines, 0, FILE);
    expect(r.subtasks[0]).toMatchObject({ status: 'done' });
  });

  it('parses description line', () => {
    const lines = ['- [ ] Parent', '  - > My description'];
    const r = parseSubItems(lines, 0, FILE);
    expect(r.description).toBe('My description');
    expect(r.subtasks).toHaveLength(0);
    expect(r.comments).toHaveLength(0);
  });

  it('concatenates multiple description lines with newline', () => {
    const lines = ['- [ ] Parent', '  - > Line one', '  - > Line two'];
    const r = parseSubItems(lines, 0, FILE);
    expect(r.description).toBe('Line one\nLine two');
  });

  it('parses dated comment', () => {
    const lines = ['- [ ] Parent', '  - 2026-06-22: Some comment'];
    const r = parseSubItems(lines, 0, FILE);
    expect(r.comments).toHaveLength(1);
    expect(r.comments[0]).toMatchObject({
      timestamp: { precision: 'day', value: '2026-06-22', raw: '2026-06-22' },
      text: 'Some comment',
      line: 1,
    });
  });

  it('parses an Atom comment with its exact source precision', () => {
    const r = parseSubItems(
      ['- [ ] Parent', '  - 2026-06-22T17:04:03.125+07:00: Precise comment'],
      0,
      FILE,
    );

    expect(r.comments[0]).toMatchObject({
      timestamp: {
        precision: 'instant',
        raw: '2026-06-22T17:04:03.125+07:00',
        atom: '2026-06-22T17:04:03.125+07:00',
        epochMs: Date.parse('2026-06-22T10:04:03.125Z'),
      },
      text: 'Precise comment',
      line: 1,
    });
  });

  it('parses undated comment', () => {
    const lines = ['- [ ] Parent', '  - Just a comment'];
    const r = parseSubItems(lines, 0, FILE);
    expect(r.comments[0]).toMatchObject({ text: 'Just a comment' });
    expect(r.comments[0]?.timestamp).toBeUndefined();
  });

  it('stops at non-indented line', () => {
    const lines = ['- [ ] Parent', '  - [ ] Child', '- [ ] Sibling'];
    const r = parseSubItems(lines, 0, FILE);
    expect(r.subtasks).toHaveLength(1);
    expect(r.subtaskRange).toEqual({ from: 1, to: 1 });
  });

  it('parses mixed children in order', () => {
    const lines = [
      '- [ ] Parent',
      '  - > Description',
      '  - [ ] Sub',
      '  - 2026-01-01: Comment',
      '  - Bare comment',
    ];
    const r = parseSubItems(lines, 0, FILE);
    expect(r.description).toBe('Description');
    expect(r.subtasks).toHaveLength(1);
    expect(r.comments).toHaveLength(2);
    expect(r.subtaskRange).toEqual({ from: 1, to: 4 });
  });

  it('parses nested sub-tasks recursively', () => {
    const lines = ['- [ ] Root', '  - [ ] Child', '    - [ ] Grandchild'];
    const r = parseSubItems(lines, 0, FILE);
    expect(r.subtasks).toHaveLength(1);
    expect(r.subtasks[0]?.subtasks).toHaveLength(1);
    expect(r.subtasks[0]?.subtasks?.[0]?.text).toBe('Grandchild');
  });

  it('sets filePath on subtasks', () => {
    const lines = ['- [ ] Parent', '  - [ ] Child'];
    const r = parseSubItems(lines, 0, FILE);
    expect(r.subtasks[0]?.filePath).toBe(FILE);
  });

  it('parses 3 levels of nesting (great-grandchild)', () => {
    const lines = [
      '- [ ] Root',
      '  - [ ] Child',
      '    - [ ] Grandchild',
      '      - [ ] GreatGrandchild',
    ];
    const r = parseSubItems(lines, 0, FILE);
    expect(r.subtasks).toHaveLength(1);
    const child = r.subtasks[0];
    expect(child?.subtasks).toHaveLength(1);
    const grand = child?.subtasks?.[0];
    expect(grand?.subtasks).toHaveLength(1);
    expect(grand?.subtasks?.[0]?.text).toBe('GreatGrandchild');
  });

  it('subtaskRange covers all descendants', () => {
    const lines = ['- [ ] Root', '  - [ ] Child', '    - [ ] Grandchild'];
    const r = parseSubItems(lines, 0, FILE);
    expect(r.subtaskRange).toEqual({ from: 1, to: 2 });
  });

  it('skips empty lines between subtasks without breaking range', () => {
    const lines = ['- [ ] Parent', '  - [ ] Child 1', '', '  - [ ] Child 2'];
    const r = parseSubItems(lines, 0, FILE);
    expect(r.subtasks).toHaveLength(2);
    expect(r.subtasks[0]?.text).toBe('Child 1');
    expect(r.subtasks[1]?.text).toBe('Child 2');
    expect(r.subtaskRange).toEqual({ from: 1, to: 3 });
  });

  it('handles tab-indented subtasks', () => {
    const lines = ['- [ ] Parent', '\t- [ ] Tab child'];
    const r = parseSubItems(lines, 0, FILE);
    expect(r.subtasks).toHaveLength(1);
    expect(r.subtasks[0]?.text).toBe('Tab child');
  });

  it('subtask can have its own description', () => {
    const lines = ['- [ ] Parent', '  - [ ] Child', '    - > Child desc'];
    const r = parseSubItems(lines, 0, FILE);
    expect(r.subtasks[0]?.description).toBe('Child desc');
  });

  it('subtask can have its own dated comment', () => {
    const lines = ['- [ ] Parent', '  - [ ] Child', '    - 2026-01-15: Child note'];
    const r = parseSubItems(lines, 0, FILE);
    expect(r.subtasks[0]?.comments).toHaveLength(1);
    expect(r.subtasks[0]?.comments?.[0]?.timestamp).toMatchObject({
      precision: 'day',
      value: '2026-01-15',
      raw: '2026-01-15',
    });
    expect(r.subtasks[0]?.comments?.[0]?.text).toBe('Child note');
  });

  it('subtask with its own children has subtaskRange set', () => {
    const lines = ['- [ ] Root', '  - [ ] Child', '    - [ ] Grandchild'];
    const r = parseSubItems(lines, 0, FILE);
    const child = r.subtasks[0];
    expect(child?.subtaskRange).toEqual({ from: 2, to: 2 });
  });

  it('sibling after nested group is parsed correctly', () => {
    const lines = ['- [ ] Root', '  - [ ] Child A', '    - [ ] Nested', '  - [ ] Child B'];
    const r = parseSubItems(lines, 0, FILE);
    expect(r.subtasks).toHaveLength(2);
    expect(r.subtasks[0]?.text).toBe('Child A');
    expect(r.subtasks[1]?.text).toBe('Child B');
    expect(r.subtasks[1]?.subtasks).toBeUndefined();
  });

  it('line property is correct for deeply nested items', () => {
    const lines = [
      '- [ ] Root', // line 0
      '  - [ ] Child', // line 1
      '    - [ ] Grand', // line 2
    ];
    const r = parseSubItems(lines, 0, FILE);
    expect(r.subtasks[0]?.line).toBe(1);
    expect(r.subtasks[0]?.subtasks?.[0]?.line).toBe(2);
  });

  // --- Edge cases (Phase 1 coverage) ---

  it('returns empty result when taskLineIdx is the last line', () => {
    const lines = ['- [ ] Parent'];
    const r = parseSubItems(lines, 0, FILE);
    expect(r.subtasks).toEqual([]);
    expect(r.comments).toEqual([]);
    expect(r.description).toBe('');
    expect(r.subtaskRange).toBeUndefined();
  });

  it('returns empty result for out-of-bounds taskLineIdx (CURRENT BEHAVIOR)', () => {
    // lines[taskLineIdx] ?? '' guards; getIndent('') === 0; loop starts at taskLineIdx+1 and exits immediately
    const lines = ['- [ ] Parent'];
    const r = parseSubItems(lines, 5, FILE);
    expect(r.subtasks).toEqual([]);
    expect(r.subtaskRange).toBeUndefined();
  });

  it('returns empty result for negative taskLineIdx', () => {
    const r = parseSubItems(['- [ ] Parent', '  - [ ] Child'], -1, FILE);
    expect(r.subtasks).toEqual([]);
    expect(r.subtaskRange).toBeUndefined();
  });

  it('returns empty result for an empty lines array', () => {
    const r = parseSubItems([], 0, FILE);
    expect(r.subtasks).toEqual([]);
    expect(r.subtaskRange).toBeUndefined();
  });

  it('parses a cancelled subtask checkbox as a subtask (registry-driven, FU-1)', () => {
    // SUBTASK_RE now matches any char inside [ ]; '-' resolves to 'cancelled'.
    const r = parseSubItems(['- [ ] Parent', '  - [-] Cancelled child'], 0, FILE);
    expect(r.subtasks).toHaveLength(1);
    expect(r.subtasks[0]?.status).toBe('cancelled');
    expect(r.subtasks[0]?.statusSymbol).toBe('-');
    expect(r.subtasks[0]?.text).toBe('Cancelled child');
    expect(r.comments).toHaveLength(0);
  });

  it('parses an in-progress subtask checkbox as a subtask (registry-driven, FU-1)', () => {
    const r = parseSubItems(['- [ ] Parent', '  - [/] In-progress child'], 0, FILE);
    expect(r.subtasks).toHaveLength(1);
    expect(r.subtasks[0]?.status).toBe('in-progress');
    expect(r.subtasks[0]?.statusSymbol).toBe('/');
    expect(r.subtasks[0]?.text).toBe('In-progress child');
    expect(r.comments).toHaveLength(0);
  });

  it('uses the supplied catalog for configured child checkbox semantics', () => {
    const configuredCatalog = new StatusCatalog([
      { id: 'custom-done', symbol: '!', type: 'done', defaultForType: true },
    ]);
    const r = parseSubItemsWithCatalog(
      ['- [ ] Parent', '  - [!] Configured child'],
      0,
      FILE,
      configuredCatalog,
    );
    expect(r.subtasks[0]?.status).toBe('done');
  });

  it('strips metadata emojis from subtask text and exposes them as fields', () => {
    const r = parseSubItems(['- [ ] Parent', '  - [ ] Child 📅 2026-01-01'], 0, FILE);
    expect(r.subtasks[0]?.text).toBe('Child');
    expect(r.subtasks[0]?.due).toBe('2026-01-01');
  });

  it('keeps duration metadata visible because SubTask has no duration field', () => {
    const r = parseSubItems(['- [ ] Parent', '  - [ ] Child ⏱️ 1h'], 0, FILE);
    expect(r.subtasks[0]?.markdownText).toBe('Child ⏱️ 1h');
    expect(r.subtasks[0]?.text).toBe('Child ⏱️ 1h');
  });

  it('derives child status from its checkbox instead of a cancelled-date marker', () => {
    const r = parseSubItems(['- [ ] Parent', '  - [ ] Child ❌ 2026-07-13'], 0, FILE);
    expect(r.subtasks[0]?.status).toBe('open');
    expect(r.subtasks[0]?.text).toBe('Child');
  });

  it('handles mixed tab and space indentation across parent and child', () => {
    // parent 2 spaces (indent 2), child 1 tab (normalized to 4) → child indent 4 > parent 2
    const r = parseSubItems(['  - [ ] Parent', '\t- [ ] Child'], 0, FILE);
    expect(r.subtasks).toHaveLength(1);
    expect(r.subtasks[0]?.text).toBe('Child');
  });

  it('keeps a structurally-shaped but impossible date as complete undated text', () => {
    const r = parseSubItems(['- [ ] Parent', '  - 2026-13-99: bad'], 0, FILE);
    expect(r.comments).toHaveLength(1);
    expect(r.comments[0]?.timestamp).toBeUndefined();
    expect(r.comments[0]?.text).toBe('2026-13-99: bad');
  });

  it('a single-digit-day date does not match COMMENT_DATE_RE and falls back to a plain comment', () => {
    // 2026-13-9 lacks the \d{2} day shape, so it is not a dated comment
    const r = parseSubItems(['- [ ] Parent', '  - 2026-13-9: bad'], 0, FILE);
    expect(r.comments).toHaveLength(1);
    expect(r.comments[0]?.timestamp).toBeUndefined();
    expect(r.comments[0]?.text).toBe('2026-13-9: bad');
  });

  it('a dropped unrecognized indented line is excluded from groups but stays in range (CURRENT BEHAVIOR, follow-up FU-6)', () => {
    const r = parseSubItems(['- [ ] Parent', '    plain text'], 0, FILE);
    expect(r.subtasks).toEqual([]);
    expect(r.comments).toEqual([]);
    // rangeTo = i is set before pattern matching, so the dropped line is in the range
    expect(r.subtaskRange).toEqual({ from: 1, to: 1 });
  });

  it('subtaskRange.to covers the last nested descendant before a sibling', () => {
    const lines = [
      '- [ ] Root', // 0
      '  - [ ] Child A', // 1
      '    - [ ] Nested', // 2
      '  - [ ] Child B', // 3
    ];
    const r = parseSubItems(lines, 0, FILE);
    expect(r.subtaskRange).toEqual({ from: 1, to: 3 });
    expect(r.subtasks[0]?.subtaskRange).toEqual({ from: 2, to: 2 });
    // sibling starts at rangeTo + 1
    expect(r.subtasks[1]?.line).toBe(3);
  });

  it('empty lines between subtasks do not corrupt line numbers', () => {
    const lines = [
      '- [ ] Parent', // 0
      '  - [ ] Child 1', // 1
      '', // 2 (skipped, not in range)
      '  - [ ] Child 2', // 3
    ];
    const r = parseSubItems(lines, 0, FILE);
    expect(r.subtasks[0]?.line).toBe(1);
    expect(r.subtasks[1]?.line).toBe(3);
    expect(r.subtaskRange).toEqual({ from: 1, to: 3 });
  });

  describe('subtask metadata', () => {
    it('preserves rawText on subtask', () => {
      const lines = ['- [ ] Parent', '  - [ ] Fix bug 📅 2026-07-01'];
      const r = parseSubItems(lines, 0, FILE);
      expect(r.subtasks[0]?.rawText).toBe('  - [ ] Fix bug 📅 2026-07-01');
    });

    it('parses due date from subtask', () => {
      const lines = ['- [ ] Parent', '  - [ ] Fix bug 📅 2026-07-01'];
      const r = parseSubItems(lines, 0, FILE);
      expect(r.subtasks[0]).toMatchObject({ due: '2026-07-01' });
    });

    it('parses scheduled date from subtask', () => {
      const lines = ['- [ ] Parent', '  - [ ] Plan ⏳ 2026-07-05'];
      const r = parseSubItems(lines, 0, FILE);
      expect(r.subtasks[0]).toMatchObject({ scheduled: '2026-07-05' });
    });

    it('parses time from subtask', () => {
      const lines = ['- [ ] Parent', '  - [ ] Meeting ⏰ 14:30'];
      const r = parseSubItems(lines, 0, FILE);
      expect(r.subtasks[0]).toMatchObject({ time: '14:30' });
    });

    it('parses priority A (🔺) from subtask', () => {
      const lines = ['- [ ] Parent', '  - [ ] Urgent 🔺'];
      const r = parseSubItems(lines, 0, FILE);
      expect(r.subtasks[0]).toMatchObject({ priority: 'A' });
    });

    it('parses priority B (⏫) from subtask', () => {
      const lines = ['- [ ] Parent', '  - [ ] Important ⏫'];
      const r = parseSubItems(lines, 0, FILE);
      expect(r.subtasks[0]).toMatchObject({ priority: 'B' });
    });

    it('defaults priority to D when no priority emoji', () => {
      const lines = ['- [ ] Parent', '  - [ ] Normal task'];
      const r = parseSubItems(lines, 0, FILE);
      expect(r.subtasks[0]).toMatchObject({ priority: 'D' });
    });

    it('parses recurrence from subtask', () => {
      const lines = ['- [ ] Parent', '  - [ ] Daily standup 🔁 every day'];
      const r = parseSubItems(lines, 0, FILE);
      expect(r.subtasks[0]).toMatchObject({ recurrence: 'every day' });
    });

    it('projects lifecycle and completion policy through the legacy subtask adapter', () => {
      const lines = [
        '- [ ] Parent',
        '  - [x] Child 🔁 every day 🏁 DELETE ➕ 2026-08-01 ✅ 2026-08-02 ❌ 2026-08-03',
      ];
      const result = parseSubItems(lines, 0, FILE);

      expect(result.subtasks[0]).toMatchObject({
        recurrence: 'every day',
        onCompletion: 'delete',
        onCompletionExplicit: true,
        created: '2026-08-01',
        completion: '2026-08-02',
        cancelledDate: '2026-08-03',
        markdownText: 'Child',
      });
    });

    it('strips metadata emoji from subtask text', () => {
      const lines = ['- [ ] Parent', '  - [ ] Fix bug 📅 2026-07-01 #work'];
      const r = parseSubItems(lines, 0, FILE);
      expect(r.subtasks[0]?.text).toBe('Fix bug');
    });

    it('retains tags in rawText but strips from text', () => {
      const lines = ['- [ ] Parent', '  - [ ] Write tests #dev'];
      const r = parseSubItems(lines, 0, FILE);
      expect(r.subtasks[0]?.rawText).toContain('#dev');
      expect(r.subtasks[0]?.text).toBe('Write tests');
    });

    it('parses all metadata simultaneously', () => {
      const lines = ['- [ ] Parent', '  - [ ] Sprint task 🔺 ⏰ 09:00 📅 2026-07-01 #work'];
      const r = parseSubItems(lines, 0, FILE);
      expect(r.subtasks[0]).toMatchObject({
        priority: 'A',
        time: '09:00',
        due: '2026-07-01',
        text: 'Sprint task',
      });
    });
  });
});
