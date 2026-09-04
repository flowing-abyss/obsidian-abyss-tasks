/**
 * Task 40 (Round 4): the tag-fill background (styles.css's shared `.abyss-tg-block`/`.abyss-tg-body`/
 * `.abyss-mg-*` rule — an opaque, theme-dependent mix against `var(--background-primary)`)
 * lets a user pick ANY hex color for a tag group. A single fixed `var(--text-normal)` title/
 * subtitle color (the pre-existing behavior) reads fine against a mid-saturation color like blue
 * or red, but loses contrast against a bright/pale tag color in light mode, or a very dark/
 * desaturated one in dark mode — exactly the complaint that survived Round 3 Task 24 (which only
 * fixed the fill's opacity, not this).
 *
 * This module replicates that CSS `color-mix` in JS (the same sRGB channel-wise mix, gamma-encoded
 * — that's what `color-mix(in srgb, ...)` does, with no linear-light conversion), computes the
 * resulting fill's WCAG relative luminance, and picks whichever of a light-text/dark-text variant
 * gives the higher contrast ratio against it.
 *
 * Deliberately pure/DOM-free so it's unit-testable without a real browser's `color-mix` support
 * (jsdom, used by this project's tests, doesn't implement `color-mix()`), and reusable from every
 * render site that sets `--abyss-tag-color` (renderTimedBlocks.ts, renderAllDay.ts, MonthGridView.ts).
 */

/** Parses a `#rgb` or `#rrggbb` hex color into 0-255 RGB channels, or null if unparseable. */
function parseHexColor(hex: string): [number, number, number] | null {
  const trimmed = hex.trim();
  const six = /^#?([0-9a-f]{6})$/i.exec(trimmed);
  if (six != null) {
    const digits = six[1];
    if (digits === undefined) return null;
    const n = parseInt(digits, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  const three = /^#?([0-9a-f]{3})$/i.exec(trimmed);
  if (three != null) {
    const digits = three[1];
    if (digits === undefined) return null;
    const channels = digits.split('').map((c) => parseInt(c + c, 16));
    const r = channels[0];
    const g = channels[1];
    const b = channels[2];
    return r === undefined || g === undefined || b === undefined ? null : [r, g, b];
  }
  return null;
}

function srgbChannelToLinear(channel: number): number {
  const cs = channel / 255;
  return cs <= 0.04045 ? cs / 12.92 : Math.pow((cs + 0.055) / 1.055, 2.4);
}

/** WCAG relative luminance (0 = black, 1 = white) of an already-parsed 0-255 RGB triple. */
function relativeLuminance(rgb: [number, number, number]): number {
  const [r, g, b] = rgb;
  return (
    0.2126 * srgbChannelToLinear(r) +
    0.7152 * srgbChannelToLinear(g) +
    0.0722 * srgbChannelToLinear(b)
  );
}

/** WCAG relative luminance of a hex color string, or null if the string doesn't parse. */
export function relativeLuminanceOfHex(hex: string): number | null {
  const rgb = parseHexColor(hex);
  return rgb != null ? relativeLuminance(rgb) : null;
}

/** WCAG contrast ratio between two relative luminances (order-independent). */
function contrastRatio(l1: number, l2: number): number {
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * Replicates `color-mix(in srgb, fgHex fgPercent%, bgHex)`: a plain per-channel linear
 * interpolation of the two colors' gamma-encoded (sRGB) 0-255 values — exactly what the CSS
 * `color-mix` function does in the `srgb` color space (no linear-light conversion). Returns null
 * if either color fails to parse.
 */
export function mixHexColors(
  fgHex: string,
  bgHex: string,
  fgPercent: number,
): [number, number, number] | null {
  const fg = parseHexColor(fgHex);
  const bg = parseHexColor(bgHex);
  if (fg == null || bg == null) return null;
  const t = fgPercent / 100;
  return [
    Math.round(fg[0] * t + bg[0] * (1 - t)),
    Math.round(fg[1] * t + bg[1] * (1 - t)),
    Math.round(fg[2] * t + bg[2] * (1 - t)),
  ];
}

export type TagFillTextVariant = 'light' | 'dark';

/**
 * Decides whether a tag-filled block's title/subtitle should use the light-text or dark-text
 * variant, given the tag's own color and the panel's actual `--background-primary` (the two
 * inputs the shared CSS fill rule itself mixes). Returns `undefined` when there's no tag color to
 * begin with, or when either color fails to parse — callers should leave the pre-existing
 * `var(--text-normal)` CSS fallback in place in that case, rather than force a variant.
 */
export function tagFillTextVariant(
  tagHex: string | undefined,
  backgroundHex: string,
  tagPercent = 14,
): TagFillTextVariant | undefined {
  if (tagHex === undefined || tagHex.length === 0) return undefined;
  const mixed = mixHexColors(tagHex, backgroundHex, tagPercent);
  if (mixed == null) return undefined;
  const bgLuminance = relativeLuminance(mixed);
  const contrastWithLightText = contrastRatio(bgLuminance, 1);
  const contrastWithDarkText = contrastRatio(bgLuminance, 0);
  return contrastWithLightText >= contrastWithDarkText ? 'light' : 'dark';
}

/**
 * The actual resolved `--background-primary` the shared tag-fill CSS rule mixes against, read
 * from `referenceEl`'s own document/window (not a bare global `document`/`window`) so this stays
 * correct inside an Obsidian popout window, which has its own document with its own computed
 * styles. Obsidian's core themes set this custom property to a literal hex value (not another
 * `color-mix`/nested `var()`), so reading it via `getComputedStyle` is reliable in both the light
 * and dark core themes; an unparseable/empty result (e.g. a test environment with no stylesheet
 * loaded) safely falls through `tagFillTextVariant`'s own `null`-mix handling to `undefined`.
 */
function currentBackgroundPrimaryHex(referenceEl: HTMLElement): string {
  const doc = referenceEl.ownerDocument;
  const win = doc.defaultView;
  if (win == null) return '';
  return win.getComputedStyle(doc.body).getPropertyValue('--background-primary').trim();
}

function currentTagFillPercent(referenceEl: HTMLElement): number {
  const doc = referenceEl.ownerDocument;
  const dark =
    doc.body.classList.contains('theme-dark') ||
    doc.documentElement.classList.contains('theme-dark');
  return dark ? 14 : 11;
}

/**
 * Convenience wrapper combining `currentBackgroundPrimaryHex` + `tagFillTextVariant`: given the
 * element the tag-colored fill was just applied to and the tag's own hex color, returns the CSS
 * custom property value (already wrapped in `var(--abyss-tag-text-<variant>)`) a render site should
 * set as `--abyss-tag-text-color` on that same element — or `undefined` when there's nothing to
 * override, in which case the caller should simply not set the property at all and let the CSS
 * rule's own `var(--text-normal)` fallback apply, unchanged from before this module existed.
 */
export function tagFillTextColorVar(
  el: HTMLElement,
  tagHex: string | undefined,
): string | undefined {
  const variant = tagFillTextVariant(
    tagHex,
    currentBackgroundPrimaryHex(el),
    currentTagFillPercent(el),
  );
  return variant === undefined ? undefined : `var(--abyss-tag-text-${variant})`;
}
