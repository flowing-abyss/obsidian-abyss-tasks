/** A native note can change before Obsidian delivers its metadata event. */
export interface NoteFileStamp {
  readonly mtime: number;
  readonly size: number;
}

export function sameNoteFileStamp(
  left: NoteFileStamp | undefined,
  right: NoteFileStamp | undefined,
): boolean {
  return left?.mtime === right?.mtime && left?.size === right?.size;
}
