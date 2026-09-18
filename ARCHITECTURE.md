# Architecture

Abyss Tasks manages Markdown tasks through an Obsidian sidebar and native `task-calendar` code
blocks. Markdown is the durable record. The plugin builds read models over the vault and writes
user changes through application commands.

This document describes the implemented architecture on `master`: ownership, sources of truth,
dependency direction, and critical data flows. Follow the source and test links for behavior details;
use CodeGraph to inspect current call paths. Proposed architecture belongs in an ignored design spec.

## System at a glance

```mermaid
flowchart LR
  Person[User] -->|interacts with| UI[Sidebar and code blocks]
  UI -->|reads through| Query[TaskQueryApi]
  Query -->|is implemented by| Index[TaskIndex]
  Index -->|reads and watches| Vault[Obsidian Markdown vault]
  Vault -->|emits file and metadata events| Index
  UI -->|sends TaskCommand values to| Commands[TaskApplicationApi]
  Commands -->|is implemented by| Service[TaskApplicationService]
  Service -->|calls| Port[TaskRepository port]
  Repository[ObsidianTaskRepository] -->|implements| Port
  Repository -->|writes Markdown through Obsidian| Vault
  Repository -->|installs committed content| Index
```

Queries return immutable snapshots. Commands validate fresh targets, perform writes, and return
structured outcomes. Successful writes enter the read model immediately; later Obsidian events
reconcile them through the same parsing path as manual edits.

## Sources of truth

| Concern                                              | Authoritative source                                                                     | Derived or temporary state                   |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------- | -------------------------------------------- |
| Tasks, metadata, and dependencies                    | Vault Markdown                                                                           | TaskIndex snapshots and calendar projections |
| Tracked time                                         | Vault Markdown time entry lines                                                          | TimeEntryIndex projection and tracked totals |
| Projects and status                                  | Project Markdown, membership query, configured status property, and literal status names | ProjectStore snapshots and task statistics   |
| Static preferences                                   | Plugin `data.json`                                                                       | Composed runtime CalendarSettings            |
| Saved list, section, and project views               | Versioned plugin `state.json`                                                            | Composed runtime CalendarSettings            |
| Navigation, selection, search, editors, and gestures | AppState or the owning view controller for the current session                           | Rendered DOM                                 |

`TaskIndex` and `ProjectStore` are rebuildable read models. `AppState` coordinates the interface;
it must not become a persistence layer. Saved view preferences and transient interaction state
remain separate even when one controller uses both.

## Boundaries and entry points

[`src/main.ts`](src/main.ts) is the task-system composition root and Obsidian lifecycle entry point.
It loads settings, creates the status catalog and task adapters, wires application capabilities,
registers views and commands, and starts and stops the index. Concrete Obsidian task adapters are
wired here; consumers receive interfaces instead of constructing alternate repositories or indexes.

| Boundary                                                  | Responsibility                                                                              | Dependency direction                                                     |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| [Task public API](src/tasks/index.ts)                     | Query, dependency query, commands, and capture planning                                     | Presentation imports this boundary                                       |
| [Task domain](src/tasks/domain/)                          | Immutable values, references, commands, status, recurrence, dates, and time                 | Domain and deterministic `rrule` boundary only                           |
| [Task application](src/tasks/application/)                | Resolve and validate use cases; coordinate repository and destination ports                 | Domain and application ports; no concrete infrastructure or presentation |
| [Task infrastructure](src/tasks/infrastructure/)          | Obsidian adapters, index, canonical codec, block editing, location, and reference authority | Application, domain, shared Markdown helpers, and Obsidian; no UI        |
| [Sidebar shell](src/views/PanelView.ts)                   | AppState, responsive panels, navigation, shortcuts, and collaborator lifetimes              | Public task capabilities                                                 |
| [Native code blocks](src/code-block/registerCodeBlock.ts) | Resolve block settings and mount CalendarRenderer                                           | Same query, command, and status capabilities as the sidebar              |

The public task capabilities are `TaskQueryApi`, `TaskDependencyQueryApi`, `TimeTrackingQueryApi`,
`TaskApplicationApi`, and `TaskCaptureApplicationApi`. Application queries supply all three query
capabilities; `TimeTrackingQueryApi` reaches the public barrel with its first presentation consumer.
Add exports only when another component needs them. Presentation must not edit task Markdown or import private task
layers. The domain must not import Obsidian, infrastructure, panels, or settings UI.

`PanelView` owns `RailPanel` for mode changes, `LeftPanel` for navigation, `CenterPanel` for selected
content, and `RightPanel` for the task inspector. Panels share transient navigation through
`AppState`. The native code block render child owns cleanup when Obsidian removes its block.

Navigation finishes the active project editor before changing mode. A rejected draft leaves the
current mode and projection intact. Inspector history stores structural task paths for its session;
only proven successor references survive writes, and history never becomes persisted task identity.

## Task commands and reconciliation

### Reads, writes, and identity

`TaskIndex` watches vault and metadata events and parses supported Markdown through the canonical
`TaskMarkdownCodec`. It exposes detached snapshots and reference resolution through public queries.
A nested line shaped as a start stamp followed by `→` is a time entry rather than a comment, and an
entry the parser cannot read stays visible on its task while counting nothing anywhere.
`TaskApplicationService` captures the relevant clock and behavior settings, resolves a command,
validates it, and delegates persistence through repository and destination ports.

The repository locates the current block, writes through Obsidian, and installs committed content
in the index before returning. Conflicts, invalid input, missing or ambiguous targets, partial moves,
and I/O failures are structured outcomes; the initiating presentation boundary reports failures.
The UI must not treat an earlier snapshot as continuing write authority.

`TaskRefAuthority` distinguishes even byte-identical occurrences without adding Markdown IDs. It
stages proven successor references and rejects ambiguous or externally changed targets. A successor
may preserve selection or retries, but does not grant general write authority.

Vault and metadata events reconcile external and plugin edits through the same index path.
`TaskIndexEvent.changed` identifies changed task projections. A separate reconciled-file signal
also covers accepted metadata events with unchanged tasks, including notes without tasks.
`ProjectStore` waits for these barriers before combining frontmatter with matching task statistics.

Task creation freezes its capture context before `TaskCaptureApplicationApi` plans a destination.
The provider resolves today's note or the configured file; project capture uses the selected note
and project insertion policy. Overview capture follows the active Table, Kanban, or Timeline
selection. Creation then uses the same application/repository path and reveals the indexed result
without inventing another persisted identity.

### Time tracking

Entry lines under a task are the record of tracked work; no session state is persisted anywhere
else. `TimeTrackingService` owns `start-tracking` and `stop-tracking`, which carry no single root
and never reach the rooted command path. It enforces one active timer by serialized sequential
writes on the mutation queue it shares with dependency operations: every running entry is closed
first, then the new entry is opened. Each step re-reads its node from the root the previous write
returned rather than waiting for the index. A hand-written entry the plugin cannot close, such as
one whose start lies ahead of the clock, is reported to diagnostics and left alone so a single
unwritable line cannot disable tracking vault wide; only an I/O failure stops the operation and
returns its structured result. A session shorter than a minute leaves no line at all, and the
outcome says so. Starting on a node that is already tracking writes nothing to that node, and a
done or cancelled node is refused.

Presentation reads those lines through one tick per owning surface. `PanelView` and `TaskModal`
each build a `TrackingTicker` and a `TrackingActions` write boundary and hand them on, together
with the device wall clock every label is read against; `PanelView` hands its one surface to both
the `CenterPanel` and the `RightPanel` it hosts, so the whole panel shares a single tick. The ticker
re-reads the active entries only when the index reports a change and runs its one-second interval
only while something is running and a surface is listening. The inspector badge keeps the total it
read at that change, so a tick is one addition and never a query, and it writes to the DOM only
when the formatted text differs. The tick it emits for an index change belongs to the owner's own
render instead, which re-reads the selection, so a surface recognises that frame by the active
entries it carries and paints a change exactly once. The badge outlives one inspector render: the chips row is rebuilt
on every index change, while the sessions popover the badge owns has to survive the write it just
made, the way the inline undo row already does. An entry rewrites the source block of the node it
sits under, so a selected sub-task has no text left to match itself by. `rebuildTaskSelection`
follows it by child position instead, but only where the domain proves the two generations of the
root differ in nothing but their tracked entries, which covers every surface that starts or pauses
a timer rather than only the inspector's own writes.

The other tracking surfaces are passive. A list card carries a count badge with its subtree total,
and while that subtree runs the card keeps the total it read so the panel's one subscription
repaints only the running roots, found by the `data-tracking-root` address the badge carries. A
calendar card reads the same snapshot for a running marker and subscribes to nothing. Starting and
pausing are offered wherever a node already has a context menu, and the `toggle-time-tracking`
command pauses whatever runs or resumes the most recently tracked task of the last seven days. The
code-block calendar keeps only the marker, because its card body right-click already belongs to the
recurrence editor and its start and pause controls live in the task modal's badge instead.

The rail widget is the one live surface outside the inspector. `RailPanel` creates its host element
once and re-places it on each mode change, so the widget survives navigation, and `PanelView` mounts
it there on the ticker and write boundary the panels already share. It regroups the seven-day window
only when the index reports a change and at one scheduled local midnight; a tick adds the open
timer's own elapsed time to the two totals already in hand and never asks the index anything. The
tracked-task list it opens beside the rail reads that same grouping, so a day's rows always add up
to its heading and today's heading to the widget's own total. The grouping gives an open timer a row
on the day that holds it from the instant it is opened, before it has earned a millisecond, so the
list never lags the widget by an index event. Opening a task from either switches to
Tasks mode and makes the node the inspector selection, which is what opens the details pane at a
compact width.

Completing or cancelling a node closes the entries still running in its subtree as a follow-up
write with the same clock reading, inside the same serialized mutation. That write never changes
the status command's own result; a failure goes to the diagnostics sink and leaves the running
entry visible for repair. Recurrence completion closes entries in the completed occurrence, and the
cloned next occurrence starts with none. The index only reads: a status symbol edited by hand in a
note closes nothing.

### Dependencies

Dependency IDs and ordered prerequisites use the Tasks-compatible `🆔` and `⛔` Markdown carriers.
`TaskIndex` derives direct and inverse relations over persisted roots and subtasks, excluding
recurrence forecasts. Direct relations follow declared ID order; inverse relations follow canonical
source order. Duplicate declarations collapse only in the projection.

`TaskDependencyService` owns dependency commands, linked subtask creation, and completion checks.
Queries preview eligibility; application commands validate it again. The live status catalog defines
active blockers. Missing IDs remain visible for repair without blocking completion; ambiguous IDs
block if any matching task is active. Authored cycles remain readable, but new cyclic edges fail.
Completion rechecks blockers before the first write and a reconciled retry; unproven identity or
blocker state returns a conflict.

Dependency changes share a mutation coordinator across service instances. Same-file metadata
changes are batched. A cross-file add writes the blocker ID before the dependent edge; failure of
the second write leaves the ID in place and reports failure. Same-file reversal is atomic;
cross-file reversal publishes only after final proof, or attempts compensation against exact owned
source. Unproven recovery reports unknown content state and reconciles from the vault.

Linked subtask creation writes the child and its edge in one root operation. Application code owns
eligibility and ID allocation; the repository owns placement and validates the resulting tree.
Removal returns exact transient recovery data for a local inspector Undo, valid only while the
committed result still owns the source. Undo data stays out of AppState and Markdown.

Task cards, subtasks, and relation rows share a transient dependency drag payload. Dependency drops
change edges through public commands; existing tag, project, and subtask reorder drops keep their
own source rules. Calendar and sidebar views share dependency/status presentation and completion
blocking. See [dependency reversal tests](test/task-dependency-reversal.test.ts) and
[linked subtask tests](test/task-create-dependency-subtask.test.ts).

## Projects

### Discovery and field authority

[`src/projects/`](src/projects/) treats qualifying Markdown notes as projects. `ProjectStore`
evaluates membership against paths, tags, and frontmatter, combines task snapshots into statistics,
and updates from vault and task-index events. It adds no persisted cache.

[ProjectManager](src/projects/ProjectManager.ts) creates notes, edits project frontmatter, and moves
tasks through `TaskApplicationApi`. Membership comes from the configured query. Status uses one configured
frontmatter property and literal status-definition names; project tags do not carry status.

`projectFields` owns case-insensitive field lookup and the shared catalog. Status, start, and end
have configured source properties; description uses `description`. Name comes from the filename,
and progress is derived from completed top-level tasks over non-cancelled top-level tasks. Time is
derived the same way from the note's own time entries: `ProjectStore` asks the time entry index for
the file total whenever it re-evaluates that note, so a project never walks entries itself. Both
derived fields are read-only wherever a field can be written, and Time ships as a curated column
that is present but hidden, so a table only widens when a reader asks for it. Normalization appends
any curated column missing from saved Table state as a hidden entry, so an older `state.json` loads
unchanged and a new curated column costs a reader nothing until they turn it on.
Curated types are fixed. Custom types and preset presentation in `projects.propertyDefinitions`
remain authoritative when Obsidian's registry changes or is unavailable. A custom definition whose
source is assigned to a curated role stays saved but inactive until that role moves away.

Malformed, ambiguous, unconfigured, or unsupported custom sources remain visible but unavailable.
Curated source collisions preserve metadata and spelling while making the roles read-only. The
native property adapter discovers and suggests values/types; it never writes Obsidian's registry.
`projectPropertyPresets` supplies shared typed identity, validation, and presentation to settings,
projections, and editors. See [field tests](test/project-fields.test.ts) and
[property-definition tests](test/project-property-definitions.test.ts).

### Shared projections and retained views

`projectTableModel` is the DOM-free source of search, typed sorting, status filtering, grouping,
and unique visible counts. Link groups use resolved note paths as identity while retaining raw
values and source paths for rendering and edits; external targets keep source-independent identity.
A render pass reads one clock and hands it to the model, so every running timer is sorted, grouped,
searched, and labelled at the same instant and nothing in a table ticks on its own.
Kanban and Timeline models reuse this projection. Their settings modules own independent saved
presentation and organization, initialized from Table only when first requested.

`ProjectsPanel` owns a long-lived [overview controller](src/panels/projects/ProjectsTableView.ts) and
property-catalog subscription. The controller shares the toolbar, field renderer, editor boundary, mutation queues,
receipt projection, and history across Table, Kanban, and Timeline. Each surface retains its own
search, selection, organization, and viewport. Switching hides inactive surfaces instead of
rebuilding them. A dashboard temporarily detaches the overview and invalidates Timeline interaction
authority; reattachment preserves the session but cannot revive an old queued gesture.

Table owns a full expanded logical row/cell projection for selection, keyboard navigation, and
clipboard commands, independently of mounted DOM. Its local `projectTableViewport` owns measured
and estimated row offsets, bounded windows, and spacer geometry. Scroll reconciliation reuses the
retained model; data and group changes replace that sequence and clamp the viewport immediately.
Group metadata remains available outside the window. Editors and native drag sources pin their
occurrence rows until the interaction finishes; other evicted rows release listeners and Markdown
components. Table geometry, resize, scroll, and focus use the host's owning document and window.

The [viewport helper](src/panels/projects/projectTableViewport.ts) contains geometry only: ordered
occurrence/header keys, measured heights, cumulative offsets, binary range lookup, and pinned-row
segments. It keeps one range with 170px overscan and consumes that buffer before refilling it.
Replacing the row sequence or accepting changed measurements invalidates the range; a viewport
height change also forces recalculation. Measurements preserve the current row anchor, and the
controller bounds measurement correction to two passes. Mounted rows stay bounded; full-collection
sorting, grouping, counts, and logical cell projection still scale with the collection.

DOM identity alone does not preserve native focus: detaching and reinserting a retained row can
blur its editor. Table reuses keyed spacer rows, patches only changed geometry, and removes obsolete
spacers before ordering retained rows. Selection consumers, including Quick Capture, resolve logical
cells rather than requiring mounted elements. Row mounting is needed only for rendering, focus,
editing, and pointer interaction. These interaction rules belong to the controller, not the geometry
helper; windowing alone is not a complete reusable view implementation.

Regression entry points are [viewport geometry tests](test/project-table-viewport.test.ts) and
[table interaction tests](test/project-table-view.test.ts). They cover buffer boundaries, group
expansion/collapse, shrinking results, changed heights, offscreen bulk selection and Quick Capture,
and retained editor/drag rows. Native validation additionally checks visible coverage after large
jumps and group expansion, focus, and style/layout cost: a bounded DOM does not guarantee uniformly
cheap buffer refills under every vault theme and plugin combination.

Table rows, Kanban cards, and Timeline ranges reconcile keyed DOM. Surviving listeners read current
reconciled contexts. Shared `ViewOptionsPopover`, field menus, cell renderers, commands, and
selection paths preserve one interaction model. Editors retain drafts on failure and route explicit
assignments through the controller. Navigation and view changes use the same editor-completion
boundary. Transient selection distinguishes grouped occurrences; mutations deduplicate physical
cells. Clipboard payloads preserve raw types and source context, rebase links, and carry no write or
history capabilities.

Kanban manual path ranks are saved view state. Filtering or sorting does not discard hidden ranks.
`projectKanbanDrop` revalidates captured source capabilities and current target/group meaning inside
the shared mutation queue, batches metadata assignments, and updates manual rank only after success.
Native drag presentation owns payload and cleanup, not metadata or settings writes.

Timeline separates pure `projectTimelineModel`,
[projectTimelineAxis](src/projects/projectTimelineAxis.ts), and `projectTimelineEdits` from native
`projectTimelineInteraction` and `ProjectsTimelineView`. Calendar geometry uses inclusive
day ordinals. The axis generates only the visible slice plus overscan; a browser-safe physical width
cap never changes logical mapping. Minimum bar/handle presentation does not alter edit geometry.
Direct and options scale changes share the guarded controller path and fit valid filtered bounds;
Today and navigation preserve the selected scale.

Timeline interaction emits frozen pointer intents or relative keyboard intents and never writes
Markdown or records history. Preview tokens remain tied to their captured source until authoritative
receipt projection arrives. Rejection, source replacement, supersession, hiding, or destruction
clears the preview; an older settlement cannot alter a newer one. Scroll/resize patches only visible
axis and grid nodes, preserving range nodes and focus. The view owns occurrence visibility:
collapsed or detached occurrences cannot capture queued commands or retain gestures/previews.
See [Timeline interaction tests](test/project-timeline-interaction.test.ts),
[Timeline axis tests](test/project-timeline-axis.test.ts), and
[overview view tests](test/projects-views.test.ts).

### Mutation ordering, receipts, and history

Three coordination scopes remain distinct. The overview orders submitted actions, then serializes
session metadata mutations together with history recording. `ProjectManager` separately serializes
metadata operations per App across panel and settings manager instances. Timeline waits for one
active-editor attempt outside the metadata queue, so correction/retry can persist without waiting
behind the range command. A failed editor attempt cancels that command.

Pointer ranges freeze occurrence, path, field binding, exact source key, raw value, existence, and
projected range; a mismatch rejects the command. Keyboard ranges freeze binding but apply relative
changes to the latest receipt projection at their queue turn. Range edits send both endpoints in
one batch, retaining the unchanged endpoint as an exact companion guard. No-op plans skip writes
and history.

`ProjectManager.applyEdits()` preflights the batch, then rechecks current source/type binding, exact
key, existence, and expected value inside each note's `Vault.process` transaction. Combined final
date values must form a valid range. Partial multi-file failure returns exact applied and failed
receipts. Status and description edits use this same path; status input becomes a configured literal
name. Failures propagate to the initiating presentation boundary.

Successful receipts enter the session projection immediately. Ordinary store/settings/task refreshes
do not retire them. Only verified per-path source observations acknowledge or supersede receipts;
observations received during a write are revalidated after receipt installation. An old observation
or async check cannot retire a newer receipt. Delete, rename, and membership loss retire affected
paths without allowing an overlay to resurrect them. Store/catalog refreshes defer during the
coordinated mutation and reconcile afterward.

`ProjectEditHistory` stores bounded session-only receipt groups. Undo/Redo use the same batch path
with exact expected values, key spelling, and presence provenance, preserving owned unknown/empty
values without overwriting external edits or rebound properties. A cleared inferred custom property
may retain cell-bound restore/refill authority derived from actual receipts. Supersession, refill,
eviction, discard, or session end removes it; it grants neither general absent-property authority
nor native type writes. See [manager tests](test/project-manager.test.ts),
[history tests](test/projectEditHistory.test.ts), and [store-event tests](test/project-store-events.test.ts).

### Creation and status renames

Overview project creation belongs to its retained session. The composer freezes a configured
status; `ProjectManager` validates its writable source before creating a note through
`DailyNoteResolver`, awaits Templater, and applies final status through serialized metadata mutation.
`ProjectStore` publication owns the visible snapshot. The overview matches the owned path/status,
relaxes obstructing filters, and reuses selection/reveal.

`ProjectCreationError` identifies the owned path and failed phase. Status recovery writes only that
file. Template recovery offers the owned note and requires a fresh draft before another create;
collision or retry must not silently duplicate a project.

Status-definition renames share per-App metadata serialization with assignments and batches. A
rename rechecks role, membership, and expected literal against fresh source, tracks owned note edits,
and persists the definition. Failure restores the definition and compensates only values still
owned by the operation. Unresolved paths reach one settings failure boundary. Recovery across files
and settings is best effort, not crash-atomic. See [rename tests](test/projectStatusRename.test.ts)
and [creation presentation tests](test/project-creation-presentation.test.ts).

## Settings and compatibility

[`SettingsPersistenceCoordinator`](src/settings/persistence.ts) serializes two documents through
Obsidian's public vault adapter. `data.json` owns static configuration; adjacent versioned
`state.json` owns list/section state and project Table, Kanban, Timeline, and active-view preferences.
One composed `CalendarSettings` object remains the runtime authority. Panels do not receive separate
settings copies.

Migration captures untouched legacy data, writes and verifies the versioned state envelope with an
exact recovery snapshot, then removes moved static keys. Recognized state wins when both copies
exist. Corrupt, unreadable, or future-version state stays untouched: view writes suspend and runtime
uses temporary defaults. Static saves preserve unmarked legacy view fields until recovery is
verified. Unknown static/nested view values survive; detached write snapshots queue in order,
unchanged writes deduplicate, and rejection does not stop later operations.

Static and view-state saves use separate callbacks. Static durability advances the rollback revision
and refreshes project settings; view-state writes do neither and narrowly refresh the existing view
controller when needed. Task-status changes rebuild the catalog, registry, and index interpretation
together. ProjectStore rescans only for membership/status inputs; presentation changes reuse its
snapshots and update retained views.

Initial custom-property type capture fills only missing static definitions, before view registration,
with bounded metadata/layout follow-ups. Failed saves retain the current draft for Retry, including
later user edits. Settings UI lifecycles preserve active drafts across rebuilds and dispose listeners.
Legacy project status migration preserves recoverable conflicts and requires explicit source
selection or discard; loading never rewrites vault notes. Any persisted-contract change needs a
compatibility/migration design. See [persistence tests](test/settings-persistence.test.ts).

Two compatibility boundaries remain explicit:

- [`src/parser/`](src/parser/) adapts canonical task data to legacy presentation. It may use codec
  internals for that conversion; new task behavior belongs in `src/tasks/`.
- `window.renderCalendar` is the legacy Dataview bridge installed and removed by `src/main.ts`.
  Native `task-calendar` code blocks are the maintained integration.

## Changes and verification

[`dependency-cruiser.config.cjs`](dependency-cruiser.config.cjs) defines exact import restrictions;
[test/dependency-rules.test.ts](test/dependency-rules.test.ts) checks them. Fix violations at their
source instead of weakening boundaries. New views reuse established commands, menus, state
semantics, and UI primitives.

Update this document in the implementing commit when ownership, a public boundary, dependency
direction, a critical data flow, persisted authority/migration, or a compatibility seam changes.
Private renames, local helpers, and styling do not require architecture prose. Record any necessary
boundary exception with its reason, narrow scope, and automated check.

```shell
pnpm arch
pnpm verify
```

The repository gate covers architecture, formatting, lint, types, coverage, artifacts, release
metadata, and dependency health. UI changes also require native `dev-vault-tasks` interaction,
screenshots, DOM evidence, and captured runtime errors, including constrained widths for layout
changes. Follow [AGENTS.md](AGENTS.md) for the development-vault and integration workflow.
