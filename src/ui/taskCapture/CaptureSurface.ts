import type { App } from 'obsidian';
import { isImeOwnedEvent } from '../ime';
import type { InteractionOwnershipPort } from '../interactionOwnership';
import { runAsyncAction } from '../runAsyncAction';
import { WikiLinkSuggest } from '../WikiLinkSuggest';
import { CaptureInteractionBoundary } from './CaptureInteractionBoundary';
import { CaptureMetadataRow } from './CaptureMetadataRow';
import type { CaptureSnapshot, TaskCaptureController } from './TaskCaptureController';

export type CapturePresentation = 'default' | 'inline';

export interface CaptureSurfaceOptions {
  readonly app?: App;
  readonly inputLabel?: string;
  readonly getTagColor?: (tag: string) => string | undefined;
  readonly formatDate?: (value: string, referenceDate?: string) => string;
  readonly shouldShowSourceNote?: (path: string) => boolean;
  readonly getDateClass?: (value: string, referenceDate?: string) => string;
  readonly interactionOwnership?: InteractionOwnershipPort;
  readonly isLive?: () => boolean;
  readonly placeholder?: string;
  readonly closeOnEmptyBlur?: boolean;
  readonly preserveDraftOnBlur?: (next: EventTarget | null) => boolean;
  readonly feedbackHost?: HTMLElement;
  readonly onEscape?: () => void;
  readonly presentation?: CapturePresentation;
}

const QUICK_CAPTURE_RECOGNITION_DELAY_MS = 24;
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
  private readonly boundary_abyssPrivate: CaptureInteractionBoundary | undefined;
  private readonly metadataRow_abyssPrivate: CaptureMetadataRow | undefined;
  private recognitionTimer_abyssPrivate: number | undefined;
  private composing_abyssPrivate = false;
  private readonly timerWindow_abyssPrivate: Window;
  private readonly links_abyssPrivate: WikiLinkSuggest | undefined;

  constructor(
    host: HTMLElement,
    private readonly controller_abyssPrivate: TaskCaptureController,
    options: CaptureSurfaceOptions = {},
  ) {
    const id = ++nextCaptureSurfaceId;
    this.timerWindow_abyssPrivate = host.win;
    this.feedbackHost_abyssPrivate = options.feedbackHost;
    this.presentation_abyssPrivate = options.presentation ?? 'default';
    this.appliedFocusEpoch_abyssPrivate = controller_abyssPrivate.snapshot().focusEpoch;

    this.element = host.createDiv();
    this.element.className = 'abyss-capture-surface abyss-quick-capture';
    this.element.classList.toggle(
      'abyss-capture-surface--inline',
      this.presentation_abyssPrivate === 'inline',
    );

    this.input = this.element.createEl('input', { attr: { enterkeyhint: 'enter' } });
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
    const smart = this.mountSmart_abyssPrivate(options);
    this.boundary_abyssPrivate = smart?.boundary;
    this.metadataRow_abyssPrivate = smart?.row;
    this.links_abyssPrivate = this.mountLinks_abyssPrivate(options);
    this.bindInput_abyssPrivate(options);

    this.subscribe_abyssPrivate();
  }

  private subscribe_abyssPrivate(): void {
    const subscription = this.controller_abyssPrivate.subscribe((snapshot) => {
      this.render_abyssPrivate(snapshot);
    });
    this.cleanup_abyssPrivate.push(() => {
      subscription.release();
    });
  }

  private mountLinks_abyssPrivate(options: CaptureSurfaceOptions): WikiLinkSuggest | undefined {
    if (options.app === undefined) return undefined;
    return new WikiLinkSuggest({
      app: options.app,
      input: this.input,
      sourcePath: () => {
        const session = this.controller_abyssPrivate.target.session;
        return session.type === 'ready' ? session.destination.filePath : undefined;
      },
      ...(options.interactionOwnership === undefined
        ? {}
        : { interactionOwnership: options.interactionOwnership }),
      registerSurface: (surface) => this.boundary_abyssPrivate?.register(surface) ?? (() => {}),
    });
  }

  private mountSmart_abyssPrivate(
    options: CaptureSurfaceOptions,
  ): { boundary: CaptureInteractionBoundary; row: CaptureMetadataRow } | undefined {
    const controller = this.controller_abyssPrivate;
    if (controller.snapshot().metadata === undefined) return undefined;
    {
      const isLive = (): boolean => !this.destroyed_abyssPrivate && (options.isLive?.() ?? true);
      const boundary = new CaptureInteractionBoundary(this.element, {
        flushInput: () => this.flushInput_abyssPrivate(),
        isLive,
        submit: (trigger) => {
          runAsyncAction(controller.submit(trigger), 'Could not add task');
        },
      });
      const row = new CaptureMetadataRow(this.element, {
        ...options,
        boundary,
        controller,
        input: this.input,
        flushInput: () => this.flushInput_abyssPrivate(),
        isLive,
      });
      this.destination_abyssPrivate.hidden = true;
      return { boundary, row };
    }
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
    const onInput = (event: Event): void => {
      if (this.boundary_abyssPrivate === undefined)
        this.controller_abyssPrivate.setDraft(this.input.value);
      else {
        const inputType = (event as InputEvent).inputType;
        const editKind = this.editKind_abyssPrivate(inputType);
        this.controller_abyssPrivate.setDraft(this.input.value, {
          deferRecognition: true,
          editKind,
        });
        if (!this.composing_abyssPrivate)
          this.scheduleRecognition_abyssPrivate(QUICK_CAPTURE_RECOGNITION_DELAY_MS);
      }
    };
    this.bindComposition_abyssPrivate();
    const onKeyDown = (event: KeyboardEvent): void => {
      if (isImeOwnedEvent(event) || this.composing_abyssPrivate) return;
      if (event.key === 'Enter') {
        event.preventDefault();
        event.stopPropagation();
        if (this.boundary_abyssPrivate !== undefined) this.boundary_abyssPrivate.requestSubmit();
        else if (this.flushInput_abyssPrivate() === 'ready')
          runAsyncAction(this.controller_abyssPrivate.submit('enter'), 'Could not add task');
      } else if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        options.onEscape?.();
        this.controller_abyssPrivate.escape();
      }
    };
    const onBlur = (event: FocusEvent): void => {
      if (this.boundary_abyssPrivate !== undefined) {
        this.boundary_abyssPrivate.requestExit({
          type: 'focus',
          relatedTarget: event.relatedTarget,
        });
        return;
      }
      if (
        options.preserveDraftOnBlur?.(event.relatedTarget) === true ||
        (options.closeOnEmptyBlur === false && this.controller_abyssPrivate.isEmpty())
      ) {
        return;
      }
      runAsyncAction(this.controller_abyssPrivate.submit('blur'), 'Could not add task');
    };

    const onSurfaceKeyDown = (event: KeyboardEvent): void => {
      if (event.target === this.input || event.key !== 'Escape' || isImeOwnedEvent(event)) return;
      event.preventDefault();
      event.stopPropagation();
      options.onEscape?.();
      this.controller_abyssPrivate.escape();
    };
    this.element.addEventListener('keydown', onSurfaceKeyDown);
    this.cleanup_abyssPrivate.push(() => {
      this.element.removeEventListener('keydown', onSurfaceKeyDown);
    });
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

  private bindComposition_abyssPrivate(): void {
    const onCompositionStart = (): void => {
      if (this.boundary_abyssPrivate === undefined) return;
      this.clearRecognitionTimer_abyssPrivate();
      this.composing_abyssPrivate = true;
      this.boundary_abyssPrivate.beginComposition();
    };
    const onCompositionEnd = (): void => {
      if (this.boundary_abyssPrivate === undefined) return;
      this.clearRecognitionTimer_abyssPrivate();
      this.recognitionTimer_abyssPrivate = this.timerWindow_abyssPrivate.setTimeout(() => {
        this.recognitionTimer_abyssPrivate = undefined;
        if (this.destroyed_abyssPrivate) return;
        this.composing_abyssPrivate = false;
        this.flushInput_abyssPrivate();
        this.boundary_abyssPrivate?.endComposition();
      }, 0);
    };
    this.input.addEventListener('compositionstart', onCompositionStart);
    this.input.addEventListener('compositionend', onCompositionEnd);
    this.cleanup_abyssPrivate.push(() => {
      this.input.removeEventListener('compositionstart', onCompositionStart);
      this.input.removeEventListener('compositionend', onCompositionEnd);
    });
  }

  private editKind_abyssPrivate(inputType: string): 'composition' | 'history' | 'paste' | 'input' {
    if (this.composing_abyssPrivate) return 'composition';
    if (inputType === 'historyUndo' || inputType === 'historyRedo') return 'history';
    return inputType === 'insertFromPaste' ? 'paste' : 'input';
  }
  private clearRecognitionTimer_abyssPrivate(): void {
    if (this.recognitionTimer_abyssPrivate !== undefined)
      this.timerWindow_abyssPrivate.clearTimeout(this.recognitionTimer_abyssPrivate);
    this.recognitionTimer_abyssPrivate = undefined;
  }
  private scheduleRecognition_abyssPrivate(delay: number): void {
    this.clearRecognitionTimer_abyssPrivate();
    this.recognitionTimer_abyssPrivate = this.timerWindow_abyssPrivate.setTimeout(() => {
      this.recognitionTimer_abyssPrivate = undefined;
      this.flushInput_abyssPrivate();
    }, delay);
  }
  private flushInput_abyssPrivate(): 'ready' | 'blocked' {
    if (this.destroyed_abyssPrivate || this.composing_abyssPrivate) return 'blocked';
    this.clearRecognitionTimer_abyssPrivate();
    this.controller_abyssPrivate.setDraft(this.input.value, { deferRecognition: true });
    this.controller_abyssPrivate.flushRecognition();
    return 'ready';
  }

  focus(): void {
    if (this.destroyed_abyssPrivate) return;
    this.input.focus();
    if (this.input.value === this.controller_abyssPrivate.target.draftSeed)
      this.input.setSelectionRange(0, 0);
  }

  ownsInteraction(target: EventTarget | null): boolean {
    return this.links_abyssPrivate?.owns(target) ?? false;
  }

  destroy(): void {
    if (this.destroyed_abyssPrivate) return;
    this.destroyed_abyssPrivate = true;
    this.clearRecognitionTimer_abyssPrivate();
    this.links_abyssPrivate?.destroy();
    this.boundary_abyssPrivate?.destroy();
    this.metadataRow_abyssPrivate?.destroy();
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

  private renderMetadata_abyssPrivate(snapshot: CaptureSnapshot): void {
    if (snapshot.metadata !== undefined) {
      this.metadataRow_abyssPrivate?.render(snapshot.metadata, snapshot.readonly);
      this.destination_abyssPrivate.textContent =
        this.metadataRow_abyssPrivate?.destinationDescription() ?? '';
    }
  }
  private render_abyssPrivate(snapshot: CaptureSnapshot): void {
    if (this.destroyed_abyssPrivate) return;
    if (this.input.value !== snapshot.draft) this.input.value = snapshot.draft;
    this.input.readOnly = snapshot.readonly;
    this.input.setAttribute('aria-busy', String(snapshot.ariaBusy));

    this.renderMetadata_abyssPrivate(snapshot);
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
