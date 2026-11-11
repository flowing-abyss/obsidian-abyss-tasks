import type { EvalCase } from './corpus';
import { files, tree } from './fixtures';
import type { TurnExpectation } from './oracles';

interface PairedTurn {
  en: string;
  ru: string;
  expect: TurnExpectation;
}

const inboxTag = '#task/inbox';

function pair(
  { id, family, split }: Pick<EvalCase, 'id' | 'family' | 'split'>,
  source: string,
  ...turns: PairedTurn[]
): EvalCase[] {
  return (['en', 'ru'] as const).map((language) => ({
    id: `${id}-${language}`,
    bilingual: { pair: id, language },
    family,
    split,
    files: files(source),
    behavior: {
      taskPrefix: '',
      inbox: { mode: 'tag', tag: inboxTag, removeTagOnAssign: true },
    },
    turns: turns.map((turn) => ({ text: turn[language], expect: turn.expect })),
  }));
}

function preview(
  changed: unknown,
  publicTrees: readonly unknown[],
  source: string,
  extra: Partial<TurnExpectation> = {},
): TurnExpectation {
  return {
    status: 'ready',
    trees: [changed],
    publicTrees,
    inboxMembers: [false],
    proposalKinds: ['task'],
    taskPlanKinds: ['create'],
    freshPreparation: true,
    writeCount: 0,
    files: { 'a.md': source },
    ...extra,
  };
}

function unchanged(
  trees: readonly unknown[],
  source: string,
  focus?: TurnExpectation['focus'],
): TurnExpectation {
  return {
    status: 'ready',
    trees,
    publicTrees: trees,
    inboxMembers: trees.map(() => false),
    ...(focus === undefined ? {} : { focus }),
    proposalKinds: [],
    taskSources: [],
    writeCount: 0,
    files: { 'a.md': source },
  };
}

function committed(
  trees: readonly unknown[],
  source: string,
  inboxMembers: readonly boolean[] = trees.map(() => false),
): TurnExpectation {
  return {
    status: 'saved',
    trees,
    publicTrees: trees,
    inboxMembers,
    proposalKinds: [],
    retainPreviousTasks: true,
    writeCount: 1,
    createdFiles: [],
    files: { 'a.md': source },
  };
}

const position = (line: number) => ({ path: 'a.md', line });
const due = { dates: { due: '2026-11-20' } };
const vega = tree('Vega', { tags: ['#work'], source: position(0) });
const vegaSource = '- [ ] Vega #work\n';
const secondVega = tree('Vega', { ...due, source: position(1) });
const changedVega = { ...vega, ...due };
const editBasis = { taskPlanKinds: ['edit'], taskSources: [{ ...position(0), kind: 'edit' }] };
const orbit = (changed: boolean) =>
  tree('Orbit', {
    children: [tree('Echo', { tags: ['#keep'] }), tree('Echo', changed ? due : {})],
  });
const orbitSource = '- [ ] Orbit\n  - [ ] Echo #keep\n  - [ ] Echo\n';
const originalOrbit = { ...orbit(false), source: position(0) };
const changedOrbit = { ...orbit(true), source: position(0) };

function captureOrion(inbox: boolean): PairedTurn[] {
  const orion = (time: string) =>
    tree('Orion', { dates: { scheduled: '2026-11-11' }, time, tags: inbox ? [inboxTag] : [] });
  const tagSuffix = inbox ? ` ${inboxTag}` : '';
  return [
    {
      en: inbox
        ? 'Make a task called Orion in my Inbox for tomorrow at ten in the morning.'
        : 'Make a task called Orion for tomorrow at ten in the morning.',
      ru: inbox
        ? 'Заведи во входящих задачу «Orion» на завтра, на десять утра.'
        : 'Заведи задачу «Orion» на завтра, на десять утра.',
      expect: preview(orion('10:00'), [], '', { inboxMembers: [inbox] }),
    },
    {
      en: 'Actually, make it half past eleven. Keep the same day.',
      ru: 'Лучше на половину двенадцатого. День оставь тот же.',
      expect: preview(orion('11:30'), [], '', { inboxMembers: [inbox], retainPreviousTasks: true }),
    },
    {
      en: 'Save it.',
      ru: 'Сохрани её.',
      expect: committed(
        [{ ...orion('11:30'), source: position(0) }],
        `- [ ] Orion${tagSuffix} ⏰ 11:30 ⏳ 2026-11-11`,
        [inbox],
      ),
    },
  ];
}

function reviseSaved(changed: unknown, original: unknown, source: string, previous = true) {
  return preview(changed, [original], source, {
    taskPlanKinds: ['edit'],
    taskSources: [{ ...position(1), kind: 'edit' }],
    retainPreviousTasks: previous,
  });
}

const relaySource = [
  '# Handoff',
  '- [ ] Relay #team',
  '  - > Keep [[Roster]].',
  '  - [ ] North #keep',
  '    - Keep [manifest](https://example.org/m).',
  '  - [ ] South 📅 2026-11-20',
  '    - > Dock 4.',
  '    - Filed.',
  '  - [ ] Reserve',
  '    - [ ] Seal #hold',
  'Protected footer.',
  '',
].join('\n');
function relay(north: string[], south: string, details: string, deadline: string) {
  return tree('Relay', {
    tags: ['#team'],
    description: 'Keep [[Roster]].',
    children: [
      tree('North', {
        tags: ['#keep'],
        comments: ['Keep [manifest](https://example.org/m).', ...north].map((text) => ({ text })),
      }),
      tree('South', {
        dates: { due: deadline },
        description: details,
        comments: [{ text: south }],
      }),
      tree('Reserve', { children: [tree('Seal', { tags: ['#hold'] })] }),
    ],
  });
}
const relayDeadline = '2026-11-20';
const originalRelay = { ...relay([], 'Filed.', 'Dock 4.', relayDeadline), source: position(1) };
const correctedRelay = relay([], 'Call Lee.', 'Dock 7.', '2026-11-23');

const dispatchSource = [
  '# Shipping',
  '- [ ] Dispatch',
  '  - [ ] Proof #north 📅 2026-11-18',
  '    - Keep north.',
  '  - [ ] Proof #south ⏳ 2026-11-12 📅 2026-11-25',
  '    - Keep south.',
  'Protected footer.',
  '',
].join('\n');
function dispatch(northDeadline: string, southDeadline: string) {
  return tree('Dispatch', {
    children: [
      tree('Proof', {
        tags: ['#north'],
        dates: { due: northDeadline },
        comments: [{ text: 'Keep north.' }],
      }),
      tree('Proof', {
        tags: ['#south'],
        dates: { scheduled: '2026-11-12', due: southDeadline },
        comments: [{ text: 'Keep south.' }],
      }),
    ],
  });
}
const northDeadline = '2026-11-18';
const southDeadline = '2026-11-25';
const mistakenDeadline = '2026-11-21';
const originalDispatch = { ...dispatch(northDeadline, southDeadline), source: position(1) };
const correctedDispatch = dispatch(northDeadline, '2026-11-24');

// Identical proper names and literals keep command language as the only variable within each pair.
export const bilingualCases: readonly EvalCase[] = [
  ...pair(
    { id: 'B01', family: 'bilingual-capture', split: 'development' },
    '',
    ...captureOrion(false),
  ),
  ...pair(
    { id: 'B02', family: 'bilingual-context', split: 'development' },
    vegaSource,
    {
      en: 'Bring the existing Vega task into context.',
      ru: 'Добавь существующую задачу «Vega» в контекст.',
      expect: unchanged([vega], vegaSource, [{ kind: 'task', ...position(0) }]),
    },
    {
      en: 'Give that task a deadline of November 20.',
      ru: 'Поставь ей дедлайн на 20 ноября.',
      expect: preview(tree('Vega', { tags: ['#work'], ...due }), [vega], vegaSource, editBasis),
    },
    {
      en: 'Save the change.',
      ru: 'Сохрани изменение.',
      expect: committed([changedVega], '- [ ] Vega #work 📅 2026-11-20\n'),
    },
  ),
  ...pair(
    { id: 'B03', family: 'bilingual-duplicate', split: 'held-out' },
    vegaSource,
    {
      en: 'Make another task named Vega. Keep the existing one as it is.',
      ru: 'Заведи ещё одну задачу с названием «Vega». Старую оставь как есть.',
      expect: preview(tree('Vega'), [vega], vegaSource),
    },
    {
      en: 'Set a deadline of November 20 on the new one.',
      ru: 'Новой поставь дедлайн на 20 ноября.',
      expect: preview(tree('Vega', due), [vega], vegaSource, { retainPreviousTasks: true }),
    },
    {
      en: 'Save the new task.',
      ru: 'Запиши новую задачу.',
      expect: committed([vega, secondVega], '- [ ] Vega #work\n- [ ] Vega 📅 2026-11-20\n'),
    },
  ),
  ...pair(
    { id: 'B04', family: 'bilingual-nested', split: 'held-out' },
    orbitSource,
    {
      en: 'Under Orbit there are two subtasks called Echo. Select the second one.',
      ru: 'У «Orbit» две подзадачи «Echo». Выбери вторую.',
      expect: unchanged([originalOrbit], orbitSource, [{ kind: 'task', ...position(2) }]),
    },
    {
      en: 'Set its deadline to November 20.',
      ru: 'Поставь ей дедлайн на 20 ноября.',
      expect: preview(orbit(true), [originalOrbit], orbitSource, editBasis),
    },
    {
      en: 'Save that change.',
      ru: 'Сохрани это изменение.',
      expect: committed(
        [changedOrbit],
        '- [ ] Orbit\n  - [ ] Echo #keep\n  - [ ] Echo 📅 2026-11-20\n',
      ),
    },
  ),
  ...pair(
    { id: 'B05', family: 'bilingual-cancel', split: 'held-out' },
    '',
    {
      en: 'Draft a task called Sirius.',
      ru: 'Подготовь задачу «Sirius».',
      expect: preview(tree('Sirius'), [], ''),
    },
    {
      en: 'I changed my mind. Discard that draft.',
      ru: 'Я передумал. Отмени этот черновик.',
      expect: unchanged([], ''),
    },
    {
      en: 'Make a new task called Lyra instead.',
      ru: 'Создай вместо неё новую задачу «Lyra».',
      expect: preview(tree('Lyra'), [], ''),
    },
    {
      en: 'Save Lyra.',
      ru: 'Сохрани «Lyra».',
      expect: committed([tree('Lyra', { source: position(0) })], '- [ ] Lyra'),
    },
  ),
  ...pair({ id: 'B06', family: 'bilingual-inbox', split: 'held-out' }, '', ...captureOrion(true)),
  ...pair(
    { id: 'C01', family: 'correction-chain', split: 'development' },
    relaySource,
    {
      en: 'On Relay, put “Call Jo.” in a new comment on North. Let me see it first.',
      ru: 'В «Relay» добавь к подзадаче «North» комментарий «Call Jo.». Сначала покажи.',
      expect: reviseSaved(
        relay(['Call Jo.'], 'Filed.', 'Dock 4.', relayDeadline),
        originalRelay,
        relaySource,
        false,
      ),
    },
    {
      en: 'No, take that off North. I meant South! Put “Call Jo.” in place of its “Filed.” comment.',
      ru: 'Нет, убери это у «North». Я имел в виду «South»! У неё вместо комментария «Filed.» напиши «Call Jo.».',
      expect: reviseSaved(
        relay([], 'Call Jo.', 'Dock 4.', relayDeadline),
        originalRelay,
        relaySource,
      ),
    },
    {
      en: 'I got the name wrong too. Make that comment “Call Lee.” and change South’s description to “Dock 7.”.',
      ru: 'И с именем я ошибся. Исправь этот комментарий на «Call Lee.», а описание у «South» замени на «Dock 7.».',
      expect: reviseSaved(
        relay([], 'Call Lee.', 'Dock 7.', relayDeadline),
        originalRelay,
        relaySource,
      ),
    },
    {
      en: 'Oh, and the deadline for South is November 23. Everything else looks right.',
      ru: 'А, и дедлайн у «South» всё-таки 23 ноября. С остальным всё в порядке.',
      expect: reviseSaved(correctedRelay, originalRelay, relaySource),
    },
    {
      en: 'Yes, save this version.',
      ru: 'Да, сохрани в таком виде.',
      expect: committed(
        [{ ...correctedRelay, source: position(1) }],
        relaySource
          .replace(relayDeadline, '2026-11-23')
          .replace('Dock 4.', 'Dock 7.')
          .replace('Filed.', 'Call Lee.'),
      ),
    },
  ),
  ...pair(
    { id: 'C02', family: 'correction-chain', split: 'held-out' },
    dispatchSource,
    {
      en: 'Set the deadline on Proof to November 21.',
      ru: 'Поставь «Proof» дедлайн на 21 ноября.',
      expect: {
        ...unchanged([originalDispatch], dispatchSource, []),
        status: 'question',
        questionIncludes: 'Proof',
      },
    },
    {
      en: 'The first one, the one tagged #north.',
      ru: 'Первой, той, что с тегом #north.',
      expect: reviseSaved(
        dispatch(mistakenDeadline, southDeadline),
        originalDispatch,
        dispatchSource,
        false,
      ),
    },
    {
      en: 'Hang on, I had them backwards. Put the first one’s old deadline back. The 21st was for the second one.',
      ru: 'Стоп, я их перепутал. Первой верни прежний дедлайн. 21-е было для второй.',
      expect: reviseSaved(
        dispatch(northDeadline, mistakenDeadline),
        originalDispatch,
        dispatchSource,
      ),
    },
    {
      en: 'Make that the 24th instead. Leave its scheduled day alone.',
      ru: 'Лучше всё-таки на 24-е. День, на который она запланирована, не трогай.',
      expect: reviseSaved(correctedDispatch, originalDispatch, dispatchSource),
    },
    {
      en: 'That’s right. Save the correction.',
      ru: 'Теперь верно. Сохрани исправление.',
      expect: committed(
        [{ ...correctedDispatch, source: position(1) }],
        dispatchSource.replace(southDeadline, '2026-11-24'),
      ),
    },
  ),
];
