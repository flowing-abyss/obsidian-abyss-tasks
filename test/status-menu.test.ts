import { describe, expect, it, vi } from 'vitest';
import { localDate, type CalendarTaskSource } from '../src/tasks';
import { showStatusMenuAt } from '../src/ui/statusMenu';
import type { CalendarOccurrence } from '../src/views/calendarOccurrences';
import { createForecastContextMenuOwner } from '../src/views/timegrid/renderTaskMeta';
import { task, testStatusRegistry } from './helpers';

function forecastFixture(): {
  readonly root: ReturnType<typeof task>;
  readonly occurrence: Extract<CalendarOccurrence, { readonly kind: 'forecast' }>;
} {
  const root = task({ recurrence: 'every day', planning: { due: '2026-08-08' } });
  const source: CalendarTaskSource = {
    root,
    node: root,
    target: { type: 'task', ref: root.ref },
  };
  return {
    root,
    occurrence: {
      kind: 'forecast',
      key: 'owned-forecast',
      source,
      planning: { due: localDate('2026-08-09') },
      referenceDate: localDate('2026-08-09'),
      ordinal: 1,
    },
  };
}

describe('status menu interaction ownership', () => {
  it('names menu containers without giving them hover tooltips', () => {
    const menu = showStatusMenuAt(new MouseEvent('contextmenu'), {
      task: task(),
      registry: testStatusRegistry(),
      onPickStatus: () => {},
      onPickPriority: () => {},
    });
    try {
      const group = menu.element.querySelector('[role="group"]');
      for (const [element, name] of [
        [menu.element, 'Task status and priority'],
        [group, 'Priority'],
      ] as const) {
        expect(element?.hasAttribute('aria-label')).toBe(false);
        const label = element?.getAttribute('aria-labelledby');
        expect(activeDocument.getElementById(label ?? '')?.textContent).toBe(name);
      }
      expect(
        menu.element.querySelector('.abyss-status-popover-flag')?.getAttribute('aria-label'),
      ).toBe('Highest');
    } finally {
      menu.close();
    }
  });

  it('acquires once per open and releases idempotently on replacement and external close', () => {
    const releases = [vi.fn(), vi.fn()];
    const interactionOwnership = {
      acquire: vi
        .fn()
        .mockReturnValueOnce({ release: releases[0] })
        .mockReturnValueOnce({ release: releases[1] }),
    };
    const options = {
      task: task(),
      registry: testStatusRegistry(),
      onPickStatus: () => {},
      onPickPriority: () => {},
      interactionOwnership,
    };

    const first = showStatusMenuAt(new MouseEvent('contextmenu'), options);
    const second = showStatusMenuAt(new MouseEvent('contextmenu'), options);

    expect(interactionOwnership.acquire).toHaveBeenCalledTimes(2);
    expect(interactionOwnership.acquire).toHaveBeenNthCalledWith(1, { blocksShortcuts: true });
    expect(releases[0]).toHaveBeenCalledOnce();
    first.close();
    second.close();
    second.close();
    expect(releases[0]).toHaveBeenCalledOnce();
    expect(releases[1]).toHaveBeenCalledOnce();
  });

  it('closes a replaced forecast menu through its owner before acquiring the status menu', () => {
    const { root, occurrence } = forecastFixture();
    const releases = [vi.fn(), vi.fn()];
    const interactionOwnership = {
      acquire: vi
        .fn()
        .mockReturnValueOnce({ release: releases[0] })
        .mockReturnValueOnce({ release: releases[1] }),
    };
    const forecastOwner = createForecastContextMenuOwner(activeDocument, interactionOwnership);
    const anchor = activeDocument.body.createEl('button');
    forecastOwner.open(anchor, new MouseEvent('contextmenu'), occurrence, {});

    const status = showStatusMenuAt(new MouseEvent('contextmenu'), {
      task: root,
      registry: testStatusRegistry(),
      onPickStatus: () => {},
      onPickPriority: () => {},
      interactionOwnership,
    });
    status.close();

    expect(activeDocument.querySelector('.abyss-forecast-context-menu')).toBeNull();
    expect(releases[0]).toHaveBeenCalledOnce();
    expect(releases[1]).toHaveBeenCalledOnce();
    forecastOwner.dismiss({ restoreFocus: false });
    anchor.remove();
  });

  it('closes a replaced status menu through its handle before acquiring the forecast menu', () => {
    const { root, occurrence } = forecastFixture();
    const releases = [vi.fn(), vi.fn()];
    const interactionOwnership = {
      acquire: vi
        .fn()
        .mockReturnValueOnce({ release: releases[0] })
        .mockReturnValueOnce({ release: releases[1] }),
    };
    const status = showStatusMenuAt(new MouseEvent('contextmenu'), {
      task: root,
      registry: testStatusRegistry(),
      onPickStatus: () => {},
      onPickPriority: () => {},
      interactionOwnership,
    });
    const forecastOwner = createForecastContextMenuOwner(activeDocument, interactionOwnership);
    const anchor = activeDocument.body.createEl('button');

    forecastOwner.open(anchor, new MouseEvent('contextmenu'), occurrence, {});

    expect(status.element.isConnected).toBe(false);
    expect(releases[0]).toHaveBeenCalledOnce();
    forecastOwner.dismiss({ restoreFocus: false });
    status.close();
    expect(releases[1]).toHaveBeenCalledOnce();
    anchor.remove();
  });
});
