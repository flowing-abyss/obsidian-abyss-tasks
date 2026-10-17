// @vitest-environment node
import { Platform } from 'obsidian';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { prepareBuild } from '../tooling/performance/build.mts';
import { CHILD_PROCESS_TIMEOUT_MS } from './support/timeouts';

const loadNodeTools = async () => {
  if (!Platform.isDesktop) throw new Error('Performance build tests require a desktop runtime');
  return Promise.all([
    import('node:child_process'),
    import('node:crypto'),
    import('node:fs/promises'),
    import('node:os'),
    import('node:path'),
  ]);
};
const [
  { execFileSync },
  { createHash },
  { mkdir, mkdtemp, readFile, rm, symlink, writeFile },
  { tmpdir },
  path,
] = await loadNodeTools();

const roots: string[] = [];
const authoredCss = '.alpha { color: red; }\n';
const mainJs = 'console.log("production");\n';
const mainMap = '{"version":3,"sources":[],"mappings":""}\n';
const manifest = '{"id":"abyss-tasks","version":"1.0.0"}\n';

beforeEach(() => {
  // Hooks can export GIT_DIR/GIT_INDEX_FILE, which would override the fixture cwd.
  const localGitVariables = execFileSync('git', ['rev-parse', '--local-env-vars'], {
    encoding: 'utf8',
  })
    .trim()
    .split('\n');
  for (const name of localGitVariables) vi.stubEnv(name, undefined);
}, CHILD_PROCESS_TIMEOUT_MS);

async function fixture(budget = 128, changeMappedJs = false) {
  const root = await mkdtemp(path.join(tmpdir(), 'abyss-performance-build-'));
  roots.push(root);
  const output = path.join(root, 'profile');
  for (const directory of [
    'dist',
    'profile',
    'tooling/performance',
    'src/tasks/infrastructure/search',
  ]) {
    await mkdir(path.join(root, directory), { recursive: true });
  }
  await writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({ release: { stylesCssBudgetBytes: budget } }),
  );
  await writeFile(path.join(root, 'styles.css'), authoredCss);
  await writeFile(path.join(root, 'dist/styles.css'), 'stale release stylesheet');
  await writeFile(path.join(root, 'manifest.json'), manifest);
  await symlink(
    path.join(process.cwd(), 'release-artifacts.mjs'),
    path.join(root, 'release-artifacts.mjs'),
  );
  await writeFile(
    path.join(root, 'esbuild.config.mjs'),
    `import { writeFileSync } from 'node:fs';
const profile = process.argv.includes('profile');
writeFileSync('main.js', ${JSON.stringify(mainJs)} + (profile && ${String(changeMappedJs)} ? 'changed' : ''));
if (profile) writeFileSync('main.js.map', ${JSON.stringify(mainMap)});
`,
  );
  await writeFile(path.join(root, 'tooling/performance/native.ts'), 'export const native = 1;');
  await writeFile(
    path.join(root, 'src/tasks/infrastructure/search/taskSearch.worker.ts'),
    'self.onmessage = () => self.postMessage("ready");',
  );
  execFileSync('git', ['init', '--quiet'], { cwd: root });
  execFileSync(
    'git',
    [
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.com',
      '-c',
      'commit.gpgsign=false',
      '-c',
      `core.hooksPath=${path.join(root, 'no-hooks')}`,
      'commit',
      '--quiet',
      '--allow-empty',
      '-m',
      'fixture',
    ],
    { cwd: root },
  );
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  return { root, output, commit };
}

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe('performance build artifact provenance', () => {
  it(
    'copies freshly generated release CSS while retaining production JavaScript and source maps',
    async () => {
      const { root, output, commit } = await fixture();

      const result = await prepareBuild(root, output);

      expect(await readFile(path.join(output, 'styles.css'), 'utf8')).toBe('.alpha{color:red}\n');
      expect(await readFile(path.join(root, 'dist/styles.css'))).toEqual(
        await readFile(path.join(output, 'styles.css')),
      );
      expect(await readFile(path.join(root, 'styles.css'), 'utf8')).toBe(authoredCss);
      expect(await readFile(path.join(output, 'main.js'), 'utf8')).toBe(mainJs);
      expect(await readFile(path.join(output, 'main.js.map'), 'utf8')).toBe(mainMap);
      expect(await readFile(path.join(output, 'manifest.json'), 'utf8')).toBe(manifest);
      expect(await readFile(path.join(output, 'native.js'), 'utf8')).toContain(
        '__abyssProfileModule',
      );
      expect(await readFile(path.join(output, 'search-worker.js'), 'utf8')).toContain('ready');
      const workerMap = JSON.parse(
        await readFile(path.join(output, 'search-worker.js.map'), 'utf8'),
      ) as { sources: string[] };
      expect(workerMap.sources).toHaveLength(1);
      expect(result).toEqual({
        commit,
        dirty: true,
        sha256: createHash('sha256').update(mainJs).digest('hex'),
      });
    },
    CHILD_PROCESS_TIMEOUT_MS,
  );

  it(
    'propagates release generation failure instead of copying authored or stale CSS',
    async () => {
      const { root, output } = await fixture(1);

      await expect(prepareBuild(root, output)).rejects.toThrow('over the 1-byte budget');

      await expect(readFile(path.join(output, 'styles.css'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
      await expect(readFile(path.join(root, 'dist/styles.css'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
      expect(await readFile(path.join(root, 'styles.css'), 'utf8')).toBe(authoredCss);
    },
    CHILD_PROCESS_TIMEOUT_MS,
  );

  it(
    'rejects a source-map build that changes the production JavaScript bytes',
    async () => {
      const { root, output } = await fixture(128, true);

      await expect(prepareBuild(root, output)).rejects.toThrow(
        'Source-map build changed production JavaScript',
      );

      await expect(readFile(path.join(output, 'main.js'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
    },
    CHILD_PROCESS_TIMEOUT_MS,
  );
});
