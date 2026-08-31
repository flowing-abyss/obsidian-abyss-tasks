// eslint-disable-next-line import/no-nodejs-modules -- this contract reads the shipped stylesheet.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(`${import.meta.dirname}/../styles.css`, 'utf8');

interface CssRule {
  selector: string;
  body: string;
}

function normalizeSelector(selector: string): string {
  let normalized = '';
  let pendingSpace = false;
  for (const character of selector) {
    if (
      character === ' ' ||
      character === '\n' ||
      character === '\r' ||
      character === '\t' ||
      character === '\f'
    ) {
      pendingSpace = normalized.length > 0 && normalized[normalized.length - 1] !== ' ';
    } else if (character === ',') {
      normalized += ', ';
      pendingSpace = false;
    } else {
      if (pendingSpace) normalized += ' ';
      normalized += character;
      pendingSpace = false;
    }
  }
  return normalized.trim();
}

function withoutComments(source: string): string {
  let clean = '';
  let cursor = 0;
  while (cursor < source.length) {
    const commentStart = source.indexOf('/*', cursor);
    if (commentStart === -1) return clean + source.slice(cursor);
    clean += source.slice(cursor, commentStart);
    const commentEnd = source.indexOf('*/', commentStart + 2);
    if (commentEnd === -1) return clean;
    cursor = commentEnd + 2;
  }
  return clean;
}

function parseTopLevelRules(source: string): CssRule[] {
  const parsed: CssRule[] = [];
  let depth = 0;
  let selectorStart = 0;
  let bodyStart = 0;
  let selector = '';

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (character === '{') {
      if (depth === 0) {
        selector = normalizeSelector(source.slice(selectorStart, index));
        bodyStart = index + 1;
      }
      depth += 1;
    } else if (character === '}') {
      depth -= 1;
      if (depth === 0) {
        parsed.push({ selector, body: source.slice(bodyStart, index) });
        selectorStart = index + 1;
      }
    }
  }

  return parsed;
}

function withoutWhitespace(source: string): string {
  let compact = '';
  for (const character of source) {
    if (
      character !== ' ' &&
      character !== '\n' &&
      character !== '\r' &&
      character !== '\t' &&
      character !== '\f'
    ) {
      compact += character;
    }
  }
  return compact;
}

function countOccurrences(source: string, needle: string): number {
  let count = 0;
  let cursor = 0;
  while (cursor < source.length) {
    const next = source.indexOf(needle, cursor);
    if (next === -1) return count;
    count += 1;
    cursor = next + needle.length;
  }
  return count;
}

function boundedBlock(source: string, header: string): string {
  const start = source.indexOf(header);
  if (start < 0) return '';
  const open = source.indexOf('{', start + header.length);
  if (open < 0) return '';
  let depth = 1;
  for (let index = open + 1; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    else if (source[index] === '}') depth -= 1;
    if (depth === 0) return source.slice(open + 1, index);
  }
  return '';
}

function declarationsInAtRule(header: string, selector: string): string {
  const nestedRules = parseTopLevelRules(withoutComments(boundedBlock(css, header)));
  const normalized = normalizeSelector(selector);
  return nestedRules
    .filter((rule) => rule.selector === normalized)
    .map(({ body }) => body)
    .join('\n');
}

const rules = parseTopLevelRules(withoutComments(css));

function declarationsFor(selector: string): string {
  const normalized = normalizeSelector(selector);
  return rules
    .filter((rule) => rule.selector === normalized)
    .map((rule) => rule.body)
    .join('\n');
}

function supplementalTopPaddingPx(selector: string): number {
  const declaration = declarationsFor(selector);
  const prefix = 'padding-top: calc(';
  const valueStart = declaration.indexOf(prefix) + prefix.length;
  const valueEnd = declaration.indexOf('px', valueStart);
  return Number(declaration.slice(valueStart, valueEnd));
}

describe('Panel shell top rhythm', () => {
  it('defines one responsive inset and one subtle theme-derived root edge', () => {
    const panel = declarationsFor('.abyss-panel-view');

    expect(panel).toContain('--abyss-shell-top-inset: clamp(3px, 0.4vw, 5px)');
    expect(panel).toContain('border-top: 1px solid var(--background-modifier-border)');
    expect(withoutWhitespace(panel)).toContain(
      'border-top-color:color-mix(insrgb,var(--background-modifier-border)60%,transparent)',
    );
    expect(countOccurrences(panel, 'border-top:')).toBe(1);
    expect(panel).toContain('box-sizing: border-box');
    for (const property of ['box-shadow:', 'outline:', 'border-radius:']) {
      expect(panel).not.toContain(property);
    }
  });

  it.each([
    ['.abyss-layout > .abyss-rail', '8px'],
    ['.abyss-layout > .abyss-left > .abyss-left-section:first-child', '12px'],
    [
      '.abyss-layout--tasks > .abyss-center-shell > .abyss-center > .abyss-center-header, .abyss-layout--search > .abyss-center-shell > .abyss-center > .abyss-center-header',
      '12px',
    ],
    ['.abyss-layout--calendar > .abyss-center-shell > .abyss-center > .abyss-cal-nav', '8px'],
    [
      '.abyss-layout--projects > .abyss-center-shell > .abyss-center .abyss-projects-toolbar',
      '12px',
    ],
    ['.abyss-layout > .abyss-right > .abyss-right-header:first-child', '12px'],
    ['.abyss-layout > .abyss-right > .abyss-breadcrumb:first-child', '18px'],
  ])('adds the inset to the approved top-level surface %s', (selector, existingTopPadding) => {
    expect(declarationsFor(selector)).toContain(
      `padding-top: calc(${existingTopPadding} + var(--abyss-shell-top-inset))`,
    );
  });

  it('calibrates the first task-mode controls to the same 26px plus inset centerline', () => {
    // Existing geometry after each supplemental top padding:
    // rail half-button 18; left row margin 1 + padding 5 + half-icon 8; filter half-height 14.
    const centerlines = [
      supplementalTopPaddingPx('.abyss-layout > .abyss-rail') + 18,
      supplementalTopPaddingPx('.abyss-layout > .abyss-left > .abyss-left-section:first-child') +
        1 +
        5 +
        8,
      supplementalTopPaddingPx(
        '.abyss-layout--tasks > .abyss-center-shell > .abyss-center > .abyss-center-header, .abyss-layout--search > .abyss-center-shell > .abyss-center > .abyss-center-header',
      ) + 14,
    ];

    expect(centerlines).toEqual([26, 26, 26]);
  });

  it('does not add the inset to content, grid, empty, section, or modal surfaces', () => {
    const insetSelectors = rules
      .filter((rule) => rule.body.includes('var(--abyss-shell-top-inset)'))
      .map((rule) => rule.selector);

    expect(insetSelectors).toEqual([
      '.abyss-layout > .abyss-rail',
      '.abyss-layout > .abyss-left > .abyss-left-section:first-child',
      '.abyss-layout--tasks > .abyss-center-shell > .abyss-center > .abyss-center-header, .abyss-layout--search > .abyss-center-shell > .abyss-center > .abyss-center-header',
      '.abyss-layout--calendar > .abyss-center-shell > .abyss-center > .abyss-cal-nav',
      '.abyss-layout--projects > .abyss-center-shell > .abyss-center .abyss-projects-toolbar',
      '.abyss-layout > .abyss-right > .abyss-right-header:first-child',
      '.abyss-layout > .abyss-right > .abyss-breadcrumb:first-child',
    ]);

    for (const selector of [
      '.abyss-center-scroll',
      '.abyss-cal-body',
      '.abyss-right-section',
      '.abyss-center-empty',
      '.abyss-modal-body',
      '.abyss-modal .abyss-right-header',
      '.abyss-layout > .abyss-right > .abyss-right-header',
    ]) {
      expect(declarationsFor(selector)).not.toContain('var(--abyss-shell-top-inset)');
    }
  });
});

describe('Task inspector semantic wrapper layout', () => {
  it('keeps header and chip wrappers layout-neutral at 440px with a long title', () => {
    const style = activeDocument.createElement('style');
    style.textContent = css;
    const shell = activeDocument.createElement('section');
    shell.className = 'abyss-entity-inspector abyss-inspector-shell';
    shell.style.width = '440px';
    shell.style.fontSize = '200%';
    shell.innerHTML = `
      <header class="abyss-right-header">
        <div class="abyss-inspector-field-row abyss-right-status-field"><span>Status</span><div><button>Status</button></div></div>
        <div class="abyss-inspector-field-row abyss-right-title-field"><span>Title</span><div class="abyss-inspector-field-content"><div class="abyss-right-title abyss-right-title-view">${'A long Task title '.repeat(40)}</div></div></div>
        <div class="abyss-right-header-actions"><button>More</button></div>
      </header>
      <div class="abyss-chips-row"><div class="abyss-inspector-field-row abyss-task-chip-field"><span>Date</span><div><button class="abyss-chip">Date</button></div></div></div>`;
    activeDocument.head.appendChild(style);
    activeDocument.body.appendChild(shell);
    try {
      for (const wrapper of shell.querySelectorAll<HTMLElement>(
        '.abyss-right-status-field, .abyss-right-title-field, .abyss-task-chip-field',
      )) {
        const computed = getComputedStyle(wrapper);
        expect(computed.display).toBe('contents');
        expect(computed.marginTop).toBe('0px');
      }
      const title = shell.querySelector<HTMLElement>('.abyss-right-title-view')!;
      const titleContent = title.parentElement!;
      const actions = shell.querySelector<HTMLElement>('.abyss-right-header-actions')!;
      expect(getComputedStyle(titleContent).display).toBe('contents');
      expect(getComputedStyle(title).flexGrow).toBe('1');
      expect(getComputedStyle(title).minWidth).toBe('0px');
      expect(getComputedStyle(actions).flexShrink).toBe('0');
      expect(getComputedStyle(title).overflowWrap).toBe('anywhere');
      expect(getComputedStyle(shell).fontSize).toBe('200%');
    } finally {
      shell.remove();
      style.remove();
    }
  });
});

describe('Portfolio Board density contract', () => {
  it('bounds high-volume Board columns inside the available Projects workspace height', () => {
    const host = declarationsFor('.abyss-projects-board-host');
    const scroll = declarationsFor('.abyss-board-column-scroll');

    expect(host).toContain('display: flex');
    expect(host).toContain('flex: 1');
    expect(host).toContain('min-height: 0');
    expect(host).toContain('overflow: hidden');
    expect(scroll).toContain('flex: 1');
    expect(scroll).toContain('min-height: 0');
    expect(scroll).toContain('overflow-y: auto');
  });

  it('owns one horizontal scroller with readable expanded columns and fixed rails', () => {
    const columns = declarationsFor('.abyss-board-columns');
    const expanded = declarationsFor('.abyss-board-column');
    const rail = declarationsFor('.abyss-board-column.is-column-collapsed');

    expect(columns).toContain('overflow-x: auto');
    expect(columns).toContain('grid-auto-columns: max-content');
    expect(expanded).toContain('inline-size: 17rem');
    expect(expanded).toContain('min-inline-size: 17rem');
    expect(rail).toContain('inline-size: 3rem');
    expect(columns).not.toContain('minmax(0, 1fr)');
  });

  it('keeps persistent Board column and status controls at coarse-safe target size', () => {
    const columnControls = declarationsFor(
      '.abyss-board-column-actions > button,\n.abyss-board-reset-order',
    );
    const statusMenu = declarationsFor('.abyss-board-status-menu');

    expect(columnControls).toContain('inline-size: 44px');
    expect(columnControls).toContain('block-size: 44px');
    expect(statusMenu).toContain('inline-size: 44px');
    expect(statusMenu).toContain('block-size: 44px');
  });

  it('keeps Project board titles readable instead of breaking words vertically', () => {
    const title = declarationsFor('.abyss-board .abyss-project-name');
    expect(title).toContain('white-space: normal');
    expect(title).toContain('word-break: normal');
    expect(title).toContain('overflow-wrap: anywhere');
    expect(title).toContain('-webkit-line-clamp: 2');
  });

  it('does not reserve an empty fourth metadata track beside Project card titles', () => {
    const primary = declarationsFor('.abyss-board .abyss-project-row-line--primary');
    const progress = declarationsFor(
      '.abyss-board .abyss-project-task-progress .abyss-progress-wrap',
    );
    expect(primary).toContain('grid-template-columns: 10px minmax(0, 1fr) auto auto');
    expect(primary).not.toContain('minmax(5rem, auto)');
    expect(progress).toContain('min-width: 4rem');
  });
});

describe('Global search field geometry', () => {
  it('keeps the global search field flexible and bounded without width animation', () => {
    const globalSearch = declarationsFor('.abyss-search-global');
    const focusedGlobalSearch = declarationsFor('.abyss-search-global:focus');

    expect(globalSearch).toContain('flex: 1');
    expect(globalSearch).toContain('min-width: 0');
    expect(globalSearch).toMatch(/max-width:\s*\d+px/);
    expect(globalSearch).toContain('width: auto');
    expect(focusedGlobalSearch).toContain('width: auto');
    expect(globalSearch).toMatch(/transition:\s*border-color/);
    expect(globalSearch).not.toMatch(/transition:[^;]*\bwidth\b/);
  });
});

describe('Projects hardening styles', () => {
  const projectsStyles = css.slice(
    css.indexOf('/* ── Projects ─'),
    css.indexOf('/* ── Settings:', css.indexOf('/* ── Projects ─')),
  );

  it('keeps the hardened Projects slice theme-derived and preserves dense desktop rows', () => {
    expect(projectsStyles).not.toMatch(/#[\da-f]{3,8}\b|rgba?\(|hsla?\(/iu);
    for (const token of [
      'var(--background-primary)',
      'var(--background-secondary)',
      'var(--background-modifier-border)',
      'var(--text-normal)',
      'var(--text-muted)',
      'var(--interactive-accent)',
    ]) {
      expect(projectsStyles).toContain(token);
    }
    const row = declarationsFor('.abyss-work-note-row');
    expect(row).toContain('block-size: 52px');
    expect(row).not.toMatch(/min-(?:block-)?size:\s*(?:4[8-9]|[5-9]\d)px/u);
    const identity = declarationsFor('.abyss-work-note-identity');
    expect(identity).toContain('appearance: none');
    expect(identity).toContain('text-align: start');
    expect(identity).toContain('background: transparent');
    const status = declarationsFor('.abyss-status-pill');
    expect(status).toContain('background: var(--background-secondary)');
    expect(status).toContain('color: var(--text-normal)');
    expect(status).toContain('border-color: var(--abyss-project-status-accent)');
  });

  it('ellipsizes long Project/Work Note/Timeline identity without reserving absent columns', () => {
    for (const selector of [
      '.abyss-project-name',
      '.abyss-work-note-title',
      '.abyss-timeline-title, .abyss-timeline-detail',
    ]) {
      const declarations = declarationsFor(selector);
      expect(declarations, selector).toContain('overflow: hidden');
      expect(declarations, selector).toContain('text-overflow: ellipsis');
    }
    expect(declarationsFor('.abyss-work-note-row')).toContain(
      'grid-template-columns: minmax(0, 1fr) auto 26px',
    );
  });

  it('keeps the compact Work Note inspector inside a viewport-bounded drawer surface', () => {
    const drawer = declarationsInAtRule(
      '@container abyss-task-list (max-width: 42rem)',
      '.abyss-work-note-inspector-host:not(:empty)',
    );
    expect(drawer).toContain('position: absolute');
    expect(drawer).toMatch(/max-block-size:\s*min\([^;]+\)/u);
    expect(drawer).toContain('overflow-y: auto');
    expect(drawer).toMatch(/inset-(?:block|inline)/u);
    expect(declarationsFor('.abyss-work-notes-split')).toContain('position: relative');
  });

  it('makes the compact Board status affordance discoverable for coarse pointers', () => {
    const coarse = declarationsInAtRule(
      '@media (hover: none), (pointer: coarse)',
      '.abyss-board-status-menu',
    );
    expect(coarse).toContain('opacity: 1');
    expect(coarse).toContain('min-block-size: 44px');
    expect(coarse).toContain('min-inline-size: 44px');
    expect(coarse).toContain('inset-inline-end: 54px');
    expect(
      declarationsInAtRule('@media (hover: none), (pointer: coarse)', '.abyss-project-row'),
    ).toContain('padding-inline-end: 96px');
    const desktop = declarationsFor('.abyss-board-status-menu');
    expect(desktop).toContain('block-size: 44px');
    expect(desktop).toContain('inline-size: 44px');
  });

  it('switches multi-column Boards to one-column tabs before cards collapse vertically', () => {
    const compactBoard = '@container abyss-task-list (max-width: 52rem)';

    expect(declarationsInAtRule(compactBoard, '.abyss-board-column-tabs')).toContain(
      'display: flex',
    );
    expect(declarationsInAtRule(compactBoard, '.abyss-board-columns')).toContain('display: block');
    expect(declarationsInAtRule(compactBoard, '.abyss-board-column')).toContain('display: none');
    expect(declarationsInAtRule(compactBoard, '.abyss-board-column.is-active')).toContain(
      'display: flex',
    );
    expect(declarationsInAtRule(compactBoard, '.abyss-board-column.is-active')).toContain(
      'inline-size: 100%',
    );
    expect(declarationsFor('.abyss-board-column-tab.is-board-active-destination')).toContain(
      'outline: 2px solid var(--interactive-accent)',
    );
    const tabGap = declarationsFor('.abyss-board-tab-landing-gap');
    expect(tabGap).toContain('position: absolute');
    expect(tabGap).toContain('background: currentColor');
  });

  it('resets compact Project identity button chrome and exposes existing row actions on coarse pointers', () => {
    const identity = declarationsFor('.abyss-project-row button.abyss-project-row-name');
    expect(identity).toContain('appearance: none');
    expect(identity).toContain('background: transparent');
    expect(identity).toContain('border: 0');
    expect(identity).toContain('box-shadow: none');
    expect(identity).toContain('padding: 0');
    expect(identity).toContain('font: inherit');
    expect(identity).toContain('text-align: start');
    expect(identity).toContain('justify-content: flex-start');
    expect(
      declarationsFor('.abyss-project-row button.abyss-project-row-name:focus-visible'),
    ).toContain('outline:');

    const coarseActions = declarationsInAtRule(
      '@media (hover: none), (pointer: coarse)',
      '.abyss-project-row-actions',
    );
    expect(coarseActions).toContain('opacity: 1');
    expect(coarseActions).not.toContain('pointer-events: none');
  });

  it('anchors New Project capture outside layout flow with theme-native tokens', () => {
    const toolbar = declarationsFor('.abyss-projects-toolbar');
    const host = declarationsFor('.abyss-projects-new-input-host');
    const capture = declarationsFor('.abyss-project-capture');
    expect(toolbar).toContain('position: relative');
    expect(host).toContain('position: absolute');
    expect(host).toMatch(/inset-(?:block|inline)/u);
    expect(capture).toContain('background: var(--background-primary)');
    expect(capture).toContain('border: 1px solid var(--background-modifier-border)');
    expect(capture).not.toMatch(/#[\da-f]{3,8}|rgba?\(/iu);
    const recovery = declarationsFor('.abyss-project-capture-open-note');
    expect(recovery).toContain('white-space: nowrap');
    expect(recovery).toContain('color: var(--text-accent)');
  });

  it('keeps Overview rows in the ordinary Task-card surface language without metadata scroll', () => {
    const row = declarationsFor('.abyss-project-row');
    expect(row).toContain('background: transparent');
    expect(row).toContain('border: 0');
    expect(row).toContain('border-radius: 6px');
    expect(row).not.toContain('overflow-x: auto');
    expect(declarationsFor('.abyss-project-row:hover')).toContain(
      'background: var(--background-modifier-hover)',
    );
    expect(declarationsFor('.abyss-project-row:focus-within')).toContain(
      'outline: 1px solid var(--background-modifier-border-focus)',
    );
    expect(declarationsFor('.abyss-project-row-line')).toContain('min-width: 0');
    expect(declarationsFor('.abyss-project-name')).toContain('text-overflow: ellipsis');
  });

  it('overlays hover actions without a reserved desktop gap and keeps one 44px coarse action', () => {
    const actions = declarationsFor('.abyss-project-row-actions');
    expect(actions).toContain('position: absolute');
    expect(actions).toMatch(/inset-inline-end:/u);
    const coarse = declarationsInAtRule(
      '@media (hover: none), (pointer: coarse)',
      '.abyss-project-row-actions',
    );
    expect(coarse).toContain('inline-size: 44px');
    expect(coarse).toContain('block-size: 44px');
    expect(
      declarationsInAtRule(
        '@media (hover: none), (pointer: coarse)',
        '.abyss-project-row-actions > button',
      ),
    ).toContain('min-inline-size: 44px');
  });

  it('collapses status overflow behind one Show summary without horizontal scrolling', () => {
    const filters = declarationsFor('.abyss-project-status-filters');
    expect(filters).toContain('overflow: hidden');
    expect(filters).not.toContain('overflow-x: auto');
    expect(declarationsFor('.abyss-project-status-summary')).toContain('flex: 0 0 auto');
  });

  it('reflows every visible 440px coarse portfolio control without clipping its Show summary', () => {
    const style = activeDocument.createElement('style');
    style.textContent = [
      css,
      boundedBlock(css, '@container abyss-task-list (max-width: 42rem)'),
      boundedBlock(css, '@container abyss-task-list (max-width: 30rem)'),
      boundedBlock(css, '@media (hover: none), (pointer: coarse)'),
    ].join('\n');
    const toolbar = activeDocument.createElement('header');
    toolbar.className = 'abyss-center-header abyss-projects-toolbar';
    toolbar.innerHTML = `
      <h2 class="abyss-projects-title">Projects</h2>
      <div class="abyss-center-controls">
        <div class="abyss-project-status-filters" data-portfolio-zone="filters">
          <button class="abyss-filter-chip abyss-project-status-filter is-active">Active</button>
          <button class="abyss-filter-chip abyss-project-status-summary">Show 6</button>
        </div>
        <div data-portfolio-zone="layout">
          <div class="abyss-cal-view-switcher abyss-projects-view-switcher">
            <button class="abyss-cal-view-btn is-active">Overview</button>
            <button class="abyss-cal-view-btn">Board</button>
            <button class="abyss-cal-view-btn">Timeline</button>
          </div>
        </div>
        <div class="abyss-projects-add-zone" data-portfolio-zone="add">
          <button class="abyss-projects-new">New</button>
        </div>
      </div>`;
    activeDocument.head.appendChild(style);
    activeDocument.body.appendChild(toolbar);
    try {
      const controls = toolbar.querySelector<HTMLElement>('.abyss-center-controls')!;
      const filters = toolbar.querySelector<HTMLElement>('[data-portfolio-zone="filters"]')!;
      const layout = toolbar.querySelector<HTMLElement>('[data-portfolio-zone="layout"]')!;
      const add = toolbar.querySelector<HTMLElement>('[data-portfolio-zone="add"]')!;
      expect(getComputedStyle(controls).display).toBe('grid');
      expect(getComputedStyle(filters).gridColumn).toBe('1 / -1');
      expect(getComputedStyle(filters).gridRow).toBe('1');
      expect(getComputedStyle(layout).gridRow).toBe('2');
      expect(getComputedStyle(add).gridRow).toBe('2');
      const visibleControls = Array.from(toolbar.querySelectorAll<HTMLButtonElement>('button'));
      expect(visibleControls).toHaveLength(6);
      for (const control of visibleControls) {
        const computed = getComputedStyle(control);
        expect(computed.minInlineSize, control.textContent ?? 'control').toBe('44px');
        expect(computed.minBlockSize, control.textContent ?? 'control').toBe('44px');
      }
    } finally {
      toolbar.remove();
      style.remove();
    }
  });

  it('gives every visible Project workspace and Work Note action a 44px coarse target', () => {
    const style = activeDocument.createElement('style');
    style.textContent = [css, boundedBlock(css, '@media (hover: none), (pointer: coarse)')].join(
      '\n',
    );
    const workspace = activeDocument.createElement('section');
    workspace.className = 'abyss-panel-view';
    workspace.innerHTML = `
      <div class="abyss-project-scope-controls">
        <button data-project-scope="tasks">Tasks</button>
        <button data-project-scope="work-notes">Work Notes</button>
        <button data-project-use-as-default>Use as default</button>
      </div>
      <div class="abyss-collection-controls">
        <div class="abyss-project-layout-controls">
          <button data-project-layout="list">List</button>
          <button data-project-layout="board">Board</button>
          <button data-project-layout="timeline">Timeline</button>
        </div>
        <button class="abyss-collection-action">Filter</button>
        <button class="abyss-view-state-btn">Show</button>
        <input class="abyss-collection-search" aria-label="Filter Work Notes">
      </div>
      <div class="abyss-work-notes-toolbar">
        <button class="abyss-work-note-create" aria-label="Create Work Note"></button>
        <input class="abyss-work-note-create-input" aria-label="Work note title">
      </div>
      <div class="abyss-work-note-row">
        <button class="abyss-work-note-identity" data-work-note-identity-control>Note</button>
        <button class="abyss-work-note-status">Active</button>
        <button class="abyss-work-note-open" aria-label="Open work note"></button>
      </div>
      <div class="abyss-work-note-inspector-header">
        <button class="abyss-work-note-open" aria-label="Open work note"></button>
        <button class="abyss-work-note-inspector-close" aria-label="Close Work Note details"></button>
      </div>
      <button class="abyss-project-inspector-open" aria-label="Open project note"></button>`;
    activeDocument.head.appendChild(style);
    activeDocument.body.appendChild(workspace);
    try {
      const controls = Array.from(
        workspace.querySelectorAll<HTMLElement>(
          [
            '.abyss-project-scope-controls > button',
            '.abyss-collection-controls :is(button, input, select, summary)',
            '.abyss-work-note-create',
            '.abyss-work-note-create-input',
            '.abyss-work-note-identity',
            '.abyss-work-note-open',
            '.abyss-work-note-status',
            '.abyss-work-note-inspector-close',
            '.abyss-project-inspector-open',
          ].join(', '),
        ),
      );
      expect(controls).toHaveLength(17);
      for (const control of controls) {
        const computed = getComputedStyle(control);
        expect(
          computed.minInlineSize,
          control.getAttribute('aria-label') ?? control.textContent,
        ).toBe('44px');
        expect(
          computed.minBlockSize,
          control.getAttribute('aria-label') ?? control.textContent,
        ).toBe('44px');
      }
    } finally {
      workspace.remove();
      style.remove();
    }
  });

  it('keeps Work Note identity title-like against Obsidian button defaults', () => {
    const pluginStyle = activeDocument.createElement('style');
    pluginStyle.textContent = css;
    const obsidianBaseline = activeDocument.createElement('style');
    obsidianBaseline.textContent = `
      .workspace-leaf-content button:not(.clickable-icon) {
        padding: 10px 14px;
        border: 2px solid rgb(120, 120, 120);
        background: rgb(70, 70, 70);
        box-shadow: 0 1px 2px rgb(0, 0, 0);
        color: rgb(120, 120, 120);
        font: bold 18px sans-serif;
        text-align: center;
      }`;
    const workspace = activeDocument.createElement('section');
    workspace.className = 'workspace-leaf-content abyss-panel-view';
    workspace.style.setProperty('--text-normal', 'rgb(230, 230, 230)');
    workspace.innerHTML = `
      <div class="abyss-work-note-row">
        <button class="abyss-work-note-identity" data-work-note-identity-control>
          <span class="abyss-work-note-title">Research release plan</span>
        </button>
      </div>`;
    activeDocument.head.append(pluginStyle, obsidianBaseline);
    activeDocument.body.appendChild(workspace);
    try {
      const identity = workspace.querySelector<HTMLElement>('[data-work-note-identity-control]')!;
      const computed = getComputedStyle(identity);
      expect(['transparent', 'rgba(0, 0, 0, 0)']).toContain(computed.backgroundColor);
      expect(computed.borderTopWidth).toBe('0px');
      expect(computed.boxShadow).toBe('none');
      expect(computed.color).toBe('var(--text-normal)');
      expect(computed.paddingTop).toBe('0px');
      expect(computed.textAlign).toBe('start');
    } finally {
      workspace.remove();
      pluginStyle.remove();
      obsidianBaseline.remove();
    }
  });

  it('uses a static focus/state cue when Projects motion is reduced', () => {
    const header = '@media (prefers-reduced-motion: reduce)';
    expect(
      declarationsInAtRule(
        header,
        '.abyss-board *, .abyss-timeline *, .abyss-work-note-row, .abyss-project-row',
      ),
    ).toContain('transition: none');
    expect(declarationsInAtRule(header, '.abyss-board-column.is-drop-target')).toContain(
      'outline:',
    );
    expect(declarationsInAtRule(header, '.is-just-created')).toContain('animation: none');
  });

  it('keeps every Projects collection flex/grid chain shrinkable without page overflow', () => {
    for (const selector of [
      '.abyss-work-notes-content',
      '.abyss-work-notes-split',
      '.abyss-board',
      '.abyss-board-columns',
      '.abyss-timeline',
    ]) {
      const declarations = declarationsFor(selector);
      expect(declarations, selector).toContain('min-width: 0');
      expect(declarations, selector).toMatch(/min-(?:height|block-size):\s*0/u);
    }
  });

  it('freezes the resizable Timeline identity column over one continuous horizontal plot', () => {
    const identity = declarationsFor('.abyss-timeline-identity');
    expect(identity).toContain('position: sticky');
    expect(identity).toContain('inline-size: var(--abyss-timeline-identity-width)');
    expect(identity).toContain('background: var(--background-primary)');
    const scroll = declarationsFor('.abyss-timeline-scroll');
    expect(scroll).toContain('overflow-x: auto');
    expect(declarationsFor('.abyss-timeline-plot')).not.toContain('grid-template-columns: repeat(');
    expect(
      declarationsFor(".abyss-timeline-axis-dates > [data-timeline-axis-label-align='start']"),
    ).toContain('transform: translateX(0)');
    expect(
      declarationsFor(".abyss-timeline-axis-dates > [data-timeline-axis-label-align='end']"),
    ).toContain('transform: translateX(-100%)');
    expect(css).not.toContain('.abyss-timeline-agenda-date');
    expect(css).not.toContain('.abyss-timeline-drop-cell');
  });

  it('keeps Timeline handles quiet until hover/focus and gives coarse agenda controls 44px targets', () => {
    const handles = declarationsFor('.abyss-timeline-edge-handle');
    expect(handles).toContain('opacity: 0');
    expect(
      declarationsFor(
        '.abyss-timeline-row:hover .abyss-timeline-edge-handle, .abyss-timeline-row:focus-within .abyss-timeline-edge-handle',
      ),
    ).toContain('opacity: 1');
    const coarseTarget = declarationsInAtRule(
      '@media (hover: none), (pointer: coarse)',
      '.abyss-timeline-touch-target',
    );
    expect(coarseTarget).toContain('min-inline-size: 44px');
    expect(coarseTarget).toContain('min-block-size: 44px');
  });

  it('bounds expanded Timeline trays and renders narrow mode as a complete agenda', () => {
    expect(declarationsFor('.abyss-timeline-tray[open] .abyss-timeline-diagnostic-scroll')).toMatch(
      /max-block-size:\s*min\(/u,
    );
    const agenda = declarationsFor('.abyss-timeline.is-agenda .abyss-timeline-row');
    expect(agenda).toContain('block-size: 144px');
    expect(agenda).toContain('grid-template-columns: minmax(0, 1fr)');
    expect(agenda).toContain('grid-template-rows: minmax(0, 1fr) auto');
    expect(agenda).toContain('overflow: visible');
    const agendaIdentity = declarationsFor('.abyss-timeline.is-agenda .abyss-timeline-identity');
    expect(agendaIdentity).toContain('grid-column: 1');
    expect(agendaIdentity).toContain('grid-row: 1');
    expect(agendaIdentity).toContain('inline-size: 100%');
    const agendaControls = declarationsFor(
      '.abyss-timeline.is-agenda .abyss-timeline-date-controls',
    );
    expect(agendaControls).toContain('position: static');
    expect(agendaControls).toContain('grid-column: 1');
    expect(agendaControls).toContain('grid-row: 2');
    expect(agendaControls).toContain('grid-template-columns: repeat(2, minmax(0, 1fr)) auto');
    const agendaDiagnostic = declarationsFor(
      '.abyss-timeline.is-agenda .abyss-timeline-diagnostic-row',
    );
    expect(agendaDiagnostic).toContain('block-size: 88px');
    expect(agendaDiagnostic).toContain('grid-template-columns: minmax(0, 1fr) auto');
    expect(agendaDiagnostic).toContain('grid-template-rows: auto auto');
    expect(declarationsFor('.abyss-timeline.is-agenda .abyss-timeline-repair-preview')).toContain(
      'grid-column: 1',
    );
    expect(declarationsFor('.abyss-timeline.is-agenda .abyss-timeline-repair-confirm')).toContain(
      'grid-column: 2',
    );
    const style = activeDocument.createElement('style');
    style.textContent = css;
    const timeline = activeDocument.createElement('div');
    timeline.className = 'abyss-timeline is-agenda';
    const plot = timeline.createDiv({ cls: 'abyss-timeline-plot' });
    activeDocument.head.appendChild(style);
    activeDocument.body.appendChild(timeline);
    try {
      expect(getComputedStyle(plot).display).toBe('none');
    } finally {
      timeline.remove();
      style.remove();
    }
    expect(declarationsFor('.abyss-timeline.is-agenda .abyss-timeline-scroll')).toContain(
      'overflow-x: hidden',
    );
    expect(declarationsFor('.abyss-timeline.is-agenda .abyss-timeline-canvas')).toContain(
      'max-inline-size: 100%',
    );
  });

  it('keeps the portfolio identity rail compact and the repair action inside its bounded tray', () => {
    const identity = declarationsFor('.abyss-project-timeline-identity');
    expect(identity).toContain('display: grid');
    expect(identity).toContain('grid-template-columns: minmax(0, 1fr) auto auto');
    expect(identity).toContain('align-items: center');
    expect(identity).not.toContain('text-align: center');
    const identityButtons = declarationsFor(
      '.abyss-project-timeline-identity .abyss-project-identity-control, .abyss-project-milestone-timeline-identity .abyss-work-note-identity',
    );
    expect(identityButtons).toContain('min-block-size: 0');
    expect(identityButtons).toContain('height: auto');
    const milestoneIdentity = declarationsFor('.abyss-project-milestone-timeline-identity');
    expect(milestoneIdentity).toContain('grid-template-rows: auto auto');
    expect(milestoneIdentity).toContain('align-self: stretch');
    expect(milestoneIdentity).toContain('block-size: auto');
    const plot = declarationsFor('.abyss-timeline-plot');
    expect(plot).toContain('grid-column: 2');
    expect(plot).toContain('grid-row: 1');

    const preview = declarationsFor('.abyss-timeline-repair-preview');
    expect(preview).toContain('color: var(--text-muted)');
    expect(preview).toContain('font-family: var(--font-monospace)');
    expect(declarationsFor('.abyss-timeline-repair-confirm')).toContain(
      'border: 1px solid var(--background-modifier-border)',
    );
  });

  it('keeps the shared collection search free of decorative double dividers', () => {
    const controls = declarationsFor('.abyss-collection-controls');
    expect(controls).not.toMatch(/border-block(?:-start|-end)?\s*:/u);
    expect(css).not.toContain('[data-project-use-as-default]');

    const style = activeDocument.createElement('style');
    style.textContent = css;
    const controlsElement = activeDocument.createElement('div');
    controlsElement.className = 'abyss-collection-controls';
    controlsElement.createEl('input', { cls: 'abyss-collection-search' });
    activeDocument.head.appendChild(style);
    activeDocument.body.appendChild(controlsElement);
    try {
      expect(controlsElement.querySelector('.abyss-collection-search')?.parentElement).toBe(
        controlsElement,
      );
    } finally {
      controlsElement.remove();
      style.remove();
    }
  });

  it('reserves a 44px coarse target for the narrow inspector close icon only', () => {
    const close = declarationsFor('.abyss-inspector-shell-close');
    expect(close).toContain('min-inline-size: 44px');
    expect(close).toContain('min-block-size: 44px');
    expect(close).not.toContain('text: Close');
  });
});
