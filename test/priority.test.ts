import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import { toStatusRules } from '../src/settings/statusCatalogAdapter';
import { StatusCatalog } from '../src/tasks/domain/StatusCatalog';
import type { TaskPriority } from '../src/tasks/domain/types';
import { TaskMarkdownCodec } from '../src/tasks/infrastructure/markdown/TaskMarkdownCodec';

describe('priority line edits', () => {
  const codec = new TaskMarkdownCodec(
    new StatusCatalog(toStatusRules(DEFAULT_SETTINGS.taskStatuses)),
  );

  it.each<[TaskPriority, string]>([
    ['A', '🔺'],
    ['B', '⏫'],
    ['C', '🔼'],
    ['D', ''],
    ['E', '🔽'],
    ['F', '⏬'],
  ])('sets priority %s losslessly', (priority, marker) => {
    const source = '- [ ] title #tag 🔁 every week 🆔 keep ⛔ dep 📅 2026-07-20 ^block';
    const result = codec.applyLineEdit(source, { type: 'set-priority', priority });
    expect(result.type).toBe(priority === 'D' ? 'unchanged' : 'changed');
    if (result.type === 'invalid') throw new Error('priority edit unexpectedly invalid');
    expect(result.content).toContain('#tag');
    expect(result.content).toContain('🆔 keep');
    expect(result.content).toContain('⛔ dep');
    expect(result.content).toContain('^block');
    if (marker.length > 0) expect(result.content).toContain(marker);
  });

  it('rejects duplicate priority spans without changing content', () => {
    const source = '- [ ] title 🔺 ⏬ custom';
    expect(codec.applyLineEdit(source, { type: 'set-priority', priority: 'C' })).toEqual({
      type: 'invalid',
      issues: [{ code: 'duplicate-field', field: 'priority' }],
    });
  });
});
