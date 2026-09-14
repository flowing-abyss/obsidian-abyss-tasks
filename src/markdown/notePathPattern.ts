import { moment } from 'obsidian';

export interface NotePathPattern {
  resolve(date: string): string;
  matches(filePath: string): boolean;
}

interface Marker {
  readonly format: string;
  readonly matcher: string;
}

interface PatternSegment {
  readonly literal: string;
  readonly marker: Marker | undefined;
  readonly next: number;
}

const FORMAT_TOKENS = [
  'GGGG',
  'YYYY',
  'DDDD',
  'DDD',
  'YY',
  'MM',
  'DD',
  'WW',
  'M',
  'D',
  'Q',
  'W',
] as const;

const TOKEN_MATCHERS: Readonly<Record<(typeof FORMAT_TOKENS)[number], string>> = {
  GGGG: '\\d{4}',
  YYYY: '\\d{4}',
  DDDD: '(?:00[1-9]|0[1-9]\\d|[12]\\d{2}|3[0-5]\\d|36[0-6])',
  DDD: '(?:[1-9]|[1-9]\\d|[12]\\d{2}|3[0-5]\\d|36[0-6])',
  YY: '\\d{2}',
  MM: '(?:0[1-9]|1[0-2])',
  DD: '(?:0[1-9]|[12]\\d|3[01])',
  WW: '(?:0[1-9]|[1-4]\\d|5[0-3])',
  M: '(?:[1-9]|1[0-2])',
  D: '(?:[1-9]|[12]\\d|3[01])',
  Q: '[1-4]',
  W: '(?:[1-9]|[1-4]\\d|5[0-3])',
};

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function throwMalformedBraces(condition: boolean): void {
  if (condition) throw new Error('Malformed braces in note path pattern.');
}

function tokenAt(
  format: string,
  cursor: number,
): { readonly run: string; readonly end: number } | undefined {
  const character = format[cursor];
  if (character === undefined || !/[A-Za-z]/u.test(character)) return undefined;
  let end = cursor + 1;
  while (format[end] === character) end += 1;
  return { run: format.slice(cursor, end), end };
}

function bracketLiteral(
  format: string,
  cursor: number,
): { readonly matcher: string; readonly next: number } {
  const close = format.indexOf(']', cursor + 1);
  if (close < 0) throw new Error('Note path date format has an unclosed bracket literal.');
  return { matcher: escapeRegex(format.slice(cursor + 1, close)), next: close + 1 };
}

function compiledFormatPart(
  format: string,
  cursor: number,
): { readonly matcher: string; readonly next: number; readonly hasDateToken: boolean } {
  const character = format[cursor];
  if (character === '[') {
    const literal = bracketLiteral(format, cursor);
    return { matcher: literal.matcher, next: literal.next, hasDateToken: false };
  }
  if (character === ']') throw new Error('Note path date format has an unmatched bracket.');
  const tokenRun = tokenAt(format, cursor);
  if (tokenRun === undefined) {
    return { matcher: escapeRegex(character ?? ''), next: cursor + 1, hasDateToken: false };
  }
  const token = FORMAT_TOKENS.find((candidate) => candidate === tokenRun.run);
  if (token === undefined)
    throw new Error(`Unsupported date token in note path format: ${tokenRun.run}`);
  return { matcher: TOKEN_MATCHERS[token], next: tokenRun.end, hasDateToken: true };
}

function compileFormat(format: string): Marker {
  if (format.length === 0) throw new Error('Note path date format cannot be empty.');
  let matcher = '';
  let cursor = 0;
  let hasDateToken = false;
  while (cursor < format.length) {
    const part = compiledFormatPart(format, cursor);
    matcher += part.matcher;
    hasDateToken ||= part.hasDateToken;
    cursor = part.next;
  }
  if (!hasDateToken) throw new Error('Note path date format must contain a supported date token.');
  return { format, matcher };
}

function normalizedPattern(pattern: string): string {
  const trimmed = pattern.trim();
  if (trimmed.length === 0) throw new Error('Task file path cannot be empty.');
  if (/^(?:\/|\\|[A-Za-z]:[\\/])/u.test(trimmed)) {
    throw new Error('Task file path must be relative to the vault.');
  }
  if (trimmed.includes('\\')) throw new Error('Task file path must use forward slashes.');
  const segments = trimmed.split('/');
  if (segments.some((segment) => segment === '.' || segment === '..')) {
    throw new Error('Task file path cannot traverse outside the vault.');
  }
  if (segments.some((segment) => segment.length === 0)) {
    throw new Error('Task file path cannot contain empty folders.');
  }
  return trimmed.toLowerCase().endsWith('.md') ? trimmed : `${trimmed}.md`;
}

function remainingPatternSegment(
  source: string,
  cursor: number,
  strayClosing: number,
): PatternSegment {
  const literal = source.slice(cursor);
  throwMalformedBraces(strayClosing >= 0 || /[{}]/u.test(literal));
  return { literal, marker: undefined, next: source.length };
}

function markedPatternSegment(
  source: string,
  cursor: number,
  opening: number,
  strayClosing: number,
): PatternSegment {
  throwMalformedBraces(strayClosing >= 0 && strayClosing < opening);
  const literal = source.slice(cursor, opening);
  throwMalformedBraces(/[{}]/u.test(literal));
  const closing = source.indexOf('}}', opening + 2);
  throwMalformedBraces(closing < 0);
  const body = source.slice(opening + 2, closing);
  throwMalformedBraces(body.includes('{') || body.includes('}'));
  const format = body.startsWith('DATE:') ? body.slice('DATE:'.length) : body;
  return { literal, marker: compileFormat(format), next: closing + 2 };
}

function nextPatternSegment(source: string, cursor: number): PatternSegment {
  const opening = source.indexOf('{{', cursor);
  const strayClosing = source.indexOf('}}', cursor);
  return opening < 0
    ? remainingPatternSegment(source, cursor, strayClosing)
    : markedPatternSegment(source, cursor, opening, strayClosing);
}

function matcherPart(literal: string, marker: Marker | undefined): string {
  if (marker === undefined) return escapeRegex(literal);
  return `${escapeRegex(literal)}(${marker.matcher})`;
}

export function compileNotePathPattern(pattern: string): NotePathPattern {
  const source = normalizedPattern(pattern);
  const literals: string[] = [];
  const markers: Marker[] = [];
  let cursor = 0;
  while (cursor < source.length) {
    const segment = nextPatternSegment(source, cursor);
    literals.push(segment.literal);
    if (segment.marker !== undefined) markers.push(segment.marker);
    cursor = segment.next;
  }
  if (literals.length === markers.length) literals.push('');

  const matcherSource = literals
    .map((literal, index) => matcherPart(literal, markers[index]))
    .join('');
  const matcher = new RegExp(`^${matcherSource}$`, 'u');
  const combinedFormat = markers.map(({ format }) => format).join('[\u0001]');

  return {
    resolve(date: string): string {
      const parsed = moment(date, 'YYYY-MM-DD', true);
      if (!parsed.isValid() || parsed.format('YYYY-MM-DD') !== date) {
        throw new Error(`Invalid local date: ${date}`);
      }
      let resolved = literals[0] ?? '';
      for (const [index, marker] of markers.entries()) {
        resolved += parsed.format(marker.format) + (literals[index + 1] ?? '');
      }
      return resolved;
    },
    matches(filePath: string): boolean {
      const match = matcher.exec(filePath);
      if (match === null) return false;
      if (markers.length === 0) return true;
      const values = match.slice(1);
      const combinedValue = values.join('\u0001');
      const parsed = moment(combinedValue, combinedFormat, true);
      return parsed.isValid() && parsed.format(combinedFormat) === combinedValue;
    },
  };
}
