import { describe, expect, it } from 'vitest';
import type { TaskRef } from '../../src/tasks/domain/types';
import { localTime } from '../../src/tasks/domain/validation';
import { applyTaskCommand } from '../../src/tasks/infrastructure/markdown/applyTaskCommand';
import {
  TaskMarkdownCodec,
  type ParsedTaskLine,
  type TaskSpanKind,
} from '../../src/tasks/infrastructure/markdown/TaskMarkdownCodec';
import { canonicalStatusCatalog } from '../helpers';

const codec = new TaskMarkdownCodec(canonicalStatusCatalog());
const location = { filePath: 'Projects/Test.md', line: 4 };
const ref: TaskRef = { ...location, revision: 'test-revision' };

function parse(source: string): ParsedTaskLine {
  const parsed = codec.parseLine(source, location);
  expect(parsed).not.toBeNull();
  return parsed!;
}

function spanText(parsed: ParsedTaskLine, kind: TaskSpanKind | 'malformed-known'): string[] {
  return parsed.spans
    .filter((span) => span.kind === kind)
    .map((span) => parsed.original.slice(span.from, span.to));
}

function expectLosslessPartition(parsed: ParsedTaskLine): void {
  expect(parsed.spans[0]?.from).toBe(0);
  for (let i = 1; i < parsed.spans.length; i++) {
    expect(parsed.spans[i]?.from).toBe(parsed.spans[i - 1]?.to);
  }
  expect(parsed.spans[parsed.spans.length - 1]?.to).toBe(parsed.original.length);
  expect(parsed.spans.map((span) => parsed.original.slice(span.from, span.to)).join('')).toBe(
    parsed.original,
  );
}

describe('TaskMarkdownCodec', () => {
  describe('atomic schedule commands', () => {
    it('shifts both boundaries of a three-day span backward by two days', () => {
      const source = '- [/] Span #keep 🛫 2026-03-01 📅 2026-03-03 ⏰ 09:30 ⏱️ 45m';

      expect(applyTaskCommand(codec, source, { type: 'shift-schedule', ref, days: -2 })).toEqual({
        type: 'changed',
        content: '- [/] Span #keep 🛫 2026-02-27 📅 2026-03-01 ⏰ 09:30 ⏱️ 45m',
      });
    });

    it('moves both span boundaries and its time in one lossless edit', () => {
      const source =
        '- [x] [[Exact title]] #alpha/sub 🔺 🛫 2026-07-18 ⏳ 2026-07-01 📅 2026-07-20 ⏰ 09:30 ⏱️ 1h45m 🆔 keep-id ^keep-block';

      expect(
        applyTaskCommand(codec, source, {
          type: 'move-time-slot',
          ref,
          days: 2,
          time: localTime('13:15'),
        }),
      ).toEqual({
        type: 'changed',
        content:
          '- [x] [[Exact title]] #alpha/sub 🔺 🛫 2026-07-20 ⏳ 2026-07-01 📅 2026-07-22 ⏰ 13:15 ⏱️ 1h45m 🆔 keep-id ^keep-block',
      });
    });

    it('changes time on the same day and treats an identical target as a no-op', () => {
      const source = '- [ ] Timed 📅 2026-07-20 ⏰ 09:30 ⏱️ 45m';

      expect(
        applyTaskCommand(codec, source, {
          type: 'move-time-slot',
          ref,
          days: 0,
          time: localTime('10:15'),
        }),
      ).toEqual({
        type: 'changed',
        content: '- [ ] Timed 📅 2026-07-20 ⏰ 10:15 ⏱️ 45m',
      });
      expect(
        applyTaskCommand(codec, source, {
          type: 'move-time-slot',
          ref,
          days: 0,
          time: localTime('09:30'),
        }),
      ).toEqual({ type: 'unchanged', content: source });
    });

    it('moves a timed span to all-day without changing unrelated bytes', () => {
      const source =
        '- [/] [[Exact title]] #alpha/sub 🔺 🛫 2026-07-18 ⏳ 2026-07-01 📅 2026-07-20 ⏰ 09:30 ⏱️ 1h45m 🆔 keep-id ^keep-block';

      expect(applyTaskCommand(codec, source, { type: 'move-to-all-day', ref, days: -2 })).toEqual({
        type: 'changed',
        content:
          '- [/] [[Exact title]] #alpha/sub 🔺 🛫 2026-07-16 ⏳ 2026-07-01 📅 2026-07-18 🆔 keep-id ^keep-block',
      });
    });

    it('moves a non-span anchor to all-day and clears its timed fields', () => {
      const source = '- [ ] Planned ⏳ 2026-07-20 📅 2026-07-30 ⏰ 09:30 ⏱️ 45m';

      expect(applyTaskCommand(codec, source, { type: 'move-to-all-day', ref, days: 3 })).toEqual({
        type: 'changed',
        content: '- [ ] Planned ⏳ 2026-07-23 📅 2026-07-30',
      });
    });

    it('does no write for an already all-day schedule with zero delta', () => {
      const source = '- [ ] All day 🛫 2026-07-18 📅 2026-07-20';

      expect(applyTaskCommand(codec, source, { type: 'move-to-all-day', ref, days: 0 })).toEqual({
        type: 'unchanged',
        content: source,
      });
    });

    it('converts a timed task to all-day on the same day', () => {
      const source = '- [ ] Timed 📅 2026-07-20 ⏰ 09:30 ⏱️ 45m';

      expect(applyTaskCommand(codec, source, { type: 'move-to-all-day', ref, days: 0 })).toEqual({
        type: 'changed',
        content: '- [ ] Timed 📅 2026-07-20',
      });
    });
  });

  it('inserts a title before metadata when the source has no editable title fragment', () => {
    expect(
      codec.applyLineEdit('- [ ] 📅 2026-07-20', {
        type: 'set-title',
        markdownTitle: 'New title',
      }),
    ).toEqual({ type: 'changed', content: '- [ ] New title 📅 2026-07-20' });
  });

  it.each([-1, 0.5])('rejects invalid text-link occurrence %s', (occurrence) => {
    expect(codec.editTextLink('before [[Link]] after', occurrence, '[[Changed]]')).toEqual({
      type: 'invalid',
      issues: [{ code: 'invalid-target', field: 'link' }],
    });
  });

  it('rejects a missing text-link occurrence', () => {
    expect(codec.editTextLink('plain text', 0, '[[Changed]]')).toEqual({
      type: 'invalid',
      issues: [{ code: 'invalid-target', field: 'link' }],
    });
  });

  describe('full-line validation used by task creation', () => {
    it.each([
      ['ordinary metadata', '- [ ] Gym ⏰ 10:00 ⏱️ 1h 📅 2026-07-11'],
      ['plain task', '- [ ] Buy milk'],
      ['boundary time', '- [ ] t ⏰ 23:59 📅 2026-07-11'],
      ['valid start/due span', '- [ ] t 🛫 2026-07-01 📅 2026-07-05'],
      ['same-day start/due span', '- [ ] t 🛫 2026-07-15 📅 2026-07-15'],
    ])('accepts a well-formed %s line', (_case, source) => {
      expect(codec.validateLine(source)).toEqual([]);
    });

    it.each([
      ['out-of-grammar hour', '- [ ] t ⏰ 2093:15 📅 2026-07-11'],
      ['out-of-range hour', '- [ ] t ⏰ 25:00 📅 2026-07-11'],
      ['out-of-range minute', '- [ ] t ⏰ 10:75 📅 2026-07-11'],
      ['zero duration', '- [ ] t ⏱️ 0m 📅 2026-07-11'],
      ['impossible day', '- [ ] t 📅 2026-07-32'],
      ['impossible month', '- [ ] t 📅 2026-13-01'],
      ['non-task syntax', 'not a task line'],
      ['impossible start date', '- [ ] t 🛫 2026-02-30 📅 2026-07-05'],
      ['inverted start/due span', '- [ ] t 🛫 2026-07-16 📅 2026-07-15'],
    ])('rejects a malformed %s line without authorizing a write', (_case, source) => {
      expect(codec.validateLine(source)).not.toEqual([]);
    });
  });

  describe('lossless line edits', () => {
    it.each([
      ['set-title', { type: 'set-title', markdownTitle: 'Changed\n- [ ] injected' }, 'title'],
      ['append-title', { type: 'append-title', markdown: 'later\rinjected' }, 'title'],
      [
        'title edit-link',
        { type: 'edit-link', occurrence: 0, replacement: '[[Changed]]\n- [ ] injected' },
        'link',
      ],
    ] as const)(
      'rejects multiline input through %s without changing the task line',
      (_type, edit, field) => {
        expect(codec.applyLineEdit('- [ ] Task [[Link]]', edit)).toEqual({
          type: 'invalid',
          issues: [{ code: 'invalid-target', field }],
        });
      },
    );

    it.each(['[[Changed]]\n- [ ] injected', '[[Changed]]\rinjected'])(
      'rejects multiline text-link replacement %j without changing the source',
      (replacement) => {
        expect(codec.editTextLink('before [[Link]] after', 0, replacement)).toEqual({
          type: 'invalid',
          issues: [{ code: 'invalid-target', field: 'link' }],
        });
      },
    );

    it('edits only top-level non-overlapping link occurrences', () => {
      const source = String.raw`before [x]([[Doc]]) then [[Alias|\[y\](u)]] after`;

      expect(codec.editTextLink(source, 0, '[changed](target)')).toEqual({
        type: 'changed',
        content: String.raw`before [changed](target) then [[Alias|\[y\](u)]] after`,
      });
      expect(codec.editTextLink(source, 1, '[[Changed]]')).toEqual({
        type: 'changed',
        content: 'before [x]([[Doc]]) then [[Changed]] after',
      });
      expect(codec.editTextLink(source, 2, '[[Invalid]]')).toEqual({
        type: 'invalid',
        issues: [{ code: 'invalid-target', field: 'link' }],
      });
    });

    it.each([
      ['set-title', { type: 'set-title', markdownTitle: 'Changed 📅 nope' }, 'due', 'invalid-date'],
      ['append-title', { type: 'append-title', markdown: '📅 nope' }, 'due', 'invalid-date'],
      [
        'set-title',
        { type: 'set-title', markdownTitle: 'Changed ⏰ 2093:15' },
        'time',
        'invalid-time',
      ],
      ['append-title', { type: 'append-title', markdown: '⏰ 2093:15' }, 'time', 'invalid-time'],
      [
        'set-title',
        { type: 'set-title', markdownTitle: 'Changed ⏱️ nope' },
        'duration',
        'invalid-duration',
      ],
      [
        'append-title',
        { type: 'append-title', markdown: '⏱️ nope' },
        'duration',
        'invalid-duration',
      ],
    ] as const)('rejects invalid metadata introduced through %s', (_type, edit, field, code) => {
      expect(codec.applyLineEdit('- [ ] Task', edit)).toEqual({
        type: 'invalid',
        issues: [{ code, field }],
      });
    });

    it.each([
      [
        'set-title',
        '- [ ] Task 📅 2026-07-20',
        { type: 'set-title', markdownTitle: 'Changed 📅 2026-07-21' },
        'due',
      ],
      [
        'append-title',
        '- [ ] Task 📅 2026-07-20',
        { type: 'append-title', markdown: '📅 2026-07-21' },
        'due',
      ],
      [
        'set-title',
        '- [ ] Task ⏰ 08:00',
        { type: 'set-title', markdownTitle: 'Changed ⏰ 09:00' },
        'time',
      ],
      [
        'append-title',
        '- [ ] Task ⏰ 08:00',
        { type: 'append-title', markdown: '⏰ 09:00' },
        'time',
      ],
      [
        'set-title',
        '- [ ] Task ⏱️ 30m',
        { type: 'set-title', markdownTitle: 'Changed ⏱️ 45m' },
        'duration',
      ],
      [
        'append-title',
        '- [ ] Task ⏱️ 30m',
        { type: 'append-title', markdown: '⏱️ 45m' },
        'duration',
      ],
    ] as const)(
      'rejects duplicate metadata introduced through %s',
      (_type, source, edit, field) => {
        expect(codec.applyLineEdit(source, edit)).toEqual({
          type: 'invalid',
          issues: [{ code: 'duplicate-field', field }],
        });
      },
    );

    it.each([
      ['set-title', { type: 'set-title', markdownTitle: 'Changed 📅 2026-07-21' }],
      ['append-title', { type: 'append-title', markdown: '📅 2026-07-21' }],
      ['set-title', { type: 'set-title', markdownTitle: 'Changed #added' }],
      ['append-title', { type: 'append-title', markdown: '#added' }],
      ['set-title', { type: 'set-title', markdownTitle: 'Changed 🆔 introduced' }],
      ['append-title', { type: 'append-title', markdown: '🆔 introduced' }],
      ['set-title', { type: 'set-title', markdownTitle: 'Changed 🆔 bad.id' }],
      ['append-title', { type: 'append-title', markdown: '🆔 bad.id' }],
      ['set-title', { type: 'set-title', markdownTitle: 'Changed ⛔ introduced' }],
      ['append-title', { type: 'append-title', markdown: '⛔ introduced' }],
      ['set-title', { type: 'set-title', markdownTitle: 'Changed ⛔ one,,two' }],
      ['append-title', { type: 'append-title', markdown: '⛔ one,,two' }],
      ['set-title', { type: 'set-title', markdownTitle: 'Changed ^introduced' }],
      ['append-title', { type: 'append-title', markdown: '^introduced' }],
    ] as const)('rejects semantic spans introduced through %s', (_type, edit) => {
      expect(codec.applyLineEdit('- [ ] Task', edit)).toEqual({
        type: 'invalid',
        issues: [{ code: 'invalid-target', field: 'title' }],
      });
    });

    it('preserves unrelated malformed and opaque source spans when setting time', () => {
      const source = '- [?] Old [[Title]] #work 🆔 keep-me ⛔ a,b 📅 2026-02-30 ⏱️ nope ^block';

      expect(codec.applyLineEdit(source, { type: 'set-time', value: '09:30' })).toEqual({
        type: 'changed',
        content:
          '- [?] Old [[Title]] #work 🆔 keep-me ⛔ a,b 📅 2026-02-30 ⏱️ nope ⏰ 09:30 ^block',
      });
    });

    it('rejects an ambiguous targeted single-valued field without changing source', () => {
      const source = '- [ ] Duplicate 📅 2026-07-20 📅 2026-07-21';

      expect(
        codec.applyLineEdit(source, {
          type: 'set-date',
          field: 'due',
          value: '2026-07-20',
        }),
      ).toEqual({
        type: 'invalid',
        issues: [{ code: 'duplicate-field', field: 'due' }],
      });
    });

    it('preserves an unrelated duplicate while replacing only the targeted span', () => {
      const source = '- [ ] Task 📅 2026-07-20 📅 2026-07-21 ⏰ 08:00';

      expect(codec.applyLineEdit(source, { type: 'set-time', value: '09:30' })).toEqual({
        type: 'changed',
        content: '- [ ] Task 📅 2026-07-20 📅 2026-07-21 ⏰ 09:30',
      });
    });

    it('validates a changed field but ignores malformed unrelated fields', () => {
      const source = '- [ ] Task 📅 2026-02-30';

      expect(codec.applyLineEdit(source, { type: 'set-time', value: '25:00' })).toEqual({
        type: 'invalid',
        issues: [{ code: 'invalid-time', field: 'time' }],
      });
      expect(codec.applyLineEdit(source, { type: 'set-time', value: '09:30' })).toEqual({
        type: 'changed',
        content: '- [ ] Task 📅 2026-02-30 ⏰ 09:30',
      });
    });

    it('checks start/due ordering only when a span boundary changes', () => {
      const source = '- [ ] Old #work 🛫 2026-07-21 📅 2026-07-20';

      expect(codec.applyLineEdit(source, { type: 'set-title', markdownTitle: 'New' })).toEqual({
        type: 'changed',
        content: '- [ ] New #work 🛫 2026-07-21 📅 2026-07-20',
      });
      expect(
        codec.applyLineEdit(source, {
          type: 'set-date',
          field: 'due',
          value: '2026-07-19',
        }),
      ).toEqual({
        type: 'invalid',
        issues: [{ code: 'inverted-span', field: 'start,due' }],
      });
    });

    it('replaces title source while preserving tags, IDs, dependencies, metadata, and block ID', () => {
      const source =
        '- [ ] Old [[Title|alias]] #work 🆔 keep-me ⛔ a,b ⏰ 08:00 📅 2026-07-20 ^block';

      expect(
        codec.applyLineEdit(source, {
          type: 'set-title',
          markdownTitle: 'New [title](https://example.test)',
        }),
      ).toEqual({
        type: 'changed',
        content:
          '- [ ] New [title](https://example.test) #work 🆔 keep-me ⛔ a,b ⏰ 08:00 📅 2026-07-20 ^block',
      });
    });

    it('replaces only the selected title link occurrence without reconstructing the line', () => {
      const source =
        '> - [ ] [[Doc#Heading|same]]#tag [[Doc^block|same]] 🧭 opaque 🆔 keep-id ⛔ dep [[After|same]] ^block\r\n';

      expect(
        codec.applyLineEdit(source, {
          type: 'edit-link',
          occurrence: 1,
          replacement: '[[Changed^anchor|updated]]',
        }),
      ).toEqual({
        type: 'changed',
        content:
          '> - [ ] [[Doc#Heading|same]]#tag [[Changed^anchor|updated]] 🧭 opaque 🆔 keep-id ⛔ dep [[After|same]] ^block\r\n',
      });

      expect(
        codec.applyLineEdit(source, {
          type: 'edit-link',
          occurrence: 2,
          replacement: '[[AfterChanged]]',
        }),
      ).toEqual({
        type: 'changed',
        content:
          '> - [ ] [[Doc#Heading|same]]#tag [[Doc^block|same]] 🧭 opaque 🆔 keep-id ⛔ dep [[AfterChanged]] ^block\r\n',
      });
    });

    it.each([
      ['- [ ] [[Calendar 📅 2026-07-20|date]] 📅 2026-08-01', '- [ ] [[Changed]] 📅 2026-08-01'],
      ['- [ ] [[Doc|time ⏰ 09:00]] ⏰ 10:00', '- [ ] [[Changed]] ⏰ 10:00'],
      ['- [ ] [[Doc|ID 🆔 keep]] 🆔 real-id', '- [ ] [[Changed]] 🆔 real-id'],
    ])(
      'treats metadata-looking text inside a title link as atomic while preserving real metadata',
      (source, expected) => {
        expect(
          codec.applyLineEdit(source, {
            type: 'edit-link',
            occurrence: 0,
            replacement: '[[Changed]]',
          }),
        ).toEqual({ type: 'changed', content: expected });
      },
    );

    it('rejects an absent title-link occurrence and keeps embeds and escaped lookalikes uncounted', () => {
      const source = '- [ ] ![[embed.png]] \\[[escaped]] [[Real]]';

      expect(
        codec.applyLineEdit(source, {
          type: 'edit-link',
          occurrence: 0,
          replacement: '[[Changed]]',
        }),
      ).toEqual({ type: 'changed', content: '- [ ] ![[embed.png]] \\[[escaped]] [[Changed]]' });
      expect(
        codec.applyLineEdit(source, {
          type: 'edit-link',
          occurrence: 1,
          replacement: '[[Changed]]',
        }),
      ).toEqual({
        type: 'invalid',
        issues: [{ code: 'invalid-target', field: 'link' }],
      });
    });

    it('sets the title fragment after a repository-leading tag without retaining the old title', () => {
      const source = '- [ ] #task/one-off Buy milk 📅 2026-06-24';
      const result = codec.applyLineEdit(source, { type: 'set-title', markdownTitle: 'New' });

      expect(result).toEqual({
        type: 'changed',
        content: '- [ ] #task/one-off New 📅 2026-06-24',
      });
      expect(parse((result as Extract<typeof result, { type: 'changed' }>).content)).toMatchObject({
        markdownTitle: 'New',
        tags: ['#task/one-off'],
        planning: { due: '2026-06-24' },
      });
    });

    it('appends after the last title fragment following a repository-leading tag', () => {
      const source = '- [ ] #task/one-off Buy milk 📅 2026-06-24';
      const result = codec.applyLineEdit(source, { type: 'append-title', markdown: 'later' });

      expect(result).toEqual({
        type: 'changed',
        content: '- [ ] #task/one-off Buy milk later 📅 2026-06-24',
      });
      expect(parse((result as Extract<typeof result, { type: 'changed' }>).content)).toMatchObject({
        markdownTitle: 'Buy milk later',
        tags: ['#task/one-off'],
        planning: { due: '2026-06-24' },
      });
    });

    it('sets an interleaved-tag title by replacing the first fragment and removing later fragments', () => {
      const source = '- [ ] Buy #shop milk 📅 2026-06-24';
      const result = codec.applyLineEdit(source, { type: 'set-title', markdownTitle: 'New' });

      expect(result).toEqual({
        type: 'changed',
        content: '- [ ] New #shop 📅 2026-06-24',
      });
      expect(parse((result as Extract<typeof result, { type: 'changed' }>).content)).toMatchObject({
        markdownTitle: 'New',
        tags: ['#shop'],
        planning: { due: '2026-06-24' },
      });
    });

    it('appends after the last interleaved-tag title fragment', () => {
      const source = '- [ ] Buy #shop milk 📅 2026-06-24';
      const result = codec.applyLineEdit(source, { type: 'append-title', markdown: 'later' });

      expect(result).toEqual({
        type: 'changed',
        content: '- [ ] Buy #shop milk later 📅 2026-06-24',
      });
      expect(parse((result as Extract<typeof result, { type: 'changed' }>).content)).toMatchObject({
        markdownTitle: 'Buy milk later',
        tags: ['#shop'],
        planning: { due: '2026-06-24' },
      });
    });

    it.each([
      '- [ ] 🧭 leading Old',
      '- [ ] Old 🧪 middle End',
      '- [ ] Old trailing 🛰️',
      '- [ ] 🧭 leading Old 🧪 middle End 🛰️',
      '- [ ] 🔥 urgent',
    ])('treats arbitrary emoji syntax as replaceable title content in %j', (source) => {
      expect(codec.applyLineEdit(source, { type: 'set-title', markdownTitle: 'New' })).toEqual({
        type: 'changed',
        content: '- [ ] New',
      });
    });

    it('inserts the supplied full title exactly once across reorder and deletion', () => {
      const source = '- [ ] Old 🧭 same Middle 🧭 same End 🧪 other';

      expect(
        codec.applyLineEdit(source, {
          type: 'set-title',
          markdownTitle: '🧪 other New 🧭 same',
        }),
      ).toEqual({ type: 'changed', content: '- [ ] 🧪 other New 🧭 same' });
      expect(codec.applyLineEdit(source, { type: 'set-title', markdownTitle: 'New' })).toEqual({
        type: 'changed',
        content: '- [ ] New',
      });
    });

    it('accepts the UI-shaped snapshot title plus an edit exactly once', () => {
      const source =
        '- [ ] Old 🧭 future #work 📅 nope 🆔 bad.id ⛔ one,,two 📅 2026-07-20 🆔 keep ⛔ dep ^block';
      const snapshotTitle = parse(source).markdownTitle;

      expect(snapshotTitle).toBe('Old 🧭 future');
      expect(
        codec.applyLineEdit(source, {
          type: 'set-title',
          markdownTitle: `${snapshotTitle} TEMP`,
        }),
      ).toEqual({
        type: 'changed',
        content:
          '- [ ] Old 🧭 future TEMP #work 📅 nope 🆔 bad.id ⛔ one,,two 📅 2026-07-20 🆔 keep ⛔ dep ^block',
      });
    });

    it('treats links, aliases, and inline code containing marker text as title content', () => {
      const source =
        '- [ ] Old [[Doc|📅 nope]] [⏰ 9:5](https://example.test) `⏱️ nope 🆔 bad.id ^bad/value` 📅 2026-07-20 ^block';
      const parsed = parse(source);

      expect(parsed.markdownTitle).toBe(
        'Old [[Doc|📅 nope]] [⏰ 9:5](https://example.test) `⏱️ nope 🆔 bad.id ^bad/value`',
      );
      expect(spanText(parsed, 'malformed-known')).toEqual([]);
      expect(codec.applyLineEdit(source, { type: 'set-title', markdownTitle: 'New' })).toEqual({
        type: 'changed',
        content: '- [ ] New 📅 2026-07-20 ^block',
      });
    });

    it.each([
      ['inline code', '- [ ] Old `x ^bad`', 'Old `x ^bad`', '- [ ] New'],
      ['wiki alias', '- [ ] Old [[Doc|x ^bad]]', 'Old [[Doc|x ^bad]]', '- [ ] New'],
      [
        'Markdown link',
        '- [ ] Old [x ^bad](https://example.test)',
        'Old [x ^bad](https://example.test)',
        '- [ ] New',
      ],
      ['valid-looking caret in code', '- [ ] `x ^valid`\r\n', '`x ^valid`', '- [ ] New\r\n'],
      [
        'malformed caret in a leading alias',
        '- [ ] [[Doc|x ^bad/value]]\r\n',
        '[[Doc|x ^bad/value]]',
        '- [ ] New\r\n',
      ],
    ])(
      'keeps a terminal %s atom whole in the snapshot and semantic replacement',
      (_case, source, markdownTitle, changed) => {
        const parsed = parse(source);

        expect(parsed.markdownTitle).toBe(markdownTitle);
        expect(spanText(parsed, 'malformed-known')).toEqual([]);
        expectLosslessPartition(parsed);
        expect(codec.applyLineEdit(source, { type: 'set-title', markdownTitle: 'New' })).toEqual({
          type: 'changed',
          content: changed,
        });
      },
    );

    it.each([
      ['wiki link', '^bad[[Doc]]'],
      ['Markdown link', '^bad[x](u)'],
      ['inline code', '^bad`code`'],
      ['wiki link containing spaces', '^bad[[Doc|x y]]'],
      ['Markdown link containing spaces', '^bad[x y](u)'],
      ['inline code containing spaces', '^bad`x y`'],
      ['overlapping outer link containing spaces', '^bad[x y]([[Doc]])'],
      ['nested carrier before a Markdown link', '^📅[x](u)'],
    ])(
      'protects a complete malformed terminal caret token that ends with %s',
      (_case, terminal) => {
        const source = `- [ ] Old ${terminal}\r\n`;
        const parsed = parse(source);

        expect(parsed.markdownTitle).toBe('Old');
        expect(spanText(parsed, 'malformed-known')).toEqual([terminal]);
        expectLosslessPartition(parsed);

        const changed = codec.applyLineEdit(source, {
          type: 'set-title',
          markdownTitle: 'New',
        });
        expect(changed).toEqual({ type: 'changed', content: `- [ ] New ${terminal}\r\n` });
        expect(
          codec.applyLineEdit((changed as Extract<typeof changed, { type: 'changed' }>).content, {
            type: 'set-title',
            markdownTitle: 'New',
          }),
        ).toEqual({ type: 'unchanged', content: `- [ ] New ${terminal}\r\n` });
      },
    );

    it('protects a leading terminal caret token through a byte-exact title replacement', () => {
      const source = '- [ ] ^bad[x y](u)  \r\n';
      const parsed = parse(source);

      expect(parsed.markdownTitle).toBe('');
      expect(spanText(parsed, 'malformed-known')).toEqual(['^bad[x y](u)']);
      expectLosslessPartition(parsed);
      expect(codec.applyLineEdit(source, { type: 'set-title', markdownTitle: 'New' })).toEqual({
        type: 'changed',
        content: '- [ ] New ^bad[x y](u)  \r\n',
      });
    });

    it('keeps valid terminal blocks protected and ordinary nonterminal carets editable', () => {
      const valid = parse('- [ ] Old ^valid\r\n');
      expect(spanText(valid, 'block-id')).toEqual(['^valid']);
      expect(valid.markdownTitle).toBe('Old');
      expect(
        codec.applyLineEdit(valid.original, { type: 'set-title', markdownTitle: 'New' }),
      ).toEqual({ type: 'changed', content: '- [ ] New ^valid\r\n' });

      const ordinary = parse('- [ ] Old ^middle text\r\n');
      expect(spanText(ordinary, 'block-id')).toEqual([]);
      expect(spanText(ordinary, 'malformed-known')).toEqual([]);
      expect(ordinary.markdownTitle).toBe('Old ^middle text');
      expect(
        codec.applyLineEdit(ordinary.original, { type: 'set-title', markdownTitle: 'New' }),
      ).toEqual({ type: 'changed', content: '- [ ] New\r\n' });
    });

    it('sweeps thousands of marker candidates across merged code and link exclusions', () => {
      const segmentCount = 1_024;
      const segments = Array.from(
        { length: segmentCount },
        (_, index) =>
          ` [date${index} 📅 nope](https://example.test/${index})` +
          ` \`time${index} ⏰ 9:5\`` +
          ` 📅 nope${index}`,
      );
      const source = `- [ ] Head${segments.join('')}`;
      const parsed = parse(source);

      expect(spanText(parsed, 'malformed-known')).toHaveLength(segmentCount);
      expect(spanText(parsed, 'title')).toHaveLength(segmentCount * 2 + 1);
      expect(parsed.markdownTitle).toContain('[date0 📅 nope](https://example.test/0)');
      expect(parsed.markdownTitle).toContain('`time1023 ⏰ 9:5`');
      expectLosslessPartition(parsed);
    });

    it('preserves dense malformed ID/dependency grammar and carrier adjacency', () => {
      const segmentCount = 512;
      const segments = Array.from(
        { length: segmentCount },
        (_, index) =>
          ` 🆔 good_${index}` +
          ` 🆔️ bad.${index}` +
          ` ⛔ dep_${index}, next-${index}` +
          ` ⛔️ one,,two${index}` +
          ` 🆔adjacent${index}📅 2026-07-20`,
      );
      const parsed = parse(`- [ ] Head${segments.join('')}`);

      expect(spanText(parsed, 'task-id')).toHaveLength(segmentCount);
      expect(spanText(parsed, 'depends-on')).toHaveLength(segmentCount);
      expect(spanText(parsed, 'malformed-known')).toHaveLength(segmentCount * 3);
      expect(spanText(parsed, 'due')).toHaveLength(segmentCount);
      expectLosslessPartition(parsed);
    });

    it('avoids quadratic growth for dense ID/dependency markers', () => {
      const denseSource = (count: number): string =>
        `- [ ] Head${Array.from({ length: count }, () => ' 🆔 . ⛔ .').join('')}`;
      const perIterationMs = (source: string): number => {
        const startedAt = performance.now();
        let iterations = 0;
        let elapsedMs = 0;
        do {
          codec.parseLine(source, location);
          iterations++;
          elapsedMs = performance.now() - startedAt;
        } while (elapsedMs < 50);
        return elapsedMs / iterations;
      };
      const small = denseSource(1_000);
      const large = denseSource(2_000);
      codec.parseLine(small, location);
      codec.parseLine(large, location);

      const pairedRatio = (largeFirst: boolean): number => {
        if (largeFirst) {
          const largeMs = perIterationMs(large);
          const smallMs = perIterationMs(small);
          return largeMs / smallMs;
        }
        const smallMs = perIterationMs(small);
        const largeMs = perIterationMs(large);
        return largeMs / smallMs;
      };
      const ratios = Array.from({ length: 5 }, (_, run) => pairedRatio(run % 2 === 1)).sort(
        (left, right) => left - right,
      );

      expect(ratios[2]).toBeLessThan(3.6);
    });

    it('preserves all valid source-owned carriers and CRLF byte-exactly', () => {
      const suffix =
        '⏰ 09:05 ⏱️ 1h30m 🔁 every week ➕ 2026-07-01 🛫 2026-07-02 ⏳ 2026-07-03 📅 2026-07-04 ❌ 2026-07-05 ✅ 2026-07-06 🆔 keep-id ⛔ dep-1, dep_2 ^block';
      const source = `> - [ ] Old ${suffix}\r\n`;

      expect(codec.applyLineEdit(source, { type: 'set-title', markdownTitle: 'New' })).toEqual({
        type: 'changed',
        content: `> - [ ] New ${suffix}\r\n`,
      });
    });

    it.each([
      ['lexical date', '📅 nope'],
      ['lexical time', '⏰ 9:5'],
      ['lexical duration', '⏱️ nope'],
      ['invalid ID', '🆔 bad.id'],
      ['invalid ID with variation selector', '🆔️ bad.id'],
      ['invalid dependency', '⛔ one,,two'],
      ['invalid terminal block', '^bad/value'],
    ])('hides and preserves a malformed known %s carrier', (_case, carrier) => {
      const source = `- [ ] Old ${carrier}`;
      const parsed = parse(source);

      expect(parsed.markdownTitle).toBe('Old');
      expect(spanText(parsed, 'malformed-known')).toEqual([carrier]);
      expect(codec.applyLineEdit(source, { type: 'set-title', markdownTitle: 'New' })).toEqual({
        type: 'changed',
        content: `- [ ] New ${carrier}`,
      });
      expectLosslessPartition(parsed);
    });

    it.each([
      ['semantic date', '📅 2026-02-30', 'due'],
      ['semantic time', '⏰ 25:00', 'time'],
      ['semantic duration', '⏱️ 0m', 'duration'],
    ] as const)('keeps a %s carrier dedicated and protected', (_case, carrier, kind) => {
      const source = `- [ ] Old ${carrier}`;
      const parsed = parse(source);

      expect(parsed.markdownTitle).toBe('Old');
      expect(spanText(parsed, kind)).toEqual([carrier]);
      expect(codec.applyLineEdit(source, { type: 'set-title', markdownTitle: 'New' })).toEqual({
        type: 'changed',
        content: `- [ ] New ${carrier}`,
      });
    });

    it('distinguishes valid and malformed IDs, dependencies, and terminal blocks', () => {
      const source =
        '- [ ] Old 🆔 bad.id 🆔 keep-id ⛔ one,,two ⛔ dep-1, dep_2 ^middle text ^bad/value';
      const parsed = parse(source);

      expect(parsed.markdownTitle).toBe('Old ^middle text');
      expect(spanText(parsed, 'task-id')).toEqual(['🆔 keep-id']);
      expect(spanText(parsed, 'depends-on')).toEqual(['⛔ dep-1, dep_2']);
      expect(spanText(parsed, 'block-id')).toEqual([]);
      expect(spanText(parsed, 'malformed-known')).toEqual([
        '🆔 bad.id',
        '⛔ one,,two',
        '^bad/value',
      ]);
      expect(codec.applyLineEdit(source, { type: 'set-title', markdownTitle: 'New' })).toEqual({
        type: 'changed',
        content: '- [ ] New 🆔 bad.id 🆔 keep-id ⛔ one,,two ⛔ dep-1, dep_2 ^bad/value',
      });
    });

    it('bounds a spaced malformed dependency to its comma-separated sequence', () => {
      const source = '- [ ] Old ⛔ one, two! tail';
      const parsed = parse(source);

      expect(parsed.markdownTitle).toBe('Old tail');
      expect(spanText(parsed, 'malformed-known')).toEqual(['⛔ one, two!']);
      expect(codec.applyLineEdit(source, { type: 'set-title', markdownTitle: 'New' })).toEqual({
        type: 'changed',
        content: '- [ ] New ⛔ one, two!',
      });
    });

    it('retains duplicate valid and malformed carriers in source order', () => {
      const source = '- [ ] Old 📅 nope Middle 📅 nope 📅 2026-02-30 📅 2026-02-30';
      const parsed = parse(source);

      expect(parsed.markdownTitle).toBe('Old Middle');
      expect(spanText(parsed, 'malformed-known')).toEqual(['📅 nope', '📅 nope']);
      expect(spanText(parsed, 'due')).toEqual(['📅 2026-02-30', '📅 2026-02-30']);
      expect(codec.applyLineEdit(source, { type: 'set-title', markdownTitle: 'New' })).toEqual({
        type: 'changed',
        content: '- [ ] New 📅 nope 📅 nope 📅 2026-02-30 📅 2026-02-30',
      });
    });

    it('bounds adjacent malformed markers without swallowing another carrier', () => {
      const source = '- [ ] 📅 📅 nope';
      const parsed = parse(source);

      expect(parsed.markdownTitle).toBe('');
      expect(spanText(parsed, 'malformed-known')).toEqual(['📅', '📅 nope']);
      expect(codec.applyLineEdit(source, { type: 'set-title', markdownTitle: 'New' })).toEqual({
        type: 'changed',
        content: '- [ ] New 📅 📅 nope',
      });
    });

    it.each(['#tag', '🔺', '📅 2026-07-20', '🆔 keep-id', '⛔ dep', '^block'])(
      'stops a malformed carrier before protected %s',
      (protectedToken) => {
        const source = `- [ ] Old 📅 ${protectedToken}`;
        const parsed = parse(source);

        expect(parsed.markdownTitle).toBe('Old');
        expect(spanText(parsed, 'malformed-known')).toEqual(['📅']);
        expectLosslessPartition(parsed);
      },
    );

    it('losslessly sweeps a long alternating malformed/protected/title corpus', () => {
      const segments = Array.from(
        { length: 256 },
        (_, index) => ` 📅 nope #tag/${index} word${index}`,
      );
      const source = `- [ ] Head${segments.join('')}`;
      const parsed = parse(source);

      expect(parsed.markdownTitle).toBe(
        ['Head', ...segments.map((_, index) => `word${index}`)].join(' '),
      );
      expect(spanText(parsed, 'malformed-known')).toHaveLength(256);
      expect(spanText(parsed, 'tag')).toHaveLength(256);
      expectLosslessPartition(parsed);
      expect(codec.applyLineEdit(source, { type: 'set-title', markdownTitle: 'New' })).toEqual({
        type: 'changed',
        content: `- [ ] New${segments.map((segment) => segment.replace(/ word\d+$/u, '')).join('')}`,
      });
    });

    it.each(['📅', '🆔', '⛔'])('stops a malformed %s carrier before recurrence', (carrier) => {
      const source = `- [ ] Old ${carrier} 🔁 every week`;
      const parsed = parse(source);

      expect(parsed.markdownTitle).toBe('Old');
      expect(parsed.recurrence).toBe('every week');
      expect(spanText(parsed, 'malformed-known')).toEqual([carrier]);
      expect(spanText(parsed, 'recurrence')).toEqual(['🔁 every week']);
      expectLosslessPartition(parsed);
      expect(codec.applyLineEdit(source, { type: 'set-title', markdownTitle: 'New' })).toEqual({
        type: 'changed',
        content: `- [ ] New ${carrier} 🔁 every week`,
      });
    });

    it.each(['^🔁', '^📅2026-07-20', '^🆔abc', '^⛔dep', '^📅nope', '^🆔bad.id', '^⛔one,,two'])(
      'gives the complete terminal malformed block %s precedence over nested carriers',
      (block) => {
        const source = `- [ ] Old ${block}\r\n`;
        const parsed = parse(source);

        expect(parsed.markdownTitle).toBe('Old');
        expect(parsed.recurrence).toBeUndefined();
        expect(spanText(parsed, 'due')).toEqual([]);
        expect(spanText(parsed, 'task-id')).toEqual([]);
        expect(spanText(parsed, 'depends-on')).toEqual([]);
        expect(spanText(parsed, 'malformed-known')).toEqual([block]);
        expectLosslessPartition(parsed);

        const changed = codec.applyLineEdit(source, { type: 'set-title', markdownTitle: 'New' });
        expect(changed).toEqual({ type: 'changed', content: `- [ ] New ${block}\r\n` });
        expect(
          codec.applyLineEdit((changed as Extract<typeof changed, { type: 'changed' }>).content, {
            type: 'set-title',
            markdownTitle: 'New',
          }),
        ).toEqual({ type: 'unchanged', content: `- [ ] New ${block}\r\n` });
      },
    );

    it('keeps protected-only empty replacement idempotent with zero whitespace growth', () => {
      const source = '- [ ] #tag 📅 nope 🆔 bad.id ^bad/value\r\n';
      expect(parse(source).markdownTitle).toBe('');
      expect(codec.applyLineEdit(source, { type: 'set-title', markdownTitle: '' })).toEqual({
        type: 'unchanged',
        content: source,
      });

      const added = codec.applyLineEdit(source, { type: 'set-title', markdownTitle: 'New' });
      expect(added).toEqual({
        type: 'changed',
        content: '- [ ] New #tag 📅 nope 🆔 bad.id ^bad/value\r\n',
      });
      expect(
        codec.applyLineEdit((added as Extract<typeof added, { type: 'changed' }>).content, {
          type: 'set-title',
          markdownTitle: 'New',
        }),
      ).toEqual({
        type: 'unchanged',
        content: '- [ ] New #tag 📅 nope 🆔 bad.id ^bad/value\r\n',
      });
    });

    it('appends after the last semantic fragment across unknown syntax and tags', () => {
      const source = '- [ ] Old 🧭 future #tag tail 📅 nope';
      expect(codec.applyLineEdit(source, { type: 'append-title', markdown: 'later' })).toEqual({
        type: 'changed',
        content: '- [ ] Old 🧭 future #tag tail later 📅 nope',
      });
    });

    it('returns unchanged for semantic no-op edits without normalizing bytes', () => {
      const source = '- [ ] Task  📅   2026-07-20 ^block\r\n';

      expect(
        codec.applyLineEdit(source, {
          type: 'set-date',
          field: 'due',
          value: '2026-07-20',
        }),
      ).toEqual({ type: 'unchanged', content: source });
    });
  });

  it('partitions a representative Tasks-compatible line without losing source bytes', () => {
    const source =
      '> - [/] Review [[Design|spec]] #work 🆔 review-1 ⛔ prep-1, prep_2 📅 2026-07-20 ^review';
    const parsed = parse(source);

    expect(parsed).toMatchObject({
      statusSymbol: '/',
      markdownTitle: 'Review [[Design|spec]]',
      tags: ['#work'],
      planning: { due: '2026-07-20' },
      source: { filePath: 'Projects/Test.md', line: 4, originalMarkdown: source },
    });
    expect(spanText(parsed, 'task-id')).toEqual(['🆔 review-1']);
    expect(spanText(parsed, 'depends-on')).toEqual(['⛔ prep-1, prep_2']);
    expect(spanText(parsed, 'block-id')).toEqual(['^review']);
    expectLosslessPartition(parsed);
  });

  it.each([
    ['🔺', 'A'],
    ['⏫', 'B'],
    ['🔼', 'C'],
    ['', 'D'],
    ['🔽', 'E'],
    ['⏬', 'F'],
  ] as const)('decodes priority %s as %s', (marker, priority) => {
    const parsed = parse(`- [ ] Task${marker ? ` ${marker}` : ''}`);
    expect(parsed.priority).toBe(priority);
    expect(parsed.markdownTitle).toBe('Task');
    expectLosslessPartition(parsed);
  });

  it('recognizes every planning field, recurrence, created date, time, and duration', () => {
    const source =
      '- [x] Ship ⏰ 09:05 ⏱️ 1h30m 🔁 every week ➕ 2026-07-01 🛫 2026-07-02 ⏳ 2026-07-03 📅 2026-07-04 ❌ 2026-07-05 ✅ 2026-07-06';
    const parsed = parse(source);

    expect(parsed.markdownTitle).toBe('Ship');
    expect(parsed.recurrence).toBe('every week');
    expect(parsed.planning).toEqual({
      start: '2026-07-02',
      scheduled: '2026-07-03',
      due: '2026-07-04',
      cancelled: '2026-07-05',
      completion: '2026-07-06',
      time: '09:05',
      duration: 90,
    });
    expect(spanText(parsed, 'created')).toEqual(['➕ 2026-07-01']);
    expectLosslessPartition(parsed);
  });

  it('retains every duplicate occurrence while exposing legacy first-value semantics', () => {
    const parsed = parse('- [ ] Task 📅 2026-07-01 📅 2026-07-02 🔼 🔽');

    expect(parsed.planning.due).toBe('2026-07-01');
    expect(parsed.priority).toBe('C');
    expect(parsed.occurrences.get('due')).toHaveLength(2);
    expect(parsed.occurrences.get('priority')).toHaveLength(2);
    expectLosslessPartition(parsed);
  });

  it('does not skip a zero-duration first occurrence in favor of a later duplicate', () => {
    const parsed = parse('- [ ] Task ⏱️ 0m ⏱️ 1h');
    expect(parsed.planning.duration).toBeUndefined();
    expect(parsed.occurrences.get('duration')).toHaveLength(2);
    expectLosslessPartition(parsed);
  });

  it('keeps tags and nested tags as dedicated spans while preserving Markdown title markup', () => {
    const parsed = parse(
      '- [ ] Read [[Sources|secondary sources]] and [docs](https://example.test) #work #project/alpha-beta',
    );

    expect(parsed.markdownTitle).toBe(
      'Read [[Sources|secondary sources]] and [docs](https://example.test)',
    );
    expect(parsed.tags).toEqual(['#work', '#project/alpha-beta']);
    expect(spanText(parsed, 'tag')).toEqual(['#work', '#project/alpha-beta']);
    expectLosslessPartition(parsed);
  });

  it.each([
    '  - [ ] Indented',
    '\t- [ ] Tabbed',
    '> - [ ] Quoted',
    '> > - [ ] Nested callout task',
    '>>- [ ] Compact quote',
  ])('preserves indentation and blockquote/callout prefix in %j', (source) => {
    const parsed = parse(source);
    expect(spanText(parsed, 'prefix')).toHaveLength(1);
    expectLosslessPartition(parsed);
  });

  it('preserves CRLF as its own exact source span', () => {
    const source = '> - [ ] Windows task 📅 2026-07-20\r\n';
    const parsed = parse(source);

    expect(parsed.lineEnding).toBe('\r\n');
    expect(parsed.source.originalMarkdown).toBe(source);
    const separators = spanText(parsed, 'separator');
    expect(separators[separators.length - 1]).toBe('\r\n');
    expectLosslessPartition(parsed);
  });

  it.each([
    ['🆔 A', 'A'],
    ['🆔 abc-DEF_123', 'abc-DEF_123'],
    ['🆔️ id_with-vs16', 'id_with-vs16'],
  ])('recognizes the pinned task ID grammar in %j', (carrier, id) => {
    const parsed = parse(`- [ ] Task ${carrier}`);
    expect(spanText(parsed, 'task-id')).toEqual([carrier]);
    expect(parsed.markdownTitle).toBe('Task');
    expect(parsed.original).toContain(id);
    expectLosslessPartition(parsed);
  });

  it.each([
    '⛔ one',
    '⛔ one,two',
    '⛔ one, two',
    '⛔ one ,two',
    '⛔ one , two',
    '⛔️ one_1, two-2',
  ])('recognizes pinned dependency lists in %j', (carrier) => {
    const parsed = parse(`- [ ] Task ${carrier}`);
    expect(spanText(parsed, 'depends-on')).toEqual([carrier]);
    expect(parsed.markdownTitle).toBe('Task');
    expectLosslessPartition(parsed);
  });

  it('recognizes adjacent metadata only when separated by whitespace', () => {
    const parsed = parse('- [ ] Task 🆔 id-1 📅 2026-07-20 ⛔ prep,next ✅ 2026-07-21');
    expect(spanText(parsed, 'task-id')).toEqual(['🆔 id-1']);
    expect(spanText(parsed, 'depends-on')).toEqual(['⛔ prep,next']);
    expect(parsed.planning).toMatchObject({ due: '2026-07-20', completion: '2026-07-21' });
    expectLosslessPartition(parsed);
  });

  it.each(['🆔 id!', '🆔 id.dot', '🆔 id/next', '⛔ one,two!', '⛔ one,,two', '⛔ one,two/three'])(
    'retains partial ID/dependency matches as malformed-known spans in %j',
    (carrier) => {
      const parsed = parse(`- [ ] Task ${carrier}`);
      expect(parsed.occurrences.get('task-id') ?? []).toHaveLength(0);
      expect(parsed.occurrences.get('depends-on') ?? []).toHaveLength(0);
      expect(parsed.markdownTitle).toBe('Task');
      expect(spanText(parsed, 'malformed-known')).toEqual([carrier]);
      expectLosslessPartition(parsed);
    },
  );

  it('separates malformed recognized-looking carriers from unknown semantic emoji', () => {
    const source =
      '- [ ] Keep 🧭 north 📅 not-a-date ⏰ 9:5 ⏱️ nope ➕ 2026-7-1 🆔 bad.value ^bad/value';
    const parsed = parse(source);

    expect(parsed.planning).toEqual({});
    expect(parsed.markdownTitle).toBe('Keep 🧭 north');
    expect(spanText(parsed, 'malformed-known')).toEqual([
      '📅 not-a-date',
      '⏰ 9:5',
      '⏱️ nope',
      '➕ 2026-7-1',
      '🆔 bad.value',
      '^bad/value',
    ]);
    expect(spanText(parsed, 'unknown').length).toBeGreaterThan(0);
    expectLosslessPartition(parsed);
  });

  it('recognizes only a terminal Obsidian block ID', () => {
    const parsed = parse('- [ ] Mention ^middle in title ^terminal');
    expect(spanText(parsed, 'block-id')).toEqual(['^terminal']);
    expect(parsed.markdownTitle).toBe('Mention ^middle in title');
    expectLosslessPartition(parsed);
  });

  it('does not recognize a terminal caret token without the required whitespace boundary', () => {
    const parsed = parse('- [ ] Keep title^not-a-block');
    expect(spanText(parsed, 'block-id')).toEqual([]);
    expect(parsed.markdownTitle).toBe('Keep title^not-a-block');
    expectLosslessPartition(parsed);
  });

  it('parses shuffled suffix tokens from right to left without reordering source', () => {
    const source = '- [ ] Task 📅 2026-07-20 🔁 every week ⏫ ⏰ 14:30';
    const parsed = parse(source);

    expect(parsed.markdownTitle).toBe('Task');
    expect(parsed.recurrence).toBe('every week');
    expect(parsed.priority).toBe('B');
    expect(parsed.planning).toMatchObject({ due: '2026-07-20', time: '14:30' });
    expectLosslessPartition(parsed);
  });

  it('returns null for non-task source', () => {
    expect(codec.parseLine('> [!todo] Callout header', location)).toBeNull();
    expect(codec.parseLine('- plain bullet', location)).toBeNull();
  });

  it('uses the injected status catalog without requiring configured symbols to parse', () => {
    expect(codec.statusForSymbol('/')).toBe('in-progress');
    expect(codec.statusForSymbol('X')).toBe('done');
    expect(codec.statusForSymbol('?')).toBe('open');
    expect(parse('- [?] Unknown but compatible').statusSymbol).toBe('?');
  });
});
