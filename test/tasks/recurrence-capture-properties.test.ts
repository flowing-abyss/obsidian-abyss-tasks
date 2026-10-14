import fc from 'fast-check';
import { expect, it } from 'vitest';
import { localDate, localTime } from '../../src/tasks/domain/validation';
import { RecurrenceTextInputParser } from '../../src/tasks/infrastructure/input/RecurrenceTextInputParser';
import { expectDefined, useRealMoment } from '../helpers';
import { smartHarness } from '../support/taskInputHarness';

useRealMoment();
const recurrence = new RecurrenceTextInputParser();
const reference = {
  epochMs: Date.parse('2026-10-13T09:00:00+07:00'),
  localDate: localDate('2026-10-13'),
  localTime: localTime('09:00'),
  second: 0,
  offsetMinutes: 420,
};

it('preserves opaque text in short, medium and long drafts while saving exact recurrence/planning', async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.constantFrom(1, 12, 90),
      fc.constantFrom(
        '👩‍💻',
        '`tomorrow`',
        '[tomorrow](Notes.md)',
        '«каждый день»',
        'build-123456',
        '-5 degrees',
        ':smile:',
      ),
      fc.constantFrom(
        { phrase: 'every day', rule: 'every day', due: '2026-10-13' },
        { phrase: 'каждый понедельник', rule: 'every week on Monday', due: '2026-10-19' },
        { phrase: 'every 2 weeks on Monday', rule: 'every 2 weeks on Monday', due: '2026-10-26' },
        { phrase: 'каждый месяц 5 числа', rule: 'every month on the 5th', due: '2026-11-05' },
      ),
      async (length, opaque, fixture) => {
        const title = `Call ${opaque} ${'ordinary detail '.repeat(length).trim()}`;
        const raw = `${title} ${fixture.phrase} at 10:00 #work`;
        const h = await smartHarness({}, { recurrence, reference, inbox: false, initial: {} });
        h.controller.setDraft(raw);
        expect(h.controller.snapshot().draft).toBe(raw);
        expect(h.controller.snapshot().metadata?.preview).toMatchObject({
          type: 'valid',
          metadata: {
            markdownTitle: title,
            recurrence: fixture.rule,
            planning: { due: fixture.due, time: '10:00' },
            tags: ['#work'],
          },
        });
        await h.controller.submit('enter');
        const root = h.readCanonicalRoot(expectDefined(h.repositoryWrites[0]));
        expect(root.markdownTitle).toBe(title);
        expect(root.recurrence).toBe(fixture.rule);
        expect(root.planning.due).toBe(fixture.due);
        expect(root.planning.time).toBe('10:00');
        expect(root.tags).toEqual(['#work']);
      },
    ),
    { seed: 2026101402, numRuns: 72 },
  );
});

it('keeps raw/history and dismissed occurrence across outside edits, with frozen Restore', async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.constantFrom('input', 'paste', 'history', 'composition'),
      fc.constantFrom(' ', '  ', '\t', '\u00a0'),
      fc.constantFrom('every day', 'каждый день'),
      fc.constantFrom('', '👩‍💻 ', 'important '.repeat(25)),
      async (kind, gap, phrase, prefix) => {
        const h = await smartHarness({}, { recurrence, reference, inbox: false, initial: {} });
        const raw = `Call${gap}${phrase}${gap}at 10:00`;
        h.controller.setDraft(raw);
        h.controller.applyMetadataAction({ type: 'dismiss', role: 'recurrence' });
        const editKind = kind;
        h.controller.setDraft(prefix + raw, {
          editKind,
          deferRecognition: editKind === 'composition',
        });
        h.controller.flushRecognition();
        expect(h.controller.snapshot().draft).toBe(prefix + raw);
        const dismissed = h.controller.snapshot().metadata?.preview;
        expect(dismissed).toMatchObject({
          type: 'valid',
          metadata: { planning: { due: '2026-10-13', time: '10:00' } },
        });
        if (dismissed?.type === 'valid') expect(dismissed.metadata.recurrence).toBeUndefined();
        h.controller.applyMetadataAction({ type: 'restore' });
        await h.controller.submit('enter');
        const root = h.readCanonicalRoot(expectDefined(h.repositoryWrites[0]));
        expect(root.markdownTitle).toBe(`${prefix}Call`);
        expect(root.recurrence).toBe('every day');
        expect(root.planning.due).toBe('2026-10-13');
        expect(root.planning.time).toBe('10:00');
      },
    ),
    { seed: 2026101403, numRuns: 64 },
  );
});

it('pairs dates around recurrence and canonical tags without changing opaque title text', async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.constantFrom('every day', 'каждый день'),
      fc.constantFrom('#work', '#work/project', '#семья'),
      fc.boolean(),
      async (phrase, tag, reverse) => {
        const temporal = reverse
          ? `at 10:00 ${tag} ${phrase} tomorrow`
          : `tomorrow ${phrase} ${tag} at 10:00`;
        const raw = `Call 👩‍💻 ${temporal}`;
        const h = await smartHarness({}, { recurrence, reference, inbox: false, initial: {} });
        h.controller.setDraft(raw);
        await h.controller.submit('enter');
        const root = h.readCanonicalRoot(expectDefined(h.repositoryWrites[0]));
        expect(root.markdownTitle).toBe('Call 👩‍💻');
        expect(root.recurrence).toBe('every day');
        expect(root.planning.due).toBe('2026-10-14');
        expect(root.planning.time).toBe('10:00');
        expect(root.tags).toEqual([tag]);
      },
    ),
    { seed: 2026101404, numRuns: 24 },
  );
});
