---
name: handling-plugin-failures
description: Defines the user-facing error boundary and diagnostic logging for a new failure-prone operation. Use for a new user-triggered or background operation that could fail without a clear message, an existing silent catch or unhandled rejection, or a new boundary with no established failure-handling pattern yet. Not for routine I/O that repeats an already-established project pattern.
---

# Handling Plugin Failures

A plugin runs on someone else's machine with no server, no metrics, no
dashboards — the only diagnostic channel is whatever the user pastes into
a GitHub issue. AGENTS.md already rules out phone-home telemetry, so this
comes down to: the user sees that something went wrong and why, and a
developer reading the bug report has enough to reproduce it.

## When to use

Required when at least one of these is true:

- a new user-triggered operation could finish without a clear message on failure
- a new background operation could fail without updating visible state or logging diagnostics
- existing code has a silent `catch {}` or a promise with no `.catch`
- the new failure boundary has no established project pattern to follow yet

**Not required — do not activate for:**

- a vault/file/network operation that repeats an already-established project pattern
- a task whose error boundary is already defined in the plan or an approved `Interfaces` block
- a mechanical change that doesn't alter failure behavior

## One user-facing error boundary

Every user-triggered operation (a command, a settings action) has exactly
**one** layer responsible for a `Notice()` — normally the top of the call
stack (the command handler), not every function it calls:

```typescript
// Low-level: propagates, doesn't catch-and-toast.
async function loadFontsFrom(folder: string): Promise<FileStat[]> {
  return this.app.vault.adapter.list(folder);
}

// The command handler is the one boundary that knows this was user-triggered.
this.addCommand({
  id: 'apply-font-settings',
  callback: async () => {
    try {
      await loadFontsFrom(this.settings.fontFolder);
    } catch (error) {
      new Notice(`Could not apply font settings: ${error instanceof Error ? error.message : String(error)}`);
    }
  },
});
```

Word the `Notice()` like an on-call runbook line: what was attempted, what
specifically failed — not "An error occurred."

## Lower layers propagate or recover

A lower-level function has three legitimate options, and "catch, show a
`Notice()`, and return as if it worked" is none of them:

- **Propagate** — no `try`/`catch`; let the caller decide.
- **Enrich and rethrow** — catch only to attach context the caller
  couldn't reconstruct, then `throw` again.
- **Fully recover** — catch, handle it completely, and continue for real.

## Background failures must not be silent

A background operation (periodic sync, file-watcher callback) has no
single user action to attribute a `Notice()` to, so it isn't required to
show one — but it must still update whatever visible state reflects it
(a status bar item) and log diagnostic detail. Never just swallow it.

## Diagnostic logging

Use `console.error`/`console.warn`/`console.debug` (the only methods
`eslint-plugin-obsidianmd` allows) for what a toast is too small for —
prefix with the plugin id so it's greppable, and include what a
maintainer needs to reproduce it (the input that failed), not just the
exception message:

```typescript
console.error('[your-plugin-id] Failed to parse font manifest', { path, cause: error });
```

Gate step-by-step tracing behind a settings toggle rather than always
emitting it.

## No telemetry

No metrics backends, dashboards, or crash reporters — a plugin has
neither the backend nor (per this template's privacy stance) permission
to phone one. An opt-in, explicitly-disclosed analytics feature is a
`source-driven-development`-grounded decision on its own, not something
this skill covers.

## Verification

- [ ] Every user-triggered operation has exactly one user-facing error boundary
- [ ] Its `Notice()` names what was attempted and what failed
- [ ] Lower-level functions propagate or enrich-and-rethrow — none catches, shows a `Notice()`, and returns normally
- [ ] No silent `catch {}` and no unhandled promise rejection
- [ ] Background operations without a direct user action update visible state and log diagnostics instead of failing silently
- [ ] No new telemetry, analytics, or crash-reporting network call was added without disclosure
