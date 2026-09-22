import postcss from 'postcss';
import { describe, expect, it } from 'vitest';
import { cssDeclarationText } from './cssHelpers';
import { cssDeclarationsFor, loadPluginStyles } from './helpers';

const css = await loadPluginStyles();

function declarationsFor(selector: string): string {
  return declarationsForSource(css, selector);
}

function declarationsForSource(source: string, selector: string): string {
  return cssDeclarationText(source, selector);
}

function atRuleBlock(header: string): string {
  const rules: string[] = [];
  postcss.parse(css).walkAtRules((rule) => {
    if (`@${rule.name} ${rule.params}` === header)
      rules.push(rule.nodes?.map((node) => node.toString()).join('\n') ?? '');
  });
  return rules.join('\n');
}

describe('CenterPanel task metadata styles', () => {
  it('paints keyboard focus on the focusable center without a mouse-focus outline', () => {
    const center = declarationsFor('.abyss-center');
    const focusVisible = declarationsFor('.abyss-center:focus-visible');

    expect(center).not.toContain('outline:');
    expect(focusVisible).toContain('outline: 1px solid var(--background-modifier-border-focus)');
    expect(focusVisible).toContain('outline-offset: -1px');
  });

  it('seats markers, badges and chips on the first title line', () => {
    const card = declarationsFor('.abyss-task-card');
    const mainRow = declarationsFor('.abyss-task-card-main-row');
    const firstLine = [
      '.abyss-status-marker',
      '.abyss-status-control',
      '.abyss-dep-indicator',
      '.abyss-task-delete-btn',
    ].map((child) => declarationsFor(`.abyss-task-card-main-row > ${child}`));
    const titleRow = declarationsFor('.abyss-task-card .abyss-task-title-row');
    const recurrenceBadge = declarationsFor(
      '.abyss-task-card .abyss-task-title-row > .abyss-recurrence-badge',
    );
    const countBadge = declarationsFor(
      '.abyss-task-card .abyss-task-title-row > .abyss-task-count-badge',
    );
    const title = declarationsFor('.abyss-task-card .abyss-task-title');
    const chips = declarationsFor('.abyss-task-card .abyss-task-meta-right > *');
    const deleteButton = declarationsFor('.abyss-task-delete-btn');

    expect(card).toContain('flex-direction: column');
    expect(card).toContain('min-width: 0');
    expect(card).toContain(
      '--abyss-task-card-title-line: calc(var(--font-ui-medium) * var(--line-height-tight))',
    );
    expect(mainRow).toContain('display: flex');
    expect(mainRow).toContain('align-items: flex-start');
    expect(mainRow).toContain('width: 100%');
    expect(mainRow).toContain('min-width: 0');
    for (const child of firstLine) {
      expect(child).toContain('margin-block-start: calc(');
      expect(child).toContain('var(--abyss-task-card-title-line)');
    }
    expect(titleRow).toContain('display: block');
    for (const badge of [recurrenceBadge, countBadge]) {
      expect(badge).toContain('vertical-align: top');
      expect(badge).toContain('margin-inline-end: var(--size-2-3)');
    }
    expect(countBadge).toContain('block-size: var(--abyss-task-card-title-line)');
    expect(title).toContain('display: inline');
    expect(chips).toContain('block-size: var(--abyss-task-card-title-line)');
    expect(deleteButton).not.toContain('align-self');
    expect(deleteButton).toContain('height: var(--abyss-task-card-marker-size)');
  });

  it('lets the title and the metadata column split the row by natural width', () => {
    const body = declarationsFor('.abyss-task-body');
    const metadata = declarationsFor('.abyss-task-meta-right');
    const noteName = declarationsFor('.abyss-task-source-note-name');
    const tag = declarationsFor('.abyss-task-tag');

    expect(body).toContain('flex: 1 1 auto');
    expect(metadata).toContain('flex: 0 1 auto');
    expect(metadata).toContain('flex-wrap: wrap');
    expect(metadata).toContain('place-content: flex-start flex-end');
    expect(metadata).not.toContain('overflow: hidden');
    expect(metadata).not.toContain('padding-top');
    expect(noteName).toContain('max-width: 12rem');
    expect(tag).toContain('max-width: 12rem');
  });

  it('keeps the description inside the title column without widening it', () => {
    const description = declarationsFor('.abyss-task-body > .abyss-task-desc');
    const body = declarationsFor('.abyss-task-body');
    const metadata = declarationsFor('.abyss-task-meta-right');

    expect(declarationsFor('.abyss-task-card > .abyss-task-desc')).toBe('');
    expect(description).toContain('contain: inline-size');
    expect(body).toContain('min-width: 0');
    expect(metadata).toContain('min-width: auto');
  });

  it('sizes every toolbar control from one host-derived token', () => {
    expect(declarationsFor('.abyss-panel-view')).toContain(
      '--abyss-toolbar-control-size: var(--input-height)',
    );
    const token = 'var(--abyss-toolbar-control-size)';
    for (const selector of [
      'button.abyss-compact-pane-button',
      '.abyss-view-state-btn',
      '.abyss-center-search',
      '.abyss-cal-nav-btn',
      '.abyss-cal-nav-today',
      '.abyss-cal-nav-month',
      '.abyss-cal-nav-year',
      '.abyss-cal-view-switcher',
      '.abyss-project-overview-switcher',
      'button.abyss-cal-view-btn',
      'button.abyss-project-overview-mode',
      '.abyss-project-table-controls .abyss-view-state-btn',
      '.abyss-projects-table button.abyss-project-overview-mode',
    ]) {
      expect(declarationsFor(selector), selector).toContain(token);
    }
    for (const selector of [
      '.abyss-center-search',
      '.abyss-project-table-controls .abyss-center-search',
      '.abyss-project-table-controls .abyss-view-state-btn',
      '.abyss-projects-table button.abyss-project-overview-mode',
      '.abyss-cal-nav-btn',
      'button.abyss-compact-pane-button',
    ]) {
      expect(declarationsFor(selector), selector).not.toMatch(/(?:block-size|height): \d+px/);
    }
  });

  it('collapses the phone header to one control row', () => {
    expect(declarationsFor('body.is-phone .abyss-panel-view .abyss-center-title')).toContain(
      'display: none',
    );
    expect(declarationsFor('body.is-phone .abyss-projects-toolbar')).toContain(
      'grid-template-columns: minmax(0, 1fr)',
    );
    expect(declarationsFor('body.is-phone .abyss-project-table-controls')).toContain(
      'justify-self: stretch',
    );
    expect(
      declarationsFor('body.is-phone .abyss-project-table-controls .abyss-center-search'),
    ).toContain('flex: 1 1 auto');
    const narrow = atRuleBlock('@container abyss-panel-layout (max-width: 38rem)');
    expect(declarationsForSource(narrow, '.abyss-layout--tasks .abyss-center-controls')).toContain(
      'flex: 1 1 auto',
    );
  });

  it('lays the phone calendar toolbar out in two rows', () => {
    const nav = declarationsFor('body.is-phone .abyss-cal-nav');
    expect(nav).toContain('display: grid');
    expect(nav).toContain('grid-template-columns: minmax(0, 1fr) auto');
    expect(nav).toContain('overflow: visible');
    expect(declarationsFor('body.is-phone .abyss-cal-nav-right')).toContain('display: contents');
    expect(declarationsFor('body.is-phone .abyss-cal-nav-left')).toContain('min-width: 0');
    // Scoped to the toolbar: the project timeline reuses these classes in its own control.
    expect(declarationsFor('body.is-phone .abyss-cal-nav .abyss-cal-view-switcher')).toContain(
      'grid-column: 1 / -1',
    );
    expect(declarationsFor('body.is-phone .abyss-cal-nav .abyss-cal-view-btn')).toContain(
      'flex: 1 1 0',
    );
    expect(declarationsFor('body.is-phone .abyss-cal-view-switcher')).toBe('');
    expect(declarationsFor('body.is-phone .abyss-panel-view .abyss-cal-nav-today')).toBe('');
  });

  it('dresses standalone phone controls as switcher cells', () => {
    const family =
      'body.is-phone .abyss-panel-view :is(.abyss-view-state-btn, button.abyss-compact-pane-button)';
    const today = 'body.is-phone .abyss-cal-nav .abyss-cal-nav-today';
    for (const selector of [family, today]) {
      const rule = declarationsFor(selector);
      expect(rule, selector).toContain('border: 0');
      expect(rule, selector).toContain('border-radius: 8px');
      expect(rule, selector).toContain('background: var(--background-modifier-border)');
      expect(rule, selector).not.toContain('color:');
      expect(declarationsFor(`${selector}:hover`), selector).toContain(
        'background: var(--background-modifier-hover)',
      );
    }
    expect(declarationsFor('body.is-phone .abyss-panel-view .abyss-center-search')).toContain(
      'border-radius: 8px',
    );
    // The tray the family copies (its :is() list is expanded for these assertions).
    expect(declarationsFor('.abyss-cal-view-switcher')).toContain('border-radius: 8px');
    // The date group stays flat whatever the host paints on plain buttons.
    for (const control of ['.abyss-cal-nav-btn', '.abyss-cal-nav-month', '.abyss-cal-nav-year']) {
      const flat = declarationsFor(`body.is-phone .abyss-cal-nav ${control}`);
      expect(flat, control).toContain('background: transparent');
      expect(flat, control).toContain('box-shadow: none');
    }
  });

  it('reserves the phone navigation inset from the host variable', () => {
    expect(declarationsFor('.abyss-panel-view')).toContain('--abyss-shell-bottom-inset: 0px');
    expect(declarationsFor('body.is-phone .abyss-panel-view')).toContain(
      '--abyss-shell-bottom-inset: max(0px, var(--view-bottom-spacing, 0px))',
    );
    expect(declarationsFor('body.is-phone .abyss-panel-view.abyss-panel-view--keyboard')).toContain(
      '--abyss-shell-bottom-inset: 0px',
    );
    for (const pane of ['.abyss-rail', '.abyss-left', '.abyss-center-shell', '.abyss-right']) {
      expect(declarationsFor(`body.is-phone .abyss-layout > ${pane}`), pane).toContain(
        'padding-block-end: var(--abyss-shell-bottom-inset)',
      );
    }
  });

  it('keeps a usable title track under the observed 292px center metadata pressure', () => {
    const center = declarationsFor('.abyss-center');
    const compact = atRuleBlock('@container abyss-task-list (max-width: 28rem)');
    const mainRow = declarationsForSource(compact, '.abyss-task-card-main-row');
    const mainRowWithDelete = declarationsForSource(
      compact,
      '.abyss-task-card-main-row--has-delete',
    );
    const metadata = declarationsForSource(compact, '.abyss-task-meta-right');
    const sourceNote = declarationsForSource(compact, '.abyss-task-source-note');

    expect(center).toContain('container-type: inline-size');
    expect(center).toContain('container-name: abyss-task-list');
    expect(mainRow).toContain('display: grid');
    expect(mainRow).toContain(
      'grid-template-columns: var(--abyss-task-card-marker-size) minmax(0, 1fr)',
    );
    expect(mainRow).not.toContain('minmax(0, 1fr) 24px');
    expect(mainRowWithDelete).toContain(
      'grid-template-columns: var(--abyss-task-card-marker-size) minmax(0, 1fr) 24px',
    );
    expect(metadata).toContain('grid-column: 2 / -1');
    expect(metadata).toContain('grid-row: 2');
    expect(sourceNote).toContain('white-space: nowrap');
  });

  it('starts the narrow metadata row at the title text edge on every device', () => {
    const compact = atRuleBlock('@container abyss-task-list (max-width: 28rem)');
    const metadata = declarationsForSource(compact, '.abyss-task-meta-right');

    expect(metadata).toContain('grid-row: 2');
    expect(metadata).toContain('justify-content: flex-start');
    expect(declarationsFor('.abyss-task-meta-right')).toContain(
      'place-content: flex-start flex-end',
    );
  });

  it('keeps a mounted delete button visible without a card-hover reveal rule', () => {
    const deleteButton = declarationsFor('.abyss-task-delete-btn');

    expect(deleteButton).not.toContain('opacity: 0');
    expect(declarationsFor('.abyss-task-card:hover .abyss-task-delete-btn')).toBe('');
  });

  it('keeps active dependency indicators between the checkbox and title at constrained widths', () => {
    const compact = atRuleBlock('@container abyss-task-list (max-width: 28rem)');
    const withIndicator = '.abyss-task-card-main-row:has(> .abyss-dep-indicator)';
    expect(declarationsForSource(compact, withIndicator)).toContain(
      'grid-template-columns: var(--abyss-task-card-marker-size) auto minmax(0, 1fr)',
    );
    expect(
      declarationsForSource(
        compact,
        '.abyss-task-card-main-row--has-delete:has(> .abyss-dep-indicator)',
      ),
    ).toContain('auto minmax(0, 1fr) 24px');
    expect(
      declarationsForSource(compact, '.abyss-task-card-main-row > .abyss-status-control'),
    ).toContain('grid-column: 1');
    const indicator = declarationsForSource(
      compact,
      '.abyss-task-card-main-row > .abyss-dep-indicator',
    );
    expect(indicator).toContain('grid-column: 2');
    expect(indicator).toContain('grid-row: 1');
    expect(declarationsForSource(compact, `${withIndicator} > .abyss-task-body`)).toContain(
      'grid-column: 3',
    );
    expect(declarationsForSource(compact, `${withIndicator} > .abyss-task-meta-right`)).toContain(
      'grid-column: 3 / -1',
    );
    expect(declarationsForSource(compact, `${withIndicator} > .abyss-task-delete-btn`)).toContain(
      'grid-column: 4',
    );
  });

  it('keeps hover and selection states paint-only so controls do not shift', () => {
    const paintBySelector = new Map([
      ['.abyss-task-card:hover', 'background:'],
      ['.abyss-task-card.is-selected', 'background:'],
      ['.abyss-task-card.abyss-multi-selected', 'box-shadow:'],
    ]);
    for (const [selector, paint] of paintBySelector) {
      const declarations = cssDeclarationsFor(css, selector);
      expect(declarations).toContain(paint);
      expect(declarations).not.toMatch(/(?:^|\s)(?:border|padding|margin|height|width)\s*:/u);
    }

    const keyboardFocus = declarationsFor('.abyss-task-card:focus-visible');
    expect(keyboardFocus).toContain('outline:');
    expect(keyboardFocus).toContain('outline-offset:');
    expect(keyboardFocus).not.toMatch(/(?:^|\s)(?:border|padding|margin|height|width)\s*:/u);
  });

  it('requires an exact selector arm for grouped paint-state rules', () => {
    const selected = '.abyss-task-card.is-selected';
    const lookalikeRules = `
      ${selected}-child,
      .scope ${selected} { background: var(--background-modifier-active-hover); }
    `;

    expect(cssDeclarationsFor(lookalikeRules, selected)).toBe('');
  });

  it('separates and vertically centers date and time icons from their labels', () => {
    const dateTimePart = declarationsFor('.abyss-task-date-part,\n.abyss-task-time-part');
    const dateIcon = declarationsFor('.abyss-date-icon');
    const dateIconSvg = declarationsFor('.abyss-date-icon svg');

    expect(dateTimePart).toContain('display: inline-flex');
    expect(dateTimePart).toContain('align-items: center');
    expect(dateTimePart).toContain('gap:');
    expect(dateIcon).toContain('justify-content: center');
    expect(dateIcon).toContain('line-height: 0');
    expect(dateIconSvg).toContain('display: block');
  });

  it('lifts the stopwatch of the time badge onto the axis of the digits beside it', () => {
    // The crown of the lucide timer takes the top of its box, which leaves the circle a pixel
    // under every other glyph in the row.
    expect(declarationsFor('.abyss-task-time-badge svg')).toContain('transform: translateY(-1px)');
  });

  it('underlines clickable center-panel tags on hover', () => {
    const tagHover = declarationsFor('.abyss-center .abyss-task-tag:hover');

    expect(tagHover).toContain('text-decoration: underline');
    expect(tagHover).toContain('text-underline-offset:');
  });
});

describe('Shared popover styles', () => {
  it('lets the anchored popover position the month and year pickers', () => {
    for (const picker of ['.abyss-month-picker', '.abyss-year-picker']) {
      const rule = declarationsFor(picker);
      expect(rule, picker).not.toContain('position:');
      expect(rule, picker).not.toContain('top:');
      expect(rule, picker).not.toContain('z-index:');
      expect(rule, picker).toContain('display: grid');
    }
    expect(declarationsFor('.abyss-popover-anchored')).toContain('position: absolute');
  });

  it('base popover sizing uses scalable units', () => {
    const popover = declarationsFor('.abyss-popover');

    expect(popover).toContain('border-radius: 0.5rem');
    expect(popover).toContain('padding: 0.5rem');
    expect(popover).toContain('min-width: 10rem');
    expect(popover).toContain('box-shadow: var(--shadow-s, none)');
  });

  it('priority popover follows the view-state menu surface and option rhythm', () => {
    const priorityPopover = declarationsFor('.abyss-priority-popover');
    const priorityOption = declarationsFor('.abyss-priority-option');
    const priorityOptionFlag = declarationsFor('.abyss-priority-option-flag');
    const priorityOptionCheck = declarationsFor('.abyss-priority-option-check');

    expect(priorityPopover).not.toContain('min-inline-size');
    expect(priorityPopover).toContain('min-width: 0');
    expect(priorityPopover).toContain('display: grid');
    expect(priorityPopover).toContain('inline-size: max-content');
    expect(priorityPopover).toContain(
      'max-inline-size: calc(100% - (var(--abyss-popover-edge-gap, 0.5rem) * 2))',
    );
    expect(priorityPopover).toContain('padding: 0');
    expect(priorityPopover).toContain('border-radius: 0.5rem');
    expect(priorityPopover).toContain('border: 0');
    expect(priorityPopover).toContain('overflow: hidden');
    expect(priorityPopover).toContain('box-shadow: var(--shadow-s, none)');
    expect(priorityOption).toContain('grid-template-columns: 0.8em 0.9em max-content');
    expect(priorityOption).toContain('justify-content: start');
    expect(priorityOption).toContain('column-gap: 0.35em');
    expect(priorityOption).toContain('padding: 0.5em 0.65em 0.5em 0.45em');
    expect(priorityOptionFlag).toContain('width: 0.9em');
    expect(priorityOptionFlag).toContain('justify-content: center');
    expect(priorityOptionCheck).toContain('width: 0.8em');
    expect(priorityOptionCheck).not.toContain('margin-left: auto');
  });

  it('keeps the add-date chooser content-sized without inheriting context-menu alignment or width', () => {
    const compact = declarationsFor('.abyss-add-date-menu--compact');
    const context = declarationsFor('.abyss-context-menu');

    expect(compact).toContain('right: auto');
    expect(compact).toContain('min-width: 0');
    expect(compact).toContain('inline-size: max-content');
    expect(context).toContain('min-width: 140px');
  });

  it('date and time popovers use the shared compact anchored surface', () => {
    const dateTimePopover = declarationsFor('.abyss-date-popover,\n.abyss-time-popover');
    const inputRow = declarationsFor('.abyss-popover-input-row');
    const dateTimeInput = declarationsFor(
      '.abyss-date-input,\n.abyss-time-input,\n.abyss-duration-input',
    );
    const dateTimeInputOverride = declarationsFor(
      '.abyss-date-popover .abyss-date-input,\n.abyss-time-popover .abyss-time-input',
    );

    expect(dateTimePopover).toContain('border: 0');
    expect(dateTimePopover).toContain('box-shadow: var(--shadow-s, none)');
    expect(dateTimePopover).toContain('border-radius: 0.5rem');
    expect(inputRow).toContain('height: 2rem');
    expect(inputRow).toContain('gap: 0.5rem');
    expect(inputRow).toContain('align-items: center');
    expect(dateTimeInput).toContain('border-radius: 0.375rem');
    expect(dateTimeInput).toContain('height: 100%');
    expect(dateTimeInput).toContain('padding: 0 0.5rem');
    expect(dateTimeInput).toContain('border: 1px solid var(--background-modifier-border)');
    expect(dateTimeInput).toContain('background: transparent');
    expect(dateTimeInputOverride).toContain('border: 1px solid var(--background-modifier-border)');
    expect(dateTimeInputOverride).toContain('background: transparent');
    expect(dateTimeInputOverride).toContain('box-shadow: none');
  });

  it('priority colors follow Obsidian theme variables', () => {
    const panel = declarationsFor('.abyss-panel-view');

    expect(panel).toContain('--abyss-priority-a: var(--color-red)');
    expect(panel).toContain('--abyss-priority-b: var(--color-orange)');
    expect(panel).toContain('--abyss-priority-c: var(--color-yellow)');
    expect(panel).toContain('--abyss-priority-e: var(--color-blue)');
    expect(panel).toContain('--abyss-priority-f: var(--color-purple)');
    expect(panel).not.toContain('--abyss-priority-b: var(--color-red)');
    expect(panel).not.toMatch(/--abyss-priority-[a-f]:\s*#[0-9a-f]/iu);
    expect(panel).not.toContain('--abyss-priority-e: #66a3ff');
    expect(panel).not.toContain('--abyss-priority-f: #2255cc');
  });

  it('date urgency colors are independent from priority menu colors', () => {
    const panel = declarationsFor('.abyss-panel-view');
    const overdueDate = declarationsFor('.abyss-task-date.is-overdue');
    const tomorrowDate = declarationsFor('.abyss-task-date.is-tomorrow');

    expect(panel).toContain('--abyss-date-overdue: var(--color-red)');
    expect(panel).toContain('--abyss-date-tomorrow: var(--color-orange)');
    expect(overdueDate).toContain('color: var(--abyss-date-overdue)');
    expect(tomorrowDate).toContain('color: var(--abyss-date-tomorrow)');
    expect(overdueDate).not.toContain('var(--abyss-priority-b)');
    expect(tomorrowDate).not.toContain('var(--abyss-priority-c)');
  });
});

describe('Panel hierarchy styles', () => {
  it('uses section spacing without decorative divider rules', () => {
    const adjacentRightSections = declarationsFor('.abyss-right-section + .abyss-right-section');

    expect(css).not.toContain('.abyss-left-divider');
    expect(css).not.toContain('.abyss-right-divider');
    expect(adjacentRightSections).toContain('margin-top: var(--size-4-2)');
    expect(adjacentRightSections).not.toContain('border');
  });
});
