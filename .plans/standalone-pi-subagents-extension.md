# Standalone Pi Subagents Extension

> **Status:** Ready for implementation

## Outcome and boundaries

- **Problem and target:** Build a standalone Pi package that replaces the current `use-pi-subagents` script skill and the future-deleted `pi-subagents-herdr` package with a lean extension-backed subagent runtime. The parent can start, inspect, continue, wait for, and stop headless Pi RPC children; users can inspect readable progress in Pi or, when already running inside Herdr, in a lazily opened tail pane.
- **In scope:**
  - Exactly four model-facing tools: `subagent_start`, `subagent_status`, `subagent_send`, and `subagent_stop`.
  - Bundled `scout`, `research`, and `worker` profiles plus flat user overrides; profile data is only `name`, `description`, and the Markdown body used as the child system prompt.
  - Children receive Pi's normally available tools, skills, and extensions, including project resources allowed by the normal saved trust decision. The package self-disables in children to prevent recursive subagents; child launch uses no session persistence or context files, and RPC remains non-interactive without suppressing approved resources.
  - Background starts, foreground starts, non-blocking status, and one blocking status call that waits for every requested run to reach any settled output state.
  - Idle follow-ups, active steering/follow-up messages, execution deadlines, non-destructive wait deadlines, and explicit per-run next actions.
  - Human-readable transcripts derived from RPC events; raw JSONL is never shown in the Pi or Herdr inspection UI.
  - A below-editor run box, `/subagents` selection overlay, readable Pi detail overlay, and optional lazy Herdr `tail -F` pane.
  - Escape cancellation, parent-session shutdown cleanup, transcript retention for the parent session, and transient open-run reminders before every parent LLM call (therefore also after compaction).
  - A bundled parent-only skill that requires polling/joining, output handling, stopping children, and parent-owned Git/worktree integration and cleanup.
- **Out of scope:**
  - Profile or runtime tool configuration/allowlists; model/thinking configuration in profiles.
  - Extension-managed Git, branches, commits, worktrees, merges, or workspace cleanup.
  - Automatic result injection or automatic idle-run cleanup; idle children stay available for follow-ups.
  - Cross-session adoption/recovery, journals, recovery locators, durable artifacts, a separate `clean`/`recover` tool, or a Unix control-socket supervisor.
  - Herdr-required operation, interactive child agents in Herdr, direct input through viewer panes, global Herdr agent discovery, or hardcoded Herdr socket protocol support.
  - Real-LLM/real-Herdr automated suites, exhaustive process-signal matrices, protocol fuzzing, or niche smoke coverage.
- **Approach:** Spawn each child as a directly owned, non-detached `pi --mode rpc` process with piped stdin/stdout. A small internal RPC transport sends commands, handles strict JSONL events and headless extension UI requests, classifies generations at `agent_settled`, and appends a bounded human transcript. One in-memory runtime registry owns current-parent runs; stopped runs leave that registry while transcript files remain until parent-session shutdown. Pi hooks provide reminders and cleanup. Herdr integration shells out through the installed `herdr` CLI only when Enter is pressed on a selected run, avoiding a second lifecycle implementation and protocol-version coupling.

## Key files, evidence, and decisions

| File or source | Why it matters | Decision or plan impact |
|---|---|---|
| `package.json` | New repository/package entrypoint | Declare one extension (not a static skill), include extension/source/profiles/skill in published files, require Node 22.19+, and provide `typecheck`, `test`, and `check` scripts. |
| `extensions/subagents/index.ts` | Parent-only Pi integration | Early-return on the child marker; otherwise register four tools, parent-only skill discovery, lifecycle hooks, reminder injection, widget, and `/subagents`. |
| `src/profiles.ts`, `agents/*.md` | Profile contract | Load bundled profiles and deterministic user overrides from `${getAgentDir()}/subagents/agents/`; accept only `name`, `description`, and non-empty body. No profile/runtime tool path exists. |
| `src/rpc-child.ts` | Headless child transport and readable event projection | Spawn direct RPC children, respond safely to extension UI requests, expose prompt/steer/follow-up/abort/stop, and translate text/tool/lifecycle events into a human transcript. |
| `src/runtime.ts` | Four-tool lifecycle semantics | Own runs/generations, waits, deadlines, output classification, cancellation scope, next actions, and transcript retention without journals/recovery machinery. |
| `src/tools.ts` | Model-facing contract | Strict schemas and responses for start/status/send/stop; status supports multi-run all-settled waiting. |
| `src/ui.ts`, `src/herdr.ts` | User inspection | Below-editor box and selectable overlay always work; Herdr is a lazy CLI-backed transcript viewer and never controls the child. |
| `skills/use-pi-subagents/SKILL.md` | Parent orchestration policy | Replace the script instructions with the four-tool workflow and mandatory supervision/Git/worktree cleanup rules. Register only through the parent extension so children do not receive it. |
| `/Users/maximilianschwarzmuller/.nvm/versions/node/v26.1.0/lib/node_modules/@earendil-works/pi-coding-agent/docs/{extensions,rpc,packages,skills,usage,tui}.md` | Authoritative installed Pi APIs | Use `registerTool`, tool `AbortSignal`, `context`, `agent_end`, `session_shutdown`, `resources_discover`, `setWidget({ placement: "belowEditor" })`, and `ui.custom({ overlay: true })`; RPC settles at `agent_settled`. |
| `/Users/maximilianschwarzmuller/.nvm/versions/node/v26.1.0/lib/node_modules/@earendil-works/pi-coding-agent/dist/modes/rpc/rpc-client.js` | Reference RPC process lifecycle | Reuse its small direct-spawn/request/event shape, but own the transport because the stock client does not answer `extension_ui_request` and assumes a package-relative CLI path. |
| `/Users/maximilianschwarzmuller/development/projects/maxed-skills/skills/use-pi-subagents/{SKILL.md,references/rpc-lifecycle.md,scripts/subagents.mjs,assets/}` | Existing headless lifecycle and policy | Preserve assignment discipline, generation semantics, settled-state caution, explicit cleanup, and parent-owned VCS; do not port the six-command CLI/control-socket implementation or tool restrictions. |
| `/Users/maximilianschwarzmuller/development/os/pi-subagents-herdr/` | Existing full extension prior art | Reuse only package/profile/tool/widget/hook patterns; omit Herdr control plane, worktrees, journals, recovery, artifacts, and automatic settlement cleanup. |
| `/Users/maximilianschwarzmuller/development/projects/academind-agent-skills/pi/extensions/subagent-dashboard/` | Existing selection overlay prior art | Adapt its compact widget/overlay interaction, but select only this runtime's runs and create a viewer lazily. |
| Herdr 0.7.4 installed CLI/schema and `/Users/maximilianschwarzmuller/development/os/herdr/{SKILL.md,website/src/content/docs/socket-api.mdx}` | Herdr capabilities and version-safe integration | A live check proved `herdr agent start ... -- tail -n +1 -F <transcript>` displays appended human lines. Use CLI-returned opaque IDs and close only viewer panes created by this extension. |

## Tasks

#### T1 — Scaffold the standalone package and simple profiles

- **Change:**
  - Create the TypeScript Pi-package skeleton, scripts, peer/dev dependencies, publish file list, README placeholder, and MIT license.
  - Declare only `./extensions/subagents/index.ts` under `pi.extensions`; do not statically declare the skill because the child copy of the extension must be able to withhold it.
  - Implement deterministic profile loading for bundled `scout`, `research`, and `worker` Markdown plus whole-file user overrides under `${getAgentDir()}/subagents/agents/`.
  - Validate lowercase kebab-case name, bounded non-empty description, no unknown frontmatter fields, and non-empty system-prompt body. Do not define, parse, pass through, or document tool/model/thinking profile configuration.
  - Write concise profile prompts that preserve bounded assignment, no recursive delegation, evidence-based handoff, and parent-owned Git/worktree responsibilities as policy rather than capability restrictions.
- **Starts at:** `package.json`, `tsconfig.json`, `src/profiles.ts`, `agents/scout.md`, `agents/research.md`, `agents/worker.md`, `tests/profiles-launch.test.ts`
- **Verify:**
  - Run `npm install`; expect a clean install with only Pi peer/dev packages, TypeBox, TypeScript, and the test runner needed by package scripts.
  - Run `npm run typecheck`; expect zero TypeScript errors.
  - Run `node --import tsx --test tests/profiles-launch.test.ts`; expect valid bundled/user override discovery and generic rejection of unsupported/malformed frontmatter.
- **Risk/recovery:** Keep profile discovery flat and load-on-activation; no watcher or project-profile layer is needed. A profile load error must name the offending file and fail activation rather than silently changing agent behavior.

#### T2 — Implement the minimal RPC child and human transcript

- **Change:**
  - Implement a direct, non-detached child process wrapper around the resolved Pi executable with strict LF-delimited JSON parsing and correlated command responses.
  - Launch with inherited parent provider/model/thinking and `--mode rpc --no-session --no-context-files --system-prompt <private-profile-file>`; intentionally omit `--no-approve`, `--tools`, `--no-skills`, and `--no-extensions` so normally available approved capabilities load while RPC remains non-interactive.
  - Set a package-specific child environment marker; the extension entrypoint must return before registering tools, skill, UI, or hooks when this marker is present.
  - Handle `prompt`, `steer`, `follow_up`, `abort`, process stop, process exit, and `agent_settled`. Auto-cancel child extension dialogs (`select`, `confirm`, `input`, `editor`) and ignore non-interactive UI updates so a headless child cannot hang awaiting UI.
  - Create one private parent-session transcript directory and one run file. Project assistant text deltas, concise tool start/end/error lines, generation boundaries, and lifecycle/error lines; never append raw RPC records or thinking text to the human view.
  - Expose the latest complete/partial assistant text separately from the transcript, and bound text returned to tools/UI while always returning the full transcript path.
- **Starts at:** `src/rpc-child.ts` (keep launch/transcript helpers local until reuse justifies extraction), `tests/rpc-runtime.test.ts`
- **Depends on:** T1
- **Verify:**
  - Run `node --import tsx --test tests/profiles-launch.test.ts tests/rpc-runtime.test.ts`; expect fake-child coverage to prove launch flags/environment, command correlation, dialog cancellation, human event projection, settlement, process exit, and bounded stop behavior.
  - Inspect the transcript fixture output; expect readable lifecycle/tool/assistant lines and no serialized RPC envelopes or thinking deltas.
- **Risk/recovery:** Do not copy the old control socket or persistent process identity system. The runtime owns the exact `ChildProcess`; stop uses RPC abort, closes stdin, waits briefly, then terminates only that owned child if needed. Unexpected hard parent termination relies on the non-detached pipe/EOF relationship; cross-session orphan recovery is explicitly deferred.

#### T3 — Implement lifecycle, four tools, waits, and actionable results

- **Change:**
  - Define run states `starting`, `running`, `idle`, `failed`, `timedout`, `blocked`, and `stopped`; only `starting`/`running` are active, while every non-stopped run remains visible and requires explicit disposition.
  - Treat `agent_settled` plus the final assistant evidence as the classification boundary: normal final text becomes `idle`; explicit errors become `failed`; execution-deadline abort becomes `timedout`; abnormal or incomplete settlement becomes `blocked` rather than false success.
  - Implement `subagent_start({ profile, task, cwd, wait?, executionTimeoutMs? })`; async is default, while foreground waits for that run's settled output and still returns `needsStop: true`.
  - Implement `subagent_status({ ids?, wait?, waitTimeoutMs? })`; no IDs lists all open runs, IDs snapshot selected runs, and `wait:true` requires non-empty IDs and waits for every selected run to settle without fail-fast. Wait expiry returns `waitTimedOut: true` plus every current snapshot and leaves children running.
  - Implement `subagent_send({ id, message, behavior?, wait?, executionTimeoutMs? })`; an idle send starts the next generation, while a running send requires `steer` or `follow-up` and remains part of the active generation/queue.
  - Implement `subagent_stop({ ids })`; independently stop/clean each requested run, close owned viewers, remove stopped runs from reminders/widget, and retain transcripts until parent-session shutdown. Unknown/failed IDs must not prevent other requested IDs from being handled.
  - Standardize every tool result with state, generation, profile, cwd, complete or partial output, error/reason, transcript path, `needsStop`, and a state-specific `nextAction` (`wait`, `inspect/retry`, `send`, `stop`, or retained-cleanup warning).
  - Use fresh internal cancellation signals for cleanup. Esc during a blocking start/send/status stops only still-running runs in that wait scope; already-idle runs remain available. A normal wait timeout never stops a child.
- **Starts at:** `src/runtime.ts`, `src/tools.ts`, `tests/rpc-runtime.test.ts`, `tests/extension.test.ts`
- **Depends on:** T2
- **Verify:**
  - Run `node --import tsx --test tests/rpc-runtime.test.ts`; expect start async/sync, idle continuation, active steer/follow-up, all-settled multi-wait, non-destructive wait timeout, execution timeout, mixed per-run stop, and Esc cancellation with idle preservation to pass.
  - Run `node --import tsx --test tests/extension.test.ts`; expect exactly four registered tool names and strict schemas with no additional fields.
- **Risk/recovery:** Keep one generation model: idle prompts increment generation; active steering/follow-up does not. Do not add a fifth wait/clean/recover tool or background result injection. Parent polling remains explicit and the skill/tool responses must make that duty unavoidable.

#### T4 — Wire parent lifecycle, reminders, and cleanup

- **Change:**
  - In the extension entrypoint, register the four tools and discover `skills/use-pi-subagents/SKILL.md` only for the parent process.
  - Bind one runtime to the exact parent session and update the below-editor widget whenever runs change; clear all extension UI on shutdown.
  - Add a `context` handler that appends one transient, hidden custom message before every parent LLM call while open runs exist. Include ID, profile, state, generation, cwd, and the required next action, so the reminder naturally reappears after manual/automatic compaction without durable catalog machinery.
  - On an aborted parent `agent_end` (user Esc), stop currently running children owned by that session while preserving already-idle children and their output. Make this idempotent with tool-level AbortSignal cleanup.
  - On `session_shutdown` (`quit`, `reload`, `new`, `resume`, or `fork`), stop all open children including idle ones, close owned viewer panes, and remove the transcript directory only after every child is proven exited. Retain and report the path when cleanup is ambiguous.
  - Do not auto-clean on ordinary parent settlement and do not inject background child results to trigger new parent turns.
- **Starts at:** `extensions/subagents/index.ts` (keep reminder formatting local), `tests/extension.test.ts`
- **Depends on:** T3
- **Verify:**
  - Run `node --import tsx --test tests/extension.test.ts`; expect parent registration, child-marker no-op, parent-only skill discovery, transient reminder content/removal, widget refresh, Esc running-only cancellation, and full shutdown cleanup to pass.
- **Risk/recovery:** The context reminder is deliberately recomputed, not journaled. If the Pi process is killed without lifecycle hooks, no extension can guarantee graceful cleanup; direct non-detached children and closed pipes are the fallback, while durable crash recovery remains out of scope.

#### T5 — Add selectable Pi inspection and lazy optional Herdr panes

- **Change:**
  - Render a compact bordered `belowEditor` box listing every non-stopped run with profile, short ID, generation, and active/inactive state; include `/subagents` as the inspection affordance.
  - Register `/subagents` to open a TUI overlay with current runs, up/down navigation, refresh, Escape, and Enter. Outside TUI mode, report that interactive inspection is unavailable while status tools remain functional.
  - Without active Herdr, Enter opens a live readable detail overlay backed by the bounded human transcript and current state.
  - Detect Herdr lazily from `HERDR_ENV=1` and the required pane/workspace/tab/socket environment. On first Enter, directly use `pi.exec("herdr", ...)` to start `tail -n +1 -F <transcript>` in a named split pane and focus the returned opaque pane/agent ID; the create command itself is the compatibility check, and later Enter focuses the existing pane.
  - If lazy Herdr creation/focus fails or the pane was manually closed, clear stale viewer ownership and fall back to the Pi detail overlay (one recreation may occur on the next Enter).
  - Close only viewer panes whose exact returned IDs are owned by this runtime, during explicit stop or session shutdown. Herdr absence/failure must never affect the RPC child lifecycle.
- **Starts at:** `src/ui.ts`, `src/herdr.ts`, `extensions/subagents/index.ts`, `tests/ui-herdr.test.ts`
- **Depends on:** T4
- **Verify:**
  - Run `node --import tsx --test tests/ui-herdr.test.ts`; expect widget presentation, overlay selection/detail, no Herdr calls before Enter, non-Herdr fallback, lazy create/focus reuse, stale-pane fallback, and owned-pane close to pass using fake UI/executor objects.
  - Manually run Pi with the local extension outside Herdr; start two fake-or-inexpensive real subagents, open `/subagents`, inspect readable live output, wait for both, send one idle follow-up, stop both, and verify the widget/reminder clears.
  - Manually run the same extension inside Herdr; press Enter on one run and expect one focused tail pane showing readable transcript lines rather than JSON, then stop the run and expect that exact viewer pane to close. Stop all started runs and development processes afterward.
- **Risk/recovery:** Use the installed Herdr CLI instead of coding its socket protocol, keeping support version-adaptive and optional. The viewer is read-only; communication remains through `subagent_send`.

#### T6 — Write the standalone skill/docs and validate the package

- **Change:**
  - Write the bundled skill as policy for the four extension tools: bounded assignments, explicit cwd/worktree preparation, async supervision, foreground and multi-run joins, state-specific handling, idle follow-ups, mandatory stop, parent verification/integration, and parent-owned worktree/branch cleanup.
  - State prominently that async children do not wake the parent automatically: the parent must poll or block with `subagent_status`, inspect every output state, and stop every run before completing the workflow.
  - Document execution timeout versus wait timeout and Esc behavior (running children in scope stop; idle children survive; session shutdown stops all).
  - Document profiles as name/description/body only, inherited parent model/thinking, normally available approved tools/skills/extensions, child self-disable, no context files, normal saved project trust in non-interactive RPC, and optional lazy Herdr viewing.
  - Complete README installation, tool examples, UI behavior, lifecycle/cleanup contract, macOS/Linux support boundary, security/trust note for unrestricted child capabilities, and explicit non-goals.
  - Keep tests to the four focused files created above; do not add real-provider CI, real-Herdr CI, recovery/worktree matrices, protocol fuzzing, or broad smoke suites.
- **Starts at:** `skills/use-pi-subagents/SKILL.md`, `README.md`, `package.json`
- **Depends on:** T5
- **Verify:**
  - Run `npm run check`; expect typecheck and all four focused test files to pass with no live model or Herdr dependency.
  - Run `npm pack --dry-run`; expect the extension, `src`, bundled profiles, parent skill, README, and license in the package, with tests/plans/reviews excluded.
  - Run `rg -n -- '--tools|--no-skills|--no-extensions|--no-approve' src agents extensions`; expect no matches, proving the child launch/profile path does not manage or suppress normally approved capabilities.
- **Risk/recovery:** Documentation is part of lifecycle safety because polling and worktree cleanup are parent obligations. Keep examples short and show the complete start → status/wait → optional send → stop sequence rather than isolated starts.

## Final acceptance

- **Checks:**
  - `npm run check` passes the focused automated suite.
  - `npm pack --dry-run` contains every runtime/profile/skill asset and no development-only artifacts.
  - Plain Pi manual flow proves async, foreground, multi-wait, readable overlay inspection, follow-up, Esc running-only cancellation, explicit stop, reminders, and widget cleanup.
  - Herdr manual flow proves lazy Enter-to-tail with human output and exact owned-pane cleanup; failure falls back to the Pi overlay without affecting the child.
  - Every subagent started during validation is stopped; no test processes, viewer panes, sockets, or worktrees remain.
- **End state:** A standalone, Herdr-optional Pi package exposes exactly four subagent tools, three simple/full-capability profiles, actionable all-settled supervision, compaction-safe reminders, readable inspection, and bounded parent/session cleanup without the old script or Herdr package.
- **Deferrals or blockers:** No implementation blocker. Cross-session crash recovery, Windows/remote-Herdr viewer support, interactive viewer input, automatic result turns, and extension-managed Git/worktrees remain deliberate non-goals until concrete usage evidence justifies them.
