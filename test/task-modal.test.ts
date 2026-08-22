import type { App } from 'obsidian';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppState } from '../src/app/AppState';
import type { TaskApplicationApi } from '../src/tasks';
import { task, taskQueryApi, testStatusRegistry } from './helpers';

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
}));

vi.mock('../src/panels/RightPanel', () => ({
  RightPanel: vi.fn().mockImplementation(function (
    this: unknown,
    state: AppState,
    _app: App,
    _statusRegistry: unknown,
    _settings: unknown,
    _onSuccessfulMutation: unknown,
    tasks: TaskApplicationApi | undefined,
  ) {
    mockState.capturedState = state;
    mockState.capturedTasks = tasks;
    return {
      mount: (el: HTMLElement) => {
        mockState.mountImpl(el);
        if (mockState.includeHeaderActions.value) {
          el.createDiv({ cls: 'abyss-right-header-actions' });
        }
      },
      destroy: mockState.destroyImpl,
    };
  }),
}));

// Import AFTER vi.mock (hoisted)
import { TaskModal } from '../src/ui/TaskModal';

function fakeApp(): App {
  return {} as App;
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
    modal = new TaskModal(app, testStatusRegistry());
  });

  afterEach(() => {
    modal.close();
  });

  describe('open', () => {
    it('creates .abyss-modal-backdrop appended to activeDocument.body', () => {
      modal.open(task());
      expect(activeDocument.body.querySelector('.abyss-modal-backdrop')).not.toBeNull();
    });

    it('inside backdrop creates .abyss-modal → .abyss-right.abyss-modal-body', () => {
      modal.open(task());
      const backdrop = activeDocument.body.querySelector('.abyss-modal-backdrop')!;
      expect(backdrop.querySelector('.abyss-modal')).not.toBeNull();
      expect(backdrop.querySelector('.abyss-right.abyss-modal-body')).not.toBeNull();
    });

    it('RightPanel constructed and mount called on panelEl', () => {
      modal.open(task());
      expect(mockState.mountImpl).toHaveBeenCalledTimes(1);
    });

    it('passes the shared task API into the modal RightPanel', () => {
      const tasks = {
        queries: taskQueryApi({
          resolve: (ref: import('../src/tasks/domain/types').TaskRef) => ({
            type: 'not-found' as const,
            ref,
          }),
        }),
        execute: vi.fn(),
      } satisfies TaskApplicationApi;
      modal = new TaskModal(app, testStatusRegistry(), undefined, tasks.queries, tasks);

      modal.open(task());

      expect(mockState.capturedTasks).toBe(tasks);
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
      const actions = activeDocument.body.querySelector('.abyss-right-header-actions')!;
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
      expect(() => modal.close()).not.toThrow();
    });

    it('close when never opened is a no-op', () => {
      const m = new TaskModal(app, testStatusRegistry());
      expect(() => m.close()).not.toThrow();
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
      modal = new TaskModal(
        app,
        testStatusRegistry(),
        undefined,
        undefined,
        undefined,
        undefined,
        interactionOwnership,
      );

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
