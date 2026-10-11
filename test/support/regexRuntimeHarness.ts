import { build } from 'esbuild';
import { Platform } from 'obsidian';

export type RegexScenario = 'tags' | 'comments' | 'legacy-links' | 'ghost';
export interface RegexScenarioResult {
  readonly samples: ReadonlyArray<{
    size: number;
    cpuMs: number;
    iterations: number;
    elapsedCpuMs: number;
  }>;
  readonly outputs: readonly string[];
}

/** Resolve only after close, including after SIGKILL, so a rejected probe leaves no live child. */
export async function runRegexChild(contents: string, deadlineMs = 4_000): Promise<string> {
  if (!Platform.isDesktop) throw new Error('Regex runtime probes require a desktop runtime');
  const [{ spawn }, { setTimeout, clearTimeout }] = await Promise.all([
    import('node:child_process'),
    import('node:timers'),
  ]);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=commonjs', '-e', contents], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '',
      stderr = '',
      timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, deadlineMs);
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      if (timedOut || code !== 0 || stderr !== '') {
        const failure = timedOut ? `exceeded ${deadlineMs}ms deadline` : 'failed';
        reject(
          new Error(
            `Regex child ${failure}; exit=${String(code)} signal=${String(signal)} stderr=${stderr} stdout=${stdout}`,
          ),
        );
      } else resolve(stdout);
    });
  });
}

const operations: Readonly<Record<RegexScenario, string>> = {
  tags: `import { normalizeTag } from './src/markdown/tagSyntax.ts';
    const makeInput = size => ['ℹ', '\\uFE0F'].map(unit => '#' + unit.repeat(size));
    const operation = input => JSON.stringify(input.flatMap(tag => [normalizeTag(tag), normalizeTag(tag + '!')]));`,
  comments: `import { projectSearchText } from './src/markdown/searchText.ts';
    const makeInput = size => '<!--'.repeat(size);
    const operation = input => JSON.stringify(projectSearchText(input, 'prose'));`,
  'legacy-links': `import { collapseLinks } from './src/markdown/links.ts';
    const makeInput = size => '[a]('.repeat(size);
    const operation = input => collapseLinks(input);`,
  ghost: `import { plainGhostTaskTitle } from './src/ui/plainGhostTaskTitle.ts';
    const makeInput = size => {
      const ticks = '\\x60'.repeat(size);
      return [ticks, ticks + '\\x60', 'left' + ticks + 'right', ticks + 'a' + ticks,
        ticks + 'a' + ticks.slice(1), ticks.slice(1) + 'a' + ticks,
        '\\\\' + ticks, '\\\\' + ticks + '\\x60', ticks + 'a\\\\' + ticks,
        ticks + 'a\\\\' + ticks + '\\x60'].map(title => ({title}));
    };
    const operation = input => JSON.stringify(input.map(plainGhostTaskTitle));`,
};

/** Bundle current production modules, never a copied regex or same-thread timeout wrapper. */
export async function runRegexScenario(scenario: RegexScenario): Promise<RegexScenarioResult> {
  const result = await build({
    stdin: {
      contents: `${operations[scenario]}
        import { cpuMilliseconds } from './test/support/cpuTime.ts';
        const sizes = [4000, 16000];
        const inputs = sizes.map(makeInput);
        for (let warmup = 0; warmup < 2; warmup++) inputs.forEach(operation);
        const samples = [];
        function sample(index) {
          const start = cpuMilliseconds();
          let iterations = 0, elapsedCpuMs = 0;
          do {
            operation(inputs[index]);
            iterations++;
            elapsedCpuMs = cpuMilliseconds() - start;
          } while (elapsedCpuMs < 8);
          samples.push({size: sizes[index], cpuMs: elapsedCpuMs / iterations, iterations, elapsedCpuMs});
        }
        for (let pair = 0; pair < 5; pair++) {
          const first = pair % 2;
          sample(first);
          sample(1 - first);
        }
        const outputs = inputs.map(operation);
        process.stdout.write(JSON.stringify({samples, outputs}));`,
      resolveDir: process.cwd(),
      loader: 'ts',
    },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    write: false,
  });
  const contents = result.outputFiles[0]?.text;
  if (contents === undefined) throw new Error(`No bundle produced for ${scenario}`);
  return JSON.parse(await runRegexChild(contents)) as RegexScenarioResult;
}

/** Ratios compare per-operation CPU: adaptive batch totals deliberately have similar duration. */
export function medianFourfoldRatio(samples: RegexScenarioResult['samples']): number {
  const ratios: number[] = [];
  for (let at = 0; at < samples.length; at += 2) {
    const a = samples[at],
      b = samples[at + 1];
    if (a === undefined || b === undefined) throw new Error('Missing interleaved CPU pair');
    const small = a.size < b.size ? a : b,
      large = a.size < b.size ? b : a;
    if (large.size !== small.size * 4) throw new Error('Expected fourfold input pair');
    ratios.push(large.cpuMs / small.cpuMs);
  }
  ratios.sort((a, b) => a - b);
  const median = ratios[Math.floor(ratios.length / 2)];
  if (median === undefined) throw new Error('Missing CPU samples');
  return median;
}
