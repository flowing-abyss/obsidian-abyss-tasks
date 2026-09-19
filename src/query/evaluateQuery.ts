import { compileNotePathPattern } from '../markdown/notePathPattern';

type Token =
  | { readonly type: 'and' | 'or' | 'not' | 'minus' | 'left' | 'right' | 'end' }
  | { readonly type: 'atom'; readonly value: string }
  | { readonly type: 'path'; readonly value: string };

type QueryNode =
  | { readonly type: 'and' | 'or'; readonly left: QueryNode; readonly right: QueryNode }
  | { readonly type: 'not'; readonly child: QueryNode }
  | { readonly type: 'atom' | 'path'; readonly value: string };

export type QuerySyntaxValidation =
  { readonly type: 'valid' } | { readonly type: 'invalid'; readonly message: string };

class QuerySyntaxError extends Error {}

function quotedValue(
  input: string,
  start: number,
): { readonly value: string; readonly next: number } {
  const quote = input[start];
  let value = '';
  for (let cursor = start + 1; cursor < input.length; cursor++) {
    const character = input[cursor] ?? '';
    if (character === '\\') {
      const escaped = input[cursor + 1];
      if (escaped === undefined) throw new QuerySyntaxError('Quoted value ends with an escape.');
      value += escaped;
      cursor += 1;
    } else if (character === quote) {
      return { value, next: cursor + 1 };
    } else {
      value += character;
    }
  }
  throw new QuerySyntaxError('Quoted value is not closed.');
}

function atomEnd(input: string, start: number): number {
  let cursor = start;
  while (cursor < input.length) {
    const character = input[cursor] ?? '';
    if (/\s/u.test(character) || character === '(' || character === ')') break;
    cursor = character === '"' || character === "'" ? quotedValue(input, cursor).next : cursor + 1;
  }
  return cursor;
}

function punctuationToken(character: string): Token | undefined {
  if (character === '(') return { type: 'left' };
  if (character === ')') return { type: 'right' };
  if (character === '-') return { type: 'minus' };
  return undefined;
}

function atomToken(value: string): Token {
  const operator = value.toUpperCase();
  if (operator === 'AND') return { type: 'and' };
  if (operator === 'OR') return { type: 'or' };
  if (operator === 'NOT') return { type: 'not' };
  return { type: 'atom', value };
}

function booleanOperatorAt(input: string, cursor: number): boolean {
  const rest = input.slice(cursor);
  return /^(?:AND|OR)(?=$|\s|[()])/iu.test(rest);
}

function nextNonWhitespace(input: string, cursor: number): number {
  let next = cursor;
  while (/\s/u.test(input[next] ?? '')) next++;
  return next;
}

type EqualityScanStep =
  | { readonly type: 'advance'; readonly next: number }
  | { readonly type: 'end'; readonly at: number };

function equalityScanStep(input: string, cursor: number): EqualityScanStep {
  const character = input[cursor] ?? '';
  if (character === '"' || character === "'") {
    return { type: 'advance', next: quotedValue(input, cursor).next };
  }
  if (character === '(' || character === ')') return { type: 'end', at: cursor };
  if (!/\s/u.test(character)) return { type: 'advance', next: cursor + 1 };
  const next = nextNonWhitespace(input, cursor + 1);
  return booleanOperatorAt(input, next) ? { type: 'end', at: cursor } : { type: 'advance', next };
}

function equalityTermEnd(input: string, start: number): number {
  let cursor = start;
  while (cursor < input.length) {
    const step = equalityScanStep(input, cursor);
    if (step.type === 'end') return step.at;
    cursor = step.next;
  }
  return input.length;
}

function equalityToken(
  input: string,
  start: number,
): { readonly token: Token; readonly next: number } | undefined {
  const end = equalityTermEnd(input, start);
  const value = input.slice(start, end).trim();
  const equals = value.indexOf('=');
  if (equals < 0 || value.slice(0, equals).trim().length === 0) return undefined;
  return { token: { type: 'atom', value }, next: end };
}

function readToken(
  input: string,
  cursor: number,
): { readonly token: Token; readonly next: number } {
  const character = input[cursor] ?? '';
  const punctuation = punctuationToken(character);
  if (punctuation !== undefined) return { token: punctuation, next: cursor + 1 };
  if (character === '"' || character === "'") {
    const quoted = quotedValue(input, cursor);
    return { token: { type: 'path', value: quoted.value }, next: quoted.next };
  }
  const end = atomEnd(input, cursor);
  if (end === cursor) throw new QuerySyntaxError('Expected a query term.');
  const atom = atomToken(input.slice(cursor, end));
  if (atom.type !== 'atom') return { token: atom, next: end };
  const equality = equalityToken(input, cursor);
  if (equality !== undefined) return equality;
  return { token: atom, next: end };
}

function tokenize(input: string): readonly Token[] {
  const tokens: Token[] = [];
  let cursor = 0;
  while (cursor < input.length) {
    const character = input[cursor] ?? '';
    if (/\s/u.test(character)) {
      cursor += 1;
      continue;
    }
    const read = readToken(input, cursor);
    tokens.push(read.token);
    cursor = read.next;
  }
  tokens.push({ type: 'end' });
  return tokens;
}

class QueryParser {
  private cursor = 0;

  constructor(private readonly tokens: readonly Token[]) {}

  parse(): QueryNode {
    const result = this.parseOr();
    if (this.current().type !== 'end') throw new QuerySyntaxError('Unexpected query term.');
    return result;
  }

  private parseOr(): QueryNode {
    let node = this.parseAnd();
    while (this.take('or')) node = { type: 'or', left: node, right: this.parseAnd() };
    return node;
  }

  private parseAnd(): QueryNode {
    let node = this.parseUnary();
    while (this.take('and')) node = { type: 'and', left: node, right: this.parseUnary() };
    return node;
  }

  private parseUnary(): QueryNode {
    let negate = false;
    while (this.take('not') || this.take('minus')) negate = !negate;
    const child = this.parsePrimary();
    return negate ? { type: 'not', child } : child;
  }

  private parsePrimary(): QueryNode {
    if (this.take('left')) {
      const node = this.parseOr();
      if (!this.take('right')) throw new QuerySyntaxError('Query parenthesis is not closed.');
      return node;
    }
    const token = this.current();
    if (token.type !== 'atom' && token.type !== 'path') {
      throw new QuerySyntaxError('Expected a query term.');
    }
    this.cursor += 1;
    return token;
  }

  private take(type: Token['type']): boolean {
    if (this.current().type !== type) return false;
    this.cursor += 1;
    return true;
  }

  private current(): Token {
    return this.tokens[this.cursor] ?? { type: 'end' };
  }
}

function parseQuery(query: string): QueryNode {
  if (query.trim().length === 0) throw new QuerySyntaxError('Query is empty.');
  return new QueryParser(tokenize(query)).parse();
}

function validatePathNodes(node: QueryNode): void {
  if (node.type === 'and' || node.type === 'or') {
    validatePathNodes(node.left);
    validatePathNodes(node.right);
    return;
  }
  if (node.type === 'not') {
    validatePathNodes(node.child);
    return;
  }
  if (node.type !== 'path') return;
  try {
    compileNotePathPattern(node.value.endsWith('/') ? `${node.value}__folder__.md` : node.value);
  } catch (error) {
    throw new QuerySyntaxError(
      error instanceof Error ? error.message : 'Invalid quoted note path.',
    );
  }
}

export function validateQuerySyntax(query: string): QuerySyntaxValidation {
  if (query.trim().length === 0) return { type: 'valid' };
  try {
    validatePathNodes(parseQuery(query));
    return { type: 'valid' };
  } catch (error) {
    return {
      type: 'invalid',
      message: error instanceof Error ? error.message : 'Invalid query.',
    };
  }
}

export function evaluateQuery(
  query: string,
  filePath: string,
  fileTags: string[],
  frontmatter: Record<string, unknown>,
): boolean {
  if (query.trim().length === 0) return false;
  try {
    return evaluateNode(parseQuery(query), filePath, fileTags, frontmatter);
  } catch {
    return false;
  }
}

function evaluateNode(
  node: QueryNode,
  filePath: string,
  fileTags: readonly string[],
  frontmatter: Record<string, unknown>,
): boolean {
  switch (node.type) {
    case 'and':
      return (
        evaluateNode(node.left, filePath, fileTags, frontmatter) &&
        evaluateNode(node.right, filePath, fileTags, frontmatter)
      );
    case 'or':
      return (
        evaluateNode(node.left, filePath, fileTags, frontmatter) ||
        evaluateNode(node.right, filePath, fileTags, frontmatter)
      );
    case 'not':
      return !evaluateNode(node.child, filePath, fileTags, frontmatter);
    case 'path':
      return matchesPath(node.value, filePath);
    case 'atom':
      return evaluateAtom(node.value, filePath, fileTags, frontmatter);
  }
}

function matchesPath(pattern: string, filePath: string): boolean {
  if (pattern.endsWith('/')) {
    return filePath.toLocaleLowerCase().startsWith(pattern.toLocaleLowerCase());
  }
  try {
    return compileNotePathPattern(pattern).matches(filePath);
  } catch {
    return false;
  }
}

function decodeEqualityValue(value: string): string {
  const trimmed = value.trim();
  if (!/^(["']).*\1$/su.test(trimmed)) return trimmed;
  try {
    return quotedValue(trimmed, 0).value;
  } catch {
    return trimmed;
  }
}

function evaluateAtom(
  term: string,
  filePath: string,
  fileTags: readonly string[],
  frontmatter: Record<string, unknown>,
): boolean {
  if (term.startsWith('#')) {
    const tagName = term.slice(1).toLowerCase();
    return fileTags.some((tag) => {
      const normalized = tag.replace(/^#/u, '').toLowerCase();
      return normalized === tagName || normalized.startsWith(`${tagName}/`);
    });
  }
  const equality = term.indexOf('=');
  if (equality >= 0) {
    const key = term.slice(0, equality).trim();
    const expected = decodeEqualityValue(term.slice(equality + 1));
    const value = frontmatter[key];
    // eslint-disable-next-line @typescript-eslint/no-base-to-string -- Query equality follows Obsidian frontmatter string coercion.
    return (value === null || value === undefined ? '' : String(value)) === expected;
  }
  return term.endsWith('/') && filePath.toLocaleLowerCase().startsWith(term.toLocaleLowerCase());
}
