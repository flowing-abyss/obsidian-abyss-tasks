// A `.md` extension, in any case, that a character other than `/` comes before.
const MARKDOWN_EXTENSION = /[^/]\.md$/iu;

/** A path without the `.md` extension of its last segment, as Obsidian names a note file. */
export function withoutMarkdownExtension(path: string): string {
  return MARKDOWN_EXTENSION.test(path) ? path.slice(0, -3) : path;
}

/** The name Obsidian shows for a note file: its path's last segment without a `.md` extension. */
export function noteNameOfPath(path: string): string {
  return withoutMarkdownExtension(path.slice(path.lastIndexOf('/') + 1));
}
