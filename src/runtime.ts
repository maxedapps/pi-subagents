import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getProcessStartIdentity,
  type LegacyOpenRun,
  type OpenRunRegistryWriter,
} from "./office-compat.ts";
import type { Profile, ProfileCatalog, ProfileName } from "./profiles.ts";
import {
  boundText,
  type ParentLaunchSnapshot,
  RpcChild,
  type SettlementEvent,
} from "./rpc-child.ts";

export type RunState =
  | "starting"
  | "running"
  | "idle"
  | "failed"
  | "timedout"
  | "blocked"
  | "stopped";

export type NextAction = "wait" | "inspect/retry" | "send" | "stop" | "retained-cleanup";
export type RecoveryState = "running" | "succeeded" | "failed";

export interface RecoverySnapshot {
  state: RecoveryState;
  summary?: string;
  error?: string;
}

export interface RunSnapshot {
  id: string;
  profile: ProfileName;
  state: RunState;
  generation: number;
  cwd: string;
  output: string;
  partial: boolean;
  error?: string;
  reason?: string;
  recovery?: RecoverySnapshot;
  transcriptPath: string;
  needsStop: boolean;
  nextAction: NextAction;
}

export interface StatusResult {
  runs: RunSnapshot[];
  waitTimedOut?: boolean;
}

export interface StopResult {
  id: string;
  ok: boolean;
  state?: RunState;
  error?: string;
  transcriptPath?: string;
  retained?: boolean;
  nextAction?: NextAction;
}

export interface RuntimeOptions {
  catalog: ProfileCatalog;
  parentSessionId: string;
  transcriptRoot?: string;
  executable?: string;
  createChild?: typeof RpcChild.start;
  now?: () => number;
  onChange?: () => void;
  closeViewer?: (runId: string) => Promise<void> | void;
  defaultExecutionTimeoutMs?: number;
  stopGraceMs?: number;
  /**
   * Pi Office open-run registry (see office-compat.ts). When present, every
   * live run is published to `<office home>/subagents/open-runs/<session>.json`
   * so a Pi Office in ANOTHER process can see it and refuse to activate over
   * it. Best effort by design: registry IO never breaks a run.
   */
  openRuns?: OpenRunRegistryWriter;
  /** Injectable for tests; must produce the same identity strings Pi Office observes. */
  processStartIdentity?: (pid: number) => Promise<string | null>;
}

interface RunRecord {
  id: string;
  profile: ProfileName;
  cwd: string;
  state: RunState;
  generation: number;
  transcriptPath: string;
  systemPromptFile: string;
  output: string;
  partial: boolean;
  error?: string;
  reason?: string;
  child?: RpcChild;
  pid?: number;
  startIdentity?: string;
  startedAt?: number;
  executionTimer?: ReturnType<typeof setTimeout>;
  executionDeadlineMs?: number;
  wrapUpTimer?: ReturnType<typeof setTimeout>;
  recoveryTimer?: ReturnType<typeof setTimeout>;
  recoveryState?: RecoveryState;
  recoverySummary?: string;
  recoveryError?: string;
  queue: Promise<void>;
  retainedTranscript?: boolean;
}

const ACTIVE = new Set<RunState>(["starting", "running"]);
const SETTLED = new Set<RunState>(["idle", "failed", "timedout", "blocked", "stopped"]);
const DEFAULT_EXECUTION_TIMEOUT_MS = 900_000;
const WRAP_UP_LEAD_MS = 60_000;
const RECOVERY_TIMEOUT_MS = 60_000;
const MAX_WAIT_MS = 300_000;

const WRAP_UP_PROMPT =
  "The execution deadline is approaching. Stop starting new work or research. "
  + "Finish current tool calls, then return the best concise handoff you can from evidence already gathered, "
  + "including findings/results, relevant paths or sources, validation, caveats, and unfinished work.";

const RECOVERY_PROMPT =
  "The previous attempt ended unexpectedly. Do not call tools or do more work. "
  + "Using only the task and evidence already present in this conversation, return a concise recovery handoff "
  + "covering findings/results, relevant paths or sources, validation performed, caveats, and unfinished work.";

function shortId(): string {
  return `run-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
}

function isActive(run: RunRecord): boolean {
  return ACTIVE.has(run.state) || run.recoveryState === "running";
}

function isSettledSnapshot(run: RunSnapshot): boolean {
  return SETTLED.has(run.state) && run.recovery?.state !== "running";
}

export function nextActionFor(state: RunState, needsStop: boolean): NextAction {
  if (state === "starting" || state === "running") return "wait";
  if (state === "idle") return needsStop ? "send" : "stop";
  if (state === "failed" || state === "timedout" || state === "blocked") return "inspect/retry";
  if (state === "stopped") return "stop";
  return "stop";
}

export class SubagentRuntime {
  private readonly catalog: ProfileCatalog;
  private readonly parentSessionId: string;
  private readonly transcriptRoot: string;
  private readonly executable?: string;
  private readonly createChild: typeof RpcChild.start;
  private readonly now: () => number;
  private readonly onChange: () => void;
  private readonly closeViewer?: (runId: string) => Promise<void> | void;
  private readonly defaultExecutionTimeoutMs: number;
  private readonly openRuns: OpenRunRegistryWriter | undefined;
  private readonly processStartIdentity: (pid: number) => Promise<string | null>;
  private readonly runs = new Map<string, RunRecord>();
  private readonly ownedTranscriptRoot: boolean;
  private shuttingDown = false;

  constructor(options: RuntimeOptions) {
    this.catalog = options.catalog;
    this.parentSessionId = options.parentSessionId;
    this.executable = options.executable;
    this.createChild = options.createChild ?? RpcChild.start.bind(RpcChild);
    this.now = options.now ?? Date.now;
    this.onChange = options.onChange ?? (() => {});
    this.closeViewer = options.closeViewer;
    this.defaultExecutionTimeoutMs = options.defaultExecutionTimeoutMs ?? DEFAULT_EXECUTION_TIMEOUT_MS;
    this.openRuns = options.openRuns;
    this.processStartIdentity = options.processStartIdentity ?? ((pid) => getProcessStartIdentity(pid));
    if (options.transcriptRoot) {
      this.transcriptRoot = options.transcriptRoot;
      mkdirSync(this.transcriptRoot, { recursive: true, mode: 0o700 });
      this.ownedTranscriptRoot = false;
    } else {
      const base = join(tmpdir(), "pi-subagents");
      mkdirSync(base, { recursive: true, mode: 0o700 });
      this.transcriptRoot = mkdtempSync(join(base, `${this.parentSessionId.slice(0, 8)}-`));
      this.ownedTranscriptRoot = true;
    }
  }

  get transcriptDirectory(): string {
    return this.transcriptRoot;
  }

  listOpen(): RunSnapshot[] {
    return [...this.runs.values()]
      .filter((run) => run.state !== "stopped")
      .map((run) => this.snapshot(run));
  }

  listAll(): RunSnapshot[] {
    return [...this.runs.values()].map((run) => this.snapshot(run));
  }

  get(id: string): RunSnapshot | undefined {
    const run = this.runs.get(id);
    return run ? this.snapshot(run) : undefined;
  }

  hasOpenRuns(): boolean {
    return [...this.runs.values()].some((run) => run.state !== "stopped");
  }

  hasActiveRuns(): boolean {
    return [...this.runs.values()].some((run) => isActive(run));
  }

  async start(input: {
    profile: ProfileName;
    task: string;
    cwd: string;
    wait?: boolean;
    executionTimeoutMs?: number;
    parent: ParentLaunchSnapshot;
    signal?: AbortSignal;
  }): Promise<RunSnapshot> {
    const profile = this.catalog[input.profile];
    if (!profile) throw new Error(`Unknown profile: ${input.profile}`);
    const id = shortId();
    const runDir = join(this.transcriptRoot, id);
    mkdirSync(runDir, { recursive: true, mode: 0o700 });
    const systemPromptFile = join(runDir, "system-prompt.md");
    writeFileSync(systemPromptFile, `${profile.systemPrompt}\n`, { mode: 0o600 });
    const transcriptPath = join(runDir, "transcript.txt");
    const run: RunRecord = {
      id,
      profile: profile.name,
      cwd: input.cwd,
      state: "starting",
      generation: 0,
      transcriptPath,
      systemPromptFile,
      output: "",
      partial: true,
      queue: Promise.resolve(),
    };
    this.runs.set(id, run);
    this.emitChange();
    this.armExecutionTimeout(run, input.executionTimeoutMs ?? this.defaultExecutionTimeoutMs);

    const boot = this.enqueue(run, async () => {
      const child = await this.createChild({
        executable: this.executable,
        cwd: input.cwd,
        systemPromptFile,
        transcriptPath,
        parent: input.parent,
      }, {
        onSettlement: (event) => this.handleSettlement(run, event),
        onExit: () => this.handleExit(run),
        onError: (error) => {
          if (run.recoveryState === "running") {
            this.failRecovery(run, error.message);
          } else if (ACTIVE.has(run.state)) {
            run.state = "failed";
            run.error = error.message;
            run.reason = error.message;
            run.partial = false;
            this.clearExecutionTimeout(run);
            this.emitChange();
          }
        },
      });
      if (!ACTIVE.has(run.state)) {
        await child.stop();
        return;
      }
      run.child = child;
      run.state = "running";
      run.generation = 1;
      this.emitChange();
      // Publish the live process to the Pi Office open-run registry as soon as
      // it exists, so an Office activating in another process sees this run and
      // refuses to activate over it. Deliberately not awaited: capturing the
      // start identity execs `ps`, and run latency must not depend on it.
      void this.recordOpenRun(run).catch(() => {});
      await child.prompt(input.task);
    });

    boot.catch((error: Error) => {
      run.state = "failed";
      run.error = error.message;
      run.reason = error.message;
      run.partial = false;
      this.clearExecutionTimeout(run);
      this.emitChange();
    });

    if (!input.wait) {
      await Promise.race([boot, Promise.resolve()]);
      return this.snapshot(run);
    }

    return this.waitForRuns([id], undefined, input.signal).then((result) => {
      const snap = result.runs.find((item) => item.id === id) ?? this.snapshot(run);
      return snap;
    });
  }

  async status(input: {
    ids?: string[];
    wait?: boolean;
    waitTimeoutMs?: number;
    signal?: AbortSignal;
  } = {}): Promise<StatusResult> {
    if (input.wait) {
      if (!input.ids?.length) throw new Error("wait:true requires non-empty ids");
      return this.waitForRuns(input.ids, input.waitTimeoutMs, input.signal);
    }
    if (!input.ids?.length) return { runs: this.listOpen() };
    return {
      runs: input.ids.map((id) => {
        const run = this.runs.get(id);
        if (!run) {
          return {
            id,
            profile: "unknown",
            state: "stopped" as const,
            generation: 0,
            cwd: "",
            output: "",
            partial: false,
            error: "unknown run id",
            reason: "unknown-run",
            transcriptPath: "",
            needsStop: false,
            nextAction: "stop" as const,
          };
        }
        return this.snapshot(run);
      }),
    };
  }

  async send(input: {
    id: string;
    message: string;
    behavior?: "steer" | "follow-up";
    wait?: boolean;
    executionTimeoutMs?: number;
    signal?: AbortSignal;
  }): Promise<RunSnapshot> {
    const run = this.runs.get(input.id);
    if (!run) throw new Error(`Unknown run id: ${input.id}`);
    if (run.state === "stopped") throw new Error(`Run ${input.id} is stopped`);

    const work = this.enqueue(run, async () => {
      const child = run.child;
      if (!child) throw new Error(`Run ${input.id} has no live child`);

      if (ACTIVE.has(run.state) || child.isActive) {
        if (!input.behavior) {
          throw new Error("Active run requires behavior: \"steer\" or \"follow-up\"");
        }
        if (input.behavior === "steer") await child.steer(input.message);
        else await child.followUp(input.message);
        run.state = "running";
        run.partial = true;
        this.emitChange();
        return;
      }

      if (run.state !== "idle") {
        throw new Error(`Cannot send prompt while state is ${run.state}`);
      }
      if (input.behavior) {
        throw new Error("behavior is only valid while a generation is running");
      }
      run.state = "running";
      run.generation += 1;
      run.output = "";
      run.partial = true;
      run.error = undefined;
      run.reason = undefined;
      this.armExecutionTimeout(run, input.executionTimeoutMs ?? this.defaultExecutionTimeoutMs);
      this.emitChange();
      await child.prompt(input.message);
    });

    if (!input.wait) {
      await Promise.race([work, Promise.resolve()]);
      return this.snapshot(run);
    }
    await Promise.race([work, Promise.resolve()]);
    const waited = await this.waitForRuns([run.id], undefined, input.signal);
    return waited.runs[0] ?? this.snapshot(run);
  }

  async stop(ids: string[]): Promise<StopResult[]> {
    const results: StopResult[] = [];
    for (const id of ids) {
      results.push(await this.stopOne(id));
    }
    return results;
  }

  async stopActive(reason = "parent-abort"): Promise<StopResult[]> {
    const activeIds = [...this.runs.values()]
      .filter((run) => isActive(run))
      .map((run) => run.id);
    const results: StopResult[] = [];
    for (const id of activeIds) {
      results.push(await this.stopOne(id, reason));
    }
    return results;
  }

  async shutdown(): Promise<{ transcriptDirectory?: string; retained: boolean }> {
    this.shuttingDown = true;
    const ids = [...this.runs.keys()];
    for (const id of ids) {
      await this.stopOne(id, "session-shutdown", true);
    }
    // The registry describes runs owned by THIS session; the session is over.
    try {
      this.openRuns?.clear();
    } catch {
      // registry IO is best effort and must never break shutdown
    }
    let retained = false;
    for (const run of this.runs.values()) {
      if (run.child && !run.child.hasExited) {
        retained = true;
        run.retainedTranscript = true;
      }
    }
    if (!retained && this.ownedTranscriptRoot) {
      try {
        rmSync(this.transcriptRoot, { recursive: true, force: true });
        return { retained: false };
      } catch {
        retained = true;
      }
    }
    return {
      retained,
      ...(retained || !this.ownedTranscriptRoot ? { transcriptDirectory: this.transcriptRoot } : {}),
    };
  }

  formatReminder(): string | undefined {
    const open = this.listOpen();
    if (!open.length) return undefined;
    const lines = [
      "Open subagent runs require explicit supervision before workflow completion:",
      ...open.map((run) =>
        `- ${run.id} [${run.profile}] state=${run.state}`
        + `${run.recovery ? ` recovery=${run.recovery.state}` : ""}`
        + ` generation=${run.generation} cwd=${run.cwd} nextAction=${run.nextAction}`
      ),
      "Poll or wait with subagent_status, inspect every settled output, then subagent_stop each run. Async children do not wake the parent automatically.",
    ];
    return lines.join("\n");
  }

  private async stopOne(id: string, reason = "explicit-stop", includeIdle = true): Promise<StopResult> {
    const run = this.runs.get(id);
    if (!run) {
      return { id, ok: false, error: "unknown run id" };
    }
    if (run.state === "stopped") {
      return {
        id,
        ok: true,
        state: "stopped",
        transcriptPath: run.transcriptPath,
        nextAction: "stop",
      };
    }
    if (!includeIdle && !isActive(run)) {
      return {
        id,
        ok: true,
        state: run.state,
        transcriptPath: run.transcriptPath,
        nextAction: nextActionFor(run.state, true),
      };
    }

    this.clearExecutionTimeout(run);
    this.clearRecoveryTimeout(run);
    try {
      await this.closeViewer?.(id);
    } catch {
      // viewer cleanup is best-effort
    }

    try {
      if (run.child) {
        run.child.markStopRequested();
        await run.child.stop();
      }
      run.state = "stopped";
      run.reason = reason;
      run.partial = false;
      this.runs.delete(id);
      this.syncOpenRuns();
      this.emitChange();
      return {
        id,
        ok: true,
        state: "stopped",
        transcriptPath: run.transcriptPath,
        nextAction: "stop",
      };
    } catch (error) {
      run.retainedTranscript = true;
      run.error = error instanceof Error ? error.message : String(error);
      this.emitChange();
      return {
        id,
        ok: false,
        error: run.error,
        transcriptPath: run.transcriptPath,
        retained: true,
        nextAction: "retained-cleanup",
      };
    }
  }

  private async waitForRuns(
    ids: string[],
    waitTimeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<StatusResult> {
    const timeout = waitTimeoutMs === undefined ? undefined : Math.min(Math.max(1, waitTimeoutMs), MAX_WAIT_MS);
    const deadline = timeout === undefined ? undefined : this.now() + timeout;

    const poll = async (): Promise<StatusResult> => {
      while (true) {
        if (signal?.aborted) {
          await this.stopActive("wait-aborted");
          return { runs: ids.map((id) => this.requiredSnapshot(id)) };
        }
        const snaps = ids.map((id) => this.requiredSnapshot(id));
        if (snaps.every(isSettledSnapshot)) {
          return { runs: snaps };
        }
        if (deadline !== undefined && this.now() >= deadline) {
          return { runs: snaps, waitTimedOut: true };
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    };

    if (signal) {
      return new Promise<StatusResult>((resolve, reject) => {
        const onAbort = () => {
          void this.stopActive("wait-aborted").finally(() => {
            resolve({ runs: ids.map((id) => this.requiredSnapshot(id)) });
          });
        };
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener("abort", onAbort, { once: true });
        poll().then((result) => {
          signal.removeEventListener("abort", onAbort);
          resolve(result);
        }, (error) => {
          signal.removeEventListener("abort", onAbort);
          reject(error);
        });
      });
    }
    return poll();
  }

  private requiredSnapshot(id: string): RunSnapshot {
    const run = this.runs.get(id);
    if (!run) {
      return {
        id,
        profile: "unknown",
        state: "stopped",
        generation: 0,
        cwd: "",
        output: "",
        partial: false,
        error: "unknown run id",
        reason: "unknown-run",
        transcriptPath: "",
        needsStop: false,
        nextAction: "stop",
      };
    }
    return this.snapshot(run);
  }

  private snapshot(run: RunRecord): RunSnapshot {
    const needsStop = run.state !== "stopped";
    const output = run.recoveryState
      ? boundText(run.output)
      : run.child?.getBoundedAssistantText() || boundText(run.output);
    const recovery = run.recoveryState
      ? {
          state: run.recoveryState,
          ...(run.recoverySummary ? { summary: boundText(run.recoverySummary) } : {}),
          ...(run.recoveryError ? { error: run.recoveryError } : {}),
        }
      : undefined;
    return {
      id: run.id,
      profile: run.profile,
      state: run.state,
      generation: run.generation,
      cwd: run.cwd,
      output,
      partial: run.partial || run.recoveryState === "running" || (!run.recoveryState && Boolean(run.child?.isPartialAssistant)),
      ...(run.error ? { error: run.error } : {}),
      ...(run.reason ? { reason: run.reason } : {}),
      ...(recovery ? { recovery } : {}),
      transcriptPath: run.transcriptPath,
      needsStop,
      nextAction: run.retainedTranscript
        ? "retained-cleanup"
        : run.recoveryState === "running"
          ? "wait"
          : nextActionFor(run.state, needsStop),
    };
  }

  private handleSettlement(run: RunRecord, event: SettlementEvent): void {
    if (run.recoveryState === "running") {
      this.handleRecoverySettlement(run, event);
      return;
    }

    this.clearExecutionTimeout(run);
    const state = event.classification.state === "stopped" && this.shuttingDown
      ? "stopped"
      : event.classification.state;
    run.state = state;
    run.output = event.assistantText;
    run.partial = false;
    run.reason = event.classification.reason;
    if (state === "failed" || state === "timedout" || state === "blocked") {
      run.error = event.classification.reason;
    } else {
      run.error = undefined;
    }

    if (
      (state === "failed" || state === "timedout" || state === "blocked")
      && run.child
      && !run.child.hasExited
      && !this.shuttingDown
    ) {
      run.recoveryState = "running";
      run.recoverySummary = undefined;
      run.recoveryError = undefined;
      this.emitChange();
      void this.startRecovery(run);
      return;
    }
    this.emitChange();
  }

  private handleRecoverySettlement(run: RunRecord, event: SettlementEvent): void {
    this.clearRecoveryTimeout(run);
    if (event.classification.state === "idle" && event.assistantText) {
      run.recoveryState = "succeeded";
      run.recoverySummary = event.assistantText;
      run.recoveryError = undefined;
    } else {
      this.failRecovery(run, event.classification.reason);
      return;
    }
    this.emitChange();
  }

  private async startRecovery(run: RunRecord): Promise<void> {
    const child = run.child;
    if (!child || child.hasExited || run.recoveryState !== "running") {
      this.failRecovery(run, "child unavailable for recovery summary");
      return;
    }
    this.armRecoveryTimeout(run);
    try {
      await child.prompt(RECOVERY_PROMPT);
    } catch (error) {
      if (child.isActive) {
        child.markTimeoutRequested();
        try {
          await child.abort();
        } catch {
          // best effort
        }
      }
      this.failRecovery(run, error instanceof Error ? error.message : String(error));
    }
  }

  private failRecovery(run: RunRecord, reason: string): void {
    if (run.recoveryState !== "running") return;
    this.clearRecoveryTimeout(run);
    run.recoveryState = "failed";
    run.recoverySummary = undefined;
    run.recoveryError = reason;
    this.emitChange();
  }

  private handleExit(run: RunRecord): void {
    // The process is gone: drop it from the open-run registry immediately
    // rather than leaving an entry Pi Office would have to classify as stale.
    this.syncOpenRuns();
    if (run.state === "stopped") return;
    if (run.recoveryState === "running") {
      this.failRecovery(run, "child exited during recovery summary");
      return;
    }
    if (ACTIVE.has(run.state)) {
      run.state = "blocked";
      run.reason = "premature-exit";
      run.error = "child exited before settlement";
      run.partial = false;
      this.clearExecutionTimeout(run);
      this.emitChange();
    }
  }

  private armExecutionTimeout(run: RunRecord, timeoutMs: number): void {
    this.clearExecutionTimeout(run);
    const ms = Math.max(1, timeoutMs);
    run.executionDeadlineMs = this.now() + ms;
    const wrapUpLead = Math.min(WRAP_UP_LEAD_MS, Math.floor(ms / 5));
    if (wrapUpLead > 0) {
      run.wrapUpTimer = setTimeout(() => {
        void this.requestWrapUp(run);
      }, ms - wrapUpLead);
    }
    run.executionTimer = setTimeout(() => {
      void this.onExecutionTimeout(run);
    }, ms);
  }

  private clearExecutionTimeout(run: RunRecord): void {
    if (run.executionTimer) clearTimeout(run.executionTimer);
    if (run.wrapUpTimer) clearTimeout(run.wrapUpTimer);
    run.executionTimer = undefined;
    run.wrapUpTimer = undefined;
    run.executionDeadlineMs = undefined;
  }

  private async requestWrapUp(run: RunRecord): Promise<void> {
    if (!ACTIVE.has(run.state) || !run.child?.isActive) return;
    try {
      await run.child.steer(WRAP_UP_PROMPT);
    } catch {
      // The hard deadline remains the fallback if graceful steering races settlement.
    }
  }

  private armRecoveryTimeout(run: RunRecord): void {
    this.clearRecoveryTimeout(run);
    run.recoveryTimer = setTimeout(() => {
      void this.onRecoveryTimeout(run);
    }, RECOVERY_TIMEOUT_MS);
  }

  private clearRecoveryTimeout(run: RunRecord): void {
    if (run.recoveryTimer) clearTimeout(run.recoveryTimer);
    run.recoveryTimer = undefined;
  }

  private async onRecoveryTimeout(run: RunRecord): Promise<void> {
    if (run.recoveryState !== "running") return;
    if (run.child) {
      run.child.markTimeoutRequested();
      try {
        await run.child.abort();
      } catch {
        // best effort
      }
    }
    setTimeout(() => {
      if (run.recoveryState === "running") this.failRecovery(run, "recovery summary timeout");
    }, 1_000);
  }

  private async onExecutionTimeout(run: RunRecord): Promise<void> {
    if (!ACTIVE.has(run.state)) return;
    if (run.child) {
      run.child.markTimeoutRequested();
      try {
        await run.child.abort();
      } catch {
        // best effort
      }
    }
    // If settlement never arrives (or child never started), force timedout.
    setTimeout(() => {
      if (ACTIVE.has(run.state)) {
        run.state = "timedout";
        run.reason = "timeout-without-settlement";
        run.error = "execution timeout";
        run.partial = false;
        run.output = run.child?.latestAssistantText ?? run.output;
        this.emitChange();
      }
    }, run.child ? 1_000 : 0);
  }

  private enqueue(run: RunRecord, work: () => Promise<void>): Promise<void> {
    const next = run.queue.then(work, work);
    run.queue = next.catch(() => {});
    return next;
  }

  private emitChange(): void {
    try {
      this.onChange();
    } catch {
      // UI refresh must not break lifecycle
    }
  }

  /**
   * Capture the started child's pid + start identity and publish it. The
   * identity string format is part of the Pi Office contract: Office
   * re-observes the pid and compares the exact string, so a mismatch makes
   * the entry read as stale rather than live.
   */
  private async recordOpenRun(run: RunRecord): Promise<void> {
    const pid = run.child?.pid;
    if (pid === undefined) return;
    run.pid = pid;
    run.startedAt = this.now();
    try {
      run.startIdentity = (await this.processStartIdentity(pid)) ?? undefined;
    } catch {
      run.startIdentity = undefined;
    }
    this.syncOpenRuns();
  }

  /**
   * Rewrite the open-run registry from the live runs. Never throws: an
   * unwritable registry must not break a run, and the Office policy marker
   * remains the fail-closed defense in the other direction.
   */
  private syncOpenRuns(): void {
    if (!this.openRuns) return;
    const entries: LegacyOpenRun[] = [];
    for (const run of this.runs.values()) {
      if (run.pid === undefined || run.state === "stopped") continue;
      if (run.child === undefined || run.child.hasExited) continue;
      entries.push({
        id: run.id,
        pid: run.pid,
        // A pid without a usable identity is recorded honestly: Pi Office
        // then classifies it as stale (never as a verified live run).
        startIdentity: run.startIdentity ?? `unavailable:pid=${run.pid}`,
        profile: run.profile,
        startedAt: run.startedAt ?? this.now(),
      });
    }
    try {
      this.openRuns.write(entries);
    } catch {
      // best effort
    }
  }
}

export function profileGuidance(catalog: ProfileCatalog): string {
  return Object.values(catalog)
    .map((profile: Profile) => `${profile.name} (${profile.description})`)
    .join("; ");
}
