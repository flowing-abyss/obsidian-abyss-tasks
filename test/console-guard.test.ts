// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import {
  CONSOLE_GUARD,
  failOnPluginLogs,
  guardConsole,
  releaseConsoleStubs,
} from './setup/consoleGuard';

type Marked = { [CONSOLE_GUARD]?: string[] };

describe('plugin log guard', () => {
  it('guards the console of every test file', () => {
    const record = (console.error as unknown as Marked)[CONSOLE_GUARD];

    expect(record).toBeInstanceOf(Array);
    expect((console.warn as unknown as Marked)[CONSOLE_GUARD]).toBe(record);
  });

  it('records plugin errors and warnings, passes every call through, and wraps a console once', () => {
    const error = vi.fn();
    const warn = vi.fn();
    const target = { error, warn };
    const failure = new Error('[abyss-tasks] inside an error');

    const record = guardConsole(target);
    target.error('[abyss-tasks] Could not save', failure);
    target.warn('[abyss-tasks] The tracked task moved');
    target.error('Another library failed');
    target.warn(' [abyss-tasks] after a space');
    target.error(failure);

    expect(record).toEqual([
      'console.error: [abyss-tasks] Could not save',
      'console.warn: [abyss-tasks] The tracked task moved',
    ]);
    expect(error.mock.calls).toEqual([
      ['[abyss-tasks] Could not save', failure],
      ['Another library failed'],
      [failure],
    ]);
    expect(warn.mock.calls).toEqual([
      ['[abyss-tasks] The tracked task moved'],
      [' [abyss-tasks] after a space'],
    ]);
    expect(guardConsole(target)).toBe(record);
  });

  it('fails once for recorded plugin logs, then clears them', () => {
    const record = ['console.error: [abyss-tasks] first', 'console.warn: [abyss-tasks] second'];

    expect(() => {
      failOnPluginLogs(record, 'in this row');
    }).toThrow(
      new Error(
        'Unexpected plugin log in this row: console.error: [abyss-tasks] first; ' +
          'console.warn: [abyss-tasks] second. A row that expects one stubs console.error or ' +
          'console.warn with mockImplementation and asserts the call. A log that lands after its ' +
          'row ends is blamed on the next row.',
      ),
    );
    expect(record).toEqual([]);
    expect(() => {
      failOnPluginLogs(record, 'in this row');
    }).not.toThrow();
  });

  it('releases a console stub a row left behind, so a later plugin log reaches the guard', () => {
    const target = { error: vi.fn(), warn: vi.fn() };
    const record = guardConsole(target);
    vi.spyOn(target, 'error').mockImplementation(() => undefined);
    vi.spyOn(target, 'warn').mockImplementation(() => undefined);

    target.error('[abyss-tasks] stubbed error');
    target.warn('[abyss-tasks] stubbed warning');
    expect(record).toEqual([]);

    releaseConsoleStubs(target);
    target.error('[abyss-tasks] later error');
    target.warn('[abyss-tasks] later warning');

    expect(record).toEqual([
      'console.error: [abyss-tasks] later error',
      'console.warn: [abyss-tasks] later warning',
    ]);
    expect(vi.isMockFunction(target.error)).toBe(false);
    expect(vi.isMockFunction(target.warn)).toBe(false);
    const { error, warn } = target;
    releaseConsoleStubs(target);
    expect(target.error).toBe(error);
    expect(target.warn).toBe(warn);
    expect(record).toHaveLength(2);
  });
});
