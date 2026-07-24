export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export type ExecFn = (
  command: string,
  args: string[],
  options?: { timeout?: number },
) => Promise<ExecResult>;

export interface HerdrEnv {
  enabled: boolean;
  workspaceId?: string;
  tabId?: string;
  paneId?: string;
  socketPath?: string;
}

export interface ViewerHandle {
  runId: string;
  agentId: string;
  paneId?: string;
}

export function detectHerdrEnv(env: NodeJS.ProcessEnv = process.env): HerdrEnv {
  const enabled = env.HERDR_ENV === "1"
    && Boolean(env.HERDR_SOCKET_PATH)
    && Boolean(env.HERDR_WORKSPACE_ID)
    && Boolean(env.HERDR_TAB_ID || env.HERDR_PANE_ID);
  return {
    enabled,
    ...(env.HERDR_WORKSPACE_ID ? { workspaceId: env.HERDR_WORKSPACE_ID } : {}),
    ...(env.HERDR_TAB_ID ? { tabId: env.HERDR_TAB_ID } : {}),
    ...(env.HERDR_PANE_ID ? { paneId: env.HERDR_PANE_ID } : {}),
    ...(env.HERDR_SOCKET_PATH ? { socketPath: env.HERDR_SOCKET_PATH } : {}),
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function pickString(record: Record<string, unknown> | undefined, keys: string[]): string | undefined {
  if (!record) return undefined;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

/** Parse `herdr agent start` CLI JSON (and loose fallbacks). Exported for tests. */
export function parseStartOutput(stdout: string, stderr = ""): { agentId: string; paneId?: string } | undefined {
  const text = `${stdout}\n${stderr}`.trim();
  if (!text) return undefined;

  const candidates = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  for (const line of candidates) {
    try {
      const json = JSON.parse(line) as Record<string, unknown>;
      const result = asRecord(json.result);
      const agent = asRecord(result?.agent) ?? asRecord(json.agent) ?? result ?? json;
      const agentId = pickString(agent, ["terminal_id", "terminalId", "agentId", "id", "name"]);
      // Never treat the CLI envelope id (cli:agent:start) as the agent target.
      if (agentId && agentId.startsWith("cli:")) continue;
      const paneId = pickString(agent, ["pane_id", "paneId", "pane"]);
      if (agentId) {
        return {
          agentId,
          ...(paneId ? { paneId } : {}),
        };
      }
    } catch {
      // try next line / fallback
    }
  }

  const terminalMatch = text.match(/terminal_id["\s:=]+([A-Za-z0-9._:-]+)/i);
  if (terminalMatch?.[1] && !terminalMatch[1].startsWith("cli:")) {
    const paneMatch = text.match(/pane_id["\s:=]+([A-Za-z0-9._:-]+)/i);
    return {
      agentId: terminalMatch[1],
      ...(paneMatch?.[1] ? { paneId: paneMatch[1] } : {}),
    };
  }
  return undefined;
}

export class HerdrViewerManager {
  private readonly exec: ExecFn;
  private readonly env: HerdrEnv;
  private readonly viewers = new Map<string, ViewerHandle>();

  constructor(exec: ExecFn, env: HerdrEnv = detectHerdrEnv()) {
    this.exec = exec;
    this.env = env;
  }

  get isAvailable(): boolean {
    return this.env.enabled;
  }

  getViewer(runId: string): ViewerHandle | undefined {
    return this.viewers.get(runId);
  }

  async openOrFocus(runId: string, transcriptPath: string, label: string): Promise<
    | { ok: true; mode: "herdr"; handle: ViewerHandle }
    | { ok: false; reason: string }
  > {
    if (!this.env.enabled) return { ok: false, reason: "herdr-unavailable" };

    const existing = this.viewers.get(runId);
    if (existing) {
      const focused = await this.focus(existing.agentId);
      if (focused) return { ok: true, mode: "herdr", handle: existing };
      this.viewers.delete(runId);
    }

    const args = [
      "agent", "start",
      label.slice(0, 48) || `subagent-${runId.slice(-8)}`,
      "--split", "right",
      "--focus",
    ];
    if (this.env.workspaceId) args.push("--workspace", this.env.workspaceId);
    if (this.env.tabId) args.push("--tab", this.env.tabId);
    args.push("--", "tail", "-n", "+1", "-F", transcriptPath);

    const result = await this.exec("herdr", args, { timeout: 8_000 });
    if (result.code !== 0) {
      return {
        ok: false,
        reason: result.stderr.trim() || result.stdout.trim() || `herdr exit ${result.code}`,
      };
    }
    const parsed = parseStartOutput(result.stdout, result.stderr);
    if (!parsed) {
      return { ok: false, reason: "herdr start returned no agent id" };
    }
    const handle: ViewerHandle = {
      runId,
      agentId: parsed.agentId,
      ...(parsed.paneId ? { paneId: parsed.paneId } : {}),
    };
    this.viewers.set(runId, handle);
    return { ok: true, mode: "herdr", handle };
  }

  async close(runId: string): Promise<void> {
    const handle = this.viewers.get(runId);
    if (!handle) return;
    this.viewers.delete(runId);
    await this.closeHandle(handle);
  }

  async closeAll(): Promise<void> {
    const handles = [...this.viewers.values()];
    this.viewers.clear();
    for (const handle of handles) {
      await this.closeHandle(handle);
    }
  }

  clear(runId: string): void {
    this.viewers.delete(runId);
  }

  private async focus(agentId: string): Promise<boolean> {
    const result = await this.exec("herdr", ["agent", "focus", agentId], { timeout: 3_000 });
    return result.code === 0;
  }

  private async closeHandle(handle: ViewerHandle): Promise<void> {
    const target = handle.paneId ?? handle.agentId;
    await this.exec("herdr", ["pane", "close", target], { timeout: 3_000 });
  }
}
