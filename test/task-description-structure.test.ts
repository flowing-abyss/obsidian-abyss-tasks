import { describe, expect, it } from 'vitest';
import { projectSearchText, searchTextSourceRanges } from '../src/markdown/searchText';
import { analyzeTaskDescription } from '../src/markdown/taskDescriptionStructure';
import { readTaskDescriptionLine } from '../src/tasks/infrastructure/markdown/taskBlockSyntax';

const description =
  'Раз\nДва\n\nтри:\n1. [test](https://google.com)\n2. test\nдругой текст\n- test\n- test';

describe('description structure', () => {
  it('separates unindented prose after lists without changing authored list items', () => {
    expect(analyzeTaskDescription(description).markdown).toBe(
      'Раз\nДва\n\nтри:\n1. [test](https://google.com)\n2. test\n\nдругой текст\n- test\n- test',
    );
    const projection = projectSearchText(description, 'description');
    expect(projection.visible.text).toBe('Раз\nДва\n\nтри:\ntest\ntest\nдругой текст\ntest\ntest');
    expect(searchTextSourceRanges(projection.visible, { from: 9, to: 12 })).toEqual([
      { from: 9, to: 12 },
    ]);
    expect(searchTextSourceRanges(projection.visible, { from: 14, to: 18 })).toEqual([
      { from: 18, to: 22 },
    ]);
  });

  it.each([
    ['1. item\n   continued', 'item\n   continued'],
    ['12. item\n13. next', 'item\nnext'],
    [
      '1. item\n   - nested\n     continued\n   1. child\n2. next',
      'item\n   nested\n     continued\n   child\nnext',
    ],
    ['- item\n\t1. nested\n\t   continued\n- next', 'item\n\tnested\n\t   continued\nnext'],
    ['paragraph\n2. literal', 'paragraph\n2. literal'],
    ['paragraph\n\n12. item', 'paragraph\n\nitem'],
    ['paragraph\n- ', 'paragraph\n- '],
    ['\\- escaped\n2\\. literal', '- escaped\n2. literal'],
  ])('preserves nesting and paragraph interruption rules for %j', (source, visible) => {
    expect(analyzeTaskDescription(source).markdown).toBe(source);
    expect(projectSearchText(source, 'description').visible.text).toBe(visible);
  });

  it.each([
    '```md\n1. literal\nplain\n```',
    '~~~\n- literal\nplain\n~~~',
    '`span\n1. literal\nplain`',
    '`span\nend`\n2. literal',
    '    1. code\n    - code',
    '# heading\n1. item',
    '<div>\n1. literal\n</div>',
    '---\n1. item',
  ])('withholds structural authority for unsupported or protected source %j', (source) => {
    expect(analyzeTaskDescription(source)).toEqual({ markdown: source, markers: [] });
  });

  it('preserves CRLF separators and existing blank lines', () => {
    expect(analyzeTaskDescription('1. item\r\nnext').markdown).toBe('1. item\r\n\r\nnext');
    expect(analyzeTaskDescription('1. item\n\nnext').markdown).toBe('1. item\n\nnext');
  });

  it('does not turn non-interrupting numeric continuation into a new list', () => {
    const source = '- item\n2. literal';
    expect(analyzeTaskDescription(source).markdown).toBe(source);
    expect(projectSearchText(source, 'description').visible.text).toBe('item\n2. literal');
  });

  it('does not opt titles or comments into the description list policy', () => {
    expect(projectSearchText('1. item\nnext', 'title').visible.text).toBe('1. item\nnext');
    expect(projectSearchText('1. item\nnext', 'prose').visible.text).toBe('1. item\nnext');
  });

  it('reads exact carrier payload and physical columns, including empty payloads', () => {
    expect(readTaskDescriptionLine('\t- >   nested  ')).toEqual({ text: '  nested  ', column: 5 });
    expect(readTaskDescriptionLine('  - > ')).toEqual({ text: '', column: 6 });
    expect(readTaskDescriptionLine('  - > \t')).toEqual({ text: '\t', column: 6 });
    expect(readTaskDescriptionLine('  - ordinary')).toBeUndefined();
  });
});
