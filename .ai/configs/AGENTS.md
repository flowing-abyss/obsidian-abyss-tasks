# Abyss Tasks plugin

An Obsidian sidebar plugin that renders vault tasks in month, week, and list views. Registers a custom `ItemView` (panel) with left/center/right sub-panels.

## Commands

| Command                        | Purpose                                       |
| ------------------------------ | --------------------------------------------- |
| `pnpm dev`                     | Watch build                                   |
| `pnpm build`                   | Typecheck + esbuild production                |
| `pnpm lint`                    | Type-aware ESLint + Obsidian rules            |
| `pnpm lint:css`                | Stylelint                                     |
| `pnpm test`                    | Vitest unit suite                             |
| `pnpm verify:task`             | Fast lint + typecheck + unit gate             |
| `pnpm verify`                  | Canonical full local/CI/pre-push quality gate |
| `pnpm format` / `format:check` | Prettier                                      |
| `pnpm deadcode`                | Knip unused code/dependencies                 |
| `pnpm release patch`           | Verify, bump, commit, tag, and push a release |

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

<!-- CODEGRAPH_START -->
## CodeGraph

In repositories indexed by CodeGraph (a `.codegraph/` directory exists at the repo root), reach for it BEFORE grep/find or reading files when you need to understand or locate code:

- **MCP tool** (when available): `codegraph_explore` answers most code questions in one call — the relevant symbols' verbatim source plus the call paths between them, including dynamic-dispatch hops grep can't follow. Name a file or symbol in the query to read its current line-numbered source. If it's listed but deferred, load it by name via tool search.
- **Shell** (always works): `codegraph explore "<symbol names or question>"` prints the same output.

If there is no `.codegraph/` directory, skip CodeGraph entirely — indexing is the user's decision.
<!-- CODEGRAPH_END -->
