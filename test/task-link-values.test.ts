// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { parseLinks } from '../src/markdown/links';
import { markdownLinkTargetParts } from '../src/markdown/linkTarget';
import { projectTableLinkTargetParts } from '../src/projects/projectTableLinkTarget';
import { outgoingTaskLinkValues } from '../src/task-lists/taskLinkValues';
import { task } from './helpers';

describe('outgoing task links', () => {
  it('uses exact resolved paths, canonical labels, and one value per note', () => {
    const linked = task({
      markdownTitle: 'Ask [[Alice|Al]] [[Alice#Heading]] [[Bob#^block]] [[alice]]',
    });
    const paths = new Map([
      ['Alice', 'People/Alice.md'],
      ['Bob', 'People/Bob.md'],
      ['alice', 'People/alice.md'],
    ]);
    expect(outgoingTaskLinkValues(linked, (target) => paths.get(target))).toEqual([
      { key: 'note:People/Alice.md', label: 'Alice', target: 'People/Alice.md' },
      { key: 'note:People/Bob.md', label: 'Bob', target: 'People/Bob.md' },
      { key: 'note:People/alice.md', label: 'alice', target: 'People/alice.md' },
    ]);
  });
  it('excludes embeds, escaped links, inline code and Markdown links', () => {
    const linked = task({
      markdownTitle:
        '![[Embed]] \\[[Escaped]] `[[Code]]` [Web](https://example.com) [Local](Note.md) [[Real]]',
    });
    expect(outgoingTaskLinkValues(linked, () => undefined).map((value) => value.label)).toEqual([
      'Real',
    ]);
  });
  it('keeps unresolved targets source-relative and removes heading/alias differences', () => {
    const make = (filePath: string) =>
      outgoingTaskLinkValues(
        task({
          markdownTitle: '[[../Missing|Alias]] [[../Missing#Head]]',
          source: { filePath, line: 0 },
        }),
        () => undefined,
      );
    expect(make('A/tasks.md')).toHaveLength(1);
    expect(make('A/tasks.md')[0]?.key).not.toBe(make('B/tasks.md')[0]?.key);
  });
  it('shares the exact target parser with Projects for authored source tokens', () => {
    for (const token of parseLinks(
      '[[Alice#^block|Al]] [Alias](Some%20Note.md#Heading) [Web](https://example.com/a#b) [Bad](bad%escape)',
    )) {
      expect(markdownLinkTargetParts(token)).toEqual(projectTableLinkTargetParts(token));
    }
    expect(markdownLinkTargetParts({ type: 'md', target: 'Some%20Note.md#Heading' })).toEqual({
      resolverTarget: 'Some Note.md',
      subpath: '#Heading',
    });
  });
});
