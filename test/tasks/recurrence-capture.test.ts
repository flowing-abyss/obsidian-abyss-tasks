import { describe, expect, it, vi } from 'vitest';
import { localDate, localTime } from '../../src/tasks/domain/validation';
import { RecurrenceTextInputParser } from '../../src/tasks/infrastructure/input/RecurrenceTextInputParser';
import { expectDefined, useRealMoment } from '../helpers';
import { smartHarness } from '../support/taskInputHarness';

useRealMoment();
const reference = {
  epochMs: Date.parse('2026-10-13T09:00:00+07:00'),
  localDate: localDate('2026-10-13'),
  localTime: localTime('09:00'),
  second: 0,
  offsetMinutes: 420,
};
const recurrence = new RecurrenceTextInputParser();
const capture = () => smartHarness({}, { recurrence, reference, inbox: false, initial: {} });

describe('recurrence capture through canonical preview and writing', () => {
  it.each(
    (
      [
        ['Каждый день — пить воду', 'Пить воду', 'every day', '2026-10-13', undefined],
        [
          'Позвонить маме каждый понедельник в 10:00',
          'Позвонить маме',
          'every week on Monday',
          '2026-10-19',
          '10:00',
        ],
        [
          'Каждый месяц 5 числа: оплатить аренду',
          'Оплатить аренду',
          'every month on the 5th',
          '2026-11-05',
          undefined,
        ],
        [
          'Send report every 2 weeks on Monday at 10:00 to Anna',
          'Send report to Anna',
          'every 2 weeks on Monday',
          '2026-10-26',
          '10:00',
        ],
        ['Call tomorrow every day at 10:00', 'Call', 'every day', '2026-10-14', '10:00'],
        ['Call tomorrow at 10:00 every day', 'Call', 'every day', '2026-10-14', '10:00'],
        ['Позвонить завтра каждый день в 10:00', 'Позвонить', 'every day', '2026-10-14', '10:00'],
        ['Позвонить завтра в 10:00 каждый день', 'Позвонить', 'every day', '2026-10-14', '10:00'],
        [
          'Завтра в 10:00 — проверить отчёт каждый день #work',
          'Проверить отчёт',
          'every day',
          '2026-10-14',
          '10:00',
        ],
      ] satisfies Array<[string, string, string, string, string | undefined]>
    ).map(([raw, title, rule, due, time]) => ({ raw, title, rule, due, time })),
  )(
    'preserves raw and saves the represented title, rule and date: $raw',
    async ({ raw, title, rule, due, time }) => {
      const h = await capture();
      h.controller.setDraft(raw);
      expect(h.controller.snapshot().draft).toBe(raw);
      expect(h.controller.snapshot().metadata?.preview).toMatchObject({
        type: 'valid',
        metadata: {
          markdownTitle: title,
          recurrence: rule,
          planning: { due, ...(time === undefined ? {} : { time }) },
        },
      });
      await h.controller.submit('enter');
      const content = expectDefined(h.repositoryWrites[0]);
      expect(content).toContain(`🔁 ${rule}`);
      const root = h.readCanonicalRoot(content);
      expect(root.markdownTitle).toBe(title);
      expect(root.recurrence).toBe(rule);
      expect(root.planning.due).toBe(due);
      expect(root.planning.time).toBe(time);
    },
  );
  it.each([
    ['Call every Monday', 'Call every Monday', undefined, undefined],
    ['Call every Monday at 10:00', 'Call every Monday', '2026-10-13', '10:00'],
    ['Call tomorrow every day at 10:00', 'Call every day', '2026-10-14', '10:00'],
  ])(
    'dismisses repeat without removing independent time/date: %s',
    async (raw, title, due, time) => {
      const h = await capture();
      h.controller.setDraft(raw);
      const before = h.controller.snapshot().metadata?.preview;
      h.controller.applyMetadataAction({ type: 'dismiss', role: 'recurrence' });
      expect(h.controller.snapshot().draft).toBe(raw);
      expect(h.controller.snapshot().metadata?.preview).toMatchObject({
        type: 'valid',
        metadata: { markdownTitle: title },
      });
      h.controller.applyMetadataAction({ type: 'restore' });
      expect(h.controller.snapshot().metadata?.preview).toEqual(before);
      h.controller.applyMetadataAction({ type: 'dismiss', role: 'recurrence' });
      await h.controller.submit('enter');
      const root = h.readCanonicalRoot(expectDefined(h.repositoryWrites[0]));
      expect(root.markdownTitle).toBe(title);
      expect(root.recurrence).toBeUndefined();
      expect(root.planning.due).toBe(due);
      expect(root.planning.time).toBe(time);
    },
  );
  it('dismisses a recurrence-owned due date with its rule and independent clock, then restores', async () => {
    const h = await capture();
    const raw = 'Call every Monday at 10:00';
    h.controller.setDraft(raw);
    const before = h.controller.snapshot().metadata?.preview;
    expect(h.controller.snapshot().metadata?.projection?.recurrenceDateInferred).toBe(true);
    h.controller.applyMetadataAction({ type: 'dismiss', role: 'due' });
    expect(h.controller.snapshot().metadata?.preview).toMatchObject({
      type: 'valid',
      metadata: { markdownTitle: raw, planning: {} },
    });
    h.controller.applyMetadataAction({ type: 'restore' });
    expect(h.controller.snapshot().metadata?.preview).toEqual(before);
    h.controller.applyMetadataAction({ type: 'dismiss', role: 'due' });
    await h.controller.submit('enter');
    const root = h.readCanonicalRoot(expectDefined(h.repositoryWrites[0]));
    expect(root.recurrence).toBeUndefined();
    expect(root.planning.due).toBeUndefined();
    expect(root.planning.time).toBeUndefined();
  });
});

describe('recurrence provenance, fallback and literal boundaries', () => {
  it.each([
    {
      initial: { due: { type: 'set' as const, value: localDate('2026-10-16') } },
      due: '2026-10-16',
    },
    {
      initial: { start: { type: 'set' as const, value: localDate('2026-10-16') } },
      due: undefined,
    },
    {
      initial: { scheduled: { type: 'set' as const, value: localDate('2026-10-16') } },
      due: undefined,
    },
  ])('keeps context planning before recurrence inference: $initial', async ({ initial, due }) => {
    const h = await smartHarness({}, { recurrence, reference, inbox: false, initial });
    h.controller.setDraft('Call every Monday at 10:00');
    expect(h.controller.snapshot().metadata?.projection?.recurrenceDateInferred).toBe(false);
    await h.controller.submit('enter');
    const root = h.readCanonicalRoot(expectDefined(h.repositoryWrites[0]));
    expect(root.markdownTitle).toBe('Call');
    expect(root.recurrence).toBe('every week on Monday');
    expect(root.planning.due).toBe(due);
    expect(root.planning.time).toBe('10:00');
    for (const role of ['due', 'start', 'scheduled'] as const)
      expect(root.planning[role]).toBe(initial[role]?.value);
  });
  it.each(['08:59', '09:00', '09:01'])(
    'phases the first recurrence from the separate clock %s',
    async (time) => {
      const h = await capture();
      h.controller.setDraft(`Call every 2 days at ${time}`);
      await h.controller.submit('enter');
      const root = h.readCanonicalRoot(expectDefined(h.repositoryWrites[0]));
      expect(root.planning.due).toBe(time === '09:01' ? '2026-10-13' : '2026-10-14');
      expect(root.planning.time).toBe(time);
    },
  );
  it('allows a manual date to represent retained recurrence after dismissing its inferred date', async () => {
    const h = await capture();
    h.controller.setDraft('Call every Monday at 10:00');
    h.controller.applyMetadataAction({ type: 'dismiss', role: 'due' });
    h.controller.applyMetadataAction({
      type: 'select-date',
      role: 'due',
      value: localDate('2026-10-16'),
    });
    await h.controller.submit('enter');
    const root = h.readCanonicalRoot(expectDefined(h.repositoryWrites[0]));
    expect(root.markdownTitle).toBe('Call at 10:00');
    expect(root.recurrence).toBe('every week on Monday');
    expect(root.planning.due).toBe('2026-10-16');
    expect(root.planning.time).toBeUndefined();
  });
  it('does not re-infer after explicit date dismissal, but accepts a newly authored date', async () => {
    const h = await capture();
    h.controller.setDraft('Call tomorrow every Monday');
    h.controller.applyMetadataAction({ type: 'dismiss', role: 'due' });
    expect(h.controller.snapshot().metadata?.preview).toMatchObject({
      type: 'valid',
      metadata: { markdownTitle: 'Call tomorrow every Monday', planning: {} },
    });
    h.controller.setDraft('Call tomorrow every Monday 📅 2026-10-16');
    await h.controller.submit('enter');
    const root = h.readCanonicalRoot(expectDefined(h.repositoryWrites[0]));
    expect(root.markdownTitle).toBe('Call tomorrow');
    expect(root.recurrence).toBe('every week on Monday');
    expect(root.planning.due).toBe('2026-10-16');
  });
  it.each([
    { prefix: '🔁 every week #prefix', initial: {} },
    {
      prefix: '',
      initial: {
        recurrence: { type: 'set' as const, value: 'every week' },
        due: { type: 'set' as const, value: localDate('2026-10-16') },
      },
    },
  ])(
    'shows prefix/initial recurrence before typing and retains unrepresented natural text',
    async ({ prefix, initial }) => {
      const h = await smartHarness({ prefix }, { recurrence, reference, inbox: false, initial });
      expect(h.controller.snapshot().metadata?.context).toMatchObject({
        type: 'ready',
        metadata: { recurrence: 'every week' },
      });
      expect(h.readReference).not.toHaveBeenCalled();
      h.controller.setDraft('Call каждый день');
      await h.controller.submit('enter');
      const root = h.readCanonicalRoot(expectDefined(h.repositoryWrites[0]));
      expect(root.markdownTitle).toBe('Call каждый день');
      expect(root.recurrence).toBe('every week');
      expect(root.planning.due).toBe(prefix === '' ? '2026-10-16' : undefined);
    },
  );
  it('reads recurrence before and after the initial patch independently', async () => {
    const h = await smartHarness(
      { prefix: '🔁 every week #prefix' },
      {
        recurrence,
        reference,
        inbox: false,
        initial: { recurrence: { type: 'set', value: 'every day' } },
      },
    );
    const session = await h.service.planCreate({ type: 'configured-default' });
    const result = session.preview({
      markdownBody: 'Call',
      initial: {
        recurrence: { type: 'set', value: 'every day' },
        due: { type: 'set', value: localDate('2026-10-16') },
      },
    });
    expect(result).toMatchObject({
      type: 'valid',
      sourceRecurrence: 'every week',
      metadata: { recurrence: 'every day' },
    });
  });
  it('removes only dismissed canonical recurrence and accepts a new source occurrence', async () => {
    const h = await capture();
    h.controller.setDraft('Call каждый день 🔁 every week');
    expect(h.controller.snapshot().metadata?.preview).toMatchObject({
      type: 'valid',
      metadata: { markdownTitle: 'Call каждый день', recurrence: 'every week' },
    });
    h.controller.applyMetadataAction({ type: 'dismiss', role: 'recurrence' });
    expect(h.controller.snapshot().draft).toBe('Call каждый день 🔁 every week');
    expect(h.controller.snapshot().metadata?.preview).toMatchObject({
      type: 'valid',
      metadata: { markdownTitle: 'Call каждый день', planning: {} },
    });
    const dismissed = h.controller.snapshot().metadata?.preview;
    if (dismissed?.type === 'valid') expect(dismissed.metadata.recurrence).toBeUndefined();
    h.controller.setDraft('Call каждый день 🔁 every month');
    expect(h.controller.snapshot().metadata?.canRestore).toBe(false);
    await h.controller.submit('enter');
    const root = h.readCanonicalRoot(expectDefined(h.repositoryWrites[0]));
    expect(root.markdownTitle).toBe('Call каждый день');
    expect(root.recurrence).toBe('every month');
  });
  it('invalidates due Restore when a new canonical recurrence is authored', async () => {
    const h = await capture();
    h.controller.setDraft('Call every Monday');
    h.controller.applyMetadataAction({ type: 'dismiss', role: 'due' });
    h.controller.setDraft('Call every Monday 🔁 every day');
    expect(h.controller.snapshot().metadata?.canRestore).toBe(false);
  });
  it.each(['Call 🔁 nonsense', 'Call 🔁 every day until June'])(
    'keeps malformed canonical source as validation failure: %s',
    async (raw) => {
      const h = await capture();
      h.controller.setDraft(raw);
      await h.controller.submit('enter');
      expect(h.repositoryWrites).toEqual([]);
      expect(h.controller.snapshot().metadata?.preview.type).toBe('invalid');
    },
  );
  it.each(['Every day', 'Каждый день —', 'every Monday at 10:00', 'каждый день #work'])(
    'never manufactures a title: %s',
    async (raw) => {
      const h = await smartHarness({ prefix: 'Configured title' }, { recurrence, reference });
      h.controller.setDraft(raw);
      await h.controller.submit('enter');
      expect(h.repositoryWrites).toEqual([]);
      expect(h.controller.snapshot().draft).toBe(raw);
    },
  );
  it('disables recurrence extraction with the existing smart toggle', async () => {
    const h = await capture();
    h.enabled.mockReturnValue(false);
    const raw = 'Каждый день — пить воду';
    h.controller.setDraft(raw);
    await h.controller.submit('enter');
    const root = h.readCanonicalRoot(expectDefined(h.repositoryWrites[0]));
    expect(root.markdownTitle).toBe(raw);
    expect(root.recurrence).toBeUndefined();
    expect(root.planning.due).toBeUndefined();
  });
  it.each([
    'Call every day except Monday',
    'Call every day (except Monday)',
    'Call until June every day',
    'Call 5 times every day',
    'Call every Mon. except Tuesday',
    'Позвонить каждый день (кроме понедельника)',
    'Позвонить до 5 июня каждый день',
    'Позвонить 5 раз каждый день',
    'Call every day and write notes',
    'Call every day at 10:00 except Monday',
  ])('keeps unsupported recurrence/date-like fragments literal: %s', async (raw) => {
    const h = await capture();
    h.controller.setDraft(`${raw}; call tomorrow`);
    await h.controller.submit('enter');
    const root = h.readCanonicalRoot(expectDefined(h.repositoryWrites[0]));
    expect(root.markdownTitle).toBe(`${raw}; call`);
    expect(root.recurrence).toBeUndefined();
    expect(root.planning.due).toBe('2026-10-14');
  });
  it.each([
    'Call every day tomorrow or Friday',
    'Call every day 10:00 12:00',
    'Call every Monday about 10:00',
    'Call every Monday tomorrow at 25:00',
    'Call every Monday 01/02',
    'Call every Monday from June 5 to June 7',
  ])('does not invent a first date across ambiguous/unsupported dates: %s', async (raw) => {
    const h = await capture();
    h.controller.setDraft(raw);
    await h.controller.submit('enter');
    const root = h.readCanonicalRoot(expectDefined(h.repositoryWrites[0]));
    expect(root.markdownTitle).toBe(raw);
    expect(root.recurrence).toBeUndefined();
    expect(root.planning.due).toBeUndefined();
  });
  it('retains multiple valid natural rules', async () => {
    const raw = 'Call every day; write every week';
    const h = await capture();
    h.controller.setDraft(raw);
    await h.controller.submit('enter');
    const root = h.readCanonicalRoot(expectDefined(h.repositoryWrites[0]));
    expect(root.markdownTitle).toBe(raw);
    expect(root.recurrence).toBeUndefined();
    expect(root.planning.due).toBeUndefined();
  });
  it('clears stale recurrence and removal authority after adapter failure and reports once per revision', async () => {
    const parser = new RecurrenceTextInputParser();
    const h = await smartHarness({}, { recurrence: parser, reference, inbox: false, initial: {} });
    h.controller.setDraft('Call every day');
    vi.spyOn(parser, 'extract').mockImplementation(() => {
      throw new Error('private task');
    });
    h.controller.setDraft('Call every week');
    expect(h.controller.snapshot().metadata?.recognitionError).toBeDefined();
    h.controller.flushRecognition();
    expect(h.onRecognitionFailure).toHaveBeenCalledOnce();
    await h.controller.submit('enter');
    const root = h.readCanonicalRoot(expectDefined(h.repositoryWrites[0]));
    expect(root.markdownTitle).toBe('Call every week');
    expect(root.recurrence).toBeUndefined();
    expect(root.planning.due).toBeUndefined();
  });
});

it.each([
  'Call tomorrow every day at 10:00',
  'Call tomorrow at 10:00 every day',
  'Позвонить завтра каждый день в 10:00',
  'Позвонить завтра в 10:00 каждый день',
])('preserves paired temporal meaning through repeat dismissal and Restore: %s', async (raw) => {
  const h = await capture();
  h.controller.setDraft(raw);
  const before = h.controller.snapshot().metadata?.preview;
  h.controller.applyMetadataAction({ type: 'dismiss', role: 'recurrence' });
  expect(h.controller.snapshot().metadata?.preview).toMatchObject({
    type: 'valid',
    metadata: { planning: { due: '2026-10-14', time: '10:00' } },
  });
  h.controller.applyMetadataAction({ type: 'restore' });
  expect(h.controller.snapshot().metadata?.preview).toEqual(before);
  await h.controller.submit('enter');
  const root = h.readCanonicalRoot(expectDefined(h.repositoryWrites[0]));
  expect(root.markdownTitle).toBe(raw.startsWith('Call') ? 'Call' : 'Позвонить');
  expect(root.recurrence).toBe('every day');
  expect(root.planning.due).toBe('2026-10-14');
  expect(root.planning.time).toBe('10:00');
});

it.each(['input', 'paste', 'history', 'composition'] as const)(
  'rebases only the dismissed occurrence through %s edits',
  async (editKind) => {
    const h = await capture();
    h.controller.setDraft('Call every day');
    h.controller.applyMetadataAction({ type: 'dismiss', role: 'recurrence' });
    const raw = '👩‍💻 Call every day; write every day';
    h.controller.setDraft(raw, { editKind, deferRecognition: editKind === 'composition' });
    h.controller.flushRecognition();
    // Multiple valid occurrences stay literal, including after the old one is dismissed.
    expect(h.controller.snapshot().draft).toBe(raw);
    await h.controller.submit('enter');
    const root = h.readCanonicalRoot(expectDefined(h.repositoryWrites[0]));
    expect(root.markdownTitle).toBe(raw);
    expect(root.recurrence).toBeUndefined();
    expect(root.planning.due).toBeUndefined();
  },
);

it('accepts a changed recurrence occurrence after dismissal without a global phrase blacklist', async () => {
  const h = await capture();
  h.controller.setDraft('Call every day');
  h.controller.applyMetadataAction({ type: 'dismiss', role: 'recurrence' });
  h.controller.setDraft('Call every week');
  expect(h.controller.snapshot().metadata?.canRestore).toBe(false);
  await h.controller.submit('enter');
  const root = h.readCanonicalRoot(expectDefined(h.repositoryWrites[0]));
  expect(root.markdownTitle).toBe('Call');
  expect(root.recurrence).toBe('every week');
  expect(root.planning.due).toBe('2026-10-13');
});

it('reuses the frozen recurrence request across an unchanged retry and reference change', async () => {
  const h = await capture();
  vi.spyOn(h.repository, 'create').mockResolvedValueOnce({
    type: 'io-error',
    cause: 'process-error',
    contentState: 'unchanged',
  });
  h.controller.setDraft('Call every 2 weeks on Monday at 10:00', { deferRecognition: true });
  await h.controller.submit('enter');
  h.readReference.mockReturnValue({ ...reference, localDate: localDate('2026-10-20') });
  await h.controller.submit('enter');
  expect(h.execute.mock.calls[0]?.[0]).toEqual(h.execute.mock.calls[1]?.[0]);
  const root = h.readCanonicalRoot(expectDefined(h.repositoryWrites[0]));
  expect(root.markdownTitle).toBe('Call');
  expect(root.recurrence).toBe('every 2 weeks on Monday');
  expect(root.planning.due).toBe('2026-10-26');
  expect(root.planning.time).toBe('10:00');
});

import { inspectTaskInput } from '../../src/tasks/domain/taskInputInspection';
import type { TaskInputRange } from '../../src/tasks/domain/taskInputTypes';
import { ChronoTaskInputRecognizer } from '../../src/tasks/infrastructure/input/ChronoTaskInputRecognizer';

describe('Chrono recurrence pairing transparency', () => {
  const chrono = new ChronoTaskInputRecognizer();
  it.each(['every Mon.', 'every week on Monday, Wednesday', 'каждый пн.', 'every day'])(
    'masks protected recurrence punctuation before pairing: %s',
    (phrase) => {
      const text = `Call tomorrow ${phrase} at 10:00`,
        from = text.indexOf(phrase),
        range = { from, to: from + phrase.length };
      const candidates = chrono.recognize({
        text,
        reference,
        protectedRanges: [range],
        pairingTransparentRanges: [range],
      });
      expect(candidates).toHaveLength(1);
      expect(candidates[0]).toMatchObject({ status: 'point', date: '2026-10-14', time: '10:00' });
      expect(candidates[0]?.ranges.map((r) => text.slice(r.from, r.to))).toEqual([
        'tomorrow',
        'at 10:00',
      ]);
    },
  );
  it.each([
    '"every day"',
    '`every day`',
    '[every day](target)',
    '🔁 every day',
    '<span>every day</span>',
  ])('cannot make a protected Markdown/canonical atom transparent: %s', (phrase) => {
    const text = `Call tomorrow ${phrase} at 10:00`,
      from = text.indexOf(phrase),
      range = { from, to: from + phrase.length };
    const candidates = chrono.recognize({
      text,
      reference,
      protectedRanges: [...inspectTaskInput(text).protectedRanges, range],
      pairingTransparentRanges: [range],
    });
    expect(
      candidates.some((candidate) => candidate.date !== undefined && candidate.time !== undefined),
    ).toBe(false);
  });
  it.each(['.', ';', '!', '?', '\n', ' or ', ' или '])(
    'keeps genuine punctuation and alternation outside recurrence as pairing barriers: %s',
    (separator) => {
      const text = `Call tomorrow every day${separator}at 10:00`,
        range = { from: 14, to: 23 };
      const candidates = chrono.recognize({
        text,
        reference,
        protectedRanges: [range],
        pairingTransparentRanges: [range],
      });
      expect(
        candidates.some(
          (candidate) => candidate.date !== undefined && candidate.time !== undefined,
        ),
      ).toBe(false);
    },
  );
  it.each([
    { protection: [{ from: 14, to: 23 }], transparent: [] },
    { protection: [], transparent: [{ from: 14, to: 23 }] },
    {
      protection: [
        { from: 14, to: 23 },
        { from: 13, to: 24 },
      ],
      transparent: [{ from: 14, to: 23 }],
    },
    { protection: [{ from: 14, to: 23 }], transparent: [{ from: 14, to: 24 }] },
    { protection: [{ from: 14, to: 23 }], transparent: [{ from: 14.5, to: 23 }] },
    { protection: [{ from: 14, to: 23 }], transparent: [{ from: -1, to: 23 }] },
    { protection: [{ from: 14, to: 23 }], transparent: [{ from: 14, to: 200 }] },
  ] satisfies ReadonlyArray<{ protection: TaskInputRange[]; transparent: TaskInputRange[] }>)(
    'rejects unproved or overlapping transparency: $transparent',
    ({ protection, transparent }) => {
      const text = 'Call tomorrow every day at 10:00';
      const candidates = chrono.recognize({
        text,
        reference,
        protectedRanges: protection,
        pairingTransparentRanges: transparent,
      });
      expect(
        candidates.some(
          (candidate) => candidate.date !== undefined && candidate.time !== undefined,
        ),
      ).toBe(false);
    },
  );
  it('rejects a range splitting a surrogate pair even when protected identically', () => {
    const text = 'Call tomorrow 👩 every day at 10:00',
      range = { from: 15, to: 25 };
    const candidates = chrono.recognize({
      text,
      reference,
      protectedRanges: [range],
      pairingTransparentRanges: [range],
    });
    expect(
      candidates.some((candidate) => candidate.date !== undefined && candidate.time !== undefined),
    ).toBe(false);
  });
  it.each(['tomorrow every day Friday at 10:00', 'tomorrow every day at 10:00 at 11:00'])(
    'does not combine genuine multiple temporal fragments: %s',
    (tail) => {
      const text = `Call ${tail}`,
        from = text.indexOf('every day'),
        range = { from, to: from + 9 };
      const candidates = chrono.recognize({
        text,
        reference,
        protectedRanges: [range],
        pairingTransparentRanges: [range],
      });
      expect(
        candidates.some(
          (candidate) => candidate.date !== undefined && candidate.time !== undefined,
        ),
      ).toBe(false);
    },
  );
});

it.each([
  { prefix: '🔁 every week #prefix', initial: {} },
  {
    prefix: '',
    initial: {
      recurrence: { type: 'set' as const, value: 'every week' },
      due: { type: 'set' as const, value: localDate('2026-10-16') },
    },
  },
])(
  'dismisses and restores prefix/initial recurrence without changing raw source',
  async ({ prefix, initial }) => {
    const h = await smartHarness({ prefix }, { recurrence, reference, inbox: false, initial });
    const context = h.controller.snapshot().metadata?.context;
    h.controller.applyMetadataAction({ type: 'dismiss', role: 'recurrence' });
    const dismissed = h.controller.snapshot().metadata?.context;
    expect(dismissed?.type).toBe('ready');
    if (dismissed?.type === 'ready') expect(dismissed.metadata.recurrence).toBeUndefined();
    h.controller.applyMetadataAction({ type: 'restore' });
    expect(h.controller.snapshot().metadata?.context).toEqual(context);
    h.controller.applyMetadataAction({ type: 'dismiss', role: 'recurrence' });
    h.controller.setDraft('Call');
    await h.controller.submit('enter');
    const content = expectDefined(h.repositoryWrites[0]),
      root = h.readCanonicalRoot(content);
    expect(content).not.toContain('🔁');
    expect(root.recurrence).toBeUndefined();
    expect(root.markdownTitle).toBe('Call');
    expect(root.planning.due).toBe(prefix === '' ? '2026-10-16' : undefined);
  },
);

it('removes the exact canonical occurrence before source validation and saves literal dismissed natural text', async () => {
  const h = await capture();
  const raw = 'Call каждый день 🔁 every week';
  h.controller.setDraft(raw);
  h.controller.applyMetadataAction({ type: 'dismiss', role: 'recurrence' });
  expect(h.controller.snapshot().draft).toBe(raw);
  await h.controller.submit('enter');
  const content = expectDefined(h.repositoryWrites[0]),
    root = h.readCanonicalRoot(content);
  expect(root.markdownTitle).toBe('Call каждый день');
  expect(root.recurrence).toBeUndefined();
  expect(root.planning.due).toBeUndefined();
  expect(content).not.toContain('🔁');
});

it('preserves configured initial recurrence without inventing a date', async () => {
  const h = await smartHarness(
    {},
    {
      recurrence,
      reference,
      inbox: false,
      initial: { recurrence: { type: 'set', value: 'every week' } },
    },
  );
  h.controller.setDraft('Call');
  await h.controller.submit('enter');
  const root = h.readCanonicalRoot(expectDefined(h.repositoryWrites[0]));
  expect(root.markdownTitle).toBe('Call');
  expect(root.recurrence).toBe('every week');
  expect(root.planning.due).toBeUndefined();
});

it.each([
  {
    raw: 'Call every day at 08:00 ⏰ 10:00',
    title: 'Call at 08:00',
    due: '2026-10-13',
    time: '10:00',
  },
  {
    raw: 'Call every day at 10:00 ⏰ 08:00',
    title: 'Call at 10:00',
    due: '2026-10-14',
    time: '08:00',
  },
  { raw: 'Call every day ⏰ 08:00', title: 'Call', due: '2026-10-14', time: '08:00' },
  { raw: 'Call every day ⏰ 10:00', title: 'Call', due: '2026-10-13', time: '10:00' },
])(
  'uses the final canonical clock for recurrence phase: $raw',
  async ({ raw, title, due, time }) => {
    const h = await capture();
    h.controller.setDraft(raw);
    const before = h.controller.snapshot().metadata?.preview;
    expect(before).toMatchObject({
      type: 'valid',
      metadata: { markdownTitle: title, recurrence: 'every day', planning: { due, time } },
    });
    h.controller.applyMetadataAction({ type: 'dismiss', role: 'time' });
    const dismissed = h.controller.snapshot().metadata?.preview;
    expect(dismissed).toMatchObject({
      type: 'valid',
      metadata: { planning: { due: '2026-10-13' } },
    });
    if (dismissed?.type === 'valid') expect(dismissed.metadata.planning.time).toBeUndefined();
    h.controller.applyMetadataAction({ type: 'restore' });
    expect(h.controller.snapshot().metadata?.preview).toEqual(before);
    await h.controller.submit('enter');
    const root = h.readCanonicalRoot(expectDefined(h.repositoryWrites[0]));
    expect(root.markdownTitle).toBe(title);
    expect(root.recurrence).toBe('every day');
    expect(root.planning.due).toBe(due);
    expect(root.planning.time).toBe(time);
  },
);

it.each(['08:00', '09:00', '10:00'])(
  'uses the final context clock %s for recurrence phase and restores time dismissal',
  async (time) => {
    const h = await smartHarness(
      {},
      {
        recurrence,
        reference,
        inbox: false,
        initial: { time: { type: 'set', value: localTime(time) } },
      },
    );
    h.controller.setDraft('Call every day');
    const before = h.controller.snapshot().metadata?.preview;
    expect(before).toMatchObject({
      type: 'valid',
      metadata: {
        markdownTitle: 'Call',
        recurrence: 'every day',
        planning: { due: time === '10:00' ? '2026-10-13' : '2026-10-14', time },
      },
    });
    h.controller.applyMetadataAction({ type: 'dismiss', role: 'time' });
    expect(h.controller.snapshot().metadata?.preview).toMatchObject({
      type: 'valid',
      metadata: { planning: { due: '2026-10-13' } },
    });
    h.controller.applyMetadataAction({ type: 'restore' });
    expect(h.controller.snapshot().metadata?.preview).toEqual(before);
    await h.controller.submit('enter');
    const root = h.readCanonicalRoot(expectDefined(h.repositoryWrites[0]));
    expect(root.planning.time).toBe(time);
    expect(root.planning.due).toBe(time === '10:00' ? '2026-10-13' : '2026-10-14');
  },
);

// These exercise real preview, controller, application service and Markdown codec writes.
describe('final review recurrence persistence regressions', () => {
  it.each([
    ['1 и 15 числа каждого месяца', 'every month on the 1st and 15th'],
    ['каждый месяц 1 , 15 числа', 'every month on the 1st and 15th'],
    ['каждый месяц 1\t, 15 числа', 'every month on the 1st and 15th'],
    ['каждый месяц 1\u00a0, 15 числа', 'every month on the 1st and 15th'],
    ['1 , 15 числа каждого месяца', 'every month on the 1st and 15th'],
    ['1\t, 15 числа каждого месяца', 'every month on the 1st and 15th'],
    ['1\u00a0, 15 числа каждого месяца', 'every month on the 1st and 15th'],
    ['1, 15 числа каждого месяца', 'every month on the 1st and 15th'],
    ['1-го, 15-го и 25-го числа каждого месяца', 'every month on the 1st, 15th and 25th'],
  ])('saves the complete reverse monthly list: %s', async (phrase, rule) => {
    const h = await capture();
    const raw = `Call ${phrase}`;
    h.controller.setDraft(raw);
    expect(h.controller.snapshot().draft).toBe(raw);
    expect(h.controller.snapshot().metadata?.preview).toMatchObject({
      type: 'valid',
      metadata: { markdownTitle: 'Call', recurrence: rule, planning: { due: '2026-10-15' } },
    });
    await h.controller.submit('enter');
    const content = expectDefined(h.repositoryWrites[0]);
    expect(content).toContain(`🔁 ${rule}`);
    const root = h.readCanonicalRoot(content);
    expect(root.markdownTitle).toBe('Call');
    expect(root.recurrence).toBe(rule);
    expect(root.planning).toMatchObject({ due: '2026-10-15' });
    expect(root.planning.time).toBeUndefined();
  });
  const literal = [
    'Call 𝕒15 числа каждого месяца',
    'Call 𐐀15 числа каждого месяца',
    'Call 𝕒1, 15 числа каждого месяца',
    'Call 𐐀1 и 15 числа каждого месяца',
    'Call 1, 𝕒15 и 25 числа каждого месяца',
    'Call +1 , 15 числа каждого месяца',
    'Call -1\t, 15 числа каждого месяца',
    'Call every day not on Monday',
    'Позвонить каждый день не в понедельник',
    'Call every day - except Monday',
    'Позвонить каждый день - кроме воскресенья',
    'Call twice every day',
    'Позвонить два раза каждый день',
    'Call every day twice',
    'Позвонить каждый день два раза',
    'Call two times every day',
    'Call every day two times',
    'Call every day at 10:00 - not on Monday',
    'Позвонить каждый день в 10:00 - не в понедельник',
    'Call every day at 10:00 - except Monday',
    'Позвонить каждый день в 10:00 - кроме воскресенья',
    'Call every day at 10:00 twice',
    'Позвонить каждый день в 10:00 два раза',
    'Call 1 или 15 числа каждого месяца',
    'Call 0 и 15 числа каждого месяца',
    'Call -1 и 15 числа каждого месяца',
    'Call 1-3 и 15 числа каждого месяца',
  ];
  const planningCases = [
    { planning: 'none', due: undefined, suffix: '', titleSuffix: '' },
    { planning: 'canonical', due: '2026-10-16', suffix: ' 📅 2026-10-16', titleSuffix: '' },
    { planning: 'context', due: '2026-10-16', suffix: '', titleSuffix: '' },
    { planning: 'semicolon', due: '2026-10-14', suffix: '; call tomorrow', titleSuffix: '; call' },
  ];
  it.each(literal.flatMap((title) => planningCases.map((entry) => ({ title, ...entry }))))(
    'retains $title with $planning planning',
    async ({ title, planning, due, suffix, titleSuffix }) => {
      const initial =
        planning === 'context'
          ? { due: { type: 'set' as const, value: localDate('2026-10-16') } }
          : {};
      const raw = `${title}${suffix}`;
      const expectedTitle = `${title}${titleSuffix}`;
      const h = await smartHarness({}, { recurrence, reference, inbox: false, initial });
      h.controller.setDraft(raw);
      expect(h.controller.snapshot().draft).toBe(raw);
      const preview = h.controller.snapshot().metadata?.preview;
      expect(preview?.type).toBe('valid');
      if (preview?.type !== 'valid') throw new Error('Expected canonical preview');
      expect(preview.metadata.markdownTitle).toBe(expectedTitle);
      expect(preview.metadata.recurrence).toBeUndefined();
      expect(preview.metadata.planning.due).toBe(due);
      expect(preview.metadata.planning.time).toBeUndefined();
      await h.controller.submit('enter');
      const content = expectDefined(h.repositoryWrites[0]);
      expect(content).toContain(expectedTitle);
      expect(content).not.toContain('🔁');
      const root = h.readCanonicalRoot(content);
      expect(root.markdownTitle).toBe(expectedTitle);
      expect(root.recurrence).toBeUndefined();
      expect(root.planning.due).toBe(due);
      expect(root.planning.time).toBeUndefined();
    },
  );
});

describe('native identifier details preserve recurrence and first-date inference', () => {
  it.each([
    ['Каждый день — обновить wiki/daily', 'Обновить wiki/daily'],
    ['every day update release-weekly', 'update release-weekly'],
    ['every day inspect hooks/every', 'inspect hooks/every'],
    ['Каждый день — проверить шаблон-каждый', 'Проверить шаблон-каждый'],
    ['every day inspect 𝕒daily', 'inspect 𝕒daily'],
    ['every day inspect 𐐀weekly', 'inspect 𐐀weekly'],
    ['Каждый день — проверить 𝕒каждый', 'Проверить 𝕒каждый'],
    [
      'Каждый день — пить воду RECURRENCE-NATIVE-5867c992e42b4378833927833bbf79bd-q-ru-daily',
      'Пить воду RECURRENCE-NATIVE-5867c992e42b4378833927833bbf79bd-q-ru-daily',
    ],
  ])('saves the exact identifier detail in %s', async (raw, title) => {
    const h = await capture();
    h.controller.setDraft(raw);
    expect(h.controller.snapshot().draft).toBe(raw);
    expect(h.controller.snapshot().metadata?.preview).toMatchObject({
      type: 'valid',
      metadata: { markdownTitle: title, recurrence: 'every day', planning: { due: '2026-10-13' } },
    });
    expect(h.controller.snapshot().metadata?.projection?.recurrenceDateInferred).toBe(true);
    await h.controller.submit('enter');
    const content = expectDefined(h.repositoryWrites[0]);
    expect(content).toContain(title);
    expect(content).toContain('🔁 every day');
    const root = h.readCanonicalRoot(content);
    expect(root.markdownTitle).toBe(title);
    expect(root.recurrence).toBe('every day');
    expect(root.planning.due).toBe('2026-10-13');
    expect(root.planning.time).toBeUndefined();
  });
});
