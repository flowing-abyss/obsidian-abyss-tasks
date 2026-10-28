import { afterEach, describe, expect, it, vi } from 'vitest';
import { textFieldAnchor, textFieldViewport } from '../src/ui/textFieldAnchor';
import { expectDefined } from './helpers';

const restorations: Array<() => void> = [];

function defineRestorable(target: object, key: string, descriptor: PropertyDescriptor): void {
  const original = Object.getOwnPropertyDescriptor(target, key);
  Object.defineProperty(target, key, { configurable: true, ...descriptor });
  restorations.push(() => {
    if (original === undefined) Reflect.deleteProperty(target, key);
    else Object.defineProperty(target, key, original);
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const restore of restorations.splice(0).reverse()) restore();
  document.body.empty();
});

function computedStyle(input: HTMLElement, overrides: Readonly<Record<string, string>> = {}) {
  const values: Readonly<Record<string, string>> = {
    'padding-top': '4px',
    'padding-right': '6px',
    'padding-bottom': '4px',
    'padding-left': '6px',
    'border-top-width': '2px',
    'border-right-width': '2px',
    'border-bottom-width': '2px',
    'border-left-width': '2px',
    'font-family': 'monospace',
    'font-size': '16px',
    'font-weight': '600',
    'font-style': 'italic',
    'line-height': '24px',
    ...overrides,
  };
  const style = input.style;
  vi.spyOn(style, 'getPropertyValue').mockImplementation((property) => values[property] ?? '');
  for (const [property, css] of [
    ['paddingTop', 'padding-top'],
    ['paddingBottom', 'padding-bottom'],
    ['borderLeftWidth', 'border-left-width'],
    ['borderRightWidth', 'border-right-width'],
    ['fontSize', 'font-size'],
    ['lineHeight', 'line-height'],
  ] as const) {
    defineRestorable(style, property, { get: () => values[css] ?? '' });
  }
  return vi
    .spyOn(expectDefined(input.ownerDocument.defaultView), 'getComputedStyle')
    .mockReturnValue(style);
}

function field(tag: 'input'): HTMLInputElement;
function field(tag?: 'textarea'): HTMLTextAreaElement;
function field(tag: 'input' | 'textarea' = 'textarea') {
  const input = document.body.createEl(tag);
  input.value = 'first line\n[[target';
  input.setSelectionRange(input.value.length, input.value.length);
  computedStyle(input);
  vi.spyOn(input, 'getBoundingClientRect').mockReturnValue(new DOMRect(100, 200, 300, 100));
  defineRestorable(input, 'clientWidth', { value: 296 });
  defineRestorable(input, 'clientHeight', { value: 96 });
  return input;
}

/** jsdom supplies real mirror text and Range selection, but has no layout engine. */
function measureRanges(owner: Document, measure: (range: Range, mirror: HTMLElement) => DOMRect) {
  const createRange = owner.createRange.bind(owner);
  return vi.spyOn(owner, 'createRange').mockImplementation(() => {
    const range = createRange();
    defineRestorable(range, 'getBoundingClientRect', {
      value: () => {
        const mirror = expectDefined(owner.querySelector<HTMLElement>('.abyss-text-field-mirror'));
        vi.spyOn(mirror, 'getBoundingClientRect').mockReturnValue(new DOMRect(13, 17, 300, 100));
        return measure(range, mirror);
      },
    });
    return range;
  });
}

function coordinates(rect: DOMRect): number[] {
  return [rect.x, rect.y, rect.width, rect.height];
}

describe('textFieldAnchor', () => {
  it('translates textarea mirror coordinates and subtracts internal scroll', () => {
    const input = field();
    input.scrollLeft = 7;
    input.scrollTop = 11;
    const ranges = measureRanges(document, (range, mirror) => {
      expect(mirror.getAttribute('aria-hidden')).toBe('true');
      expect(mirror.classList.contains('is-single-line')).toBe(false);
      expect(mirror.style.padding).toBe('4px 6px');
      expect(mirror.style.borderLeftWidth).toBe('2px');
      expect(mirror.style.borderRightWidth).toBe('2px');
      expect(mirror.style.borderTopWidth).toBe('2px');
      expect(mirror.style.borderBottomWidth).toBe('2px');
      expect(mirror.style.fontFamily).toBe('monospace');
      expect(mirror.style.fontSize).toBe('16px');
      expect(mirror.style.fontWeight).toBe('600');
      expect(mirror.style.fontStyle).toBe('italic');
      expect(mirror.style.lineHeight).toBe('24px');
      expect(mirror.style.getPropertyValue('--abyss-field-width')).toBe('300px');
      expect(mirror.firstChild?.nodeType).toBe(Node.TEXT_NODE);
      expect(mirror.firstChild?.textContent).toBe('first line\n');
      expect(range.toString()).toBe('[');
      expect([range.startOffset, range.endOffset]).toEqual([0, 1]);
      return new DOMRect(53, 57, 8, 24);
    });

    expect(coordinates(textFieldAnchor(input, 11))).toEqual([133, 229, 1, 24]);
    expect(ranges).toHaveBeenCalledOnce();
    expect(document.querySelector('.abyss-text-field-mirror')).toBeNull();
  });

  it('centers a single input line in its padded content height and subtracts horizontal scroll', () => {
    const input = field('input');
    input.scrollLeft = 9;
    computedStyle(input, { 'line-height': '20px' });
    defineRestorable(input, 'clientHeight', { value: 40 });
    measureRanges(document, (_range, mirror) => {
      expect(mirror.classList.contains('is-single-line')).toBe(true);
      return new DOMRect(53, 57, 8, 20);
    });

    expect(coordinates(textFieldAnchor(input, 0))).toEqual([131, 246, 1, 20]);
  });

  it('measures the selection when the opener is outside the field and clamps the caret', () => {
    const input = field();
    input.value = 'before [[target suffix';
    input.setSelectionRange(12, 12);
    let measurements = 0;
    const ranges = measureRanges(document, (range, mirror) => {
      measurements++;
      expect(mirror.firstChild?.textContent).toBe(measurements === 1 ? 'before ' : 'before [[tar');
      expect(range.startContainer.nodeType).toBe(Node.TEXT_NODE);
      expect([range.startOffset, range.endOffset]).toEqual([0, 1]);
      expect(range.toString()).toBe(measurements === 1 ? '[' : 'g');
      // The opener is above the field. The caret starts inside, with its glyph crossing
      // the right edge and its line crossing the bottom edge.
      return measurements === 1 ? new DOMRect(53, -10, 8, 24) : new DOMRect(312, 107, 8, 24);
    });

    expect(coordinates(textFieldAnchor(input, 7))).toEqual([399, 276, 1, 24]);
    expect(ranges).toHaveBeenCalledTimes(2);
    expect(document.querySelector('.abyss-text-field-mirror')).toBeNull();
  });

  it.each([
    { edges: 'left and top', x: -100, y: -100, want: [100, 200, 1, 24] },
    { edges: 'right and bottom', x: 1000, y: 1000, want: [400, 276, 1, 24] },
  ])('clamps an offscreen caret at the $edges edges', ({ x, y, want }) => {
    const input = field();
    measureRanges(document, () => new DOMRect(x, y, 8, 24));
    expect(coordinates(textFieldAnchor(input, 0))).toEqual(want);
  });

  it.each([
    ['', 0, '', '\u200b'],
    ['hello', 0, '', 'hello'],
    ['hello', 5, 'hello', '\u200b'],
  ] as const)(
    'measures real text nodes for value %j at offset %s',
    (value, opener, prefix, tail) => {
      const input = field();
      input.value = value;
      const ranges = measureRanges(document, (range, mirror) => {
        expect(mirror.firstChild?.nodeType).toBe(Node.TEXT_NODE);
        expect(mirror.firstChild?.textContent).toBe(prefix);
        expect(mirror.lastElementChild?.textContent).toBe(tail);
        expect(range.startContainer).toBe(mirror.lastElementChild?.firstChild);
        expect(range.endContainer).toBe(range.startContainer);
        expect([range.startOffset, range.endOffset]).toEqual([0, 1]);
        expect(range.toString()).toBe(tail.slice(0, 1));
        return new DOMRect(53, 57, 0, 24);
      });

      expect(coordinates(textFieldAnchor(input, opener))).toEqual([140, 240, 1, 24]);
      expect(ranges).toHaveBeenCalledOnce();
    },
  );

  it.each([
    ['normal', '10px', 20],
    ['30px', '10px', 30],
    ['normal', '30px', 36],
  ])(
    'falls back from zero-height ranges using line-height %s and font-size %s',
    (line, font, height) => {
      const input = field();
      computedStyle(input, { 'line-height': line, 'font-size': font });
      measureRanges(document, () => new DOMRect(53, 57, 0, 0));
      expect(coordinates(textFieldAnchor(input, 0))).toEqual([140, 240, 1, height]);
    },
  );

  it('keeps a zero-size field anchor finite and retains the fallback line height', () => {
    const input = field();
    vi.spyOn(input, 'getBoundingClientRect').mockReturnValue(new DOMRect(100, 200, 0, 0));
    computedStyle(input, { 'line-height': 'normal', 'font-size': '10px' });
    measureRanges(document, () => new DOMRect(53, 57, 0, 0));
    expect(coordinates(textFieldAnchor(input, 0))).toEqual([100, 200, 1, 20]);
  });

  it('normalizes non-finite parsed style measurements before computing input coordinates', () => {
    const input = field('input');
    defineRestorable(input, 'clientHeight', { value: 40 });
    computedStyle(input, {
      'line-height': 'Infinity',
      'font-size': 'NaN',
      'padding-top': 'Infinity',
      'padding-bottom': '-Infinity',
      'border-left-width': 'NaN',
      'border-right-width': 'Infinity',
    });
    measureRanges(document, (_range, mirror) => {
      expect(mirror.style.getPropertyValue('--abyss-field-width')).toBe('296px');
      return new DOMRect(53, 57, 0, 0);
    });
    expect(coordinates(textFieldAnchor(input, 0))).toEqual([140, 250, 1, 20]);
  });

  it('falls back to the value end when selectionStart is null', () => {
    const input = field('input');
    input.type = 'number';
    input.value = '123';
    expect(input.selectionStart).toBeNull();
    let measurements = 0;
    measureRanges(document, (range, mirror) => {
      measurements++;
      expect(mirror.firstChild?.textContent).toBe(measurements === 1 ? '' : '123');
      expect(range.toString()).toBe(measurements === 1 ? '1' : '\u200b');
      return measurements === 1 ? new DOMRect(-100, -100, 1, 24) : new DOMRect(53, 57, 1, 24);
    });
    expect(coordinates(textFieldAnchor(input, 0))).toEqual([140, 272, 1, 24]);
    expect(measurements).toBe(2);
  });

  it('inserts vault text literally without interpreting markup', () => {
    const input = field();
    input.value = '<img src=x onerror=alert(1)>[[x';
    measureRanges(document, (_range, mirror) => {
      expect(mirror.querySelector('img')).toBeNull();
      expect(mirror.textContent).toBe('<img src=x onerror=alert(1)>[[x');
      return new DOMRect(53, 57, 8, 24);
    });
    expect(coordinates(textFieldAnchor(input, 26))).toEqual([140, 240, 1, 24]);
  });

  it('removes the mirror and propagates measurement failures', () => {
    const input = field();
    const failure = new Error('measurement failed');
    measureRanges(document, () => {
      throw failure;
    });
    expect(() => textFieldAnchor(input, 0)).toThrow(failure);
    expect(document.querySelector('.abyss-text-field-mirror')).toBeNull();
  });

  it('uses the adopted input document for mirrors, ranges and computed style', () => {
    const input = field();
    const frame = document.body.createEl('iframe');
    const owner = expectDefined(frame.contentDocument);
    const win = expectDefined(owner.defaultView);
    // obsidian-test-mocks installs host helpers only in the main realm. Retain those
    // real helpers on an adopted body while B still owns the mirror, Range and style.
    owner.documentElement.replaceChild(owner.adoptNode(createEl('body')), owner.body);
    owner.body.append(owner.adoptNode(input));
    const globalRanges = vi.spyOn(document, 'createRange');
    const globalStyle = vi.spyOn(window, 'getComputedStyle');
    const ownerStyle = computedStyle(input, { 'font-family': 'serif' });
    const ranges = measureRanges(owner, (range, mirror) => {
      expect(mirror.ownerDocument).toBe(owner);
      expect(range.startContainer.ownerDocument).toBe(owner);
      expect(range).toBeInstanceOf(win.Range);
      expect(range.toString()).toBe('f');
      expect(mirror.style.fontFamily).toBe('serif');
      expect(document.querySelector('.abyss-text-field-mirror')).toBeNull();
      expect(owner.body.contains(mirror)).toBe(true);
      return new DOMRect(53, 57, 8, 24);
    });

    const anchor = textFieldAnchor(input, 0);
    expect(coordinates(anchor)).toEqual([140, 240, 1, 24]);
    expect(anchor).toBeInstanceOf(win.DOMRect);
    expect(ranges).toHaveBeenCalledOnce();
    expect(ownerStyle).toHaveBeenCalledExactlyOnceWith(input);
    expect(globalRanges).not.toHaveBeenCalled();
    expect(globalStyle).not.toHaveBeenCalled();
    expect(owner.querySelector('.abyss-text-field-mirror')).toBeNull();
  });

  it('returns the field rectangle when its document has no defaultView', () => {
    const input = field();
    const owner = document.implementation.createHTMLDocument('detached owner');
    owner.body.append(owner.adoptNode(input));
    const rect = input.getBoundingClientRect();
    const ranges = vi.spyOn(owner, 'createRange');
    expect(owner.defaultView).toBeNull();
    expect(textFieldAnchor(input, 0)).toBe(rect);
    expect(ranges).not.toHaveBeenCalled();
    expect(owner.querySelector('.abyss-text-field-mirror')).toBeNull();
  });
});

describe('textFieldViewport', () => {
  it('intersects the visual viewport with every owned scroll container', () => {
    const input = field('input');
    const clip = document.body.createDiv();
    const outer = document.body.createDiv();
    defineRestorable(window, 'visualViewport', {
      value: { offsetLeft: 10, offsetTop: 20, width: 300, height: 200 },
    });
    vi.spyOn(clip, 'getBoundingClientRect').mockReturnValue(new DOMRect(50, 60, 100, 80));
    vi.spyOn(outer, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 500, 500));
    expect(coordinates(textFieldViewport(input, [outer, clip]))).toEqual([50, 60, 100, 80]);
  });

  it('keeps the visual viewport offsets and intersects partially overlapping containers', () => {
    const input = field('input');
    const clip = document.body.createDiv();
    defineRestorable(window, 'visualViewport', {
      value: { offsetLeft: 10, offsetTop: 20, width: 300, height: 200 },
    });
    vi.spyOn(clip, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 100, 80));
    expect(coordinates(textFieldViewport(input))).toEqual([10, 20, 300, 200]);
    expect(coordinates(textFieldViewport(input, [clip]))).toEqual([10, 20, 90, 60]);
  });

  it('returns nonnegative zero dimensions for disjoint clips', () => {
    const input = field('input');
    const first = document.body.createDiv();
    const second = document.body.createDiv();
    defineRestorable(window, 'visualViewport', {
      value: { offsetLeft: 10, offsetTop: 20, width: 300, height: 200 },
    });
    vi.spyOn(first, 'getBoundingClientRect').mockReturnValue(new DOMRect(50, 60, 100, 80));
    vi.spyOn(second, 'getBoundingClientRect').mockReturnValue(new DOMRect(200, 180, 40, 30));
    expect(coordinates(textFieldViewport(input, [first, second]))).toEqual([200, 180, 0, 0]);
  });

  it('uses the owning window dimensions after adoption when VisualViewport is absent', () => {
    const input = field('input');
    const frame = document.body.createEl('iframe');
    const owner = expectDefined(frame.contentDocument);
    const win = expectDefined(owner.defaultView);
    owner.body.append(owner.adoptNode(input));
    defineRestorable(win, 'visualViewport', { value: undefined });
    defineRestorable(win, 'innerWidth', { value: 360 });
    defineRestorable(win, 'innerHeight', { value: 640 });
    const globalViewport = vi.fn(() => {
      throw new Error('global viewport read');
    });
    defineRestorable(window, 'visualViewport', { get: globalViewport });
    defineRestorable(window, 'innerWidth', { get: globalViewport });
    defineRestorable(window, 'innerHeight', { get: globalViewport });

    expect(coordinates(textFieldViewport(input))).toEqual([0, 0, 360, 640]);
    expect(globalViewport).not.toHaveBeenCalled();
  });

  it('uses the adopted owning window VisualViewport', () => {
    const input = field('input');
    const frame = document.body.createEl('iframe');
    const owner = expectDefined(frame.contentDocument);
    const win = expectDefined(owner.defaultView);
    owner.body.append(owner.adoptNode(input));
    defineRestorable(win, 'visualViewport', {
      value: { offsetLeft: 5, offsetTop: 30, width: 320, height: 400 },
    });
    defineRestorable(window, 'visualViewport', {
      value: { offsetLeft: 100, offsetTop: 200, width: 1000, height: 800 },
    });
    expect(coordinates(textFieldViewport(input))).toEqual([5, 30, 320, 400]);
  });

  it('returns the input rectangle without a window even when clips are supplied', () => {
    const input = field('input');
    const owner = document.implementation.createHTMLDocument('detached owner');
    owner.body.append(owner.adoptNode(input));
    const clip = document.body.createDiv();
    const measure = vi.spyOn(clip, 'getBoundingClientRect');
    const rect = input.getBoundingClientRect();
    expect(textFieldViewport(input, [clip])).toBe(rect);
    expect(measure).not.toHaveBeenCalled();
  });
});
