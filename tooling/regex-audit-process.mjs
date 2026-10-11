import { spawn } from 'node:child_process';
import path from 'node:path';
import { clearTimeout, setTimeout } from 'node:timers';

const ROOT = path.resolve(import.meta.dirname, '..');
const DEADLINE_MS = 90_000;

/**
 * POSIX descendants inherit the dedicated group; Windows requires taskkill's tree operation.
 * The published recheck worker/agent spawns do not detach from their owner's group.
 * @param {import('node:child_process').ChildProcess} child
 * @returns {Promise<string>} Empty on success, otherwise an actionable cleanup failure.
 */
async function terminateTree(child) {
  if (child.pid === undefined) return '';
  if (process.platform !== 'win32') {
    try {
      process.kill(-child.pid, 'SIGKILL');
      return '';
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ESRCH') return '';
      child.kill('SIGKILL');
      return `process-group termination failed: ${String(error)}`;
    }
  }
  return new Promise((resolve) => {
    const killer = spawn(
      path.win32.join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'taskkill.exe'),
      ['/PID', String(child.pid), '/T', '/F'],
      { stdio: 'ignore', windowsHide: true },
    );
    let finished = false;
    /** @param {string} error */
    const finish = (error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (error) child.kill('SIGKILL');
      killer.unref();
      resolve(error);
    };
    // Never wait for taskkill's close or reap indefinitely; errors stay visibly failed.
    const timer = setTimeout(() => {
      killer.kill('SIGKILL');
      finish('process-tree termination exceeded 1000ms');
    }, 1000);
    killer.once('error', (error) => finish(`process-tree termination failed: ${error.message}`));
    killer.once('exit', (code) =>
      finish(code === 0 ? '' : `process-tree termination exited ${code}`),
    );
  });
}

/**
 * A fresh Node process on every call; terminate its solver tree on deadline/cancellation/overflow.
 * Failure cleanup never awaits inherited pipe close or process reap.
 * @param {string[]} args @param {{deadlineMs?: number, signal?: AbortSignal}} [settings]
 * @returns {Promise<unknown>}
 */
export function runBoundedChild(args, settings = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: ROOT,
      detached: process.platform !== 'win32',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let failure = '';
    const release = () => {
      clearTimeout(timer);
      settings.signal?.removeEventListener('abort', cancel);
    };
    /** @param {string} reason */
    const stop = (reason) => {
      if (failure) return;
      failure = reason;
      void terminateTree(child)
        .catch((error) => `process-tree termination failed: ${String(error)}`)
        .then((cleanupError) => {
          release();
          child.stdout.destroy();
          child.stderr.destroy();
          child.unref();
          reject(new Error(cleanupError ? `${reason}; ${cleanupError}` : reason));
        });
    };
    const timer = setTimeout(
      () => stop(`analyzer hard deadline exceeded (${settings.deadlineMs ?? DEADLINE_MS}ms)`),
      settings.deadlineMs ?? DEADLINE_MS,
    );
    const cancel = () => stop('analyzer cancelled');
    settings.signal?.addEventListener('abort', cancel, { once: true });
    if (settings.signal?.aborted) cancel();
    child.stdout.setEncoding('utf8').on('data', (chunk) => {
      if (failure) return;
      stdout += chunk;
      if (stdout.length > 10_000_000) stop('analyzer output limit exceeded');
    });
    child.stderr.setEncoding('utf8').on('data', (chunk) => {
      if (failure) return;
      stderr += chunk;
      if (stderr.length > 1_000_000) stop('analyzer error output limit exceeded');
    });
    child.once('error', (error) => stop(`analyzer failed to start: ${error.message}`));
    child.once('close', (code) => {
      if (failure) return; // The bounded tree-termination path owns failure settlement.
      release();
      if (code !== 0 || stderr) {
        reject(new Error(`analyzer exited ${code}: ${stderr}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch {
        reject(new Error('analyzer returned invalid JSON'));
      }
    });
  });
}
