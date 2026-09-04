import { Platform, setIcon } from 'obsidian';
import { describe, expect, it } from 'vitest';
import type { CalendarSettings } from '../src/settings/types';
import { subtask, task, useRealMoment, withMobile } from './helpers';

describe('test helpers', () => {
  describe('useRealMoment', () => {
    useRealMoment();
    it('installs real moment as window.moment', () => {
      expect(window.moment('2026-06-24').isSame('2026-06-24', 'day')).toBe(true);
      expect(window.moment('2026-06-25').isAfter('2026-06-24', 'day')).toBe(true);
    });
    it('supports date arithmetic', () => {
      expect(window.moment('2026-06-24').add(1, 'day').format('YYYY-MM-DD')).toBe('2026-06-25');
    });
  });

  describe('withMobile', () => {
    withMobile(true);
    it('sets Platform.isMobile to the given value for the block', () => {
      expect(Platform.isMobile).toBe(true);
    });
  });

  describe('task builder', () => {
    it('produces a Task with sensible defaults', () => {
      const t = task();
      expect(t.source.filePath).toBe('f.md');
      expect(t.status).toBe('open');
      expect(t.priority).toBe('D');
    });
    it('overrides win', () => {
      const t = task({ status: 'done', priority: 'A', planning: { due: '2026-06-24' } });
      expect(t.status).toBe('done');
      expect(t.priority).toBe('A');
      expect(t.planning.due).toBe('2026-06-24');
    });
  });

  describe('subtask builder', () => {
    it('preserves dependency metadata and clones the dependency list override', () => {
      const dependsOn = ['schema', 'auth', 'schema'];
      const child = subtask({ dependencyId: 'build-api', dependsOn });

      expect(child.dependencyId).toBe('build-api');
      expect(child.dependsOn).toEqual(['schema', 'auth', 'schema']);
      expect(child.dependsOn).not.toBe(dependsOn);
    });
  });

  describe('obsidian alias resolution (proves vitest.config fix)', () => {
    it('resolves imports from obsidian via obsidian-test-mocks', () => {
      // setIcon is a function from the mocked obsidian module
      expect(typeof setIcon).toBe('function');
    });
    it('lets src modules that import from obsidian load (resolveConfig reaches obsidian)', async () => {
      const { resolveConfig } = await import('../src/code-block/registerCodeBlock');
      const cfg = resolveConfig(
        { desktop: { defaultView: 'month', firstDayOfWeek: 1 } } as unknown as CalendarSettings,
        {},
      );
      expect(cfg.isMobile).toBe(false);
    });
  });
});
