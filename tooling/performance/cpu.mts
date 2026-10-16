import { readFile, readdir, writeFile } from 'node:fs/promises';
import type { Profiler } from 'node:inspector';
import { SourceMap, type SourceMapping } from 'node:module';
import path from 'node:path';

interface FrameSummary {
  name: string;
  source: string;
  line: number;
  column: number;
  mapped: boolean;
  selfMs: number;
  inclusiveMs: number;
}
interface CpuSummary {
  sampledMs: number;
  method: 'uniform-sample-weight';
  frames: FrameSummary[];
}
type MapPayload = ConstructorParameters<typeof SourceMap>[0];
const WORKER_PREFIX = '/* abyss-task-search-worker */';

function mapping(
  frame: Profiler.ProfileNode['callFrame'],
  map: SourceMap,
  worker: boolean,
): Partial<SourceMapping> & { name?: string } {
  const mapped = frame.url === 'plugin:abyss-tasks' || (worker && frame.url.startsWith('blob:'));
  const column = frame.columnNumber - (worker && frame.lineNumber === 0 ? WORKER_PREFIX.length : 0);
  return mapped && column >= 0 ? map.findEntry(frame.lineNumber, column) : {};
}

function frameLocation(
  frame: Profiler.ProfileNode['callFrame'],
  map: SourceMap,
  worker: boolean,
): Omit<FrameSummary, 'selfMs' | 'inclusiveMs'> {
  const entry = mapping(frame, map, worker);
  return {
    name: entry.name ?? frame.functionName,
    mapped: entry.originalSource !== undefined,
    source: entry.originalSource ?? (frame.url === '' ? '(native)' : frame.url),
    line: (entry.originalLine ?? frame.lineNumber) + 1,
    column: (entry.originalColumn ?? frame.columnNumber) + 1,
  };
}

function addSample(
  id: number,
  duration: number,
  rows: Map<number, FrameSummary>,
  parents: Map<number, number>,
): void {
  const leaf = rows.get(id);
  if (leaf === undefined || duration < 0) throw new Error('Invalid CPU sample');
  leaf.selfMs += duration;
  const visitedNodes = new Set<number>();
  const visitedFrames = new Set<FrameSummary>();
  for (let node: number | undefined = id; node !== undefined; node = parents.get(node)) {
    if (visitedNodes.has(node)) throw new Error('Cyclic CPU call tree');
    visitedNodes.add(node);
    const row = rows.get(node);
    if (row !== undefined && !visitedFrames.has(row)) {
      row.inclusiveMs += duration;
      visitedFrames.add(row);
    }
  }
}

export function cpuSummary(
  profile: Profiler.Profile,
  payload: MapPayload,
  worker: boolean,
): CpuSummary {
  if (profile.samples === undefined || profile.timeDeltas?.length !== profile.samples.length)
    throw new Error('CPU profile has no aligned samples and time deltas');
  const sourceMap = new SourceMap(payload);
  const parents = new Map<number, number>();
  const rows = new Map<number, FrameSummary>();
  const merged = new Map<string, FrameSummary>();
  for (const node of profile.nodes) {
    for (const child of node.children ?? []) parents.set(child, node.id);
    const location = frameLocation(node.callFrame, sourceMap, worker);
    const key = JSON.stringify(location);
    const row = merged.get(key) ?? { ...location, selfMs: 0, inclusiveMs: 0 };
    merged.set(key, row);
    rows.set(node.id, row);
  }
  // DevTools' bottom-up summary weights hit counts by the average interval.
  // Individual timeDeltas may be negative when samples arrive out of order.
  const sampledMs = (profile.endTime - profile.startTime) / 1000;
  const weight = profile.samples.length === 0 ? 0 : sampledMs / profile.samples.length;
  for (const id of profile.samples) addSample(id, weight, rows, parents);
  return {
    sampledMs,
    method: 'uniform-sample-weight',
    frames: [...merged.values()].sort((a, b) => b.selfMs - a.selfMs),
  };
}

export async function writeCpuEvidence(output: string): Promise<void> {
  const summaries: Record<string, CpuSummary> = {};
  for (const file of (await readdir(output)).filter((name) => name.endsWith('.cpuprofile'))) {
    const worker = file.startsWith('worker-');
    const profile = JSON.parse(await readFile(path.join(output, file), 'utf8')) as Profiler.Profile;
    const map = JSON.parse(
      await readFile(path.join(output, worker ? 'search-worker.js.map' : 'main.js.map'), 'utf8'),
    ) as MapPayload;
    summaries[file] = cpuSummary(profile, map, worker);
  }
  await writeFile(path.join(output, 'cpu-summary.json'), JSON.stringify(summaries, null, 2));
  const memory: Record<string, unknown> = {};
  for (const name of (await readdir(output)).filter(
    (file) => file.startsWith('memory-') && file.endsWith('.json'),
  ))
    memory[name] = JSON.parse(await readFile(path.join(output, name), 'utf8')) as unknown;
  const cpu = Object.fromEntries(
    Object.entries(summaries).map(([name, summary]) => {
      const pluginFrames = summary.frames.filter((frame) => frame.mapped);
      return [
        name,
        {
          sampledMs: summary.sampledMs,
          method: summary.method,
          topSelf: pluginFrames.slice(0, 15),
          topInclusive: [...pluginFrames]
            .sort((a, b) => b.inclusiveMs - a.inclusiveMs)
            .slice(0, 15),
        },
      ];
    }),
  );
  await writeFile(
    path.join(output, 'diagnostics-summary.json'),
    JSON.stringify(
      {
        cpu,
        memory,
        note: 'Diagnostic pass only. CPU times are sample-weighted estimates including profiler overhead. Inclusive frames overlap. Heap is whole-isolate, without forced GC; growth alone does not prove a leak.',
      },
      null,
      2,
    ),
  );
}
