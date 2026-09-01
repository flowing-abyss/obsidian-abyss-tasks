export interface BoardPoint {
  readonly x: number;
  readonly y: number;
}

export interface BoardRect {
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
}

export interface BoardDestinationGeometry<ColumnId extends string> {
  readonly kind: 'column' | 'rail' | 'hidden-disclosure';
  readonly columnId?: ColumnId;
  readonly rect: BoardRect;
  readonly enabled: boolean;
  readonly hiddenColumnIds?: readonly ColumnId[];
}

interface BoardItemGeometry<ItemId extends string, ColumnId extends string> {
  readonly itemId: ItemId;
  readonly columnId: ColumnId;
  readonly rect: BoardRect;
}

export interface BoardGeometrySnapshot<ItemId extends string, ColumnId extends string> {
  readonly destinations: readonly BoardDestinationGeometry<ColumnId>[];
  readonly items: readonly BoardItemGeometry<ItemId, ColumnId>[];
  readonly scrollContainer?: {
    readonly rect: BoardRect;
    readonly scrollLeft: number;
  };
}

export interface BoardCanonicalPosition<ColumnId extends string> {
  readonly position: number;
  readonly evidence: string;
  readonly gap: BoardLandingGap<ColumnId>;
}

export interface BoardObservedPosition<ColumnId extends string> {
  readonly columnId: ColumnId;
  readonly position: number;
  readonly evidence: string;
}

interface BoardLandingGap<ColumnId extends string> {
  readonly columnId: ColumnId;
  readonly position: number;
  readonly beforeItemId?: string;
  readonly afterItemId?: string;
}

export type BoardDestination<ColumnId extends string> =
  | { readonly kind: 'column' | 'rail'; readonly columnId: ColumnId }
  | {
      readonly kind: 'column';
      readonly columnId: ColumnId;
      readonly exposedFromHidden: true;
    }
  | { readonly kind: 'hidden-disclosure' };

export interface BoardMoveIntent<ItemId extends string, ColumnId extends string> {
  readonly itemId: ItemId;
  readonly observedSource: BoardObservedPosition<ColumnId>;
  readonly destination: BoardObservedPosition<ColumnId>;
  readonly interactionEpoch: number;
}

type BoardCommitResult<UndoAuthority> =
  | {
      readonly type: 'success';
      readonly undo?: { readonly authority: UndoAuthority; readonly evidence: string };
      /** A command may be accepted while its canonical source publication is still pending. */
      readonly settled?: boolean;
    }
  | {
      readonly type: 'conflict' | 'failure';
      readonly reason?: string;
      /** The presentation layer already delivered the one terminal result. */
      readonly announced?: boolean;
    };

type BoardUndoResult =
  | { readonly type: 'success' }
  | { readonly type: 'conflict' | 'failure'; readonly reason?: string };

export type BoardAnnouncement<ItemId extends string, ColumnId extends string> =
  | { readonly type: 'pickup'; readonly itemId: ItemId; readonly sourceColumnId: ColumnId }
  | {
      readonly type: 'destination';
      readonly destination: BoardDestination<ColumnId>;
      readonly position?: number;
    }
  | { readonly type: 'commit-pending' }
  | { readonly type: 'success' }
  | { readonly type: 'cancel' }
  | { readonly type: 'conflict' | 'failure'; readonly reason?: string }
  | { readonly type: 'undo-available' }
  | { readonly type: 'undo-success' }
  | { readonly type: 'undo-conflict' | 'undo-failure'; readonly reason?: string };

export interface BoardRenderProjection<ItemId extends string, ColumnId extends string> {
  readonly pickedItemId?: ItemId;
  readonly sourcePlaceholder?: { readonly itemId: ItemId; readonly columnId: ColumnId };
  readonly preview?: { readonly anchor: BoardPoint; readonly offset: BoardPoint };
  readonly activeDestination?: BoardDestination<ColumnId>;
  readonly landingGap?: BoardLandingGap<ColumnId>;
  readonly pending: boolean;
  readonly accessibility: {
    readonly grabbed: boolean;
    readonly dropEffect: 'move' | 'none';
    readonly dropTargets: readonly BoardDestination<ColumnId>[];
    readonly undoAvailable: boolean;
  };
}

export interface BoardInteractionPorts<
  ItemId extends string,
  ColumnId extends string,
  UndoAuthority,
> {
  readonly geometry: {
    snapshot(): BoardGeometrySnapshot<ItemId, ColumnId>;
    canonicalLanding(
      itemId: ItemId,
      destinationColumnId: ColumnId,
      snapshot: BoardGeometrySnapshot<ItemId, ColumnId>,
    ): BoardCanonicalPosition<ColumnId> | undefined;
  };
  readonly commitMove: (
    intent: BoardMoveIntent<ItemId, ColumnId>,
  ) => Promise<BoardCommitResult<UndoAuthority>>;
  readonly undoMove?: (request: {
    readonly authority: UndoAuthority;
    readonly evidence: string;
    readonly move: BoardMoveIntent<ItemId, ColumnId>;
    readonly operationEpoch: number;
  }) => Promise<BoardUndoResult>;
  readonly publish: (projection: BoardRenderProjection<ItemId, ColumnId>) => void;
  readonly announce: (announcement: BoardAnnouncement<ItemId, ColumnId>) => void;
  readonly capturePointer?: (pointerId: number) => void;
  readonly releasePointer?: (pointerId: number) => void;
  readonly requestAutoscroll?: (request: {
    readonly direction: -1 | 0 | 1;
    readonly speed: number;
  }) => void;
  readonly restoreFocus?: (itemId: ItemId, columnId: ColumnId) => void;
}

export interface BoardInteractionOptions {
  readonly movementThreshold?: number;
  readonly edgeZone?: number;
  readonly maxAutoscrollSpeed?: number;
}

interface ActiveInteraction<ItemId extends string, ColumnId extends string> {
  readonly epoch: number;
  readonly mode: 'pointer' | 'keyboard' | 'fallback';
  readonly itemId: ItemId;
  readonly source: BoardObservedPosition<ColumnId>;
  readonly pointerId?: number;
  readonly pressPoint?: BoardPoint;
  picked: boolean;
  pending: boolean;
  hiddenExpanded: boolean;
  pointerCaptured: boolean;
  preview?: { readonly anchor: BoardPoint; readonly offset: BoardPoint };
  activeDestination?: BoardDestination<ColumnId>;
  landing?: BoardCanonicalPosition<ColumnId>;
  dropTargets: readonly BoardDestination<ColumnId>[];
  lastDestinationAnnouncement?: string;
}

interface StoredUndo<ItemId extends string, ColumnId extends string, UndoAuthority> {
  readonly authority: UndoAuthority;
  readonly evidence: string;
  readonly move: BoardMoveIntent<ItemId, ColumnId>;
}

const DEFAULT_MOVEMENT_THRESHOLD = 6;
const DEFAULT_EDGE_ZONE = 40;
const DEFAULT_MAX_AUTOSCROLL_SPEED = 20;

function copyPoint(point: BoardPoint): BoardPoint {
  return Object.freeze({ x: point.x, y: point.y });
}

function copyRect(rect: BoardRect): BoardRect {
  return Object.freeze({
    left: rect.left,
    right: rect.right,
    top: rect.top,
    bottom: rect.bottom,
  });
}

function copySnapshot<ItemId extends string, ColumnId extends string>(
  snapshot: BoardGeometrySnapshot<ItemId, ColumnId>,
): BoardGeometrySnapshot<ItemId, ColumnId> {
  return {
    destinations: snapshot.destinations.map((destination) => ({
      ...destination,
      rect: copyRect(destination.rect),
      hiddenColumnIds: destination.hiddenColumnIds ? [...destination.hiddenColumnIds] : undefined,
    })),
    items: snapshot.items.map((item) => ({ ...item, rect: copyRect(item.rect) })),
    scrollContainer: snapshot.scrollContainer
      ? {
          rect: copyRect(snapshot.scrollContainer.rect),
          scrollLeft: snapshot.scrollContainer.scrollLeft,
        }
      : undefined,
  };
}

function contains(rect: BoardRect, point: BoardPoint): boolean {
  return (
    point.x >= rect.left && point.x < rect.right && point.y >= rect.top && point.y < rect.bottom
  );
}

function destinationKey<ColumnId extends string>(
  destination: BoardDestination<ColumnId> | undefined,
  position: number | undefined,
): string | undefined {
  if (!destination) return undefined;
  return destination.kind === 'hidden-disclosure'
    ? destination.kind
    : `${destination.kind}:${destination.columnId}:${position ?? ''}:${'exposedFromHidden' in destination}`;
}

function errorReason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function freezeIntent<ItemId extends string, ColumnId extends string>(
  intent: BoardMoveIntent<ItemId, ColumnId>,
): BoardMoveIntent<ItemId, ColumnId> {
  Object.freeze(intent.observedSource);
  Object.freeze(intent.destination);
  return Object.freeze(intent);
}

/**
 * Pure, renderer-agnostic board interaction state machine. It publishes
 * semantic projections and mutation intents but never owns DOM, timers, or
 * persistence.
 */
export class BoardInteractionController<
  ItemId extends string,
  ColumnId extends string,
  UndoAuthority,
> {
  private readonly movementThreshold: number;
  private readonly edgeZone: number;
  private readonly maxAutoscrollSpeed: number;
  private active?: ActiveInteraction<ItemId, ColumnId>;
  private undoToken?: StoredUndo<ItemId, ColumnId, UndoAuthority>;
  private publishedUndoToken?: StoredUndo<ItemId, ColumnId, UndoAuthority>;
  private undoPending = false;
  private epoch = 0;

  constructor(
    private readonly ports: BoardInteractionPorts<ItemId, ColumnId, UndoAuthority>,
    options: BoardInteractionOptions = {},
  ) {
    this.movementThreshold = Math.max(0, options.movementThreshold ?? DEFAULT_MOVEMENT_THRESHOLD);
    this.edgeZone = Math.max(1, options.edgeZone ?? DEFAULT_EDGE_ZONE);
    this.maxAutoscrollSpeed = Math.max(
      1,
      options.maxAutoscrollSpeed ?? DEFAULT_MAX_AUTOSCROLL_SPEED,
    );
  }

  pointerDown(input: {
    readonly pointerId: number;
    readonly button: number;
    readonly isPrimary: boolean;
    readonly itemId: ItemId;
    readonly source: BoardObservedPosition<ColumnId>;
    readonly point: BoardPoint;
    readonly enabled: boolean;
  }): boolean {
    if (input.button !== 0 || !input.isPrimary || !input.enabled || this.active || this.undoPending)
      return false;
    this.active = {
      epoch: ++this.epoch,
      mode: 'pointer',
      itemId: input.itemId,
      source: { ...input.source },
      pointerId: input.pointerId,
      pressPoint: copyPoint(input.point),
      picked: false,
      pending: false,
      hiddenExpanded: false,
      pointerCaptured: false,
      dropTargets: [],
    };
    return true;
  }

  pointerMove(input: { readonly pointerId: number; readonly point: BoardPoint }): boolean {
    const active = this.active;
    if (
      !active ||
      active.mode !== 'pointer' ||
      active.pointerId !== input.pointerId ||
      active.pending
    ) {
      return false;
    }
    if (!active.picked) {
      const press = active.pressPoint!;
      if (Math.hypot(input.point.x - press.x, input.point.y - press.y) < this.movementThreshold) {
        return true;
      }
      const snapshot = this.snapshot();
      const item = snapshot.items.find(({ itemId }) => itemId === active.itemId);
      if (!item) return false;
      const offset = copyPoint({ x: press.x - item.rect.left, y: press.y - item.rect.top });
      active.picked = true;
      active.preview = {
        anchor: copyPoint({ x: input.point.x - offset.x, y: input.point.y - offset.y }),
        offset,
      };
      if (this.ports.capturePointer) {
        this.ports.capturePointer(input.pointerId);
        active.pointerCaptured = true;
      }
      this.ports.announce({
        type: 'pickup',
        itemId: active.itemId,
        sourceColumnId: active.source.columnId,
      });
    }
    this.updatePointerTarget(active, input.point);
    this.publish();
    return true;
  }

  async pointerUp(input: {
    readonly pointerId: number;
    readonly point: BoardPoint;
  }): Promise<boolean> {
    const active = this.active;
    if (!active || active.mode !== 'pointer' || active.pointerId !== input.pointerId) return false;
    if (!active.picked) {
      this.active = undefined;
      return false;
    }
    if (!active.pending) this.updatePointerTarget(active, input.point);
    if (!this.changedColumnDestination(active)) {
      this.cancelActive(true);
      return false;
    }
    return this.commitActive(active);
  }

  pointerCancel(pointerId: number): boolean {
    const active = this.active;
    if (!active || active.mode !== 'pointer' || active.pointerId !== pointerId) return false;
    this.cancelActive(true);
    return true;
  }

  lostPointerCapture(pointerId: number): boolean {
    const active = this.active;
    if (!active || active.mode !== 'pointer' || active.pointerId !== pointerId) return false;
    this.cancelActive(false);
    return true;
  }

  async keyDown(input: {
    readonly key: string;
    readonly itemId?: ItemId;
    readonly source?: BoardObservedPosition<ColumnId>;
    readonly enabled?: boolean;
  }): Promise<boolean> {
    if (input.key === 'Escape' && this.active) {
      this.cancelActive(true);
      return true;
    }
    if (!this.active) {
      if (
        input.key !== ' ' ||
        input.itemId === undefined ||
        input.source === undefined ||
        input.enabled !== true ||
        this.undoPending
      ) {
        return false;
      }
      const active: ActiveInteraction<ItemId, ColumnId> = {
        epoch: ++this.epoch,
        mode: 'keyboard',
        itemId: input.itemId,
        source: { ...input.source },
        picked: true,
        pending: false,
        hiddenExpanded: false,
        pointerCaptured: false,
        dropTargets: [],
      };
      this.active = active;
      this.refreshDropTargets(active);
      const sourceTarget = active.dropTargets.find(
        (destination) =>
          destination.kind !== 'hidden-disclosure' &&
          destination.columnId === active.source.columnId,
      );
      this.ports.announce({
        type: 'pickup',
        itemId: active.itemId,
        sourceColumnId: active.source.columnId,
      });
      if (sourceTarget) this.setDestination(active, sourceTarget, this.snapshot());
      this.publish();
      return true;
    }

    const active = this.active;
    if (!active.picked || active.pending) return false;
    if (input.key === 'ArrowUp' || input.key === 'ArrowDown') return false;
    if (input.key === ' ') {
      if (active.activeDestination?.kind === 'hidden-disclosure') {
        active.hiddenExpanded = true;
        this.refreshDropTargets(active);
        this.publish();
        return true;
      }
      const priorDestination = active.activeDestination;
      const snapshot = this.snapshot();
      this.refreshDropTargets(active, snapshot);
      const liveDestination = active.dropTargets.find(
        (destination) =>
          destinationKey(destination, undefined) === destinationKey(priorDestination, undefined),
      );
      if (!liveDestination) {
        this.cancelActive(true);
        return true;
      }
      this.setDestination(active, liveDestination, snapshot);
      if (!this.changedColumnDestination(active)) {
        this.cancelActive(true);
        return true;
      }
      await this.commitActive(active);
      return true;
    }
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(input.key)) return false;

    this.refreshDropTargets(active);
    const targets = active.dropTargets;
    if (targets.length === 0) return true;
    let index = targets.findIndex(
      (destination) =>
        destinationKey(destination, undefined) ===
        destinationKey(active.activeDestination, undefined),
    );
    if (index < 0) index = 0;
    if (input.key === 'Home') index = 0;
    else if (input.key === 'End') index = targets.length - 1;
    else if (input.key === 'ArrowLeft') index = Math.max(0, index - 1);
    else index = Math.min(targets.length - 1, index + 1);
    this.setDestination(active, targets[index], this.snapshot());
    this.publish();
    return true;
  }

  async requestMove(input: {
    readonly itemId: ItemId;
    readonly source: BoardObservedPosition<ColumnId>;
    readonly destinationColumnId: ColumnId;
    readonly enabled: boolean;
  }): Promise<boolean> {
    if (
      !input.enabled ||
      this.active ||
      this.undoPending ||
      input.source.columnId === input.destinationColumnId
    ) {
      return false;
    }
    const snapshot = this.snapshot();
    const landing = this.ports.geometry.canonicalLanding(
      input.itemId,
      input.destinationColumnId,
      snapshot,
    );
    if (!landing) return false;
    const active: ActiveInteraction<ItemId, ColumnId> = {
      epoch: ++this.epoch,
      mode: 'fallback',
      itemId: input.itemId,
      source: { ...input.source },
      picked: true,
      pending: false,
      hiddenExpanded: false,
      pointerCaptured: false,
      activeDestination: { kind: 'column', columnId: input.destinationColumnId },
      landing: this.copyLanding(landing),
      dropTargets: [],
    };
    this.active = active;
    this.ports.announce({
      type: 'pickup',
      itemId: active.itemId,
      sourceColumnId: active.source.columnId,
    });
    this.announceDestination(active);
    this.publish();
    return this.commitActive(active);
  }

  async undo(): Promise<boolean> {
    if (!this.undoToken || !this.ports.undoMove || this.active || this.undoPending) return false;
    const token = this.undoToken;
    this.undoToken = undefined;
    this.undoPending = true;
    const operationEpoch = ++this.epoch;
    this.publish();
    let result: BoardUndoResult;
    try {
      result = await this.ports.undoMove({ ...token, operationEpoch });
    } catch (error) {
      result = { type: 'failure', reason: errorReason(error) };
    }
    if (this.epoch !== operationEpoch || !this.undoPending) return false;
    this.undoPending = false;
    if (result.type === 'success') {
      this.ports.announce({ type: 'undo-success' });
      this.ports.restoreFocus?.(token.move.itemId, token.move.observedSource.columnId);
    } else {
      this.ports.announce({
        type: result.type === 'conflict' ? 'undo-conflict' : 'undo-failure',
        reason: result.reason,
      });
    }
    this.publish();
    return true;
  }

  projection(): BoardRenderProjection<ItemId, ColumnId> {
    const active = this.active;
    const picked = active?.picked === true;
    const preview = active?.preview
      ? {
          anchor: copyPoint(active.preview.anchor),
          offset: copyPoint(active.preview.offset),
        }
      : undefined;
    const landingGap = active?.landing ? Object.freeze({ ...active.landing.gap }) : undefined;
    const activeDestination = active?.activeDestination
      ? Object.freeze({ ...active.activeDestination })
      : undefined;
    const projection: BoardRenderProjection<ItemId, ColumnId> = {
      pickedItemId: picked ? active.itemId : undefined,
      sourcePlaceholder: picked
        ? Object.freeze({ itemId: active.itemId, columnId: active.source.columnId })
        : undefined,
      preview: preview ? Object.freeze(preview) : undefined,
      activeDestination,
      landingGap,
      pending: active?.pending === true || this.undoPending,
      accessibility: Object.freeze({
        grabbed: picked,
        dropEffect: picked ? 'move' : 'none',
        dropTargets: Object.freeze(
          active?.dropTargets.map((target) => Object.freeze({ ...target })) ?? [],
        ),
        undoAvailable: this.undoToken !== undefined && !this.active && !this.undoPending,
      }),
    };
    return Object.freeze(projection);
  }

  /** Explicitly retires Undo when the consumer knows its authority is stale. */
  invalidateUndo(): boolean {
    if (!this.undoToken) return false;
    this.undoToken = undefined;
    this.publish();
    return true;
  }

  /**
   * The board calls this only after its application-owned overlay observes the
   * matching canonical publication. Command acceptance alone must never expose Undo.
   */
  acceptPublishedUndo(
    authority: UndoAuthority,
    evidence: string,
    move: BoardMoveIntent<ItemId, ColumnId>,
  ): boolean {
    if (this.undoPending || this.undoToken) return false;
    const token = Object.freeze({ authority, evidence, move });
    if (this.active) {
      if (
        !this.active.pending ||
        this.active.itemId !== move.itemId ||
        this.active.epoch !== move.interactionEpoch
      )
        return false;
      this.publishedUndoToken = token;
      return true;
    }
    this.undoToken = token;
    this.publish();
    return true;
  }

  private snapshot(): BoardGeometrySnapshot<ItemId, ColumnId> {
    return copySnapshot(this.ports.geometry.snapshot());
  }

  private updatePointerTarget(
    active: ActiveInteraction<ItemId, ColumnId>,
    point: BoardPoint,
  ): void {
    const snapshot = this.snapshot();
    if (active.preview) {
      active.preview = {
        anchor: copyPoint({
          x: point.x - active.preview.offset.x,
          y: point.y - active.preview.offset.y,
        }),
        offset: active.preview.offset,
      };
    }
    this.refreshDropTargets(active, snapshot);
    const destinationGeometry = snapshot.destinations.find(
      (candidate) => candidate.enabled && contains(candidate.rect, point),
    );
    const destination = destinationGeometry
      ? this.destinationFromGeometry(destinationGeometry)
      : undefined;
    if (destination?.kind === 'hidden-disclosure' && !active.hiddenExpanded) {
      active.hiddenExpanded = true;
      this.refreshDropTargets(active, snapshot);
    }
    this.setDestination(active, destination, snapshot);
    this.autoscroll(point, snapshot.scrollContainer?.rect);
  }

  private destinationFromGeometry(
    geometry: BoardDestinationGeometry<ColumnId>,
  ): BoardDestination<ColumnId> | undefined {
    if (geometry.kind === 'hidden-disclosure') return { kind: 'hidden-disclosure' };
    return geometry.columnId ? { kind: geometry.kind, columnId: geometry.columnId } : undefined;
  }

  private refreshDropTargets(
    active: ActiveInteraction<ItemId, ColumnId>,
    providedSnapshot?: BoardGeometrySnapshot<ItemId, ColumnId>,
  ): void {
    const snapshot = providedSnapshot ?? this.snapshot();
    active.dropTargets = snapshot.destinations
      .filter(({ enabled }) => enabled)
      .flatMap((geometry): readonly BoardDestination<ColumnId>[] => {
        const destination = this.destinationFromGeometry(geometry);
        if (!destination) return [];
        if (!active.hiddenExpanded || destination.kind !== 'hidden-disclosure') {
          return [destination];
        }
        return [
          destination,
          ...(geometry.hiddenColumnIds ?? []).map(
            (columnId): BoardDestination<ColumnId> => ({
              kind: 'column',
              columnId,
              exposedFromHidden: true,
            }),
          ),
        ];
      });
  }

  private setDestination(
    active: ActiveInteraction<ItemId, ColumnId>,
    destination: BoardDestination<ColumnId> | undefined,
    snapshot: BoardGeometrySnapshot<ItemId, ColumnId>,
  ): void {
    active.activeDestination = destination;
    active.landing = undefined;
    if (!destination) active.lastDestinationAnnouncement = undefined;
    if (destination && destination.kind !== 'hidden-disclosure') {
      const landing = this.ports.geometry.canonicalLanding(
        active.itemId,
        destination.columnId,
        snapshot,
      );
      if (landing) active.landing = this.copyLanding(landing);
      else active.activeDestination = undefined;
    }
    if (!active.activeDestination) active.lastDestinationAnnouncement = undefined;
    this.announceDestination(active);
  }

  private announceDestination(active: ActiveInteraction<ItemId, ColumnId>): void {
    const key = destinationKey(active.activeDestination, active.landing?.position);
    if (!key || key === active.lastDestinationAnnouncement) return;
    active.lastDestinationAnnouncement = key;
    this.ports.announce({
      type: 'destination',
      destination: active.activeDestination!,
      position: active.landing?.position,
    });
  }

  private copyLanding(landing: BoardCanonicalPosition<ColumnId>): BoardCanonicalPosition<ColumnId> {
    return {
      position: landing.position,
      evidence: landing.evidence,
      gap: { ...landing.gap },
    };
  }

  private changedColumnDestination(active: ActiveInteraction<ItemId, ColumnId>): boolean {
    return (
      active.activeDestination !== undefined &&
      active.activeDestination.kind !== 'hidden-disclosure' &&
      active.activeDestination.columnId !== active.source.columnId &&
      active.landing !== undefined
    );
  }

  private async commitActive(active: ActiveInteraction<ItemId, ColumnId>): Promise<boolean> {
    if (this.active !== active || active.pending || !this.changedColumnDestination(active))
      return false;
    const destination = active.activeDestination!;
    if (destination.kind === 'hidden-disclosure' || !active.landing) return false;
    const intent = freezeIntent({
      itemId: active.itemId,
      observedSource: { ...active.source },
      destination: {
        columnId: destination.columnId,
        position: active.landing.position,
        evidence: active.landing.evidence,
      },
      interactionEpoch: active.epoch,
    });
    active.pending = true;
    if (active.pointerId !== undefined && active.pointerCaptured) {
      this.ports.releasePointer?.(active.pointerId);
      active.pointerCaptured = false;
    }
    this.stopAutoscroll();
    this.ports.announce({ type: 'commit-pending' });
    this.publish();

    let result: BoardCommitResult<UndoAuthority>;
    try {
      result = await this.ports.commitMove(intent);
    } catch (error) {
      result = { type: 'failure', reason: errorReason(error) };
    }
    if (this.active !== active || !active.pending || this.epoch !== active.epoch) return false;

    this.active = undefined;
    if (result.type === 'success') {
      this.undoToken =
        result.settled !== false && result.undo
          ? { ...result.undo, move: intent }
          : this.publishedUndoToken;
      this.publishedUndoToken = undefined;
      this.ports.restoreFocus?.(active.itemId, destination.columnId);
      if (result.settled !== false) {
        this.ports.announce({ type: 'success' });
        if (this.undoToken) this.ports.announce({ type: 'undo-available' });
      }
    } else {
      this.publishedUndoToken = undefined;
      if (!result.announced) this.ports.announce({ type: result.type, reason: result.reason });
      this.ports.restoreFocus?.(active.itemId, active.source.columnId);
    }
    this.publish();
    return result.type === 'success';
  }

  private cancelActive(releasePointer: boolean): void {
    const active = this.active;
    if (!active) return;
    this.active = undefined;
    this.publishedUndoToken = undefined;
    this.epoch += 1;
    if (releasePointer && active.pointerId !== undefined && active.pointerCaptured) {
      this.ports.releasePointer?.(active.pointerId);
      active.pointerCaptured = false;
    }
    this.stopAutoscroll();
    if (active.picked) {
      this.ports.announce({ type: 'cancel' });
      this.ports.restoreFocus?.(active.itemId, active.source.columnId);
      this.publish();
    }
  }

  private autoscroll(point: BoardPoint, bounds: BoardRect | undefined): void {
    if (!bounds) {
      this.stopAutoscroll();
      return;
    }
    let direction: -1 | 0 | 1 = 0;
    let intensity = 0;
    if (point.x < bounds.left + this.edgeZone) {
      direction = -1;
      intensity = (bounds.left + this.edgeZone - point.x) / this.edgeZone;
    } else if (point.x > bounds.right - this.edgeZone) {
      direction = 1;
      intensity = (point.x - (bounds.right - this.edgeZone)) / this.edgeZone;
    }
    const speed =
      direction === 0
        ? 0
        : Math.min(
            this.maxAutoscrollSpeed,
            Math.max(1, Math.round(intensity * this.maxAutoscrollSpeed)),
          );
    this.ports.requestAutoscroll?.({ direction, speed });
  }

  private stopAutoscroll(): void {
    this.ports.requestAutoscroll?.({ direction: 0, speed: 0 });
  }

  private publish(): void {
    this.ports.publish(this.projection());
  }
}
