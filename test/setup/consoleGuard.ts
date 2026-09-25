import { vi } from 'vitest';

/** Marks a wrapped console method; the wrapper carries the record of plugin logs it saw. */
export const CONSOLE_GUARD = Symbol.for('abyss-tasks.isolated-failures-guard');

const PLUGIN_LOG_PREFIX = '[abyss-tasks]';
const GUARDED_METHODS = ['error', 'warn'] as const;

type GuardedMethod = ((...args: unknown[]) => void) & { [CONSOLE_GUARD]?: string[] };

/**
 * Wraps `error` and `warn` once with plain functions, which `restoreMocks` and `mockReset` leave in
 * place, and returns the shared record of plugin logs they saw. Every call still reaches the
 * original method. A row's own `vi.spyOn(console, 'error')` with `mockImplementation` replaces the
 * wrapper for that row; a call-through spy still reaches it.
 */
export function guardConsole(target: Pick<Console, 'error' | 'warn'>): string[] {
  const installed = (target.error as GuardedMethod)[CONSOLE_GUARD];
  if (installed !== undefined) return installed;
  const record: string[] = [];
  for (const method of GUARDED_METHODS) {
    const original = target[method].bind(target);
    const guarded: GuardedMethod = (...args: unknown[]): void => {
      const [first] = args;
      if (typeof first === 'string' && first.startsWith(PLUGIN_LOG_PREFIX)) {
        record.push(`console.${method}: ${first}`);
      }
      original(...args);
    };
    guarded[CONSOLE_GUARD] = record;
    target[method] = guarded;
  }
  return record;
}

/**
 * Restores a spy a row left on `error` or `warn`, which puts the guard's wrapper back, so a plugin
 * log that lands after the row reaches the record instead of the row's stub.
 */
export function releaseConsoleStubs(target: Pick<Console, 'error' | 'warn'>): void {
  for (const method of GUARDED_METHODS) {
    const current = target[method];
    if (vi.isMockFunction(current)) current.mockRestore();
  }
}

/** Throws once for the plugin logs recorded so far and clears them, so each log fails one check. */
export function failOnPluginLogs(record: string[], when: string): void {
  const seen = record.splice(0);
  if (seen.length === 0) return;
  throw new Error(
    `Unexpected plugin log ${when}: ${seen.join('; ')}. A row that expects one stubs ` +
      'console.error or console.warn with mockImplementation and asserts the call. A log that ' +
      'lands after its row ends is blamed on the next row.',
  );
}
