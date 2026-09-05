import { selectorSpecificity } from '@csstools/selector-specificity';
import postcss from 'postcss';
import selectorParser from 'postcss-selector-parser';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import mappings from './fixtures/compact-selectors.json';

function compact(selector: string): string {
  return selectorParser().processSync(selector, { lossless: false });
}

describe('compact stylesheet selectors', () => {
  const source = postcss.parse(ts.sys.readFile(`${process.cwd()}/styles.css`) ?? '');
  const selectors = new Set<string>();
  source.walkRules((rule) => {
    selectors.add(compact(rule.selector));
  });

  it.each(mappings)('preserves the scope and specificity of $from', ({ from, to }) => {
    const before = selectorParser().astSync(from, { lossless: false });
    const after = selectorParser().astSync(to, { lossless: false });
    const factored = after.first;
    expect(factored).toBeDefined();
    const group = factored.nodes.find((node) => node.type === 'pseudo' && node.value === ':is');
    if (group?.type !== 'pseudo') throw new Error('Missing :is group');
    const expanded = group.nodes.map((arm) => {
      // A compound arm substitutes only this element; no ancestor, sibling or pseudo-element
      // may move inside :is. Equal arm specificity avoids changing the cascade for any match.
      expect(
        arm.nodes.some(
          (node) => node.type === 'combinator' || (node.value?.startsWith('::') ?? false),
        ),
      ).toBe(false);
      const clone = factored.clone();
      const replacement = clone.nodes.find(
        (node) => node.type === 'pseudo' && node.value === ':is',
      );
      if (replacement === undefined) throw new Error('Missing replacement group');
      replacement.replaceWith(...arm.nodes.map((node) => node.clone()));
      return compact(clone.toString());
    });
    expect(expanded).toEqual(before.nodes.map((node) => compact(node.toString())));
    for (const selector of before.nodes) {
      expect(selectorSpecificity(factored)).toEqual(selectorSpecificity(selector));
    }
    expect(selectors.has(compact(to)), to).toBe(true);
  });
});
