import { parseLinks } from '../markdown/links';

export interface CommentPreview {
  readonly markdown: string;
  readonly fullOccurrences: readonly number[];
}

/** A first-line token grants editing only when its raw bytes and offset exist in the full field. */
export function commentPreview(markdown: string): CommentPreview {
  const firstLine = markdown.split(/\r?\n|\r/u, 1)[0] ?? '';
  const fullTokens = parseLinks(markdown);
  return {
    markdown: firstLine,
    fullOccurrences: parseLinks(firstLine).map((token) =>
      fullTokens.findIndex((full) => full.raw === token.raw && full.index === token.index),
    ),
  };
}
