// @vitest-environment node
import { Platform } from 'obsidian';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const nodeTools = async () => {
  if (!Platform.isDesktop) throw new Error('Installed compatibility fixtures require desktop');
  return Promise.all([import('node:fs'), import('node:module'), import('node:vm')]);
};
const [{ readFileSync }, { createRequire }, { compileFunction }] = await nodeTools();
const require = createRequire(import.meta.url);
const sdkRequire = createRequire(require.resolve('@ai-sdk/openai'));

// The legacy converter is bundled privately. Exercise its actual installed function,
// rather than inventing a public provider option or duplicating its implementation.
function converter(entry: string): (regex: RegExp, refs: object) => string {
  const text = readFileSync(
    (entry.startsWith('@ai-sdk/') ? sdkRequire : require).resolve(entry),
    'utf8',
  );
  const source = ts.createSourceFile(
    'provider.js',
    text,
    ts.ScriptTarget.ESNext,
    true,
    ts.ScriptKind.JS,
  );
  const declaration = source.statements.find(
    (node) => ts.isFunctionDeclaration(node) && node.name?.text === 'stringifyRegExpWithFlags',
  );
  if (declaration === undefined) throw new Error('Recheck the pinned provider compatibility patch');
  return compileFunction(
    `${declaration.getText(source)}; return stringifyRegExpWithFlags(regex, refs);`,
    ['regex', 'refs'],
  ) as (regex: RegExp, refs: object) => string;
}

describe.each([
  '@openrouter/ai-sdk-provider',
  '@openrouter/ai-sdk-provider/internal',
  '@ai-sdk/provider-utils',
  '@ai-sdk/provider-utils/experimental-decision',
  '@ai-sdk/provider-utils/experimental-evaluation',
])('pinned converter in %s', (entry) => {
  it('refuses multiline flag expansion while preserving default and i/s semantics', () => {
    const convert = converter(entry);
    expect(() => convert(/^hello$/m, { applyRegexFlags: true })).toThrow(
      'Multiline regex flag expansion is unsupported',
    );
    expect(convert(/^hello$/m, { applyRegexFlags: false })).toBe('^hello$');
    const pattern = new RegExp(convert(/^a.b$/is, { applyRegexFlags: true }));
    expect(pattern.test('A\nB')).toBe(true);
    expect(pattern.test('acbd')).toBe(false);
  });
});
