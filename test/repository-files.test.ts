import { Platform } from 'obsidian';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { git, repositoryFiles, trackedFiles } from './support/repositoryFiles';

const loadNodeTools = async () => {
  if (!Platform.isDesktop) throw new Error('Repository file tests require a desktop runtime');
  return Promise.all([import('node:fs'), import('node:os'), import('node:path')]);
};
const [{ mkdtempSync, rmSync, writeFileSync }, { tmpdir }, path] = await loadNodeTools();

const repositories: string[] = [];

afterEach(() => {
  for (const root of repositories.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A new git repository in a temporary directory whose index holds `files`. */
function makeRepository(files: Readonly<Record<string, string>>) {
  const root = mkdtempSync(path.join(tmpdir(), 'abyss-repository-files-'));
  repositories.push(root);
  git(root, ['init', '--quiet']);
  for (const [file, text] of Object.entries(files)) writeFileSync(path.join(root, file), text);
  git(root, ['add', '--', ...Object.keys(files)]);
  return root;
}

describe('repository files', () => {
  it('lists what a clone would hold, without files deleted but not staged', () => {
    const root = makeRepository({ '.gitignore': 'ignored.ts\n', 'kept.ts': '', 'deleted.ts': '' });
    rmSync(path.join(root, 'deleted.ts'));
    writeFileSync(path.join(root, 'untracked.ts'), '');
    writeFileSync(path.join(root, 'ignored.ts'), '');

    expect(new Set(trackedFiles(root))).toEqual(new Set(['.gitignore', 'kept.ts']));
    expect(new Set(repositoryFiles(root))).toEqual(
      new Set(['.gitignore', 'kept.ts', 'untracked.ts']),
    );
  });

  // A git hook in a worktree exports GIT_DIR, which git prefers to the directory it runs in.
  it('lists the repository at the given root whatever repository the environment names', () => {
    const root = makeRepository({ 'kept.ts': '' });
    const other = makeRepository({ 'other.ts': '' });
    vi.stubEnv('GIT_DIR', path.join(other, '.git'));

    expect(trackedFiles(root)).toEqual(['kept.ts']);
    expect(repositoryFiles(root)).toEqual(['kept.ts']);
  });
});
