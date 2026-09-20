import postcss from 'postcss';
import selectorParser from 'postcss-selector-parser';

interface CssRuleRecord {
  readonly rule: postcss.Rule;
  readonly normalizedSelector: string;
  readonly normalizedBranches: readonly string[];
}

export interface CssReader {
  declarations(selector: string, topLevel?: boolean): postcss.Declaration[];
  declarationText(selector: string, topLevel?: boolean): string;
  ruleContaining(selectors: string[], last?: boolean): string;
}

export function normalizeCssSelector(selector: string): string {
  return selectorParser().processSync(selector, { lossless: false });
}

function declarationsFor(
  records: readonly CssRuleRecord[],
  selector: string,
  topLevel: boolean,
): postcss.Declaration[] {
  const declarations: postcss.Declaration[] = [];
  const target = normalizeCssSelector(selector);
  for (const { rule, normalizedSelector, normalizedBranches } of records) {
    if (topLevel && rule.parent?.type !== 'root') continue;
    if (normalizedSelector !== target && !normalizedBranches.some((branch) => branch === target))
      continue;
    rule.each((node) => {
      if (node.type === 'decl') declarations.push(node);
    });
  }
  return declarations;
}

function declarationText(declarations: readonly postcss.Declaration[]): string {
  return declarations
    .map(
      (declaration) =>
        `${declaration.prop}: ${declaration.value}${declaration.important ? ' !important' : ''};`,
    )
    .join('\n');
}

function ruleContaining(
  records: readonly CssRuleRecord[],
  selectors: string[],
  last: boolean,
): string {
  const matches: string[] = [];
  const wanted = selectors.map(normalizeCssSelector);
  for (const { rule, normalizedSelector, normalizedBranches } of records) {
    if (
      wanted.every((selector) => normalizedBranches.includes(selector)) ||
      (wanted.length === 1 && normalizedSelector === wanted[0])
    ) {
      matches.push(declarationText(rule.nodes.filter((node) => node.type === 'decl')));
    }
  }
  return (last ? matches[matches.length - 1] : matches[0]) ?? '';
}

/** Parse and normalize a stylesheet once for repeated exact-selector queries. */
export function createCssReader(source: string): CssReader {
  const records: CssRuleRecord[] = [];
  postcss.parse(source).walkRules((rule) => {
    records.push({
      rule,
      normalizedSelector: normalizeCssSelector(rule.selector),
      normalizedBranches: selectorParser()
        .astSync(rule.selector)
        .nodes.map((branch) => normalizeCssSelector(branch.toString())),
    });
  });
  return {
    declarations: (selector, topLevel = false) => declarationsFor(records, selector, topLevel),
    declarationText: (selector, topLevel = false) =>
      declarationText(declarationsFor(records, selector, topLevel)),
    ruleContaining: (selectors, last = false) => ruleContaining(records, selectors, last),
  };
}

/** Read declarations from actual selector branches, preserving cascade/source order. */
export function cssDeclarations(
  source: string,
  selector: string,
  topLevel = false,
): postcss.Declaration[] {
  return createCssReader(source).declarations(selector, topLevel);
}

export function cssDeclarationText(source: string, selector: string, topLevel = false): string {
  return createCssReader(source).declarationText(selector, topLevel);
}

export function cssValue(declarations: string, property: string): string | undefined {
  const root = postcss.parse(declarations);
  return root.nodes.find(
    (node): node is postcss.Declaration => node.type === 'decl' && node.prop === property,
  )?.value;
}

/** Exact selector branches in one rule, with source-order selection explicit at call sites. */
export function cssRuleContaining(source: string, selectors: string[], last = false): string {
  return createCssReader(source).ruleContaining(selectors, last);
}
