import { frames } from './native-helpers.ts';
import type { CdpListener, NativeBridge, RendererScript } from './native-types.ts';
import { bounded } from './profiler.ts';

interface WorkerTarget {
  sessionId: string;
  targetId: string;
  url: string;
}
interface ParsedScript {
  scriptId: string;
  url: string;
  hash: string;
  startLine: number;
  startColumn: number;
}
interface ParsedEvent {
  scriptId: string | null;
  url: string | null;
  receivedSession: string | null;
  owned: boolean;
  admitted: boolean;
  startLine: number | null;
  startColumn: number | null;
  fieldTypes: Record<string, string>;
}
function stringField(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}
function numberField(value: unknown): number | null {
  return typeof value === 'number' ? value : null;
}
interface RendererProfile {
  nodes: Array<{ callFrame: { scriptId: string; url: string } }>;
}
function sampledIdentity(
  parsed: ParsedScript,
  sampled: { scriptId: string; url: string },
): boolean {
  return (
    parsed.scriptId === sampled.scriptId &&
    mainCandidate(sampled.url) &&
    (parsed.url === sampled.url || parsed.url === 'plugin:abyss-tasks')
  );
}
function rendererCandidates(
  profile: RendererProfile,
): Array<{ scriptId: string; url: string; contradictory: boolean }> {
  const urls = new Map<string, Set<string>>();
  for (const { callFrame } of profile.nodes) {
    const values = urls.get(callFrame.scriptId) ?? new Set<string>();
    values.add(callFrame.url);
    urls.set(callFrame.scriptId, values);
  }
  return [...urls].flatMap(([scriptId, values]) => {
    const url = [...values].find(mainCandidate);
    return url === undefined ? [] : [{ scriptId, url, contradictory: values.size !== 1 }];
  });
}

/** CDP locations include the script's resource origin; source text excludes that origin. */
export function mainScriptEvidence(
  parsed: ParsedScript,
  source: string,
  main: { text: string; sha256: string },
  sampled: { scriptId: string; url: string },
): RendererScript | undefined {
  if (!sampledIdentity(parsed, sampled)) return undefined;
  const at = source.indexOf(main.text);
  if (main.text.length === 0 || at < 0 || source.indexOf(main.text, at + 1) >= 0) return undefined;
  const position = (offset: number): { line: number; column: number } => {
    const prefix = source.slice(0, offset).split('\n');
    return {
      line: parsed.startLine + prefix.length - 1,
      column:
        (prefix.length === 1 ? parsed.startColumn : 0) + (prefix[prefix.length - 1]?.length ?? 0),
    };
  };
  const start = position(at),
    end = position(at + main.text.length);
  return {
    scriptId: parsed.scriptId,
    url: sampled.url,
    debuggerUrl: parsed.url,
    hash: parsed.hash,
    scriptStartLine: parsed.startLine,
    scriptStartColumn: parsed.startColumn,
    startLine: start.line,
    startColumn: start.column,
    endLine: end.line,
    endColumn: end.column,
    prefixCharacters: at,
    suffixCharacters: source.length - at - main.text.length,
    mainSha256: main.sha256,
  };
}

function mainCandidate(url: string): boolean {
  if (url === 'plugin:abyss-tasks') return true;
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === 'app:' &&
      parsed.hostname === 'obsidian.md' &&
      parsed.searchParams.get('id') === 'abyss-tasks'
    );
  } catch {
    return false;
  }
}

export class NativeCdp {
  private session = '';
  private readonly workers: WorkerTarget[] = [];
  private readonly profiledWorkers: WorkerTarget[] = [];
  private readonly errors: string[] = [];
  private readonly notes: string[] = [];
  private tracing = false;
  private profiling = false;
  private traceDone: ((value: Record<string, unknown>) => void) | undefined;
  private readonly events: unknown[] = [];
  private readonly scripts = new Map<string, ParsedScript>();
  private readonly parsedEvents: ParsedEvent[] = [];
  private debugging = false;
  private readonly listener: CdpListener = (_event, method, params, session) => {
    if (method === 'Target.attachedToTarget' && session === this.session) this.attached(params);
    if (method === 'Tracing.dataCollected' && Array.isArray(params['value']))
      this.events.push(...(params['value'] as unknown[]));
    if (method === 'Tracing.tracingComplete') this.traceDone?.(params);
    if (method === 'Debugger.scriptParsed') this.recordParsed(params, session);
  };
  constructor(private readonly bridge: NativeBridge) {}

  async send<T>(
    method: string,
    params: Record<string, unknown> = {},
    session = this.session,
  ): Promise<T> {
    const pending =
      session === ''
        ? this.bridge.debugger.sendCommand(method, params)
        : this.bridge.debugger.sendCommand(method, params, session);
    return (await bounded(pending, 10000, method)) as T;
  }
  async open(): Promise<void> {
    if (!this.bridge.debugger.isAttached())
      throw new Error('Enable Obsidian dev:debug before diagnostics');
    const info = await this.send<{ targetInfo: { targetId: string } }>(
      'Target.getTargetInfo',
      {},
      '',
    );
    this.session = (
      await this.send<{ sessionId: string }>(
        'Target.attachToTarget',
        { targetId: info.targetInfo.targetId, flatten: true },
        '',
      )
    ).sessionId;
    this.bridge.debugger.on('message', this.listener);
    await this.send('Debugger.enable');
    this.debugging = true;
    await this.send('Target.setAutoAttach', {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: true,
      filter: [{ type: 'worker' }, { exclude: true }],
    });
  }
  private recordParsed(params: Record<string, unknown>, session: string | undefined): void {
    const owned = session === this.session;
    this.parsedEvents.push({
      scriptId: stringField(params['scriptId']),
      url: stringField(params['url']),
      receivedSession: stringField(session),
      owned,
      admitted: owned && this.parsed(params),
      startLine: numberField(params['startLine']),
      startColumn: numberField(params['startColumn']),
      fieldTypes: Object.fromEntries(
        ['scriptId', 'url', 'hash', 'startLine', 'startColumn'].map((key) => [
          key,
          typeof params[key],
        ]),
      ),
    });
  }
  private parsed(params: Record<string, unknown>): boolean {
    if (
      typeof params['scriptId'] !== 'string' ||
      typeof params['url'] !== 'string' ||
      typeof params['hash'] !== 'string' ||
      typeof params['startLine'] !== 'number' ||
      typeof params['startColumn'] !== 'number'
    )
      return false;
    this.scripts.set(params['scriptId'], {
      scriptId: params['scriptId'],
      url: params['url'],
      hash: params['hash'],
      startLine: params['startLine'],
      startColumn: params['startColumn'],
    });
    return true;
  }
  private provenance(candidates: ReadonlyArray<{ scriptId: string }>): Record<string, unknown> {
    const ids = new Set(candidates.map((candidate) => candidate.scriptId));
    return {
      ownedSession: this.session,
      events: {
        total: this.parsedEvents.length,
        owned: this.parsedEvents.filter((event) => event.owned).length,
        admitted: this.parsedEvents.filter((event) => event.admitted).length,
      },
      candidates: this.parsedEvents.filter(
        (event) =>
          (event.scriptId !== null && ids.has(event.scriptId)) ||
          (event.url !== null && mainCandidate(event.url)),
      ),
    };
  }
  private async rendererSources(profile: RendererProfile): Promise<void> {
    const scripts: RendererScript[] = [],
      unmapped: Array<{ scriptId: string; url: string; reason: string }> = [];
    const candidates = rendererCandidates(profile);
    const main = this.bridge.mainSource();
    for (const frame of candidates) {
      const parsed = this.scripts.get(frame.scriptId);
      if (frame.contradictory || parsed === undefined || !sampledIdentity(parsed, frame)) {
        unmapped.push({ ...frame, reason: 'Missing or contradictory scriptParsed identity' });
        continue;
      }
      try {
        const { scriptSource } = await this.send<{ scriptSource: string }>(
          'Debugger.getScriptSource',
          { scriptId: frame.scriptId },
        );
        const proof = mainScriptEvidence(parsed, scriptSource, main, frame);
        if (proof === undefined)
          unmapped.push({ ...frame, reason: 'Saved main is not a unique exact source interval' });
        else scripts.push(proof);
      } catch {
        unmapped.push({ ...frame, reason: 'Sampled script source unavailable' });
      }
    }
    this.bridge.save('renderer-sources.json', {
      scripts,
      unmapped,
      provenance: this.provenance(candidates),
    });
    if (candidates.length > 0 && scripts.length === 0)
      throw new Error('No sampled renderer script matched the saved main source');
  }
  private attached(params: Record<string, unknown>): void {
    const target = params['targetInfo'] as
      { type?: string; url?: string; targetId?: string } | undefined;
    if (
      target?.type !== 'worker' ||
      typeof target.url !== 'string' ||
      typeof params['sessionId'] !== 'string' ||
      typeof target.targetId !== 'string'
    )
      return;
    this.workers.push({
      sessionId: params['sessionId'],
      targetId: target.targetId,
      url: target.url,
    });
  }
  async start(): Promise<void> {
    await this.send('Profiler.enable');
    await this.send('Profiler.setSamplingInterval', { interval: 1000 });
    await this.send('Profiler.start');
    this.profiling = true;
    await this.send('Tracing.start', {
      transferMode: 'ReportEvents',
      traceConfig: {
        recordMode: 'recordUntilFull',
        includedCategories: [
          'devtools.timeline',
          'blink.user_timing',
          'v8',
          'disabled-by-default-devtools.timeline',
        ],
      },
    });
    this.tracing = true;
  }
  async memory(label: string): Promise<void> {
    const renderer = await this.send('Runtime.getHeapUsage');
    const workers: unknown[] = [];
    for (const target of this.workers) {
      if (!target.url.startsWith('blob:')) continue;
      try {
        const record = await this.inspectWorker(target);
        if (record !== undefined) workers.push(record);
      } catch (error) {
        this.errors.push(`Worker ${label}: ${String(error)}`);
      }
    }
    this.bridge.save(`memory-${label}.json`, {
      renderer,
      workers,
      forcedGC: false,
      attribution: 'Whole isolates; not plugin-exclusive or RSS',
      errors: this.errors,
    });
    if (workers.length !== 1)
      throw new Error(`Expected one verified search Worker at ${label}; found ${workers.length}`);
  }
  private async inspectWorker(target: WorkerTarget): Promise<unknown> {
    let source: string;
    try {
      source = await blobText(target.url);
    } catch (error) {
      this.notes.push(`Unidentified Blob Worker source unavailable: ${String(error)}`);
      return undefined;
    }
    if (!source.startsWith('/* abyss-task-search-worker */')) return undefined;
    if (!this.bridge.matchesWorkerSource(source))
      throw new Error('Search Worker source does not match the saved production map');
    const identity = await this.send<{
      result: { value: { url: string; dedicated: boolean } };
    }>(
      'Runtime.evaluate',
      {
        expression:
          '({url:location.href,dedicated:typeof DedicatedWorkerGlobalScope!=="undefined"&&self instanceof DedicatedWorkerGlobalScope})',
        returnByValue: true,
      },
      target.sessionId,
    );
    if (identity.result.value.url !== target.url || !identity.result.value.dedicated)
      throw new Error('Worker identity mismatch');
    const record = {
      targetId: target.targetId,
      url: target.url,
      heap: await this.send('Runtime.getHeapUsage', {}, target.sessionId),
      isolate: await this.send('Runtime.getIsolateId', {}, target.sessionId),
    };
    if (!this.profiledWorkers.some((worker) => worker.targetId === target.targetId)) {
      await this.profileWorker(target);
      this.profiledWorkers.push(target);
    }
    return record;
  }
  private async profileWorker(target: WorkerTarget): Promise<void> {
    await this.send('Profiler.enable', {}, target.sessionId);
    await this.send('Profiler.setSamplingInterval', { interval: 1000 }, target.sessionId);
    await this.send('Profiler.start', {}, target.sessionId);
  }
  async stop(): Promise<void> {
    if (this.tracing) {
      const done = new Promise<Record<string, unknown>>((resolve) => {
        this.traceDone = resolve;
      });
      await this.send('Tracing.end');
      const completion = await bounded(done, 15000, 'trace completion');
      this.tracing = false;
      this.bridge.save('trace.json', { traceEvents: this.events, metadata: completion });
      if (completion['dataLossOccurred'] === true) throw new Error('Trace buffer lost events');
    }
    if (this.profiling) {
      const result = await this.send<{ profile: RendererProfile }>('Profiler.stop');
      this.profiling = false;
      this.bridge.save('renderer.cpuprofile', result.profile);
      await this.rendererSources(result.profile);
    }
    await this.stopWorkers();
    this.bridge.save('diagnostic-notes.json', [...this.notes, ...this.errors]);
    if (this.errors.length > 0) throw new Error(this.errors.join('; '));
  }
  private async stopWorkers(): Promise<void> {
    for (const target of this.profiledWorkers) {
      try {
        const profile = await this.send<{ profile: unknown }>(
          'Profiler.stop',
          {},
          target.sessionId,
        );
        this.bridge.save(`worker-${target.targetId}.cpuprofile`, profile.profile);
        this.bridge.save(
          'memory-worker-end.json',
          await this.send('Runtime.getHeapUsage', {}, target.sessionId),
        );
      } catch (error) {
        this.errors.push(`Worker profile unavailable: ${String(error)}`);
      }
    }
  }
  async screenshot(name: string): Promise<void> {
    await frames();
    const response = await this.send<{ data: string }>('Page.captureScreenshot', { format: 'png' });
    this.bridge.saveImage(`${name}.png`, response.data);
  }
  async close(): Promise<void> {
    const errors: unknown[] = [];
    if (this.tracing || this.profiling) {
      try {
        await this.stop();
      } catch (error) {
        errors.push(error);
      }
    }
    this.bridge.debugger.removeListener('message', this.listener);
    try {
      await this.detach();
    } catch (error) {
      errors.push(error);
    }
    if (errors.length > 0) throw new AggregateError(errors, 'CDP cleanup failed');
  }
  private async detach(): Promise<void> {
    const errors: unknown[] = [];
    if (this.session !== '') {
      if (this.debugging) {
        try {
          await this.send('Debugger.disable');
        } catch (error) {
          errors.push(error);
        }
        this.debugging = false;
      }
      try {
        await this.send('Target.detachFromTarget', { sessionId: this.session }, '');
      } catch (error) {
        errors.push(error);
      }
      this.session = '';
    }
    if (errors.length > 0) throw new AggregateError(errors, 'CDP detach failed');
  }
}

function blobText(url: string): Promise<string> {
  if (!url.startsWith('blob:')) throw new Error('Only renderer-owned Blob sources may be read');
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', url);
    xhr.timeout = 10000;
    xhr.onload = (): void => {
      resolve(xhr.responseText);
    };
    xhr.onerror = (): void => {
      reject(new Error('Worker Blob read failed'));
    };
    xhr.ontimeout = (): void => {
      reject(new Error('Worker Blob read timed out'));
    };
    xhr.send();
  });
}
