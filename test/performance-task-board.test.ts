import { describe, expect, it } from 'vitest';
import { taskBoardEvidence } from '../tooling/performance/native-helpers';
import { scenarioIds } from '../tooling/performance/types';

describe('native task board evidence', () => {
  it('requires the canonical population and ready, bounded column mounts', () => {
    const host = document.body.createDiv();
    const column = host.createDiv({ cls: 'abyss-task-kanban-column' });
    column.dataset['columnKey'] = 'status:todo';
    const count = column.createSpan({ cls: 'abyss-task-kanban-column-count', text: '1000' });
    const expected = new Map([['status:todo', 1000]]);
    try {
      expect(() => taskBoardEvidence(host, expected)).toThrow('populated');
      const card = column.createDiv({ cls: 'abyss-task-card', text: 'A ready task' });
      expect(taskBoardEvidence(host, expected)).toEqual({ tasks: 1000, columns: 1, mounted: 1 });
      card.inert = true;
      expect(() => taskBoardEvidence(host, expected)).toThrow('populated');
      card.inert = false;
      count.textContent = '999';
      expect(() => taskBoardEvidence(host, expected)).toThrow('population');
      count.textContent = '1000';
      for (let index = 0; index < 80; index++)
        column.createDiv({ cls: 'abyss-task-card', text: 'Unexpected unbounded mount' });
      expect(() => taskBoardEvidence(host, expected)).toThrow('bounded');
    } finally {
      host.remove();
    }
  });
  it('enrolls board opening and scrolling in both complete fixture rosters', () => {
    for (const kind of ['standard', 'wide-tree'] as const) {
      expect(scenarioIds(kind, false)).toContain('ui.tasks.kanban');
      expect(scenarioIds(kind, false)).toContain('ui.tasks.kanban-scroll');
      expect(scenarioIds(kind, true)).toEqual(['startup.index']);
    }
  });
});
