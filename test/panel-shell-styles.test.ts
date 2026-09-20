import postcss from 'postcss';
import valueParser from 'postcss-value-parser';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { cssDeclarationText, cssDeclarations, normalizeCssSelector } from './cssHelpers';
import { expandCompoundSelectorLists } from './support/expandedCss';

function readStyles(): string {
  const styles = ts.sys.readFile(ts.sys.resolvePath(`${import.meta.dirname}/../styles.css`));
  if (styles === undefined) throw new Error('Expected styles.css to be readable');
  return expandCompoundSelectorLists(styles);
}

const css = readStyles();

function withoutWhitespace(source: string): string {
  let compact = '';
  for (const character of source) {
    if (
      character !== ' ' &&
      character !== '\n' &&
      character !== '\r' &&
      character !== '\t' &&
      character !== '\f'
    ) {
      compact += character;
    }
  }
  return compact;
}

function countOccurrences(source: string, needle: string): number {
  let count = 0;
  let cursor = 0;
  while (cursor < source.length) {
    const next = source.indexOf(needle, cursor);
    if (next === -1) return count;
    count += 1;
    cursor = next + needle.length;
  }
  return count;
}

const rules = postcss
  .parse(css)
  .nodes.filter((node) => node.type === 'rule')
  .map((rule) => ({
    selector: rule.selector,
    body: rule.nodes
      .filter((node) => node.type === 'decl')
      .map((node) => node.toString())
      .join('\n'),
  }));

function declarationsFor(selector: string): string {
  return cssDeclarationText(css, selector, true);
}

function supplementalTopPaddingPx(selector: string): number {
  const declaration = cssDeclarations(css, selector, true).find(
    (item) => item.prop === 'padding-top',
  );
  const expression = valueParser(declaration?.value ?? '').nodes[0];
  if (expression?.type !== 'function' || expression.value !== 'calc')
    throw new Error('Expected calculated inset');
  return defaultSpacingPx(expression.nodes[0]);
}

function defaultSpacingPx(base: valueParser.Node | undefined): number {
  // Independently documented Default-theme spacing; this assertion guards the original geometry.
  const defaults: Record<string, number> = { '--size-4-2': 8, '--size-4-3': 12 };
  if (base?.type === 'function' && base.value === 'var')
    return defaults[base.nodes[0]?.value ?? ''] ?? NaN;
  return base?.type === 'word' ? Number.parseFloat(base.value) : NaN;
}

describe('Panel shell top rhythm', () => {
  it('defines one responsive inset and one subtle theme-derived root edge', () => {
    const panel = declarationsFor('.abyss-panel-view');

    expect(panel).toContain('--abyss-shell-top-inset: calc(clamp(3px, 0.4vw, 5px) - 2px)');
    expect(panel).toContain('border-top: 1px solid var(--background-modifier-border)');
    expect(withoutWhitespace(panel)).toContain(
      'border-top-color:color-mix(insrgb,var(--background-modifier-border)60%,transparent)',
    );
    expect(countOccurrences(panel, 'border-top:')).toBe(1);
    expect(panel).toContain('box-sizing: border-box');
    for (const property of ['box-shadow:', 'outline:', 'border-radius:']) {
      expect(panel).not.toContain(property);
    }
  });

  it.each([
    ['.abyss-layout > .abyss-rail', 'var(--size-4-2)', false],
    ['.abyss-layout > .abyss-left > .abyss-left-section:first-child', 'var(--size-4-3)', false],
    [
      '.abyss-layout--tasks > .abyss-center-shell > .abyss-center > .abyss-center-header, .abyss-layout--search > .abyss-center-shell > .abyss-center > .abyss-center-header',
      'var(--size-4-3)',
      true,
    ],
    [
      '.abyss-layout--calendar > .abyss-center-shell > .abyss-center > .abyss-cal-nav',
      'var(--size-4-2)',
      true,
    ],
    [
      '.abyss-layout--projects > .abyss-center-shell > .abyss-center .abyss-projects-toolbar',
      'var(--size-4-3)',
      true,
    ],
    ['.abyss-layout > .abyss-right > .abyss-right-header:first-child', 'var(--size-4-3)', false],
    ['.abyss-layout > .abyss-right > .abyss-breadcrumb:first-child', '18px', false],
  ])(
    'adds the inset to the approved top-level surface %s',
    (selector, existingTopPadding, capped) => {
      const inset = capped
        ? 'min(var(--abyss-shell-top-inset), 5px)'
        : 'var(--abyss-shell-top-inset)';
      expect(declarationsFor(selector)).toContain(
        `padding-top: calc(${existingTopPadding} + ${inset})`,
      );
    },
  );

  it('calibrates the first task-mode controls to the same 26px plus inset centerline', () => {
    // Existing geometry after each supplemental top padding:
    // rail half-button 18; left row margin 1 + padding 5 + half-icon 8; filter half-height 14.
    const centerlines = [
      supplementalTopPaddingPx('.abyss-layout > .abyss-rail') + 18,
      supplementalTopPaddingPx('.abyss-layout > .abyss-left > .abyss-left-section:first-child') +
        1 +
        5 +
        8,
      supplementalTopPaddingPx(
        '.abyss-layout--tasks > .abyss-center-shell > .abyss-center > .abyss-center-header, .abyss-layout--search > .abyss-center-shell > .abyss-center > .abyss-center-header',
      ) + 14,
    ];

    expect(centerlines).toEqual([26, 26, 26]);
  });

  it('does not add the inset to content, grid, empty, section, or modal surfaces', () => {
    const insetSelectors = rules
      .filter((rule) => rule.body.includes('var(--abyss-shell-top-inset)'))
      .map((rule) => normalizeCssSelector(rule.selector));

    expect(insetSelectors).toEqual(
      [
        '.abyss-layout > .abyss-rail',
        '.abyss-layout > .abyss-left > .abyss-left-section:first-child',
        '.abyss-layout--tasks > .abyss-center-shell > .abyss-center > .abyss-center-header, .abyss-layout--search > .abyss-center-shell > .abyss-center > .abyss-center-header',
        '.abyss-layout--calendar > .abyss-center-shell > .abyss-center > .abyss-cal-nav',
        '.abyss-layout--projects > .abyss-center-shell > .abyss-center .abyss-projects-toolbar',
        '.abyss-layout > .abyss-right > .abyss-right-header:first-child',
        '.abyss-layout > .abyss-right > .abyss-breadcrumb:first-child',
      ].map(normalizeCssSelector),
    );

    for (const selector of [
      '.abyss-center-scroll',
      '.abyss-cal-body',
      '.abyss-right-section',
      '.abyss-center-empty',
      '.abyss-modal-body',
      '.abyss-modal .abyss-right-header',
      '.abyss-layout > .abyss-right > .abyss-right-header',
    ]) {
      expect(declarationsFor(selector)).not.toContain('var(--abyss-shell-top-inset)');
    }
  });
});

describe('Global search field geometry', () => {
  it('keeps the global search field flexible and bounded without width animation', () => {
    const globalSearch = declarationsFor('.abyss-search-global');
    const focusedGlobalSearch = declarationsFor('.abyss-search-global:focus');

    expect(globalSearch).toContain('flex: 1');
    expect(globalSearch).toContain('min-width: 0');
    expect(globalSearch).toMatch(/max-width:\s*\d+px/);
    expect(globalSearch).toContain('width: auto');
    expect(focusedGlobalSearch).toContain('width: auto');
    expect(globalSearch).toMatch(/transition:\s*border-color/);
    expect(globalSearch).not.toMatch(/transition:[^;]*\bwidth\b/);
  });
});
