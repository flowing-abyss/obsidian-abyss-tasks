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
const OBSIDIAN_BASE_BUTTON_SELECTOR = 'button';
const OBSIDIAN_BASE_BUTTON_DECLARATIONS = {
  height: 'var(--input-height)',
  'white-space': 'nowrap',
};
const PICKER_DIV_GEOMETRY = {
  height: 'auto',
  'min-height': '0',
  'white-space': 'normal',
};

describe('native picker button visual reset', () => {
  it('restores a theme-token focus-visible outline after the legacy toolbar reset', () => {
    const baseSelector = '.tasksCalendar button';
    const focusSelector = '.tasksCalendar button:focus-visible';
    const focus = declarationsFor(focusSelector);

    expect(
      compareSpecificity(specificity(focusSelector), specificity(baseSelector)),
    ).toBeGreaterThan(0);
    expect(focus).toContain('outline: 2px solid var(--interactive-accent)');
    expect(focus).toContain('outline-offset: 2px');
    expect(css.indexOf(`${focusSelector} {`)).toBeGreaterThan(css.indexOf(`${baseSelector} {`));
  });

  it.each([
    '.abyss-tag-picker-modal button.abyss-tag-picker-item',
    '.abyss-status-icon-field button.abyss-status-icon-result',
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
    expect(
      compareSpecificity(specificity(selector), specificity(OBSIDIAN_BASE_BUTTON_SELECTOR)),
    ).toBeGreaterThan(0);
  });

  it('keeps tag rows content-height and wrapping instead of inheriting the base button geometry', () => {
    const selector = '.abyss-tag-picker-modal button.abyss-tag-picker-item';
    const declarations = declarationsFor(selector);

    expect(
      compareSpecificity(specificity(selector), specificity(OBSIDIAN_BASE_BUTTON_SELECTOR)),
    ).toBeGreaterThan(0);
    for (const [property, value] of Object.entries(PICKER_DIV_GEOMETRY)) {
      if (property in OBSIDIAN_BASE_BUTTON_DECLARATIONS) {
        expect(value).not.toBe(
          OBSIDIAN_BASE_BUTTON_DECLARATIONS[
            property as keyof typeof OBSIDIAN_BASE_BUTTON_DECLARATIONS
          ],
        );
      }
      expect(declarations).toContain(`${property}: ${value}`);
    }
  });

  it('retains a focus-visible ring and checked/removing tag state after the reset', () => {
    const focus = declarationsFor(
      '.abyss-tag-picker-modal button.abyss-tag-picker-item:focus-visible,\n.abyss-status-icon-field button.abyss-status-icon-result:focus-visible',
    );
    const checked = declarationsFor(
      '.abyss-tag-picker-modal button.abyss-tag-picker-item--checked',
    );
    const removing = declarationsFor(
      '.abyss-tag-picker-modal button.abyss-tag-picker-item--removing',
    );

    expect(focus).toContain('outline: 2px solid var(--interactive-accent)');
    expect(focus).toContain('outline-offset: 2px');
    expect(checked).toContain('background: var(--background-modifier-active-hover)');
    expect(removing).toContain('background: rgba(var(--color-red-rgb), 0.08)');
    expect(
      css.indexOf('.abyss-tag-picker-modal button.abyss-tag-picker-item--checked'),
    ).toBeGreaterThan(css.indexOf('.abyss-tag-picker-modal button.abyss-tag-picker-item {'));
    expect(
      css.indexOf('.abyss-tag-picker-modal button.abyss-tag-picker-item--removing'),
    ).toBeGreaterThan(css.indexOf('.abyss-tag-picker-modal button.abyss-tag-picker-item {'));
  });

  it('keeps checked and removing backgrounds ahead of the ordinary hover state', () => {
    const hover = '.abyss-tag-picker-modal button.abyss-tag-picker-item:hover';
    const checkedHover = '.abyss-tag-picker-modal button.abyss-tag-picker-item--checked:hover';
    const removingHover = '.abyss-tag-picker-modal button.abyss-tag-picker-item--removing:hover';

    expect(declarationsFor(checkedHover)).toContain(
      'background: var(--background-modifier-active-hover)',
    );
    expect(declarationsFor(removingHover)).toContain(
      'background: rgba(var(--color-red-rgb), 0.08)',
    );
    expect(
      compareSpecificity(specificity(checkedHover), specificity(hover)),
    ).toBeGreaterThanOrEqual(0);
    expect(
      compareSpecificity(specificity(removingHover), specificity(hover)),
    ).toBeGreaterThanOrEqual(0);
    expect(css.indexOf(checkedHover)).toBeGreaterThan(css.indexOf(hover));
    expect(css.indexOf(removingHover)).toBeGreaterThan(css.indexOf(hover));
  });
});
