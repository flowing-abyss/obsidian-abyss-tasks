import { describe, expect, it, vi } from 'vitest';
import type { TaskCommandResult, TaskCreateSession } from '../src/tasks';
import { CaptureSurface } from '../src/ui/taskCapture/CaptureSurface';
import type { CaptureTarget } from '../src/ui/taskCapture/CaptureTargetResolver';
import { TaskCaptureController } from '../src/ui/taskCapture/TaskCaptureController';
import { describeTaskCreationResult } from '../src/ui/taskCommandResult';
import { deferred, flushMicrotasks, task } from './helpers';

const success = (): TaskCommandResult => ({
  type: 'ok',
  outcome: {
    type: 'task',
    task: task({ title: 'Captured', source: { filePath: 'Inbox.md', line: 2 } }),
  },
  changed: true,
});

const failure = (): TaskCommandResult => ({
  type: 'io-error',
  cause: 'repository-error',
  contentState: 'unknown',
});

interface Harness {
  readonly controller: TaskCaptureController;
  readonly execute: ReturnType<typeof vi.fn<TaskCreateSession['execute']>>;
  readonly onResult: ReturnType<typeof vi.fn>;
  readonly onRequestClose: ReturnType<typeof vi.fn>;
}

function harness(implementation: TaskCreateSession['execute'] = async () => success()): Harness {
  const execute = vi.fn<TaskCreateSession['execute']>(implementation);
  const target: CaptureTarget = {
    label: 'Inbox · #inbox',
    context: { type: 'list', selection: 'inbox' },
    session: {
      type: 'ready',
      destination: { filePath: 'Inbox.md', insertion: { type: 'append' } },
      execute,
    },
    markdownPrefix: '',
    markdownSuffixes: ['#inbox'],
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

function host(): HTMLElement {
  return document.createElement('div');
}

function type(surface: CaptureSurface, value: string): void {
  surface.input.value = value;
  surface.input.dispatchEvent(new Event('input', { bubbles: true }));
}

function key(surface: CaptureSurface, value: string): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true });
  surface.input.dispatchEvent(event);
  return event;
}

describe('CaptureSurface', () => {
  it('renders the destination and accessible stable capture nodes without a live region', () => {
    const { controller } = harness();
    const positioningHost = host();

    const surface = new CaptureSurface(positioningHost, controller);
    const destination = surface.element.querySelector<HTMLElement>('.abyss-capture-destination')!;
    const pending = surface.element.querySelector<HTMLElement>('.abyss-capture-pending')!;
    const error = surface.element.querySelector<HTMLElement>('.abyss-capture-error')!;

    expect(positioningHost.firstElementChild).toBe(surface.element);
    expect(destination.textContent).toBe('Inbox · #inbox');
    expect(surface.input.placeholder).toBe('Task name…');
    expect(surface.input.getAttribute('aria-label')).toBe('Add task');
    expect(surface.input.readOnly).toBe(false);
    expect(surface.input.getAttribute('aria-busy')).toBe('false');
    expect(surface.input.getAttribute('aria-invalid')).toBe('false');
    expect(surface.input.getAttribute('aria-describedby')).toBe(destination.id);
    expect(pending.hidden).toBe(true);
    expect(error.hidden).toBe(true);
    expect(surface.element.querySelector('[aria-live]')).toBeNull();
  });

  it('updates stable nodes for pending and mapped error state', async () => {
    const pendingResult = deferred<TaskCommandResult>();
    const { controller } = harness(() => pendingResult.promise);
    const surface = new CaptureSurface(host(), controller);
    const originalInput = surface.input;
    const originalDestination = surface.element.querySelector('.abyss-capture-destination');
    const originalPending = surface.element.querySelector<HTMLElement>('.abyss-capture-pending')!;
    const originalError = surface.element.querySelector<HTMLElement>('.abyss-capture-error')!;
    type(surface, '  exact failure  ');

    key(surface, 'Enter');

    expect(surface.input).toBe(originalInput);
    expect(surface.element.querySelector('.abyss-capture-destination')).toBe(originalDestination);
    expect(surface.element.querySelector('.abyss-capture-pending')).toBe(originalPending);
    expect(surface.element.querySelector('.abyss-capture-error')).toBe(originalError);
    expect(surface.input.value).toBe('  exact failure  ');
    expect(surface.input.readOnly).toBe(true);
    expect(surface.input.getAttribute('aria-busy')).toBe('true');
    expect(originalPending.hidden).toBe(false);
    expect(surface.element.classList.contains('is-submitting')).toBe(true);

    pendingResult.resolve(failure());
    await flushMicrotasks(0);

    expect(surface.input).toBe(originalInput);
    expect(surface.input.value).toBe('  exact failure  ');
    expect(surface.input.readOnly).toBe(false);
    expect(surface.input.getAttribute('aria-busy')).toBe('false');
    expect(surface.input.getAttribute('aria-invalid')).toBe('true');
    expect(surface.input.getAttribute('aria-describedby')).toBe(
      `${originalDestination!.id} ${originalError.id}`,
    );
    expect(originalError.textContent).toBe('Failed to create task. Please try again.');
    expect(originalError.hidden).toBe(false);
    expect(surface.element.classList.contains('has-error')).toBe(true);

    type(surface, 'corrected');
    expect(surface.input.getAttribute('aria-invalid')).toBe('false');
    expect(surface.input.getAttribute('aria-describedby')).toBe(originalDestination!.id);
    expect(originalError.hidden).toBe(true);
  });

  it('routes Enter, blur, and Escape to controller semantics', async () => {
    const entered = harness();
    const enterSurface = new CaptureSurface(host(), entered.controller);
    type(enterSurface, 'first');
    const enterEvent = key(enterSurface, 'Enter');
    await flushMicrotasks(0);
    expect(enterEvent.defaultPrevented).toBe(true);
    expect(entered.execute).toHaveBeenCalledOnce();
    expect(entered.onRequestClose).not.toHaveBeenCalled();

    const blurred = harness();
    const blurSurface = new CaptureSurface(host(), blurred.controller);
    type(blurSurface, 'second');
    blurSurface.input.dispatchEvent(new FocusEvent('blur'));
    await flushMicrotasks(0);
    expect(blurred.execute).toHaveBeenCalledOnce();
    expect(blurred.onRequestClose).toHaveBeenCalledOnce();

    const escaped = harness();
    const escapeSurface = new CaptureSurface(host(), escaped.controller);
    type(escapeSurface, 'discard');
    const escapeEvent = key(escapeSurface, 'Escape');
    expect(escapeEvent.defaultPrevented).toBe(true);
    expect(escaped.execute).not.toHaveBeenCalled();
    expect(escaped.onRequestClose).toHaveBeenCalledOnce();
  });

  it('focuses once for a new focusEpoch and never for blur-origin completion', async () => {
    const entered = harness();
    const enterSurface = new CaptureSurface(host(), entered.controller);
    const enterFocus = vi.spyOn(enterSurface.input, 'focus');
    type(enterSurface, 'repeat capture');
    key(enterSurface, 'Enter');
    await flushMicrotasks(0);
    expect(enterFocus).toHaveBeenCalledOnce();
    expect(enterSurface.input.value).toBe('');

    const blurred = harness(async () => failure());
    const blurSurface = new CaptureSurface(host(), blurred.controller);
    const blurFocus = vi.spyOn(blurSurface.input, 'focus');
    type(blurSurface, 'keep without focus theft');
    blurSurface.input.dispatchEvent(new FocusEvent('blur'));
    await flushMicrotasks(0);
    expect(blurFocus).not.toHaveBeenCalled();
    expect(blurSurface.input.value).toBe('keep without focus theft');
  });

  it('does not replay a historical focusEpoch when remounted during a later blur submission', async () => {
    const pendingResult = deferred<TaskCommandResult>();
    let submissionCount = 0;
    const { controller } = harness(async () => {
      submissionCount++;
      return submissionCount === 1 ? success() : await pendingResult.promise;
    });
    controller.setDraft('first Enter');
    await controller.submit('enter');
    controller.setDraft('later blur');
    const submission = controller.submit('blur');
    const container = document.createElement('div');
    const externalFocus = document.createElement('button');
    const positioningHost = host();
    container.append(externalFocus, positioningHost);
    document.body.appendChild(container);
    externalFocus.focus();

    const surface = new CaptureSurface(positioningHost, controller);

    expect(document.activeElement).toBe(externalFocus);
    expect(surface.input.readOnly).toBe(true);
    pendingResult.resolve(failure());
    await submission;
    expect(document.activeElement).toBe(externalFocus);
    expect(surface.input.value).toBe('later blur');
    surface.destroy();
    container.remove();
  });

  it('releases listeners and its observer on teardown without synthesizing blur', () => {
    const { controller, execute } = harness();
    const positioningHost = host();
    const surface = new CaptureSurface(positioningHost, controller);
    type(surface, 'must not submit');
    const detachedInput = surface.input;

    surface.destroy();
    surface.destroy();
    controller.setDraft('controller survives remount');
    detachedInput.dispatchEvent(new FocusEvent('blur'));
    detachedInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));

    expect(positioningHost.childElementCount).toBe(0);
    expect(execute).not.toHaveBeenCalled();
    expect(controller.snapshot().draft).toBe('controller survives remount');
  });

  it('remounts during a deferred success and updates only the new surface once', async () => {
    const pendingResult = deferred<TaskCommandResult>();
    const { controller, execute, onResult } = harness(() => pendingResult.promise);
    const positioningHost = host();
    const first = new CaptureSurface(positioningHost, controller);
    type(first, 'survives remount');
    key(first, 'Enter');
    const detachedInput = first.input;
    first.destroy();
    const second = new CaptureSurface(positioningHost, controller);
    const secondFocus = vi.spyOn(second.input, 'focus');

    expect(second.input.value).toBe('survives remount');
    expect(second.input.readOnly).toBe(true);
    pendingResult.resolve(success());
    await flushMicrotasks(0);

    expect(execute).toHaveBeenCalledOnce();
    expect(onResult).toHaveBeenCalledOnce();
    expect(second.input.value).toBe('');
    expect(second.input.readOnly).toBe(false);
    expect(secondFocus).toHaveBeenCalledOnce();
    expect(detachedInput.value).toBe('survives remount');
    expect(detachedInput.readOnly).toBe(true);
  });

  it('remounts during a deferred failure and preserves the new surface draft exactly once', async () => {
    const pendingResult = deferred<TaskCommandResult>();
    const { controller, execute, onResult } = harness(() => pendingResult.promise);
    const positioningHost = host();
    const first = new CaptureSurface(positioningHost, controller);
    type(first, '  failed after remount  ');
    key(first, 'Enter');
    first.destroy();
    const second = new CaptureSurface(positioningHost, controller);
    const secondFocus = vi.spyOn(second.input, 'focus');

    pendingResult.resolve(failure());
    await flushMicrotasks(0);

    expect(execute).toHaveBeenCalledOnce();
    expect(onResult).toHaveBeenCalledOnce();
    expect(second.input.value).toBe('  failed after remount  ');
    expect(second.input.getAttribute('aria-invalid')).toBe('true');
    expect(second.element.querySelector('.abyss-capture-error')?.textContent).toBe(
      'Failed to create task. Please try again.',
    );
    expect(secondFocus).toHaveBeenCalledOnce();
  });
});
