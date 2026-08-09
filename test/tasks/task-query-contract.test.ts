import { describe, expect, it } from 'vitest';
import { localDate } from '../../src/tasks/domain/validation';
import { TaskIndex } from '../../src/tasks/infrastructure/TaskIndex';
import {
  canonicalStatusCatalog,
  createAppWithFiles,
  seedTaskCache,
  useRealMoment,
} from '../helpers';

useRealMoment();

async function queryIndex(files: Record<string, string>): Promise<TaskIndex> {
  const app = await createAppWithFiles(files);
  for (const [path, content] of Object.entries(files)) {
    seedTaskCache(
      app,
      path,
      content
        .split('\n')
        .flatMap((line, index) =>
          /^- \[.\]/u.test(line) ? [{ task: line[3] ?? ' ', parent: -1, line: index }] : [],
        ),
    );
  }
  const index = new TaskIndex(app, {
    statusCatalog: canonicalStatusCatalog(),
    dailyNoteFormat: 'YYYY-MM-DD',
  });
  await index.initialize();
  return index;
}

describe('TaskQueryApi contract', () => {
  it('applies the exact current file, folder, tag, status, and list-date semantics', async () => {
    const index = await queryIndex({
      'Work/2026-07-01.md': [
        '- [ ] due #Work 📅 2026-07-10',
        '- [/] scheduled #work ⏳ 2026-07-11',
        '- [x] due wins #Work ⏳ 2026-07-01 📅 2027-01-01',
      ].join('\n'),
      'Workish.md': '- [-] start #Work 🛫 2026-07-12',
      'work/lower.md': '- [ ] lower #Work 📅 2026-07-13',
    });

    expect(index.list({ filePath: 'Work/2026-07-01.md' })).toHaveLength(3);
    expect(index.list({ filePath: 'work/2026-07-01.md' })).toEqual([]);
    expect(index.list({ folder: 'Work' })).toHaveLength(4);
    expect(index.list({ folder: 'work' })).toHaveLength(1);
    expect(index.list({ tag: '#Work' })).toHaveLength(4);
    expect(index.list({ tag: '#work' })).toHaveLength(1);
    expect(index.list({ statuses: ['in-progress', 'cancelled'] })).toHaveLength(2);
    expect(
      index.list({
        dateRange: { from: localDate('2026-07-10'), to: localDate('2026-07-12') },
      }),
    ).toHaveLength(3);
    index.destroy();
  });

  it('does not use the daily-note date as a generic list-date anchor', async () => {
    const index = await queryIndex({ 'daily/2026-07-13.md': '- [ ] daily without marker' });
    expect(
      index.list({
        dateRange: { from: localDate('2026-07-13'), to: localDate('2026-07-13') },
      }),
    ).toHaveLength(0);
    index.destroy();
  });

  it('matches query tags canonically, excluding inline code and longer tag names', async () => {
    const index = await queryIndex({
      'tags.md': ['- [ ] inline `#work`', '- [ ] longer #workplace', '- [ ] real #work'].join('\n'),
    });

    expect(index.list({ tag: '#work' }).map((task) => task.title)).toEqual(['real']);
    index.destroy();
  });

  it('returns a distinct calendar union for spans, scheduled/due markers, and repeated dates', async () => {
    const index = await queryIndex({
      'calendar.md': [
        '- [ ] span 🛫 2026-07-01 📅 2026-07-03',
        '- [ ] deadline ⏳ 2026-07-02 📅 2026-07-05',
        '- [ ] scheduled only ⏳ 2026-07-03',
      ].join('\n'),
    });

    const tasks = index.forCalendarProjection([
      localDate('2026-07-02'),
      localDate('2026-07-03'),
      localDate('2026-07-05'),
      localDate('2026-07-02'),
    ]).materialized;
    expect(tasks.map(({ node }) => node.title)).toEqual(['span', 'deadline', 'scheduled only']);
    index.destroy();
  });

  it('queries every part of a multi-year span without leaking outside its range', async () => {
    const index = await queryIndex({
      'long.md': '- [ ] long 🛫 2026-01-01 📅 2027-12-31',
    });
    expect(index.forCalendarProjection([localDate('2026-01-01')]).materialized).toHaveLength(1);
    expect(index.forCalendarProjection([localDate('2026-07-01')]).materialized).toHaveLength(1);
    expect(index.forCalendarProjection([localDate('2027-01-02')]).materialized).toHaveLength(1);
    expect(index.forCalendarProjection([localDate('2027-12-31')]).materialized).toHaveLength(1);
    expect(index.forCalendarProjection([localDate('2028-01-01')]).materialized).toHaveLength(0);
    expect(index.forCalendarProjection([localDate('2027-01-01')]).materialized).toHaveLength(1);
    index.destroy();
  });

  it('indexes active root and nested recurrence owners independently of viewport and parent status', async () => {
    const index = await queryIndex({
      'owners.md': [
        '- [ ] root owner 🔁 every week 📅 2026-06-01',
        '  - [/] nested visible 🔁 every day 📅 2026-08-08',
        '  - [x] nested done 🔁 every day 📅 2026-08-08',
        '  - [-] nested cancelled 🔁 every day 📅 2026-08-08',
        '  - [ ] nested plain 📅 2026-08-08',
        '- [x] done parent',
        '  - [ ] nested active 🔁 every month 📅 2026-06-30',
        '- [/] progressing owner 🔁 every week 📅 2026-06-01',
        '- [x] done owner 🔁 every week 📅 2026-06-01',
        '- [-] cancelled owner 🔁 every week 📅 2026-06-01',
      ].join('\n'),
    });

    const projection = index.forCalendarProjection([localDate('2026-08-08')]);
    expect(projection.materialized.map(({ node }) => node.title)).toEqual([
      'nested visible',
      'nested done',
      'nested cancelled',
    ]);
    expect(projection.recurringSources.map(({ node }) => node.title)).toEqual([
      'root owner',
      'nested visible',
      'nested active',
      'progressing owner',
    ]);
    expect(projection.recurringSources.map(({ target }) => target.type)).toEqual([
      'task',
      'subtask',
      'subtask',
      'task',
    ]);
    expect(projection.recurringSources[2]?.root.status).toBe('done');
    index.destroy();
  });
});
