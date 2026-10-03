#!/usr/bin/env node
// Bootstraps every AI-agent config from the canonical sources under `.ai/`.
//
// `.ai/` is the only agent-tooling directory tracked in git. `.claude/`, `.codex/`,
// `.forge/`, `.opencode/`, `.pi/`, `.agents/`, `AGENTS.md`, `CLAUDE.md`, `.mcp.json`,
// and `opencode.json` are all gitignored, machine-local, and rebuilt by this script.
// Run it after cloning, or any time an agent dir looks empty:
//
//   node .ai/setup.mjs
//
// Safe to re-run: existing correct links are left alone. A symlink that no longer
// resolves and points into `.ai/` can only be one this script made before its
// source moved, so it is replaced with the expected link. Anything else that isn't
// already the expected link is reported and skipped rather than overwritten.
//
// `.ai/configs/` is laid out as a literal mirror of the repo root — e.g.
// `.ai/configs/.codex/hooks.json` becomes `<repo-root>/.codex/hooks.json`.
// To wire up a new agent config, just add the file at its real repo-root-relative
// path under `.ai/configs/` and re-run this script; nothing else to edit. The one
// exception is a harness plugin in JavaScript or TypeScript, which the Obsidian
// community directory's review would read as plugin code: it lives in
// `.ai/scripts/`, which the review skips, and is linked explicitly below.
//
// Real symlinks require Administrator privileges or Windows Developer Mode,
// so `pnpm install` would fail on an ordinary Windows account. Directory
// links use junctions instead (no elevation needed); file links use hard
// links. No copy fallback: source and destination live in the same repo
// checkout, normally the same volume, so a failed hard link is reported as
// a conflict (with the destination and the real filesystem error) rather
// than silently degrading to a copy that stops tracking future edits.

import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  statSync,
  symlinkSync,
  unlinkSync,
} from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const isWindows = process.platform === 'win32';

const aiRoot = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(aiRoot, '..');
process.chdir(repoRoot);

const configsRoot = path.join(aiRoot, 'configs');

const links = [
  // Skills: every agent that understands the shared SKILL.md convention reads
  // from one of these paths. Not part of the configs mirror because it's
  // a shared directory symlink, not a 1:1 file mirror.
  ['.claude/skills', '.ai/skills'],
  ['.forge/skills', '.ai/skills'],
  ['.opencode/skills', '.ai/skills'],
  ['.pi/skills', '.ai/skills'],
  ['.agents/skills', '.ai/skills'],

  // Harness plugins live outside the configs mirror, in `.ai/scripts/`, so the
  // community directory's review doesn't read them as plugin code.
  ['.opencode/plugins/pnpm-policy.js', '.ai/scripts/opencode/pnpm-policy.js'],
  ['.opencode/plugins/codegraph.js', '.ai/scripts/opencode/codegraph.js'],
  ['.pi/extensions/pnpm-policy.ts', '.ai/scripts/pi/pnpm-policy.ts'],
  ['.pi/extensions/codegraph.ts', '.ai/scripts/pi/codegraph.ts'],

  // Claude Code's local CodeGraph installer writes project instructions here.
  // Keep it on the same canonical source as every other agent instruction file.
  ['.claude/CLAUDE.md', path.join('.ai/configs', 'AGENTS.md')],

  // AGENTS.md is the canonical agent-instructions file (mirrored from
  // `.ai/configs/AGENTS.md` below, like everything else). CLAUDE.md is
  // just a name Claude Code specifically looks for, so it links straight to
  // the same real source rather than to the generated AGENTS.md link — that
  // way it doesn't depend on link-creation order or a generated link's
  // still-linkable state.
  ['CLAUDE.md', path.join('.ai/configs', 'AGENTS.md')],

  // Hooks + MCP config: every file under `.ai/configs/` mirrored to the
  // same relative path at the repo root.
  ...listFiles(configsRoot).map((absolutePath) => {
    const relativePath = path.relative(configsRoot, absolutePath);
    return [relativePath, path.join('.ai/configs', relativePath)];
  }),
];

let created = 0;
let replaced = 0;
let skipped = 0;
let conflicts = 0;

for (const [linkPath, targetPath] of links) {
  const result = ensureLink(linkPath, targetPath);
  if (result === 'created') created += 1;
  if (result === 'replaced') replaced += 1;
  if (result === 'skipped') skipped += 1;
  if (result === 'conflict') conflicts += 1;
}

console.log(
  `\n${created} created, ${replaced} replaced, ${skipped} already OK, ${conflicts} conflicts.`,
);
if (conflicts > 0) {
  console.log('Resolve conflicts above manually, then re-run this script.');
  process.exitCode = 1;
}

function listFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(dir, entry.name);
    return entry.isDirectory() ? listFiles(entryPath) : [entryPath];
  });
}

function ensureLink(linkPath, targetPath) {
  let isDirTarget;
  try {
    isDirTarget = statSync(targetPath).isDirectory();
  } catch (error) {
    console.log(`conflict ${linkPath}: source ${targetPath} does not exist (${error.message})`);
    return 'conflict';
  }

  const linkKind = !isWindows ? 'symlink' : isDirTarget ? 'junction' : 'hardlink';
  const relativeTarget = path.relative(path.dirname(linkPath), targetPath);

  mkdirSync(path.dirname(linkPath), { recursive: true });

  let staleTarget;
  if (existsSync(linkPath) || isBrokenSymlink(linkPath)) {
    const check = isExistingLinkCorrect(linkPath, targetPath, relativeTarget, linkKind);
    if (check.ok) {
      console.log(`ok       ${linkPath}`);
      return 'skipped';
    }

    staleTarget = ownStaleLinkTarget(linkPath);
    if (staleTarget === undefined) {
      console.log(
        `conflict ${linkPath} (exists and is not the expected link to ${relativeTarget}: ${check.reason})`,
      );
      return 'conflict';
    }
    unlinkSync(linkPath);
  }

  try {
    createLink(linkPath, targetPath, relativeTarget, isDirTarget);
  } catch (error) {
    console.log(
      `conflict ${linkPath}: could not create link to ${relativeTarget} (${error.message})`,
    );
    return 'conflict';
  }

  if (staleTarget !== undefined) {
    console.log(
      `replaced ${linkPath} -> ${relativeTarget} (the old link pointed to "${staleTarget}")`,
    );
    return 'replaced';
  }
  console.log(`created  ${linkPath} -> ${relativeTarget}`);
  return 'created';
}

// Only this script makes links into `.ai/`, so a symlink that no longer resolves
// and whose stored target, resolved the way the filesystem does against the
// link's own directory, lies inside `.ai/` is one it made before its source
// moved. Returns that stored target, or undefined for anything else.
function ownStaleLinkTarget(linkPath) {
  if (existsSync(linkPath) || !isBrokenSymlink(linkPath)) return undefined;
  const storedTarget = readlinkSync(linkPath);
  const resolved = path.resolve(realpathSync(path.dirname(linkPath)), storedTarget);
  const fromAiRoot = path.relative(realpathSync(aiRoot), resolved);
  const insideAiRoot =
    fromAiRoot !== '' && !path.isAbsolute(fromAiRoot) && fromAiRoot.split(path.sep)[0] !== '..';
  return insideAiRoot ? storedTarget : undefined;
}

function createLink(linkPath, targetPath, relativeTarget, isDirTarget) {
  if (!isWindows) {
    symlinkSync(relativeTarget, linkPath);
    return;
  }

  if (isDirTarget) {
    // `type: 'junction'` needs no elevation, unlike a real directory symlink.
    // Pass an already-absolute target explicitly — real Windows CI showed
    // the junction otherwise resolving to a nonexistent path (ENOENT on
    // realpath), which points at Node resolving a relative target against
    // something other than this process's cwd for junctions specifically.
    symlinkSync(path.resolve(targetPath), linkPath, 'junction');
    return;
  }

  // Hard link: no elevation needed, but same-volume only. Source and
  // destination are both inside this one repository checkout, so they're
  // normally on the same volume; if linkSync still fails (a genuinely
  // unsupporting filesystem, a cross-volume checkout), let it throw —
  // ensureLink reports the destination and the real filesystem error and
  // treats it as a conflict. No copy fallback: a copy would stop reflecting
  // edits to `.ai/configs` the moment it's made, silently reintroducing the
  // exact drift this whole mirroring setup exists to prevent.
  linkSync(targetPath, linkPath);
}

// Returns { ok, reason } rather than a bare boolean so a genuine conflict
// (not just a broken assumption in this function) tells the user exactly
// what was found instead of a generic "not the expected link".
function isExistingLinkCorrect(linkPath, targetPath, relativeTarget, linkKind) {
  let stat;
  try {
    stat = lstatSync(linkPath);
  } catch (error) {
    return { ok: false, reason: `could not stat existing path (${error.message})` };
  }

  if (linkKind === 'symlink') {
    // POSIX: exact-match the relative target we pass to symlinkSync — this
    // also confirms it's a *relative* symlink, matching what we create.
    if (!stat.isSymbolicLink()) {
      return { ok: false, reason: `existing path is not a symlink (${describeStat(stat)})` };
    }
    const actual = readlinkSync(linkPath);
    return actual === relativeTarget
      ? { ok: true }
      : { ok: false, reason: `symlink points to "${actual}", expected "${relativeTarget}"` };
  }

  if (linkKind === 'junction') {
    // Windows junctions are reported as symbolic links by lstat, but
    // readlinkSync returns the raw stored target text (often an NT device
    // path like \\?\D:\...), which won't string-match a plain
    // path.resolve() even for a genuinely correct junction. Resolve both
    // sides through the filesystem instead of comparing stored text.
    if (!stat.isSymbolicLink()) {
      return { ok: false, reason: `existing path is not a junction (${describeStat(stat)})` };
    }
    let linkReal;
    let targetReal;
    try {
      linkReal = realpathSync(linkPath);
    } catch (error) {
      return { ok: false, reason: `could not resolve the junction's real path (${error.message})` };
    }
    try {
      targetReal = realpathSync(targetPath);
    } catch (error) {
      return { ok: false, reason: `could not resolve the source's real path (${error.message})` };
    }
    return linkReal === targetReal
      ? { ok: true }
      : { ok: false, reason: `junction resolves to "${linkReal}", expected "${targetReal}"` };
  }

  // Windows hard link: correct only if it's a real hard link (same inode)
  // to the source — no copy fallback exists to also treat as correct.
  if (!stat.isFile()) {
    return { ok: false, reason: `existing path is not a regular file (${describeStat(stat)})` };
  }
  const targetStat = statSync(targetPath);
  return stat.dev === targetStat.dev && stat.ino === targetStat.ino
    ? { ok: true }
    : { ok: false, reason: 'existing file is not a hard link to the source (different inode)' };
}

function describeStat(stat) {
  if (stat.isDirectory()) return 'a directory';
  if (stat.isFile()) return 'a regular file';
  if (stat.isSymbolicLink()) return 'a symlink/junction';
  return 'an unknown file type';
}

function isBrokenSymlink(linkPath) {
  try {
    return lstatSync(linkPath).isSymbolicLink();
  } catch {
    return false;
  }
}
