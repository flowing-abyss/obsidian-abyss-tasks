import { Platform } from 'obsidian';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TaskModal } from '../src/ui/TaskModal';
import * as anchors from '../src/ui/textFieldAnchor';
import { expectDefined, testStatusRegistry, useRealMoment } from './helpers';
import { inspectorCleanups, inspectorHarness } from './support/inspectorHarness';
import { taskViewportOwner } from './support/taskViewportOwner';

useRealMoment();

afterEach(() => {
  inspectorCleanups.splice(0).forEach((cleanup) => {
    cleanup();
  });
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.empty();
  document.body.style.removeProperty('--keyboard-height');
});

function nativeGeometry() {
  const frames = new Map<number, FrameRequestCallback>();
  let id = 0;
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
    frames.set(++id, callback);
    return id;
  });
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((key) => {
    frames.delete(key);
  });
  const observers: ResizeObserverCallback[] = [];
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: ResizeObserverCallback) {
        observers.push(callback);
      }
      observe() {}
      disconnect() {}
    },
  );
  const viewport = Object.assign(new EventTarget(), {
    height: 914,
    width: 411,
    offsetTop: 0,
    offsetLeft: 0,
    scale: 1,
  });
  vi.stubGlobal('visualViewport', viewport);
  vi.stubGlobal('innerHeight', 914);
  return {
    viewport,
    flush() {
      const callbacks = [...frames.values()];
      frames.clear();
      callbacks.forEach((callback) => {
        callback(0);
      });
    },
    resize() {
      observers.forEach((callback) => {
        callback([], {} as ResizeObserver);
      });
    },
  };
}

function rect(element: Element, bounds: () => DOMRect) {
  vi.spyOn(element, 'getBoundingClientRect').mockImplementation(bounds);
}

function scrollport(element: HTMLElement, bounds: () => DOMRect, extent: number) {
  const stylesheet = createEl('style', {
    text: '.inspector-test-scrollport { overflow-y: auto; scroll-padding-top: 16px; scroll-padding-bottom: 16px; }',
  });
  element.ownerDocument.body.appendChild(stylesheet);
  element.addClass('inspector-test-scrollport');
  rect(element, bounds);
  vi.spyOn(element, 'clientHeight', 'get').mockImplementation(() => bounds().height);
  vi.spyOn(element, 'clientWidth', 'get').mockReturnValue(360);
  vi.spyOn(element, 'scrollHeight', 'get').mockReturnValue(extent);
}

async function fixture(mobile = true) {
  vi.spyOn(Platform, 'isMobile', 'get').mockReturnValue(mobile);
  const native = nativeGeometry();
  const h = await inspectorHarness('- [ ] Current\n  Description\n  - [ ] Child');
  h.el.classList.add('abyss-right');
  let bottom = 914;
  scrollport(h.el, () => new DOMRect(50, 156, 360, bottom - 156), 1100);
  const field = expectDefined(h.el.querySelector<HTMLTextAreaElement>('.abyss-comment-input'));
  rect(field, () => new DOMRect(68, 610 - h.el.scrollTop, 322, 60));
  return {
    ...h,
    ...native,
    field,
    keyboard(height = 578) {
      bottom = height;
      window.dispatchEvent(new Event('keyboardDidShow'));
      native.flush();
    },
    bounds(value: number) {
      bottom = value;
    },
  };
}

describe('mobile inspector field visibility', () => {
  it('reveals a comment after the keyboard opens without changing its draft or focus', async () => {
    const h = await fixture();
    h.field.value = 'Unsubmitted comment';
    h.field.focus();
    h.field.setSelectionRange(4, 8);
    h.flush();
    expect(h.el.scrollTop).toBe(0);

    h.keyboard();

    expect(h.el.scrollTop).toBe(108);
    expect(document.activeElement).toBe(h.field);
    expect([h.field.value, h.field.selectionStart, h.field.selectionEnd]).toEqual([
      'Unsubmitted comment',
      4,
      8,
    ]);
    expect(await h.read()).toBe('- [ ] Current\n  Description\n  - [ ] Child');
  });

  it('responds to the host scrollport resize even without a keyboard event', async () => {
    const h = await fixture();
    h.field.focus();
    h.flush();
    h.bounds(578);
    h.resize();
    h.flush();
    expect(h.el.scrollTop).toBe(108);
  });

  it('leaves an already visible description in place', async () => {
    const h = await fixture();
    expectDefined(h.el.querySelector<HTMLElement>('.abyss-right-desc-view')).click();
    const field = expectDefined(h.el.querySelector<HTMLTextAreaElement>('.abyss-right-desc-edit'));
    rect(field, () => new DOMRect(68, 353, 322, 60));
    field.focus();
    h.keyboard();
    expect(h.el.scrollTop).toBe(0);
    expect(document.activeElement).toBe(field);
  });

  it('reveals the existing subtask editor after a long list', async () => {
    const h = await fixture();
    expectDefined(h.el.querySelector<HTMLElement>('.abyss-subtask-add-row')).click();
    const field = expectDefined(h.el.querySelector<HTMLInputElement>('.abyss-subtask-new-input'));
    rect(field, () => new DOMRect(68, 595 - h.el.scrollTop, 322, 28));
    h.keyboard();
    expect(h.el.scrollTop).toBe(61);
    expect(document.activeElement).toBe(field);
  });

  it('intersects a panned visual viewport with host bounds without subtracting the keyboard twice', async () => {
    const h = await fixture();
    document.body.setCssProps({ '--keyboard-height': '336px' });
    h.field.focus();
    h.bounds(578);
    Object.assign(h.viewport, { height: 450, offsetTop: 40 });
    h.viewport.dispatchEvent(new Event('resize'));
    h.flush();
    expect(h.el.scrollTop).toBe(196);
  });

  it('reveals a field clipped by the top of the visible viewport', async () => {
    const h = await fixture();
    rect(h.field, () => new DOMRect(68, 210 - h.el.scrollTop, 322, 60));
    h.el.scrollTop = 80;
    h.viewport.offsetTop = 180;
    h.field.focus();
    h.flush();
    expect(h.el.scrollTop).toBe(14);
  });

  it('scrolls the native modal content without moving the page or rebuilding its editor', async () => {
    const h = await fixture();
    const modal = new TaskModal({
      app: h.app,
      tasks: h.api,
      queries: h.index,
      statusRegistry: testStatusRegistry(),
    });
    try {
      modal.open(h.node('Current').root);
      const shell = expectDefined(document.querySelector<HTMLElement>('.abyss-modal'));
      const content = expectDefined(shell.querySelector<HTMLElement>('.modal-content'));
      const body = expectDefined(shell.querySelector<HTMLElement>('.abyss-modal-body'));
      const field = expectDefined(body.querySelector<HTMLTextAreaElement>('.abyss-comment-input'));
      scrollport(shell, () => new DOMRect(16, 40, 380, 420), 420);
      scrollport(content, () => new DOMRect(17, 40, 378, 420), 800);
      scrollport(body, () => new DOMRect(17, 40 - content.scrollTop, 378, 800), 800);
      rect(field, () => new DOMRect(33, 780 - content.scrollTop, 330, 60));
      field.focus();
      h.flush();
      expect(content.scrollTop).toBe(380);
      expect(body.scrollTop).toBe(0);
      expect(document.documentElement.scrollTop).toBe(0);
      expect(document.activeElement).toBe(field);
    } finally {
      modal.close();
    }
  });

  it('follows the caret instead of the far edge of an oversized description, including IME input', async () => {
    const h = await fixture();
    expectDefined(h.el.querySelector<HTMLElement>('.abyss-right-desc-view')).click();
    const field = expectDefined(h.el.querySelector<HTMLTextAreaElement>('.abyss-right-desc-edit'));
    rect(field, () => new DOMRect(68, 200 - h.el.scrollTop, 322, 700));
    let caretTop = 530;
    vi.spyOn(anchors, 'textFieldAnchor').mockImplementation(
      () => new DOMRect(80, caretTop - h.el.scrollTop, 1, 20),
    );
    field.focus();
    h.keyboard();
    expect(h.el.scrollTop).toBe(0);
    caretTop = 640;
    field.dispatchEvent(new InputEvent('input', { bubbles: true, isComposing: true }));
    h.flush();
    expect(h.el.scrollTop).toBe(98);
    expect(document.activeElement).toBe(field);
    expect(await h.read()).toBe('- [ ] Current\n  Description\n  - [ ] Child');
  });

  it('does not fight a manual scroll or reset the position when the keyboard closes', async () => {
    const h = await fixture();
    h.field.focus();
    h.keyboard();
    h.el.scrollTop = 40;
    h.el.dispatchEvent(new Event('scroll'));
    h.flush();
    expect(h.el.scrollTop).toBe(40);
    h.bounds(914);
    h.resize();
    window.dispatchEvent(new Event('keyboardDidHide'));
    h.flush();
    expect(h.el.scrollTop).toBe(40);
  });

  it.each(['blur', 'remove', 'destroy'] as const)(
    'discards queued reveal work on %s',
    async (exit) => {
      const h = await fixture();
      h.bounds(578);
      h.field.focus();
      if (exit === 'blur') document.body.createEl('input').focus();
      if (exit === 'remove') h.field.remove();
      if (exit === 'destroy') h.panel.destroy();
      h.flush();
      h.resize();
      window.dispatchEvent(new Event('keyboardDidShow'));
      h.flush();
      expect(h.el.scrollTop).toBe(0);
    },
  );

  it('uses the current editor when focus moves before the scheduled frame', async () => {
    const h = await fixture();
    h.bounds(578);
    h.field.focus();
    expectDefined(h.el.querySelector<HTMLElement>('.abyss-subtask-add-row')).click();
    const next = expectDefined(h.el.querySelector<HTMLInputElement>('.abyss-subtask-new-input'));
    rect(next, () => new DOMRect(68, 300, 322, 28));
    h.flush();
    expect(h.el.scrollTop).toBe(0);
    expect(document.activeElement).toBe(next);
  });

  it('leaves desktop scrolling to the desktop host', async () => {
    const h = await fixture(false);
    h.field.focus();
    h.keyboard();
    h.resize();
    h.flush();
    expect(h.el.scrollTop).toBe(0);
  });

  it('keeps wiki-link suggestions inside the visible inspector above the keyboard', async () => {
    const h = await fixture();
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement,
    ) {
      if (this.matches('.abyss-link-suggest')) return new DOMRect(0, 0, 300, 300);
      return new DOMRect();
    });
    vi.spyOn(anchors, 'textFieldAnchor').mockImplementation(() => new DOMRect(80, 510, 1, 20));
    h.field.focus();
    h.keyboard();
    h.field.value = '[[';
    h.field.setSelectionRange(2, 2);
    h.field.dispatchEvent(new InputEvent('input', { bubbles: true }));
    await vi.waitFor(() => {
      expect(document.querySelector('.abyss-link-suggest')).not.toBeNull();
    });
    const popup = expectDefined(document.querySelector<HTMLElement>('.abyss-link-suggest'));
    expect(popup.dataset['side']).toBe('above');
    const top = parseFloat(popup.style.getPropertyValue('--abyss-pop-top'));
    expect(top).toBeGreaterThanOrEqual(156);
    expect(top + 300).toBeLessThan(578);
    expect(parseFloat(popup.style.getPropertyValue('--abyss-pop-height'))).toBe(342);
    h.bounds(914);
    h.resize();
    h.flush();
    expect(popup.dataset['side']).toBe('below');
    h.bounds(578);
    h.resize();
    h.flush();
    expect(popup.dataset['side']).toBe('above');
    expect(document.activeElement).toBe(h.field);
    expect(await h.read()).toBe('- [ ] Current\n  Description\n  - [ ] Child');
  });

  it('retires the previous window and follows the adopted inspector in its new window', async () => {
    const h = await fixture();
    const owner = taskViewportOwner();
    try {
      h.bounds(578);
      h.field.focus();
      owner.doc.body.appendChild(h.el);
      scrollport(h.el, () => new DOMRect(50, 156, 360, 422), 1100);
      h.panel.onWindowMigrated();
      const field = expectDefined(h.el.querySelector<HTMLTextAreaElement>('.abyss-comment-input'));
      rect(field, () => new DOMRect(68, 610 - h.el.scrollTop, 322, 60));
      field.focus();
      h.flush();
      h.resize();
      h.flush();
      expect(h.el.scrollTop).toBe(0);
      owner.flush();
      expect(h.el.scrollTop).toBe(108);
      expect(owner.doc.activeElement).toBe(field);
      h.panel.destroy();
      expect(owner.observers.every((observer) => observer.elements.size === 0)).toBe(true);
      expect(owner.frames.size).toBe(0);
    } finally {
      owner.destroy();
    }
  });
});
