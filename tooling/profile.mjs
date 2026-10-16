import { build } from 'esbuild';
import { spawn } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const directory = path.join(root, 'docs/performance');
await mkdir(directory, { recursive: true });
const outfile = path.join(directory, `runner-${process.pid}.mjs`);
try {
  await build({
    entryPoints: [path.join(root, 'tooling/performance/cli.mts')],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    packages: 'external',
    target: 'node22',
  });
  const child = spawn(process.execPath, [outfile, root, ...process.argv.slice(2)], {
    stdio: 'inherit',
  });
  const interrupt = () => {
    child.kill('SIGINT');
  };
  const terminate = () => {
    child.kill('SIGTERM');
  };
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', terminate);
  try {
    process.exitCode = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code) => {
        resolve(code ?? 1);
      });
    });
  } finally {
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', terminate);
  }
} finally {
  await rm(outfile, { force: true });
}
