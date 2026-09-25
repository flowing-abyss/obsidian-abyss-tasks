import { afterEach } from 'vitest';

// Isolation keeps a throwing subscriber or presentation from failing its caller, so a real defect
// would only print a line. This guard fails the row instead. It imports nothing from `src`: a setup
// file that loads real modules does so before a test file's `vi.mock` applies.
const GUARDED = new Set([
  '[abyss-tasks] task index listener failed',
  '[abyss-tasks] task index publication failed',
  '[abyss-tasks] Could not show the created task',
]);
const GUARD = Symbol.for('abyss-tasks.isolated-failures-guard');

type GuardedLog = ((...args: unknown[]) => void) & { [GUARD]?: string[] };

/**
 * Wraps the console's `error` once with a plain function, which `restoreMocks` and `mockReset`
 * leave in place. A row's own `vi.spyOn(console, 'error')` with `mockImplementation` replaces it for
 * that row; a call-through spy still reaches it.
 */
function guardConsole(): string[] {
  const installed = (console.error as GuardedLog)[GUARD];
  if (installed !== undefined) return installed;
  const logged: string[] = [];
  const real = console.error.bind(console);
  const guarded: GuardedLog = (...args: unknown[]): void => {
    const [first] = args;
    if (typeof first === 'string' && GUARDED.has(first)) logged.push(first);
    real(...args);
  };
  guarded[GUARD] = logged;
  console.error = guarded;
  return logged;
}

const logged = guardConsole();

afterEach(() => {
  const seen = logged.splice(0);
  if (seen.length === 0) return;
  throw new Error(
    `Unexpected isolated failure: ${seen.join('; ')}. A row that expects it stubs console.error ` +
      'with mockImplementation. A log that lands after its row ends is blamed on the next row.',
  );
});
