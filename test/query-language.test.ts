import { describe, expect, it } from 'vitest';
import { compileQuery, evaluateCompiledQuery, evaluateQuery } from '../src/query/compileQuery';

const candidate = (
  path = 'Projects/Alpha.md',
  tags: readonly string[] = ['#project/active'],
  frontmatter: Record<string, unknown> = {},
) => ({ path, tags, frontmatter });

describe('vault membership query compiler', () => {
  it('evaluates nested parentheses with NOT, AND, and OR precedence', () => {
    const query = compileQuery('#alpha OR (#beta AND NOT #archived)');

    expect(query.state).toBe('valid');
    expect(evaluateCompiledQuery(query, candidate('A.md', ['#beta']))).toBe(true);
    expect(evaluateCompiledQuery(query, candidate('A.md', ['#beta', '#archived']))).toBe(false);
    expect(evaluateCompiledQuery(query, candidate('A.md', ['#alpha', '#archived']))).toBe(true);
  });

  it('recognizes case-insensitive keywords at parenthesis boundaries with flexible whitespace', () => {
    const query = compileQuery('( #project )aNd( status = active )oR( #archive )');

    expect(query.state).toBe('valid');
    expect(
      evaluateCompiledQuery(query, candidate('A.md', ['#project'], { status: 'active' })),
    ).toBe(true);
    expect(evaluateCompiledQuery(query, candidate('A.md', ['#archive']))).toBe(true);
    expect(evaluateCompiledQuery(query, candidate('A.md', ['#project'], { status: 'done' }))).toBe(
      false,
    );
  });

  it('matches folder and quoted-folder terms', () => {
    expect(evaluateQuery('Projects/', 'Projects/A.md', [], {})).toBe(true);
    expect(evaluateQuery('"Project Plans/"', 'Project Plans/A.md', [], {})).toBe(true);
    expect(evaluateQuery('"Project Plans/"', 'Projects/A.md', [], {})).toBe(false);
  });

  it('matches hierarchical tags and scalar or array frontmatter properties without object coercion', () => {
    const query = compileQuery('#project AND status="in progress" AND priority=2');

    expect(query.state).toBe('valid');
    expect(
      evaluateCompiledQuery(
        query,
        candidate('A.md', ['#project/client'], { status: ['backlog', 'in progress'], priority: 2 }),
      ),
    ).toBe(true);
    expect(
      evaluateCompiledQuery(
        query,
        candidate('A.md', ['#project'], { status: { value: 'in progress' }, priority: 2 }),
      ),
    ).toBe(false);
  });

  it('keeps legacy frontmatter keys containing spaces', () => {
    expect(
      evaluateQuery('Project Status = active', 'A.md', [], { 'Project Status': 'active' }),
    ).toBe(true);
  });

  it('decodes quoted values and folder paths with quote and backslash escaping', () => {
    expect(
      evaluateQuery('title="A \\"quoted\\" \\\\ path"', 'A.md', [], {
        title: 'A "quoted" \\ path',
      }),
    ).toBe(true);
    expect(evaluateQuery('"Project \\"Alpha\\"/"', 'Project "Alpha"/A.md', [], {})).toBe(true);
  });

  it('represents a blank disabled slot intentionally and rejects a blank enabled required slot', () => {
    expect(compileQuery('   ', { enabled: false, required: false })).toEqual({
      state: 'disabled',
      source: '   ',
    });
    expect(compileQuery('   ', { enabled: true, required: true })).toMatchObject({
      state: 'invalid',
      diagnostic: { code: 'empty-required-query', offset: 0 },
    });
  });

  it('reports stable source offsets for unfinished structure and values', () => {
    expect(compileQuery('#tag AND (')).toMatchObject({
      state: 'invalid',
      diagnostic: { code: 'unclosed-parenthesis', offset: 9 },
    });
    expect(compileQuery('title="unfinished')).toMatchObject({
      state: 'invalid',
      diagnostic: { code: 'unterminated-quote', offset: 6 },
    });
    expect(compileQuery('#tag AND )')).toMatchObject({
      state: 'invalid',
      diagnostic: { code: 'expected-term', offset: 9 },
    });
  });
});
