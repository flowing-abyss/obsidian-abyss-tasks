/**
 * The process's user and system CPU time in milliseconds. A row that times its own work reads this
 * clock, directly or through `interleavedRatio` in test/helpers.ts, never the wall clock: on a busy
 * machine a thread waits for a core, and the wall clock counts that wait while this one leaves it
 * out. It counts V8's helper threads, which work beside the main thread. `process.threadCpuUsage()`
 * would leave them out, but on Linux it moves only at the thread's scheduler ticks (1 to 4 ms), and
 * `process.cpuUsage()` moves in microseconds on Linux and macOS.
 */
export function cpuMilliseconds(): number {
  const usage = process.cpuUsage();
  return (usage.user + usage.system) / 1_000;
}
