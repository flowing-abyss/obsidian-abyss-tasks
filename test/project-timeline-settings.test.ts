import { describe, expect, it } from 'vitest';
import { buildDefaultProjectTableSettings } from '../src/projects/projectTableSettings';
import {
  buildDefaultProjectTimelineSettings,
  isMalformedProjectTimelineSettings,
  normalizeProjectTimelineSettings,
} from '../src/projects/projectTimelineSettings';

describe('project Timeline settings', () => {
  it('initializes detached grouping, sorting, and filters from the table', () => {
    const table = buildDefaultProjectTableSettings();
    table.groupBy = 'property:Owner';
    table.sortBy = { field: 'end', dir: 'desc' };
    table.hiddenStatuses = ['id:done'];

    const timeline = buildDefaultProjectTimelineSettings(table);
    timeline.sortBy.field = 'start';
    timeline.hiddenStatuses.push('none');

    expect(timeline).toEqual({
      groupBy: 'property:Owner',
      sortBy: { field: 'start', dir: 'desc' },
      hiddenStatuses: ['id:done', 'none'],
      scale: 'month',
      showMetadata: true,
      progress: 'full',
      showUnscheduled: true,
    });
    expect(table.sortBy).toEqual({ field: 'end', dir: 'desc' });
    expect(table.hiddenStatuses).toEqual(['id:done']);
  });

  it('normalizes known values without sharing nested values', () => {
    const table = buildDefaultProjectTableSettings();
    const raw = {
      groupBy: 'status',
      sortBy: { field: 'name', dir: 'desc' },
      hiddenStatuses: ['id:done', 'id:done'],
      scale: 'quarter',
      showMetadata: false,
      progress: 'bar',
      showUnscheduled: false,
    };

    const normalized = normalizeProjectTimelineSettings(raw, table);
    normalized.sortBy.field = 'start';
    normalized.hiddenStatuses.push('none');

    expect(raw.sortBy).toEqual({ field: 'name', dir: 'desc' });
    expect(raw.hiddenStatuses).toEqual(['id:done', 'id:done']);
    expect(normalized).toMatchObject({
      groupBy: 'status',
      scale: 'quarter',
      showMetadata: false,
      progress: 'bar',
      showUnscheduled: false,
    });
  });

  it('reports malformed known fields while allowing future keys', () => {
    expect(isMalformedProjectTimelineSettings({ scale: 'year' })).toBe(true);
    expect(isMalformedProjectTimelineSettings({ showUnscheduled: 'yes' })).toBe(true);
    expect(isMalformedProjectTimelineSettings({ futureOption: { keep: true } })).toBe(false);
  });
});
