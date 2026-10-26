import { afterEach, expect, it, vi } from 'vitest';
import { TaskTimelineSurface } from '../src/panels/task-collection/TaskTimelineSurface';
import { indexedRows } from '../src/panels/task-list/taskListRows';
import { defaultTaskTimelineSettings } from '../src/task-lists/taskTimelineSettings';
import { localDate, type TaskPlanning } from '../src/tasks';
import { expectDefined } from './helpers';
import { prepareTaskPanelViewport } from './support/taskPanelViewport';
afterEach(() => vi.restoreAllMocks());
it('bounds mounted rows and calendar cells and reveals a distant task through the shared viewport', () => {
  const host = document.body.createDiv({ cls: 'abyss-center-scroll' });
  prepareTaskPanelViewport(host);
  const settings = defaultTaskTimelineSettings();
  const surface = new TaskTimelineSurface<TaskPlanning>(
    {
      host,
      scroll: host,
      mountedChanged: () => {},
      reportFailure: (error) => {
        throw error;
      },
      mount: (parent, row) => {
        const element = parent.createDiv({ cls: 'abyss-task-card' });
        element.dataset['key'] = row.key;
        return {
          element,
          update: () => {},
          destroy: () => {
            element.remove();
          },
        };
      },
    },
    {
      settings: () => settings,
      now: () => new Date(2026, 9, 26),
      planning: (value) => value,
      snapshot: () => undefined,
      commit: async () => false,
      select: () => {},
      openDates: () => {},
      changeScale: () => {},
    },
  );
  try {
    const rows = indexedRows(
      Array.from({ length: 5000 }, (_, i) => ({
        kind: 'task' as const,
        key: `n:${i}`,
        taskKey: `n:${i}`,
        task: { start: localDate('2026-10-24'), due: localDate('2026-10-28') },
      })),
    );
    surface.update(rows, {
      revision: 'one',
      preserveAnchor: true,
      estimate: () => 64,
      measurementRevision: () => '',
    });
    const today = expectDefined(
      host.querySelector<HTMLElement>(
        '.abyss-project-timeline-axis-dates > .abyss-project-timeline-today',
      ),
    );
    const tracks = [
      ...host.querySelectorAll<HTMLElement>(
        '.abyss-task-timeline-row > .abyss-project-timeline-track',
      ),
    ];
    expect(tracks.length).toBeGreaterThan(0);
    for (const track of tracks) {
      expect(
        track.querySelector<HTMLElement>(':scope > .abyss-project-timeline-today')?.style.left,
      ).toBe(today.style.left);
    }
    expect(host.querySelectorAll('.abyss-task-card').length).toBeGreaterThan(0);
    expect(host.querySelectorAll('.abyss-task-card').length).toBeLessThan(100);
    expect(host.querySelectorAll('.abyss-project-timeline-axis-cell').length).toBeLessThan(100);
    expect(surface.reveal('n:4999')?.dataset['key']).toBe('n:4999');
    expect(surface.mountedKeys().length).toBeLessThan(100);
    const card = expectDefined(surface.element('n:4999'));
    expect(card.classList.contains('abyss-task-card')).toBe(true);
  } finally {
    surface.destroy();
    host.remove();
  }
});
