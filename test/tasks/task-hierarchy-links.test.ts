import { expect, it } from 'vitest';
import { parseLinks, parseSourceReferences } from '../../src/markdown/links';
import { rebaseMarkdownSourceReferences } from '../../src/markdown/sourceReferences';

const references = {
  resolve: (target: string, source: string) =>
    target === ''
      ? source
      : (
          {
            source: 'folder/source.md',
            '../People/Alice': 'People/Alice.md',
            'photo.png': 'folder/photo.png',
          } as Record<string, string>
        )[target],
  linktext: (path: string) => path.replace(/\.md$/u, ''),
};
it('retargets moved anchors while keeping source anchors and preserving aliases and embeds', () => {
  const text =
    '[[#^child| kid ]] [[source#^child]] [child](source#^child) [[#^stays]] ![[#^child]] ![photo](photo.png) [[../People/Alice#Heading\\|Alice]]';
  expect(
    rebaseMarkdownSourceReferences(text, {
      sourcePath: 'folder/source.md',
      destinationPath: 'else/target.md',
      movedAnchors: new Set(['child']),
      resolver: references,
    }),
  ).toBe(
    '[[else/target#^child| kid ]] [[else/target#^child]] [child](else/target#^child) [[folder/source#^stays]] ![[else/target#^child]] ![photo](folder/photo.png) [[People/Alice#Heading\\|Alice]]',
  );
});
it('preserves external URLs, escaped syntax, inline code and fenced code', () => {
  const text =
    '[web](https://example.com/a#b) `[[missing]]` \\[[missing]]\n  ```md\n  [[missing]]\n  ```\n';
  expect(
    rebaseMarkdownSourceReferences(text, {
      sourcePath: 'folder/source.md',
      destinationPath: 'else/target.md',
      movedAnchors: new Set(),
      resolver: references,
    }),
  ).toBe(text);
});
it('rejects unresolved internal references without guessing new meaning', () => {
  expect(
    rebaseMarkdownSourceReferences('[[../unknown]]', {
      sourcePath: 'folder/source.md',
      destinationPath: 'else/target.md',
      movedAnchors: new Set(),
      resolver: references,
    }),
  ).toBeUndefined();
});
it('does not grant ordinary link edits authority over images or embeds', () => {
  expect(parseLinks('![[source]] ![image](photo.png) [[source]]')).toMatchObject([
    { raw: '[[source]]', index: 32 },
  ]);
});

it.each([
  ['![](photo.png)', '![](../folder/photo.png)'],
  ['![](missing.png)', undefined],
  [
    'before `\n~~~js\ncode\n~~~\n![photo](photo.png) `inline`',
    'before `\n~~~js\ncode\n~~~\n![photo](../folder/photo.png) `inline`',
  ],
  ['before `\n~~~js\ncode\n~~~\n![photo](missing.png) `inline`', undefined],
  [
    '~~~js\nconsole.log("`");\n~~~\n![photo](photo.png) `inline`',
    '~~~js\nconsole.log("`");\n~~~\n![photo](../folder/photo.png) `inline`',
  ],
  ['~~~js\nconsole.log("`");\n~~~\n![photo](missing.png) `inline`', undefined],
])('rebases or rejects image references outside code: %s', (text, expected) => {
  expect(
    rebaseMarkdownSourceReferences(text, {
      sourcePath: 'folder/source.md',
      destinationPath: 'else/target.md',
      movedAnchors: new Set(),
      resolver: { ...references, linktext: () => '../folder/photo.png' },
    }),
  ).toBe(expected);
});
it('includes empty-alt images only in source reference authority with exact offsets', () => {
  const text = '![](photo.png) [](/empty) ![photo](photo.png)';
  expect(parseSourceReferences(text)).toMatchObject([
    { raw: '[](photo.png)', index: 1, display: '' },
    { raw: '[photo](photo.png)', index: 27, display: 'photo' },
  ]);
  expect(parseLinks(text)).toEqual([]);
});

it.each([
  '[label](other(one).md)',
  '[label](<other.md>)',
  '[label](other.md "title")',
  '[outer [inner]](other.md)',
  '<img src="photo.png">',
])(
  'rejects complex source-reference syntax rather than claiming complete recognition: %s',
  (text) => {
    expect(
      rebaseMarkdownSourceReferences(text, {
        sourcePath: 'folder/source.md',
        destinationPath: 'else/target.md',
        movedAnchors: new Set(),
        resolver: { resolve: () => 'folder/other.md', linktext: () => '../folder/other.md' },
      }),
    ).toBeUndefined();
  },
);

it('preserves supported code and escaped references next to rebased image references', () => {
  const text = '> - [x] Move `[](missing.md)` \\[[missing]] ![photo](photo.png)\r\n';
  expect(
    rebaseMarkdownSourceReferences(text, {
      sourcePath: 'folder/source.md',
      destinationPath: 'else/target.md',
      movedAnchors: new Set(),
      resolver: references,
    }),
  ).toBe('> - [x] Move `[](missing.md)` \\[[missing]] ![photo](folder/photo.png)\r\n');
});

it.each([
  ['ordinary prose without brackets', 'ordinary prose without brackets'],
  ['literal [aside]', undefined],
  ['literal \\[aside\\]', 'literal \\[aside\\]'],
  ['- [ ] task\n  12. [x] child', '- [ ] task\n  12. [x] child'],
])('bounds literal bracket recognition explicitly: %s', (text, expected) => {
  expect(
    rebaseMarkdownSourceReferences(text, {
      sourcePath: 'folder/source.md',
      destinationPath: 'else/target.md',
      movedAnchors: new Set(),
      resolver: references,
    }),
  ).toBe(expected);
});
