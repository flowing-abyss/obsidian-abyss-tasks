import { describe, expect, it, vi } from 'vitest';
import { fallbackSearchWords, prepareSearchQuery } from '../src/tasks/domain/searchMatchPolicy';
import { compactTaskDescriptionExcerpt } from '../src/ui/taskDescriptionExcerpt';
import { expectDefined } from './helpers';

function excerpt(holder: HTMLElement, query: string, anchors?: readonly HTMLAnchorElement[]): void {
  compactTaskDescriptionExcerpt(
    holder,
    prepareSearchQuery(query, fallbackSearchWords),
    fallbackSearchWords,
    anchors,
  );
}
function sourceText(holder: HTMLElement): string {
  return holder.textContent.replace(/ ?… ?/gu, '').trim();
}

describe('compact matching description windows', () => {
  it.each([
    {
      behavior: 'omits unrelated logical lines between nearby matches',
      source: 'needle first\nunrelated paragraph\nneedle second\nother paragraph',
      want: 'needle first … needle second …',
    },
    {
      behavior: 'keeps adjacent logical lines distinct after removing their line break',
      source: 'needle first\nneedle second',
      want: 'needle first … needle second',
    },
    {
      behavior: 'merges nearby same-line context without repeating text or adding a gap',
      source: 'opening needle first, needle second, needle third ending',
      want: 'opening needle first, needle second, needle third ending',
    },
  ])('$behavior', ({ source, want }) => {
    const holder = createDiv();
    holder.appendText(source);
    excerpt(holder, 'needle');
    expect(holder.textContent).toBe(want);
  });

  it('retains three distant hits in one text run and omits a fourth distant hit', () => {
    const holder = createDiv();
    holder
      .createEl('em')
      .appendText(
        `needle first ${'filler '.repeat(80)}needle second ${'filler '.repeat(80)}needle third ${'filler '.repeat(80)}needle fourth`,
      );
    excerpt(holder, 'needle');
    expect(holder.querySelectorAll('em')).toHaveLength(1);
    expect(holder.textContent).toContain('needle first');
    expect(holder.textContent).toContain('needle second');
    expect(holder.textContent).toContain('needle third');
    expect(holder.textContent).not.toContain('needle fourth');
    expect(sourceText(holder).length).toBeLessThanOrEqual(240);
    expect(holder.textContent.match(/…/gu)).toHaveLength(3);
  });

  it('keeps short distinct hits after an oversized matched token within the shared budget', () => {
    const holder = createDiv();
    holder.appendText(`needle${'x'.repeat(600)}\nneedle short\nneedle final`);
    excerpt(holder, 'needle');
    expect(holder.textContent).toContain('needle short');
    expect(holder.textContent).toContain('needle final');
    expect(sourceText(holder).length).toBeLessThanOrEqual(240);
  });

  it('cuts context and long hits at safe Unicode boundaries', () => {
    const holder = createDiv();
    holder.appendText(
      `${'a'.repeat(20)}😀é${'z'.repeat(21)} needle${'é'.repeat(200)}\nneedle second`,
    );
    excerpt(holder, 'needle');
    expect(holder.textContent).toContain('needle second');
    expect(sourceText(holder).length).toBeLessThanOrEqual(240);
    for (const point of holder.textContent) expect(point).not.toMatch(/^[\uD800-\uDFFF]$/u);
    for (const part of holder.textContent.split('…')) expect(part.trim()).not.toMatch(/^\p{M}/u);
  });

  it('bounds the opening window with no trustworthy candidates and removes discarded subtrees', () => {
    const holder = createDiv();
    holder.createEl('button', { text: 'Ignored opening' });
    holder.createEl('p').appendText('opening '.repeat(100));
    holder.createEl('p').createEl('a', { href: 'https://example.com', text: 'Discarded alias' });
    holder.createEl('button', { text: 'Ignored' });
    excerpt(holder, 'missing');
    expect(holder.textContent).toMatch(/^opening /u);
    expect(sourceText(holder).length).toBeLessThanOrEqual(240);
    expect(holder.querySelector('a, button')).toBeNull();
  });

  it('combines visible hits with every proven destination anchor without cloning listeners', () => {
    const holder = createDiv();
    const first = holder
      .createEl('p')
      .createEl('a', { text: 'First alias', href: 'https://first.test' });
    holder.createEl('p').appendText('unrelated '.repeat(80));
    holder.createEl('p').createEl('strong').appendText('needle visible');
    const last = holder
      .createEl('p')
      .createEl('a', { text: 'Last alias', href: 'https://last.test' });
    const click = vi.fn((event: Event) => {
      event.preventDefault();
    });
    first.addEventListener('click', click);
    excerpt(holder, 'needle', [first, last]);
    expect(holder.textContent).toContain('First alias');
    expect(holder.textContent).toContain('needle visible');
    expect(holder.textContent).toContain('Last alias');
    expect([...holder.querySelectorAll('a')]).toEqual([first, last]);
    first.dispatchEvent(new MouseEvent('click', { cancelable: true }));
    expect(click).toHaveBeenCalledOnce();
    expect(holder.querySelector('a')?.textContent).not.toContain('…');
  });

  it('keeps one contiguous fragment of an oversized alias and leaves room for later external hits', () => {
    const holder = createDiv();
    const anchor = holder.createEl('a', { href: 'https://example.com' });
    anchor.createEl('mark').appendText(`needle first ${'filler '.repeat(80)}needle second`);
    holder.createEl('p').appendText('needle outside');
    excerpt(holder, 'needle');
    expect(holder.querySelector('a')).toBe(anchor);
    expect(anchor.textContent).toContain('needle first');
    expect(anchor.textContent).not.toContain('needle second');
    expect(holder.textContent).toContain('needle outside');
    expect(holder.querySelector('mark')?.textContent).not.toContain('…');
    expect(anchor.textContent).not.toContain('…');
    expect(anchor.nextSibling?.textContent).toBe(' … ');
    expect(sourceText(holder).length).toBeLessThanOrEqual(240);
  });

  it('keeps intervening alias text when both hits fit the aggregate allocation', () => {
    const holder = createDiv();
    const anchor = holder.createEl('a', { href: 'https://example.com' });
    anchor.appendText(`needle first ${'filler '.repeat(16)}needle second`);
    holder.createEl('p').appendText('needle outside');
    excerpt(holder, 'needle');
    expect(anchor.textContent).toBe(`needle first ${'filler '.repeat(16)}needle second`);
    expect(holder.textContent).toContain('needle outside');
    expect(sourceText(holder).length).toBeLessThanOrEqual(240);
  });

  it('preserves original reversed, explicit and nested ordered-list ordinals', () => {
    const holder = createDiv();
    const list = holder.createEl('ol', { attr: { reversed: '' } });
    list.createEl('li').appendText('discard one');
    const middle = list.createEl('li', { attr: { value: '9' } });
    middle.appendText('needle outer');
    const nested = middle.createEl('ol', { attr: { start: '4' } });
    nested.createEl('li').appendText('discard nested');
    nested.createEl('li').appendText('needle inner');
    list.createEl('li').appendText('discard two');
    const last = list.createEl('li');
    last.appendText('needle last');
    excerpt(holder, 'needle');
    expect([...holder.querySelectorAll('li')].map((li) => li.getAttribute('value'))).toEqual([
      '9',
      '5',
      '7',
    ]);
    expect(holder.textContent).not.toContain('discard');
    expect(expectDefined(holder.querySelector('ol ol')).hasAttribute('start')).toBe(true);
  });
});

it.each(['plain', 'nested'] as const)(
  'places each shared %s highlight omission at its real gap outside all marks',
  (shape) => {
    const holder = createDiv();
    const mark = holder.createEl('mark');
    const body = shape === 'nested' ? mark.createEl('em').createEl('mark') : mark;
    body.appendText(
      `needle first ${'filler '.repeat(80)}needle second ${'filler '.repeat(80)}needle third`,
    );
    excerpt(holder, 'needle');
    expect(holder.textContent).toContain('needle first');
    expect(holder.textContent).toContain('needle second');
    expect(holder.textContent).toContain('needle third');
    const outer = [...holder.children];
    expect(outer).toHaveLength(3);
    expect(outer[0]).toBe(mark);
    expect(outer.map((element) => element.textContent.match(/needle/gu)?.length)).toEqual([
      1, 1, 1,
    ]);
    expect(outer[0]?.nextSibling?.textContent).toBe(' … ');
    expect(outer[1]?.nextSibling?.textContent).toBe(' … ');
    for (const retained of holder.querySelectorAll('mark'))
      expect(retained.textContent).not.toContain('…');
    expect(sourceText(holder).length).toBeLessThanOrEqual(240);
  },
);

it('splits a shared highlight around original wired anchors without cloning them', () => {
  const holder = createDiv();
  const mark = holder.createEl('mark');
  const first = mark.createEl('a', { href: 'https://first.test' });
  first.appendText('needle first');
  mark.appendText(`${' filler'.repeat(80)} `);
  const second = mark.createEl('a', { href: 'https://second.test' });
  second.appendText('needle second');
  const clicked = vi.fn((event: Event) => {
    event.preventDefault();
  });
  second.addEventListener('click', clicked);
  excerpt(holder, 'needle');
  expect([...holder.querySelectorAll('a')]).toEqual([first, second]);
  expect(holder.children).toHaveLength(2);
  expect(holder.firstElementChild?.nextSibling?.textContent).toBe(' … ');
  second.dispatchEvent(new MouseEvent('click', { cancelable: true }));
  expect(clicked).toHaveBeenCalledOnce();
});
