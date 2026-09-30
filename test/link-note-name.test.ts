// @vitest-environment node
// A wiki link's note name drops only a `.md` extension of the path before the first `#`, as
// Obsidian names a note file, and a plain title reads each wiki link as `parseLinks` does.
import { describe, expect, it } from 'vitest';
import {
  aliasSeparator,
  buildLinkRaw,
  collapseLinks,
  linkLabel,
  linkValueLabel,
  parseLinks,
  writtenAlias,
} from '../src/markdown/links';
import { noteNameOfPath } from '../src/markdown/noteName';
import { rebaseProjectClipboardLinks } from '../src/panels/projects/projectTableClipboard';
import { TaskMarkdownCodec } from '../src/tasks/infrastructure/markdown/TaskMarkdownCodec';
import { canonicalStatusCatalog, expectDefined } from './helpers';

const LINK = String.fromCodePoint(0x1f517);

/** The plain title the codec gives a task line, which every title surface shows or compares. */
function codecTitle(line: string): string | undefined {
  return new TaskMarkdownCodec(canonicalStatusCatalog()).parseLine(line, {
    filePath: 't.md',
    line: 0,
  })?.title;
}

// [link, the name Obsidian gives the linked note (Vl of the file) with the subpath as written]
const NOTE_NAMES: ReadonlyArray<readonly [string, string]> = [
  ['[[Note]]', 'Note'],
  ['[[Folder/Note]]', 'Note'],
  ['[[Projects/2026.09 Review]]', '2026.09 Review'],
  ['[[Folder.v1/Note]]', 'Note'],
  ['[[v1.2 notes]]', 'v1.2 notes'],
  ['[[2026.09.30]]', '2026.09.30'],
  ['[[Note.md]]', 'Note'],
  ['[[Note.MD]]', 'Note'],
  ['[[Folder/Note.md]]', 'Note'],
  ['[[a.md.md]]', 'a.md'],
  ['[[Note.]]', 'Note.'],
  ['[[Note..md]]', 'Note.'],
  ['[[.md]]', '.md'],
  ['[[.hidden]]', '.hidden'],
  ['[[Folder/.hidden]]', '.hidden'],
  ['[[photo.png]]', 'photo.png'],
  ['[[paper.pdf]]', 'paper.pdf'],
  ['[[Board.canvas]]', 'Board.canvas'],
  ['[[Drawing.excalidraw]]', 'Drawing.excalidraw'],
  ['[[Drawing.excalidraw.md]]', 'Drawing.excalidraw'],
  ['[[Note#Heading]]', 'Note#Heading'],
  ['[[Note#v1.2 changes]]', 'Note#v1.2 changes'],
  ['[[Note#a/b]]', 'Note#a/b'],
  ['[[Note.md#Heading]]', 'Note#Heading'],
  ['[[Folder/Note#Heading]]', 'Note#Heading'],
  ['[[Note#^block1]]', 'Note#^block1'],
  ['[[#Heading]]', '#Heading'],
  ['[[./Note]]', 'Note'],
  ['[[../Up/Note.md]]', 'Note'],
  ['[[  Spaced Note  ]]', 'Spaced Note'],
];

describe('the name of a note file', () => {
  // A file path is not split at `#`, since a file name may hold one.
  it.each([
    ['Plan.MD', 'Plan'],
    ['Folder/Plan.md', 'Plan'],
    ['v1.2 notes.md', 'v1.2 notes'],
    ['photo.png', 'photo.png'],
    ['.md', '.md'],
    ['Folder/.md', '.md'],
    ['Note..md', 'Note.'],
    ['A#B.md', 'A#B'],
  ])('Y1j the note file %s is named %s', (path, name) => {
    expect(noteNameOfPath(path)).toBe(name);
  });
});

describe('the note name of a wiki link', () => {
  it.each(NOTE_NAMES)('Y1a %s displays its note name %s', (raw, name) => {
    expect(expectDefined(parseLinks(raw)[0]).display).toBe(name);
  });

  it.each([
    ['[[Areas/2026.09 Review]]', '2026.09 Review'],
    ['[[Folder.v1/Owner]]', 'Owner'],
    ['[[./Owner]]', 'Owner'],
  ])('Y1b the project value %s is labelled %s', (value, label) => {
    expect(linkValueLabel(value)).toBe(label);
  });

  it('Y1b an empty alias on a dotted name is labelled by the whole note name', () => {
    expect(linkLabel(expectDefined(parseLinks('[[v1.2 notes|]]')[0]))).toBe('v1.2 notes');
  });

  it('Y1e a copied link in a dotted folder gains no alias', () => {
    const copied = rebaseProjectClipboardLinks('[[Folder.v1/Note]]', 'a.md', 'b.md', {
      resolve: () => 'Folder.v1/Note.md',
      linktext: () => 'Note',
    });
    expect(copied).toBe('[[Note]]');
  });
});

describe('the plain title of a wiki link', () => {
  it.each([
    ['- [ ] Read [[Projects/2026.09 Review]]', `Read ${LINK} Projects/2026.09 Review`],
    ['- [ ] Read [[v1.2 notes]]', `Read ${LINK} v1.2 notes`],
    ['- [ ] Read [[photo.png]]', `Read ${LINK} photo.png`],
    ['- [ ] Read [[Note.md]]', `Read ${LINK} Note`],
    ['- [ ] Read [[Folder.v1/Note]]', `Read ${LINK} Folder.v1/Note`],
    ['- [ ] Read [[Note#v1.2 changes]]', `Read ${LINK} Note#v1.2 changes`],
    ['- [ ] Read [[./Note]]', `Read ${LINK} ./Note`],
  ])('Y1c the plain title of %s is %s', (line, title) => {
    expect(codecTitle(line)).toBe(title);
  });

  it('Y1d the legacy collapse keeps a dotted name', () => {
    expect(collapseLinks('[[v1.2 notes]] and [[Note.md]]')).toBe(
      `${LINK} v1.2 notes and ${LINK} Note`,
    );
  });

  it.each([
    ['- [ ] Read [[Sources|]]', `Read ${LINK} Sources`],
    ['- [ ] Read [[Note.md|]]', `Read ${LINK} Note`],
    ['- [ ] Read [[Note.md|Alias]]', `Read ${LINK}Note.md`],
  ])('Y1f an empty alias collapses as no alias does: %s is %s', (line, title) => {
    expect(codecTitle(line)).toBe(title);
  });

  it('Y1g the legacy collapse reads an empty alias as no alias', () => {
    expect(collapseLinks('[[Sources|]] and [[Note.md|]]')).toBe(`${LINK} Sources and ${LINK} Note`);
  });

  it('Y1h the table form drops its backslash in both collapses', () => {
    expect(codecTitle(String.raw`- [ ] Read [[Note\|Alias]]`)).toBe(`Read ${LINK}Note`);
    expect(collapseLinks(String.raw`Read [[Note\|Alias]]`)).toBe(`Read ${LINK}Note`);
  });

  it('Y1i a link with a blank text before its pipe collapses as an unaliased link', () => {
    expect(codecTitle('- [ ] Read [[ |Alias]]')).toBe(`Read ${LINK} |Alias`);
    expect(collapseLinks('Read [[ |Alias]]')).toBe(`Read ${LINK} |Alias`);
  });

  it.each([
    ['Read [[ Note ]]', `Read ${LINK} Note`],
    ['Read [[Note.md ]]', `Read ${LINK} Note`],
    ['Read [[ Note | Alias ]]', `Read ${LINK}Note`],
    [String.raw`Read [[Note\]]`, `Read ${LINK} Note`],
    ['Read [[x [[a|b]] y]]', `Read [x ${LINK}a y]`],
  ])(
    'Y1k padding and nesting read as the reader reads them: %s is %s in both collapses',
    (title, plain) => {
      expect(codecTitle(`- [ ] ${title}`)).toBe(plain);
      expect(collapseLinks(title)).toBe(plain);
    },
  );
});

describe('the text a link is written with', () => {
  it.each([
    ['[[Note]]', ''],
    ['[[Note|A]]', 'A'],
    ['[[Note|]]', ''],
    ['[[ |A]]', ''],
    [String.raw`[[Note\|A]]`, 'A'],
    ['[Docs](x)', 'Docs'],
  ])('Y1l the written alias of %s is %j', (raw, alias) => {
    expect(writtenAlias(expectDefined(parseLinks(raw)[0]))).toBe(alias);
  });

  it.each([
    ['[[Note|A]]', '|'],
    [String.raw`[[Note\|A]]`, String.raw`\|`],
    [String.raw`[[Note\]]`, '|'],
    ['[Docs](x)', '|'],
  ])('Y1l the alias separator of %s is %s', (raw, separator) => {
    expect(aliasSeparator(expectDefined(parseLinks(raw)[0]))).toBe(separator);
  });

  // An alias is left out only when it is empty or repeats a target with no folder and no `.md`
  // extension; the separator is `|` unless one is given.
  it.each([
    ['Note', 'Note', undefined, '[[Note]]'],
    ['Folder/Note', 'Folder/Note', undefined, '[[Folder/Note|Folder/Note]]'],
    ['Folder/Note', 'Note', undefined, '[[Folder/Note|Note]]'],
    ['Note', 'note', undefined, '[[Note|note]]'],
    ['Note', '', undefined, '[[Note]]'],
    ['Note#H', 'Note#H', undefined, '[[Note#H]]'],
    ['Note.md', 'Note.md', undefined, '[[Note.md|Note.md]]'],
    ['v1.2 notes', 'v1.2 notes', undefined, '[[v1.2 notes]]'],
    ['Note#v1.2', 'Note#v1.2', undefined, '[[Note#v1.2]]'],
    ['Note.md', 'Note', undefined, '[[Note.md|Note]]'],
    ['Note', 'A', '\\|', String.raw`[[Note\|A]]`],
  ] as const)(
    'Y1l a wiki link to %s with the alias %j and the separator %s is written %s',
    (target, alias, separator, raw) => {
      expect(buildLinkRaw('wiki', target, alias, separator)).toBe(raw);
    },
  );
});

describe('a copied link keeps only the alias it is written with', () => {
  it.each([
    ['[[Note]]', '[[Folder/Note]]'],
    ['[[Note|Alias]]', '[[Folder/Note|Alias]]'],
    ['[[Other|Note]]', '[[Folder/Note|Note]]'],
    ['[[Folder/Note|Folder/Note]]', '[[Folder/Note|Folder/Note]]'],
    ['[[Note|Folder/Note]]', '[[Folder/Note|Folder/Note]]'],
    [String.raw`[[Note\|Alias]]`, String.raw`[[Folder/Note\|Alias]]`],
  ])('Y2f %s pasted where it needs its folder is %s', (value, pasted) => {
    const copied = rebaseProjectClipboardLinks(value, 'a.md', 'Sub/b.md', {
      resolve: () => 'Folder/Note.md',
      linktext: () => 'Folder/Note',
    });
    expect(copied).toBe(pasted);
  });
});
