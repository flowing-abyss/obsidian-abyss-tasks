import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

const run = promisify(execFile);
const failureCodes = [
  'plan-storage',
  'plan-desktop',
  'plan-sign-in',
  'plan-permission',
  'plan-limit',
  'invalid-request',
  'invalid-response',
  'unavailable',
  'rate-limit',
  'cancelled',
  'timeout',
  'busy',
  'too-large',
];
export class SubscriptionEvaluationFailure extends Error {
  /** @param {string} code */
  constructor(code) {
    super(`subscription:${code}`);
    this.name = 'SubscriptionEvaluationFailure';
    this.code = code;
  }
}
/** The CLI never receives credentials. The running development-vault plugin owns OAuth,
 * token refresh, the production SDK adapter, and its deadline. Synthetic parameters/results
 * cross a private temporary directory which is removed after every generation. */
/**
 * @param {string} model
 * @param {{dispatch:()=>void,close?:()=>void}} budget
 * @param {(code:string)=>Promise<unknown>} [execute]
 * @returns {ReturnType<typeof import('../src/ai/providers/chatGptPlanModel.ts').createChatGptPlanModel>}
 */
export function subscriptionModel(model, budget, execute = executeInDevelopmentVault) {
  return {
    specificationVersion: 'v4',
    provider: 'chatgpt-plan',
    modelId: model,
    supportedUrls: {},
    doGenerate: async (params) => {
      params.abortSignal?.throwIfAborted();
      const directory = await mkdtemp(join(tmpdir(), 'abyss-command-eval-'));
      const input = join(directory, 'input.json'),
        output = join(directory, 'output.json'),
        cancellation = join(directory, 'cancel');
      let retainExchange = false;
      let writeCancellation = Promise.resolve();
      const onAbort = () => {
        writeCancellation = writeFile(cancellation, '1', { mode: 0o600 }).catch(() => {});
      };
      try {
        await writeFile(cancellation, '0', { mode: 0o600 });
        params.abortSignal?.addEventListener('abort', onAbort, { once: true });
        if (params.abortSignal?.aborted === true) onAbort();
        await writeFile(input, JSON.stringify({ ...params, abortSignal: undefined }), {
          mode: 0o600,
        });
        params.abortSignal?.throwIfAborted();
        budget.dispatch();
        const code = `
          const fs=require('node:fs/promises');
          const nodeFs=require('node:fs');
          const cancellationPath=${JSON.stringify(cancellation)};
          const remoteController=new AbortController();
          const timeoutSignal=AbortSignal.timeout(60000);
          const remoteSignal=AbortSignal.any([remoteController.signal,timeoutSignal]);
          const params=JSON.parse(await fs.readFile(${JSON.stringify(input)},'utf8'));
          let watcher;
          let poll;
          let monitoring=true;
          const stopMonitoring=()=>{
            if (!monitoring) return;
            monitoring=false;
            if (poll!==undefined) { clearInterval(poll); poll=undefined; }
            if (watcher!==undefined) { watcher.close(); watcher=undefined; }
          };
          const cancelIfRequested=async()=>{
            try { if (await fs.readFile(cancellationPath,'utf8')==='1') remoteController.abort(); }
            catch {}
          };
          watcher=nodeFs.watch(${JSON.stringify(directory)},(_event,filename)=>{
            if (filename===null || String(filename)==='cancel') void cancelIfRequested();
          });
          watcher.on('error',()=>{});
          poll=setInterval(()=>{if(monitoring)void cancelIfRequested()},25);
          remoteController.signal.addEventListener('abort',stopMonitoring,{once:true});
          timeoutSignal.addEventListener('abort',stopMonitoring,{once:true});
          if (remoteController.signal.aborted || timeoutSignal.aborted) stopMonitoring();
          let payload;
          try {
            await cancelIfRequested();
            if (remoteController.signal.aborted) throw remoteController.signal.reason;
            const model=app.plugins.plugins['abyss-tasks'].chatGptPlan.model(${JSON.stringify(model)});
            const result=await model.doGenerate({...params,abortSignal:remoteSignal});
            await cancelIfRequested();
            if (remoteController.signal.aborted) throw remoteController.signal.reason;
            if (timeoutSignal.aborted) throw timeoutSignal.reason;
            const {content,finishReason,usage,warnings,providerMetadata}=result;
            payload={ok:true,result:{content,finishReason,usage,warnings,providerMetadata}};
          } catch (error) {
            const codes=${JSON.stringify(failureCodes)};
            const code=timeoutSignal.aborted?'timeout':remoteController.signal.aborted?'cancelled':codes.includes(error?.code)?error.code:(error?.name==='TimeoutError'?'timeout':'unavailable');
            payload={ok:false,code};
          } finally {
            stopMonitoring();
          }
          await fs.writeFile(${JSON.stringify(output)},JSON.stringify(payload),{mode:0o600});
          return 'Command evaluation generation settled';
        `;
        const drainController = new AbortController();
        let removeAbortListener = () => {};
        const cancellationDrain = new Promise((_, reject) => {
          const beginDrain = () => {
            void delay(settlementDrainMs, undefined, { signal: drainController.signal }).then(
              () => {
                reject(new SubscriptionEvaluationFailure('settlement-unknown'));
              },
              () => {},
            );
          };
          if (params.abortSignal?.aborted === true) beginDrain();
          else if (params.abortSignal !== undefined) {
            params.abortSignal.addEventListener('abort', beginDrain, { once: true });
            removeAbortListener = () =>
              params.abortSignal?.removeEventListener('abort', beginDrain);
          }
        });
        try {
          await Promise.race([execute(code), cancellationDrain]);
        } catch (error) {
          if (
            error instanceof SubscriptionEvaluationFailure &&
            error.code === 'settlement-unknown'
          ) {
            retainExchange = true;
            budget.close?.();
            throw error;
          }
        } finally {
          drainController.abort();
          removeAbortListener();
          await writeCancellation;
        }
        let value;
        try {
          value =
            /** @type {{ok:boolean,code?:string,result:Awaited<ReturnType<ReturnType<typeof import('../src/ai/providers/chatGptPlanModel.ts').createChatGptPlanModel>['doGenerate']>>}} */ (
              JSON.parse(await readFile(output, 'utf8'))
            );
        } catch {
          retainExchange = true;
          budget.close?.();
          throw new SubscriptionEvaluationFailure('settlement-unknown');
        }
        if (params.abortSignal?.aborted === true)
          throw new SubscriptionEvaluationFailure('cancelled');
        if (!value.ok)
          throw new SubscriptionEvaluationFailure(
            failureCodes.includes(value.code ?? '') ? String(value.code) : 'unavailable',
          );
        return value.result;
      } finally {
        params.abortSignal?.removeEventListener('abort', onAbort);
        if (!retainExchange) await rm(directory, { recursive: true, force: true });
      }
    },
    doStream: () => {
      throw new Error('subscription-evaluation-streaming-unavailable');
    },
  };
}
const settlementDrainMs = 5_000;

/** @param {string} code */
async function executeInDevelopmentVault(code) {
  try {
    await run('obsidian', ['vault=dev-vault-tasks', 'eval', `code=${code}`], {
      timeout: 70000,
      maxBuffer: 65536,
    });
  } catch {
    throw new SubscriptionEvaluationFailure('cli-failed');
  }
}
