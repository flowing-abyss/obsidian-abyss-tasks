import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppState } from '../src/app/AppState';
import { CaptureSessions } from '../src/panels/center/CaptureSessions';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import type {
  TaskApplicationApi,
  TaskCaptureApplicationApi,
  TaskCreateSession,
} from '../src/tasks';
import { deferred, flushMicrotasks, taskQueryApi, useRealMoment } from './helpers';

useRealMoment();
afterEach(() => {
  vi.restoreAllMocks();
  activeDocument.body.empty();
});

describe('capture session cancellation', () => {
  it('keeps a cancelled late destination resolution inert without mounting, focusing or executing', async () => {
    const state = new AppState();
    const pending = deferred<TaskCreateSession>();
    const execute = vi.fn<TaskApplicationApi['execute']>();
    const sessionExecute = vi.fn<TaskCreateSession['execute']>();
    const application: TaskApplicationApi & TaskCaptureApplicationApi = {
      queries: taskQueryApi(),
      execute,
      planCreate: () => pending.promise,
    };
    const root = activeDocument.body.createDiv();
    const captures = new CaptureSessions({
      state,
      settings: DEFAULT_SETTINGS,
      application,
      listNodes: () => application.queries.listNodes(),
      onCreationResult: () => {},
      root: () => root,
    });
    const host = root.createDiv();
    captures.renderCaptureHost(host, { type: 'list', selectionKey: 'inbox' });
    const next = activeDocument.body.createEl('button', { text: 'Unrelated focus' });
    try {
      captures.openCapture(
        { type: 'list', selectionKey: 'inbox' },
        { type: 'default', source: 'search' },
      );
      captures.cancelActiveCapture();
      next.focus();
      pending.resolve({
        type: 'ready',
        destination: { filePath: 'Capture.md', insertion: { type: 'append' } },
        execute: sessionExecute,
      });
      await flushMicrotasks();
      expect(root.querySelector('.abyss-capture-surface')).toBeNull();
      expect(root.querySelector('.abyss-capture-input')).toBeNull();
      expect(activeDocument.activeElement).toBe(next);
      expect(execute).not.toHaveBeenCalled();
      expect(sessionExecute).not.toHaveBeenCalled();
      expect(host.querySelector<HTMLButtonElement>('.abyss-add-task-trigger')?.hidden).toBe(false);
    } finally {
      captures.cancelActiveCapture();
    }
  });
});
