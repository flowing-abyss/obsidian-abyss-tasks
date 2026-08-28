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
      '.abyss-timeline-title, .abyss-timeline-detail, .abyss-timeline-agenda-date',
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
    expect(coarse).toContain('min-block-size: 32px');
    expect(coarse).toContain('min-inline-size: 32px');
    const desktop = declarationsFor('.abyss-board-status-menu');
    expect(desktop).toContain('block-size: 26px');
    expect(desktop).toContain('inline-size: 26px');
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
  });

  it('resets compact Project identity button chrome and exposes existing row actions on coarse pointers', () => {
    const identity = declarationsFor('.abyss-project-row-name');
    expect(identity).toContain('appearance: none');
    expect(identity).toContain('background: transparent');
    expect(identity).toContain('border: 0');
    expect(identity).toContain('box-shadow: none');
    expect(identity).toContain('padding: 0');
    expect(identity).toContain('font: inherit');
    expect(identity).toContain('text-align: start');
    expect(declarationsFor('.abyss-project-row-name:focus-visible')).toContain('outline:');

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
});
