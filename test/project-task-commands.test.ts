import { describe, expect, it, vi } from 'vitest';
import { createProjectIntegrationReads } from '../src/projects/projectIntegration';
import * as projectCommands from '../src/projects/projectTaskCommands';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import type { TaskReadEvent } from '../src/tasks/application/TaskIntegrationReadApi';
import { expectDefined, flushMicrotasks, metadataChangedEmitter } from './helpers';
import { publicApiHarness } from './support/publicApiHarness';

const dest = 'projects/A.md';
const src = 'source.md';
const tree = '- [ ] Same\n  - [ ] Child';

async function setup(content = tree) {
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.projects.membershipQuery = 'projects/';
  settings.projects.taskInsertionMode = 'prepend';
  settings.taskLifecycle.addCreatedDate = false;
  settings.taskPrefix = '';
  const h = await publicApiHarness(
    { [dest]: content, [src]: tree, 'projects/B.md': '' },
    { behaviorSettings: () => settings },
  );
  h.reads.activateOccurrences();
  const sources = h.index.projectSources();
  const reads = createProjectIntegrationReads(sources, () => settings.projects);
  const commands = projectCommands.createProjectTaskCommands(
    reads,
    sources,
    h.service,
    () => settings.projects,
  );
  const summary = reads.summary(dest);
  if (summary.type !== 'ok') throw new Error(summary.reason);
  const proof = expectDefined(summary.value);
  function prepareMove(path = src, child = false) {
    const page = h.reads.page({ path }, 8);
    if (page.type !== 'ok') throw new Error(page.reason);
    return commands.prepareMove(
      proof,
      expectDefined(page.value.nodes[child ? 1 : 0]),
      page.observation,
    );
  }
  return { ...h, commands, proof, prepareMove, settings };
}

describe('guarded project task commands at the vault writer', () => {
  it.each(['install', 'delivery', 'noop'] as const)(
    'rejects native bytes superseded during %s before metadata delivery',
    async (phase) => {
      const h = await setup();
      try {
        await h.index.refreshSourceExclusion((meta) => meta.tags.includes('#private'));
        const vault = h.app.vault,
          read = vault.read.bind(vault);
        let destinationReads = 0;
        vi.spyOn(vault, 'read').mockImplementation(async (file) => {
          const previous = await read(file);
          if (file.path === dest && ++destinationReads === (phase === 'delivery' ? 2 : 1)) {
            const privateNote = `#private\n${previous}`;
            await vault.adapter.write(dest, privateNote);
            file.stat = { ...file.stat, size: privateNote.length, mtime: file.stat.mtime + 1 };
          }
          return previous;
        });
        const run =
          phase === 'noop' ? h.prepareMove(dest) : h.commands.prepareCreate(h.proof, 'Task');
        const result = await run();
        expect(result).toMatchObject({
          outcome: phase === 'noop' ? 'failed' : 'changed',
          destinationCopy: phase === 'noop' ? 'unchanged' : 'committed',
          sourceRemoval: 'unchanged',
        });
        expect(result.task).toBeUndefined();
        expect(h.index.projectSources().get(dest)).toMatchObject({
          type: 'error',
          reason: 'incomplete',
        });
        expect(h.reads.page({ path: dest }, 1)).toMatchObject({ type: 'error' });
        const latest = await h.read(dest);
        expect(latest).toContain('#private');
        const file = expectDefined(vault.getFileByPath(dest));
        metadataChangedEmitter(h.app)(file, latest.slice('#private\n'.length), {});
        await flushMicrotasks();
        expect(h.index.projectSources().get(dest)).toMatchObject({
          type: 'error',
          reason: 'incomplete',
        });
        await h.external(dest, latest);
        expect(h.index.projectSources().get(dest)).toMatchObject({ type: 'ok', value: undefined });
        metadataChangedEmitter(h.app)(file, latest.slice('#private\n'.length), {});
        await flushMicrotasks();
        expect(h.index.projectSources().get(dest)).not.toMatchObject({
          type: 'ok',
          value: { path: dest },
        });
      } finally {
        h.dispose();
      }
    },
  );
  it('inserts a fresh occurrence before an identical task', async () => {
    const h = await setup('- [ ] Same');
    try {
      const old = expectDefined(h.index.list({ filePath: dest })[0]);
      const result = await h.commands.prepareCreate(h.proof, 'Same')();
      expect(result).toMatchObject({
        outcome: 'changed',
        destinationCopy: 'committed',
        task: { rootLine: 0 },
      });
      expect(result.task?.rootRevision).not.toBe(old.ref.revision);
      expect(await h.read(dest)).toBe('- [ ] Same\n- [ ] Same');
    } finally {
      h.dispose();
    }
  });
  it('checks the original root and project again when the same-note move hold ends', async () => {
    const h = await setup();
    try {
      const run = h.prepareMove(dest);
      const file = expectDefined(h.app.vault.getFileByPath(dest));
      const hold = h.index.holdStatisticsPublication.bind(h.index);
      vi.spyOn(h.index, 'holdStatisticsPublication').mockImplementationOnce(() => {
        const release = hold();
        return () => {
          release();
          file.stat.mtime += 1;
        };
      });
      expect(await run()).toMatchObject({
        outcome: 'failed',
        destinationCopy: 'unchanged',
        sourceRemoval: 'unchanged',
      });
    } finally {
      h.dispose();
    }
  });
  it('moves the whole selected root before an identical subtree', async () => {
    const h = await setup();
    try {
      const accepted: Array<Extract<TaskReadEvent, { type: 'accepted' }>> = [];
      h.reads.subscribe((event) => {
        if (event.type === 'accepted' && event.change.operation !== undefined) accepted.push(event);
      });
      const result = await h.prepareMove()();
      expect(result).toMatchObject({
        outcome: 'changed',
        destinationCopy: 'committed',
        sourceRemoval: 'committed',
        task: { filePath: dest, rootLine: 0 },
      });
      expect(await h.read(dest)).toBe(`${tree}\n${tree}`);
      expect(await h.read(src)).toBe('');
      expect(accepted).toHaveLength(2);
      expect(accepted[0]?.change.operation).toBe(accepted[1]?.change.operation);
      expect(
        accepted[0]?.change.witnesses
          .filter((w) => w.kind === 'created')
          .map((w) => w.after.nodeOffset),
      ).toEqual([0, 1]);
      expect(
        accepted[1]?.change.witnesses
          .filter((w) => w.kind === 'removed')
          .map((w) => w.before.nodeOffset),
      ).toEqual([0, 1]);
    } finally {
      h.dispose();
    }
  });

  it('serializes two moves of one source to different projects', async () => {
    const h = await setup();
    const other = 'projects/B.md';
    let release = (): void => {};
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered = (): void => {};
    const firstCopy = new Promise<void>((resolve) => {
      entered = resolve;
    });
    try {
      const reads = createProjectIntegrationReads(
        h.index.projectSources(),
        () => h.settings.projects,
      );
      const summary = reads.summary(other),
        page = h.reads.page({ path: src }, 1);
      if (summary.type !== 'ok' || page.type !== 'ok') throw new Error('Missing source or project');
      const runSecond = createProjectTaskCommandsFor(h, reads).prepareMove(
        expectDefined(summary.value),
        expectDefined(page.value.nodes[0]),
        page.observation,
      );
      const vault = h.app.vault,
        process = vault.process.bind(vault);
      vi.spyOn(vault, 'process').mockImplementationOnce(async (file, transform) => {
        const content = await process(file, transform);
        entered();
        await blocked;
        return content;
      });
      const first = h.prepareMove()();
      await firstCopy;
      const second = runSecond();
      await new Promise((resolve) => window.setTimeout(resolve, 0));
      release();
      expect(await first).toMatchObject({ outcome: 'changed', sourceRemoval: 'committed' });
      expect(await second).toMatchObject({
        outcome: 'failed',
        destinationCopy: 'unchanged',
        sourceRemoval: 'unchanged',
      });
      expect(await h.read(other)).toBe('');
      expect(await h.read(src)).toBe('');
    } finally {
      release();
      h.dispose();
    }
  });

  it.each([
    'source-hidden',
    'source-replaced',
    'destination-replaced',
    'destination-edited',
    'source-throw',
  ] as const)('keeps confirmed copy across the second phase: %s', async (race) => {
    const h = await setup();
    try {
      const process = h.app.vault.process.bind(h.app.vault);
      vi.spyOn(h.app.vault, 'process').mockImplementation(async (file, transform) => {
        if (file.path === src) {
          if (race === 'source-hidden')
            await h.index.refreshSourceExclusion((meta) => meta.filePath === src);
          if (race === 'source-replaced' || race === 'destination-replaced') {
            const old =
              race === 'source-replaced' ? file : expectDefined(h.app.vault.getFileByPath(dest));
            const content = await h.app.vault.read(old);
            const path = old.path;
            await h.app.fileManager.trashFile(old);
            const replacement = await h.app.vault.create(path, content);
            if (path === src) return process(replacement, transform);
          }
          if (race === 'destination-edited')
            await h.app.vault.modify(
              expectDefined(h.app.vault.getFileByPath(dest)),
              'Discarded copy',
            );
          if (race === 'source-throw') {
            await process(file, transform);
            throw new Error('Lost acknowledgement');
          }
        }
        return process(file, transform);
      });
      const result = await h.prepareMove()();
      expect(result).toMatchObject({
        outcome: 'failed',
        destinationCopy: 'committed',
        sourceRemoval: race === 'source-throw' ? 'unknown' : 'unchanged',
      });
      expect(await h.read(src)).toBe(race === 'source-throw' ? '' : tree);
      if (race === 'destination-edited' || race === 'destination-replaced')
        expect(result.task).toBeUndefined();
      expect(await h.read(dest)).toBe(
        race === 'destination-edited' ? 'Discarded copy' : `${tree}\n${tree}`,
      );
    } finally {
      h.dispose();
    }
  });

  it.each([
    'source-hidden',
    'source-edited',
    'destination-edited',
    'child',
    'stale-root',
    'removal-excludes',
    'copy-throw',
  ] as const)('checks source and destination before copying: %s', async (race) => {
    const h = await setup();
    try {
      if (race === 'removal-excludes')
        await h.index.refreshSourceExclusion(
          (meta) => meta.filePath === src && !meta.tags.includes('#allow'),
        );
      if (race === 'removal-excludes') await h.external(src, '- [ ] Root #allow');
      const run = h.prepareMove(src, race === 'child');
      if (race === 'stale-root') await h.external(src, '- [ ] Other');
      const process = h.app.vault.process.bind(h.app.vault);
      vi.spyOn(h.app.vault, 'process').mockImplementationOnce(async (file, transform) => {
        if (race === 'source-hidden')
          await h.index.refreshSourceExclusion((meta) => meta.filePath === src);
        if (race === 'source-edited')
          await h.app.vault.modify(expectDefined(h.app.vault.getFileByPath(src)), 'User edited');
        if (race === 'destination-edited') return process(file, () => transform('User edited'));
        const written = await process(file, transform);
        if (race === 'copy-throw') throw new Error('Lost acknowledgement');
        return written;
      });
      const result = await run();
      expect(result).toMatchObject({
        outcome: 'failed',
        destinationCopy: race === 'copy-throw' ? 'unknown' : 'unchanged',
        sourceRemoval: 'unchanged',
      });
      const expectedDestination: Partial<Record<typeof race, string>> = {
        'destination-edited': 'User edited',
        'copy-throw': `${tree}\n${tree}`,
      };
      const expectedSource: Partial<Record<typeof race, string>> = {
        'stale-root': '- [ ] Other',
        'removal-excludes': '- [ ] Root #allow',
        'source-edited': 'User edited',
      };
      expect(await h.read(dest)).toBe(expectedDestination[race] ?? tree);
      expect(await h.read(src)).toBe(expectedSource[race] ?? tree);
    } finally {
      h.dispose();
    }
  });
  it('checks capture settings in the actual process callback', async () => {
    const h = await setup();
    const process = h.app.vault.process.bind(h.app.vault);
    vi.spyOn(h.app.vault, 'process').mockImplementationOnce((file, transform) => {
      h.settings.taskPrefix = '#private';
      return process(file, transform);
    });
    try {
      expect(await h.commands.prepareCreate(h.proof, 'Task')()).toMatchObject({
        outcome: 'failed',
        destinationCopy: 'unchanged',
      });
      expect(await h.read(dest)).toBe(tree);
    } finally {
      h.dispose();
    }
  });
  it('keeps the acknowledged copy when its readback fails, and never attempts removal', async () => {
    const h = await setup();
    try {
      const process = h.app.vault.process.bind(h.app.vault);
      vi.spyOn(h.app.vault, 'process').mockImplementationOnce(async (file, transform) => {
        const result = await process(file, transform);
        vi.spyOn(h.app.vault, 'read').mockRejectedValueOnce(new Error('Read failed'));
        return result;
      });
      const result = await h.prepareMove()();
      expect(result).toMatchObject({
        outcome: 'failed',
        destinationCopy: 'committed',
        sourceRemoval: 'unchanged',
      });
      expect(result.task).toBeUndefined();
      expect(await h.read(src)).toBe(tree);
      expect(await h.read(dest)).toBe(`${tree}\n${tree}`);
    } finally {
      h.dispose();
    }
  });
  it('removes only the selected occurrence between identical source roots', async () => {
    const h = await setup();
    try {
      await h.external(src, `${tree}\n## Middle\n${tree}\n## End\n${tree}`);
      const page = h.reads.page({ path: src }, 10);
      if (page.type !== 'ok') throw new Error(page.reason);
      const selected = expectDefined(page.value.nodes.find((node) => node.line === 3));
      const result = await h.commands.prepareMove(h.proof, selected, page.observation)();
      expect(result).toMatchObject({
        outcome: 'changed',
        destinationCopy: 'committed',
        sourceRemoval: 'committed',
      });
      expect(await h.read(src)).toBe(`${tree}\n## Middle\n## End\n${tree}`);
    } finally {
      h.dispose();
    }
  });

  it.each([src, dest])(
    'observes a changed native peer stamp while the index still has old bytes: %s',
    async (peer) => {
      const h = await setup();
      try {
        const vault = h.app.vault,
          process = vault.process.bind(vault);
        vi.spyOn(vault, 'process').mockImplementation(async (file, transform) => {
          if (file.path !== peer) {
            const other = expectDefined(vault.getFileByPath(peer));
            await vault.adapter.write(peer, 'Unobserved edit');
            other.stat = {
              ...other.stat,
              size: 'Unobserved edit'.length,
              mtime: other.stat.mtime + 1,
            };
          }
          return process(file, transform);
        });
        const result = await h.prepareMove()();
        expect(result).toMatchObject({
          outcome: 'failed',
          destinationCopy: peer === src ? 'unchanged' : 'committed',
          sourceRemoval: 'unchanged',
        });
        expect(await h.read(src)).toBe(peer === src ? 'Unobserved edit' : tree);
      } finally {
        h.dispose();
      }
    },
  );
  it('keeps ordinary multiline task capture available in an explicitly selected note', async () => {
    const h = await setup();
    try {
      const result = await h.service.execute({
        type: 'create',
        destination: {
          type: 'explicit',
          destination: { filePath: src, insertion: { type: 'prepend' } },
        },
        markdownBody: 'Capture\n  - [ ] Nested',
      });
      expect(result).toMatchObject({ type: 'ok', changed: true });
      expect(await h.read(src)).toBe(`- [ ] Capture\n  - [ ] Nested\n${tree}`);
      expect(await h.read(dest)).toBe(tree);
    } finally {
      h.dispose();
    }
  });
  it('keeps newer private destination metadata when an older readback resolves', async () => {
    const h = await setup();
    try {
      await h.index.refreshSourceExclusion((meta) => meta.tags.includes('#private'));
      const vault = h.app.vault,
        process = vault.process.bind(vault),
        read = vault.read.bind(vault);
      vi.spyOn(vault, 'process').mockImplementationOnce(async (file, transform) => {
        const content = await process(file, transform);
        vi.spyOn(vault, 'read').mockImplementationOnce(async (target) => {
          const prior = await read(target);
          await h.external(dest, `#private\n${prior}`);
          return prior;
        });
        return content;
      });
      const result = await h.prepareMove()();
      expect(result).toMatchObject({
        outcome: 'failed',
        destinationCopy: 'committed',
        sourceRemoval: 'unchanged',
      });
      expect(result.task).toBeUndefined();
      expect(h.index.projectSources().get(dest)).toMatchObject({ type: 'ok', value: undefined });
      expect(await h.read(src)).toBe(tree);
    } finally {
      h.dispose();
    }
  });

  it.each(['append', 'section'] as const)(
    'applies %s capture policy, prefix and lifecycle',
    async (mode) => {
      const h = await setup('# Work');
      try {
        h.settings.projects.taskInsertionMode = mode;
        h.settings.projects.taskInsertionSection = 'Tasks';
        h.settings.taskPrefix = '#work';
        h.settings.taskLifecycle.addCreatedDate = true;
        const reads = createProjectIntegrationReads(
          h.index.projectSources(),
          () => h.settings.projects,
        );
        const summary = reads.summary(dest);
        if (summary.type !== 'ok') throw new Error(summary.reason);
        const commands = createProjectTaskCommandsFor(h, reads);
        expect(await commands.prepareCreate(expectDefined(summary.value), 'Next')()).toMatchObject({
          outcome: 'changed',
        });
        const bytes = await h.read(dest);
        expect(bytes).toContain('#work');
        expect(bytes).toContain('2026-08-01');
        expect(bytes.includes('Tasks')).toBe(mode === 'section');
        expect(await h.read(src)).toBe(tree);
      } finally {
        h.dispose();
      }
    },
  );

  it.each(['prefix', 'title', 'replacement', 'newlines', 'same-revision'] as const)(
    'protects exact project create: %s',
    async (race) => {
      const h = await setup();
      try {
        if (race === 'prefix') h.settings.taskPrefix = '#hidden';
        await h.index.refreshSourceExclusion((meta) => meta.tags.includes('#hidden'));
        const reads = createProjectIntegrationReads(
          h.index.projectSources(),
          () => h.settings.projects,
        );
        const summary = reads.summary(dest);
        if (summary.type !== 'ok') throw new Error(summary.reason);
        const proof = expectDefined(summary.value);
        const commands = createProjectTaskCommandsFor(h, reads);
        const titles: Partial<Record<typeof race, string>> = {
          title: 'Task #hidden',
          newlines: 'Task\n- [ ] Another',
        };
        const run = commands.prepareCreate(proof, titles[race] ?? 'Task');
        if (race === 'replacement') {
          const process = h.app.vault.process.bind(h.app.vault);
          vi.spyOn(h.app.vault, 'process').mockImplementationOnce(async (file, transform) => {
            await h.app.fileManager.trashFile(file);
            return process(await h.app.vault.create(dest, tree), transform);
          });
        }
        if (race === 'same-revision') {
          const results = await Promise.all([run(), commands.prepareCreate(proof, 'Other')()]);
          expect(results.map((result) => result.outcome)).toEqual(['changed', 'failed']);
          expect(await h.read(dest)).toBe(`- [ ] Task\n${tree}`);
        } else {
          expect(await run()).toMatchObject({ outcome: 'failed', destinationCopy: 'unchanged' });
          expect(await h.read(dest)).toBe(tree);
        }
      } finally {
        h.dispose();
      }
    },
  );

  it.each(['healthy', 'project-changed', 'task-changed'] as const)(
    'requires both read proofs for same-file no-op: %s',
    async (race) => {
      const h = await setup();
      try {
        const run = h.prepareMove(dest);
        if (race === 'project-changed') h.settings.projects.membershipQuery = 'another/';
        if (race === 'task-changed') h.index.updateIntegrationSemantics('new-statuses');
        expect(await run()).toMatchObject({
          outcome: race === 'healthy' ? 'noop' : 'failed',
          destinationCopy: 'unchanged',
          sourceRemoval: 'unchanged',
        });
        expect(await h.read(dest)).toBe(tree);
      } finally {
        h.dispose();
      }
    },
  );
});

function createProjectTaskCommandsFor(
  h: Awaited<ReturnType<typeof setup>>,
  reads: ReturnType<typeof createProjectIntegrationReads>,
) {
  return projectCommands.createProjectTaskCommands(
    reads,
    h.index.projectSources(),
    h.service,
    () => h.settings.projects,
  );
}
