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
- When a local `.codegraph/` index exists, use `codegraph explore "<question>"` before grep or file-by-file reading for code discovery, dependency impact, and refactoring. Use `rg` when the index is absent or CodeGraph reports that it cannot answer.
- Rebuild a missing or intentionally reset local index with `codegraph init --yes`; CodeGraph then keeps it current automatically. Use `codegraph index --force` only for a deliberate full rebuild and `codegraph status` to verify freshness.
- Never disable, downgrade, bypass, or warn-only an applicable `eslint-plugin-obsidianmd` rule; fix the violation at its source. This includes runtime code, `manifest.json`, and `LICENSE`.
- `docs/` is gitignored — local-only scratch space for plans/specs. **Never commit `docs/`.**

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
