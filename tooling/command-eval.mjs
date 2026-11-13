const { spawn } = await import('node:child_process');
const { resolve } = await import('node:path');
const { default: process } = await import('node:process');

/** Parse only documented options. No credentials are accepted on the command line. */
/** @param {string[]} args */
export function parseArgs(args) {
  const options = {
    model: 'google/gemma-4-31b-it:free',
    provider: 'openrouter',
    cases: 'gym',
    maxRequests: 60,
    out: 'docs/research/command-mode-round2/runs/baseline',
    allowPaid: false,
    list: false,
    vault: /** @type {string | undefined} */ (undefined),
    localBaseURL: /** @type {string | undefined} */ (undefined),
  };
  let explicitModel = false;
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === '--') continue;
    if (flag === '--list') {
      options.list = true;
      continue;
    }
    if (flag === '--allow-paid') {
      options.allowPaid = true;
      continue;
    }
    const value = args[++i];
    if (value === undefined || value.startsWith('--')) throw new Error('Missing option value');
    switch (flag) {
      case '--model':
        explicitModel = true;
        options.model = value;
        break;
      case '--provider':
        options.provider = value;
        break;
      case '--vault':
        options.vault = value;
        break;
      case '--base-url':
        options.localBaseURL = value;
        break;
      case '--cases':
        options.cases = value;
        break;
      case '--max-requests':
        options.maxRequests = Number(value);
        break;
      case '--out':
        options.out = value;
        break;
      default:
        throw new Error('Unknown option');
    }
  }
  if (
    !Number.isSafeInteger(options.maxRequests) ||
    options.maxRequests < 1 ||
    options.model.trim() === '' ||
    !['openrouter', 'openai', 'anthropic', 'groq', 'cerebras', 'local', 'chatgpt-plan'].includes(
      options.provider,
    )
  )
    throw new Error('Invalid configuration');
  assertTransport(options, explicitModel);
  if (
    !options.list &&
    !options.allowPaid &&
    options.provider !== 'local' &&
    options.provider !== 'chatgpt-plan' &&
    (options.provider !== 'openrouter' || !options.model.endsWith(':free'))
  )
    throw new Error('Paid models require --allow-paid');
  return options;
}
/** @param {{provider:string,vault?:string|undefined,localBaseURL?:string|undefined,allowPaid:boolean}} options @param {boolean} explicitModel */
function assertTransport(options, explicitModel) {
  if (options.provider === 'chatgpt-plan') {
    if (
      !explicitModel ||
      options.vault !== 'dev-vault-tasks' ||
      options.allowPaid ||
      options.localBaseURL !== undefined
    )
      throw new Error('Invalid subscription configuration');
    return;
  }
  if (options.vault !== undefined) throw new Error('Unexpected vault');
  if (options.provider === 'local') {
    if (!explicitModel || !options.localBaseURL || options.allowPaid)
      throw new Error('Invalid local configuration');
  } else if (options.localBaseURL !== undefined) throw new Error('Unexpected local base');
}
async function main() {
  const options = parseArgs(process.argv.slice(2));
  /** @type {number} */
  const code = await new Promise((done, reject) => {
    const child = spawn(
      process.execPath,
      [
        resolve(import.meta.dirname, '../node_modules/vitest/vitest.mjs'),
        'run',
        '--config',
        'vitest.command-live.config.ts',
      ],
      {
        cwd: resolve(import.meta.dirname, '..'),
        stdio: 'inherit',
        env: { ...process.env, COMMAND_EVAL_OPTIONS: JSON.stringify(options) },
      },
    );
    child.once('error', reject);
    child.once('exit', (value) => done(value ?? 1));
  });
  process.exitCode = code;
}
if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(import.meta.filename))
  void main().catch(() => {
    process.stderr.write('Command evaluation configuration or launcher failed.\n');
    process.exitCode = 1;
  });
