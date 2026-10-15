import { MarkdownRenderer } from 'obsidian';
import { expect, it, vi } from 'vitest';
import { TaskCardRenderer } from '../src/panels/center/TaskCardRenderer';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import { deferred, expectDefined, flushMicrotasks, methodOf, useRealMoment } from './helpers';
import { prepareTaskPanelViewport } from './support/taskPanelViewport';
import { mountCanonicalSearchUi } from './support/taskSearchUiHarness';
import { taskViewportOwner } from './support/taskViewportOwner';

useRealMoment();

function frames() {
  const queued = new Map<number, FrameRequestCallback>();
  let next = 0;
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
    queued.set(++next, callback);
    return next;
  });
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => queued.delete(id));
  return () => {
    const current = [...queued.values()];
    queued.clear();
    for (const callback of current) callback(0);
  };
}

it.each([95.5, 111])(
  'keeps cached ordinary predecessors reserved until Markdown commits its actual %spx height',
  async (actual) => {
    const frame = frames();
    const receipt = deferred<void>();
    let hold = false;
    let pending = false;
    let specialCard: HTMLElement | undefined;
    const mount = methodOf(TaskCardRenderer.prototype, 'mountInto');
    vi.spyOn(TaskCardRenderer.prototype, 'mountInto').mockImplementation(function (
      this: TaskCardRenderer,
      card,
      task,
      ...rest
    ) {
      if (task.source.line === 8) specialCard = card;
      const specialHeight = hold ? 80 : 95.5;
      card.setCssProps({ height: `${task.source.line === 8 ? specialHeight : 64}px` });
      return mount.call(this, card, task, ...rest);
    });
    vi.spyOn(MarkdownRenderer, 'render').mockImplementation(async (_app, text, holder) => {
      const special = text === '**needle** 8';
      if (hold && special) {
        pending = true;
        const card = expectDefined(specialCard);
        await receipt.promise;
        card.setCssProps({ height: `${actual}px` });
      }
      holder.textContent = text;
    });
    const h = await mountCanonicalSearchUi(
      { 'ordinary.md': Array.from({ length: 120 }, (_, n) => `- [ ] **needle** ${n}`).join('\n') },
      structuredClone(DEFAULT_SETTINGS),
      'tasks',
    );
    try {
      await flushMicrotasks(80);
      const surface = expectDefined(h.panel['taskSurface_abyssPrivate']).surface;
      const scroll = expectDefined(h.root.querySelector<HTMLElement>('.abyss-center-scroll'));
      surface.refreshMeasurements();
      await flushMicrotasks(40);
      const move = async (top: number) => {
        scroll.scrollTop = top;
        scroll.dispatchEvent(new Event('scroll'));
        frame();
        await flushMicrotasks(40);
      };
      await move(1200);
      expect(surface.element('ordinary.md:8')).toBeUndefined();
      await move(900);
      const anchor = expectDefined(surface.element('ordinary.md:15'));
      hold = true;
      scroll.scrollTop = 650;
      scroll.dispatchEvent(new Event('scroll'));
      const before = anchor.getBoundingClientRect().top;
      const writes = vi.spyOn(scroll, 'scrollTop', 'set');
      frame();
      await flushMicrotasks(40);
      expect(pending).toBe(true);
      expect(surface.element('ordinary.md:15')).toBe(anchor);
      expect(scroll.scrollTop).toBe(650);
      expect(anchor.getBoundingClientRect().top).toBe(before);
      expect(writes).not.toHaveBeenCalled();
      const predecessor = expectDefined(surface.element('ordinary.md:8'));
      const predecessorFrame = expectDefined(predecessor.parentElement);
      expect(predecessorFrame.hasClass('abyss-virtual-row-frame-clipped')).toBe(true);
      receipt.resolve();
      await flushMicrotasks(80);
      expect(scroll.scrollTop).toBe(650 + actual - 95.5);
      expect(anchor.getBoundingClientRect().top).toBe(before);
      expect(surface.element('ordinary.md:15')).toBe(anchor);
      expect(predecessorFrame.hasClass('abyss-virtual-row-frame-clipped')).toBe(false);
      expect(predecessor.getBoundingClientRect().height).toBe(actual);
      expect(writes.mock.calls).toEqual(actual === 95.5 ? [] : [[665.5]]);
      frame();
      await flushMicrotasks(40);
      expect(scroll.scrollTop).toBe(650 + actual - 95.5);
      expect(writes.mock.calls).toEqual(actual === 95.5 ? [] : [[665.5]]);
    } finally {
      receipt.resolve();
      h.dispose();
    }
  },
);

it.each(['eviction', 'replacement', 'adoption', 'destruction'] as const)(
  'rejects an old ordinary Markdown receipt after %s',
  async (change) => {
    const frame = frames();
    const oldText = deferred<void>();
    const newText = deferred<void>();
    let calls = 0;
    vi.spyOn(MarkdownRenderer, 'render').mockImplementation(async (_app, text, holder) => {
      if (text === '**Same**') await (++calls === 1 ? oldText.promise : newText.promise);
      holder.textContent = text;
    });
    const before = [
      '- [ ] Parent',
      '  - [ ] **Same**',
      ...Array.from({ length: 118 }, (_, n) => `- [ ] Neighbor ${n}`),
    ]
      .map((line) => `${line} #work`)
      .join('\n');
    const h = await mountCanonicalSearchUi(
      { 'ordinary.md': before },
      structuredClone(DEFAULT_SETTINGS),
      'tasks',
    );
    h.state.set('selectedList', { type: 'tag', tag: '#work' });
    const owner = change === 'adoption' ? taskViewportOwner() : undefined;
    try {
      await flushMicrotasks(80);
      const surface = expectDefined(h.panel['taskSurface_abyssPrivate']).surface;
      const previous = expectDefined(h.panel['ordinaryCards_abyssPrivate'].get('ordinary.md:1'));
      const refresh = vi.spyOn(surface, 'refreshMeasurements');
      const scroll = expectDefined(h.root.querySelector<HTMLElement>('.abyss-center-scroll'));
      if (change === 'eviction') {
        scroll.scrollTop = 3000;
        scroll.dispatchEvent(new Event('scroll'));
        frame();
      } else if (change === 'replacement') {
        h.index.installCommittedContent(
          'ordinary.md',
          before.replace('  - [ ] **Same**', '- [ ] **Same**'),
        );
        h.panel.refresh('source');
      } else if (change === 'adoption') {
        const adopted = expectDefined(owner);
        adopted.doc.body.append(h.root);
        prepareTaskPanelViewport(h.root, true);
        h.panel.onWindowMigrated();
        // The retired document must not trigger a measurement even before owner rebinding.
      } else h.dispose();
      await flushMicrotasks(80);
      refresh.mockClear();
      oldText.resolve();
      await flushMicrotasks(80);
      expect(refresh).not.toHaveBeenCalled();
      if (change === 'replacement') {
        const current = expectDefined(h.panel['ordinaryCards_abyssPrivate'].get('ordinary.md:1'));
        expect(current).not.toBe(previous);
        expect(current.element).toBe(previous.element);
        expect(
          expectDefined(current.element.parentElement).hasClass('abyss-virtual-row-frame-clipped'),
        ).toBe(true);
        newText.resolve();
        await flushMicrotasks(80);
        expect(refresh).toHaveBeenCalledTimes(1);
        expect(
          expectDefined(current.element.parentElement).hasClass('abyss-virtual-row-frame-clipped'),
        ).toBe(false);
      } else if (change === 'adoption') {
        const adopted = expectDefined(owner);
        surface.refreshMeasurements();
        await flushMicrotasks(80);
        adopted.flush();
        await flushMicrotasks(80);
        const current = expectDefined(h.panel['ordinaryCards_abyssPrivate'].get('ordinary.md:1'));
        expect(current).not.toBe(previous);
        expect(current.element.ownerDocument).toBe(adopted.doc);
        refresh.mockClear();
        newText.resolve();
        await flushMicrotasks(80);
        expect(refresh).toHaveBeenCalledTimes(1);
        expect(
          expectDefined(current.element.parentElement).hasClass('abyss-virtual-row-frame-clipped'),
        ).toBe(false);
      } else {
        expect(surface.element('ordinary.md:1')).toBeUndefined();
      }
    } finally {
      oldText.resolve();
      newText.resolve();
      h.dispose();
      owner?.destroy();
    }
  },
);
