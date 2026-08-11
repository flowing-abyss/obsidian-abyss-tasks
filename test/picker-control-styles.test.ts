// eslint-disable-next-line import/no-nodejs-modules -- this contract reads the shipped stylesheet.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(`${import.meta.dirname}/../styles.css`, 'utf8');

function declarationsFor(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&').replace(/\\,/gu, ',');
  return new RegExp(`${escaped}\\s*\\{(?<body>[^}]*)\\}`, 'u').exec(css)?.groups?.['body'] ?? '';
}

function specificity(selector: string): [number, number, number] {
  const withoutNot = selector.replace(/:not\(([^)]*)\)/gu, '$1');
  const ids = (withoutNot.match(/#[\w-]+/gu) ?? []).length;
  const classes = (withoutNot.match(/\.[\w-]+|:[\w-]+/gu) ?? []).length;
  const elements = (withoutNot.match(/(^|[\s>+~])([a-z][\w-]*)/giu) ?? []).length;
  return [ids, classes, elements];
}

function compareSpecificity(
  left: [number, number, number],
  right: [number, number, number],
): number {
  for (let index = 0; index < left.length; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

const OBSIDIAN_BUTTON_SELECTOR = 'button:not(.clickable-icon)';

describe('native picker button visual reset', () => {
  it.each([
    '.tc-tag-picker-modal button.tc-tag-picker-item',
    '.tc-status-icon-field button.tc-status-icon-result',
  ])('out-ranks Obsidian’s %s button defaults', (selector) => {
    const declarations = declarationsFor(selector);

    expect(
      compareSpecificity(specificity(selector), specificity(OBSIDIAN_BUTTON_SELECTOR)),
    ).toBeGreaterThan(0);
    for (const declaration of [
      'appearance: none',
      'background: transparent',
      'border: 0',
      'box-shadow: none',
      'font: inherit',
      'color: inherit',
      'box-sizing: border-box',
    ]) {
      expect(declarations).toContain(declaration);
    }
  });

  it('retains a focus-visible ring and checked/removing tag state after the reset', () => {
    const focus = declarationsFor(
      '.tc-tag-picker-modal button.tc-tag-picker-item:focus-visible,\n.tc-status-icon-field button.tc-status-icon-result:focus-visible',
    );
    const checked = declarationsFor('.tc-tag-picker-modal button.tc-tag-picker-item--checked');
    const removing = declarationsFor('.tc-tag-picker-modal button.tc-tag-picker-item--removing');

    expect(focus).toContain('outline: 2px solid var(--interactive-accent)');
    expect(focus).toContain('outline-offset: 2px');
    expect(checked).toContain('background: var(--background-modifier-active-hover)');
    expect(removing).toContain('background: rgba(var(--color-red-rgb), 0.08)');
    expect(css.indexOf('.tc-tag-picker-modal button.tc-tag-picker-item--checked')).toBeGreaterThan(
      css.indexOf('.tc-tag-picker-modal button.tc-tag-picker-item {'),
    );
    expect(css.indexOf('.tc-tag-picker-modal button.tc-tag-picker-item--removing')).toBeGreaterThan(
      css.indexOf('.tc-tag-picker-modal button.tc-tag-picker-item {'),
    );
  });
});
