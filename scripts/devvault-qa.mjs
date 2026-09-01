#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, realpathSync } from 'node:fs';
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(SCRIPT_PATH), '..');
const EXPECTED_DEV_VAULT = join(REPO_ROOT, 'dev-vault');
const COMMITTED_SCENARIOS = join(REPO_ROOT, 'scripts', 'devvault-qa', 'scenarios.json');
const REQUIRED_THEMES = ['dark', 'light'];
const REQUIRED_WIDTHS = [1440, 900, 760, 440];
const REQUIRED_ZOOMS = [1, 2];
const REQUIRED_POINTERS = ['fine', 'coarse', 'hover-none'];
const REQUIRED_SURFACES = [
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
];
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

export const FALLBACK_TESTS = Object.freeze({
  cssMedia:
    'test/panel-shell-styles.test.ts > makes the compact Board status affordance discoverable for coarse pointers',
  domAccessibility:
    'test/projects-accessibility.test.ts > exposes exactly one named collection toolbar with keyboard-native controls',
});

function object(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : null;
}

function nonemptyString(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`Scenario field ${field} must be a non-empty string`);
  }
  return value;
}

function exactMatrix(actual, expected, field) {
  if (!Array.isArray(actual)) throw new Error(`Scenario matrix ${field} must be an array`);
  if (
    actual.length !== expected.length ||
    actual.some((value, index) => value !== expected[index])
  ) {
    throw new Error(
      `Scenario matrix ${field} must be exactly ${expected.join(', ')}; received ${actual.join(', ')}`,
    );
  }
  return actual;
}

function validateEvalSyntax(code, field, expression = false) {
  try {
    Function(expression ? `return (async()=>await (${code}))()` : code);
  } catch (error) {
    throw new Error(
      `${field} is not valid JavaScript: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function validateAction(value, field, contract) {
  const candidate = object(value);
  if (!candidate) throw new Error(`${field} must be an object`);
  const type = nonemptyString(candidate.type, `${field}.type`);
  const allowedTypes =
    contract === 'interaction'
      ? [
          'eval',
          'key',
          'click',
          'click-text',
          'input',
          'pointer',
          'pointer-drag',
          'context-menu',
          'plugin-reload',
          'app-restart',
        ]
      : ['dom-contains', 'dom-not-contains', 'eval-truthy'];
  if (!allowedTypes.includes(type)) {
    throw new Error(`${field} has unsupported ${contract} type ${type}`);
  }
  const fieldsByType = {
    eval: ['type', 'code', 'workflow'],
    key: ['type', 'key', 'code', 'selector', 'workflow'],
    click: ['type', 'selector', 'workflow'],
    'click-text': ['type', 'value', 'workflow'],
    input: ['type', 'selector', 'value', 'workflow'],
    pointer: ['type', 'selector', 'workflow'],
    'pointer-drag': [
      'type',
      'selector',
      'targetSelector',
      'coordinates',
      'movementThreshold',
      'dispatchTarget',
      'requirePointerCapture',
      'workflow',
    ],
    'context-menu': ['type', 'selector', 'workflow'],
    'plugin-reload': ['type', 'workflow'],
    'app-restart': ['type', 'workflow'],
    'dom-contains': ['type', 'value'],
    'dom-not-contains': ['type', 'value'],
    'eval-truthy': ['type', 'code'],
  };
  const additional = Object.keys(candidate).find((key) => !fieldsByType[type].includes(key));
  if (additional) throw new Error(`${field}.${additional} is an additional field`);
  if (['eval', 'eval-truthy'].includes(type)) {
    const code = nonemptyString(candidate.code, `${field}.code`);
    validateEvalSyntax(code, `${field}.code`, type === 'eval-truthy');
  }
  if (type === 'key') {
    nonemptyString(candidate.key, `${field}.key`);
    if (candidate.code !== undefined) nonemptyString(candidate.code, `${field}.code`);
    if (candidate.selector !== undefined) nonemptyString(candidate.selector, `${field}.selector`);
  }
  if (['click', 'pointer', 'context-menu'].includes(type)) {
    nonemptyString(candidate.selector, `${field}.selector`);
  }
  if (type === 'pointer-drag') {
    nonemptyString(candidate.selector, `${field}.selector`);
    nonemptyString(candidate.targetSelector, `${field}.targetSelector`);
    const coordinates = object(candidate.coordinates);
    const source = object(coordinates?.source);
    const target = object(coordinates?.target);
    const validPoint = (point) =>
      point &&
      Object.keys(point).length === 2 &&
      Number.isFinite(point.x) &&
      point.x >= 0 &&
      point.x <= 1 &&
      Number.isFinite(point.y) &&
      point.y >= 0 &&
      point.y <= 1;
    if (!validPoint(source) || !validPoint(target)) {
      throw new Error(`${field}.coordinates must define normalized source and target points`);
    }
    if (!Number.isFinite(candidate.movementThreshold) || candidate.movementThreshold < 3) {
      throw new Error(`${field}.movementThreshold must be at least 3 pixels`);
    }
    if (!['source', 'document'].includes(candidate.dispatchTarget)) {
      throw new Error(`${field}.dispatchTarget must be source or document`);
    }
    if (candidate.requirePointerCapture !== true) {
      throw new Error(`${field}.requirePointerCapture must be true`);
    }
  }
  if (['click-text', 'dom-contains', 'dom-not-contains'].includes(type)) {
    nonemptyString(candidate.value, `${field}.value`);
  }
  if (type === 'input') {
    nonemptyString(candidate.selector, `${field}.selector`);
    if (typeof candidate.value !== 'string') throw new Error(`${field}.value must be a string`);
  }
  if (candidate.workflow !== undefined && typeof candidate.workflow !== 'boolean') {
    throw new Error(`${field}.workflow must be boolean`);
  }
  return structuredClone(candidate);
}

function validateStateSnapshot(value, field) {
  const candidate = object(value);
  if (!candidate) throw new Error(`${field} must be an object`);
  const extra = Object.keys(candidate).find(
    (key) => !['beforeEval', 'afterEval', 'expect'].includes(key),
  );
  if (extra) throw new Error(`${field}.${extra} is an additional field`);
  const beforeEval = nonemptyString(candidate.beforeEval, `${field}.beforeEval`);
  const afterEval = nonemptyString(candidate.afterEval, `${field}.afterEval`);
  validateEvalSyntax(beforeEval, `${field}.beforeEval`, true);
  validateEvalSyntax(afterEval, `${field}.afterEval`, true);
  if (!['changed', 'unchanged'].includes(candidate.expect)) {
    throw new Error(`${field}.expect must be changed or unchanged`);
  }
  if (/innerHTML|outerHTML|document\.body\.textContent/iu.test(`${beforeEval}\n${afterEval}`)) {
    throw new Error(`${field} must capture canonical domain state, not generic DOM HTML/text`);
  }
  return { beforeEval, afterEval, expect: candidate.expect };
}

function validatePostcondition(value, field) {
  const candidate = object(value);
  if (!candidate) throw new Error(`${field} must be an object`);
  const type = nonemptyString(candidate.type, `${field}.type`);
  if (!['eval-truthy', 'eval-equals'].includes(type)) {
    throw new Error(`${field}.type must be eval-truthy or eval-equals`);
  }
  const allowed =
    type === 'eval-equals' ? ['id', 'type', 'code', 'expected'] : ['id', 'type', 'code'];
  const extra = Object.keys(candidate).find((key) => !allowed.includes(key));
  if (extra) throw new Error(`${field}.${extra} is an additional field`);
  const result = {
    id: nonemptyString(candidate.id, `${field}.id`),
    type,
    code: nonemptyString(candidate.code, `${field}.code`),
  };
  validateEvalSyntax(result.code, `${field}.code`, true);
  if (type === 'eval-equals') {
    if (!Object.prototype.hasOwnProperty.call(candidate, 'expected')) {
      throw new Error(`${field}.expected is required`);
    }
    return { ...result, expected: structuredClone(candidate.expected) };
  }
  return result;
}

function validateMeasurement(value, field) {
  const candidate = object(value);
  if (!candidate) throw new Error(`${field} must be an object`);
  const type = nonemptyString(candidate.type, `${field}.type`);
  if (!['density', 'native-reference'].includes(type)) {
    throw new Error(`${field}.type must be density or native-reference`);
  }
  const allowed =
    type === 'density'
      ? ['id', 'type', 'selector', 'min', 'max']
      : ['id', 'type', 'selector', 'referenceSelector', 'metric', 'min', 'max'];
  const extra = Object.keys(candidate).find((key) => !allowed.includes(key));
  if (extra) throw new Error(`${field}.${extra} is an additional field`);
  const min = candidate.min;
  const max = candidate.max;
  if (!Number.isFinite(min) || !Number.isFinite(max) || min > max) {
    throw new Error(`${field} must define a finite min/max range`);
  }
  const result = {
    id: nonemptyString(candidate.id, `${field}.id`),
    type,
    selector: nonemptyString(candidate.selector, `${field}.selector`),
    min,
    max,
  };
  if (type === 'density' && (min < 0.1 || max - min > 20)) {
    throw new Error(`${field} density range must be narrow enough to detect layout regressions`);
  }
  if (type === 'native-reference') {
    if (candidate.metric !== 'height-ratio') {
      throw new Error(`${field}.metric must be height-ratio`);
    }
    if (min <= 0 || max / min > 10) {
      throw new Error(`${field} native-reference range must be a bounded native comparison`);
    }
    return {
      ...result,
      referenceSelector: nonemptyString(candidate.referenceSelector, `${field}.referenceSelector`),
      metric: candidate.metric,
    };
  }
  return result;
}

/** Validate the compact committed manifest and expand it to exact DevVaultScenario records. */
export function validateAndExpandScenarios(value) {
  const document = object(value);
  if (!document || document.version !== 1) throw new Error('Scenario document version must be 1');
  if (!Array.isArray(document.surfaces) || document.surfaces.length === 0) {
    throw new Error('Scenario document must define at least one surface');
  }
  const matrix = object(document.matrix);
  if (!matrix) throw new Error('Scenario document matrix is required');
  const themes = exactMatrix(matrix.themes, REQUIRED_THEMES, 'themes');
  const widths = exactMatrix(matrix.widths, REQUIRED_WIDTHS, 'widths');
  const zooms = exactMatrix(matrix.zooms, REQUIRED_ZOOMS, 'zooms');
  const pointers = exactMatrix(matrix.pointers, REQUIRED_POINTERS, 'pointers');
  const validateScenario = (value, index, collection) => {
    const surface = object(value);
    if (!surface) throw new Error(`${collection}[${index}] must be an object`);
    const field = `${collection}[${index}]`;
    const id = nonemptyString(surface.id, `${field}.id`);
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(id)) {
      throw new Error(`${field}.id is invalid: ${id}`);
    }
    const setupEval = surface.setupEval;
    if (!Array.isArray(setupEval) || setupEval.some((entry) => typeof entry !== 'string')) {
      throw new Error(`${field}.setupEval must be an array of strings`);
    }
    setupEval.forEach((code, setupIndex) =>
      validateEvalSyntax(code, `${field}.setupEval[${setupIndex}]`),
    );
    const interactions = surface.interactions;
    const assertions = surface.assertions;
    const postconditions = surface.postconditions;
    const measurements = surface.measurements;
    if (
      !Array.isArray(interactions) ||
      !Array.isArray(assertions) ||
      !Array.isArray(postconditions) ||
      !Array.isArray(measurements)
    ) {
      throw new Error(
        `${field} interactions, assertions, postconditions, and measurements must be arrays`,
      );
    }
    if (postconditions.length === 0) {
      throw new Error(`${field} must declare at least one explicit domain postcondition`);
    }
    if (measurements.length === 0) {
      throw new Error(`${field} must declare at least one UI measurement`);
    }
    const validatedInteractions = interactions.map((action, actionIndex) =>
      validateAction(action, `${field}.interactions[${actionIndex}]`, 'interaction'),
    );
    if (
      !validatedInteractions.some(
        ({ type, workflow }) =>
          workflow === true &&
          [
            'key',
            'click',
            'click-text',
            'input',
            'context-menu',
            'pointer-drag',
            'plugin-reload',
            'app-restart',
          ].includes(type),
      )
    ) {
      throw new Error(`${field} must declare a real workflow interaction`);
    }
    const validatedMeasurements = measurements.map((measurement, measurementIndex) =>
      validateMeasurement(measurement, `${field}.measurements[${measurementIndex}]`),
    );
    const scenarioMeasurementTypes = new Set(validatedMeasurements.map(({ type }) => type));
    if (
      !scenarioMeasurementTypes.has('density') ||
      !scenarioMeasurementTypes.has('native-reference')
    ) {
      throw new Error(`${field} must pair density with a native Obsidian reference measurement`);
    }
    return {
      id,
      expectedWindowTitle: nonemptyString(
        surface.expectedWindowTitle,
        `${field}.expectedWindowTitle`,
      ),
      rootSelector: nonemptyString(surface.rootSelector, `${field}.rootSelector`),
      expectedLandmark: nonemptyString(surface.expectedLandmark, `${field}.expectedLandmark`),
      setupEval: [...setupEval],
      stateSnapshot: validateStateSnapshot(surface.stateSnapshot, `${field}.stateSnapshot`),
      interactions: validatedInteractions,
      assertions: assertions.map((action, actionIndex) =>
        validateAction(action, `${field}.assertions[${actionIndex}]`, 'assertion'),
      ),
      postconditions: postconditions.map((condition, conditionIndex) =>
        validatePostcondition(condition, `${field}.postconditions[${conditionIndex}]`),
      ),
      measurements: validatedMeasurements,
    };
  };
  const surfaces = document.surfaces.map((value, index) =>
    validateScenario(value, index, 'surfaces'),
  );
  if (!Array.isArray(document.workflows)) {
    throw new Error('Scenario document workflows must be an array');
  }
  const workflows = document.workflows.map((value, index) =>
    validateScenario(value, index, 'workflows'),
  );
  const declared = [...surfaces, ...workflows];
  if (new Set(declared.map(({ id }) => id)).size !== declared.length) {
    throw new Error('Scenario ids must be unique across surfaces and workflows');
  }
  const surfaceIds = new Set(surfaces.map(({ id }) => id));
  const missingSurfaces = REQUIRED_SURFACES.filter((id) => !surfaceIds.has(id));
  const unexpectedSurfaces = [...surfaceIds].filter((id) => !REQUIRED_SURFACES.includes(id));
  if (missingSurfaces.length > 0 || unexpectedSurfaces.length > 0) {
    throw new Error(
      `Scenario document required surfaces mismatch; missing=${missingSurfaces.join(',')}; unexpected=${unexpectedSurfaces.join(',')}`,
    );
  }
  const workflowIds = new Set(workflows.map(({ id }) => id));
  const missingWorkflows = REQUIRED_WORKFLOWS.filter((id) => !workflowIds.has(id));
  const unexpectedWorkflows = [...workflowIds].filter((id) => !REQUIRED_WORKFLOWS.includes(id));
  if (missingWorkflows.length > 0 || unexpectedWorkflows.length > 0) {
    throw new Error(
      `Scenario document required workflows mismatch; missing=${missingWorkflows.join(',')}; unexpected=${unexpectedWorkflows.join(',')}`,
    );
  }
  const measurementTypes = new Set(
    declared.flatMap(({ measurements }) => measurements.map(({ type }) => type)),
  );
  if (!measurementTypes.has('density') || !measurementTypes.has('native-reference')) {
    throw new Error('Scenario document requires both native-reference and density measurements');
  }
  const expanded = [];
  for (const surface of surfaces) {
    for (const theme of themes) {
      for (const width of widths) {
        for (const zoom of zooms) {
          for (const pointer of pointers) {
            expanded.push({
              id: `${surface.id}--${theme}--${width}--z${zoom}--${pointer}`,
              surface: surface.id,
              theme,
              width,
              zoom,
              pointer,
              expectedWindowTitle: surface.expectedWindowTitle,
              rootSelector: surface.rootSelector,
              expectedLandmark: surface.expectedLandmark,
              setupEval: [...surface.setupEval],
              stateSnapshot: structuredClone(surface.stateSnapshot),
              interactions: surface.interactions.map((action) => structuredClone(action)),
              assertions: surface.assertions.map((action) => structuredClone(action)),
              postconditions: surface.postconditions.map((condition) => structuredClone(condition)),
              measurements: surface.measurements.map((measurement) => structuredClone(measurement)),
            });
          }
        }
      }
    }
  }
  for (const workflow of workflows) {
    expanded.push({
      id: `${workflow.id}--dark--1440--z1--fine`,
      surface: workflow.id,
      theme: 'dark',
      width: 1440,
      zoom: 1,
      pointer: 'fine',
      expectedWindowTitle: workflow.expectedWindowTitle,
      rootSelector: workflow.rootSelector,
      expectedLandmark: workflow.expectedLandmark,
      setupEval: [...workflow.setupEval],
      stateSnapshot: structuredClone(workflow.stateSnapshot),
      interactions: workflow.interactions.map((action) => structuredClone(action)),
      assertions: workflow.assertions.map((action) => structuredClone(action)),
      postconditions: workflow.postconditions.map((condition) => structuredClone(condition)),
      measurements: workflow.measurements.map((measurement) => structuredClone(measurement)),
    });
  }
  return expanded;
}

/** CLI safety boundary: no alias, sibling, real vault, or caller-selected fixture is accepted. */
export function assertExactDevVault(vaultPath) {
  if (typeof vaultPath !== 'string' || vaultPath.includes('\0')) {
    throw new Error('Refusing QA mutation: an exact Dev Vault path is required');
  }
  if (vaultPath !== EXPECTED_DEV_VAULT) {
    throw new Error(`Refusing QA mutation: use the exact Dev Vault path ${EXPECTED_DEV_VAULT}`);
  }
  const candidate = resolve(vaultPath);
  if (candidate !== EXPECTED_DEV_VAULT) {
    throw new Error(`Refusing QA mutation outside the repository Dev Vault: ${candidate}`);
  }
  if (!existsSync(candidate) || lstatSync(candidate).isSymbolicLink()) {
    throw new Error(`Refusing QA mutation through a missing or symlinked Dev Vault: ${candidate}`);
  }
  if (realpathSync(candidate) !== candidate) {
    throw new Error(`Refusing QA mutation through a non-canonical Dev Vault: ${candidate}`);
  }
  return candidate;
}

function assertNoSymlinkComponents(path, boundary) {
  const absolute = resolve(path);
  const root = resolve(boundary);
  if (absolute !== root && !absolute.startsWith(`${root}${sep}`)) {
    throw new Error(`Path escapes its allowed root: ${absolute}`);
  }
  if (!existsSync(root)) {
    throw new Error(`QA path root does not exist: ${root}`);
  }
  if (lstatSync(root).isSymbolicLink()) {
    throw new Error(`Refusing QA path with symlink root: ${root}`);
  }
  const suffix = relative(root, absolute).split(sep).filter(Boolean);
  let current = root;
  for (const component of suffix) {
    current = join(current, component);
    if (!existsSync(current)) break;
    if (lstatSync(current).isSymbolicLink()) {
      throw new Error(`Refusing QA path with symlink component: ${current}`);
    }
  }
  let existing = absolute;
  while (!existsSync(existing)) existing = dirname(existing);
  const resolvedExisting = realpathSync(existing);
  const resolvedRoot = realpathSync(root);
  if (resolvedExisting !== resolvedRoot && !resolvedExisting.startsWith(`${resolvedRoot}${sep}`)) {
    throw new Error(`QA path resolves outside its allowed root: ${absolute}`);
  }
}

function normalizeSnapshot(value) {
  if (typeof value === 'string') {
    return value
      .replaceAll('\r\n', '\n')
      .replace(/[ \t]+$/gmu, '')
      .trim();
  }
  if (Array.isArray(value)) return value.map(normalizeSnapshot);
  const candidate = object(value);
  if (!candidate) return value;
  return Object.fromEntries(
    Object.keys(candidate)
      .sort()
      .map((key) => [key, normalizeSnapshot(candidate[key])]),
  );
}

export function canonicalSnapshotHash(value) {
  const canonical = JSON.stringify(normalizeSnapshot(value));
  return createHash('sha256').update(canonical).digest('hex');
}

async function sha256File(path) {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
}

async function treeEntries(root, at = root) {
  const children = await readdir(at, { withFileTypes: true });
  const found = [];
  for (const child of children.sort((left, right) => left.name.localeCompare(right.name))) {
    const path = join(at, child.name);
    if (child.isSymbolicLink()) throw new Error(`Fixture symlinks are unsupported: ${path}`);
    if (child.isDirectory()) {
      found.push({ type: 'directory', absolutePath: path });
      found.push(...(await treeEntries(root, path)));
    } else if (child.isFile()) found.push({ type: 'file', absolutePath: path });
    else throw new Error(`Unsupported fixture entry: ${path}`);
  }
  return found;
}

export async function manifestForDirectory(root) {
  const absolute = resolve(root);
  const rootMetadata = await stat(absolute);
  const entries = [{ type: 'directory', absolutePath: absolute }, ...(await treeEntries(absolute))];
  return Promise.all(
    entries.map(async (entry) => {
      const metadata =
        entry.absolutePath === absolute ? rootMetadata : await stat(entry.absolutePath);
      const common = {
        type: entry.type,
        path:
          entry.absolutePath === absolute
            ? '.'
            : relative(absolute, entry.absolutePath).split(sep).join('/'),
        mode: metadata.mode & 0o777,
      };
      return entry.type === 'directory'
        ? common
        : {
            ...common,
            size: metadata.size,
            sha256: await sha256File(entry.absolutePath),
          };
    }),
  );
}

export function diffManifests(expected, actual) {
  const before = new Map(expected.map((entry) => [entry.path, entry]));
  const after = new Map(actual.map((entry) => [entry.path, entry]));
  const paths = [...new Set([...before.keys(), ...after.keys()])].sort();
  return paths.flatMap((path) => {
    const left = before.get(path);
    const right = after.get(path);
    if (!left) return [`added:${path}`];
    if (!right) return [`removed:${path}`];
    return left.type === right.type &&
      left.mode === right.mode &&
      left.size === right.size &&
      left.sha256 === right.sha256
      ? []
      : [`changed:${path}`];
  });
}

async function copyTree(source, destination) {
  await mkdir(destination, { recursive: true });
  const all = await treeEntries(source);
  for (const entry of all.filter(({ type }) => type === 'directory')) {
    await mkdir(join(destination, relative(source, entry.absolutePath)), { recursive: true });
  }
  for (const entry of all.filter(({ type }) => type === 'file')) {
    const target = join(destination, relative(source, entry.absolutePath));
    await mkdir(dirname(target), { recursive: true });
    await copyFile(entry.absolutePath, target);
    await chmod(target, (await stat(entry.absolutePath)).mode & 0o777);
  }
  for (const entry of all.filter(({ type }) => type === 'directory').reverse()) {
    await chmod(
      join(destination, relative(source, entry.absolutePath)),
      (await stat(entry.absolutePath)).mode & 0o777,
    );
  }
  await chmod(destination, (await stat(source)).mode & 0o777);
}

function ensureSeparated(source, output) {
  const sourcePath = `${resolve(source)}${sep}`;
  const outputPath = `${resolve(output)}${sep}`;
  if (sourcePath.startsWith(outputPath) || outputPath.startsWith(sourcePath)) {
    throw new Error('Fixture backup and source directories must not contain one another');
  }
}

export async function createFixtureBackup(vaultPath, outputPath) {
  const vault = resolve(vaultPath);
  const out = resolve(outputPath);
  ensureSeparated(vault, out);
  const backup = join(out, 'backup');
  try {
    await lstat(backup);
    throw new Error(`Refusing to overwrite an existing fixture backup: ${backup}`);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  await mkdir(out, { recursive: true });
  const manifest = await manifestForDirectory(vault);
  await copyTree(vault, backup);
  const copied = await manifestForDirectory(backup);
  const differences = diffManifests(manifest, copied);
  if (differences.length > 0) throw new Error(`Fixture backup differs: ${differences.join(', ')}`);
  await writeFile(
    join(out, 'fixture-manifest.before.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  await writeFile(join(out, 'fixture-manifest.sha256'), `${canonicalSnapshotHash(manifest)}\n`);
  return manifest;
}

export async function restoreFixtureBackup(vaultPath, outputPath) {
  const vault = resolve(vaultPath);
  const out = resolve(outputPath);
  ensureSeparated(vault, out);
  const backup = join(out, 'backup');
  const expected = JSON.parse(await readFile(join(out, 'fixture-manifest.before.json'), 'utf8'));
  const recordedChecksum = (await readFile(join(out, 'fixture-manifest.sha256'), 'utf8')).trim();
  const observedChecksum = canonicalSnapshotHash(expected);
  if (recordedChecksum !== observedChecksum) {
    throw new Error('Fixture manifest checksum mismatch; backup retained');
  }
  const backupManifest = await manifestForDirectory(backup);
  const backupDifferences = diffManifests(expected, backupManifest);
  if (backupDifferences.length > 0) {
    throw new Error(`Refusing restore from a corrupt backup: ${backupDifferences.join(', ')}`);
  }
  await rm(vault, { recursive: true, force: true });
  await copyTree(backup, vault);
  const restored = await manifestForDirectory(vault);
  const differences = diffManifests(expected, restored);
  await writeFile(
    join(out, 'fixture-manifest.after.json'),
    `${JSON.stringify(restored, null, 2)}\n`,
  );
  if (differences.length > 0) {
    throw new Error(`Fixture restore differs; backup retained: ${differences.join(', ')}`);
  }
  await rm(backup, { recursive: true, force: true });
  return restored;
}

function assertHash(value, field) {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) {
    throw new Error(`${field} must be a SHA-256 hash`);
  }
}

function schemaRef(root, ref) {
  if (typeof ref !== 'string' || !ref.startsWith('#/'))
    throw new Error(`Unsupported schema ref ${ref}`);
  return ref
    .slice(2)
    .split('/')
    .reduce((current, key) => current?.[key.replaceAll('~1', '/').replaceAll('~0', '~')], root);
}

function matchesType(value, type) {
  if (type === 'array') return Array.isArray(value);
  if (type === 'object') return object(value) !== null;
  if (type === 'integer') return Number.isInteger(value);
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (type === 'null') return value === null;
  return typeof value === type;
}

function validateSchemaNode(root, schema, value, path) {
  if (schema.$ref) return validateSchemaNode(root, schemaRef(root, schema.$ref), value, path);
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((type) => matchesType(value, type))) {
      throw new Error(`${path} does not match schema type ${types.join('|')}`);
    }
  }
  if (schema.enum && !schema.enum.some((candidate) => Object.is(candidate, value))) {
    throw new Error(`${path} is outside the schema enum`);
  }
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      throw new Error(`${path} is shorter than schema minLength`);
    }
    if (schema.pattern && !new RegExp(schema.pattern, 'u').test(value)) {
      throw new Error(`${path} does not match schema pattern`);
    }
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) {
      throw new Error(`${path} is below schema minimum`);
    }
    if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum) {
      throw new Error(`${path} is below schema exclusiveMinimum`);
    }
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      throw new Error(`${path} has fewer than schema minItems`);
    }
    if (
      schema.uniqueItems &&
      new Set(value.map((entry) => JSON.stringify(entry))).size !== value.length
    ) {
      throw new Error(`${path} violates schema uniqueItems`);
    }
    if (schema.items)
      value.forEach((entry, index) =>
        validateSchemaNode(root, schema.items, entry, `${path}[${index}]`),
      );
  }
  const candidate = object(value);
  if (candidate) {
    for (const required of schema.required ?? []) {
      if (!Object.prototype.hasOwnProperty.call(candidate, required)) {
        throw new Error(`${path}.${required} is required by schema`);
      }
    }
    const properties = schema.properties ?? {};
    if (schema.additionalProperties === false) {
      const extra = Object.keys(candidate).find(
        (key) => !Object.prototype.hasOwnProperty.call(properties, key),
      );
      if (extra) throw new Error(`${path}.${extra} is an additional property`);
    }
    for (const [key, childSchema] of Object.entries(properties)) {
      if (Object.prototype.hasOwnProperty.call(candidate, key)) {
        validateSchemaNode(root, childSchema, candidate[key], `${path}.${key}`);
      }
    }
  }
}

export function validateEvidenceDocument(schema, value) {
  const root = object(schema);
  if (!root) throw new Error('Evidence schema must be an object');
  validateSchemaNode(root, root, value, '$');
}

function validateEvidenceRecord(scenario, value, options) {
  const record = object(value);
  if (!record) throw new Error(`Evidence for ${scenario.id} must be an object`);
  if (record.scenarioId !== scenario.id)
    throw new Error(`Unexpected scenario ${record.scenarioId}`);
  if (record.status === 'rejected')
    throw new Error(`Scenario ${scenario.id} was rejected: ${record.reason}`);
  if (!['accepted', 'unsupported-with-fallback'].includes(record.status)) {
    throw new Error(`Scenario ${scenario.id} has invalid status`);
  }
  nonemptyString(record.reason, `${scenario.id}.reason`);
  if (
    record.expectedWindowTitle !== scenario.expectedWindowTitle ||
    record.observedWindowTitle !== scenario.expectedWindowTitle
  ) {
    throw new Error(`Scenario ${scenario.id} captured the wrong window title`);
  }
  if (
    record.rootSelector !== scenario.rootSelector ||
    record.observedRootSelector !== scenario.rootSelector
  ) {
    throw new Error(`Scenario ${scenario.id} captured the wrong root selector`);
  }
  if (
    record.expectedLandmark !== scenario.expectedLandmark ||
    record.observedLandmark !== scenario.expectedLandmark
  ) {
    throw new Error(`Scenario ${scenario.id} captured the wrong landmark`);
  }
  if (record.theme !== scenario.theme || record.observedTheme !== scenario.theme) {
    throw new Error(`Scenario ${scenario.id} captured the wrong theme`);
  }
  if (record.viewportWidth !== scenario.width || record.observedViewportWidth !== scenario.width) {
    throw new Error(`Scenario ${scenario.id} captured the wrong viewport width`);
  }
  if (record.requestedZoom !== scenario.zoom) {
    throw new Error(`Scenario ${scenario.id} recorded the wrong requested zoom`);
  }
  if (record.requestedPointerMedia !== scenario.pointer) {
    throw new Error(`Scenario ${scenario.id} recorded the wrong requested pointer media`);
  }
  const workflow = object(record.workflow);
  if (
    !workflow ||
    !['keyboard', 'click', 'context-menu', 'pointer-drag', 'plugin-reload', 'app-restart'].includes(
      workflow.type,
    )
  ) {
    throw new Error(`Scenario ${scenario.id} workflow evidence is invalid`);
  }
  if (typeof workflow.changed !== 'boolean') {
    throw new Error(`Scenario ${scenario.id} workflow changed state is invalid`);
  }
  if (workflow.changed !== (scenario.stateSnapshot.expect === 'changed')) {
    throw new Error(`Scenario ${scenario.id} workflow violated its declared state expectation`);
  }
  assertHash(workflow.beforeSha256, `${scenario.id}.workflow.beforeSha256`);
  assertHash(workflow.afterSha256, `${scenario.id}.workflow.afterSha256`);
  if (!Object.prototype.hasOwnProperty.call(workflow, 'beforeState')) {
    throw new Error(`Scenario ${scenario.id} workflow canonical beforeState is missing`);
  }
  if (!Object.prototype.hasOwnProperty.call(workflow, 'afterState')) {
    throw new Error(`Scenario ${scenario.id} workflow canonical afterState is missing`);
  }
  if (canonicalSnapshotHash(workflow.beforeState) !== workflow.beforeSha256) {
    throw new Error(`Scenario ${scenario.id} workflow beforeState hash is not canonical`);
  }
  if (canonicalSnapshotHash(workflow.afterState) !== workflow.afterSha256) {
    throw new Error(`Scenario ${scenario.id} workflow afterState hash is not canonical`);
  }
  const interaction = object(workflow.interaction);
  if (interaction) {
    assertHash(interaction.resultSha256, `${scenario.id}.workflow.interaction.resultSha256`);
  }
  if (
    !interaction ||
    interaction.actionType !==
      scenario.interactions.find(({ workflow: selected }) => selected === true)?.type ||
    canonicalSnapshotHash(interaction.result) !== interaction.resultSha256
  ) {
    throw new Error(`Scenario ${scenario.id} interaction evidence is invalid`);
  }
  const declaredWorkflow = scenario.interactions.find(
    ({ workflow: selected }) => selected === true,
  );
  if (
    declaredWorkflow?.type === 'pointer-drag' &&
    (interaction.result?.pointerCaptured !== true ||
      interaction.result?.dispatchTarget !== declaredWorkflow.dispatchTarget ||
      interaction.result?.distance < declaredWorkflow.movementThreshold)
  ) {
    throw new Error(`Scenario ${scenario.id} pointer capture/threshold evidence is invalid`);
  }
  const expectedPostconditions = new Map(
    scenario.postconditions.map((condition) => [condition.id, condition]),
  );
  if (!Array.isArray(record.postconditions)) {
    throw new Error(`Scenario ${scenario.id} postcondition evidence is missing`);
  }
  const observedPostconditions = new Map();
  for (const condition of record.postconditions) {
    const candidate = object(condition);
    const declared = candidate && expectedPostconditions.get(candidate.id);
    if (
      !candidate ||
      typeof candidate.id !== 'string' ||
      !declared ||
      observedPostconditions.has(candidate.id)
    ) {
      throw new Error(`Scenario ${scenario.id} postcondition evidence is invalid`);
    }
    assertHash(candidate.actualSha256, `${scenario.id}.postconditions.${candidate.id}`);
    if (canonicalSnapshotHash(candidate.actual) !== candidate.actualSha256) {
      throw new Error(`Scenario ${scenario.id} postcondition canonical value is invalid`);
    }
    const derivedPassed =
      declared.type === 'eval-truthy'
        ? Boolean(candidate.actual)
        : canonicalSnapshotHash(candidate.actual) === canonicalSnapshotHash(declared.expected);
    if (candidate.passed !== derivedPassed || !derivedPassed) {
      throw new Error(`Scenario ${scenario.id} postcondition failed: ${candidate.id}`);
    }
    observedPostconditions.set(candidate.id, candidate);
  }
  if (
    observedPostconditions.size !== expectedPostconditions.size ||
    [...expectedPostconditions.keys()].some((id) => !observedPostconditions.has(id))
  ) {
    throw new Error(`Scenario ${scenario.id} postcondition evidence does not match declaration`);
  }
  const expectedMeasurements = new Map(scenario.measurements.map((entry) => [entry.id, entry]));
  if (!Array.isArray(record.measurements)) {
    throw new Error(`Scenario ${scenario.id} measurement evidence is missing`);
  }
  const observedMeasurements = new Map();
  for (const measurement of record.measurements) {
    const candidate = object(measurement);
    const declared = candidate && expectedMeasurements.get(candidate.id);
    if (
      !candidate ||
      !declared ||
      observedMeasurements.has(candidate.id) ||
      candidate.type !== declared.type ||
      !Number.isFinite(candidate.value) ||
      !object(candidate.details) ||
      candidate.passed !== true ||
      candidate.value < declared.min ||
      candidate.value > declared.max
    ) {
      throw new Error(`Scenario ${scenario.id} measurement evidence is invalid`);
    }
    assertHash(candidate.detailsSha256, `${scenario.id}.measurements.${candidate.id}`);
    if (canonicalSnapshotHash(candidate.details) !== candidate.detailsSha256) {
      throw new Error(`Scenario ${scenario.id} measurement source evidence is not canonical`);
    }
    observedMeasurements.set(candidate.id, candidate);
  }
  if (observedMeasurements.size !== expectedMeasurements.size) {
    throw new Error(`Scenario ${scenario.id} measurement evidence does not match declaration`);
  }
  const screenshot = object(record.screenshot);
  if (!screenshot) throw new Error(`Scenario ${scenario.id} screenshot is missing`);
  assertHash(screenshot.sha256, `${scenario.id}.screenshot.sha256`);
  if (!Number.isInteger(screenshot.width) || screenshot.width <= 0) {
    throw new Error(`Scenario ${scenario.id} screenshot width is invalid`);
  }
  if (!Number.isInteger(screenshot.height) || screenshot.height <= 0) {
    throw new Error(`Scenario ${scenario.id} screenshot height is invalid`);
  }
  if (
    !Array.isArray(screenshot.nonblankHistogram) ||
    screenshot.nonblankHistogram.filter((count) => Number.isInteger(count) && count > 0).length < 2
  ) {
    throw new Error(`Scenario ${scenario.id} has a blank screenshot histogram`);
  }
  assertHash(record.domSha256, `${scenario.id}.domSha256`);
  const accessibility = object(record.accessibility);
  if (!accessibility || !['macos-ax', 'dom-projection'].includes(accessibility.provider)) {
    throw new Error(`Scenario ${scenario.id} accessibility evidence is invalid`);
  }
  assertHash(accessibility.sha256, `${scenario.id}.accessibility.sha256`);
  if (!Number.isFinite(record.dpr) || record.dpr <= 0) {
    throw new Error(`Scenario ${scenario.id} DPR is invalid`);
  }
  if (screenshot.width !== Math.round(scenario.width * record.dpr)) {
    throw new Error(`Scenario ${scenario.id} screenshot device-pixel dimensions are invalid`);
  }
  if (record.observedZoom !== scenario.zoom) {
    throw new Error(`Scenario ${scenario.id} observed the wrong zoom`);
  }
  if (record.status === 'accepted' && record.observedPointerMedia !== scenario.pointer) {
    throw new Error(`Scenario ${scenario.id} observed the wrong pointer media`);
  }
  assertHash(record.pluginArtifactSha256, `${scenario.id}.pluginArtifactSha256`);
  assertHash(record.fixtureManifestSha256, `${scenario.id}.fixtureManifestSha256`);
  if (record.pluginArtifactSha256 !== options.pluginArtifactSha256) {
    throw new Error(`Scenario ${scenario.id} plugin artifact mismatch`);
  }
  if (record.fixtureManifestSha256 !== options.fixtureManifestSha256) {
    throw new Error(`Scenario ${scenario.id} source fixture mismatch`);
  }
  if (record.status === 'accepted') {
    if (accessibility.provider !== 'macos-ax') {
      throw new Error(
        `Scenario ${scenario.id} cannot accept a fabricated OS accessibility capture`,
      );
    }
    return;
  }
  if (accessibility.provider !== 'dom-projection') {
    throw new Error(`Scenario ${scenario.id} fallback must use a DOM accessibility projection`);
  }
  const named = record.fallbackTestEvidence;
  if (
    !Array.isArray(named) ||
    !named.includes(FALLBACK_TESTS.cssMedia) ||
    !named.includes(FALLBACK_TESTS.domAccessibility)
  ) {
    throw new Error(`Scenario ${scenario.id} fallback requires named CSS/media and DOM tests`);
  }
  const fallbackRun = object(options.fallbackTestRun);
  if (
    !fallbackRun ||
    fallbackRun.runner !== 'vitest-node-api' ||
    fallbackRun.command !== 'vitest run fallback contracts' ||
    fallbackRun.exitCode !== 0 ||
    typeof fallbackRun.gitHead !== 'string' ||
    !/^[a-f0-9]{40}$/u.test(fallbackRun.gitHead) ||
    typeof fallbackRun.resultSha256 !== 'string' ||
    !SHA256_PATTERN.test(fallbackRun.resultSha256) ||
    !Array.isArray(fallbackRun.passing)
  ) {
    throw new Error(`Scenario ${scenario.id} fallback lacks passing test command provenance`);
  }
  const passing = new Set(fallbackRun.passing);
  for (const test of named) {
    if (!passing.has(test)) {
      throw new Error(`Scenario ${scenario.id} fallback test is not recorded as passing: ${test}`);
    }
  }
}

export function verifyEvidenceMatrix(scenarios, records, options) {
  const expected = new Map(scenarios.map((scenario) => [scenario.id, scenario]));
  const observed = new Map();
  for (const record of records) {
    const candidate = object(record);
    const id = candidate?.scenarioId;
    if (typeof id !== 'string' || !expected.has(id)) throw new Error(`Unexpected scenario ${id}`);
    if (observed.has(id)) throw new Error(`Duplicate scenario evidence: ${id}`);
    observed.set(id, candidate);
  }
  const missing = [...expected.keys()].filter((id) => !observed.has(id));
  if (missing.length > 0) throw new Error(`Missing scenario evidence: ${missing.join(', ')}`);
  for (const [id, scenario] of expected)
    validateEvidenceRecord(scenario, observed.get(id), options);
  return { scenarios: expected.size, status: 'accepted' };
}

async function pluginArtifactHash(directory) {
  const records = await Promise.all(
    ['main.js', 'styles.css', 'manifest.json'].map(async (name) => ({
      path: name,
      sha256: await sha256File(join(directory, name)),
    })),
  );
  return { files: records, sha256: canonicalSnapshotHash(records) };
}

async function repositoryHead() {
  let gitDirectory = join(REPO_ROOT, '.git');
  const metadata = await stat(gitDirectory);
  if (metadata.isFile()) {
    const pointer = (await readFile(gitDirectory, 'utf8')).trim();
    if (!pointer.startsWith('gitdir: ')) throw new Error('Unsupported .git pointer');
    gitDirectory = resolve(REPO_ROOT, pointer.slice('gitdir: '.length));
  }
  const head = (await readFile(join(gitDirectory, 'HEAD'), 'utf8')).trim();
  if (/^[a-f0-9]{40}$/u.test(head)) return head;
  if (!head.startsWith('ref: ')) throw new Error('Unsupported git HEAD');
  const ref = head.slice('ref: '.length);
  let value;
  try {
    value = (await readFile(join(gitDirectory, ref), 'utf8')).trim();
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    const packedRefs = await readFile(join(gitDirectory, 'packed-refs'), 'utf8');
    value = packedRefs
      .split('\n')
      .find((line) => line.endsWith(` ${ref}`))
      ?.split(' ')[0];
  }
  if (!/^[a-f0-9]{40}$/u.test(value)) throw new Error('Invalid git HEAD ref');
  return value;
}

async function runFallbackContractTests() {
  const files = ['test/panel-shell-styles.test.ts', 'test/projects-accessibility.test.ts'];
  const { startVitest } = await import('vitest/node');
  const context = await startVitest('test', files, {
    run: true,
    watch: false,
    color: false,
    reporters: ['dot'],
  });
  const failed = context.state.getFailedFilepaths();
  const errors = context.state.getUnhandledErrors().map((error) => String(error));
  await context.close();
  const result = { files, failed, errors };
  const exitCode = failed.length === 0 && errors.length === 0 ? 0 : 1;
  return {
    runner: 'vitest-node-api',
    command: 'vitest run fallback contracts',
    exitCode,
    gitHead: await repositoryHead(),
    resultSha256: canonicalSnapshotHash(result),
    passing: exitCode === 0 ? Object.values(FALLBACK_TESTS) : [],
    result,
  };
}

function parsePng(bytes) {
  if (bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') {
    throw new Error('Screenshot is not a PNG');
  }
  let offset = 8;
  let width;
  let height;
  let bitDepth;
  let colorType;
  const imageData = [];
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.subarray(offset + 4, offset + 8).toString('ascii');
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
    } else if (type === 'IDAT') imageData.push(data);
    else if (type === 'IEND') break;
    offset += length + 12;
  }
  if (!width || !height || bitDepth !== 8 || ![0, 2, 4, 6].includes(colorType)) {
    throw new Error('Screenshot PNG format is unsupported');
  }
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType];
  const stride = width * channels;
  const inflated = inflateSync(Buffer.concat(imageData));
  const pixels = Buffer.alloc(stride * height);
  let inputOffset = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = inflated[inputOffset];
    inputOffset += 1;
    const rowOffset = y * stride;
    for (let x = 0; x < stride; x += 1) {
      const raw = inflated[inputOffset + x];
      const left = x >= channels ? pixels[rowOffset + x - channels] : 0;
      const up = y > 0 ? pixels[rowOffset - stride + x] : 0;
      const upLeft = y > 0 && x >= channels ? pixels[rowOffset - stride + x - channels] : 0;
      let value;
      if (filter === 0) value = raw;
      else if (filter === 1) value = raw + left;
      else if (filter === 2) value = raw + up;
      else if (filter === 3) value = raw + Math.floor((left + up) / 2);
      else if (filter === 4) {
        const prediction = left + up - upLeft;
        const leftDistance = Math.abs(prediction - left);
        const upDistance = Math.abs(prediction - up);
        const diagonalDistance = Math.abs(prediction - upLeft);
        value =
          raw +
          (leftDistance <= upDistance && leftDistance <= diagonalDistance
            ? left
            : upDistance <= diagonalDistance
              ? up
              : upLeft);
      } else throw new Error(`Screenshot PNG uses unknown filter ${filter}`);
      pixels[rowOffset + x] = value & 0xff;
    }
    inputOffset += stride;
  }
  const histogram = Array.from({ length: 16 }, () => 0);
  for (let index = 0; index < pixels.length; index += channels) {
    const red = pixels[index];
    const green = channels === 1 || channels === 2 ? red : pixels[index + 1];
    const blue = channels === 1 || channels === 2 ? red : pixels[index + 2];
    const alpha = channels === 2 ? pixels[index + 1] : channels === 4 ? pixels[index + 3] : 255;
    if (alpha === 0) continue;
    const luminance = Math.round((red * 299 + green * 587 + blue * 114) / 1000);
    histogram[Math.min(15, Math.floor(luminance / 16))] += 1;
  }
  return { width, height, nonblankHistogram: histogram };
}

async function analyzePng(path) {
  const bytes = await readFile(path);
  return { sha256: createHash('sha256').update(bytes).digest('hex'), ...parsePng(bytes) };
}

export function assertAllowedCommand(command, args) {
  const allowed =
    (command === 'open' && args.length === 2 && args[0] === '-a' && args[1] === 'Obsidian') ||
    (command === 'pgrep' && args.length === 2 && args[0] === '-x' && args[1] === 'Obsidian') ||
    (command === 'osascript' &&
      ((args.length === 2 && args[0] === '-e') ||
        (args.length === 4 && args[0] === '-l' && args[1] === 'JavaScript' && args[2] === '-e'))) ||
    (command === 'obsidian' &&
      args[0] === 'vault=dev-vault' &&
      ['eval', 'plugin:reload', 'dev:dom', 'dev:screenshot'].includes(args[1]) &&
      args.slice(2).every((argument) => typeof argument === 'string' && !argument.includes('\0')));
  if (!allowed) throw new Error(`Command allowlist rejected: ${command} ${args.join(' ')}`);
}

function rawRun(command, args) {
  const result = spawnSync(command, args, { cwd: REPO_ROOT, encoding: 'utf8' });
  return {
    status: result.status ?? 1,
    stdout: (result.stdout ?? '').trim(),
    stderr: result.stderr ?? '',
  };
}

function run(command, args, { optional = false } = {}) {
  assertAllowedCommand(command, args);
  const result = rawRun(command, args);
  if (result.status !== 0 && !optional) {
    throw new Error(`${command} ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  }
  return result;
}

function obsidian(...args) {
  return run('obsidian', ['vault=dev-vault', ...args]);
}

function obsidianEval(code) {
  return obsidian('eval', `code=${code}`).stdout;
}

function normalizedCliPath(stdout) {
  const value = stdout.trim();
  if (!value.startsWith('"')) return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

/** Proves the app behind the CLI is the exact repository Dev Vault before UI mutation. */
export function proveExactRunningVault(execute = rawRun) {
  const proofArgs = ['vault=dev-vault', 'eval', 'code=app.vault.adapter.basePath'];
  assertAllowedCommand('obsidian', proofArgs);
  let proof = execute('obsidian', proofArgs);
  if (proof.status !== 0) {
    const launchArgs = ['-a', 'Obsidian'];
    assertAllowedCommand('open', launchArgs);
    const launch = execute('open', launchArgs);
    if (launch.status !== 0) throw new Error(`Obsidian recovery launch failed: ${launch.stderr}`);
    proof = execute('obsidian', proofArgs);
  }
  if (proof.status !== 0) throw new Error(`Cannot prove running vault: ${proof.stderr}`);
  const observed = normalizedCliPath(proof.stdout);
  if (observed !== EXPECTED_DEV_VAULT) {
    throw new Error(`Refusing wrong running vault: ${observed}`);
  }
  return observed;
}

function evaluateAction(action) {
  if (action.type === 'eval') return action.code;
  if (action.type === 'key') {
    return `(()=>{const target=${action.selector ? `document.querySelector(${JSON.stringify(action.selector)})` : 'document.activeElement||document.body'};if(!target)throw new Error('Missing keyboard target');target.focus?.();const e=new KeyboardEvent('keydown',{key:${JSON.stringify(action.key)},code:${JSON.stringify(action.code ?? '')},bubbles:true,cancelable:true});target.dispatchEvent(e);return e.defaultPrevented})()`;
  }
  if (action.type === 'click' || action.type === 'pointer' || action.type === 'context-menu') {
    const eventType =
      action.type === 'context-menu'
        ? 'contextmenu'
        : action.type === 'click'
          ? 'click'
          : 'pointerdown';
    return `(()=>{const el=document.querySelector(${JSON.stringify(action.selector)});if(!el)throw new Error('Missing interaction target');el.dispatchEvent(new MouseEvent(${JSON.stringify(eventType)},{bubbles:true,cancelable:true,button:${action.type === 'context-menu' ? 2 : 0}}));return true})()`;
  }
  if (action.type === 'click-text') {
    return `(()=>{const label=${JSON.stringify(action.value)};const el=[...document.querySelectorAll('button,[role="button"],[role="tab"],[role="menuitem"],.menu-item,summary')].find(e=>e.textContent?.trim()===label);if(!el)throw new Error('Missing text interaction target '+label);el.click();return true})()`;
  }
  if (action.type === 'input') {
    return `(()=>{const el=document.querySelector(${JSON.stringify(action.selector)});if(!(el instanceof HTMLInputElement||el instanceof HTMLTextAreaElement))throw new Error('Missing input target');el.focus();el.value=${JSON.stringify(action.value)};el.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:${JSON.stringify(action.value)}}));el.dispatchEvent(new Event('change',{bubbles:true}));return JSON.stringify({value:el.value,ariaInvalid:el.getAttribute('aria-invalid')})})()`;
  }
  throw new Error(`Unsupported interaction ${action.type}`);
}

function parseEvalResult(value) {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

/** Runs the native mouse phase with fail-closed release and observer cleanup on every exit. */
export function runNativePointerPhase(ports, points, maxCaptureAttempts = 20) {
  let mouseIsDown = false;
  let releasePoint = points.source;
  try {
    mouseIsDown = true;
    ports.pickup();
    releasePoint = points.pickup;
    let captured = false;
    for (let attempt = 0; attempt < maxCaptureAttempts; attempt += 1) {
      if (ports.captureObserved()) {
        captured = true;
        break;
      }
      ports.wait();
    }
    if (!captured) throw new Error('Native pointer capture was not observed');
    releasePoint = points.target;
    ports.drag();
    mouseIsDown = false;
    return true;
  } finally {
    if (mouseIsDown) {
      try {
        ports.release(releasePoint);
      } catch {
        // Best-effort release must not hide the original native-input failure.
      }
    }
    try {
      ports.cleanup();
    } catch {
      // The browser may have exited; native mouse release was already attempted.
    }
  }
}

function executeAction(action, scenario) {
  if (action.type === 'plugin-reload') {
    obsidian('plugin:reload', 'id=task-calendar');
    return { reloaded: 'task-calendar' };
  }
  if (action.type === 'pointer-drag') {
    run('open', ['-a', 'Obsidian']);
    const expectedWindowTitle = scenario.expectedWindowTitle;
    const frontmostScript = `tell application "System Events"\nif not (exists process "Obsidian") then return false\ntell process "Obsidian"\nif not frontmost then return false\nif not (exists window whose name contains ${JSON.stringify(expectedWindowTitle)}) then return false\nreturn true\nend tell\nend tell`;
    let frontmost = false;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const activation = run('osascript', ['-e', frontmostScript], { optional: true });
      if (
        activation.status === 0 &&
        activation.stdout === 'true' &&
        obsidianEval(`document.title===${JSON.stringify(expectedWindowTitle)}`) === 'true'
      ) {
        frontmost = true;
        break;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
    if (!frontmost) throw new Error(`Obsidian window ${expectedWindowTitle} is not frontmost`);
    const sourcePoint = action.coordinates.source;
    const targetPoint = action.coordinates.target;
    const geometry = parseEvalResult(
      obsidianEval(
        `(()=>{const source=document.querySelector(${JSON.stringify(action.selector)});const target=document.querySelector(${JSON.stringify(action.targetSelector)});if(!source||!target)throw new Error('Missing pointer drag target');const sr=source.getBoundingClientRect();const tr=target.getBoundingClientRect();const chromeY=window.outerHeight-window.innerHeight;const left=window.screenX+sr.left,top=window.screenY+chromeY+sr.top,right=left+sr.width,bottom=top+sr.height;const sx=left+sr.width*${sourcePoint.x};const sy=top+sr.height*${sourcePoint.y};let tx=window.screenX+tr.left+tr.width*${targetPoint.x};let ty=window.screenY+chromeY+tr.top+tr.height*${targetPoint.y};const threshold=${action.movementThreshold};if(Math.hypot(tx-sx,ty-sy)<threshold){tx=sx+threshold+2;ty=sy;}const pickupDistance=threshold+1;const candidates=[[pickupDistance,0],[-pickupDistance,0],[0,pickupDistance],[0,-pickupDistance]];const pickup=candidates.map(([dx,dy])=>({x:sx+dx,y:sy+dy})).find(({x,y})=>x>left+1&&x<right-1&&y>top+1&&y<bottom-1);if(!pickup)throw new Error('Pointer source is too small for a threshold-crossing pickup');const state={captured:false};const onCapture=()=>{state.captured=true};source.addEventListener('gotpointercapture',onCapture);window.__abyssQaNativePointer={source,state,onCapture};return JSON.stringify({sx,sy,px:pickup.x,py:pickup.y,tx,ty})})()`,
      ),
    );
    const nativeHelpers = `ObjC.import('Cocoa');const point=(x,y)=>$.CGPointMake(x,y);const post=(type,x,y)=>{const event=$.CGEventCreateMouseEvent(null,type,point(x,y),$.kCGMouseButtonLeft);$.CGEventPost($.kCGHIDEventTap,event)}`;
    const pickupScript = `${nativeHelpers};post($.kCGEventLeftMouseDown,${String(geometry.sx)},${String(geometry.sy)});$.NSThread.sleepForTimeInterval(0.05);post($.kCGEventLeftMouseDragged,${String(geometry.px)},${String(geometry.py)});$.NSThread.sleepForTimeInterval(0.05)`;
    const dragScript = `${nativeHelpers};const px=${String(geometry.px)},py=${String(geometry.py)},tx=${String(geometry.tx)},ty=${String(geometry.ty)};for(let step=1;step<=8;step+=1){const progress=step/8;post($.kCGEventLeftMouseDragged,px+(tx-px)*progress,py+(ty-py)*progress);$.NSThread.sleepForTimeInterval(0.03)}post($.kCGEventLeftMouseUp,tx,ty);$.NSThread.sleepForTimeInterval(0.05)`;
    const pointerCaptured = runNativePointerPhase(
      {
        pickup: () => run('osascript', ['-l', 'JavaScript', '-e', pickupScript]),
        captureObserved: () =>
          obsidianEval(`window.__abyssQaNativePointer?.state.captured===true`) === 'true',
        drag: () => run('osascript', ['-l', 'JavaScript', '-e', dragScript]),
        release: ({ x, y }) =>
          run(
            'osascript',
            [
              '-l',
              'JavaScript',
              '-e',
              `${nativeHelpers};post($.kCGEventLeftMouseUp,${String(x)},${String(y)})`,
            ],
            { optional: true },
          ),
        cleanup: () =>
          obsidianEval(
            `(()=>{const owned=window.__abyssQaNativePointer;if(owned)owned.source.removeEventListener('gotpointercapture',owned.onCapture);delete window.__abyssQaNativePointer;return true})()`,
          ),
        wait: () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25),
      },
      {
        source: { x: geometry.sx, y: geometry.sy },
        pickup: { x: geometry.px, y: geometry.py },
        target: { x: geometry.tx, y: geometry.ty },
      },
    );
    return {
      pointerCaptured,
      distance: Math.hypot(geometry.tx - geometry.sx, geometry.ty - geometry.sy),
      dispatchTarget: action.dispatchTarget,
      source: { x: geometry.sx, y: geometry.sy },
      target: { x: geometry.tx, y: geometry.ty },
    };
  }
  if (action.type === 'app-restart') {
    const running = run('pgrep', ['-x', 'Obsidian']);
    const oldPid = Number.parseInt(running.stdout.split(/\s+/u)[0] ?? '', 10);
    if (!Number.isInteger(oldPid) || oldPid <= 0) throw new Error('Cannot identify Obsidian PID');
    run('osascript', ['-e', 'tell application "Obsidian" to quit']);
    let exited = false;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const probe = run('pgrep', ['-x', 'Obsidian'], { optional: true });
      if (probe.status !== 0 || !probe.stdout.split(/\s+/u).includes(String(oldPid))) {
        exited = true;
        break;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
    }
    if (!exited) throw new Error(`Obsidian process ${String(oldPid)} did not exit`);
    run('open', ['-a', 'Obsidian']);
    let lastError;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      try {
        proveExactRunningVault();
        const reopened = run('pgrep', ['-x', 'Obsidian']);
        const newPid = Number.parseInt(reopened.stdout.split(/\s+/u)[0] ?? '', 10);
        if (!Number.isInteger(newPid) || newPid <= 0 || newPid === oldPid) {
          throw new Error('Obsidian process identity did not change');
        }
        if (obsidianEval(`app.plugins.enabledPlugins.has('task-calendar')`) !== 'true') {
          throw new Error('Plugin is not enabled after restart');
        }
        return { oldPid, newPid, reopened: 'Obsidian', vault: EXPECTED_DEV_VAULT };
      } catch (error) {
        lastError = error;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
      }
    }
    throw new Error(
      `Obsidian restart did not reconnect to the exact Dev Vault: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
    );
  }
  return parseEvalResult(obsidianEval(evaluateAction(action)));
}

function domainStateEval(code) {
  return `(async()=>JSON.stringify(await (${code})))()`;
}

function capturePostconditions(scenario) {
  return scenario.postconditions.map((condition) => {
    const actual = parseEvalResult(obsidianEval(domainStateEval(condition.code)));
    const passed =
      condition.type === 'eval-truthy'
        ? Boolean(actual)
        : canonicalSnapshotHash(actual) === canonicalSnapshotHash(condition.expected);
    return {
      id: condition.id,
      passed,
      actualSha256: canonicalSnapshotHash(actual),
      actual,
    };
  });
}

function captureMeasurements(scenario) {
  return scenario.measurements.map((measurement) => {
    const observed = parseEvalResult(
      obsidianEval(
        measurement.type === 'density'
          ? `(()=>{const elements=[...document.querySelectorAll(${JSON.stringify(measurement.selector)})];if(elements.length===0)throw new Error('Missing density target');const top=Math.min(...elements.map(el=>el.getBoundingClientRect().top));const bottom=Math.max(...elements.map(el=>el.getBoundingClientRect().bottom));const height=Math.max(1,bottom-top);return JSON.stringify({value:elements.length*100/height,details:{itemCount:elements.length,spanHeight:height}})})()`
          : `(()=>{const target=document.querySelector(${JSON.stringify(measurement.selector)});const reference=document.querySelector(${JSON.stringify(measurement.referenceSelector)});if(!target||!reference)throw new Error('Missing native reference measurement target');const targetHeight=target.getBoundingClientRect().height;const referenceHeight=reference.getBoundingClientRect().height;if(!(referenceHeight>0))throw new Error('Native reference has zero height');return JSON.stringify({value:targetHeight/referenceHeight,details:{targetHeight,referenceHeight}})})()`,
      ),
    );
    const value = Number(observed?.value);
    const details = object(observed?.details) ?? {};
    return {
      id: measurement.id,
      type: measurement.type,
      value,
      passed: value >= measurement.min && value <= measurement.max,
      details,
      detailsSha256: canonicalSnapshotHash(details),
    };
  });
}

function environmentSetup(scenario) {
  return `(()=>{document.documentElement.classList.toggle('theme-dark',${scenario.theme === 'dark'});document.documentElement.classList.toggle('theme-light',${scenario.theme === 'light'});document.body.dataset.abyssQaRequestedPointer=${JSON.stringify(scenario.pointer)};document.body.dataset.abyssQaZoom=${JSON.stringify(String(scenario.zoom))};document.body.dataset.abyssQaWidth=${JSON.stringify(String(scenario.width))};window.resizeTo(${scenario.width},Math.max(700,Math.round(900/${scenario.zoom})));document.body.style.zoom=${JSON.stringify(String(scenario.zoom))};return JSON.stringify({width:window.innerWidth,dpr:window.devicePixelRatio,zoom:Number(document.body.dataset.abyssQaZoom)})})()`;
}

function observationEval(scenario) {
  return `(()=>{const root=document.querySelector(${JSON.stringify(scenario.rootSelector)});const title=document.title;const landmark=root&&((root.getAttribute('aria-label')||root.getAttribute('role')||'').includes(${JSON.stringify(scenario.expectedLandmark)})||root.textContent?.includes(${JSON.stringify(scenario.expectedLandmark)}))?${JSON.stringify(scenario.expectedLandmark)}:null;const pointer=window.matchMedia('(pointer: coarse)').matches?'coarse':window.matchMedia('(hover: none)').matches?'hover-none':'fine';const theme=document.documentElement.classList.contains('theme-dark')?'dark':document.documentElement.classList.contains('theme-light')?'light':'unknown';return JSON.stringify({windowTitle:title,rootSelector:root?${JSON.stringify(scenario.rootSelector)}:null,landmark,dpr:window.devicePixelRatio,zoom:Number.parseFloat(getComputedStyle(document.body).zoom)||1,pointer,theme,viewportWidth:window.innerWidth})})()`;
}

function assertionFailure(scenario, dom) {
  for (const assertion of scenario.assertions) {
    if (assertion.type === 'dom-contains' && !dom.includes(assertion.value)) {
      return `DOM did not contain ${assertion.value}`;
    }
    if (assertion.type === 'dom-not-contains' && dom.includes(assertion.value)) {
      return `DOM unexpectedly contained ${assertion.value}`;
    }
    if (assertion.type === 'eval-truthy' && obsidianEval(assertion.code) !== 'true') {
      return `Evaluation was not true: ${assertion.code}`;
    }
  }
  return null;
}

function accessibilityProjectionEval(rootSelector) {
  return `(()=>{const root=document.querySelector(${JSON.stringify(rootSelector)});if(!root)throw new Error('Missing accessibility root');const selector='button,a[href],input,select,textarea,summary,[role],[tabindex]';const roleFor=(el)=>el.getAttribute('role')||({BUTTON:'button',A:'link',INPUT:el.type==='checkbox'?'checkbox':'textbox',SELECT:'combobox',TEXTAREA:'textbox',SUMMARY:'button'}[el.tagName]||null);const nameFor=(el)=>el.getAttribute('aria-label')||el.getAttribute('title')||el.value||el.textContent?.trim()||'';return JSON.stringify([...root.querySelectorAll(selector)].map((el,index)=>({order:index,tag:el.tagName.toLowerCase(),role:roleFor(el),name:nameFor(el),tabIndex:el.tabIndex,focused:el===document.activeElement,states:{disabled:el.disabled===true||el.getAttribute('aria-disabled')==='true',checked:el.checked===true||el.getAttribute('aria-checked'),pressed:el.getAttribute('aria-pressed'),selected:el.selected===true||el.getAttribute('aria-selected'),expanded:el.getAttribute('aria-expanded'),current:el.getAttribute('aria-current')}})))})()`;
}

function captureAx(expectedWindowTitle) {
  const script = `tell application "System Events"\nif not (exists process "Obsidian") then error "Obsidian process unavailable"\ntell process "Obsidian"\nset targetWindow to first window whose name contains ${JSON.stringify(expectedWindowTitle)}\nreturn entire contents of targetWindow as text\nend tell\nend tell`;
  return run('osascript', ['-e', script], { optional: true });
}

function safeFilename(value) {
  return value.replace(/[^a-z0-9_.-]+/giu, '_');
}

export async function verifyEvidenceArtifacts(scenario, record, out) {
  const name = safeFilename(scenario.id);
  const perScenario = await readJson(join(out, 'evidence', `${name}.json`));
  if (canonicalSnapshotHash(perScenario) !== canonicalSnapshotHash(record)) {
    throw new Error(`Scenario ${scenario.id} per-scenario JSON hash mismatch`);
  }
  const screenshot = await analyzePng(join(out, 'screenshots', `${name}.png`));
  if (canonicalSnapshotHash(screenshot) !== canonicalSnapshotHash(record.screenshot)) {
    throw new Error(`Scenario ${scenario.id} screenshot hash/dimensions/histogram mismatch`);
  }
  const dom = await readFile(join(out, 'dom', `${name}.html`), 'utf8');
  if (canonicalSnapshotHash(dom) !== record.domSha256) {
    throw new Error(`Scenario ${scenario.id} DOM hash mismatch`);
  }
  const accessibility = await readJson(join(out, 'accessibility', `${name}.json`));
  if (canonicalSnapshotHash(accessibility) !== record.accessibility.sha256) {
    throw new Error(`Scenario ${scenario.id} accessibility hash mismatch`);
  }
  const before = await readJson(join(out, 'workflow', `${name}.before.json`));
  const after = await readJson(join(out, 'workflow', `${name}.after.json`));
  const beforeSha256 = canonicalSnapshotHash(before);
  const afterSha256 = canonicalSnapshotHash(after);
  if (
    beforeSha256 !== record.workflow.beforeSha256 ||
    afterSha256 !== record.workflow.afterSha256
  ) {
    throw new Error(`Scenario ${scenario.id} workflow hash mismatch`);
  }
  if (
    beforeSha256 !== canonicalSnapshotHash(record.workflow.beforeState) ||
    afterSha256 !== canonicalSnapshotHash(record.workflow.afterState)
  ) {
    throw new Error(`Scenario ${scenario.id} reopened canonical workflow state mismatch`);
  }
  if (record.workflow.changed !== (beforeSha256 !== afterSha256)) {
    throw new Error(
      `Scenario ${scenario.id} workflow changed flag contradicts state-change evidence`,
    );
  }
}

async function captureScenario(scenario, out, artifactSha256, fixtureManifestSha256) {
  obsidianEval(environmentSetup(scenario));
  for (const code of scenario.setupEval) obsidianEval(code);
  const workflowAction =
    scenario.interactions.find(({ workflow }) => workflow === true) ??
    scenario.interactions.find(({ type }) =>
      [
        'key',
        'click',
        'click-text',
        'input',
        'context-menu',
        'pointer-drag',
        'plugin-reload',
        'app-restart',
      ].includes(type),
    );
  if (!workflowAction) throw new Error(`Scenario ${scenario.id} has no real workflow action`);
  let workflowBefore;
  let workflowAfter;
  let interactionResult;
  for (const action of scenario.interactions) {
    if (action === workflowAction)
      workflowBefore = parseEvalResult(
        obsidianEval(domainStateEval(scenario.stateSnapshot.beforeEval)),
      );
    const result = executeAction(action, scenario);
    if (action === workflowAction) {
      interactionResult = result;
    }
  }
  workflowAfter = parseEvalResult(obsidianEval(domainStateEval(scenario.stateSnapshot.afterEval)));
  const workflowType =
    workflowAction.type === 'context-menu'
      ? 'context-menu'
      : workflowAction.type === 'pointer-drag'
        ? 'pointer-drag'
        : workflowAction.type === 'plugin-reload'
          ? 'plugin-reload'
          : workflowAction.type === 'app-restart'
            ? 'app-restart'
            : ['click', 'click-text', 'input'].includes(workflowAction.type)
              ? 'click'
              : 'keyboard';
  const workflow = {
    type: workflowType,
    changed: canonicalSnapshotHash(workflowBefore) !== canonicalSnapshotHash(workflowAfter),
    beforeSha256: canonicalSnapshotHash(workflowBefore),
    afterSha256: canonicalSnapshotHash(workflowAfter),
    beforeState: workflowBefore,
    afterState: workflowAfter,
    interaction: {
      actionType: workflowAction.type,
      resultSha256: canonicalSnapshotHash(interactionResult),
      result: interactionResult,
    },
  };
  const workflowDir = join(out, 'workflow');
  await mkdir(workflowDir, { recursive: true });
  await writeFile(
    join(workflowDir, `${safeFilename(scenario.id)}.before.json`),
    `${JSON.stringify(workflowBefore, null, 2)}\n`,
  );
  await writeFile(
    join(workflowDir, `${safeFilename(scenario.id)}.after.json`),
    `${JSON.stringify(workflowAfter, null, 2)}\n`,
  );
  const screenshotPath = join(out, 'screenshots', `${safeFilename(scenario.id)}.png`);
  await mkdir(dirname(screenshotPath), { recursive: true });
  obsidian('dev:screenshot', `path=${screenshotPath}`);
  const dom = obsidian('dev:dom', `selector=${scenario.rootSelector}`, 'html').stdout;
  const domPath = join(out, 'dom', `${safeFilename(scenario.id)}.html`);
  await mkdir(dirname(domPath), { recursive: true });
  await writeFile(domPath, `${dom}\n`, 'utf8');
  const screenshot = await analyzePng(screenshotPath);
  const postconditions = capturePostconditions(scenario);
  const measurements = captureMeasurements(scenario);
  const observation = JSON.parse(obsidianEval(observationEval(scenario)));
  const ax = captureAx(scenario.expectedWindowTitle);
  const domProjection = JSON.parse(
    obsidianEval(accessibilityProjectionEval(scenario.rootSelector)),
  );
  const axSnapshot = {
    expectedWindowTitle: scenario.expectedWindowTitle,
    lines: ax.stdout
      .replaceAll('\r\n', '\n')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean),
  };
  const accessibility =
    ax.status === 0 && ax.stdout
      ? { provider: 'macos-ax', sha256: canonicalSnapshotHash(axSnapshot), snapshot: axSnapshot }
      : {
          provider: 'dom-projection',
          sha256: canonicalSnapshotHash(domProjection),
          snapshot: domProjection,
        };
  const axPath = join(out, 'accessibility', `${safeFilename(scenario.id)}.json`);
  await mkdir(dirname(axPath), { recursive: true });
  await writeFile(axPath, `${JSON.stringify(accessibility.snapshot, null, 2)}\n`, 'utf8');
  const mismatch =
    observation.windowTitle !== scenario.expectedWindowTitle
      ? 'Wrong Obsidian window title.'
      : observation.rootSelector !== scenario.rootSelector
        ? 'Expected root selector was not found.'
        : observation.landmark !== scenario.expectedLandmark
          ? 'Expected accessibility landmark was not found.'
          : (assertionFailure(scenario, dom) ??
            postconditions.find(({ passed }) => !passed)?.id ??
            measurements.find(({ passed }) => !passed)?.id ??
            (workflowAction.type === 'pointer-drag' &&
            (interactionResult?.pointerCaptured !== true ||
              interactionResult?.dispatchTarget !== workflowAction.dispatchTarget ||
              interactionResult?.distance < workflowAction.movementThreshold)
              ? 'Pointer drag did not satisfy capture/document/threshold evidence.'
              : null));
  const pointerFallback = observation.pointer !== scenario.pointer;
  const fallback = accessibility.provider === 'dom-projection' || pointerFallback;
  const status = mismatch ? 'rejected' : fallback ? 'unsupported-with-fallback' : 'accepted';
  return {
    scenarioId: scenario.id,
    status,
    reason:
      mismatch ??
      (fallback
        ? 'OS accessibility or requested pointer media was unavailable; deterministic DOM and keyboard fallbacks recorded.'
        : 'Expected Obsidian surface, DOM landmark, accessibility tree, and nonblank pixels were captured.'),
    expectedWindowTitle: scenario.expectedWindowTitle,
    observedWindowTitle: observation.windowTitle,
    rootSelector: scenario.rootSelector,
    observedRootSelector: observation.rootSelector,
    expectedLandmark: scenario.expectedLandmark,
    observedLandmark: observation.landmark,
    theme: scenario.theme,
    observedTheme: observation.theme,
    viewportWidth: scenario.width,
    observedViewportWidth: observation.viewportWidth,
    requestedZoom: scenario.zoom,
    requestedPointerMedia: scenario.pointer,
    workflow,
    postconditions,
    measurements,
    screenshot,
    domSha256: canonicalSnapshotHash(dom),
    accessibility: { provider: accessibility.provider, sha256: accessibility.sha256 },
    dpr: observation.dpr,
    observedZoom: observation.zoom,
    observedPointerMedia: observation.pointer,
    pluginArtifactSha256: artifactSha256,
    fixtureManifestSha256,
    ...(fallback && { fallbackTestEvidence: Object.values(FALLBACK_TESTS) }),
  };
}

function parseArgs(argv) {
  const [command, ...tokens] = argv;
  const options = {};
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token.startsWith('--')) throw new Error(`Unexpected argument ${token}`);
    const name = token.slice(2);
    const value = tokens[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for --${name}`);
    options[name] = value;
    index += 1;
  }
  return { command, options };
}

function requiredOption(options, name) {
  return nonemptyString(options[name], `--${name}`);
}

function assertCommittedScenarios(path) {
  const candidate = resolve(path);
  if (candidate !== COMMITTED_SCENARIOS) {
    throw new Error(`Refusing uncommitted QA scenarios: ${candidate}`);
  }
  return candidate;
}

export function assertSafeEvidenceOut(path) {
  const candidate = resolve(path);
  const root = join(REPO_ROOT, '.superpowers', 'sdd');
  if (!candidate.startsWith(`${root}${sep}`) || !candidate.includes(`${sep}devvault-qa${sep}`)) {
    throw new Error(
      `Refusing QA evidence outside the ignored SDD evidence directory: ${candidate}`,
    );
  }
  assertNoSymlinkComponents(candidate, root);
  ensureSeparated(EXPECTED_DEV_VAULT, candidate);
  return candidate;
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function prepareCommand(options) {
  const vault = assertExactDevVault(requiredOption(options, 'vault'));
  const out = assertSafeEvidenceOut(requiredOption(options, 'out'));
  const manifest = await createFixtureBackup(vault, out);
  const source = await pluginArtifactHash(REPO_ROOT);
  const installedDirectory = join(vault, '.obsidian', 'plugins', 'task-calendar');
  assertNoSymlinkComponents(installedDirectory, vault);
  const installed = await pluginArtifactHash(installedDirectory);
  if (source.sha256 !== installed.sha256) {
    throw new Error('Installed Dev Vault plugin artifact mismatch');
  }
  await writeFile(
    join(out, 'artifact-manifest.json'),
    `${JSON.stringify({ source, installed }, null, 2)}\n`,
    'utf8',
  );
  return { files: manifest.length, artifactSha256: source.sha256 };
}

async function captureCommand(options) {
  assertExactDevVault(EXPECTED_DEV_VAULT);
  proveExactRunningVault();
  const scenariosPath = assertCommittedScenarios(requiredOption(options, 'scenarios'));
  const out = assertSafeEvidenceOut(requiredOption(options, 'out'));
  const scenarios = validateAndExpandScenarios(await readJson(scenariosPath));
  const artifact = await readJson(join(out, 'artifact-manifest.json'));
  const fixtureManifestSha256 = (
    await readFile(join(out, 'fixture-manifest.sha256'), 'utf8')
  ).trim();
  const records = [];
  await mkdir(join(out, 'evidence'), { recursive: true });
  for (const scenario of scenarios) {
    const record = await captureScenario(
      scenario,
      out,
      artifact.source.sha256,
      fixtureManifestSha256,
    );
    records.push(record);
    await writeFile(
      join(out, 'evidence', `${safeFilename(scenario.id)}.json`),
      `${JSON.stringify(record, null, 2)}\n`,
      'utf8',
    );
  }
  await writeFile(join(out, 'evidence.json'), `${JSON.stringify(records, null, 2)}\n`, 'utf8');
  return { scenarios: records.length };
}

async function verifyCommand(options) {
  const scenariosPath = assertCommittedScenarios(requiredOption(options, 'scenarios'));
  const out = assertSafeEvidenceOut(requiredOption(options, 'out'));
  const scenarios = validateAndExpandScenarios(await readJson(scenariosPath));
  const records = await readJson(join(out, 'evidence.json'));
  const schema = await readJson(join(REPO_ROOT, 'scripts', 'devvault-qa', 'evidence.schema.json'));
  validateEvidenceDocument(schema, records);
  const artifact = await readJson(join(out, 'artifact-manifest.json'));
  const fixtureManifestSha256 = (
    await readFile(join(out, 'fixture-manifest.sha256'), 'utf8')
  ).trim();
  assertHash(fixtureManifestSha256, 'fixtureManifestSha256');
  const fixtureManifest = await readJson(join(out, 'fixture-manifest.before.json'));
  if (canonicalSnapshotHash(fixtureManifest) !== fixtureManifestSha256) {
    throw new Error('Fixture manifest checksum mismatch');
  }
  const backupManifest = await manifestForDirectory(join(out, 'backup'));
  const backupDifferences = diffManifests(fixtureManifest, backupManifest);
  if (backupDifferences.length > 0) {
    throw new Error(`Fixture backup changed after prepare: ${backupDifferences.join(', ')}`);
  }

  const vault = assertExactDevVault(EXPECTED_DEV_VAULT);
  const installedDirectory = join(vault, '.obsidian', 'plugins', 'task-calendar');
  assertNoSymlinkComponents(installedDirectory, vault);
  const sourceNow = await pluginArtifactHash(REPO_ROOT);
  const installedNow = await pluginArtifactHash(installedDirectory);
  if (
    artifact?.source?.sha256 !== sourceNow.sha256 ||
    artifact?.installed?.sha256 !== installedNow.sha256 ||
    sourceNow.sha256 !== installedNow.sha256
  ) {
    throw new Error('Plugin artifact changed after prepare or installed artifact is stale');
  }

  for (const scenario of scenarios) {
    const record = records.find((candidate) => candidate?.scenarioId === scenario.id);
    if (!record) continue;
    await verifyEvidenceArtifacts(scenario, record, out);
  }

  let fallbackTestRun;
  if (records.some((record) => record?.status === 'unsupported-with-fallback')) {
    fallbackTestRun = await runFallbackContractTests();
    await writeFile(
      join(out, 'fallback-tests.json'),
      `${JSON.stringify(fallbackTestRun, null, 2)}\n`,
      'utf8',
    );
    if (fallbackTestRun.exitCode !== 0) {
      throw new Error('Fallback contract tests failed');
    }
  }
  const result = verifyEvidenceMatrix(scenarios, records, {
    pluginArtifactSha256: sourceNow.sha256,
    fixtureManifestSha256,
    fallbackTestRun,
  });
  await writeFile(join(out, 'verification.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  return result;
}

async function restoreCommand(options) {
  const out = assertSafeEvidenceOut(requiredOption(options, 'out'));
  const vault = assertExactDevVault(EXPECTED_DEV_VAULT);
  proveExactRunningVault();
  const restored = await restoreFixtureBackup(vault, out);
  return { restoredFiles: restored.length };
}

async function main(argv) {
  const { command, options } = parseArgs(argv);
  let result;
  if (command === 'prepare') result = await prepareCommand(options);
  else if (command === 'capture') result = await captureCommand(options);
  else if (command === 'verify') result = await verifyCommand(options);
  else if (command === 'restore') result = await restoreCommand(options);
  else {
    throw new Error(
      'Usage: devvault-qa.mjs <prepare|capture|verify|restore> --out <path> [--vault <path>] [--scenarios <path>]',
    );
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT_PATH) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
