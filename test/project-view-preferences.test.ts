import { describe, expect, it } from 'vitest';
import {
  reconcileProjectBoardPreference,
  resetProjectBoardStatusOrder,
} from '../src/panels/projects/projectViewPreferences';

describe('Project view preferences', () => {
  it('reconciles active board IDs in their stored order while preserving dormant IDs', () => {
    const preference = reconcileProjectBoardPreference(
      {
        version: 1,
        statusIds: ['planned', 'retired', 'planned', 'active'],
        dormantStatusIds: ['retired', 'legacy'],
      },
      ['active', 'planned', 'done'],
    );

    expect(preference).toEqual({
      version: 1,
      statusIds: ['planned', 'active', 'done'],
      dormantStatusIds: ['retired', 'legacy'],
    });
  });

  it('restores a dormant status when it becomes configured again', () => {
    const preference = reconcileProjectBoardPreference(
      {
        version: 1,
        statusIds: ['active'],
        dormantStatusIds: ['retired'],
      },
      ['active', 'retired'],
    );

    expect(preference).toEqual({
      version: 1,
      statusIds: ['active', 'retired'],
      dormantStatusIds: [],
    });
  });

  it('resets active IDs to the configured order without discarding dormant IDs', () => {
    expect(
      resetProjectBoardStatusOrder(
        {
          version: 1,
          statusIds: ['planned', 'active'],
          dormantStatusIds: ['retired', 'legacy'],
        },
        ['active', 'planned', 'done'],
      ),
    ).toEqual({
      version: 1,
      statusIds: ['active', 'planned', 'done'],
      dormantStatusIds: ['retired', 'legacy'],
    });
  });
});
