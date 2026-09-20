# Abyss Tasks plugin

An Obsidian sidebar plugin that renders vault tasks in month, week, and list views. Registers a custom `ItemView` (panel) with left/center/right sub-panels.

## Commands

| Command                        | Purpose                                        |
| ------------------------------ | ---------------------------------------------- |
| `pnpm dev`                     | Watch build                                    |
| `pnpm build`                   | Typecheck + esbuild production                 |
| `pnpm lint`                    | Type-aware ESLint + Obsidian rules             |
| `pnpm lint:css`                | Authored CSS correctness, scope, and tokens    |
| `pnpm lint:css:artifact`       | Shipped CSS policy after artifact generation   |
| `pnpm test`                    | Vitest unit suite                              |
| `pnpm verify:task`             | Fast lint + CSS + types + architecture + tests |
| `pnpm verify`                  | Canonical full local/CI/pre-push quality gate  |
| `pnpm format` / `format:check` | Prettier                                       |
| `pnpm deadcode`                | Knip unused code/dependencies                  |
| `pnpm release patch`           | Verify, bump, commit, tag, and push a release  |

## Conventions

- Strict TypeScript. Prefer `async/await`.
- Tests in `test/*.test.ts` use [obsidian-test-mocks](https://github.com/mnaoumov/obsidian-test-mocks) (auto-setup in `vitest.config.ts`).
- Conventional commits enforced by commitlint + husky hooks.
- `pnpm release` runs the canonical verification gate, updates `manifest.json` + `versions.json`, commits, tags with **no `v` prefix**, and pushes. **Never tag manually.** `manifest.json` `id` must stay `abyss-tasks`.
- Never disable, downgrade, bypass, or warn-only an applicable `eslint-plugin-obsidianmd` rule; fix the violation at its source. This includes runtime code, `manifest.json`, and `LICENSE`.
- `docs/` is gitignored — local-only scratch space for plans/specs. **Never commit `docs/`.**
- Presentation code imports task contracts from `src/tasks`; only `src/main.ts` wires concrete
  Obsidian task adapters. The legacy parser may import canonical Markdown codec internals.
- Reuse an existing application command, UI primitive, and `abyss-*` CSS family before creating a
  parallel mechanism.
- Fix dependency-cruiser and architecture-test violations at their source; never weaken a rule or
  add a blanket exception.
- `pnpm verify` is the authoritative local, CI, and pre-push gate; `verify:task` is the fast
  iteration gate. Keep source CSS checks and the post-build artifact CSS check in the full gate.
- Text writes stay with the exact file/owner/API authorities in
  `test/architecture/storageAuthority.ts`. Presentation uses public commands. A new acquisition
  needs a narrow reason and accepting/rejecting coverage, not a blanket authorization.
- Classify new `CalendarSettings` and `ProjectsSettings` keys in
  `test/architecture/settingsOwnership.ts`; verify static/view routing through the real persistence
  coordinator. Preserve unknown persisted extensions and keep session state transient.
- Pure project models receive explicit time and data. Enroll new pure modules in the exact roster
  in `eslint.config.mts`; project surfaces use their owning document/window and dispose pending
  work. The ambient rule guards references, not transitive purity or native lifecycle behavior.
- Scope styles to plugin-owned surfaces and use semantic host tokens. `tooling/css-contracts.mjs`
  owns token provenance, required fallbacks, finite runtime-variable families, and exact reasoned
  exceptions. Enroll new dynamic CSS producers/consumers there with source-backed tests; static
  checks do not prove cascade, contrast, or layout under every theme.
- Import host Moment through `src/obsidianMoment.ts`; keep its callable-type correction confined
  to that boundary and preserve the external Obsidian instance.
- Read `ARCHITECTURE.md` before planning or implementing a cross-cutting change. Use CodeGraph and
  the source code to verify the current implementation.
- Update `ARCHITECTURE.md` in the same commit when component ownership, a public boundary,
  dependency direction, a critical data flow, or a persisted source of truth changes. Keep future
  architecture in local specs until it is implemented.
- When extending an existing workflow, preserve its interaction model and reuse its rendering,
  commands, menus, and state semantics. Do not create a parallel approximation merely because it
  is locally simpler.
- Do not add persisted task metadata solely to simplify presentation logic. Prefer existing task
  syntax, source order, creation dates, and derived state. Any new persisted field requires an
  explicit compatibility and migration design.
- Prefer one complete, deeply integrated workflow over several partial views or abstractions. New
  views must reuse existing task operations and reach production-quality interaction before
  additional views are introduced.
- UI work is incomplete until it is exercised in `dev-vault-tasks` with the Obsidian CLI, inspected
  through screenshots and DOM evidence, and checked for captured runtime errors. Test desktop and
  constrained widths when layout is affected.
- Use `dev-vault-tasks` for automated UI interaction and writable smoke tests. Snapshot and restore
  modified vault content. Never deploy to or mutate the production vault unless the user explicitly
  requests it.
- Do not bump the plugin version, tag, or publish a release unless explicitly requested.

## Obsidian CLI

[Obsidian CLI](https://obsidian.md/help/cli) controls the running app from the terminal.

```shell
obsidian vault="dev-vault-tasks" plugin:reload id=abyss-tasks             # reload after rebuild
obsidian vault="dev-vault-tasks" eval code="app.vault.getFiles().length"   # run JS in app
obsidian vault="dev-vault-tasks" devtools                                  # toggle dev tools
obsidian vault="dev-vault-tasks" dev:screenshot path=screenshot.png        # screenshot
obsidian vault="dev-vault-tasks" dev:dom selector=".abyss-panel-view" text # query DOM
```

Typical loop: `pnpm dev` → `obsidian plugin:reload id=abyss-tasks`.

## References

- API docs: https://docs.obsidian.md

## CodeGraph

Prefer CodeGraph for dependency discovery, blast-radius analysis, unfamiliar code,
and cross-module refactoring. For obvious local changes, prefer ordinary Read/Search.

Step 2 of `using-git-worktrees` automatically initializes/syncs each checkout's own
ignored `.codegraph/` as best effort, including the main checkout. Before a batch
of graph queries, check for `.codegraph/codegraph.db` at the current checkout root
and run `codegraph sync` there; repeat after edits. Always pass that absolute root
(`git rev-parse --show-toplevel`) as MCP `codegraph_explore.projectPath`, or run
`codegraph explore` from that root. MCP can discover a new index without restarting,
but cross-project queries do not start a watcher. If the local index is missing,
sync fails, or results report another worktree/stale files, use Read/Search.
This project policy takes precedence over CodeGraph's generic agent guidance.
