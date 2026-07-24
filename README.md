# @maxedapps/pi-subagents

Standalone Pi package that adds four headless subagent tools:

- `subagent_start`
- `subagent_status`
- `subagent_send`
- `subagent_stop`

Bundled profiles: **scout**, **research**, **worker**. Optional lazy Herdr transcript panes when Pi is already running inside Herdr.

## Install

```bash
pi install npm:@maxedapps/pi-subagents
```

Or link a local checkout:

```bash
pi install file:/path/to/pi-subagents
```

Requires Node.js 22.19+ and Pi 0.81.1+ on tested macOS/Linux.

If you previously used the script-based `use-pi-subagents` skill under `~/.pi/agent/skills/`, remove or rename that skill directory. Pi keeps the first skill name winner, so the old skill can shadow this package skill.

## Tools

### Start

```ts
// async (default)
subagent_start({ profile: "scout", task: "Where is X defined?", cwd: "/repo" })

// foreground join — still needs explicit stop afterward
subagent_start({ profile: "worker", task: "Implement Y", cwd: "/repo/worktree", wait: true })
```

### Status / join

```ts
subagent_status({}) // list open runs
subagent_status({ ids: ["run-…", "run-…"], wait: true }) // all-settled
subagent_status({ ids: ["run-…"], wait: true, waitTimeoutMs: 5000 }) // may set waitTimedOut
```

### Send

```ts
subagent_send({ id, message: "Also check tests" }) // idle → next generation
subagent_send({ id, message: "Stop exploring; answer now", behavior: "steer" }) // active
```

### Stop

```ts
subagent_stop({ ids: ["run-…", "run-…"] })
```

**Async children do not wake the parent.** Always poll/join, inspect outputs, and stop every run.

## Profiles

Markdown files with only:

```md
---
name: scout
description: Repository inspection and codebase questions
---
System prompt body…
```

User overrides (whole-file replace by `name`):

`~/.pi/agent/subagents/agents/*.md`

Children inherit the parent model/thinking and normally available approved tools, skills, and extensions. Launch intentionally does **not** pass `--tools`, `--no-skills`, `--no-extensions`, or `--no-approve`. The extension self-disables in children. Child sessions use `--no-session` and `--no-context-files`.

## UI

- Compact **below-editor** widget for open runs
- `/subagents` selection overlay (TUI)
- Enter → readable Pi detail overlay, or lazy Herdr `tail -n +1 -F <transcript>` split when `HERDR_ENV=1` and pane/workspace/tab/socket env are present
- Viewer panes are read-only; communicate only through `subagent_send`
- Herdr failure falls back to the Pi overlay and never affects the RPC child

## Lifecycle and cleanup

| Event | Behavior |
|---|---|
| Execution timeout | Aborts that generation → `timedout` |
| Wait timeout | Returns current snapshots; children keep running |
| Esc during blocking tool wait | Stops running runs in scope; idle survives |
| Parent Esc | Stops running children; idle survives |
| Session shutdown | Stops all open children, closes owned viewers, deletes transcript dir when safe |
| Explicit `subagent_stop` | Stops requested runs; transcripts retained until shutdown |

Parent owns Git, branches, commits, worktrees, merges, and workspace cleanup. The bundled parent-only skill states this policy.

## Security / trust

Children run with the same approved capability surface the parent would normally expose in non-interactive RPC, including trusted extensions and project resources allowed by the saved trust decision. Assign least scope in the task text and parent-prepared cwd. Do not treat child output as authoritative without parent verification.

## Non-goals

- Profile/runtime tool allowlists or model settings in profiles
- Extension-managed Git/worktrees
- Automatic result turns or automatic idle cleanup
- Cross-session adoption/recovery, journals, control sockets
- Windows/remote-Herdr viewer guarantees
- Interactive input through viewer panes

## Develop

```bash
npm install
npm run check
```

## License

MIT
