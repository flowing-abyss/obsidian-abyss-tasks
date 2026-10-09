import type {
  CreationRevealAuthority,
  CreationRevealRequest,
} from '../creation/CreationPresentationController';

/** Opening captures the origin; each submission acquires fresh interaction permission. */
export interface CaptureRevealAuthority {
  forSubmission(request: CreationRevealRequest): CreationRevealAuthority;
}

/** Finite result permission shared by capture owners; presentation and scrolling stay external. */
export class CaptureRevealIntent {
  private epoch = 0;
  private submission:
    | {
        readonly authority: CreationRevealAuthority;
        readonly epoch: number;
        readonly cancel: () => void;
      }
    | undefined;
  private input: HTMLInputElement | undefined;
  private readonly cancellations = new Set<() => void>();
  private readonly revoke = (): void => {
    this.epoch++;
    for (const cancel of [...this.cancellations]) cancel();
  };

  constructor(private readonly authority: CaptureRevealAuthority | undefined) {}

  mount(input: HTMLInputElement): void {
    if (this.input === input) return;
    this.unmount();
    this.input = input;
    input.addEventListener('blur', this.revoke);
    input.addEventListener('input', this.revoke);
  }

  unmount(): void {
    this.revoke();
    this.input?.removeEventListener('blur', this.revoke);
    this.input?.removeEventListener('input', this.revoke);
    this.input = undefined;
  }

  beginSubmission(): void {
    this.revoke();
    const origin = this.authority;
    if (origin === undefined) return;
    const epoch = this.epoch;
    const controller = new AbortController();
    const cancel = (): void => {
      controller.abort();
      this.cancellations.delete(cancel);
    };
    this.cancellations.add(cancel);
    const authority = origin.forSubmission({
      signal: controller.signal,
      isCurrent: () => this.epoch === epoch,
    });
    this.submission = { authority, epoch, cancel };
  }

  forResult(success: boolean): CreationRevealAuthority | undefined {
    const submission = this.submission;
    if (submission === undefined) return undefined;
    const { authority, epoch, cancel: cancelSubmission } = submission;
    const selectionCurrent = authority.canSelect?.() !== false;
    const isCurrent = (): boolean =>
      selectionCurrent && this.epoch === epoch && authority.isCurrent();
    if (!success || !isCurrent()) cancelSubmission();
    return {
      ...(authority.canSelect === undefined
        ? {}
        : { canSelect: () => authority.canSelect?.() !== false }),
      isCurrent,
      onFinished: cancelSubmission,
      onPresented: (ref, element) => {
        authority.onPresented?.(ref, element);
        cancelSubmission();
      },
      reveal: (ref, request) => {
        const controller = new AbortController();
        const cleanup = (): void => {
          request.signal.removeEventListener('abort', cancel);
          this.cancellations.delete(cancel);
        };
        const cancel = (): void => {
          controller.abort();
          cleanup();
        };
        this.cancellations.add(cancel);
        request.signal.addEventListener('abort', cancel, { once: true });
        const current = (): boolean =>
          !controller.signal.aborted && request.isCurrent() && isCurrent();
        if (request.signal.aborted || !current()) {
          cancel();
          return undefined;
        }
        try {
          const result = authority.reveal(ref, { signal: controller.signal, isCurrent: current });
          if (result !== undefined && 'then' in result) {
            let release: (() => void) | undefined;
            const cancelled = new Promise<undefined>((resolve) => {
              const done = (): void => {
                resolve(undefined);
              };
              controller.signal.addEventListener('abort', done, { once: true });
              release = () => {
                controller.signal.removeEventListener('abort', done);
              };
              if (controller.signal.aborted) done();
            });
            return Promise.race([result, cancelled]).finally(() => {
              release?.();
            });
          }
          return result;
        } catch (error) {
          cleanup();
          throw error;
        }
      },
    };
  }
}
