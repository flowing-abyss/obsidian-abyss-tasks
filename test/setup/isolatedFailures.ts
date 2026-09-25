import { afterAll, afterEach } from 'vitest';
import { failOnPluginLogs, guardConsole, releaseConsoleStubs } from './consoleGuard';

// The plugin reports many failures only in the console, and isolation keeps a throwing subscriber
// or presentation from failing its caller, so a real defect would only print a line. This guard
// fails the row instead. It imports nothing from `src`: a setup file that loads real modules does
// so before a test file's `vi.mock` applies.
const record = guardConsole(console);

afterEach(() => {
  // Vitest restores spies only when the next row starts, so a row's stub would swallow later logs.
  releaseConsoleStubs(console);
  failOnPluginLogs(record, 'in this row');
});

afterAll(() => {
  failOnPluginLogs(record, "after the file's last row");
});
