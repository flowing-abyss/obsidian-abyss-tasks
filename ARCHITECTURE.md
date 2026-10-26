# Architecture

Abyss Tasks manages Markdown tasks through an Obsidian sidebar, with task lists, a calendar,
project views, and Analysis. Markdown is the durable record. The plugin builds read models over
the vault and writes user changes through application commands.

This document describes implemented ownership, sources of truth, dependency direction, and the
contracts that changes must preserve. Source links lead to algorithms and local behavior. Proposed
architecture belongs in an ignored design spec.

## System at a glance

```mermaid
flowchart LR
  Person[User] -->|interacts with| UI[Sidebar]
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

Queries return detached, immutable snapshots. Commands validate current source, perform writes,
and return structured outcomes. Successful writes enter the read model before the command returns;
later vault and metadata events reconcile through the same parsing path as manual edits.

Task text inputs share [WikiLinkSuggest](src/ui/WikiLinkSuggest.ts). Quick and inline capture,
inspector titles and descriptions, subtask entry, and new or edited comments own a disposable
controller for their exact input lifetime. Completion changes the draft through the field's input
event; existing capture and inspector commands still own persistence. Portal clicks belong to the
same interaction boundary, and accepting a suggestion consumes Enter before the editor can save.

The file source in [NoteSuggest](src/ui/NoteSuggest.ts) has a separate inline-link mode using
Obsidian's fuzzy search, aliases, and link formatting. Optional host configuration and supported-file
capabilities stay at that boundary. Excluded files are absent from an empty query and downranked
when matching text is entered. The existing note picker keeps its own filtering contract. The
controller validates the draft, source destination, and candidate again before inserting.

The shared anchored popover accepts measured text and viewport rectangles. A temporary mirror
measures the opening brackets, falling back to the visible caret in a scrolled field. The menu lives
in the input's document, shifts horizontally, flips vertically, and scrolls within the visible window.
Native text insertion preserves Undo where the host supports the legacy editing command; otherwise
range replacement preserves the draft and caret. Closing the editor releases its popup and listeners.

## Sources of truth

| Concern                                                 | Authoritative source                                         | Derived or temporary state            |
| ------------------------------------------------------- | ------------------------------------------------------------ | ------------------------------------- |
| Tasks, planning, comments, recurrence, and dependencies | Vault Markdown                                               | TaskIndex snapshots and projections   |
| Tracked time                                            | Markdown time entry lines                                    | TimeEntryIndex and totals             |
| Project membership and fields                           | Project Markdown and configured membership/field definitions | ProjectStore snapshots and statistics |
| Static preferences                                      | Plugin `data.json`                                           | Composed runtime CalendarSettings     |
| Saved list, section, and project views                  | Versioned plugin `state.json`                                | Composed runtime CalendarSettings     |
| Navigation, selection, search, drafts, and gestures     | AppState or the owning controller for the session            | Rendered DOM                          |

`TaskIndex` and `ProjectStore` are rebuildable. `AppState` coordinates the interface and does not
persist it. Saved preferences remain separate from transient interaction state. CalendarMode owns
its date and view type; StatisticsMode owns Analysis choices for its session.

## Dependency and write boundaries

[`src/main.ts`](src/main.ts) is the task-system composition root and Obsidian lifecycle entry point.
It loads settings, builds the status catalog and concrete task adapters, injects capabilities,
registers views and commands, and starts and stops plugin services. Consumers do not construct
alternate task repositories, indexes, or Search services.

| Boundary                                         | Responsibility and dependencies                                                                                                                                 |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Task public API](src/tasks/index.ts)            | Presentation's entry point for task queries, commands, capture, Search, Statistics sources, and task values                                                     |
| [Task domain](src/tasks/domain/)                 | Immutable values, identity, validation, status, recurrence, dates, and time; depends on itself, deterministic `rrule`, and shared tag syntax                    |
| [Task application](src/tasks/application/)       | Use cases and validation through domain contracts and application ports; no Obsidian or presentation imports                                                    |
| [Task infrastructure](src/tasks/infrastructure/) | Obsidian adapters, index, codec, source editing, and reference authority; depends inward, with explicit host, Markdown, scheduler, and search-engine boundaries |
| [Shared Markdown](src/markdown/)                 | Source syntax and display/search parsing; imports no task layer                                                                                                 |
| [Presentation](src/panels/)                      | Views and interactions over public capabilities; no task Markdown writer                                                                                        |

[`TaskApplicationApi`](src/tasks/application/TaskApplicationApi.ts) exposes commands and composed
query capabilities. [`TaskSearchApi`](src/tasks/application/TaskSearchApi.ts) separates shared
retrieval from canonical organization and exact hydration. Statistics has a separate retained-source
capability. Infrastructure never imports UI. [`src/parser/`](src/parser/) is a legacy presentation
adapter with a narrow codec-import exception; new task behavior belongs in `src/tasks/`.

Text writes have named owners: `ObsidianTaskRepository` for task transactions, `ProjectManager`
for project metadata, `NoteTemplateService` for note preparation, and `TagManager` for global tag
renames. Settings writes use composition-root ports. The exact file/owner/API authorizations and
the reasons for exceptions live in [`storageAuthority.ts`](test/architecture/storageAuthority.ts).
Passing data to a renderer or deriving a projection grants no write authority.

## Task source and command flow

### Parsing, identity, and reconciliation

[`TaskIndex`](src/tasks/infrastructure/TaskIndex.ts) discovers tasks from Markdown, including
Obsidian comment blocks and excluding frontmatter and fenced examples. Host list-item metadata
enriches discovery; omissions do not remove source tasks. The canonical
[`TaskMarkdownCodec`](src/tasks/infrastructure/markdown/TaskMarkdownCodec.ts) parses them. Source
exclusions apply to paths, tags, and frontmatter before public projections and reconciliation
transitions; excluded content remains available for repository proof. Each accepted observation
prepares authored frontmatter and canonical body tags once for exclusion and Statistics policy.
Host-cache frontmatter remains the presentation authority, with authored frontmatter as its fallback.
Snapshot projection reuses the successful canonical root parse; rejected candidates receive no
root reference allocation.

Existing Markdown retains authored list markers, indentation, quotes, line endings, and unrelated
content. Creation has its own formatting policy. Comments, subtree bounds, source transfer, and
link editing share canonical source readers: an edit must identify the actual authored block or
occurrence. Rendered labels, joined text, and matching destination names cannot authorize a write.
Timing normalization applies to creation and explicit timing edits; reads, unrelated edits, and
transfers preserve legacy values. The domain's duration rule keeps edited durations within the day.

[`TaskRefAuthority`](src/tasks/infrastructure/TaskRefAuthority.ts) distinguishes occurrences and
records proven successors without adding identity fields to Markdown. Every write needs a fresh,
unambiguous source match. An old snapshot, equal Markdown, file/line position, or a successor used
for selection is insufficient by itself. Root and descendant references retain their full ancestry;
a child projection never becomes an independent root write target.

The repository installs committed content immediately. A conflicting cache observation cannot
replace it until a fresh vault read confirms that observation. Accepted file reconciliation also
publishes a separate signal when tasks are unchanged or absent. `ProjectStore` waits for this
barrier before combining frontmatter and task statistics. A failing subscriber cannot prevent
later subscribers or the reconciliation signal from receiving an accepted change.

### Commands, creation, and transfers

Explicit root deletion may remove its now-empty source note only when the path matches the current
configured `taskFilePath`, including valid historical date expansions. Valid leading frontmatter and
whitespace alone count as empty; other body content or invalid configuration/frontmatter preserves
the note. Completion deletion, subtask deletion, transfers, and notes outside the current configured
path have no cleanup authority. No provenance metadata is added.

[`taskFileMutationQueue`](src/tasks/infrastructure/obsidian/taskFileMutationQueue.ts) orders repository
writes, publication, and cleanup per App and path. It covers repository transactions only; transfers
retain their source reservations and postconditions. Before `FileManager.trashFile`, the repository
requires fresh proof of unchanged content, file identity, and cleanup policy. External edits can
still race removal because Obsidian has no compare-and-trash API. Removal follows the host deletion
preference, including permanent deletion; neither Undo nor a downgrade guarantees recovery.
Cleanup failure adds `noteCleanupWarning` to the successful deletion outcome. Shared presentation
reports the warning without retrying or rolling back task deletion; diagnostics omit note text.

[`TaskApplicationService`](src/tasks/application/TaskApplicationService.ts) captures the clock and
behavior settings, resolves the command, validates it, and delegates persistence through ports.
Conflict, invalid input, missing or ambiguous targets, partial transfers, and I/O failure are
structured outcomes. The initiating presentation boundary reports them. Retries require the
operation's source proof and captured policy; they cannot silently acquire a different target.

Capture retains a session with its destination, date, template, insertion policy, and behavior
settings. Planning does not write. [`NoteTemplateService`](src/notes/NoteTemplateService.ts)
prepares the note at execution and coordinates concurrent preparation of the same path. Uncertain
preparation needs fresh proof before retry. The application owns root/subtask prefix, Inbox, and
tag policy; presentation supplies typed input. Prefix tags are fallback for a new task whose composed
root has no surviving authored or initial tag. Only canonical root tag tokens wholly supplied by
the prefix are omitted when specific tags survive; other prefix Markdown and later lines remain.
The persisted prefix stays unchanged, Inbox capture skips it, and subtasks retain their opt-in and
owning-root Inbox gate. Current source exclusions still apply when a retained session writes. A failed
creation must not silently duplicate a task or note.

Quick capture owns one transient task-input state. Its first meaningful edit or manual choice freezes
an explicit civil-time reference and the static `parseDatesInQuickCapture` preference until success.
The composition root injects the shared clock, offline English/Russian date recognizer and
`RecurrenceInputParser` through `TaskInputServices`; other capture controllers omit those capabilities.
One `RecurrenceTextInputParser` serves Q and the existing recurrence editors through PanelView,
CenterPanel, RightPanel and TaskModal. The Q smart preference controls extraction only; explicit
custom-rule editing keeps the injected parser available. The pure model owns raw text, occurrence
suppression, manual choices and source ranges. Q reads canonical source planning and recurrence
from its retained create session before projection, then previews the exact unprefixed final request under
the same policy. Chip removal and the single Restore action change metadata only; they preserve raw
text and native input history. The session's optional `inspectInputProtection(request)` proves source
ownership over the original request and frozen prefix before preflight. Composed Markdown atoms, quotes, comments, URLs and HTML
elements crossing that boundary keep the whole input literal for that revision. Manual choices retain
their explicit values while losing source-consumption authority. Only an absent capability permits
legacy behavior; acquired malformed or throwing proof uses the existing unavailable-preview boundary.
Exact inactive canonical occurrences are filtered before source
preflight and application tag policy. Final projection removes their union with fully represented
accepted natural ranges in original UTF-16 coordinates. Restore reverses only its own metadata deltas;
source changes and conflicting re-entry expire the offer. Metadata never creates an authored title.
The removal operation retains original source spans and body offsets. The projection can expose a
lowercase surviving word after an initially uppercase natural prefix only when every preceding
non-whitespace source character belongs to fully consumed natural ranges and the word is outside
protected Markdown and retained temporal candidates.
Inactive canonical/tag removals supply no such proof. The shared Q request builder applies a single
Unicode-letter uppercase mapping when it stays one code point; the neutral projected body and raw
input remain unchanged. Canonical preview and frozen submission/retry receive that same request.
Empty forms may expose manual choices without a valid creation preview.

CalendarMode supplies its displayed day or compact Month/Week selected day to the Q capture context;
CaptureTargetResolver freezes it as the initial due date. Full-width Week and Month retain the
clock-day fallback. Explicit input and manual choices take precedence, and natural-language recognition keeps its own clock reference.

The retained create session's optional `previewContext(request?)` reads known prefix, initial, and
resolver-seed metadata through the canonical validation, patch, and normalization stages. Its ready
result has the captured session day and metadata without a title or executable request. The regular
creation path retains its title and block checks. Q caches this context before mounting, without
acquiring the recognition reference or reading the recognition preference. `projectTaskInputContext`
uses the same source and manual-choice precedence with no natural candidates or reference; explicit
time alone cannot infer a day. A resolver seed keeps its transient ownership through metadata actions.
An authored input change expires that ownership, and equal bytes from Undo cannot reacquire it.

Valid creation previews and ready contexts carry an optional Inbox classification from the session's
frozen policy and final canonical tags. Central membership shares `isTaskInboxMember` while retaining
its cooperative exact-tag matching. An Inbox-intent Q caption represents that actual membership and
hides only its exact service tag. Other tags retain removal and Restore. Legacy previews without the
classification display their actual source and tags; unsupported context is optional. Unexpected
context or draft preview failures clear stale metadata and use one inline error with a constant,
sanitized diagnostic per phase and revision. Ordinary valid preview can recover without a new session.

`CaptureMetadataRow` and central task cards share tag and source-note content. Q resolves colors
directly from current configured groups through the shared matcher. Central navigation and group
discovery retain the effective groups and observed task catalog. PanelView injects the source-path display
policy and CenterPanel's shared date formatter and classifier through the Q coordinator and surface.
Generic file captions obey `shouldShowSourcePath`, including configured date-template destinations;
semantic Inbox and explicit project captions remain. The existing assistive destination description
tracks the visible caption. Q supplies its frozen recognition day when acquired, otherwise the ready
context day, then the existing display clock. Point-date badges reuse the central semantic classes, and the independent
clock follows the primary due, scheduled, then start date. `taskOccupiedDates` keeps interval date/time
content neutral, including equal start/due bounds. A draft retained across midnight may therefore
keep a different semantic color from a newly rendered central card, matching its frozen interpretation.
Q renders removable date, time, recurrence and tag metadata as whole-body buttons separated by
decorative dots. Recurrence follows time and precedes tags, using the final canonical preview metadata.
Primary activation dismisses metadata while retaining raw input; hover and keyboard focus strike only
the label. Date contextmenu and Shift+F10 open the shared picker. Destination captions remain passive,
and ambiguity opens the existing choice menu with an explicit Ignore date suggestions action.
Q's `CaptureInteractionBoundary` owns the mounted
input, row, native menus and picker roots in their document. Explicit Enter and proven exit share one
settlement path: picker drafts, raw input and recognition, then one submit. Invalid picker drafts block
submission with inline feedback. Ordinary typing coalesces for 24 ms; Enter and exit flush synchronously.
Composition stages raw against one immutable precomposition mapping baseline and settles after the
final input event.
Window migration disposes surface listeners, timers and child drafts and remounts against the new
document while retaining the controller, create session, reference and pending submission.

Submission detaches and freezes the request, model and reference. A known unchanged write failure
retains that request for explicit Enter retry; edits keep the original reference and create a new
projection. Every write failure blocks blur retries. An unknown outcome remains latched across edits
until the user checks the destination and explicitly repeats, or closes the capture. Success resets
transient input state before result presentation, while retaining the destination session. Recognition
failures show sanitized feedback once per revision and preserve explicit choices; canonical preview
failure blocks writing. None of this state is persisted in task Markdown or saved view state.

Moves and archives prove the destination before removing the source. Archive batches share a frozen
date-expanded destination and return an archive-specific outcome because the destination is outside
ordinary queries. Recovery can remove or restore only exact content still owned by that operation;
identical text alone is insufficient. Multi-note operations are not crash-atomic and may report
partial or unknown content state, followed by reconciliation from the vault.

[`TaskHierarchyService`](src/tasks/application/TaskHierarchyService.ts) handles reparenting and
promotion with explicit source and destination preconditions. Same-note changes use one transaction;
cross-note changes write destination first and compensate only proven owned bytes on failure.
Transferred subtrees preserve metadata and rebase supported references inside the moved range.
Unprovable cross-note reference syntax is rejected. Inbound links outside that range remain
unchanged, so links to moved block IDs can become stale. Hierarchy outcomes, rather than line
coincidence, determine any selection handoff.

### Dependencies, recurrence, and tracking

Dependencies use Tasks-compatible `🆔` and `⛔` Markdown carriers on roots and subtasks. The index
derives the graph from persisted nodes and the current status catalog, excluding recurrence
forecasts. Graph readiness is shared, cancellable, and tied to the accepted source generation.
Query eligibility is advisory: [`TaskDependencyService`](src/tasks/application/TaskDependencyService.ts)
revalidates exact identity, graph constraints, and completion blockers at the write boundary.
Linked-child creation writes the child and edge together. Dependency mutations share serialization
across service instances; cross-file recovery remains limited to exact owned changes.

Nested time entry lines are the sole tracked-time record. Unreadable entries remain visible and
contribute nothing to totals. [`TimeTrackingService`](src/tasks/application/TimeTrackingService.ts)
shares the dependency mutation coordinator. Starting tracking closes other running entries before
opening the requested entry; failures can leave entries requiring repair. Completion or cancellation
closes the affected subtree's running entries in a serialized follow-up write with the same captured
clock. A failed follow-up is logged; the status change stays committed and unclosed entries remain
visible for repair. A recurring successor starts without the completed occurrence's entries.
Manual status edits trigger no writes.

`TaskIndex` updates `TimeEntryIndex` with task reconciliation. Each panel/modal tracking surface
shares a ticker and command boundary; ticking updates displayed totals without repeating queries.
Recurrence forecasts are derived, bounded, and carry no tracked time or direct mutation authority.
Edits resolve their persisted source through the existing calendar/application adapters.

The recurrence domain owns `recurrenceLabel`: Q, inspector chips, editor previews and shared
tooltips display the same canonical English rule and one terminal `when done`. Invalid stored rules
remain visible as authored. Custom editors use the optional recurrence input port, falling back to
`parseRecurrenceRule` when absent; presets and structured controls keep their domain builders.
Russian custom drafts retain their text and selection through passive refresh and draft transfer.
An intentional completion or mode change may rewrite a valid draft using its parsed English `raw`;
saves use that validated value through the existing patch command and English Markdown contract.
Unexpected custom-parser failures belong to the editor's inline validation boundary: stale preview
clears, Save disables, and a constant sanitized diagnostic logs once per distinct draft revision.
A valid subsequent edit recovers without changing the retained task target.

## Search and bounded read models

[`TaskSearchService`](src/tasks/infrastructure/search/TaskSearchService.ts) is one lazy,
plugin-owned service. Panels and dependency pickers own requests, cursors, and subscriptions.
Preparation and recovery are shared; cancelling one caller does not stop another caller's work.
Unload disposes Search before TaskIndex. Worker execution has an inline compatibility fallback and
bounded recovery; eligible user input may retry an unavailable service, while passive preparation
and timers do not create retry loops.

`TaskIndex` owns accepted source generations and compact exact addresses. Addresses identify a
particular file version and node ancestry; unchanged files can retain them across unrelated updates.
A global generation protects complete query/organization results. The separate `semanticsRevision`
invalidates classified snapshots when status rules change, even if text and addresses stay the same.
Exact hydration checks current addresses and returns detached roots and nodes in bounded batches;
it never guesses a child or uses write-reconciliation authority to revive a stale hit.

The inward [`MiniSearchTaskEngine`](src/tasks/infrastructure/search/MiniSearchTaskEngine.ts) is the
sole MiniSearch import boundary. The shared runtime publishes accepted replacements before starting
incremental maintenance. Further mutations wait for that maintenance before changing the engine or
invalidating publication and cursors; direct reads can use the published index during the wait.
Worker requests retain FIFO order, so reads behind a waiting mutation also wait. This can delay the
next search update by the remaining maintenance time. Disposal releases waiting mutations promptly,
and a maintenance failure makes the runtime unusable through the existing recovery boundary.
Shared [`searchMatchPolicy`](src/tasks/domain/searchMatchPolicy.ts) and
[`markdown/searchText`](src/markdown/searchText.ts) define matching and visible-text provenance.
Root Search can match fields across descendants and retains relevance order. Node requests default
to their own title and tags, including dependency search. Tasks Filter opts into subtree matching
across Search fields, with source paths still opt-in, then applies ordinary list membership, sort,
and grouping. Project Filter and Global Search retain root populations.

Descriptions share the pure [`taskDescriptionStructure`](src/markdown/taskDescriptionStructure.ts)
analysis for rendering and search projection. Display separators preserve list/prose boundaries
without rewriting the authored `- > ` payload or its whitespace. Obsidian remains the Markdown
renderer; link editing still requires complete field alignment and exact source occurrence proof.
Existing source needs no migration; a downgrade resumes the older whitespace and list display.

Search text and link destinations remain separate from source edit authority. The Worker exchanges
text documents and compact numeric results, never task refs, source-bearing revisions, or rich snapshots.

Retrieval, compact organization, and DOM mounting have separate lifetimes. Organization publishes
the complete logical order before mounting; hydration and Markdown rendering belong only to demanded
rows and finite interaction leases. Nonempty Tasks Filter retains outermost eligible exact nodes as
logical rows; nested matches remain context within those trees. Selection and bulk actions use the
retained bases without promoting an ineligible ancestor. Temporary reveal keeps its exact inspector
target separate from the scrolling card and includes the required ancestry without duplicate rows.
Contexts belong to the current publication and reveal path. Empty browsing and root Search keep
their populations. Mounted cards are bounded, though one matching tree may contain many context nodes.
Empty node browsing can use canonical source order without building the full-text index. Shared
service capacity bounds cursors; cancellation, source changes, and disposal retire obsolete work.
Cooperative batches yield to the owning window, but individual source projection and inline search
still contain synchronous work.

[`TaskSearch`](src/panels/center/TaskSearch.ts) joins retrieval, organization, dependency readiness,
and current mounted-row render receipts before completing a presentation. Native scrolling only
changes demanded rows. Source/semantic changes and later input prevent obsolete results or callbacks
from publishing. `SearchStatus` owns the mounted surface's accessible state and failure notice;
inward reads never create Notices. Diagnostics omit query text, task content, paths, and arbitrary
exception causes. Hidden preparation failures remain quiet until an active surface needs feedback.

[`TaskListStatusPublication`](src/panels/task-list/TaskListStatusPublication.ts) captures a list
status press or a Kanban card press before an inspector blur can save. It pins the row and holds Search presentation intake
through the native activation task, an opened status menu, a native Kanban drag, and accepted asynchronous commands.
Search and source queries remain live. Each publication must still resolve the captured root exactly
or through a repository-proven authority transition, with surviving descendants checked by the
existing exact selection/source continuity rules; external replacements, ambiguity, deletion,
semantic changes, navigation, cancellation, and owner loss revoke the hold. The original callback
keeps its captured subject, while the gesture owner advances its actionable subject only through
these source checks or the inspector's command-specific successor proof. `PanelView` forwards the
inspector's existing mutation tokens and settled proof to this owner. An accepted list action waits
for its matching inspector save to settle, revalidates the exact successor, and submits that subject
once through the existing application command. Matching metadata echoes may expire the index's old
transition without invalidating the proven current subject; external edits to that successor still
cancel the action. This evidence lasts only for the gesture, menu, and command lifetime and grants
no global source history or retry. Releasing the last lease delivers deferred Search presentation.
Moving to another valid marker transfers the presentation lease before retiring the previous menu
and row pin, retaining the latest deferred state through the next native activation.

## Presentation and interaction ownership

[`PanelView`](src/views/PanelView.ts) owns AppState, the rail, panels, shortcuts, and their lifetimes.
It injects capabilities and callbacks; delegated UI owners do not add independent task writers or
duplicate shell subscriptions. LeftPanel defers task navigation presentation in Calendar, Search
and Projects; returning to Tasks rebuilds counts, tags, projects and active state from current data
and settings. Its outer render still settles inline sessions while hidden.

| Owner                                               | Responsibility                                                                                   |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| [CompactPaneAccess](src/views/CompactPaneAccess.ts) | Responsive pane access, local focus, observers, and pending pane intent                          |
| [LeftPanel](src/panels/LeftPanel.ts)                | Navigation, counts, creation routing, and tag/project navigation sessions                        |
| [CenterPanel](src/panels/CenterPanel.ts)            | Mode composition, task surfaces, subscriptions, selection, capture, and shared card interactions |
| [RightPanel](src/panels/RightPanel.ts)              | Inspector targets, commands, drafts, recovery, Undo, history, and result ordering                |
| [TaskModal](src/ui/TaskModal.ts)                    | The same inspector with local AppState, hosted in a native Obsidian Modal                        |
| [CalendarSettingsTab](src/settings/SettingsTab.ts)  | Settings staging, persistence, retry, and semantic rebuild; section owners render controls       |

TaskModal delegates platform Back and scope stacking to the native Modal host. The host's public
Back hook first asks RightPanel's local interaction registry to dismiss its newest connected surface
through that surface's existing cancellation and focus path; Back closes the modal when no nested
surface remains. Planning menus, dependency search and shared anchored popovers (including link
suggestions attached to the document body) register exact surfaces and dismissal callbacks on their
existing interaction leases. Ordinary editing leases do not consume Back. The local registry forwards
shortcut blocking to its parent and releases those leases on inspector disposal.
Its facade owns one cleanup path for the local inspector, subscriptions, drafts, tracking ticker
and interaction lease. Programmatic close always disposes the inspector. The host uses the
inspector's guarded Escape scope; nested editors and IME keep priority.
Native selection restoration is disabled so explicit close restores only a connected opener when
focus still belongs to the modal. Programmatic replacement and deletion do not restore focus.

RightPanel owns a mobile field-visibility subscription for both the sidebar and native TaskModal.
It observes the owning window and inspector scroll containers, then minimally scrolls the active
editor into their intersection with the visual viewport. Oversized editors follow the caret.
Obsidian still owns the keyboard inset; the subscription never subtracts it again, changes focus,
or submits a draft. Disposal and window migration retire observers, listeners, and queued frames.
Inspector link suggestions use the same mobile scroll-container bounds and observe their size,
so the suggestion list fits above the keyboard even when VisualViewport does not resize.

Centre surfaces reuse `TaskCommands`, `TaskMenus`, `CaptureSessions`, `ListViewControls`, and
[`TaskCardRenderer`](src/panels/center/TaskCardRenderer.ts). Inspector planning, dependency, and
section owners render and invoke retained callbacks; RightPanel keeps submission and recovery
authority. [`taskContextMenu`](src/ui/taskContextMenu.ts) builds one shared menu from an exact node
and surface-owned actions. Descendant rows always target that node; CenterPanel retains bulk routing.
Inspector commands, pending edits, recovery, and Undo stay with RightPanel's current retained owner.
View-filter actions are a center-only capability. New workflows reuse these commands, menus,
renderers, and state semantics.

Search and Filter share tree rendering by exact node/comment references.
[`RetainedTaskText`](src/ui/retainedTaskText.ts) owns each field's Markdown lifetime and preserves
complete text and wired anchors when only highlighting changes. Changed excerpts replace only the
affected field after source and focus checks. Retired fields lose activation authority even if
physical removal waits for focus.
Link edits retain the source occurrence that produced the anchor; ordinary actions use current
snapshots. Render receipts settle after publication, including deferred commits, before geometry
is accepted. Query changes preserve the task surface and its logical scroll anchor. Root and child
metadata share CenterPanel's civil-day snapshot; date changes do not replace task text.

### Logical tasks and visual occurrences

[`taskNodeMembership`](src/task-lists/taskNodeMembership.ts) supplies shared membership rules for
ordinary and compact projections. Task lists and tags can include roots and descendants, using
each node's own metadata. Untagged Inbox admits roots only. Global Search and project collections
retain root populations. Sidebar badges count unique active physical nodes independently of saved
centre filters. Tag discovery uses canonical public task tags and the configured tag catalog.

[`taskOccupiedDates`](src/tasks/domain/taskOccupiedDates.ts) represents a valid inclusive start/due
interval, or distinct authored date points. Today, Upcoming, and Calendar use that same model.
The public task API exposes `taskOccurrenceCompletion` so presentation models retain canonical
date-specific completion capability alongside `taskOccupiedDates`.
Today distinguishes overdue work; Upcoming admits any future occupied date without expanding
recurrence forecasts. Date-specific continuation rows carry completion restrictions separately
from the canonical task. Explicit status commands still target the physical node. PanelView owns
civil-day invalidation, including midnight and wake/window changes, without writing Markdown.

Date and outgoing-link grouping can display one physical node several times. Logical row keys
identify occurrences; command targets identify source nodes. Selection, ranges, and keyboard
movement follow the complete logical order. Counts and bulk writes deduplicate physical nodes;
selected occurrences determine occurrence-specific completion capability. Selection survives exact
identity, a proven relocation of an unchanged source block, or a proven owned command transition.
An unrelated task inheriting the same line cannot inherit selection.
Grouped rows retain their logical group identity even when a redundant Today heading is hidden.

[`TaskListSurface`](src/panels/task-list/TaskListSurface.ts) mounts bounded keyed rows over the
pure [`RowViewport`](src/panels/virtualization/rowViewport.ts). Logical rows own order and selection;
DOM owns geometry, focus, and interaction. Mounted rows own disposable Markdown Components. Pins
retain focused editors and active interactions, and invalidation ends those interactions before
eviction. Date-grouped Upcoming uses [`taskDailyRows`](src/panels/task-list/taskDailyRows.ts) and
bounded native scroll geometry without materializing every day. Full order remains available to
selection and navigation regardless of the mounted window. Pending rows reserve their modeled
extent until current render receipts authorize measurement. The surface batches accepted geometry
before paint and preserves settled visible rows through asynchronous rendering and window refills.
Explicit source/reveal anchors and native scroll ownership keep priority. Replacement, document
changes, and disposal revoke stale measurement authority. Extent transactions preserve native scroll
range through intermediate DOM changes while permitting a real final shrink.

Tasks Kanban uses `TaskKanbanSurface` over the same row surface, one viewport per visible status
column. `CenterPanel` retains source subscriptions, selection, commands, and search hydration;
the board only owns column geometry and mounts. It organizes compact rows before hydration,
releases offscreen columns, and retains interaction pins. List and board scroll anchors remain
session state, separately per task context. The shared card renderer and native write receipts
remain authoritative in both layouts. `TaskKanbanDrag` consumes the existing
AppState task payload and uses `TaskCommands` for whole-column status changes. A drop retains its
captured definition and cancellation authority through confirmation; it never changes priority,
source order, or task ranks. A selected-card drag captures the existing exact menu selection and
uses the sequential task batch command, including guarded advancement after earlier writes.
A successful single drop reveals the committed node (the completed occurrence for recurrence)
after the receiving publication is ready; bulk drops retain column feedback without per-task reveal.
AppState retires task drags before publishing navigation, project, or task-view context changes,
so native-source and destination cleanup cannot write state during notification delivery.
Android native drag context menus are suppressed only while that payload is active.
Tag/project transfers keep their existing destinations.

Tasks Timeline uses `TaskTimelineSurface` around that same row surface and card renderer. The
sticky calendar axis contributes a viewport inset, so virtual rows and exact reveals remain below
the header. `taskTimelineModel` maps Start/Due to an inclusive range and Scheduled to a separate
marker; malformed ranges retain their authored values. Shared Projects axis, navigation, geometry
and pointer interaction drive the compact calendar. The task adapter captures canonical node
references and submits one date patch through `TaskCommands`, rechecking the source and view
lifetime before writing. Missing endpoints remain missing when moved. Summary selection, search
hydration and command receipts stay with `CenterPanel`; timeline anchors remain session state.

The project dashboard embeds this same task shell and all three surfaces. `ProjectsPanel` owns the
page and project details; `CenterPanel` supplies the note-scoped task context to existing controls,
search and capture. View preferences share the existing `project:<path>` entry with the same project
opened from Tasks. Dashboard text queries remain session state per path, independent of Tasks'
selection and query. Returning to Tasks reads saved preferences without overwriting them with its
inactive state. Each layout uses the shared inner task viewport; the dashboard keeps its compact project
context in the task toolbar and its Add task footer outside scrolling content. `CompactPaneAccess` opens the shared task inspector as an overlay on dashboard selection,
anchored below the task toolbar; the overview keeps it hidden. The task Timeline owns the shared axis
and a contextual overlay slot. `ProjectDashboardTimeline` adds distinct Start/End handles to that
axis and passive vertical boundaries to mounted task tracks, independently of task filtering and
without a project row. Virtual mounts release their boundary decorations on disposal. The shared
pointer owner publishes previews for these barless handles; task track gestures remain unobstructed.
The overlay shares endpoint source capture, paired write guards,
gesture planning and failure feedback with the overview; `ProjectsPanel` submits changes through
ProjectManager using the overview session's mutation queue and receipt projections. Dashboard
range Undo/Redo uses the same project edit history. Successful receipts update the range and
header immediately; verified source observations reconcile them before later edits. No task dates or new
metadata are derived from the project range. Leaving a dashboard releases its
task interactions, search, capture and selection.

CalendarMode owns the period anchor, transient selected day, view lifetime, and forecast presentation.
Its mounted publication hold defers query patches during pointer presses and native drags, and through
the full-grid pointer and status callbacks and menu leases that CalendarMode wraps. It reads the newest
query state once those interactions settle.
Pointer release waits through the native click/contextmenu turn before replacing its target.
The hold retains the origin of a timed-block press across query patches and consumes its click
after movement or scrolling, including after capture loss or Escape. A fresh press restores normal
activation; keyboard clicks retain their own path.
Submitted timed gestures publish temporary planning through the existing occurrence projector and
view patch. Submitted paints retain the last mounted projection sources and each node’s latest
submitted plan until canonical publication, so external source relocation cannot duplicate a block
or partial settlement undo its displayed geometry. CalendarPointerEdits owns these pending plans; CalendarTaskSource keeps the exact captured
canonical root, node and target. The replacement block exposes real handles immediately. The
publication hold consumes the submitting gesture's click and defers canonical replacement during a
later press. Status, menus and legacy callbacks retain their existing inert settlement boundary;
compact agenda actions retain TaskCardRenderer and CenterPanel command owners.

CalendarEditQueue serializes pointer and keyboard commands. Command builders receive a successor
only after the whole-tree owned-change proof accepts the preceding receipt. The queue retains source
reference aliases for mounted sources and the latest receipt, with one current snapshot per lineage;
intermediate unrendered receipt aliases are retired. Rendering pins exact source refs for gestures
that have not submitted yet, without acquiring replacement authority. Queued captures
hold that lineage directly. Keyboard input captures it before deferring or coalescing repeats;
shared keyboard intents are validated against that lineage only after earlier pointer edits settle.
If a remount exposes an already committed source before its delayed receipt, the whole-tree proof
joins captures of that exact reference; redirects discard obsolete snapshots and compress on access.
Failed or unproved receipts invalidate already queued dependents. A fresh
submission may retry its explicit source through the public API. The queue never acquires replacement
sources through query lookup. Command planning always comes from the canonical node, even when its
reference matches a block showing speculative planning; a failed edit cannot move the opposite edge
of the next resize. CalendarEditWitness describes declared date writes and the existing
midnight duration normalization for proof; it never infers permitted edits from a receipt diff.
Root planning receipts may retain the public API’s same-file line rebase after the expected planning
values and full task tree pass the owned-change proof. Prepared patches retain their originally
issued target for that check; the ordinary inspector selection proof keeps its existing line guard.

timedEditPlanning supplies both previews and submitted command patches. It preserves absolute pointer
dates and resized edges against the proved successor, retaining the opposite edge and the caller's
occurrence roles. A newly created interval replaces the preceding point semantics. Horizontal boundary
edits preserve authored timing. CalendarNativeDragContext retains rendered planning only for its exact
registered AppState payload, capturing it before native drop cleanup. Native drops and status actions
wait behind submitted timed edits and use their proved source successor.
Time-grid moves, vertical resizing, keyboard timing edits, native drops and empty-grid placement
share the five-minute step from dragGeometry. Preview and command planning use the same minimum
duration; the final start slot is 23:55. Authored durations and default durations retain their existing
storage semantics.

TimedBlockKeyboardQueue holds publication during each keyboard write without making the focused block
inert. Its receipt updates TimedBlockFocusRetention before releasing the hold; the replacement receives
focus in that publication turn, keeping repeated keys out of native page scrolling. Consecutive vertical
repeats of the same kind and direction accumulate behind the active write; reversal and modifier changes
retain their order and clamps. Tab transfers the hold to a queued edit of the next block. A pointer
submission discards unsent repeats on its source and suppresses late keyboard following. Subsequent
keyboard input starts a new sequence with its own following intent. Submitted planning restores focus
before the predecessor receipt, preserving native key input without letting that receipt change the
pointer's destination. Cancellation
leaves keyboard following intact. Even unchanged receipts release dirty publication before settling
focus ownership. Shared no-op intents retain only the exact canonical node reference supplied by the
queue’s validated builder; they preserve focus through publication without claiming a write.
Submitted pointer paints restore captured focus synchronously even without an active keyboard sequence.
Keyboard navigation across periods
preserves the scroll offset instead of scrolling to the current time. Automatic following shares
the mounted publication hold, so an accepted keyboard date cannot destroy a held pointer gesture.
A submitted pointer gesture takes over navigation; cancellation lets the keyboard follow settle.
Shortening an interval clamps keyboard focus to a surviving segment.
Navigation, width remounts, disposal, and window migration retire the hold; late completion cannot
restore the retired view or its temporary projection.
Timed and span sessions release pointer capture and listeners at submission. The timed planning patch
replaces its preview with an interactive block; other span previews remain until command publication.
For timed mouse gestures, capture loss with no buttons pressed can precede `pointerup` on a trackpad.
Both the session and its publication hold retain ownership through that notification; unpressed
mouse movement does not alter the preview. Only the subsequent matching `pointerup` submits.
Escape, pointer cancellation, window blur, active-button capture loss and view disposal still cancel;
a new press with the same pointer anywhere retires an unfinished session before the next release.
Explicit view patches still cancel sessions. View replacement retires temporary planning and its cached
projection. Late settlement requests a canonical refresh through the current hold, which still respects
any new pointer or menu owner; it cannot restore the retired view. Timed gestures retain their original planning and grab offset while refreshing
column rectangles on movement, ancestor scrolling, and release; scrolling also updates a stationary
pointer's preview.
Timed moves and releases use the same bounded geometric preference for the current preview.
Date selection tolerates up to eight CSS pixels across a column seam, capped at one tenth of both
involved column widths; clear column interiors select their own date regardless of the path.
Time selection retains the current five-minute snap bucket within three quarters of a step, so
small reversals at a rounding boundary do not flicker while every slot center remains reachable.
Resize limits retain their pre-clamp snap bucket, preserving adjacent off-grid endpoints. Date and
time preferences are independent, and date-only handles ignore vertical drift. A timed session also
retains the pointer sample that directly resolved its displayed target. If a later sample has no
target but stays within twelve CSS pixels on the gesture's relevant axes, the session keeps that
preview only when resolving the retained sample against current geometry still proves the same
target. Tolerated misses do not advance the retained sample. A new valid target takes precedence;
a larger miss clears the preview and cannot restore an earlier target. Stationary clicks never
acquire this fallback. Explicit cancellation still disposes the session. Ancestor scrolling
recalculates without either preference.
Shared span geometry keeps strict hit selection unless the timed session supplies a current target.
CalendarCommands ignores malformed date/time/duration input during command construction and lets
unexpected execution failures reach the existing UI action boundary. Retained presentation never
grants new source authority; external edits and deletion can still cause a command to be refused.
Timed forecast bodies and their top/bottom handles use the same pointer sessions and publication
hold to edit the series time or duration through an explicit canonical source patch. Forecast
movement is vertical only: projected dates, recurrence and source date roles remain unchanged.
These gestures grant no task selection, status controls, keyboard editing or native drag identity.
Top/bottom time handles cover the full edge and take priority over date handles at corners.
Time handles are limited to a quarter of the block's height; lateral date handles are limited to a
quarter of its width. This retains a movable center in short or densely overlapping blocks. Positive
physical height bounds the grab offset independently of semantic duration, including fractional layout
rounding.
Its mounted center owner supplies the available width; an owner-window observer coalesces changes
and rebuilds Month/Week only when the width category changes. CalendarContent retains one canonical
occurrence projection per publication and visible range; width remounts reuse that content.
Query intake invalidates this cache immediately, so a width remount reads current content even when
the retired interaction had deferred its publication.
ConstrainedCalendarView builds its bounded day model directly from those occurrences and retains its
date buttons. Selecting a date reads that model and replaces the agenda without querying, projecting,
or creating display snapshots. CenterPanel supplies eager agenda mounts from its retained
TaskCardRenderer with exact source ancestry. The view factory adapts occurrences to TaskSnapshots only
at full-grid Month/Week and Day render/patch calls. Materialized agenda activation adapts its single
occurrence on demand through the existing exact-source lookup; forecasts activate their source and
reference date directly.
The view captures scroll before destroying those mounts and replacing a day. It owns agenda scroll
anchoring and restores the same-day offset again when the current card receipts are ready, including
an offset clamped by unfinished rich text. A user scroll or retired list revokes that correction.
Date changes reset the offset. A narrow calendar policy supplies activation
and occurrence planning; forecasts omit mutation controls, editable links, drag/drop, tracking, and
writable presentation identity. Materialized rows retain canonical commands and status menus.
Agenda focus does not write inspector selection or install list multiselection; only native row
focus paints the canonical outline. Details activation remains available on continuation rows.
The shared bottom capture trigger sits outside the agenda list's scroll area.
Month week links carry the rendered row's first civil date; configured week layout derives its
seven dates. Mobile Day body taps open the same inspector. `TimedTouchActivation` leaves early
body movement to native scrolling; a stationary 450 ms hold hands the original touch to the shared
timed session. Only the claimed hold suppresses touch scrolling, context-menu activation and its
release click. The existing timed owner disposes pending holds on view changes; cancellation, blur
and an additional touch retire pending or active gestures. `CalendarPublicationHold` retains the
touch origin across submitted planning so a compatibility click cannot open empty-grid capture.
Explicit resize handles, mouse/pen dragging, native drag and empty-grid creation retain their own
handlers.

CaptureSessions retains the agenda editor's frozen date and draft through publications, width
changes, and date selection. It mounts only on that date's agenda or corresponding full-grid host;
a temporarily absent date leaves the session retained and unmounted. CalendarCommands maps
gestures to public commands. Materialized cards retain exact root/child ancestry and occupied-date
roles; moves and resizes edit those roles through canonical targets. Layout, previews, recurrence
forecasts, and display clamping do not themselves change stored planning.

### Drafts, navigation, and native lifetime

RightPanel keeps a submitted editor's target and value separate from newer live input. Continuation,
selection, and focus after a write require command-specific successor proof. Unproved or conflicting
drafts remain recoverable with their original owner; newer live input, including an empty value,
wins. Undo and inspector history are session-only and cannot overwrite external edits. Removal
holds prevent delete/archive/move publications from selecting a task that inherits a source line.
Sibling reorder proves the exact source permutation before mapping selection, drafts, and history
to surviving occurrences. It moves existing inspector rows and advances only proven captured editor
and planning-popup targets, preserving rendered Markdown, focus, drafts, and comment disclosure.
Non-draft task-action menus close after reorder. Other commands keep their existing target-capture
behavior. A drop that leaves the order and exact selected snapshot unchanged does not remount the
inspector.

AppState distinguishes explicit selection intent from refresh. Later user selection or navigation
wins over delayed command, capture, and reveal callbacks. Transient UI cancellation after submission
does not cancel the submitted write. Search activation, inspector navigation, and capture reuse
CenterPanel's exact-task reveal path. Nested Filter activation resolves the exact inspector path
without changing the active list or query; generation, cancellation, and selection intent guard
publication. Matching descriptions use bounded excerpts after complete rendering and link wiring;
display-only fallback grants no edit authority. The inspector retains the complete description and
editor source. Temporary inclusion of a revealed or created task does not
alter saved filters. Reveal consumes its scroll permission once and yields to later user scrolling,
focus, source changes, or owner loss. Modal-to-sidebar draft transfer preserves both owners on conflict.

Navigation completes an active project editor before changing mode; rejected drafts keep the current
mode. Explicit left task destinations dismiss their compact overlay only after the navigator accepts
and commits the destination, including reactivating the current list. Disclosure, editing, menus,
and background identity changes retain their existing interaction ownership. Dismissal belongs to
the initiating view mount; deferred completion cannot close a reopened view's overlay. Focus return
requires a connected opener and current interaction ownership. Each surface uses
its owning document/window, including after Obsidian popout migration, and releases listeners,
observers, timers, frames, subscriptions, and Components on teardown. Finite Obsidian Scope bindings
and the shared shortcut router respect active editors, nested surfaces, and interaction leases.

[`renderTaskText`](src/ui/renderTaskText.ts) uses Obsidian MarkdownRenderer with the source path and
Component lifetime. A render receipt settles only after current Markdown, source-token link wiring,
and search marks are ready. Replacement or disposal makes old callbacks inert. Editable links need
whole-field alignment and exact authored occurrence proof; ambiguous anchors receive no edit wiring.
Compact title embeds become inert labels. Presentation and search highlighting confer no write rights.

Retained create sessions expose a synchronous preview through the same frozen creation policy and
initial-field preparation as execution. The Markdown preview adapter runs `createTaskBlock` in memory
and reads its canonical root metadata. It also retains policy-prefixed source planning before the
initial patch, separately from final planning. Preview does not prepare or validate destinations,
read the clock again, or write; execution retains its destination and current-source checks.
Unavailable sessions and absent preview ports return explicit capability outcomes. Kanban capture adds
an optional create-only status (id, symbol, semantic type). Both application preparation and the
canonical Markdown codec revalidate that definition, then apply its normal status/date edit while
building the one new root block. Capture defaults, destination, and failed-draft ownership stay with
`CaptureSessions` and the ordinary create session. No second status write or task metadata is added.

The task domain's input inspection reads canonical carrier occurrences and atomic Markdown ranges
in raw UTF-16 coordinates. It protects tags, known carriers (including malformed ones), links,
images, code, and HTML without applying creation policy or normalizing the draft. These read helpers
and neutral contracts remain inward until a presentation consumer needs a public barrel export.

The application input-recognizer port accepts frozen civil reference data and raw protected ranges.
Its offline Chrono adapter imports only the English and Russian locales and returns neutral points,
partial interpretations, ranges, and unsupported expressions. Domain input state owns occurrence
suppression, manual calendar provenance, fallback clears, tag removals, and the last restorable dismissal.
The pure projection chooses effective planning and removes only fully represented, current disjoint
source ranges. Same-line metadata groups own adjacent unprotected dash/colon separators; interior
groups preserve their left connector. Active canonical tags and valid carriers stay in Markdown
while their title separators are removed. An owned attached separator supplies one horizontal
gap when removal would merge retained canonical metadata with title text. Capitalization requires
an initially uppercase, fully consumed natural prefix, including its owned separators; canonical source never supplies that proof.
Canonical tags stay protected from parsing and conserved between a joined day and clock;
other Markdown atoms remain merge barriers. These helpers carry no write or settings authority.

## Projects

[`ProjectStore`](src/projects/ProjectStore.ts) evaluates configured membership against note paths,
tags, and frontmatter, then combines reconciled tasks into derived statistics. It persists no cache.
[`ProjectManager`](src/projects/ProjectManager.ts) owns creation and guarded metadata writes;
task moves still use TaskApplicationApi.

[`projectFields`](src/projects/projectFields.ts) owns case-insensitive lookup, exact source binding,
and the shared field catalog. Project status is a configured frontmatter property with literal
status definitions, independent of tags. Curated types are fixed; custom definitions and presets
are static configuration, independent of native discovery and column visibility. Native property
adapters suggest types and values without changing Obsidian's registry. Ambiguous or unsupported
bindings preserve data and make affected roles read-only. Hiding changes view state; removing a
custom definition does not delete note metadata. Derived task/time statistics remain read-only.

[`projectTableModel`](src/projects/projectTableModel.ts) supplies shared search, typed filtering,
sorting, grouping, and visible counts for Table, Kanban, and Timeline. Pure models receive explicit
time and data. The retained [`ProjectsTableView`](src/panels/projects/ProjectsTableView.ts)
controller shares toolbar, field rendering, editors, mutation queues, history, and clipboard logic.
Each surface keeps its own organization, selection, and viewport across switching or dashboard
visits. The common logical-cell contract drives selection, clipboard, keyboard movement, and reveal;
windowed DOM is only a mounted subset. Clipboard data carries values and source context, not write
or history authority.

The overview orders submitted actions; ProjectManager separately serializes metadata operations
per App. Every note transaction rechecks field/type binding, source key, property presence, and
expected value. Multi-file batches return applied and failed receipts. Successful receipts project
immediately and remain until verified source observations acknowledge or supersede them; an ordinary
refresh cannot discard them. Rename, deletion, and membership loss retire affected paths.
[`ProjectEditHistory`](src/projects/projectEditHistory.ts) uses those bounded session receipts for
guarded Undo/Redo, preserving external edits and field bindings.

Kanban ranks are saved view state. Drops revalidate current group meaning, write metadata, then
change rank after success; filtering does not delete hidden ranks. Timeline uses the same endpoint
plan for preview and persistence and validates both endpoints together. All project surfaces reuse
bounded row geometry, pin active editors/gestures, and retire native work on hide or migration.
Drafts and submitted receipts keep their controller ownership through those transitions.
The dashboard's retained property controller uses the same `ProjectCellEditor` and its positioning
primitive as the overview. `ProjectsTableView.createFieldEditorSession` captures the effective field,
exact source state and presets, and submits through the existing mutation queue/history/receipts.
The dashboard owns editor and popover disposal; refreshing project evidence keeps active anchors
attached. Source-note chips are suppressed only for a task whose source matches the current project.

`TimelinePointerInteraction` owns shared pointer capture, preview, cancellation, edge scrolling and
row pins. Like calendar gestures, it ignores unpressed mouse motion, retains window release
ownership after released capture loss, and samples the final pointer position before submission.
A physical-click guard survives inspector reflow; the next press and keyboard activation remain
independent. Its caller supplies immutable source evidence, equality, planning and command receipts;
the Projects adapter retains frontmatter binding and write authority. `timelinePresentation` shares
calendar navigation, scale controls, axis cells and grid rendering without acquiring write authority.

Project creation shares NoteTemplateService and retains the owned path and failed phase for recovery.
Retries must not silently create a second note. Status-definition renames serialize metadata edits
and settings changes, compensating only values still owned by the operation. Recovery across notes
and settings is best effort rather than crash-atomic.

## Analysis and Statistics

[`TaskStatisticsSource`](src/tasks/application/TaskStatisticsSource.ts) is a separate read capability
implemented by TaskIndex. Its first subscriber activates
[`TaskStatisticsProjection`](src/tasks/infrastructure/TaskStatisticsProjection.ts), retaining
immutable, versioned evidence; the last subscriber releases that extra evidence and pending work.
Analysis can include the current archive destination only when source policy permits it. Archive
parsing uses the canonical codec without entering ordinary task, dependency, tracking, or reference
authority indexes. Policy tightening removes forbidden cached evidence immediately.

Acquisition failures retain last-good permitted evidence and expose coverage issues. Ready means
acquisition settled, not that coverage is complete. Move/archive publication holds prevent temporary
intermediate copies from becoming a completed observation; partial transfers expose actual retained
copies without content deduplication. Statistics settlement and ProjectStore settlement let the UI
capture a coherent source/catalog/project observation and reject stale preparation.

Pure [`src/statistics/`](src/statistics/) normalizes physical nodes and their own entries, preserving
live/archive provenance and source date issues. StatisticsSession receives explicit time, calendar,
project descriptors, and scope. Current open, aging, and dependency populations use live records;
historical and time metrics can include archives. Cohorts exclude inherited recurrence. Civil dates,
actual tracking instants, observed time bounds, and missing/invalid dates have distinct semantics.
Coverage remains visible independently of period totals. Aggregation and evidence use immutable
records; chart caps limit representation without losing the underlying evidence population.

[`StatisticsMode`](src/panels/statistics/StatisticsMode.ts) is retained by CenterPanel and subscribes
only while visible. It owns observations, transient navigation choices, evidence results, diagnostics,
and retry. LeftPanel receives a navigation port and never acquires retained Statistics sources.
Changed charts are staged before replacing the last-good presentation. Hidden views stop aggregation;
owner-document changes release and remount native resources.

Chart models contain data and semantic observations, with opaque evidence/action IDs.
[`StatisticsChart`](src/panels/statistics/StatisticsChart.ts) defines mount/update/destroy;
[`TanStackStatisticsChart`](src/panels/statistics/TanStackStatisticsChart.ts) is the sole TanStack
Charts import boundary. It translates model output without owning task classification or source
selection. Evidence pages mount the shared task cards for exact live nodes and revalidate their
current identity. Archive rows can only open a verified retained source; they never enter task
mutation queries or commands.

## Settings and compatibility

[`SettingsPersistenceCoordinator`](src/settings/persistence.ts) serializes `data.json` and adjacent
`state.json` through composition-root ports. One composed CalendarSettings object is the runtime
authority. Static saves and view-state saves use separate callbacks: only static saves advance
settings rollback state and refresh project settings. Task-status changes rebuild catalog, registry,
and index interpretation together. Analysis choices, Search options, drafts, history, and gestures
remain transient.

Saved views write schema 2 and read schema 1 and legacy data. Migration retains a recovery snapshot,
writes and verifies the state envelope, then cleans moved static keys. Recognized state wins over
legacy copies regardless of the static marker. Missing state after migration uses defaults without
recapturing stale keys. Corrupt, unreadable, or future-version state stays untouched: view writes
suspend and runtime uses temporary defaults, while static saves preserve guarded legacy fields.
Older schema-1 binaries suspend writes to schema 2; re-upgrading restores those views.

`ViewModeSwitcher` supplies the icon controls for Tasks and the Projects overview. Both put the
active filters before the switcher, then the existing `ViewOptionsPopover` sort/group menu and local search. Task Kanban
options use the same popover rows as Projects; List options keep their existing behavior.

Task collection preferences extend each saved `ListViewState` with an optional display mode and
independent Kanban and Timeline settings. Existing List grouping, sorting and status visibility remain intact;
explicit property filters are shared. Kanban derives its effective selector state and status-column
order from `taskKanbanSettings` and `taskKanbanModel`, without task ranks or source writes.
`taskCollectionSettings` projects each layout’s organization while preserving List preferences.
The serializer normalizes malformed layout preferences independently, retains their recovery source,
and preserves unknown nested layout and sort extensions.

Ordinary saves preserve unknown static and nested view extensions. Detached writes queue in order;
a rejected write does not block later operations. [`ViewStatePathOwner`](src/settings/ViewStatePathOwner.ts)
updates saved note paths for rename/delete, while PanelNavigator updates session navigation.
[`tagViewState`](src/settings/tagViewState.ts) carries raw tag-view entries through rename, preserving
unknown fields and rejecting conflicting destinations before vault writes. Failed view persistence
retains staged preferences for retry.

Archive-path and source-exclusion changes form one validated settings draft. Changing the archive
path adds the prior destination to the ignore expression; only successful persistence changes the
effective policy and rebuilds projections. Versioned custom-property definitions prevent native
rediscovery from undoing explicit schema edits; unsupported versions preserve data and disable schema
editing. Schema persists before view cleanup, so partial failure leaves durable schema authoritative
and cleanup retryable. These are separate file writes, not a two-file transaction. Persisted-contract
changes need explicit migration, fallback, and rollback design; new task metadata must not be added
merely to simplify presentation.

[`TagManager`](src/tags/TagManager.ts) owns navigation tag settings, promotion, ordering, and global
rename. Discovered groups stay derived until configured. Navigation archives hide groups in settings
without changing task Markdown. Shared [`tagSyntax`](src/markdown/tagSyntax.ts) supplies Unicode and
nested-tag validity and locale-independent case identity, while writes preserve authored spelling.
Configured group IDs remain exact; saved-view lookup resolves aliases without rebinding physical keys.

Shared Markdown and task-domain readers retain separate dependency boundaries, with agreement tests
for links and code-point handling. Embeds/images are atomic source ranges. Source and shipped code
avoid regex lookbehind for older iOS engines. [`obsidianMoment.ts`](src/obsidianMoment.ts) is the single
import boundary for the host Moment export: its callable-type correction preserves the external
Obsidian runtime instance. Remove that correction when upstream types support the same use.

## Architecture checks

| Contract                                   | Enforcement                                                                                                                                         |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Import direction and public task consumers | [Dependency rules](dependency-cruiser.config.cjs) and [architecture tests](test/architecture-boundaries.test.ts)                                    |
| Text-write acquisition                     | [Exact storage roster](test/architecture/storageAuthority.ts) and [audit](test/storage-authority.test.ts)                                           |
| Settings ownership and migration           | [Key classification](test/architecture/settingsOwnership.ts) and [coordinator tests](test/settings-persistence.test.ts)                             |
| Pure models and native lifetime            | [ESLint rosters](eslint.config.mts), [project policy](eslint-project-policy.mts), and [lifecycle tests](test/project-owner-lifecycle.test.ts)       |
| Host lint and shipped compatibility        | [Lint parity](test/obsidian-lint-parity.test.ts), [community review](test/store-review.test.ts), and [artifact tests](test/build-artifacts.test.ts) |
| CSS scope, tokens, and runtime variables   | [CSS policy](tooling/css-policy.mjs) and [finite contracts](tooling/css-contracts.mjs), checked in authored and shipped CSS                         |

New write acquisitions, settings keys, pure modules, and dynamic CSS producers/consumers must extend
their exact rosters with reasons and tests. Fix violations at their source; do not weaken checks.
Static audits do not establish all passed-capability flows, transitive purity, browser lifecycle,
layout, or contrast. Styles stay scoped to plugin-owned surfaces and use semantic host tokens.

```shell
pnpm arch
pnpm verify
```

`pnpm verify` is the full quality gate; `pnpm verify:task` is the fast iteration gate. CI and pre-push
use [`tooling/verify-changes.mjs`](tooling/verify-changes.mjs) through `pnpm run ci`. Only explicitly
allowed documentation and semantic version-only metadata changes take the light route; behavior,
tooling, and uncertain history require full verification. The full gate checks source CSS and fresh
built artifact CSS. Release preparation also requires fresh artifacts, even for metadata-only changes.
The full command always runs the complete `verify:checks` chain. After success,
[`verification-receipt.mjs`](tooling/verification-receipt.mjs) can record a local receipt in the
checkout's Git directory when source, tests, configuration, installed dependencies, and execution
environment stayed unchanged during the run. A branch pre-push can reuse it for 24 hours only when
the actual files match the pushed commit and the built artifacts still match. It refreshes the
dependency audit and rechecks the receipt before accepting the push. A later full run invalidates
earlier success, including on failure. Missing or uncertain evidence uses the full gate, as do
platforms without the file-open flags needed to reject symlink replacements. CI, tag pushes, and
release preparation never consume local receipts.
[`esbuild.config.mjs`](esbuild.config.mjs) embeds runtime dependency license notices in the bundle.

Native performance evaluation is an opt-in development workflow described in
[PERFORMANCE.md](PERFORMANCE.md). The Node controller in `tooling/performance/` owns fixture
transactions, production artifact deployment to `dev-vault-tasks`, restoration, and comparison.
Its separately bundled renderer helper drives existing query/command contracts and native UI,
records Performance API spans, and owns secondary CDP sessions. It is not imported by product
code and introduces no persisted product metadata or production write authority. Result files and
recovery journals stay in ignored local storage; failed or incompatible runs cannot claim gains.

Releases use the existing release command or the [patch preparation](.github/workflows/prepare-release.yml)
and [merged-release tagging](.github/workflows/tag-release.yml) workflows. Automated tagging validates
the merged version-only PR and successful master CI using trusted master code; tags are immutable.
The [release workflow](.github/workflows/release.yml) owns preflight, artifacts, attestation, and draft
release creation. Do not bump versions, tag manually, or publish without an explicit release request.

UI changes require native interaction, screenshots, DOM evidence, and captured runtime errors in
`dev-vault-tasks`, including constrained widths when layout changes. Follow [AGENTS.md](AGENTS.md)
for vault restoration and integration rules. Update this document with changes to ownership, public
boundaries, dependency direction, critical data flow, persisted authority, or compatibility. Private
helpers, rendering recipes, tuning constants, and test inventories belong in source and tests.
