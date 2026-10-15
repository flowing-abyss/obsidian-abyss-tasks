import { consumeMarkdownFenceLine, type MarkdownFence } from './fences';
import { inlineCodeRanges, type SourceRange } from './inlineCode';

export interface TaskDescriptionStructure {
  readonly markdown: string;
  readonly markers: readonly SourceRange[];
}
interface ListItem {
  readonly indent: number;
  readonly content: number;
  readonly kind: string;
}
interface StructureState {
  readonly items: ListItem[];
  paragraph: boolean;
  blank: boolean;
  fence: MarkdownFence | undefined;
}

function columns(text: string, start = 0): number {
  let column = start;
  for (const char of text) column += char === '\t' ? 4 - (column % 4) : 1;
  return column;
}

interface ParsedMarker extends SourceRange, ListItem {
  readonly interrupts: boolean;
}
function parsedMarker(line: string): ParsedMarker | undefined {
  const match = /^([ \t]*)([-+*]|\d{1,9}[.)])([ \t]+|$)/u.exec(line);
  if (match === null) return undefined;
  const prefix = match[1] ?? '',
    token = match[2] ?? '';
  const indent = columns(prefix),
    markerEnd = indent + token.length;
  const padding = columns(match[3] ?? '', markerEnd) - markerEnd;
  // More than four spaces starts indented content, outside this structural subset.
  if (padding > 4) return undefined;
  const ordered = /[.)]$/u.test(token),
    kind = ordered ? token.slice(-1) : token;
  return {
    from: prefix.length,
    to: match[0].length,
    indent,
    content: markerEnd + Math.max(1, padding),
    kind,
    interrupts: line.slice(match[0].length).trim().length > 0 && (!ordered || token === `1${kind}`),
  };
}
function siblingOf(item: ParsedMarker, previous: ListItem | undefined): boolean {
  return previous !== undefined && item.indent < previous.content;
}
function parentContent(items: readonly ListItem[], sibling: boolean): number {
  return items[items.length - (sibling ? 2 : 1)]?.content ?? 0;
}
function listMarker(line: string, state: StructureState): SourceRange | undefined {
  const marker = parsedMarker(line);
  if (marker === undefined) return undefined;
  const items = state.items;
  while (items.length > 0 && marker.indent < (items[items.length - 1]?.indent ?? 0)) items.pop();
  const previous = items[items.length - 1],
    sibling = siblingOf(marker, previous);
  const base = parentContent(items, sibling);
  if (marker.indent < base || marker.indent > base + 3) return undefined;
  if (!canStartItem(marker, previous, state.paragraph, sibling)) return undefined;
  if (sibling) items.pop();
  items.push(marker);
  return { from: marker.from, to: marker.to };
}
function canStartItem(
  marker: ParsedMarker,
  previous: ListItem | undefined,
  paragraph: boolean,
  sibling: boolean,
): boolean {
  return !paragraph || marker.interrupts || (sibling && previous?.kind === marker.kind);
}

function unsupportedBlock(line: string): boolean {
  const block = line.trimStart();
  return (
    /^(?:#{1,6}(?:\s|$)|>|<[A-Za-z!/]|\[[^\]]+\]:)/u.test(block) ||
    /^(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})$/u.test(block) ||
    /^=+\s*$/u.test(block)
  );
}
interface DescriptionLine {
  readonly text: string;
  readonly ending: string;
  readonly offset: number;
}
interface AnalysisState extends StructureState {
  readonly markers: SourceRange[];
  readonly chunks: string[];
  readonly code: readonly SourceRange[];
  codeAt: number;
}
function protectedLine(line: DescriptionLine, state: AnalysisState): boolean {
  const consumed = consumeMarkdownFenceLine(state.fence, line.text);
  state.fence = consumed.fence;
  if (!consumed.isContent) state.paragraph = false;
  while ((state.code[state.codeAt]?.to ?? Infinity) <= line.offset) state.codeAt++;
  const range = state.code[state.codeAt];
  return (
    !consumed.isContent ||
    (range !== undefined && range.from < line.offset && range.to > line.offset)
  );
}
function unindentedProse(text: string): boolean {
  return /^\S/u.test(text) && !/^(?:[-+*]|\d{1,9}[.)])(?:[ \t]|$)/u.test(text);
}
function consumeStructure(line: DescriptionLine, state: AnalysisState): boolean {
  if (protectedLine(line, state)) return true;
  if (unsupportedBlock(line.text)) return false;
  const marker = listMarker(line.text, state);
  if (marker !== undefined) {
    state.markers.push({ from: line.offset + marker.from, to: line.offset + marker.to });
    state.fence = consumeMarkdownFenceLine(undefined, line.text.slice(marker.to)).fence;
  } else if (unindentedProse(line.text) && state.items.length > 0) {
    // Descriptions intentionally require indentation for list continuation.
    if (!state.blank) state.chunks.push(line.ending);
    state.items.length = 0;
  }
  state.blank = line.text.trim().length === 0;
  state.paragraph = !state.blank;
  return true;
}
/** A bounded description policy, not a Markdown renderer. Unknown blocks retain full proof checks. */
export function analyzeTaskDescription(source: string): TaskDescriptionStructure {
  const state: AnalysisState = {
    markers: [],
    chunks: [],
    code: inlineCodeRanges(source),
    codeAt: 0,
    items: [],
    paragraph: false,
    blank: true,
    fence: undefined,
  };
  const lines = source.split(/(\r\n|\n|\r)/u);
  let offset = 0,
    previousEnding = '\n';
  for (let index = 0; index < lines.length; index += 2) {
    const text = lines[index] ?? '',
      ending = lines[index + 1] ?? '';
    if (!consumeStructure({ text, ending: previousEnding, offset }, state))
      return { markdown: source, markers: [] };
    state.chunks.push(text, ending);
    offset += text.length + ending.length;
    previousEnding = ending;
  }
  return { markdown: state.chunks.join(''), markers: state.markers };
}
