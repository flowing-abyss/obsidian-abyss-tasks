import postcss from 'postcss';
import selectorParser from 'postcss-selector-parser';

export function normalizeCssSelector(selector: string): string {
  return selectorParser().processSync(selector, { lossless: false });
}

/** Read declarations from actual selector branches, preserving cascade/source order. */
export function cssDeclarations(
  source: string,
  selector: string,
  topLevel = false,
): postcss.Declaration[] {
  const declarations: postcss.Declaration[] = [];
  const target = normalizeCssSelector(selector);
  postcss.parse(source).walkRules((rule) => {
    if (topLevel && rule.parent?.type !== 'root') return;
    const branches = selectorParser().astSync(rule.selector).nodes;
    if (
      normalizeCssSelector(rule.selector) !== target &&
      !branches.some((branch) => normalizeCssSelector(branch.toString()) === target)
    )
      return;
    rule.each((node) => {
      if (node.type === 'decl') declarations.push(node);
    });
  });
  return declarations;
}

export function cssDeclarationText(source: string, selector: string, topLevel = false): string {
  return cssDeclarations(source, selector, topLevel)
    .map(
      (declaration) =>
        `${declaration.prop}: ${declaration.value}${declaration.important ? ' !important' : ''};`,
    )
    .join('\n');
}

export function cssValue(declarations: string, property: string): string | undefined {
  const root = postcss.parse(declarations);
  return root.nodes.find(
    (node): node is postcss.Declaration => node.type === 'decl' && node.prop === property,
  )?.value;
}

/** Exact selector branches in one rule, with source-order selection explicit at call sites. */
export function cssRuleContaining(source: string, selectors: string[], last = false): string {
  const matches: string[] = [];
  const wanted = selectors.map(normalizeCssSelector);
  postcss.parse(source).walkRules((rule) => {
    const actual = selectorParser()
      .astSync(rule.selector)
      .nodes.map((branch) => normalizeCssSelector(branch.toString()));
    if (
      wanted.every((selector) => actual.includes(selector)) ||
      (wanted.length === 1 && normalizeCssSelector(rule.selector) === wanted[0])
    ) {
      matches.push(
        rule.nodes
          .filter((node) => node.type === 'decl')
          .map((node) => `${node.prop}: ${node.value}${node.important ? ' !important' : ''};`)
          .join('\n'),
      );
    }
  });
  return (last ? matches[matches.length - 1] : matches[0]) ?? '';
}
