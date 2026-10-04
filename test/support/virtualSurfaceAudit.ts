/**
 * Exercise twenty complete outward/return cycles of the same mounted surface. This workload
 * retains real DOM, Component and native resource behavior, so its callers name the measured
 * lifecycle-audit limit rather than the ordinary interaction-test limit.
 */
export async function runVirtualSurfaceAuditCycles(
  cycle: (index: number) => Promise<void>,
): Promise<void> {
  for (let index = 0; index < 20; index++) await cycle(index);
}
