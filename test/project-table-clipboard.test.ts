import { describe, expect, it } from 'vitest';
import {
  PROJECT_TABLE_CLIPBOARD_TYPE,
  clipboardPayloadFromText,
  coerceProjectClipboardValue,
  decodeProjectTableClipboard,
  deduplicateProjectCellAssignments,
  encodeProjectTableClipboard,
  formatProjectTableTsv,
  parseProjectTableTsv,
  rebaseProjectClipboardLinks,
  resolveProjectPasteRectangle,
  type ProjectClipboardCell,
} from '../src/panels/projects/projectTableClipboard';

describe('project table clipboard', () => {
  it('round-trips quoted TSV cells containing tabs, newlines and quotes', () => {
    const rows = [
      ['plain', 'with\ttab'],
      ['with\nline', 'say "hello"'],
    ];
    const text = formatProjectTableTsv(rows);

    expect(text).toBe('plain\t"with\ttab"\n"with\nline"\t"say ""hello"""');
    expect(parseProjectTableTsv(text)).toEqual(rows);
  });

  it('retains typed raw values, field types and source paths in the internal payload', () => {
    const rows: ProjectClipboardCell[][] = [
      [
        { value: ['[[People/A]]', 2], sourcePath: 'Projects/A.md', fieldType: 'list' },
        { value: false, sourcePath: 'Projects/A.md', fieldType: 'checkbox' },
      ],
    ];

    const encoded = encodeProjectTableClipboard(rows);
    expect(PROJECT_TABLE_CLIPBOARD_TYPE).toBe('application/x-abyss-project-table');
    expect(decodeProjectTableClipboard(encoded)).toEqual(rows);
    expect(encoded).not.toContain('ownedClear');
    expect(encoded).not.toContain('restoreSourceValue');

    const capabilityShaped = encodeProjectTableClipboard([
      [
        {
          value: 'A',
          sourcePath: 'A.md',
          fieldType: 'text',
          ownedClear: true,
          restoreSourceValue: true,
        } as ProjectClipboardCell,
      ],
    ]);
    expect(capabilityShaped).not.toContain('ownedClear');
    expect(capabilityShaped).not.toContain('restoreSourceValue');
  });

  it('rejects malformed quoted TSV and untrusted internal capability-shaped values', () => {
    expect(() => parseProjectTableTsv('"unfinished')).toThrow('Unterminated quoted clipboard cell');
    expect(
      decodeProjectTableClipboard(
        JSON.stringify({
          version: 1,
          rows: [[{ value: { ownedClear: true }, sourcePath: 'A.md', fieldType: 'text' }]],
        }),
      ),
    ).toBeUndefined();
    expect(
      decodeProjectTableClipboard(
        JSON.stringify({
          version: 1,
          rows: [[{ value: 'A', sourcePath: 'A.md', fieldType: 'invented' }]],
        }),
      ),
    ).toBeUndefined();
  });

  it('maps one cell across a selection, a matching rectangle in place, and other TSV from focus', () => {
    const oneCell = clipboardPayloadFromText('x');
    const one = [[oneCell]];
    expect(
      resolveProjectPasteRectangle(one, {
        selection: { top: 0, left: 0, bottom: 1, right: 1 },
        focus: { row: 1, column: 1 },
        rowCount: 3,
        columnCount: 3,
      }),
    ).toEqual([
      { row: 0, column: 0, source: oneCell },
      { row: 0, column: 1, source: oneCell },
      { row: 1, column: 0, source: oneCell },
      { row: 1, column: 1, source: oneCell },
    ]);

    const a = clipboardPayloadFromText('a');
    const b = clipboardPayloadFromText('b');
    const c = clipboardPayloadFromText('c');
    const d = clipboardPayloadFromText('d');
    const rectangle = [
      [a, b],
      [c, d],
    ];
    expect(
      resolveProjectPasteRectangle(rectangle, {
        selection: { top: 0, left: 0, bottom: 1, right: 1 },
        focus: { row: 1, column: 1 },
        rowCount: 3,
        columnCount: 3,
      }),
    ).toEqual([
      { row: 0, column: 0, source: a },
      { row: 0, column: 1, source: b },
      { row: 1, column: 0, source: c },
      { row: 1, column: 1, source: d },
    ]);
    expect(
      resolveProjectPasteRectangle(rectangle, {
        selection: { top: 1, left: 1, bottom: 1, right: 1 },
        focus: { row: 1, column: 1 },
        rowCount: 3,
        columnCount: 3,
      }),
    ).toEqual([
      { row: 1, column: 1, source: a },
      { row: 1, column: 2, source: b },
      { row: 2, column: 1, source: c },
      { row: 2, column: 2, source: d },
    ]);
  });

  it('rejects readonly, incompatible and unknown-status assignments before writes', () => {
    expect(() =>
      coerceProjectClipboardValue(clipboardPayloadFromText('X'), 'name', ['Active']),
    ).toThrow('Name is read-only');
    expect(() =>
      coerceProjectClipboardValue(
        { value: ['a'], sourcePath: 'A.md', fieldType: 'list' },
        'number',
        ['Active'],
      ),
    ).toThrow('cannot be pasted into Number');
    expect(() =>
      coerceProjectClipboardValue(clipboardPayloadFromText('Unknown'), 'status', ['Active']),
    ).toThrow('Unknown project status: Unknown');
    expect(
      coerceProjectClipboardValue(clipboardPayloadFromText('Active'), 'status', ['Active']),
    ).toBe('Active');
  });

  it('deduplicates repeated project cells and rejects conflicting repeated assignments', () => {
    expect(
      deduplicateProjectCellAssignments([
        { key: 'Projects/A.md\0status', value: 'Active', target: 1 },
        { key: 'Projects/A.md\0status', value: 'Active', target: 2 },
      ]),
    ).toEqual([{ key: 'Projects/A.md\0status', value: 'Active', target: 1 }]);
    expect(() =>
      deduplicateProjectCellAssignments([
        { key: 'Projects/A.md\0status', value: 'Active', target: 1 },
        { key: 'Projects/A.md\0status', value: 'Done', target: 2 },
      ]),
    ).toThrow('Conflicting values target the same project cell');
  });

  it('rebases wiki and Markdown links across folders while preserving syntax, aliases and headings', () => {
    const links = {
      resolve: (target: string, sourcePath: string) => {
        expect(sourcePath).toBe('Projects/Source.md');
        expect(target).toBe('../People/Anna Smith');
        return 'People/Anna Smith.md';
      },
      linktext: (path: string, destinationPath: string) => {
        expect(path).toBe('People/Anna Smith.md');
        expect(destinationPath).toBe('Projects/Nested/Destination.md');
        return '../../People/Anna Smith';
      },
    };

    expect(
      rebaseProjectClipboardLinks(
        '[[../People/Anna Smith#Details|Anna]]',
        'Projects/Source.md',
        'Projects/Nested/Destination.md',
        links,
      ),
    ).toBe('[[../../People/Anna Smith#Details|Anna]]');
    expect(
      rebaseProjectClipboardLinks(
        '[Anna](../People/Anna%20Smith#Details)',
        'Projects/Source.md',
        'Projects/Nested/Destination.md',
        links,
      ),
    ).toBe('[Anna](../../People/Anna%20Smith#Details)');
  });
});
