// @vitest-environment node
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { parseTask } from '../../src/parser/TaskParser';
import { parseTaskLineSourceModel } from '../../src/tasks/domain/taskLineSourceModel';
import { TaskMarkdownCodec } from '../../src/tasks/infrastructure/markdown/TaskMarkdownCodec';
import { canonicalStatusCatalog, expectDefined } from '../helpers';

const statusCatalog = canonicalStatusCatalog();
const codec = new TaskMarkdownCodec(statusCatalog);
const location = { filePath: 'html.md', line: 0 };

function expectHtmlTitle(source: string, title: string, tags: readonly string[]): void {
  for (const parsed of [
    expectDefined(parseTaskLineSourceModel(source)),
    expectDefined(codec.parseLine(source, location)),
  ]) {
    expect(parsed.tags).toEqual(tags);
    expect(parsed.markdownTitle).toBe(title);
    expect(parsed.original).toBe(source);
    expect(parsed.spans.map((span) => source.slice(span.from, span.to)).join('')).toBe(source);
    expect(
      parsed.spans
        .filter((span) => span.kind === 'tag')
        .map((span) => source.slice(span.from, span.to)),
    ).toEqual(tags);
  }
}

describe('HTML task attributes are authored title syntax', () => {
  it('preserves the screenshot color and keeps the real category and due date', () => {
    const title = 'новая <font color="#ff0000">задача</font>';
    const source = `- [ ] #category/personal ${title} 📅 2026-10-12`;
    expectHtmlTitle(source, title, ['#category/personal']);
    expect(codec.parseLine(source, location)?.planning.due).toBe('2026-10-12');
    const legacy = expectDefined(parseTask(source, { ...location, statusCatalog }));
    expect(legacy.rawText).toBe(source);
    expect(legacy.text).toBe(title);
    expect(legacy.markdownText).toBe(title);
  });

  it.each([
    ['font', '<font color="#ff0000">text</font>'],
    ['span', "<span style='color: #abc; background: #AABBCCDD'>text</span>"],
    ['link', '<a href="#section" title="a > b #hidden">text</a>'],
    ['image', '<img src="image.svg#icon" alt="#hidden" />'],
    ['SVG', '<svg><path fill="#fff" stroke="#abcdef" /></svg>'],
    ['input', '<input value="#hidden" disabled>'],
    ['custom', '<my-widget data-tag="#hidden" aria-label="#label">text</my-widget>'],
    ['unquoted', '<span style=color:#abc data-tag=#hidden>text</span>'],
    ['upper case', '<SPAN STYLE="color: #ABC">text</SPAN>'],
    ['quoted angles', '<span title="<font color=\'#abc\'> #hidden >">text</span>'],
    ['equals whitespace', '<span data-tag = "#hidden" >text</span>'],
  ])('protects attributes in %s', (_name, title) => {
    expectHtmlTitle(`- [ ] #before ${title} #after`, title, ['#before', '#after']);
  });

  it.each([
    'a',
    'abbr',
    'b',
    'bdi',
    'bdo',
    'blockquote',
    'br',
    'button',
    'cite',
    'code',
    'del',
    'details',
    'div',
    'em',
    'font',
    'i',
    'img',
    'input',
    'kbd',
    'label',
    'mark',
    'p',
    'q',
    's',
    'samp',
    'small',
    'span',
    'strong',
    'sub',
    'summary',
    'sup',
    'svg',
    'table',
    'td',
    'time',
    'u',
    'var',
    'wbr',
    'my-widget',
  ])('does not depend on a whitelist of HTML elements: %s', (name) => {
    const title = `<${name} data-tag="#hidden" style="color: #fff">text</${name}>`;
    expectHtmlTitle(`- [ ] ${title} #real`, title, ['#real']);
  });

  it('keeps genuine tags in visible text inside an element', () => {
    expectHtmlTitle(
      '- [ ] <span color="#fff">text #visible</span> #outside',
      '<span color="#fff">text </span>',
      ['#visible', '#outside'],
    );
  });

  it('does not read other task metadata from attribute values', () => {
    const title =
      '<span title="📅 2026-01-01 🆔 hidden ⛔ hidden 🔺 ⏰ 01:02 🔁 every day ^hidden #fff">text</span>';
    const source = `- [ ] ${title} 📅 2026-10-12 🆔 real ⛔ dependency #real`;
    expectHtmlTitle(source, title, ['#real']);
    const parsed = expectDefined(codec.parseLine(source, location));
    expect(parsed.planning).toEqual({ due: '2026-10-12' });
    expect(parsed.dependencyId).toBe('real');
    expect(parsed.dependsOn).toEqual(['dependency']);
    expect(parsed.priority).toBe('D');
    expect(parsed.recurrence).toBeUndefined();
  });

  it('removes only the genuine tag when its spelling also occurs in attributes', () => {
    const title = '<font color="#ff0000" data-tag="#ff0000">text</font>';
    const source = `- [ ] ${title} #ff0000\r\n`;
    expect(
      codec.applyLineEdit(source, { type: 'change-tags', add: [], remove: ['#ff0000'] }),
    ).toMatchObject({
      type: 'changed',
      content: `- [ ] ${title}\r\n`,
    });
    expect(
      codec.applyLineEdit(`- [ ] ${title}\r\n`, {
        type: 'change-tags',
        add: [],
        remove: ['#ff0000'],
      }).type,
    ).toBe('unchanged');
  });

  it.each([
    '- [ ] 2 < 3 #real',
    '- [ ] <not-a-tag #real',
    '- [ ] <span title="unterminated #real',
    '- [ ] `<span title="` #real ">',
    '- [ ] [[<span title="|label]] #real ">',
  ])('keeps real metadata after literal or protected angle text: %s', (source) => {
    expect(codec.parseLine(source, location)?.tags).toEqual(['#real']);
  });

  it('changes status without removing completion or cancellation text from HTML attributes', () => {
    const title = '<span title="✅ 2026-01-01 ❌ 2026-01-02 #hidden">text</span>';
    const source = `- [ ] ${title} #real\r\n`;
    const expected = `- [x] ${title} #real\r\n`;
    const edit = {
      type: 'set-status' as const,
      symbol: 'x',
      today: '2026-10-12',
      addCompletionDate: false,
    };
    expect(codec.applyLineEdit(source, edit)).toMatchObject({ type: 'changed', content: expected });
    expect(codec.applyLineEdit(expected, edit).type).toBe('unchanged');
    expectHtmlTitle(expected, title, ['#real']);
  });

  it.each([
    ['\\', ['#hidden', '#real']],
    ['\\\\', ['#real']],
    ['\\\\\\', ['#hidden', '#real']],
    ['\\\\\\\\', ['#real']],
  ] as const)('preserves the HTML escape parity after %j', (slashes, tags) => {
    const source = `- [ ] ${slashes}<font color="#hidden">text</font> #real`;
    expect(codec.parseLine(source, location)?.tags).toEqual(tags);
    expect(codec.parseLine(source, location)?.original).toBe(source);
  });

  it('preserves independently generated quoted colors, names and line endings', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('font', 'span', 'a', 'img', 'svg', 'my-widget'),
        fc.constantFrom('"', "'", ''),
        fc.constantFrom('#abc', '#ABCDEF', '#00112233', '#fff', '#цвет', '#tag/child'),
        fc.constantFrom('', '\n', '\r\n'),
        (name, quote, value, ending) => {
          const title = `<${name} data-value=${quote}${value}${quote}>😀 text</${name}>`;
          const source = `- [ ] #real ${title} 📅 2026-10-12${ending}`;
          expectHtmlTitle(source, title, ['#real']);
          expect(codec.parseLine(source, location)?.planning.due).toBe('2026-10-12');
        },
      ),
      { seed: 20261012, numRuns: 200 },
    );
  });
});
