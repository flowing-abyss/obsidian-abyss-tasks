import { selectorSpecificity } from '@csstools/selector-specificity';
import { Platform } from 'obsidian';
import postcss from 'postcss';
import selectorParser from 'postcss-selector-parser';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const loadNodeTools = async () => {
  if (!Platform.isDesktop) throw new Error('Release artifact tests require a desktop runtime');
  return Promise.all([
    import('node:child_process'),
    import('node:fs'),
    import('node:os'),
    import('node:path'),
  ]);
};
const [
  { execFileSync, spawnSync },
  { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync },
  { tmpdir },
  path,
] = await loadNodeTools();

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

// A tag-triggered workflow exports its own ref, which the checker compares with the fixture manifest.
function withoutAmbientReleaseRef(env: typeof process.env): typeof process.env {
  return Object.fromEntries(
    Object.entries(env).filter(([key]) => key !== 'GITHUB_REF_TYPE' && key !== 'GITHUB_REF_NAME'),
  );
}

function runScript(scriptPath: string, env = withoutAmbientReleaseRef(process.env)) {
  return spawnSync(process.execPath, [scriptPath], {
    cwd: fixtureDirectory,
    encoding: 'utf8',
    env,
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

interface CheckerFixtureOptions {
  readonly isDesktopOnly?: boolean;
  readonly mainJs?: string;
}

function writeCheckerFixture(budget: number, options: CheckerFixtureOptions = {}): void {
  const { isDesktopOnly = true, mainJs = 'void 0;\n' } = options;
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
      isDesktopOnly,
    }),
  );
  writeFileSync(path.join(fixtureDirectory, 'versions.json'), '{"1.0.0":"1.0.0"}');
  writeFileSync(path.join(fixtureDirectory, 'main.js'), mainJs);
  writeFileSync(path.join(fixtureDirectory, 'styles.css'), '.alpha { color: red; }\n');
  writeFileSync(path.join(fixtureDirectory, 'README.md'), '# Fixture\n');
  writeFileSync(path.join(fixtureDirectory, 'LICENSE'), 'Fixture license\n');
}

function writeAcceptedFixture(options: CheckerFixtureOptions = {}): void {
  writeCheckerFixture(128, options);
  mkdirSync(path.join(fixtureDirectory, 'dist'));
  writeFileSync(path.join(fixtureDirectory, 'dist/styles.css'), '.a{}\n');
}

describe('release stylesheet producer', () => {
  it.each(['environment', 'config-file discovery'])(
    'ignores ambient Browserslist %s when producing release bytes',
    (configuration) => {
      writeProducerFixture(128, '.alpha { background: transparent; }');
      const outputs: Buffer[] = [];
      for (const [environment, query] of [
        ['legacy', 'ie 11'],
        ['modern', 'chrome 120'],
      ]) {
        const env = Object.fromEntries(
          Object.entries(process.env).filter(([key]) => !key.startsWith('BROWSERSLIST')),
        );
        if (configuration === 'environment') env['BROWSERSLIST'] = query;
        else {
          const configPath = path.join(fixtureDirectory, '.browserslistrc');
          writeFileSync(configPath, '[legacy]\nie 11\n[modern]\nchrome 120\n');
          env['BROWSERSLIST_ENV'] = environment;
          env['BROWSERSLIST_CONFIG'] = configPath;
        }
        const result = runScript(PRODUCER_PATH, env);
        expect(result.status, result.stderr).toBe(0);
        outputs.push(readFileSync(path.join(fixtureDirectory, 'dist/styles.css')));
      }
      expect(outputs[0]).toEqual(outputs[1]);
    },
  );

  it('preserves selector specificity and scope through release minification', () => {
    const source = `
      .scope :is(.active, .inactive) > button::before { color: var(--text-normal); }
      .scope .row:hover, .scope .row:focus-within { opacity: 1; }
      .scope #strong, .scope .weak { padding: 0 1px; }
    `;
    writeProducerFixture(1024, source);
    const result = runScript(PRODUCER_PATH);
    expect(result.status, result.stderr).toBe(0);
    function inventory(css: string): string[] {
      const selectors: string[] = [];
      postcss.parse(css).walkRules((rule) => {
        for (const selector of selectorParser().astSync(rule.selector, { lossless: false }).nodes) {
          selector.walkPseudos((pseudo) => {
            if (pseudo.value === '::before') pseudo.value = ':before';
          });
          selectors.push(JSON.stringify([selector.toString(), selectorSpecificity(selector)]));
        }
      });
      return selectors.sort((left, right) => left.localeCompare(right));
    }
    const output = readFileSync(path.join(fixtureDirectory, 'dist/styles.css'), 'utf8');
    expect(inventory(output)).toEqual(inventory(source));
    expect(output).toContain('var(--text-normal)');
  });

  it('ships the real stylesheet under budget with deterministic output and untouched source', () => {
    const source = readFileSync(path.join(REPOSITORY_ROOT, 'styles.css'), 'utf8');
    const pkg = JSON.parse(readFileSync(path.join(REPOSITORY_ROOT, 'package.json'), 'utf8')) as {
      release: { stylesCssBudgetBytes: number };
    };
    writeProducerFixture(pkg.release.stylesCssBudgetBytes, source);
    const first = runScript(PRODUCER_PATH, { ...process.env, BROWSERSLIST: 'ie 11' });
    expect(first.status, first.stderr).toBe(0);
    const output = readFileSync(path.join(fixtureDirectory, 'dist/styles.css'));
    expect(output.length).toBeLessThanOrEqual(pkg.release.stylesCssBudgetBytes);
    const second = runScript(PRODUCER_PATH, { ...process.env, BROWSERSLIST: 'chrome 120' });
    expect(second.status, second.stderr).toBe(0);
    expect(readFileSync(path.join(fixtureDirectory, 'dist/styles.css'))).toEqual(output);
    expect(readFileSync(path.join(fixtureDirectory, 'styles.css'), 'utf8')).toBe(source);
  });

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
    expect(result.stderr).toBe(
      'release:check failed with 1 problem(s):\n\n  ✖ dist/styles.css is empty.\n',
    );
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
    expect(result.stdout).toBe('release:check passed.\n');
    expect(result.stderr).toBe('');
  });
});

describe('release tag checker', () => {
  function releaseRef(tag: string): typeof process.env {
    return {
      ...withoutAmbientReleaseRef(process.env),
      GITHUB_REF_TYPE: 'tag',
      GITHUB_REF_NAME: tag,
    };
  }

  it('rejects a release tag that differs from the manifest version', () => {
    writeAcceptedFixture();

    const result = runScript(CHECKER_PATH, releaseRef('2.0.0'));

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      'Release tag "2.0.0" must equal manifest.json version "1.0.0".',
    );
  });

  it('accepts a release tag that equals the manifest version', () => {
    writeAcceptedFixture();

    const result = runScript(CHECKER_PATH, releaseRef('1.0.0'));

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('release:check passed.');
  });
});

describe('release main.js checker', () => {
  const lookbehindMessage =
    'main.js contains a regular-expression lookbehind, which iOS before 16.4 cannot compile, ' +
    'but manifest.json sets "isDesktopOnly": false.';
  const negativeLookbehind = `const pattern = /${['(?', '<!a)b'].join('')}/u;\n`;
  const positiveLookbehind = `const pattern = /${['(?', '<=a)b'].join('')}/u;\n`;

  it.each([
    ['a negative', negativeLookbehind],
    ['a positive', positiveLookbehind],
  ])('rejects %s lookbehind in a mobile bundle', (_kind, mainJs) => {
    writeAcceptedFixture({ isDesktopOnly: false, mainJs });

    const result = runScript(CHECKER_PATH);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(lookbehindMessage);
  });

  it('rejects a Node built-in require in a mobile bundle', () => {
    writeAcceptedFixture({ isDesktopOnly: false, mainJs: 'require("fs");\n' });

    const result = runScript(CHECKER_PATH);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      'main.js requires Node built-in module(s) [fs] but manifest.json sets "isDesktopOnly": ' +
        'false — this will crash on mobile. Check for a desktop-only dependency that got bundled.',
    );
  });

  it.each([
    ['a lookbehind in a desktop-only bundle', true, negativeLookbehind],
    ['a named group in a mobile bundle', false, 'const pattern = /(?<name>a)/u;\n'],
  ])('accepts %s', (_case, isDesktopOnly, mainJs) => {
    writeAcceptedFixture({ isDesktopOnly, mainJs });

    const result = runScript(CHECKER_PATH);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('release:check passed.');
    expect(result.stderr).toBe('');
  });
});

describe('host Moment bundle boundary', () => {
  it('uses only the externally supplied Obsidian instance in its production bundle', () => {
    // esbuild runs in its supported Node realm, rather than jsdom's split typed-array realm.
    const output = execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
      import assert from 'node:assert/strict';
      import { runInNewContext } from 'node:vm';
      import { build } from 'esbuild';
      const result = await build({
        entryPoints: ['src/obsidianMoment.ts'], bundle: true, write: false,
        metafile: true, format: 'cjs', target: 'es2021', external: ['obsidian'],
      });
      assert.deepEqual(Object.keys(result.metafile.inputs), ['src/obsidianMoment.ts']);
      assert.deepEqual(Object.values(result.metafile.outputs).flatMap(entry => entry.imports),
        [{ path: 'obsidian', kind: 'require-call', external: true }]);
      const suppliedHost = function moment() {};
      const module = { exports: {} };
      runInNewContext(result.outputFiles[0].text, {
        module,
        require(name) {
          assert.equal(name, 'obsidian');
          return { moment: suppliedHost };
        },
      });
      assert.equal(module.exports.moment, suppliedHost);
      console.log('external host identity preserved');
    `,
      ],
      { encoding: 'utf8' },
    );
    expect(output.trim()).toBe('external host identity preserved');
  });
});
