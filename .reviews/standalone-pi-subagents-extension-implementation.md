# Plan-backed implementation review

- **Plan:** `.plans/standalone-pi-subagents-extension.md`
- **Tracker:** `.plans/standalone-pi-subagents-extension-progress.md`
- **Date:** 2026-07-24
- **Reviewer:** parent agent (independent child launchers unavailable; native `subagent_*` not active during bootstrap)
- **State:** `Clear`

## Four verdicts

1. **Baseline quality:** Plan is complete, testable, and scoped. No authority conflicts.
2. **Compliance:** Core package behavior matches T1–T6 including live Herdr create/focus/close after parse fix.
3. **Quality beyond baseline:** No material unjustified complexity. Direct RPC child + in-memory runtime matches lean rewrite intent.
4. **Tests/validation:** `npm run check` 23/23; `npm pack --dry-run` assets correct; launch-flag `rg` clean; live Pi RPC loads extension (`/subagents`, widget); live Herdr tail pane open/refocus/close verified.

## Evidence matrix (compressed)

| Authority | Expected | Evidence | Status |
|---|---|---|---|
| Four tools only | start/status/send/stop | `src/tools.ts`, extension test | Complete |
| Profiles name/desc/body only | reject tools/model/thinking | `src/profiles.ts`, agents/*.md, profiles-launch tests | Complete |
| Child marker self-disable | no tools/hooks in child | `CHILD_ENV_MARKER`, extension test | Complete |
| Launch flags | rpc, no-session, no-context-files; no tools/skills/ext/approve suppressors | `buildChildArgv`, rg clean, profiles-launch test | Complete |
| Dialog cancel + human transcript | cancel select/confirm/input/editor; no raw JSONL/thinking | `src/rpc-child.ts`, rpc-runtime test | Complete |
| States/generations/waits/timeouts/Esc | full lifecycle | `src/runtime.ts`, rpc-runtime test | Complete |
| Reminders + Esc + shutdown | context custom msg; running-only Esc; full shutdown | extension hooks, runtime methods | Complete |
| Widget + /subagents + Herdr lazy | belowEditor, overlay, CLI tail -F | `src/ui.ts`, `src/herdr.ts`, ui-herdr tests, live RPC widget/command, live Herdr smoke | Complete |
| Skill + README | four-tool policy, poll/stop/Git parent-owned | `skills/…/SKILL.md`, `README.md` | Complete |
| Package files | extension/src/agents/skill/README/LICENSE; no tests | pack dry-run | Complete |

## Findings

### F1 — Herdr start output parsed CLI envelope id (fixed)

- **Severity/Confidence:** S2 / C3
- **Location:** `src/herdr.ts` `parseStartOutput`
- **Evidence:** Live `herdr agent start` returns `{"id":"cli:agent:start","result":{"agent":{"terminal_id","pane_id"…}}}`. First parser treated envelope `id` as agent target; focus/close failed; name-collision on recreate.
- **Impact:** Lazy Herdr viewers could not be refocused or reliably closed.
- **Fix:** Parse `result.agent.terminal_id` + `pane_id`; reject `cli:*` ids; unit + live retest passed; leftover panes closed.

### Residual / non-findings

- **Name collision:** Existing user skill `~/.pi/agent/skills/use-pi-subagents` wins over package skill path on name collision (Pi first-writer). Documented migration in README.
- Full interactive TUI `/subagents` keyboard path under a human session not separately driven; overlay components unit-tested and command registered live.

## Disposition

- F1 fixed and revalidated → Clear.
- No open material findings.
