import { describe, expect, it } from 'vitest';
import {
  groupTasksByDate,
  groupTasksByPriority,
  groupTasksByTag,
  sortTasksByField,
} from '../src/views/taskGrouping';
import { task, useRealMoment } from './helpers';

useRealMoment();

describe('sortTasksByField', () => {
  it('date asc: nearest first (no date sorts last)', () => {
    const t1 = task({ planning: { due: '2026-07-01' } });
    const t2 = task({ planning: { due: '2026-06-28' } });
    const t3 = task({});
    const out = sortTasksByField([t1, t3, t2], 'date', 'asc');
    expect(out.map((t) => t.planning.due)).toEqual(['2026-06-28', '2026-07-01', undefined]);
  });

  it('date desc: furthest first, no-date last', () => {
    const t1 = task({ planning: { due: '2026-07-01' } });
    const t2 = task({ planning: { due: '2026-06-28' } });
    const out = sortTasksByField([t2, t1], 'date', 'desc');
    expect(out[0]?.planning.due).toBe('2026-07-01');
  });

  it('priority asc: A before F', () => {
    const out = sortTasksByField(
      [task({ priority: 'F' }), task({ priority: 'A' })],
      'priority',
      'asc',
    );
    expect(out[0]?.priority).toBe('A');
  });

  it('priority desc: F before A', () => {
    const out = sortTasksByField(
      [task({ priority: 'A' }), task({ priority: 'F' })],
      'priority',
      'desc',
    );
    expect(out[0]?.priority).toBe('F');
  });

  it('title asc: alphabetical', () => {
    const out = sortTasksByField(
      [task({ title: 'zebra' }), task({ title: 'apple' })],
      'title',
      'asc',
    );
    expect(out[0]?.title).toBe('apple');
  });

  it('tag asc: first tag alphabetical, untagged last', () => {
    const t1 = task({
      tags: ['#work'],
      source: { originalMarkdown: '- [ ] task #work', originalBlock: '- [ ] task #work' },
    });
    const t2 = task({
      tags: ['#art'],
      source: { originalMarkdown: '- [ ] task #art', originalBlock: '- [ ] task #art' },
    });
    const t3 = task({
      source: { originalMarkdown: '- [ ] task no tag', originalBlock: '- [ ] task no tag' },
    });
    const out = sortTasksByField([t1, t3, t2], 'tag', 'asc');
    expect((out[0]?.source.originalMarkdown.match(/#[\w/-]+/u) ?? [])[0]).toBe('#art');
    expect(out[2]?.source.originalMarkdown).toContain('no tag');
  });
});

describe('groupTasksByPriority', () => {
  it('returns groups for present priorities only', () => {
    const tasks = [
      task({ priority: 'A', title: 'high' }),
      task({ priority: 'D', title: 'normal' }),
    ];
    const groups = groupTasksByPriority(tasks);
    expect(groups.map((g) => g.label)).toContain('🔺 Highest');
    expect(groups.map((g) => g.label)).toContain('Normal');
    expect(groups.map((g) => g.label)).not.toContain('⏬ Lowest');
  });

  it('tasks with priority A appear in Highest group', () => {
    const t = task({ priority: 'A', title: 'urgent' });
    const groups = groupTasksByPriority([t]);
    const highest = groups.find((g) => g.label === '🔺 Highest');
    expect(highest?.tasks[0]?.title).toBe('urgent');
  });
});

describe('groupTasksByTag', () => {
  it('groups by first tag; untagged go to "No tag"', () => {
    const t1 = task({
      tags: ['#work'],
      source: { originalMarkdown: '- [ ] a #work', originalBlock: '- [ ] a #work' },
    });
    const t2 = task({
      tags: ['#personal'],
      source: { originalMarkdown: '- [ ] b #personal', originalBlock: '- [ ] b #personal' },
    });
    const t3 = task({
      source: { originalMarkdown: '- [ ] c no tag', originalBlock: '- [ ] c no tag' },
    });
    const groups = groupTasksByTag([t1, t2, t3]);
    expect(groups.map((g) => g.label)).toContain('#work');
    expect(groups.map((g) => g.label)).toContain('#personal');
    expect(groups.map((g) => g.label)).toContain('No tag');
  });
});

describe('groupTasksByDate', () => {
  it('places a daily-note-only task in No date while retaining explicit due dates', () => {
    const groups = groupTasksByDate(
      [
        task({ title: 'daily-only', presentation: {} }),
        task({ title: 'due', planning: { due: '2026-06-26' } }),
      ],
      '2026-06-26',
      '2026-06-27',
    );
    expect(
      groups.find((group) => group.label === 'No date')?.tasks.map((task) => task.title),
    ).toEqual(['daily-only']);
    expect(
      groups.find((group) => group.label === 'Today')?.tasks.map((task) => task.title),
    ).toEqual(['due']);
  });

  it('returns Overdue group for tasks with past due date', () => {
    const t = task({ planning: { due: '2020-01-01' } });
    const groups = groupTasksByDate([t], '2026-06-26', '2026-06-27');
    expect(groups[0]?.label).toBe('Overdue');
    expect(groups[0]?.tasks).toHaveLength(1);
  });
});
