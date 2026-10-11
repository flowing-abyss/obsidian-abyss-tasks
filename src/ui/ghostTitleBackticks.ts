// The existing inline grammar with ticks exposed as runs preserves match and escape priority.
const INLINE_RUN_RE = /(\*\*|__|~~)((?:.*?[^\\\n\r\u2028\u2029])??)\1|(\\[*_~`])|`+/gu;

interface TickRun {
  from: number;
  end: number;
  following: number;
}

function tickRuns(text: string): TickRun[] {
  let maximum = 0;
  // LS/PS are barriers for dot-based content; the caller already normalized CR/LF.
  return [...text.matchAll(/`+|[\u2028\u2029]/gu)]
    .reverse()
    .map((match) => {
      const run = {
        from: match.index + Number(text[match.index - 1] === '\\'),
        end: match.index + match[0].length,
        following: maximum,
      };
      maximum = match[0][0] === '`' ? Math.max(maximum, run.end - run.from) : 0;
      return run;
    })
    .reverse();
}

function tickPair(
  text: string,
  match: RegExpExecArray,
  runs: readonly TickRun[],
  at: number,
): { content: string; end: number } {
  const length = match[0].length;
  const width = Math.max(Math.floor(length / 2), Math.min(length, runs[at]?.following ?? 0));
  if (width === 0) return { content: match[0], end: match.index + length };
  let close = match.index + width;
  if (width * 2 > length) {
    // A successful search consumes everything through this closer. Across the pass these
    // searches visit disjoint ranges; no opener retries shorter widths against the suffix.
    let run: TickRun | undefined;
    let next = at;
    do {
      run = runs[++next];
    } while (run !== undefined && run.end - run.from < width);
    if (run !== undefined) close = run.from;
  }
  return { content: text.slice(match.index + width, close), end: close + width };
}

/** One pass with greedy opener width, optional empty content, and the first eligible closer. */
export function replaceGhostTitleBackticks(text: string): string {
  const runs = tickRuns(text);
  const pieces: string[] = [];
  let copied = 0;
  let at = 0;
  INLINE_RUN_RE.lastIndex = 0;
  for (let match = INLINE_RUN_RE.exec(text); match !== null; match = INLINE_RUN_RE.exec(text)) {
    let content = match[2] ?? match[3] ?? '';
    if (match[0][0] === '`') {
      while ((runs[at]?.end ?? text.length) <= match.index) at++;
      const pair = tickPair(text, match, runs, at);
      content = pair.content;
      INLINE_RUN_RE.lastIndex = pair.end;
    }
    pieces.push(text.slice(copied, match.index), content);
    copied = INLINE_RUN_RE.lastIndex;
  }
  pieces.push(text.slice(copied));
  return pieces.join('');
}
