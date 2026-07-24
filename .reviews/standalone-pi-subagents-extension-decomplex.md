# Decomplex review: Standalone Pi Subagents Extension

## Overall status

Two supported simplifications preserve all required behavior: collapse three one-purpose helper modules into their owning boundaries, and remove a redundant Herdr preflight call. The lifecycle/tool/UI boundaries and focused validation are otherwise proportionate.

## Review contract

| Axis | Selection |
|---|---|
| Mode | Prevention |
| Target | `.plans/standalone-pi-subagents-extension.md` |
| Authority / required behavior | User-approved standalone four-tool RPC extension, simple profiles without capability settings, all-settled waits, cancellation/cleanup, reminders, Pi inspection, and optional lazy Herdr tail viewing; explicit lean/simple constraint |
| Scope | Proposed source boundaries, runtime layers, optional Herdr flow, and validation burden |
| Report | `.reviews/standalone-pi-subagents-extension-decomplex.md` |

## Coverage

### Inspected

- Outcome, in/out boundaries, architecture, all six tasks, automated/manual validation, and deferrals.
- Prior-art decisions for the old RPC skill, Herdr-first package, dashboard, Pi extension/RPC APIs, and Herdr CLI.
- Proposed module boundaries, lifecycle states, transcript ownership, wait/cancel semantics, and optional viewer fallback.

### Skipped or partial

- No source exists yet, so implementation-level duplication and dependency weight cannot be measured.
- Exact package naming/versioning is intentionally left to implementation and does not affect complexity.

## Potential findings

### DEX-001 — Avoid one-purpose launch, transcript, and reminder modules

- **Evidence:** Supported
- **Recommendation:** Act
- **Surface and location / authority:** Proposed `src/launch.ts`, `src/transcript.ts`, and `src/reminder.ts` in T2/T4; user requires a lean implementation.
- **Current-need evidence:** Each proposed file has one owning caller/boundary: child launch/transcript projection belong to the RPC child; reminder rendering belongs to extension lifecycle wiring.
- **Added burden:** Extra public/internal APIs, files, imports, and ownership decisions before any reuse exists.
- **Reachable practical impact:** Implementers can spend time designing wrappers and tests around pass-through seams, while lifecycle behavior is split across more locations.
- **Smallest simpler alternative:** Keep launch argument construction and transcript projection as local helpers in `src/rpc-child.ts`; keep reminder formatting as a local pure helper in `extensions/subagents/index.ts`. Extract only if implementation produces independent reuse or an unmanageable file.
- **Exception / boundary check:** Preserve `rpc-child` versus `runtime`, and `ui` versus `herdr`; those are real process/lifecycle and optional-integration boundaries.
- **Required behavior and simplification risk:** No behavior changes. The only risk is file growth, which can be reassessed from actual code rather than predicted.
- **Bounded next step or user question:** Amend starts-at paths and key-file table; do not create the three helper modules initially.
- **Acceptance signal:** Initial implementation has `profiles`, `rpc-child`, `runtime`, `tools`, `ui`, `herdr`, and extension entry boundaries only, unless concrete code evidence justifies another extraction.

### DEX-002 — Attempt the lazy Herdr operation directly instead of preflighting

- **Evidence:** Supported
- **Recommendation:** Act
- **Surface and location / authority:** T5 requires environment detection plus a successful CLI check before `herdr agent start`; Herdr is optional and Enter-triggered.
- **Current-need evidence:** The actual `agent start` request already proves binary/socket/session compatibility and returns the required pane ID or a useful failure.
- **Added burden:** One extra subprocess, separate timeout/error path, and a check/use race on every first inspection.
- **Reachable practical impact:** Slower Enter behavior and more branches/tests without improving correctness; Herdr can disappear after the preflight anyway.
- **Smallest simpler alternative:** Gate only on the required Herdr environment, attempt `herdr agent start` directly, parse its returned ID, and fall back to the Pi overlay on any failure.
- **Exception / boundary check:** Keep opaque-ID parsing, exact owned-pane cleanup, and fallback; these protect real ownership and optional-operation boundaries.
- **Required behavior and simplification risk:** Preserves lazy hybrid behavior and makes failure handling more direct. Error messaging may be less tailored, but the command result can supply the reason.
- **Bounded next step or user question:** Remove the preflight requirement and corresponding test expectation.
- **Acceptance signal:** First Enter performs at most one Herdr create command before either focusing the pane or opening the Pi detail overlay.

## Confirmed proportionate areas

- Four model-facing tools with multi-wait folded into status rather than a fifth wait tool.
- Direct non-detached child ownership instead of the old control-socket supervisor and recovery journal.
- Human transcript retained only for the parent session.
- Transient context reminders instead of compaction catalogs or automatic result turns.
- CLI-backed optional Herdr viewer instead of a versioned socket client.
- Four focused automated test files plus two bounded manual flows; excluded matrices and real-provider CI remain appropriately out of scope.
- Explicit settled-state classification, cancellation, and cleanup are lifecycle invariants rather than optional hardening.

## Limitations

- Source-level complexity must be reassessed after implementation; this prevention pass cannot prove future file size or duplication.
- Hard-crash cleanup remains an explicit product limitation, not a complexity finding, because cross-session recovery was intentionally deferred.
