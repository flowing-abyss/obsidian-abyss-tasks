import { replaceUnlessPreceded } from '../markdown/precedingCodePoint';
import type { TaskSnapshot } from '../tasks';

// Pair content never ends in a backslash: its last character class excludes it, and for inline
// pairs also the line terminators that `.` excludes. Group 3 is an escaped inline delimiter, which
// `$2$3` keeps, so no pair starts right after a backslash. `isEmphasisNeighbour` refuses an
// emphasis pair right after a backslash, an asterisk, or an underscore.
const PAIRED_INLINE_DELIMITER_RE = /(\*\*|__|~~|`+)((?:.*?[^\\\n\r\u2028\u2029])??)\1|(\\[*_~`])/gu;
const PAIRED_EMPHASIS_RE = /([*_])([^*_]*?[^*_\\])\1/gu;
const PAIR_DELIMITER_RE = /[*_~`]/u;

function isEmphasisNeighbour(previous: string): boolean {
  return previous === '\\' || previous === '*' || previous === '_';
}

function pairContent(match: RegExpExecArray): string {
  return match[2] ?? '';
}

/** Inert, single-line text for calendar span continuations and forecast occurrences. */
export function plainGhostTaskTitle(task: TaskSnapshot): string {
  let text = task.title.replace(/[\r\n]+/gu, ' ');
  // Every pair needs one of these delimiters, so without one the passes change nothing.
  if (PAIR_DELIMITER_RE.test(text)) {
    let previous: string;
    do {
      previous = text;
      text = text.replace(PAIRED_INLINE_DELIMITER_RE, '$2$3');
      text = replaceUnlessPreceded(PAIRED_EMPHASIS_RE, text, isEmphasisNeighbour, pairContent);
    } while (text !== previous);
  }
  return text
    .replace(/\\([*_~`\\])/gu, '$1')
    .replace(/\s{2,}/gu, ' ')
    .trim();
}
