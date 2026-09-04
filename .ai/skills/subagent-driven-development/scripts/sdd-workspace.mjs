#!/usr/bin/env node
// Resolve and ensure the working-tree directory SDD uses for one plan's
// short-lived artifacts: task briefs, implementer reports, review packages,
// and the progress ledger. Prints the plan directory's absolute path.
//
// One directory per plan (.superpowers/sdd/<plan-basename>/) so a follow-up
// plan in the same working tree can never read or overwrite another plan's
// artifacts. A stale ledger misread as current progress makes controllers
// skip whole task sequences — plan-scoping removes that failure structurally.
//
// The workspace lives in the working tree (not under .git/) because Claude Code
// treats .git/ as a protected path and denies agent writes there — which blocks
// an implementer subagent from writing its report file. A self-ignoring
// .gitignore at .superpowers/sdd/ keeps every plan's workspace out of
// `git status` and out of accidental commits without modifying any tracked file.
//
// Single source of truth for the workspace location, so task-brief and
// review-package cannot drift to different directories.
//
// Usage: node sdd-workspace.mjs PLAN_FILE
//
// Ported from the original bash script to run identically on Windows,
// macOS, and Linux — same usage, same stdout/exit-code contract.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export class CliError extends Error {
  constructor(exitCode, message) {
    super(message);
    this.exitCode = exitCode;
  }
}

/** @returns {string} the plan's workspace directory, created if necessary */
export function resolveWorkspace(planFile) {
  if (!existsSync(planFile)) {
    throw new CliError(2, `no such plan file: ${planFile}`);
  }

  // Matches the original `basename "$plan" .md`: strips a literal ".md"
  // suffix only, not "whatever extension is present".
  const slug = path.basename(planFile, '.md');
  if (!slug || slug === '.' || slug === '..') {
    throw new CliError(2, `cannot derive a workspace name from: ${planFile}`);
  }

  const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  const base = path.join(root, '.superpowers', 'sdd');
  const dir = path.join(base, slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(base, '.gitignore'), '*\n');

  return dir;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length !== 1) {
    console.error('usage: sdd-workspace PLAN_FILE');
    process.exit(2);
  }
  try {
    console.log(resolveWorkspace(args[0]));
  } catch (error) {
    console.error(error instanceof CliError ? error.message : String(error));
    process.exit(error instanceof CliError ? error.exitCode : 1);
  }
}
