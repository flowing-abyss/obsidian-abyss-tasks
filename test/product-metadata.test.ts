import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '..');
const manifest = JSON.parse(readFileSync(resolve(ROOT, 'manifest.json'), 'utf8')) as {
  id: string;
  name: string;
  description: string;
};
const packageMetadata = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')) as {
  name: string;
  description: string;
  repository: { type: string; url: string };
};
const lockfile = JSON.parse(readFileSync(resolve(ROOT, 'package-lock.json'), 'utf8')) as {
  name: string;
  packages: Record<string, { name?: string }>;
};

describe('Abyss Tasks product metadata', () => {
  it('uses the approved product identity and SSH repository while preserving the plugin ID', () => {
    expect(manifest).toMatchObject({
      id: 'task-calendar',
      name: 'Abyss Tasks',
      description: 'A task management interface for Markdown tasks in Obsidian',
    });
    expect(packageMetadata).toMatchObject({
      name: 'obsidian-abyss-tasks',
      description: 'A task management interface for Markdown tasks in Obsidian',
      repository: {
        type: 'git',
        url: 'git@github.com:flowing-abyss/obsidian-abyss-tasks.git',
      },
    });
    expect(lockfile.name).toBe('obsidian-abyss-tasks');
    expect(lockfile.packages['']?.name).toBe('obsidian-abyss-tasks');
  });
});
