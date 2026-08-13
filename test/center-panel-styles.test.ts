import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(resolve(import.meta.dirname, '..', 'styles.css'), 'utf8');

function declarationsFor(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&').replace(/\\,/gu, ',');
  const match = new RegExp(`${escaped}\\s*\\{(?<body>[^}]*)\\}`, 'u').exec(css);
  return match?.groups?.['body'] ?? '';
}

describe('CenterPanel task metadata styles', () => {
  it('uses one centered primary-row contract without compensating offsets', () => {
    const card = declarationsFor('.tc-task-card');
    const mainRow = declarationsFor('.tc-task-card-main-row');
    const titleRow = declarationsFor('.tc-task-title-row');
    const metadata = declarationsFor('.tc-task-meta-right');
    const deleteButton = declarationsFor('.tc-task-delete-btn');

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
    const description = declarationsFor('.tc-task-card > .tc-task-desc');
    const body = declarationsFor('.tc-task-body');
    const metadata = declarationsFor('.tc-task-meta-right');

    expect(description).toContain('margin-inline-start:');
    expect(description).toContain('var(--tc-task-card-marker-size)');
    expect(description).toContain('var(--tc-task-card-primary-gap)');
    expect(body).toContain('min-width: 0');
    expect(metadata).toContain('min-width: 0');
    expect(metadata).toContain('overflow: hidden');
  });

  it('keeps hover and selection states paint-only so controls do not shift', () => {
    for (const selector of [
      '.tc-task-card:hover',
      '.tc-task-card.is-selected',
      '.tc-task-card.tc-multi-selected',
    ]) {
      const declarations = declarationsFor(selector);
      expect(declarations).not.toMatch(/(?:^|\s)(?:border|padding|margin|height|width)\s*:/u);
    }
  });

  it('separates and vertically centers date and time icons from their labels', () => {
    const dateTimePart = declarationsFor('.tc-task-date-part,\n.tc-task-time-part');
    const dateIcon = declarationsFor('.tc-date-icon');
    const dateIconSvg = declarationsFor('.tc-date-icon svg');

    expect(dateTimePart).toContain('display: inline-flex');
    expect(dateTimePart).toContain('align-items: center');
    expect(dateTimePart).toContain('gap:');
    expect(dateIcon).toContain('justify-content: center');
    expect(dateIcon).toContain('line-height: 0');
    expect(dateIconSvg).toContain('display: block');
  });

  it('underlines clickable center-panel tags on hover', () => {
    const tagHover = declarationsFor('.tc-center .tc-task-tag:hover');

    expect(tagHover).toContain('text-decoration: underline');
    expect(tagHover).toContain('text-underline-offset:');
  });
});

describe('Shared popover styles', () => {
  it('base popover sizing uses scalable units', () => {
    const popover = declarationsFor('.tc-popover');

    expect(popover).toContain('border-radius: 0.5rem');
    expect(popover).toContain('padding: 0.5rem');
    expect(popover).toContain('min-width: 10rem');
    expect(popover).toContain('box-shadow: var(--shadow-s)');
  });

  it('priority popover follows the view-state menu surface and option rhythm', () => {
    const priorityPopover = declarationsFor('.tc-priority-popover');
    const priorityOption = declarationsFor('.tc-priority-option');
    const priorityOptionFlag = declarationsFor('.tc-priority-option-flag');
    const priorityOptionCheck = declarationsFor('.tc-priority-option-check');

    expect(priorityPopover).not.toContain('min-inline-size');
    expect(priorityPopover).toContain('min-width: 0');
    expect(priorityPopover).toContain('display: grid');
    expect(priorityPopover).toContain('inline-size: max-content');
    expect(priorityPopover).toContain(
      'max-inline-size: calc(100% - (var(--tc-popover-edge-gap, 0.5rem) * 2))',
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
    const compact = declarationsFor('.tc-add-date-menu--compact');
    const context = declarationsFor('.tc-context-menu');

    expect(compact).toContain('right: auto');
    expect(compact).toContain('min-width: 0');
    expect(compact).toContain('inline-size: max-content');
    expect(context).toContain('min-width: 140px');
  });

  it('date and time popovers use the shared compact anchored surface', () => {
    const dateTimePopover = declarationsFor('.tc-date-popover,\n.tc-time-popover');
    const inputRow = declarationsFor('.tc-popover-input-row');
    const dateTimeInput = declarationsFor('.tc-date-input,\n.tc-time-input,\n.tc-duration-input');
    const dateTimeInputOverride = declarationsFor(
      '.tc-date-popover .tc-date-input,\n.tc-time-popover .tc-time-input',
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
    const panel = declarationsFor('.tc-panel-view');

    expect(panel).toContain('--tc-priority-a: var(--color-red)');
    expect(panel).toContain('--tc-priority-b: var(--color-orange)');
    expect(panel).toContain('--tc-priority-c: var(--color-yellow)');
    expect(panel).toContain('--tc-priority-e: var(--color-blue)');
    expect(panel).toContain('--tc-priority-f: var(--color-purple)');
    expect(panel).not.toContain('--tc-priority-b: var(--color-red)');
    expect(panel).not.toMatch(/--tc-priority-[a-f]:\s*#[0-9a-f]/iu);
    expect(panel).not.toContain('--tc-priority-e: #66a3ff');
    expect(panel).not.toContain('--tc-priority-f: #2255cc');
  });

  it('date urgency colors are independent from priority menu colors', () => {
    const panel = declarationsFor('.tc-panel-view');
    const overdueDate = declarationsFor('.tc-task-date.is-overdue');
    const tomorrowDate = declarationsFor('.tc-task-date.is-tomorrow');

    expect(panel).toContain('--tc-date-overdue: var(--color-red)');
    expect(panel).toContain('--tc-date-tomorrow: var(--color-orange)');
    expect(overdueDate).toContain('color: var(--tc-date-overdue)');
    expect(tomorrowDate).toContain('color: var(--tc-date-tomorrow)');
    expect(overdueDate).not.toContain('var(--tc-priority-b)');
    expect(tomorrowDate).not.toContain('var(--tc-priority-c)');
  });
});

describe('Panel hierarchy styles', () => {
  it('uses section spacing without decorative divider rules', () => {
    const adjacentRightSections = declarationsFor('.tc-right-section + .tc-right-section');

    expect(css).not.toContain('.tc-left-divider');
    expect(css).not.toContain('.tc-right-divider');
    expect(adjacentRightSections).toContain('margin-top: 8px');
    expect(adjacentRightSections).not.toContain('border');
  });
});
