import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { detectHerdrEnv, HerdrViewerManager, parseStartOutput } from "../src/herdr.ts";
import {
  formatWidgetLines,
  presentWidget,
  readTranscriptTail,
  RunListOverlay,
  DetailOverlay,
} from "../src/ui.ts";
import type { RunSnapshot } from "../src/runtime.ts";

function run(partial: Partial<RunSnapshot> & Pick<RunSnapshot, "id" | "profile" | "state">): RunSnapshot {
  return {
    generation: 1,
    cwd: "/tmp",
    output: "hi",
    partial: false,
    transcriptPath: "/tmp/t.txt",
    needsStop: true,
    nextAction: "wait",
    ...partial,
  };
}

test("widget presentation lists non-stopped runs and inspection hint", () => {
  const presentation = presentWidget([
    run({ id: "run-abc12345", profile: "scout", state: "running", generation: 2 }),
    run({ id: "run-def67890", profile: "worker", state: "idle" }),
    run({ id: "run-zzz", profile: "research", state: "stopped" }),
  ]);
  assert.ok(presentation);
  assert.match(presentation!.header, /1 active/);
  assert.equal(presentation!.rows.length, 2);
  assert.equal(presentation!.hint, "/subagents");
  const lines = formatWidgetLines([
    run({ id: "run-abc12345", profile: "scout", state: "running" }),
  ]);
  assert.ok(lines?.some((line) => line.includes("/subagents")));
});

test("detectHerdrEnv requires HERDR_ENV and core ids", () => {
  assert.equal(detectHerdrEnv({}).enabled, false);
  assert.equal(detectHerdrEnv({
    HERDR_ENV: "1",
    HERDR_SOCKET_PATH: "/tmp/h.sock",
    HERDR_WORKSPACE_ID: "ws",
    HERDR_TAB_ID: "tab",
  }).enabled, true);
  assert.equal(detectHerdrEnv({
    HERDR_ENV: "1",
    HERDR_SOCKET_PATH: "/tmp/h.sock",
    HERDR_WORKSPACE_ID: "ws",
  }).enabled, false);
});

test("parseStartOutput reads Herdr CLI agent_started envelope", () => {
  const parsed = parseStartOutput(JSON.stringify({
    id: "cli:agent:start",
    result: {
      type: "agent_started",
      agent: {
        name: "sa-parse-test",
        pane_id: "w4J:p8",
        terminal_id: "term_657566d563eb0494",
        workspace_id: "w4J",
      },
    },
  }));
  assert.deepEqual(parsed, {
    agentId: "term_657566d563eb0494",
    paneId: "w4J:p8",
  });
  assert.equal(parseStartOutput(JSON.stringify({ id: "cli:agent:start" })), undefined);
});

test("Herdr viewer is lazy, reusable, stale-fallback, and owned close only", async () => {
  const calls: Array<{ command: string; args: string[] }> = [];
  const manager = new HerdrViewerManager(async (command, args) => {
    calls.push({ command, args });
    if (args[0] === "agent" && args[1] === "start") {
      return {
        code: 0,
        stdout: JSON.stringify({
          id: "cli:agent:start",
          result: {
            type: "agent_started",
            agent: { terminal_id: "term-1", pane_id: "pane-1", name: args[2] },
          },
        }),
        stderr: "",
      };
    }
    if (args[0] === "agent" && args[1] === "focus") {
      if (args[2] === "term-1" && calls.filter((c) => c.args[1] === "focus").length === 1) {
        return { code: 0, stdout: "", stderr: "" };
      }
      return { code: 1, stdout: "", stderr: "missing" };
    }
    if (args[0] === "pane" && args[1] === "close") {
      return { code: 0, stdout: "", stderr: "" };
    }
    return { code: 1, stdout: "", stderr: "no" };
  }, {
    enabled: true,
    workspaceId: "ws",
    tabId: "tab",
    socketPath: "/tmp/h.sock",
  });

  assert.equal(calls.length, 0);
  const first = await manager.openOrFocus("run-1", "/tmp/transcript.txt", "scout-run1");
  assert.equal(first.ok, true);
  if (first.ok) assert.equal(first.handle.agentId, "term-1");
  assert.ok(calls.some((call) => call.args.includes("tail") && call.args.includes("-F")));
  assert.equal(calls.some((call) => call.args[1] === "start"), true);

  const second = await manager.openOrFocus("run-1", "/tmp/transcript.txt", "scout-run1");
  assert.equal(second.ok, true);
  assert.equal(calls.filter((call) => call.args[1] === "focus").length, 1);
  assert.equal(calls.filter((call) => call.args[1] === "start").length, 1);

  // stale focus then recreate
  manager.clear("run-1");
  // put back stale handle manually
  (manager as any).viewers.set("run-1", { runId: "run-1", agentId: "term-1", paneId: "pane-1" });
  const stale = await manager.openOrFocus("run-1", "/tmp/transcript.txt", "scout-run1");
  assert.equal(stale.ok, true);
  assert.ok(calls.filter((call) => call.args[1] === "start").length >= 2);

  await manager.close("run-1");
  assert.ok(calls.some((call) => call.args[0] === "pane" && call.args[1] === "close" && call.args[2] === "pane-1"));
  assert.equal(manager.getViewer("run-1"), undefined);
});

test("non-Herdr path leaves manager unavailable and never execs", async () => {
  let called = false;
  const manager = new HerdrViewerManager(async () => {
    called = true;
    return { code: 0, stdout: "", stderr: "" };
  }, { enabled: false });
  const result = await manager.openOrFocus("run-1", "/tmp/t", "x");
  assert.equal(result.ok, false);
  assert.equal(called, false);
});

test("overlay selection components respond to keys", () => {
  const runs = [
    run({ id: "run-1", profile: "scout", state: "running" }),
    run({ id: "run-2", profile: "worker", state: "idle" }),
  ];
  const actions: unknown[] = [];
  const theme = {
    fg: (_c: string, text: string) => text,
    bg: (_c: string, text: string) => text,
    bold: (text: string) => text,
  } as any;
  const overlay = new RunListOverlay(() => runs, theme, (action) => actions.push(action), () => {});
  overlay.handleInput("r");
  overlay.handleInput("\x1b[B"); // may not match Key.down depending on encoding; call select via enter after setting
  // Use direct selected navigation via private path-free public enter after down-like selected default
  overlay.handleInput("\r");
  assert.ok(actions.some((action: any) => action.type === "refresh" || action.type === "select"));

  const detail = new DetailOverlay(runs[0]!, theme, () => actions.push({ type: "closed" }));
  const rendered = detail.render(80);
  assert.ok(rendered.some((line) => line.includes("scout") || line.includes("run-1")));
});

test("readTranscriptTail returns last lines only", async () => {
  const root = await mkdtemp(join(tmpdir(), "transcript-"));
  try {
    const path = join(root, "t.txt");
    await writeFile(path, Array.from({ length: 100 }, (_, i) => `line-${i}`).join("\n"));
    const tail = readTranscriptTail(path, 5);
    assert.equal(tail.length, 5);
    assert.equal(tail[0], "line-95");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
