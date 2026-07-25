/**
 * Pi Office coexistence (`pi-office-legacy-compat` v1) -- the legacy side.
 *
 * These tests pin the contract Pi Office relies on: probe reply shape, exact
 * tool-set suppression/restoration, execute-time fail-closed marker checks
 * (including "failed"/"retained" windows and stale markers), the open-run
 * registry lifecycle, and the Office-managed-child self-disable.
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import subagentsExtension from "../extensions/subagents/index.ts";
import {
  activePolicyDir,
  activePolicyMarkerPath,
  computeRepoKey,
  canonicalizePath,
  COMPAT_PROBE_EVENT,
  COMPAT_RELEASE_EVENT,
  COMPAT_RELEASED_REPLY_EVENT,
  COMPAT_SUPPRESS_EVENT,
  COMPAT_SUPPRESSED_REPLY_EVENT,
  getProcessStartIdentity,
  hashToolSnapshot,
  LEGACY_COMPAT_PROTOCOL_VERSION,
  legacyOpenRunsDir,
  OfficeCompat,
  OfficeWindowError,
  OpenRunRegistry,
  PACKAGE_VERSION,
  type PolicyMarkerState,
} from "../src/office-compat.ts";
import { loadProfileCatalog } from "../src/profiles.ts";
import { boundText, type RpcChild } from "../src/rpc-child.ts";
import { SubagentRuntime } from "../src/runtime.ts";
import { registerSubagentTools } from "../src/tools.ts";
import { fileURLToPath } from "node:url";

const bundledProfiles = fileURLToPath(new URL("../agents", import.meta.url));

type Handler = (...args: any[]) => any;

interface FakePi {
  tools: Array<{ name: string; execute: Handler }>;
  handlers: Map<string, Handler[]>;
  busListeners: Map<string, Array<(data: unknown) => void>>;
  activeTools: () => string[];
  emitBus: (channel: string, data: unknown) => void;
  onBus: (channel: string, handler: (data: unknown) => void) => () => void;
}

function createFakePi(initialActiveTools: string[] = ["read", "bash", "subagent_start"]): FakePi & Record<string, any> {
  const tools: Array<{ name: string; execute: Handler }> = [];
  const handlers = new Map<string, Handler[]>();
  const busListeners = new Map<string, Array<(data: unknown) => void>>();
  let activeTools = [...initialActiveTools];

  const emitBus = (channel: string, data: unknown): void => {
    for (const listener of [...(busListeners.get(channel) ?? [])]) listener(data);
  };
  const onBus = (channel: string, handler: (data: unknown) => void): (() => void) => {
    const list = busListeners.get(channel) ?? [];
    list.push(handler);
    busListeners.set(channel, list);
    return () => {
      busListeners.set(channel, (busListeners.get(channel) ?? []).filter((item) => item !== handler));
    };
  };

  return {
    registerTool(def: { name: string; execute: Handler }) {
      tools.push(def);
    },
    registerCommand() {},
    on(event: string, handler: Handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    getThinkingLevel: () => "medium",
    exec: async () => ({ code: 1, stdout: "", stderr: "" }),
    events: { emit: emitBus, on: onBus },
    getActiveTools: () => [...activeTools],
    setActiveTools: (names: string[]) => {
      activeTools = [...names];
    },
    tools,
    handlers,
    busListeners,
    activeTools: () => [...activeTools],
    emitBus,
    onBus,
  };
}

interface MarkerOverrides {
  state?: PolicyMarkerState;
  runtimePid?: number;
  runtimeStartIdentity?: string;
  officeId?: string;
}

async function writeMarker(home: string, repoPath: string, overrides: MarkerOverrides = {}): Promise<string> {
  const dir = activePolicyDir(home);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const path = activePolicyMarkerPath(home, computeRepoKey(canonicalizePath(repoPath)));
  const pid = overrides.runtimePid ?? process.pid;
  const identity = overrides.runtimeStartIdentity ?? (await getProcessStartIdentity(pid)) ?? "identity-unavailable";
  const marker = {
    schemaVersion: 1,
    protocolVersion: 1,
    officeId: overrides.officeId ?? "Otest0001",
    repoPath: canonicalizePath(repoPath),
    supervisorSessionId: "supervisor-session",
    runtimePid: pid,
    runtimeStartIdentity: identity,
    socketPath: join(home, "office-sock", "Otest0001.sock"),
    reservedAt: Date.now(),
    state: overrides.state ?? "active",
  };
  await writeFile(path, `${JSON.stringify(marker, null, 2)}\n`, { mode: 0o600 });
  return path;
}

/** Run `body` with an isolated Pi Office home and a scratch "repository". */
async function withIsolatedOffice(
  body: (env: { home: string; repo: string; other: string }) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "office-compat-"));
  const home = join(root, "agent");
  const repo = join(root, "repo");
  const other = join(root, "other-repo");
  await mkdir(home, { recursive: true });
  await mkdir(repo, { recursive: true });
  await mkdir(other, { recursive: true });
  const previous = process.env.PI_OFFICE_HOME;
  process.env.PI_OFFICE_HOME = home;
  try {
    await body({ home, repo, other });
  } finally {
    if (previous === undefined) delete process.env.PI_OFFICE_HOME;
    else process.env.PI_OFFICE_HOME = previous;
    await rm(root, { recursive: true, force: true });
  }
}

function startTool(pi: { tools: Array<{ name: string; execute: Handler }> }): Handler {
  const tool = pi.tools.find((item) => item.name === "subagent_start");
  assert.ok(tool, "subagent_start must be registered");
  return tool!.execute;
}

async function expectRefusal(promise: Promise<unknown>, code: string): Promise<OfficeWindowError> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  assert.ok(error instanceof OfficeWindowError, `expected an OfficeWindowError, got ${String(error)}`);
  assert.equal((error as OfficeWindowError).code, code);
  return error as OfficeWindowError;
}

async function waitFor(condition: () => boolean | Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("condition not met within timeout");
}

// ---------------------------------------------------------------------------

test("probe reply reports protocol, package version, open runs and parent session", async () => {
  await withIsolatedOffice(async () => {
    const pi = createFakePi();
    subagentsExtension(pi as any);

    const replies: unknown[] = [];
    pi.onBus("reply-channel-1", (data) => replies.push(data));
    pi.emitBus(COMPAT_PROBE_EVENT, { protocolVersion: 1, replyEvent: "reply-channel-1" });

    // The reply must arrive SYNCHRONOUSLY during dispatch: Pi Office waits one
    // macrotask and treats a late answer as an incompatible companion.
    assert.equal(replies.length, 1);
    assert.deepEqual(replies[0], {
      protocolVersion: LEGACY_COMPAT_PROTOCOL_VERSION,
      packageVersion: PACKAGE_VERSION,
      openRunCount: 0,
      parentSessionId: "unbound-session",
    });

    // Malformed probes are ignored, never answered with a half-valid reply.
    const ignored: unknown[] = [];
    pi.onBus("reply-channel-2", (data) => ignored.push(data));
    pi.emitBus(COMPAT_PROBE_EVENT, { protocolVersion: 1 });
    pi.emitBus(COMPAT_PROBE_EVENT, { replyEvent: "reply-channel-2" });
    assert.equal(ignored.length, 0);
  });
});

test("probe reply carries the bound session id and open run count", async () => {
  await withIsolatedOffice(async ({ repo }) => {
    const pi = createFakePi();
    subagentsExtension(pi as any);

    const ctx = {
      mode: "rpc",
      hasUI: false,
      cwd: repo,
      sessionManager: { getSessionId: () => "parent-session-42" },
      ui: { setWidget() {}, notify() {} },
    };
    for (const handler of pi.handlers.get("session_start") ?? []) await handler({ reason: "startup" }, ctx);

    const replies: unknown[] = [];
    pi.onBus("reply-3", (data) => replies.push(data));
    pi.emitBus(COMPAT_PROBE_EVENT, { protocolVersion: 1, replyEvent: "reply-3" });
    assert.equal((replies[0] as { parentSessionId: string }).parentSessionId, "parent-session-42");
    assert.equal((replies[0] as { openRunCount: number }).openRunCount, 0);
  });
});

test("suppress snapshots and removes exactly its own tools; release restores the exact prior set", async () => {
  await withIsolatedOffice(async ({ home, repo }) => {
    const initial = ["read", "subagent_start", "bash", "subagent_send", "subagent_status", "subagent_stop", "write"];
    const pi = createFakePi(initial);
    subagentsExtension(pi as any);

    const suppressed: unknown[] = [];
    pi.onBus(COMPAT_SUPPRESSED_REPLY_EVENT, (data) => suppressed.push(data));
    const markerPath = activePolicyMarkerPath(home, computeRepoKey(canonicalizePath(repo)));
    pi.emitBus(COMPAT_SUPPRESS_EVENT, { officeId: "Otest0001", policyPath: markerPath });

    assert.deepEqual(suppressed, [{ previousToolsHash: hashToolSnapshot(initial) }]);
    assert.deepEqual(pi.activeTools(), ["read", "bash", "write"]);

    const released: unknown[] = [];
    pi.onBus(COMPAT_RELEASED_REPLY_EVENT, (data) => released.push(data));
    pi.emitBus(COMPAT_RELEASE_EVENT, { officeId: "Otest0001" });

    assert.deepEqual(released, [{ officeId: "Otest0001" }]);
    // Exact array, original order included.
    assert.deepEqual(pi.activeTools(), initial);
  });
});

test("suppressed legacy tools fail closed on execute even without a marker", async () => {
  await withIsolatedOffice(async ({ home, repo }) => {
    const pi = createFakePi();
    subagentsExtension(pi as any);
    const markerPath = activePolicyMarkerPath(home, computeRepoKey(canonicalizePath(repo)));
    pi.emitBus(COMPAT_SUPPRESS_EVENT, { officeId: "Osuppress", policyPath: markerPath });

    const error = await expectRefusal(
      startTool(pi)("call-1", { profile: "scout", task: "t", cwd: repo }, undefined, undefined, { cwd: repo }),
      "office-suppressed",
    );
    assert.match(error.message, /office_agent_\*/);
    assert.match(error.message, /no fallback/);
  });
});

test("an active policy marker fails every subagent tool closed, in any window state", async () => {
  await withIsolatedOffice(async ({ home, repo }) => {
    const pi = createFakePi();
    subagentsExtension(pi as any);

    for (const state of ["reserved", "active", "paused", "recovering", "failed", "retained"] as PolicyMarkerState[]) {
      await writeMarker(home, repo, { state });
      for (const toolName of ["subagent_start", "subagent_status", "subagent_send", "subagent_stop"]) {
        const tool = pi.tools.find((item) => item.name === toolName);
        assert.ok(tool, `${toolName} must be registered`);
        const params = toolName === "subagent_start"
          ? { profile: "scout", task: "t", cwd: repo }
          : toolName === "subagent_send"
            ? { id: "run-x", message: "m" }
            : { ids: ["run-x"] };
        const error = await expectRefusal(
          tool!.execute("call", params, undefined, undefined, { cwd: repo }),
          "office-active",
        );
        // A failed/retained Office still holds the window: state is evidence,
        // never a gate.
        assert.match(error.message, new RegExp(`window state ${state}`));
        assert.equal(error.officeId, "Otest0001");
      }
    }
  });
});

test("a stale marker (dead or identity-mismatched runtime) also fails closed, with reconcile guidance", async () => {
  await withIsolatedOffice(async ({ home, repo }) => {
    const pi = createFakePi();
    subagentsExtension(pi as any);

    const markerPath = await writeMarker(home, repo, {
      runtimeStartIdentity: "darwin:pid=1:lstart=Thu Jan  1 00:00:00 1970:ppid=0",
    });
    const error = await expectRefusal(
      startTool(pi)("call", { profile: "scout", task: "t", cwd: repo }, undefined, undefined, { cwd: repo }),
      "office-stale-marker",
    );
    assert.match(error.message, /office_reconcile/);
    assert.equal(error.markerPath, markerPath);

    // Fail-closed never means "clean up": the marker belongs to Pi Office.
    await stat(markerPath);
  });
});

test("an unreadable or invalid marker fails closed instead of being ignored", async () => {
  await withIsolatedOffice(async ({ home, repo }) => {
    const pi = createFakePi();
    subagentsExtension(pi as any);
    const dir = activePolicyDir(home);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const markerPath = activePolicyMarkerPath(home, computeRepoKey(canonicalizePath(repo)));
    await writeFile(markerPath, "{not json", { mode: 0o600 });

    await expectRefusal(
      startTool(pi)("call", { profile: "scout", task: "t", cwd: repo }, undefined, undefined, { cwd: repo }),
      "office-marker-unreadable",
    );

    await writeFile(markerPath, JSON.stringify({ schemaVersion: 1, protocolVersion: 1 }), { mode: 0o600 });
    await expectRefusal(
      startTool(pi)("call", { profile: "scout", task: "t", cwd: repo }, undefined, undefined, { cwd: repo }),
      "office-marker-unreadable",
    );
  });
});

test("a marker for an unrelated repository does not block, an ancestor repository does", async () => {
  await withIsolatedOffice(async ({ home, repo, other }) => {
    const pi = createFakePi();
    subagentsExtension(pi as any);

    // Marker held for `other`; a launch into `repo` is unrelated. The tool
    // therefore proceeds past the guard and fails in the runtime instead
    // (no parent session is bound in this harness).
    await writeMarker(home, other);
    const error = await startTool(pi)("call", { profile: "scout", task: "t", cwd: repo }, undefined, undefined, { cwd: repo })
      .then(() => null, (caught: unknown) => caught);
    assert.ok(error instanceof Error);
    assert.equal(error instanceof OfficeWindowError, false);
    assert.match((error as Error).message, /not bound to a parent session/);

    // A launch into a SUBDIRECTORY of the held repository is covered.
    const nested = join(other, "packages", "app");
    await mkdir(nested, { recursive: true });
    await expectRefusal(
      startTool(pi)("call", { profile: "scout", task: "t", cwd: nested }, undefined, undefined, { cwd: repo }),
      "office-active",
    );
  });
});

test("open-run registry records live runs with Office-comparable identities and is removed at shutdown", async () => {
  await withIsolatedOffice(async ({ home, repo }) => {
    const catalog = loadProfileCatalog({ bundledDir: bundledProfiles, userDir: join(home, "missing") });
    const registry = new OpenRunRegistry(home, "parent/session:1");
    const transcriptRoot = join(home, "transcripts");

    const createChild: typeof RpcChild.start = async (options) => {
      const child = {
        transcriptPath: options.transcriptPath,
        cwd: options.cwd,
        pid: process.pid,
        get latestAssistantText() { return ""; },
        get isPartialAssistant() { return true; },
        get isActive() { return true; },
        get hasExited() { return false; },
        async prompt() {},
        async steer() {},
        async followUp() {},
        async abort() {},
        markTimeoutRequested() {},
        markStopRequested() {},
        async stop() {},
        getBoundedAssistantText() { return boundText(""); },
      };
      return child as unknown as RpcChild;
    };

    const runtime = new SubagentRuntime({
      catalog,
      parentSessionId: "parent/session:1",
      transcriptRoot,
      createChild,
      openRuns: registry,
      defaultExecutionTimeoutMs: 30_000,
    });

    const run = await runtime.start({ profile: "scout", task: "keep running", cwd: repo, parent: {} });
    await waitFor(async () => {
      try {
        await stat(registry.path);
        return true;
      } catch {
        return false;
      }
    });

    assert.equal(registry.path, join(legacyOpenRunsDir(home), "parent_session_1.json"));
    const fileStat = await stat(registry.path);
    assert.equal(fileStat.mode & 0o777, 0o600);
    const dirStat = await stat(legacyOpenRunsDir(home));
    assert.equal(dirStat.mode & 0o777, 0o700);

    const parsed = JSON.parse(await readFile(registry.path, "utf8")) as {
      schemaVersion: number;
      runs: Array<{ id: string; pid: number; startIdentity: string; profile: string; startedAt: number }>;
    };
    assert.equal(parsed.schemaVersion, 1);
    assert.equal(parsed.runs.length, 1);
    assert.equal(parsed.runs[0]!.id, run.id);
    assert.equal(parsed.runs[0]!.pid, process.pid);
    assert.equal(parsed.runs[0]!.profile, "scout");
    assert.ok(parsed.runs[0]!.startedAt > 0);
    // The identity string format is part of the contract: Pi Office re-observes
    // the pid itself and compares the exact string. It must also contain no
    // component that changes during a process's life (notably `ppid`, which
    // changes when a detached process is reparented) -- otherwise every
    // cross-check after a Pi restart would report a false pid reuse.
    assert.equal(parsed.runs[0]!.startIdentity, await getProcessStartIdentity(process.pid));
    assert.equal(parsed.runs[0]!.startIdentity.includes("ppid"), false);

    // Stopping the run removes it (no lingering entries for dead work).
    await runtime.stop([run.id]);
    await assert.rejects(stat(registry.path));

    // A second run reappears in the registry; shutdown removes the file.
    const second = await runtime.start({ profile: "worker", task: "keep running", cwd: repo, parent: {} });
    await waitFor(async () => {
      try {
        await stat(registry.path);
        return true;
      } catch {
        return false;
      }
    });
    assert.ok(second.id);
    await runtime.shutdown();
    await assert.rejects(stat(registry.path));
  });
});

test("the probe reports open runs so Pi Office refuses to activate over them", async () => {
  await withIsolatedOffice(async ({ home }) => {
    const pi = createFakePi();
    const compat = new OfficeCompat({
      host: pi as any,
      toolNames: ["subagent_start"],
      home,
      getOpenRunCount: () => 2,
      getParentSessionId: () => "sess-open",
    });
    compat.install();

    const replies: Array<{ openRunCount: number; parentSessionId: string }> = [];
    pi.onBus("reply-open", (data) => replies.push(data as { openRunCount: number; parentSessionId: string }));
    pi.emitBus(COMPAT_PROBE_EVENT, { protocolVersion: 1, replyEvent: "reply-open" });
    assert.equal(replies[0]!.openRunCount, 2);
    assert.equal(replies[0]!.parentSessionId, "sess-open");
  });
});

test("the default tool guard fails closed even without a handshake controller", async () => {
  await withIsolatedOffice(async ({ home, repo }) => {
    const catalog = loadProfileCatalog({ bundledDir: bundledProfiles, userDir: join(home, "missing") });
    const pi = createFakePi();
    // No guard argument: registerSubagentTools must still install the
    // marker-only check, never a no-op.
    registerSubagentTools(pi as any, { get: () => { throw new Error("runtime must not be reached"); } }, catalog);
    await writeMarker(home, repo);
    await expectRefusal(
      startTool(pi)("call", { profile: "scout", task: "t", cwd: repo }, undefined, undefined, { cwd: repo }),
      "office-active",
    );
  });
});

test("an Office-managed child self-disables: no tools, no hooks, no bus listeners", async () => {
  await withIsolatedOffice(async () => {
    for (const marker of ["PI_OFFICE_RUN_ID", "PI_OFFICE_BOOTSTRAP"]) {
      const previous = process.env[marker];
      process.env[marker] = marker === "PI_OFFICE_RUN_ID" ? "worker-m1-1-abcd" : "/tmp/bootstrap.json";
      try {
        const pi = createFakePi();
        subagentsExtension(pi as any);
        assert.equal(pi.tools.length, 0);
        assert.equal(pi.handlers.size, 0);
        assert.equal(pi.busListeners.size, 0);
      } finally {
        if (previous === undefined) delete process.env[marker];
        else process.env[marker] = previous;
      }
    }
  });
});
