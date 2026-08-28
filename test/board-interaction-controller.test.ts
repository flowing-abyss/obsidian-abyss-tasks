import { describe, expect, it, vi } from 'vitest';
import {
  BoardInteractionController,
  type BoardAnnouncement,
  type BoardDestinationGeometry,
  type BoardGeometrySnapshot,
  type BoardInteractionPorts,
  type BoardMoveIntent,
  type BoardRenderProjection,
} from '../src/panels/projects/BoardInteractionController';

type ItemId = 'card-1' | 'card-2';
type ColumnId = 'todo' | 'doing' | 'done' | 'hidden';
type UndoAuthority = { readonly revision: string };

const rect = (left: number, right: number, top = 0, bottom = 100) => ({
  left,
  right,
  top,
  bottom,
});

function column(
  columnId: ColumnId,
  left: number,
  right: number,
  kind: 'column' | 'rail' = 'column',
  enabled = true,
): BoardDestinationGeometry<ColumnId> {
  return { kind, columnId, rect: rect(left, right), enabled };
}

function disclosure(left = 300, right = 340): BoardDestinationGeometry<ColumnId> {
  return {
    kind: 'hidden-disclosure',
    rect: rect(left, right),
    enabled: true,
    hiddenColumnIds: ['hidden'],
  };
}

function snapshot(
  destinations: readonly BoardDestinationGeometry<ColumnId>[] = [
    column('todo', 0, 100),
    column('doing', 100, 200),
    column('done', 200, 240, 'rail'),
    disclosure(),
  ],
): BoardGeometrySnapshot<ItemId, ColumnId> {
  return {
    destinations,
    items: [
      { itemId: 'card-1', columnId: 'todo', rect: rect(10, 90, 10, 50) },
      { itemId: 'card-2', columnId: 'doing', rect: rect(110, 190, 10, 50) },
    ],
    scrollContainer: { rect: rect(0, 340), scrollLeft: 0 },
  };
}

function harness(
  options: {
    snapshot?: BoardGeometrySnapshot<ItemId, ColumnId>;
    capturePointer?: boolean;
  } = {},
) {
  let geometry = options.snapshot ?? snapshot();
  let landingPosition = 2;
  let landingAvailable = true;
  const projections: BoardRenderProjection<ItemId, ColumnId>[] = [];
  const announcements: BoardAnnouncement<ItemId, ColumnId>[] = [];
  const commitMove = vi
    .fn<(intent: BoardMoveIntent<ItemId, ColumnId>) => Promise<unknown>>()
    .mockResolvedValue({ type: 'success' });
  const undoMove = vi.fn().mockResolvedValue({ type: 'success' });
  const ports: BoardInteractionPorts<ItemId, ColumnId, UndoAuthority> = {
    geometry: {
      snapshot: () => geometry,
      canonicalLanding: (_itemId, destinationColumnId) =>
        landingAvailable
          ? {
              position: landingPosition,
              evidence: `selector:${destinationColumnId}:${landingPosition}`,
              gap: { columnId: destinationColumnId, position: landingPosition },
            }
          : undefined,
    },
    commitMove: commitMove as BoardInteractionPorts<ItemId, ColumnId, UndoAuthority>['commitMove'],
    undoMove,
    publish: (projection) => projections.push(projection),
    announce: (announcement) => announcements.push(announcement),
    ...(options.capturePointer === false ? {} : { capturePointer: vi.fn() }),
    releasePointer: vi.fn(),
    requestAutoscroll: vi.fn(),
    restoreFocus: vi.fn(),
  };
  const controller = new BoardInteractionController(ports, {
    movementThreshold: 6,
    edgeZone: 40,
    maxAutoscrollSpeed: 20,
  });
  return {
    controller,
    ports,
    commitMove,
    undoMove,
    projections,
    announcements,
    setGeometry: (next: BoardGeometrySnapshot<ItemId, ColumnId>) => {
      geometry = next;
    },
    setLandingPosition: (position: number) => {
      landingPosition = position;
    },
    setLandingAvailable: (available: boolean) => {
      landingAvailable = available;
    },
  };
}

function press(h: ReturnType<typeof harness>, point = { x: 50, y: 30 }): void {
  expect(
    h.controller.pointerDown({
      pointerId: 7,
      button: 0,
      isPrimary: true,
      itemId: 'card-1',
      source: { columnId: 'todo', position: 0, evidence: 'source:0' },
      point,
      enabled: true,
    }),
  ).toBe(true);
}

function pickup(h: ReturnType<typeof harness>, point = { x: 110, y: 30 }): void {
  press(h);
  h.controller.pointerMove({ pointerId: 7, point });
}

describe('BoardInteractionController pointer state machine', () => {
  it('accepts only an enabled primary-pointer identity', () => {
    const h = harness();

    expect(
      h.controller.pointerDown({
        pointerId: 1,
        button: 1,
        isPrimary: true,
        itemId: 'card-1',
        source: { columnId: 'todo', position: 0, evidence: 'source:0' },
        point: { x: 50, y: 30 },
        enabled: true,
      }),
    ).toBe(false);
    expect(
      h.controller.pointerDown({
        pointerId: 1,
        button: 0,
        isPrimary: true,
        itemId: 'card-1',
        source: { columnId: 'todo', position: 0, evidence: 'source:0' },
        point: { x: 50, y: 30 },
        enabled: false,
      }),
    ).toBe(false);
    expect(h.controller.projection().pickedItemId).toBeUndefined();

    expect(
      h.controller.pointerDown({
        pointerId: 2,
        button: 0,
        isPrimary: false,
        itemId: 'card-1',
        source: { columnId: 'todo', position: 0, evidence: 'source:0' },
        point: { x: 50, y: 30 },
        enabled: true,
      }),
    ).toBe(false);
  });

  it('uses an inclusive threshold and treats pre-threshold release as a click', async () => {
    const h = harness();
    press(h);
    h.controller.pointerMove({ pointerId: 7, point: { x: 55, y: 30 } });
    expect(h.controller.projection().pickedItemId).toBeUndefined();

    await h.controller.pointerUp({ pointerId: 7, point: { x: 55, y: 30 } });
    expect(h.commitMove).not.toHaveBeenCalled();

    press(h);
    h.controller.pointerMove({ pointerId: 7, point: { x: 56, y: 30 } });
    expect(h.controller.projection().pickedItemId).toBe('card-1');
    expect(h.ports.capturePointer).toHaveBeenCalledWith(7);
  });

  it('publishes a source placeholder and fixed preview independent of source reflow', () => {
    const h = harness();
    pickup(h);
    const picked = h.controller.projection();

    expect(picked.sourcePlaceholder).toEqual({ itemId: 'card-1', columnId: 'todo' });
    expect(picked.preview).toEqual({
      anchor: { x: 70, y: 10 },
      offset: { x: 40, y: 20 },
    });

    const mutable = snapshot();
    h.setGeometry(mutable);
    (mutable.items[0]!.rect as { left: number }).left = 999;
    expect(h.controller.projection().preview).toEqual(picked.preview);
  });

  it('re-reads live target geometry and canonical landing after layout changes', () => {
    const h = harness();
    pickup(h, { x: 150, y: 30 });
    expect(h.controller.projection().activeDestination).toEqual({
      kind: 'column',
      columnId: 'doing',
    });
    expect(h.controller.projection().landingGap).toMatchObject({ position: 2 });

    h.setGeometry(
      snapshot([
        column('todo', 0, 50),
        column('doing', 220, 320),
        column('done', 50, 120, 'rail'),
        disclosure(120, 160),
      ]),
    );
    h.setLandingPosition(4);
    h.controller.pointerMove({ pointerId: 7, point: { x: 80, y: 30 } });

    expect(h.controller.projection().activeDestination).toEqual({
      kind: 'rail',
      columnId: 'done',
    });
    expect(h.controller.projection().landingGap).toEqual({ columnId: 'done', position: 4 });
  });

  it('documents left/top inclusive and right/bottom exclusive hit boundaries', () => {
    const h = harness();
    pickup(h, { x: 100, y: 0 });
    expect(h.controller.projection().activeDestination).toMatchObject({ columnId: 'doing' });

    h.controller.pointerMove({ pointerId: 7, point: { x: 200, y: 100 } });
    expect(h.controller.projection().activeDestination).toBeUndefined();
  });

  it('excludes hidden columns until pointer activation latches the visible disclosure', () => {
    const h = harness({
      snapshot: snapshot([column('todo', 0, 100), column('doing', 100, 200), disclosure(200, 240)]),
    });
    pickup(h, { x: 150, y: 30 });

    expect(h.controller.projection().accessibility.dropTargets).not.toContainEqual({
      kind: 'column',
      columnId: 'hidden',
      exposedFromHidden: true,
    });

    h.controller.pointerMove({ pointerId: 7, point: { x: 220, y: 30 } });

    expect(h.controller.projection().activeDestination).toEqual({ kind: 'hidden-disclosure' });
    expect(h.controller.projection().accessibility.dropTargets).toContainEqual({
      kind: 'column',
      columnId: 'hidden',
      exposedFromHidden: true,
    });
  });

  it('emits bounded horizontal autoscroll and clears it outside the edge zone', () => {
    const h = harness();
    pickup(h, { x: 2, y: 30 });
    expect(h.ports.requestAutoscroll).toHaveBeenLastCalledWith({ direction: -1, speed: 19 });

    h.controller.pointerMove({ pointerId: 7, point: { x: 339, y: 30 } });
    expect(h.ports.requestAutoscroll).toHaveBeenLastCalledWith({ direction: 1, speed: 20 });

    h.controller.pointerMove({ pointerId: 7, point: { x: 170, y: 30 } });
    expect(h.ports.requestAutoscroll).toHaveBeenLastCalledWith({ direction: 0, speed: 0 });
  });

  it('keeps autoscroll at zero on the exact edge-zone boundary', () => {
    const h = harness();
    pickup(h, { x: 40, y: 30 });
    expect(h.ports.requestAutoscroll).toHaveBeenLastCalledWith({ direction: 0, speed: 0 });

    h.controller.pointerMove({ pointerId: 7, point: { x: 300, y: 30 } });
    expect(h.ports.requestAutoscroll).toHaveBeenLastCalledWith({ direction: 0, speed: 0 });
  });

  it('commits one immutable cross-column intent and ignores duplicate release', async () => {
    const h = harness();
    let resolve!: (value: unknown) => void;
    h.commitMove.mockReturnValueOnce(new Promise((done) => (resolve = done)));
    pickup(h, { x: 150, y: 30 });

    const first = h.controller.pointerUp({ pointerId: 7, point: { x: 150, y: 30 } });
    const duplicate = h.controller.pointerUp({ pointerId: 7, point: { x: 150, y: 30 } });

    expect(h.commitMove).toHaveBeenCalledOnce();
    const intent = h.commitMove.mock.calls[0]![0] as BoardMoveIntent<ItemId, ColumnId>;
    expect(intent).toEqual({
      itemId: 'card-1',
      observedSource: { columnId: 'todo', position: 0, evidence: 'source:0' },
      destination: { columnId: 'doing', position: 2, evidence: 'selector:doing:2' },
      interactionEpoch: 1,
    });
    expect(Object.isFrozen(intent)).toBe(true);
    expect(h.controller.projection().pending).toBe(true);

    resolve({ type: 'success' });
    await Promise.all([first, duplicate]);
    expect(h.commitMove).toHaveBeenCalledOnce();
  });

  it('does not commit same-source, invalid, stale-pointer, or lost-capture releases', async () => {
    const h = harness();
    pickup(h, { x: 60, y: 30 });
    await h.controller.pointerUp({ pointerId: 99, point: { x: 150, y: 30 } });
    expect(h.controller.projection().pickedItemId).toBe('card-1');

    await h.controller.pointerUp({ pointerId: 7, point: { x: 50, y: 30 } });
    expect(h.commitMove).not.toHaveBeenCalled();

    pickup(h, { x: 150, y: 30 });
    h.controller.lostPointerCapture(7);
    await h.controller.pointerUp({ pointerId: 7, point: { x: 150, y: 30 } });
    expect(h.commitMove).not.toHaveBeenCalled();
  });

  it.each(['escape', 'pointercancel', 'lostcapture'] as const)(
    '%s clears every transient and restores source focus',
    async (kind) => {
      const h = harness();
      pickup(h, { x: 150, y: 30 });

      if (kind === 'escape') await h.controller.keyDown({ key: 'Escape' });
      else if (kind === 'pointercancel') h.controller.pointerCancel(7);
      else h.controller.lostPointerCapture(7);

      expect(h.controller.projection()).toMatchObject({ pending: false });
      expect(h.controller.projection().pickedItemId).toBeUndefined();
      expect(h.controller.projection().sourcePlaceholder).toBeUndefined();
      expect(h.controller.projection().preview).toBeUndefined();
      expect(h.controller.projection().landingGap).toBeUndefined();
      expect(h.ports.requestAutoscroll).toHaveBeenLastCalledWith({ direction: 0, speed: 0 });
      expect(h.ports.restoreFocus).toHaveBeenLastCalledWith('card-1', 'todo');
      expect(h.announcements[h.announcements.length - 1]).toMatchObject({ type: 'cancel' });
    },
  );

  it('releases pointer capture exactly once and never releases before pickup', async () => {
    const h = harness();
    press(h);
    h.controller.pointerCancel(7);
    expect(h.ports.releasePointer).not.toHaveBeenCalled();

    pickup(h, { x: 150, y: 30 });
    let resolve!: (value: unknown) => void;
    h.commitMove.mockReturnValueOnce(new Promise((done) => (resolve = done)));
    const pending = h.controller.pointerUp({ pointerId: 7, point: { x: 150, y: 30 } });
    await h.controller.keyDown({ key: 'Escape' });
    resolve({ type: 'success' });
    await pending;

    expect(h.ports.releasePointer).toHaveBeenCalledTimes(1);
  });

  it('does not release capture when no capture port was present', () => {
    const h = harness({ capturePointer: false });
    pickup(h, { x: 150, y: 30 });
    h.controller.pointerCancel(7);

    expect(h.ports.releasePointer).not.toHaveBeenCalled();
  });

  it.each(['conflict', 'failure'] as const)(
    'restores exact source focus and announces %s result',
    async (type) => {
      const h = harness();
      h.commitMove.mockResolvedValueOnce({ type, reason: `${type}-reason` });
      pickup(h, { x: 150, y: 30 });

      await h.controller.pointerUp({ pointerId: 7, point: { x: 150, y: 30 } });

      expect(h.controller.projection().pickedItemId).toBeUndefined();
      expect(h.ports.restoreFocus).toHaveBeenLastCalledWith('card-1', 'todo');
      expect(h.announcements[h.announcements.length - 1]).toEqual({
        type,
        reason: `${type}-reason`,
      });
    },
  );

  it('normalizes a thrown commit callback to failure', async () => {
    const h = harness();
    h.commitMove.mockRejectedValueOnce(new Error('offline'));
    pickup(h, { x: 150, y: 30 });

    await h.controller.pointerUp({ pointerId: 7, point: { x: 150, y: 30 } });

    expect(h.announcements[h.announcements.length - 1]).toEqual({
      type: 'failure',
      reason: 'offline',
    });
    expect(h.ports.restoreFocus).toHaveBeenLastCalledWith('card-1', 'todo');
  });

  it('ignores a stale async result after cancel and a newer pickup', async () => {
    const h = harness();
    let resolve!: (value: unknown) => void;
    h.commitMove.mockReturnValueOnce(new Promise((done) => (resolve = done)));
    pickup(h, { x: 150, y: 30 });
    const oldCommit = h.controller.pointerUp({ pointerId: 7, point: { x: 150, y: 30 } });
    await h.controller.keyDown({ key: 'Escape' });

    expect(
      h.controller.pointerDown({
        pointerId: 8,
        button: 0,
        isPrimary: true,
        itemId: 'card-2',
        source: { columnId: 'doing', position: 0, evidence: 'source:0' },
        point: { x: 150, y: 30 },
        enabled: true,
      }),
    ).toBe(true);
    resolve({ type: 'success', undo: { authority: { revision: 'old' }, evidence: 'old' } });
    await oldCommit;

    expect(h.controller.projection().pending).toBe(false);
    expect(h.announcements).not.toContainEqual({ type: 'undo-available' });
  });
});

describe('BoardInteractionController keyboard and fallback', () => {
  it('uses Space pickup/drop and traverses reachable columns, rails, and disclosure', async () => {
    const h = harness();
    await h.controller.keyDown({
      key: ' ',
      itemId: 'card-1',
      source: { columnId: 'todo', position: 0, evidence: 'source:0' },
      enabled: true,
    });
    expect(h.controller.projection().pickedItemId).toBe('card-1');

    await h.controller.keyDown({ key: 'ArrowRight' });
    expect(h.controller.projection().activeDestination).toMatchObject({ columnId: 'doing' });
    await h.controller.keyDown({ key: 'End' });
    expect(h.controller.projection().activeDestination).toEqual({ kind: 'hidden-disclosure' });
    await h.controller.keyDown({ key: 'Home' });
    expect(h.controller.projection().activeDestination).toMatchObject({ columnId: 'todo' });
    await h.controller.keyDown({ key: 'ArrowLeft' });
    expect(h.controller.projection().activeDestination).toMatchObject({ columnId: 'todo' });

    await h.controller.keyDown({ key: 'ArrowRight' });
    await h.controller.keyDown({ key: ' ' });
    expect(h.commitMove).toHaveBeenCalledOnce();
  });

  it('skips disabled destinations and omits Up/Down manual insertion', async () => {
    const h = harness({
      snapshot: snapshot([
        column('todo', 0, 100),
        column('doing', 100, 200, 'column', false),
        column('done', 200, 240, 'rail'),
      ]),
    });
    await h.controller.keyDown({
      key: ' ',
      itemId: 'card-1',
      source: { columnId: 'todo', position: 0, evidence: 'source:0' },
      enabled: true,
    });

    expect(await h.controller.keyDown({ key: 'ArrowRight' })).toBe(true);
    expect(h.controller.projection().activeDestination).toMatchObject({ columnId: 'done' });
    expect(await h.controller.keyDown({ key: 'ArrowDown' })).toBe(false);
    expect(await h.controller.keyDown({ key: 'ArrowUp' })).toBe(false);
    expect(h.controller.projection().activeDestination).toMatchObject({ columnId: 'done' });
  });

  it('expands disclosure into explicit hidden destinations before they become reachable', async () => {
    const h = harness();
    await h.controller.keyDown({
      key: ' ',
      itemId: 'card-1',
      source: { columnId: 'todo', position: 0, evidence: 'source:0' },
      enabled: true,
    });
    await h.controller.keyDown({ key: 'End' });

    expect(h.controller.projection().accessibility.dropTargets).not.toContainEqual({
      kind: 'column',
      columnId: 'hidden',
    });
    await h.controller.keyDown({ key: ' ' });
    expect(h.controller.projection().accessibility.dropTargets).toContainEqual({
      kind: 'column',
      columnId: 'hidden',
      exposedFromHidden: true,
    });
    expect(h.commitMove).not.toHaveBeenCalled();

    await h.controller.keyDown({ key: 'End' });
    await h.controller.keyDown({ key: ' ' });
    expect(h.commitMove.mock.calls[0]![0]).toMatchObject({
      destination: { columnId: 'hidden' },
    });
  });

  it('keeps hidden disclosure metadata paired after disabled destinations are skipped', async () => {
    const h = harness({
      snapshot: snapshot([
        column('todo', 0, 100),
        column('doing', 100, 200, 'column', false),
        disclosure(200, 240),
      ]),
    });
    await h.controller.keyDown({
      key: ' ',
      itemId: 'card-1',
      source: { columnId: 'todo', position: 0, evidence: 'source:0' },
      enabled: true,
    });
    await h.controller.keyDown({ key: 'End' });
    await h.controller.keyDown({ key: ' ' });

    expect(h.controller.projection().accessibility.dropTargets).toContainEqual({
      kind: 'column',
      columnId: 'hidden',
      exposedFromHidden: true,
    });
  });

  it('deduplicates unchanged destination announcements', async () => {
    const h = harness();
    await h.controller.keyDown({
      key: ' ',
      itemId: 'card-1',
      source: { columnId: 'todo', position: 0, evidence: 'source:0' },
      enabled: true,
    });
    await h.controller.keyDown({ key: 'ArrowLeft' });
    await h.controller.keyDown({ key: 'ArrowLeft' });

    expect(h.announcements.filter(({ type }) => type === 'destination')).toHaveLength(1);
  });

  it('announces the same destination again after leaving and re-entering it', () => {
    const h = harness();
    pickup(h, { x: 150, y: 30 });
    h.controller.pointerMove({ pointerId: 7, point: { x: 250, y: 150 } });
    h.controller.pointerMove({ pointerId: 7, point: { x: 150, y: 30 } });

    expect(h.announcements.filter(({ type }) => type === 'destination')).toHaveLength(2);
  });

  it('re-announces a destination after canonical landing temporarily disappears', () => {
    const h = harness();
    pickup(h, { x: 150, y: 30 });
    h.setLandingAvailable(false);
    h.controller.pointerMove({ pointerId: 7, point: { x: 150, y: 30 } });
    expect(h.controller.projection().activeDestination).toBeUndefined();
    h.setLandingAvailable(true);
    h.controller.pointerMove({ pointerId: 7, point: { x: 150, y: 30 } });

    expect(h.announcements.filter(({ type }) => type === 'destination')).toHaveLength(2);
  });

  it('revalidates live keyboard geometry and landing immediately before drop', async () => {
    const h = harness();
    await h.controller.keyDown({
      key: ' ',
      itemId: 'card-1',
      source: { columnId: 'todo', position: 0, evidence: 'source:0' },
      enabled: true,
    });
    await h.controller.keyDown({ key: 'ArrowRight' });
    h.setLandingPosition(5);

    await h.controller.keyDown({ key: ' ' });

    expect(h.commitMove.mock.calls[0]![0]).toMatchObject({
      destination: { columnId: 'doing', position: 5, evidence: 'selector:doing:5' },
    });
  });

  it('does not keyboard-commit a destination disabled before drop', async () => {
    const h = harness();
    await h.controller.keyDown({
      key: ' ',
      itemId: 'card-1',
      source: { columnId: 'todo', position: 0, evidence: 'source:0' },
      enabled: true,
    });
    await h.controller.keyDown({ key: 'ArrowRight' });
    h.setGeometry(
      snapshot([
        column('todo', 0, 100),
        column('doing', 100, 200, 'column', false),
        column('done', 200, 240, 'rail'),
      ]),
    );

    await h.controller.keyDown({ key: ' ' });

    expect(h.commitMove).not.toHaveBeenCalled();
    expect(h.controller.projection().pickedItemId).toBeUndefined();
    expect(h.ports.restoreFocus).toHaveBeenLastCalledWith('card-1', 'todo');
  });

  it('menu/touch fallback uses the same move intent and pending lock', async () => {
    const h = harness();
    let resolve!: (value: unknown) => void;
    h.commitMove.mockReturnValueOnce(new Promise((done) => (resolve = done)));
    const first = h.controller.requestMove({
      itemId: 'card-1',
      source: { columnId: 'todo', position: 0, evidence: 'source:0' },
      destinationColumnId: 'doing',
      enabled: true,
    });
    const second = await h.controller.requestMove({
      itemId: 'card-2',
      source: { columnId: 'doing', position: 0, evidence: 'source:0' },
      destinationColumnId: 'done',
      enabled: true,
    });

    expect(second).toBe(false);
    expect(h.commitMove).toHaveBeenCalledOnce();
    resolve({ type: 'success' });
    await first;
  });
});

describe('BoardInteractionController conditional Undo', () => {
  async function successfulMove(h: ReturnType<typeof harness>, revision = 'r1'): Promise<void> {
    h.commitMove.mockResolvedValueOnce({
      type: 'success',
      undo: { authority: { revision }, evidence: `undo:${revision}` },
    });
    await h.controller.requestMove({
      itemId: 'card-1',
      source: { columnId: 'todo', position: 0, evidence: 'source:0' },
      destinationColumnId: 'doing',
      enabled: true,
    });
  }

  it('offers explicit conditional Undo once and consumes it on success', async () => {
    const h = harness();
    await successfulMove(h);

    expect(h.controller.projection().accessibility.undoAvailable).toBe(true);
    expect(h.announcements[h.announcements.length - 1]).toEqual({
      type: 'undo-available',
    });
    expect(await h.controller.undo()).toBe(true);
    expect(h.undoMove).toHaveBeenCalledWith({
      authority: { revision: 'r1' },
      evidence: 'undo:r1',
      move: expect.objectContaining({ itemId: 'card-1' }),
      operationEpoch: expect.any(Number),
    });
    expect(await h.controller.undo()).toBe(false);
  });

  it('keeps committed state visible when conditional Undo is refused', async () => {
    const h = harness();
    await successfulMove(h);
    h.undoMove.mockResolvedValueOnce({ type: 'conflict', reason: 'external-change' });

    await h.controller.undo();

    expect(h.announcements[h.announcements.length - 1]).toEqual({
      type: 'undo-conflict',
      reason: 'external-change',
    });
    expect(h.ports.restoreFocus).not.toHaveBeenCalledWith('card-1', 'todo');
  });

  it('retires stale Undo only after a newer successful move', async () => {
    const h = harness();
    await successfulMove(h, 'old');

    await h.controller.requestMove({
      itemId: 'card-1',
      source: { columnId: 'doing', position: 2, evidence: 'selector:doing:2' },
      destinationColumnId: 'doing',
      enabled: true,
    });
    expect(h.controller.projection().accessibility.undoAvailable).toBe(true);

    h.commitMove.mockResolvedValueOnce({ type: 'conflict', reason: 'changed' });
    await h.controller.requestMove({
      itemId: 'card-1',
      source: { columnId: 'doing', position: 2, evidence: 'selector:doing:2' },
      destinationColumnId: 'done',
      enabled: true,
    });
    expect(h.controller.projection().accessibility.undoAvailable).toBe(true);

    h.commitMove.mockResolvedValueOnce({ type: 'success' });
    await h.controller.requestMove({
      itemId: 'card-1',
      source: { columnId: 'doing', position: 2, evidence: 'selector:doing:2' },
      destinationColumnId: 'done',
      enabled: true,
    });
    expect(h.controller.projection().accessibility.undoAvailable).toBe(false);
  });

  it('disables Undo while an interaction is active or pending', async () => {
    const h = harness();
    await successfulMove(h);
    press(h);
    expect(await h.controller.undo()).toBe(false);
    expect(h.undoMove).not.toHaveBeenCalled();
  });

  it('lets the mutation port explicitly invalidate a stale Undo token', async () => {
    const h = harness();
    await successfulMove(h);

    expect(h.controller.invalidateUndo()).toBe(true);
    expect(h.controller.projection().accessibility.undoAvailable).toBe(false);
    expect(h.controller.invalidateUndo()).toBe(false);
    expect(await h.controller.undo()).toBe(false);
  });
});
