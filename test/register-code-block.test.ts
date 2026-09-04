import { describe, expect, it } from 'vitest';
import { resolveConfig } from '../src/code-block/registerCodeBlock';
import { DEFAULT_SETTINGS, DEFAULT_VIEW_CONFIG } from '../src/settings/defaults';
import type { CalendarSettings } from '../src/settings/types';
import { withMobile } from './helpers';

describe('resolveConfig', () => {
  describe('desktop (Platform.isMobile = false)', () => {
    it('returns all DEFAULT_VIEW_CONFIG fields with isMobile false on empty params', () => {
      const cfg = resolveConfig(DEFAULT_SETTINGS, {});
      expect(cfg.isMobile).toBe(false);
      expect(cfg.defaultView).toBe(DEFAULT_VIEW_CONFIG.defaultView);
      expect(cfg.firstDayOfWeek).toBe(DEFAULT_VIEW_CONFIG.firstDayOfWeek);
      expect(cfg.dailyNoteFolder).toBe(DEFAULT_VIEW_CONFIG.dailyNoteFolder);
      expect(cfg.dailyNoteFormat).toBe(DEFAULT_VIEW_CONFIG.dailyNoteFormat);
      expect(cfg.upcomingDays).toBe(DEFAULT_VIEW_CONFIG.upcomingDays);
      expect(cfg.style).toBe(DEFAULT_VIEW_CONFIG.style);
      expect(cfg.globalTaskFilter).toBe(DEFAULT_VIEW_CONFIG.globalTaskFilter);
      expect(cfg.startPosition).toBe(DEFAULT_VIEW_CONFIG.startPosition);
      expect(cfg.tag).toBe(DEFAULT_VIEW_CONFIG.tag);
      expect(cfg.folder).toBe(DEFAULT_VIEW_CONFIG.folder);
    });
  });

  describe('mobile (Platform.isMobile = true)', () => {
    withMobile(true);

    it('uses settings.mobile overrides (e.g. defaultView list)', () => {
      const cfg = resolveConfig(DEFAULT_SETTINGS, {});
      expect(cfg.isMobile).toBe(true);
      expect(cfg.defaultView).toBe(DEFAULT_SETTINGS.mobile.defaultView);
    });

    it('fills all DEFAULT_VIEW_CONFIG fields even when settings.mobile is missing (spreading undefined is a no-op)', () => {
      const partial: CalendarSettings = {
        ...DEFAULT_SETTINGS,
        mobile: undefined as unknown as CalendarSettings['mobile'],
      };
      const cfg = resolveConfig(partial, {});
      expect(cfg.isMobile).toBe(true);
      expect(cfg.defaultView).toBe(DEFAULT_VIEW_CONFIG.defaultView);
      expect(cfg.firstDayOfWeek).toBe(DEFAULT_VIEW_CONFIG.firstDayOfWeek);
      expect(cfg.upcomingDays).toBe(DEFAULT_VIEW_CONFIG.upcomingDays);
    });
  });

  describe('param overrides', () => {
    it('overrides defaultView via params.view', () => {
      expect(resolveConfig(DEFAULT_SETTINGS, { view: 'week' }).defaultView).toBe('week');
      expect(resolveConfig(DEFAULT_SETTINGS, { view: 'list' }).defaultView).toBe('list');
      expect(resolveConfig(DEFAULT_SETTINGS, { view: 'month' }).defaultView).toBe('month');
    });

    it('clamps firstDayOfWeek to [0, 6]', () => {
      expect(resolveConfig(DEFAULT_SETTINGS, { firstDayOfWeek: 99 }).firstDayOfWeek).toBe(6);
      expect(resolveConfig(DEFAULT_SETTINGS, { firstDayOfWeek: -5 }).firstDayOfWeek).toBe(0);
      expect(resolveConfig(DEFAULT_SETTINGS, { firstDayOfWeek: 3 }).firstDayOfWeek).toBe(3);
      expect(resolveConfig(DEFAULT_SETTINGS, { firstDayOfWeek: 0 }).firstDayOfWeek).toBe(0);
      expect(resolveConfig(DEFAULT_SETTINGS, { firstDayOfWeek: 6 }).firstDayOfWeek).toBe(6);
    });

    it('passes upcomingDays through without clamping (CURRENT BEHAVIOR)', () => {
      expect(resolveConfig(DEFAULT_SETTINGS, { upcomingDays: 999 }).upcomingDays).toBe(999);
      expect(resolveConfig(DEFAULT_SETTINGS, { upcomingDays: -1 }).upcomingDays).toBe(-1);
    });

    it('applies each optional override only when defined', () => {
      const cfg = resolveConfig(DEFAULT_SETTINGS, {
        dailyNoteFolder: 'notes/daily',
        dailyNoteFormat: 'DD-MM-YYYY',
        style: 'style3',
        globalTaskFilter: '#task',
        startPosition: '2026-06',
        tag: '#work',
        folder: 'projects',
      });
      expect(cfg.dailyNoteFolder).toBe('notes/daily');
      expect(cfg.dailyNoteFormat).toBe('DD-MM-YYYY');
      expect(cfg.style).toBe('style3');
      expect(cfg.globalTaskFilter).toBe('#task');
      expect(cfg.startPosition).toBe('2026-06');
      expect(cfg.tag).toBe('#work');
      expect(cfg.folder).toBe('projects');
    });

    it('does not override when a param is absent', () => {
      const cfg = resolveConfig(DEFAULT_SETTINGS, {});
      expect(cfg.defaultView).toBe(DEFAULT_VIEW_CONFIG.defaultView);
    });
  });

  describe('global settings threading', () => {
    it('copies sourceNoteDisplay from settings', () => {
      const s = { ...DEFAULT_SETTINGS, sourceNoteDisplay: 'always' as const };
      expect(resolveConfig(s, {}).sourceNoteDisplay).toBe('always');
    });

    it('copies sourceNoteDisplay never', () => {
      const s = { ...DEFAULT_SETTINGS, sourceNoteDisplay: 'never' as const };
      expect(resolveConfig(s, {}).sourceNoteDisplay).toBe('never');
    });

    it('copies customFilePath from settings', () => {
      const s = { ...DEFAULT_SETTINGS, customFilePath: 'Inbox/tasks.md' };
      expect(resolveConfig(s, {}).customFilePath).toBe('Inbox/tasks.md');
    });

    it('default resolveConfig has sourceNoteDisplay non-default', () => {
      expect(resolveConfig(DEFAULT_SETTINGS, {}).sourceNoteDisplay).toBe('non-default');
    });
  });
});
