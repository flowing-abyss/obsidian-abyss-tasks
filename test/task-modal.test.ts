import { Scope, type App } from 'obsidian';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppState } from '../src/app/AppState';
import type { RightPanel, RightPanelMutationLifecycle } from '../src/panels/RightPanel';
import { localDate, type CommentTimeContextProvider, type TaskApplicationApi } from '../src/tasks';
import type { TaskRef } from '../src/tasks/domain/types';
import type { InteractionOwnershipPort } from '../src/ui/interactionOwnership';
import { expectDefined, task, taskQueryApi, testStatusRegistry } from './helpers';
import { scopeKeyboardEvent } from './support/scopeKeyboardEvent';

// vi.hoisted runs BEFORE vi.mock factory execution, avoiding TDZ.
// The factory captures these refs by closure.
const mockState = vi.hoisted(() => ({
  mountImpl: vi.fn(),
  destroyImpl: vi.fn(),
  includeHeaderActions: { value: true },
  // Captures the AppState instance TaskModal constructs for RightPanel, so tests can
  // inspect taskStack after simulating a store update (RightPanel itself is mocked out).
  capturedState: null as AppState | null,
  capturedTasks: undefined as TaskApplicationApi | undefined,
  capturedOwnership: undefined as InteractionOwnershipPort | undefined,
  capturedCommentTime: undefined as CommentTimeContextProvider | undefined,
  capturedLifecycle: undefined as ((event: RightPanelMutationLifecycle) => void) | undefined,
}));

vi.mock('../src/panels/RightPanel', () => ({
  RightPanel: class RightPanelMock {
    constructor({
      state,
      tasks,
      onMutationLifecycle: lifecycle,
      commentTimeContext: commentTime,
      interactionOwnership: ownership,
    }: ConstructorParameters<typeof RightPanel>[0]) {
      mockState.capturedState = state;
      mockState.capturedTasks = tasks;
      mockState.capturedOwnership = ownership;
      mockState.capturedCommentTime = commentTime;
      mockState.capturedLifecycle = lifecycle;
    }

    mount(el: HTMLElement): void {
      mockState.mountImpl(el);
      if (mockState.includeHeaderActions.value) {
        el.createDiv({ cls: 'abyss-right-header-actions' });
      }
    }

    destroy(): void {
      mockState.destroyImpl();
    }
  },
}));

// Import AFTER vi.mock (hoisted)
import { TaskModal } from '../src/ui/TaskModal';

function fakeApp(): App {
  return {
    scope: new Scope(),
    keymap: { pushScope: vi.fn(), popScope: vi.fn() },
  } as unknown as App;
}

describe('TaskModal', () => {
  let modal: InstanceType<typeof TaskModal>;
  const app = fakeApp();

  beforeEach(() => {
    mockState.mountImpl.mockClear();
    mockState.destroyImpl.mockClear();
    mockState.includeHeaderActions.value = true;
    mockState.capturedState = null;
    mockState.capturedTasks = undefined;
    mockState.capturedOwnership = undefined;
    mockState.capturedCommentTime = undefined;
    mockState.capturedLifecycle = undefined;
    modal = new TaskModal({
      app,
      statusRegistry: testStatusRegistry(),
    });
  });

  afterEach(() => {
    modal.close();
  });

  it.each(['backdrop', 'Escape', 'Close'])(
    'returns explicit %s close to its connected opener',
    (action) => {
      const opener = document.body.createEl('button');
      opener.focus();
      modal.open(task());
      const backdrop = expectDefined(document.querySelector<HTMLElement>('.abyss-modal-backdrop'));
      expectDefined(document.querySelector<HTMLButtonElement>('.abyss-modal-close-btn')).focus();
      if (action === 'backdrop') backdrop.click();
      else if (action === 'Close')
        expectDefined(document.querySelector<HTMLElement>('.abyss-modal-close-btn')).click();
      else document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      expect(document.activeElement).toBe(opener);
      opener.remove();
    },
  );

  it.each(['outside', 'detached', 'public-close', 'replacement'] as const)(
    'does not focus a modal opener on %s',
    (action) => {
      const opener = document.body.createEl('button'),
        outside = document.body.createEl('input');
      opener.focus();
      modal.open(task());
      try {
        if (action === 'outside') outside.focus();
        else if (action === 'detached') opener.remove();
        else
          expectDefined(
            document.querySelector<HTMLButtonElement>('.abyss-modal-close-btn'),
          ).focus();
        if (action === 'public-close') modal.close();
        else if (action === 'replacement') modal.open(task({ title: 'replacement' }));
        else expectDefined(document.querySelector<HTMLElement>('.abyss-modal-backdrop')).click();
        expect(document.activeElement).not.toBe(opener);
      } finally {
        modal.close();
        opener.remove();
        outside.remove();
      }
    },
  );

  describe('open', () => {
    it('creates .abyss-modal-backdrop appended to activeDocument.body', () => {
      modal.open(task());
      expect(activeDocument.body.querySelector('.abyss-modal-backdrop')).not.toBeNull();
    });

    it('inside backdrop creates .abyss-modal → .abyss-right.abyss-modal-body', () => {
      modal.open(task());
      const backdrop = expectDefined(activeDocument.body.querySelector('.abyss-modal-backdrop'));
      expect(backdrop.querySelector('.abyss-modal')).not.toBeNull();
      expect(backdrop.querySelector('.abyss-right.abyss-modal-body')).not.toBeNull();
    });

    it('RightPanel constructed and mount called on panelEl', () => {
      modal.open(task());
      expect(mockState.mountImpl).toHaveBeenCalledTimes(1);
    });

    it('passes the supplied task API, ownership and comment provider into the inner panel with a live mutation callback', () => {
      const tasks = {
        queries: taskQueryApi({
          resolve: (ref: TaskRef) => ({
            type: 'not-found' as const,
            ref,
          }),
        }),
        execute: vi.fn(),
      } satisfies TaskApplicationApi;
      const ownership = { acquire: vi.fn(() => ({ release: vi.fn() })) };
      const commentTime: CommentTimeContextProvider = () => ({
        nowEpochMs: 0,
        today: localDate('2026-10-02'),
        locale: 'en',
        timeZone: 'UTC',
      });
      modal = new TaskModal({
        app,
        statusRegistry: testStatusRegistry(),
        queries: tasks.queries,
        tasks,
        commentTimeContext: commentTime,
        interactionOwnership: ownership,
      });

      modal.open(task());

      expect(mockState.capturedTasks).toBe(tasks);
      expect(mockState.capturedOwnership).toBe(ownership);
      expect(mockState.capturedCommentTime).toBe(commentTime);
      const lifecycle = expectDefined(mockState.capturedLifecycle);
      const ref = task().ref;
      const token = {};
      lifecycle({ phase: 'started', ref, token });
      expect(modal['ownedWriteRef_abyssPrivate']).toEqual(ref);
      lifecycle({ phase: 'settled', ref, token });
      expect(modal['ownedWriteRef_abyssPrivate']).toBeUndefined();
    });

    it('mounts the inner panel before subscribing active-selection convergence to the queries', () => {
      const unsubscribe = vi.fn();
      const subscribe = vi.fn(() => {
        expect(mockState.mountImpl).toHaveBeenCalledTimes(1);
        expect(mockState.capturedState?.get('taskStack')[0]?.title).toBe('mount first');
        return unsubscribe;
      });
      modal = new TaskModal({
        app,
        statusRegistry: testStatusRegistry(),
        queries: taskQueryApi({ subscribe }),
      });
      modal.open(task({ title: 'mount first' }));
      expect(subscribe).toHaveBeenCalledOnce();
      modal.close();
      expect(unsubscribe).toHaveBeenCalledOnce();
    });

    it('close button has abyss-right-action-btn abyss-modal-close-btn class', () => {
      modal.open(task());
      const btn = activeDocument.body.querySelector('.abyss-modal-close-btn') as HTMLButtonElement;
      expect(btn).not.toBeNull();
      expect(btn.classList.contains('abyss-right-action-btn')).toBe(true);
    });

    it('close button inserted into .abyss-right-header-actions when present', () => {
      mockState.includeHeaderActions.value = true;
      modal.open(task());
      const actions = expectDefined(
        activeDocument.body.querySelector('.abyss-right-header-actions'),
      );
      expect(actions.querySelector('.abyss-modal-close-btn')).not.toBeNull();
    });

    it('close button appended to panelEl when .abyss-right-header-actions missing (fallback)', () => {
      mockState.includeHeaderActions.value = false;
      modal.open(task());
      const panelEl = activeDocument.body.querySelector(
        '.abyss-right.abyss-modal-body',
      ) as HTMLElement;
      expect(panelEl.querySelector(':scope > .abyss-modal-close-btn')).not.toBeNull();
      // ensure not inside a header-actions (there is none)
      expect(activeDocument.body.querySelector('.abyss-right-header-actions')).toBeNull();
    });

    it('backdrop click (target === backdrop) closes modal', () => {
      modal.open(task());
      const backdrop = activeDocument.body.querySelector('.abyss-modal-backdrop') as HTMLElement;
      backdrop.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      expect(activeDocument.body.querySelector('.abyss-modal-backdrop')).toBeNull();
    });

    it('backdrop click where target is descendant does NOT close', () => {
      modal.open(task());
      const backdrop = activeDocument.body.querySelector('.abyss-modal-backdrop') as HTMLElement;
      const inner = backdrop.querySelector('.abyss-modal') as HTMLElement;
      inner.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      expect(activeDocument.body.querySelector('.abyss-modal-backdrop')).not.toBeNull();
    });

    it('Escape keydown closes modal', () => {
      modal.open(task());
      activeDocument.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      expect(activeDocument.body.querySelector('.abyss-modal-backdrop')).toBeNull();
    });

    it('Escape closes the modal and consumes the event before it reaches the window', () => {
      modal.open(task());
      const windowKeydown = vi.fn();
      activeWindow.addEventListener('keydown', windowKeydown);
      try {
        const escape = new KeyboardEvent('keydown', {
          key: 'Escape',
          bubbles: true,
          cancelable: true,
        });
        activeDocument.dispatchEvent(escape);
        expect(activeDocument.body.querySelector('.abyss-modal-backdrop')).toBeNull();
        expect(escape.defaultPrevented).toBe(true);
        expect(windowKeydown).not.toHaveBeenCalled();
      } finally {
        activeWindow.removeEventListener('keydown', windowKeydown);
      }
    });

    // Characterization: passes on master; guards the yield to inner surfaces after the reorder.
    it('leaves the modal open when an inner surface already consumed the Escape', () => {
      modal.open(task());
      const consume = (event: KeyboardEvent): void => {
        if (event.key === 'Escape') event.preventDefault();
      };
      activeDocument.addEventListener('keydown', consume, true);
      try {
        expectDefined(
          activeDocument.body.querySelector<HTMLElement>('.abyss-modal-backdrop'),
        ).dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
        );
        expect(activeDocument.body.querySelector('.abyss-modal-backdrop')).not.toBeNull();
      } finally {
        activeDocument.removeEventListener('keydown', consume, true);
      }
    });

    it('leaves the modal open and the event unconsumed while an IME owns the Escape', () => {
      modal.open(task());
      const escape = new KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
        cancelable: true,
        isComposing: true,
      });
      activeDocument.dispatchEvent(escape);
      expect(activeDocument.body.querySelector('.abyss-modal-backdrop')).not.toBeNull();
      expect(escape.defaultPrevented).toBe(false);
    });

    it('other keys do not close', () => {
      modal.open(task());
      activeDocument.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      expect(activeDocument.body.querySelector('.abyss-modal-backdrop')).not.toBeNull();
    });
  });

  describe('close', () => {
    it('removes backdrop from DOM', () => {
      modal.open(task());
      modal.close();
      expect(activeDocument.body.querySelector('.abyss-modal-backdrop')).toBeNull();
    });

    it('calls RightPanel.destroy()', () => {
      modal.open(task());
      mockState.destroyImpl.mockClear();
      modal.close();
      expect(mockState.destroyImpl).toHaveBeenCalledTimes(1);
    });

    it('removes keydown listener from ownerDoc', () => {
      modal.open(task());
      modal.close();
      // dispatching Escape after close should not throw and should not re-close
      expect(() =>
        activeDocument.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })),
      ).not.toThrow();
    });

    it('close twice is a no-op', () => {
      modal.open(task());
      modal.close();
      expect(() => {
        modal.close();
      }).not.toThrow();
    });

    it('close when never opened is a no-op', () => {
      const m = new TaskModal({
        app,
        statusRegistry: testStatusRegistry(),
      });
      expect(() => {
        m.close();
      }).not.toThrow();
    });
  });

  describe('lifecycle', () => {
    it('acquires once per open and releases on replacement, Escape, and repeated close', () => {
      const releases = [vi.fn(), vi.fn()];
      const interactionOwnership = {
        acquire: vi
          .fn()
          .mockReturnValueOnce({ release: releases[0] })
          .mockReturnValueOnce({ release: releases[1] }),
      };
      modal = new TaskModal({
        app,
        statusRegistry: testStatusRegistry(),
        interactionOwnership,
      });

      modal.open(task({ title: 'first' }));
      modal.open(task({ title: 'second' }));
      expect(interactionOwnership.acquire).toHaveBeenCalledTimes(2);
      expect(releases[0]).toHaveBeenCalledOnce();

      activeDocument.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      modal.close();
      expect(releases[1]).toHaveBeenCalledOnce();
    });

    it('open twice without close → first backdrop removed, second created', () => {
      modal.open(task({ title: 'first' }));
      const firstBackdrop = activeDocument.body.querySelector(
        '.abyss-modal-backdrop',
      ) as HTMLElement;
      modal.open(task({ title: 'second' }));
      const secondBackdrop = activeDocument.body.querySelector(
        '.abyss-modal-backdrop',
      ) as HTMLElement;
      expect(secondBackdrop).not.toBeNull();
      expect(firstBackdrop.isConnected).toBe(false);
      // only one backdrop at a time
      expect(activeDocument.body.querySelectorAll('.abyss-modal-backdrop')).toHaveLength(1);
    });
  });
});

it('acquires the custom modal parent only after mount and retires children before parent on reentrant close/reopen', () => {
  const app = fakeApp();
  const push = vi.spyOn(app.keymap, 'pushScope');
  const pop = vi.spyOn(app.keymap, 'popScope');
  const register = vi.spyOn(Scope.prototype, 'register');
  const unregister = vi.spyOn(Scope.prototype, 'unregister');
  const modal = new TaskModal({ app, statusRegistry: testStatusRegistry() });
  const order: string[] = [];
  pop.mockImplementation(() => {
    order.push('parent');
  });
  mockState.mountImpl.mockImplementationOnce(() => {
    expect(push).not.toHaveBeenCalled();
  });
  modal.open(task());
  expect(push).toHaveBeenCalledOnce();
  expect(register.mock.calls.map(([mods, key]) => [mods, key])).toEqual([[[], 'Escape']]);
  const stale = expectDefined(register.mock.calls[0])[2];
  mockState.destroyImpl.mockImplementationOnce(() => {
    order.push('child');
    modal.close();
  });
  modal.close();
  modal.close();
  expect(order).toEqual(['child', 'parent']);
  expect(unregister).toHaveBeenCalledOnce();
  modal.open(task());
  expect(
    stale(new KeyboardEvent('keydown', { key: 'Escape' }), {
      key: 'Escape',
      vkey: 'Escape',
      modifiers: '',
    }),
  ).toBeUndefined();
  expect(document.querySelector('.abyss-modal')).not.toBeNull();
  modal.close();
  expect(push).toHaveBeenCalledTimes(2);
  expect(pop).toHaveBeenCalledTimes(2);
  vi.restoreAllMocks();
});

it('closes from focused-target Scope transport while deferring nested editors and foreign focus', () => {
  const app = fakeApp();
  const register = vi.spyOn(Scope.prototype, 'register');
  const modal = new TaskModal({ app, statusRegistry: testStatusRegistry() });
  modal.open(task());
  const owner = expectDefined(document.querySelector<HTMLElement>('.abyss-modal'));
  const callback = expectDefined(register.mock.calls[0])[2];
  const context = { key: 'Escape', vkey: 'Escape', modifiers: '' };
  const foreign = document.body.createEl('button');
  try {
    const editor = owner.createEl('input');
    editor.focus();
    const editorEscape = scopeKeyboardEvent(editor, { key: 'Escape' });
    expect(callback(editorEscape, context)).toBeUndefined();
    expect(editorEscape.defaultPrevented).toBe(false);
    foreign.focus();
    expect(callback(scopeKeyboardEvent(foreign, { key: 'Escape' }), context)).toBeUndefined();
    const button = expectDefined(owner.querySelector('button'));
    button.focus();
    const event = scopeKeyboardEvent(button, { key: 'Escape' });
    expect(callback(event, context)).toBe(false);
    expect(event.defaultPrevented).toBe(true);
    expect(owner.isConnected).toBe(false);
    expect(callback(scopeKeyboardEvent(button, { key: 'Escape' }), context)).toBeUndefined();
  } finally {
    modal.close();
    foreign.remove();
    vi.restoreAllMocks();
  }
});

it('leaves no modal lease or mounted DOM after failed mount', () => {
  const app = fakeApp();
  const push = vi.spyOn(app.keymap, 'pushScope');
  const modal = new TaskModal({ app, statusRegistry: testStatusRegistry() });
  mockState.mountImpl.mockImplementationOnce(() => {
    throw new Error('mount failure');
  });
  expect(() => {
    modal.open(task());
  }).toThrow('mount failure');
  expect(push).not.toHaveBeenCalled();
  expect(document.querySelector('.abyss-modal')).toBeNull();
  modal.close();
});

it('never pushes a modal scope when mount leaves its DOM inactive', () => {
  const app = fakeApp();
  const push = vi.spyOn(app.keymap, 'pushScope');
  const modal = new TaskModal({ app, statusRegistry: testStatusRegistry() });
  mockState.mountImpl.mockImplementationOnce((element: HTMLElement) => {
    expectDefined(element.closest<HTMLElement>('.abyss-modal')).hidden = true;
  });
  try {
    modal.open(task());
    expect(push).not.toHaveBeenCalled();
    expect(document.querySelector('.abyss-modal')).toBeNull();
  } finally {
    modal.close();
    vi.restoreAllMocks();
  }
});
