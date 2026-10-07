import type { CreationRevealAuthority } from '../creation/CreationPresentationController';

/** Finite result permission shared by capture owners; presentation and scrolling stay external. */
export class CaptureRevealIntent {
  private epoch = 0;
  private input: HTMLInputElement | undefined;
  private readonly cancellations = new Set<() => void>();
  private readonly revoke = (): void => {
    this.epoch++;
    for (const cancel of [...this.cancellations]) cancel();
  };

  constructor(private readonly authority: CreationRevealAuthority | undefined) {}

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

  forResult(): CreationRevealAuthority | undefined {
    const authority = this.authority;
    if (authority === undefined) return undefined;
    const epoch = this.epoch;
    const isCurrent = (): boolean => this.epoch === epoch && authority.isCurrent();
    return {
      isCurrent,
      onPresented: (ref, element) => authority.onPresented?.(ref, element),
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
