# Architecture

Abyss Tasks manages Markdown tasks through an Obsidian sidebar, with task lists, a calendar,
project views, and Analysis. Markdown is the durable record. The plugin builds read models over
the vault and writes user changes through application commands.

## System at a glance

```mermaid
flowchart LR
  Integrator[External plugin] -->|getApi v1| Facade[TaskApiProvider]
  Facade -->|bounded reads and accepted witnesses| Index
  Facade -->|guarded status intent| Service
  Facade -->|epoch request receipts| Requests[TaskRequestRegistry]
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

[`TaskEditPreparationApi`](src/tasks/application/TaskEditPreparationApi.ts) prepares a root tree
without writing or publishing accepted revisions. TaskApplicationService freezes settings and clock
and normalizes typed edits through its ordinary command preparation. Immutable `append` operations
use refs from the preceding `after` tree; `before` remains the original accepted root, and `after`
is null only for deletion. Returned snapshots and receipts are detached.

[`MarkdownTaskEditPreparation`](src/tasks/infrastructure/markdown/MarkdownTaskEditPreparation.ts)
retains candidate content behind opaque commit closures and invokes the repository's existing
canonical codec/editor path in memory. ObsidianTaskRepository borrows accepted source evidence
through the index read ports. Inside the existing file writer it checks the native file identity,
accepted source version, original full-file bytes and root revision, scope, semantics, and candidate
source policy. Any intervening same-file edit rejects that writer basis. One commit attempt writes the
complete candidate and publishes through the normal transition path; root deletion uses normal
delete receipts and configured empty-note cleanup. Composite edits carry canonical physical line
mappings through each append. TaskBlockEditor proves insertion/removal continuity from retained
source-line objects, including identical-title siblings; missing proof never becomes a continuation. Repeated commit calls retain the first result, including unknown failures;
recovery reads do not replay the edit. An unattempted plan family can instead `refresh` against
current accepted state. The application and repository require exact or native authority continuation
of the retained root, unchanged original root bytes, the same native file, and unchanged settings,
scope and semantics. The canonical block editor transplants the sealed replacement into the fresh
note, preserving other bytes. Refresh advances a private writer anchor while retaining the original
reviewed `before`, frozen clock, and composed child map. Any attempt, including an unchanged or
unknown result, prevents refresh throughout that append/refresh family.

Canonical single-root edits and task insertions also prove untouched sibling roots from their exact exterior bytes and
physical line displacement. The repository validates their accepted revisions and passes them through
the existing TaskRefAuthority transition and occurrence witnesses, including duplicate full blocks and
children. TaskIndex can use the latest native unchanged-revision witness across missed intermediate
shifts only for positive, unique, non-recycled generations in the same authority epoch. Generation-zero
source-derived revisions require refresh after every shifting write. Visual, uncertain and text-only
relocation results do not grant refresh authority; no historical transition store is retained.
Same-revision native transitions remain relocation evidence with an explicit authority-transition
basis, preserving ordinary archive behavior and keeping `authoritySuccessor` limited to changed
generations. Refresh requires that native basis, never the relocation label alone.

Ordinary and prepared task creation reuse `ProjectRootPhase` and its full-population structural
reservation. Canonical insertion retains all untouched roots and descendants by physical source
correspondence, including duplicate blocks under prepend and section placement. A created receipt
uses the structural owner's fresh reserved root reference; an unavailable accepted installation cannot
make an equal preexisting root look like the inserted occurrence. Acknowledged storage remains a
known commit even if later accepted readback is unavailable.

A rejected staged write cannot retain speculative sibling or inserted-root authority. Exact rejected-candidate
readback remints retained sibling and newly inserted revisions without continuations and publishes their invalidation
through the existing occurrence boundary. Literal restoration ownership remains reserved for the
original source. If rejection readback is unavailable, the repository captures a native file and
observation guarded invalidation from TaskSnapshotState. The index revokes speculative task refs,
marks source acquisition failed, and retires occurrence handles; it does not certify an empty note.
Later acquisition cannot reuse the revoked refs. Creation additionally binds the invalidation capture
to the exact candidate content, so an already accepted competing source cannot be invalidated by an
older failed write. A later accepted observation also makes a captured invalidation inert.
The structural owner's optional rejected-readback path retains only its existing restoration or
revocation stage through installation/release. Revocation stages cannot forward bytes, complete a
mutation, or commit authority. Changed-generation status successors keep their established confirmed
receipt behavior; rejected insertion revokes its fresh root as well as retained siblings.

[`TaskCreatePreparationApi`](src/tasks/application/TaskCreatePreparationApi.ts) prepares complete
new trees through the same application normalization, canonical creation codec, editor and snapshot
projector. Seed children receive native prefix/Inbox policy and initial lifecycle/status fields;
initial status constructs the task through the shared line codec without completion-time deletion
or recurring completion. Descriptions, comments and their timestamps are visible before provisioning. Appends retain sealed candidates and expose detached
physical node correspondence from the immediately preceding preview, including newly drafted
children with identical titles. Changing previews have distinct draft revisions; unchanged appends
retain the preceding snapshot and refs. Draft refs carry no accepted mutation authority. A creation
starts with no predecessor map; root deletion discards the proposal rather than becoming a creation
command.

Destination planning remains read-only. The sealed plan captures effective behavior/catalog,
resolved default path/insertion, native file identity and accepted bytes, or a missing note with a
frozen static template. Pre-provision checks include project guards and complete candidate source
policy. Each provisioning boundary rechecks the captured basis; insertion rechecks identity, bytes,
settings, project revision, scope and semantics inside the existing queued writer. A changed default
never redirects an agreed candidate. Commit inserts the exact reviewed block once, shares its receipt
across repeated/concurrent calls, and reports destination provisioning separately as unchanged,
committed or unknown. A persisted folder/note with a failed task insertion is not a saved task.

`NoteTemplateService.planStaticNote` owns guarded static provisioning through its existing folder
and note writers. It freezes core template expansion during preparation and rejects executable
Templater syntax before any writes with `unsupported-template`. Existing destinations need no
template execution. Ordinary Q capture retains its established eager preparation and Templater
behavior. No new text-write authority or persisted task metadata is introduced.

Creation refresh coordinates the repository basis with `TaskDestinationPlan.refreshPrepared`, the
static note owner, and the selected project guard. It keeps path, insertion policy, template bytes and
expansion, settings and project meaning fixed. Project guards can adopt incidental task-byte revisions
only while identity, frontmatter, membership/schema semantics and placement remain unchanged.
A planned missing note can adopt a newly created file only with a current accepted root anchor.
`sharesDestinationBasis` compares preparations issued by the same application owner through private
sealed destination/template state; it exposes no template bytes and proves no write success. Its inward
caller must retain the earlier known successful creation, verify matching destination bases and proven
current occurrence identity before supplying that receipt's anchor. Native owners validate the anchor's
accepted reference/path/file; they never infer success from a file appearing. Static note refresh then
binds the accepted file and makes provisioning a no-op. These capabilities add no public receipt token,
identity registry, command replay or multi-root transaction.

The opt-in native profiler in [`tooling/performance/native-api.ts`](tooling/performance/native-api.ts)
is a structural consumer of the external v1 contract, imported only as types from `api.d.ts`.
Its scan measures complete coherent pagination after untimed client activation. Its status span
measures one guarded completion, identical receipt replay, and final hydration after untimed
sandbox creation through the existing application command. Preparation waits for matching metadata,
current and cached bytes, and canonical acceptance before one fresh public resolve. This establishes
the sandbox read basis without reserving coverage against later host events. Ordinary profiling never
discovers the provider. Both selections use the same profiler, pending-work drain, cycle reset, and
transaction restoration; the API client and listener belong to one cycle.

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
| [Internal task boundary](src/tasks/index.ts)     | Presentation's entry point for task queries, commands, capture, Search, Statistics sources, and task values                                                     |
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

## Portable integration contract

[`api.d.ts`](api.d.ts) is the canonical external contract, including discovery and cleanup
examples. Consumers inspect an integration-supplied candidate for `getApi`, request major version
1 explicitly, and check the result and `info.apiVersion`. Unsupported majors fail without fallback.
The contract does not prescribe an Obsidian plugin registry. Register client disposal and the
subscription's unsubscribe function with the consumer's own lifecycle. Read capabilities and limits
from `client.info`; they describe supported operations and bounded resources, not permissions.

External plugins and future AI or MCP consumers use this client boundary. No AI or MCP adapter,
transport, or SDK is implemented. `src/main.ts` alone composes the provider with the real index and
application service. `src/integrations/` imports inward contracts through `src/tasks` and the narrow
[`projectApi`](src/projects/projectApi.ts) port; the task domain,
application and infrastructure layers do not depend on the external declaration or facade.

The headless project read adapter derives membership and fields from accepted TaskIndex sources,
including empty notes, without opening ProjectStore. Main injects one reader, the ProjectManager
write port and the prepared project task commands into TaskApiProvider. Only this complete
composition advertises the six project capabilities and exposes the eight project methods.
Requests materialize project notes on demand. Clients share a provider-owned ProjectReadRegistry
for bounded opaque file identities and cursors. Project configuration invalidates common scans without changing task status semantics.
ProjectStore and the adapter share root statistics through the pure project statistics model.

Headless project updates run through ProjectManager's per-app metadata queue. The manager checks
the accepted file, source bytes, field bindings and status meaning inside the single-note write.
It validates membership and exclusion on the candidate before returning it to the vault.
When a note has frontmatter, TaskIndex and the writer require a YAML mapping and verify its
boundaries against Obsidian after accounting for a leading byte-order mark.
For headless creation, NoteTemplateService prepares the configured static template and the manager
adds the initial fields in memory. The service rechecks the template, destination and project scope
after folder creation, then creates one note with its final content. This route accepts core static
substitutions and suppresses recognized automatic Templater execution. Executable templates and
unsupported active adapters fail before note creation. Both writers reconcile the
actual file through TaskIndex before issuing a new project reference.

Project task capture uses the dashboard insertion policy and the application service's task
prefix and lifecycle settings. The repository checks the project's file, accepted bytes and
candidate inside the native write. A root move uses the same destination-first sequence as
the dashboard. Before copying, it checks the source root and the permission of the note that
would remain. Before removal, it reads back the destination and verifies the installed copy,
current project membership and original source incarnation. Each phase records its own storage
acknowledgement. TaskIndex accepts structural occurrence witnesses only while the file and
acquisition still match the readback. The inserted root receives a fresh revision even beside
identical roots. The facade pins existing targets at admission and reserves capacity for a new
project or task. A confirmed task result names the writer's exact occurrence. A same-note move
uses the pinned original target. Summary evidence suffices for project writes and disclosure,
including projects whose configured detail exceeds the public result limit.

TaskIndex samples the native file identity, size and modification time at acquisition. A changed
stamp makes the accepted source unavailable. Ordinary metadata callbacks can update tasks immediately.
TaskIndex records when their bytes still need confirmation for a project reader. An exact project
read checks its own note. A page checks coverage across all potentially visible notes, including
those after the page boundary. A pending proof yields incomplete coverage. TaskIndex confirms queued
coverage paths one at a time, with a separate slot for exact reads and moves. Readers share a native
read of the same acquisition. Only an individually read note receives ongoing native checks.
Matching bytes confirm the source. Different bytes enter the
normal index installation and invalidate subscribers. A superseded acquisition cannot settle a newer
one. Project moves can wait for their captured source proof. Later callbacks for project-read notes
reuse the proof only when the bytes and stamp still match. Static template creation checks its captured
template stamp through folder setup and final authorization.

The declaration has no imports, runtime statements, ambient host augmentation, or internal type
references, and needs no Obsidian or DOM typings. Its request and result data is recursively readonly.
[`src/integrations/validation.ts`](src/integrations/validation.ts) accepts allowlisted plain
records, normalizes canonical task dates and tags through the task public boundary, and
copies and freezes validated data. Cancellation signals remain live caller-owned capabilities;
only their copied options envelope is frozen. [`values.ts`](src/integrations/values.ts) owns
plain-value freezing and structured API errors. Public integration calls return structured failures
without UI notices; ordinary task commands retain their existing behavior.

[`TaskIdentityRegistry`](src/integrations/TaskIdentityRegistry.ts) owns bounded, epoch-scoped
opaque targets and revisions for issued occurrences. It consumes accepted semantic witnesses
synchronously, preserves proven continuations, and retires uncertain or removed occurrences
without reviving their targets. Whole-root or semantics changes advance the public revision.
Projection allocates a node and its parent atomically; lookup does not renew idle expiry or grant
source permission. Pins preserve accepted operation authority, while reserved capacity guarantees
a next-occurrence receipt can settle even after disposal. Receipt claims reuse an already projected
next occurrence only at its currently proven address.

[`TaskCursorRegistry`](src/integrations/TaskCursorRegistry.ts) retains bounded query bindings and
next offsets. Cursors bind normalized filters, page size, generation, scope, semantics, and provider
epoch; replay does not extend expiry. Both registries reject live capacity overflow instead of
evicting issued state. Their only task dependencies are inward value types exported through
`src/tasks`. Their contents are transient and belong to one provider lifetime.

[`TaskApiProvider`](src/integrations/TaskApiProvider.ts) implements the full v1 facade over
`TaskIntegrationReadApi` and `TaskStatusMutationApi`. Main constructs it before index initialization,
exposes `getApi`, and disposes it before destroying the index. Existing `queries` and `tasks` fields
keep their application interfaces. The provider owns clients, identity, cursor and request registries;
clients expose frozen method tables, readiness, subscription and disposal. The first client activates
occurrence evidence and installs a synchronous accepted-event listener. That listener applies identity
witnesses before external invalidations. Outward publications retain their original listener audience
and drain in order across callback reentry. Every callback checks its registration and client lifetime.
Provider closure settles pending readiness and closes listeners before releasing its inward subscription.

[`taskApiReads`](src/integrations/taskApiReads.ts) snapshots validated inputs before yielding, checks
liveness and current source permission at delivery, and maps inward failures to sanitized API errors.
Cursor binding failures precede incomplete coverage. [`taskDto`](src/integrations/taskDto.ts) copies
only the public allowlist, including parent targets; no inward revision or source block becomes a public
token. Current exclusion precedes incomplete health for target reads, while lifecycle failure retains
precedence. Source health determines whether a snapshot can be disclosed; identity witnesses determine
whether an opaque target still names the same occurrence. Either proof can be unavailable independently.

[`taskContentApi`](src/integrations/taskContentApi.ts) composes the native edit and creation
preparations into optional public tree, prepare, apply and create capabilities. A client owns bounded,
expiring immutable plan versions and plan-only draft targets; native preparations retain the source,
clock, settings and sealed candidate authority. Before trees retain the original reviewed root.
The plan composes original-to-current native correspondence through each immediate-predecessor
preparation. Late expansion issues existing descendant targets from the pinned original-root proof;
new authored descendants remain plan-owned. Refresh resolves
the pinned original accepted root, or a same-consumer successful insertion retained by the request
owner with matching sealed destination basis. It advances an unattempted writer without replaying a
command. Prepared successors remain unpublished until the final delivery check. Rejected delivery
releases only its unpublished version; a visible refresh predecessor retires only when a successor is
published. Concurrent visible versions and separately admitted request pins retain their ownership.
A mutation consumes the whole plan family, including divergent versions and failed attempts.
Initial native edit preparation is asynchronous: the existing repository awaits the source owner's
current acquisition, then rechecks file incarnation, lifecycle, scope, semantics and exact root.
The application owner captures settings and commands before the await and rejects changed settings;
the facade revalidates the accepted caller revision and releases pins on failed preparation. Creation
and refresh use the same source-acquisition guard. Append remains synchronous over its sealed tree.
Initial status symbols resolve through the current complete native catalog; saved status actions retain
their separate lifecycle command path. Draft status edits are not part of the content command union.

[`taskTreeApi`](src/integrations/taskTreeApi.ts) projects canonical direct-entry order into detached
trees and owns revision-scoped comment/time handles and shallow expansion cursors. Entry limits never
truncate scalar text. Incomplete children expand independently, so exhausting a node cursor does not
claim recursive completeness. Activity summaries derive from the full tree at one explicit observation
time, independent of the returned entry window. Read-only time entries preserve their owning node.
Plan handles never enter the accepted identity registry. Late before expansion projects accepted
handles only within the unchanged original block proved at the current retained root address.

[`taskSearchApi`](src/integrations/taskSearchApi.ts) owns client search cursors, releases borrowed native
cursors on expiry/cancellation/disposal, and scans native retrieval batches through exact accepted
hydration before applying node filters. Field selection travels through the existing Search service,
worker validation and MiniSearch field selector. Existing UI defaults remain unchanged. Scoped tag
catalogs enumerate permitted accepted nodes and reuse canonical case-insensitive representatives.

[`taskContentReceipt`](src/integrations/taskContentReceipt.ts) is stateless. It compares the sealed final
block with the writer's exact installed occurrence and current accepted readback, then maps only the
final-plan task handles frozen at admission through canonical relative positions within that proved
block. The existing per-file reconciliation record also borrows the exact current installed file
incarnation and source bytes. Matching host echoes retain its native transition before or after the
notification flush only when that full basis and task population still match. Same-revision native
relocation proof survives a later echo; changed-generation predecessor authority remains available only
for its already queued delivery, then returns to the established visual-only lifecycle. Different bytes,
replacement files, restoration or revocation replace or clear the proof;
unchanged task lists alone grant no continuity. A missing readback or mapping preserves write effects and never authorizes replay. Comments
remain version-scoped; receipts grant no durable comment correspondence. Every initial or replayed
content receipt delivery checks current client/provider lifetime and disclosure of its retained task
handles. It returns a detached redacted projection when proof is unavailable, while the request owner
keeps its immutable historical receipt and effect facts. Delivery never repeats the writer.

[`TaskRequestRegistry`](src/integrations/TaskRequestRegistry.ts) owns bounded accepted promises and
terminal mutation outcomes across status, project and prepared content operations within one provider epoch and
consumer namespace. Exact normalized payloads include the operation and deadline. Project request bytes and content receipt/preparation reservations share a 4 MiB cap in addition to the provider's request counts. Task and project targets
and cursors have separate capacity and expiry accounting. The registry validates and
normalizes payloads before replay, then acquires an admission ticket only for new requests. A final
synchronous reservation check handles callback reentry and releases unused tickets. A transient
abort listener covers admission: getter observations precede the final client check,
and abort notifications update owned state without another signal getter after that check. The
listener is removed when the synchronous reserve/reject decision finishes. Accepted work
keeps its authority pin through settlement and retains failures as well as successes; client disposal
cannot erase it. A monotonic effective clock rejects expired payloads, and only expired settled
records free capacity. Provider disposal rejects new work and drops terminal state while accepted
operations finish. Each task status ticket pins the original public target and retains the exact inward
root, selected node and observation. Any authored recurrence field reserves one possible-next slot before
acceptance. The ticket releases both resources on rejection or settlement, including construction failure.

Project receipts retain storage facts and optional opaque references. Each joined call or replay
checks its own client and the current permission for each reference. A task reference needs a
proven occurrence and a permitted, well-formed source at issuance and delivery. A healthy source
can still disclose the task after it leaves project membership. A move records the destination copy
and source removal separately. A failed second phase leaves the acknowledged copy in place.

[`taskApiMutations`](src/integrations/taskApiMutations.ts) validates new requests against current source
eligibility, coverage, revision and status semantics, then submits one intent through the existing
application mutation queue. The service acquires the strict read lease inside that queue. The facade
neither acquires a second lease nor imports reference authority or concrete storage adapters. It claims
the reserved next target from exact final occurrence continuations before projecting result snapshots.
Receipt mapping preserves committed status and known next facts when tracking or snapshot projection
fails. After a successful changed writer settles, its transaction invokes the one-shot confirmation
returned by the strict guard. Normal accepted-index installation runs first. If observation closed or
publication failed, the callback retains only historical original/next facts from that exact candidate.
It cannot restore current addresses, clear lease failure, or authorize follow-up writes. Existing
accepted roles and later timer continuations take precedence. Rejected writers never invoke it, and
lease disposal makes retained callbacks inert. Replays retain the original values and effects; each delivery checks current disclosure proof
and strips unavailable DTOs without replacing them with newer task data.

Readiness means initialization completed; it does not prove complete current coverage. A failed
or pending source, including an empty note, can make an otherwise ready scoped read incomplete.
A coherent scan subscribes before paging, keeps the same normalized query and limit, and accepts
only pages from one observation with no intervening invalidation. Consumers restart after a stale
cursor or incomplete read. Physical child nodes match filters independently of their parents.
Authored IDs are exact lookup values and may resolve ambiguously; neither source coordinates nor
an authored ID replaces an issued occurrence target.

Successful readiness or a read does not reserve complete coverage for a later queued write. An
accepted request that fails unchanged with `INCOMPLETE_READ` keeps that terminal result for replay.
The consumer rereads and decides whether to make a distinct request with a fresh ID and revision.
Committed, partial, or unknown effects must not be repeated just to obtain a missing DTO; use a fresh
read and the receipt's recovery guidance.

Targets describe proven occurrences within one provider epoch and idle lifetime. They are not
durable IDs; a continued occurrence can keep its target while its whole-root revision changes.
Request replay is bounded and in memory, so it is not durable exactly-once delivery. `consumerId`
is a request namespace, not authorization. Strict writer checks protect the current file and captured
read observations; they do not lock the whole vault into a cross-file transaction. A committed main
write can retain known effects while timer work is partial or unknown. Consumers follow the returned
effect and recovery values and reread when needed, without repeating known committed work.

Compatibility is exercised by the standalone consumer fixture and public contract, validation,
lifecycle, read, identity, cursor, request and receipt suites in `test/public-api-*.test.ts`. The real
index/repository harness also covers empty-source health, ordinary/UI occurrence continuation,
strict writer callbacks and per-timer guards. Architecture tests enforce the inward imports and exact
storage owners. Native desktop acceptance and the opt-in API profiler check the running host;
constrained desktop widths do not establish real-device mobile behavior. Product runtime remains
free of new Node/Electron imports and retains `isDesktopOnly: false`.

Main updates the effective mutation semantics key synchronously before settings persistence and when
the status catalog changes. The key covers the catalog, lifecycle date policy and recurrence settings;
unchanged effective values and unrelated preferences preserve it. Source exclusions continue using
the existing successfully persisted storage-policy hook. Reload creates a fresh provider epoch and
keeps old clients disposed. Public state, receipts and identity reservations never enter settings or
Markdown. The boundary adds no persisted fields or settings format changes, so it needs no data
migration. Rolling back v1 discovery leaves existing Markdown and settings readable.

## Task source and command flow

### Identity and reconciliation

[`TaskIndex`](src/tasks/infrastructure/TaskIndex.ts) discovers tasks from Markdown through the
canonical [`TaskMarkdownCodec`](src/tasks/infrastructure/markdown/TaskMarkdownCodec.ts). Host
list-item metadata enriches discovery; omissions cannot remove authored tasks. Source exclusions
apply before public projections, while excluded content remains available for repository proof.
Host-cache frontmatter supplies presentation values, with authored frontmatter as fallback.

Initial discovery starts after layout readiness. Vault reads remain concurrent, while each
initialization attempt owns a cancellable queue for accepting their results. The queue yields
between atomic file installations after a short time or work budget, rechecks file ownership,
and drains before publishing readiness. Retired attempts cannot accept late reads or failures.
Repository commits and metadata observations retain synchronous acceptance. One large file can
still exceed the slice budget; this is cooperative scheduling on the host thread.

`TaskIndex.integrationReads()` exposes internal lifecycle, coverage, and complete physical-node
reads. [`taskIntegrationProjection`](src/tasks/infrastructure/taskIntegrationProjection.ts) walks
canonical roots and descendants in code-unit path and absolute-line order. Filters apply to each
node independently; page hydration is bounded to requested rows and one lookahead. Exact addresses
retain whole-root revision and physical line offset, with parent lines calculated from full ancestry.
ID resolution counts all matches while hydrating at most 100. Ordinary root-filtered queries retain
their existing behavior. Read status uses the current catalog and authored cancellation precedence;
planning uses canonical valid date, time, and duration projections.

Accepted source records bind their existing evidence to the owned file object. Integration coverage
and disclosure require that object to remain at its current path; legacy ghost records and vanished
or replaced files grant no read authority. Disclosure also checks current source policy.
[`taskSourceMetadata`](src/tasks/infrastructure/taskSourceMetadata.ts) supplies authored tags and
frontmatter for that policy, separately from host-cache presentation enrichment. The projection
retains sorted path keys and borrows canonical node records inward. These records include internal
source and reference evidence; they are not external DTOs.

[`TaskIntegrationReadState`](src/tasks/infrastructure/TaskIntegrationReadState.ts) tracks source
acquisitions by file identity, initialization attempt, and current observation, including empty
notes. Pending or failed sources make reads incomplete within the requested path or folder unless
current policy proves exclusion from the path alone. Main supplies that proof from the existing
query parser and path matchers; unknown tags and frontmatter remain unknown through compound and
negated queries. Shared coverage applies the proof to scans, authored-ID resolution, and strict
status admission without hydrating excluded rows. Health remains tracked, so widening policy or
renaming into an included path restores the incomplete result. Arbitrary source predicates without
an explicit path proof stay conservative. Ordinary UI queries keep their existing empty-source
behavior. Accepted bytes settle only their current acquisition. Verified repository installs supersede older acquisitions, while previews
and rename relocation cannot clear unresolved health. Confirmed deletion and bootstrap pruning
remove health even when a file had no tasks.

Integration observations have their own revision, scan generation, scope revision, and effective
semantics revision, independent of Search and UI notifications. Policy refresh marks coverage
unsettled before awaiting reads. Subscription registration returns the current state atomically;
ordered notifications isolate subscriber failures and respect unsubscribe. Rename notifications
wait for synchronous canonical relocation and read admission, with coverage unavailable during
that transition. Counter exhaustion fails the integration read state with a sanitized diagnostic.
This capability reuses the index's accepted source records and does not activate Statistics.

`TaskIndex.statusReadBasis()` creates a temporary, operation-owned read lease for strict status
writes. The lease checks complete coverage, source policy, file identity, source observations, and
semantics. Repository guards run inside the existing synchronous writer before edits or no-ops;
strict requests cannot rebase or fall back to legacy arguments. Unsupported writer paths reject the
precondition. Ordinary commands retain their existing retries and result shapes.

`TaskApplicationService.mutateStatus` exposes a separate inward desired-state capability. It
reserves the existing dependency mutation queue once, admits an exact read lease, and dispatches a
guarded status edit without retry. Changed completion/cancellation operations use the existing
tracking service once, with the same lease, captured settings, and clock through every timer write.
Strict follow-up also captures whether the prepared main command lands on done or cancelled, so a
later catalog change cannot erase pending timers or turn an unfinished transition into a completion.
Ordinary follow-up continues to check the live catalog. Each edit requires the exact owning root and
node; a failed lease prevents further writes and
cannot acquire a successor. Semantic completion uses the
current status catalog and authored cancellation marker. The transient semantic transition intent
reaches recurrence generation and its completion stamp handling. Already-complete and exact configured
same-symbol requests still pass through the repository guard as no-ops. The service returns the
lease's final occurrence proofs before disposal. Main status results remain separate from tracking
details, which retain the last proven root, closed and unclosed counts, discarded entries, and
partial or unknown outcomes. The application captures pending timer counts before dispatch. If a
confirmed retained status write fails publication before tracking starts, it reports that skipped
work as partial; an unexpected failure after tracking starts reports unknown effects. Historical
confirmation never resumes timer writes, and removed originals and transitions without required
tracking acquire no tracking warning. A no-op status request does not close timers. Ordinary UI commands
keep their existing result shapes and follow-up behavior.

[`TaskStatusReadLease`](src/tasks/infrastructure/TaskStatusReadLease.ts) advances only from a trusted
operation-tagged acceptance of its exact pending full-source candidate. Repositories supply the
original and newly created recurrence owner coordinates before staging. The lease validates those
roles against accepted witnesses and follows them independently through timer edits, including two
occurrences in one root. Its inward listener runs before outward callbacks. It retains exact settled
acquisition tokens for its lifetime so delayed health notifications cannot invalidate already-proven
reads. Source health retains only overlapping acquisition cohorts until acceptance or invalidation;
a newer unconfirmed read grants no authority. An unrelated source failure stops later writes while
retaining unaffected occurrence proofs. Pathless source bookkeeping events revalidate only the
retained exact addresses against their accepted owner and current canonical roots. Later source
invalidation clears those proofs without following another operation's successors. Disposal releases
the subscription and pending bytes.

Occurrence collection activates synchronously on the inward read port. It retains no second task
index. Authority staging carries frozen continued, removed, and created witnesses with an opaque
operation token. Staging checks source-backed physical endpoints; acceptance checks their exact
canonical predecessor and successor addresses. Invalid or ambiguous evidence invalidates affected
addresses without claiming removal. Replacement file owners invalidate previous addresses even when
bytes match. Unchanged exact occurrences reserve their own endpoints and cannot be claimed by a
continuation from another occurrence. Duplicate echoes cannot recreate occurrences, and restoration
revokes forward semantics.

Ordinary task-line edits and comment/tracking splices carry physical node mappings from the editor.
The repository binds those mappings to minted candidate revisions before staging. Recurrence uses
its actual completed and active subtree coordinates: Keep continues every history node, Delete
removes every old selected node, and the next subtree consists entirely of created occurrences.
Ancestors and containing siblings follow the verified line transform. UI successor ordering stays
independent. Unsupported structural changes remain conservative invalidations.

Owned host rename preserves occurrence identity across exact confirmed content and rechecks source
exclusions. When policy or Statistics requires a reload, a transient rename operation borrows the
old canonical roots until its exact acquisition settles. It defers semantic disposition only; health
and existing UI timing remain unchanged, and old addresses are undisclosable while absent. Matching
bytes under the same file owner establish continuation before accepted callbacks. Changed, failed,
replaced, or superseded reads invalidate those predecessors and release the proof. External deletion
invalidates before callbacks; recreation cannot revive a previous owner. Unique byte-identical
same-file relocation reuses the existing reconciliation proof. Duplicate or visual matches do not.

Loaded observations, metadata observations, repository installs, and rename relocation share a
synchronous accepted-install boundary. Repository batches prepare and prove every file before
installing any roots. Once all roots and source health are installed, inward accepted listeners
receive exact accepted bytes, owned file identities, and settled acquisition tokens before held
health, Search, Statistics, or UI callbacks can read those roots. Previews publish no acceptance.
Nested accepted installations deliver their evidence in order to every listener. Integration reads
remain incomplete while newer installed roots await semantic delivery; the latest accepted event
can hydrate its own roots synchronously. Held notifications retain their acquisition evidence and
original listener audience; subscribers already advanced by acceptance receive the current complete
observation rather than an older
revision. Accepted source evidence is transient and never enters public task DTOs.

Edits preserve unrelated Markdown and identify the actual authored block or occurrence. Rendering,
matching text, file/line position, and link labels confer no write authority.
[`TaskRefAuthority`](src/tasks/infrastructure/TaskRefAuthority.ts) distinguishes occurrences and
records proven successors without adding identity metadata to notes. Each write requires a fresh,
unambiguous source match. Descendants retain their root and full ancestry.

The repository installs committed content before returning. A conflicting cache observation must
be confirmed by a fresh vault read before replacing it. Accepted reconciliation publishes a signal
even when tasks are unchanged or absent; `ProjectStore` waits for it before combining frontmatter
with task statistics. One failing subscriber cannot block other subscribers or that barrier.

### Commands and recovery

[`TaskApplicationService`](src/tasks/application/TaskApplicationService.ts) captures the clock and
behavior settings, validates commands, and delegates writes through ports. Conflict, invalid input,
missing or ambiguous targets, partial transfers, and I/O failures return structured outcomes.
The initiating presentation boundary reports them. A retry retains the operation's source proof
and policy; it cannot silently acquire a different target.

[`taskFileMutationQueue`](src/tasks/infrastructure/obsidian/taskFileMutationQueue.ts) orders
repository transactions, publication, and cleanup per App and path. Moves and archives prove the
destination before removing the source. Recovery compensates only exact content still owned by
the operation. Multi-note changes are not crash-atomic and can leave partial or unknown outcomes.
Archive batches retain a frozen destination and an outcome for content outside ordinary queries.

[`TaskHierarchyService`](src/tasks/application/TaskHierarchyService.ts) owns reparenting and
promotion. Same-note edits use one transaction; cross-note edits write the destination first.
Supported internal references are rebased; unprovable cross-note syntax is rejected. Inbound links
outside a moved subtree remain unchanged. Selection handoff follows the hierarchy outcome, not
line coincidence.

Explicit root deletion alone may remove an empty source note matching the current configured
`taskFilePath`, including valid historical date expansions. Other content, invalid frontmatter,
completion deletion, subtask deletion, and transfers have no such cleanup authority. Removal uses
Obsidian's deletion preference after fresh content and file-identity checks. The host has no
compare-and-trash API, so an external edit can still race removal. Cleanup failure reports a warning
on the successful task deletion; it does not retry or roll back that deletion. Undo cannot guarantee
recovery of a removed note.

### Capture and input

Capture owns a retained create session with destination, date, template, insertion policy, and
behavior settings. Planning and canonical previews do not write.
[`NoteTemplateService`](src/notes/NoteTemplateService.ts) prepares the destination at execution and
coordinates preparation of the same path. Uncertain preparation requires fresh proof before retry.
The application owns prefix, Inbox, and tag policy; presentation supplies typed input. Current source
exclusions still apply when a retained session writes.

Quick capture freezes its civil-time reference and smart-input preference on meaningful input.
The composition root injects offline English/Russian recognition and recurrence parsing through
`TaskInputServices`. Pure input models preserve raw text, manual choices, protected source ranges,
and occurrence-specific suppression. Canonical preview and submission share the same frozen policy;
recognition cannot consume protected Markdown or invent an authored title. Other capture surfaces
retain their existing capabilities. Recognition and draft state are transient.

A submitted request is frozen separately from newer input. Known unchanged failures permit explicit
retry; unknown outcomes require the user to inspect the destination before repeating. Blur never
retries a failed write. Shared capture interaction ownership settles nested drafts before submission
and retains the session across remounts. Kanban's optional initial status is validated during the
single creation transaction, without a second status write.

### Dependencies, recurrence, and time

Tasks-compatible `🆔` and `⛔` carriers are the dependency record. The index derives a graph from
persisted nodes and current status semantics, excluding recurrence forecasts.
[`TaskDependencyService`](src/tasks/application/TaskDependencyService.ts) revalidates exact targets,
graph constraints, and completion blockers at the write boundary. Linked-child creation writes the
child and edge together; mutation coordination is shared across service instances.

Nested time-entry lines are the sole tracked-time record. Invalid entries remain visible but do
not contribute totals. [`TimeTrackingService`](src/tasks/application/TimeTrackingService.ts) shares
dependency mutation coordination. Starting a timer closes other running entries before opening it.
Completion/cancellation closes affected subtree timers in a follow-up write using the captured
clock. A failed follow-up leaves the status and prior timer writes committed. Strict follow-up
stops on the first failure across the subtree; ordinary follow-up still sets aside unwritable
entries and reports through existing diagnostics. Its failed-pass result continues to suppress the
short-entry notice, while strict details report whether a short entry was discarded. Manual
status edits do not trigger writes. Recurring successors start without prior tracking entries.

The plugin-owned [`TimeTrackingReminder`](src/ui/timeTracking/TimeTrackingReminder.ts) observes
public active-entry queries independently of panel mounting. Its static interval preference lives
in `data.json`; deadlines and delivered intervals remain transient. It schedules one upcoming
boundary for the current running entry and skips missed boundaries on startup or visibility return.
The owning document supplies visibility and trusted interaction events. Unload removes listeners
and pending work before the task index is destroyed. [`ReminderAudio`](src/ui/timeTracking/ReminderAudio.ts)
synthesizes the short local signal, bounds audio activation, suspends hardware between sounds, and
releases its context on disable/unload. Sound failures leave tracking and textual notices available.

Recurrence forecasts are bounded derived values with no direct write authority. Edits resolve the
persisted source through existing adapters. The domain owns recurrence parsing, canonical English
labels; invalid stored rules remain visible as authored. Timing normalization
applies to creation and explicit timing edits; reads and unrelated edits preserve legacy values.

## Search and read models

[`TaskSearchService`](src/tasks/infrastructure/search/TaskSearchService.ts) is one lazy, plugin-owned
service. Consumers own requests, cursors, and subscriptions; shared preparation and recovery survive
an individual caller's cancellation. Worker execution has an inline fallback and bounded recovery.
Unload disposes Search before TaskIndex. The inward
[`MiniSearchTaskEngine`](src/tasks/infrastructure/search/MiniSearchTaskEngine.ts) is the only
MiniSearch import boundary. The internal
[`TaskSearchWorkerHandler`](src/tasks/infrastructure/search/TaskSearchWorkerHandler.ts) owns
request decoding, first-init epoch selection, FIFO dispatch, and sanitized replies. The production
bootstrap and controlled tests share the Worker handler and runtime; the harness controls cloning,
delivery, and selected backend completion timing. The bootstrap reports failed transport through a
sanitized Worker error, including maintenance replies sent outside request processing. The existing
parent error boundary owns recovery. The runtime lives for the Worker's lifetime.

TaskIndex owns source generations, exact compact addresses, and a separate semantic revision for
status changes. Hydration returns detached roots/nodes in bounded batches and rejects stale
addresses. Search never uses write-reconciliation authority to revive a stale hit. Worker messages
contain search documents and compact results, not task references or source-bearing snapshots.

Root Search can match across descendants. Node search normally uses the node's title and tags;
Tasks Filter opts into subtree matching and then applies list membership and organization. Project
Filter and Global Search retain root populations. Nonempty Tasks Filter exposes outermost eligible
exact nodes, retaining nested matches as context rather than promoting ineligible ancestors.
[`searchMatchPolicy`](src/tasks/domain/searchMatchPolicy.ts) and
[`markdown/searchText`](src/markdown/searchText.ts) define matching and visible-text provenance.

Retrieval, complete logical organization, hydration, and DOM mounting have separate lifetimes.
[`TaskSearch`](src/panels/center/TaskSearch.ts) joins query publication, dependency readiness, and
current render receipts before reporting completion. Scrolling changes demanded mounts, not the
query. Source changes, new input, cancellation, and disposal retire obsolete work. Mounted rows and
service cursors are bounded, though a matching tree may contain many context nodes.

The mounted `SearchStatus` owns accessible state and failure notices. Inward reads never create
Notices. Diagnostics omit query text, task content, paths, and arbitrary exception causes. Hidden
preparation failures stay quiet until an active surface needs feedback.

## Presentation and interaction ownership

[`PanelView`](src/views/PanelView.ts) owns AppState, the shell, panels, shortcuts, and their lifetimes.
It injects capabilities; child views do not create independent task writers or shell subscriptions.

| Owner                                               | Responsibility                                                                             |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| [CompactPaneAccess](src/views/CompactPaneAccess.ts) | Responsive pane access and local focus                                                     |
| [LeftPanel](src/panels/LeftPanel.ts)                | Navigation, counts, and tag/project creation routing                                       |
| [CenterPanel](src/panels/CenterPanel.ts)            | Modes, task contexts, queries, selection, hydration, capture, and shared card interactions |
| [RightPanel](src/panels/RightPanel.ts)              | Inspector commands, drafts, recovery, Undo, history, and result ordering                   |
| [TaskModal](src/ui/TaskModal.ts)                    | The same inspector with local AppState in a native Modal                                   |
| [CalendarSettingsTab](src/settings/SettingsTab.ts)  | Settings staging, persistence, retry, and semantic rebuild                                 |

Task surfaces reuse `TaskCommands`, `TaskMenus`, `CaptureSessions`, `ListViewControls`, and
[`TaskCardRenderer`](src/panels/center/TaskCardRenderer.ts). The shared
[`taskContextMenu`](src/ui/taskContextMenu.ts) receives exact nodes and surface-owned actions.
Descendant actions target that node; CenterPanel owns bulk routing. Inspector owners render and
invoke retained callbacks while RightPanel keeps submission and recovery authority.

RightPanel keeps submitted targets and values separate from newer live input. Continuation, focus,
and selection after a write require command-specific successor proof. Unproved drafts stay with
their original owner; guarded Undo/history cannot overwrite external edits. Later user navigation
and selection take precedence over delayed callbacks. Cancellation after submission does not cancel
the submitted write. Project navigation settles the active project editor before changing mode;
invalid drafts retain the current view.

[`TaskListStatusPublication`](src/panels/task-list/TaskListStatusPublication.ts) holds presentation
through a captured status/card press, menu, drag, and command, including an intervening inspector
save. Queries remain live. Advancing the actionable subject requires exact source continuity or a
proven command successor. This proof lasts only for that interaction; external replacement, semantic
change, navigation, cancellation, or owner loss revokes it.

[`RetainedTaskText`](src/ui/retainedTaskText.ts) and
[`renderTaskText`](src/ui/renderTaskText.ts) own field rendering through Obsidian MarkdownRenderer,
the source path, and finite Components. Receipts settle after current Markdown and link wiring are
ready. Replacement/disposal invalidates old callbacks. Editable links require whole-field alignment
and exact authored occurrence proof; highlighting and excerpts add no write authority. Shared
[WikiLinkSuggest](src/ui/WikiLinkSuggest.ts) owns completion UI only for its editor's lifetime;
existing capture and inspector commands still persist the draft.

Each surface uses its owning document/window and retires listeners, observers, timers, frames,
subscriptions, and Components on hide, disposal, or window migration as appropriate. Retained
controllers keep drafts while native resources remount. Interaction leases, Obsidian Scopes, and the
shared shortcut router respect editors, IME, and nested surfaces. Native Modal Back first dismisses
its newest nested surface; focus returns only to a connected opener still owned by the interaction.
Obsidian owns the mobile keyboard inset.

## Task collections and Calendar

[`taskNodeMembership`](src/task-lists/taskNodeMembership.ts) supplies shared membership. Lists and
tags can include roots and descendants by their own metadata; untagged Inbox admits roots only.
Project collections and Global Search retain roots. Temporal lists apply status and lifecycle dates;
Scheduled contributes independently of Start/Due. Sidebar counts deduplicate active physical nodes
independently of saved center filters.

[`taskOccupiedDates`](src/tasks/domain/taskOccupiedDates.ts) describes inclusive Start/Due ranges
or distinct authored points for calendar geometry. Occurrence completion capability is
separate from the physical node. Grouping may display that node more than once: logical keys identify
rows, while commands identify source nodes. Selection and keyboard ranges follow complete logical
order; counts and bulk writes deduplicate physical targets. Selection survives only exact identity
or proven source transitions. PanelView invalidates civil dates without writing Markdown.

[`TaskListSurface`](src/panels/task-list/TaskListSurface.ts) mounts bounded keyed rows over
[`RowViewport`](src/panels/virtualization/rowViewport.ts). DOM owns geometry, focus, and active
interaction pins; logical rows own order and selection. Current render receipts authorize geometry.
Source replacement, owner changes, and disposal revoke stale measurement and interaction authority.
Scroll anchors and exact reveals yield to newer user scrolling and focus.

Tasks List, Kanban, and Timeline share this surface and card renderer. Kanban owns status-column
geometry and per-column viewports; offscreen viewports release unpinned rows while retaining columns.
Column order comes from configured status order. Drops change the captured task or selected batch
through existing status commands. Task ranks and source-order writes are not introduced. A successful
single drop reveals its committed node after publication; bulk drops provide column feedback.

Timeline maps Start/Due to a range and Scheduled to a separate marker; malformed ranges retain their
authored values. Shared project axis, navigation, geometry, and pointer components drive the view.
The task adapter captures canonical references and submits one guarded date patch through
`TaskCommands`. Moving an open range preserves absent endpoints. CenterPanel retains queries,
selection, hydration, and receipts; layout scroll anchors remain session state. Timeline owners
share [`projectTimelineViewport`](src/projects/projectTimelineViewport.ts) and preserve the logical
center through refresh, resize, and window migration. Their frame owners rebase bounded physical
tracks and compensate native horizontal scroll without rebuilding task cards or project models.
Initial focus waits for usable geometry and yields to later reveals or user scrolling; explicit
Timeline entry centers Today.

The project dashboard embeds this same task shell. ProjectsPanel owns project details, while
CenterPanel supplies the note-scoped task context. Preferences share `project:<path>` with Tasks'
project list; dashboard queries remain independent session state per path. Source-note metadata is
suppressed only when a task's source matches the current project. Leaving the dashboard releases
its task interactions, capture, search, and selection.

CalendarMode owns period, selected day, forecasts, and view lifetime. Its occurrence projection is
shared by full and constrained layouts. `CalendarCommands` maps gestures to public commands;
`CalendarEditQueue` orders pointer/keyboard writes and advances sources only through whole-tree
owned-change proof. Failed or unproved receipts invalidate dependent queued edits. Temporary
planning previews never grant replacement-source authority or change stored planning themselves.

Calendar publication holds retain the physical gesture target through native activation and
submitted preview settlement. Explicit cancellation and owner changes retire pending gestures.
Forecast edits resolve their persisted source without granting forecast status/drag identity.
Capture retains its frozen date and draft through publications and width/date changes, mounting
only when its destination context is visible.

## Projects

[`ProjectStore`](src/projects/ProjectStore.ts) evaluates configured membership from paths, tags, and
frontmatter, then combines reconciled tasks into statistics. Its cache is derived.
[`ProjectManager`](src/projects/ProjectManager.ts) owns creation and guarded metadata writes; task
moves use TaskApplicationApi.

[`projectFields`](src/projects/projectFields.ts) owns case-insensitive lookup, exact source binding,
and the shared catalog. Project status is a configured frontmatter property with literal definitions,
independent of tags. Curated types are fixed. Custom definitions and presets are static configuration,
independent of column visibility and native discovery. Native adapters suggest types/values without
changing Obsidian's registry. Ambiguous or unsupported bindings preserve data and make affected roles
read-only. Removing a definition does not delete note metadata; derived statistics remain read-only.

[`projectTableModel`](src/projects/projectTableModel.ts) supplies shared search, typed filtering,
sorting, grouping, and counts. Pure models receive explicit time and data. The retained
[`ProjectsTableView`](src/panels/projects/ProjectsTableView.ts) shares toolbar, field rendering,
editors, action sequencing, render gates, and clipboard logic across Table, Kanban, and Timeline.
Surfaces retain separate organization, selection, and viewport state. Logical cells drive keyboard movement,
selection and reveal across windowed DOM. Clipboard content conveys values, not write authority.

[`ProjectsPanel`](src/panels/projects/ProjectsPanel.ts) owns one shared
[`ProjectMutationSession`](src/projects/ProjectMutationSession.ts) for its mounted lifetime.
ProjectStore allocates verified source-observation revisions. The panel-owned session retains those
observations and revisions, orders shared field edits, Timeline/history mutations and dashboard-header
status actions, and owns copied receipt projections. Header status actions retain their existing
non-history behavior. Creation uses its existing manager path. ProjectStore observations reach the
session directly, including while the table DOM is detached. The table adapts session changes to its
existing editor, drag, and pending-render gates; the dashboard reads the same projections. Disposal
clears transient projections and retires queued session work and callbacks. Active writes may finish
without publication or refresh into a replacement panel. ProjectManager retains write authority and
serializes metadata operations per App. Transactions
recheck field/type binding, source key, property presence, and expected value. Queued status writes
also retain the chosen definition's meaning. Batches return applied/failed receipts. Successful
receipts project immediately until verified source observations acknowledge or supersede them;
ordinary refresh cannot discard them. Rename, deletion, and membership loss retire affected paths.
[`ProjectEditHistory`](src/projects/projectEditHistory.ts) uses bounded session receipts for guarded
Undo/Redo while preserving external edits and bindings.

Project Kanban ranks are saved view state. Drops validate group meaning, write metadata, and change
rank only after success; filtering preserves hidden ranks. Timeline preview and persistence share
one endpoint plan and validate both endpoints together. Surfaces use bounded geometry and pin active
editors/gestures. Shared `TimelinePointerInteraction` owns native gesture lifetime;
`timelinePresentation` shares axis/scale-button rendering. Active and submitted pointer previews
retain calendar ranges and reproject into the current window on rebases, cancellation, or failed
writes. Row and dashboard boundary affordances use the exposed date viewport independently of the
larger physical buffer. Adapters retain their own source and write authority.

Dashboard properties reuse [`projectTableCells`](src/panels/projects/projectTableCells.ts), presets,
and `ProjectCellEditor`. `createFieldEditorSession` captures effective type and exact source state,
then submits through the shared mutation session and ProjectEditHistory. This also owns inline checkbox and
list changes. The dashboard owns finite Markdown, popover, and editor resources and retains active
anchors and focus on refresh. Its floating field editor belongs to the properties menu's focus
scope; value changes keep both surfaces open. Configured empty properties stay available for editing.

`ProjectDashboardTimeline` reuses the task Timeline axis and shared interaction components. Its
project endpoint edits use the shared mutation session, ProjectManager guards, receipt projection,
and ProjectEditHistory. Project range changes never derive task dates or add task metadata.

Creation shares NoteTemplateService and retains the owned path/failed phase for recovery. Status
renames coordinate metadata and settings writes, compensating only owned values. Recovery across
notes and settings is best effort and not crash-atomic.

## Analysis and Statistics

[`TaskStatisticsSource`](src/tasks/application/TaskStatisticsSource.ts) is a separate retained read
capability. Its first subscriber activates
[`TaskStatisticsProjection`](src/tasks/infrastructure/TaskStatisticsProjection.ts); its last releases
extra evidence and pending work. Permitted archive evidence uses the canonical codec without entering
ordinary task, dependency, tracking, or reference-authority indexes. Tightened policy removes
forbidden cached evidence immediately.

Failures retain last-good permitted evidence and expose coverage issues. Ready means acquisition
settled, not complete coverage. Transfer publication holds prevent intermediate copies from appearing
as completed observations; partial transfers expose actual retained copies without content
deduplication. Statistics and ProjectStore settlement support coherent observations.

Pure [`src/statistics/`](src/statistics/) receives explicit time, calendar, projects, and scope.
Physical nodes preserve live/archive provenance, date issues, and their own tracking entries.
Open/aging/dependency populations use live records; historical metrics may include archives. Coverage
is independent of totals; chart caps do not remove underlying evidence.

[`StatisticsMode`](src/panels/statistics/StatisticsMode.ts) subscribes while visible and owns session
choices, preparation, diagnostics, and retry. Charts are staged before replacing last-good content.
[`TanStackStatisticsChart`](src/panels/statistics/TanStackStatisticsChart.ts) is the sole TanStack
Charts import boundary and cannot select/classify sources. Evidence mounts shared cards for exact
live nodes; archive rows can only open a verified retained source.

## Settings and compatibility

[`SettingsPersistenceCoordinator`](src/settings/persistence.ts) serializes `data.json` and adjacent
`state.json` through composition-root ports. One composed CalendarSettings object is the runtime
authority. The composition-root static port confirms host writes by JSON readback before coordinator
deduplication advances. Static and view-state saves remain separate. Status changes rebuild task catalog,
registry, and index semantics together. Navigation, search choices, drafts, gestures, history, and
Analysis state remain transient.

Saved views write schema 2 and read schema 1/legacy data. Migration retains a recovery snapshot,
writes and verifies the envelope, then cleans moved static keys. Recognized state wins over legacy
copies. Missing state after migration uses defaults without recapturing stale keys. Corrupt,
unreadable, or future-version state stays untouched: view writes suspend and temporary defaults are
used, while static saves preserve guarded legacy fields. Older schema-1 binaries suspend writes to
schema 2; re-upgrading restores those views.

Each saved `ListViewState` can choose a layout and independent Kanban/Timeline organization. Explicit
property filters are shared; effective layout settings preserve List preferences. Malformed layout
preferences recover independently. Ordinary saves preserve unknown static and nested view extensions.
Detached writes queue in order. Their latest staged envelope supplies extensions for subsequent
snapshots; completion cannot replace newer intent, and a rejected write does not block later operations.

Deleting a status definition removes its exact saved visibility, collapse, rank, and task-filter
references, while preserving unrelated state and authored note values. Static definitions are saved
before cleaned view state. Retryable failures retain the current draft and offer retry; these separate file
writes are not a transaction. Unknown raw project statuses remain independent values.

[`settingsSaveFailure`](src/settings/settingsSaveFailure.ts) owns transient failure and Retry feedback.
Calls sharing an explicit owner and action coordinate settings failure feedback; unscoped calls
retain independent feedback. Retry invokes the retained latest save callback. Within that state,
dismissal retires feedback before the host hides its Notice; stale hides and save completions cannot
replace current feedback. Successful saves stay silent. SettingsTab renders draft changes while
visible, independently of save completion.

[`ViewStatePathOwner`](src/settings/ViewStatePathOwner.ts) forwards note rename/delete events to the
persistence coordinator, which rebases both runtime preferences and their retained raw extensions;
PanelNavigator owns session navigation. [`tagViewState`](src/settings/tagViewState.ts) preserves raw
view entries and unknown fields through tag rename and rejects conflicting destinations before vault
writes. [`TagManager`](src/tags/TagManager.ts) owns tag configuration and global rename. Discovered
groups remain derived until configured. Navigation archives change visibility without task writes.
Shared [`tagSyntax`](src/markdown/tagSyntax.ts) defines Unicode/nested-tag validity and case identity;
writes preserve authored spelling.

Archive-path/source-exclusion changes form one validated draft; only successful persistence changes
effective policy. Versioned custom-property definitions prevent rediscovery from undoing explicit
schema choices. Unsupported versions preserve data and disable schema edits. Persisted-contract
changes require migration, fallback, and rollback design. Presentation convenience alone cannot
justify new task metadata.

Shared Markdown and task-domain readers retain separate dependencies and agreement tests. Source
and shipped code avoid regex lookbehind for older iOS engines.
[`obsidianMoment.ts`](src/obsidianMoment.ts) is the host Moment import boundary; its callable-type
correction preserves Obsidian's runtime instance.

## Architecture checks

| Contract                                   | Enforcement                                                                                                                                     |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Import direction and public task consumers | [Dependency rules](dependency-cruiser.config.cjs), [architecture tests](test/architecture-boundaries.test.ts)                                   |
| Text-write acquisition                     | [Exact storage roster](test/architecture/storageAuthority.ts), [audit](test/storage-authority.test.ts)                                          |
| Settings ownership and migration           | [Key classification](test/architecture/settingsOwnership.ts), [coordinator tests](test/settings-persistence.test.ts)                            |
| Pure models and native lifetime            | [ESLint rosters](eslint.config.mts), [project policy](eslint-project-policy.mts), [lifecycle tests](test/project-owner-lifecycle.test.ts)       |
| Host compatibility                         | [Lint parity](test/obsidian-lint-parity.test.ts), [community review](test/store-review.test.ts), [artifact tests](test/build-artifacts.test.ts) |
| CSS scope, tokens, and runtime variables   | [CSS policy](tooling/css-policy.mjs), [finite contracts](tooling/css-contracts.mjs)                                                             |

New write acquisitions, settings keys, pure modules, and dynamic CSS contracts require exact roster
entries and tests. Fix violations at their source. Styles use plugin-owned scopes and semantic host
tokens. Static checks cannot establish every capability flow, native lifetime, layout, or contrast.

`pnpm verify` is the authoritative full gate; `verify:task` supports iteration. CI/pre-push use
[`verify-changes.mjs`](tooling/verify-changes.mjs); behavior, tooling, and uncertain history require
full verification, including authored and freshly built artifact CSS. See [AGENTS.md](AGENTS.md)
for workflow and native UI requirements, and [PERFORMANCE.md](PERFORMANCE.md) for performance work.

Update this document when ownership, public boundaries, dependency direction, critical data flow,
or persisted authority changes. Algorithms and local rendering details belong in source and tests;
proposed architecture belongs in ignored design specs.
