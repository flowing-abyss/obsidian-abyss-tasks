import { describe, expect, it } from 'vitest';
import {
  mixHexColors,
  relativeLuminanceOfHex,
  tagFillTextColorVar,
  tagFillTextVariant,
} from '../src/tags/tagFillContrast';

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
    expect(tagFillTextVariant('#ffee58', '#ffffff', 14)).toBe('dark');
  });

  it('picks light text for a bright/light tag mixed into a dark background', () => {
    expect(tagFillTextVariant('#ffee58', '#1e1e1e', 18)).toBe('light');
  });

  it('picks light text for a dark/desaturated tag mixed into a dark background', () => {
    expect(tagFillTextVariant('#1a1a40', '#1e1e1e', 18)).toBe('light');
  });

  it('picks dark text for a dark/desaturated tag mixed into a light background', () => {
    expect(tagFillTextVariant('#00004d', '#ffffff', 14)).toBe('dark');
  });

  it('picks a sensible variant for a mid-saturation "normal" color (blue) in both themes', () => {
    expect(tagFillTextVariant('#2196f3', '#ffffff', 14)).toBe('dark');
    expect(tagFillTextVariant('#2196f3', '#1e1e1e', 18)).toBe('light');
  });

  it.each([
    ['yellow', '#ffee58'],
    ['navy', '#00004d'],
    ['pale green', '#d8f3dc'],
    ['red', '#d32f2f'],
    ['neutral', '#808080'],
  ])(
    'keeps %s readable at restrained event and ghost strengths in both themes',
    (_name, tagColor) => {
      expect(tagFillTextVariant(tagColor, '#ffffff', 14)).toBe('dark');
      expect(tagFillTextVariant(tagColor, '#ffffff', 7)).toBe('dark');
      expect(tagFillTextVariant(tagColor, '#1e1e1e', 18)).toBe('light');
      expect(tagFillTextVariant(tagColor, '#1e1e1e', 10)).toBe('light');
    },
  );
});

describe('tagFillTextColorVar', () => {
  it('resolves event and ghost strength from the rendered element owner document in both themes', () => {
    const frame = document.createElement('iframe');
    document.body.appendChild(frame);
    const ownerDocument = frame.contentDocument!;
    ownerDocument.body.classList.add('theme-dark');
    ownerDocument.body.style.setProperty('--background-primary', '#1e1e1e');
    const event = ownerDocument.createElement('div');
    const ghost = ownerDocument.createElement('div');
    ownerDocument.body.append(event, ghost);

    try {
      expect(tagFillTextColorVar(event, '#ffffff', 'event')).toBe('var(--tc-tag-text-light)');
      expect(tagFillTextColorVar(ghost, '#ffffff', 'ghost')).toBe('var(--tc-tag-text-light)');

      ownerDocument.body.classList.remove('theme-dark');
      ownerDocument.body.style.setProperty('--background-primary', '#ffffff');
      expect(tagFillTextColorVar(event, '#ffffff', 'event')).toBe('var(--tc-tag-text-dark)');
      expect(tagFillTextColorVar(ghost, '#ffffff', 'ghost')).toBe('var(--tc-tag-text-dark)');
    } finally {
      frame.remove();
    }
  });
});
