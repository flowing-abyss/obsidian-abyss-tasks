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

  private phase: CapturePhase = 'idle';
  private draft = '';
  private focusEpoch = 0;
  private error: CreationResultDescription | undefined;
  private readonly observers = new Set<CaptureObserver>();
  private readonly describe: typeof describeTaskCreationResult;
  private readonly onResult: TaskCaptureControllerOptions['onResult'];
  private readonly onRequestClose: TaskCaptureControllerOptions['onRequestClose'];
  private submissionToken = 0;
  private closeAfterSuccess = false;
  private destroyed = false;

  constructor(options: TaskCaptureControllerOptions) {
    this.target = options.target;
    this.describe = options.describe;
    this.onResult = options.onResult;
    this.onRequestClose = options.onRequestClose;
  }

  snapshot(): CaptureSnapshot {
    return {
      phase: this.phase,
      draft: this.draft,
      readonly: this.phase === 'submitting',
      ariaBusy: this.phase === 'submitting',
      focusEpoch: this.focusEpoch,
      ...(this.error !== undefined && { error: this.error }),
    };
  }

  subscribe(observer: CaptureObserver): { release(): void } {
    if (!this.destroyed) this.observers.add(observer);
    observer(this.snapshot());
    let released = false;
    return {
      release: (): void => {
        if (released) return;
        released = true;
        this.observers.delete(observer);
      },
    };
  }

  setDraft(value: string): void {
    if (this.destroyed || this.phase === 'submitting' || this.phase === 'closed') return;
    if (value === this.draft && this.phase !== 'error') return;
    this.draft = value;
    this.phase = 'idle';
    this.error = undefined;
    this.emit();
  }

  async submit(cause: CaptureSubmitCause): Promise<void> {
    const submission = this.beginSubmission(cause);
    if (submission === undefined || this.isSubmissionObsolete(submission.token)) return;
    const result = await this.target.session.execute({
      markdownBody: commandBodyForCapture(this.target, submission.draft),
      ...(this.target.initial !== undefined && { initial: this.target.initial }),
    });
    if (this.isSubmissionObsolete(submission.token)) return;
    this.finishSubmission(submission, result);
  }

  private beginSubmission(cause: CaptureSubmitCause): CaptureSubmission | undefined {
    if (this.destroyed || this.phase === 'closed') return undefined;
    if (this.phase === 'submitting') {
      if (cause === 'blur') this.closeAfterSuccess = true;
      return undefined;
    }
    if (this.draft.trim().length === 0) {
      if (cause === 'blur') this.close();
      return undefined;
    }
    const submission = { cause, draft: this.draft, token: ++this.submissionToken };
    this.phase = 'submitting';
    this.error = undefined;
    this.closeAfterSuccess = false;
    this.emit();
    return submission;
  }

  private finishSubmission(submission: CaptureSubmission, result: TaskCommandResult): void {
    const description = this.describe(result);
    const shouldRequestClose = this.applySubmissionDescription(submission, description);
    this.closeAfterSuccess = false;
    this.emit();
    if (this.isSubmissionObsolete(submission.token)) return;
    this.onResult(result, description);
    if (shouldRequestClose && !this.isSubmissionObsolete(submission.token)) {
      this.onRequestClose();
    }
  }

  private applySubmissionDescription(
    submission: CaptureSubmission,
    description: CreationResultDescription,
  ): boolean {
    if (description.kind === 'success') {
      const shouldClose = submission.cause === 'blur' || this.closeAfterSuccess;
      this.draft = '';
      if (shouldClose) {
        this.phase = 'closed';
      } else {
        this.phase = 'idle';
        this.focusEpoch++;
      }
      return shouldClose;
    }
    this.draft = submission.draft;
    this.phase = 'error';
    this.error = description;
    if (submission.cause === 'enter') this.focusEpoch++;
    return false;
  }

  private isSubmissionObsolete(token: number): boolean {
    return this.destroyed || token !== this.submissionToken;
  }

  escape(): void {
    if (this.destroyed || this.phase === 'closed') return;
    if (this.phase === 'submitting') {
      this.closeAfterSuccess = true;
      return;
    }
    this.close();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.phase = 'closed';
    this.submissionToken++;
    this.observers.clear();
  }

  private close(): void {
    if (this.phase === 'closed') return;
    const token = this.submissionToken;
    this.phase = 'closed';
    this.emit();
    if (this.destroyed || token !== this.submissionToken) return;
    this.onRequestClose();
  }

  private emit(): void {
    const snapshot = this.snapshot();
    for (const observer of [...this.observers]) {
      if (this.destroyed) return;
      if (this.observers.has(observer)) observer(snapshot);
    }
  }
}
