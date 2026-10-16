import { frames } from './native-helpers.ts';
import type { CdpListener, NativeBridge } from './native-types.ts';
import { bounded } from './profiler.ts';

interface WorkerTarget {
  sessionId: string;
  targetId: string;
  url: string;
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
  private readonly listener: CdpListener = (_event, method, params, session) => {
    if (method === 'Target.attachedToTarget' && session === this.session) this.attached(params);
    if (method === 'Tracing.dataCollected' && Array.isArray(params['value']))
      this.events.push(...(params['value'] as unknown[]));
    if (method === 'Tracing.tracingComplete') this.traceDone?.(params);
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
    await this.send('Target.setAutoAttach', {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: true,
      filter: [{ type: 'worker' }, { exclude: true }],
    });
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
      const result = await this.send<{ profile: unknown }>('Profiler.stop');
      this.profiling = false;
      this.bridge.save('renderer.cpuprofile', result.profile);
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
    if (this.session !== '') {
      try {
        await this.send('Target.detachFromTarget', { sessionId: this.session }, '');
      } catch (error) {
        errors.push(error);
      }
      this.session = '';
    }
    if (errors.length > 0) throw new AggregateError(errors, 'CDP cleanup failed');
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
