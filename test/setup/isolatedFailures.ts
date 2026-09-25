import { afterAll, afterEach } from 'vitest';
import { guardConsole } from './consoleGuard';

// The plugin reports many failures only in the console, and isolation keeps a throwing subscriber
// or presentation from failing its caller, so a real defect would only print a line. This guard
// fails the row instead. It imports nothing from `src`: a setup file that loads real modules does
// so before a test file's `vi.mock` applies.
const record = guardConsole(console);

function failOnPluginLogs(when: string): void {
  const seen = record.splice(0);
  if (seen.length === 0) return;
  throw new Error(
    `Unexpected plugin log ${when}: ${seen.join('; ')}. A row that expects one stubs ` +
      'console.error or console.warn with mockImplementation and asserts the call. A log that ' +
      'lands after its row ends is blamed on the next row.',
  );
}

afterEach(() => {
  failOnPluginLogs('in this row');
});

afterAll(() => {
  failOnPluginLogs("after the file's last row");
});
