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
  const excluded = excludedCodeRanges(source);
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
