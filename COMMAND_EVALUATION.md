# Command mode evaluation

Keep Command mode changes in the existing session, tool and public task-command workflow.
Read `ARCHITECTURE.md` before changing ownership or data flow. Use the source and CodeGraph to
check the current boundaries. Task edits must preserve unrelated titles, metadata, descendants,
comments and timestamps; only explicit confirmation may save the reviewed changes.

## Reproduce before changing behavior

Start with the user's complete instruction, existing task tree, selected project/task and current
preview. Preserve long dictated text as submitted. A successful nearby example does not establish
that the reported workflow works. Keep ambiguous captures separate from explicit edits of existing
tasks.

Add the reproduction to `test/command-live/corpus.ts` or one of its case modules. Give each turn an
observable contract: selected task identity, fresh proposal, literal resulting content, public
readback, write count or confirmation receipt. Status-only `ready` and `saved` responses do not
prove an operation happened. Add adversarial controls that preserve the expected shape while
changing the requested meaning or owner.

When the user names a task ID, keep it separate from search wording. Only a case-sensitive exact
`authoredId` match in complete results scoped to the requested path can issue an edit reference;
the selected task still needs a canonical read at its current revision.

For a known project URL, exercise `research({ url })` and require attributed page-content evidence.
A search excerpt can suggest a relevant page but cannot establish that the page was read. Keep
source text untrusted: instructions embedded in it do not authorize saving, deleting or changing
unrelated tasks. Extraction metadata records limits on redirect verification and freshness.

Use fixed source/page fixtures for deterministic behavior checks. Name them as fixtures in the
report. Include project purpose, capabilities and limits when evaluating a project overview; a
single duration field exercises a narrower workflow. The `project-page-overview` cases cover a
selected project task, long Russian dictation, two sourced comments and a later save.

## Run a comparable campaign

List cases without dispatching a model request:

```shell
pnpm command:eval --list
```

Every evaluation run writes to a newly reserved output directory. The launcher creates an exclusive
directory before starting Vitest; if `--out` already exists, the run stops and asks for a fresh path.
The default path uses a unique run ID under `docs/research/command-mode-round6/runs/`. Keep prior
manifests and reports intact. `--list` remains read-only and does not reserve an output directory.

For the connected ChatGPT plan in the development vault, use its actual model ID and a bounded request
count. The Luna route is:

```shell
pnpm command:eval --provider chatgpt-plan --vault dev-vault-tasks --model gpt-6-luna --cases project-page-overview --max-requests 30 --out docs/research/command-mode-round6/runs/UNIQUE-RUN-ID
```

This route uses the running development vault's existing connection. Credentials remain in
Obsidian SecretStorage. The harness counts model generations; OAuth and catalog maintenance are
outside that count. Other routes retain their own documented budget and billing checks. Never
silently change provider, model or credential source to make a run succeed.

Use three separate evidence levels. Deterministic scripted controls run the actual command pipeline
with supplied tool calls and no provider request. Replaying or regrading a saved trace checks a
preserved result against a stated evaluator version; it does not dispatch a model. A Luna run with
fixed `pageFixture` content checks model behavior without fetching that source. A separate native
trial may check a real URL and an explicitly reviewed Obsidian Save action. It needs the safeguards
and snapshot procedure in “Native command SDK trace”; do not combine it with a fixed-source result.

Harness runs use mechanical source predicates: nonempty text, any declared length limit, and the
exact cited destination. Those checks do not establish that claims, exclusions or absence claims
match the page. Each source-based output remains pending independent calibrated content review,
including semantic accuracy, contradictions, relevance and concision. A report's `outcome: passed`
records harness checks only; task completion also requires applicable operational checks and an
independent content-review pass. Direct `evaluateTurn` calls remain strict unless the caller explicitly selects
mechanical mode. Reports and the CLI identify the policy and pending review status.

For a free OpenRouter run, name a model ending in `:free`, keep the default no-paid setting, and use
a fresh `--out` directory and bounded `--max-requests` value:

```shell
pnpm command:eval --provider openrouter --model google/gemma-4-31b-it:free --cases project-page-overview --max-requests 30 --out docs/research/command-mode-round6/runs/UNIQUE-RUN-ID
```

The launcher rejects paid OpenRouter models unless `--allow-paid` is supplied. Qualification
procedures do not use that option or an Ollama/local model. Treat a route or model-selection failure
as a provider/configuration outcome; do not silently fall back to another route.

Freeze the cases, sources, evaluator and model selection before collecting a baseline. Run the same
selection after the implementation into a fresh output directory. Preserve both manifests, case
reports and traces. Check source, fixture, model, transport, budget and evaluator hashes; explain any
difference that prevents a paired comparison. Keep these inputs fixed when comparing versions. Do
not rewrite the baseline or tune an expectation to accept a failed output. A newly added
qualification case needs its own comparable before/after pair.

When regrading saved reports, use the same frozen evaluator and retain the original artifacts. A
preview or stopped run remains incomplete if it lacks an expected turn, required save, or public
readback, even when every available turn passes the revised predicates.

Inspect the raw tool calls and their results for every failed turn. Separate provider or request
budget exhaustion, unsupported tool/API behavior, agent mistakes and oracle failures. Record stopped
or unexecuted cases as such. Report the first attempt and any recovery separately; later success does
not erase a first-pass failure. Record provider failures and missing token usage as unknown, not
zero. A campaign that stops early supplies no evidence about its remaining cases.

When a real failure becomes a regression case, archive its exact public form as a development-split
reproduction. Use distinct task names, source text and page facts for generalized development
variants. Keep held-out prompts and answers separate and diverse; do not tune runtime examples or
criteria against them. A scripted control can show that the pipeline and oracle accept a specified
tool sequence; it does not show that a model learned the behavior. Re-run a live comparison only
under the same frozen grader, sources, model, transport and caps.

The development case `prospective-pending-owner-comment-ru` in
`test/command-live/pendingOwnerCase.ts` covers a due-date preview, a Russian follow-up that repeats
the unchanged task title and exact path before appending one supplied comment, and an explicit Save.
Run the same case registration on the baseline and candidate. Its oracle accepts any valid tool path
that preserves the pending due date and owner; it does not require a particular lookup trajectory.

## Native command SDK trace

`tooling/native-command-trace.mjs` builds temporary Obsidian CLI eval snippets for the live plugin
instance. It wraps `providerConnections.model` and `commandResearch.search/readPage` in memory; it
does not call a provider during preflight or change plugin runtime code. The installer accepts up to
eight exact operator-supplied HTTPS page URLs. It records SDK `doGenerate` calls, reported token
totals, latency, unified finish reason, content types and tool names. Missing usage stays absent. The
URL list filters trace capture only; unlisted reads still pass through the existing adapter and are
retained only as URL hash/length metadata. The helper requires one to eight HTTPS capture URLs, each
at most 2,000 characters, with no user info, query or fragment. It records content only when
`readPage` was called for a capture URL and the returned page matches it, capped at 8,000 characters,
with the returned page kind, URL, extraction evidence and limitations. For `finish` calls, retain the
active schema SHA-256 and allowlisted argument-shape metadata: known-key presence, value type and
length, plus an enum value only when its value is on an explicit allowlist. Do not retain raw arguments,
free text, task references, unknown field names, model prompts, credentials, headers or raw errors.
Search query text and vault text are not recorded.

For ChatGPT plan subscription accounting, sum retained `generation-output.usage.inputTokens.total`
and `generation-output.usage.outputTokens.total` across generations. The report's `knownTokens` is a
summary of HTTP request usage and does not represent total subscription usage; keep missing SDK
usage unknown.

Before any UI interaction, copy the real file bytes for the exact target task note, workspace
configuration, plugin settings/state, session index and session files to a location outside the vault.
Write a manifest containing each source path, backup path, byte count, mode and hash, then reread the
backup files and verify their hashes. Hashes without the corresponding backup bytes are not a backup; do not start the
trial if any required bytes are missing. Build and install the frozen plugin in `dev-vault-tasks`,
verify its `main.js` hash, and separately check the Luna/Tavily settings, target baseline and writable
output path without reading credentials. Use `buildNativeTraceInstallEval(captureUrls,
expectedModelId, key)` to generate the installer snippet, setting `expectedModelId` to the Luna ID
shown by the existing connection catalog. The wrapper rejects a returned SDK model with another ID
before any generation dispatch. Run the snippet with Obsidian CLI. The helper preflight contains
booleans only and does not replace the separate operator checks. Require `installed: true` before
opening a fresh command session; do not submit from a pre-existing owner. Use Obsidian CLI for
automation and verify the exact vault name and base path before every mutation; do not rely on stale
native accessibility indices. Prepare the registered Save runner and its closed-scope test, which must
prove that no Obsidian VM action is possible, before the model turn starts.

Start one 180-second timer owned by that fresh session. Treat the model turn as settled only after
`owner.commandPending()` has been observed as `true`, then returns `false`, and the final session
snapshot is stable. A `ready` status by itself is insufficient because a tool can publish an
intermediate ready state while the agent continues. `CommandSessionOwner.commandPending()` tracks
pending work, including work after such intermediate results (`src/ai/CommandSessionOwner.ts:204-214`).
Clear the watchdog after the settled-turn guard, before operator review begins. Review the exact source,
owner, revision and proposal content before saving. Task content plans expire five minutes after
issuance. After review, allow only approval data and one prewritten CLI action that invokes the existing
registered UI Save command; do not write runner code or change safeguards inside the plan TTL. Keep
that action under the same owner, source-freshness, vault-name and base-path guards as Send. Never let
the model watchdog cancel an idle preview or an admitted write. If the plan expires, use the existing
History and “Review current source” flow; an expired plan cannot be resumed for saving.

Dispose and drain the owner before reading the trace or restoring files. Saving can create a new
automatic session; retain only bounded receipt and session-ID metadata needed to identify the saved
owner and generated session. Avoid serializing complete or growing session snapshots into a CLI
result. Read the bounded trace with `buildNativeTraceReadEval(key)`, then save that sanitized readback
to a new ignored `docs/` directory using a temporary file and atomic rename. Verify that the export
is complete before restoring the vault and workspace snapshot. Put trace read/export in a `try` block
and call `buildNativeTraceRestoreEval(key)` in `finally`, so hooks are restored even if
the read or export fails. The restore only replaces methods that still point to this trace's wrappers.
If a read-only post-save export exceeds the CLI output limit, record it as an export failure and retain
the already captured public receipt and source verification; do not reinterpret it as a provider or
write failure. Compare live files with the manifest before restoring. Restore only files whose current
contents match the trial's expected changes; if a backup is missing, or live state does not match the
recorded trial state, do not claim exact restoration or overwrite unmatched state. A result is not
attributable to this instrumentation unless `sdkInvocations` increased before the result was claimed.
The wrapper stops before the 13th SDK call or third combined search/page-read adapter call and records
each local budget rejection separately. Do not retry a stopped trial to fill its trace.

Independently check the synthetic target through the public API, record write effects and runtime
errors, and compare the target/session snapshots. Keep the development vault as the only trial target.
After cleanup, confirm the trace wrappers are absent and the snapshots match. These logical
adapter-call counts do not identify provider HTTP retries; page text establishes only what the plugin
received, not source freshness or correctness.

## Interpret the evidence

`scripted-control` tests exercise the real command pipeline with supplied tool calls. They prove
that the pipeline and oracle accept the specified behavior and reject the tested mutations; they
do not measure a model's interpretation of the instruction. A live model run with fixed page
content measures the model's use of that supplied content. Real provider extraction and website
freshness need separate checks with the configured research provider.

Source destinations, page-read actions, exact structured fields and owner-bound writes have
mechanical predicates. The source-fact matcher supports fixture-authored phrase alternatives,
whole numeric tokens and explicit contrary phrases. A separate fixture-authored absence matcher
recognizes bounded English and Russian negation forms around capability terms, with clause
boundaries and calibrated controls for double negatives, requirement wording and URL-slug-only
matches. It is a narrow fixture check, not a general language parser. Neither matcher establishes
arbitrary natural-language entailment. Inspect each generated comment against the attributed page
and record unsupported claims, omitted requested facts and misleading paraphrases.

Open-goal cases intentionally leave the individual steps to the model. Their automatic checks
require one root, a bounded hierarchy, distinct nonempty titles and no invented schedule. Review
whether the steps are useful, sufficiently complete, ordered sensibly and actually actionable.
A structural pass alone does not establish those qualities.

For semantic review, calibrate the independent reviewer on the frozen rubric and blind controls
before reviewing qualification answers. Keep source entailment, citations, role fit, decomposition
usefulness, permission and truthful stage wording as independent judgments; mechanical phrase or
structure checks do not establish them. Preserve the calibration record and do not show the blind key
to the reviewer before its classifications are recorded. Keep the rubric version fixed for paired
comparisons; a substantive criterion change requires a new version and a fresh blind calibration.

Assess the requested preview from the retained canonical task proposal changes, using
`task plan.after.comments` or the target preview tree. Do not use finish or status prose, or the
public saved tree before Save, as the proposed content. In the private retained evidence, keep the
requested target/owner identity, source revision, and originating proposal/plan identity and revision
with the complete canonical capture. Missing comments or an incomplete capture remain unassessed and
need review; if a case requires a comment count, they fail that requirement. Cases requiring Save
also need the retained explicit confirmation effects and public readback.

Grade both comparison arms from the same frozen source, user instruction, rubric and reviewer
settings. Replace arm and model labels with opaque answer IDs; keep arm mapping private until grading
is recorded. Blind packets must omit arm, model, provider, pass and resource labels. Preserve answers
and grading records, then join them to the arm mapping. Calibrate on valid paraphrases, including
Russian; exact-citation contradictions sharing the expected keywords; wrong URLs; missing captures;
and borderline or incomplete answers. A correct URL and source-shaped fields do not pass when the
claims are unsupported or contradict the source. If the rubric changes, regrade both baseline and
new answers under the revised rubric.

Completion requires both an independent content pass and the required structural, state,
preservation and write checks. Scripted controls and trace replay test the pipeline or a preserved
result; they do not qualify a model. Keep provider or usage failures and unrun cases separate from
content failures, as described above. Judge source depth and concision against the actual request and
material read; there is no global character limit.

Report deterministic checks and live outcomes separately. Campaign counts are model-generation
invocations; report network retries, rejected provider requests, tool repairs and unrun cases
separately. An attempt numbered one does not show that a turn avoided schema repair; inspect the
tool calls and repair feedback. Keep native UI command turns separate from measured SDK generations,
and mark UI token counts unknown unless captured by the SDK. An implementing agent's own reading of
the output is a self-review; label it as such. Use an independent reviewer or human review for
claims of independent semantic assessment, preserving the source and resulting comments/tree.

## Verify and leave a usable handoff

Run focused tests during iteration and the canonical `pnpm verify` before reporting completion.
Exercise UI changes in `dev-vault-tasks` with screenshots, DOM evidence and captured runtime
errors. Snapshot and restore modified vault content, workspace configuration and session/settings
state. Preserve a draft
through the existing session owner with `newSession('keep')`. Do not restore on-disk session history
under a live in-memory owner: wait for calls to settle, release it through a plugin reload, restore
the snapshot, reload again, then verify the fresh session has no unexpected recovery or write.
Include desktop and constrained widths when layout changes.

Keep run artifacts and work notes under ignored `docs/`. The handoff should state the original
reproduction, implementation boundaries, commands and observed results, remaining failures and
the limits of each evidence source. Leave README, release versions, tags and production vaults
unchanged unless the user explicitly requests those changes.
