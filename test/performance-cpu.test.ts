// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { cpuSummary } from '../tooling/performance/cpu.mts';

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
    const summary = cpuSummary(profile, map, false);
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
  });
});
