import { build } from 'esbuild';
import { copyFile, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { command } from './driver.mts';
import { sha256 } from './transaction.mts';
import type { ProfileRun } from './types.ts';

export async function prepareBuild(root: string, output: string): Promise<ProfileRun['build']> {
  await command(process.execPath, ['esbuild.config.mjs', 'production'], root);
  const normal = sha256(await readFile(path.join(root, 'main.js')));
  await command(process.execPath, ['esbuild.config.mjs', 'production', 'profile'], root);
  if (sha256(await readFile(path.join(root, 'main.js'))) !== normal)
    throw new Error('Source-map build changed production JavaScript');
  await command(process.execPath, ['release-artifacts.mjs'], root);
  await copyFile(path.join(root, 'dist/styles.css'), path.join(output, 'styles.css'));
  for (const name of ['main.js', 'main.js.map', 'manifest.json'])
    await copyFile(path.join(root, name), path.join(output, name));
  await build({
    entryPoints: [path.join(root, 'tooling/performance/native.ts')],
    bundle: true,
    platform: 'browser',
    format: 'iife',
    globalName: '__abyssProfileModule',
    outfile: path.join(output, 'native.js'),
    target: 'es2021',
  });
  const worker = await build({
    entryPoints: [path.join(root, 'src/tasks/infrastructure/search/taskSearch.worker.ts')],
    bundle: true,
    platform: 'browser',
    format: 'iife',
    outfile: path.join(output, 'search-worker.js'),
    sourcemap: 'external',
    minify: true,
    mangleProps: /_abyssPrivate$/,
    target: 'es2021',
  });
  if (worker.errors.length > 0) throw new Error('Worker map build failed');
  await writeFile(
    path.join(output, 'source-maps.json'),
    JSON.stringify(
      {
        mainSha256: normal,
        workerPrefix: '/* abyss-task-search-worker */',
        workerMapNote:
          'Embedded Worker source has this prefix on its first line; subtract its length from first-line columns when mapping. Worker compilation uses production options.',
      },
      null,
      2,
    ),
  );
  return {
    commit: (await command('git', ['rev-parse', 'HEAD'], root)).trim(),
    dirty: (await command('git', ['status', '--porcelain'], root)).trim().length > 0,
    sha256: normal,
  };
}

export async function protocolHash(root: string): Promise<string> {
  const folder = path.join(root, 'tooling/performance');
  const chunks: Buffer[] = [];
  for (const name of (await readdir(folder))
    .filter((p) => p.endsWith('.ts') || p.endsWith('.mts'))
    .sort((a, b) => a.localeCompare(b)))
    chunks.push(Buffer.from(name), await readFile(path.join(folder, name)));
  return sha256(Buffer.concat(chunks));
}
