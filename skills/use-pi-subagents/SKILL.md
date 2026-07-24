---
name: use-pi-subagents
description: >-
  Pi extension launcher for bounded scout, research, and worker subagents via
  subagent_start/status/send/stop. Use when on Pi with this extension active and
  you need to launch, supervise, continue, or stop headless children. Apply
  together with use-subagents policy. Do not use for recursive delegation,
  ordinary background processes, or automatic Git/worktree management.
license: MIT
compatibility: >-
  Requires the @maxedapps/pi-subagents extension in the parent Pi session.
  Children self-disable the extension. Parent owns every workspace and Git
  operation. Complements use-subagents; does not replace it.
metadata:
  short-description: Four-tool Pi subagent launcher (with use-subagents policy)
---

# Use Pi Subagents

**Four extension tools only.** Load/follow `use-subagents` for delegation, split, assignment shape, worktrees/Git, verify, workspace cleanup, and reporting.

This skill is **how to start and supervise** children with:

- `subagent_start`
- `subagent_status`
- `subagent_send`
- `subagent_stop`

## Critical supervision rule

**Async children do not wake the parent automatically.**

Before finishing any workflow that started children you must:

1. Poll or block with `subagent_status` until every needed run settles
2. Inspect every output state (`idle`, `failed`, `timedout`, `blocked`, …)
3. `subagent_stop` every run you started

Fire-and-forget is a failure mode.

## Profiles

Bundled profiles: **scout** · **research** · **worker**

Profiles are Markdown with only:

- `name`
- `description`
- system-prompt body

No profile tool/model/thinking configuration. Children inherit the parent model/thinking and normally available approved tools, skills, and extensions (project resources allowed by the normal saved trust decision). The package self-disables inside children (no recursive subagents). Child launch uses `--no-session` and `--no-context-files` only.

User overrides: `~/.pi/agent/subagents/agents/*.md` (whole-file replace by `name`).

## Workflow

1. Apply `use-subagents` (split, ownership, isolation, join points).
2. Prepare each exact `cwd` (worktrees if needed) **in the parent**.
3. Start:
   - Background (default): `subagent_start({ profile, task, cwd })`
   - Foreground join: `subagent_start({ profile, task, cwd, wait: true })`
4. Supervise:
   - List open runs: `subagent_status({})`
   - Snapshot: `subagent_status({ ids: ["run-…"] })`
   - Block until all selected settle: `subagent_status({ ids: […], wait: true })`
   - Optional wait bound: `waitTimeoutMs` → may return `waitTimedOut: true` without stopping children
5. Optional continue:
   - Idle follow-up (new generation): `subagent_send({ id, message })`
   - Active steer/follow-up: `subagent_send({ id, message, behavior: "steer"|"follow-up" })`
6. Verify + integrate in the parent. Child claims are evidence, not acceptance.
7. Stop every run: `subagent_stop({ ids: […] })`
8. Parent-owned worktree/branch cleanup per `use-subagents`.

## Timeouts and Esc

| Control | Effect |
|---|---|
| `executionTimeoutMs` on start/send | Child generation execution deadline. Timeout aborts that generation → `timedout`. |
| `waitTimeoutMs` on status | Caller wait only. Never stops children. |
| Esc during blocking start/send/status | Stops **running** runs in that wait scope only. Already-idle runs survive. |
| Parent Esc (`agent_end` aborted) | Stops currently running children; preserves idle output. |
| Session shutdown (`quit`/`reload`/`new`/`resume`/`fork`) | Stops all open children including idle; closes owned Herdr viewer panes; removes transcript dir when every child is proven exited. |

## Result handling

Every tool result includes `state`, `generation`, `profile`, `cwd`, output (complete or partial), `error`/`reason` when present, `transcriptPath`, `needsStop`, and `nextAction`:

| State | Typical nextAction |
|---|---|
| `starting` / `running` | `wait` |
| `idle` | inspect handoff; optional `send`; then `stop` |
| `failed` / `timedout` / `blocked` | `inspect/retry` then `stop` |
| retained cleanup ambiguity | `retained-cleanup` — report path; do not invent recovery |

## UI

- Below-editor widget lists open runs
- `/subagents` opens a selection overlay (TUI). Enter shows a readable live detail overlay, or lazily opens a Herdr `tail -F` transcript pane when already inside Herdr
- Raw RPC JSONL is never shown

## Non-goals

- No extension-managed Git/worktrees
- No automatic result injection / auto idle cleanup
- No cross-session recovery tools
- No recursive subagents
