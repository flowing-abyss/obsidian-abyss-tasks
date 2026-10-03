export { consumeMarkdownFenceLine, type MarkdownFence } from '../../../markdown/fences';
import { parseYaml } from 'obsidian';

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
 * Reads a `- > ` description line: the text after the marker, trimmed. Any other line gives
 * nothing.
 */
export function readTaskDescriptionLine(line: string): TaskDescriptionLine | undefined {
  const match = DESCRIPTION_RE.exec(line);
  if (match == null) return undefined;
  const content = match[1] ?? '';
  return { text: content.trim(), column: match[0].length - content.trimStart().length };
}

type MarkdownFrontmatter =
  | { readonly type: 'none'; readonly contentStart: 0 }
  | {
      readonly type: 'valid';
      readonly contentStart: number;
      readonly value: Record<string, unknown> | undefined;
    }
  | { readonly type: 'invalid' };

export function parseMarkdownFrontmatter(lines: readonly string[]): MarkdownFrontmatter {
  const first = lines[0]?.replace(/^\uFEFF/u, '').trim();
  if (first !== '---') return { type: 'none', contentStart: 0 };
  const closing = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
  if (closing < 0) return { type: 'invalid' };
  try {
    const parsed: unknown = parseYaml(lines.slice(1, closing).join('\n'));
    if (parsed === null || parsed === undefined) {
      return { type: 'valid', contentStart: closing + 1, value: undefined };
    }
    if (typeof parsed !== 'object' || Array.isArray(parsed)) return { type: 'invalid' };
    return {
      type: 'valid',
      contentStart: closing + 1,
      value: parsed as Record<string, unknown>,
    };
  } catch {
    return { type: 'invalid' };
  }
}
