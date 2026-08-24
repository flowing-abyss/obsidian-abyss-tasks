import { describe, expect, it, vi } from 'vitest';
import { localDate, type TaskCommandResult, type TaskCreateSession } from '../src/tasks';
import type { CaptureTarget } from '../src/ui/taskCapture/CaptureTargetResolver';
import { TaskCaptureController } from '../src/ui/taskCapture/TaskCaptureController';
import { describeTaskCreationResult } from '../src/ui/taskCommandResult';
import { deferred, task } from './helpers';

const successfulResult = (): TaskCommandResult => ({
  type: 'ok',
  outcome: {
    type: 'task',
    task: task({ title: 'Captured', source: { filePath: 'Inbox.md', line: 4 } }),
  },
  changed: true,
});

const failedResult = (): TaskCommandResult => ({
  type: 'invalid',
  issues: [{ code: 'invalid-title', field: 'title' }],
});

interface Harness {
  readonly controller: TaskCaptureController;
  readonly execute: ReturnType<typeof vi.fn<TaskCreateSession['execute']>>;
  readonly onResult: ReturnType<typeof vi.fn>;
  readonly onRequestClose: ReturnType<typeof vi.fn>;
}

function harness(
  implementation: TaskCreateSession['execute'] = async () => successfulResult(),
): Harness {
  const execute = vi.fn<TaskCreateSession['execute']>(implementation);
  const target: CaptureTarget = {
    label: 'Inbox · #inbox',
    context: { type: 'list', selection: 'inbox' },
    session: {
      type: 'ready',
      destination: { filePath: 'Inbox.md', insertion: { type: 'append' } },
      execute,
    },
    markdownPrefix: '#base',
    markdownSuffixes: ['#inbox'],
    initial: { due: { type: 'set', value: localDate('2026-08-22') } },
  };
  const onResult = vi.fn();
  const onRequestClose = vi.fn();
  return {
    controller: new TaskCaptureController({
      target,
      describe: describeTaskCreationResult,
      onResult,
      onRequestClose,
    }),
    execute,
    onResult,
    onRequestClose,
  };
}

describe('TaskCaptureController', () => {
  it('starts idle and lets observers detach and remount without owning the controller', () => {
    const { controller } = harness();
    const first = vi.fn();
    const second = vi.fn();

    const subscription = controller.subscribe(first);
    controller.setDraft('first draft');
    subscription.release();
    subscription.release();
    controller.setDraft('remounted draft');
    controller.subscribe(second);

    expect(first.mock.calls.map(([snapshot]) => snapshot)).toEqual([
      {
        phase: 'idle',
        draft: '',
        readonly: false,
        ariaBusy: false,
        focusEpoch: 0,
      },
      {
        phase: 'idle',
        draft: 'first draft',
        readonly: false,
        ariaBusy: false,
        focusEpoch: 0,
      },
    ]);
    expect(second).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledWith({
      phase: 'idle',
      draft: 'remounted draft',
      readonly: false,
      ariaBusy: false,
      focusEpoch: 0,
    });
  });

  it('does not notify a reentrantly attached observer twice in the active emission', () => {
    const { controller } = harness();
    const attached = vi.fn();
    let subscription: { release(): void } | undefined;
    controller.subscribe((snapshot) => {
      if (snapshot.draft === 'attach now' && subscription === undefined) {
        subscription = controller.subscribe(attached);
      }
    });

    controller.setDraft('attach now');

    expect(attached).toHaveBeenCalledOnce();
    expect(attached).toHaveBeenCalledWith(controller.snapshot());
  });

  it('skips an observer released by an earlier observer during the same emission', () => {
    const { controller } = harness();
    const notifications: string[] = [];
    let laterSubscription!: { release(): void };
    controller.subscribe((snapshot) => {
      if (snapshot.draft !== 'release later') return;
      notifications.push('earlier');
      laterSubscription.release();
    });
    laterSubscription = controller.subscribe((snapshot) => {
      if (snapshot.draft === 'release later') notifications.push('later');
    });

    controller.setDraft('release later');

    expect(notifications).toEqual(['earlier']);
  });

  it('snapshots the exact draft and synchronously exposes readonly pending state', async () => {
    const pending = deferred<TaskCommandResult>();
    const { controller, execute } = harness(() => pending.promise);
    controller.setDraft('  exact draft  ');

    const submission = controller.submit('enter');

    expect(controller.snapshot()).toEqual({
      phase: 'submitting',
      draft: '  exact draft  ',
      readonly: true,
      ariaBusy: true,
      focusEpoch: 0,
    });
    expect(execute).toHaveBeenCalledWith({
      markdownBody: '#base exact draft #inbox',
      initial: { due: { type: 'set', value: localDate('2026-08-22') } },
    });
    pending.resolve(successfulResult());
    await submission;
  });

  it('ignores duplicate Enter, an Enter-blur race, and draft mutation while pending', async () => {
    const pending = deferred<TaskCommandResult>();
    const { controller, execute } = harness(() => pending.promise);
    controller.setDraft('keep this exact text');

    const first = controller.submit('enter');
    const duplicate = controller.submit('enter');
    const blur = controller.submit('blur');
    controller.setDraft('replacement that must be ignored');

    expect(execute).toHaveBeenCalledOnce();
    expect(controller.snapshot().draft).toBe('keep this exact text');
    pending.resolve(failedResult());
    await Promise.all([first, duplicate, blur]);
    expect(controller.snapshot().draft).toBe('keep this exact text');
  });

  it('records blur intent during an Enter submission and closes after its success', async () => {
    const pending = deferred<TaskCommandResult>();
    const { controller, execute, onRequestClose } = harness(() => pending.promise);
    controller.setDraft('submit once then leave');

    const submission = controller.submit('enter');
    const blur = controller.submit('blur');
    pending.resolve(successfulResult());
    await Promise.all([submission, blur]);

    expect(execute).toHaveBeenCalledOnce();
    expect(controller.snapshot()).toMatchObject({ phase: 'closed', draft: '', focusEpoch: 0 });
    expect(onRequestClose).toHaveBeenCalledOnce();
  });

  it('does not cross the application boundary after a pending observer destroys it', async () => {
    const { controller, execute, onResult, onRequestClose } = harness();
    controller.subscribe((snapshot) => {
      if (snapshot.phase === 'submitting') controller.destroy();
    });
    const laterObserver = vi.fn();
    controller.subscribe(laterObserver);
    controller.setDraft('destroy before execute');
    laterObserver.mockClear();

    await controller.submit('enter');

    expect(execute).not.toHaveBeenCalled();
    expect(onResult).not.toHaveBeenCalled();
    expect(onRequestClose).not.toHaveBeenCalled();
    expect(laterObserver).not.toHaveBeenCalled();
    expect(controller.snapshot()).toMatchObject({
      phase: 'closed',
      draft: 'destroy before execute',
    });
  });

  it('stops a terminal emission and result continuation when an observer destroys it', async () => {
    const { controller, execute, onResult, onRequestClose } = harness();
    let submitted = false;
    controller.subscribe((snapshot) => {
      if (snapshot.phase === 'submitting') submitted = true;
      if (submitted && snapshot.phase === 'idle') controller.destroy();
    });
    const laterPhases: string[] = [];
    controller.subscribe((snapshot) => laterPhases.push(snapshot.phase));
    controller.setDraft('destroy on terminal');

    await controller.submit('enter');

    expect(execute).toHaveBeenCalledOnce();
    expect(onResult).not.toHaveBeenCalled();
    expect(onRequestClose).not.toHaveBeenCalled();
    expect(laterPhases).toEqual(['idle', 'idle', 'submitting']);
    expect(controller.snapshot()).toMatchObject({ phase: 'closed', draft: '' });
  });

  it('clears an Enter submission, remains open, and advances focusEpoch on success', async () => {
    const result = successfulResult();
    const { controller, onResult, onRequestClose } = harness(async () => result);
    controller.setDraft('first');

    await controller.submit('enter');

    expect(controller.snapshot()).toEqual({
      phase: 'idle',
      draft: '',
      readonly: false,
      ariaBusy: false,
      focusEpoch: 1,
    });
    expect(onResult).toHaveBeenCalledOnce();
    expect(onResult).toHaveBeenCalledWith(result, describeTaskCreationResult(result));
    expect(onRequestClose).not.toHaveBeenCalled();
  });

  it('clears and closes after a blur-origin success without requesting focus', async () => {
    const { controller, onRequestClose } = harness();
    controller.setDraft('blurred');

    await controller.submit('blur');

    expect(controller.snapshot()).toEqual({
      phase: 'closed',
      draft: '',
      readonly: false,
      ariaBusy: false,
      focusEpoch: 0,
    });
    expect(onRequestClose).toHaveBeenCalledOnce();
  });

  it.each([
    ['enter', 1],
    ['blur', 0],
  ] as const)('preserves the exact draft after a %s-origin failure', async (cause, focusEpoch) => {
    const result = failedResult();
    const { controller, onResult, onRequestClose } = harness(async () => result);
    controller.setDraft('  invalid draft  ');

    await controller.submit(cause);

    expect(controller.snapshot()).toEqual({
      phase: 'error',
      draft: '  invalid draft  ',
      readonly: false,
      ariaBusy: false,
      focusEpoch,
      error: describeTaskCreationResult(result),
    });
    expect(onResult).toHaveBeenCalledWith(result, describeTaskCreationResult(result));
    expect(onRequestClose).not.toHaveBeenCalled();
  });

  it('clears an error when the user edits the preserved draft', async () => {
    const { controller } = harness(async () => failedResult());
    controller.setDraft('invalid');
    await controller.submit('enter');

    controller.setDraft('corrected');

    expect(controller.snapshot()).toEqual({
      phase: 'idle',
      draft: 'corrected',
      readonly: false,
      ariaBusy: false,
      focusEpoch: 1,
    });
  });

  it('does not duplicate a close requested reentrantly by the result callback', async () => {
    const base = harness(async () => failedResult());
    const onRequestClose = vi.fn();
    let controller!: TaskCaptureController;
    controller = new TaskCaptureController({
      target: base.controller.target,
      describe: describeTaskCreationResult,
      onResult: () => controller.escape(),
      onRequestClose,
    });
    controller.setDraft('invalid');

    await controller.submit('enter');

    expect(controller.snapshot().phase).toBe('closed');
    expect(onRequestClose).toHaveBeenCalledOnce();
  });

  it('does not request a pending blur close after the result callback destroys the capture', async () => {
    const base = harness();
    const onRequestClose = vi.fn();
    let controller!: TaskCaptureController;
    controller = new TaskCaptureController({
      target: base.controller.target,
      describe: describeTaskCreationResult,
      onResult: () => controller.destroy(),
      onRequestClose,
    });
    controller.setDraft('successful');

    await controller.submit('blur');

    expect(controller.snapshot().phase).toBe('closed');
    expect(onRequestClose).not.toHaveBeenCalled();
  });

  it('does not request close after a closed-state observer destroys the controller', () => {
    const { controller, execute, onRequestClose } = harness();
    controller.subscribe((snapshot) => {
      if (snapshot.phase === 'closed') controller.destroy();
    });

    controller.escape();

    expect(execute).not.toHaveBeenCalled();
    expect(onRequestClose).not.toHaveBeenCalled();
  });

  it('Escape closes idle and error captures without submitting again', async () => {
    const idle = harness();
    idle.controller.setDraft('discard me');
    idle.controller.escape();
    expect(idle.controller.snapshot().phase).toBe('closed');
    expect(idle.execute).not.toHaveBeenCalled();
    expect(idle.onRequestClose).toHaveBeenCalledOnce();

    const error = harness(async () => failedResult());
    error.controller.setDraft('failed draft');
    await error.controller.submit('enter');
    error.controller.escape();
    error.controller.escape();
    expect(error.controller.snapshot()).toMatchObject({
      phase: 'closed',
      draft: 'failed draft',
    });
    expect(error.execute).toHaveBeenCalledOnce();
    expect(error.onRequestClose).toHaveBeenCalledOnce();
  });

  it('Escape during an Enter submission closes only after the request succeeds', async () => {
    const pending = deferred<TaskCommandResult>();
    const { controller, onRequestClose } = harness(() => pending.promise);
    controller.setDraft('already submitted');
    const submission = controller.submit('enter');

    controller.escape();

    expect(controller.snapshot()).toMatchObject({
      phase: 'submitting',
      draft: 'already submitted',
      focusEpoch: 0,
    });
    expect(onRequestClose).not.toHaveBeenCalled();
    pending.resolve(successfulResult());
    await submission;
    expect(controller.snapshot()).toMatchObject({ phase: 'closed', draft: '', focusEpoch: 0 });
    expect(onRequestClose).toHaveBeenCalledOnce();
  });

  it('keeps the exact draft and error available when a request fails after Escape', async () => {
    const pending = deferred<TaskCommandResult>();
    const { controller, onRequestClose } = harness(() => pending.promise);
    controller.setDraft('  repair after failure  ');
    const submission = controller.submit('enter');
    controller.escape();

    pending.resolve(failedResult());
    await submission;

    expect(controller.snapshot()).toEqual({
      phase: 'error',
      draft: '  repair after failure  ',
      readonly: false,
      ariaBusy: false,
      focusEpoch: 1,
      error: describeTaskCreationResult(failedResult()),
    });
    expect(onRequestClose).not.toHaveBeenCalled();
  });

  it('ignores a late result after destroy without presenting or closing again', async () => {
    const pending = deferred<TaskCommandResult>();
    const { controller, onResult, onRequestClose } = harness(() => pending.promise);
    const observer = vi.fn();
    controller.subscribe(observer);
    controller.setDraft('in flight');
    const submission = controller.submit('enter');

    controller.destroy();
    pending.resolve(successfulResult());
    await submission;

    expect(controller.snapshot()).toMatchObject({ phase: 'closed', draft: 'in flight' });
    expect(onResult).not.toHaveBeenCalled();
    expect(onRequestClose).not.toHaveBeenCalled();
    expect(observer).toHaveBeenCalledTimes(3);
  });

  it('supports consecutive successful Enter submissions with monotonic focusEpoch values', async () => {
    const { controller, execute, onResult } = harness();
    controller.setDraft('first');
    await controller.submit('enter');
    controller.setDraft('second');
    await controller.submit('enter');

    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute.mock.calls.map(([request]) => request.markdownBody)).toEqual([
      '#base first #inbox',
      '#base second #inbox',
    ]);
    expect(controller.snapshot()).toMatchObject({ phase: 'idle', draft: '', focusEpoch: 2 });
    expect(onResult).toHaveBeenCalledTimes(2);
  });

  it('does nothing for empty Enter and closes an empty blur without submitting', async () => {
    const enter = harness();
    enter.controller.setDraft('   ');
    await enter.controller.submit('enter');
    expect(enter.controller.snapshot()).toMatchObject({ phase: 'idle', draft: '   ' });
    expect(enter.execute).not.toHaveBeenCalled();
    expect(enter.onRequestClose).not.toHaveBeenCalled();

    const blur = harness();
    blur.controller.setDraft('  ');
    await blur.controller.submit('blur');
    expect(blur.controller.snapshot()).toMatchObject({ phase: 'closed', draft: '  ' });
    expect(blur.execute).not.toHaveBeenCalled();
    expect(blur.onRequestClose).toHaveBeenCalledOnce();
  });
});
