import { Platform } from 'obsidian';

const loadNodeTools = async () => {
  if (!Platform.isDesktop) throw new Error('Repository file lists require a desktop runtime');
  return Promise.all([import('node:child_process'), import('node:fs'), import('node:path')]);
};
const [{ execFileSync }, { existsSync }, path] = await loadNodeTools();

/**
 * Runs git on the repository at `root` and returns its output. The variables git calls local to a
 * repository stay out of its environment: a git hook exports some of them (a worktree's pre-push
 * hook sets GIT_DIR), and git would prefer them to `root`.
 */
export function git(root: string, args: readonly string[]): string {
  const local = new Set(
    execFileSync('git', ['rev-parse', '--local-env-vars'], { encoding: 'utf8' }).split('\n'),
  );
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !local.has(name)));
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', env });
}

/**
 * The files git lists, relative to `root`, without those missing on disk: git still lists a file
 * deleted but not staged, and a linter asked for a missing file throws.
 */
function listedFiles(root: string, args: readonly string[]): string[] {
  return git(root, ['ls-files', '-z', ...args])
    .split('\0')
    .filter((file) => file !== '' && existsSync(path.join(root, file)));
}

/** Every file git tracks. */
export function trackedFiles(root: string): string[] {
  return listedFiles(root, []);
}

/** Every file git tracks or would track: what a clone holds once the work is committed. */
export function repositoryFiles(root: string): string[] {
  return listedFiles(root, ['--cached', '--others', '--exclude-standard']);
}
