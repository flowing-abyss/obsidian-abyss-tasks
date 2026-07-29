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
    const panel = declarationsFor('.tc-panel-view');

    expect(panel).toContain('--tc-shell-top-inset: clamp(3px, 0.4vw, 5px)');
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
    ['.tc-layout > .tc-rail', '8px'],
    ['.tc-layout > .tc-left > .tc-left-section:first-child', '12px'],
    [
      '.tc-layout--tasks > .tc-center > .tc-center-header, .tc-layout--search > .tc-center > .tc-center-header',
      '12px',
    ],
    ['.tc-layout--calendar > .tc-center > .tc-cal-nav', '8px'],
    ['.tc-layout--projects > .tc-center .tc-projects-toolbar', '12px'],
    ['.tc-layout > .tc-right > .tc-right-header:first-child', '12px'],
    ['.tc-layout > .tc-right > .tc-breadcrumb:first-child', '18px'],
  ])('adds the inset to the approved top-level surface %s', (selector, existingTopPadding) => {
    expect(declarationsFor(selector)).toContain(
      `padding-top: calc(${existingTopPadding} + var(--tc-shell-top-inset))`,
    );
  });

  it('calibrates the first task-mode controls to the same 26px plus inset centerline', () => {
    // Existing geometry after each supplemental top padding:
    // rail half-button 18; left row margin 1 + padding 5 + half-icon 8; filter half-height 14.
    const centerlines = [
      supplementalTopPaddingPx('.tc-layout > .tc-rail') + 18,
      supplementalTopPaddingPx('.tc-layout > .tc-left > .tc-left-section:first-child') + 1 + 5 + 8,
      supplementalTopPaddingPx(
        '.tc-layout--tasks > .tc-center > .tc-center-header, .tc-layout--search > .tc-center > .tc-center-header',
      ) + 14,
    ];

    expect(centerlines).toEqual([26, 26, 26]);
  });

  it('does not add the inset to content, grid, empty, section, or modal surfaces', () => {
    const insetSelectors = rules
      .filter((rule) => rule.body.includes('var(--tc-shell-top-inset)'))
      .map((rule) => rule.selector);

    expect(insetSelectors).toEqual([
      '.tc-layout > .tc-rail',
      '.tc-layout > .tc-left > .tc-left-section:first-child',
      '.tc-layout--tasks > .tc-center > .tc-center-header, .tc-layout--search > .tc-center > .tc-center-header',
      '.tc-layout--calendar > .tc-center > .tc-cal-nav',
      '.tc-layout--projects > .tc-center .tc-projects-toolbar',
      '.tc-layout > .tc-right > .tc-right-header:first-child',
      '.tc-layout > .tc-right > .tc-breadcrumb:first-child',
    ]);

    for (const selector of [
      '.tc-center-scroll',
      '.tc-cal-body',
      '.tc-right-section',
      '.tc-center-empty',
      '.tc-modal-body',
      '.tc-modal .tc-right-header',
      '.tc-layout > .tc-right > .tc-right-header',
    ]) {
      expect(declarationsFor(selector)).not.toContain('var(--tc-shell-top-inset)');
    }
  });
});
