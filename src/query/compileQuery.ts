export interface QueryCandidate {
  readonly path: string;
  readonly tags: readonly string[];
  readonly frontmatter: Readonly<Record<string, unknown>>;
}

export interface QueryDiagnostic {
  readonly code:
    | 'empty-required-query'
    | 'expected-term'
    | 'expected-property-value'
    | 'expected-closing-parenthesis'
    | 'unclosed-parenthesis'
    | 'unterminated-quote'
    | 'unsupported-term'
    | 'unexpected-token';
  readonly offset: number;
}

interface TagExpression {
  readonly type: 'tag';
  readonly value: string;
}

interface FolderExpression {
  readonly type: 'folder';
  readonly value: string;
}

interface PropertyExpression {
  readonly type: 'property';
  readonly key: string;
  readonly value: string;
}

interface NotExpression {
  readonly type: 'not';
  readonly expression: QueryExpression;
}

interface BinaryExpression {
  readonly type: 'and' | 'or';
  readonly left: QueryExpression;
  readonly right: QueryExpression;
}

type QueryExpression =
  | TagExpression
  | FolderExpression
  | PropertyExpression
  | NotExpression
  | BinaryExpression;

export type CompiledQuery =
  | { readonly state: 'disabled'; readonly source: string }
  | { readonly state: 'invalid'; readonly source: string; readonly diagnostic: QueryDiagnostic }
  | { readonly state: 'valid'; readonly source: string; readonly expression: QueryExpression };

export interface QueryCompileOptions {
  readonly enabled?: boolean;
  readonly required?: boolean;
}

function isWhitespace(character: string | undefined): boolean {
  return character !== undefined && /\s/u.test(character);
}

function isOperatorBoundary(character: string | undefined): boolean {
  return (
    character === undefined ||
    isWhitespace(character) ||
    character === '(' ||
    character === ')' ||
    character === '-' ||
    character === '#' ||
    character === '"' ||
    character === "'"
  );
}

class QueryParser {
  private offset = 0;
  private diagnostic?: QueryDiagnostic;

  constructor(private readonly source: string) {}

  parse(): { readonly expression?: QueryExpression; readonly diagnostic?: QueryDiagnostic } {
    const expression = this.expression();
    this.whitespace();
    if (!this.diagnostic && expression && this.offset !== this.source.length) {
      this.fail('unexpected-token', this.offset);
    }
    return this.diagnostic ? { diagnostic: this.diagnostic } : { expression };
  }

  private expression(): QueryExpression | undefined {
    let left = this.conjunction();
    while (left && this.binaryKeyword('OR')) {
      const right = this.conjunction();
      if (!right) return undefined;
      left = { type: 'or', left, right };
    }
    return left;
  }

  private conjunction(): QueryExpression | undefined {
    let left = this.unary();
    while (left && this.binaryKeyword('AND')) {
      const right = this.unary();
      if (!right) return undefined;
      left = { type: 'and', left, right };
    }
    return left;
  }

  private unary(): QueryExpression | undefined {
    this.whitespace();
    if (this.keyword('NOT')) {
      const expression = this.unary();
      if (!expression) return undefined;
      return { type: 'not', expression };
    }
    if (this.source[this.offset] === '-') {
      this.offset += 1;
      const expression = this.unary();
      if (!expression) return undefined;
      return { type: 'not', expression };
    }
    return this.primary();
  }

  private primary(): QueryExpression | undefined {
    this.whitespace();
    const start = this.offset;
    if (this.source[this.offset] === '(') {
      this.offset += 1;
      this.whitespace();
      if (this.offset === this.source.length) {
        this.fail('unclosed-parenthesis', start);
        return undefined;
      }
      const expression = this.expression();
      if (!expression) return undefined;
      this.whitespace();
      if (this.source[this.offset] !== ')') {
        this.fail(
          this.offset === this.source.length
            ? 'unclosed-parenthesis'
            : 'expected-closing-parenthesis',
          start,
        );
        return undefined;
      }
      this.offset += 1;
      return expression;
    }
    if (this.source[this.offset] === ')' || this.offset === this.source.length) {
      this.fail('expected-term', this.offset);
      return undefined;
    }
    if (this.source[this.offset] === '#') {
      const value = this.bare();
      return { type: 'tag', value };
    }
    if (this.source[this.offset] === '"' || this.source[this.offset] === "'") {
      const value = this.quoted();
      if (value === undefined) return undefined;
      if (!value.endsWith('/')) {
        this.fail('unsupported-term', start);
        return undefined;
      }
      return { type: 'folder', value };
    }

    const equalsOffset = this.propertyEquals(start);
    if (equalsOffset !== undefined) {
      const key = this.source.slice(start, equalsOffset).trim();
      this.offset = equalsOffset + 1;
      this.whitespace();
      const valueOffset = this.offset;
      if (
        this.offset === this.source.length ||
        this.source[this.offset] === ')' ||
        this.keywordAt(this.offset, 'AND') ||
        this.keywordAt(this.offset, 'OR')
      ) {
        this.fail('expected-property-value', valueOffset);
        return undefined;
      }
      const value =
        this.source[this.offset] === '"' || this.source[this.offset] === "'"
          ? this.quoted()
          : this.bare();
      if (value === undefined || value.length === 0) {
        if (!this.diagnostic) this.fail('expected-property-value', valueOffset);
        return undefined;
      }
      return { type: 'property', key, value };
    }
    const keyOrFolder = this.bare();
    this.whitespace();
    if (!keyOrFolder.endsWith('/')) {
      this.fail('unsupported-term', start);
      return undefined;
    }
    return { type: 'folder', value: keyOrFolder };
  }

  private keyword(word: 'AND' | 'OR' | 'NOT'): boolean {
    this.whitespace();
    if (!this.keywordAt(this.offset, word)) {
      return false;
    }
    this.offset += word.length;
    return true;
  }

  private binaryKeyword(word: 'AND' | 'OR'): boolean {
    this.whitespace();
    const operatorOffset = this.offset;
    if (!this.keywordAt(operatorOffset, word)) return false;
    if (
      !isWhitespace(this.source[operatorOffset - 1]) ||
      !isWhitespace(this.source[operatorOffset + word.length])
    ) {
      return false;
    }
    this.offset += word.length;
    return true;
  }

  private bare(stopAtEquals = false): string {
    const start = this.offset;
    while (this.offset < this.source.length) {
      const character = this.source[this.offset];
      if (
        isWhitespace(character) ||
        character === '(' ||
        character === ')' ||
        (stopAtEquals && character === '=')
      ) {
        break;
      }
      this.offset += 1;
    }
    return this.source.slice(start, this.offset);
  }

  private propertyEquals(start: number): number | undefined {
    let index = start;
    while (index < this.source.length) {
      const character = this.source[index];
      if (character === '=') return index;
      if (character === '(' || character === ')') return undefined;
      if (isWhitespace(character)) {
        while (isWhitespace(this.source[index])) index += 1;
        if (this.keywordAt(index, 'AND') || this.keywordAt(index, 'OR')) return undefined;
        continue;
      }
      index += 1;
    }
    return undefined;
  }

  private keywordAt(offset: number, word: 'AND' | 'OR' | 'NOT'): boolean {
    return (
      this.source.slice(offset, offset + word.length).toUpperCase() === word &&
      isOperatorBoundary(this.source[offset - 1]) &&
      isOperatorBoundary(this.source[offset + word.length])
    );
  }

  private quoted(): string | undefined {
    const start = this.offset;
    const quote = this.source[this.offset]!;
    this.offset += 1;
    let value = '';
    while (this.offset < this.source.length) {
      const character = this.source[this.offset]!;
      this.offset += 1;
      if (character === quote) return value;
      if (character === '\\') {
        const escaped = this.source[this.offset];
        if (escaped === undefined) break;
        value += escaped;
        this.offset += 1;
      } else {
        value += character;
      }
    }
    this.fail('unterminated-quote', start);
    return undefined;
  }

  private whitespace(): void {
    while (isWhitespace(this.source[this.offset])) this.offset += 1;
  }

  private fail(code: QueryDiagnostic['code'], offset: number): void {
    this.diagnostic ??= { code, offset };
  }
}

export function compileQuery(source: string, options: QueryCompileOptions = {}): CompiledQuery {
  const enabled = options.enabled ?? true;
  const required = options.required ?? true;
  if (!source.trim()) {
    if (!enabled || !required) return { state: 'disabled', source };
    return {
      state: 'invalid',
      source,
      diagnostic: { code: 'empty-required-query', offset: 0 },
    };
  }
  if (!enabled) return { state: 'disabled', source };
  const parsed = new QueryParser(source).parse();
  if (!parsed.expression) {
    return {
      state: 'invalid',
      source,
      diagnostic: parsed.diagnostic ?? { code: 'expected-term', offset: 0 },
    };
  }
  return { state: 'valid', source, expression: parsed.expression };
}

function scalarMatches(value: unknown, expected: string): boolean {
  if (Array.isArray(value)) return value.some((entry) => scalarMatches(entry, expected));
  if (value === undefined || value === null) return expected === '';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value) === expected;
  }
  return false;
}

function matches(expression: QueryExpression, candidate: QueryCandidate): boolean {
  switch (expression.type) {
    case 'and':
      return matches(expression.left, candidate) && matches(expression.right, candidate);
    case 'or':
      return matches(expression.left, candidate) || matches(expression.right, candidate);
    case 'not':
      return !matches(expression.expression, candidate);
    case 'folder':
      return candidate.path.startsWith(expression.value);
    case 'property':
      return scalarMatches(candidate.frontmatter[expression.key], expression.value);
    case 'tag': {
      const tag = expression.value.slice(1).toLowerCase();
      return candidate.tags.some((entry) => {
        const normalized = entry.replace(/^#/u, '').toLowerCase();
        return normalized === tag || normalized.startsWith(`${tag}/`);
      });
    }
  }
}

export function evaluateCompiledQuery(query: CompiledQuery, candidate: QueryCandidate): boolean {
  return query.state === 'valid' && matches(query.expression, candidate);
}

export function evaluateQuery(
  query: string,
  filePath: string,
  fileTags: readonly string[],
  frontmatter: Readonly<Record<string, unknown>>,
): boolean {
  return evaluateCompiledQuery(compileQuery(query), {
    path: filePath,
    tags: fileTags,
    frontmatter,
  });
}
