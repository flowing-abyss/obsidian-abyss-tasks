import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  exposeScrollSurface,
  rapidScroll,
  readyRowLabel,
  reversalStep,
  uncoveredHeight,
  verifyProject,
  verifyTask,
  type RecordScroll,
  type ScrollObservation,
} from '../tooling/performance/native-scroll';

describe('cross-view scroll observation', () => {
  it('scales the Task Timeline reversal to fit the full multi-screen route', () => {
    expect(reversalStep('tasks.timeline', { clientHeight: 936, scrollHeight: 60_000 })).toBe(936);
    expect(reversalStep('tasks.timeline', { clientHeight: 1200, scrollHeight: 60_000 })).toBe(950);
    expect(reversalStep('tasks.timeline', { clientHeight: 936, scrollHeight: 1636 })).toBe(36);
    expect(reversalStep('projects.timeline', { clientHeight: 936, scrollHeight: 60_000 })).toBe(
      320,
    );
  });

  it('clips ready intervals, counts holes and does not double count pinned rows', () => {
    expect(
      uncoveredHeight(20, 120, [
        [90, 130],
        [0, 40],
        [30, 50],
        [75, 85],
      ]),
    ).toBe(30);
    expect(uncoveredHeight(20, 120, [])).toBe(100);
  });
});

function expectCanonicalCoverage(observed: ScrollObservation | undefined): void {
  expect(observed?.passes[0]?.map((step) => step.inputDistance)).toEqual([
    100, 200, 300, 400, 700, -600, -300, -200, -200, -400,
  ]);
  expect(observed?.passes[0]?.[7]).toMatchObject({
    mounted: 0,
    ready: 0,
    previewReady: 1,
    uncoveredPx: 100,
    blankPx: 0,
  });
  expect(observed?.passes[0]?.[8]).toMatchObject({
    mounted: 1,
    ready: 0,
    uncoveredPx: 100,
    blankPx: 0,
  });
  expect(observed?.passes[1]?.[9]).toMatchObject({
    mounted: 1,
    ready: 1,
    previewReady: 0,
    uncoveredPx: 0,
    blankPx: 0,
    visibleMetadataRows: 1,
  });
  expect(observed?.immediateHit).toBe(true);
}

describe('native reversal identity', () => {
  afterEach(() => {
    document.body.replaceChildren();
    vi.useRealTimers();
  });

  it('exposes a center collection through its own open detail toggle, preserving inspector scrolls', () => {
    const other = document.body.createDiv({ cls: 'abyss-panel-view' });
    const panel = document.body.createDiv({ cls: 'abyss-panel-view' });
    const toggle = (root: HTMLElement) =>
      root.createEl('button', {
        cls: 'abyss-compact-pane-button--right',
        attr: { 'aria-expanded': 'true' },
      });
    const unrelated = toggle(other);
    const button = toggle(panel);
    const center = panel.createDiv({ cls: 'abyss-center' }).createDiv();
    const picker = panel.createDiv({ cls: 'abyss-right' }).createDiv();
    const clicked = vi.fn(() => {
      button.setAttribute('aria-expanded', 'false');
    });
    button.addEventListener('click', clicked);
    const unrelatedClick = vi.spyOn(unrelated, 'click');
    exposeScrollSurface(picker);
    expect(clicked).not.toHaveBeenCalled();
    exposeScrollSurface(center);
    exposeScrollSurface(center);
    expect(clicked).toHaveBeenCalledTimes(1);
    expect(unrelatedClick).not.toHaveBeenCalled();
  });

  it('refuses a fully visible column with no actual scrolling range', async () => {
    const body = document.body.createDiv({ cls: 'abyss-project-kanban-column-body' });
    Object.defineProperties(body, { clientHeight: { value: 400 }, scrollHeight: { value: 400 } });
    await expect(rapidScroll('projects.kanban', vi.fn(), vi.fn(), vi.fn())).rejects.toThrow(
      'Populated scroll surface missing',
    );
  });

  it.each(['canonical', 'changed', 'preview', 'empty'] as const)(
    'requires an immediate Timeline hit after a multi-screen reversal (final row %s)',
    async (finalRow) => {
      const scroll = document.body.createDiv({ cls: 'abyss-task-timeline' });
      const row = scroll.createDiv({ cls: 'abyss-task-timeline-row' });
      const card = row.createDiv({ cls: 'abyss-task-card' });
      card.dataset['rowKey'] = 'test.md:9';
      const title = card.createSpan({ cls: 'abyss-task-title', text: 'Target' });
      const formattedTitle = title.createEl('em');
      const status = card.createSpan({ cls: 'abyss-status-marker' });
      const metadata = card.createSpan({ cls: 'abyss-task-tag', text: 'tag' });
      const preview = scroll.createDiv({ cls: 'abyss-task-timeline-preview-row' });
      const shortTitle = preview.createEl('button', {
        cls: 'abyss-task-timeline-preview-title',
        text: 'Target',
      });
      shortTitle.dataset['timelinePreviewKey'] = 'test.md:9';
      preview.remove();
      const click = vi.fn();
      formattedTitle.addEventListener('click', click);
      const bounds = new DOMRect(10, 10, 160, 100);
      for (const element of [scroll, row, title, status, metadata, preview, shortTitle]) {
        vi.spyOn(element, 'getBoundingClientRect').mockReturnValue(bounds);
      }
      let top = 0;
      let assignments = 0;
      Object.defineProperties(scroll, {
        clientWidth: { value: 160 },
        clientHeight: { value: 100 },
        scrollHeight: { value: 6000 },
        scrollTop: {
          get: () => top,
          set: (next: number) => {
            top = next;
            assignments++;
            preview.remove();
            scroll.append(row);
            card.append(status);
            if (assignments === 21 && finalRow === 'changed') card.dataset['rowKey'] = 'test.md:12';
            if (
              assignments === 9 ||
              (assignments === 21 && ['preview', 'empty'].includes(finalRow))
            ) {
              row.remove();
              if (assignments === 9 || finalRow === 'preview') scroll.append(preview);
            } else if (assignments === 10) {
              status.remove();
            }
          },
        },
      });
      const width = vi.spyOn(document.documentElement, 'clientWidth', 'get').mockReturnValue(900);
      const original = Object.getOwnPropertyDescriptor(document, 'elementFromPoint');
      Object.defineProperty(document, 'elementFromPoint', {
        configurable: true,
        value: () => {
          if (row.isConnected) return formattedTitle;
          return preview.isConnected ? shortTitle : scroll;
        },
      });
      const raf = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
        queueMicrotask(() => {
          callback(performance.now());
        });
        return 1;
      });
      const record = vi.fn<RecordScroll>();
      const verify = vi.fn(() => Promise.resolve());
      try {
        const run = rapidScroll(
          'tasks.timeline',
          async (_id, action) => {
            await action();
          },
          record,
          verify,
        );
        if (finalRow === 'preview' || finalRow === 'empty') {
          await expect(run).rejects.toThrow('Immediate Timeline reversal target');
          expect(verify).not.toHaveBeenCalled();
          return;
        }
        await run;
        expectCanonicalCoverage(record.mock.calls[0]?.[1]);
        expect(click).toHaveBeenCalledOnce();
        expect(record.mock.calls[0]?.[1].originalTargetHit).toBe(finalRow === 'canonical');
        expect(verify).toHaveBeenCalledWith(
          finalRow === 'changed' ? 'test.md:12' : 'test.md:9',
          'Target',
        );
      } finally {
        raf.mockRestore();
        width.mockRestore();
        if (original === undefined) Reflect.deleteProperty(document, 'elementFromPoint');
        else Object.defineProperty(document, 'elementFromPoint', original);
      }
    },
  );

  it('records native reanchoring separately from the positions reached on reversal', async () => {
    const scroll = document.body.createDiv({ cls: 'abyss-dep-search-results' });
    Object.defineProperties(scroll, {
      clientHeight: { value: 100 },
      scrollHeight: { value: 2400 },
    });
    const option = scroll.createEl('button', { cls: 'abyss-dep-search-option' });
    const title = option.createSpan({ cls: 'abyss-dep-search-title', text: 'Candidate' });
    const bounds = {
      left: 10,
      top: 10,
      right: 110,
      bottom: 110,
      height: 100,
      width: 100,
    } as DOMRect;
    vi.spyOn(scroll, 'getBoundingClientRect').mockReturnValue(bounds);
    vi.spyOn(option, 'getBoundingClientRect').mockReturnValue(bounds);
    vi.spyOn(title, 'getBoundingClientRect').mockReturnValue({ ...bounds, height: 20, bottom: 30 });
    const viewport = vi.spyOn(document.documentElement, 'clientWidth', 'get').mockReturnValue(900);
    const original = Object.getOwnPropertyDescriptor(document, 'elementFromPoint');
    Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => title });
    const raf = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      queueMicrotask(() => {
        scroll.scrollTop = 0;
        callback(performance.now());
      });
      return 1;
    });
    const verify = vi.fn(() => Promise.resolve());
    const record = vi.fn<RecordScroll>();
    try {
      await rapidScroll(
        'inspector.dependencies',
        async (_id, action) => {
          await action();
        },
        record,
        verify,
      );
      const observation = record.mock.calls[0]?.[1];
      expect(verify).toHaveBeenCalledWith('Candidate', 'Candidate');
      expect(observation?.passes[0]?.some((step) => step.distance < 0)).toBe(true);
      expect(observation?.passes[0]?.every((step) => step.inputDistance > 0)).toBe(true);
    } finally {
      raf.mockRestore();
      viewport.mockRestore();
      if (original === undefined) Reflect.deleteProperty(document, 'elementFromPoint');
      else Object.defineProperty(document, 'elementFromPoint', original);
    }
  });

  it('counts actionable labels while the outer dialog fetches the next range', () => {
    const dialog = document.body.createDiv({ attr: { 'aria-busy': 'true' } });
    const row = dialog.createEl('button', {
      cls: 'abyss-dep-search-option',
      attr: { role: 'option', 'aria-disabled': 'false' },
    });
    const label = row.createSpan({ cls: 'abyss-dep-search-title', text: 'Candidate' });
    vi.spyOn(label, 'getBoundingClientRect').mockReturnValue({ height: 20 } as DOMRect);
    const read = () => readyRowLabel(row, '.abyss-dep-search-title');
    expect(read()).toBe(label);
    row.setAttribute('aria-busy', 'true');
    expect(read()).toBeUndefined();
    row.removeAttribute('aria-busy');
    dialog.setAttribute('inert', '');
    expect(read()).toBeUndefined();
    dialog.removeAttribute('inert');
    row.disabled = true;
    expect(read()).toBeUndefined();
    row.setAttribute('aria-disabled', 'true');
    row.createSpan({ cls: 'abyss-dep-search-reason', text: 'Already linked' });
    expect(read()).toBe(label);
  });
  it('requires all mounted dashboard task sources to match the clicked project path', async () => {
    vi.useFakeTimers();
    const title = document.body.createEl('button', {
      cls: 'abyss-project-dashboard-title',
      text: 'Project-004',
    });
    Object.defineProperty(title, 'clientHeight', { value: 28 });
    const tasks = document.body.createDiv({ cls: 'abyss-project-tasks' });
    const card = tasks.createDiv({ cls: 'abyss-task-card' });
    card.dataset['rowKey'] = 'Other/Project-004.md:9';
    const path = 'Fixture/Project-004.md';
    const done = vi.fn();
    const result = verifyProject(path, 'Project-004').then(done);
    await vi.advanceTimersByTimeAsync(25);
    expect(done).not.toHaveBeenCalled();
    card.dataset['rowKey'] = `${path}:9`;
    await vi.advanceTimersByTimeAsync(25);
    await result;
    expect(done).toHaveBeenCalledOnce();
  });

  it('requires the matching selected task even when the inspector title is identical', async () => {
    vi.useFakeTimers();
    const card = document.body
      .createDiv({ cls: 'abyss-center' })
      .createDiv({ cls: 'abyss-task-card is-selected' });
    card.dataset['rowKey'] = 'source.md:7';
    const inspector = document.body.createDiv({ cls: 'abyss-right-title-view', text: 'Duplicate' });
    Object.defineProperty(inspector, 'clientHeight', { value: 28 });
    const done = vi.fn();
    const result = verifyTask('source.md:2', 'Duplicate').then(done);
    await vi.advanceTimersByTimeAsync(25);
    expect(done).not.toHaveBeenCalled();
    card.dataset['rowKey'] = 'source.md:2';
    await vi.advanceTimersByTimeAsync(25);
    await result;
    expect(done).toHaveBeenCalledOnce();
  });
});
