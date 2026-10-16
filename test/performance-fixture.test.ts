import { describe, expect, it } from 'vitest';
import { TaskIndex } from '../src/tasks/infrastructure/TaskIndex';
import { createFixture, FIXTURE_FOLDER } from '../tooling/performance/fixture.mts';
import { canonicalStatusCatalog, createAppWithFiles, seedTaskCache } from './helpers';

describe('performance corpus', () => {
  it('is reproducible and changes identity when the calendar anchor changes', () => {
    const fixture = createFixture('2026-10-16');
    expect(fixture).toEqual(createFixture('2026-10-16'));
    expect(fixture.digest).not.toBe(createFixture('2026-10-17').digest);
    expect(() => createFixture('2026-02-31')).toThrow();
  });
  it('exercises real task projection, recurrence, dependencies, time and archive history', async () => {
    const fixture = createFixture('2026-10-16');
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
      expect(nodes).toHaveLength(6000);
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
      expect(
        Object.keys(fixture.files).filter((p) => p.startsWith(`${FIXTURE_FOLDER}/projects/`)),
      ).toHaveLength(100);
    } finally {
      index.destroy();
    }
  });
});
