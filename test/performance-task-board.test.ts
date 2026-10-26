import { describe, expect, it, vi } from 'vitest';
import { taskBoardEvidence, waitFor } from '../tooling/performance/native-helpers';
import type { Measure } from '../tooling/performance/native-scenarios';
import * as scenarios from '../tooling/performance/native-scenarios';
import type { Host } from '../tooling/performance/native-types';
import type { Sample } from '../tooling/performance/types';
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

function timelineHarness(kind: 'tasks' | 'projects', movable = true) {
  const root = document.body.createDiv();
  root.createEl('button', { cls: 'abyss-rail-btn', attr: { 'aria-label': 'Tasks' } });
  root.createEl('button', { cls: 'abyss-rail-btn', attr: { 'aria-label': 'Projects' } });
  const group = root.createDiv({ cls: 'abyss-tag-group-header' });
  group.createSpan({ cls: 'abyss-left-label', text: 'Profile' });
  const center = root.createDiv({ cls: 'abyss-center' });
  const receipt = center.createDiv();
  receipt.dataset['searchPhase'] = 'complete';
  receipt.dataset['searchLogicalResults'] = '6000';
  const controls = root.createDiv({
    cls: kind === 'tasks' ? 'abyss-task-collection-switcher' : 'abyss-project-overview-switcher',
  });
  center.createDiv({ cls: 'abyss-task-card', text: 'List preparation task' });
  center.createDiv({ cls: 'abyss-project-table-row', text: 'Project table row' });
  center.createDiv({ cls: 'abyss-project-kanban-card', text: 'Project Kanban card' });
  for (const label of ['List view', 'Table view', 'Kanban view'])
    controls.createEl('button', { attr: { 'aria-label': label } });
  const button = controls.createEl('button', { attr: { 'aria-label': 'Timeline view' } });
  const scroller = center.createDiv({
    cls: `abyss-project-timeline-scroll${kind === 'tasks' ? ' abyss-task-timeline' : ''}`,
  });
  const axis = scroller.createDiv({ cls: 'abyss-project-timeline-axis' });
  const date = axis.createDiv({ text: '26', attr: { 'data-start-day': '2026-10-26' } });
  const row = scroller.createDiv({
    cls: `abyss-project-timeline-row${kind === 'tasks' ? ' abyss-task-timeline-row' : ''}`,
  });
  const content = row.createDiv({
    cls: kind === 'tasks' ? 'abyss-task-card' : 'abyss-project-timeline-summary',
    text: 'A populated row',
  });
  Object.defineProperties(scroller, {
    clientWidth: { configurable: true, value: 800 },
    clientHeight: { configurable: true, value: 500 },
    scrollWidth: { configurable: true, value: 2800 },
  });
  vi.spyOn(scroller, 'getBoundingClientRect').mockReturnValue({
    width: 800,
    height: 500,
  } as DOMRect);
  let left = 0;
  const positions: number[] = [];
  Object.defineProperty(scroller, 'scrollLeft', {
    configurable: true,
    get: () => left,
    set: (next: number) => {
      if (movable) left = next;
      positions.push(left);
      scroller.dispatchEvent(new Event('scroll'));
    },
  });
  const samples: Record<string, Sample['facts']> = {};
  const measure: Measure = async (id, action, prepare) => {
    await prepare?.();
    samples[id] = await action();
  };
  const host = {
    plugins: { plugins: { 'abyss-tasks': { queries: { listNodes: () => Array<unknown>(6000) } } } },
  } as unknown as Host;
  return { root, button, scroller, date, content, receipt, positions, measure, samples, host };
}

describe('native Timeline scenarios', () => {
  it('opens Tasks Timeline and records three finite native scrolls with logical facts', async () => {
    const h = timelineHarness('tasks');
    const controls: string[] = [];
    h.root
      .querySelector('.abyss-tag-group-header')
      ?.addEventListener('click', () => controls.push('profile'));
    h.root
      .querySelector('[aria-label="List view"]')
      ?.addEventListener('click', () => controls.push('list'));
    h.button.addEventListener('click', () => controls.push('timeline'));
    try {
      await scenarios.taskTimelineScenarios(h.host, h.measure);
      expect(controls).toEqual(['profile', 'list', 'timeline']);
      expect(h.positions).toEqual([500, 1500, 1000]);
      expect(h.samples).toEqual({
        'ui.tasks.timeline': { tasks: 6000, view: 'timeline' },
        'ui.tasks.timeline-scroll': { tasks: 6000, scrolls: 3, view: 'timeline' },
      });
    } finally {
      h.root.remove();
    }
  });
  it('uses the same finite horizontal workload for Projects Timeline', async () => {
    const h = timelineHarness('projects');
    try {
      await scenarios.projectScenarios(h.measure);
      expect(h.positions).toEqual([500, 1500, 1000]);
      expect(h.samples['ui.projects.timeline-scroll']).toEqual({
        projects: 100,
        scrolls: 3,
        view: 'timeline',
      });
    } finally {
      h.root.remove();
    }
  });
  it('waits for a populated date axis and ready task rows before accepting open or scroll', async () => {
    const h = timelineHarness('tasks');
    h.date.remove();
    h.content.setAttribute('aria-busy', 'true');
    let settled = false;
    const result = scenarios.taskTimelineScenarios(h.host, h.measure).then(() => {
      settled = true;
    });
    try {
      await new Promise((resolve) => window.setTimeout(resolve, 100));
      expect(settled).toBe(false);
      expect(h.positions).toEqual([]);
      h.scroller.querySelector('.abyss-project-timeline-axis')?.append(h.date);
      h.content.removeAttribute('aria-busy');
      await result;
      expect(h.positions).toEqual([500, 1500, 1000]);
    } finally {
      h.root.remove();
    }
  });
  it('does not accept a horizontal scroll until its rows and dates are ready', async () => {
    const h = timelineHarness('projects');
    h.scroller.addEventListener('scroll', () => {
      if (h.positions.length !== 1) return;
      h.date.remove();
      h.content.inert = true;
    });
    const result = scenarios.projectScenarios(h.measure);
    try {
      await waitFor(() => h.positions.length === 1, 'first horizontal request');
      await new Promise((resolve) => window.setTimeout(resolve, 50));
      expect(h.positions).toEqual([500]);
      expect(h.samples).not.toHaveProperty('ui.projects.timeline-scroll');
      h.scroller.querySelector('.abyss-project-timeline-axis')?.append(h.date);
      h.content.inert = false;
      await result;
      expect(h.positions).toEqual([500, 1500, 1000]);
      expect(h.samples['ui.projects.timeline-scroll']).toEqual({
        projects: 100,
        scrolls: 3,
        view: 'timeline',
      });
    } finally {
      h.root.remove();
    }
  });
  it.each(['no-range', 'unchanged-offset', 'unbounded-rows'] as const)(
    'rejects %s instead of recording successful horizontal work',
    async (failure) => {
      const h = timelineHarness('projects', failure !== 'unchanged-offset');
      if (failure === 'no-range') Object.defineProperty(h.scroller, 'scrollWidth', { value: 800 });
      if (failure === 'unbounded-rows')
        for (let index = 0; index < 80; index++)
          h.scroller.createDiv({ cls: 'abyss-project-timeline-row', text: 'Unexpected row' });
      try {
        await expect(scenarios.projectScenarios(h.measure)).rejects.toThrow(
          {
            'no-range': 'horizontal range',
            'unchanged-offset': 'offset',
            'unbounded-rows': 'bounded',
          }[failure],
        );
        expect(h.samples).not.toHaveProperty('ui.projects.timeline-scroll');
      } finally {
        h.root.remove();
      }
    },
  );
});
