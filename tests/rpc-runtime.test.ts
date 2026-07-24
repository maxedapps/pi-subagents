import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import {
  boundText,
  buildChildArgv,
  classifyAssistant,
  projectEventLine,
  RpcChild,
} from "../src/rpc-child.ts";
import { CHILD_ENV_MARKER, loadProfileCatalog } from "../src/profiles.ts";
import { SubagentRuntime } from "../src/runtime.ts";
import { fileURLToPath } from "node:url";

const bundledProfiles = fileURLToPath(new URL("../agents", import.meta.url));

class FakeChildProcess extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  pid = 4242;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killed = false;
  private readonly writes: string[] = [];

  constructor() {
    super();
    this.stdin.write = ((chunk: string | Buffer, encoding?: BufferEncoding | ((error?: Error | null) => void), cb?: (error?: Error | null) => void) => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      this.writes.push(text);
      if (typeof encoding === "function") encoding(null);
      else cb?.(null);
      queueMicrotask(() => this.autoRespond(text));
      return true;
    }) as typeof this.stdin.write;
  }

  get allWrites(): string {
    return this.writes.join("");
  }

  kill(signal?: NodeJS.Signals): boolean {
    this.killed = true;
    this.signalCode = signal ?? "SIGTERM";
    this.exitCode = null;
    this.emit("exit", this.exitCode, this.signalCode);
    return true;
  }

  endProcess(code = 0): void {
    this.exitCode = code;
    this.emit("exit", code, null);
  }

  emitLine(value: unknown): void {
    this.stdout.write(`${JSON.stringify(value)}\n`);
  }

  private autoRespond(text: string): void {
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (message.type && message.id) {
        this.emitLine({ type: "response", id: message.id, command: message.type, success: true, data: {} });
      }
    }
  }
}

function fakeSpawnFactory(capture: { last?: FakeChildProcess; env?: NodeJS.ProcessEnv; argv?: string[] }) {
  return ((_command: string, args: readonly string[], options: { env?: NodeJS.ProcessEnv }) => {
    const child = new FakeChildProcess();
    capture.last = child;
    capture.env = options.env;
    capture.argv = [...args];
    return child as unknown as ReturnType<typeof import("node:child_process").spawn>;
  }) as typeof import("node:child_process").spawn;
}

test("classifyAssistant maps stop/error/abort/timeout evidence", () => {
  assert.equal(classifyAssistant({ role: "assistant", stopReason: "stop", content: "ok" }).state, "idle");
  assert.equal(classifyAssistant({ role: "assistant", stopReason: "stop", content: "" }).state, "blocked");
  assert.equal(classifyAssistant({ role: "assistant", stopReason: "error", errorMessage: "boom" }).state, "failed");
  assert.equal(classifyAssistant({ role: "assistant", stopReason: "aborted" }, { timeoutRequested: true }).state, "timedout");
  assert.equal(classifyAssistant({ role: "assistant", stopReason: "aborted" }, { stopRequested: true }).state, "stopped");
  assert.equal(classifyAssistant({ role: "assistant", stopReason: "aborted" }).state, "blocked");
  assert.equal(classifyAssistant(null).state, "blocked");
});

test("projectEventLine never returns raw thinking and summarizes tools", () => {
  assert.equal(
    projectEventLine(JSON.stringify({ type: "tool_execution_start", toolName: "read", args: { path: "/tmp/a" } })),
    "tool start read: /tmp/a",
  );
  assert.equal(projectEventLine(JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "secret" } })), undefined);
  assert.equal(projectEventLine("not-json"), undefined);
});

test("RpcChild launch flags, env marker, dialog cancel, settlement, and transcript", async () => {
  const root = await mkdtemp(join(tmpdir(), "rpc-child-"));
  const capture: { last?: FakeChildProcess; env?: NodeJS.ProcessEnv; argv?: string[] } = {};
  try {
    const transcriptPath = join(root, "transcript.txt");
    const child = new RpcChild();
    const settlement = new Promise((resolve) => {
      void RpcChild.start({
        executable: process.execPath,
        cwd: root,
        systemPromptFile: join(root, "system.md"),
        transcriptPath,
        parent: { thinking: "low" },
        spawnImpl: fakeSpawnFactory(capture),
        commandTimeoutMs: 2_000,
        stopGraceMs: 50,
      }, {
        onSettlement: resolve,
      }).then(async (started) => {
        Object.assign(child, started);
        assert.ok(capture.env?.[CHILD_ENV_MARKER] === "1");
        assert.deepEqual(capture.argv?.slice(0, 4), ["--mode", "rpc", "--no-session", "--no-context-files"]);
        assert.equal(capture.argv?.includes("--tools"), false);

        const fake = capture.last!;
        fake.emitLine({
          type: "extension_ui_request",
          id: "ui-1",
          method: "confirm",
          title: "x",
          message: "y",
        });
        await new Promise((r) => setTimeout(r, 20));
        assert.match(fake.allWrites, /extension_ui_response.*"cancelled":true/);

        const wait = started.waitForSettlement(2_000);
        await started.prompt("hello");
        fake.emitLine({
          type: "tool_execution_start",
          toolName: "read",
          args: { path: "README.md" },
        });
        fake.emitLine({
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", delta: "partial " },
        });
        fake.emitLine({
          type: "message_end",
          message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "final answer" }] },
        });
        fake.emitLine({ type: "agent_settled" });
        const event = await wait;
        assert.equal(event.classification.state, "idle");
        assert.equal(event.assistantText, "final answer");

        const transcript = await readFile(transcriptPath, "utf8");
        assert.match(transcript, /tool start read: README.md/);
        assert.match(transcript, /settled state=idle/);
        assert.match(transcript, /assistant: final answer/);
        assert.equal(transcript.includes("thinking"), false);
        assert.equal(transcript.includes("extension_ui_request"), false);
        assert.equal(transcript.includes('"type":"prompt"'), false);

        await started.stop();
        fake.endProcess(0);
      });
    });
    await settlement;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runtime start async/sync, multi-wait, send, stop, timeouts, and esc scope", async () => {
  const root = await mkdtemp(join(tmpdir(), "runtime-"));
  const catalog = loadProfileCatalog({ bundledDir: bundledProfiles, userDir: join(root, "missing-user") });
  const children = new Map<string, {
    promptCount: number;
    steerCount: number;
    followUpCount: number;
    abortCount: number;
    stopCount: number;
    active: boolean;
    timeout: boolean;
    stopFlag: boolean;
    listeners: Array<(event: unknown) => void>;
    text: string;
  }>();

  const createChild: typeof RpcChild.start = async (options, events = {}) => {
    const id = options.transcriptPath;
    const state = {
      promptCount: 0,
      steerCount: 0,
      followUpCount: 0,
      abortCount: 0,
      stopCount: 0,
      active: false,
      timeout: false,
      stopFlag: false,
      listeners: [] as Array<(event: unknown) => void>,
      text: "",
    };
    children.set(id, state);
    const child = {
      transcriptPath: options.transcriptPath,
      cwd: options.cwd,
      get latestAssistantText() { return state.text; },
      get isPartialAssistant() { return state.active; },
      get isActive() { return state.active; },
      get hasExited() { return state.stopCount > 0; },
      async prompt(message: string) {
        state.promptCount += 1;
        state.active = true;
        state.text = "";
        if (message.includes("fail")) {
          queueMicrotask(() => {
            state.active = false;
            state.text = "failed";
            events.onSettlement?.({
              classification: { state: "failed", reason: "assistant-error", text: "failed" },
              assistantText: "failed",
              partial: false,
            });
          });
          return;
        }
        if (message.includes("slow")) return;
        queueMicrotask(() => {
          state.active = false;
          state.text = `done:${message}`;
          events.onSettlement?.({
            classification: { state: "idle", reason: "stop", text: state.text },
            assistantText: state.text,
            partial: false,
          });
        });
      },
      async steer() { state.steerCount += 1; },
      async followUp() { state.followUpCount += 1; },
      async abort() {
        state.abortCount += 1;
        if (state.timeout) {
          state.active = false;
          events.onSettlement?.({
            classification: { state: "timedout", reason: "timeout-abort", text: state.text },
            assistantText: state.text,
            partial: false,
          });
        } else if (state.stopFlag) {
          state.active = false;
          events.onSettlement?.({
            classification: { state: "stopped", reason: "explicit-stop-abort", text: state.text },
            assistantText: state.text,
            partial: false,
          });
        }
      },
      markTimeoutRequested() { state.timeout = true; },
      markStopRequested() { state.stopFlag = true; },
      waitForSettlement() {
        return new Promise((resolve) => {
          state.listeners.push(resolve);
        });
      },
      async stop() {
        state.stopCount += 1;
        state.active = false;
        events.onExit?.(0, null);
      },
      getBoundedAssistantText() { return boundText(state.text); },
    };
    return child as unknown as RpcChild;
  };

  const runtime = new SubagentRuntime({
    catalog,
    parentSessionId: "session-test",
    transcriptRoot: root,
    createChild,
    defaultExecutionTimeoutMs: 30_000,
  });

  try {
    const asyncStart = await runtime.start({
      profile: "scout",
      task: "quick one",
      cwd: root,
      parent: { thinking: "medium" },
    });
    assert.ok(asyncStart.id);
    assert.equal(asyncStart.needsStop, true);
    await runtime.status({ ids: [asyncStart.id], wait: true, waitTimeoutMs: 1_000 });
    const idle = runtime.get(asyncStart.id)!;
    assert.equal(idle.state, "idle");
    assert.equal(idle.generation, 1);
    assert.match(idle.output, /done:quick one/);

    const foreground = await runtime.start({
      profile: "worker",
      task: "quick two",
      cwd: root,
      wait: true,
      parent: {},
    });
    assert.equal(foreground.state, "idle");
    assert.equal(foreground.needsStop, true);

    const a = await runtime.start({ profile: "scout", task: "quick a", cwd: root, parent: {} });
    const b = await runtime.start({ profile: "research", task: "quick b", cwd: root, parent: {} });
    const multi = await runtime.status({ ids: [a.id, b.id], wait: true, waitTimeoutMs: 1_000 });
    assert.equal(multi.waitTimedOut, undefined);
    assert.ok(multi.runs.every((run) => run.state === "idle"));

    const slow = await runtime.start({ profile: "scout", task: "slow task", cwd: root, parent: {} });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(runtime.get(slow.id)?.state, "running");
    const timed = await runtime.status({ ids: [slow.id], wait: true, waitTimeoutMs: 50 });
    assert.equal(timed.waitTimedOut, true);
    assert.equal(runtime.get(slow.id)?.state, "running");

    const follow = await runtime.send({ id: idle.id, message: "next" });
    await runtime.status({ ids: [idle.id], wait: true, waitTimeoutMs: 1_000 });
    assert.equal(runtime.get(idle.id)?.generation, 2);

    // Keep one running for steer
    const active = await runtime.start({ profile: "scout", task: "slow steer", cwd: root, parent: {} });
    await runtime.send({ id: active.id, message: "nudge", behavior: "steer" });
    const activeChild = [...children.values()].find((item) => item.steerCount === 1);
    assert.ok(activeChild);

    const failed = await runtime.start({ profile: "scout", task: "please fail", cwd: root, wait: true, parent: {} });
    assert.equal(failed.state, "failed");

    // execution timeout
    const timeoutRun = await runtime.start({
      profile: "scout",
      task: "slow timeout",
      cwd: root,
      executionTimeoutMs: 30,
      parent: {},
    });
    await new Promise((r) => setTimeout(r, 80));
    const afterTimeout = runtime.get(timeoutRun.id);
    assert.ok(afterTimeout);
    assert.ok(afterTimeout.state === "timedout" || afterTimeout.state === "running");
    if (afterTimeout.state === "running") {
      await new Promise((r) => setTimeout(r, 1200));
    }
    assert.equal(runtime.get(timeoutRun.id)?.state, "timedout");

    // Esc-style active-only stop preserves idle
    const keepIdle = await runtime.start({ profile: "scout", task: "keep", cwd: root, wait: true, parent: {} });
    const killActive = await runtime.start({ profile: "scout", task: "slow kill", cwd: root, parent: {} });
    await runtime.stopActive("esc");
    assert.equal(runtime.get(keepIdle.id)?.state, "idle");
    assert.equal(runtime.get(killActive.id), undefined);

    const mixed = await runtime.stop([keepIdle.id, "missing-id", foreground.id]);
    assert.equal(mixed.find((item) => item.id === keepIdle.id)?.ok, true);
    assert.equal(mixed.find((item) => item.id === "missing-id")?.ok, false);
    assert.equal(runtime.get(keepIdle.id), undefined);

    const reminder = runtime.formatReminder();
    assert.ok(reminder);
    assert.match(reminder!, /Open subagent runs/);

    const shutdown = await runtime.shutdown();
    assert.equal(shutdown.retained, false);
    void follow;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("boundText truncates large payloads", () => {
  const text = boundText("x".repeat(40_000), 100);
  assert.ok(text.length < 200);
  assert.match(text, /truncated/);
});

test("buildChildArgv baseline", () => {
  assert.ok(buildChildArgv({ systemPromptFile: "s", parent: {} }).includes("--mode"));
});
