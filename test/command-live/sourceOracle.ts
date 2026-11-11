import { inlineCodeRanges } from '../../src/markdown/inlineCode';
import { parseLinks, parseSourceReferences } from '../../src/markdown/links';
/** Compare destinations, excluding Markdown labels, embeds and inline code from bare URLs. */
export function hasSourceDestination(text: string, source: string): boolean {
  const links = parseSourceReferences(text);
  if (
    parseLinks(text).some(
      (link) => link.type === 'md' && markdownDestination(link.target) === source,
    )
  )
    return true;
  const excluded = [
    ...inlineCodeRanges(text),
    ...links.map((link) => ({ from: link.index, to: link.index + link.raw.length })),
  ];
  const bare = text
    .split('')
    .map((char, index) =>
      excluded.some((range) => index >= range.from && index < range.to) ? ' ' : char,
    )
    .join('');
  for (const match of bare.matchAll(/https?:\/\/[^\s<>"'`]+/gu)) {
    if (match.index > 0 && !/[\s(:<]/u.test(bare.charAt(match.index - 1))) continue;
    let destination = match[0];
    while (
      /[.,;:!?]/u.test(destination.slice(-1)) ||
      (destination.endsWith(')') &&
        [...destination].filter((char) => char === ')').length >
          [...destination].filter((char) => char === '(').length)
    )
      destination = destination.slice(0, -1);
    if (destination === source) return true;
  }
  return false;
}
function markdownDestination(text: string): string | undefined {
  const match = /^(?:<([^>]+)>|(\S+))(?:\s+["'][^]*["'])?$/u.exec(text.trim());
  return match?.[1] ?? match?.[2];
}
