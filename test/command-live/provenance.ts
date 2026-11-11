import { Platform } from 'obsidian';
interface SourceFileFingerprint {
  path: string;
  sha256: string;
}
/** Hash only the selected source tree; symbolic links cannot escape its authority. */
export async function sourceFingerprint(root: string) {
  if (!Platform.isDesktop) throw new Error('Source fingerprints require the desktop evaluator');
  const [{ createHash }, { readdir, readFile }, { join }] = await Promise.all([
    import('node:crypto'),
    import('node:fs/promises'),
    import('node:path'),
  ]);
  const files: SourceFileFingerprint[] = [];
  async function visit(directory: string, prefix: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw new Error('source-symlink-not-allowed');
      const path = `${prefix}${entry.name}`;
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute, `${path}/`);
      else if (entry.isFile())
        files.push({
          path,
          sha256: createHash('sha256')
            .update(await readFile(absolute))
            .digest('hex'),
        });
    }
  }
  await visit(root, '');
  files.sort((a, b) => {
    if (a.path === b.path) return 0;
    return a.path < b.path ? -1 : 1;
  });
  return { treeHash: createHash('sha256').update(JSON.stringify(files)).digest('hex'), files };
}
