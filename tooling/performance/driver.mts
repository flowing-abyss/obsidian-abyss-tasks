import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { parseCliResult } from './options.ts';

const execute = promisify(execFile);
export async function command(
  file: string,
  args: string[],
  cwd?: string,
  signal?: AbortSignal,
): Promise<string> {
  const result = await execute(file, args, {
    timeout: 120000,
    killSignal: 'SIGKILL',
    maxBuffer: 32 * 1024 * 1024,
    ...(cwd === undefined ? {} : { cwd }),
    ...(signal === undefined ? {} : { signal }),
  });
  return result.stdout;
}
export async function cli(args: string[], signal?: AbortSignal): Promise<string> {
  return await command('obsidian', ['vault=dev-vault-tasks', ...args], undefined, signal);
}

function missingFile(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

function completion(stdout: string, id: string): unknown {
  let envelope: unknown;
  try {
    envelope = JSON.parse(stdout);
  } catch (error) {
    throw new Error(`Invalid profiler result JSON: ${String(error)}`);
  }
  if (typeof envelope !== 'object' || envelope === null)
    throw new Error('Invalid profiler result envelope');
  const fields = envelope as Record<string, unknown>;
  if (fields['id'] !== id || typeof fields['ok'] !== 'boolean')
    throw new Error('Invalid profiler result envelope');
  if (fields['ok'] === false && typeof fields['error'] !== 'string')
    throw new Error('Invalid profiler rejection envelope');
  return parseCliResult(stdout);
}

async function waitForCompletion(
  result: string,
  id: string,
  deadline: number,
  launch: { error?: Error },
): Promise<unknown> {
  // Only the controller polls its own filesystem; no CLI/renderer polling occurs in timed spans.
  while (Date.now() < deadline) {
    let stdout: string | undefined;
    try {
      stdout = await readFile(result, 'utf8');
    } catch (error) {
      if (!missingFile(error)) throw error;
    }
    if (stdout !== undefined) return completion(stdout, id);
    if (launch.error !== undefined) throw launch.error;
    await delay(50);
  }
  throw new Error('Profiler evaluation timed out after 120000ms; native work may still be running');
}

export async function evaluate<T>(body: string): Promise<T> {
  const deadline = Date.now() + 120000;
  const directory = await mkdtemp(path.join(tmpdir(), 'abyss-profile-eval-'));
  const staging = path.join(directory, 'pending');
  const result = path.join(directory, 'result');
  const abort = new AbortController();
  let failure: Error | undefined;
  let value: T | undefined;
  try {
    await writeFile(staging, '', { flag: 'wx', mode: 0o600 });
    // The launcher returns synchronously. Completion never depends on the CLI forwarding a Promise.
    // r+ cannot recreate the staging file after caller cleanup, even if the body settles late.
    const source = `(()=>{
      const fs=require('node:fs'), staging=${JSON.stringify(staging)}, result=${JSON.stringify(result)};
      const publish=(envelope)=>{try{
        fs.writeFileSync(staging,JSON.stringify({id:${JSON.stringify(directory)},...envelope}),{flag:'r+'});
        fs.renameSync(staging,result);
      }catch(error){if(error?.code!=='ENOENT')console.error('[abyss-profile] Result delivery failed',error);}};
      void(async()=>{try{
        if(!fs.existsSync(staging))return;
        if(app.vault.getName()!=='dev-vault-tasks')throw Error('Wrong vault');
        publish({ok:true,value:await(async()=>{${body}})()});
      }catch(error){publish({ok:false,error:String(error?.stack??error)});}})();
      return JSON.stringify({ok:true,value:${JSON.stringify(directory)}});
    })()`;
    const launch: { error?: Error } = {};
    // Attach the rejection handler before awaiting; it also observes abort/late CLI failures.
    cli(['eval', `code=${source}`], abort.signal)
      .then((stdout) => {
        if (parseCliResult(stdout) !== directory)
          throw new Error('Invalid profiler launch response');
      })
      .catch((error: unknown) => {
        launch.error = error instanceof Error ? error : new Error(String(error));
      });
    value = (await waitForCompletion(result, directory, deadline, launch)) as T;
  } catch (error) {
    failure = error instanceof Error ? error : new Error(String(error));
  }
  abort.abort();
  try {
    await rm(directory, { recursive: true, force: true });
  } catch (cleanupError) {
    if (failure !== undefined)
      throw new AggregateError([failure, cleanupError], 'Profiler evaluation and cleanup failed');
    throw cleanupError;
  }
  if (failure !== undefined) throw failure;
  return value as T;
}

export interface HostBefore {
  vault: string;
  configDir: string;
  debugger: boolean;
  enabled: boolean;
  runtimeErrors: string;
  viewportOverride?: boolean;
  devtools: boolean;
  layout: Record<string, unknown>;
  identity: Record<string, string | number | boolean>;
}

export async function preflight(): Promise<HostBefore> {
  return await evaluate<HostBefore>(`
    const remote=require('electron').remote, wc=remote.getCurrentWebContents();
    if(window.__abyssProfile)throw Error('A profile harness is already installed; recover its run first');
    if(document.visibilityState!=='visible')throw Error('Bring dev-vault-tasks to the foreground');
    const hash=require('crypto').createHash('sha256');
    for(const file of app.vault.getMarkdownFiles().sort((a,b)=>a.path.localeCompare(b.path))) {
      hash.update(JSON.stringify([file.path,await app.vault.cachedRead(file)]));
    }
    return {vault:app.vault.adapter.getBasePath(),configDir:app.vault.configDir,runtimeErrors:'',
      devtools:wc.isDevToolsOpened(),
      debugger:wc.debugger.isAttached(),enabled:!!app.plugins.plugins['abyss-tasks'],layout:app.workspace.getLayout(),
      identity:{obsidian:remote.app.getVersion(),electron:process.versions.electron,chrome:process.versions.chrome,
      viewport:innerWidth+'x'+innerHeight,dpr:devicePixelRatio,timezone:Intl.DateTimeFormat().resolvedOptions().timeZone,
      locale:navigator.language,theme:document.body.className,day:new Date().toLocaleDateString('en-CA'),
      hostCorpus:hash.digest('hex'),
      plugins:JSON.stringify(Object.entries(app.plugins.plugins).filter(([id])=>id!=='abyss-tasks').map(([id,p])=>[id,p.manifest.version]).sort()),
      longTasks:PerformanceObserver.supportedEntryTypes.includes('longtask')}};
  `);
}
