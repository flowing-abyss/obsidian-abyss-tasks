export interface MarkdownFence {
  readonly marker: '`' | '~';
  readonly length: number;
  readonly quoteDepth: number;
}

interface MarkdownFenceLine {
  readonly fence: MarkdownFence | undefined;
  readonly isContent: boolean;
  readonly opened: boolean;
}

const CONTAINER_PREFIX_RE = /^([\t >]*)/u;
const FENCE_OPEN_RE = /^[\t >]*(`{3,}|~{3,})/u;
const FENCE_CLOSE_RE = /^[\t >]*(`{3,}|~{3,})[\t ]*$/u;

function quoteDepth(line: string): number {
  const prefix = CONTAINER_PREFIX_RE.exec(line)?.[1] ?? '';
  return [...prefix].filter((character) => character === '>').length;
}

function fenceMarker(token: string | undefined): '`' | '~' | undefined {
  const marker = token?.[0];
  return marker === '`' || marker === '~' ? marker : undefined;
}

function retainedFence(
  active: MarkdownFence | undefined,
  depth: number,
): MarkdownFence | undefined {
  if (active === undefined || depth < active.quoteDepth) return undefined;
  return active;
}

function closesFence(active: MarkdownFence, line: string, depth: number): boolean {
  if (depth !== active.quoteDepth) return false;
  const token = FENCE_CLOSE_RE.exec(line)?.[1];
  return (
    token !== undefined && fenceMarker(token) === active.marker && token.length >= active.length
  );
}

export function consumeMarkdownFenceLine(
  active: MarkdownFence | undefined,
  line: string,
): MarkdownFenceLine {
  const markdownLine = line.endsWith('\r') ? line.slice(0, -1) : line;
  const depth = quoteDepth(markdownLine);
  const retained = retainedFence(active, depth);
  if (retained !== undefined) {
    return {
      fence: closesFence(retained, markdownLine, depth) ? undefined : retained,
      isContent: false,
      opened: false,
    };
  }

  const token = FENCE_OPEN_RE.exec(markdownLine)?.[1];
  const marker = fenceMarker(token);
  if (token === undefined || marker === undefined) {
    return { fence: undefined, isContent: true, opened: false };
  }
  return {
    fence: { marker, length: token.length, quoteDepth: depth },
    isContent: false,
    opened: true,
  };
}
