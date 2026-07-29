import { inlineCodeRanges, type SourceRange } from '../parser/inlineCode';

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

  let from = 0;
  while (from < source.length && /\s/u.test(source[from] ?? '')) from++;
  let to = source.length;
  while (to > from && /\s/u.test(source[to - 1] ?? '')) to--;
  const leading = source.slice(0, from);
  let scalar = source.slice(from, to);
  const trailing = source.slice(to);
  if (!scalar) return source;

  let comment = '';
  const commentAt = yamlCommentStart(scalar);
  if (commentAt >= 0) {
    comment = scalar.slice(commentAt);
    scalar = scalar.slice(0, commentAt);
  }

  const quote =
    scalar.length >= 2 &&
    (scalar[0] === '"' || scalar[0] === "'") &&
    scalar[scalar.length - 1] === scalar[0]
      ? scalar[0]
      : '';
  const rawValue = quote ? scalar.slice(1, -1) : scalar;
  if (!rawValue) return source;

  const hasHash = rawValue.startsWith('#');
  const canonical = hasHash ? rawValue : `#${rawValue}`;
  const replacement = replaceCanonicalTag(canonical, oldTag, newTag, scope);
  if (replacement === canonical) return source;

  const displayed = hasHash ? replacement : replacement.slice(1);
  return `${leading}${quote}${displayed}${quote}${comment}${trailing}`;
}

function leadingYamlCommentPrefixEnd(source: string): number {
  let cursor = 0;
  let sawComment = false;
  while (cursor < source.length) {
    const newline = source.indexOf('\n', cursor);
    const lineEnd = newline < 0 ? source.length : newline + 1;
    const coreEnd = newline < 0 ? lineEnd : newline;
    const trimmed = source.slice(cursor, coreEnd).replace(/\r$/u, '').trim();
    if (!trimmed) {
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
  for (let index = 0; index < source.length; index++) {
    const character = source[index] ?? '';
    if (quote) {
      if (quote === '"' && character === '\\') {
        index++;
      } else if (character === quote) {
        if (quote === "'" && source[index + 1] === "'") index++;
        else quote = '';
      }
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === '#' && index > 0 && /\s/u.test(source[index - 1] ?? '')) {
      let commentAt = index;
      while (commentAt > 0 && /[ \t]/u.test(source[commentAt - 1] ?? '')) commentAt--;
      return commentAt;
    }
  }
  return -1;
}

function flowSequenceClose(source: string): number {
  const open = source.indexOf('[');
  if (open < 0) return -1;
  let quote = '';
  let comment = false;
  for (let index = open + 1; index < source.length; index++) {
    const character = source[index] ?? '';
    if (comment) {
      if (character === '\n') comment = false;
    } else if (quote) {
      if (quote === '"' && character === '\\') {
        index++;
      } else if (character === quote) {
        if (quote === "'" && source[index + 1] === "'") index++;
        else quote = '';
      }
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === '#' && /\s/u.test(source[index - 1] ?? '')) {
      comment = true;
    } else if (character === ']') {
      return index;
    }
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
  let quote = '';
  let comment = false;
  for (let index = 0; index < inner.length; index++) {
    const character = inner[index] ?? '';
    if (comment) {
      if (character === '\n') comment = false;
    } else if (quote) {
      if (quote === '"' && character === '\\') {
        index++;
      } else if (character === quote) {
        if (quote === "'" && inner[index + 1] === "'") index++;
        else quote = '';
      }
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === '#' && /\s/u.test(inner[index - 1] ?? '')) {
      comment = true;
    } else if (character === ',') {
      parts.push(inner.slice(start, index));
      parts.push(',');
      start = index + 1;
    }
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

function transformTagsProperty(
  lines: readonly string[],
  index: number,
  property: YamlProperty,
  ending: string,
  oldTag: string,
  newTag: string,
  scope: TagRenameScope,
): TransformedTagsProperty {
  const { separator, value } = property;
  if (!value || value.startsWith('#')) {
    return { text: lines[index] ?? '', nextIndex: index, beginsBlock: true };
  }
  if (!value.trimStart().startsWith('[')) {
    return {
      text: `${property.key}:${separator}${transformYamlScalar(
        value,
        oldTag,
        newTag,
        scope,
      )}${ending}`,
      nextIndex: index,
      beginsBlock: false,
    };
  }

  let flow = `${value}${ending}`;
  while (flowSequenceClose(flow) < 0 && index + 1 < lines.length) {
    index++;
    flow += lines[index] ?? '';
  }
  return {
    text: `${property.key}:${separator}${transformFlowSequence(flow, oldTag, newTag, scope)}`,
    nextIndex: index,
    beginsBlock: false,
  };
}

function transformFrontmatterYaml(
  yaml: string,
  oldTag: string,
  newTag: string,
  scope: TagRenameScope,
): string {
  const lines = linesPreservingEndings(yaml);
  let inTagsBlock = false;
  const transformedLines: string[] = [];

  let index = 0;
  while (index < lines.length) {
    const lineIndex = index;
    index++;
    const line = lines[lineIndex] ?? '';
    let ending = '';
    if (line.endsWith('\r\n')) ending = '\r\n';
    else if (line.endsWith('\n')) ending = '\n';
    const core = ending ? line.slice(0, -ending.length) : line;
    const property = yamlProperty(core);
    if (property) {
      inTagsBlock = false;
      if (property.key.trim() !== 'tags') {
        transformedLines.push(line);
        continue;
      }

      const transformed = transformTagsProperty(
        lines,
        lineIndex,
        property,
        ending,
        oldTag,
        newTag,
        scope,
      );
      index = transformed.nextIndex + 1;
      inTagsBlock = transformed.beginsBlock;
      transformedLines.push(transformed.text);
      continue;
    }

    if (!inTagsBlock) {
      transformedLines.push(line);
      continue;
    }
    const trimmed = core.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      transformedLines.push(line);
      continue;
    }
    const item = yamlListItem(core);
    if (!item) {
      if (core[0] !== ' ' && core[0] !== '\t') inTagsBlock = false;
      transformedLines.push(line);
      continue;
    }
    transformedLines.push(
      `${item.prefix}${transformYamlScalar(item.value, oldTag, newTag, scope)}${ending}`,
    );
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
  if (!opening) return null;

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

function fencedCodeRanges(source: string): readonly SourceRange[] {
  const ranges: SourceRange[] = [];
  let open: {
    readonly from: number;
    readonly marker: string;
    readonly length: number;
    readonly quoteDepth: number;
  } | null = null;
  let lineStart = 0;

  while (lineStart < source.length) {
    const newline = source.indexOf('\n', lineStart);
    const lineEnd = newline < 0 ? source.length : newline + 1;
    const core = source.slice(lineStart, newline < 0 ? lineEnd : newline).replace(/\r$/u, '');
    const container = blockquoteContainer(core);

    if (open && open.quoteDepth > 0 && container.quoteDepth < open.quoteDepth) {
      ranges.push({ from: open.from, to: lineStart });
      open = null;
    }
    if (open) {
      const leading = /^ {0,3}/u.exec(container.content)?.[0].length ?? 0;
      const candidate = container.content.slice(leading);
      let run = 0;
      while (candidate[run] === open.marker) run++;
      if (
        container.quoteDepth === open.quoteDepth &&
        run >= open.length &&
        /^[ \t]*$/u.test(candidate.slice(run))
      ) {
        ranges.push({ from: open.from, to: lineEnd });
        open = null;
      }
    } else {
      const match = /^ {0,3}(`{3,}|~{3,})/u.exec(container.content);
      const delimiter = match?.[1];
      const rest = match ? container.content.slice(match[0].length) : '';
      if (delimiter && (delimiter[0] !== '`' || !rest.includes('`'))) {
        open = {
          from: lineStart,
          marker: delimiter[0] ?? '`',
          length: delimiter.length,
          quoteDepth: container.quoteDepth,
        };
      }
    }

    lineStart = lineEnd;
  }
  if (open) ranges.push({ from: open.from, to: source.length });
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

function markdownLinkDestinationEnd(source: string, from: number): number | null {
  if (source[from] !== ']' || source[from + 1] !== '(' || isEscaped(source, from)) return null;
  let depth = 1;
  let quote = '';
  for (let cursor = from + 2; cursor < source.length; cursor++) {
    const character = source[cursor] ?? '';
    if (character === '\\') {
      cursor++;
      continue;
    }
    if (quote) {
      if (character === quote) quote = '';
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === '(') depth++;
    else if (character === ')' && --depth === 0) return cursor + 1;
  }
  return null;
}

function markdownLinkDestinationRange(
  source: string,
  from: number,
): { readonly destination: SourceRange; readonly to: number } | null {
  if (source[from] !== '[' || isEscaped(source, from)) return null;
  let depth = 1;
  for (let cursor = from + 1; cursor < source.length; cursor++) {
    const character = source[cursor] ?? '';
    if (character === '\\') {
      cursor++;
      continue;
    }
    if (character === '[') {
      depth++;
      continue;
    }
    if (character !== ']' || --depth !== 0) continue;
    const to = markdownLinkDestinationEnd(source, cursor);
    return to === null ? null : { destination: { from: cursor + 1, to }, to };
  }
  return null;
}

const ASCII_LETTER = /^[A-Za-z]$/u;
const ASCII_ALPHANUMERIC = /^[A-Za-z0-9]$/u;
const URI_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]{1,31}$/u;
const EMAIL_LOCAL = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+$/u;
const EMAIL_DOMAIN_LABEL = /^[A-Za-z0-9-]+$/u;
const HTML_TAG_NAME = /[A-Za-z][A-Za-z0-9-]*/uy;
const HTML_WHITESPACE = /[ \t\r\n]+/uy;
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
  return pattern.exec(source) ? pattern.lastIndex : null;
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
    return (tokenEnd(HTML_WHITESPACE, body, cursor) ?? cursor) === body.length;
  }

  while (cursor < body.length) {
    const attributeFrom = tokenEnd(HTML_WHITESPACE, body, cursor);
    if (attributeFrom === null) return body.slice(cursor) === '/';
    if (attributeFrom === body.length) return true;
    if (body[attributeFrom] === '/') return attributeFrom + 1 === body.length;
    const attributeEnd = tokenEnd(HTML_ATTRIBUTE_NAME, body, attributeFrom);
    if (attributeEnd === null) return false;
    cursor = tokenEnd(HTML_WHITESPACE, body, attributeEnd) ?? attributeEnd;
    if (body[cursor] !== '=') {
      cursor = attributeEnd;
      continue;
    }
    cursor = tokenEnd(HTML_WHITESPACE, body, cursor + 1) ?? cursor + 1;
    const valueEnd = tokenEnd(HTML_ATTRIBUTE_VALUE, body, cursor);
    if (valueEnd === null) return false;
    cursor = valueEnd;
  }
  return true;
}

function quotedAngleEnd(source: string, from: number): number | null {
  let quote = '';
  for (let cursor = from + 1; cursor < source.length; cursor++) {
    const character = source[cursor] ?? '';
    if (quote) {
      if (character === quote) quote = '';
      continue;
    }
    if (character === '"' || character === "'") quote = character;
    else if (character === '>') return cursor + 1;
  }
  return null;
}

function angleLiteralEnd(source: string, from: number): number | null {
  if (source[from] !== '<' || isEscaped(source, from)) return null;

  const terminatedLiteral = (delimiter: string): number | null => {
    const close = source.indexOf(delimiter, from + 2);
    return close < 0 ? null : close + delimiter.length;
  };
  if (source.startsWith('<?', from)) return terminatedLiteral('?>');
  if (source.startsWith('<![CDATA[', from)) return terminatedLiteral(']]>');
  if (source.startsWith('<!', from)) {
    const to = terminatedLiteral('>');
    if (to === null) return null;
    return ASCII_LETTER.test(source[from + 2] ?? '') ? to : null;
  }

  const autolinkClose = source.indexOf('>', from + 1);
  if (autolinkClose >= 0) {
    const content = source.slice(from + 1, autolinkClose);
    if (isUriAutolink(content) || isEmailAutolink(content)) return autolinkClose + 1;
  }

  const htmlClose = quotedAngleEnd(source, from);
  if (htmlClose === null) return null;
  const candidate = source.slice(from, htmlClose);
  return isHtmlTag(candidate) ? htmlClose : null;
}

function wikiLinkTargetRange(
  source: string,
  from: number,
): { readonly target: SourceRange; readonly to: number } | null {
  if (!source.startsWith('[[', from) || isEscaped(source, from)) return null;
  let pipe = -1;
  for (let cursor = from + 2; cursor < source.length - 1; cursor++) {
    if (source[cursor] === '\\') {
      cursor++;
      continue;
    }
    if (source[cursor] === '|' && pipe < 0) pipe = cursor;
    if (source[cursor] === ']' && source[cursor + 1] === ']') {
      return {
        target: { from: from + 2, to: pipe >= 0 ? pipe : cursor },
        to: cursor + 2,
      };
    }
  }
  return null;
}

function referenceDefinitionEnd(source: string, from: number): number | null {
  if (from > 0 && source[from - 1] !== '\n') return null;
  const newline = source.indexOf('\n', from);
  const to = newline < 0 ? source.length : newline + 1;
  const line = source.slice(from, newline < 0 ? to : newline).replace(/\r$/u, '');
  let cursor = 0;
  while (cursor < 3 && line[cursor] === ' ') cursor++;
  if (line[cursor] !== '[') return null;
  cursor++;
  while (cursor < line.length) {
    if (line[cursor] === '\\') {
      cursor += 2;
      continue;
    }
    if (line[cursor] === ']') break;
    cursor++;
  }
  if (line[cursor] !== ']' || line[cursor + 1] !== ':') return null;
  return to;
}

function mergeSourceRanges(ranges: readonly SourceRange[]): readonly SourceRange[] {
  const ordered = [...ranges].sort((left, right) => left.from - right.from || left.to - right.to);
  const merged: SourceRange[] = [];
  for (const range of ordered) {
    const previous = merged[merged.length - 1];
    if (!previous || previous.to < range.from) {
      merged.push(range);
      continue;
    }
    if (range.to > previous.to) {
      merged[merged.length - 1] = { from: previous.from, to: range.to };
    }
  }
  return merged;
}

interface SemanticLiteralMatch {
  readonly range: SourceRange;
  readonly scanTo: number;
}

function commentLiteralAt(source: string, from: number): SemanticLiteralMatch | null {
  if (source.startsWith('<!--', from)) {
    const close = source.indexOf('-->', from + 4);
    const to = close < 0 ? source.length : close + 3;
    return { range: { from, to }, scanTo: to };
  }
  if (!source.startsWith('%%', from) || isEscaped(source, from)) return null;
  const to = closingDelimiter(source, from + 2, '%%');
  return to === null ? null : { range: { from, to }, scanTo: to };
}

function mathLiteralAt(source: string, from: number): SemanticLiteralMatch | null {
  if (source[from] !== '$' || isEscaped(source, from)) return null;
  let length = 1;
  while (source[from + length] === '$') length++;
  const delimiter = '$'.repeat(length);
  const to = closingDelimiter(source, from + length, delimiter);
  return to === null ? null : { range: { from, to }, scanTo: to };
}

function semanticLiteralAt(source: string, from: number): SemanticLiteralMatch | null {
  const definitionEnd = referenceDefinitionEnd(source, from);
  if (definitionEnd !== null) {
    return { range: { from, to: definitionEnd }, scanTo: definitionEnd };
  }

  const comment = commentLiteralAt(source, from);
  if (comment) return comment;

  const wiki = wikiLinkTargetRange(source, from);
  if (wiki) return { range: wiki.target, scanTo: wiki.to };

  const destination = markdownLinkDestinationRange(source, from);
  if (destination) {
    return { range: destination.destination, scanTo: destination.to };
  }

  if (source[from] === '<') {
    const to = angleLiteralEnd(source, from);
    if (to !== null) return { range: { from, to }, scanTo: to };
  }

  return mathLiteralAt(source, from);
}

/**
 * Locates Markdown regions whose bytes are syntax or literal content rather than visible prose.
 * The rename pass consumes this one ordered range set, so destinations, raw markup, comments,
 * code, and math all share the same lossless boundary contract.
 */
function markdownSemanticLiteralRanges(source: string): readonly SourceRange[] {
  const codeRanges = excludedCodeRanges(source);
  const ranges: SourceRange[] = [...codeRanges];
  let codeIndex = 0;
  let cursor = 0;
  while (cursor < source.length) {
    while (codeRanges[codeIndex] && codeRanges[codeIndex]!.to <= cursor) codeIndex++;
    const code = codeRanges[codeIndex];
    if (code && code.from <= cursor) {
      cursor = code.to;
      continue;
    }

    const literal = semanticLiteralAt(source, cursor);
    if (literal) {
      ranges.push(literal.range);
      cursor = literal.scanTo;
      continue;
    }

    cursor++;
  }
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
    while (excluded[rangeIndex] && (excluded[rangeIndex]?.to ?? 0) <= offset) rangeIndex++;
    const range = excluded[rangeIndex];
    if ((range && range.from <= offset && offset < range.to) || isEscaped(source, offset)) {
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
  if (!frontmatter) return transformBodyTags(source, oldTag, newTag, scope);

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
