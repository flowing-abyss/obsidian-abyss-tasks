# Abyss Tasks

A task management interface for Markdown tasks in Obsidian.

The plugin is currently distributed as part of the [Flowing Abyss vault](https://flowing-abyss.com/Description-of-Obsidian-Vault).
Documentation and a wider public release will follow after the initial testing period.

Saved view preferences now use `state.json` schema 2, including tag exclusions. Existing schema-1
and legacy preferences remain readable; the next saved-view change upgrades the state without
changing task notes or resetting customized views. If you return to an older plugin binary, it
reports the unsupported schema, temporarily uses default saved views, and suspends state writes.
Re-upgrading restores your schema-2 preferences. To recover your earlier saved views while staying
on the older binary, restore a pre-upgrade state backup; there is no automatic lossy downgrade.
