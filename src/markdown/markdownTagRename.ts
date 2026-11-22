import { frontmatterRange } from './frontmatterRange';

import { normalizeTag, sameTag, tagHasPrefix, type TagRenameScope } from './tagSyntax';
import { visibleMarkdownTags } from './visibleMarkdownTags';
export { normalizeTag, type TagRenameScope } from './tagSyntax';

function replaceCanonicalTag(
  value: string,
  oldTag: string,
  newTag: string,
  scope: TagRenameScope,
): string {
  if (sameTag(value, oldTag)) return newTag;
  if (scope === 'prefix' && tagHasPrefix(value, oldTag)) {
    return `${newTag}/${value.split('/').slice(oldTag.split('/').length).join('/')}`;
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

/** Extracts visible inline body tags using the same Markdown boundaries as lossless tag edits. */
export function extractMarkdownBodyTags(source: string): readonly string[] {
  const frontmatter = frontmatterRange(source);
  const tags = new Set<string>();
  for (const match of visibleMarkdownTags(source.slice(frontmatter?.bodyFrom ?? 0))) {
    const tag = normalizeTag(match[0]);
    if (tag !== null) tags.add(tag);
  }
  return [...tags];
}

function transformBodyTags(
  source: string,
  oldTag: string,
  newTag: string,
  scope: TagRenameScope,
): string {
  let result = '';
  let copiedTo = 0;
  for (const match of visibleMarkdownTags(source)) {
    const replacement = replaceCanonicalTag(match[0], oldTag, newTag, scope);
    if (replacement === match[0]) continue;
    result += source.slice(copiedTo, match.index) + replacement;
    copiedTo = match.index + match[0].length;
  }
  return result + source.slice(copiedTo);
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
