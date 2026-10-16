import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { FIXTURE_FOLDER } from './fixture.ts';

interface Journal {
  schemaVersion: 1;
  vault: string;
  output: string;
  pid: number;
  configDir: string;
  restored: boolean;
  originals: Record<string, string | null>;
}

export async function canonicalPath(file: string): Promise<string> {
  try {
    return await realpath(file);
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    return path.join(await canonicalPath(path.dirname(path.resolve(file))), path.basename(file));
  }
}

function checkProcess(journal: Journal): void {
  if (journal.pid === process.pid || journal.restored) return;
  try {
    process.kill(journal.pid, 0);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ESRCH') return;
    throw error;
  }
  throw new Error('The profile process is still running; stop it before recovery');
}

function validOriginals(originals: unknown): boolean {
  return (
    typeof originals === 'object' &&
    originals !== null &&
    !Array.isArray(originals) &&
    Object.values(originals).every((x: unknown) => x === null || typeof x === 'string')
  );
}

function parseJournal(value: unknown): Journal {
  if (typeof value !== 'object' || value === null) throw new Error('Invalid recovery journal');
  const v = value as Record<string, unknown>;
  if (
    v['schemaVersion'] !== 1 ||
    typeof v['pid'] !== 'number' ||
    typeof v['restored'] !== 'boolean' ||
    !['vault', 'output', 'configDir'].every((k) => typeof v[k] === 'string')
  )
    throw new Error('Invalid recovery identity');
  const originals = v['originals'];
  if (!Number.isInteger(v['pid']) || Number(v['pid']) <= 0)
    throw new Error('Invalid process identity');
  if (!validOriginals(originals)) throw new Error('Invalid recovery originals');
  return value as Journal;
}

async function readOptional(file: string): Promise<Buffer | null> {
  try {
    return await readFile(file);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  }
}

async function safePath(root: string, relative: string): Promise<string> {
  if (path.isAbsolute(relative) || relative.split(/[\\/]/u).some((p) => p === '..' || p === ''))
    throw new Error(`Unsafe relative path: ${relative}`);
  let current = root;
  for (const part of relative.split('/')) {
    current = path.join(current, part);
    try {
      if ((await lstat(current)).isSymbolicLink())
        throw new Error(`Refusing symbolic link: ${current}`);
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    }
  }
  return current;
}

export class VaultTransaction {
  private constructor(private readonly journal: Journal) {}

  static async begin(vault: string, output: string, configDir: string): Promise<VaultTransaction> {
    const root = await realpath(vault);
    if (path.basename(root) !== 'dev-vault-tasks')
      throw new Error('Only dev-vault-tasks is allowed');
    const destination = await canonicalPath(output);
    if (destination === root || destination.startsWith(`${root}${path.sep}`))
      throw new Error('Output must be outside the vault');
    const fixture = await safePath(root, FIXTURE_FOLDER);
    const lock = await safePath(root, `${configDir}/abyss-profile.lock`);
    if ((await readOptional(lock)) !== null) throw new Error(`Performance lock exists: ${lock}`);
    try {
      await lstat(fixture);
      throw new Error('Performance fixture folder is occupied');
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    }
    await mkdir(destination, { recursive: true });
    await writeFile(lock, JSON.stringify({ output: destination, pid: process.pid }), {
      flag: 'wx',
    }).catch((error: unknown) => {
      throw new AggregateError([error], `Performance lock unavailable: ${lock}`);
    });
    const tx = new VaultTransaction({
      schemaVersion: 1,
      vault: root,
      output: destination,
      pid: process.pid,
      configDir,
      restored: false,
      originals: {},
    });
    try {
      await tx.save();
      await mkdir(fixture);
    } catch (error) {
      await rm(lock);
      throw error;
    }
    return tx;
  }

  static async load(output: string): Promise<VaultTransaction> {
    const value: unknown = JSON.parse(await readFile(path.join(output, 'recovery.json'), 'utf8'));
    const journal = parseJournal(value);
    if (
      (await canonicalPath(output)) !== journal.output ||
      path.basename(journal.vault) !== 'dev-vault-tasks'
    )
      throw new Error('Recovery identity mismatch');
    if ((await realpath(journal.vault)) !== journal.vault) throw new Error('Recovery vault moved');
    checkProcess(journal);
    return new VaultTransaction(journal);
  }

  get vault(): string {
    return this.journal.vault;
  }

  private async save(): Promise<void> {
    const file = path.join(this.journal.output, 'recovery.json');
    await writeFile(`${file}.tmp`, JSON.stringify(this.journal, null, 2), { mode: 0o600 });
    await rename(`${file}.tmp`, file);
  }

  private async target(relative: string): Promise<string> {
    const managed = ['main.js', 'styles.css', 'manifest.json', 'data.json', 'state.json'].map(
      (name) => `${this.journal.configDir}/plugins/abyss-tasks/${name}`,
    );
    if (!managed.includes(relative) && !relative.startsWith(`${FIXTURE_FOLDER}/`))
      throw new Error(`Unowned path: ${relative}`);
    return await safePath(this.vault, relative);
  }

  async write(relative: string, content: Buffer): Promise<void> {
    if (this.journal.restored) throw new Error('Transaction already restored');
    const file = await this.target(relative);
    if (!Object.prototype.hasOwnProperty.call(this.journal.originals, relative)) {
      this.journal.originals[relative] = (await readOptional(file))?.toString('base64') ?? null;
      await this.save();
    }
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content);
  }

  async restore(): Promise<void> {
    if (this.journal.restored) return;
    const errors: unknown[] = [];
    for (const [relative, original] of Object.entries(this.journal.originals).reverse()) {
      try {
        const file = await this.target(relative);
        if (original === null) await rm(file, { force: true });
        else await writeFile(file, Buffer.from(original, 'base64'));
      } catch (error) {
        errors.push(error);
      }
    }
    try {
      await this.removeEmptyFixtureDirectories();
    } catch (error) {
      errors.push(error);
    }
    if (errors.length > 0)
      throw new AggregateError(
        errors,
        'Restoration incomplete; retain recovery.json and retry recovery',
      );
    if (!(await this.verify())) throw new Error('Restoration hash mismatch');
    this.journal.restored = true;
    await this.save();
    await rm(await safePath(this.vault, `${this.journal.configDir}/abyss-profile.lock`));
  }

  private async removeEmptyFixtureDirectories(): Promise<void> {
    const directories = new Set<string>([FIXTURE_FOLDER]);
    for (const relative of Object.keys(this.journal.originals).filter((p) =>
      p.startsWith(`${FIXTURE_FOLDER}/`),
    )) {
      let directory = path.dirname(relative);
      while (directory !== '.') {
        directories.add(directory);
        directory = path.dirname(directory);
      }
    }
    for (const directory of [...directories].sort((a, b) => b.length - a.length)) {
      try {
        await rmdir(await safePath(this.vault, directory));
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
      }
    }
  }

  async verify(): Promise<boolean> {
    for (const [relative, original] of Object.entries(this.journal.originals)) {
      const content = await readOptional(await this.target(relative));
      if ((content?.toString('base64') ?? null) !== original) return false;
    }
    return true;
  }
}

export function sha256(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}
