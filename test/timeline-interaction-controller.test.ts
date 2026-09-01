import { describe, expect, it, vi } from 'vitest';
import {
  TimelineInteractionController,
  timelineKeyboardUnitDays,
  type TimelineAnnouncement,
  type TimelineCommitIntent,
  type TimelineInteractionPorts,
  type TimelineInteractionTarget,
  type TimelineProjection,
  type TimelineSemanticIntent,
} from '../src/panels/projects/TimelineInteractionController';
import { parseProjectDate } from '../src/projects/projectDates';

type ItemId = 'project-1' | 'point-1' | 'milestone-1';

const date = (raw: string) => {
  const parsed = parseProjectDate(raw);
  if (!parsed) throw new Error(`Invalid test date: ${raw}`);
  return parsed;
};

const rangeMove = (start = '2026-03-07T09:10:11.123-05:00', end = '2026-03-09T18:20:21Z') =>
  ({
    kind: 'range-move',
    itemId: 'project-1',
    carrier: { start: date(start), end: date(end) },
  }) as const satisfies TimelineInteractionTarget<ItemId>;

const startEdge = (start = '2026-03-07', end = '2026-03-09') =>
  ({
    kind: 'start-edge',
    itemId: 'project-1',
    carrier: { start: date(start), end: date(end) },
  }) as const satisfies TimelineInteractionTarget<ItemId>;

const endEdge = (start = '2026-03-07', end = '2026-03-09') =>
  ({
    kind: 'end-edge',
    itemId: 'project-1',
    carrier: { start: date(start), end: date(end) },
  }) as const satisfies TimelineInteractionTarget<ItemId>;

const point = (raw = '2026-10-31T23:59:58.987654+07:00') =>
  ({
    kind: 'point-move',
    itemId: 'point-1',
    role: 'scheduled',
    carrier: { at: date(raw) },
  }) as const satisfies TimelineInteractionTarget<ItemId>;

const milestone = (raw = '2026-12-30') =>
  ({
    kind: 'milestone-move',
    itemId: 'milestone-1',
    role: 'milestone',
    carrier: { at: date(raw) },
  }) as const satisfies TimelineInteractionTarget<ItemId>;

const identity = (width = 240) =>
  ({ kind: 'identity-column', width }) as const satisfies TimelineInteractionTarget<ItemId>;

function harness() {
  let geometry = {
    pixelsPerDay: 10,
    scrollLeft: 100,
    maxScrollLeft: 500,
    scrollBounds: { left: 0, right: 300 },
  };
  const projections: TimelineProjection<ItemId>[] = [];
  const announcements: TimelineAnnouncement<ItemId>[] = [];
  const semanticIntents: TimelineSemanticIntent<ItemId>[] = [];
  const commit = vi
    .fn<(intent: TimelineCommitIntent<ItemId>) => Promise<unknown>>()
    .mockResolvedValue({ type: 'success' });
  const ports: TimelineInteractionPorts<ItemId> = {
    geometry: { snapshot: () => geometry },
    commit: commit as TimelineInteractionPorts<ItemId>['commit'],
    publish: (projection) => projections.push(projection),
    announce: (announcement) => announcements.push(announcement),
    emit: (intent) => semanticIntents.push(intent),
    capturePointer: vi.fn(),
    releasePointer: vi.fn(),
    requestAutoscroll: vi.fn(),
    restoreFocus: vi.fn(),
  };
  const controller = new TimelineInteractionController(ports, {
    movementThreshold: 6,
    edgeZone: 40,
    maxAutoscrollSpeed: 20,
    identityKeyboardStep: 8,
    identityKeyboardLargeStep: 32,
  });
  return {
    controller,
    ports,
    commit,
    projections,
    announcements,
    semanticIntents,
    setGeometry: (changes: Partial<typeof geometry>) => {
      geometry = { ...geometry, ...changes };
    },
  };
}

function press(
  h: ReturnType<typeof harness>,
  target: TimelineInteractionTarget<ItemId> = rangeMove(),
  point = { x: 100, y: 20 },
) {
  return h.controller.pointerDown({
    pointerId: 7,
    button: 0,
    isPrimary: true,
    enabled: true,
    point,
    target,
  });
}

function pickup(
  h: ReturnType<typeof harness>,
  target: TimelineInteractionTarget<ItemId> = rangeMove(),
  point = { x: 106, y: 20 },
) {
  expect(press(h, target)).toBe(true);
  expect(h.controller.pointerMove({ pointerId: 7, point })).toBe(true);
}

describe('TimelineInteractionController pointer date editing', () => {
  it('accepts only enabled primary-button input and uses an inclusive pickup threshold', async () => {
    const h = harness();
    for (const rejected of [
      { button: 1, isPrimary: true, enabled: true },
      { button: 0, isPrimary: false, enabled: true },
      { button: 0, isPrimary: true, enabled: false },
    ]) {
      expect(
        h.controller.pointerDown({
          pointerId: 7,
          point: { x: 100, y: 20 },
          target: rangeMove(),
          ...rejected,
        }),
      ).toBe(false);
    }

    expect(press(h)).toBe(true);
    h.controller.pointerMove({ pointerId: 7, point: { x: 105, y: 20 } });
    expect(h.controller.projection().accessibility.grabbed).toBe(false);
    expect(await h.controller.pointerUp({ pointerId: 7, point: { x: 105, y: 20 } })).toBe(false);
    expect(h.commit).not.toHaveBeenCalled();

    pickup(h);
    expect(h.controller.projection().accessibility.grabbed).toBe(true);
    expect(h.ports.capturePointer).toHaveBeenCalledOnce();
  });

  it('moves a whole range from the frozen original with deterministic whole-day snapping', () => {
    const h = harness();
    pickup(h, rangeMove(), { x: 115, y: 20 });
    expect(h.controller.projection()).toMatchObject({
      activeTarget: 'range-move',
      dayDelta: 2,
      validity: { valid: true },
      previewGeometry: {
        kind: 'range',
        start: '2026-03-09T09:10:11.123-05:00',
        end: '2026-03-11T18:20:21Z',
      },
      accessibility: { ownedRole: 'range', editorAvailable: true },
    });

    h.controller.pointerMove({ pointerId: 7, point: { x: 125, y: 20 } });
    expect(h.controller.projection().dayDelta).toBe(3);
    expect(h.controller.projection().draftCarrier).toMatchObject({
      start: { raw: '2026-03-10T09:10:11.123-05:00' },
      end: { raw: '2026-03-12T18:20:21Z' },
    });
  });

  it('re-reads live pixels and scroll offset after resize/autoscroll without cumulative drift', () => {
    const h = harness();
    pickup(h, point('2026-03-07'), { x: 110, y: 20 });
    expect(h.controller.projection().dayDelta).toBe(1);

    h.setGeometry({ pixelsPerDay: 20, scrollLeft: 140 });
    h.controller.pointerMove({ pointerId: 7, point: { x: 100, y: 20 } });
    expect(h.controller.projection().dayDelta).toBe(2);
    expect(h.controller.projection().draftCarrier).toMatchObject({
      at: { raw: '2026-03-09' },
    });

    h.setGeometry({ scrollLeft: 100 });
    h.controller.pointerMove({ pointerId: 7, point: { x: 100, y: 20 } });
    expect(h.controller.projection().draftCarrier).toMatchObject({
      at: { raw: '2026-03-07' },
    });
  });

  it('changes only the owned start or end endpoint and marks reversed previews invalid', () => {
    const startHarness = harness();
    pickup(startHarness, startEdge(), { x: 120, y: 20 });
    expect(startHarness.controller.projection().draftCarrier).toMatchObject({
      start: { raw: '2026-03-09' },
      end: { raw: '2026-03-09' },
    });
    startHarness.controller.pointerMove({ pointerId: 7, point: { x: 130, y: 20 } });
    expect(startHarness.controller.projection()).toMatchObject({
      validity: { valid: false, reason: 'reversed' },
      draftCarrier: { start: { raw: '2026-03-10' }, end: { raw: '2026-03-09' } },
    });

    const endHarness = harness();
    pickup(endHarness, endEdge(), { x: 80, y: 20 });
    expect(endHarness.controller.projection()).toMatchObject({
      draftCarrier: { start: { raw: '2026-03-07' }, end: { raw: '2026-03-07' } },
      accessibility: { ownedRole: 'end' },
    });
    endHarness.controller.pointerMove({ pointerId: 7, point: { x: 70, y: 20 } });
    expect(endHarness.controller.projection().validity).toEqual({
      valid: false,
      reason: 'reversed',
    });
  });

  it.each([
    ['point', point(), '2026-11-02T23:59:58.987654+07:00', 'scheduled'],
    ['milestone', milestone(), '2027-01-01', 'milestone'],
  ] as const)(
    'moves an exact %s carrier and preserves its owned role',
    (_name, target, want, role) => {
      const h = harness();
      pickup(h, target, { x: 120, y: 20 });
      expect(h.controller.projection()).toMatchObject({
        dayDelta: 2,
        draftCarrier: { at: { raw: want } },
        accessibility: { ownedRole: role },
      });
    },
  );

  it('preserves DST-adjacent duration, offset spelling, precision, fraction, and Z suffix', () => {
    const h = harness();
    pickup(h, rangeMove(), { x: 120, y: 20 });
    const draft = h.controller.projection().draftCarrier;
    expect(draft).toEqual({
      start: date('2026-03-09T09:10:11.123-05:00'),
      end: date('2026-03-11T18:20:21Z'),
    });
    expect(h.controller.projection().originalCarrier).toEqual({
      start: date('2026-03-07T09:10:11.123-05:00'),
      end: date('2026-03-09T18:20:21Z'),
    });
  });

  it('bounds edge autoscroll, zeros it at/outside zones and scroll boundaries', () => {
    const h = harness();
    pickup(h, rangeMove(), { x: 1, y: 20 });
    expect(h.ports.requestAutoscroll).toHaveBeenLastCalledWith({ direction: -1, speed: 20 });
    h.controller.pointerMove({ pointerId: 7, point: { x: 40, y: 20 } });
    expect(h.ports.requestAutoscroll).toHaveBeenLastCalledWith({ direction: 0, speed: 0 });
    h.controller.pointerMove({ pointerId: 7, point: { x: 299, y: 20 } });
    expect(h.ports.requestAutoscroll).toHaveBeenLastCalledWith({ direction: 1, speed: 20 });

    h.setGeometry({ scrollLeft: 500 });
    h.controller.pointerMove({ pointerId: 7, point: { x: 320, y: 20 } });
    expect(h.ports.requestAutoscroll).toHaveBeenLastCalledWith({ direction: 0, speed: 0 });
    h.setGeometry({ scrollLeft: 0 });
    h.controller.pointerMove({ pointerId: 7, point: { x: -20, y: 20 } });
    expect(h.ports.requestAutoscroll).toHaveBeenLastCalledWith({ direction: 0, speed: 0 });
  });
});

describe('TimelineInteractionController commit and cleanup authority', () => {
  it.each([
    ['whole range', rangeMove(), 'range'],
    ['start edge', startEdge(), 'start'],
    ['end edge', endEdge(), 'end'],
    ['point', point('2026-03-07'), 'scheduled'],
  ] as const)(
    'keeps the exact deferred %s draft pending and settles its one frozen commit',
    async (_name, target, role) => {
      const h = harness();
      let resolve!: (value: { readonly type: 'success' }) => void;
      h.commit.mockReturnValueOnce(new Promise((done) => (resolve = done)));
      pickup(h, target, { x: 110, y: 20 });
      const drafted = h.controller.projection().draftCarrier;

      const release = h.controller.pointerUp({ pointerId: 7, point: { x: 110, y: 20 } });

      expect(h.controller.projection()).toMatchObject({
        pending: true,
        draftCarrier: drafted,
        accessibility: { ownedRole: role },
      });
      expect(h.commit).toHaveBeenCalledOnce();
      expect(Object.isFrozen(h.commit.mock.calls[0]![0])).toBe(true);
      expect(h.ports.requestAutoscroll).toHaveBeenLastCalledWith({ direction: 0, speed: 0 });

      resolve({ type: 'success' });
      await release;
      expect(h.commit).toHaveBeenCalledOnce();
      expect(h.announcements.filter(({ type }) => type === 'success')).toHaveLength(1);
    },
  );

  it('stops horizontal autoscroll while its deferred drop is pending', async () => {
    const h = harness();
    let resolve!: (value: { readonly type: 'success' }) => void;
    h.commit.mockReturnValueOnce(new Promise((done) => (resolve = done)));
    pickup(h, rangeMove(), { x: 299, y: 20 });
    expect(h.ports.requestAutoscroll).toHaveBeenLastCalledWith({ direction: 1, speed: 20 });

    const release = h.controller.pointerUp({ pointerId: 7, point: { x: 299, y: 20 } });

    expect(h.ports.requestAutoscroll).toHaveBeenLastCalledWith({ direction: 0, speed: 0 });
    expect(h.controller.projection().pending).toBe(true);
    resolve({ type: 'success' });
    await release;
  });

  it('commits one deeply frozen intent and ignores duplicate release', async () => {
    const h = harness();
    let resolve!: (value: unknown) => void;
    h.commit.mockReturnValueOnce(new Promise((done) => (resolve = done)));
    pickup(h, rangeMove(), { x: 120, y: 20 });

    const first = h.controller.pointerUp({ pointerId: 7, point: { x: 120, y: 20 } });
    const duplicate = h.controller.pointerUp({ pointerId: 7, point: { x: 120, y: 20 } });
    expect(h.commit).toHaveBeenCalledOnce();
    const intent = h.commit.mock.calls[0]![0];
    expect(intent).toMatchObject({ type: 'date-change', target: 'range-move', dayDelta: 2 });
    expect(Object.isFrozen(intent)).toBe(true);
    expect(Object.isFrozen(intent.original)).toBe(true);
    expect(Object.isFrozen(intent.draft)).toBe(true);
    expect(h.controller.projection().pending).toBe(true);
    expect(h.ports.releasePointer).toHaveBeenCalledTimes(1);

    resolve({ type: 'success' });
    await Promise.all([first, duplicate]);
    expect(h.commit).toHaveBeenCalledOnce();
    expect(h.ports.restoreFocus).toHaveBeenLastCalledWith('project-1', 'range');
  });

  it.each([
    ['synchronous', 'success', undefined, true],
    ['synchronous', 'conflict', 'changed', false],
    ['synchronous', 'failure', 'offline', false],
    ['asynchronous', 'success', undefined, true],
    ['asynchronous', 'conflict', 'changed', false],
    ['asynchronous', 'failure', 'offline', false],
  ] as const)(
    'does not treat %s expected release capture loss as cancellation after %s',
    async (delivery, type, reason, expectedResult) => {
      const h = harness();
      vi.mocked(h.ports.releasePointer!).mockImplementation((pointerId) => {
        if (delivery === 'synchronous') h.controller.lostPointerCapture(pointerId);
        else queueMicrotask(() => h.controller.lostPointerCapture(pointerId));
      });
      h.commit.mockResolvedValueOnce({ type, ...(reason !== undefined && { reason }) });
      pickup(h, rangeMove(), { x: 120, y: 20 });

      const result = await h.controller.pointerUp({ pointerId: 7, point: { x: 120, y: 20 } });

      expect(result).toBe(expectedResult);
      expect(h.commit).toHaveBeenCalledOnce();
      expect(h.ports.releasePointer).toHaveBeenCalledOnce();
      expect(h.announcements.filter((announcement) => announcement.type === 'cancel')).toEqual([]);
      expect(h.announcements.filter((announcement) => announcement.type === type)).toHaveLength(1);
      expect(h.announcements[h.announcements.length - 1]).toEqual(
        reason === undefined ? { type } : { type, reason },
      );
      expect(h.ports.restoreFocus).toHaveBeenCalledOnce();
      expect(h.ports.restoreFocus).toHaveBeenLastCalledWith('project-1', 'range');
      expect(h.controller.projection()).toEqual({
        pending: false,
        accessibility: { grabbed: false, editorAvailable: false },
      });
    },
  );

  it.each(['pointerCancel', 'lostPointerCapture', 'Escape', 'disable', 'destroy'] as const)(
    '%s restores the exact original state/focus and clears all transient state',
    async (terminal) => {
      const h = harness();
      pickup(h, rangeMove(), { x: 120, y: 20 });
      if (terminal === 'pointerCancel') h.controller.pointerCancel(7);
      else if (terminal === 'lostPointerCapture') h.controller.lostPointerCapture(7);
      else if (terminal === 'Escape') await h.controller.keyDown({ key: 'Escape' });
      else if (terminal === 'disable') h.controller.setEnabled(false);
      else h.controller.destroy();

      expect(h.controller.projection()).toEqual({
        pending: false,
        accessibility: { grabbed: false, editorAvailable: false },
      });
      expect(h.ports.requestAutoscroll).toHaveBeenLastCalledWith({ direction: 0, speed: 0 });
      expect(h.ports.restoreFocus).toHaveBeenLastCalledWith('project-1', 'range');
      expect(h.announcements[h.announcements.length - 1]).toMatchObject({ type: 'cancel' });
    },
  );

  it('captures only after pickup and releases exactly once across terminal races', async () => {
    const h = harness();
    press(h);
    h.controller.pointerCancel(7);
    expect(h.ports.releasePointer).not.toHaveBeenCalled();

    pickup(h);
    h.controller.pointerCancel(7);
    h.controller.lostPointerCapture(7);
    h.controller.destroy();
    expect(h.ports.capturePointer).toHaveBeenCalledOnce();
    expect(h.ports.releasePointer).toHaveBeenCalledOnce();
  });

  it.each(['conflict', 'failure'] as const)(
    'restores and explicitly announces %s',
    async (type) => {
      const h = harness();
      h.commit.mockResolvedValueOnce({ type, reason: `${type}-reason` });
      pickup(h, point('2026-03-07'), { x: 120, y: 20 });
      expect(await h.controller.pointerUp({ pointerId: 7, point: { x: 120, y: 20 } })).toBe(false);
      expect(h.controller.projection().activeTarget).toBeUndefined();
      expect(h.announcements[h.announcements.length - 1]).toEqual({
        type,
        reason: `${type}-reason`,
      });
      expect(h.ports.restoreFocus).toHaveBeenLastCalledWith('point-1', 'scheduled');
    },
  );

  it('normalizes thrown commits to failure and exact restoration', async () => {
    const h = harness();
    h.commit.mockRejectedValueOnce(new Error('offline'));
    pickup(h, milestone(), { x: 120, y: 20 });
    await h.controller.pointerUp({ pointerId: 7, point: { x: 120, y: 20 } });
    expect(h.announcements[h.announcements.length - 1]).toEqual({
      type: 'failure',
      reason: 'offline',
    });
    expect(h.ports.restoreFocus).toHaveBeenLastCalledWith('milestone-1', 'milestone');
  });

  it('suppresses stale async results after cancel and a newer interaction', async () => {
    const h = harness();
    let resolve!: (value: unknown) => void;
    h.commit.mockReturnValueOnce(new Promise((done) => (resolve = done)));
    pickup(h, rangeMove(), { x: 120, y: 20 });
    const old = h.controller.pointerUp({ pointerId: 7, point: { x: 120, y: 20 } });
    await h.controller.keyDown({ key: 'Escape' });
    await h.controller.keyDown({ key: 'ArrowRight', target: point('2026-05-01'), enabled: true });

    resolve({ type: 'success' });
    await old;
    expect(h.controller.projection()).toMatchObject({
      activeTarget: 'point-move',
      draftCarrier: { at: { raw: '2026-05-02' } },
    });
    expect(h.announcements.filter(({ type }) => type === 'success')).toHaveLength(0);
  });

  it('does not commit an invalid reversed draft', async () => {
    const h = harness();
    pickup(h, startEdge(), { x: 130, y: 20 });
    expect(await h.controller.pointerUp({ pointerId: 7, point: { x: 130, y: 20 } })).toBe(false);
    expect(h.commit).not.toHaveBeenCalled();
    expect(h.announcements[h.announcements.length - 1]).toEqual({
      type: 'cancel',
      reason: 'reversed',
    });
  });
});

describe('TimelineInteractionController keyboard date editing', () => {
  it.each([
    ['portfolio', 'day', 1],
    ['portfolio', 'week', 7],
    ['portfolio', 'month', 30],
    ['portfolio', 'quarter', 91],
    ['portfolio', 'year', 365],
    ['tasks', 'day', 1],
    ['tasks', 'week', 7],
    ['tasks', 'month', 30],
    ['tasks', 'quarter', 91],
    ['tasks', 'year', 365],
    ['workNotes', 'day', 1],
    ['workNotes', 'week', 7],
    ['workNotes', 'month', 30],
    ['workNotes', 'quarter', 91],
    ['workNotes', 'year', 365],
  ] as const)('maps %s %s Shift+Arrow to its pure visible-scale unit', (scope, scale, days) => {
    expect(timelineKeyboardUnitDays(scope, scale)).toBe(days);
  });

  it('Arrow and Shift+Arrow pick up a bar, draft from original, and deduplicate destinations', async () => {
    const h = harness();
    await h.controller.keyDown({
      key: 'ArrowRight',
      target: rangeMove('2026-01-01', '2026-01-03'),
      enabled: true,
      scope: 'portfolio',
      scale: 'month',
    });
    expect(h.controller.projection()).toMatchObject({
      dayDelta: 1,
      draftCarrier: { start: { raw: '2026-01-02' }, end: { raw: '2026-01-04' } },
    });
    await h.controller.keyDown({
      key: 'ArrowRight',
      shiftKey: true,
      scope: 'portfolio',
      scale: 'month',
    });
    expect(h.controller.projection()).toMatchObject({
      dayDelta: 31,
      draftCarrier: { start: { raw: '2026-02-01' }, end: { raw: '2026-02-03' } },
    });
    expect(h.announcements.filter(({ type }) => type === 'pickup')).toHaveLength(1);
    expect(h.announcements.filter(({ type }) => type === 'destination')).toHaveLength(2);
  });

  it.each(['ArrowLeft', 'ArrowRight', 'Enter'] as const)(
    'does not let %s alter or commit an active pointer interaction',
    async (key) => {
      const h = harness();
      pickup(h, rangeMove('2026-01-01', '2026-01-03'), { x: 120, y: 20 });
      const before = h.controller.projection();
      const announcementCount = h.announcements.length;
      const publicationCount = h.projections.length;

      expect(await h.controller.keyDown({ key })).toBe(false);

      expect(h.controller.projection()).toEqual(before);
      expect(h.commit).not.toHaveBeenCalled();
      expect(h.announcements).toHaveLength(announcementCount);
      expect(h.projections).toHaveLength(publicationCount);
    },
  );

  it.each([
    ['missing scope', undefined, undefined],
    ['missing scale', 'tasks', undefined],
    ['missing scope for scale', undefined, 'week'],
    ['mismatched scale', 'tasks', 'century' as never],
  ] as const)(
    'rejects Shift+Arrow with %s before creating keyboard interaction state',
    async (_case, scope, scale) => {
      const h = harness();

      expect(
        await h.controller.keyDown({
          key: 'ArrowRight',
          shiftKey: true,
          target: point('2026-05-01'),
          enabled: true,
          ...(scope !== undefined && { scope }),
          ...(scale !== undefined && { scale }),
        }),
      ).toBe(false);

      expect(h.controller.projection()).toEqual({
        pending: false,
        accessibility: { grabbed: false, editorAvailable: false },
      });
      expect(h.announcements).toEqual([]);
      expect(h.projections).toEqual([]);
      expect(h.commit).not.toHaveBeenCalled();

      expect(press(h, point('2026-05-01'))).toBe(true);
      expect(h.controller.pointerCancel(7)).toBe(true);
      expect(
        await h.controller.keyDown({
          key: 'Enter',
          target: point('2026-05-01'),
          enabled: true,
        }),
      ).toBe(true);
      expect(h.semanticIntents).toHaveLength(1);
    },
  );

  it('keyboard edges own only one endpoint and Escape restores original focus', async () => {
    const h = harness();
    await h.controller.keyDown({ key: 'ArrowLeft', target: endEdge(), enabled: true });
    expect(h.controller.projection().draftCarrier).toEqual({
      start: date('2026-03-07'),
      end: date('2026-03-08'),
    });
    await h.controller.keyDown({ key: 'Escape' });
    expect(h.controller.projection().activeTarget).toBeUndefined();
    expect(h.ports.restoreFocus).toHaveBeenLastCalledWith('project-1', 'end');
  });

  it('Enter commits a current valid draft exactly once despite duplicate Enter', async () => {
    const h = harness();
    let resolve!: (value: unknown) => void;
    h.commit.mockReturnValueOnce(new Promise((done) => (resolve = done)));
    await h.controller.keyDown({ key: 'ArrowRight', target: point('2026-04-01'), enabled: true });
    const first = h.controller.keyDown({ key: 'Enter' });
    const duplicate = h.controller.keyDown({ key: 'Enter' });
    expect(h.commit).toHaveBeenCalledOnce();
    expect(h.announcements).toContainEqual({ type: 'commit-pending' });
    resolve({ type: 'success' });
    await Promise.all([first, duplicate]);
    expect(h.commit).toHaveBeenCalledOnce();
  });

  it('idle Enter emits a frozen open-date-editor intent for the exact owned carrier', async () => {
    const h = harness();
    const target = point('2026-04-01T10:11:12.004+07:00');
    expect(await h.controller.keyDown({ key: 'Enter', target, enabled: true })).toBe(true);
    expect(h.semanticIntents).toEqual([
      {
        type: 'open-date-editor',
        itemId: 'point-1',
        ownedRole: 'scheduled',
        carrier: date('2026-04-01T10:11:12.004+07:00'),
      },
    ]);
    expect(Object.isFrozen(h.semanticIntents[0])).toBe(true);
    expect(Object.isFrozen(h.semanticIntents[0]!.carrier)).toBe(true);
  });

  it('idle Enter preserves whole-range ownership in the date-editor intent', async () => {
    const h = harness();
    const target = rangeMove('2026-04-01T08:09:10.111Z', '2026-04-03T17:18:19+07:00');

    expect(await h.controller.keyDown({ key: 'Enter', target, enabled: true })).toBe(true);

    expect(h.semanticIntents).toEqual([
      {
        type: 'open-date-editor',
        itemId: 'project-1',
        ownedRole: 'range',
        carrier: {
          start: date('2026-04-01T08:09:10.111Z'),
          end: date('2026-04-03T17:18:19+07:00'),
        },
      },
    ]);
  });
});

describe('TimelineInteractionController identity-column editing', () => {
  it('pointer resize clamps to 160–360, announces boundary, and cancel restores width', () => {
    const h = harness();
    pickup(h, identity(200), { x: 400, y: 20 });
    expect(h.controller.projection()).toMatchObject({
      activeTarget: 'identity-column',
      originalWidth: 200,
      draftWidth: 360,
      validity: { valid: true },
      accessibility: { ownedRole: 'identity-column', editorAvailable: false },
    });
    expect(h.announcements[h.announcements.length - 1]).toEqual({
      type: 'destination',
      target: 'identity-column',
      width: 360,
      boundary: 'max',
    });
    h.controller.pointerCancel(7);
    expect(h.ports.restoreFocus).toHaveBeenLastCalledWith(undefined, 'identity-column');
  });

  it('keyboard uses deterministic small/large steps, clamps, commits once, and announces pixels', async () => {
    const h = harness();
    await h.controller.keyDown({ key: 'ArrowLeft', target: identity(164), enabled: true });
    expect(h.controller.projection().draftWidth).toBe(160);
    await h.controller.keyDown({ key: 'ArrowRight', shiftKey: true });
    expect(h.controller.projection().draftWidth).toBe(192);
    expect(h.announcements).toContainEqual({
      type: 'destination',
      target: 'identity-column',
      width: 160,
      boundary: 'min',
    });
    await h.controller.keyDown({ key: 'Enter' });
    expect(h.commit).toHaveBeenCalledOnce();
    expect(h.commit.mock.calls[0]![0]).toMatchObject({
      type: 'identity-width-change',
      originalWidth: 164,
      draftWidth: 192,
    });
  });

  it.each([
    ['compact', 160],
    ['default', 240],
    ['wide', 360],
  ] as const)('emits a deeply frozen %s touch/menu preset intent', (preset, width) => {
    const h = harness();
    expect(h.controller.requestIdentityPreset(preset)).toBe(true);
    expect(h.semanticIntents[h.semanticIntents.length - 1]).toEqual({
      type: 'identity-width-preset',
      preset,
      width,
    });
    expect(Object.isFrozen(h.semanticIntents[h.semanticIntents.length - 1])).toBe(true);
    expect(h.announcements[h.announcements.length - 1]).toEqual({
      type: 'destination',
      target: 'identity-column',
      width,
      boundary: preset === 'compact' ? 'min' : preset === 'wide' ? 'max' : 'none',
    });
  });
});

describe('TimelineInteractionController input and projection immutability', () => {
  it('copies caller-owned target carriers and freezes every published projection branch', () => {
    const h = harness();
    const mutable = {
      kind: 'range-move' as const,
      itemId: 'project-1' as const,
      carrier: {
        start: { ...date('2026-01-01') },
        end: { ...date('2026-01-02') },
      },
    };
    pickup(h, mutable, { x: 120, y: 20 });
    mutable.carrier.start.raw = '2099-01-01';

    const projection = h.controller.projection();
    expect(projection.originalCarrier).toMatchObject({ start: { raw: '2026-01-01' } });
    expect(Object.isFrozen(projection)).toBe(true);
    expect(Object.isFrozen(projection.originalCarrier)).toBe(true);
    expect(Object.isFrozen(projection.draftCarrier)).toBe(true);
    expect(Object.isFrozen(projection.accessibility)).toBe(true);
    expect(Object.isFrozen(projection.validity)).toBe(true);
  });
});
