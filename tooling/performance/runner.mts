import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { cpus, platform, totalmem } from 'node:os';
import path from 'node:path';
import { prepareBuild, protocolHash } from './build.mts';
import { writeCpuEvidence } from './cpu.mts';
import { cli, evaluate, preflight, type HostBefore } from './driver.mts';
import { createFixture, type Fixture } from './fixture.mts';
import { settings as effectiveSettings, parseOptions, type Options } from './options.ts';
import { recoverOffline } from './recovery.mts';
import { parseRun, renderComparison, renderReport } from './report.ts';
import { compareRuns, sampleProblems, summarize } from './statistics.ts';
import { canonicalPath, sha256, VaultTransaction } from './transaction.mts';
import { FIXTURE_FOLDER, scenarioIds, type ProfileRun, type Sample } from './types.ts';

let stopRequested = false;
function requestStop(): void {
  stopRequested = true;
  process.stderr.write(
    'Cancellation requested; waiting for the native operation, then restoring.\n',
  );
}
function checkCancellation(): void {
  if (stopRequested) throw new Error('Profile cancelled');
}

const HELP = `pnpm run profile [--runs 10] [--startup] [--anchor YYYY-MM-DD] [--out DIR] [--baseline DIR]
             [--vault-path PATH] [--width 420] [--fixture standard|wide-tree] [--no-diagnostics]
pnpm profile:startup [--runs 10]
pnpm profile:compare BEFORE_DIR AFTER_DIR
pnpm run profile --recover RUN_DIR
pnpm run profile --recover-offline RUN_DIR  (Obsidian must be fully closed)

Uses the running dev-vault-tasks only. Keep that window foreground and do not edit the dev vault during a run.
Artifacts and recovery backups stay local under docs/performance by default. Startup is a warm-host plugin restart.
`;

async function json(file: string, value: unknown): Promise<void> {
  await writeFile(file, JSON.stringify(value, null, 2));
}
async function loadRun(directory: string): Promise<ProfileRun> {
  return parseRun(await readFile(path.join(directory, 'run.json'), 'utf8'));
}
async function compare(before: string, after: string, output: string): Promise<void> {
  const result = compareRuns(await loadRun(before), await loadRun(after));
  await json(path.join(output, 'comparison.json'), result);
  await writeFile(path.join(output, 'comparison.md'), renderComparison(result));
  process.stdout.write(renderComparison(result));
  if (!result.compatible) process.exitCode = 2;
  else if (result.scenarios.some((s) => s.verdict === 'regression')) process.exitCode = 3;
}

async function inject(
  output: string,
  before: HostBefore,
  fixture: Fixture,
  mode: { startup: boolean; viewport: string },
): Promise<void> {
  await evaluate(
    `window.__abyssProfileModule=(0,eval)(require('fs').readFileSync(${JSON.stringify(path.join(output, 'native.js'))},'utf8')+'\\n__abyssProfileModule;');return true;`,
  );
  const options = {
    vault: before.vault,
    fixtureFolder: Object.keys(fixture.files)[0]?.split('/')[0],
    anchor: fixture.anchor,
    fixtureKind: fixture.kind,
    expectedRoots: fixture.roots,
    expectedNodes: fixture.nodes,
    ...mode,
  };
  await evaluate(`const fs=require('fs'),path=require('path'),out=${JSON.stringify(output)};
    const bridge={debugger:require('electron').remote.getCurrentWebContents().debugger,

      matchesWorkerSource:(source)=>source==='/* abyss-task-search-worker */'+fs.readFileSync(path.join(out,'search-worker.js'),'utf8'),
      save:(name,data)=>{if(path.basename(name)!==name)throw Error('Invalid artifact name');fs.writeFileSync(path.join(out,name),JSON.stringify(data));},
      saveImage:(name,data)=>fs.writeFileSync(path.join(out,name),Buffer.from(data,'base64'))};
    window.__abyssProfile=window.__abyssProfileModule.install(app,bridge,${JSON.stringify(options)});return true;`);
}

async function prepareVault(
  tx: VaultTransaction,
  before: HostBefore,
  output: string,
  fixture: Fixture,
): Promise<void> {
  await evaluate(`await app.plugins.disablePlugin('abyss-tasks');return true;`);
  for (const name of ['main.js', 'styles.css', 'manifest.json'])
    await tx.write(
      `${before.configDir}/plugins/abyss-tasks/${name}`,
      await readFile(path.join(output, name)),
    );
  const settings = effectiveSettings(fixture.settings);
  await tx.write(
    `${before.configDir}/plugins/abyss-tasks/data.json`,
    Buffer.from(JSON.stringify(settings)),
  );
  await tx.write(
    `${before.configDir}/plugins/abyss-tasks/state.json`,
    Buffer.from(JSON.stringify({ schemaVersion: 2, views: {} })),
  );
  for (const [relative, content] of Object.entries(fixture.files))
    await tx.write(relative, Buffer.from(content));
  await evaluate(
    `await window.__abyssProfile.prepareFixture(JSON.parse(require('fs').readFileSync(${JSON.stringify(path.join(output, 'fixture-contents.json'))},'utf8')));return true;`,
  );
}

async function resetCycle(tx: VaultTransaction, before: HostBefore, output: string): Promise<void> {
  await evaluate(
    `for(const l of app.workspace.getLeavesOfType('task-calendar-panel'))l.detach();await app.plugins.disablePlugin('abyss-tasks');return true;`,
  );
  await evaluate(
    `const files=JSON.parse(require('fs').readFileSync(${JSON.stringify(path.join(output, 'fixture-contents.json'))},'utf8'));await window.__abyssProfile.resetFixture(Object.fromEntries(Object.entries(files).filter(([p])=>p.endsWith('/inbox.md')||p.endsWith('/Project-000.md'))));return true;`,
  );
  await tx.write(
    `${before.configDir}/plugins/abyss-tasks/state.json`,
    Buffer.from(JSON.stringify({ schemaVersion: 2, views: {} })),
  );
}

export async function restoreHost(tx: VaultTransaction, before: HostBefore): Promise<void> {
  await tx.assertOwnership();
  const errors: unknown[] = [];
  try {
    await evaluate(
      `await window.__abyssProfile?.cleanup();delete window.__abyssProfile;delete window.__abyssProfileModule;for(const l of app.workspace.getLeavesOfType('task-calendar-panel'))l.detach();await app.plugins.disablePlugin('abyss-tasks');return true;`,
    );
  } catch (error) {
    errors.push(error);
  }
  // Never restore files while a failed native disable might still write them.
  if (errors.length > 0)
    throw new AggregateError(
      errors,
      'Native cleanup failed; use --recover after resolving the host error',
    );
  await tx.restore(false);
  if (before.viewportOverride === true) {
    await setDebugger(true);
    await evaluate(
      "await require('electron').remote.getCurrentWebContents().debugger.sendCommand('Emulation.clearDeviceMetricsOverride');return true;",
    );
  }

  const prefix = `${FIXTURE_FOLDER}/`;
  await evaluate(
    `const deadline=Date.now()+30000;while(app.vault.getFiles().some(f=>f.path.startsWith(${JSON.stringify(prefix)}))){if(Date.now()>deadline)throw Error('Fixture removal has not reached the host');await new Promise(r=>setTimeout(r,10));}
    ${before.enabled ? "await app.plugins.enablePlugin('abyss-tasks');" : ''}await app.workspace.changeLayout(${JSON.stringify(before.layout)});return true;`,
  );
  if (!before.debugger) await setDebugger(false);
  if (!(await tx.verify())) throw new Error('Restoration hash mismatch after host restoration');
  await tx.releaseLock();
}

async function recover(output: string): Promise<void> {
  const tx = await VaultTransaction.load(output);
  const before = JSON.parse(
    await readFile(path.join(output, 'host-before.json'), 'utf8'),
  ) as HostBefore;
  const current = await evaluate<string>('return app.vault.adapter.getBasePath();');
  if ((await canonicalPath(current)) !== tx.vault || before.vault !== tx.vault)
    throw new Error('Recovery vault does not match running dev-vault-tasks');
  await restoreHost(tx, before);
  process.stdout.write(`Restored ${tx.vault}; backups retained in ${output}\n`);
}

async function results(output: string, run: ProfileRun): Promise<void> {
  run.diagnostics = (await readdir(output)).filter((name) =>
    /(?:\.cpuprofile$|\.map$|\.png$|^(?:trace|memory-|diagnostic|analysis-dom|runtime-errors|source-maps|cpu-summary))/u.test(
      name,
    ),
  );
  await json(path.join(output, 'run.json'), run);
  const summary = run.expectedScenarios.map((id) => {
    const samples = run.samples.filter((s) => s.scenario === id);
    if (samples.length === 0) return { scenario: id, missing: true };
    const metrics = Object.fromEntries(
      (['durationMs', 'longTasks', 'longTaskMs', 'maxFrameGapMs', 'domNodes'] as const).map(
        (key) => {
          const values = samples.flatMap((sample) => (sample[key] === null ? [] : [sample[key]]));
          return [key, values.length === 0 ? null : summarize(values)];
        },
      ),
    );
    return { scenario: id, metrics, facts: samples[0]?.facts };
  });
  await json(path.join(output, 'summary.json'), {
    status: run.status,
    restored: run.restored,
    diagnostics: run.diagnostics,
    scenarios: summary,
  });
  await writeFile(path.join(output, 'report.md'), renderReport(run));
  process.stdout.write(
    `\n${run.status}: ${run.samples.length} samples, restoration ${run.restored ? 'verified' : 'FAILED'}\n${path.join(output, 'report.md')}\n${path.join(output, 'summary.json')}\n`,
  );
}

async function checkedHost(options: Options): Promise<HostBefore> {
  const before = await preflight();
  if (options.width !== undefined && (before.debugger || before.devtools))
    throw new Error('Close existing DevTools/debugger before using --width');
  before.viewportOverride = options.width !== undefined;
  before.runtimeErrors = await cli(['dev:errors']);
  if (!before.debugger) await setDebugger(false);
  before.vault = await canonicalPath(before.vault);
  if (options.vaultPath !== undefined && (await canonicalPath(options.vaultPath)) !== before.vault)
    throw new Error('--vault-path differs from the running vault');
  return before;
}

async function setDebugger(attached: boolean): Promise<void> {
  await evaluate(`const d=require('electron').remote.getCurrentWebContents().debugger;
    if(d.isAttached()!==${String(attached)})d.${attached ? "attach('1.3')" : 'detach()'};return true;`);
}

async function configureViewport(
  options: Options,
  before: HostBefore,
  run: ProfileRun,
): Promise<void> {
  if (options.width === undefined) return;
  await setDebugger(true);
  const metrics = {
    width: options.width,
    height: Number(String(before.identity['viewport']).split('x')[1]),
    deviceScaleFactor: before.identity['dpr'],
    mobile: false,
  };
  run.identity['viewport'] = await evaluate<string>(
    `await require('electron').remote.getCurrentWebContents().debugger.sendCommand('Emulation.setDeviceMetricsOverride',${JSON.stringify(metrics)});return innerWidth+'x'+innerHeight;`,
  );
  if (!String(run.identity['viewport']).startsWith(`${options.width}x`))
    throw new Error('Requested viewport width was not applied');
}

async function reserveOutput(
  root: string,
  options: Options,
  vault: string,
  id: string,
): Promise<string> {
  const output = await canonicalPath(options.out ?? path.join(root, 'docs/performance', id));
  if (output === vault || output.startsWith(`${vault}${path.sep}`))
    throw new Error('Output must be outside the vault');
  await mkdir(path.dirname(output), { recursive: true });
  await mkdir(output);
  await writeFile(path.join(output, 'owner.json'), JSON.stringify({ pid: process.pid, id }), {
    flag: 'wx',
  });
  return output;
}

async function validateRun(
  output: string,
  run: ProfileRun,
  options: Options,
  before: HostBefore,
): Promise<void> {
  const day = await evaluate<string>("return new Date().toLocaleDateString('en-CA');");
  if (day !== run.identity['day'])
    throw new Error('Host day changed during profiling; repeat the run');
  const runtimeErrors = await cli(['dev:errors']);
  await writeFile(path.join(output, 'runtime-errors.txt'), runtimeErrors);
  if (runtimeErrors !== before.runtimeErrors)
    throw new Error('New host runtime errors; see runtime-errors.txt');
  if (options.diagnostics) await writeCpuEvidence(output);
  const problems = sampleProblems(run.samples, run.expectedScenarios, options.runs);
  if (problems.length > 0) throw new Error(problems.join('; '));
}

async function runSuite(root: string, options: Options): Promise<void> {
  const before = await checkedHost(options);
  const id = new Date().toISOString().replaceAll(':', '-');
  const output = await reserveOutput(root, options, before.vault, id);
  const fixture = createFixture(options.anchor ?? String(before.identity['day']), options.fixture);
  await json(path.join(output, 'settings.json'), effectiveSettings(fixture.settings));
  await json(path.join(output, 'fixture-contents.json'), fixture.files);
  process.stdout.write(
    `Building production artifacts; ${fixture.nodes} live nodes, ${fixture.archiveRoots} archived roots.\n`,
  );
  const build = await prepareBuild(root, output);
  await json(path.join(output, 'host-before.json'), before);
  await json(path.join(output, 'fixture.json'), {
    ...fixture,
    files: Object.fromEntries(
      Object.entries(fixture.files).map(([name, content]) => [name, sha256(content)]),
    ),
  });
  const run = await newRun({ root, before, fixture, options, id, build });
  const tx = await VaultTransaction.begin(before.vault, output, before.configDir);
  try {
    await configureViewport(options, before, run);
    await inject(output, before, fixture, {
      startup: options.startup,
      viewport: String(run.identity['viewport']),
    });
    await prepareVault(tx, before, output, fixture);
    await iterations(tx, before, output, { options, run });
    await validateRun(output, run, options, before);
    run.status = 'complete';
  } catch (error) {
    run.errors.push(String(error instanceof Error ? error.stack : error));
  } finally {
    try {
      await restoreHost(tx, before);
      run.restored = true;
    } catch (error) {
      run.errors.push(`Restoration: ${String(error)}`);
      run.status = 'failed';
    }
    await results(output, run);
  }
  if (run.status !== 'complete' || !run.restored)
    throw new Error(
      `Profile failed: ${run.errors.join('\n')}\nRecovery: pnpm run profile --recover ${output}`,
    );
  if (options.baseline !== undefined) await compare(options.baseline, output, output);
}

async function newRun(input: {
  root: string;
  before: HostBefore;
  fixture: Fixture;
  options: Options;
  id: string;
  build: ProfileRun['build'];
}): Promise<ProfileRun> {
  const { root, before, fixture, options, id, build } = input;
  return {
    schemaVersion: 1,
    id,
    createdAt: new Date().toISOString(),
    status: 'failed',
    restored: false,
    build,
    identity: {
      ...before.identity,
      fixture: fixture.digest,
      fixtureKind: fixture.kind,
      fixtureRoots: fixture.roots,
      fixtureNodes: fixture.nodes,
      maxChildrenPerRoot: fixture.maxChildrenPerRoot,
      largestRootBytes: fixture.largestRootBytes,
      settings: sha256(JSON.stringify(effectiveSettings(fixture.settings))),
      protocol: await protocolHash(root),
      cpu: cpus()[0]?.model ?? 'unknown',
      memory: totalmem(),
      platform: platform(),
      startupOnly: options.startup,
      preexistingDebugger: before.debugger,
      viewportOverride: options.width !== undefined,
    },
    expectedScenarios: scenarioIds(fixture.kind, options.startup),
    samples: [],
    errors: [],
    diagnostics: [],
  };
}

async function iterations(
  tx: VaultTransaction,
  before: HostBefore,
  output: string,
  input: { options: Options; run: ProfileRun },
): Promise<void> {
  const { options, run } = input;
  for (let i = -1; i < options.runs; i++) {
    checkCancellation();
    const label = i < 0 ? 'Warmup' : `Measurement ${i + 1}/${options.runs}`;
    process.stdout.write(`${label}\n`);
    await resetCycle(tx, before, output);
    const samples = await evaluate<Sample[]>(
      `return await window.__abyssProfile.cycle(${i},false);`,
    );
    if (i >= 0) run.samples.push(...samples);
  }
  checkCancellation();
  if (options.diagnostics) {
    process.stdout.write('Separate CDP diagnostic pass\n');
    await setDebugger(true);
    await resetCycle(tx, before, output);
    await evaluate('return await window.__abyssProfile.cycle(0,true);');
  }
}

export async function main(args: string[], root: string): Promise<void> {
  process.on('SIGINT', requestStop);
  process.on('SIGTERM', requestStop);
  try {
    const options = parseOptions(args);
    if (options.help) {
      process.stdout.write(HELP);
      return;
    }
    if (options.compare !== undefined) {
      await compare(options.compare[0], options.compare[1], options.compare[1]);
      return;
    }
    if (options.recover !== undefined) {
      await recover(options.recover);
      return;
    }
    if (options.recoverOffline !== undefined) {
      await recoverOffline(options.recoverOffline);
      return;
    }
    await runSuite(root, options);
  } catch (error) {
    process.stderr.write(
      `Performance command failed: ${String(error instanceof Error ? error.stack : error)}\n`,
    );
    process.exitCode = 1;
  } finally {
    process.off('SIGINT', requestStop);
    process.off('SIGTERM', requestStop);
  }
}
