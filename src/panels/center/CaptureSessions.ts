import type { AppState } from '../../app/AppState';
import { listSelectionToKey } from '../../app/listViewState';
import type { CalendarSettings } from '../../settings/types';
import type {
  LocalDate,
  TaskApplicationApi,
  TaskCaptureApplicationApi,
  TaskCommandResult,
  TaskNodeSnapshot,
} from '../../tasks';
import type { CreationRevealAuthority } from '../../ui/creation/CreationPresentationController';
import { isRealmHTMLElement } from '../../ui/domRealm';
import { runAsyncAction } from '../../ui/runAsyncAction';
import {
  CaptureRevealIntent,
  type CaptureRevealAuthority,
} from '../../ui/taskCapture/CaptureRevealIntent';
import { CaptureSurface } from '../../ui/taskCapture/CaptureSurface';
import {
  CaptureTargetResolver,
  type CaptureContext,
  type CaptureTarget,
} from '../../ui/taskCapture/CaptureTargetResolver';
import { TaskCaptureController } from '../../ui/taskCapture/TaskCaptureController';
import {
  describeTaskCreationResult,
  type CreationResultDescription,
} from '../../ui/taskCommandResult';
import {
  calendarCaptureHost,
  calendarCaptureInputClass,
  captureTargetForCalendarPlacement,
  isCalendarCapturePlacement,
  type CalendarCapturePlacement,
} from '../calendar/calendarCapturePlacement';

export type BarCapturePlacement =
  | { readonly type: 'list'; readonly selectionKey: string }
  | { readonly type: 'project'; readonly path: string };

export type PanelCapturePlacement = BarCapturePlacement | CalendarCapturePlacement;

interface PanelCaptureSession {
  readonly requestId: number;
  readonly placement: PanelCapturePlacement;
  readonly controller: TaskCaptureController;
  surface?: CaptureSurface | undefined;
  host?: HTMLElement | undefined;
  feedbackHost?: HTMLElement | undefined;
  returnFocus?: HTMLElement;
  restoreFocusOnClose: boolean;
  focusOnMount: boolean;
  revealIntent?: CaptureRevealIntent | undefined;
}

interface CaptureSessionsOptions {
  readonly state: AppState;
  readonly settings: CalendarSettings;
  readonly application: (TaskApplicationApi & TaskCaptureApplicationApi) | null;
  readonly listNodes: () => readonly TaskNodeSnapshot[];
  readonly onCreationResult: (
    result: TaskCommandResult,
    description: CreationResultDescription,
    revealAuthority?: CreationRevealAuthority,
  ) => void;
  readonly captureReveal?: (isCurrent: () => boolean) => CaptureRevealAuthority;
  readonly root: () => HTMLElement;
}

export class CaptureSessions {
  readonly #captureTargets: CaptureTargetResolver | null;
  #captureRequestId = 0;
  #resolvingCapture: {
    readonly requestId: number;
    readonly placement: PanelCapturePlacement;
  } | null = null;
  #activeCapture: PanelCaptureSession | null = null;
  readonly #state: AppState;
  readonly #root: () => HTMLElement;
  readonly #captureReveal: CaptureSessionsOptions['captureReveal'];
  readonly #onCreationResult: CaptureSessionsOptions['onCreationResult'];

  constructor(options: CaptureSessionsOptions) {
    this.#state = options.state;
    this.#root = options.root;
    this.#onCreationResult = options.onCreationResult;
    this.#captureReveal = options.captureReveal;
    this.#captureTargets =
      options.application != null
        ? new CaptureTargetResolver(
            options.application,
            options.settings,
            undefined,
            options.listNodes,
          )
        : null;
  }

  renderCaptureHost(host: HTMLElement, placement: BarCapturePlacement): void {
    host.dataset['abyssCaptureHost'] = placement.type;
    if (placement.type === 'project') host.dataset['abyssCapturePath'] = placement.path;
    if (placement.type === 'list') {
      host.dataset['abyssCaptureSelection'] = placement.selectionKey;
    }
    if (host.querySelector('.abyss-add-task-trigger') !== null) return;
    const trigger = host.createEl('button', {
      cls: 'abyss-add-task-trigger',
      attr: { type: 'button' },
    });
    trigger.createSpan({ cls: 'abyss-add-task-plus', text: '+' });
    trigger.createSpan({ cls: 'abyss-add-task-label', text: 'Add task' });
    trigger.addEventListener('click', () => {
      const context: CaptureContext =
        placement.type === 'project'
          ? { type: 'project-dashboard', path: placement.path }
          : { type: 'list', selection: this.#state.get('selectedList') };
      this.openCapture(placement, context, trigger);
    });
    const active = this.#activeCapture;
    if (active != null && this.#sameCapturePlacement(active.placement, placement)) {
      trigger.hidden = true;
      active.returnFocus = trigger;
      this.#mountCaptureSurface(active, host);
    }
  }

  openDateCapture(date: LocalDate): void {
    if (this.#state.get('mode') !== 'tasks') return;
    const active = this.#activeCapture;
    if (
      active !== null &&
      (active.controller.snapshot().phase !== 'idle' || !active.controller.isEmpty())
    ) {
      active.focusOnMount = true;
      this.remountActiveCapture();
      if (active.surface !== undefined) this.#focusNewCaptureSurface(active, active.surface);
      return;
    }
    const selection = this.#state.get('selectedList');
    this.openCapture(
      { type: 'list', selectionKey: listSelectionToKey(selection) },
      { type: 'list', selection, date },
    );
  }

  openCapture(
    placement: PanelCapturePlacement,
    context: CaptureContext,
    returnFocus = this.#currentCaptureFocusOrigin(),
  ): void {
    if (this.#captureTargets == null) return;
    this.cancelActiveCapture();
    const requestId = ++this.#captureRequestId;
    this.#resolvingCapture = { requestId, placement };
    runAsyncAction(
      this.#captureTargets.resolve(context).then((resolvedTarget) => {
        if (requestId !== this.#captureRequestId) return;
        this.#resolvingCapture = null;
        const target = this.#targetForCapturePlacement(resolvedTarget, placement);
        const controller = new TaskCaptureController({
          target,
          describe: describeTaskCreationResult,
          onSubmit: () => this.#activeCapture?.revealIntent?.beginSubmission(),
          onResult: (result, description) => {
            const current = this.#activeCapture;
            if (current?.requestId === requestId && description.kind !== 'success') {
              current.restoreFocusOnClose = false;
            }
            this.#onCreationResult(
              result,
              description,
              current?.revealIntent?.forResult(description.kind === 'success'),
            );
          },
          onRequestClose: () => {
            this.#closeCaptureByRequestId(requestId);
          },
        });
        const session: PanelCaptureSession = {
          requestId,
          placement,
          controller,
          ...(returnFocus !== null && { returnFocus }),
          restoreFocusOnClose: false,
          focusOnMount: true,
        };
        this.#activeCapture = session;
        this.remountActiveCapture();
        if (!isCalendarCapturePlacement(placement)) {
          session.revealIntent = new CaptureRevealIntent(
            this.#captureReveal?.(
              () =>
                this.#activeCapture === session &&
                session.controller.snapshot().phase !== 'closed' &&
                session.surface?.input.isConnected === true &&
                session.surface.input.ownerDocument.activeElement === session.surface.input,
            ),
          );
          if (session.surface !== undefined) session.revealIntent.mount(session.surface.input);
        }
      }),
    );
  }

  remountActiveCapture(): void {
    const active = this.#activeCapture;
    if (active == null) return;
    const placement = active.placement;
    if (isCalendarCapturePlacement(placement)) {
      const host = calendarCaptureHost(this.#root(), placement);
      if (host != null) this.#mountCaptureSurface(active, host);
      return;
    }
    const host = [...this.#root().querySelectorAll<HTMLElement>('[data-abyss-capture-host]')].find(
      (candidate) =>
        placement.type === 'project'
          ? candidate.dataset['abyssCaptureHost'] === 'project' &&
            candidate.dataset['abyssCapturePath'] === placement.path
          : candidate.dataset['abyssCaptureHost'] === 'list' &&
            candidate.dataset['abyssCaptureSelection'] === placement.selectionKey,
    );
    if (host != null) this.#mountCaptureSurface(active, host);
  }

  #targetForCapturePlacement(
    target: CaptureTarget,
    placement: PanelCapturePlacement,
  ): CaptureTarget {
    if (!isCalendarCapturePlacement(placement)) return target;
    return captureTargetForCalendarPlacement(target, placement);
  }

  #mountCaptureSurface(active: PanelCaptureSession, host: HTMLElement): void {
    if (this.#activeCapture !== active) return;
    if (this.#isCaptureSurfaceMounted(active, host)) return;
    this.unmountActiveCapture();
    const feedbackHost = this.#prepareCaptureHost(active, host);
    const onEscape = (): void => {
      active.restoreFocusOnClose = true;
    };
    const options = {
      ...(active.placement.type === 'calendar-timed' && {
        placeholder: `Task at ${active.placement.time}…`,
      }),
      ...(feedbackHost !== undefined && { feedbackHost }),
      onEscape,
    };
    const presentation =
      active.placement.type === 'list' || active.placement.type === 'project'
        ? 'inline'
        : 'default';
    const surface = new CaptureSurface(host, active.controller, { ...options, presentation });
    this.#applyCaptureInputClass(surface, active.placement);
    active.revealIntent?.mount(surface.input);
    active.surface = surface;
    active.host = host;
    this.#focusNewCaptureSurface(active, surface);
  }

  #isCaptureSurfaceMounted(active: PanelCaptureSession, host: HTMLElement): boolean {
    return active.surface?.element.isConnected === true && active.host === host;
  }

  #applyCaptureInputClass(surface: CaptureSurface, placement: PanelCapturePlacement): void {
    const className = calendarCaptureInputClass(placement);
    if (className !== undefined && className !== '') surface.input.addClass(className);
  }

  #focusNewCaptureSurface(active: PanelCaptureSession, surface: CaptureSurface): void {
    if (!active.focusOnMount) return;
    active.focusOnMount = false;
    surface.focus();
  }

  #prepareCaptureHost(active: PanelCaptureSession, host: HTMLElement): HTMLElement | undefined {
    if (isCalendarCapturePlacement(active.placement)) {
      host.empty();
      const feedbackHost = this.#root().createDiv({ cls: 'abyss-calendar-capture-feedback' });
      active.feedbackHost = feedbackHost;
      return feedbackHost;
    }
    const trigger = host.querySelector<HTMLButtonElement>('.abyss-add-task-trigger');
    if (trigger != null) {
      trigger.hidden = true;
      active.returnFocus = trigger;
    }
    return undefined;
  }

  unmountActiveCapture(): void {
    const active = this.#activeCapture;
    const surface = active?.surface;
    active?.revealIntent?.unmount();
    if (active == null || surface == null) return;
    active.focusOnMount =
      active.focusOnMount || surface.input.ownerDocument.activeElement === surface.input;
    active.surface = undefined;
    active.host = undefined;
    surface.destroy();
    active.feedbackHost?.remove();
    active.feedbackHost = undefined;
  }

  #closeCapture(active: PanelCaptureSession): void {
    if (this.#activeCapture !== active) return;
    const host = active.host;
    const placement = active.placement;
    const returnFocus = active.returnFocus;
    const restoreFocus = active.restoreFocusOnClose;
    const captureOwnedFocus =
      active.surface !== undefined &&
      active.surface.input.ownerDocument.activeElement === active.surface.input;
    this.unmountActiveCapture();
    active.controller.destroy();
    this.#activeCapture = null;
    this.#restoreCaptureHost(host, placement);
    if (
      restoreFocus &&
      captureOwnedFocus &&
      returnFocus != null &&
      this.#canRestoreCaptureFocus(returnFocus)
    ) {
      returnFocus.focus({ preventScroll: true });
    }
  }

  #closeCaptureByRequestId(requestId: number): void {
    const active = this.#activeCapture;
    if (active?.requestId === requestId) this.#closeCapture(active);
  }

  cancelActiveCapture(): void {
    this.#captureRequestId++;
    this.#resolvingCapture = null;
    const active = this.#activeCapture;
    if (active == null) return;
    const host = active.host;
    const placement = active.placement;
    this.unmountActiveCapture();
    active.controller.destroy();
    this.#activeCapture = null;
    this.#restoreCaptureHost(host, placement);
  }

  #restoreCaptureHost(host: HTMLElement | undefined, placement: PanelCapturePlacement): void {
    if (host?.isConnected !== true) return;
    if (isCalendarCapturePlacement(placement)) {
      host.remove();
      return;
    }
    host.querySelector<HTMLButtonElement>('.abyss-add-task-trigger')?.removeAttribute('hidden');
  }

  #sameCapturePlacement(left: PanelCapturePlacement, right: PanelCapturePlacement): boolean {
    return this.#capturePlacementKey(left) === this.#capturePlacementKey(right);
  }

  #capturePlacementKey(placement: PanelCapturePlacement): string {
    switch (placement.type) {
      case 'project':
        return `project:${placement.path}`;
      case 'calendar-timed':
        return `calendar-timed:${placement.date}:${placement.time}`;
      case 'calendar-all-day':
        return `calendar-all-day:${placement.date}`;
      case 'calendar-month':
        return `calendar-month:${placement.date}`;
      case 'list':
        return `list:${placement.selectionKey}`;
    }
  }

  cancelStaleListCapture(): void {
    const placement = this.#activeCapture?.placement ?? this.#resolvingCapture?.placement;
    if (placement?.type !== 'list') return;
    const currentSelectionKey = listSelectionToKey(this.#state.get('selectedList'));
    if (this.#state.get('mode') !== 'tasks' || placement.selectionKey !== currentSelectionKey) {
      this.cancelActiveCapture();
    }
  }

  #currentCaptureFocusOrigin(): HTMLElement | null {
    const active = this.#root().ownerDocument.activeElement;
    return isRealmHTMLElement(active) ? active : null;
  }

  #canRestoreCaptureFocus(element: HTMLElement): boolean {
    if (!element.isConnected) return false;
    const ownerWindow = element.ownerDocument.defaultView;
    if (ownerWindow == null) return false;
    const style = ownerWindow.getComputedStyle(element);
    return (
      style.display !== 'none' && style.visibility !== 'hidden' && style.visibility !== 'collapse'
    );
  }
}
