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

function validateAction(value, field, contract) {
  const candidate = object(value);
  if (!candidate) throw new Error(`${field} must be an object`);
  const type = nonemptyString(candidate.type, `${field}.type`);
  const allowedTypes =
    contract === 'interaction'
      ? ['eval', 'key', 'click', 'click-text', 'pointer', 'pointer-drag', 'context-menu']
      : ['dom-contains', 'dom-not-contains', 'eval-truthy'];
  if (!allowedTypes.includes(type)) {
    throw new Error(`${field} has unsupported ${contract} type ${type}`);
  }
  const fieldsByType = {
    eval: ['type', 'code', 'workflow'],
    key: ['type', 'key', 'code', 'selector', 'workflow'],
    click: ['type', 'selector', 'workflow'],
    'click-text': ['type', 'value', 'workflow'],
    pointer: ['type', 'selector', 'workflow'],
    'pointer-drag': ['type', 'selector', 'targetSelector', 'workflow'],
    'context-menu': ['type', 'selector', 'workflow'],
    'dom-contains': ['type', 'value'],
    'dom-not-contains': ['type', 'value'],
    'eval-truthy': ['type', 'code'],
  };
  const additional = Object.keys(candidate).find((key) => !fieldsByType[type].includes(key));
  if (additional) throw new Error(`${field}.${additional} is an additional field`);
  if (['eval', 'eval-truthy'].includes(type)) nonemptyString(candidate.code, `${field}.code`);
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
  }
  if (['click-text', 'dom-contains', 'dom-not-contains'].includes(type)) {
    nonemptyString(candidate.value, `${field}.value`);
  }
  if (candidate.workflow !== undefined && typeof candidate.workflow !== 'boolean') {
    throw new Error(`${field}.workflow must be boolean`);
  }
  return structuredClone(candidate);
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
  const surfaces = document.surfaces.map((value, index) => {
    const surface = object(value);
    if (!surface) throw new Error(`surfaces[${index}] must be an object`);
    const id = nonemptyString(surface.id, `surfaces[${index}].id`);
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(id)) {
      throw new Error(`surfaces[${index}].id is invalid: ${id}`);
    }
    const setupEval = surface.setupEval;
    if (!Array.isArray(setupEval) || setupEval.some((entry) => typeof entry !== 'string')) {
      throw new Error(`surfaces[${index}].setupEval must be an array of strings`);
    }
    const interactions = surface.interactions;
    const assertions = surface.assertions;
    if (!Array.isArray(interactions) || !Array.isArray(assertions)) {
      throw new Error(`surfaces[${index}] interactions and assertions must be arrays`);
    }
    const validatedInteractions = interactions.map((action, actionIndex) =>
      validateAction(action, `surfaces[${index}].interactions[${actionIndex}]`, 'interaction'),
    );
    if (
      !validatedInteractions.some(
        ({ type, workflow }) =>
          workflow === true && ['key', 'context-menu', 'pointer-drag'].includes(type),
      )
    ) {
      throw new Error(`surfaces[${index}] must declare a real workflow interaction`);
    }
    return {
      id,
      expectedWindowTitle: nonemptyString(
        surface.expectedWindowTitle,
        `surfaces[${index}].expectedWindowTitle`,
      ),
      rootSelector: nonemptyString(surface.rootSelector, `surfaces[${index}].rootSelector`),
      expectedLandmark: nonemptyString(
        surface.expectedLandmark,
        `surfaces[${index}].expectedLandmark`,
      ),
      setupEval: [...setupEval],
      interactions: validatedInteractions,
      assertions: assertions.map((action, actionIndex) =>
        validateAction(action, `surfaces[${index}].assertions[${actionIndex}]`, 'assertion'),
      ),
    };
  });
  if (new Set(surfaces.map(({ id }) => id)).size !== surfaces.length) {
    throw new Error('Scenario surface ids must be unique');
  }
  const surfaceIds = new Set(surfaces.map(({ id }) => id));
  const missingSurfaces = REQUIRED_SURFACES.filter((id) => !surfaceIds.has(id));
  const unexpectedSurfaces = [...surfaceIds].filter((id) => !REQUIRED_SURFACES.includes(id));
  if (missingSurfaces.length > 0 || unexpectedSurfaces.length > 0) {
    throw new Error(
      `Scenario document required surfaces mismatch; missing=${missingSurfaces.join(',')}; unexpected=${unexpectedSurfaces.join(',')}`,
    );
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
              interactions: surface.interactions.map((action) => structuredClone(action)),
              assertions: surface.assertions.map((action) => structuredClone(action)),
            });
          }
        }
      }
    }
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
  if (!workflow || !['keyboard', 'context-menu', 'pointer-drag'].includes(workflow.type)) {
    throw new Error(`Scenario ${scenario.id} workflow evidence is invalid`);
  }
  if (typeof workflow.changed !== 'boolean') {
    throw new Error(`Scenario ${scenario.id} workflow changed state is invalid`);
  }
  assertHash(workflow.beforeSha256, `${scenario.id}.workflow.beforeSha256`);
  assertHash(workflow.afterSha256, `${scenario.id}.workflow.afterSha256`);
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
  if (!workflow.changed || workflow.beforeSha256 === workflow.afterSha256) {
    throw new Error(`Scenario ${scenario.id} fallback lacks a real state-change workflow`);
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
    (command === 'osascript' && args.length === 2 && args[0] === '-e') ||
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
    return `(()=>{const label=${JSON.stringify(action.value)};const el=[...document.querySelectorAll('button,[role="button"],[role="tab"],summary')].find(e=>e.textContent?.trim()===label);if(!el)throw new Error('Missing text interaction target '+label);el.click();return true})()`;
  }
  if (action.type === 'pointer-drag') {
    return `(()=>{const source=document.querySelector(${JSON.stringify(action.selector)});const target=document.querySelector(${JSON.stringify(action.targetSelector)});if(!source||!target)throw new Error('Missing pointer drag target');source.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,cancelable:true,pointerId:1,buttons:1}));target.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,cancelable:true,pointerId:1,buttons:1}));target.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,cancelable:true,pointerId:1,buttons:0}));return true})()`;
  }
  throw new Error(`Unsupported interaction ${action.type}`);
}

function environmentSetup(scenario) {
  return `(()=>{document.documentElement.classList.toggle('theme-dark',${scenario.theme === 'dark'});document.documentElement.classList.toggle('theme-light',${scenario.theme === 'light'});document.body.dataset.abyssQaRequestedPointer=${JSON.stringify(scenario.pointer)};document.body.dataset.abyssQaZoom=${JSON.stringify(String(scenario.zoom))};document.body.dataset.abyssQaWidth=${JSON.stringify(String(scenario.width))};window.resizeTo(${scenario.width},Math.max(700,Math.round(900/${scenario.zoom})));document.body.style.zoom=${JSON.stringify(String(scenario.zoom))};return JSON.stringify({width:window.innerWidth,dpr:window.devicePixelRatio,zoom:Number(document.body.dataset.abyssQaZoom)})})()`;
}

function observationEval(scenario) {
  return `(()=>{const root=document.querySelector(${JSON.stringify(scenario.rootSelector)});const title=document.title;const landmark=root&&((root.getAttribute('aria-label')||root.getAttribute('role')||'').includes(${JSON.stringify(scenario.expectedLandmark)})||root.textContent?.includes(${JSON.stringify(scenario.expectedLandmark)}))?${JSON.stringify(scenario.expectedLandmark)}:null;const pointer=window.matchMedia('(pointer: coarse)').matches?'coarse':window.matchMedia('(hover: none)').matches?'hover-none':'fine';const theme=document.documentElement.classList.contains('theme-dark')?'dark':document.documentElement.classList.contains('theme-light')?'light':'unknown';return JSON.stringify({windowTitle:title,rootSelector:root?${JSON.stringify(scenario.rootSelector)}:null,landmark,dpr:window.devicePixelRatio,zoom:Number.parseFloat(getComputedStyle(document.body).zoom)||1,pointer,theme,viewportWidth:window.innerWidth})})()`;
}

function workflowSnapshotEval() {
  return `(()=>{const active=document.activeElement;return JSON.stringify({body:document.body.innerHTML,active:active?{tag:active.tagName,aria:active.getAttribute('aria-label'),text:active.textContent?.trim().slice(0,200),value:'value'in active?active.value:null}:null})})()`;
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
      ['key', 'context-menu', 'pointer-drag'].includes(type),
    );
  if (!workflowAction) throw new Error(`Scenario ${scenario.id} has no real workflow action`);
  let workflowBefore;
  let workflowAfter;
  for (const action of scenario.interactions) {
    if (action === workflowAction)
      workflowBefore = JSON.parse(obsidianEval(workflowSnapshotEval()));
    obsidianEval(evaluateAction(action));
    if (action === workflowAction) workflowAfter = JSON.parse(obsidianEval(workflowSnapshotEval()));
  }
  const workflowType =
    workflowAction.type === 'context-menu'
      ? 'context-menu'
      : workflowAction.type === 'pointer-drag'
        ? 'pointer-drag'
        : 'keyboard';
  const workflow = {
    type: workflowType,
    changed: canonicalSnapshotHash(workflowBefore) !== canonicalSnapshotHash(workflowAfter),
    beforeSha256: canonicalSnapshotHash(workflowBefore),
    afterSha256: canonicalSnapshotHash(workflowAfter),
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
          : assertionFailure(scenario, dom);
  const pointerFallback = observation.pointer !== scenario.pointer;
  const fallback = accessibility.provider === 'dom-projection' || pointerFallback;
  const fallbackWithoutWorkflow = fallback && !workflow.changed;
  const status =
    mismatch || fallbackWithoutWorkflow
      ? 'rejected'
      : fallback
        ? 'unsupported-with-fallback'
        : 'accepted';
  return {
    scenarioId: scenario.id,
    status,
    reason:
      mismatch ??
      (fallbackWithoutWorkflow
        ? 'Platform fallback lacks a real keyboard/context-menu workflow.'
        : null) ??
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
