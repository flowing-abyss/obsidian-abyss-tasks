# Native performance evaluation

Measure the production plugin in the real Obsidian desktop host and compare saved results. The
harness uses Obsidian CLI, Performance API, and Electron's Chrome DevTools Protocol connection.
It adds no packages or product behavior. Playwright, Appium, and device automation are not involved.

## Run and compare

Install repository dependencies and enable [Obsidian CLI](https://help.obsidian.md/cli). Open
**dev-vault-tasks**, bring its window to the foreground, and leave the vault idle during the run.
The running vault's canonical directory must also be named `dev-vault-tasks`. Use `--vault-path`
to require a particular checkout's dev vault. Other vaults are refused.

```sh
# One discarded warmup, 10 measured repetitions, one separate diagnostic pass.
pnpm run profile --out docs/performance/before

# After a code change, repeat under the same conditions.
pnpm run profile --out docs/performance/after --baseline docs/performance/before

# Offline comparison: no running Obsidian or rebuild needed.
pnpm profile:compare docs/performance/before docs/performance/after

# Plugin restart through index readiness in an already-running host.
pnpm profile:startup --runs 10

# More observations, or a separate narrow desktop workload.
pnpm run profile --runs 30
pnpm run profile --width 360 --out docs/performance/narrow
pnpm run profile --fixture wide-tree --anchor 2026-10-16 --out docs/performance/wide-before
```

Use **`pnpm run profile`**: `pnpm profile` is a pnpm built-in. Output directories must be new and
outside the vault. The default is a timestamped folder in ignored `docs/performance/`.
`--anchor YYYY-MM-DD` fixes generated dates; the default is the host's local day. The actual host
day also belongs to comparison identity because calendar and statistics views use it. `--runs`
accepts 1–100. `--fixture standard|wide-tree` selects a finite corpus; the default is `standard`. `--no-diagnostics` omits the CPU, trace, screenshot, and heap pass.

`--width` constrains the desktop renderer viewport through CDP, verifies it during every scenario,
and clears the override afterward. Close existing DevTools/debugger before using this mode so the
harness can own and restore that state. It does not test mobile Obsidian, touch, a slower CPU, or
Android/iOS. Compare matching widths; this mode keeps the debugger attached during timing.

Exit codes: `0` completed with no detected material regression, possibly **inconclusive**; `1`
execution/diagnostics/restoration failure; `2` incompatible inputs; `3` exploratory regression
signal. Read validity and verdicts instead of treating zero as proof that a patch is safe.

## Snapshot and scenarios

The deterministic corpus has 100 project notes, an inbox, and an archive: 4,000 live root tasks and
2,000 children (**6,000 live nodes**), plus 300 archived roots. It covers four statuses, dates spread
over a year, undated tasks, 200 short intervals, 200 recurring tasks, 1,000 dependency edges, tags,
rich descriptions, comments, 2,000 live time entries, and archived completion/time history.
Projects have statuses, date ranges, and budgets. Tests parse the corpus through the real TaskIndex.

The `wide-tree` corpus inserts 999 additional direct children immediately after Child 0 under
`profile-0` in Project-000. It retains the same files, 4,000 live roots, and 300 archived roots,
and has **6,999 live nodes**. Its widest root has 1,000 children with deterministic long titles.
`fixture.json` records the actual largest root byte size and maximum direct child count. The
standard corpus keeps its original Markdown bytes and digest for a given anchor. Fixture kind,
digest, counts, and scenario roster belong to comparison identity.

Temporary settings select the corpus for tasks and projects. Existing notes stay in place.
Startup still reads existing Markdown before applying source exclusion, so a content digest of
those notes belongs to comparison identity. This is not an empty-host benchmark.

| Scenarios                                        | Work and completion condition                                                                                                                                                                                                 |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `startup.index`                                  | Enable the plugin, join TaskIndex initialization, assert the selected fixture's exact root and node counts after readiness. Host and filesystem caches are warm.                                                              |
| `query.roots/nodes/dependencies/time`            | Public read projections; dependencies include first acquisition in the cycle.                                                                                                                                                 |
| `search.cold`                                    | Prepare the newly created Search service/Worker and await readiness; service-cold, not OS-cold.                                                                                                                               |
| `search.warm/no-results/subtree`                 | Open a cursor, read 40 hits, hydrate, and release it.                                                                                                                                                                         |
| `panel.first-open`, `ui.search/scroll/inspector` | Open the real panel, join applied search results, visit three changed/hydrated virtual ranges, and open a task.                                                                                                               |
| `ui.inspector.link-input`                        | Open the title editor, type five progressive wiki-link prefixes, await nonempty results with highlights matching each query, then cancel the draft.                                                                           |
| `ui.calendar.day/week/month`                     | Enter Calendar and switch views, checking the active view, complete visible date range, and populated cards or compact agenda. Day includes entering Calendar.                                                                |
| `ui.projects.table/kanban/timeline`              | Enter Projects and render its three views. Table includes entering Projects.                                                                                                                                                  |
| `statistics.acquire`                             | Subscribe to retained Statistics data, await settlement, reject projection issues.                                                                                                                                            |
| `ui.analysis.*`                                  | Rhythm, completion, deadlines, cohorts, allocation, timeline, sessions, patterns, movement, aging, dependencies. Await nonbusy content and rendering opportunities.                                                           |
| `search.edit-to-query`                           | After one untimed Project-000 title edit and Worker publication, append one inbox task and await its exact canonical acceptance, newer Worker publication, sole node-scoped query hit, current hydration, and cursor release. |
| `command.*`                                      | Create, edit, complete, comment, start/stop tracking, and advance recurrence through existing application commands; require successful receipts.                                                                              |
| `index.external-edit`                            | Modify the fixture inbox through the vault API and await its changed task projection.                                                                                                                                         |
| `index.wide-child-edit` (wide-tree only)         | Edit only the final wide child's title through the vault API; await that descendant with matching ancestry and exact root/node counts.                                                                                        |
| `index.metadata-only` (wide-tree only)           | Change Project-000's frontmatter budget, await accepted task metadata and a newer settled Statistics source, and verify task bytes/population stay unchanged.                                                                 |
| `panel.close`                                    | Detach the panel. The shared Search Worker may remain alive until plugin unload.                                                                                                                                              |

Wide index scenarios run before `search.edit-to-query`, while task population still matches the
generated fixture. Both full rosters then run `search.edit-to-query` immediately before
`command.create`. Startup-only mode runs only `startup.index` for either fixture.

`search.edit-to-query` primes only Project-000's root title from `Profile task 0 database` to
`Profile task 0 database abysssearchprime`, after the measurement boundary's frame settling and
before its observation and clock start. There is no frame or sleep between successful preparation
and the timed inbox append of `- [ ] abysssearchlatency sandbox`. The span ends after hydrating
the sole `abysssearchlatency` hit as the exact current inbox task and releasing its cursor.
Canonical acceptance alone cannot finish this sample. Preparation and action both use tracked,
bounded work; failure or cancellation unwinds subscriptions and aborts outstanding search work.
The existing unload/reset and transaction restoration own temporary fixture bytes.

Both publications must report `compatibility: false` through the public Search subscription. The
cursor must match the latest ready generation, newer than the priming generation, before and
after hydration. Any inline-ready, recovering, failed, or disposed transition invalidates the
Worker workload, even if it later returns to ready. Deterministic completed-work facts record one
priming edit, one measured edit, exact root/node counts plus one, one result and hydrated row,
current title/path/target and publication matches, and `backend: 'worker'`. Absolute generations,
durations, and incidental maintenance overlap stay out of these facts.

This measures end-to-end update visibility, including vault events, canonical acceptance, Search
publication, Worker queueing, query, and hydration. It does not isolate vacuum CPU or establish that
maintenance overlaps the next mutation. The public compatibility flag attributes each sample's
backend; the separate CDP diagnostic pass still owns Worker source and transport evidence.
Inline behavior needs separately labeled evidence and a matching protocol/backend for comparison.

Each repetition resets the modified inbox, Project-000 (including its children, recurrence, and metadata), and view state, then reloads the plugin.
Preparation joins host metadata events and checks exact file/cache contents before timing starts.
Scenario order is fixed. UI spans include two animation-frame opportunities; they are not OS
input-to-photon measurements. Scrolling also waits for changed, populated, nonbusy cards and a
stable range. A scenario or fixture change invalidates old baselines through the protocol hash.

## Read the evidence

Start with `report.md` or `summary.json`: per-scenario sample count, median, p95, median absolute
deviation, min/max, long tasks, frame gaps, DOM size, and completed-work facts. `run.json` preserves
all measured samples and identities: commit/dirty state, exact bundle hash, effective settings,
fixture, existing Markdown, host versions, CPU, viewport, locale, timezone, enabled plugin versions,
and protocol hash. `settings.json` contains the effective configuration, not just its patch.
`fixture-contents.json` preserves the generated Markdown; `fixture.json` records its hashes and counts.

Calendar completion accepts the existing month/time-grid dates and cards as well as compact date
buttons with a selected agenda. Completed-work facts record the same visible dates and canonical
semantic occurrence population in both forms; full-grid and selected-agenda card totals are not
compared as work. Canonical occurrence facts are collected after each timed calendar span using
the public query and existing occurrence projector. This extra evidence is outside the measured
duration. A zero-height hour grid is recorded as baseline evidence and does not fail a run.

Next read `diagnostics-summary.json`: source-mapped CPU hotspots by self/inclusive time and separate
renderer/Worker heap observations at Search readiness, after Analysis, and after panel close.
`cpu-summary.json` retains the complete frame table. CPU times are sample-weighted estimates from
a separate run, including profiling/host/harness overhead. Inclusive frames overlap; do not sum
parents and children. Only verified plugin frames receive the plugin source map.
Worker CPU recording begins after the standalone API search scenarios, before UI scenarios. It
covers UI search and subsequent work; cold construction and the standalone warm/no-results/subtree
queries have wall times but no Worker CPU attribution in this version.

| Artifact                                                          | Use                                                                                                                                                  |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `comparison.json/md`                                              | Compatibility reasons, median differences, confidence intervals, practical margins, verdicts. Written into the candidate directory.                  |
| `iteration-*.json`                                                | Raw spans; `-1` is the discarded warmup. Diagnostic samples are separate.                                                                            |
| `renderer.cpuprofile`, `worker-*.cpuprofile`                      | Load in DevTools' JavaScript profiler. Worker recording covers UI search and subsequent work, after the standalone API search scenarios.             |
| `trace.json`                                                      | Load in DevTools Performance. User Timing spans sit alongside JS, layout, paint, and GC events.                                                      |
| `main.js/map`, `search-worker.js/map`, `source-maps.json`         | Exact builds/maps and Worker prefix offset. Mapped main JS must equal normal production bytes; live Worker source must equal the saved Worker build. |
| `memory-*.json`                                                   | Whole-isolate JS heap, no forced GC. Not RSS, plugin-exclusive allocation, or proof of a leak.                                                       |
| `analysis.png`, `analysis-dom.json`, `runtime-errors.txt`         | Screenshot, DOM evidence, captured host errors.                                                                                                      |
| `calendar-day/week/month-dom.json`, `calendar-day/week/month.png` | Diagnostic calendar DOM, rendered-card counts, selected agenda date, rectangles and scroll dimensions, plus screenshots taken outside timed spans.   |
| `progress.json`, `failure-dom.json`                               | Last attempted scenario and failure context when the renderer can respond.                                                                           |
| `recovery.json`, `host-before.json`                               | Original managed bytes and native state for recovery.                                                                                                |

Long-task counts include entries of at least 50 ms overlapping a span; duration is clipped to
that overlap. They cover the renderer, not just the plugin. Unsupported metrics are `null`.
Frame gaps are a requestAnimationFrame proxy bounded by the span, not a dropped-frame count.
DOM size counts plugin-panel descendants. Use care interpreting sub-frame UI changes.

## Decide whether a change helped

Comparison rejects failed/unrestored runs, missing/duplicate scenarios, incomplete iterations,
changed environment/protocol/settings/corpus, and different completed-work facts. Different bundle
hashes are expected when testing an optimization. This scenario extension changes the protocol
hash, so apply the same tooling to both product checkouts and collect fresh runs under the same
host day, anchor, settings, viewport, diagnostic mode, and roster.

Preserve failed original-product wide runs as diagnostics. Do not remove scenarios, accept partial
iterations, filter failed samples, or repeat runs until a lucky pass. If the original wide workload
cannot finish, report that comparison limit. Complete standard comparisons and candidate-wide
correctness/latency evidence remain useful, but do not establish an original-wide latency result.
A separately labeled original-product-plus-maintenance-fix control can isolate other optimization
effects; it cannot replace the original-versus-fix latency comparison.

The comparator uses 2,000 deterministic bootstrap resamples for an exploratory, unadjusted 95%
interval of median difference. The practical margin is `max(5 ms, 10% of baseline median)`.
At least 10 observations per side are required:

- **improvement/regression:** the entire interval exceeds the practical margin in that direction;
- **no-material-difference:** the entire interval fits inside the margin;
- **inconclusive:** neither conclusion is established.

Below 30 observations, p95 is flagged as unstable. The full scenario comparisons have no multiplicity
correction. Thermal drift, GC, JIT, sync, and background applications can affect a whole batch.
Run A/A on unchanged code to learn the noise floor; confirm apparent wins/regressions in A/B/B/A
order on the same host. These are investigation signals, not automatic causal proof.

Choose a slow scenario from the summary, inspect its trace span and CPU frames, then add a workload
where evidence is thin: dense calendar overlap, large dependency components, different project
distributions, long sessions, or device interaction. Keep stress workloads separate from the
ordinary baseline. A 6,000-node fixture does not represent every 6,000-task vault.

## Restoration and failures

The transaction reserves a fixture directory and exclusive lock. It journals original bytes before
replacing installed plugin artifacts/settings. It restores those bytes, removes generated files,
restores layout/viewport/debugger state, and verifies the files. Existing notes and unrelated files
are not intentionally written. Do not edit the dev vault while the runner owns its temporary state.

Each evaluation launches its body once through a synchronous CLI acknowledgement. The renderer
publishes completion separately into a unique controller-owned directory in the OS temporary
folder, outside the vault. It writes only the serialized result or rejection, then renames the
staging file so the controller reads a complete envelope with the matching call identity. The
controller checks that file every 50 ms; it does not poll the renderer through CLI during native
scenario spans. The action is never replayed to recover missing output. Body rejections, invalid
results, delivery timeouts, and cleanup failures invalidate the run.

The controller aborts its CLI subprocess and removes the temporary directory on success, failure,
or the 120-second evaluation deadline. A queued launch checks that its pending file still exists
before starting. Completion can only open an existing staging file, so work that settles after
cleanup cannot recreate it. A non-cancellation publication error is logged in the renderer and a
missing completion fails the evaluation. Cleanup errors are reported; if an operation also failed,
both errors are retained. A force-killed controller can leave an OS temporary directory behind.

Ctrl-C requests cancellation between native operations and restoration afterward. A hung renderer
or force-killed controller can require recovery. Renderer timers cannot interrupt synchronous JS;
the evaluation deadline bounds the controller's wait, not an arbitrary plugin operation already
in progress. Serialization and result-file I/O occur after the body settles, outside its native
timing spans. They still add work between evaluations, so comparisons require matching protocol
hashes and fresh baselines. The result transport does not establish why an earlier CLI response
was missing after a completed operation.

```sh
# Responsive dev vault:
pnpm run profile --recover docs/performance/RUN

# Unresponsive host: close Obsidian completely, then restore files offline.
pnpm run profile --recover-offline docs/performance/RUN
# Reopen dev-vault-tasks, then restore its layout:
pnpm run profile --recover docs/performance/RUN
```

Offline recovery refuses a running Obsidian process. Recovery never converts a failed benchmark
into a successful one. Backups/traces stay local and may contain original settings or note text;
inspect before sharing. `docs/` is ignored and must not be committed.

## Implementation and references

`tooling/performance/runner.mts` owns orchestration; `native.ts` is a separate renderer bundle.
`AbyssProfiler` owns and cleans its Performance marks. CDP owns a secondary renderer session and
verified Search Worker sessions, preserving a preexisting root debugger. None of this is imported
by `src/main.ts`. `pnpm verify` remains the quality gate; native profiling is an explicit workflow.

Sources: [User Timing](https://www.w3.org/TR/user-timing/),
[Long Tasks](https://www.w3.org/TR/longtasks-1/),
[Electron debugger](https://www.electronjs.org/docs/latest/api/debugger),
[CDP viewport override](https://chromedevtools.github.io/devtools-protocol/tot/Emulation/#method-setDeviceMetricsOverride),
[CDP tracing](https://chromedevtools.github.io/devtools-protocol/tot/Tracing/),
[esbuild maps](https://esbuild.github.io/api/#sourcemap),
[Node SourceMap](https://nodejs.org/api/module.html#class-modulesourcemap).
CPU hotspot weighting follows the average-sample approach in
[DevTools' profile tree](https://github.com/ChromeDevTools/devtools-frontend/blob/main/front_end/models/cpu_profile/CPUProfileDataModel.ts).
