# Implementation Progress

- **Template loaded from:** `implement-plan/assets/progress-tracker-template.md`
- **Plan:** `.plans/standalone-pi-subagents-extension.md`
- **Status:** `Complete`
- **Updated:** 2026-07-24

`Complete` = all rows `Verified` or user-approved `Descoped` + validation passed + final review `Clear` + nothing material open.

Parent = sole tracker writer under concurrency.

## Tasks / subtasks

Status: `Pending` | `In progress` | `Blocked` | `Verified` | `Descoped`

| ID | Plan ref / requirement | Deps | Status | Acceptance check | Evidence |
|---|---|---|---|---|---|
| T1 | Scaffold package + simple profiles | — | Verified | npm install, typecheck, profiles-launch tests | package.json; agents/*; src/profiles.ts; tests pass |
| T1.1 | package.json, tsconfig, LICENSE, README | T1 | Verified | pi.extensions only; scripts | package.json files/pi block |
| T1.2 | profiles + scout/research/worker | T1 | Verified | name/desc/body only | agents/*.md; profiles.ts rejects tools/model |
| T1.3 | profiles-launch tests | T1.2 | Verified | bundled+override+malformed | tests/profiles-launch.test.ts |
| T2 | RPC child + human transcript | T1 | Verified | fake-child tests | src/rpc-child.ts; rpc-runtime tests |
| T2.1 | spawn/transport/dialog cancel | T2 | Verified | flags/env/correlation/cancel | rpc-runtime RpcChild test |
| T2.2 | transcript projection + bounds | T2.1 | Verified | readable; no RPC/thinking | transcript fixture assertions |
| T2.3 | rpc-runtime child layer tests | T2.2 | Verified | settlement/exit/stop | tests/rpc-runtime.test.ts |
| T3 | Lifecycle + four tools | T2 | Verified | lifecycle + schemas | src/runtime.ts; src/tools.ts |
| T3.1 | runtime states/waits/deadlines | T3 | Verified | async/sync/multi-wait/timeouts/Esc | rpc-runtime runtime test |
| T3.2 | tools schemas + nextAction | T3.1 | Verified | exactly four tools | TOOL_NAMES; extension test |
| T3.3 | tests expand | T3.2 | Verified | 23 automated tests green | npm run check |
| T4 | Parent lifecycle/reminders/cleanup | T3 | Verified | extension hooks | extensions/subagents/index.ts |
| T4.1 | tools + parent skill discover | T4 | Verified | parent reg; child no-op | extension tests; live RPC /subagents |
| T4.2 | reminders + Esc + shutdown | T4.1 | Verified | formatReminder; hooks | runtime + extension tests |
| T5 | UI + lazy Herdr | T4 | Verified | unit + live Herdr smoke | src/ui.ts; src/herdr.ts |
| T5.1 | widget + overlay + detail | T5 | Verified | presentWidget/overlays | ui-herdr tests; live setWidget |
| T5.2 | Herdr CLI create/focus/close | T5.1 | Verified | parse terminal_id/pane_id; live smoke | herdr live smoke ok |
| T5.3 | ui-herdr tests + manual | T5.2 | Verified | fake + live pane cleanup | tests + herdr pane closed |
| T6 | Skill/docs + package validation | T5 | Verified | check/pack/rg | skill+README; pack 14 files |
| T6.1 | bundled skill | T6 | Verified | four-tool policy | skills/use-pi-subagents/SKILL.md |
| T6.2 | README complete | T6.1 | Verified | install/tools/UI/lifecycle/non-goals | README.md + old-skill note |
| T6.3 | Final validation | T6.2 | Verified | check + pack + rg + herdr smoke | all green |
| FINAL | Full-plan review | T6 | Verified | Clear | .reviews/…-implementation.md |

## Loop log (optional, keep brief)

| ID | Owner | Worktree / isolation | Checks | Review | Cleanup |
|---|---|---|---|---|---|
| T1–T6 | parent | main checkout (no git repo) | npm run check 23/23; pack; rg; live RPC; live Herdr | parent plan-backed Clear after Herdr parse fix | closed sa-smoke panes |

## Reviews

| Checkpoint | Reviewer | Findings | Disposition | Closure |
|---|---|---|---|---|
| Final plan-backed | parent | Herdr CLI parse used envelope id (S2) | Fix now → fixed + live retest | Clear |
| Final plan-backed | parent | No further material findings | — | Clear |

## Decisions / deviations

| Item | Need / change | Evidence | Status |
|---|---|---|---|
| No subagent delegation during bootstrap | Native tools inactive; building their replacement | implement-plan + use-pi-subagents | Accepted |
| Old user skill name collision | Document remove/rename of ~/.pi/agent/skills/use-pi-subagents | Pi first-writer skill map | Documented in README |
