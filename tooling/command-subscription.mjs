import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
 * @param {{dispatch:()=>void}} budget
 * @param {(code:string, signal?:AbortSignal)=>Promise<unknown>} [execute]
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
        output = join(directory, 'output.json');
      try {
        await writeFile(input, JSON.stringify({ ...params, abortSignal: undefined }), {
          mode: 0o600,
        });
        params.abortSignal?.throwIfAborted();
        budget.dispatch();
        await execute(
          `
          const fs=require('node:fs/promises');
          const params=JSON.parse(await fs.readFile(${JSON.stringify(input)},'utf8'));
          let payload;
          try {
            const model=app.plugins.plugins['abyss-tasks'].chatGptPlan.model(${JSON.stringify(model)});
            const result=await model.doGenerate({...params,abortSignal:AbortSignal.timeout(60000)});
            const {content,finishReason,usage,warnings,providerMetadata}=result;
            payload={ok:true,result:{content,finishReason,usage,warnings,providerMetadata}};
          } catch (error) {
            const codes=${JSON.stringify(failureCodes)};
            const code=codes.includes(error?.code)?error.code:(error?.name==='TimeoutError'?'timeout':'unavailable');
            payload={ok:false,code};
          }
          await fs.writeFile(${JSON.stringify(output)},JSON.stringify(payload),{mode:0o600});
          return 'Command evaluation generation settled';
        `,
          params.abortSignal,
        );
        params.abortSignal?.throwIfAborted();
        const value =
          /** @type {{ok:boolean,code?:string,result:Awaited<ReturnType<ReturnType<typeof import('../src/ai/providers/chatGptPlanModel.ts').createChatGptPlanModel>['doGenerate']>>}} */ (
            JSON.parse(await readFile(output, 'utf8'))
          );
        if (!value.ok)
          throw new SubscriptionEvaluationFailure(
            failureCodes.includes(value.code ?? '') ? String(value.code) : 'unavailable',
          );
        return value.result;
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
    doStream: () => {
      throw new Error('subscription-evaluation-streaming-unavailable');
    },
  };
}
/** @param {string} code @param {AbortSignal} [signal] */
async function executeInDevelopmentVault(code, signal) {
  try {
    await run('obsidian', ['vault=dev-vault-tasks', 'eval', `code=${code}`], {
      timeout: 70000,
      maxBuffer: 65536,
      ...(signal === undefined ? {} : { signal }),
    });
  } catch {
    throw new SubscriptionEvaluationFailure(signal?.aborted === true ? 'cancelled' : 'cli-failed');
  }
}
