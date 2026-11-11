// @vitest-environment node
import { Platform } from 'obsidian';
import { describe, expect, it } from 'vitest';
import { cpuSummary, writeCpuEvidence } from '../tooling/performance/cpu.mts';
import { mainScriptEvidence } from '../tooling/performance/native-cdp';

describe('CPU evidence', () => {
  it('attributes sampled self and inclusive time separately and maps only plugin frames', () => {
    const frame = {
      functionName: 'minified',
      scriptId: '1',
      url: 'plugin:abyss-tasks',
      lineNumber: 0,
      columnNumber: 0,
    };
    const profile = {
      startTime: 0,
      endTime: 6000,
      nodes: [
        { id: 1, callFrame: { ...frame, functionName: '(root)', url: '' }, children: [2, 3] },
        { id: 2, callFrame: frame },
        { id: 3, callFrame: { ...frame, functionName: 'host', url: 'app://obsidian.md/app.js' } },
      ],
      samples: [2, 2, 3],
      timeDeltas: [1000, -100, 5100],
    };
    const map = {
      version: 3,
      sourceRoot: '',
      file: 'main.js',
      sources: ['src/example.ts'],
      sourcesContent: ['function original() {}'],
      names: ['original'],
      mappings: 'AAAAA',
    };
    const proof = mainScriptEvidence(
      { scriptId: '1', url: frame.url, startLine: 0, startColumn: 0, hash: 'runtime' },
      'compiled',
      { text: 'compiled', sha256: 'main' },
      frame,
    );
    if (proof === undefined) throw new Error('Missing proof');
    const summary = cpuSummary(profile, map, false, [proof]);
    expect(summary.sampledMs).toBe(6);
    expect(summary.frames.find((f) => f.name === 'original')).toMatchObject({
      selfMs: 4,
      inclusiveMs: 4,
      source: 'src/example.ts',
      line: 1,
    });
    expect(summary.frames.find((f) => f.name === 'host')?.source).toBe('app://obsidian.md/app.js');
    expect(summary.frames.find((f) => f.name === 'host')?.mapped).toBe(false);
    expect(summary.frames.find((f) => f.name === '(root)')?.inclusiveMs).toBe(6);
    expect(cpuSummary(profile, map, false, []).frames.every((f) => !f.mapped)).toBe(true);
  });
  it('maps only exact source-proven script IDs inside the saved-main interval across host wrapping', () => {
    const url =
      'app://obsidian.md/_plugin/host/profile-config%2Fplugins%2Fabyss-tasks?id=abyss-tasks';
    const sampled = { scriptId: '7', url };
    const parsed = {
      scriptId: '7',
      url: 'plugin:abyss-tasks',
      startLine: 2,
      startColumn: 3,
      hash: 'runtime',
    };
    const main = { text: 'code\nnext', sha256: 'main' };
    expect(mainScriptEvidence(parsed, 'contrary', main, sampled)).toBeUndefined();
    expect(mainScriptEvidence(parsed, `${main.text}${main.text}`, main, sampled)).toBeUndefined();
    expect(mainScriptEvidence(parsed, `  ${main.text}`, main, sampled)).toMatchObject({
      startLine: 2,
      startColumn: 5,
      endLine: 3,
      endColumn: 4,
    });
    const proof = mainScriptEvidence(parsed, `wrap\n  ${main.text}\nend`, main, sampled);
    expect(proof).toMatchObject({
      url,
      debuggerUrl: 'plugin:abyss-tasks',
      startLine: 3,
      startColumn: 2,
      endLine: 4,
      endColumn: 4,
      prefixCharacters: 7,
      suffixCharacters: 4,
      mainSha256: 'main',
    });
    if (proof === undefined) throw new Error('Missing proof');
    const frame = { functionName: 'compiled', scriptId: '7', url, lineNumber: 3, columnNumber: 2 };
    const nodes = [
      frame,
      { ...frame, scriptId: '8' },
      { ...frame, url: 'plugin:other' },
      { ...frame, url: 'plugin:abyss-tasks' },
      { ...frame, columnNumber: 1 },
      { ...frame, lineNumber: 4, columnNumber: 4 },
    ].map((callFrame, index) => ({ id: index + 1, callFrame }));
    const map = {
      version: 3,
      file: 'main.js',
      sourceRoot: '',
      sources: ['src/original.ts'],
      names: [],
      mappings: 'AAAA',
      sourcesContent: ['source'],
    };
    const summary = cpuSummary(
      { nodes, startTime: 0, endTime: 1000, samples: [1], timeDeltas: [1000] },
      map,
      false,
      [proof],
    );
    expect(summary.frames.filter((f) => f.mapped)).toEqual([
      expect.objectContaining({ source: 'src/original.ts', line: 1, column: 1 }),
    ]);
    expect(summary.frames.filter((f) => !f.mapped)).toHaveLength(5);
    expect(
      summary.frames.filter((f) => !f.mapped).every((f) => f.unmappedReason !== undefined),
    ).toBe(true);
  });
  it.each([
    { scriptId: '8', url: 'plugin:abyss-tasks' },
    { scriptId: '7', url: 'plugin:other' },
    { scriptId: '7', url: 'app://obsidian.md/_plugin/other?id=abyss-tasks' },
  ])('refuses an unbound debugger identity even with the exact whole main (%j)', (identity) => {
    const parsed = { ...identity, startLine: 0, startColumn: 0, hash: 'runtime' };
    const sampled = { scriptId: '7', url: 'app://obsidian.md/_plugin/host?id=abyss-tasks' };
    expect(
      mainScriptEvidence(parsed, 'compiled', { text: 'compiled', sha256: 'main' }, sampled),
    ).toBeUndefined();
  });
  it('refuses renderer evidence for a different saved production artifact', async () => {
    if (!Platform.isDesktop) throw new Error('CPU evidence tests require desktop');
    const { mkdtemp, rm, writeFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { default: path } = await import('node:path');
    const output = await mkdtemp(path.join(tmpdir(), 'abyss-cpu-'));
    try {
      await writeFile(path.join(output, 'main.js'), 'compiled');
      await writeFile(
        path.join(output, 'renderer-sources.json'),
        JSON.stringify({ scripts: [{ mainSha256: 'contrary' }] }),
      );
      await expect(writeCpuEvidence(output)).rejects.toThrow('does not match saved main');
    } finally {
      await rm(output, { recursive: true, force: true });
    }
  });
});
