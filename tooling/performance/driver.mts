import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseCliResult } from './options.ts';

const execute = promisify(execFile);
export async function command(file: string, args: string[], cwd?: string): Promise<string> {
  const result = await execute(file, args, {
    timeout: 120000,
    killSignal: 'SIGKILL',
    maxBuffer: 32 * 1024 * 1024,
    ...(cwd === undefined ? {} : { cwd }),
  });
  return result.stdout;
}
export async function cli(args: string[]): Promise<string> {
  return await command('obsidian', ['vault=dev-vault-tasks', ...args]);
}
export async function evaluate<T>(body: string): Promise<T> {
  const source = `(async()=>{try{if(app.vault.getName()!=='dev-vault-tasks')throw Error('Wrong vault');return JSON.stringify({ok:true,value:await(async()=>{${body}})()});}catch(error){return JSON.stringify({ok:false,error:String(error?.stack??error)});}})()`;
  return parseCliResult(await cli(['eval', `code=${source}`])) as T;
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
