import { describe, expect, it, vi } from 'vitest';
import { CONSOLE_GUARD, guardConsole } from './setup/consoleGuard';

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
});
