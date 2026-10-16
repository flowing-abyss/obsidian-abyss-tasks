import { writeFile } from 'node:fs/promises';
import { platform } from 'node:os';
import path from 'node:path';
import { command } from './driver.mts';
import { VaultTransaction } from './transaction.mts';

export function hostRunning(processes: string): boolean {
  return processes
    .split('\n')
    .some((line) => /(?:^|[/\\]|")obsidian(?:\.exe)?(?:"|$)/iu.test(line.trim()));
}

export async function recoverOffline(output: string): Promise<void> {
  const processes =
    platform() === 'win32'
      ? await command('tasklist', ['/FO', 'CSV', '/NH'])
      : await command('ps', ['-A', '-o', 'comm=']);
  if (hostRunning(processes))
    throw new Error(
      'Offline recovery requires Obsidian to be fully closed. Close it first, or use --recover with the responsive dev vault.',
    );
  const tx = await VaultTransaction.load(output);
  await tx.restore();
  if (!(await tx.verify())) throw new Error('Offline restoration verification failed');
  await writeFile(
    path.join(output, 'recovery-status.json'),
    JSON.stringify({ filesRestored: true, hostLayoutPending: true }),
  );
  process.stdout.write(
    `Files restored. Reopen dev-vault-tasks, then run pnpm run profile --recover ${output} to restore its workspace layout.\n`,
  );
}
