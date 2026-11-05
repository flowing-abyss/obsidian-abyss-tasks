export { consumeMarkdownFenceLine, type MarkdownFence } from '../../../markdown/fences';
export { parseMarkdownFrontmatter } from '../../../markdown/readFrontmatter';

const DESCRIPTION_RE = /^[\s>]*- > (.*)/u;

export function isTaskBlockBlankLine(line: string): boolean {
  return /^[\s>]*$/u.test(line);
}

/** A description line's text as the task's description holds it, and where that text starts. */
export interface TaskDescriptionLine {
  readonly text: string;
  readonly column: number;
}

/**
 * Reads a `- > ` description line: the exact text after the marker. Any other line gives
 * nothing.
 */
export function readTaskDescriptionLine(line: string): TaskDescriptionLine | undefined {
  const match = DESCRIPTION_RE.exec(line);
  if (match == null) return undefined;
  const content = match[1] ?? '';
  return { text: content, column: match[0].length - content.length };
}
