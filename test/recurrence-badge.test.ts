import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { addIcon } from 'obsidian';
import { describe, expect, it } from 'vitest';
import {
  recurrenceBadgeInput,
  renderRecurrenceBadge,
} from '../src/ui/recurrence/renderRecurrenceBadge';

addIcon('repeat-2', '<svg data-lucide="repeat-2"><path d="M17 2l4 4-4 4"/></svg>');

describe('renderRecurrenceBadge', () => {
  it('renders one fixed repeat-2 icon slot with an accessible valid-rule tooltip', () => {
    const container = activeDocument.createElement('div');

    const badge = renderRecurrenceBadge(container, {
      rule: 'every week',
      validity: 'valid',
    });

    expect(container.querySelectorAll('.abyss-recurrence-badge')).toHaveLength(1);
    expect(badge.dataset['recurrenceValidity']).toBe('valid');
    expect(badge.getAttribute('title')).toBe('Repeats: every week');
    expect(badge.getAttribute('aria-label')).toBe('Repeats: every week');
    expect(badge.querySelectorAll('.abyss-recurrence-badge-icon')).toHaveLength(1);
    expect(badge.querySelector('.abyss-recurrence-badge-icon')?.getAttribute('data-icon')).toBe(
      'repeat-2',
    );
    expect(badge.querySelectorAll('[data-lucide="repeat-2"]')).toHaveLength(1);
  });

  it('keeps invalid and forecast recurrence on the same badge component and geometry contract', () => {
    const container = activeDocument.createElement('div');

    const badge = renderRecurrenceBadge(container, {
      rule: 'tomorrow',
      validity: 'invalid',
      reason: 'Start the rule with “every”.',
      forecast: true,
    });

    expect(badge.classList.contains('abyss-recurrence-badge')).toBe(true);
    expect(badge.dataset['recurrenceValidity']).toBe('invalid');
    expect(badge.dataset['recurrenceForecast']).toBe('true');
    expect(badge.getAttribute('title')).toBe('Invalid repeat rule: Start the rule with “every”.');
    expect(badge.getAttribute('aria-label')).toBe(
      'Invalid repeat rule: Start the rule with “every”.',
    );
    expect(badge.querySelectorAll('.abyss-recurrence-badge-icon')).toHaveLength(1);
  });

  it('derives validity and parser issue text from the authoritative rule parser', () => {
    expect(recurrenceBadgeInput('every weekday')).toEqual({
      rule: 'every weekday',
      validity: 'valid',
    });
    expect(recurrenceBadgeInput('tomorrow')).toEqual({
      rule: 'tomorrow',
      validity: 'invalid',
      reason: 'Start the rule with “every”.',
    });
  });

  it('keeps valid, invalid, and forecast states on one tokenized fixed geometry without opacity', () => {
    const css = readFileSync(resolve(import.meta.dirname, '..', 'styles.css'), 'utf8');
    const base = /\.abyss-recurrence-badge\s*\{([^}]*)\}/u.exec(css)?.[1] ?? '';
    const icon = /\.abyss-recurrence-badge-icon\s*\{([^}]*)\}/u.exec(css)?.[1] ?? '';
    const invalid =
      /\.abyss-recurrence-badge\[data-recurrence-validity='invalid'\]\s*\{([^}]*)\}/u.exec(
        css,
      )?.[1] ?? '';
    const forecast =
      /\.abyss-recurrence-badge\[data-recurrence-forecast='true'\]\s*\{([^}]*)\}/u.exec(css)?.[1] ??
      '';

    expect(base).toMatch(/box-sizing:\s*border-box/u);
    expect(base).toMatch(/height:\s*var\(--abyss-recurrence-badge-height\)/u);
    expect(base).toMatch(/border-radius:\s*var\(--abyss-recurrence-badge-radius\)/u);
    expect(base).toMatch(/padding:\s*var\(--abyss-recurrence-badge-padding\)/u);
    expect(base).toMatch(/background:\s*var\(--background-modifier-hover\)/u);
    expect(base).not.toMatch(/opacity/u);
    expect(icon).toMatch(/width:\s*var\(--abyss-recurrence-badge-icon-size\)/u);
    expect(icon).toMatch(/flex:\s*0 0 var\(--abyss-recurrence-badge-icon-size\)/u);
    expect(invalid).toMatch(/color:\s*var\(--text-warning/u);
    expect(invalid).not.toMatch(/height|padding|border-radius|opacity/u);
    expect(forecast).toMatch(/outline:\s*1px dotted var\(--text-faint\)/u);
    expect(forecast).not.toMatch(/height|padding|border-radius|opacity/u);
  });

  it('keeps the body-mounted editor fixed above the later generic anchored-popover rule', () => {
    const css = readFileSync(resolve(import.meta.dirname, '..', 'styles.css'), 'utf8');
    const floating =
      /\.abyss-popover-anchored\.abyss-recurrence-popover-floating\s*\{([^}]*)\}/u.exec(css)?.[1] ??
      '';

    expect(floating).toMatch(/position:\s*fixed/u);
  });

  it('layers destructive confirmation above the task-detail modal', () => {
    const css = readFileSync(resolve(import.meta.dirname, '..', 'styles.css'), 'utf8');
    const confirmation = /\.abyss-recurrence-delete-confirm\s*\{([^}]*)\}/u.exec(css)?.[1] ?? '';
    const modal = /\.abyss-modal-backdrop\s*\{([^}]*)\}/u.exec(css)?.[1] ?? '';
    const confirmationLayer = Number(/z-index:\s*(\d+)/u.exec(confirmation)?.[1]);
    const modalLayer = Number(/z-index:\s*(\d+)/u.exec(modal)?.[1]);

    expect(confirmationLayer).toBeGreaterThan(modalLayer);
  });
});
