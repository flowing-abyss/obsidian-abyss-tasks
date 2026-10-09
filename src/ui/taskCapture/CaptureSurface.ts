import { isImeOwnedEvent } from '../ime';
import { runAsyncAction } from '../runAsyncAction';
import type { CaptureSnapshot, TaskCaptureController } from './TaskCaptureController';

export type CapturePresentation = 'default' | 'inline';

export interface CaptureSurfaceOptions {
  readonly inputLabel?: string;
  readonly placeholder?: string;
  readonly closeOnEmptyBlur?: boolean;
  readonly preserveDraftOnBlur?: (next: EventTarget | null) => boolean;
  readonly feedbackHost?: HTMLElement;
  readonly onEscape?: () => void;
  readonly presentation?: CapturePresentation;
}

let nextCaptureSurfaceId = 0;

export class CaptureSurface {
  readonly element: HTMLElement;
  readonly input: HTMLInputElement;

  private readonly destination_abyssPrivate: HTMLElement;
  private readonly pending_abyssPrivate: HTMLElement;
  private readonly error_abyssPrivate: HTMLElement;
  private readonly feedbackHost_abyssPrivate: HTMLElement | undefined;
  private readonly presentation_abyssPrivate: CapturePresentation;
  private readonly cleanup_abyssPrivate: Array<() => void> = [];
  private appliedFocusEpoch_abyssPrivate: number;
  private destroyed_abyssPrivate = false;

  constructor(
    host: HTMLElement,
    private readonly controller_abyssPrivate: TaskCaptureController,
    options: CaptureSurfaceOptions = {},
  ) {
    const id = ++nextCaptureSurfaceId;
    this.feedbackHost_abyssPrivate = options.feedbackHost;
    this.presentation_abyssPrivate = options.presentation ?? 'default';
    this.appliedFocusEpoch_abyssPrivate = controller_abyssPrivate.snapshot().focusEpoch;

    this.element = host.createDiv();
    this.element.className = 'abyss-capture-surface abyss-quick-capture';
    this.element.classList.toggle(
      'abyss-capture-surface--inline',
      this.presentation_abyssPrivate === 'inline',
    );

    this.input = this.element.createEl('input');
    this.input.className = 'abyss-capture-input abyss-quick-capture-input';
    this.input.type = 'text';
    this.input.placeholder = options.placeholder ?? 'Task name…';
    this.input.setAttribute('aria-label', options.inputLabel ?? 'Add task');

    this.destination_abyssPrivate = this.element.createSpan();
    this.destination_abyssPrivate.className = 'abyss-capture-destination';
    this.destination_abyssPrivate.id = `abyss-capture-destination-${id}`;
    this.destination_abyssPrivate.textContent = controller_abyssPrivate.target.label;

    this.pending_abyssPrivate = this.element.createSpan();
    this.pending_abyssPrivate.className = 'abyss-capture-pending';
    this.pending_abyssPrivate.textContent = 'Adding task…';

    this.error_abyssPrivate = this.element.createDiv();
    this.error_abyssPrivate.className = 'abyss-capture-error';
    this.error_abyssPrivate.id = `abyss-capture-error-${id}`;

    this.attachFeedback_abyssPrivate();
    this.bindInput_abyssPrivate(options);

    const subscription = controller_abyssPrivate.subscribe((snapshot) => {
      this.render_abyssPrivate(snapshot);
    });
    this.cleanup_abyssPrivate.push(() => {
      subscription.release();
    });
  }

  private attachFeedback_abyssPrivate(): void {
    const feedbackHost = this.feedbackHost_abyssPrivate ?? this.element;
    if (feedbackHost !== this.element) feedbackHost.classList.add('abyss-capture-feedback-layer');
    feedbackHost.append(
      this.destination_abyssPrivate,
      this.pending_abyssPrivate,
      this.error_abyssPrivate,
    );
  }

  private bindInput_abyssPrivate(options: CaptureSurfaceOptions): void {
    const onInput = (): void => {
      this.controller_abyssPrivate.setDraft(this.input.value);
      this.render_abyssPrivate(this.controller_abyssPrivate.snapshot());
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (isImeOwnedEvent(event)) return;
      if (event.key === 'Enter') {
        event.preventDefault();
        event.stopPropagation();
        runAsyncAction(this.controller_abyssPrivate.submit('enter'), 'Could not add task');
      } else if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        options.onEscape?.();
        this.controller_abyssPrivate.escape();
      }
    };
    const onBlur = (event: FocusEvent): void => {
      if (
        options.preserveDraftOnBlur?.(event.relatedTarget) === true ||
        (options.closeOnEmptyBlur === false && this.controller_abyssPrivate.isEmpty())
      ) {
        return;
      }
      runAsyncAction(this.controller_abyssPrivate.submit('blur'), 'Could not add task');
    };

    this.input.addEventListener('input', onInput);
    this.input.addEventListener('keydown', onKeyDown);
    this.input.addEventListener('blur', onBlur);
    this.cleanup_abyssPrivate.push(
      () => {
        this.input.removeEventListener('input', onInput);
      },
      () => {
        this.input.removeEventListener('keydown', onKeyDown);
      },
      () => {
        this.input.removeEventListener('blur', onBlur);
      },
    );
  }

  focus(): void {
    if (this.destroyed_abyssPrivate) return;
    this.input.focus();
    if (this.input.value === this.controller_abyssPrivate.target.draftSeed)
      this.input.setSelectionRange(0, 0);
  }

  destroy(): void {
    if (this.destroyed_abyssPrivate) return;
    this.destroyed_abyssPrivate = true;
    for (const release of this.cleanup_abyssPrivate.splice(0).reverse()) release();
    this.element.remove();
    this.destination_abyssPrivate.remove();
    this.pending_abyssPrivate.remove();
    this.error_abyssPrivate.remove();
    const feedbackHost = this.feedbackHost_abyssPrivate;
    if (feedbackHost?.childElementCount === 0) {
      feedbackHost.classList.remove('abyss-capture-feedback-layer');
    }
  }

  private render_abyssPrivate(snapshot: CaptureSnapshot): void {
    if (this.destroyed_abyssPrivate) return;
    if (this.input.value !== snapshot.draft) this.input.value = snapshot.draft;
    this.input.readOnly = snapshot.readonly;
    this.input.setAttribute('aria-busy', String(snapshot.ariaBusy));

    const hasError = snapshot.error !== undefined;
    this.input.setAttribute('aria-invalid', String(hasError));
    this.input.setAttribute(
      'aria-describedby',
      hasError
        ? `${this.destination_abyssPrivate.id} ${this.error_abyssPrivate.id}`
        : this.destination_abyssPrivate.id,
    );
    this.error_abyssPrivate.textContent = snapshot.error?.message ?? '';
    this.error_abyssPrivate.hidden = this.presentation_abyssPrivate !== 'inline' && !hasError;
    this.pending_abyssPrivate.hidden = snapshot.phase !== 'submitting';

    this.element.classList.toggle('is-submitting', snapshot.phase === 'submitting');
    this.element.classList.toggle('has-error', hasError);
    this.element.classList.toggle('is-closed', snapshot.phase === 'closed');

    if (snapshot.focusEpoch !== this.appliedFocusEpoch_abyssPrivate) {
      this.appliedFocusEpoch_abyssPrivate = snapshot.focusEpoch;
      if (snapshot.focusEpoch > 0) this.focus();
    }
  }
}
