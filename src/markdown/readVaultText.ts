import type { TFile, Vault } from 'obsidian';
import { sameNoteFileStamp } from './noteFileStamp';

export class NoteSourceChangedError extends Error {
  constructor(readonly reason: 'changed' | 'contrary-text' = 'changed') {
    super('Note source changed during acquisition.');
    this.name = 'NoteSourceChangedError';
  }
}

/** The source owner still rechecks its original file, stamp and policy after this await. */
export async function readVaultText(
  vault: Vault,
  file: TFile,
  mode: 'fresh' | 'cached' = 'fresh',
): Promise<string> {
  const path = file.path,
    stamp = { ...file.stat };
  const current = (): boolean =>
    vault.getAbstractFileByPath(path) === file && sameNoteFileStamp(stamp, file.stat);
  if (!current()) throw new NoteSourceChangedError();
  const text = mode === 'cached' ? await vault.cachedRead(file) : await vault.read(file);
  if (!current()) throw new NoteSourceChangedError();
  if (new TextEncoder().encode(text).byteLength === stamp.size) return text;
  const bytes = await vault.readBinary(file);
  if (!current() || bytes.byteLength !== stamp.size) throw new NoteSourceChangedError();
  const raw = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  if (raw !== `\uFEFF${text}`) throw new NoteSourceChangedError('contrary-text');
  return raw;
}
