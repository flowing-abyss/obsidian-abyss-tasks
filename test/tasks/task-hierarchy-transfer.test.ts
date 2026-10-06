import { describe, expect, it } from 'vitest';
import { rebaseMarkdownSourceReferences } from '../../src/markdown/sourceReferences';
import { TaskBlockEditor } from '../../src/tasks/infrastructure/markdown/TaskBlockEditor';
import {
  prepareHierarchyTransfer,
  type HierarchyEndpoint,
} from '../../src/tasks/infrastructure/markdown/taskHierarchyTransfer';
import { expectDefined } from '../helpers';
import { unprovedHierarchyReferences } from '../support/hierarchyReferenceFixtures';

const editor = new TaskBlockEditor(() => '    ');
function endpoint(
  filePath: string,
  content: string,
  root = 0,
  relativeLine = 0,
): HierarchyEndpoint {
  const block = expectDefined(editor.rootBlocks(content)[root]);
  const owned = expectDefined(editor.ownedTaskSubtree(block.source, relativeLine));
  return {
    filePath,
    block,
    target: { relativeLine, lineCount: owned.toLine - owned.fromLine + 1, childRanges: [] },
  };
}
function transfer(
  source: string,
  destination?: string,
  options: {
    sourceRoot?: number;
    sourceLine?: number;
    parentRoot?: number;
    parentLine?: number;
  } = {},
) {
  const { sourceRoot = 0, sourceLine = 0, parentRoot = 0, parentLine = 0 } = options;
  const same = destination === source;
  return prepareHierarchyTransfer({
    contents: new Map(
      destination === undefined || same
        ? [['source.md', source]]
        : [
            ['source.md', source],
            ['target.md', destination],
          ],
    ),
    source: endpoint('source.md', source, sourceRoot, sourceLine),
    ...(destination !== undefined && {
      parent: endpoint(same ? 'source.md' : 'target.md', destination, parentRoot, parentLine),
    }),
    editor,
    rewrite: (text) => text,
  });
}
function contents(result: ReturnType<typeof transfer>, path: string): string | undefined {
  expect(result.type).toBe('prepared');
  return result.type === 'prepared' ? result.contents.get(path) : undefined;
}
describe('hierarchy source transfer', () => {
  it('moves one multiline comment with escaped task text as exact source', () => {
    const source = '- [ ] Move\r\n\t- 2026-10-06: first\r\n\t  \\- [ ] literal\r\n\t  tail  ';
    const result = transfer(source, '> - [ ] Parent\r\n> \t- [ ] Existing');
    expect(contents(result, 'source.md')).toBe('');
    expect(contents(result, 'target.md')).toBe(
      '> - [ ] Parent\r\n> \t- [ ] Existing\r\n> \t- [ ] Move\r\n> \t\t- 2026-10-06: first\r\n> \t\t  \\- [ ] literal\r\n> \t\t  tail  ',
    );
  });
  it('moves exact subtree bytes under the destination after its existing children', () => {
    const source =
      '- [ ] Move 🆔 move ^move\n  description [[People/Alice|Alice]]\n  - [ ] Child ^child\n    child body\n  - 2026-10-03T10:00:00 comment\n- [ ] Sibling\n';
    const destination = '- [ ] Parent\n  parent description\n  - [ ] Existing\n';
    const result = transfer(source, destination);
    expect(contents(result, 'source.md')).toBe('- [ ] Sibling\n');
    expect(contents(result, 'target.md')).toBe(
      '- [ ] Parent\n  parent description\n  - [ ] Existing\n  - [ ] Move 🆔 move ^move\n    description [[People/Alice|Alice]]\n    - [ ] Child ^child\n      child body\n    - 2026-10-03T10:00:00 comment\n',
    );
    expect(result).toMatchObject({ moved: { filePath: 'target.md', line: 3 }, changed: true });
  });
  it.each(['-', '*', '+', '12.'])(
    'preserves %s markers and CRLF with no final newline',
    (marker) => {
      const result = transfer(`${marker} [ ] Move\r\n  body`, '- [ ] Parent\r\n\t- [ ] Existing');
      expect(contents(result, 'source.md')).toBe('');
      expect(contents(result, 'target.md')).toBe(
        `- [ ] Parent\r\n\t- [ ] Existing\r\n\t${marker} [ ] Move\r\n\t  body`,
      );
    },
  );
  it('promotes a deep child after the whole old root including its trailing comments', () => {
    const source =
      '- [ ] Root\n  - [ ] Branch\n    - [ ] Move\n      body\n  - 2026-10-03T10:00:00 comment\n- [ ] Next\n';
    const result = transfer(source, undefined, { sourceLine: 2 });
    expect(contents(result, 'source.md')).toBe(
      '- [ ] Root\n  - [ ] Branch\n  - 2026-10-03T10:00:00 comment\n- [ ] Move\n  body\n- [ ] Next\n',
    );
    expect(result).toMatchObject({ moved: { line: 3 } });
  });
  it('moves a same-root branch using physical positions after removal', () => {
    const source = '- [ ] Root\n  - [ ] Move\n    body\n  - [ ] Parent\n    - [ ] Existing\n';
    const result = transfer(source, source, { sourceLine: 1, parentLine: 3 });
    expect(contents(result, 'source.md')).toBe(
      '- [ ] Root\n  - [ ] Parent\n    - [ ] Existing\n    - [ ] Move\n      body\n',
    );
  });
  it('leaves an existing direct parent unchanged', () => {
    const source = '- [ ] Root\n  - [ ] Move\n  - [ ] Sibling\n';
    const result = transfer(source, source, { sourceLine: 1 });
    expect(contents(result, 'source.md')).toBe(source);
    expect(result).toMatchObject({ changed: false });
  });
  it('rejects self and descendant parents', () => {
    const source = '- [ ] Root\n  - [ ] Child\n';
    expect(transfer(source, source)).toEqual({ type: 'invalid' });
    expect(transfer(source, source, { parentLine: 1 })).toEqual({ type: 'invalid' });
  });
  it('keeps quoted prefixes, fences, metadata, and legacy oversize duration bytes', () => {
    const source = '> - [ ] Move ⏰ 23:00 ⏱️ 99h\n>   ```md\n>   [[untouched]]\n>   ```\n';
    const result = transfer(source, '> - [ ] Parent\n>   - > body\n');
    expect(contents(result, 'target.md')).toBe(
      '> - [ ] Parent\n>   - > body\n>   - [ ] Move ⏰ 23:00 ⏱️ 99h\n>     ```md\n>     [[untouched]]\n>     ```\n',
    );
  });
  it('rejects destination block ID collisions', () => {
    expect(transfer('- [ ] Move ^same\n', '- [ ] Parent ^same\n')).toEqual({ type: 'invalid' });
  });
  it('moves only the requested byte-identical root', () => {
    const source = '- [ ] Same\n- [ ] Same\n- [ ] Parent\n';
    const result = transfer(source, source, { sourceRoot: 1, parentRoot: 2 });
    expect(contents(result, 'source.md')).toBe('- [ ] Same\n- [ ] Parent\n    - [ ] Same\n');
  });
});

it('preserves fenced task examples and inserts outside the destination fence', () => {
  const result = transfer(
    '- [ ] Move\n  ~~~md\n  - [ ] Example ^fake\n  ~~~\n',
    '- [ ] Parent\n  ~~~md\n  - [ ] Example ^fake\n  ~~~\n',
  );
  expect(contents(result, 'target.md')).toBe(
    '- [ ] Parent\n  ~~~md\n  - [ ] Example ^fake\n  ~~~\n  - [ ] Move\n    ~~~md\n    - [ ] Example ^fake\n    ~~~\n',
  );
});
it('leaves inbound links outside the moved range unchanged in both authorized notes', () => {
  const result = transfer(
    '- [ ] Move ^move\n- [ ] Stays [[source#^move]]\n',
    '- [ ] Parent [[source#^move]]\n',
  );
  expect(contents(result, 'source.md')).toBe('- [ ] Stays [[source#^move]]\n');
  expect(contents(result, 'target.md')).toBe(
    '- [ ] Parent [[source#^move]]\n    - [ ] Move ^move\n',
  );
});

it('transfers images after mixed fences with exact code bytes and new relative destinations', () => {
  const source =
    '- [ ] Move\r\n  ~~~js\r\n  console.log("`");\r\n  ~~~\r\n  ![](photo.png) ![photo](photo.png) `![](missing.png)`\r\n';
  const destination = '- [ ] Parent\r\n';
  const result = prepareHierarchyTransfer({
    contents: new Map([
      ['source.md', source],
      ['target.md', destination],
    ]),
    source: endpoint('source.md', source),
    parent: endpoint('target.md', destination),
    editor,
    rewrite: (text, sourcePath, destinationPath, movedAnchors) =>
      rebaseMarkdownSourceReferences(text, {
        sourcePath,
        destinationPath,
        movedAnchors,
        resolver: {
          resolve: (target) => (target === 'photo.png' ? 'folder/photo.png' : undefined),
          linktext: () => '../folder/photo.png',
        },
      }),
  });
  expect(contents(result, 'source.md')).toBe('');
  expect(contents(result, 'target.md')).toBe(
    '- [ ] Parent\r\n    - [ ] Move\r\n      ~~~js\r\n      console.log("`");\r\n      ~~~\r\n      ![](../folder/photo.png) ![photo](../folder/photo.png) `![](missing.png)`\r\n',
  );
});

it.each(unprovedHierarchyReferences)(
  'rejects unproved outgoing source before preparing: %s',
  (source) => {
    const destination = '- [ ] Parent\n\n[id]: https://example.com/different\n';
    const result = prepareHierarchyTransfer({
      contents: new Map([
        ['A/source.md', source],
        ['B/target.md', destination],
      ]),
      source: endpoint('A/source.md', source),
      parent: endpoint('B/target.md', destination),
      editor,
      rewrite: (text, sourcePath, destinationPath, movedAnchors) =>
        rebaseMarkdownSourceReferences(text, {
          sourcePath,
          destinationPath,
          movedAnchors,
          resolver: {
            resolve: (target) => `A/${target}`,
            linktext: (path) => `../${path}`,
          },
        }),
    });
    expect(result).toEqual({ type: 'invalid' });
  },
);
