import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const ROOT = ts.sys.resolvePath(`${import.meta.dirname}/..`);

function source(path: string): string {
  const content = ts.sys.readFile(ts.sys.resolvePath(`${ROOT}/${path}`));
  if (content === undefined) throw new Error(`Unable to read ${path}`);
  return content;
}

const manifest = JSON.parse(source('manifest.json')) as {
  id: string;
  name: string;
  description: string;
};
const packageMetadata = JSON.parse(source('package.json')) as {
  name: string;
  description: string;
  repository: { type: string; url: string };
};
const lockfile = source('pnpm-lock.yaml');

describe('Abyss Tasks product metadata', () => {
  it('uses the approved product identity, plugin ID, and SSH repository', () => {
    expect(manifest).toMatchObject({
      id: 'abyss-tasks',
      name: 'Abyss Tasks',
      description: 'A task management interface for Markdown tasks.',
    });
    expect(packageMetadata).toMatchObject({
      name: 'obsidian-abyss-tasks',
      description: 'A task management interface for Markdown tasks.',
      repository: {
        type: 'git',
        url: 'git@github.com:flowing-abyss/obsidian-abyss-tasks.git',
      },
    });
    expect(lockfile).toContain("lockfileVersion: '9.0'");
    expect(lockfile).toMatch(/importers:\n\n {2}\.:/u);
  });
});
