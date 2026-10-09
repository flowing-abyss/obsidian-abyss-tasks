import type { TaskCommandResult } from '../../tasks';
import type { CreationResultDescription, describeTaskCreationResult } from '../taskCommandResult';
import { commandBodyForCapture, type CaptureTarget } from './CaptureTargetResolver';

export type CapturePhase = 'idle' | 'submitting' | 'error' | 'closed';
export type CaptureSubmitCause = 'enter' | 'blur';

export interface CaptureSnapshot {
  readonly phase: CapturePhase;
  readonly draft: string;
  readonly readonly: boolean;
  readonly ariaBusy: boolean;
  readonly focusEpoch: number;
  readonly error?: CreationResultDescription;
}

export interface CaptureObserver {
  (snapshot: CaptureSnapshot): void;
}

interface TaskCaptureControllerOptions {
  readonly target: CaptureTarget;
  readonly onSubmit?: () => void;
  readonly describe: typeof describeTaskCreationResult;
  readonly onResult: (result: TaskCommandResult, description: CreationResultDescription) => void;
  readonly onRequestClose: () => void;
}

interface CaptureSubmission {
  readonly cause: CaptureSubmitCause;
  readonly draft: string;
  readonly token: number;
}

export class TaskCaptureController {
  readonly target: CaptureTarget;

  private phase_abyssPrivate: CapturePhase = 'idle';
  private draft_abyssPrivate = '';
  private focusEpoch_abyssPrivate = 0;
  private error_abyssPrivate: CreationResultDescription | undefined;
  private readonly observers_abyssPrivate = new Set<CaptureObserver>();
  private readonly onSubmit_abyssPrivate: TaskCaptureControllerOptions['onSubmit'];
  private readonly describe_abyssPrivate: typeof describeTaskCreationResult;
  private readonly onResult_abyssPrivate: TaskCaptureControllerOptions['onResult'];
  private readonly onRequestClose_abyssPrivate: TaskCaptureControllerOptions['onRequestClose'];
  private submissionToken_abyssPrivate = 0;
  private closeAfterSuccess_abyssPrivate = false;
  private destroyed_abyssPrivate = false;

  constructor(options: TaskCaptureControllerOptions) {
    this.target = options.target;
    this.draft_abyssPrivate = this.target.draftSeed ?? '';
    this.onSubmit_abyssPrivate = options.onSubmit;
    this.describe_abyssPrivate = options.describe;
    this.onResult_abyssPrivate = options.onResult;
    this.onRequestClose_abyssPrivate = options.onRequestClose;
  }

  snapshot(): CaptureSnapshot {
    return {
      phase: this.phase_abyssPrivate,
      draft: this.draft_abyssPrivate,
      readonly: this.phase_abyssPrivate === 'submitting',
      ariaBusy: this.phase_abyssPrivate === 'submitting',
      focusEpoch: this.focusEpoch_abyssPrivate,
      ...(this.error_abyssPrivate !== undefined && { error: this.error_abyssPrivate }),
    };
  }

  subscribe(observer: CaptureObserver): { release(): void } {
    if (!this.destroyed_abyssPrivate) this.observers_abyssPrivate.add(observer);
    observer(this.snapshot());
    let released = false;
    return {
      release: (): void => {
        if (released) return;
        released = true;
        this.observers_abyssPrivate.delete(observer);
      },
    };
  }

  setDraft(value: string): void {
    if (
      this.destroyed_abyssPrivate ||
      this.phase_abyssPrivate === 'submitting' ||
      this.phase_abyssPrivate === 'closed'
    )
      return;
    if (value === this.draft_abyssPrivate && this.phase_abyssPrivate !== 'error') return;
    this.draft_abyssPrivate = value;
    this.phase_abyssPrivate = 'idle';
    this.error_abyssPrivate = undefined;
    this.emit_abyssPrivate();
  }

  isEmpty(): boolean {
    const draft = this.draft_abyssPrivate.trim();
    return draft.length === 0 || draft === this.target.draftSeed?.trim();
  }

  async submit(cause: CaptureSubmitCause): Promise<void> {
    const submission = this.beginSubmission_abyssPrivate(cause);
    if (submission === undefined || this.isSubmissionObsolete_abyssPrivate(submission.token))
      return;
    const result = await this.target.session.execute({
      markdownBody: commandBodyForCapture(this.target, submission.draft),
      ...(this.target.initial !== undefined && { initial: this.target.initial }),
    });
    if (this.isSubmissionObsolete_abyssPrivate(submission.token)) return;
    this.finishSubmission_abyssPrivate(submission, result);
  }

  private beginSubmission_abyssPrivate(cause: CaptureSubmitCause): CaptureSubmission | undefined {
    if (this.destroyed_abyssPrivate || this.phase_abyssPrivate === 'closed') return undefined;
    if (this.phase_abyssPrivate === 'submitting') {
      if (cause === 'blur') this.closeAfterSuccess_abyssPrivate = true;
      return undefined;
    }
    if (this.isEmpty()) {
      if (cause === 'blur') this.close_abyssPrivate();
      return undefined;
    }
    const submission = {
      cause,
      draft: this.draft_abyssPrivate,
      token: ++this.submissionToken_abyssPrivate,
    };
    this.phase_abyssPrivate = 'submitting';
    this.error_abyssPrivate = undefined;
    this.closeAfterSuccess_abyssPrivate = false;
    this.onSubmit_abyssPrivate?.();
    this.emit_abyssPrivate();
    return submission;
  }

  private finishSubmission_abyssPrivate(
    submission: CaptureSubmission,
    result: TaskCommandResult,
  ): void {
    const description = this.describe_abyssPrivate(result);
    const shouldRequestClose = this.applySubmissionDescription_abyssPrivate(
      submission,
      description,
    );
    this.closeAfterSuccess_abyssPrivate = false;
    this.emit_abyssPrivate();
    if (this.isSubmissionObsolete_abyssPrivate(submission.token)) return;
    this.presentResult_abyssPrivate(result, description);
    if (shouldRequestClose && !this.isSubmissionObsolete_abyssPrivate(submission.token)) {
      this.onRequestClose_abyssPrivate();
    }
  }

  /**
   * The command has finished by now, so a failure to show its result is logged and does not fail
   * the capture.
   */
  private presentResult_abyssPrivate(
    result: TaskCommandResult,
    description: CreationResultDescription,
  ): void {
    try {
      this.onResult_abyssPrivate(result, description);
    } catch (error) {
      console.error('[abyss-tasks] Could not show the capture result', error);
    }
  }

  private applySubmissionDescription_abyssPrivate(
    submission: CaptureSubmission,
    description: CreationResultDescription,
  ): boolean {
    if (description.kind === 'success') {
      const shouldClose = submission.cause === 'blur' || this.closeAfterSuccess_abyssPrivate;
      this.draft_abyssPrivate = this.target.draftSeed ?? '';
      if (shouldClose) {
        this.phase_abyssPrivate = 'closed';
      } else {
        this.phase_abyssPrivate = 'idle';
        this.focusEpoch_abyssPrivate++;
      }
      return shouldClose;
    }
    this.draft_abyssPrivate = submission.draft;
    this.phase_abyssPrivate = 'error';
    this.error_abyssPrivate = description;
    if (submission.cause === 'enter') this.focusEpoch_abyssPrivate++;
    return false;
  }

  private isSubmissionObsolete_abyssPrivate(token: number): boolean {
    return this.destroyed_abyssPrivate || token !== this.submissionToken_abyssPrivate;
  }

  escape(): void {
    if (this.destroyed_abyssPrivate || this.phase_abyssPrivate === 'closed') return;
    if (this.phase_abyssPrivate === 'submitting') {
      this.closeAfterSuccess_abyssPrivate = true;
      return;
    }
    this.close_abyssPrivate();
  }

  destroy(): void {
    if (this.destroyed_abyssPrivate) return;
    this.destroyed_abyssPrivate = true;
    this.phase_abyssPrivate = 'closed';
    this.submissionToken_abyssPrivate++;
    this.observers_abyssPrivate.clear();
  }

  private close_abyssPrivate(): void {
    if (this.phase_abyssPrivate === 'closed') return;
    const token = this.submissionToken_abyssPrivate;
    this.phase_abyssPrivate = 'closed';
    this.emit_abyssPrivate();
    if (this.destroyed_abyssPrivate || token !== this.submissionToken_abyssPrivate) return;
    this.onRequestClose_abyssPrivate();
  }

  private emit_abyssPrivate(): void {
    const snapshot = this.snapshot();
    for (const observer of [...this.observers_abyssPrivate]) {
      if (this.destroyed_abyssPrivate) return;
      if (this.observers_abyssPrivate.has(observer)) observer(snapshot);
    }
  }
}
