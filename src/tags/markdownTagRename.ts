import { inlineCodeRanges, type SourceRange } from '../markdown/inlineCode';

export type TagRenameScope = 'exact' | 'prefix';

const TAG_CHARACTER = String.raw`(?:[\p{L}\p{M}\p{N}\p{Pc}-]|\p{Extended_Pictographic}|\p{Regional_Indicator}|\p{Emoji_Modifier}|\uFE0F|\u200D)`;
const VALID_TAG = new RegExp(String.raw`^#${TAG_CHARACTER}+(?:/${TAG_CHARACTER}+)*$`, 'u');
const ALL_NUMERIC = /^\p{N}+$/u;

export function normalizeTag(value: string): string | null {
  const trimmed = value.trim();
  const tag = trimmed.startsWith('#') ? trimmed : `#${trimmed}`;
  if (!VALID_TAG.test(tag)) return null;
  return ALL_NUMERIC.test(tag.slice(1).replace(/\//gu, '')) ? null : tag;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function replacementPattern(tag: string, scope: TagRenameScope): RegExp {
  const suffix = scope === 'exact' ? `(?!${TAG_CHARACTER}|/)` : `(?=/|(?!${TAG_CHARACTER}|/))`;
  return new RegExp(`(?<!#)${escapeRegExp(tag)}${suffix}`, 'gu');
}

function replaceCanonicalTag(
  value: string,
  oldTag: string,
  newTag: string,
  scope: TagRenameScope,
): string {
  if (value === oldTag) return newTag;
  if (scope === 'prefix' && value.startsWith(`${oldTag}/`)) {
    return `${newTag}${value.slice(oldTag.length)}`;
  }
  return value;
}

interface TagReplacement {
  readonly oldTag: string;
  readonly newTag: string;
  readonly scope: TagRenameScope;
}

interface YamlScalarParts {
  readonly leading: string;
  readonly scalar: string;
  readonly trailing: string;
}

function splitYamlScalarWhitespace(source: string): YamlScalarParts {
  let from = 0;
  while (from < source.length && /\s/u.test(source[from] ?? '')) from++;
  let to = source.length;
  while (to > from && /\s/u.test(source[to - 1] ?? '')) to--;
  return {
    leading: source.slice(0, from),
    scalar: source.slice(from, to),
    trailing: source.slice(to),
  };
}

function splitYamlScalarComment(scalar: string): {
  readonly value: string;
  readonly comment: string;
} {
  const commentAt = yamlCommentStart(scalar);
  return commentAt < 0
    ? { value: scalar, comment: '' }
    : { value: scalar.slice(0, commentAt), comment: scalar.slice(commentAt) };
}

function yamlScalarQuote(scalar: string): string {
  if (scalar.length < 2) return '';
  const opener = scalar[0] ?? '';
  if (opener !== '"' && opener !== "'") return '';
  return scalar[scalar.length - 1] === opener ? opener : '';
}

function replaceYamlScalarValue(
  scalar: string,
  replacement: TagReplacement,
): { readonly quote: string; readonly displayed: string } | null {
  const quote = yamlScalarQuote(scalar);
  const rawValue = quote.length > 0 ? scalar.slice(1, -1) : scalar;
  if (rawValue.length === 0) return null;
  const hasHash = rawValue.startsWith('#');
  const canonical = hasHash ? rawValue : `#${rawValue}`;
  const updated = replaceCanonicalTag(
    canonical,
    replacement.oldTag,
    replacement.newTag,
    replacement.scope,
  );
  if (updated === canonical) return null;
  return { quote, displayed: hasHash ? updated : updated.slice(1) };
}

function transformYamlScalar(
  source: string,
  oldTag: string,
  newTag: string,
  scope: TagRenameScope,
): string {
  const commentPrefixEnd = leadingYamlCommentPrefixEnd(source);
  if (commentPrefixEnd > 0) {
    return (
      source.slice(0, commentPrefixEnd) +
      transformYamlScalar(source.slice(commentPrefixEnd), oldTag, newTag, scope)
    );
  }
  const parts = splitYamlScalarWhitespace(source);
  if (parts.scalar.length === 0) return source;
  const content = splitYamlScalarComment(parts.scalar);
  const updated = replaceYamlScalarValue(content.value, { oldTag, newTag, scope });
  if (updated === null) return source;
  return `${parts.leading}${updated.quote}${updated.displayed}${updated.quote}${content.comment}${parts.trailing}`;
}

interface YamlQuoteStep {
  readonly index: number;
  readonly quote: string;
}

function yamlQuoteStep(source: string, index: number, quote: string): YamlQuoteStep | null {
  if (quote.length === 0) return null;
  const character = source[index] ?? '';
  if (quote === '"' && character === '\\') return { index: index + 1, quote };
  if (character !== quote) return { index, quote };
  if (quote === "'" && source[index + 1] === "'") return { index: index + 1, quote };
  return { index, quote: '' };
}

function yamlCommentMarker(source: string, index: number): boolean {
  return source[index] === '#' && /\s/u.test(source[index - 1] ?? '');
}

function yamlCommentOffset(source: string, marker: number): number {
  let commentAt = marker;
  while (commentAt > 0 && /[ \t]/u.test(source[commentAt - 1] ?? '')) commentAt--;
  return commentAt;
}

function leadingYamlCommentPrefixEnd(source: string): number {
  let cursor = 0;
  let sawComment = false;
  while (cursor < source.length) {
    const newline = source.indexOf('\n', cursor);
    const lineEnd = newline < 0 ? source.length : newline + 1;
    const coreEnd = newline < 0 ? lineEnd : newline;
    const trimmed = source.slice(cursor, coreEnd).replace(/\r$/u, '').trim();
    if (trimmed.length === 0) {
      cursor = lineEnd;
      continue;
    }
    if (!trimmed.startsWith('#')) break;
    sawComment = true;
    cursor = lineEnd;
  }
  return sawComment ? cursor : 0;
}

function yamlCommentStart(source: string): number {
  let quote = '';
  let index = 0;
  while (index < source.length) {
    const character = source[index] ?? '';
    const quoted = yamlQuoteStep(source, index, quote);
    if (quoted != null) {
      index = quoted.index;
      quote = quoted.quote;
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (index > 0 && yamlCommentMarker(source, index))
      return yamlCommentOffset(source, index);
    index++;
  }
  return -1;
}

interface YamlFlowScanState {
  quote: string;
  comment: boolean;
}

type YamlFlowSignal = 'none' | 'close' | 'separator';

interface YamlFlowStep {
  readonly index: number;
  readonly signal: YamlFlowSignal;
}

function yamlFlowStep(source: string, index: number, state: YamlFlowScanState): YamlFlowStep {
  const character = source[index] ?? '';
  if (state.comment) {
    if (character === '\n') state.comment = false;
    return { index, signal: 'none' };
  }
  const quoted = yamlQuoteStep(source, index, state.quote);
  if (quoted != null) {
    state.quote = quoted.quote;
    return { index: quoted.index, signal: 'none' };
  }
  if (character === '"' || character === "'") {
    state.quote = character;
    return { index, signal: 'none' };
  }
  if (yamlCommentMarker(source, index)) {
    state.comment = true;
    return { index, signal: 'none' };
  }
  if (character === ']') return { index, signal: 'close' };
  return { index, signal: character === ',' ? 'separator' : 'none' };
}

function flowSequenceClose(source: string): number {
  const open = source.indexOf('[');
  if (open < 0) return -1;
  const state: YamlFlowScanState = { quote: '', comment: false };
  let index = open + 1;
  while (index < source.length) {
    const step = yamlFlowStep(source, index, state);
    index = step.index;
    if (step.signal === 'close') return index;
    index++;
  }
  return -1;
}

function transformFlowSequence(
  source: string,
  oldTag: string,
  newTag: string,
  scope: TagRenameScope,
): string {
  const open = source.indexOf('[');
  const close = flowSequenceClose(source);
  if (open < 0 || close <= open) return source;

  const inner = source.slice(open + 1, close);
  const parts: string[] = [];
  let start = 0;
  const state: YamlFlowScanState = { quote: '', comment: false };
  let index = 0;
  while (index < inner.length) {
    const step = yamlFlowStep(inner, index, state);
    index = step.index;
    if (step.signal === 'separator') {
      parts.push(inner.slice(start, index));
      parts.push(',');
      start = index + 1;
    }
    index++;
  }
  parts.push(inner.slice(start));

  const transformed = parts
    .map((part) => (part === ',' ? part : transformYamlScalar(part, oldTag, newTag, scope)))
    .join('');
  return source.slice(0, open + 1) + transformed + source.slice(close);
}

function linesPreservingEndings(source: string): readonly string[] {
  const lines: string[] = [];
  let from = 0;
  while (from < source.length) {
    const newline = source.indexOf('\n', from);
    const to = newline < 0 ? source.length : newline + 1;
    lines.push(source.slice(from, to));
    from = to;
  }
  return lines;
}

interface YamlProperty {
  readonly key: string;
  readonly separator: string;
  readonly value: string;
}

function yamlProperty(source: string): YamlProperty | null {
  const colon = source.indexOf(':');
  if (colon <= 0) return null;
  const key = source.slice(0, colon);
  const first = key[0] ?? '';
  if (/\s/u.test(first) || first === '#' || first === ':') return null;

  let valueFrom = colon + 1;
  while (source[valueFrom] === ' ' || source[valueFrom] === '\t') valueFrom++;
  return {
    key,
    separator: source.slice(colon + 1, valueFrom),
    value: source.slice(valueFrom),
  };
}

function yamlListItem(source: string): { readonly prefix: string; readonly value: string } | null {
  let marker = 0;
  while (source[marker] === ' ' || source[marker] === '\t') marker++;
  if (source[marker] !== '-') return null;

  let valueFrom = marker + 1;
  if (source[valueFrom] !== ' ' && source[valueFrom] !== '\t') return null;
  while (source[valueFrom] === ' ' || source[valueFrom] === '\t') valueFrom++;
  return { prefix: source.slice(0, valueFrom), value: source.slice(valueFrom) };
}

interface TransformedTagsProperty {
  readonly text: string;
  readonly nextIndex: number;
  readonly beginsBlock: boolean;
}

interface TagsPropertyTransformOptions {
  readonly lines: readonly string[];
  readonly index: number;
  readonly property: YamlProperty;
  readonly ending: string;
  readonly replacement: TagReplacement;
}

function transformTagsProperty(options: TagsPropertyTransformOptions): TransformedTagsProperty {
  const { lines, index, property, ending, replacement } = options;
  const { separator, value } = property;
  if (value.length === 0 || value.startsWith('#')) {
    return { text: lines[index] ?? '', nextIndex: index, beginsBlock: true };
  }
  if (!value.trimStart().startsWith('[')) {
    return {
      text: `${property.key}:${separator}${transformYamlScalar(
        value,
        replacement.oldTag,
        replacement.newTag,
        replacement.scope,
      )}${ending}`,
      nextIndex: index,
      beginsBlock: false,
    };
  }

  let flow = `${value}${ending}`;
  let nextIndex = index;
  while (flowSequenceClose(flow) < 0 && nextIndex + 1 < lines.length) {
    nextIndex++;
    flow += lines[nextIndex] ?? '';
  }
  return {
    text: `${property.key}:${separator}${transformFlowSequence(
      flow,
      replacement.oldTag,
      replacement.newTag,
      replacement.scope,
    )}`,
    nextIndex,
    beginsBlock: false,
  };
}

interface YamlLineParts {
  readonly line: string;
  readonly ending: string;
  readonly core: string;
}

function yamlLineParts(line: string): YamlLineParts {
  let ending = '';
  if (line.endsWith('\r\n')) ending = '\r\n';
  else if (line.endsWith('\n')) ending = '\n';
  return {
    line,
    ending,
    core: ending.length > 0 ? line.slice(0, -ending.length) : line,
  };
}

interface FrontmatterLineResult {
  readonly text: string;
  readonly nextIndex: number;
  readonly inTagsBlock: boolean;
}

interface FrontmatterLineOptions {
  readonly lines: readonly string[];
  readonly index: number;
  readonly inTagsBlock: boolean;
  readonly replacement: TagReplacement;
}

function transformFrontmatterProperty(
  parts: YamlLineParts,
  property: YamlProperty,
  options: FrontmatterLineOptions,
): FrontmatterLineResult {
  if (property.key.trim() !== 'tags') {
    return { text: parts.line, nextIndex: options.index, inTagsBlock: false };
  }
  const transformed = transformTagsProperty({
    lines: options.lines,
    index: options.index,
    property,
    ending: parts.ending,
    replacement: options.replacement,
  });
  return {
    text: transformed.text,
    nextIndex: transformed.nextIndex,
    inTagsBlock: transformed.beginsBlock,
  };
}

function transformTagsBlockLine(
  parts: YamlLineParts,
  options: FrontmatterLineOptions,
): FrontmatterLineResult {
  const unchanged = { text: parts.line, nextIndex: options.index, inTagsBlock: true };
  const trimmed = parts.core.trim();
  if (trimmed.length === 0 || trimmed.startsWith('#')) return unchanged;
  const item = yamlListItem(parts.core);
  if (item != null) {
    const replacement = options.replacement;
    return {
      text: `${item.prefix}${transformYamlScalar(
        item.value,
        replacement.oldTag,
        replacement.newTag,
        replacement.scope,
      )}${parts.ending}`,
      nextIndex: options.index,
      inTagsBlock: true,
    };
  }
  const staysInBlock = parts.core[0] === ' ' || parts.core[0] === '\t';
  return { ...unchanged, inTagsBlock: staysInBlock };
}

function transformFrontmatterLine(options: FrontmatterLineOptions): FrontmatterLineResult {
  const parts = yamlLineParts(options.lines[options.index] ?? '');
  const property = yamlProperty(parts.core);
  if (property != null) return transformFrontmatterProperty(parts, property, options);
  if (!options.inTagsBlock) {
    return { text: parts.line, nextIndex: options.index, inTagsBlock: false };
  }
  return transformTagsBlockLine(parts, options);
}

function transformFrontmatterYaml(
  yaml: string,
  oldTag: string,
  newTag: string,
  scope: TagRenameScope,
): string {
  const lines = linesPreservingEndings(yaml);
  const transformedLines: string[] = [];
  const replacement: TagReplacement = { oldTag, newTag, scope };
  let inTagsBlock = false;
  let index = 0;
  while (index < lines.length) {
    const transformed = transformFrontmatterLine({
      lines,
      index,
      inTagsBlock,
      replacement,
    });
    transformedLines.push(transformed.text);
    inTagsBlock = transformed.inTagsBlock;
    index = transformed.nextIndex + 1;
  }
  return transformedLines.join('');
}

interface FrontmatterRange {
  readonly yamlFrom: number;
  readonly yamlTo: number;
  readonly bodyFrom: number;
}

function frontmatterRange(source: string): FrontmatterRange | null {
  const opening = /^(?:\uFEFF)?---[ \t]*\r?\n/u.exec(source);
  if (opening == null) return null;

  let lineStart = opening[0].length;
  while (lineStart <= source.length) {
    const newline = source.indexOf('\n', lineStart);
    const lineEnd = newline < 0 ? source.length : newline + 1;
    const coreEnd = newline < 0 ? lineEnd : newline;
    const core = source.slice(lineStart, coreEnd).replace(/\r$/u, '');
    if (/^(?:---|\.\.\.)[ \t]*$/u.test(core)) {
      return { yamlFrom: opening[0].length, yamlTo: lineStart, bodyFrom: lineEnd };
    }
    if (newline < 0) break;
    lineStart = lineEnd;
  }
  return null;
}

interface OpenFence {
  readonly from: number;
  readonly marker: string;
  readonly length: number;
  readonly quoteDepth: number;
}

interface MarkdownSourceLine {
  readonly from: number;
  readonly to: number;
  readonly container: ReturnType<typeof blockquoteContainer>;
}

function markdownSourceLine(source: string, from: number): MarkdownSourceLine {
  const newline = source.indexOf('\n', from);
  const to = newline < 0 ? source.length : newline + 1;
  const core = source.slice(from, newline < 0 ? to : newline).replace(/\r$/u, '');
  return { from, to, container: blockquoteContainer(core) };
}

function closingFenceRange(line: MarkdownSourceLine, open: OpenFence): SourceRange | null {
  const leading = /^ {0,3}/u.exec(line.container.content)?.[0].length ?? 0;
  const candidate = line.container.content.slice(leading);
  let run = 0;
  while (candidate[run] === open.marker) run++;
  if (line.container.quoteDepth !== open.quoteDepth || run < open.length) return null;
  return /^[ \t]*$/u.test(candidate.slice(run)) ? { from: open.from, to: line.to } : null;
}

function openingFence(line: MarkdownSourceLine): OpenFence | null {
  const match = /^ {0,3}(`{3,}|~{3,})/u.exec(line.container.content);
  if (match === null) return null;
  const delimiter = match[1];
  if (delimiter === undefined) return null;
  const rest = line.container.content.slice(match[0].length);
  if (delimiter[0] === '`' && rest.includes('`')) return null;
  return {
    from: line.from,
    marker: delimiter[0] ?? '`',
    length: delimiter.length,
    quoteDepth: line.container.quoteDepth,
  };
}

function droppedBlockquoteFence(line: MarkdownSourceLine, open: OpenFence): SourceRange | null {
  if (open.quoteDepth === 0 || line.container.quoteDepth >= open.quoteDepth) return null;
  return { from: open.from, to: line.from };
}

interface FenceLineTransition {
  readonly open: OpenFence | null;
  readonly range?: SourceRange;
}

function fenceLineTransition(
  line: MarkdownSourceLine,
  open: OpenFence | null,
): FenceLineTransition {
  if (open === null) return { open: openingFence(line) };
  const dropped = droppedBlockquoteFence(line, open);
  if (dropped != null) return { open: openingFence(line), range: dropped };
  const closed = closingFenceRange(line, open);
  return closed == null ? { open } : { open: null, range: closed };
}

function fencedCodeRanges(source: string): readonly SourceRange[] {
  const ranges: SourceRange[] = [];
  let open: OpenFence | null = null;
  let lineStart = 0;

  while (lineStart < source.length) {
    const line = markdownSourceLine(source, lineStart);
    const transition = fenceLineTransition(line, open);
    if (transition.range != null) ranges.push(transition.range);
    open = transition.open;
    lineStart = line.to;
  }
  if (open != null) ranges.push({ from: open.from, to: source.length });
  return ranges;
}

function blockquoteContainer(source: string): {
  readonly content: string;
  readonly quoteDepth: number;
} {
  let cursor = 0;
  let quoteDepth = 0;
  while (cursor < source.length) {
    const beforeMarker = cursor;
    let spaces = 0;
    while (spaces < 3 && source[cursor] === ' ') {
      cursor++;
      spaces++;
    }
    if (source[cursor] !== '>') {
      cursor = beforeMarker;
      break;
    }
    quoteDepth++;
    cursor++;
    if (source[cursor] === ' ' || source[cursor] === '\t') cursor++;
  }
  return { content: quoteDepth > 0 ? source.slice(cursor) : source, quoteDepth };
}

function excludedCodeRanges(source: string): readonly SourceRange[] {
  const fences = fencedCodeRanges(source);
  const ranges = [...fences];
  let cursor = 0;
  for (const fence of fences) {
    if (cursor < fence.from) {
      for (const range of inlineCodeRanges(source.slice(cursor, fence.from))) {
        ranges.push({ from: cursor + range.from, to: cursor + range.to });
      }
    }
    cursor = fence.to;
  }
  if (cursor < source.length) {
    for (const range of inlineCodeRanges(source.slice(cursor))) {
      ranges.push({ from: cursor + range.from, to: cursor + range.to });
    }
  }
  return ranges.sort((left, right) => left.from - right.from);
}

function closingDelimiter(source: string, from: number, delimiter: string): number | null {
  let close = source.indexOf(delimiter, from);
  while (close >= 0) {
    if (
      !isEscaped(source, close) &&
      source[close - 1] !== delimiter[0] &&
      source[close + delimiter.length] !== delimiter[0]
    ) {
      return close + delimiter.length;
    }
    close = source.indexOf(delimiter, close + 1);
  }
  return null;
}

function singleLineWhitespaceEnd(source: string, from: number): number {
  let cursor = from;
  while (source[cursor] === ' ' || source[cursor] === '\t') cursor++;
  if (source[cursor] === '\r' && source[cursor + 1] === '\n') cursor += 2;
  else if (source[cursor] === '\n') cursor++;
  while (source[cursor] === ' ' || source[cursor] === '\t') cursor++;
  return cursor;
}

interface LinkTitleScanStep {
  readonly cursor: number;
  readonly lineHasContent: boolean;
  readonly result: 'continue' | 'close' | 'invalid';
}

interface LinkTitleScanOptions {
  readonly source: string;
  readonly cursor: number;
  readonly opener: string;
  readonly closer: string;
  readonly lineHasContent: boolean;
}

function isLinkTitleContent(character: string): boolean {
  return character !== ' ' && character !== '\t' && character !== '\r';
}

function escapedLinkTitleStep(source: string, cursor: number): LinkTitleScanStep {
  const followedByLineBreak = source[cursor + 1] === '\n' || source[cursor + 1] === '\r';
  return {
    cursor: cursor + (followedByLineBreak ? 1 : 2),
    lineHasContent: true,
    result: 'continue',
  };
}

function lineBreakTitleStep(cursor: number, lineHasContent: boolean): LinkTitleScanStep {
  return {
    cursor: cursor + 1,
    lineHasContent: false,
    result: lineHasContent ? 'continue' : 'invalid',
  };
}

function linkTitleScanStep(options: LinkTitleScanOptions): LinkTitleScanStep {
  const { source, cursor, opener, closer, lineHasContent } = options;
  const character = source[cursor] ?? '';
  if (character === '\\') return escapedLinkTitleStep(source, cursor);
  if (character === '\n') return lineBreakTitleStep(cursor, lineHasContent);
  const hasContent = isLinkTitleContent(character);
  if (opener === '(' && character === '(') {
    return { cursor: cursor + 1, lineHasContent: true, result: 'invalid' };
  }
  return {
    cursor: cursor + 1,
    lineHasContent: lineHasContent || hasContent,
    result: character === closer ? 'close' : 'continue',
  };
}

function linkTitleEnd(source: string, from: number): number | null {
  const opener = source[from] ?? '';
  const closer = opener === '(' ? ')' : opener;
  if (opener !== '"' && opener !== "'" && opener !== '(') return null;
  let lineHasContent = true;
  let cursor = from + 1;
  while (cursor < source.length) {
    const step = linkTitleScanStep({ source, cursor, opener, closer, lineHasContent });
    if (step.result === 'invalid') return null;
    if (step.result === 'close') return step.cursor;
    cursor = step.cursor;
    lineHasContent = step.lineHasContent;
  }
  return null;
}

interface DestinationDepthStep {
  readonly result: 'continue' | 'close' | 'invalid';
  readonly depth: number;
}

function destinationDepthStep(character: string, depth: number): DestinationDepthStep {
  if (character === '(') {
    return depth >= 32 ? { result: 'invalid', depth } : { result: 'continue', depth: depth + 1 };
  }
  if (character !== ')') return { result: 'continue', depth };
  return depth === 0 ? { result: 'close', depth } : { result: 'continue', depth: depth - 1 };
}

function isBareDestinationWhitespace(character: string): boolean {
  const code = character.charCodeAt(0);
  return code <= 32 || code === 127;
}

function bareLinkDestinationEnd(source: string, from: number): number | null {
  let cursor = from;
  let depth = 0;
  while (cursor < source.length) {
    const character = source[cursor] ?? '';
    if (character === '\\') {
      cursor += 2;
      continue;
    }
    const nextDepth = destinationDepthStep(character, depth);
    if (nextDepth.result === 'invalid') return null;
    if (nextDepth.result === 'close' || isBareDestinationWhitespace(character)) return cursor;
    depth = nextDepth.depth;
    cursor++;
  }
  return null;
}

function angleLinkDestinationEnd(source: string, from: number): number | null {
  for (let cursor = from + 1; cursor < source.length; cursor++) {
    const character = source[cursor] ?? '';
    if (character === '\\') {
      cursor++;
      continue;
    }
    if (character === '>') return cursor + 1;
    if (character === '<' || character === '\n' || character === '\r') return null;
  }
  return null;
}

function linkDestinationContentEnd(source: string, from: number): number | null {
  return source[from] === '<'
    ? angleLinkDestinationEnd(source, from)
    : bareLinkDestinationEnd(source, from);
}

function markdownLinkDestinationEnd(source: string, closeBracket: number): number | null {
  if (source[closeBracket + 1] !== '(') return null;
  let cursor = singleLineWhitespaceEnd(source, closeBracket + 2);
  const destinationEnd = linkDestinationContentEnd(source, cursor);
  if (destinationEnd === null) return null;
  cursor = destinationEnd;

  if (source[cursor] === ')') return cursor + 1;
  const titleFrom = singleLineWhitespaceEnd(source, cursor);
  if (titleFrom === cursor) return null;
  if (source[titleFrom] === ')') return titleFrom + 1;
  const titleEnd = linkTitleEnd(source, titleFrom);
  if (titleEnd === null) return null;
  const close = singleLineWhitespaceEnd(source, titleEnd);
  return source[close] === ')' ? close + 1 : null;
}

const ASCII_LETTER = /^[A-Za-z]$/u;
const ASCII_ALPHANUMERIC = /^[A-Za-z0-9]$/u;
const URI_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]{1,31}$/u;
const EMAIL_LOCAL = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+$/u;
const EMAIL_DOMAIN_LABEL = /^[A-Za-z0-9-]+$/u;
const HTML_TAG_NAME = /[A-Za-z][A-Za-z0-9-]*/uy;
const HTML_ATTRIBUTE_NAME = /[A-Za-z_:][A-Za-z0-9_.:-]*/uy;
const HTML_ATTRIBUTE_VALUE = /(?:[^ "'=<>`]+|'[^']*'|"[^"]*")/uy;

function isUriAutolink(source: string): boolean {
  const colon = source.indexOf(':');
  if (colon < 2 || colon > 32 || !URI_SCHEME.test(source.slice(0, colon))) return false;
  for (const character of source.slice(colon + 1)) {
    const code = character.charCodeAt(0);
    if (code <= 32 || code === 127 || character === '<' || character === '>') return false;
  }
  return true;
}

function isEmailAutolink(source: string): boolean {
  const at = source.indexOf('@');
  if (at <= 0 || at !== source.lastIndexOf('@') || at === source.length - 1) return false;
  if (!EMAIL_LOCAL.test(source.slice(0, at))) return false;
  return source
    .slice(at + 1)
    .split('.')
    .every(
      (label) =>
        label.length >= 1 &&
        label.length <= 63 &&
        ASCII_ALPHANUMERIC.test(label[0] ?? '') &&
        ASCII_ALPHANUMERIC.test(label[label.length - 1] ?? '') &&
        EMAIL_DOMAIN_LABEL.test(label),
    );
}

function tokenEnd(pattern: RegExp, source: string, from: number): number | null {
  pattern.lastIndex = from;
  return pattern.exec(source) != null ? pattern.lastIndex : null;
}

type HtmlAttributeScanResult =
  | { readonly type: 'continue'; readonly cursor: number }
  | { readonly type: 'complete' }
  | { readonly type: 'invalid' };

function htmlAttributeScan(body: string, cursor: number): HtmlAttributeScanResult {
  const attributeFrom = singleLineWhitespaceEnd(body, cursor);
  if (attributeFrom === cursor) {
    return body.slice(cursor) === '/' ? { type: 'complete' } : { type: 'invalid' };
  }
  if (attributeFrom === body.length) return { type: 'complete' };
  if (body[attributeFrom] === '/') {
    return attributeFrom + 1 === body.length ? { type: 'complete' } : { type: 'invalid' };
  }
  const attributeEnd = tokenEnd(HTML_ATTRIBUTE_NAME, body, attributeFrom);
  if (attributeEnd === null) return { type: 'invalid' };
  const separatorEnd = singleLineWhitespaceEnd(body, attributeEnd);
  if (body[separatorEnd] !== '=') return { type: 'continue', cursor: attributeEnd };
  const valueFrom = singleLineWhitespaceEnd(body, separatorEnd + 1);
  const valueEnd = tokenEnd(HTML_ATTRIBUTE_VALUE, body, valueFrom);
  return valueEnd === null ? { type: 'invalid' } : { type: 'continue', cursor: valueEnd };
}

function isHtmlTag(source: string): boolean {
  const body = source.slice(1, -1);
  let cursor = 0;
  const closing = body[cursor] === '/';
  if (closing) cursor++;
  const nameEnd = tokenEnd(HTML_TAG_NAME, body, cursor);
  if (nameEnd === null) return false;
  cursor = nameEnd;

  if (closing) {
    return singleLineWhitespaceEnd(body, cursor) === body.length;
  }

  while (cursor < body.length) {
    const result = htmlAttributeScan(body, cursor);
    if (result.type === 'complete') return true;
    if (result.type === 'invalid') return false;
    cursor = result.cursor;
  }
  return true;
}

function quotedAngleEnd(source: string, from: number): number | null {
  let quote = '';
  for (let cursor = from + 1; cursor < source.length; cursor++) {
    const character = source[cursor] ?? '';
    if (quote.length > 0) {
      if (character === quote) quote = '';
      continue;
    }
    if (character === '"' || character === "'") quote = character;
    else if (character === '>') return cursor + 1;
  }
  return null;
}

interface SemanticScanState {
  htmlCommentFailed: boolean;
  processingInstructionFailed: boolean;
  cdataFailed: boolean;
  declarationFailed: boolean;
}

interface TerminatedAngleLiteralOptions {
  readonly source: string;
  readonly from: number;
  readonly state: SemanticScanState;
  readonly delimiter: string;
  readonly failure: keyof Omit<SemanticScanState, 'htmlCommentFailed'>;
}

function terminatedAngleLiteral(options: TerminatedAngleLiteralOptions): number | null {
  if (options.state[options.failure]) return null;
  const close = options.source.indexOf(options.delimiter, options.from + 2);
  if (close >= 0) return close + options.delimiter.length;
  options.state[options.failure] = true;
  return null;
}

function declarationLiteralEnd(
  source: string,
  from: number,
  state: SemanticScanState,
): number | null {
  const to = terminatedAngleLiteral({
    source,
    from,
    state,
    delimiter: '>',
    failure: 'declarationFailed',
  });
  if (to === null) return null;
  return ASCII_LETTER.test(source[from + 2] ?? '') ? to : null;
}

function autolinkLiteralEnd(source: string, from: number): number | null {
  const close = source.indexOf('>', from + 1);
  if (close < 0) return null;
  const content = source.slice(from + 1, close);
  return isUriAutolink(content) || isEmailAutolink(content) ? close + 1 : null;
}

function htmlLiteralEnd(source: string, from: number): number | null {
  const close = quotedAngleEnd(source, from);
  if (close === null) return null;
  return isHtmlTag(source.slice(from, close)) ? close : null;
}

function angleLiteralEnd(source: string, from: number, state: SemanticScanState): number | null {
  if (source[from] !== '<' || isEscaped(source, from)) return null;
  if (source.startsWith('<?', from)) {
    return terminatedAngleLiteral({
      source,
      from,
      state,
      delimiter: '?>',
      failure: 'processingInstructionFailed',
    });
  }
  if (source.startsWith('<![CDATA[', from)) {
    return terminatedAngleLiteral({
      source,
      from,
      state,
      delimiter: ']]>',
      failure: 'cdataFailed',
    });
  }
  if (source.startsWith('<!', from)) return declarationLiteralEnd(source, from, state);
  return autolinkLiteralEnd(source, from) ?? htmlLiteralEnd(source, from);
}

function referenceLabelEnd(line: string, from: number): number {
  let cursor = from;
  while (cursor < line.length) {
    if (line[cursor] === '\\') cursor += 2;
    else if (line[cursor] === ']') return cursor;
    else cursor++;
  }
  return cursor;
}

function referenceDefinitionEnd(source: string, from: number): number | null {
  if (from > 0 && source[from - 1] !== '\n') return null;
  const newline = source.indexOf('\n', from);
  const to = newline < 0 ? source.length : newline + 1;
  const line = source.slice(from, newline < 0 ? to : newline).replace(/\r$/u, '');
  let cursor = 0;
  while (cursor < 3 && line[cursor] === ' ') cursor++;
  if (line[cursor] !== '[') return null;
  cursor = referenceLabelEnd(line, cursor + 1);
  if (line[cursor] !== ']' || line[cursor + 1] !== ':') return null;
  return to;
}

function mergeSourceRanges(ranges: readonly SourceRange[]): readonly SourceRange[] {
  const ordered = [...ranges].sort((left, right) => {
    const startOrder = left.from - right.from;
    return startOrder !== 0 ? startOrder : left.to - right.to;
  });
  const merged: SourceRange[] = [];
  for (const range of ordered) {
    const previous = merged[merged.length - 1];
    if (previous == null || previous.to < range.from) {
      merged.push(range);
      continue;
    }
    if (range.to > previous.to) {
      merged[merged.length - 1] = { from: previous.from, to: range.to };
    }
  }
  return merged;
}

function blankLineCounts(source: string): Uint32Array {
  const counts = new Uint32Array(source.length + 1);
  let count = 0;
  let lineHasContent = false;
  for (let cursor = 0; cursor < source.length; cursor++) {
    const character = source[cursor] ?? '';
    if (character === '\n') {
      if (!lineHasContent) count++;
      lineHasContent = false;
    } else if (character !== ' ' && character !== '\t' && character !== '\r') {
      lineHasContent = true;
    }
    counts[cursor + 1] = count;
  }
  return counts;
}

interface LinkLabelState {
  readonly image: boolean;
  readonly linkEpoch: number;
  readonly blankLines: number;
}

interface InlineLinkScanState {
  readonly labels: LinkLabelState[];
  readonly destinations: SourceRange[];
  linkEpoch: number;
  opaqueIndex: number;
  cursor: number;
}

interface InlineLinkScanContext {
  readonly source: string;
  readonly blankLines: Uint32Array;
  readonly opaqueRanges: readonly SourceRange[];
  readonly state: InlineLinkScanState;
}

function skipInlineLinkOpaqueRange(context: InlineLinkScanContext): boolean {
  const { state, opaqueRanges } = context;
  while ((opaqueRanges[state.opaqueIndex]?.to ?? Number.POSITIVE_INFINITY) <= state.cursor) {
    state.opaqueIndex++;
  }
  const opaque = opaqueRanges[state.opaqueIndex];
  if (opaque == null || opaque.from > state.cursor) return false;
  state.cursor = opaque.to;
  return true;
}

function openInlineLinkLabel(context: InlineLinkScanContext): void {
  const { source, blankLines, state } = context;
  state.labels.push({
    image: source[state.cursor - 1] === '!' && !isEscaped(source, state.cursor - 1),
    linkEpoch: state.linkEpoch,
    blankLines: blankLines[state.cursor] ?? 0,
  });
  state.cursor++;
}

function closeInlineLinkLabel(context: InlineLinkScanContext): void {
  const { source, blankLines, state } = context;
  const label = state.labels.pop();
  if (label === undefined) {
    state.cursor++;
    return;
  }
  const destinationEnd = markdownLinkDestinationEnd(source, state.cursor);
  const labelIsValid =
    label.blankLines === blankLines[state.cursor] &&
    (label.image || label.linkEpoch === state.linkEpoch);
  if (!labelIsValid || destinationEnd === null) {
    state.cursor++;
    return;
  }
  state.destinations.push({ from: state.cursor + 1, to: destinationEnd });
  if (!label.image) state.linkEpoch++;
  state.cursor = destinationEnd;
}

function scanInlineLinkCharacter(context: InlineLinkScanContext): void {
  const { source, state } = context;
  const character = source[state.cursor] ?? '';
  if (character === '\\') {
    state.cursor += 2;
  } else if (character === '[') {
    openInlineLinkLabel(context);
  } else if (character === ']') {
    closeInlineLinkLabel(context);
  } else {
    state.cursor++;
  }
}

function inlineLinkDestinationRanges(
  source: string,
  opaqueRanges: readonly SourceRange[],
): readonly SourceRange[] {
  const blankLines = blankLineCounts(source);
  const state: InlineLinkScanState = {
    labels: [],
    destinations: [],
    linkEpoch: 0,
    opaqueIndex: 0,
    cursor: 0,
  };
  const context: InlineLinkScanContext = { source, blankLines, opaqueRanges, state };
  while (state.cursor < source.length) {
    if (!skipInlineLinkOpaqueRange(context)) scanInlineLinkCharacter(context);
  }
  return state.destinations;
}

interface SemanticLiteralMatch {
  readonly range: SourceRange;
  readonly scanTo: number;
}

function isHtmlBlockStart(source: string, from: number): boolean {
  let spaces = 0;
  for (let cursor = from - 1; cursor >= 0 && source[cursor] !== '\n'; cursor--) {
    if (source[cursor] !== ' ' || ++spaces > 3) return false;
  }
  return true;
}

function htmlCommentEnd(source: string, from: number, state: SemanticScanState): number | null {
  if (source.startsWith('<!-->', from)) return from + 5;
  if (source.startsWith('<!--->', from)) return from + 6;
  if (state.htmlCommentFailed) return isHtmlBlockStart(source, from) ? source.length : null;
  const close = source.indexOf('-->', from + 4);
  if (close >= 0) return close + 3;
  if (isHtmlBlockStart(source, from)) return source.length;
  state.htmlCommentFailed = true;
  return null;
}

function htmlCommentLiteralAt(
  source: string,
  from: number,
  state: SemanticScanState,
): SemanticLiteralMatch | null {
  if (!source.startsWith('<!--', from) || isEscaped(source, from)) return null;
  const to = htmlCommentEnd(source, from, state);
  return to === null ? null : { range: { from, to }, scanTo: to };
}

function obsidianCommentLiteralAt(source: string, from: number): SemanticLiteralMatch | null {
  if (!source.startsWith('%%', from) || isEscaped(source, from)) return null;
  const to = closingDelimiter(source, from + 2, '%%');
  return to === null ? null : { range: { from, to }, scanTo: to };
}

function commentLiteralAt(
  source: string,
  from: number,
  state: SemanticScanState,
): SemanticLiteralMatch | null {
  return htmlCommentLiteralAt(source, from, state) ?? obsidianCommentLiteralAt(source, from);
}

function mathLiteralAt(source: string, from: number): SemanticLiteralMatch | null {
  if (source[from] !== '$' || isEscaped(source, from)) return null;
  let length = 1;
  while (source[from + length] === '$') length++;
  const delimiter = '$'.repeat(length);
  const to = closingDelimiter(source, from + length, delimiter);
  return to === null ? null : { range: { from, to }, scanTo: to };
}

function semanticLiteralAt(
  source: string,
  from: number,
  state: SemanticScanState,
): SemanticLiteralMatch | null {
  const definitionEnd = referenceDefinitionEnd(source, from);
  if (definitionEnd !== null) {
    return { range: { from, to: definitionEnd }, scanTo: definitionEnd };
  }

  const comment = commentLiteralAt(source, from, state);
  if (comment != null) return comment;

  if (source[from] === '<') {
    const to = angleLiteralEnd(source, from, state);
    if (to !== null) return { range: { from, to }, scanTo: to };
  }

  return mathLiteralAt(source, from);
}

interface WikiScanState {
  from: number;
  pipe: number;
}

interface WikiScanResult {
  readonly to: number;
  readonly target?: SourceRange;
  readonly opaque?: SourceRange;
}

function resetWikiScan(state: WikiScanState): void {
  state.from = -1;
  state.pipe = -1;
}

function isWikiOpener(source: string, cursor: number): boolean {
  return source.startsWith('[[', cursor) && !isEscaped(source, cursor);
}

function openWikiScan(cursor: number, state: WikiScanState): WikiScanResult {
  state.from = cursor;
  state.pipe = -1;
  return { to: cursor + 2 };
}

function activeWikiScanAt(source: string, cursor: number, state: WikiScanState): WikiScanResult {
  if (source[cursor] === '\n') {
    resetWikiScan(state);
    return { to: cursor + 1 };
  }
  if (isWikiOpener(source, cursor)) return openWikiScan(cursor, state);
  if (source[cursor] === '|' && state.pipe < 0 && !isEscaped(source, cursor)) {
    state.pipe = cursor;
    return { to: cursor + 1 };
  }
  if (!source.startsWith(']]', cursor) || isEscaped(source, cursor)) {
    return { to: cursor + 1 };
  }
  const to = cursor + 2;
  const from = state.from;
  const pipe = state.pipe;
  resetWikiScan(state);
  return {
    to,
    target: { from: from + 2, to: pipe >= 0 ? pipe : cursor },
    opaque: { from, to },
  };
}

function wikiScanAt(source: string, cursor: number, state: WikiScanState): WikiScanResult | null {
  if (state.from < 0) {
    return isWikiOpener(source, cursor) ? openWikiScan(cursor, state) : null;
  }
  return activeWikiScanAt(source, cursor, state);
}

interface SemanticRangeScanContext {
  readonly source: string;
  readonly codeRanges: readonly SourceRange[];
  readonly ranges: SourceRange[];
  readonly opaqueRanges: SourceRange[];
  readonly semanticState: SemanticScanState;
  readonly wikiState: WikiScanState;
  codeIndex: number;
  cursor: number;
}

function resetWikiAcrossRange(context: SemanticRangeScanContext, to: number): void {
  if (context.wikiState.from < 0) return;
  if (context.source.slice(context.cursor, to).includes('\n')) resetWikiScan(context.wikiState);
}

function consumeCodeRange(context: SemanticRangeScanContext): boolean {
  while (
    (context.codeRanges[context.codeIndex]?.to ?? Number.POSITIVE_INFINITY) <= context.cursor
  ) {
    context.codeIndex++;
  }
  const code = context.codeRanges[context.codeIndex];
  if (code == null || code.from > context.cursor) return false;
  resetWikiAcrossRange(context, code.to);
  context.cursor = code.to;
  return true;
}

function consumeSemanticLiteral(context: SemanticRangeScanContext): boolean {
  const literal = semanticLiteralAt(context.source, context.cursor, context.semanticState);
  if (literal == null) return false;
  context.ranges.push(literal.range);
  context.opaqueRanges.push({ from: context.cursor, to: literal.scanTo });
  resetWikiAcrossRange(context, literal.scanTo);
  context.cursor = literal.scanTo;
  return true;
}

function consumeWikiLiteral(context: SemanticRangeScanContext): boolean {
  const wiki = wikiScanAt(context.source, context.cursor, context.wikiState);
  if (wiki == null) return false;
  if (wiki.target != null && wiki.opaque != null) {
    context.ranges.push(wiki.target);
    context.opaqueRanges.push(wiki.opaque);
  }
  context.cursor = wiki.to;
  return true;
}

function scanSemanticRange(context: SemanticRangeScanContext): void {
  if (consumeCodeRange(context)) return;
  if (consumeSemanticLiteral(context)) return;
  if (consumeWikiLiteral(context)) return;
  context.cursor++;
}

/**
 * Locates Markdown regions whose bytes are syntax or literal content rather than visible prose.
 * The rename pass consumes this one ordered range set, so destinations, raw markup, comments,
 * code, and math all share the same lossless boundary contract.
 */
function markdownSemanticLiteralRanges(source: string): readonly SourceRange[] {
  const codeRanges = excludedCodeRanges(source);
  const ranges: SourceRange[] = [...codeRanges];
  const opaqueRanges: SourceRange[] = [...codeRanges];
  const context: SemanticRangeScanContext = {
    source,
    codeRanges,
    ranges,
    opaqueRanges,
    semanticState: {
      htmlCommentFailed: false,
      processingInstructionFailed: false,
      cdataFailed: false,
      declarationFailed: false,
    },
    wikiState: { from: -1, pipe: -1 },
    codeIndex: 0,
    cursor: 0,
  };
  while (context.cursor < source.length) scanSemanticRange(context);
  ranges.push(...inlineLinkDestinationRanges(source, mergeSourceRanges(opaqueRanges)));
  return mergeSourceRanges(ranges);
}

function isEscaped(source: string, at: number): boolean {
  let slashes = 0;
  for (let index = at - 1; index >= 0 && source[index] === '\\'; index--) slashes++;
  return slashes % 2 === 1;
}

function transformBodyTags(
  source: string,
  oldTag: string,
  newTag: string,
  scope: TagRenameScope,
): string {
  const excluded = markdownSemanticLiteralRanges(source);
  let rangeIndex = 0;
  return source.replace(replacementPattern(oldTag, scope), (match, offset: number) => {
    while (excluded[rangeIndex] != null && (excluded[rangeIndex]?.to ?? 0) <= offset) rangeIndex++;
    const range = excluded[rangeIndex];
    if ((range != null && range.from <= offset && offset < range.to) || isEscaped(source, offset)) {
      return match;
    }
    return newTag;
  });
}

export function transformMarkdownTags(
  source: string,
  oldTag: string,
  newTag: string,
  scope: TagRenameScope,
): string {
  const frontmatter = frontmatterRange(source);
  if (frontmatter == null) return transformBodyTags(source, oldTag, newTag, scope);

  const yaml = transformFrontmatterYaml(
    source.slice(frontmatter.yamlFrom, frontmatter.yamlTo),
    oldTag,
    newTag,
    scope,
  );
  const body = transformBodyTags(source.slice(frontmatter.bodyFrom), oldTag, newTag, scope);
  return (
    source.slice(0, frontmatter.yamlFrom) +
    yaml +
    source.slice(frontmatter.yamlTo, frontmatter.bodyFrom) +
    body
  );
}
