import { expect, it } from 'vitest';
import { parseLinks } from '../../src/markdown/links';
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
