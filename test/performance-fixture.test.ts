import { describe, expect, it, vi } from 'vitest';
import { TaskIndex } from '../src/tasks/infrastructure/TaskIndex';
import { createFixture, FIXTURE_FOLDER } from '../tooling/performance/fixture.mts';
import { indexScenarios } from '../tooling/performance/native-scenarios';
import type { Host } from '../tooling/performance/native-types';
import {
  canonicalStatusCatalog,
  createAppWithFiles,
  expectDefined,
  seedTaskCache,
} from './helpers';

describe('performance corpus', () => {
  it('is reproducible and changes identity when the calendar anchor changes', () => {
    const fixture = createFixture('2026-10-16');
    expect(fixture).toEqual(createFixture('2026-10-16'));
    expect(fixture.digest).toBe('65e8094d27abffbb476ba5115fd03fd5e57cd4a752ebd90b49f21d647de2431d');
    expect(fixture.digest).not.toBe(createFixture('2026-10-17').digest);
    expect(() => createFixture('2026-02-31')).toThrow();
  });
  it('adds a deterministic wide root without changing files or the standard corpus', () => {
    const standard = createFixture('2026-10-16');
    const wide = createFixture('2026-10-16', 'wide-tree');
    expect(wide).toMatchObject({
      kind: 'wide-tree',
      roots: 4000,
      nodes: 6999,
      maxChildrenPerRoot: 1000,
    });
    expect(standard).toMatchObject({
      kind: 'standard',
      roots: 4000,
      nodes: 6000,
      maxChildrenPerRoot: 1,
    });
    expect(wide.largestRootBytes).toBeGreaterThanOrEqual(53000);
    expect(Object.keys(wide.files)).toEqual(Object.keys(standard.files));
    expect(wide.digest).not.toBe(standard.digest);
    expect(createFixture('2026-10-16', 'wide-tree')).toEqual(wide);
  });
  it.each(['standard', 'wide-tree'] as const)(
    'exercises real task projection, recurrence, dependencies, time and archive history (%s)',
    async (kind) => {
      const fixture = createFixture('2026-10-16', kind);
      const app = await createAppWithFiles(fixture.files);
      for (const [path, content] of Object.entries(fixture.files)) {
        seedTaskCache(
          app,
          path,
          content
            .split('\n')
            .flatMap((line, index) =>
              line.startsWith('- [') ? [{ task: ' ', parent: -1, line: index }] : [],
            ),
        );
      }
      const index = new TaskIndex(app, {
        statusCatalog: canonicalStatusCatalog(),
        excludeSource: (source) => source.filePath.endsWith('/archive.md'),
        statisticsFileKind: (path) => (path.endsWith('/archive.md') ? 'archive' : 'live'),
      });
      try {
        await index.initialize();
        const nodes = index.listNodes().map((entry) => entry.node);
        expect(index.list()).toHaveLength(4000);
        expect(nodes).toHaveLength(kind === 'standard' ? 6000 : 6999);
        expect(nodes.some((node) => node.title.startsWith('Archived '))).toBe(false);
        const root = expectDefined(index.list().find((task) => task.dependencyId === 'profile-0'));
        expect(root.subtasks).toHaveLength(kind === 'standard' ? 1 : 1000);
        const spans = nodes.filter(
          (n) => n.planning.start !== undefined && n.planning.due !== undefined,
        );
        expect(spans.length).toBeGreaterThan(100);
        expect(spans.length).toBeLessThan(400);
        expect(
          spans.every(
            (n) =>
              Date.parse(n.planning.due ?? '') - Date.parse(n.planning.start ?? '') <= 7 * 86400000,
          ),
        ).toBe(true);
        expect(nodes.filter((n) => n.planning.due === undefined).length).toBeGreaterThan(500);
        expect(nodes.filter((n) => n.recurrence !== undefined).length).toBeGreaterThan(150);
        expect(nodes.flatMap((n) => n.timeEntries).length).toBeGreaterThan(1000);
        expect(nodes.flatMap((n) => n.comments).length).toBeGreaterThan(1000);
        expect(nodes.flatMap((n) => n.dependsOn).length).toBeGreaterThan(500);
        expect(nodes.filter((n) => n.description !== undefined).length).toBeGreaterThan(1000);
        const off = index.subscribeStatistics(() => {});
        try {
          await index.whenStatisticsSettled();
          const history = index.readStatistics().files.filter((f) => f.kind === 'archive');
          expect(history.flatMap((f) => f.roots)).toHaveLength(300);
        } finally {
          off();
        }
        if (kind === 'wide-tree') {
          Object.defineProperty(app, 'plugins', {
            value: { plugins: { 'abyss-tasks': { queries: index, taskStatistics: index } } },
          });
          const modify = app.vault.modify.bind(app.vault);
          const writes: string[] = [];
          const spy = vi.spyOn(app.vault, 'modify').mockImplementation(async (file, content) => {
            writes.push(content);
            await modify(file, content);
            seedTaskCache(
              app,
              file.path,
              content
                .split('\n')
                .flatMap((line, index) =>
                  line.startsWith('- [') ? [{ task: ' ', parent: -1, line: index }] : [],
                ),
              { budget: content.includes('budget: 1001\n') ? 1001 : 1000 },
            );
          });
          const facts: Record<string, unknown> = {};
          try {
            await indexScenarios(
              app as Host,
              {
                vault: 'dev-vault-tasks',
                fixtureFolder: FIXTURE_FOLDER,
                anchor: fixture.anchor,
                fixtureKind: kind,
                expectedRoots: 4000,
                expectedNodes: 6999,
                startup: false,
                viewport: '1024x768',
              },
              async (id, action) => {
                facts[id] = await action();
              },
            );
            const last = expectDefined(
              index
                .listNodes()
                .find(
                  (entry) =>
                    entry.node.title.startsWith('Wide child 999 ') &&
                    entry.node.title.endsWith(' edited'),
                ),
            );
            expect(last.root.dependencyId).toBe('profile-0');
            expect(last.path).toHaveLength(1);
            expect(last.target.type).toBe('subtask');
            if (last.target.type === 'subtask')
              expect(last.target.ref.parent).toEqual({ type: 'task', ref: last.root.ref });
            expect(index.list()).toHaveLength(4000);
            expect(index.listNodes()).toHaveLength(6999);
            expect(facts['index.wide-child-edit']).toMatchObject({
              roots: 4000,
              nodes: 6999,
              children: 1000,
              edits: 1,
            });
            expect(facts['index.metadata-only']).toMatchObject({
              roots: 4000,
              nodes: 6999,
              taskBytesUnchanged: true,
              accepted: true,
            });
            expect(writes).toHaveLength(2);
            const childEdit = expectDefined(writes[0]);
            const metadataEdit = expectDefined(writes[1]);
            expect(
              childEdit.replace('coverage edited #profile/child', 'coverage #profile/child'),
            ).toBe(fixture.files[`${FIXTURE_FOLDER}/projects/Project-000.md`]);
            expect(metadataEdit.replace('budget: 1001\n', 'budget: 1000\n')).toBe(childEdit);
            expect(metadataEdit.split('---\n')[2]).toBe(childEdit.split('---\n')[2]);
          } finally {
            spy.mockRestore();
          }
        }
        expect(
          Object.keys(fixture.files).filter((p) => p.startsWith(`${FIXTURE_FOLDER}/projects/`)),
        ).toHaveLength(100);
      } finally {
        index.destroy();
      }
    },
  );
});
