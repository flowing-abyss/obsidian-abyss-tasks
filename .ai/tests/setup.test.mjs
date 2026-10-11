import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
const aiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// --- setup.mjs on a temporary checkout: the links it replaces and refuses ---

const posixLinksOnly = {
  skip: process.platform === 'win32' && 'a Windows checkout holds hard links, which never dangle',
};

// The smallest checkout setup.mjs runs in: its own copy, because it finds
// `.ai` from its real path, and a source for every link it makes.
function makeCheckout(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'ai-setup-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const dir of ['skills', 'configs', 'scripts/opencode', 'scripts/pi']) {
    mkdirSync(path.join(root, '.ai', dir), { recursive: true });
  }
  copyFileSync(path.join(aiRoot, 'setup.mjs'), path.join(root, '.ai', 'setup.mjs'));
  for (const source of [
    'configs/AGENTS.md',
    'scripts/opencode/pnpm-policy.js',
    'scripts/opencode/codegraph.js',
    'scripts/pi/pnpm-policy.ts',
    'scripts/pi/codegraph.ts',
  ]) {
    writeFileSync(path.join(root, '.ai', source), '');
  }
  return root;
}

function runSetup(root) {
  return spawnSync(process.execPath, [path.join(root, '.ai', 'setup.mjs')], {
    cwd: root,
    encoding: 'utf8',
  });
}

function placeLink(root, linkPath, storedTarget) {
  mkdirSync(path.dirname(path.join(root, linkPath)), { recursive: true });
  symlinkSync(storedTarget, path.join(root, linkPath));
}

function describePath(root, linkPath) {
  const absolute = path.join(root, linkPath);
  return lstatSync(absolute).isSymbolicLink()
    ? `a link to ${readlinkSync(absolute)}`
    : `a file holding ${readFileSync(absolute, 'utf8')}`;
}

test('setup.mjs replaces its own stale links, then leaves them alone', posixLinksOnly, (t) => {
  const root = makeCheckout(t);
  const moves = [
    [
      '.opencode/plugins/pnpm-policy.js',
      '../../.ai/configs/.opencode/plugins/pnpm-policy.js',
      '../../.ai/scripts/opencode/pnpm-policy.js',
    ],
    [
      '.pi/extensions/pnpm-policy.ts',
      '../../.ai/configs/.pi/extensions/pnpm-policy.ts',
      '../../.ai/scripts/pi/pnpm-policy.ts',
    ],
  ];
  for (const [linkPath, oldTarget] of moves) placeLink(root, linkPath, oldTarget);

  const first = runSetup(root);
  assert.equal(first.status, 0, first.stdout);
  const lines = first.stdout.split('\n');
  for (const [linkPath, oldTarget, newTarget] of moves) {
    const report = `replaced ${linkPath} -> ${newTarget} (the old link pointed to "${oldTarget}")`;
    assert.ok(lines.includes(report), `missing "${report}" in:\n${first.stdout}`);
    assert.equal(describePath(root, linkPath), `a link to ${newTarget}`);
  }
  assert.match(first.stdout, /^\d+ created, 2 replaced, 0 already OK, 0 conflicts\.$/m);

  const second = runSetup(root);
  assert.equal(second.status, 0, second.stdout);
  assert.match(second.stdout, /^0 created, 0 replaced, \d+ already OK, 0 conflicts\.$/m);
});

for (const [what, place] of [
  [
    'a regular file',
    (root) => {
      mkdirSync(path.join(root, '.opencode', 'plugins'), { recursive: true });
      writeFileSync(path.join(root, '.opencode', 'plugins', 'pnpm-policy.js'), 'mine');
    },
  ],
  [
    'a resolving link into .ai/',
    (root) => placeLink(root, '.opencode/plugins/pnpm-policy.js', '../../.ai/configs/AGENTS.md'),
  ],
  [
    'a dangling link to a path outside .ai/',
    (root) => placeLink(root, '.opencode/plugins/pnpm-policy.js', '../../outside/pnpm-policy.js'),
  ],
  [
    'an unknown dangling link inside .ai/',
    (root) =>
      placeLink(root, '.opencode/plugins/pnpm-policy.js', '../../.ai/custom/pnpm-policy.js'),
  ],
  [
    'a dangling link into a sibling .ai-old/',
    (root) => placeLink(root, '.opencode/plugins/pnpm-policy.js', '../../.ai-old/configs/x'),
  ],
  [
    'a dangling link that lives outside the checkout through a linked .opencode',
    (root, t) => {
      const outside = mkdtempSync(path.join(tmpdir(), 'ai-setup-outside-'));
      t.after(() => rmSync(outside, { recursive: true, force: true }));
      symlinkSync(outside, path.join(root, '.opencode'), 'dir');
      placeLink(
        outside,
        'plugins/pnpm-policy.js',
        '../../.ai/configs/.opencode/plugins/pnpm-policy.js',
      );
    },
  ],
]) {
  test(`setup.mjs keeps ${what} at a link path as a conflict`, posixLinksOnly, (t) => {
    const root = makeCheckout(t);
    const linkPath = '.opencode/plugins/pnpm-policy.js';
    place(root, t);
    const before = describePath(root, linkPath);

    const result = runSetup(root);

    assert.equal(result.status, 1, result.stdout);
    const report = `conflict ${linkPath} (exists and is not the expected link to ../../.ai/scripts/opencode/pnpm-policy.js: `;
    assert.ok(
      result.stdout.split('\n').some((line) => line.startsWith(report)),
      `missing "${report}" in:\n${result.stdout}`,
    );
    assert.doesNotMatch(result.stdout, /^replaced /m);
    assert.equal(describePath(root, linkPath), before);
  });
}
