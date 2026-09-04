export function evaluateQuery(
  query: string,
  filePath: string,
  fileTags: string[],
  frontmatter: Record<string, unknown>,
): boolean {
  if (query.trim().length === 0) return false;
  const orGroups = splitOuter(query, ' OR ');
  return orGroups.some((group) => {
    const andTerms = splitOuter(group, ' AND ');
    return andTerms.every((term) => evaluateTerm(term.trim(), filePath, fileTags, frontmatter));
  });
}

function splitOuter(input: string, sep: string): string[] {
  const results: string[] = [];
  let depth = 0;
  let quoteChar: string | undefined;
  let start = 0;
  const s = input.toUpperCase();
  const sepUpper = sep.toUpperCase();
  for (let i = 0; i < input.length; i++) {
    const ch = input[i] ?? '';
    const structure = consumeStructure(ch, depth, quoteChar);
    depth = structure.depth;
    quoteChar = structure.quoteChar;
    if (!structure.consumed && depth === 0 && s.startsWith(sepUpper, i)) {
      results.push(input.slice(start, i).trim());
      i += sep.length - 1;
      start = i + 1;
    }
  }
  results.push(input.slice(start).trim());
  return results.filter((part) => part.length > 0);
}

interface QueryStructure {
  readonly depth: number;
  readonly quoteChar: string | undefined;
  readonly consumed: boolean;
}

function consumeStructure(
  char: string,
  depth: number,
  quoteChar: string | undefined,
): QueryStructure {
  if (quoteChar !== undefined) {
    return { depth, quoteChar: char === quoteChar ? undefined : quoteChar, consumed: true };
  }
  if (char === '"' || char === "'") return { depth, quoteChar: char, consumed: true };
  if (char === '(') return { depth: depth + 1, quoteChar, consumed: true };
  if (char === ')') return { depth: depth - 1, quoteChar, consumed: true };
  return { depth, quoteChar, consumed: false };
}

function evaluateTerm(
  raw: string,
  filePath: string,
  fileTags: string[],
  frontmatter: Record<string, unknown>,
): boolean {
  let term = raw.trim();
  let negate = false;
  while (term.length > 0) {
    if (term.startsWith('-')) {
      negate = !negate;
      term = term.slice(1).trim();
    } else if (/^NOT\s+/i.test(term)) {
      negate = !negate;
      term = term.slice(3).trim();
    } else break;
  }
  if (term.length === 0) return false;
  const matches = evaluateBaseTerm(term, filePath, fileTags, frontmatter);
  return negate ? !matches : matches;
}

function evaluateBaseTerm(
  raw: string,
  filePath: string,
  fileTags: string[],
  frontmatter: Record<string, unknown>,
): boolean {
  const term = raw;
  if (term.startsWith('(') && term.endsWith(')')) {
    return evaluateQuery(term.slice(1, -1).trim(), filePath, fileTags, frontmatter);
  }
  if (term.startsWith('#')) {
    const tagName = term.slice(1).toLowerCase();
    return fileTags.some((t) => {
      const ft = t.replace(/^#/, '').toLowerCase();
      return ft === tagName || ft.startsWith(`${tagName}/`);
    });
  }
  const eqIdx = term.indexOf('=');
  if (eqIdx !== -1 && !term.startsWith('"') && !term.startsWith("'")) {
    const key = term.slice(0, eqIdx).trim();
    const val = term
      .slice(eqIdx + 1)
      .trim()
      .replace(/^["']|["']$/g, '');
    const fmVal = frontmatter[key];
    // eslint-disable-next-line @typescript-eslint/no-base-to-string -- Query equality follows Obsidian frontmatter string coercion.
    return (fmVal === null || fmVal === undefined ? '' : String(fmVal)) === val;
  }
  const folderRaw = term.replace(/^["']|["']$/g, '');
  if (folderRaw.endsWith('/')) return filePath.startsWith(folderRaw);
  return false;
}
