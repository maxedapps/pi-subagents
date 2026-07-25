# Pi Subagents

Run **scout**, **research**, and **worker** children from a Pi parent session—without blocking the parent on every task.

Install once. The parent agent gets four tools and a small UI. You supervise with status/wait/stop (children do **not** wake the parent automatically).

## Install

```bash
pi install npm:@maxedapps/pi-subagents
```

Requires **Node 22.19+** and **Pi 0.82.0+** (macOS/Linux).

Then start a new Pi session (or `/reload`).

## What you get

| Piece | Purpose |
|---|---|
| `subagent_start` | Launch one child |
| `subagent_status` | List, snapshot, or wait until settled |
| `subagent_send` | Follow up (idle) or steer (running) |
| `subagent_stop` | Tear down runs when done |
| Below-editor widget | Live open runs |
| `/subagents` | Inspect readable transcripts (TUI) |

**Profiles**

| Profile | Best for |
|---|---|
| `scout` | Codebase questions, read-only inspection |
| `research` | Repo + web research |
| `worker` | One bounded implementation in a parent-supplied cwd |

Children use the **parent’s model/thinking** and normally available tools/skills/extensions. They cannot start their own subagents. **You** own Git, worktrees, and integration.

## Typical flow

```text
1. Prepare cwd (worktree if needed) in the parent
2. subagent_start({ profile, task, cwd })          # async default
3. subagent_status({ ids, wait: true })            # join when needed
4. Inspect output / optional subagent_send
5. subagent_stop({ ids })                          # always
```

### Start

```js
// background (default)
subagent_start({
  profile: "scout",
  task: "Where is auth middleware registered?",
  cwd: "/path/to/repo",
})

// block until this run settles (still must stop afterward)
subagent_start({
  profile: "worker",
  task: "Add validation to the signup form",
  cwd: "/path/to/worktree",
  wait: true,
  executionTimeoutMs: 600000, // optional generation deadline
})
```

### Status / wait

```js
subagent_status({})                                 // all open runs
subagent_status({ ids: ["run-…"] })                 // snapshot
subagent_status({ ids: ["run-a", "run-b"], wait: true })
subagent_status({ ids: ["run-…"], wait: true, waitTimeoutMs: 5000 })
// waitTimeoutMs → may return waitTimedOut: true; children keep running
```

### Send

```js
subagent_send({ id, message: "Also check the tests" })  // idle → next generation
subagent_send({ id, message: "Answer now", behavior: "steer" })       // running
subagent_send({ id, message: "…", behavior: "follow-up" })            // running queue
```

### Stop

```js
subagent_stop({ ids: ["run-…", "run-…"] })
```

Unknown ids are skipped; others still stop.

## How to read results

Every tool result includes roughly:

- `state` — `starting` · `running` · `idle` · `failed` · `timedout` · `blocked` · `stopped`
- `output` — final or partial text
- `transcriptPath` — full human log
- `needsStop` — still must be stopped when true
- `nextAction` — what to do next (`wait`, `send`, `inspect/retry`, `stop`, …)

| State | Do this |
|---|---|
| `running` / `starting` | Wait or status-wait |
| `idle` | Read handoff; optional send; then **stop** |
| `failed` / `timedout` / `blocked` | Read error/output; **stop** |
| `stopped` | Done for that run |

**Rule:** never finish a workflow with open runs—`subagent_stop` everything you started.

## UI

- **Widget** under the editor lists open runs.
- **`/subagents`** (TUI): ↑↓ select · Enter inspect · `r` refresh · Esc close.
- Inside **Herdr**, Enter can open a live transcript tail pane; elsewhere you get a Pi detail overlay. Viewers are read-only—use `subagent_send` to talk to the child.

## Timeouts & Esc

| Control | Effect |
|---|---|
| `executionTimeoutMs` | Child generation deadline → `timedout` |
| `waitTimeoutMs` | Your wait only; does **not** stop children |
| Esc during a blocking tool | Stops **running** runs in that wait; idle runs stay |
| Parent Esc | Stops running children; idle stays |
| Quit / reload / new session | Stops **all** open children |

## Custom profiles

Add Markdown under:

```text
~/.pi/agent/subagents/agents/*.md
```

```md
---
name: my-reviewer
description: Focused PR review
---
Your system prompt…
```

Same `name` replaces a bundled profile. Only `name`, `description`, and the body are supported.

## Coexistence with Pi Office

Pi Office is a separate product that manages its own agents through a durable
runtime. While an Office holds a repository, **all** agent launching and control
goes through its `office_agent_*` tools — there is no fallback, and this
extension deliberately steps aside:

- Pi Office asks this extension (0.2.0+) to suppress itself when an Office
  activates; the `subagent_*` tools are removed from the active set and the
  exact previous tool set is restored when the Office releases the window.
- Every `subagent_*` call re-checks the Office policy marker at execution time
  and **fails closed** — including for an Office in another Pi process, a
  `failed`/`retained` Office, and a stale marker (that one asks you to run
  `office_reconcile` rather than deleting anything).
- Open runs are published to `<pi agent dir>/subagents/open-runs/<session>.json`
  so an Office refuses to activate over live legacy runs instead of adopting
  them. Stop your runs first, then create the Office.
- Inside an Office-managed child (`PI_OFFICE_RUN_ID` present) this extension
  registers nothing at all.

Nothing changes when no Office is active, and this package has no dependency on
Pi Office.

## Safety

- Children inherit approved parent capabilities (including project trust). Scope the **task** and **cwd** tightly.
- Treat child output as evidence—verify in the parent before merging or shipping.
- Parent owns every Git/worktree operation; children should not manage VCS.

## License

MIT
