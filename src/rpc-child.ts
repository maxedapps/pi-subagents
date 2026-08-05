import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { accessSync, appendFileSync, constants, mkdirSync, writeFileSync } from "node:fs";
import { realpathSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { CHILD_ENV_MARKER } from "./profiles.ts";

const DIALOG_METHODS = new Set(["select", "confirm", "input", "editor"]);
const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;
const DEFAULT_STOP_GRACE_MS = 5_000;
export const MAX_TOOL_TEXT = 32_768;
export const MAX_TRANSCRIPT_LINES = 2_000;

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface ParentLaunchSnapshot {
  readonly model?: string;
  readonly thinking?: ThinkingLevel;
}

export interface RpcChildLaunchOptions {
  readonly executable?: string;
  readonly cwd: string;
  readonly systemPromptFile: string;
  readonly transcriptPath: string;
  readonly parent: ParentLaunchSnapshot;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly commandTimeoutMs?: number;
  readonly stopGraceMs?: number;
  readonly spawnImpl?: typeof spawn;
}

export type SettlementClassification =
  | { state: "idle"; reason: string; text: string; stopReason?: string | null }
  | { state: "failed"; reason: string; text: string; stopReason?: string | null }
  | { state: "timedout"; reason: string; text: string; stopReason?: string | null }
  | { state: "stopped"; reason: string; text: string; stopReason?: string | null }
  | { state: "blocked"; reason: string; text: string; stopReason?: string | null };

export interface SettlementEvent {
  readonly classification: SettlementClassification;
  readonly assistantText: string;
  readonly partial: boolean;
}

export interface RpcChildEvents {
  onSettlement?: (event: SettlementEvent) => void;
  onExit?: (code: number | null, signal: NodeJS.Signals | null) => void;
  onError?: (error: Error) => void;
  onTranscript?: (line: string) => void;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  command: string;
}

function resolveExecutable(name: string): string {
  if (name.includes("/") || name.includes("\\")) {
    accessSync(name, constants.X_OK);
    return realpathSync(name);
  }
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (!directory) continue;
    const candidate = join(directory, name);
    try {
      accessSync(candidate, constants.X_OK);
      return realpathSync(candidate);
    } catch {
      // keep searching
    }
  }
  throw new Error(`executable not found: ${name}`);
}

export function boundText(value: string | undefined | null, max = MAX_TOOL_TEXT): string {
  const text = String(value ?? "");
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n[truncated ${text.length - max} characters]`;
}

export function assistantTextFromMessage(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .filter((part): part is { type: string; text: string } =>
      Boolean(part)
      && typeof part === "object"
      && (part as { type?: unknown }).type === "text"
      && typeof (part as { text?: unknown }).text === "string")
    .map((part) => part.text)
    .join("")
    .trim();
}

export function classifyAssistant(
  message: unknown,
  context: { timeoutRequested?: boolean; stopRequested?: boolean } = {},
): SettlementClassification {
  if (!message || typeof message !== "object" || (message as { role?: unknown }).role !== "assistant") {
    return { state: "blocked", reason: "missing-final-assistant", text: "" };
  }
  const stopReason = (message as { stopReason?: unknown }).stopReason ?? null;
  const text = assistantTextFromMessage(message);
  const errorMessage = typeof (message as { errorMessage?: unknown }).errorMessage === "string"
    ? (message as { errorMessage: string }).errorMessage
    : null;
  const abortLike = stopReason === "aborted" || Boolean(errorMessage?.toLowerCase().includes("abort"));
  // Pi may surface an RPC abort as stopReason="error" with "Request was aborted".
  // Prefer the cause known by this runtime over that generic provider shape.
  if (abortLike && context.timeoutRequested) {
    return { state: "timedout", reason: "timeout-abort", text, stopReason: String(stopReason) };
  }
  if (abortLike && context.stopRequested) {
    return { state: "stopped", reason: "explicit-stop-abort", text, stopReason: String(stopReason) };
  }
  if (stopReason === "error" || errorMessage) {
    return { state: "failed", reason: errorMessage || "assistant-error", text, stopReason: String(stopReason) };
  }
  if (stopReason === "aborted") {
    return { state: "blocked", reason: "spontaneous-abort", text, stopReason: "aborted" };
  }
  if (stopReason === "length") return { state: "blocked", reason: "length", text, stopReason: "length" };
  if (stopReason === "toolUse") return { state: "blocked", reason: "terminal-tool-use", text, stopReason: "toolUse" };
  if (stopReason === "stop") {
    if (!text) return { state: "blocked", reason: "missing-text", text, stopReason: "stop" };
    return { state: "idle", reason: "stop", text, stopReason: "stop" };
  }
  if (stopReason == null) return { state: "blocked", reason: "unknown-stop-reason", text, stopReason: null };
  return { state: "blocked", reason: `unknown-stop-reason:${String(stopReason)}`, text, stopReason: String(stopReason) };
}

export function buildChildArgv(options: {
  systemPromptFile: string;
  parent: ParentLaunchSnapshot;
}): string[] {
  const argv = [
    "--mode", "rpc",
    "--no-session",
    "--no-context-files",
    "--system-prompt", options.systemPromptFile,
  ];
  if (options.parent.model) argv.push("--model", options.parent.model);
  if (options.parent.thinking) argv.push("--thinking", options.parent.thinking);
  return argv;
}

function attachJsonlReader(
  stream: NodeJS.ReadableStream,
  onLine: (line: string) => void,
  onError?: (error: Error) => void,
): void {
  const decoder = new StringDecoder("utf8");
  let buffer = "";
  const feed = (chunk: string | Buffer) => {
    buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);
    while (true) {
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex === -1) break;
      let line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line.length) onLine(line);
    }
  };
  stream.on("data", feed);
  stream.on("end", () => {
    buffer += decoder.end();
    if (buffer.length) {
      const line = buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer;
      if (line.length) onLine(line);
    }
  });
  stream.on("error", (error) => onError?.(error instanceof Error ? error : new Error(String(error))));
}

function summarizeToolArgs(args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const record = args as Record<string, unknown>;
  for (const key of ["path", "file", "command", "pattern", "query", "url", "name"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return boundText(value.trim(), 120);
  }
  return "";
}

export class RpcChild {
  transcriptPath = "";
  cwd = "";
  private commandTimeoutMs = DEFAULT_COMMAND_TIMEOUT_MS;
  private stopGraceMs = DEFAULT_STOP_GRACE_MS;
  private readonly events: RpcChildEvents;
  private process: ChildProcessWithoutNullStreams | null = null;
  private pending = new Map<string, PendingRequest>();
  private requestId = 0;
  private stderr = "";
  private exitError: Error | null = null;
  private stopped = false;
  private timeoutRequested = false;
  private stopRequested = false;
  private lastAssistant: unknown = null;
  private streamingAssistant = "";
  private assistantText = "";
  private partialAssistant = false;
  private transcriptLines: string[] = [];
  private activeGeneration = false;
  private settledWaiters: Array<(event: SettlementEvent) => void> = [];
  private exitPromise: Promise<{ code: number | null; signal: NodeJS.Signals | null }> | null = null;

  constructor(events: RpcChildEvents = {}) {
    this.events = events;
  }

  static async start(options: RpcChildLaunchOptions, events: RpcChildEvents = {}): Promise<RpcChild> {
    const child = new RpcChild(events);
    await child.launch(options);
    return child;
  }

  get pid(): number | undefined {
    return this.process?.pid;
  }

  get latestAssistantText(): string {
    return this.assistantText || this.streamingAssistant;
  }

  get isPartialAssistant(): boolean {
    return this.partialAssistant && !this.assistantText;
  }

  get isActive(): boolean {
    return this.activeGeneration;
  }

  get hasExited(): boolean {
    return this.process === null || this.process.exitCode !== null || this.process.signalCode !== null;
  }

  async launch(options: RpcChildLaunchOptions): Promise<void> {
    if (this.process) throw new Error("RPC child already started");
    const executable = resolveExecutable(options.executable ?? process.env.PI_SUBAGENTS_PI_PATH ?? "pi");
    const argv = buildChildArgv({
      systemPromptFile: options.systemPromptFile,
      parent: options.parent,
    });
    mkdirSync(dirname(options.transcriptPath), { recursive: true });
    writeFileSync(options.transcriptPath, "", { mode: 0o600 });
    this.transcriptPath = options.transcriptPath;
    this.cwd = options.cwd;
    this.commandTimeoutMs = options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    this.stopGraceMs = options.stopGraceMs ?? DEFAULT_STOP_GRACE_MS;

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...options.env,
      [CHILD_ENV_MARKER]: "1",
    };
    const spawnImpl = options.spawnImpl ?? spawn;
    const childProcess = spawnImpl(executable, argv, {
      cwd: options.cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: false,
    }) as ChildProcessWithoutNullStreams;
    this.process = childProcess;
    this.appendTranscript(`started profile process pid=${childProcess.pid ?? "unknown"} cwd=${options.cwd}`);

    childProcess.stderr.setEncoding("utf8");
    childProcess.stderr.on("data", (chunk: string) => {
      this.stderr = boundText(this.stderr + chunk, 16_384);
    });

    this.exitPromise = new Promise((resolve) => {
      childProcess.once("exit", (code, signal) => {
        this.rejectPending(this.exitError ?? new Error(`child exited code=${code} signal=${signal}`));
        if (this.activeGeneration) {
          const classification = this.stopRequested
            ? classifyAssistant(this.lastAssistant, { stopRequested: true, timeoutRequested: this.timeoutRequested })
            : this.timeoutRequested
              ? classifyAssistant(this.lastAssistant, { timeoutRequested: true })
              : { state: "blocked" as const, reason: "premature-exit", text: assistantTextFromMessage(this.lastAssistant) || this.streamingAssistant };
          this.finishSettlement(classification);
        }
        this.appendTranscript(`process exited code=${code ?? "null"} signal=${signal ?? "null"}`);
        this.events.onExit?.(code, signal);
        resolve({ code, signal });
      });
    });

    childProcess.once("error", (error) => {
      const wrapped = new Error(`child process error: ${error.message}`);
      this.exitError = wrapped;
      this.events.onError?.(wrapped);
      this.rejectPending(wrapped);
    });

    attachJsonlReader(childProcess.stdout, (line) => this.handleLine(line), (error) => {
      this.events.onError?.(error);
    });

    await new Promise((resolve) => setTimeout(resolve, 25));
    if (childProcess.exitCode !== null) {
      throw this.exitError ?? new Error(`child exited during start (code=${childProcess.exitCode}). stderr=${this.stderr}`);
    }
  }

  async prompt(message: string): Promise<void> {
    this.beginGeneration();
    await this.send({ type: "prompt", message });
  }

  async steer(message: string): Promise<void> {
    if (!this.activeGeneration) throw new Error("steer requires an active generation");
    this.appendTranscript(`steer: ${boundText(message, 200)}`);
    await this.send({ type: "steer", message });
  }

  async followUp(message: string): Promise<void> {
    if (!this.activeGeneration) throw new Error("follow_up requires an active generation");
    this.appendTranscript(`follow-up: ${boundText(message, 200)}`);
    await this.send({ type: "follow_up", message });
  }

  async abort(): Promise<void> {
    try {
      await this.send({ type: "abort" });
    } catch {
      // best effort
    }
  }

  markTimeoutRequested(): void {
    this.timeoutRequested = true;
  }

  markStopRequested(): void {
    this.stopRequested = true;
  }

  waitForSettlement(timeoutMs?: number): Promise<SettlementEvent> {
    return new Promise((resolve, reject) => {
      const timer = timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
          this.settledWaiters = this.settledWaiters.filter((waiter) => waiter !== onSettle);
          reject(new Error("wait timed out before settlement"));
        }, Math.max(1, timeoutMs));
      const onSettle = (event: SettlementEvent) => {
        if (timer) clearTimeout(timer);
        resolve(event);
      };
      this.settledWaiters.push(onSettle);
    });
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.stopRequested = true;
    const child = this.process;
    if (!child) return;
    try {
      if (this.activeGeneration) await this.abort();
    } catch {
      // ignore
    }
    try {
      child.stdin.end();
    } catch {
      // ignore
    }
    const exited = await Promise.race([
      this.exitPromise ?? Promise.resolve({ code: 0, signal: null }),
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), this.stopGraceMs)),
    ]);
    if (exited === "timeout" && child.exitCode === null && child.signalCode === null) {
      try {
        child.kill("SIGTERM");
      } catch {
        // ignore
      }
      await Promise.race([
        this.exitPromise ?? Promise.resolve({ code: 0, signal: null }),
        new Promise((resolve) => setTimeout(resolve, this.stopGraceMs)),
      ]);
      if (child.exitCode === null && child.signalCode === null) {
        try {
          child.kill("SIGKILL");
        } catch {
          // ignore
        }
      }
    }
    this.rejectPending(new Error("child stopped"));
    this.process = null;
  }

  getBoundedAssistantText(): string {
    return boundText(this.latestAssistantText);
  }

  private beginGeneration(): void {
    this.activeGeneration = true;
    this.timeoutRequested = false;
    this.stopRequested = false;
    this.lastAssistant = null;
    this.streamingAssistant = "";
    this.assistantText = "";
    this.partialAssistant = true;
    this.appendTranscript("--- generation start ---");
  }

  private finishSettlement(classification: SettlementClassification): void {
    if (!this.activeGeneration) return;
    this.activeGeneration = false;
    this.assistantText = classification.text || this.streamingAssistant;
    this.partialAssistant = false;
    this.appendTranscript(`settled state=${classification.state} reason=${classification.reason}`);
    if (this.assistantText) this.appendTranscript(`assistant: ${boundText(this.assistantText, 4_000)}`);
    const event: SettlementEvent = {
      classification,
      assistantText: this.assistantText,
      partial: false,
    };
    const waiters = this.settledWaiters;
    this.settledWaiters = [];
    for (const waiter of waiters) waiter(event);
    this.events.onSettlement?.(event);
  }

  private appendTranscript(line: string): void {
    const stamped = `[${new Date().toISOString()}] ${line}`;
    this.transcriptLines.push(stamped);
    if (this.transcriptLines.length > MAX_TRANSCRIPT_LINES) {
      this.transcriptLines = this.transcriptLines.slice(-MAX_TRANSCRIPT_LINES);
    }
    if (this.transcriptPath) {
      try {
        appendFileSync(this.transcriptPath, `${stamped}\n`, { mode: 0o600 });
      } catch {
        // keep in-memory only
      }
    }
    this.events.onTranscript?.(stamped);
  }

  private handleLine(line: string): void {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line) as Record<string, unknown>;
    } catch {
      this.appendTranscript(`malformed stdout ignored (${boundText(line, 120)})`);
      return;
    }

    if (message.type === "response" && typeof message.id === "string") {
      const pending = this.pending.get(message.id);
      if (pending) {
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.success) pending.resolve(message);
        else pending.reject(new Error(String(message.error ?? `RPC ${pending.command} failed`)));
      }
      return;
    }

    if (message.type === "extension_ui_request") {
      const method = String(message.method ?? "");
      if (DIALOG_METHODS.has(method) && typeof message.id === "string") {
        this.writeRaw({ type: "extension_ui_response", id: message.id, cancelled: true });
        this.appendTranscript(`cancelled extension dialog ${method}`);
      }
      return;
    }

    if (message.type === "message_update") {
      const assistantMessageEvent = message.assistantMessageEvent as { type?: string; delta?: string } | undefined;
      if (assistantMessageEvent?.type === "text_delta" && typeof assistantMessageEvent.delta === "string") {
        this.streamingAssistant += assistantMessageEvent.delta;
        this.partialAssistant = true;
      }
      return;
    }

    if (message.type === "message_end" && message.message && typeof message.message === "object") {
      const role = (message.message as { role?: unknown }).role;
      if (role === "assistant") {
        this.lastAssistant = message.message;
        this.assistantText = assistantTextFromMessage(message.message);
        this.partialAssistant = false;
      }
      return;
    }

    if (message.type === "tool_execution_start") {
      const toolName = String(message.toolName ?? "tool");
      const args = summarizeToolArgs(message.args);
      this.appendTranscript(args ? `tool start ${toolName}: ${args}` : `tool start ${toolName}`);
      return;
    }

    if (message.type === "tool_execution_end") {
      const toolName = String(message.toolName ?? "tool");
      const isError = message.isError === true;
      this.appendTranscript(isError ? `tool error ${toolName}` : `tool end ${toolName}`);
      return;
    }

    if (message.type === "agent_start") {
      this.appendTranscript("agent start");
      return;
    }

    if (message.type === "agent_end") {
      this.appendTranscript("agent end");
      return;
    }

    if (message.type === "agent_settled") {
      if (!this.activeGeneration) return;
      this.finishSettlement(classifyAssistant(this.lastAssistant, {
        timeoutRequested: this.timeoutRequested,
        stopRequested: this.stopRequested,
      }));
    }
  }

  private writeRaw(value: unknown): void {
    const child = this.process;
    if (!child?.stdin?.writable) return;
    try {
      child.stdin.write(`${JSON.stringify(value)}\n`);
    } catch {
      // ignore
    }
  }

  private async send(command: Record<string, unknown>): Promise<unknown> {
    const child = this.process;
    if (!child?.stdin?.writable) throw new Error("RPC child stdin is not writable");
    if (this.exitError) throw this.exitError;
    const id = `req_${++this.requestId}`;
    const payload = { ...command, id };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timeout waiting for response to ${String(command.type)}. stderr=${this.stderr}`));
      }, this.commandTimeoutMs);
      this.pending.set(id, {
        resolve,
        reject,
        timer,
        command: String(command.type ?? "unknown"),
      });
      try {
        child.stdin.write(`${JSON.stringify(payload)}\n`);
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

/** Test helper: project a raw RPC event line into human transcript text. */
export function projectEventLine(line: string): string | undefined {
  let message: Record<string, unknown>;
  try {
    message = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  if (message.type === "tool_execution_start") {
    const toolName = String(message.toolName ?? "tool");
    const args = summarizeToolArgs(message.args);
    return args ? `tool start ${toolName}: ${args}` : `tool start ${toolName}`;
  }
  if (message.type === "tool_execution_end") {
    const toolName = String(message.toolName ?? "tool");
    return message.isError === true ? `tool error ${toolName}` : `tool end ${toolName}`;
  }
  if (message.type === "agent_start") return "agent start";
  if (message.type === "agent_end") return "agent end";
  if (message.type === "agent_settled") return "agent settled";
  return undefined;
}
