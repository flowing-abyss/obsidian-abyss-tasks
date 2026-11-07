import { describe, expect, it } from 'vitest';
import { ready, taskEditPreparationHarness } from '../support/taskEditPreparationHarness';

async function prepared() {
  const h = await taskEditPreparationHarness('- [ ] Root\n- [ ] Sibling\n');
  const p = ready(
    await h.service.prepare(h.root, [
      {
        type: 'patch',
        target: { type: 'task', ref: h.root.ref },
        patch: { markdownTitle: { type: 'set', value: 'Changed' } },
      },
    ]),
  );
  return { ...h, p };
}

describe('strict prepared root commit', () => {
  it.each(['root', 'sibling'])(
    'rejects concurrent %s edits inside the write callback',
    async (target) => {
      const h = await prepared();
      const process = h.process;
      const external =
        target === 'root' ? '- [ ] External\n- [ ] Sibling\n' : '- [ ] Root\n- [ ] External\n';
      h.writes.mockImplementationOnce(async (file, callback) => {
        await h.app.vault.modify(file, external);
        return process(file, callback);
      });
      expect((await h.p.commit()).type).not.toBe('ok');
      expect(await h.read()).toBe(external);
    },
  );

  it('rejects a replacement file even with the same bytes', async () => {
    const h = await prepared();
    await h.app.vault.rename(h.file, 'old.md');
    const replacement = await h.app.vault.create('tasks.md', '- [ ] Root\n- [ ] Sibling\n');
    expect((await h.p.commit()).type).not.toBe('ok');
    expect(await h.app.vault.read(replacement)).toBe('- [ ] Root\n- [ ] Sibling\n');
  });

  it('rejects semantics changes after preparation', async () => {
    const h = await prepared();
    h.writes.mockImplementationOnce(async (file, callback) => {
      h.index.updateIntegrationSemantics('changed');
      return h.process(file, callback);
    });
    expect((await h.p.commit()).type).not.toBe('ok');
    expect(await h.read()).toBe('- [ ] Root\n- [ ] Sibling\n');
  });

  it('rejects a candidate that would move the source outside permitted scope', async () => {
    const h = await taskEditPreparationHarness('- [ ] Root\n', {
      index: {
        excludeSource: (source) => source.tags.includes('#excluded'),
      },
    });
    const p = ready(
      await h.service.prepare(h.root, [
        {
          type: 'patch',
          target: { type: 'task', ref: h.root.ref },
          patch: { tags: { add: ['#excluded'] } },
        },
      ]),
    );
    expect((await p.commit()).type).not.toBe('ok');
    expect(await h.read()).toBe('- [ ] Root\n');
  });

  it('rejects a scope change inside the writer even when bytes are unchanged', async () => {
    const h = await prepared();
    h.writes.mockImplementationOnce(async (file, callback) => {
      await h.index.refreshSourceExclusion(() => true);
      return h.process(file, callback);
    });
    expect((await h.p.commit()).type).not.toBe('ok');
    expect(await h.read()).toBe('- [ ] Root\n- [ ] Sibling\n');
  });

  it.each([false, true])(
    'never retries or reports saved after a rejected write (effect=%s)',
    async (effect) => {
      const h = await prepared();
      const process = h.process;
      h.writes.mockImplementationOnce(async (file, callback) => {
        if (effect) await process(file, callback);
        throw new Error('write failed');
      });
      const receipt = await h.p.commit();
      expect(receipt).toMatchObject({
        type: 'io-error',
        contentState: effect ? 'unknown' : 'unchanged',
      });
      expect(await h.p.commit()).toEqual(receipt);
      expect(h.writes).toHaveBeenCalledTimes(1);
    },
  );
});
