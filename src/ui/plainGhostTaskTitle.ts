import type { TaskSnapshot } from '../tasks';

const PAIRED_INLINE_DELIMITER_RE = /(?<!\\)(\*\*|__|~~|`+)(.*?)(?<!\\)\1/gu;
const PAIRED_EMPHASIS_RE = /(?<![\\*_])([*_])([^*_]+?)(?<!\\)\1/gu;

/** Inert, single-line text for non-terminal calendar span continuations. */
export function plainGhostTaskTitle(task: TaskSnapshot): string {
  let text = task.title.replace(/[\r\n]+/gu, ' ');
  let previous: string;
  do {
    previous = text;
    text = text.replace(PAIRED_INLINE_DELIMITER_RE, '$2').replace(PAIRED_EMPHASIS_RE, '$2');
  } while (text !== previous);
  return text
    .replace(/\\([*_~`\\])/gu, '$1')
    .replace(/\s{2,}/gu, ' ')
    .trim();
}
