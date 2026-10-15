import { expect, it, vi } from 'vitest';
import { projectSearchText } from '../src/markdown/searchText';
import { prepareSearchQuery } from '../src/tasks';
import { fallbackSearchWords } from '../src/tasks/domain/searchMatchPolicy';
import { markSearchText, renderedAnchorSources } from '../src/ui/markSearchText';
import { compactTaskDescriptionExcerpt } from '../src/ui/taskDescriptionExcerpt';

it('marks normalized and surrogate words without replacing owner-document anchors or their listeners', () => {
  const doc = document.implementation.createHTMLDocument();
  const host = doc.adoptNode(createDiv());
  const anchor = host.createEl('a');
  anchor.textContent = 'Cafe\u0301 𐐀𐐁';
  host.append(anchor);
  const click = vi.fn();
  anchor.addEventListener('click', click);
  markSearchText(
    host,
    projectSearchText('Cafe\u0301 𐐀𐐁', 'title'),
    prepareSearchQuery('Café 𐐀𐐁', fallbackSearchWords),
    fallbackSearchWords,
  );
  expect(host.querySelector('a')).toBe(anchor);
  expect([...host.querySelectorAll('mark')].map((m) => m.textContent)).toEqual([
    'Cafe\u0301',
    '𐐀𐐁',
  ]);
  expect(host.querySelector('mark')?.ownerDocument).toBe(doc);
  anchor.click();
  expect(click).toHaveBeenCalledOnce();
  markSearchText(
    host,
    projectSearchText('Cafe\u0301 𐐀𐐁', 'title'),
    prepareSearchQuery('<img onerror=x>', fallbackSearchWords),
    fallbackSearchWords,
  );
  expect(host.querySelector('img')).toBeNull();
  expect(host.querySelector('mark')).toBeNull();
  expect(host.querySelector('a')).toBe(anchor);
});

it('marks fuzzy whole tokens across bold, inline code and escaped punctuation', () => {
  const host = createFragment().createDiv();
  host.createEl('strong').appendText('bud');
  host.appendText('jet *');
  host.createEl('code').appendText('budget');
  host.appendText('*');
  markSearchText(
    host,
    projectSearchText('**bud**jet \\*`budget`\\*', 'prose'),
    prepareSearchQuery('budget', fallbackSearchWords),
    fallbackSearchWords,
  );
  expect([...host.querySelectorAll('mark')].map((m) => m.textContent)).toEqual([
    'bud',
    'jet',
    'budget',
  ]);
  expect(host.querySelector('code mark')?.textContent).toBe('budget');
  expect(host.textContent).toBe('budjet *budget*');
});

it('omits uncertain marks when the host changed an alias, hid a control, or added visible text', () => {
  for (const rendered of ['different needle', 'needle extra', 'needle']) {
    const host = createFragment().createDiv();
    host.textContent = rendered;
    host.createEl('button').appendText('needle');
    host.createEl('script').appendText('needle');
    markSearchText(
      host,
      projectSearchText('[[Target|needle]] trailing', 'title'),
      prepareSearchQuery('needle', fallbackSearchWords),
      fallbackSearchWords,
    );
    expect(host.querySelector('mark')).toBeNull();
  }
});

it('does not mark hidden targets as visible aliases and does not nest duplicate-token marks', () => {
  const host = createFragment().createDiv();
  host.createEl('a').appendText('Visible alias');
  const projection = projectSearchText('[[HiddenLedger|Visible alias]]', 'title');
  markSearchText(
    host,
    projection,
    prepareSearchQuery('HiddenLedger', fallbackSearchWords),
    fallbackSearchWords,
  );
  expect(host.querySelector('mark')).toBeNull();
  const query = prepareSearchQuery('alias alia', fallbackSearchWords);
  markSearchText(host, projection, query, fallbackSearchWords);
  markSearchText(host, projection, query, fallbackSearchWords);
  expect(host.querySelectorAll('mark')).toHaveLength(1);
  expect(host.querySelector('mark')?.textContent).toBe('alias');
});

it('does not insert HTML marks into host-rendered SVG controls', () => {
  const host = createFragment().createDiv();
  const graphic = host.createSvg('svg');
  graphic.createSvg('text').appendText('needle');
  markSearchText(
    host,
    projectSearchText('<svg><text>needle</text></svg>', 'prose'),
    prepareSearchQuery('needle', fallbackSearchWords),
    fallbackSearchWords,
  );
  expect(host.querySelector('mark')).toBeNull();
  expect(graphic.querySelector('text')?.textContent).toBe('needle');
});

it.each([128, 512])(
  'marks all %i fragmented repeated Unicode words without replacing anchors',
  (count) => {
    const host = createFragment().createDiv();
    const anchors: HTMLAnchorElement[] = [];
    for (let i = 0; i < count; i++) {
      host.createEl('strong').appendText('Cafe');
      host.appendText('\u0301 ');
      anchors.push(host.createEl('a', { text: '𐐀𐐁' }));
      host.appendText(' ');
    }
    const clicks = vi.fn();
    anchors[0]?.addEventListener('click', clicks);
    markSearchText(
      host,
      projectSearchText('**Cafe**\u0301 [𐐀𐐁](target) '.repeat(count), 'prose'),
      prepareSearchQuery('Café 𐐀𐐁', fallbackSearchWords),
      fallbackSearchWords,
    );
    expect(host.textContent).toBe('Cafe\u0301 𐐀𐐁 '.repeat(count));
    expect([...host.querySelectorAll('mark')].map((mark) => mark.textContent)).toEqual(
      Array.from({ length: count }, () => ['Cafe', '\u0301', '𐐀𐐁']).flat(),
    );
    expect([...host.querySelectorAll('a')]).toEqual(anchors);
    anchors[0]?.click();
    expect(clicks).toHaveBeenCalledOnce();
  },
);

it.each([128, 512])(
  'proves %i fragmented anchor spans with bounded provenance lookups',
  (count) => {
    const host = createFragment().createDiv();
    const anchors: HTMLAnchorElement[] = [];
    for (let index = 0; index < count; index++) {
      const anchor = host.createEl('a');
      anchor.createEl('strong').appendText('Cafe');
      anchor.appendText('\u0301');
      anchors.push(anchor);
      host.appendText(' ');
    }
    const projection = projectSearchText('[**Cafe**\u0301](target) '.repeat(count), 'prose');
    let visits = 0;
    const map = new Proxy(projection.visible.map, {
      get(target, key, receiver) {
        if (typeof key === 'string' && /^\d+$/u.test(key)) visits++;
        return Reflect.get(target, key, receiver) as unknown;
      },
    });
    const sources = renderedAnchorSources(host, {
      ...projection,
      visible: { ...projection.visible, map },
    });
    for (const [index, anchor] of anchors.entries()) {
      expect(sources.get(anchor)).toEqual([
        { from: index * 20 + 3, to: index * 20 + 7 },
        { from: index * 20 + 9, to: index * 20 + 10 },
      ]);
    }
    expect(visits).toBeLessThan(count * (Math.ceil(Math.log2(map.length)) + 5));
  },
);

it('excerpts a late formatted match while retaining the original anchor and listener', () => {
  const host = createDiv();
  host.createEl('p', { text: 'unrelated opening paragraph '.repeat(40) });
  const line = host.createEl('p');
  line.appendText('context ');
  const anchor = line.createEl('a');
  anchor.createEl('strong').appendText('late');
  anchor.appendText(' match');
  line.appendText(' trailing '.repeat(40));
  const openedOriginalOccurrence = vi.fn();
  anchor.addEventListener('click', openedOriginalOccurrence);
  compactTaskDescriptionExcerpt(
    host,
    prepareSearchQuery('late', fallbackSearchWords),
    fallbackSearchWords,
  );
  expect(host.querySelector('a')).toBe(anchor);
  expect(host.textContent).toContain('late match');
  expect(host.textContent).not.toContain('unrelated opening paragraph');
  expect(host.textContent.length).toBeLessThanOrEqual(246);
  expect(host.querySelectorAll('p')).toHaveLength(1);
  expect(anchor.textContent).toBe('late match');
  expect(host.querySelector('strong')?.textContent).toBe('late');
  anchor.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  expect(openedOriginalOccurrence).toHaveBeenCalledOnce();
});

it('retains ordered-list ordinals and nested semantics without inventing source marks', () => {
  const host = createDiv();
  const list = host.createEl('ol', { attr: { start: '7' } });
  list.createEl('li').appendText('discard this');
  list.createEl('li', { attr: { value: '12' } }).appendText('discard too');
  const item = list.createEl('li');
  const nested = item.createEl('ul').createEl('li');
  nested.createEl('code').appendText('needle');
  list.createEl('li', { text: 'remaining details '.repeat(80) });
  const query = prepareSearchQuery('needle', fallbackSearchWords);
  markSearchText(
    host,
    projectSearchText('7. discard this\n12. discard too\n13. - `needle`', 'prose'),
    query,
    fallbackSearchWords,
  );
  compactTaskDescriptionExcerpt(host, query, fallbackSearchWords);
  expect(host.querySelector('ol')).toBe(list);
  expect(host.querySelector('ol > li')).toBe(item);
  expect(item.getAttribute('value')).toBe('13');
  expect(host.querySelector('ol > li > ul > li > code')?.textContent).toBe('needle');
  expect(host.textContent).not.toContain('discard');
  expect(host.querySelector('mark')).toBeNull();
  expect(host.textContent.length).toBeLessThanOrEqual(246);
});

it.each(['😀', 'e\u0301'])('does not split %s at either excerpt boundary', (cluster) => {
  const host = createDiv();
  host.appendText(`${cluster.repeat(100)} needle ${cluster.repeat(200)}`);
  compactTaskDescriptionExcerpt(
    host,
    prepareSearchQuery('needle', fallbackSearchWords),
    fallbackSearchWords,
  );
  expect(host.textContent).toContain('needle');
  const text = host.textContent.replace(/^… /u, '').replace(/ …$/u, '');
  expect(text).not.toMatch(/^[\uDC00-\uDFFF\p{M}]/u);
  expect(text).not.toMatch(/[\uD800-\uDBFF]$/u);
  expect(text).not.toMatch(/e$/u);
  expect(host.textContent.length).toBeLessThanOrEqual(246);
});

it('bounds empty or transformed content and accepts a proved destination-only anchor', () => {
  const query = prepareSearchQuery('destination', fallbackSearchWords);
  const empty = createDiv();
  compactTaskDescriptionExcerpt(empty, query, fallbackSearchWords);
  expect(empty.textContent).toBe('');
  const host = createDiv();
  host.createEl('p', { text: 'unrelated opening paragraph '.repeat(40) });
  const anchor = host.createEl('p').createEl('a', { text: 'Visible alias' });
  compactTaskDescriptionExcerpt(host, query, fallbackSearchWords, [anchor]);
  expect(host.querySelector('a')).toBe(anchor);
  expect(host.textContent).toBe('… Visible alias');
  expect(host.querySelector('mark')).toBeNull();
  const transformed = createDiv();
  transformed.appendText('host changed text '.repeat(300));
  compactTaskDescriptionExcerpt(transformed, query, fallbackSearchWords);
  expect(transformed.textContent.length).toBeLessThanOrEqual(246);
  expect(transformed.querySelector('mark')).toBeNull();
});

it('bounds an exceptionally long single match and prunes a large fragmented field', () => {
  const host = createDiv();
  for (let i = 0; i < 1000; i++) host.createEl('p').createEl('em').appendText('unrelated');
  const needle = 'a'.repeat(300);
  const anchor = host.createEl('a', { text: needle });
  compactTaskDescriptionExcerpt(
    host,
    prepareSearchQuery(needle, fallbackSearchWords),
    fallbackSearchWords,
  );
  expect(host.querySelector('a')).toBe(anchor);
  expect(anchor.textContent).toBe('a'.repeat(240));
  expect(host.querySelectorAll('p, em')).toHaveLength(0);
  expect(host.textContent).toBe(`… ${'a'.repeat(240)} …`);
});

it('removes excluded blocks and unrelated lines beyond the matched logical line', () => {
  const host = createDiv();
  host.createEl('p').appendText('opening');
  const p = host.createEl('p');
  p.appendText('needle');
  p.createEl('br');
  p.appendText('\nnext line');
  p.createSpan({
    attr: { 'aria-hidden': 'true' },
    text: 'huge hidden subtree '.repeat(1000),
  });
  host.createEl('p', { text: 'remaining '.repeat(1000) });
  compactTaskDescriptionExcerpt(
    host,
    prepareSearchQuery('needle', fallbackSearchWords),
    fallbackSearchWords,
  );
  expect(host.querySelectorAll('br')).toHaveLength(0);
  expect(host.textContent).not.toContain('next line');
  expect(host.querySelector('[aria-hidden]')).toBeNull();
  expect(host.textContent).not.toContain('opening');
  expect(host.textContent.length).toBeLessThanOrEqual(246);
});
