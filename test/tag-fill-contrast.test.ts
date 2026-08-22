import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  mixHexColors,
  relativeLuminanceOfHex,
  tagFillTextColorVar,
  tagFillTextVariant,
} from '../src/tags/tagFillContrast';

const css = readFileSync(resolve(import.meta.dirname, '..', 'styles.css'), 'utf8');

function rgbToHex([red, green, blue]: readonly [number, number, number]): string {
  return `#${[red, green, blue].map((channel) => channel.toString(16).padStart(2, '0')).join('')}`;
}

function contrastRatio(left: string, right: string): number {
  const leftLuminance = relativeLuminanceOfHex(left)!;
  const rightLuminance = relativeLuminanceOfHex(right)!;
  return (
    (Math.max(leftLuminance, rightLuminance) + 0.05) /
    (Math.min(leftLuminance, rightLuminance) + 0.05)
  );
}

function cssPercent(variable: string): number | null {
  const escaped = variable.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const value = new RegExp(`${escaped}\\s*:\\s*(\\d+(?:\\.\\d+)?)%`, 'u').exec(css)?.[1];
  return value === undefined ? null : Number(value);
}

function declarationsFor(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&').replace(/\\,/gu, ',');
  return new RegExp(`${escaped}\\s*\\{(?<body>[^}]*)\\}`, 'u').exec(css)?.groups?.['body'] ?? '';
}

describe('relativeLuminanceOfHex', () => {
  it('classifies known light colors as high luminance', () => {
    expect(relativeLuminanceOfHex('#ffffff')).toBeCloseTo(1, 2);
    // Pale yellow
    expect(relativeLuminanceOfHex('#fff8b0')!).toBeGreaterThan(0.8);
  });

  it('classifies known dark colors as low luminance', () => {
    expect(relativeLuminanceOfHex('#000000')).toBeCloseTo(0, 2);
    // Navy
    expect(relativeLuminanceOfHex('#000080')!).toBeLessThan(0.1);
  });

  it('supports 3-digit hex shorthand', () => {
    expect(relativeLuminanceOfHex('#fff')).toBeCloseTo(1, 2);
    expect(relativeLuminanceOfHex('#000')).toBeCloseTo(0, 2);
  });

  it('returns null for unparseable input', () => {
    expect(relativeLuminanceOfHex('not-a-color')).toBeNull();
    expect(relativeLuminanceOfHex('')).toBeNull();
  });
});

describe('mixHexColors', () => {
  it('replicates a simple channel-wise srgb mix', () => {
    // 40% red mixed into white background -> matches CSS color-mix(in srgb, red 40%, white)
    const mixed = mixHexColors('#ff0000', '#ffffff', 40);
    expect(mixed).toEqual([255, Math.round(255 * 0.6), Math.round(255 * 0.6)]);
  });

  it('returns null when either input is unparseable', () => {
    expect(mixHexColors('nope', '#ffffff', 40)).toBeNull();
    expect(mixHexColors('#ffffff', 'nope', 40)).toBeNull();
  });
});

describe('tagFillTextVariant', () => {
  it('returns undefined when there is no tag color (nothing to override)', () => {
    expect(tagFillTextVariant(undefined, '#ffffff')).toBeUndefined();
  });

  it('returns undefined when the background is unparseable, leaving the CSS fallback', () => {
    expect(tagFillTextVariant('#ffcc00', 'not-a-color')).toBeUndefined();
  });

  it('picks dark text for a bright/light tag mixed into a light background', () => {
    expect(tagFillTextVariant('#ffee58', '#ffffff', 11)).toBe('dark');
  });

  it('picks light text for a bright/light tag mixed into a dark background', () => {
    expect(tagFillTextVariant('#ffee58', '#1e1e1e', 14)).toBe('light');
  });

  it('picks light text for a dark/desaturated tag mixed into a dark background', () => {
    expect(tagFillTextVariant('#1a1a40', '#1e1e1e', 14)).toBe('light');
  });

  it('picks dark text for a dark/desaturated tag mixed into a light background', () => {
    expect(tagFillTextVariant('#00004d', '#ffffff', 11)).toBe('dark');
  });

  it('picks a sensible variant for a mid-saturation "normal" color (blue) in both themes', () => {
    expect(tagFillTextVariant('#2196f3', '#ffffff', 11)).toBe('dark');
    expect(tagFillTextVariant('#2196f3', '#1e1e1e', 14)).toBe('light');
  });

  it.each([
    ['yellow', '#ffee58'],
    ['navy', '#00004d'],
    ['pale green', '#d8f3dc'],
    ['red', '#d32f2f'],
    ['neutral', '#808080'],
  ])('keeps %s readable against committed fills in both themes', (_name, tagColor) => {
    expect(tagFillTextVariant(tagColor, '#ffffff', 11)).toBe('dark');
    expect(tagFillTextVariant(tagColor, '#1e1e1e', 14)).toBe('light');
  });

  it.each([
    ['yellow', '#ffee58'],
    ['navy', '#00004d'],
    ['pale green', '#d8f3dc'],
    ['red', '#d32f2f'],
  ])('keeps %s at WCAG 4.5:1 against the committed fill in both themes', (_name, tagColor) => {
    const lightBackground = '#ffffff';
    const darkBackground = '#1e1e1e';
    const lightFill = tagColor
      ? rgbToHex(mixHexColors(tagColor, lightBackground, 11)!)
      : lightBackground;
    const darkFill = tagColor
      ? rgbToHex(mixHexColors(tagColor, darkBackground, 14)!)
      : darkBackground;

    expect(contrastRatio(lightFill, '#161616')).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(darkFill, '#f5f5f5')).toBeGreaterThanOrEqual(4.5);
  });

  it('keeps an untagged task readable against the actual interactive-accent mix and text-normal fallback in both themes', () => {
    const interactiveAccent = '#7f6df2';
    const lightFill = rgbToHex(mixHexColors(interactiveAccent, '#ffffff', 11)!);
    const darkFill = rgbToHex(mixHexColors(interactiveAccent, '#1e1e1e', 14)!);

    expect(contrastRatio(lightFill, '#2e3338')).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(darkFill, '#dadada')).toBeGreaterThanOrEqual(4.5);
  });
});

describe('tagFillTextColorVar', () => {
  it('resolves the shared committed fill strength from the rendered element owner document in both themes', () => {
    const frame = document.createElement('iframe');
    document.body.appendChild(frame);
    const ownerDocument = frame.contentDocument!;
    ownerDocument.body.classList.add('theme-dark');
    ownerDocument.body.style.setProperty('--background-primary', '#1e1e1e');
    const event = ownerDocument.createElement('div');
    const ghost = ownerDocument.createElement('div');
    ownerDocument.body.append(event, ghost);

    try {
      expect(tagFillTextColorVar(event, '#ffffff')).toBe('var(--abyss-tag-text-light)');
      expect(tagFillTextColorVar(ghost, '#ffffff')).toBe('var(--abyss-tag-text-light)');

      ownerDocument.body.classList.remove('theme-dark');
      ownerDocument.body.style.setProperty('--background-primary', '#ffffff');
      expect(tagFillTextColorVar(event, '#ffffff')).toBe('var(--abyss-tag-text-dark)');
      expect(tagFillTextColorVar(ghost, '#ffffff')).toBe('var(--abyss-tag-text-dark)');
    } finally {
      frame.remove();
    }
  });
});

describe('calendar focus and selection contrast', () => {
  it('mixes every span/timed focus outline toward text-normal while keeping task color primary', () => {
    const focusRules = [
      declarationsFor('.abyss-span-piece:focus-visible:hover'),
      declarationsFor('.abyss-tg-block:focus-visible'),
      declarationsFor('.abyss-tg-block.is-selected'),
    ];

    expect(cssPercent('--abyss-event-focus-tag-strength')).toBe(55);
    for (const rule of focusRules) {
      expect(rule).toContain(
        'var(--abyss-tag-color, var(--interactive-accent)) var(--abyss-event-focus-tag-strength)',
      );
      expect(rule).toContain('var(--text-normal)');
      expect(rule).not.toContain('var(--background-primary)');
    }
  });

  it.each([
    ['yellow', '#ffee58'],
    ['navy', '#00004d'],
    ['pale green', '#d8f3dc'],
    ['red', '#d32f2f'],
    ['untagged fallback', '#7f6df2'],
  ])(
    'keeps the %s focus outline at 3:1 against its adjacent fill in light and dark themes',
    (_name, taskColor) => {
      const focusTagStrength = cssPercent('--abyss-event-focus-tag-strength');
      expect(focusTagStrength).not.toBeNull();
      if (focusTagStrength === null) return;

      const lightFill = rgbToHex(mixHexColors(taskColor, '#ffffff', 11)!);
      const darkFill = rgbToHex(mixHexColors(taskColor, '#1e1e1e', 14)!);
      const lightFocus = rgbToHex(mixHexColors(taskColor, '#161616', focusTagStrength)!);
      const darkFocus = rgbToHex(mixHexColors(taskColor, '#f5f5f5', focusTagStrength)!);

      expect(contrastRatio(lightFocus, lightFill)).toBeGreaterThanOrEqual(3);
      expect(contrastRatio(darkFocus, darkFill)).toBeGreaterThanOrEqual(3);
    },
  );
});
