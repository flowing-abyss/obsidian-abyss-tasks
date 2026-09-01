import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { deflateSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';

const scratch: string[] = [];

interface QaModule {
  validateAndExpandScenarios(value: unknown): any[];
  assertExactDevVault(path: string): string;
  verifyEvidenceMatrix(scenarios: any[], evidence: any[], options: any): unknown;
  canonicalSnapshotHash(value: unknown): string;
  createFixtureBackup(vault: string, out: string): Promise<any[]>;
  restoreFixtureBackup(vault: string, out: string): Promise<any[]>;
  manifestForDirectory(root: string): Promise<any[]>;
  diffManifests(expected: any[], actual: any[]): string[];
  verifyEvidenceArtifacts(scenario: any, record: any, out: string): Promise<void>;
  validateEvidenceDocument(schema: unknown, value: unknown): void;
  assertAllowedCommand(command: string, args: string[]): void;
  proveExactRunningVault(execute: (...args: any[]) => any): string;
  normalizeObsidianCliOutput(stdout: string): string;
  parseJsonEvalOutput(value: string, context: string): unknown;
  measurementEval(measurement: unknown): string;
  surfaceNavigationEval(scenario: { navigationEval: string }): string;
  runCaptureWithRecovery<T>(
    capture: () => Promise<T>,
    recover: () => void,
    safeToRetry: boolean,
  ): Promise<T>;
  assertSafeEvidenceOut(path: string): string;
  runNativePointerPhase(
    ports: {
      pickup(): void;
      captureObserved(): boolean;
      drag(): void;
      release(point: { x: number; y: number }): void;
      cleanup(): void;
      wait(): void;
    },
    points: {
      source: { x: number; y: number };
      pickup: { x: number; y: number };
      target: { x: number; y: number };
    },
    maxCaptureAttempts?: number,
  ): boolean;
}

const REQUIRED_WORKFLOWS = [
  'work-note-create',
  'work-note-ownership',
  'work-note-relations',
  'work-note-progress',
  'work-note-safe-delete',
  'milestone-assignment',
  'milestone-progress-filter',
  'projects-board-move',
  'projects-board-rollback',
  'projects-timeline-move-resize',
  'projects-timeline-rollback',
  'pending-conflict-undo',
  'persistence-plugin-reload',
  'persistence-app-restart',
  'settings-validation-diagnostics',
] as const;

async function qaModule(): Promise<QaModule> {
  return (await import('../scripts/devvault-qa.mjs')) as unknown as QaModule;
}

function scenarioDocument(): any {
  const ids = [
    'tasks',
    'projects-table',
    'projects-board',
    'projects-timeline',
    'project-task-list',
    'project-task-table',
    'project-task-board',
    'project-task-timeline',
    'project-work-notes',
    'task-inspector',
    'project-inspector',
    'work-note-inspector',
    'milestones',
    'settings',
  ];
  const surfaces = ids.map((id) => ({
    id,
    expectedWindowTitle: 'Abyss Tasks',
    rootSelector: '.abyss-center-panel',
    expectedLandmark: 'Tasks',
    navigationEval:
      "document.querySelector('.abyss-rail-btn[aria-label=\"Tasks\"]')?.click()",
    readyEval: '!!document.querySelector(".abyss-center-panel")',
    setupEval: ['document.body.dataset.qaSurface="tasks"'],
    stateSnapshot: {
      beforeEval: '({selected:document.activeElement?.getAttribute("aria-label")??null})',
      afterEval: '({selected:document.activeElement?.getAttribute("aria-label")??null})',
      expect: 'changed',
    },
    interactions: [{ type: 'key', key: 'q', workflow: true }],
    postconditions: [
      {
        id: `${id}-domain-result`,
        type: 'eval-truthy',
        code: 'document.body.dataset.qaSurface==="tasks"',
      },
    ],
    assertions: [{ type: 'dom-contains', value: 'Tasks' }],
    measurements: [
      {
        id: `${id}-density`,
        type: 'density',
        selector: '.abyss-center-panel',
        min: 0.5,
        max: 8,
      },
      {
        id: `${id}-native-reference`,
        type: 'native-reference',
        selector: '.abyss-task-card',
        referenceSelector: '.setting-item',
        metric: 'height-ratio',
        min: 0.5,
        max: 5,
      },
    ],
  }));
  return {
    version: 1,
    surfaces,
    workflows: REQUIRED_WORKFLOWS.map((id) => ({
      id,
      expectedWindowTitle: 'Abyss Tasks',
      rootSelector: '.abyss-center-panel',
      expectedLandmark: 'Tasks',
      setupEval: ['document.body.dataset.qaWorkflow="ready"'],
      stateSnapshot: {
        beforeEval: '({state:document.body.dataset.qaWorkflow})',
        afterEval: '({state:document.body.dataset.qaWorkflow})',
        expect: 'changed',
      },
      interactions: [
        {
          type: 'key',
          key: 'q',
          workflow: true,
        },
      ],
      postconditions: [
        {
          id: `${id}-domain-result`,
          type: 'eval-equals',
          code: 'document.body.dataset.qaWorkflow',
          expected: 'ready',
        },
      ],
      assertions: [{ type: 'dom-contains', value: 'Tasks' }],
      measurements: [
        {
          id: `${id}-density`,
          type: 'density',
          selector: '.abyss-task-card',
          min: 0.5,
          max: 8,
        },
        {
          id: `${id}-native-reference`,
          type: 'native-reference',
          selector: '.abyss-center-panel',
          referenceSelector: '.setting-item',
          metric: 'height-ratio',
          min: 0.5,
          max: 5,
        },
      ],
    })),
    matrix: {
      themes: ['dark', 'light'],
      widths: [1440, 900, 760, 440],
      zooms: [1, 2],
      pointers: ['fine', 'coarse', 'hover-none'],
    },
  };
}

function evidenceRecord(
  scenarioId: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const beforeState = { selected: null };
  const afterState = { selected: 'Quick capture' };
  const interactionResult = false;
  const canonical = (value: unknown) =>
    createHash('sha256').update(JSON.stringify(value)).digest('hex');
  return {
    scenarioId,
    status: 'accepted',
    reason: 'Expected Obsidian surface, DOM landmark, and nonblank pixels were captured.',
    expectedWindowTitle: 'Abyss Tasks',
    observedWindowTitle: 'Abyss Tasks',
    rootSelector: '.abyss-center-panel',
    observedRootSelector: '.abyss-center-panel',
    expectedLandmark: 'Tasks',
    observedLandmark: 'Tasks',
    theme: 'dark',
    observedTheme: 'dark',
    viewportWidth: 1440,
    observedViewportWidth: 1440,
    requestedZoom: 1,
    requestedPointerMedia: 'fine',
    workflow: {
      type: 'keyboard',
      changed: true,
      beforeSha256: canonical(beforeState),
      afterSha256: canonical(afterState),
      beforeState,
      afterState,
      interaction: {
        actionType: 'key',
        resultSha256: canonical(interactionResult),
        result: interactionResult,
      },
    },
    postconditions: [
      {
        id: 'tasks-domain-result',
        passed: true,
        actualSha256: canonical(true),
        actual: true,
      },
    ],
    measurements: [
      {
        id: 'tasks-density',
        type: 'density',
        value: 2,
        passed: true,
        details: { itemCount: 4, spanHeight: 20 },
        detailsSha256: canonical({ itemCount: 4, spanHeight: 20 }),
      },
      {
        id: 'tasks-native-reference',
        type: 'native-reference',
        value: 1.5,
        passed: true,
        details: { referenceHeight: 24, targetHeight: 36 },
        detailsSha256: canonical({ referenceHeight: 24, targetHeight: 36 }),
      },
    ],
    screenshot: {
      sha256: 'a'.repeat(64),
      width: 2880,
      height: 1800,
      nonblankHistogram: [0, 12, 5, 0],
    },
    domSha256: 'b'.repeat(64),
    accessibility: { provider: 'macos-ax', sha256: 'c'.repeat(64) },
    dpr: 2,
    observedZoom: 1,
    observedPointerMedia: 'fine',
    pluginArtifactSha256: 'd'.repeat(64),
    fixtureManifestSha256: 'e'.repeat(64),
    ...overrides,
  };
}

function opaqueTestPng(): Buffer {
  const chunk = (type: string, data: Buffer): Buffer => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    return Buffer.concat([length, Buffer.from(type, 'ascii'), data, Buffer.alloc(4)]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.from([0, 32, 64, 96, 255]))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

afterEach(async () => {
  await Promise.all(scratch.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

describe('Dev Vault QA harness scenario contract', () => {
  it('rejects a malformed scenario document before any capture work', async () => {
    const qa = await qaModule();
    expect(qa.validateAndExpandScenarios).toBeTypeOf('function');
    if (typeof qa.validateAndExpandScenarios !== 'function') return;

    const malformed = scenarioDocument();
    malformed.matrix.widths = [1440, 901, 760, 440];

    expect(() => qa.validateAndExpandScenarios(malformed)).toThrow(/width.*901/iu);
    expect(() =>
      qa.validateAndExpandScenarios({
        ...scenarioDocument(),
        surfaces: [
          {
            ...scenarioDocument().surfaces[0],
            interactions: [{ type: 'click' }],
          },
        ],
      }),
    ).toThrow(/selector/iu);
    expect(() =>
      qa.validateAndExpandScenarios({
        ...scenarioDocument(),
        surfaces: [
          {
            ...scenarioDocument().surfaces[0],
            assertions: [{ type: 'click-text', value: 'wrong contract' }],
          },
        ],
      }),
    ).toThrow(/assertion|unsupported/iu);
    expect(() =>
      qa.validateAndExpandScenarios({
        ...scenarioDocument(),
        surfaces: scenarioDocument().surfaces.map((surface: any, index: number) =>
          index === 0
            ? {
                ...surface,
                interactions: [
                  { type: 'key', key: 'q', workflow: true, fabricatedField: 'ignored' },
                ],
              }
            : surface,
        ),
      }),
    ).toThrow(/additional|fabricatedField/iu);
    expect(() =>
      qa.validateAndExpandScenarios({
        ...scenarioDocument(),
        surfaces: scenarioDocument().surfaces.map((surface: any, index: number) =>
          index === 0
            ? {
                ...surface,
                assertions: [{ type: 'dom-contains', value: 'Tasks', workflow: true }],
              }
            : surface,
        ),
      }),
    ).toThrow(/assertion.*workflow|additional/iu);

    const missingPostconditions = scenarioDocument();
    missingPostconditions.surfaces[0]!.postconditions = [];
    expect(() => qa.validateAndExpandScenarios(missingPostconditions)).toThrow(/postcondition/iu);

    const unpairedMeasurements = scenarioDocument();
    unpairedMeasurements.surfaces[0]!.measurements = [
      unpairedMeasurements.surfaces[0]!.measurements[0],
    ];
    expect(() => qa.validateAndExpandScenarios(unpairedMeasurements)).toThrow(
      /native Obsidian reference|pair density/iu,
    );

    const meaninglessDensity = scenarioDocument();
    meaninglessDensity.surfaces[0]!.measurements[0] = {
      ...meaninglessDensity.surfaces[0]!.measurements[0],
      min: 0.01,
      max: 200,
    };
    expect(() => qa.validateAndExpandScenarios(meaninglessDensity)).toThrow(/density range/iu);

    const genericState = scenarioDocument();
    genericState.surfaces[0]!.stateSnapshot = {
      beforeEval: 'document.body.innerHTML',
      afterEval: 'document.body.innerHTML',
      expect: 'changed',
    };
    expect(() => qa.validateAndExpandScenarios(genericState)).toThrow(
      /canonical.*domain|innerHTML/iu,
    );

    const pointerWithoutGeometry = scenarioDocument();
    pointerWithoutGeometry.surfaces[0]!.interactions = [
      {
        type: 'pointer-drag',
        selector: '.source',
        targetSelector: '.target',
        workflow: true,
      },
    ];
    expect(() => qa.validateAndExpandScenarios(pointerWithoutGeometry)).toThrow(
      /coordinates|threshold|capture|document/iu,
    );

    const missingNavigation = scenarioDocument();
    delete missingNavigation.surfaces[0]!.navigationEval;
    expect(() => qa.validateAndExpandScenarios(missingNavigation)).toThrow(/navigation/iu);

    const missingReadiness = scenarioDocument();
    delete missingReadiness.surfaces[0]!.readyEval;
    expect(() => qa.validateAndExpandScenarios(missingReadiness)).toThrow(/ready|readiness/iu);
  });

  it('expands every required surface across the complete deterministic matrix', async () => {
    const qa = await qaModule();
    expect(qa.validateAndExpandScenarios).toBeTypeOf('function');
    if (typeof qa.validateAndExpandScenarios !== 'function') return;
    const manifestPath = resolve(process.cwd(), 'scripts/devvault-qa/scenarios.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as unknown;

    const scenarios = qa.validateAndExpandScenarios(manifest) as Array<{
      id: string;
      surface: string;
      interactions: Array<{ type: string; dispatchTarget?: string; workflow?: boolean }>;
      measurements: Array<{ type: string }>;
      postconditions: unknown[];
      stateSnapshot: { expect: string };
    }>;
    const requiredSurfaces = [
      'tasks',
      'projects-table',
      'projects-board',
      'projects-timeline',
      'project-task-list',
      'project-task-table',
      'project-task-board',
      'project-task-timeline',
      'project-work-notes',
      'task-inspector',
      'project-inspector',
      'work-note-inspector',
      'milestones',
      'settings',
    ];

    expect(scenarios).toHaveLength(
      requiredSurfaces.length * 2 * 4 * 2 * 3 + REQUIRED_WORKFLOWS.length,
    );
    expect(new Set(scenarios.map(({ id }) => id)).size).toBe(scenarios.length);
    for (const surface of requiredSurfaces) {
      expect(scenarios.some(({ id }) => id === `${surface}--dark--1440--z1--fine`)).toBe(true);
      expect(scenarios.some(({ id }) => id === `${surface}--light--440--z2--hover-none`)).toBe(
        true,
      );
    }
    for (const workflow of REQUIRED_WORKFLOWS) {
      const scenario = scenarios.find(
        ({ id }: { id: string }) => id === `${workflow}--dark--1440--z1--fine`,
      ) as { postconditions?: unknown[]; stateSnapshot?: { expect?: string } } | undefined;
      expect(scenario?.postconditions?.length).toBeGreaterThan(0);
      expect(['changed', 'unchanged']).toContain(scenario?.stateSnapshot?.expect);
    }
    for (const scenario of scenarios) {
      expect(new Set(scenario.measurements.map(({ type }) => type))).toEqual(
        new Set(['density', 'native-reference']),
      );
    }
    expect(
      scenarios.find(({ surface }) => surface === 'projects-board-move')?.interactions,
    ).toContainEqual(expect.objectContaining({ type: 'pointer-drag', dispatchTarget: 'source' }));
    expect(
      scenarios.find(({ surface }) => surface === 'projects-timeline-move-resize')?.interactions,
    ).toContainEqual(expect.objectContaining({ type: 'pointer-drag', dispatchTarget: 'document' }));
    expect(
      scenarios.find(({ surface }) => surface === 'work-note-safe-delete')?.stateSnapshot.expect,
    ).toBe('changed');
    expect(
      scenarios.find(({ surface }) => surface === 'persistence-app-restart')?.interactions,
    ).toContainEqual(expect.objectContaining({ type: 'app-restart', workflow: true }));
    const incomplete = JSON.parse(JSON.stringify(manifest)) as {
      surfaces: unknown[];
    };
    incomplete.surfaces.pop();
    expect(() => qa.validateAndExpandScenarios(incomplete)).toThrow(/required surface/iu);

    const incompleteWorkflow = JSON.parse(JSON.stringify(manifest)) as {
      workflows: unknown[];
    };
    incompleteWorkflow.workflows.pop();
    expect(() => qa.validateAndExpandScenarios(incompleteWorkflow)).toThrow(/required workflow/iu);
  });

  it('requires real pointer geometry and native density/reference measurement contracts', async () => {
    const qa = await qaModule();
    const document = scenarioDocument();
    document.surfaces[0]!.interactions = [
      {
        type: 'pointer-drag',
        selector: '.source',
        targetSelector: '.target',
        coordinates: {
          source: { x: 0.5, y: 0.5 },
          target: { x: 0.5, y: 0.5 },
        },
        movementThreshold: 4,
        dispatchTarget: 'document',
        requirePointerCapture: true,
        workflow: true,
      },
    ];
    document.surfaces[0]!.measurements = [
      {
        id: 'native-row-height',
        type: 'native-reference',
        selector: '.abyss-task-card',
        referenceSelector: '.setting-item',
        metric: 'height-ratio',
        min: 0.5,
        max: 1.5,
      },
      {
        id: 'task-density',
        type: 'density',
        selector: '.abyss-task-card',
        min: 1,
        max: 8,
      },
    ];

    const [scenario] = qa.validateAndExpandScenarios(document);
    expect(scenario.interactions[0]).toMatchObject({
      movementThreshold: 4,
      dispatchTarget: 'document',
      requirePointerCapture: true,
    });
    expect(scenario.measurements).toHaveLength(2);
  });

  it('rejects every vault except the repository Dev Vault, including the real vault', async () => {
    const qa = await qaModule();
    expect(qa.assertExactDevVault).toBeTypeOf('function');
    if (typeof qa.assertExactDevVault !== 'function') return;

    expect(() => qa.assertExactDevVault('/Users/flowing-abyss/Base/Obsidian')).toThrow(
      /refusing.*Dev Vault/iu,
    );
    expect(() => qa.assertExactDevVault(resolve(process.cwd(), 'dev-vault-copy'))).toThrow(
      /refusing.*Dev Vault/iu,
    );
    expect(() => qa.assertExactDevVault(`${process.cwd()}/dev-vault/../dev-vault`)).toThrow(
      /exact Dev Vault/iu,
    );
    expect(qa.assertExactDevVault(resolve(process.cwd(), 'dev-vault'))).toBe(
      resolve(process.cwd(), 'dev-vault'),
    );
  });

  it('allows only exact Obsidian CLI, launch, and accessibility commands', async () => {
    const qa = await qaModule();

    expect(() => qa.assertAllowedCommand('open', ['-a', 'Obsidian'])).not.toThrow();
    expect(() =>
      qa.assertAllowedCommand('obsidian', ['vault=dev-vault', 'eval', 'code=1']),
    ).not.toThrow();
    expect(() => qa.assertAllowedCommand('pgrep', ['-x', 'Obsidian'])).not.toThrow();
    expect(() =>
      qa.assertAllowedCommand('osascript', ['-l', 'JavaScript', '-e', 'true']),
    ).not.toThrow();
    expect(() => qa.assertAllowedCommand('open', ['/Applications/Obsidian.app'])).toThrow(
      /allowlist/iu,
    );
    expect(() => qa.assertAllowedCommand('obsidian', ['vault=Obsidian', 'eval', 'code=1'])).toThrow(
      /allowlist/iu,
    );
    expect(() => qa.assertAllowedCommand('pkill', ['Obsidian'])).toThrow(/allowlist/iu);
    expect(() => qa.assertAllowedCommand('pgrep', ['-f', 'Obsidian'])).toThrow(/allowlist/iu);
  });

  it.each(['pickup', 'capture', 'drag'] as const)(
    'always releases native pointer state and removes observers after %s failure',
    async (failure) => {
      const qa = await qaModule();
      const releases: Array<{ x: number; y: number }> = [];
      let cleanupCount = 0;
      const invoke = () =>
        qa.runNativePointerPhase(
          {
            pickup: () => {
              if (failure === 'pickup') throw new Error('pickup failed');
            },
            captureObserved: () => failure !== 'capture',
            drag: () => {
              if (failure === 'drag') throw new Error('drag failed');
            },
            release: (point) => releases.push(point),
            cleanup: () => {
              cleanupCount += 1;
            },
            wait: () => {},
          },
          {
            source: { x: 1, y: 2 },
            pickup: { x: 6, y: 2 },
            target: { x: 50, y: 20 },
          },
          2,
        );

      expect(invoke).toThrow(/pickup|capture|drag/iu);
      expect(releases).toEqual([
        failure === 'pickup'
          ? { x: 1, y: 2 }
          : failure === 'capture'
            ? { x: 6, y: 2 }
            : { x: 50, y: 20 },
      ]);
      expect(cleanupCount).toBe(1);
    },
  );

  it('proves the absolute running vault before recovery and only recovers with open -a Obsidian', async () => {
    const qa = await qaModule();
    const expected = resolve(process.cwd(), 'dev-vault');
    const calls: Array<{ command: string; args: string[] }> = [];
    const results = [
      { status: 1, stdout: '', stderr: 'not connected' },
      { status: 0, stdout: '', stderr: '' },
      { status: 0, stdout: expected, stderr: '' },
    ];
    const execute = (command: string, args: string[]) => {
      calls.push({ command, args });
      return results.shift();
    };

    expect(qa.proveExactRunningVault(execute)).toBe(expected);
    expect(calls).toEqual([
      {
        command: 'obsidian',
        args: ['vault=dev-vault', 'eval', 'code=app.vault.adapter.basePath'],
      },
      { command: 'open', args: ['-a', 'Obsidian'] },
      {
        command: 'obsidian',
        args: ['vault=dev-vault', 'eval', 'code=app.vault.adapter.basePath'],
      },
    ]);
    expect(() =>
      qa.proveExactRunningVault(() => ({
        status: 0,
        stdout: '/Users/flowing-abyss/Base/Obsidian',
        stderr: '',
      })),
    ).toThrow(/running vault/iu);

    expect(
      qa.proveExactRunningVault(() => ({
        status: 0,
        stdout: `=> ${expected}`,
        stderr: '',
      })),
    ).toBe(expected);
    expect(qa.normalizeObsidianCliOutput(`=> ${JSON.stringify('{"ready":true}')}`)).toBe(
      '{"ready":true}',
    );
  });

  it('reports non-JSON eval failures with the scenario and action context', async () => {
    const qa = await qaModule();

    expect(() =>
      qa.parseJsonEvalOutput(
        'Error: Missing text interaction target Table',
        'projects-table--dark--1440--z1--fine interaction[0] click-text',
      ),
    ).toThrow(
      /projects-table--dark--1440--z1--fine interaction\[0\] click-text.*Missing text interaction target Table/iu,
    );
  });

  it('measures against the first visible native Obsidian reference', async () => {
    const qa = await qaModule();
    document.body.innerHTML = `
      <div class="qa-target"></div>
      <div class="qa-reference is-hidden"></div>
      <div class="qa-reference is-visible"></div>`;
    const target = document.querySelector<HTMLElement>('.qa-target')!;
    const hidden = document.querySelector<HTMLElement>('.qa-reference.is-hidden')!;
    const visible = document.querySelector<HTMLElement>('.qa-reference.is-visible')!;
    target.getBoundingClientRect = () => ({ height: 40 }) as DOMRect;
    hidden.getBoundingClientRect = () => ({ height: 0 }) as DOMRect;
    visible.getBoundingClientRect = () => ({ height: 20 }) as DOMRect;

    const result = JSON.parse(
      Function(
        `return ${qa.measurementEval({
          type: 'native-reference',
          selector: '.qa-target',
          referenceSelector: '.qa-reference',
        })}`,
      )(),
    ) as { value: number; details: { referenceHeight: number } };

    expect(result).toEqual({
      value: 2,
      details: { targetHeight: 40, referenceHeight: 20 },
    });
  });

  it('returns from an open project before selecting a deterministic portfolio layout', async () => {
    const qa = await qaModule();
    const manifest = JSON.parse(
      await readFile(resolve(process.cwd(), 'scripts/devvault-qa/scenarios.json'), 'utf8'),
    ) as { surfaces: Array<{ id: string; navigationEval: string }> };
    const scenario = manifest.surfaces.find(({ id }) => id === 'projects-table')!;
    document.body.innerHTML = `
      <button class="abyss-rail-btn" aria-label="Projects"></button>
      <button class="abyss-project-back"></button>
      <button data-project-portfolio-layout="overview"></button>`;
    let backClicks = 0;
    let layoutClicks = 0;
    document.querySelector('.abyss-project-back')!.addEventListener('click', () => {
      backClicks += 1;
    });
    document
      .querySelector('[data-project-portfolio-layout="overview"]')!
      .addEventListener('click', () => {
        layoutClicks += 1;
      });

    await Function(
      'app',
      `return ${qa.surfaceNavigationEval(scenario)}`,
    )({ commands: { executeCommandById: async () => true } });

    expect(backClicks).toBe(1);
    expect(layoutClicks).toBe(1);
  });

  it('restarts and retries one read-only surface after a bounded CLI timeout', async () => {
    const qa = await qaModule();
    let captures = 0;
    let recoveries = 0;
    const timeout = Object.assign(new Error('CLI timed out'), { code: 'QA_CLI_TIMEOUT' });

    await expect(
      qa.runCaptureWithRecovery(
        async () => {
          captures += 1;
          if (captures === 1) throw timeout;
          return 'captured';
        },
        () => {
          recoveries += 1;
        },
        true,
      ),
    ).resolves.toBe('captured');
    expect({ captures, recoveries }).toEqual({ captures: 2, recoveries: 1 });

    captures = 0;
    recoveries = 0;
    await expect(
      qa.runCaptureWithRecovery(
        async () => {
          captures += 1;
          throw timeout;
        },
        () => {
          recoveries += 1;
        },
        false,
      ),
    ).rejects.toThrow(/timed out/iu);
    expect({ captures, recoveries }).toEqual({ captures: 1, recoveries: 0 });
  });

  it('rejects evidence paths that traverse an existing symlink', async () => {
    const qa = await qaModule();
    const sdd = resolve(process.cwd(), '.superpowers', 'sdd');
    await mkdir(sdd, { recursive: true });
    const root = await mkdtemp(join(sdd, 'devvault-qa-symlink-test-'));
    scratch.push(root);
    const allowed = join(root, 'devvault-qa');
    const outside = await mkdtemp(join(tmpdir(), 'abyss-qa-escape-'));
    scratch.push(outside);
    await mkdir(allowed, { recursive: true });
    await symlink(outside, join(allowed, 'escape'));

    expect(() => qa.assertSafeEvidenceOut(join(allowed, 'escape', 'run'))).toThrow(/symlink/iu);
  });
});

describe('Dev Vault QA evidence contract', () => {
  it('loads the committed evidence schema and rejects additional fields', async () => {
    const qa = await qaModule();
    const schema = JSON.parse(
      await readFile(resolve(process.cwd(), 'scripts/devvault-qa/evidence.schema.json'), 'utf8'),
    ) as unknown;
    const scenario = qa.validateAndExpandScenarios(scenarioDocument())[0]!;

    expect(() => qa.validateEvidenceDocument(schema, [evidenceRecord(scenario.id)])).not.toThrow();
    expect(() =>
      qa.validateEvidenceDocument(schema, [
        { ...evidenceRecord(scenario.id), fabricatedExtra: true },
      ]),
    ).toThrow(/additional|fabricatedExtra/iu);
  });

  it('reopens paired screenshot, DOM, AX, and per-scenario JSON instead of trusting hashes', async () => {
    const qa = await qaModule();
    const scenario = qa.validateAndExpandScenarios(scenarioDocument())[0]!;
    const record = evidenceRecord(scenario.id);
    const out = await mkdtemp(join(tmpdir(), 'abyss-qa-artifacts-'));
    scratch.push(out);
    await Promise.all(
      ['screenshots', 'dom', 'accessibility', 'workflow', 'evidence'].map((name) =>
        mkdir(join(out, name), { recursive: true }),
      ),
    );
    await writeFile(join(out, 'screenshots', `${scenario.id}.png`), 'not a png', 'utf8');
    await writeFile(join(out, 'dom', `${scenario.id}.html`), '<main>wrong DOM</main>\n', 'utf8');
    await writeFile(join(out, 'accessibility', `${scenario.id}.json`), '{}\n', 'utf8');
    await writeFile(join(out, 'workflow', `${scenario.id}.before.json`), '{}\n', 'utf8');
    await writeFile(join(out, 'workflow', `${scenario.id}.after.json`), '{}\n', 'utf8');
    await writeFile(
      join(out, 'evidence', `${scenario.id}.json`),
      `${JSON.stringify(record)}\n`,
      'utf8',
    );

    await expect(qa.verifyEvidenceArtifacts(scenario, record, out)).rejects.toThrow(
      /screenshot|PNG|hash/iu,
    );
  });

  it('derives workflow state change from reopened before and after snapshots', async () => {
    const qa = await qaModule();
    const scenario = qa.validateAndExpandScenarios(scenarioDocument())[0]!;
    const out = await mkdtemp(join(tmpdir(), 'abyss-qa-workflow-'));
    scratch.push(out);
    await Promise.all(
      ['screenshots', 'dom', 'accessibility', 'workflow', 'evidence'].map((name) =>
        mkdir(join(out, name), { recursive: true }),
      ),
    );
    const png = opaqueTestPng();
    const dom = '<main>Tasks</main>';
    const accessibility: unknown[] = [];
    const unchanged = { focused: 'same-task', text: 'same state' };
    const unchangedHash = qa.canonicalSnapshotHash(unchanged);
    const histogram = Array.from({ length: 16 }, (_, index) => (index === 3 ? 1 : 0));
    const record = evidenceRecord(scenario.id, {
      screenshot: {
        sha256: createHash('sha256').update(png).digest('hex'),
        width: 1,
        height: 1,
        nonblankHistogram: histogram,
      },
      domSha256: qa.canonicalSnapshotHash(dom),
      accessibility: {
        provider: 'macos-ax',
        sha256: qa.canonicalSnapshotHash(accessibility),
      },
      workflow: {
        type: 'keyboard',
        changed: true,
        beforeSha256: unchangedHash,
        afterSha256: unchangedHash,
        beforeState: unchanged,
        afterState: unchanged,
        interaction: {
          actionType: 'key',
          resultSha256: qa.canonicalSnapshotHash(false),
          result: false,
        },
      },
    });
    await writeFile(join(out, 'screenshots', `${scenario.id}.png`), png);
    await writeFile(join(out, 'dom', `${scenario.id}.html`), `${dom}\n`, 'utf8');
    await writeFile(
      join(out, 'accessibility', `${scenario.id}.json`),
      `${JSON.stringify(accessibility)}\n`,
      'utf8',
    );
    await writeFile(
      join(out, 'workflow', `${scenario.id}.before.json`),
      `${JSON.stringify(unchanged)}\n`,
      'utf8',
    );
    await writeFile(
      join(out, 'workflow', `${scenario.id}.after.json`),
      `${JSON.stringify(unchanged)}\n`,
      'utf8',
    );
    await writeFile(
      join(out, 'evidence', `${scenario.id}.json`),
      `${JSON.stringify(record)}\n`,
      'utf8',
    );

    await expect(qa.verifyEvidenceArtifacts(scenario, record, out)).rejects.toThrow(
      /workflow.*changed|state-change/iu,
    );
  });

  it('rejects evidence without paired canonical domain state and passing postconditions', async () => {
    const qa = await qaModule();
    const [scenario] = qa.validateAndExpandScenarios(scenarioDocument());
    const options = {
      pluginArtifactSha256: 'd'.repeat(64),
      fixtureManifestSha256: 'e'.repeat(64),
      passingFallbackTests: [],
    };
    const missingCanonicalPair = evidenceRecord(scenario.id);
    missingCanonicalPair.workflow = {
      type: 'keyboard',
      changed: true,
      beforeSha256: '1'.repeat(64),
      afterSha256: '2'.repeat(64),
    };
    expect(() => qa.verifyEvidenceMatrix([scenario], [missingCanonicalPair], options)).toThrow(
      /canonical.*state|beforeState|afterState/iu,
    );

    const failedPostcondition = evidenceRecord(scenario.id, {
      postconditions: [
        {
          id: 'tasks-domain-result',
          passed: false,
          actualSha256: qa.canonicalSnapshotHash(false),
          actual: false,
        },
      ],
    });
    expect(() => qa.verifyEvidenceMatrix([scenario], [failedPostcondition], options)).toThrow(
      /postcondition/iu,
    );

    const dishonestPostcondition = evidenceRecord(scenario.id, {
      postconditions: [
        {
          id: 'tasks-domain-result',
          passed: true,
          actualSha256: qa.canonicalSnapshotHash(false),
          actual: false,
        },
      ],
    });
    expect(() => qa.verifyEvidenceMatrix([scenario], [dishonestPostcondition], options)).toThrow(
      /postcondition/iu,
    );

    const missingMeasurement = evidenceRecord(scenario.id, { measurements: [] });
    expect(() => qa.verifyEvidenceMatrix([scenario], [missingMeasurement], options)).toThrow(
      /measurement/iu,
    );
  });

  it('rejects pointer workflow evidence that misses capture, document dispatch, or threshold', async () => {
    const qa = await qaModule();
    const document = scenarioDocument();
    document.surfaces[0]!.interactions = [
      {
        type: 'pointer-drag',
        selector: '.source',
        targetSelector: '.target',
        coordinates: {
          source: { x: 0.5, y: 0.5 },
          target: { x: 0.5, y: 0.5 },
        },
        movementThreshold: 4,
        dispatchTarget: 'document',
        requirePointerCapture: true,
        workflow: true,
      },
    ];
    const [scenario] = qa.validateAndExpandScenarios(document);
    const result = { pointerCaptured: false, distance: 2, dispatchTarget: 'source' };
    const record = evidenceRecord(scenario.id, {
      workflow: {
        ...(evidenceRecord(scenario.id).workflow as Record<string, unknown>),
        type: 'pointer-drag',
        interaction: {
          actionType: 'pointer-drag',
          resultSha256: qa.canonicalSnapshotHash(result),
          result,
        },
      },
    });

    expect(() =>
      qa.verifyEvidenceMatrix([scenario], [record], {
        pluginArtifactSha256: 'd'.repeat(64),
        fixtureManifestSha256: 'e'.repeat(64),
      }),
    ).toThrow(/pointer.*capture|threshold|document/iu);
  });

  it('accepts source-dispatched Board pointer evidence when the declaration requires it', async () => {
    const qa = await qaModule();
    const document = scenarioDocument();
    document.surfaces[0]!.interactions = [
      {
        type: 'pointer-drag',
        selector: '.source',
        targetSelector: '.target',
        coordinates: {
          source: { x: 0.5, y: 0.5 },
          target: { x: 0.5, y: 0.5 },
        },
        movementThreshold: 4,
        dispatchTarget: 'source',
        requirePointerCapture: true,
        workflow: true,
      },
    ];
    const [scenario] = qa.validateAndExpandScenarios(document);
    const result = { pointerCaptured: true, distance: 12, dispatchTarget: 'source' };
    const record = evidenceRecord(scenario.id, {
      workflow: {
        ...(evidenceRecord(scenario.id).workflow as Record<string, unknown>),
        type: 'pointer-drag',
        interaction: {
          actionType: 'pointer-drag',
          resultSha256: qa.canonicalSnapshotHash(result),
          result,
        },
      },
    });

    expect(() =>
      qa.verifyEvidenceMatrix([scenario], [record], {
        pluginArtifactSha256: 'd'.repeat(64),
        fixtureManifestSha256: 'e'.repeat(64),
      }),
    ).not.toThrow();
  });

  it.each([
    ['window title', { observedWindowTitle: 'Another vault' }],
    ['root selector', { observedRootSelector: '.wrong-root' }],
    ['landmark', { observedLandmark: 'Wrong landmark' }],
  ])('rejects a capture from the wrong %s', async (_label, overrides) => {
    const qa = await qaModule();
    expect(qa.verifyEvidenceMatrix).toBeTypeOf('function');
    if (typeof qa.verifyEvidenceMatrix !== 'function') return;
    const [scenario] = (qa.validateAndExpandScenarios as (value: unknown) => Array<{ id: string }>)(
      scenarioDocument(),
    );
    expect(scenario).toBeDefined();

    expect(() =>
      qa.verifyEvidenceMatrix([scenario], [evidenceRecord(scenario!.id, overrides)], {
        pluginArtifactSha256: 'd'.repeat(64),
        fixtureManifestSha256: 'e'.repeat(64),
        passingFallbackTests: [],
      }),
    ).toThrow(/window|root|landmark/iu);
  });

  it('rejects a screenshot with a blank pixel histogram', async () => {
    const qa = await qaModule();
    expect(qa.verifyEvidenceMatrix).toBeTypeOf('function');
    if (typeof qa.verifyEvidenceMatrix !== 'function') return;
    const [scenario] = (qa.validateAndExpandScenarios as (value: unknown) => Array<{ id: string }>)(
      scenarioDocument(),
    );

    expect(() =>
      qa.verifyEvidenceMatrix(
        [scenario],
        [
          evidenceRecord(scenario!.id, {
            screenshot: {
              sha256: 'a'.repeat(64),
              width: 2880,
              height: 1800,
              nonblankHistogram: [0, 0, 0, 0],
            },
          }),
        ],
        {
          pluginArtifactSha256: 'd'.repeat(64),
          fixtureManifestSha256: 'e'.repeat(64),
          passingFallbackTests: [],
        },
      ),
    ).toThrow(/blank/iu);
  });

  it.each([
    ['theme', { observedTheme: 'light' }],
    ['viewport', { observedViewportWidth: 900 }],
    ['requested zoom', { requestedZoom: 2 }],
    ['requested pointer media', { requestedPointerMedia: 'coarse' }],
    [
      'device-pixel dimensions',
      {
        screenshot: {
          sha256: 'a'.repeat(64),
          width: 1440,
          height: 900,
          nonblankHistogram: [0, 12, 5, 0],
        },
      },
    ],
  ])('rejects evidence captured with the wrong %s', async (_label, overrides) => {
    const qa = await qaModule();
    const [scenario] = qa.validateAndExpandScenarios(scenarioDocument());

    expect(() =>
      qa.verifyEvidenceMatrix([scenario], [evidenceRecord(scenario!.id, overrides)], {
        pluginArtifactSha256: 'd'.repeat(64),
        fixtureManifestSha256: 'e'.repeat(64),
        passingFallbackTests: [],
      }),
    ).toThrow(/theme|viewport|zoom|pointer|dimension/iu);
  });

  it('hashes normalized DOM and accessibility projections deterministically', async () => {
    const qa = await qaModule();
    expect(qa.canonicalSnapshotHash).toBeTypeOf('function');
    if (typeof qa.canonicalSnapshotHash !== 'function') return;

    const first = qa.canonicalSnapshotHash({
      role: 'button',
      name: 'Add\r\nTask',
      states: { pressed: false, disabled: false },
    });
    const reordered = qa.canonicalSnapshotHash({
      states: { disabled: false, pressed: false },
      name: 'Add\nTask',
      role: 'button',
    });

    expect(first).toMatch(/^[a-f0-9]{64}$/u);
    expect(reordered).toBe(first);
    expect(qa.canonicalSnapshotHash({ role: 'button', name: 'Delete task' })).not.toBe(first);
  });

  it('rejects missing, duplicate, and unexpected scenario evidence', async () => {
    const qa = await qaModule();
    expect(qa.verifyEvidenceMatrix).toBeTypeOf('function');
    if (typeof qa.verifyEvidenceMatrix !== 'function') return;
    const scenarios = (qa.validateAndExpandScenarios as (value: unknown) => Array<{ id: string }>)(
      scenarioDocument(),
    ).slice(0, 2);
    const options = {
      pluginArtifactSha256: 'd'.repeat(64),
      fixtureManifestSha256: 'e'.repeat(64),
      passingFallbackTests: [],
    };

    expect(() => qa.verifyEvidenceMatrix(scenarios, [], options)).toThrow(/missing scenario/iu);
    expect(() =>
      qa.verifyEvidenceMatrix(
        scenarios.slice(0, 1),
        [evidenceRecord(scenarios[0]!.id), evidenceRecord(scenarios[0]!.id)],
        options,
      ),
    ).toThrow(/duplicate/iu);
    expect(() =>
      qa.verifyEvidenceMatrix(
        scenarios.slice(0, 1),
        [evidenceRecord('unexpected--dark--1440--z1--fine')],
        options,
      ),
    ).toThrow(/unexpected scenario/iu);
  });

  it('rejects plugin artifact and source fixture mismatches', async () => {
    const qa = await qaModule();
    expect(qa.verifyEvidenceMatrix).toBeTypeOf('function');
    if (typeof qa.verifyEvidenceMatrix !== 'function') return;
    const [scenario] = (qa.validateAndExpandScenarios as (value: unknown) => Array<{ id: string }>)(
      scenarioDocument(),
    );
    const record = evidenceRecord(scenario!.id);

    expect(() =>
      qa.verifyEvidenceMatrix([scenario], [record], {
        pluginArtifactSha256: 'f'.repeat(64),
        fixtureManifestSha256: 'e'.repeat(64),
        passingFallbackTests: [],
      }),
    ).toThrow(/artifact mismatch/iu);
    expect(() =>
      qa.verifyEvidenceMatrix([scenario], [record], {
        pluginArtifactSha256: 'd'.repeat(64),
        fixtureManifestSha256: 'f'.repeat(64),
        passingFallbackTests: [],
      }),
    ).toThrow(/fixture mismatch/iu);
  });

  it('permits an unsupported platform only with named passing CSS/media and DOM accessibility fallbacks', async () => {
    const qa = await qaModule();
    expect(qa.verifyEvidenceMatrix).toBeTypeOf('function');
    if (typeof qa.verifyEvidenceMatrix !== 'function') return;
    const [scenario] = (qa.validateAndExpandScenarios as (value: unknown) => Array<{ id: string }>)(
      scenarioDocument(),
    );
    const required = [
      'test/panel-shell-styles.test.ts > makes the compact Board status affordance discoverable for coarse pointers',
      'test/projects-accessibility.test.ts > exposes exactly one named collection toolbar with keyboard-native controls',
    ];
    const record = evidenceRecord(scenario!.id, {
      status: 'unsupported-with-fallback',
      reason: 'macOS AX permission and coarse-pointer emulation are unavailable.',
      accessibility: { provider: 'dom-projection', sha256: 'c'.repeat(64) },
      fallbackTestEvidence: required,
    });
    const fallbackTestRun = {
      runner: 'vitest-node-api',
      command: 'vitest run fallback contracts',
      exitCode: 0,
      gitHead: 'f'.repeat(40),
      resultSha256: '9'.repeat(64),
      passing: required,
    };
    const options = {
      pluginArtifactSha256: 'd'.repeat(64),
      fixtureManifestSha256: 'e'.repeat(64),
      fallbackTestRun,
    };

    expect(() => qa.verifyEvidenceMatrix([scenario], [record], options)).not.toThrow();
    expect(() =>
      qa.verifyEvidenceMatrix([scenario], [record], {
        ...options,
        fallbackTestRun: { ...fallbackTestRun, passing: required.slice(0, 1) },
      }),
    ).toThrow(/fallback.*passing/iu);
    expect(() =>
      qa.verifyEvidenceMatrix(
        [scenario],
        [{ ...record, fallbackTestEvidence: required.slice(0, 1) }],
        options,
      ),
    ).toThrow(/CSS.*DOM|fallback/iu);
    const unchangedState = { selected: null };
    const unchangedRecord = evidenceRecord(scenario!.id, {
      ...record,
      workflow: {
        ...(record.workflow as Record<string, unknown>),
        changed: false,
        beforeSha256: qa.canonicalSnapshotHash(unchangedState),
        afterSha256: qa.canonicalSnapshotHash(unchangedState),
        beforeState: unchangedState,
        afterState: unchangedState,
      },
    });
    const unchangedScenario = {
      ...scenario,
      stateSnapshot: { ...(scenario as any).stateSnapshot, expect: 'unchanged' },
    };
    expect(() =>
      qa.verifyEvidenceMatrix([unchangedScenario], [unchangedRecord], options),
    ).not.toThrow();
  });
});

describe('Dev Vault fixture backup and restore', () => {
  it('restores path, bytes, and mode exactly and deletes the backup only after equality', async () => {
    const qa = await qaModule();
    expect(qa.createFixtureBackup).toBeTypeOf('function');
    expect(qa.restoreFixtureBackup).toBeTypeOf('function');
    expect(qa.manifestForDirectory).toBeTypeOf('function');
    expect(qa.diffManifests).toBeTypeOf('function');
    if (
      typeof qa.createFixtureBackup !== 'function' ||
      typeof qa.restoreFixtureBackup !== 'function' ||
      typeof qa.manifestForDirectory !== 'function' ||
      typeof qa.diffManifests !== 'function'
    )
      return;

    const root = await mkdtemp(join(tmpdir(), 'abyss-devvault-qa-'));
    scratch.push(root);
    const vault = join(root, 'vault');
    const out = join(root, 'evidence');
    await mkdir(join(vault, 'Folder'), { recursive: true });
    await mkdir(join(vault, 'Empty'), { recursive: true });
    await chmod(join(vault, 'Empty'), 0o750);
    await writeFile(join(vault, 'Folder', 'Task.md'), 'original\n', 'utf8');
    await writeFile(join(vault, 'root.md'), 'root\n', 'utf8');
    await chmod(join(vault, 'root.md'), 0o640);

    const before = await qa.createFixtureBackup(vault, out);
    await writeFile(join(vault, 'Folder', 'Task.md'), 'changed\n', 'utf8');
    await rm(join(vault, 'root.md'));
    await writeFile(join(vault, 'new.md'), 'new\n', 'utf8');
    const dirty = await qa.manifestForDirectory(vault);
    expect(qa.diffManifests(before, dirty)).not.toEqual([]);

    const restored = await qa.restoreFixtureBackup(vault, out);
    expect(qa.diffManifests(before, restored)).toEqual([]);
    expect(await readFile(join(vault, 'Folder', 'Task.md'), 'utf8')).toBe('original\n');
    expect((await stat(join(vault, 'root.md'))).mode & 0o777).toBe(0o640);
    expect((await stat(join(vault, 'Empty'))).mode & 0o777).toBe(0o750);
    await expect(stat(join(out, 'backup'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('retains the only backup when the before manifest and checksum are tampered together', async () => {
    const qa = await qaModule();
    const root = await mkdtemp(join(tmpdir(), 'abyss-devvault-qa-tamper-'));
    scratch.push(root);
    const vault = join(root, 'vault');
    const out = join(root, 'evidence');
    await mkdir(vault, { recursive: true });
    await writeFile(join(vault, 'first.md'), 'first\n', 'utf8');
    await writeFile(join(vault, 'second.md'), 'second\n', 'utf8');
    await qa.createFixtureBackup(vault, out);
    const manifestPath = join(out, 'fixture-manifest.before.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Array<{
      path: string;
      type: string;
    }>;
    const removed = manifest.find(({ path }) => path === 'second.md')!;
    await rm(join(out, 'backup', removed.path));
    await writeFile(
      manifestPath,
      `${JSON.stringify(
        manifest.filter(({ path }) => path !== removed.path),
        null,
        2,
      )}\n`,
      'utf8',
    );

    await expect(qa.restoreFixtureBackup(vault, out)).rejects.toThrow(/checksum/iu);
    expect(await readFile(join(out, 'backup', 'first.md'), 'utf8')).toBe('first\n');
  });
});
