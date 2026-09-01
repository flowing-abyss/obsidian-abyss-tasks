# Abyss Tasks plugin

An Obsidian sidebar plugin that renders vault tasks in month, week, and list views. Registers a custom `ItemView` (panel) with left/center/right sub-panels.

## Commands

| Command                           | Purpose                                              |
| --------------------------------- | ---------------------------------------------------- |
| `npm run dev`                     | Watch build                                          |
| `npm run build`                   | `tsc -noEmit` + esbuild production                   |
| `npm run lint` / `lint:fix`       | ESLint `src/`                                        |
| `npm run review:obsidian`         | Official `eslint-plugin-obsidianmd` review           |
| `npm run review:local`            | Full review: obsidian + lint + audit + build + tests |
| `npm run format` / `format:check` | Prettier                                             |
| `npm run knip`                    | Unused code/exports                                  |
| `npm run test:unit`               | Vitest run (coverage: `npm run coverage`)            |
| `npm version patch`               | Bump + commit + tag + push (also `minor`/`major`)    |

## Conventions

- Strict TypeScript. Prefer `async/await`.
- Tests in `test/*.test.ts` use [obsidian-test-mocks](https://github.com/mnaoumov/obsidian-test-mocks) (auto-setup in `vitest.config.ts`).
- Conventional commits enforced by commitlint + husky hooks.
- `npm version` runs `version-bump.mjs` (updates `manifest.json` + `versions.json`), commits, tags with **no `v` prefix**, pushes. CI publishes on `*.*.*` tags. **Never tag manually.** `manifest.json` `id` must stay `abyss-tasks`.
- `docs/` is gitignored — local-only scratch space for plans/specs. **Never commit `docs/`.**

## Obsidian CLI

[Obsidian CLI](https://obsidian.md/help/cli) controls the running app from the terminal.

```shell
obsidian vault="dev-vault-tasks" plugin:reload id=abyss-tasks            # reload after rebuild
obsidian vault="dev-vault-tasks" eval code="app.vault.getFiles().length" # run JS in app
obsidian vault="dev-vault-tasks" devtools                                  # toggle dev tools
obsidian vault="dev-vault-tasks" dev:screenshot path=screenshot.png        # screenshot
obsidian vault="dev-vault-tasks" dev:dom selector=".abyss-panel-view" text # query DOM
```

Typical loop: `npm run dev` → `obsidian plugin:reload id=abyss-tasks`.

## References

- API docs: https://docs.obsidian.md
