import type postcss from 'postcss';
import { describe, expect, it } from 'vitest';
import { cssDeclarations, cssDeclarationText } from './cssHelpers';

const STYLES = '.abyss-card { color: var(--text-normal); padding: 4px; }';

function written(declarations: readonly postcss.Declaration[]): string[] {
  return declarations.map(({ prop, value }) => `${prop}: ${value}`);
}

describe('CSS helpers', () => {
  it('reads a selector unchanged after a row edits the declarations an earlier read returned', () => {
    const edited = cssDeclarations(STYLES, '.abyss-card');
    for (const declaration of edited) declaration.value = 'inherit';

    expect(written(edited)).toEqual(['color: inherit', 'padding: inherit']);
    expect(written(cssDeclarations(STYLES, '.abyss-card'))).toEqual([
      'color: var(--text-normal)',
      'padding: 4px',
    ]);
    expect(cssDeclarationText(STYLES, '.abyss-card')).toBe(
      'color: var(--text-normal);\npadding: 4px;',
    );
  });
});
