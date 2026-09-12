import type { Project } from '../../projects/types';

const PRESENTATION_TIMEOUT_MS = 3_000;
const NORMAL_HIGHLIGHT_MS = 1_100;
const REDUCED_HIGHLIGHT_MS = 800;

interface PendingProjectPresentation {
  readonly path: string;
  readonly expectedStatus: string | undefined;
  readonly ownsFocus: () => boolean;
  expiresAt: number;
  membershipResolved: boolean;
  highlightUntil: number | undefined;
  element: HTMLElement | undefined;
  timeout: number;
}

interface ProjectCreationPresentationOptions {
  readonly host: HTMLElement;
  readonly projects: () => readonly Project[];
  readonly present: (project: Project, focus: boolean) => HTMLElement | null;
  readonly inaccessible: (path: string) => void;
  readonly reducedMotion: () => boolean;
  readonly now: () => number;
}

/** Resolves completed project commands against early or future ProjectStore snapshots. */
export class ProjectCreationPresentation {
  private readonly pending_abyssPrivate: PendingProjectPresentation[] = [];
  private destroyed_abyssPrivate = false;

  constructor(private readonly options_abyssPrivate: ProjectCreationPresentationOptions) {}

  enqueue(request: {
    readonly path: string;
    readonly expectedStatus?: string;
    readonly ownsFocus?: () => boolean;
  }): void {
    if (this.destroyed_abyssPrivate) return;
    const entry: PendingProjectPresentation = {
      path: request.path,
      expectedStatus: request.expectedStatus,
      ownsFocus: request.ownsFocus ?? (() => true),
      expiresAt: this.options_abyssPrivate.now() + PRESENTATION_TIMEOUT_MS,
      membershipResolved: false,
      highlightUntil: undefined,
      element: undefined,
      timeout: 0,
    };
    entry.timeout = this.setTimeout_abyssPrivate(() => {
      this.expire_abyssPrivate(entry);
    }, PRESENTATION_TIMEOUT_MS);
    this.pending_abyssPrivate.push(entry);
    this.update();
  }

  update(): void {
    if (this.destroyed_abyssPrivate) return;
    for (const entry of [...this.pending_abyssPrivate]) {
      this.updateEntry_abyssPrivate(entry);
    }
  }

  private updateEntry_abyssPrivate(entry: PendingProjectPresentation): void {
    if (!this.pending_abyssPrivate.includes(entry)) return;
    const project = this.options_abyssPrivate
      .projects()
      .find(
        (candidate) =>
          candidate.path === entry.path &&
          (entry.expectedStatus === undefined || candidate.statusId === entry.expectedStatus),
      );
    if (project === undefined) return;
    if (!entry.membershipResolved) {
      entry.membershipResolved = true;
      this.clearTimeout_abyssPrivate(entry.timeout);
      entry.timeout = 0;
    }
    const previous = entry.element;
    const focus = entry.highlightUntil === undefined && entry.ownsFocus();
    const element = this.options_abyssPrivate.present(project, focus);
    if (element === null) return;
    if (previous !== element) {
      previous?.classList.remove('is-just-created');
      entry.element = element;
    }
    element.classList.add('is-just-created');
    if (entry.highlightUntil === undefined) this.startHighlight_abyssPrivate(entry);
  }

  destroy(): void {
    if (this.destroyed_abyssPrivate) return;
    this.destroyed_abyssPrivate = true;
    for (const entry of this.pending_abyssPrivate.splice(0)) {
      this.clearTimeout_abyssPrivate(entry.timeout);
      entry.element?.classList.remove('is-just-created');
    }
  }

  private startHighlight_abyssPrivate(entry: PendingProjectPresentation): void {
    this.clearTimeout_abyssPrivate(entry.timeout);
    const duration = this.options_abyssPrivate.reducedMotion()
      ? REDUCED_HIGHLIGHT_MS
      : NORMAL_HIGHLIGHT_MS;
    entry.highlightUntil = this.options_abyssPrivate.now() + duration;
    entry.timeout = this.setTimeout_abyssPrivate(() => {
      this.expire_abyssPrivate(entry);
    }, duration);
  }

  private expire_abyssPrivate(entry: PendingProjectPresentation): void {
    if (!this.pending_abyssPrivate.includes(entry)) return;
    const deadline = entry.highlightUntil ?? entry.expiresAt;
    const remaining = deadline - this.options_abyssPrivate.now();
    if (remaining > 0) {
      entry.timeout = this.setTimeout_abyssPrivate(() => {
        this.expire_abyssPrivate(entry);
      }, remaining);
      return;
    }
    if (
      entry.highlightUntil === undefined &&
      !entry.membershipResolved &&
      entry.ownsFocus() &&
      this.options_abyssPrivate.host.isConnected
    ) {
      this.options_abyssPrivate.inaccessible(entry.path);
    }
    this.finish_abyssPrivate(entry);
  }

  private finish_abyssPrivate(entry: PendingProjectPresentation): void {
    const index = this.pending_abyssPrivate.indexOf(entry);
    if (index < 0) return;
    this.pending_abyssPrivate.splice(index, 1);
    this.clearTimeout_abyssPrivate(entry.timeout);
    entry.element?.classList.remove('is-just-created');
  }

  private setTimeout_abyssPrivate(callback: () => void, delay: number): number {
    const ownerWindow = this.options_abyssPrivate.host.ownerDocument.defaultView;
    return (ownerWindow ?? window).setTimeout(callback, delay);
  }

  private clearTimeout_abyssPrivate(timeout: number): void {
    const ownerWindow = this.options_abyssPrivate.host.ownerDocument.defaultView;
    (ownerWindow ?? window).clearTimeout(timeout);
  }
}
