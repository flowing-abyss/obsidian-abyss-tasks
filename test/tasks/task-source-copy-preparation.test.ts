import { expect, it, vi } from 'vitest';
import { expectDefined } from '../helpers';
import { ready, taskEditPreparationHarness } from '../support/taskEditPreparationHarness';

it('copies a source root comment after a destination root description edit with note preambles', async () => {
  const h = await taskEditPreparationHarness('# Итог\n\n- [ ] Итог\n', {
    files: {
      'z-source.md':
        '# Перенос\n\n- [ ] Исходная задача\n  - > Исходное описание.\n  - 2021-01-02: Важный комментарий.\n  - [ ] Проверить результат\n',
    },
  });
  const source = expectDefined(h.index.list({ filePath: 'z-source.md' })[0]);
  let p = ready(await h.service.prepare(h.root, []));
  p = ready(
    p.append({
      type: 'set-description',
      target: { type: 'task', ref: expectDefined(p.after).ref },
      text: 'Исходная задача\nИсходное описание.',
    }),
  );
  p = ready(
    await p.copySource({
      type: 'comment',
      source: expectDefined(source.comments[0]).ref,
      parent: { type: 'task', ref: expectDefined(p.after).ref },
    }),
  );
  expect(p.after?.comments[0]?.text).toBe('Важный комментарий.');
  expect(p.copies[0]?.state).toBe('retained');
  expect(h.writes).not.toHaveBeenCalled();
});

it('copies selected historical comments exactly without restamping or losing duplicate ownership', async () => {
  const h = await taskEditPreparationHarness(
    '- [ ] Target\r\n- [ ] Source\r\n\t- 2020-01-02: Same\r\n\t  continuation\r\n\t- Same\r\n',
  );
  const source = expectDefined(h.index.list()[1]);
  let p = ready(await h.service.prepare(h.root, []));
  for (const comment of source.comments) {
    p = ready(
      await p.copySource({
        type: 'comment',
        source: comment.ref,
        parent: { type: 'task', ref: expectDefined(p.after).ref },
      }),
    );
  }
  expect(p.after?.comments.map((c) => c.ref.originalMarkdown)).toEqual(
    source.comments.map((c) => c.ref.originalMarkdown),
  );
  expect(p.copies).toHaveLength(2);
  expect(p.copies.every((c) => c.state === 'retained')).toBe(true);
  expect(h.writes).not.toHaveBeenCalled();
  expect((await p.commit()).type).toBe('ok');
  expect(h.index.list()[1]?.source.originalBlock).toBe(source.source.originalBlock);
});

it('grafts historical subtree bytes with new identities and rejects initial status refinement', async () => {
  const h = await taskEditPreparationHarness(
    '- [ ] Target\n- [x] Source [unknown:: keep]\n\t- > prose\n\t- 2020-01-02: history\n\t- [ ] Child\n\t  ```\n\t  - [ ] fenced\n\t  ```\n',
  );
  const source = expectDefined(h.index.list()[1]);
  let p = ready(await h.service.prepare(h.root, []));
  p = ready(
    await p.copySource({
      type: 'subtree',
      source: { type: 'task', ref: source.ref },
      parent: { type: 'task', ref: expectDefined(p.after).ref },
    }),
  );
  const inserted = expectDefined(p.after?.subtasks[0]);
  expect(inserted.ref.originalBlock).toBe(
    source.source.originalBlock
      .split('\n')
      .map((l) => `\t${l}`)
      .join('\n'),
  );
  expect(p.copies[0]?.state).toBe('retained');
  expect(
    p.refineInitialStatus({ target: { type: 'subtask', ref: inserted.ref }, symbol: ' ' }).type,
  ).toBe('invalid');
  expect(h.writes).not.toHaveBeenCalled();
  expect((await p.commit()).type).toBe('ok');
  expect(h.index.list()).toHaveLength(2);
});
it('proves a simple flat merge from canonical copies and holds unknown source-owned data', async () => {
  const h = await taskEditPreparationHarness(
    '- [ ] Target #work\n\t- > Source\n- [ ] Source #work\n\t- 2020-01-02: kept\n\t- [ ] Child\n',
  );
  const source = expectDefined(h.index.list()[1]);
  let p = ready(await h.service.prepare(h.root, []));
  p = ready(
    await p.copySource({
      type: 'comment',
      source: expectDefined(source.comments[0]).ref,
      parent: { type: 'task', ref: expectDefined(p.after).ref },
    }),
  );
  p = ready(
    await p.copySource({
      type: 'subtree',
      source: { type: 'subtask', ref: expectDefined(source.subtasks[0]).ref },
      parent: { type: 'task', ref: expectDefined(p.after).ref },
    }),
  );
  const assessment = await p.assessMerge({ type: 'task', ref: source.ref });
  expect(assessment?.state).toBe('covered');
  expect(assessment?.entries.some((e) => e.kind === 'comment' && e.state === 'retained')).toBe(
    true,
  );
  p = ready(p.append({ type: 'delete-comment', comment: expectDefined(p.after?.comments[0]).ref }));
  expect((await p.assessMerge({ type: 'task', ref: source.ref }))?.state).toBe('held');
  expect(h.writes).not.toHaveBeenCalled();
});
it.each(['[unknown:: data]', '🔁 every day', '🆔 source', '✅ 2020-01-01'])(
  'holds unsupported source header %s',
  async (header) => {
    const h = await taskEditPreparationHarness(`- [ ] Source\n- [ ] Source ${header}\n`);
    const source = expectDefined(h.index.list()[1]);
    const p = ready(await h.service.prepare(h.root, []));
    expect((await p.assessMerge({ type: 'task', ref: source.ref }))?.state).toBe('held');
    expect(h.writes).not.toHaveBeenCalled();
  },
);

it('keeps a frozen same-note copy after a source-sibling edit and refuses original-source cleanup', async () => {
  const h = await taskEditPreparationHarness(
    '- [ ] Target\n- [ ] Source\n\t- 2020-01-02: history\n',
  );
  h.index.integrationReads().activateOccurrences();
  const source = expectDefined(h.index.list()[1]);
  const remove = ready(await h.service.prepare(source, [{ type: 'delete', ref: source.ref }]));
  let p = ready(await h.service.prepare(h.root, []));
  p = ready(
    await p.copySource({
      type: 'subtree',
      source: { type: 'task', ref: source.ref },
      parent: { type: 'task', ref: expectDefined(p.after).ref },
    }),
  );
  const frozen = p.after?.source.originalBlock;
  expect(
    (
      await h.service.execute({
        type: 'set-description',
        target: { type: 'task', ref: source.ref },
        text: 'Newer source',
      })
    ).type,
  ).toBe('ok');
  p = ready(await p.refresh(expectDefined(h.index.list()[0])));
  expect(p.after?.source.originalBlock).toBe(frozen);
  expect((await p.commit()).type).toBe('ok');
  expect((await remove.refresh(expectDefined(h.index.list()[1]))).type).toBe('invalid');
  expect(await h.read()).toContain('Newer source');
  expect(h.index.list()[0]?.subtasks[0]?.description).toBeUndefined();
});

it('permits separately guarded cleanup only after the known destination copy and readback', async () => {
  const h = await taskEditPreparationHarness('- [ ] Target\n- [ ] Source\n\t- Same\n');
  h.index.integrationReads().activateOccurrences();
  const source = expectDefined(h.index.list()[1]);
  let remove = ready(await h.service.prepare(source, [{ type: 'delete', ref: source.ref }]));
  let p = ready(await h.service.prepare(h.root, []));
  p = ready(
    await p.copySource({
      type: 'subtree',
      source: { type: 'task', ref: source.ref },
      parent: { type: 'task', ref: expectDefined(p.after).ref },
    }),
  );
  expect(h.writes).not.toHaveBeenCalled();
  const result = await p.commit();
  expect(result.type).toBe('ok');
  expect(h.index.list()[0]?.source.originalBlock).toBe(p.after?.source.originalBlock);
  expect(await p.commit()).toEqual(result);
  expect(h.writes).toHaveBeenCalledTimes(1);
  remove = ready(await remove.refresh(expectDefined(h.index.list()[1])));
  expect((await remove.commit()).type).toBe('ok');
  expect(h.index.list()).toHaveLength(1);
  expect(h.index.list()[0]?.subtasks[0]?.comments[0]?.text).toBe('Same');
});

it('rebases supported cross-file references and preserves legacy tracking', async () => {
  const h = await taskEditPreparationHarness('- [ ] Target\n', {
    files: {
      'z-source.md':
        '- [ ] Source ⏱️ 99h\n\t- > [[#^child| kid ]]\n\t- [ ] Child ^child\n\t- 2020-01-02T10:00:00+00:00 → 2020-01-02T11:00:00+00:00\n',
    },
  });
  vi.spyOn(h.app.metadataCache, 'fileToLinktext').mockImplementation((file) =>
    file.path.replace(/\.md$/u, ''),
  );
  const source = expectDefined(h.index.list({ filePath: 'z-source.md' })[0]);
  let p = ready(await h.service.prepare(h.root, []));
  p = ready(
    await p.copySource({
      type: 'subtree',
      source: { type: 'task', ref: source.ref },
      parent: { type: 'task', ref: expectDefined(p.after).ref },
    }),
  );
  expect(p.after?.source.originalBlock).toContain('[[tasks#^child| kid ]]');
  expect(p.after?.source.originalBlock).toContain('⏱️ 99h');
  expect(p.after?.subtasks[0]?.timeEntries).toHaveLength(1);
  expect((await p.commit()).type).toBe('ok');
  expect(h.index.list({ filePath: 'z-source.md' })[0]?.source.originalBlock).toBe(
    source.source.originalBlock,
  );
});

it('rejects unsupported cross-file references without changing the valid destination preparation', async () => {
  const h = await taskEditPreparationHarness('- [ ] Target\n', {
    files: { 'z-source.md': '- [ ] Source\n\t- [[Missing]]\n' },
  });
  const source = expectDefined(h.index.list({ filePath: 'z-source.md' })[0]);
  const p = ready(await h.service.prepare(h.root, []));
  expect(
    (
      await p.copySource({
        type: 'comment',
        source: expectDefined(source.comments[0]).ref,
        parent: { type: 'task', ref: expectDefined(p.after).ref },
      })
    ).type,
  ).toBe('invalid');
  expect(p.after?.source.originalBlock).toBe('- [ ] Target');
  expect(h.writes).not.toHaveBeenCalled();
});

it('allows a historical copy into creation but never grants copied nodes construction status authority', async () => {
  const h = await taskEditPreparationHarness('- [ ] Source\n\t- [ ] Same\n');
  let p = await h.service.prepareCreateTree({
    destination: {
      type: 'explicit',
      destination: { filePath: 'tasks.md', insertion: { type: 'append' } },
    },
    tree: { markdownTitle: 'New' },
  });
  if (p.type !== 'ready') throw new Error('No creation');
  p = await p.copySource({
    type: 'subtree',
    source: { type: 'task', ref: h.root.ref },
    parent: { type: 'task', ref: p.after.ref },
  });
  if (p.type !== 'ready') throw new Error('No copy');
  const child = expectDefined(p.after.subtasks[0]);
  expect(
    p.refineInitialStatus({ target: { type: 'subtask', ref: child.ref }, symbol: 'x' }).type,
  ).toBe('invalid');
  expect(
    p.refineInitialStatus({
      target: { type: 'subtask', ref: expectDefined(child.subtasks[0]).ref },
      symbol: 'x',
    }).type,
  ).toBe('invalid');
  expect((await p.commit()).result.type).toBe('ok');
});

it.each(['before', 'after'])(
  'memoizes a %s-write failure without deleting the source or replaying the copy',
  async (phase) => {
    const h = await taskEditPreparationHarness('- [ ] Target\n', {
      files: { 'z-source.md': '- [ ] Source\n' },
    });
    const source = expectDefined(h.index.list({ filePath: 'z-source.md' })[0]);
    let p = ready(await h.service.prepare(h.root, []));
    p = ready(
      await p.copySource({
        type: 'subtree',
        source: { type: 'task', ref: source.ref },
        parent: { type: 'task', ref: expectDefined(p.after).ref },
      }),
    );
    h.writes.mockImplementationOnce(async (file, update) => {
      if (phase === 'after') await h.process(file, update);
      throw new Error('Injected writer failure');
    });
    const result = await p.commit();
    expect(result).toMatchObject({ type: 'io-error' });
    expect(await p.commit()).toEqual(result);
    expect(h.writes).toHaveBeenCalledTimes(1);
    expect(h.index.list({ filePath: 'z-source.md' })[0]?.source.originalBlock).toBe('- [ ] Source');
  },
);

it.each([
  '- [ ] Same 📅 2026-01-01 📅 2026-01-02',
  '- [ ] Same\n\tunknown authored body',
  '- [ ] Same\n\t- 2020-01-02T10:00:00+00:00 → 2020-01-02T11:00:00+00:00',
])('holds residual source evidence: %s', async (text) => {
  const h = await taskEditPreparationHarness(`- [ ] Same\n${text}\n`);
  const p = ready(await h.service.prepare(h.root, []));
  expect(
    (await p.assessMerge({ type: 'task', ref: expectDefined(h.index.list()[1]).ref }))?.state,
  ).toBe('held');
});
it('holds cleanup when copied children reverse source order', async () => {
  const h = await taskEditPreparationHarness(
    '- [ ] Same\n- [ ] Same\n\t- [ ] First\n\t- [ ] Second\n',
  );
  const source = expectDefined(h.index.list()[1]);
  let p = ready(await h.service.prepare(h.root, []));
  for (const child of [...source.subtasks].reverse())
    p = ready(
      await p.copySource({
        type: 'subtree',
        source: { type: 'subtask', ref: child.ref },
        parent: { type: 'task', ref: expectDefined(p.after).ref },
      }),
    );
  expect((await p.assessMerge({ type: 'task', ref: source.ref }))?.state).toBe('held');
});
it('holds cross-note child identities whose incoming references have no migration proof', async () => {
  const h = await taskEditPreparationHarness('- [ ] Same\n', {
    files: { 'z-source.md': '- [ ] Same\n\t- [ ] Child ^child\n' },
  });
  const source = expectDefined(h.index.list({ filePath: 'z-source.md' })[0]);
  let p = ready(await h.service.prepare(h.root, []));
  p = ready(
    await p.copySource({
      type: 'subtree',
      source: { type: 'subtask', ref: expectDefined(source.subtasks[0]).ref },
      parent: { type: 'task', ref: expectDefined(p.after).ref },
    }),
  );
  expect((await p.assessMerge({ type: 'task', ref: source.ref }))?.state).toBe('held');
});

it('retains quoted comment payload and timestamp spelling while changing only its container', async () => {
  const h = await taskEditPreparationHarness(
    '- [ ] Target\r\n> - [ ] Source\r\n> \t- 2020-01-02T03:04:05Z: payload\r\n> \t  continuation\r\n',
  );
  const source = expectDefined(h.index.list()[1]);
  const original = expectDefined(source.comments[0]);
  const p = ready(
    await ready(await h.service.prepare(h.root, [])).copySource({
      type: 'comment',
      source: original.ref,
      parent: { type: 'task', ref: h.root.ref },
    }),
  );
  expect(p.after?.comments[0]?.timestamp?.raw).toBe('2020-01-02T03:04:05Z');
  expect(p.after?.comments[0]?.text).toBe('payload\ncontinuation');
  expect(p.after?.comments[0]?.ref.originalMarkdown).toBe(
    '\t- 2020-01-02T03:04:05Z: payload\r\n\t  continuation\r',
  );
  expect(h.writes).not.toHaveBeenCalled();
});

it('rejects a destination changed after preview and leaves both versions intact', async () => {
  const h = await taskEditPreparationHarness('- [ ] Target\n', {
    files: { 'z-source.md': '- [ ] Source\n' },
  });
  const source = expectDefined(h.index.list({ filePath: 'z-source.md' })[0]);
  let p = ready(await h.service.prepare(h.root, []));
  p = ready(
    await p.copySource({
      type: 'subtree',
      source: { type: 'task', ref: source.ref },
      parent: { type: 'task', ref: expectDefined(p.after).ref },
    }),
  );
  expect(
    (
      await h.service.execute({
        type: 'set-description',
        target: { type: 'task', ref: h.root.ref },
        text: 'Independent',
      })
    ).type,
  ).toBe('ok');
  expect((await p.commit()).type).toBe('invalid');
  expect(h.index.list({ filePath: 'tasks.md' })[0]?.subtasks).toHaveLength(0);
  expect(await h.read()).toContain('Independent');
  expect(h.index.list({ filePath: 'z-source.md' })[0]?.title).toBe('Source');
});

it('keeps a reviewed cross-note copy after source file replacement but rejects stale source selection', async () => {
  const h = await taskEditPreparationHarness('- [ ] Target\n', {
    files: { 'z-source.md': '- [ ] Source\n' },
  });
  const source = expectDefined(h.index.list({ filePath: 'z-source.md' })[0]);
  let p = ready(await h.service.prepare(h.root, []));
  p = ready(
    await p.copySource({
      type: 'subtree',
      source: { type: 'task', ref: source.ref },
      parent: { type: 'task', ref: expectDefined(p.after).ref },
    }),
  );
  const file = expectDefined(h.app.vault.getFileByPath('z-source.md') ?? undefined);
  await h.app.fileManager.trashFile(file);
  await h.app.vault.create('z-source.md', '- [ ] Replacement\n');
  expect((await p.commit()).type).toBe('ok');
  expect(h.index.list({ filePath: 'tasks.md' })[0]?.subtasks[0]?.title).toBe('Source');
  expect((await h.service.execute({ type: 'delete', ref: source.ref })).type).not.toBe('ok');
});

it('retains an unknown copy receipt after failed readback and never retries the writer', async () => {
  const h = await taskEditPreparationHarness('- [ ] Target\n', {
    files: { 'z-source.md': '- [ ] Source\n' },
  });
  const source = expectDefined(h.index.list({ filePath: 'z-source.md' })[0]);
  let p = ready(await h.service.prepare(h.root, []));
  p = ready(
    await p.copySource({
      type: 'subtree',
      source: { type: 'task', ref: source.ref },
      parent: { type: 'task', ref: expectDefined(p.after).ref },
    }),
  );
  h.writes.mockImplementationOnce(async (file, update) => {
    await h.process(file, update);
    throw new Error('Late failure');
  });
  const read = vi.spyOn(h.app.vault, 'read').mockRejectedValue(new Error('Unreadable'));
  const result = await p.commit();
  expect(result).toMatchObject({ type: 'io-error', contentState: 'unknown' });
  expect(await p.commit()).toEqual(result);
  expect(h.writes).toHaveBeenCalledTimes(1);
  read.mockRestore();
  expect(h.index.list({ filePath: 'z-source.md' })[0]?.title).toBe('Source');
});
it('holds anchored comment copies whose identity cannot safely be duplicated', async () => {
  const h = await taskEditPreparationHarness('- [ ] Target\n- [ ] Source\n\t- history ^comment\n');
  const source = expectDefined(h.index.list()[1]);
  const p = ready(await h.service.prepare(h.root, []));
  expect(
    (
      await p.copySource({
        type: 'comment',
        source: expectDefined(source.comments[0]).ref,
        parent: { type: 'task', ref: expectDefined(p.after).ref },
      })
    ).type,
  ).toBe('invalid');
});

it.each(['![[#Section]]', '![photo](./photo.png)', '[[#Section]]', '[photo][local]'])(
  'holds cross-file description reference meaning for %s',
  async (description) => {
    const content = `- [ ] Same\n\t- > ${description}\n`;
    const h = await taskEditPreparationHarness(content, { files: { 'z-source.md': content } });
    const source = expectDefined(h.index.list({ filePath: 'z-source.md' })[0]);
    const p = ready(await h.service.prepare(h.root, []));
    const report = await p.assessMerge({ type: 'task', ref: source.ref });
    expect(report?.state).toBe('held');
    expect(report?.entries).toContainEqual(
      expect.objectContaining({ kind: 'constraint', field: 'description-links', state: 'held' }),
    );
    expect(h.writes).not.toHaveBeenCalled();
  },
);

it('keeps historical copies and merge proof separate from new-tree comment authority', async () => {
  const before = '- [ ] Source #work\n\t- 2020-01-02: history\n\t- [ ] Child\n';
  const h = await taskEditPreparationHarness(before);
  try {
    const source = h.root;
    const comment = expectDefined(source.comments[0]);
    let p = await h.service.prepareCreateTree({
      destination: {
        type: 'explicit',
        destination: { filePath: 'tasks.md', insertion: { type: 'append' } },
      },
      tree: { markdownTitle: 'Target #work', description: 'Source' },
    });
    if (p.type !== 'ready') throw new Error('Missing creation');
    expect(p.sourceCopiesAvailable()).toBe(true);
    p = await p.copySource({
      type: 'comment',
      source: comment.ref,
      parent: { type: 'task', ref: p.after.ref },
    });
    if (p.type !== 'ready') throw new Error('Missing comment copy');
    p = await p.copySource({
      type: 'subtree',
      source: { type: 'subtask', ref: expectDefined(source.subtasks[0]).ref },
      parent: { type: 'task', ref: p.after.ref },
    });
    if (p.type !== 'ready') throw new Error('Missing subtree copy');
    expect(p.sourceCopiesAvailable()).toBe(true);
    expect(p.continueSourceComment(comment.ref)).toBeUndefined();
    expect(p.after.comments[0]?.ref.originalMarkdown).toBe(comment.ref.originalMarkdown);
    expect((await p.assessMerge({ type: 'task', ref: source.ref }))?.state).toBe('covered');
    expect(h.writes).not.toHaveBeenCalled();
    const candidate = p.after.source.originalBlock;
    expect(await p.commit()).toMatchObject({
      result: { type: 'ok' },
      destinationEffects: 'unchanged',
    });
    expect(h.writes).toHaveBeenCalledOnce();
    expect(h.index.list()[0]?.source.originalBlock).toBe(source.source.originalBlock);
    expect(h.index.list()[1]?.source.originalBlock).toBe(candidate);
    expect(await h.read()).toBe(`${before}${candidate}\n`);
  } finally {
    h.index.destroy();
  }
});

it.each(['before-assess', 'during-assess', 'before-copy', 'during-copy'])(
  'withholds new-tree source evidence after catalog changes %s',
  async (phase) => {
    const before = '- [ ] Source\n\t- 2020-01-02: history\n';
    const h = await taskEditPreparationHarness(before);
    try {
      const prepare = h.repository.prepareCreateRoot.bind(h.repository);
      const assess = vi.fn();
      const copy = vi.fn();
      vi.spyOn(h.repository, 'prepareCreateRoot').mockImplementation(async (...args) => {
        const prepared = await prepare(...args);
        if (prepared.type !== 'ready') return prepared;
        return {
          ...prepared,
          assessMerge: async (source) => {
            assess();
            const result = await prepared.assessMerge(source);
            if (phase === 'during-assess') h.catalog.replace([]);
            return result;
          },
          copySource: async (input) => {
            copy();
            const result = await prepared.copySource(input);
            if (phase === 'during-copy') h.catalog.replace([]);
            return result;
          },
        };
      });
      const p = await h.service.prepareCreateTree({
        destination: {
          type: 'explicit',
          destination: { filePath: 'tasks.md', insertion: { type: 'append' } },
        },
        tree: { markdownTitle: 'New' },
      });
      if (p.type !== 'ready') throw new Error('Missing creation');
      if (phase.startsWith('before')) h.catalog.replace([]);
      if (phase.endsWith('assess')) {
        expect(await p.assessMerge({ type: 'task', ref: h.root.ref })).toBeUndefined();
        expect(assess).toHaveBeenCalledTimes(phase.startsWith('before') ? 0 : 1);
      } else {
        expect(
          await p.copySource({
            type: 'comment',
            source: expectDefined(h.root.comments[0]).ref,
            parent: { type: 'task', ref: p.after.ref },
          }),
        ).toMatchObject({
          type: 'invalid',
          result: { type: 'invalid', issues: [{ field: 'settings' }] },
        });
        expect(copy).toHaveBeenCalledTimes(phase.startsWith('before') ? 0 : 1);
      }
      expect(p.after.comments).toEqual([]);
      expect(h.writes).not.toHaveBeenCalled();
      expect(await h.read()).toBe(before);
    } finally {
      h.index.destroy();
    }
  },
);
