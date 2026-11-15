/** Four fresh R9 development fixtures authored after the runtime freeze. */
import type { EvalCase } from './corpus';
import { files, tree } from './fixtures';

const withoutChildren = (value: ReturnType<typeof tree>) =>
  Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'children'));

const freshQualificationCases: readonly EvalCase[] = [
  {
    id: 'r9-fresh-selective-child-removal-ru',
    family: 'r9-fresh-selective-child-removal',
    split: 'development',
    files: files(
      '# Теплица\n' +
        '- [ ] Подготовить рассадный стол #сад ⏳ 2027-03-12\n' +
        '  - [ ] Отмыть поддон #вода\n' +
        '    - Не снимать наклейку с номером секции.\n' +
        '  - [ ] Заказать второй термометр\n' +
        '  - [ ] Проверить лампу для рассады\n' +
        '- [ ] Пересадить базилик #сад 📅 2027-03-20\n',
      { 'notes/seed-log.md': '# Seed log\nОтметки для опытной грядки остаются здесь.\n' },
    ),
    turns: [
      {
        text: 'В задаче «Подготовить рассадный стол» убери только шаг «Заказать второй термометр». Остальное оставь как есть: дату, теги, заметку к поддону, лампу и соседнюю задачу про базилик. Сначала покажи черновик, ничего пока не сохраняй.',
        expect: {
          status: 'ready',
          trees: [
            tree('Подготовить рассадный стол', {
              tags: ['#сад'],
              dates: { scheduled: '2027-03-12' },
              children: [
                tree('Отмыть поддон', {
                  tags: ['#вода'],
                  comments: [{ text: 'Не снимать наклейку с номером секции.' }],
                }),
                tree('Проверить лампу для рассады'),
              ],
            }),
          ],
          removedNodes: [[0, 1]],
          publicTrees: [
            tree('Подготовить рассадный стол', {
              tags: ['#сад'],
              dates: { scheduled: '2027-03-12' },
              children: [
                tree('Отмыть поддон', {
                  tags: ['#вода'],
                  comments: [{ text: 'Не снимать наклейку с номером секции.' }],
                }),
                tree('Заказать второй термометр'),
                tree('Проверить лампу для рассады'),
              ],
              source: { path: 'a.md', line: 1 },
            }),
            tree('Пересадить базилик', {
              tags: ['#сад'],
              dates: { due: '2027-03-20' },
              source: { path: 'a.md', line: 6 },
            }),
          ],
          taskSources: [{ path: 'a.md', line: 1, kind: 'edit' }],
          proposalKinds: ['task'],
          writeCount: 0,
          files: {
            'a.md':
              '# Теплица\n' +
              '- [ ] Подготовить рассадный стол #сад ⏳ 2027-03-12\n' +
              '  - [ ] Отмыть поддон #вода\n' +
              '    - Не снимать наклейку с номером секции.\n' +
              '  - [ ] Заказать второй термометр\n' +
              '  - [ ] Проверить лампу для рассады\n' +
              '- [ ] Пересадить базилик #сад 📅 2027-03-20\n',
            'notes/seed-log.md': '# Seed log\nОтметки для опытной грядки остаются здесь.\n',
            'control.md':
              '---\nprotected: true\n---\n# Control\r\n- [ ] Untouched [unknown:: keep] #control\r\n',
          },
        },
      },
      {
        text: 'Да, сохрани только это удаление.',
        expect: {
          status: 'saved',
          proposalKinds: [],
          publicTrees: [
            tree('Подготовить рассадный стол', {
              tags: ['#сад'],
              dates: { scheduled: '2027-03-12' },
              children: [
                tree('Отмыть поддон', {
                  tags: ['#вода'],
                  comments: [{ text: 'Не снимать наклейку с номером секции.' }],
                }),
                tree('Проверить лампу для рассады'),
              ],
              source: { path: 'a.md', line: 1 },
            }),
            tree('Пересадить базилик', {
              tags: ['#сад'],
              dates: { due: '2027-03-20' },
              source: { path: 'a.md' },
            }),
          ],
          writeCount: 1,
          files: {
            'a.md':
              '# Теплица\n' +
              '- [ ] Подготовить рассадный стол #сад ⏳ 2027-03-12\n' +
              '  - [ ] Отмыть поддон #вода\n' +
              '    - Не снимать наклейку с номером секции.\n' +
              '  - [ ] Проверить лампу для рассады\n' +
              '- [ ] Пересадить базилик #сад 📅 2027-03-20\n',
            'notes/seed-log.md': '# Seed log\nОтметки для опытной грядки остаются здесь.\n',
            'control.md':
              '---\nprotected: true\n---\n# Control\r\n- [ ] Untouched [unknown:: keep] #control\r\n',
          },
        },
      },
    ],
  },
  {
    id: 'r9-fresh-cancel-corrected-capture-en',
    family: 'r9-fresh-cancel-corrected-capture',
    split: 'development',
    files: files(
      '# Workshop\n' +
        '- [ ] Inspect the cedar press #tools 📅 2027-06-18\n' +
        '  - Keep the brass gauge in its case.\n' +
        '- [ ] Restock blue masking tape #supplies\n',
      { 'records/shift.md': 'Shift note: leave the side door latched.\n' },
    ),
    turns: [
      {
        text: 'Change the due date of “Inspect the cedar press” to June 21 and show me the draft. Keep the tool tag, its note, and the masking tape task; don’t save yet.',
        expect: {
          status: 'ready',
          trees: [
            tree('Inspect the cedar press', {
              tags: ['#tools'],
              dates: { due: '2027-06-21' },
              comments: [{ text: 'Keep the brass gauge in its case.' }],
            }),
          ],
          publicTrees: [
            tree('Inspect the cedar press', {
              tags: ['#tools'],
              dates: { due: '2027-06-18' },
              comments: [{ text: 'Keep the brass gauge in its case.' }],
              source: { path: 'a.md', line: 1 },
            }),
            tree('Restock blue masking tape', {
              tags: ['#supplies'],
              source: { path: 'a.md', line: 3 },
            }),
          ],
          taskSources: [{ path: 'a.md', line: 1, kind: 'edit' }],
          proposalKinds: ['task'],
          writeCount: 0,
        },
      },
      {
        text: 'Discard the entire cedar press date draft. I gave you the wrong day; leave the saved press task and every other task untouched. Do not save anything.',
        expect: {
          status: 'ready',
          pendingTaskStates: [
            {
              path: 'a.md',
              line: 1,
              tree: tree('Inspect the cedar press', {
                tags: ['#tools'],
                dates: { due: '2027-06-18' },
                comments: [{ text: 'Keep the brass gauge in its case.' }],
              }),
            },
          ],
          publicTrees: [
            tree('Inspect the cedar press', {
              tags: ['#tools'],
              dates: { due: '2027-06-18' },
              comments: [{ text: 'Keep the brass gauge in its case.' }],
              source: { path: 'a.md', line: 1 },
            }),
            tree('Restock blue masking tape', {
              tags: ['#supplies'],
              source: { path: 'a.md', line: 3 },
            }),
          ],
          proposalKinds: [],
          writeCount: 0,
          files: {
            'a.md':
              '# Workshop\n' +
              '- [ ] Inspect the cedar press #tools 📅 2027-06-18\n' +
              '  - Keep the brass gauge in its case.\n' +
              '- [ ] Restock blue masking tape #supplies\n',
            'records/shift.md': 'Shift note: leave the side door latched.\n',
            'control.md':
              '---\nprotected: true\n---\n# Control\r\n- [ ] Untouched [unknown:: keep] #control\r\n',
          },
        },
      },
      {
        text: 'Actually, voice note corrected: book the kiln safety check for June 24, 2027, tag it #inspection, and keep it as a new task. Покажи черновик, пожалуйста; пока ничего не сохраняй.',
        expect: {
          status: 'ready',
          trees: [
            tree('Book the kiln safety check', {
              tags: ['#inspection'],
              dates: { scheduled: '2027-06-24' },
            }),
          ],
          publicTrees: [
            tree('Inspect the cedar press', {
              tags: ['#tools'],
              dates: { due: '2027-06-18' },
              comments: [{ text: 'Keep the brass gauge in its case.' }],
              source: { path: 'a.md', line: 1 },
            }),
            tree('Restock blue masking tape', {
              tags: ['#supplies'],
              source: { path: 'a.md', line: 3 },
            }),
          ],
          taskPlanKinds: ['create'],
          proposalKinds: ['task'],
          freshPreparation: true,
          writeCount: 0,
        },
      },
      {
        text: 'Save the kiln safety check.',
        expect: {
          status: 'saved',
          proposalKinds: [],
          publicTrees: [
            tree('Inspect the cedar press', {
              tags: ['#tools'],
              dates: { due: '2027-06-18' },
              comments: [{ text: 'Keep the brass gauge in its case.' }],
              source: { path: 'a.md', line: 1 },
            }),
            tree('Restock blue masking tape', {
              tags: ['#supplies'],
              source: { path: 'a.md', line: 3 },
            }),
            tree('Book the kiln safety check', {
              tags: ['#inspection'],
              dates: { scheduled: '2027-06-24' },
              source: { path: 'a.md' },
            }),
          ],
          writeCount: 1,
          contains: {
            'a.md': [
              'Inspect the cedar press #tools',
              'Restock blue masking tape #supplies',
              'Book the kiln safety check #inspection',
              '2027-06-24',
            ],
          },
          files: {
            'a.md':
              '# Workshop\n' +
              '- [ ] Inspect the cedar press #tools 📅 2027-06-18\n' +
              '  - Keep the brass gauge in its case.\n' +
              '- [ ] Restock blue masking tape #supplies\n' +
              '- [ ] Book the kiln safety check #inspection ⏳ 2027-06-24\n',
            'records/shift.md': 'Shift note: leave the side door latched.\n',
            'control.md':
              '---\nprotected: true\n---\n# Control\r\n- [ ] Untouched [unknown:: keep] #control\r\n',
          },
        },
      },
    ],
  },
  {
    id: 'r9-fresh-ambiguous-owner-discriminator-ru',
    family: 'r9-fresh-ambiguous-owner-discriminator',
    split: 'development',
    files: files('# Inbox\n', {
      'Ветеринар/приём.md':
        '# Приёмы\n- [ ] Позвонить Марине #клиника 📅 2027-08-12\n  - Уточнить доступ к боковому входу.\n',
      'Команда/контакты.md':
        '# Контакты\n- [ ] Позвонить Марине #команда 📅 2027-08-16\n  - Спросить про макет афиши.\n',
      'records/clinic.md': '# Карточка клиники\nТелефон дежурного: внутренний 31.\n',
    }),
    turns: [
      {
        text: 'Измени дедлайн задачи «Позвонить Марине» на 18 августа 2027 года. Сначала покажи черновик, установленный срок и комментарии не теряй.',
        expect: {
          status: 'question',
          publicTrees: [
            tree('Позвонить Марине', {
              tags: ['#клиника'],
              dates: { due: '2027-08-12' },
              comments: [{ text: 'Уточнить доступ к боковому входу.' }],
              source: { path: 'Ветеринар/приём.md', line: 1 },
            }),
            tree('Позвонить Марине', {
              tags: ['#команда'],
              dates: { due: '2027-08-16' },
              comments: [{ text: 'Спросить про макет афиши.' }],
              source: { path: 'Команда/контакты.md', line: 1 },
            }),
          ],
          proposalKinds: [],
          writeCount: 0,
        },
      },
      {
        text: 'Я имею в виду Марину из файла «Ветеринар/приём.md», где надо уточнить боковой вход. Измени срок выполнения именно этой задачи на 18 августа, вторую не меняй, потом дай посмотреть черновик.',
        expect: {
          status: 'ready',
          trees: [
            tree('Позвонить Марине', {
              tags: ['#клиника'],
              dates: { due: '2027-08-18' },
              comments: [{ text: 'Уточнить доступ к боковому входу.' }],
            }),
          ],
          publicTrees: [
            tree('Позвонить Марине', {
              tags: ['#клиника'],
              dates: { due: '2027-08-12' },
              comments: [{ text: 'Уточнить доступ к боковому входу.' }],
              source: { path: 'Ветеринар/приём.md', line: 1 },
            }),
            tree('Позвонить Марине', {
              tags: ['#команда'],
              dates: { due: '2027-08-16' },
              comments: [{ text: 'Спросить про макет афиши.' }],
              source: { path: 'Команда/контакты.md', line: 1 },
            }),
          ],
          taskSources: [{ path: 'Ветеринар/приём.md', line: 1, kind: 'edit' }],
          proposalKinds: ['task'],
          writeCount: 0,
        },
      },
      {
        text: 'Да, сохрани изменение для задачи из «Ветеринар/приём.md».',
        expect: {
          status: 'saved',
          proposalKinds: [],
          publicTrees: [
            tree('Позвонить Марине', {
              tags: ['#клиника'],
              dates: { due: '2027-08-18' },
              comments: [{ text: 'Уточнить доступ к боковому входу.' }],
              source: { path: 'Ветеринар/приём.md', line: 1 },
            }),
            tree('Позвонить Марине', {
              tags: ['#команда'],
              dates: { due: '2027-08-16' },
              comments: [{ text: 'Спросить про макет афиши.' }],
              source: { path: 'Команда/контакты.md', line: 1 },
            }),
          ],
          writeCount: 1,
          files: {
            'a.md': '# Inbox\n',
            'Команда/контакты.md':
              '# Контакты\n- [ ] Позвонить Марине #команда 📅 2027-08-16\n  - Спросить про макет афиши.\n',
            'records/clinic.md': '# Карточка клиники\nТелефон дежурного: внутренний 31.\n',
          },
        },
      },
    ],
  },
  {
    id: 'r9-fresh-open-goal-expansion-en',
    family: 'r9-fresh-open-goal-expansion',
    split: 'development',
    limitations: [
      'The unchanged independent quality rubric must judge whether the generated actions are useful, feasible, sequenced, and specific for this greenhouse ventilation goal. The structural oracle accepts any valid decomposition and does not prescribe step titles.',
    ],
    files: files(
      '# Conservatory\n' +
        '- [ ] Get the west greenhouse ventilation ready #horticulture ⏳ 2027-04-03 📅 2027-04-10\n' +
        '  - > The hand crank is stored in the weatherproof cabinet beside Bay 2.\n' +
        '  - [ ] Check the cabinet latch #maintenance\n' +
        '  - Keep the seedling trays clear of the floor vents.\n' +
        '- [ ] Label the alpine seedlings #horticulture 📅 2027-04-14\n' +
        '  - Use the blue tags from the propagation drawer.\n',
      { 'equipment/vent-list.md': '# Vent list\nLouvers are numbered from the south wall.\n' },
    ),
    turns: [
      {
        text: 'Read “Get the west greenhouse ventilation ready” first. Use the crank location, cabinet check, and tray note to add a practical plan that takes the vents from the current setup to working safely. Add 3–5 new concrete direct steps, with one nested step only if it helps. Keep the title, dates, tag, description, cabinet step, comment, and the neighboring seedling task intact. Don’t invent dates or repeats. Show me the draft and don’t save or research.',
        expect: {
          status: 'ready',
          trees: [
            withoutChildren(
              tree('Get the west greenhouse ventilation ready', {
                tags: ['#horticulture'],
                dates: { scheduled: '2027-04-03', due: '2027-04-10' },
                description: 'The hand crank is stored in the weatherproof cabinet beside Bay 2.',
                comments: [{ text: 'Keep the seedling trays clear of the floor vents.' }],
              }),
            ),
          ],
          publicTrees: [
            withoutChildren(
              tree('Get the west greenhouse ventilation ready', {
                tags: ['#horticulture'],
                dates: { scheduled: '2027-04-03', due: '2027-04-10' },
                description: 'The hand crank is stored in the weatherproof cabinet beside Bay 2.',
                comments: [{ text: 'Keep the seedling trays clear of the floor vents.' }],
                source: { path: 'a.md', line: 1 },
              }),
            ),
            tree('Label the alpine seedlings', {
              tags: ['#horticulture'],
              dates: { due: '2027-04-14' },
              comments: [{ text: 'Use the blue tags from the propagation drawer.' }],
              source: { path: 'a.md' },
            }),
          ],
          taskSources: [{ path: 'a.md', line: 1, kind: 'edit' }],
          proposalKinds: ['task'],
          decomposition: { minChildren: 4, maxChildren: 6, maxDepth: 2, noInventedSchedule: true },
          writeCount: 0,
        },
      },
      {
        text: 'Save that ventilation plan.',
        expect: {
          status: 'saved',
          proposalKinds: [],
          publicTrees: [
            withoutChildren(
              tree('Get the west greenhouse ventilation ready', {
                tags: ['#horticulture'],
                dates: { scheduled: '2027-04-03', due: '2027-04-10' },
                description: 'The hand crank is stored in the weatherproof cabinet beside Bay 2.',
                comments: [{ text: 'Keep the seedling trays clear of the floor vents.' }],
                source: { path: 'a.md', line: 1 },
              }),
            ),
            tree('Label the alpine seedlings', {
              tags: ['#horticulture'],
              dates: { due: '2027-04-14' },
              comments: [{ text: 'Use the blue tags from the propagation drawer.' }],
              source: { path: 'a.md' },
            }),
          ],
          writeCount: 1,
          contains: { 'a.md': ['Check the cabinet latch #maintenance'] },
          files: {
            'equipment/vent-list.md': '# Vent list\nLouvers are numbered from the south wall.\n',
            'control.md':
              '---\nprotected: true\n---\n# Control\r\n- [ ] Untouched [unknown:: keep] #control\r\n',
          },
        },
      },
    ],
  },
];

export { freshQualificationCases };
