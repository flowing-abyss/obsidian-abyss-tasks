import { afterAll, beforeEach } from 'vitest';
import { failOnPluginLogs, guardConsole, releaseConsoleStubs } from './consoleGuard';

// The plugin reports many failures only in the console, and isolation keeps a throwing subscriber
// or presentation from failing its caller, so a real defect would only print a line. This guard
// fails the row instead. It imports nothing from `src`: a setup file that loads real modules does
// so before a test file's `vi.mock` applies.
const record = guardConsole(console);

// Before each row, this file registers the row's check as an `onTestFinished` callback. Vitest runs
// it after every `afterEach` of the row's file, even when one of them throws, and keeps its error
// beside theirs, so a log made during a row fails that row, not the next one.
beforeEach(({ onTestFinished }) => {
  onTestFinished(() => {
    // Vitest restores spies only when the next row starts, so a row's stub would swallow later logs.
    releaseConsoleStubs(console);
    failOnPluginLogs(record, 'in this row');
  });
});

afterAll(() => {
  failOnPluginLogs(record, "after the file's last row");
});
