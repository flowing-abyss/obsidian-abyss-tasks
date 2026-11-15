/** Four replacement R9 held-out cases authored after the runtime freeze. */
import type { EvalCase } from './corpus';
import { files, tree } from './fixtures';

export const r9QualificationCases: readonly EvalCase[] = [
  {
    id: 'r9-repl-due-schedule-en',
    family: 'r9-replacement-due-schedule',
    split: 'held-out',
    files: files(
      '- [ ] Inspect the rainwater barrel mesh #garden ⏳ 2027-03-04 📅 2027-03-20 ⏰ 16:30\n' +
        '  - Check the mesh frame for splits.\n' +
        '  - [ ] Rinse the intake screen\n' +
        '- [ ] Return the courtyard key\n',
    ),
    turns: [
      {
        text: 'For “Inspect the rainwater barrel mesh” in a.md, remove only its deadline and schedule it for March 12, 2027. Keep the time, comment, child task and tag. Show me a preview; don’t save yet.',
        expect: {
          status: 'ready',
          proposalKinds: ['task'],
          taskPlanKinds: ['edit'],
          taskSources: [{ path: 'a.md', line: 0, kind: 'edit' }],
          trees: [
            tree('Inspect the rainwater barrel mesh', {
              dates: { scheduled: '2027-03-12', due: undefined },
              time: '16:30',
              tags: ['#garden'],
              comments: [{ text: 'Check the mesh frame for splits.' }],
              children: [tree('Rinse the intake screen')],
            }),
          ],
          publicTrees: [
            tree('Inspect the rainwater barrel mesh', {
              dates: { scheduled: '2027-03-04', due: '2027-03-20' },
              time: '16:30',
              tags: ['#garden'],
              comments: [{ text: 'Check the mesh frame for splits.' }],
              children: [tree('Rinse the intake screen')],
            }),
            tree('Return the courtyard key'),
          ],
          writeCount: 0,
        },
      },
      {
        text: 'Save that change.',
        expect: {
          status: 'saved',
          proposalKinds: [],
          publicTrees: [
            tree('Inspect the rainwater barrel mesh', {
              dates: { scheduled: '2027-03-12', due: undefined },
              time: '16:30',
              tags: ['#garden'],
              comments: [{ text: 'Check the mesh frame for splits.' }],
              children: [tree('Rinse the intake screen')],
            }),
            tree('Return the courtyard key'),
          ],
          createdFiles: [],
          writeCount: 1,
          files: files(
            '- [ ] Inspect the rainwater barrel mesh #garden ⏳ 2027-03-12 ⏰ 16:30\n' +
              '  - Check the mesh frame for splits.\n' +
              '  - [ ] Rinse the intake screen\n' +
              '- [ ] Return the courtyard key\n',
          ),
        },
      },
    ],
  },
  {
    id: 'r9-repl-comment-owner-ru',
    family: 'r9-replacement-comment-owner',
    split: 'held-out',
    files: files(
      '- [ ] Проверить клапан дождевого бака\n' +
        '  - Снимок показаний приложен.\n' +
        '  - Нужен новый уплотнитель.\n' +
        '- [ ] Сверить список инструментов\n' +
        '  - Снимок показаний приложен.\n',
    ),
    turns: [
      {
        text: 'В a.md у задачи «Проверить клапан дождевого бака» удали только комментарий «Снимок показаний приложен.»; такой же комментарий у «Сверить список инструментов» оставь. Покажи предпросмотр, пока не сохраняй.',
        expect: {
          status: 'ready',
          proposalKinds: ['task'],
          taskPlanKinds: ['edit'],
          taskSources: [{ path: 'a.md', line: 0, kind: 'edit' }],
          trees: [
            tree('Проверить клапан дождевого бака', {
              comments: [{ text: 'Нужен новый уплотнитель.' }],
            }),
          ],
          publicTrees: [
            tree('Проверить клапан дождевого бака', {
              comments: [
                { text: 'Снимок показаний приложен.' },
                { text: 'Нужен новый уплотнитель.' },
              ],
            }),
            tree('Сверить список инструментов', {
              comments: [{ text: 'Снимок показаний приложен.' }],
            }),
          ],
          writeCount: 0,
        },
      },
      {
        text: 'Сохрани это изменение.',
        expect: {
          status: 'saved',
          proposalKinds: [],
          publicTrees: [
            tree('Проверить клапан дождевого бака', {
              comments: [{ text: 'Нужен новый уплотнитель.' }],
            }),
            tree('Сверить список инструментов', {
              comments: [{ text: 'Снимок показаний приложен.' }],
            }),
          ],
          createdFiles: [],
          writeCount: 1,
          files: files(
            '- [ ] Проверить клапан дождевого бака\n' +
              '  - Нужен новый уплотнитель.\n' +
              '- [ ] Сверить список инструментов\n' +
              '  - Снимок показаний приложен.\n',
          ),
        },
      },
    ],
  },
  {
    id: 'r9-repl-two-captures-en',
    family: 'r9-replacement-two-captures',
    split: 'held-out',
    files: files(
      '- [ ] Check the park noticeboard #volunteers\n' +
        '- [ ] Refill the first-aid kit ⏳ 2027-04-02 📅 2027-04-14\n',
    ),
    turns: [
      {
        text: 'Create exactly two independent tasks: “Order seed trays” with a deadline of April 8, 2027 and the #garden tag, and “Print volunteer orientation sheets” with a duration of 45 minutes. Keep the existing tasks unchanged. Show me the preview; don’t save yet.',
        expect: {
          status: 'ready',
          proposalKinds: ['task', 'task'],
          taskPlanKinds: ['create', 'create'],
          trees: [
            tree('Order seed trays', { dates: { due: '2027-04-08' }, tags: ['#garden'] }),
            tree('Print volunteer orientation sheets', { durationMinutes: 45 }),
          ],
          publicTrees: [
            tree('Check the park noticeboard', { tags: ['#volunteers'] }),
            tree('Refill the first-aid kit', {
              dates: { scheduled: '2027-04-02', due: '2027-04-14' },
            }),
          ],
          writeCount: 0,
        },
      },
      {
        text: 'Save both new tasks.',
        expect: {
          status: 'saved',
          proposalKinds: [],
          publicTrees: [
            tree('Check the park noticeboard', { tags: ['#volunteers'] }),
            tree('Refill the first-aid kit', {
              dates: { scheduled: '2027-04-02', due: '2027-04-14' },
            }),
            tree('Order seed trays', { dates: { due: '2027-04-08' }, tags: ['#garden'] }),
            tree('Print volunteer orientation sheets', { durationMinutes: 45 }),
          ],
          createdFiles: [],
          writeCount: 2,
          files: files(
            '- [ ] Check the park noticeboard #volunteers\n' +
              '- [ ] Refill the first-aid kit ⏳ 2027-04-02 📅 2027-04-14\n' +
              '- [ ] Order seed trays #garden 📅 2027-04-08\n' +
              '- [ ] Print volunteer orientation sheets ⏱️ 45m\n',
          ),
        },
      },
    ],
  },
  {
    id: 'r9-repl-courtyard-goal-ru',
    family: 'r9-replacement-open-goal',
    split: 'held-out',
    files: files('# Общий двор\n', {
      'grounds/guidelines.md':
        '# Правила общего двора\nПожарный проезд должен оставаться свободным.\n',
    }),
    turns: [
      {
        text: 'У нас жильцы уже давно хотят привести в порядок общий двор, но пока всё остаётся на словах: сначала бы собрать людей, понять, чем можно заниматься своими силами, а потом довести уборку до конца и не оставить мешки у подъезда. Подготовь одну открытую задачу «Подготовить соседскую уборку двора» и разложи её на четыре полезных прямых действия, названия шагов придумай сам. Хочется, чтобы шаги помогали реально провести такую уборку, а не просто повторяли цель разными словами. Даты, время и повторение я пока не выбирал — ничего такого не добавляй. Покажи черновик, я посмотрю перед сохранением.',
        expect: {
          status: 'ready',
          proposalKinds: ['task'],
          trees: [{ markdownTitle: 'Подготовить соседскую уборку двора' }],
          publicTrees: [],
          decomposition: { minChildren: 4, maxChildren: 4, maxDepth: 1, noInventedSchedule: true },
          writeCount: 0,
        },
      },
      {
        text: 'Сохрани эту задачу с шагами.',
        expect: {
          status: 'saved',
          proposalKinds: [],
          trees: [{ markdownTitle: 'Подготовить соседскую уборку двора' }],
          publicTrees: [{ markdownTitle: 'Подготовить соседскую уборку двора' }],
          decomposition: { minChildren: 4, maxChildren: 4, maxDepth: 1, noInventedSchedule: true },
          createdFiles: [],
          writeCount: 1,
          contains: {
            'a.md': ['# Общий двор'],
            'grounds/guidelines.md': [
              '# Правила общего двора',
              'Пожарный проезд должен оставаться свободным.',
            ],
          },
          files: {
            'grounds/guidelines.md':
              '# Правила общего двора\nПожарный проезд должен оставаться свободным.\n',
            'control.md':
              '---\nprotected: true\n---\n# Control\r\n- [ ] Untouched [unknown:: keep] #control\r\n',
          },
        },
      },
    ],
  },
];
