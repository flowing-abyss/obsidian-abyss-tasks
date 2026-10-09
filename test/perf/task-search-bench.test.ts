import { Platform } from 'obsidian';
import { expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../../src/settings/defaults';
import { fallbackSearchWords, prepareSearchQuery } from '../../src/tasks/domain/searchMatchPolicy';
import { taskTreeNodes } from '../../src/tasks/domain/taskSearchProjection';
import { createMiniSearchTaskEngine } from '../../src/tasks/infrastructure/search/MiniSearchTaskEngine';
import { createCanonicalSearchHarness } from '../support/taskSearchHarness';
import { TYPESCRIPT_PROGRAM_TIMEOUT_MS } from '../support/timeouts';

it(
  'accepts the canonical 50k corpus and compares identical projections with the direct engine',
  async () => {
    if (!Platform.isDesktop) throw new Error('Local corpus benchmark requires desktop file access');
    const { readFile } = await import('node:fs/promises');
    const directory =
      '/Users/flowing-abyss/Main/obsidian-task-calendar/docs/research/search-stress-2026-10-04';
    const manifest = JSON.parse(await readFile(`${directory}/fixture-manifest.json`, 'utf8')) as {
      files: Array<{ path: string }>;
    };
    const quality = JSON.parse(await readFile(`${directory}/quality-cases.json`, 'utf8')) as {
      cases: Array<{ query: string }>;
    };
    const files: Record<string, string> = {};
    for (const file of manifest.files)
      files[file.path.replace(/^markdown\//u, '')] = await readFile(
        `${directory}/${file.path}`,
        'utf8',
      );
    const acceptedAt = performance.now();
    const h = await createCanonicalSearchHarness(files, DEFAULT_SETTINGS);
    const acceptedMs = performance.now() - acceptedAt;
    const source = h.index.searchSource();
    const engine = createMiniSearchTaskEngine(fallbackSearchWords);
    let nodes = 0,
      roots = 0,
      comments = 0,
      projectedUnits = 0;
    const directAt = performance.now();
    for (const file of source.files()) {
      engine.replaceBegin(file.path);
      for (const document of source.documents(file)) {
        nodes++;
        roots += Number(document.id === document.rootId);
        projectedUnits +=
          document.title.length +
          document.description.length +
          document.comments.length +
          document.tags.length +
          document.metadata.length +
          document.links.length +
          document.sourcePath.length;
        engine.add([document]);
      }
      engine.replaceCommit(file.path);
      for (const root of h.index.list({ filePath: file.path }))
        for (const task of taskTreeNodes(root)) comments += task.node.comments.length;
    }
    const directBuildMs = performance.now() - directAt;
    expect({ files: source.files().length, roots, nodes, comments }).toEqual({
      files: 321,
      roots: 50000,
      nodes: 130020,
      comments: 230026,
    });
    const signal = new AbortController().signal;
    const buildAt = performance.now();
    const first = await h.search.open({ kind: 'roots', query: 'estuary' }, signal);
    h.search.release(first);
    const serviceBuildMs = performance.now() - buildAt;
    const times: number[] = [];
    for (const query of quality.cases.map((row) => row.query)) {
      const expected = engine.search({
        kind: 'roots',
        query: prepareSearchQuery(query, fallbackSearchWords),
        includeSourcePath: false,
      });
      const at = performance.now();
      const cursor = await h.search.open({ kind: 'roots', query }, signal);
      expect(cursor.total).toBe(expected.length);
      let offset = 0;
      do {
        const page = await h.search.read(cursor, offset, 200, signal);
        expect(page.hits).toEqual(
          expected
            .slice(offset, offset + 200)
            .map((hit) => ({ address: source.address(hit.id), score: hit.score })),
        );
        offset += page.hits.length;
        if (page.done) break;
      } while (offset < cursor.total);
      times.push(performance.now() - at);
    }
    times.sort((a, b) => a - b);
    console.debug(
      JSON.stringify({
        kind: 'node-inline-control-not-native',
        acceptedMs,
        directBuildMs,
        serviceBuildMs,
        projectedUnits,
        queries: times.length,
        fullVectorP50: times[Math.floor(times.length * 0.5)],
        fullVectorP95: times[Math.floor(times.length * 0.95)],
      }),
    );
    engine.dispose();
    h.close();
  },
  TYPESCRIPT_PROGRAM_TIMEOUT_MS,
);
