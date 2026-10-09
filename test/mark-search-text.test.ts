import { expect, it, vi } from 'vitest';
import { projectSearchText } from '../src/markdown/searchText';
import { prepareSearchQuery } from '../src/tasks';
import { fallbackSearchWords } from '../src/tasks/domain/searchMatchPolicy';
import { markSearchText, renderedAnchorSources } from '../src/ui/markSearchText';

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
