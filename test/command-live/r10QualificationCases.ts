/** Two new post-freeze held-out R10 command-live qualification cases. */
import type { EvalCase } from './corpus';
import { files, tree } from './fixtures';

const mechanicalLog =
  '# Mechanical room log\n' +
  'The north gauge was checked before the west-wing work.\n' +
  '- [ ] Calibrate the north pressure gauge #boiler ⏳ 2027-01-08 📅 2027-01-21\n' +
  '  - [ ] Record the brass dial reading\n' +
  '\n' +
  'The west-wing inspection was copied from the service card.\n' +
  '- [ ] Calibrate the north pressure gauge #boiler ⏳ 2027-01-10 📅 2027-01-26\n';
const mechanicalControl =
  '---\nprotected: true\n---\n# Control\r\n- [ ] Untouched [unknown:: keep] #control\r\n';
const mechanicalIndex = '# Index\r\nRetain this line exactly.\r\n';

const firstDraft = tree('Подготовить паспорт вентилятора', {
  tags: ['#механика'],
  dates: { due: '2027-02-14' },
  children: [
    tree('Сверить серийный номер с шильдиком', {
      comments: [{ text: 'Не отклеивать бирку перед осмотром.' }],
    }),
  ],
});
const refinedFirstDraft = tree('Подготовить паспорт вентилятора', {
  tags: ['#механика'],
  dates: { due: '2027-02-16' },
  children: [
    tree('Сверить серийный номер с шильдиком', {
      comments: [{ text: 'Не отклеивать бирку перед осмотром.' }],
    }),
  ],
});
const secondDraft = tree('Заказать уплотнения для коллектора', {
  tags: ['#закупки'],
  dates: { scheduled: '2027-02-19' },
  children: [tree('Проверить диаметр резьбы по чертежу')],
});
const savedFirst = {
  ...refinedFirstDraft,
  source: { path: 'a.md', line: 1 },
};
const savedSecond = {
  ...secondDraft,
  source: { path: 'a.md', line: 4 },
};

export const r10QualificationCases: readonly EvalCase[] = [
  {
    id: 'r10-fresh-sparse-line-en',
    family: 'r10-fresh-command-live-owner-coordinate',
    split: 'held-out',
    files: files('# Inbox\n', {
      'records/Mechanical room.md': mechanicalLog,
      'notes/Log index.md': mechanicalIndex,
    }),
    turns: [
      {
        text: 'In “records/Mechanical room.md”, move “Calibrate the north pressure gauge” to January 15, 2027. Keep its tag and current deadline. Show me a preview before saving.',
        expect: {
          status: 'question',
          questionIncludes: 'Calibrate the north pressure gauge',
          trees: [
            tree('Calibrate the north pressure gauge', {
              tags: ['#boiler'],
              dates: { scheduled: '2027-01-08', due: '2027-01-21' },
              children: [tree('Record the brass dial reading')],
              source: { path: 'records/Mechanical room.md', line: 2 },
            }),
            tree('Calibrate the north pressure gauge', {
              tags: ['#boiler'],
              dates: { scheduled: '2027-01-10', due: '2027-01-26' },
              source: { path: 'records/Mechanical room.md', line: 6 },
            }),
          ],
          publicTrees: [
            tree('Calibrate the north pressure gauge', {
              tags: ['#boiler'],
              dates: { scheduled: '2027-01-08', due: '2027-01-21' },
              children: [tree('Record the brass dial reading')],
              source: { path: 'records/Mechanical room.md', line: 2 },
            }),
            tree('Calibrate the north pressure gauge', {
              tags: ['#boiler'],
              dates: { scheduled: '2027-01-10', due: '2027-01-26' },
              source: { path: 'records/Mechanical room.md', line: 6 },
            }),
          ],
          proposalKinds: [],
          writeCount: 0,
          files: {
            'a.md': '# Inbox\n',
            'control.md': mechanicalControl,
            'records/Mechanical room.md': mechanicalLog,
            'notes/Log index.md': mechanicalIndex,
          },
        },
      },
      {
        text: 'I mean the entry on physical line 7 of “records/Mechanical room.md”. That one is currently scheduled for January 10, 2027 and due January 26, 2027. Change only its scheduled date to January 15, keep its tag and title, and show the preview without saving.',
        expect: {
          status: 'ready',
          trees: [
            tree('Calibrate the north pressure gauge', {
              tags: ['#boiler'],
              dates: { scheduled: '2027-01-15', due: '2027-01-26' },
            }),
          ],
          publicTrees: [
            tree('Calibrate the north pressure gauge', {
              tags: ['#boiler'],
              dates: { scheduled: '2027-01-08', due: '2027-01-21' },
              children: [tree('Record the brass dial reading')],
              source: { path: 'records/Mechanical room.md', line: 2 },
            }),
            tree('Calibrate the north pressure gauge', {
              tags: ['#boiler'],
              dates: { scheduled: '2027-01-10', due: '2027-01-26' },
              source: { path: 'records/Mechanical room.md', line: 6 },
            }),
          ],
          taskSources: [{ path: 'records/Mechanical room.md', line: 6, kind: 'edit' }],
          taskPlanKinds: ['edit'],
          proposalKinds: ['task'],
          writeCount: 0,
          files: {
            'a.md': '# Inbox\n',
            'control.md': mechanicalControl,
            'records/Mechanical room.md': mechanicalLog,
            'notes/Log index.md': mechanicalIndex,
          },
        },
      },
      {
        text: 'Save that change.',
        expect: {
          status: 'saved',
          publicTrees: [
            tree('Calibrate the north pressure gauge', {
              tags: ['#boiler'],
              dates: { scheduled: '2027-01-08', due: '2027-01-21' },
              children: [tree('Record the brass dial reading')],
              source: { path: 'records/Mechanical room.md', line: 2 },
            }),
            tree('Calibrate the north pressure gauge', {
              tags: ['#boiler'],
              dates: { scheduled: '2027-01-15', due: '2027-01-26' },
              source: { path: 'records/Mechanical room.md', line: 6 },
            }),
          ],
          proposalKinds: [],
          createdFiles: [],
          writeCount: 1,
          files: {
            'a.md': '# Inbox\n',
            'control.md': mechanicalControl,
            'notes/Log index.md': mechanicalIndex,
            'records/Mechanical room.md':
              '# Mechanical room log\n' +
              'The north gauge was checked before the west-wing work.\n' +
              '- [ ] Calibrate the north pressure gauge #boiler ⏳ 2027-01-08 📅 2027-01-21\n' +
              '  - [ ] Record the brass dial reading\n' +
              '\n' +
              'The west-wing inspection was copied from the service card.\n' +
              '- [ ] Calibrate the north pressure gauge #boiler ⏳ 2027-01-15 📅 2027-01-26\n',
          },
        },
      },
    ],
  },
  {
    id: 'r10-fresh-earlier-draft-ru',
    family: 'r10-fresh-command-live-earlier-pending-root',
    split: 'held-out',
    files: files('# Приём задач\n', {
      'notes/Закупки.md': '# Закупки\r\nСверять номенклатуру с бумажным каталогом.\r\n',
    }),
    turns: [
      {
        text: 'Надиктую сразу две отдельные новые задачи. Первая — «Подготовить паспорт вентилятора»: тег #механика, срок 14 февраля 2027 года; внутри отдельным шагом сверь серийный номер с шильдиком, а под шагом оставь заметку «Не отклеивать бирку перед осмотром». Вторая — «Заказать уплотнения для коллектора»: тег #закупки, запланировать на 19 февраля 2027 года, внутри шаг «Проверить диаметр резьбы по чертежу». Покажи оба черновика, пока ничего не сохраняй.',
        expect: {
          status: 'ready',
          trees: [firstDraft, secondDraft],
          publicTrees: [],
          taskPlanKinds: ['create', 'create'],
          proposalKinds: ['task', 'task'],
          freshPreparation: true,
          writeCount: 0,
        },
      },
      {
        text: 'Уточню не последнюю, а первую из новых задач — «Подготовить паспорт вентилятора». Измени только её срок выполнения на 16 февраля 2027 года. Тег, шаг со сверкой серийного номера и заметку под ним сохрани; вторую задачу «Заказать уплотнения для коллектора» со сроком и шагом оставь как была. Покажи оба черновика, ничего пока не записывай.',
        expect: {
          status: 'ready',
          trees: [refinedFirstDraft, secondDraft],
          publicTrees: [],
          proposalKinds: ['task', 'task'],
          writeCount: 0,
        },
      },
      {
        text: 'Да, сохрани обе задачи с этим сроком и прежними шагами.',
        expect: {
          status: 'saved',
          proposalKinds: [],
          publicTrees: [savedFirst, savedSecond],
          createdFiles: [],
          writeCount: 2,
          retainPreviousTasks: true,
          files: {
            'a.md':
              '# Приём задач\n' +
              '- [ ] Подготовить паспорт вентилятора #механика 📅 2027-02-16\n' +
              '  - [ ] Сверить серийный номер с шильдиком\n' +
              '    - Не отклеивать бирку перед осмотром.\n' +
              '- [ ] Заказать уплотнения для коллектора #закупки ⏳ 2027-02-19\n' +
              '  - [ ] Проверить диаметр резьбы по чертежу\n',
            'control.md': mechanicalControl,
            'notes/Закупки.md': '# Закупки\r\nСверять номенклатуру с бумажным каталогом.\r\n',
          },
        },
      },
    ],
  },
];
