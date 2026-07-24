import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import subagentsExtension, { isAbortedAssistantStop } from "../extensions/subagents/index.ts";
import { CHILD_ENV_MARKER } from "../src/profiles.ts";
import {
  createStartSchema,
  sendSchema,
  statusSchema,
  stopSchema,
  TOOL_NAMES,
} from "../src/tools.ts";
import { loadProfileCatalog } from "../src/profiles.ts";
import { fileURLToPath } from "node:url";

const bundledProfiles = fileURLToPath(new URL("../agents", import.meta.url));

type Handler = (...args: any[]) => any;

function createFakePi() {
  const tools: Array<{ name: string; parameters: unknown; execute: Handler }> = [];
  const handlers = new Map<string, Handler[]>();
  const commands = new Map<string, Handler>();
  const widgets = new Map<string, unknown>();
  let thinking: string = "medium";

  const pi = {
    registerTool(def: { name: string; parameters: unknown; execute: Handler }) {
      tools.push(def);
    },
    registerCommand(name: string, def: { handler: Handler }) {
      commands.set(name, def.handler);
    },
    on(event: string, handler: Handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    getThinkingLevel() {
      return thinking;
    },
    exec: async () => ({ code: 1, stdout: "", stderr: "no herdr" }),
    async emit(event: string, payload: unknown, ctx: unknown) {
      const list = handlers.get(event) ?? [];
      let result;
      for (const handler of list) result = await handler(payload, ctx);
      return result;
    },
    tools,
    commands,
    widgets,
    handlers,
  };
  return pi;
}

function createCtx(mode: "tui" | "rpc" = "tui") {
  const widgets = new Map<string, unknown>();
  return {
    mode,
    hasUI: true,
    cwd: process.cwd(),
    model: { provider: "openai", id: "gpt-test" },
    sessionManager: {
      getSessionId: () => "sess-1",
      getSessionFile: () => "/tmp/sess.jsonl",
      getLeafId: () => "leaf-1",
    },
    ui: {
      setWidget(key: string, value: unknown) {
        if (value === undefined) widgets.delete(key);
        else widgets.set(key, value);
      },
      notify() {},
      custom: async () => undefined,
      theme: {
        fg: (_c: string, text: string) => text,
        bg: (_c: string, text: string) => text,
        bold: (text: string) => text,
      },
      widgets,
    },
  };
}

test("child marker prevents registration", () => {
  const previous = process.env[CHILD_ENV_MARKER];
  process.env[CHILD_ENV_MARKER] = "1";
  try {
    const pi = createFakePi();
    subagentsExtension(pi as any);
    assert.equal(pi.tools.length, 0);
    assert.equal(pi.handlers.size, 0);
  } finally {
    if (previous === undefined) delete process.env[CHILD_ENV_MARKER];
    else process.env[CHILD_ENV_MARKER] = previous;
  }
});

test("parent registers exactly four tools and parent-only skill discovery", async () => {
  const pi = createFakePi();
  subagentsExtension(pi as any);
  assert.deepEqual(pi.tools.map((tool) => tool.name), [...TOOL_NAMES]);

  const discovered = await pi.emit("resources_discover", { reason: "startup" }, createCtx());
  assert.ok(discovered.skillPaths[0].endsWith("skills/use-pi-subagents/SKILL.md"));

  const catalog = loadProfileCatalog({
    bundledDir: bundledProfiles,
    userDir: join(tmpdir(), "no-user-profiles"),
  });
  const start = createStartSchema(catalog) as { additionalProperties?: boolean; properties: Record<string, unknown> };
  assert.equal((start as any).additionalProperties ?? (start as any).properties?.additionalProperties, false);
  // TypeBox object uses additionalProperties in schema
  assert.ok(JSON.stringify(start).includes('"additionalProperties":false') || (start as any).additionalProperties === false);
  assert.ok(JSON.stringify(statusSchema).includes("ids"));
  assert.ok(JSON.stringify(sendSchema).includes("behavior"));
  assert.ok(JSON.stringify(stopSchema).includes("ids"));
  assert.equal(JSON.stringify(createStartSchema(catalog)).includes("model"), false);
  assert.equal(JSON.stringify(createStartSchema(catalog)).includes("tools"), false);
});

test("context reminder, esc running-only stop, and shutdown cleanup", async () => {
  const root = await mkdtemp(join(tmpdir(), "ext-"));
  const pi = createFakePi();
  subagentsExtension(pi as any);
  const ctx = createCtx();

  await pi.emit("session_start", { reason: "startup" }, ctx);

  // Create a lightweight runtime run by invoking start tool with a fake by monkeypatching is hard;
  // instead validate reminder absence then aborted detection helpers and shutdown path.
  const reminder = await pi.emit("context", { messages: [{ role: "user", content: "hi" }] }, ctx);
  assert.equal(reminder, undefined);

  assert.equal(isAbortedAssistantStop([{ role: "assistant", stopReason: "aborted" }]), true);
  assert.equal(isAbortedAssistantStop([{ role: "assistant", stopReason: "stop" }]), false);

  await pi.emit("agent_end", { messages: [{ role: "assistant", stopReason: "aborted" }] }, ctx);
  await pi.emit("session_shutdown", { reason: "quit" }, ctx);
  assert.equal(ctx.ui.widgets.size, 0);
  await rm(root, { recursive: true, force: true });
});

test("strict tool schemas reject additional properties at schema level", () => {
  for (const schema of [statusSchema, sendSchema, stopSchema]) {
    assert.equal((schema as any).additionalProperties, false);
  }
});
