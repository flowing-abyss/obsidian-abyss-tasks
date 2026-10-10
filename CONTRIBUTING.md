# Contributing

Issues and pull requests are welcome. For a bug report, include your Obsidian and plugin
versions, the steps to reproduce it, and a small Markdown example. Remove personal
information from notes and screenshots before sharing them.

Discuss larger changes in an issue first so we can agree on the workflow and scope.

## Getting set up

Use Node.js and pnpm versions matching `engines` in `package.json`.

```sh
pnpm install
pnpm dev
```

Copy `main.js`, `manifest.json` and `styles.css` into
`.obsidian/plugins/abyss-tasks/` in a test vault, then enable the plugin. `pnpm dev`
rebuilds on save. After each rebuild, copy the updated files into the test vault and
reload the plugin to try your changes.

## Before opening a pull request

```sh
pnpm verify
```

This is the same quality gate used by CI and the pre-push hook. Use `pnpm verify:task`
for faster checks while working, then run the full gate before submitting.

Add tests for behavior changes. Exercise UI changes in `dev-vault-tasks`, inspect the
result at desktop and narrow widths, and check for runtime errors. Restore any vault
content changed by the test.

Follow [Conventional Commits](https://www.conventionalcommits.org) for commits and pull
request titles, such as `fix: preserve task order` or `docs: clarify quick capture`.
Keep each pull request focused on one change.

Read [Architecture](ARCHITECTURE.md) before changing ownership or data flow. Reuse
existing task operations and UI controls, and keep local plans under the ignored
`docs/` directory.
