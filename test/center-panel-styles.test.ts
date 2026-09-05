import { describe, expect, it } from 'vitest';
import { loadPluginStyles } from './helpers';

const css = await loadPluginStyles();

function declarationsFor(selector: string): string {
  return declarationsForSource(css, selector);
}

function declarationsForSource(source: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&').replace(/\\,/gu, ',');
  const match = new RegExp(`${escaped}\\s*\\{(?<body>[^}]*)\\}`, 'u').exec(source);
  return match?.groups?.['body'] ?? '';
}

function atRuleBlock(header: string): string {
  const start = css.indexOf(header);
  if (start < 0) return '';
  const opening = css.indexOf('{', start + header.length);
  if (opening < 0) return '';
  let depth = 0;
  for (let index = opening; index < css.length; index++) {
    if (css[index] === '{') depth += 1;
    if (css[index] === '}') depth -= 1;
    if (depth === 0) return css.slice(opening + 1, index);
  }
  return '';
}

describe('CenterPanel task metadata styles', () => {
  it('paints keyboard focus on the focusable center without a mouse-focus outline', () => {
    const center = declarationsFor('.abyss-center');
    const focusVisible = declarationsFor('.abyss-center:focus-visible');

    expect(center).not.toContain('outline:');
    expect(focusVisible).toContain('outline: 1px solid var(--background-modifier-border-focus)');
    expect(focusVisible).toContain('outline-offset: -1px');
  });

  it('uses one centered primary-row contract without compensating offsets', () => {
    const card = declarationsFor('.abyss-task-card');
    const mainRow = declarationsFor('.abyss-task-card-main-row');
    const titleRow = declarationsFor('.abyss-task-title-row');
    const metadata = declarationsFor('.abyss-task-meta-right');
    const deleteButton = declarationsFor('.abyss-task-delete-btn');

    expect(card).toContain('flex-direction: column');
    expect(card).toContain('min-width: 0');
    expect(mainRow).toContain('display: flex');
    expect(mainRow).toContain('align-items: center');
    expect(mainRow).toContain('width: 100%');
    expect(mainRow).toContain('min-width: 0');
    expect(titleRow).toContain('align-items: center');
    expect(metadata).not.toContain('padding-top');
    expect(deleteButton).not.toContain('align-self');
  });

  it('keeps descriptions title-aligned while narrow primary rows contain their content', () => {
    const description = declarationsFor('.abyss-task-card > .abyss-task-desc');
    const body = declarationsFor('.abyss-task-body');
    const metadata = declarationsFor('.abyss-task-meta-right');

    expect(description).toContain('margin-inline-start:');
    expect(description).toContain('var(--abyss-task-card-marker-size)');
    expect(description).toContain('var(--abyss-task-card-primary-gap)');
    expect(body).toContain('min-width: 0');
    expect(metadata).toContain('min-width: 0');
    expect(metadata).toContain('overflow: hidden');
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
      const declarations = declarationsFor(selector);
      expect(declarations).toContain(paint);
      expect(declarations).not.toMatch(/(?:^|\s)(?:border|padding|margin|height|width)\s*:/u);
    }

    const keyboardFocus = declarationsFor('.abyss-task-card:focus-visible');
    expect(keyboardFocus).toContain('outline:');
    expect(keyboardFocus).toContain('outline-offset:');
    expect(keyboardFocus).not.toMatch(/(?:^|\s)(?:border|padding|margin|height|width)\s*:/u);
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

  it('underlines clickable center-panel tags on hover', () => {
    const tagHover = declarationsFor('.abyss-center .abyss-task-tag:hover');

    expect(tagHover).toContain('text-decoration: underline');
    expect(tagHover).toContain('text-underline-offset:');
  });
});

describe('Shared popover styles', () => {
  it('base popover sizing uses scalable units', () => {
    const popover = declarationsFor('.abyss-popover');

    expect(popover).toContain('border-radius: 0.5rem');
    expect(popover).toContain('padding: 0.5rem');
    expect(popover).toContain('min-width: 10rem');
    expect(popover).toContain('box-shadow: var(--shadow-s)');
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
    expect(priorityPopover).toContain('box-shadow: var(--shadow-s)');
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
    expect(dateTimePopover).toContain('box-shadow: var(--shadow-s)');
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
    expect(adjacentRightSections).toContain('margin-top: 8px');
    expect(adjacentRightSections).not.toContain('border');
  });
});
