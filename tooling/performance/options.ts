import { DEFAULT_SETTINGS } from '../../src/settings/defaults';
import type { FixtureKind } from './types.ts';

export interface Options {
  runs: number;
  fixture: FixtureKind;
  width?: number;
  startup: boolean;
  diagnostics: boolean;
  out?: string;
  baseline?: string;
  vaultPath?: string;
  anchor?: string;
  recover?: string;
  recoverOffline?: string;
  compare?: [string, string];
  help: boolean;
}

function fixtureKind(value: string): FixtureKind {
  if (value !== 'standard' && value !== 'wide-tree')
    throw new Error('--fixture must be standard or wide-tree');
  return value;
}

function applyOption(options: Options, args: string[], index: number): number {
  const arg = args[index];
  if (arg === '--fixture') {
    options.fixture = fixtureKind(argument(args, index + 1));
    return index + 1;
  }
  if (arg === '--startup') {
    options.startup = true;
    return index;
  }
  if (arg === '--no-diagnostics') {
    options.diagnostics = false;
    return index;
  }
  if (arg === '--help') {
    options.help = true;
    return index;
  }
  if (arg === '--compare') {
    options.compare = [argument(args, index + 1), argument(args, index + 2)];
    return index + 2;
  }
  if (arg === '--runs' || arg === '--width') {
    options[arg === '--runs' ? 'runs' : 'width'] = Number(argument(args, index + 1));
    return index + 1;
  }
  const values = new Map([
    ['--out', 'out'],
    ['--baseline', 'baseline'],
    ['--vault-path', 'vaultPath'],
    ['--anchor', 'anchor'],
    ['--recover', 'recover'],
    ['--recover-offline', 'recoverOffline'],
  ] as const);
  const key = values.get(arg as '--out');
  if (key === undefined) throw new Error(`Unknown option: ${String(arg)}`);
  options[key] = argument(args, index + 1);
  return index + 1;
}

export function parseOptions(args: string[]): Options {
  const options: Options = {
    fixture: 'standard',
    runs: 10,
    startup: false,
    diagnostics: true,
    help: false,
  };
  const seen = new Set<string>();
  let i = 0;
  while (i < args.length) {
    const arg = args[i] ?? '';
    if (seen.has(arg)) throw new Error(`Duplicate option: ${arg}`);
    seen.add(arg);
    i = applyOption(options, args, i) + 1;
  }
  validateLimits(options);
  const modes = ['--compare', '--recover', '--recover-offline'].filter((mode) => seen.has(mode));
  if (modes.length > 1 || (modes.length === 1 && seen.size !== 1))
    throw new Error('Comparison and recovery modes cannot be combined with other options');
  return options;
}

function validateLimits(options: Options): void {
  if (!Number.isInteger(options.runs) || options.runs < 1 || options.runs > 100)
    throw new Error('--runs must be an integer from 1 to 100');
  if (
    options.width !== undefined &&
    (!Number.isInteger(options.width) || options.width < 320 || options.width > 3840)
  )
    throw new Error('--width must be an integer from 320 to 3840');
}

function argument(args: string[], index: number): string {
  const value = args[index];
  if (value === undefined || value.startsWith('--')) throw new Error('Missing option value');
  return value;
}

export function parseCliResult(stdout: string): unknown {
  const line = stdout.trim().replace(/^=>\s*/u, '');
  let result: unknown;
  try {
    result = JSON.parse(line);
  } catch {
    throw new Error(`Invalid Obsidian CLI response: ${stdout.slice(0, 500)}`);
  }
  if (typeof result !== 'object' || result === null) throw new Error('Invalid CLI envelope');
  const envelope = result as Record<string, unknown>;
  if (envelope['ok'] !== true)
    throw new Error(
      typeof envelope['error'] === 'string' ? envelope['error'] : 'Native command failed',
    );
  return envelope['value'];
}

export function settings(patch: Record<string, unknown>): unknown {
  return {
    ...DEFAULT_SETTINGS,
    ...patch,
    projects: {
      ...DEFAULT_SETTINGS.projects,
      ...(patch['projects'] as object),
      propertyDefinitionsVersion: 1,
    },
  };
}
