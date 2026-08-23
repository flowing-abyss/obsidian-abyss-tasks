import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { TaskCommandResult, TaskCreateSession } from '../src/tasks';
import { CaptureSurface } from '../src/ui/taskCapture/CaptureSurface';
import type { CaptureTarget } from '../src/ui/taskCapture/CaptureTargetResolver';
import { TaskCaptureController } from '../src/ui/taskCapture/TaskCaptureController';
import { describeTaskCreationResult } from '../src/ui/taskCommandResult';
import { deferred, flushMicrotasks, task } from './helpers';

const css = readFileSync(resolve(import.meta.dirname, '..', 'styles.css'), 'utf8');

function declarationsFor(selector: string): string {
  return declarationsForSource(css, selector);
}

function declarationsForSource(source: string, selector: string): string {
  const uncommentedCss = source.replace(/\/\*[\s\S]*?\*\//gu, '');
  const normalize = (value: string): string => value.trim().replace(/\s+/gu, ' ');
  const matches = [...uncommentedCss.matchAll(/([^{}]+)\{([^}]*)\}/gu)].filter(
    (match) => normalize(match[1] ?? '') === normalize(selector),
  );
  return matches[matches.length - 1]?.[2] ?? '';
}

function lastAtRuleBlock(header: string): string {
  const start = css.lastIndexOf(header);
  if (start < 0) return '';
  const opening = css.indexOf('{', start + header.length);
  if (opening < 0) return '';
  let depth = 0;
  for (let index = opening; index < css.length; index += 1) {
    if (css[index] === '{') depth += 1;
    if (css[index] === '}') depth -= 1;
    if (depth === 0) return css.slice(opening + 1, index);
  }
  return '';
}

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

  it('can portal calendar feedback outside a clipping positioning host without breaking descriptions', () => {
    const { controller } = harness();
    const positioningHost = host();
    const feedbackHost = host();

    const surface = new CaptureSurface(positioningHost, controller, { feedbackHost });
    const destination = feedbackHost.querySelector<HTMLElement>('.abyss-capture-destination')!;
    const pending = feedbackHost.querySelector<HTMLElement>('.abyss-capture-pending')!;
    const error = feedbackHost.querySelector<HTMLElement>('.abyss-capture-error')!;

    expect(surface.element.parentElement).toBe(positioningHost);
    expect(surface.element.querySelector('.abyss-capture-destination')).toBeNull();
    expect(feedbackHost.classList).toContain('abyss-capture-feedback-layer');
    expect(destination.textContent).toBe('Inbox · #inbox');
    expect(surface.input.getAttribute('aria-describedby')).toBe(destination.id);
    expect(pending.hidden).toBe(true);
    expect(error.hidden).toBe(true);

    surface.destroy();
    expect(feedbackHost.childElementCount).toBe(0);
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

  it('reports Escape ownership before the controller requests close', () => {
    const escaped = harness();
    const trace: string[] = [];
    escaped.onRequestClose.mockImplementation(() => trace.push('close'));
    const surface = new CaptureSurface(host(), escaped.controller, {
      onEscape: () => trace.push('escape'),
    });

    key(surface, 'Escape');

    expect(trace).toEqual(['escape', 'close']);
  });

  it.each(['Enter', 'Escape'] as const)('keeps %s owned by the capture surface', async (value) => {
    const current = harness();
    const parent = host();
    const parentKeydown = vi.fn();
    parent.addEventListener('keydown', parentKeydown);
    const surface = new CaptureSurface(parent, current.controller);
    if (value === 'Enter') type(surface, 'owned submission');

    const event = key(surface, value);
    await flushMicrotasks(0);

    expect(event.defaultPrevented).toBe(true);
    expect(parentKeydown).not.toHaveBeenCalled();
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

  it('styles shared capture, destination, pending, and error states with theme variables', () => {
    const surface = declarationsFor('.abyss-capture-surface');
    const submitting = declarationsFor('.abyss-capture-surface.is-submitting');
    const error = declarationsFor('.abyss-capture-surface.has-error');

    expect(surface).toContain('display:');
    expect(surface).toContain('var(--');
    expect(surface).not.toMatch(/(?:^|;)\s*(?:min-|max-)?width\s*:\s*\d/u);
    expect(submitting).toContain('var(--');
    expect(error).toContain('var(--text-error)');
    expect(declarationsFor('.abyss-capture-destination')).toContain('var(--text-muted)');
    expect(declarationsFor('.abyss-capture-pending')).toContain('var(--text-accent)');
    expect(declarationsFor('.abyss-capture-error')).toContain('var(--text-error)');

    expect(declarationsFor('.abyss-tg-quick-add')).toContain('position: absolute');
    expect(declarationsFor('.abyss-tg-allday-quick-add')).toContain('position: absolute');
    expect(declarationsFor('.abyss-mg-quick-add')).toContain('position: absolute');
  });

  it('keeps calendar focus paint visible and portals compact feedback outside clipped cells', () => {
    const focusSelector =
      ':is(.abyss-tg-quick-add, .abyss-tg-allday-quick-add, .abyss-mg-quick-add) .abyss-capture-input:focus-visible';
    const errorFocusSelector =
      ':is(.abyss-tg-quick-add, .abyss-tg-allday-quick-add, .abyss-mg-quick-add) .abyss-capture-surface.has-error .abyss-capture-input:focus-visible';
    const focus = declarationsFor(focusSelector);
    const errorFocus = declarationsFor(errorFocusSelector);
    const feedback = declarationsFor('.abyss-calendar-capture-feedback');

    expect(focus).toContain('outline:');
    expect(focus).toContain('var(--interactive-accent)');
    expect(errorFocus).toContain('var(--text-error)');
    expect(feedback).toContain('position: absolute');
    expect(feedback).toMatch(/inline-size:\s*min\(/u);
    expect(feedback).toContain('z-index:');
    expect(feedback).toContain('inset-block-start:');
    expect(feedback).not.toContain('inset-block-end:');
  });

  it('wraps narrow calendar controls and clears capture feedback above mobile chrome', () => {
    const compact = lastAtRuleBlock('@container abyss-task-list (max-width: 30rem)');
    const phone = lastAtRuleBlock('@media (max-width: 480px)');
    const nav = declarationsForSource(compact, '.abyss-cal-nav');
    const calendarFeedback = declarationsForSource(
      compact,
      '.abyss-center .abyss-calendar-capture-feedback',
    );
    const globalFeedback = declarationsForSource(phone, 'body.is-mobile .abyss-creation-feedback');

    expect(nav).toContain('flex-wrap: wrap');
    expect(calendarFeedback).toContain('inset-block-start:');
    expect(calendarFeedback).toContain('var(--size-4-16');
    expect(calendarFeedback).toContain('var(--size-4-12');
    expect(calendarFeedback).toContain('var(--size-4-4');
    expect(globalFeedback).toContain('inset-block-end:');
    expect(globalFeedback).toContain('env(safe-area-inset-bottom');
  });

  it('disables smooth scrolling and capture/highlight animation under reduced motion', () => {
    const reducedMotion = /@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/gu;
    const rules = [...css.matchAll(reducedMotion)].map((match) => match[1] ?? '');
    const captureRule = rules.find((rule) => rule.includes('.abyss-capture-surface')) ?? '';
    const highlightRule = rules.find((rule) => rule.includes('.is-just-created')) ?? '';

    expect(captureRule).toContain('scroll-behavior: auto');
    expect(captureRule).toContain('animation: none');
    expect(captureRule).not.toContain('scroll-behavior: smooth');
    expect(highlightRule).toContain('animation: none');
  });
});
