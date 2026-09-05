import { selectorSpecificity } from '@csstools/selector-specificity';
import postcss from 'postcss';
import selectorParser from 'postcss-selector-parser';

function isGroup(node: selectorParser.Node): node is selectorParser.Pseudo {
  return node.type === 'pseudo' && node.value === ':is';
}

function substitute(selector: selectorParser.Selector, arm: selectorParser.Selector): string {
  const copy = selector.clone();
  const original = copy.nodes.find(isGroup);
  if (original === undefined) throw new Error('Missing :is node in selector clone');
  original.replaceWith(...arm.nodes.map((node) => node.clone()));
  copy.walk((node) => {
    node.spaces.before = '';
    node.spaces.after = '';
    if (node.type === 'combinator') node.raws = {};
    if (node.type === 'combinator' && node.value.trim().length > 0) {
      node.spaces.before = ' ';
      node.spaces.after = ' ';
      node.value = node.value.trim();
    } else if (node.type === 'combinator') node.value = ' ';
  });
  return copy.toString().trim();
}

function expandSelector(selector: selectorParser.Selector): string[] | undefined {
  const group = selector.nodes.find(isGroup);
  const first = group?.nodes[0];
  if (group === undefined || first === undefined) return undefined;
  const specificity = JSON.stringify(selectorSpecificity(first));
  const safe = group.nodes.every(
    (arm) =>
      arm.nodes.every((node) => node.type !== 'combinator') &&
      JSON.stringify(selectorSpecificity(arm)) === specificity,
  );
  return safe ? group.nodes.map((arm) => substitute(selector, arm)) : undefined;
}

/** Let declaration assertions address individual selectors regardless of safe :is factoring. */
export function expandCompoundSelectorLists(css: string): string {
  const root = postcss.parse(css);
  root.walkRules((rule) => {
    const ast = selectorParser().astSync(rule.selector);
    const expansions = ast.nodes.map(expandSelector);
    if (expansions.every((entry) => entry === undefined)) return;
    rule.selector = ast.nodes
      .flatMap((selector, index) => expansions[index] ?? [selector.toString()])
      .join(',\n');
  });
  return root.toString();
}
