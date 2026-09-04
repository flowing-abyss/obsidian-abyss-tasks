import { describe, expect, it } from 'vitest';
import {
  editRecurrenceIterationTaskLine,
  prepareRecurrenceIteration,
  recurrenceMarkerCountInOwnedSubtree,
  recurrenceOwnedSubtree,
} from '../../src/tasks/domain/recurrenceIteration';
import type { TaskPlanning } from '../../src/tasks/domain/types';
import { localDate, localTime } from '../../src/tasks/domain/validation';
import { stripTerminalBlockId } from '../../src/tasks/infrastructure/markdown/TaskBlockEditor';
import { TaskMarkdownCodec } from '../../src/tasks/infrastructure/markdown/TaskMarkdownCodec';
import { canonicalStatusCatalog } from '../helpers';

const codec = new TaskMarkdownCodec(canonicalStatusCatalog());

function planning(overrides: TaskPlanning = {}): TaskPlanning {
  return overrides;
}

describe('recurrence subtree contracts', () => {
  it('finds only the selected task and its structurally owned descendants', () => {
    const rootBlock = [
      '- [ ] Root',
      '  - [/] Owner 🔁 every day',
      '    - [ ] Child',
      '      - child note',
      '  - [ ] Sibling',
    ].join('\n');

    expect(recurrenceOwnedSubtree(rootBlock, 1)).toEqual({
      fromLine: 1,
      toLine: 3,
      taskLines: [1, 2],
    });
    expect(recurrenceMarkerCountInOwnedSubtree(rootBlock, 1)).toBe(1);
  });

  it.each([
    ['empty source', '', 0],
    ['non-task root', 'ordinary text', 0],
    ['non-integer owner line', '- [ ] Root', 0.5],
    ['sibling outside a root block', '- [ ] Root\n- [ ] Sibling', 0],
    ['mismatched quote depth', '> - [ ] Root\n  - [ ] Child', 0],
  ] as const)('rejects an invalid ownership boundary: %s', (_name, rootBlock, ownerLine) => {
    expect(recurrenceOwnedSubtree(rootBlock, ownerLine)).toBeUndefined();
    expect(recurrenceMarkerCountInOwnedSubtree(rootBlock, ownerLine)).toBeUndefined();
  });

  it('rejects a multi-character target status before mutating a recurrence line', () => {
    expect(
      editRecurrenceIterationTaskLine('- [/] Owner 🔁 every day', {
        type: 'clean-owner',
        planning: {},
        todoSymbol: 'xx',
        today: localDate('2026-08-01'),
        addCreatedDate: false,
      }),
    ).toEqual({ type: 'invalid', code: 'invalid-task-syntax' });
  });
});

describe('prepareRecurrenceIteration', () => {
  it('uses the canonical start marker when replacing and shifting start dates', () => {
    expect(
      prepareRecurrenceIteration({
        rootBlock: '- [/] Owner 🔁 every day 🛫 2026-08-02\n  - [x] Child 🛫 2026-08-03',
        ownerRelativeLine: 0,
        nextPlanning: { start: localDate('2026-08-09') },
        dayDelta: 7,
        doneSymbol: 'x',
        todoSymbol: ' ',
        today: localDate('2026-08-01'),
        addCreatedDate: false,
        addCompletionDate: true,
      }),
    ).toMatchObject({
      type: 'prepared',
      cleanSubtree: '- [ ] Owner 🔁 every day 🛫 2026-08-09\n  - [ ] Child 🛫 2026-08-10',
    });
  });

  it('inserts multiple missing planning carriers in canonical order', () => {
    expect(
      prepareRecurrenceIteration({
        rootBlock: '- [/] Owner 🔁 every day',
        ownerRelativeLine: 0,
        nextPlanning: {
          start: localDate('2026-08-09'),
          scheduled: localDate('2026-08-10'),
          due: localDate('2026-08-11'),
          time: localTime('09:30'),
          duration: 90 as NonNullable<TaskPlanning['duration']>,
        },
        dayDelta: 7,
        doneSymbol: 'x',
        todoSymbol: ' ',
        today: localDate('2026-08-01'),
        addCreatedDate: true,
        addCompletionDate: true,
      }),
    ).toMatchObject({
      type: 'prepared',
      cleanSubtree:
        '- [ ] Owner ⏰ 09:30 ⏱️ 1h30m 🔁 every day ➕ 2026-08-01 🛫 2026-08-09 ⏳ 2026-08-10 📅 2026-08-11',
    });
  });

  it.each(['⏫', '#project/repeat'])(
    'preserves a %s token after the recurrence value using codec boundaries',
    (token) => {
      expect(
        prepareRecurrenceIteration({
          rootBlock: `- [/] Owner 🔁 every day ${token} 📅 2026-08-02`,
          ownerRelativeLine: 0,
          nextPlanning: { due: localDate('2026-08-09') },
          dayDelta: 7,
          doneSymbol: 'x',
          todoSymbol: ' ',
          today: localDate('2026-08-01'),
          addCreatedDate: false,
          addCompletionDate: true,
        }),
      ).toMatchObject({
        type: 'prepared',
        cleanSubtree: `- [ ] Owner 🔁 every day ${token} 📅 2026-08-09`,
      });
    },
  );

  it('prepares one clean nested occurrence without altering non-identity prose', () => {
    const rootBlock = [
      '> - [ ] Root shell ^root-block',
      '>   - > Root description stays outside ^root-description',
      '>   - [/] Ship [[Plan|roadmap]] ![[diagram.png]] [spec](https://example.com/a_(b)) #project/repeat ⏫ 🔁 every week 🏁 keep ➕ 2026-07-01 🛫 2026-08-02 ⏳ 2026-08-03 📅 2026-08-04 ✅ 2026-07-30 ❌ 2026-07-31 ⏰ 09:30 ⏱️ 1h30m 🆔 owner-id ⛔ prep-one,prep-two ^owner-block',
      '>     - > Description keeps ^middle caret, [[link]], #tag, and ![[asset.pdf]] ^description-block',
      '>     - 2026-08-01: Dated comment keeps 2026-08-04 and 🆔 prose ^comment-block',
      '>     - Ordinary list keeps [brackets], ^middle, and ⛔ prose ^ordinary-block',
      '>     - [x] Child [label](https://example.com) #child 🔽 ➕ 2026-07-02 🛫 2026-08-10 ⏳ 2026-08-11 📅 2026-08-12 ✅ 2026-08-13 ⏰ 14:15 ⏱️ 45m 🆔 child-id ⛔ owner-id ^child-block',
      '>       - [-] Grandchild ![[deep.png]] ➕ 2026-07-03 📅 2026-08-31 ❌ 2026-08-14 🆔 grand-id ^grand-block',
      '>         - > Deep description byte-for-byte except id ^deep-description',
      '>   - [ ] Sibling stays outside 🆔 sibling-id ^sibling-block',
    ].join('\r\n');

    expect(
      prepareRecurrenceIteration({
        rootBlock,
        ownerRelativeLine: 2,
        nextPlanning: planning({
          start: localDate('2026-08-09'),
          scheduled: localDate('2026-08-10'),
          due: localDate('2026-08-11'),
          time: localTime('09:30'),
          duration: 90 as NonNullable<TaskPlanning['duration']>,
        }),
        dayDelta: 7,
        doneSymbol: 'x',
        todoSymbol: ' ',
        today: localDate('2026-08-01'),
        addCreatedDate: true,
        addCompletionDate: true,
      }),
    ).toEqual({
      type: 'prepared',
      cleanSubtree: [
        '>   - [ ] Ship [[Plan|roadmap]] ![[diagram.png]] [spec](https://example.com/a_(b)) #project/repeat ⏫ 🔁 every week 🏁 keep ➕ 2026-08-01 🛫 2026-08-09 ⏳ 2026-08-10 📅 2026-08-11 ⏰ 09:30 ⏱️ 1h30m',
        '>     - > Description keeps ^middle caret, [[link]], #tag, and ![[asset.pdf]]',
        '>     - 2026-08-01: Dated comment keeps 2026-08-04 and 🆔 prose',
        '>     - Ordinary list keeps [brackets], ^middle, and ⛔ prose',
        '>     - [ ] Child [label](https://example.com) #child 🔽 ➕ 2026-08-01 🛫 2026-08-17 ⏳ 2026-08-18 📅 2026-08-19 ⏰ 14:15 ⏱️ 45m',
        '>       - [ ] Grandchild ![[deep.png]] ➕ 2026-08-01 📅 2026-09-07',
        '>         - > Deep description byte-for-byte except id',
      ].join('\r\n'),
      completedSubtree: [
        '>   - [x] Ship [[Plan|roadmap]] ![[diagram.png]] [spec](https://example.com/a_(b)) #project/repeat ⏫ 🔁 every week 🏁 keep ➕ 2026-07-01 🛫 2026-08-02 ⏳ 2026-08-03 📅 2026-08-04 ✅ 2026-08-01 ⏰ 09:30 ⏱️ 1h30m 🆔 owner-id ⛔ prep-one,prep-two ^owner-block',
        '>     - > Description keeps ^middle caret, [[link]], #tag, and ![[asset.pdf]] ^description-block',
        '>     - 2026-08-01: Dated comment keeps 2026-08-04 and 🆔 prose ^comment-block',
        '>     - Ordinary list keeps [brackets], ^middle, and ⛔ prose ^ordinary-block',
        '>     - [x] Child [label](https://example.com) #child 🔽 ➕ 2026-07-02 🛫 2026-08-10 ⏳ 2026-08-11 📅 2026-08-12 ✅ 2026-08-13 ⏰ 14:15 ⏱️ 45m 🆔 child-id ⛔ owner-id ^child-block',
        '>       - [-] Grandchild ![[deep.png]] ➕ 2026-07-03 📅 2026-08-31 ❌ 2026-08-14 🆔 grand-id ^grand-block',
        '>         - > Deep description byte-for-byte except id ^deep-description',
      ].join('\r\n'),
    });
  });

  it('removes recursive created dates when disabled and changes only owner lifecycle history', () => {
    const rootBlock = [
      '- [/] Owner 🔁 every day ➕ 2026-07-01 ✅ 2026-07-20 🆔 owner-id ^owner-block',
      '  - [x] Child ➕ 2026-07-02 ✅ 2026-07-21 🆔 child-id ^child-block',
    ].join('\n');

    expect(
      prepareRecurrenceIteration({
        rootBlock,
        ownerRelativeLine: 0,
        nextPlanning: {},
        dayDelta: 0,
        doneSymbol: 'x',
        todoSymbol: ' ',
        today: localDate('2026-08-01'),
        addCreatedDate: false,
        addCompletionDate: false,
      }),
    ).toEqual({
      type: 'prepared',
      cleanSubtree: '- [ ] Owner 🔁 every day\n  - [ ] Child',
      completedSubtree:
        '- [x] Owner 🔁 every day ➕ 2026-07-01 🆔 owner-id ^owner-block\n' +
        '  - [x] Child ➕ 2026-07-02 ✅ 2026-07-21 🆔 child-id ^child-block',
    });
  });

  it.each([
    ['enabled', true, '- [x] Owner 🔁 every day ✅ 2026-07-01'],
    ['disabled', false, '- [x] Owner 🔁 every day ✅ 2026-07-01'],
    ['case-equivalent Done symbol', true, '- [X] Owner 🔁 every day ✅ 2026-07-01'],
  ])('preserves the first Done stamp when completion dates are %s', (_name, enabled, rootBlock) => {
    const result = prepareRecurrenceIteration({
      rootBlock,
      ownerRelativeLine: 0,
      nextPlanning: {},
      dayDelta: 1,
      doneSymbol: 'x',
      todoSymbol: ' ',
      today: localDate('2026-08-01'),
      addCreatedDate: false,
      addCompletionDate: enabled,
    });

    expect(result).toMatchObject({
      type: 'prepared',
      completedSubtree: '- [x] Owner 🔁 every day ✅ 2026-07-01',
    });
  });

  it.each([
    [true, '- [x] Owner 🔁 every day ✅ 2026-08-01'],
    [false, '- [x] Owner 🔁 every day'],
  ])(
    'clears cancellation history when completing with completion dates %s',
    (enabled, expected) => {
      const result = prepareRecurrenceIteration({
        rootBlock: '- [-] Owner 🔁 every day ❌ 2026-07-01',
        ownerRelativeLine: 0,
        nextPlanning: {},
        dayDelta: 1,
        doneSymbol: 'x',
        todoSymbol: ' ',
        today: localDate('2026-08-01'),
        addCreatedDate: false,
        addCompletionDate: enabled,
      });

      expect(result).toMatchObject({ type: 'prepared', completedSubtree: expected });
    },
  );

  it('removes every task identity carrier from the clean copy', () => {
    expect(
      prepareRecurrenceIteration({
        rootBlock:
          '- [/] Owner 🔁 every day 🆔 first 🆔 second ⛔ before ⛔ after\n' +
          '  - [ ] Child 🆔 child-one 🆔 child-two ⛔ owner ⛔ sibling',
        ownerRelativeLine: 0,
        nextPlanning: {},
        dayDelta: 1,
        doneSymbol: 'x',
        todoSymbol: ' ',
        today: localDate('2026-08-01'),
        addCreatedDate: false,
        addCompletionDate: true,
      }),
    ).toMatchObject({
      type: 'prepared',
      cleanSubtree: '- [ ] Owner 🔁 every day\n  - [ ] Child',
    });
  });

  it.each([
    ['ancestor', ['- [ ] Root 🔁 every month', '  - [/] Owner 🔁 every day'].join('\n'), 1],
    ['descendant malformed marker', ['- [/] Owner 🔁 every day', '  - [ ] Child 🔁'].join('\n'), 0],
    [
      'sibling empty marker',
      ['- [ ] Root', '  - [/] Owner 🔁 every day', '  - [ ] Sibling 🔁'].join('\n'),
      1,
    ],
    ['same task', '- [/] Owner 🔁 every day 🔁 every week', 0],
  ])('rejects a second recurrence marker on the %s', (_name, rootBlock, ownerRelativeLine) => {
    expect(
      prepareRecurrenceIteration({
        rootBlock,
        ownerRelativeLine,
        nextPlanning: {},
        dayDelta: 0,
        doneSymbol: 'x',
        todoSymbol: ' ',
        today: localDate('2026-08-01'),
        addCreatedDate: true,
        addCompletionDate: true,
      }),
    ).toEqual({ type: 'invalid', code: 'nested-recurrence-conflict' });
  });

  it.each([
    ['zero markers', '- [/] Owner', 0],
    [
      'ancestor marker borrowed by a nested owner',
      ['- [ ] Root 🔁 every day', '  - [/] Owner'].join('\n'),
      1,
    ],
    [
      'sibling marker borrowed by a nested owner',
      ['- [ ] Root', '  - [/] Owner', '  - [ ] Sibling 🔁 every day'].join('\n'),
      1,
    ],
  ])(
    'requires the selected owner to own the one semantic recurrence marker: %s',
    (_name, rootBlock, ownerRelativeLine) => {
      expect(
        prepareRecurrenceIteration({
          rootBlock,
          ownerRelativeLine,
          nextPlanning: {},
          dayDelta: 0,
          doneSymbol: 'x',
          todoSymbol: ' ',
          today: localDate('2026-08-01'),
          addCreatedDate: true,
          addCompletionDate: true,
        }),
      ).toEqual({ type: 'invalid', code: 'nested-recurrence-conflict' });
    },
  );

  it('ignores protected recurrence markers when enforcing owner recurrence semantics', () => {
    expect(
      prepareRecurrenceIteration({
        rootBlock: '- [/] Owner 🔁 every day `🔁 every week` [marker 🔁](https://example.com)',
        ownerRelativeLine: 0,
        nextPlanning: {},
        dayDelta: 0,
        doneSymbol: 'x',
        todoSymbol: ' ',
        today: localDate('2026-08-01'),
        addCreatedDate: false,
        addCompletionDate: true,
      }),
    ).toMatchObject({
      type: 'prepared',
      cleanSubtree: '- [ ] Owner 🔁 every day `🔁 every week` [marker 🔁](https://example.com)',
    });
  });

  it.each([
    {
      name: 'date punctuation',
      rootBlock: '- [/] Owner 🔁 every day 📅 2026-08-02.',
      nextPlanning: { due: localDate('2026-08-09') },
      cleanSubtree: '- [ ] Owner 🔁 every day 📅 2026-08-09.',
    },
    {
      name: 'time punctuation',
      rootBlock: '- [/] Owner 🔁 every day ⏰ 09:30,',
      nextPlanning: { time: localTime('09:30') },
      cleanSubtree: '- [ ] Owner 🔁 every day ⏰ 09:30,',
    },
  ])('uses the codec source model for $name', ({ rootBlock, nextPlanning, cleanSubtree }) => {
    expect(codec.validateLine(rootBlock)).toEqual([]);
    expect(
      prepareRecurrenceIteration({
        rootBlock,
        ownerRelativeLine: 0,
        nextPlanning,
        dayDelta: 7,
        doneSymbol: 'x',
        todoSymbol: ' ',
        today: localDate('2026-08-01'),
        addCreatedDate: false,
        addCompletionDate: true,
      }),
    ).toMatchObject({ type: 'prepared', cleanSubtree });
  });

  it('rejects malformed task dates before returning either candidate', () => {
    const rootBlock = [
      '- [/] Owner 🔁 every day 📅 2026-08-01',
      '  - [ ] Child 📅 2026-02-30',
    ].join('\n');

    expect(
      prepareRecurrenceIteration({
        rootBlock,
        ownerRelativeLine: 0,
        nextPlanning: { due: localDate('2026-08-02') },
        dayDelta: 1,
        doneSymbol: 'x',
        todoSymbol: ' ',
        today: localDate('2026-08-01'),
        addCreatedDate: true,
        addCompletionDate: true,
      }),
    ).toEqual({ type: 'invalid', code: 'invalid-task-syntax' });
  });

  it.each(['🆔', '⛔'])(
    'rejects an empty %s identity carrier before returning candidates',
    (marker) => {
      expect(
        prepareRecurrenceIteration({
          rootBlock: `- [/] Owner 🔁 every day ${marker}`,
          ownerRelativeLine: 0,
          nextPlanning: {},
          dayDelta: 1,
          doneSymbol: 'x',
          todoSymbol: ' ',
          today: localDate('2026-08-01'),
          addCreatedDate: true,
          addCompletionDate: true,
        }),
      ).toEqual({ type: 'invalid', code: 'invalid-task-syntax' });
    },
  );

  it('rejects an inverted source span before returning either candidate', () => {
    expect(
      prepareRecurrenceIteration({
        rootBlock: '- [/] Owner 🔁 every day 🛫 2026-08-03 📅 2026-08-02',
        ownerRelativeLine: 0,
        nextPlanning: {
          start: localDate('2026-08-04'),
          due: localDate('2026-08-05'),
        },
        dayDelta: 1,
        doneSymbol: 'x',
        todoSymbol: ' ',
        today: localDate('2026-08-01'),
        addCreatedDate: true,
        addCompletionDate: true,
      }),
    ).toEqual({ type: 'invalid', code: 'invalid-task-syntax' });
  });

  it('rejects an inverted next-occurrence span', () => {
    expect(
      prepareRecurrenceIteration({
        rootBlock: '- [/] Owner 🔁 every day 🛫 2026-08-01 📅 2026-08-02',
        ownerRelativeLine: 0,
        nextPlanning: {
          start: localDate('2026-08-05'),
          due: localDate('2026-08-04'),
        },
        dayDelta: 1,
        doneSymbol: 'x',
        todoSymbol: ' ',
        today: localDate('2026-08-01'),
        addCreatedDate: true,
        addCompletionDate: true,
      }),
    ).toEqual({ type: 'invalid', code: 'invalid-descendant-date' });
  });

  it('rejects a descendant date that cannot be shifted safely', () => {
    const rootBlock = [
      '- [/] Owner 🔁 every day 📅 9999-12-30',
      '  - [ ] Child 📅 9999-12-31',
    ].join('\n');

    expect(
      prepareRecurrenceIteration({
        rootBlock,
        ownerRelativeLine: 0,
        nextPlanning: { due: localDate('9999-12-31') },
        dayDelta: 1,
        doneSymbol: 'x',
        todoSymbol: ' ',
        today: localDate('2026-08-01'),
        addCreatedDate: true,
        addCompletionDate: true,
      }),
    ).toEqual({ type: 'invalid', code: 'invalid-descendant-date' });
  });

  it('rejects a relative owner line that is not an owned task', () => {
    expect(
      prepareRecurrenceIteration({
        rootBlock: '- [ ] Root\n  - ordinary list item',
        ownerRelativeLine: 1,
        nextPlanning: {},
        dayDelta: 0,
        doneSymbol: 'x',
        todoSymbol: ' ',
        today: localDate('2026-08-01'),
        addCreatedDate: true,
        addCompletionDate: true,
      }),
    ).toEqual({ type: 'invalid', code: 'invalid-task-syntax' });
  });
});

describe('stripTerminalBlockId', () => {
  it('removes only a whitespace-delimited terminal block ID', () => {
    expect(stripTerminalBlockId('  - prose ^middle remains ^terminal\r')).toBe(
      '  - prose ^middle remains\r',
    );
    expect(stripTerminalBlockId('  - prose^not-a-block')).toBe('  - prose^not-a-block');
    expect(stripTerminalBlockId('  - prose ^middle remains')).toBe('  - prose ^middle remains');
  });
});
