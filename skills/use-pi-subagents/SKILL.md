---
name: use-pi-subagents
description: >-
  Orchestrates outsourcing of bounded scouting, research, and implementation to
  headless Pi subagents via subagent_start/status/send/stop. Use this skill when
  the parent should delegate substantive work, supervise it, and integrate the
  results. Apply together with use-subagents policy. Do not use for recursive
  delegation, duplicate parent/child execution, ordinary background processes,
  or automatic Git/worktree management.
license: MIT
compatibility: >-
  Requires the @maxedapps/pi-subagents extension in the parent Pi session.
  Children self-disable the extension. Parent owns every workspace and Git
  operation. Complements use-subagents; does not replace it.
metadata:
  short-description: Pi subagent outsourcing and orchestration
---

# Use Pi Subagents

**Outsource execution; orchestrate in the parent.** Load/follow `use-subagents` for delegation, split, assignment shape, worktrees/Git, verify, workspace cleanup, and reporting.

- Assign bounded, non-overlapping child scopes with explicit deliverables.
- Do not perform a child-owned scope in the parent. Parent work is decomposition, supervision, focused verification, integration, or explicitly separate work.
- If a child cannot finish, explicitly reclaim or reassign its scope before continuing it elsewhere.

Use these four extension tools to start and supervise children:

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

1. Apply `use-subagents`: define child-owned scopes, parent orchestration/integration, isolation, and join points.
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
6. Verify with focused checks, then integrate. Follow up or reassign gaps; do not redo successful child work.
7. Stop every run: `subagent_stop({ ids: […] })`
8. Parent-owned worktree/branch cleanup per `use-subagents`.

## Timeouts and Esc

| Control | Effect |
|---|---|
| `executionTimeoutMs` on start/send | Near the deadline the child is steered to wrap up; the hard deadline aborts → `timedout`, followed by a short best-effort recovery-summary attempt. Omit it for the 15-minute default; allow 10–15 minutes for deep research. |
| `waitTimeoutMs` on status | Caller wait only. Never stops children. |
| Esc during blocking start/send/status | Stops **running** runs in that wait scope only. Already-idle runs survive. |
| Parent Esc (`agent_end` aborted) | Stops currently running children; preserves idle output. |
| Session shutdown (`quit`/`reload`/`new`/`resume`/`fork`) | Stops all open children including idle; closes owned Herdr viewer panes; removes transcript dir when every child is proven exited. |

## Result handling

Every tool result includes `state`, `generation`, `profile`, `cwd`, output (complete or partial), `error`/`reason` when present, `transcriptPath`, `needsStop`, and `nextAction`. Abnormal settlement may also include `recovery.state` plus a best-effort `recovery.summary` or `recovery.error`:

| State | Typical nextAction |
|---|---|
| `starting` / `running` | `wait` |
| `idle` | inspect handoff; optional `send`; then `stop` |
| `failed` / `timedout` / `blocked` | inspect error/output and any recovery summary; `inspect/retry` then `stop` |
| retained cleanup ambiguity | `retained-cleanup` — report path; do not invent recovery |

## UI

- Below-editor widget lists open runs
- `/subagents` opens a selection overlay (TUI). Enter shows a readable live detail overlay, or lazily opens a Herdr `tail -F` transcript pane when already inside Herdr
- Raw RPC JSONL is never shown

## When a Pi Office is active

If a Pi Office holds the repository, these tools are **not** the way to run agents.

- The Office suppresses this extension and every `subagent_*` call fails closed
  ("refusing to run …: Pi Office … is active"). This is intended, not a bug.
- Launch, resume, and control agents **only** through the Office's
  `office_agent_*` tools; never work around a refusal with `pi --mode rpc`,
  scripts, or another subagent extension.
- On a *stale* Office marker refusal, report it and run `office_reconcile` in
  the Office. Never delete Office state to unblock yourself.
- Before creating an Office, `subagent_stop` every open run: the Office refuses
  to activate over live legacy runs and never adopts them.

## Non-goals

- No extension-managed Git/worktrees
- No automatic result injection / auto idle cleanup
- No cross-session recovery tools
- No recursive subagents
