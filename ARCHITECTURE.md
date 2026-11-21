# Architecture

Abyss Tasks reads Markdown tasks from an Obsidian vault and presents them in lists, a calendar,
project views, and Analysis. Clicking a checkbox in the inspector and approving a task edit in
Command mode both use the task application service. Editing the note directly updates the same index.

## Task reads and writes

[main.ts](src/main.ts) builds the task index, repository, and application service. It gives each
view the queries and commands it needs through the [internal task API](src/tasks/index.ts).
The task domain defines values and rules. The application layer implements use cases against
ports. Infrastructure connects those ports to Obsidian. Presentation code imports the task API
and leaves Markdown editing to the writers.

1. **Read.** [TaskIndex](src/tasks/infrastructure/TaskIndex.ts) observes vault and metadata
   changes. It parses task trees with the [Markdown codec](src/tasks/infrastructure/markdown/TaskMarkdownCodec.ts)
   and exposes snapshots of the sources allowed by the current settings.
2. **Edit.** A view submits a command with a reference to the selected task or subtask.
   [TaskApplicationService](src/tasks/application/TaskApplicationService.ts) applies the task
   rules, including status, recurrence, dependencies, and time tracking. Edits that need a
   preview can prepare a candidate against the current source before committing.
3. **Commit.** [ObsidianTaskRepository](src/tasks/infrastructure/obsidian/ObsidianTaskRepository.ts)
   serializes writes per file, checks the source against the expected revision, and installs
   committed content in the index. Views then read the accepted result. A title or line number
   can locate a candidate. Continuing an edit after the source changes requires proof that the
   reference still identifies the same occurrence.

Moves and archives across files write the destination before removing the source. If removal
fails, the repository reports the partial transfer. Project metadata,
prepared note sections, note creation, and vault-wide tag renames have their own writers.
The [storage authority roster](test/architecture/storageAuthority.ts) names each owner and the
Obsidian operations it can use.

## Where state lives

| Data                                                     | Owner                                                                                                                                                                                                                                                      |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Task trees, comments, dependencies, tracked time         | Vault Markdown. The index and totals can be rebuilt from it.                                                                                                                                                                                               |
| Project membership and fields                            | Project notes and configured membership rules. ProjectStore derives the list of projects and their statistics.                                                                                                                                             |
| Preferences and saved views                              | The [settings coordinator](src/settings/persistence.ts) combines static preferences in `data.json` with versioned view preferences in `state.json`. It preserves unknown fields and suspends view-state writes if the stored format cannot be read safely. |
| Current navigation, task selection, and inspector drafts | The view's [AppState](src/app/AppState.ts) and the controller that owns the interaction.                                                                                                                                                                   |
| Command conversations, proposals, and write journal      | [CommandSessionStore](src/ai/CommandSessionStore.ts) keeps session files under the plugin directory for history and recovery.                                                                                                                              |
| Provider credentials                                     | Obsidian SecretStorage. Plugin settings hold the selected connections and secret identifiers.                                                                                                                                                              |

## Views and derived data

[PanelView](src/views/PanelView.ts) owns the sidebar, its state, and the lifetime of its panels.
The rail switches modes. The left panel handles navigation. The center panel hosts the task
collection, calendar, project, and Analysis surfaces. The right panel owns the task inspector,
including edits, drafts, and undo. [TaskModal](src/ui/TaskModal.ts) reuses that inspector with
its own selection. Task cards and the inspector capture the node the user acted on so a later
selection change cannot redirect that action.

- **Search** reads an index feed through [TaskSearchService](src/tasks/infrastructure/search/TaskSearchService.ts).
  The service returns compact matches. Views request current task snapshots for the rows they
  display and discard stale matches.
- **Calendar** [projects recurring tasks](src/views/calendarOccurrences.ts) onto future dates.
  A forecast has no saved occurrence of its own. Editing the series targets its source task.
- **Projects** use [ProjectStore](src/projects/ProjectStore.ts) to derive membership from paths,
  tags, and frontmatter. [ProjectManager](src/projects/ProjectManager.ts) creates project notes
  and writes their metadata. Moving a task between projects uses the task application service.
- **Analysis** subscribes to a [statistics projection](src/tasks/infrastructure/TaskStatisticsProjection.ts)
  while it needs data. That projection can include permitted archive records without adding them
  to ordinary task lists. It reports gaps in coverage alongside the totals.

## Command mode and integrations

External plugins open a versioned client with `getApi(1, { consumerId })`. Command mode uses the
same [provider](src/integrations/TaskApiProvider.ts) for task, project, and note operations.
Clients receive opaque targets and revisions. A prepared change refers to the version the client
reviewed. After a provider reload, consumers resolve targets again. Calling `client.dispose()`
releases subscriptions and pending reads.
[Public API guide](API.md) · [TypeScript contract](api.d.ts)

The first use of Command mode opens a [session owner](src/ai/CommandSessionOwner.ts) shared by
the plugin's panels and popouts. Adding a task from a menu checks its native reference, adds the
verified task to the session, and opens the composer. The model runs when the user submits a
command. It receives the working selection and bounded session context. Before admitting web
research, the agent checks the current request and recent user messages for permission. Notes
and web pages supply evidence only. Write approval comes from the user.

The [command agent](src/ai/CommandAgent.ts) calls tools to read current data and prepare a
proposal. The user can review it in the panel and confirm that revision. A request to save
through the model also requires a check of what the user authorized. The
[write coordinator](src/ai/commandWrites.ts) journals an operation before dispatch and checks
the receipt and resulting state before reporting it saved. If a write may have taken effect,
the session keeps the evidence for recovery. [Command evaluation guide](COMMAND_EVALUATION.md)

Model, voice, and web research connections are configured separately. The desktop ChatGPT
subscription connection uses its own sign-in. [Provider adapters](src/ai/providers/) use the
selected connection for each role. Research distinguishes search excerpts from page content
retrieved through a provider that supports reading URLs.

## Checking boundaries

[Dependency rules](dependency-cruiser.config.cjs) and [architecture tests](test/architecture-boundaries.test.ts)
enforce import direction. The [settings ownership roster](test/architecture/settingsOwnership.ts)
classifies persisted keys. Run `pnpm verify` for the full gate. The [contributor instructions](AGENTS.md)
cover writable UI checks in the test vault and the [performance guide](PERFORMANCE.md) covers profiling.
