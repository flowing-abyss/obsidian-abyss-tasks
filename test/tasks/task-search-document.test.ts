import { afterEach, expect, it } from 'vitest';
import { fallbackSearchWords, prepareSearchQuery } from '../../src/tasks/domain/searchMatchPolicy';
import { TaskIndex } from '../../src/tasks/infrastructure/TaskIndex';
import { createMiniSearchTaskEngine } from '../../src/tasks/infrastructure/search/MiniSearchTaskEngine';
import { canonicalStatusCatalog, createAppWithFiles, expectDefined } from '../helpers';
const indexes: TaskIndex[] = [];
afterEach(() => {
  for (const index of indexes.splice(0)) index.destroy();
});
it('feeds authored canonical Markdown through the shared projection into the real engine', async () => {
  const app = await createAppWithFiles({});
  const index = new TaskIndex(app, { statusCatalog: canonicalStatusCatalog() });
  indexes.push(index);
  await index.initialize();
  index.installCommittedContent(
    'a.md',
    [
      '- [ ] **bud**get \\*literal\\* `code` [[Ledger|Alias]] ![[Folder/Photo.png]] #Work/Urgent 📅 2026-10-04 ⏱️ 1h30m 🆔 dependency42',
      '  - > **Visible** [label](destination)',
      '  - first **bounded',
      '  - second** comment',
      '  - [ ] Child #nested',
    ].join('\n'),
  );
  const source = index.searchSource();
  const documents = [...source.documents(expectDefined(source.files()[0]))];
  expect(documents).toHaveLength(2);
  expect(documents[0]).toMatchObject({
    title: 'budget *literal* code Alias Photo.png',
    description: 'Visible label',
    comments: 'first **bounded\nsecond** comment',
    tags: '#Work/Urgent',
    links: 'Ledger\nFolder/Photo.png\ndestination',
  });
  expect(documents[0]?.metadata).toContain('2026-10-04');
  expect(documents[0]?.metadata).toContain('90');
  expect(documents[0]?.metadata).toContain('1h30m');
  expect(documents[0]?.metadata).toContain('dependency42');
  expect(documents[0]?.metadata).not.toContain('open');
  const engine = createMiniSearchTaskEngine(fallbackSearchWords);
  engine.add(documents);
  for (const query of [
    'budget',
    'Alias',
    'Ledger',
    'destination',
    'Photo',
    'nested',
    '2026-10-04',
    'dependency42',
  ]) {
    expect(
      engine
        .search({
          kind: 'roots',
          query: prepareSearchQuery(query, fallbackSearchWords),
          includeSourcePath: false,
        })
        .map((hit) => hit.id),
    ).toEqual([documents[0]?.id]);
  }
  engine.dispose();
});
