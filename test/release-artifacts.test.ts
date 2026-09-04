import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const REPOSITORY_ROOT = process.cwd();
const PRODUCER_PATH = path.join(REPOSITORY_ROOT, 'release-artifacts.mjs');
const CHECKER_PATH = path.join(REPOSITORY_ROOT, 'release-check.mjs');

let fixtureDirectory = '';

beforeEach(() => {
  fixtureDirectory = mkdtempSync(path.join(tmpdir(), 'abyss-release-artifacts-'));
});

afterEach(() => {
  rmSync(fixtureDirectory, { recursive: true, force: true });
});

function runScript(scriptPath: string): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, [scriptPath], {
    cwd: fixtureDirectory,
    encoding: 'utf8',
  });
}

function writeProducerFixture(budget: number, stylesheet: string): void {
  writeFileSync(
    path.join(fixtureDirectory, 'package.json'),
    JSON.stringify({ release: { stylesCssBudgetBytes: budget } }),
  );
  writeFileSync(path.join(fixtureDirectory, 'styles.css'), stylesheet);
  mkdirSync(path.join(fixtureDirectory, 'dist'));
  writeFileSync(path.join(fixtureDirectory, 'dist/styles.css'), 'stale');
}

function writeCheckerFixture(budget: number): void {
  writeFileSync(
    path.join(fixtureDirectory, 'package.json'),
    JSON.stringify({
      name: 'release-check-fixture',
      version: '1.0.0',
      release: { mainJsBudgetBytes: 1024, stylesCssBudgetBytes: budget },
    }),
  );
  writeFileSync(
    path.join(fixtureDirectory, 'manifest.json'),
    JSON.stringify({
      id: 'release-check-fixture',
      name: 'Release Check Fixture',
      author: 'Fixture Author',
      version: '1.0.0',
      minAppVersion: '1.0.0',
      description: 'Fixture manifest for release checks.',
      isDesktopOnly: true,
    }),
  );
  writeFileSync(path.join(fixtureDirectory, 'versions.json'), '{"1.0.0":"1.0.0"}');
  writeFileSync(path.join(fixtureDirectory, 'main.js'), 'void 0;\n');
  writeFileSync(path.join(fixtureDirectory, 'styles.css'), '.alpha { color: red; }\n');
  writeFileSync(path.join(fixtureDirectory, 'README.md'), '# Fixture\n');
  writeFileSync(path.join(fixtureDirectory, 'LICENSE'), 'Fixture license\n');
}

describe('release stylesheet producer', () => {
  it('replaces stale output with minified CSS under budget', () => {
    writeProducerFixture(128, '.alpha { color: red; }');

    const result = runScript(PRODUCER_PATH);

    expect(result.status).toBe(0);
    expect(readFileSync(path.join(fixtureDirectory, 'dist/styles.css'), 'utf8')).toBe(
      '.alpha{color:red}\n',
    );
  });

  it('fails when generated CSS exceeds the configured budget', () => {
    writeProducerFixture(4, '.alpha { color: red; }');

    const result = runScript(PRODUCER_PATH);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('styles.css');
    expect(result.stderr).toContain('budget');
    expect(existsSync(path.join(fixtureDirectory, 'dist/styles.css'))).toBe(false);
  });

  it('fails on malformed CSS without preserving stale output', () => {
    writeProducerFixture(128, '.alpha { color: red; }}');

    const result = runScript(PRODUCER_PATH);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/styles\.css produced \d+ esbuild warning/u);
    expect(existsSync(path.join(fixtureDirectory, 'dist/styles.css'))).toBe(false);
  });
});

describe('release stylesheet checker', () => {
  it('fails with an actionable message when the generated stylesheet is missing', () => {
    writeCheckerFixture(128);

    const result = runScript(CHECKER_PATH);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      'dist/styles.css is missing — run `pnpm release:artifacts` first.',
    );
  });

  it('fails when the generated stylesheet is empty', () => {
    writeCheckerFixture(128);
    mkdirSync(path.join(fixtureDirectory, 'dist'));
    writeFileSync(path.join(fixtureDirectory, 'dist/styles.css'), '');

    const result = runScript(CHECKER_PATH);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('dist/styles.css is empty.');
  });

  it('fails when the generated stylesheet exceeds the shared budget', () => {
    writeCheckerFixture(4);
    mkdirSync(path.join(fixtureDirectory, 'dist'));
    writeFileSync(path.join(fixtureDirectory, 'dist/styles.css'), 'five!');

    const result = runScript(CHECKER_PATH);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('dist/styles.css is 5 bytes, over the 4-byte budget.');
  });

  it('accepts a non-empty generated stylesheet under the shared budget', () => {
    writeCheckerFixture(128);
    mkdirSync(path.join(fixtureDirectory, 'dist'));
    writeFileSync(path.join(fixtureDirectory, 'dist/styles.css'), '.a{}\n');

    const result = runScript(CHECKER_PATH);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('release:check passed.');
    expect(result.stderr).toBe('');
  });
});
