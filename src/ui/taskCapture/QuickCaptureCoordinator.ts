import type { ShortcutActionId } from '../../settings/shortcuts';
import type { TaskCommandResult } from '../../tasks';
import type { InteractionOwnershipPort } from '../interactionOwnership';
import { describeTaskCreationResult, type CreationResultDescription } from '../taskCommandResult';
import { CaptureSurface } from './CaptureSurface';
import type { CaptureContext, CaptureTarget } from './CaptureTargetResolver';
import { TaskCaptureController } from './TaskCaptureController';

export type QuickCapturePhase = 'closed' | 'resolving' | 'open';

interface QuickCaptureCoordinatorOptions {
  readonly host: HTMLElement;
  readonly context: () => CaptureContext;
  readonly resolveTarget: (context: CaptureContext) => Promise<CaptureTarget>;
  readonly interactionOwnership: InteractionOwnershipPort<ShortcutActionId>;
  readonly onResult?: (result: TaskCommandResult, description: CreationResultDescription) => void;
}

function frozenContext(context: CaptureContext): CaptureContext {
  if (context.type === 'list') {
    return {
      type: 'list',
      selection:
        typeof context.selection === 'string' ? context.selection : { ...context.selection },
    };
  }
  return { ...context };
}

export class QuickCaptureCoordinator {
  private currentPhase: QuickCapturePhase = 'closed';
  private generation = 0;
  private ownershipToken: { release(): void } | null = null;
  private controller: TaskCaptureController | null = null;
  private surface: CaptureSurface | null = null;
  private focusOrigin: HTMLElement | null = null;
  private restoreFocusOnClose = false;
  private destroyed = false;

  constructor(private readonly options: QuickCaptureCoordinatorOptions) {}

  get phase(): QuickCapturePhase {
    return this.currentPhase;
  }

  openOrFocus(): void {
    if (this.destroyed || this.currentPhase === 'resolving') return;
    if (this.currentPhase === 'open') {
      this.surface?.focus();
      return;
    }

    const context = frozenContext(this.options.context());
    const generation = ++this.generation;
    this.focusOrigin = this.currentFocusOrigin();
    this.restoreFocusOnClose = false;
    this.currentPhase = 'resolving';
    this.ownershipToken = this.options.interactionOwnership.acquire({
      blocksShortcuts: true,
      allowActions: ['openQuickCapture'],
    });

    void this.resolveGeneration(generation, context);
  }

  close(): void {
    if (this.destroyed || this.currentPhase === 'closed') return;
    this.releaseCurrentGeneration(false);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.releaseCurrentGeneration();
  }

  private async resolveGeneration(generation: number, context: CaptureContext): Promise<void> {
    try {
      const target = await this.options.resolveTarget(context);
      this.openResolvedTarget(generation, target);
    } catch {
      this.closeGeneration(generation);
    }
  }

  private openResolvedTarget(generation: number, target: CaptureTarget): void {
    if (!this.ownsResolvingGeneration(generation)) return;

    let controller!: TaskCaptureController;
    controller = new TaskCaptureController({
      target,
      describe: describeTaskCreationResult,
      onResult: (result, description) => {
        if (this.generation === generation && this.controller === controller) {
          if (description.kind !== 'success') this.restoreFocusOnClose = false;
          this.options.onResult?.(result, description);
        }
      },
      onRequestClose: () => {
        if (this.generation === generation && this.controller === controller) {
          this.releaseCurrentGeneration(this.restoreFocusOnClose);
        }
      },
    });

    let surface: CaptureSurface;
    try {
      surface = new CaptureSurface(this.options.host, controller, {
        submitOnBlur: false,
        onEscape: () => {
          if (this.generation === generation && this.controller === controller) {
            this.restoreFocusOnClose = true;
          }
        },
      });
    } catch {
      controller.destroy();
      this.closeGeneration(generation);
      return;
    }
    if (!this.ownsResolvingGeneration(generation)) {
      surface.destroy();
      controller.destroy();
      return;
    }

    this.controller = controller;
    this.surface = surface;
    this.currentPhase = 'open';
    surface.focus();
  }

  private ownsResolvingGeneration(generation: number): boolean {
    return !this.destroyed && this.generation === generation && this.currentPhase === 'resolving';
  }

  private closeGeneration(generation: number): void {
    if (this.generation !== generation || this.currentPhase !== 'resolving') return;
    this.releaseCurrentGeneration(false);
  }

  private releaseCurrentGeneration(restoreFocus = false): void {
    ++this.generation;
    this.currentPhase = 'closed';
    const surface = this.surface;
    const controller = this.controller;
    const ownershipToken = this.ownershipToken;
    const focusOrigin = this.focusOrigin;
    const captureOwnedFocus =
      surface !== null && surface.input.ownerDocument.activeElement === surface.input;
    this.surface = null;
    this.controller = null;
    this.ownershipToken = null;
    this.focusOrigin = null;
    this.restoreFocusOnClose = false;
    surface?.destroy();
    controller?.destroy();
    ownershipToken?.release();
    if (restoreFocus && captureOwnedFocus && focusOrigin && this.canRestoreFocus(focusOrigin)) {
      focusOrigin.focus({ preventScroll: true });
    }
  }

  private currentFocusOrigin(): HTMLElement | null {
    const ownerDocument = this.options.host.ownerDocument;
    const active = ownerDocument.activeElement;
    const ownerWindow = ownerDocument.defaultView;
    return ownerWindow && active instanceof ownerWindow.HTMLElement ? active : null;
  }

  private canRestoreFocus(element: HTMLElement): boolean {
    if (!element.isConnected) return false;
    const ownerWindow = element.ownerDocument.defaultView;
    if (!ownerWindow) return false;
    const style = ownerWindow.getComputedStyle(element);
    return (
      style.display !== 'none' && style.visibility !== 'hidden' && style.visibility !== 'collapse'
    );
  }
}
