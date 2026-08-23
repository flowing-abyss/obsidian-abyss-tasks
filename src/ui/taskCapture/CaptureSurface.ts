import type { CaptureSnapshot, TaskCaptureController } from './TaskCaptureController';

export interface CaptureSurfaceOptions {
  readonly inputLabel?: string;
  readonly placeholder?: string;
  readonly closeOnEmptyBlur?: boolean;
  readonly feedbackHost?: HTMLElement;
  readonly onEscape?: () => void;
}

let nextCaptureSurfaceId = 0;

export class CaptureSurface {
  readonly element: HTMLElement;
  readonly input: HTMLInputElement;

  private readonly destination: HTMLElement;
  private readonly pending: HTMLElement;
  private readonly error: HTMLElement;
  private readonly feedbackHost: HTMLElement | undefined;
  private readonly cleanup: Array<() => void> = [];
  private appliedFocusEpoch: number;
  private destroyed = false;

  constructor(
    host: HTMLElement,
    private readonly controller: TaskCaptureController,
    options: CaptureSurfaceOptions = {},
  ) {
    const ownerDocument = host.ownerDocument;
    const id = ++nextCaptureSurfaceId;
    this.feedbackHost = options.feedbackHost;
    this.appliedFocusEpoch = controller.snapshot().focusEpoch;

    this.element = ownerDocument.createElement('div');
    this.element.className = 'abyss-capture-surface abyss-quick-capture';

    this.input = ownerDocument.createElement('input');
    this.input.className = 'abyss-capture-input abyss-quick-capture-input';
    this.input.type = 'text';
    this.input.placeholder = options.placeholder ?? 'Task name…';
    this.input.setAttribute('aria-label', options.inputLabel ?? 'Add task');

    this.destination = ownerDocument.createElement('span');
    this.destination.className = 'abyss-capture-destination';
    this.destination.id = `abyss-capture-destination-${id}`;
    this.destination.textContent = controller.target.label;

    this.pending = ownerDocument.createElement('span');
    this.pending.className = 'abyss-capture-pending';
    this.pending.textContent = 'Adding task…';

    this.error = ownerDocument.createElement('div');
    this.error.className = 'abyss-capture-error';
    this.error.id = `abyss-capture-error-${id}`;

    this.element.append(this.input);
    const feedbackHost = this.feedbackHost ?? this.element;
    if (feedbackHost !== this.element) feedbackHost.classList.add('abyss-capture-feedback-layer');
    feedbackHost.append(this.destination, this.pending, this.error);
    host.appendChild(this.element);

    const onInput = (): void => {
      this.controller.setDraft(this.input.value);
      this.render(this.controller.snapshot());
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      // eslint-disable-next-line @typescript-eslint/no-deprecated -- Chromium can expose IME ownership only through the legacy 229 sentinel.
      if (event.isComposing || event.keyCode === 229) return;
      if (event.key === 'Enter') {
        event.preventDefault();
        event.stopPropagation();
        void this.controller.submit('enter');
      } else if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        options.onEscape?.();
        this.controller.escape();
      }
    };
    const onBlur = (): void => {
      if (
        options.closeOnEmptyBlur === false &&
        this.controller.snapshot().draft.trim().length === 0
      ) {
        return;
      }
      void this.controller.submit('blur');
    };

    this.input.addEventListener('input', onInput);
    this.input.addEventListener('keydown', onKeyDown);
    this.input.addEventListener('blur', onBlur);
    this.cleanup.push(
      () => this.input.removeEventListener('input', onInput),
      () => this.input.removeEventListener('keydown', onKeyDown),
      () => this.input.removeEventListener('blur', onBlur),
    );

    const subscription = controller.subscribe((snapshot) => this.render(snapshot));
    this.cleanup.push(() => subscription.release());
  }

  focus(): void {
    if (!this.destroyed) this.input.focus();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const release of this.cleanup.splice(0).reverse()) release();
    this.element.remove();
    this.destination.remove();
    this.pending.remove();
    this.error.remove();
    const feedbackHost = this.feedbackHost;
    if (feedbackHost?.childElementCount === 0) {
      feedbackHost.classList.remove('abyss-capture-feedback-layer');
    }
  }

  private render(snapshot: CaptureSnapshot): void {
    if (this.destroyed) return;
    if (this.input.value !== snapshot.draft) this.input.value = snapshot.draft;
    this.input.readOnly = snapshot.readonly;
    this.input.setAttribute('aria-busy', String(snapshot.ariaBusy));

    const hasError = snapshot.error !== undefined;
    this.input.setAttribute('aria-invalid', String(hasError));
    this.input.setAttribute(
      'aria-describedby',
      hasError ? `${this.destination.id} ${this.error.id}` : this.destination.id,
    );
    this.error.textContent = snapshot.error?.message ?? '';
    this.error.hidden = !hasError;
    this.pending.hidden = snapshot.phase !== 'submitting';

    this.element.classList.toggle('is-submitting', snapshot.phase === 'submitting');
    this.element.classList.toggle('has-error', hasError);
    this.element.classList.toggle('is-closed', snapshot.phase === 'closed');

    if (snapshot.focusEpoch !== this.appliedFocusEpoch) {
      this.appliedFocusEpoch = snapshot.focusEpoch;
      if (snapshot.focusEpoch > 0) this.input.focus();
    }
  }
}
