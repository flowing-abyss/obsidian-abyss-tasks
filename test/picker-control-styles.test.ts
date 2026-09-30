// @vitest-environment node
import { compare, selectorSpecificity } from '@csstools/selector-specificity';
import postcss from 'postcss';
import selectorParser from 'postcss-selector-parser';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { createCssReader, normalizeCssSelector, type CssReader } from './cssHelpers';

const stylesPath = ts.sys.resolvePath(`${import.meta.dirname}/../styles.css`);

function readStyles(): string {
  const content = ts.sys.readFile(stylesPath);
  if (content === undefined) throw new Error(`Unable to read ${stylesPath}`);
  return content;
}

const css = readStyles();

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
    expect(removing).toContain('background: rgb(var(--color-red-rgb), 0.08)');
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
    expect(declarationsFor(removingHover)).toContain('background: rgb(var(--color-red-rgb), 0.08)');
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

describe('month date-button native cascade', () => {
  it('keeps date labels intrinsic and left aligned above native button defaults', () => {
    const selector = '.abyss-mg-cell button.abyss-mg-day-label';
    const declarations = declarationsFor(selector);
    expect(
      compareSpecificity(specificity(selector), specificity(OBSIDIAN_BUTTON_SELECTOR)),
    ).toBeGreaterThan(0);
    for (const declaration of [
      'appearance: none',
      'background: transparent',
      'border: 0',
      'width: fit-content',
      'min-width: 0',
      'align-self: flex-start',
      'justify-content: flex-start',
      'text-align: left',
      'height: auto',
      'padding: 0',
    ])
      expect(declarations).toContain(declaration);
    const hover = `${selector}:hover`;
    expect(
      compareSpecificity(specificity(hover), specificity(`${OBSIDIAN_BUTTON_SELECTOR}:hover`)),
    ).toBeGreaterThan(0);
    expect(declarationsFor(hover)).toContain('background: transparent');
  });
});

/** Obsidian's tablet padding for plain buttons, 4px 20px (`--size-4-1` `--size-4-5`). */
const OBSIDIAN_TABLET_BUTTON_SELECTOR = '.is-tablet button:not(.clickable-icon)';

/**
 * Every plugin button rule that declares a padding the host's tablet rule reaches, and the tablet
 * rule that keeps that padding. The raised rule adds `body.is-tablet` and, where the rule named
 * only a class, the `button` the host rule pads.
 */
const TABLET_PADDING_ROWS: ReadonlyArray<readonly [declared: string, raised: string]> = [
  ['button.abyss-compact-pane-button', 'body.is-tablet button.abyss-compact-pane-button'],
  ['.abyss-tg-header-cell', 'body.is-tablet button.abyss-tg-header-cell'],
  ['.abyss-mg-add-btn', 'body.is-tablet button.abyss-mg-add-btn'],
  [
    '.abyss-mg-cell button.abyss-mg-day-label',
    'body.is-tablet .abyss-mg-cell button.abyss-mg-day-label',
  ],
  ['.abyss-rail-btn', 'body.is-tablet button.abyss-rail-btn'],
  ['.abyss-task-delete-btn', 'body.is-tablet button.abyss-task-delete-btn'],
  ['.abyss-add-task-trigger', 'body.is-tablet button.abyss-add-task-trigger'],
  [
    ':is(.abyss-cal-nav-month, .abyss-cal-nav-year)',
    'body.is-tablet button:is(.abyss-cal-nav-month, .abyss-cal-nav-year)',
  ],
  ['.abyss-cal-nav-btn', 'body.is-tablet button.abyss-cal-nav-btn'],
  ['.abyss-cal-nav-today', 'body.is-tablet button.abyss-cal-nav-today'],
  [
    ':is(button.abyss-cal-view-btn, button.abyss-project-overview-mode)',
    'body.is-tablet :is(button.abyss-cal-view-btn, button.abyss-project-overview-mode)',
  ],
  [
    '.abyss-month-picker button.abyss-month-picker-btn',
    'body.is-tablet .abyss-month-picker button.abyss-month-picker-btn',
  ],
  [
    '.abyss-year-picker button.abyss-year-picker-btn',
    'body.is-tablet .abyss-year-picker button.abyss-year-picker-btn',
  ],
  [
    '.abyss-breadcrumb .abyss-inspector-back',
    'body.is-tablet .abyss-breadcrumb button.abyss-inspector-back',
  ],
  ['.abyss-chip', 'body.is-tablet button.abyss-chip'],
  ['.abyss-chip-remove', 'body.is-tablet button.abyss-chip-remove'],
  ['.abyss-popover-clear-icon-btn', 'body.is-tablet button.abyss-popover-clear-icon-btn'],
  ['.abyss-priority-option', 'body.is-tablet button.abyss-priority-option'],
  ['.abyss-recurrence-presets button', 'body.is-tablet .abyss-recurrence-presets button'],
  [
    '.abyss-recurrence-actions button.abyss-recurrence-clear',
    'body.is-tablet .abyss-recurrence-actions button.abyss-recurrence-clear',
  ],
  ['.abyss-status-popover-flag', 'body.is-tablet button.abyss-status-popover-flag'],
  [
    ':is(.abyss-dep-badge, .abyss-time-badge) > button',
    'body.is-tablet :is(.abyss-dep-badge, .abyss-time-badge) > button',
  ],
  [
    '.abyss-dep-badge > .abyss-dep-badge-body',
    'body.is-tablet .abyss-dep-badge > button.abyss-dep-badge-body',
  ],
  [
    '.abyss-dep-badge > .abyss-dep-badge-add',
    'body.is-tablet .abyss-dep-badge > button.abyss-dep-badge-add',
  ],
  ['.abyss-dep-row button.abyss-dep-title', 'body.is-tablet .abyss-dep-row button.abyss-dep-title'],
  ['.abyss-subtask-remove', 'body.is-tablet button.abyss-subtask-remove'],
  ['.abyss-dep-remove', 'body.is-tablet button.abyss-dep-remove'],
  ['.abyss-time-row-remove', 'body.is-tablet button.abyss-time-row-remove'],
  [
    '.abyss-dep-search-option:not([hidden])',
    'body.is-tablet button.abyss-dep-search-option:not([hidden])',
  ],
  ['.abyss-dep-search-direction', 'body.is-tablet button.abyss-dep-search-direction'],
  ['.abyss-dep-search-create', 'body.is-tablet button.abyss-dep-search-create'],
  ['.abyss-subtask-add-row', 'body.is-tablet button.abyss-subtask-add-row'],
  [
    '.abyss-tag-picker-modal button.abyss-tag-picker-item',
    'body.is-tablet .abyss-tag-picker-modal button.abyss-tag-picker-item',
  ],
  ['.abyss-filter-chip-x', 'body.is-tablet button.abyss-filter-chip-x'],
  ['.abyss-view-state-btn', 'body.is-tablet button.abyss-view-state-btn'],
  [
    '.abyss-view-state-popover button.abyss-view-state-row-main',
    'body.is-tablet .abyss-view-state-popover button.abyss-view-state-row-main',
  ],
  [
    '.abyss-view-state-popover button.abyss-view-state-option',
    'body.is-tablet .abyss-view-state-popover button.abyss-view-state-option',
  ],
  ['.abyss-view-state-reset-btn', 'body.is-tablet button.abyss-view-state-reset-btn'],
  [
    '.abyss-project-table-controls .abyss-view-state-btn',
    'body.is-tablet .abyss-project-table-controls button.abyss-view-state-btn',
  ],
  [
    '.abyss-projects-table button.abyss-project-overview-mode',
    'body.is-tablet .abyss-projects-table button.abyss-project-overview-mode',
  ],
  [
    '.abyss-projects-table button.abyss-project-table-column-button',
    'body.is-tablet .abyss-projects-table button.abyss-project-table-column-button',
  ],
  [
    '.abyss-projects-table button.abyss-project-table-name',
    'body.is-tablet .abyss-projects-table button.abyss-project-table-name',
  ],
  [
    '.abyss-projects-table button.abyss-project-table-group-toggle',
    'body.is-tablet .abyss-projects-table button.abyss-project-table-group-toggle',
  ],
  [
    'button.abyss-project-table-status-pill',
    'body.is-tablet button.abyss-project-table-status-pill',
  ],
  [
    '.abyss-project-table-status-pill:is(.is-text, .is-dot)',
    'body.is-tablet button.abyss-project-table-status-pill:is(.is-text, .is-dot)',
  ],
  [
    '.abyss-projects-table button.abyss-project-table-value-remove',
    'body.is-tablet .abyss-projects-table button.abyss-project-table-value-remove',
  ],
  [
    '.abyss-projects-table button.abyss-project-value-picker-edit',
    'body.is-tablet .abyss-projects-table button.abyss-project-value-picker-edit',
  ],
  [
    '.abyss-projects-table button.abyss-project-value-picker-action',
    'body.is-tablet .abyss-projects-table button.abyss-project-value-picker-action',
  ],
  [
    '.abyss-projects-table button.abyss-projects-new',
    'body.is-tablet .abyss-projects-table button.abyss-projects-new',
  ],
  [
    '.abyss-projects-table button.abyss-project-kanban-group-header',
    'body.is-tablet .abyss-projects-table button.abyss-project-kanban-group-header',
  ],
  ['.abyss-project-timeline-axis button', 'body.is-tablet .abyss-project-timeline-axis button'],
  [
    '.abyss-project-timeline-axis .abyss-cal-nav-today',
    'body.is-tablet .abyss-project-timeline-axis button.abyss-cal-nav-today',
  ],
  [
    '.abyss-project-timeline-group-header',
    'body.is-tablet button.abyss-project-timeline-group-header',
  ],
  [
    '.abyss-project-timeline-name-cell button.abyss-project-table-name',
    'body.is-tablet .abyss-project-timeline-name-cell button.abyss-project-table-name',
  ],
  [
    '.abyss-view-state-popover button.abyss-view-state-option-move',
    'body.is-tablet .abyss-view-state-popover button.abyss-view-state-option-move',
  ],
  [
    '.abyss-view-state-popover button.abyss-view-state-option-action',
    'body.is-tablet .abyss-view-state-popover button.abyss-view-state-option-action',
  ],
  ['.abyss-project-column-add', 'body.is-tablet button.abyss-project-column-add'],
  ['.abyss-project-back', 'body.is-tablet button.abyss-project-back'],
  ['.abyss-project-open-btn', 'body.is-tablet button.abyss-project-open-btn'],
  [
    '.abyss-status-icon-field button.abyss-status-icon-result',
    'body.is-tablet .abyss-status-icon-field button.abyss-status-icon-result',
  ],
  ['.abyss-detached-draft-copy', 'body.is-tablet button.abyss-detached-draft-copy'],
  ['.abyss-detached-draft-discard', 'body.is-tablet button.abyss-detached-draft-discard'],
  [
    '.abyss-time-badge > .abyss-time-badge-body',
    'body.is-tablet .abyss-time-badge > button.abyss-time-badge-body',
  ],
  [
    '.abyss-time-badge > .abyss-time-badge-toggle',
    'body.is-tablet .abyss-time-badge > button.abyss-time-badge-toggle',
  ],
  [
    '.abyss-rail-tracking .abyss-rail-tracking-toggle',
    'body.is-tablet .abyss-rail-tracking button.abyss-rail-tracking-toggle',
  ],
  [
    '.abyss-rail-tracking .abyss-rail-tracking-task',
    'body.is-tablet .abyss-rail-tracking button.abyss-rail-tracking-task',
  ],
  [
    '.abyss-time-tracking-popover--tasks .abyss-tracked-day-header',
    'body.is-tablet .abyss-time-tracking-popover--tasks button.abyss-tracked-day-header',
  ],
  [
    '.abyss-tracked-row :is(.abyss-tracked-row-toggle, .abyss-tracked-row-done)',
    'body.is-tablet .abyss-tracked-row button.abyss-tracked-row-toggle',
  ],
  [
    '.abyss-tracked-row .abyss-tracked-row-open',
    'body.is-tablet .abyss-tracked-row button.abyss-tracked-row-open',
  ],
];

const PADDING = /^padding(-|$)/u;

function rank(selector: string): ReturnType<typeof selectorSpecificity> {
  const node = selectorParser().astSync(selector).nodes[0];
  if (node === undefined) throw new Error(`Expected a selector: ${selector}`);
  return selectorSpecificity(node);
}

/** The padding a selector's own top-level rules end with, property by property. */
function paddingOf(reader: CssReader, selector: string): Record<string, string> {
  const padding: Record<string, string> = {};
  for (const declaration of reader.declarations(selector, true))
    if (PADDING.test(declaration.prop)) padding[declaration.prop] = declaration.value;
  return padding;
}

describe('plugin button padding on a tablet', () => {
  const reader = createCssReader(css);
  const host = rank(OBSIDIAN_TABLET_BUTTON_SELECTOR);

  it.each(TABLET_PADDING_ROWS)(
    'keeps the padding %s declares above the host tablet rule',
    (declared, raised) => {
      const padding = paddingOf(reader, declared);
      expect(Object.keys(padding).length).toBeGreaterThan(0);
      expect(compare(rank(raised), host)).toBeGreaterThan(0);
      const properties = reader.declarations(raised, true).map(({ prop }) => prop);
      expect(properties.length).toBeGreaterThan(0);
      expect(properties.filter((property) => !PADDING.test(property))).toEqual([]);
      expect(paddingOf(reader, raised)).toEqual(padding);
    },
  );

  it('raises no other rule, in the order of the rules it repeats', () => {
    const raised: string[] = [];
    const declaredAt = new Map<string, number>();
    let index = 0;
    postcss.parse(css).walkRules((rule) => {
      index += 1;
      const pads = rule.nodes.some((node) => node.type === 'decl' && PADDING.test(node.prop));
      for (const branch of selectorParser().astSync(rule.selector).nodes) {
        const selector = normalizeCssSelector(branch.toString());
        if (selector.includes('.is-tablet')) raised.push(selector);
        else if (pads && rule.parent?.type === 'root') declaredAt.set(selector, index);
      }
    });
    expect(raised).toEqual(
      TABLET_PADDING_ROWS.map(([, selector]) => normalizeCssSelector(selector)),
    );
    // Two raised rules that tie on one button then resolve as the rules they repeat do.
    const positions = TABLET_PADDING_ROWS.map(
      ([declared]) => declaredAt.get(normalizeCssSelector(declared)) ?? 0,
    );
    expect(positions.every((position) => position > 0)).toBe(true);
    expect(
      positions.every((position, at) => at === 0 || position >= (positions[at - 1] ?? 0)),
    ).toBe(true);
  });

  it('leaves the hover and active rules of the raised families uncontested', () => {
    for (const selector of [
      '.abyss-rail-btn:hover',
      '.abyss-rail-btn.is-active',
      '.abyss-task-delete-btn:hover',
      ':is(.abyss-cal-nav-month, .abyss-cal-nav-year):hover',
      '.abyss-cal-nav-btn:hover',
      '.abyss-view-state-btn:hover',
      '.abyss-view-state-btn--active',
    ]) {
      const properties = reader.declarations(selector, true).map(({ prop }) => prop);
      expect(properties.length).toBeGreaterThan(0);
      expect(properties.filter((property) => PADDING.test(property))).toEqual([]);
    }
  });
});
