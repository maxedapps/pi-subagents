/**
 * Pi Office coexistence -- the LEGACY side of the `pi-office-legacy-compat`
 * protocol v1.
 *
 * Pi Office is a separate product with its own durable runtime. While an
 * Office holds a repository, agents are launched, resumed and controlled ONLY
 * through its `office_agent_*` tools -- there is no fallback, and this legacy
 * extension must therefore fail closed.
 *
 * This package has NO dependency on Pi Office: every protocol constant, path
 * rule and validator below is duplicated BY VALUE from the Office-side
 * definition (`src/shared/legacy-compat-protocol.ts` in the pi-office repo).
 * Nothing here imports Office code, and Office never imports this package.
 *
 * Three mechanisms, all implemented here:
 *
 *   1. **Bus handshake** over the shared `pi.events` bus for the case where
 *      both extensions are loaded in the same visible Pi process:
 *      probe -> info reply -> suppress -> release. The probe listener is
 *      installed at extension-factory time and replies SYNCHRONOUSLY during
 *      dispatch, because Office waits exactly one macrotask before deciding
 *      that no compatible companion is present.
 *   2. **Persistent active-policy marker** written by Pi Office and checked
 *      fail-closed before EVERY `subagent_*` execution. This catches stale
 *      calls, Offices held by other Pi processes, and missed bus events. ANY
 *      existing marker -- regardless of its `state`, including "failed" and
 *      "retained" -- is an active policy window: a failed or retained Office
 *      may still own unknown resources. The marker is removed only by Pi
 *      Office when it releases the window; this package never deletes it.
 *   3. **Open-run registry** files written by this package on every run
 *      start/stop and removed at shutdown, so Office can see (and refuse to
 *      activate over) live legacy runs started by other processes.
 *
 * Plus defense in depth: when `PI_OFFICE_RUN_ID` / `PI_OFFICE_BOOTSTRAP` is
 * present the process is an Office-managed child, and this extension disables
 * itself entirely (Office also launches children with `--no-extensions`).
 *
 * Dependency rule: `node:*` builtins only, so this module stays a
 * self-contained copy of the contract.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { createRequire } from "node:module";

// ---------------------------------------------------------------------------
// Protocol constants (duplicated by value -- keep in sync with Pi Office v1)
// ---------------------------------------------------------------------------

export const LEGACY_COMPAT_PROTOCOL_NAME = "pi-office-legacy-compat";
export const LEGACY_COMPAT_PROTOCOL_VERSION = 1;

/** Office -> legacy: `{ protocolVersion, replyEvent }`. */
export const COMPAT_PROBE_EVENT = "pi-office:compat:probe";
/** Office -> legacy: `{ officeId, policyPath }`. */
export const COMPAT_SUPPRESS_EVENT = "pi-office:compat:suppress";
/** Office -> legacy: `{ officeId }`. */
export const COMPAT_RELEASE_EVENT = "pi-office:compat:release";
/** Legacy -> Office reply to suppress: `{ previousToolsHash }`. */
export const COMPAT_SUPPRESSED_REPLY_EVENT = "pi-subagents:compat:suppressed";
/** Legacy -> Office reply to release: `{ officeId }`. */
export const COMPAT_RELEASED_REPLY_EVENT = "pi-subagents:compat:released";

/** Env vars that mark this process as an Office-managed child. */
export const OFFICE_CHILD_ENV_VARS = ["PI_OFFICE_RUN_ID", "PI_OFFICE_BOOTSTRAP"] as const;

/** Routing hint for the Office home; authority always rests on the files there. */
export const PI_OFFICE_HOME_ENV = "PI_OFFICE_HOME";
/** Pi's own agent-dir override, honored so both sides resolve the same home. */
export const PI_AGENT_DIR_ENV = "PI_AGENT_DIR";

/** Marker `state` values; `released` is represented by deleting the file. */
export const POLICY_MARKER_STATES = [
  "reserved",
  "active",
  "paused",
  "recovering",
  "failed",
  "retained",
] as const;
export type PolicyMarkerState = (typeof POLICY_MARKER_STATES)[number];

/** Hex chars of sha256(canonical repo path) used as the marker file name. */
export const REPO_KEY_HEX_LENGTH = 16;

const FALLBACK_PACKAGE_VERSION = "0.2.0";

/**
 * This package's own version, reported in the probe reply so Office can apply
 * its minimum-companion-version gate. Read from the installed package.json
 * (always present in the published tarball) with a constant fallback.
 */
export const PACKAGE_VERSION: string = readPackageVersion();

function readPackageVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    const pkg = require("../package.json") as { version?: unknown };
    return typeof pkg.version === "string" && pkg.version !== "" ? pkg.version : FALLBACK_PACKAGE_VERSION;
  } catch {
    return FALLBACK_PACKAGE_VERSION;
  }
}

export interface CompatProbeReply {
  protocolVersion: number;
  packageVersion: string;
  openRunCount: number;
  parentSessionId: string;
}

export interface ActivePolicyMarker {
  schemaVersion: 1;
  protocolVersion: 1;
  officeId: string;
  repoPath: string;
  supervisorSessionId: string;
  runtimePid: number;
  runtimeStartIdentity: string;
  socketPath: string;
  reservedAt: number;
  state: PolicyMarkerState;
}

export interface LegacyOpenRun {
  id: string;
  pid: number;
  startIdentity: string;
  profile: string;
  startedAt: number;
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

function expandTilde(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith(`~${sep}`) || path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

/**
 * Resolve the Pi Office home. Precedence mirrors both sides exactly:
 * `PI_OFFICE_HOME`, else Pi's agent dir (`PI_AGENT_DIR`, else `~/.pi/agent`).
 */
export function resolveOfficeHome(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[PI_OFFICE_HOME_ENV];
  if (override !== undefined && override.trim() !== "") return resolve(expandTilde(override.trim()));
  const agentDir = env[PI_AGENT_DIR_ENV];
  if (agentDir !== undefined && agentDir.trim() !== "") return resolve(expandTilde(agentDir.trim()));
  return join(homedir(), ".pi", "agent");
}

/** `<home>/office-runs/active-policy` -- one marker file per held repository. */
export function activePolicyDir(home: string): string {
  return join(home, "office-runs", "active-policy");
}

/** sha256 of the CANONICAL absolute repo path, truncated to the key length. */
export function computeRepoKey(canonicalRepoPath: string): string {
  return createHash("sha256").update(canonicalRepoPath, "utf8").digest("hex").slice(0, REPO_KEY_HEX_LENGTH);
}

/** `<home>/office-runs/active-policy/<repoKey>.json` */
export function activePolicyMarkerPath(home: string, repoKey: string): string {
  return join(activePolicyDir(home), `${repoKey}.json`);
}

/** `<home>/subagents/open-runs` -- this package's open-run registry files. */
export function legacyOpenRunsDir(home: string): string {
  return join(home, "subagents", "open-runs");
}

/** Registry file name is derived from the parent session id (sanitized). */
export function openRunRegistryPath(home: string, parentSessionId: string): string {
  const safe = parentSessionId.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120) || "unknown-session";
  return join(legacyOpenRunsDir(home), `${safe}.json`);
}

/** Canonical form of a path; falls back to a plain resolve when it is absent. */
export function canonicalizePath(path: string): string {
  const absolute = resolve(path);
  try {
    return realpathSync.native(absolute);
  } catch {
    return absolute;
  }
}

/** True when the two canonical paths are equal or one contains the other. */
export function pathsRelated(left: string, right: string): boolean {
  if (left === right) return true;
  return left.startsWith(right.endsWith(sep) ? right : right + sep)
    || right.startsWith(left.endsWith(sep) ? left : left + sep);
}

// ---------------------------------------------------------------------------
// Process start identity (duplicated by value: the STRING FORMAT is part of
// the contract -- Pi Office compares these strings against its own probe)
// ---------------------------------------------------------------------------

const PS_TIMEOUT_MS = 5_000;

function execPs(args: readonly string[]): Promise<{ stdout: string; exitCode: number }> {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile("ps", [...args], { timeout: PS_TIMEOUT_MS, killSignal: "SIGKILL", encoding: "utf8" }, (error, stdout) => {
      if (error === null) {
        resolvePromise({ stdout, exitCode: 0 });
        return;
      }
      const exitCode = typeof error.code === "number" ? error.code : null;
      if (exitCode !== null) {
        resolvePromise({ stdout: stdout ?? "", exitCode });
        return;
      }
      rejectPromise(error instanceof Error ? error : new Error(String(error)));
    });
  });
}

/** Parse field 22 (`starttime`) of /proc/<pid>/stat, counting from the last ')'. */
export function parseProcPidStatStarttime(statContent: string): string {
  const closeParen = statContent.lastIndexOf(")");
  if (closeParen === -1) throw new Error("malformed /proc/<pid>/stat: missing ')' after comm");
  const rest = statContent.slice(closeParen + 1).trim();
  const fields = rest === "" ? [] : rest.split(/\s+/);
  const starttime = fields[19];
  if (starttime === undefined || !/^\d+$/.test(starttime)) {
    throw new Error("malformed /proc/<pid>/stat: starttime (field 22) not found or not numeric");
  }
  return starttime;
}

/** Parse `btime` (seconds since epoch) from /proc/stat. */
export function parseProcStatBtime(procStatContent: string): string {
  const match = /^btime[ \t]+(\d+)[ \t]*$/m.exec(procStatContent);
  if (match === null || match[1] === undefined) throw new Error("malformed /proc/stat: no btime line");
  return match[1];
}

/**
 * Start identity of a live process, or null when no such process exists.
 * Unsupported platforms return null (this package still runs there; Pi Office
 * itself is POSIX-only, so no identity can ever match anyway).
 */
export async function getProcessStartIdentity(
  pid: number,
  platform: NodeJS.Platform = process.platform,
): Promise<string | null> {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (platform === "linux") {
    let statContent: string;
    try {
      statContent = await readFile(`/proc/${pid}/stat`, "utf8");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ESRCH") return null;
      throw error;
    }
    const starttime = parseProcPidStatStarttime(statContent);
    const btime = parseProcStatBtime(await readFile("/proc/stat", "utf8"));
    return `linux:pid=${pid}:btime=${btime}:starttime=${starttime}`;
  }
  if (platform === "darwin") {
    // lstart ONLY: the identity must contain nothing that can change during a
    // process's life. Pi Office's supporting runtime is spawned detached and
    // is reparented to init when the visible Pi exits, so a `ppid` component
    // would break every cross-check after a supervisor restart. Duplicated by
    // value from Pi Office's src/shared/process-identity.ts -- keep in sync.
    const lstartResult = await execPs(["-p", String(pid), "-o", "lstart="]);
    const lstart = lstartResult.stdout.trim();
    if (lstartResult.exitCode !== 0 || lstart === "") return null;
    return `darwin:pid=${pid}:lstart=${lstart}`;
  }
  return null;
}

/** Only an exact match of two non-empty strings counts; everything else fails closed. */
export function identitiesMatch(recorded: string | null | undefined, observed: string | null | undefined): boolean {
  return typeof recorded === "string" && recorded !== "" && recorded === observed;
}

// ---------------------------------------------------------------------------
// Marker validation (hand-rolled: this module stays dependency-free)
// ---------------------------------------------------------------------------

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value !== "";
}

function positiveInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

export function parseActivePolicyMarker(value: unknown): ParseResult<ActivePolicyMarker> {
  if (!isRecord(value)) return { ok: false, error: "policy marker must be an object" };
  if (value.schemaVersion !== 1) return { ok: false, error: "policy marker schemaVersion must be 1" };
  if (value.protocolVersion !== 1) return { ok: false, error: "policy marker protocolVersion must be 1" };
  if (!nonEmptyString(value.officeId)) return { ok: false, error: "policy marker officeId must be a non-empty string" };
  if (!nonEmptyString(value.repoPath)) return { ok: false, error: "policy marker repoPath must be a non-empty string" };
  if (!nonEmptyString(value.supervisorSessionId)) {
    return { ok: false, error: "policy marker supervisorSessionId must be a non-empty string" };
  }
  if (!positiveInt(value.runtimePid)) return { ok: false, error: "policy marker runtimePid must be a positive integer" };
  if (!nonEmptyString(value.runtimeStartIdentity)) {
    return { ok: false, error: "policy marker runtimeStartIdentity must be a non-empty string" };
  }
  if (!nonEmptyString(value.socketPath)) return { ok: false, error: "policy marker socketPath must be a non-empty string" };
  if (typeof value.reservedAt !== "number" || !Number.isFinite(value.reservedAt) || value.reservedAt < 0) {
    return { ok: false, error: "policy marker reservedAt must be a non-negative number" };
  }
  if (typeof value.state !== "string" || !(POLICY_MARKER_STATES as readonly string[]).includes(value.state)) {
    return { ok: false, error: `policy marker state must be one of: ${POLICY_MARKER_STATES.join(", ")}` };
  }
  return {
    ok: true,
    value: {
      schemaVersion: 1,
      protocolVersion: 1,
      officeId: value.officeId,
      repoPath: value.repoPath,
      supervisorSessionId: value.supervisorSessionId,
      runtimePid: value.runtimePid,
      runtimeStartIdentity: value.runtimeStartIdentity,
      socketPath: value.socketPath,
      reservedAt: value.reservedAt,
      state: value.state as PolicyMarkerState,
    },
  };
}

// ---------------------------------------------------------------------------
// Fail-closed window check
// ---------------------------------------------------------------------------

export type OfficeWindowCode =
  | "office-active"
  | "office-stale-marker"
  | "office-marker-unreadable"
  | "office-suppressed";

/** Refusal raised before any launch/control work happens. */
export class OfficeWindowError extends Error {
  readonly code: OfficeWindowCode;
  readonly markerPath: string | undefined;
  readonly officeId: string | undefined;

  constructor(code: OfficeWindowCode, message: string, details: { markerPath?: string; officeId?: string } = {}) {
    super(message);
    this.name = "OfficeWindowError";
    this.code = code;
    this.markerPath = details.markerPath;
    this.officeId = details.officeId;
  }
}

const INTERNAL_ONLY_NOTE =
  "While a Pi Office holds this repository, agents are launched, resumed and controlled ONLY through its "
  + "office_agent_* tools -- there is no fallback. Report the blocker and stop; do not route around the Office.";

const RECONCILE_NOTE =
  "Run office_reconcile in the Office (or remove the marker only after verifying no Office resources remain).";

function readMarkerFile(path: string): ActivePolicyMarker {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") throw new MarkerGoneError();
    throw new OfficeWindowError(
      "office-marker-unreadable",
      `refusing to run: the Pi Office policy marker ${path} could not be read `
        + `(${error instanceof Error ? error.message : String(error)}); failing closed. ${RECONCILE_NOTE}`,
      { markerPath: path },
    );
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch (error) {
    throw new OfficeWindowError(
      "office-marker-unreadable",
      `refusing to run: the Pi Office policy marker ${path} is not valid JSON `
        + `(${error instanceof Error ? error.message : String(error)}); failing closed. ${RECONCILE_NOTE}`,
      { markerPath: path },
    );
  }
  const parsed = parseActivePolicyMarker(decoded);
  if (!parsed.ok) {
    throw new OfficeWindowError(
      "office-marker-unreadable",
      `refusing to run: the Pi Office policy marker ${path} is invalid (${parsed.error}); failing closed. `
        + RECONCILE_NOTE,
      { markerPath: path },
    );
  }
  return parsed.value;
}

/** Internal signal: a marker file vanished between listing and reading. */
class MarkerGoneError extends Error {}

export interface AssertNoActiveOfficeWindowOptions {
  /** Pi Office home to inspect. */
  home: string;
  /** Candidate paths (launch cwd, process cwd, marker paths announced by Office). */
  paths: readonly string[];
  /** Marker files to check regardless of path relatedness (from the suppress event). */
  markerPaths?: readonly string[];
  /** Tool being executed, used in the refusal message. */
  toolName?: string;
  platform?: NodeJS.Platform;
}

/**
 * Refuse when any Pi Office policy window covers one of the candidate paths.
 *
 * Fail-closed rules (the contract, not heuristics):
 *  - ANY existing marker whose repository relates to a candidate path blocks,
 *    whatever its `state` (a "failed"/"retained" Office still holds the window).
 *  - A marker whose runtime pid is alive AND identity-matching -> "Office active".
 *  - A marker whose runtime is dead or identity-mismatched -> "stale marker",
 *    still refused, with reconcile guidance. This package never deletes it.
 *  - An unreadable or invalid marker, or an unreadable marker directory, is
 *    refused too: unknown Office state is never treated as "no Office".
 */
export async function assertNoActiveOfficeWindow(options: AssertNoActiveOfficeWindowOptions): Promise<void> {
  const candidates = [...new Set(options.paths.filter((path) => typeof path === "string" && path !== ""))]
    .map(canonicalizePath);
  const dir = activePolicyDir(options.home);

  const files: string[] = [];
  for (const explicit of options.markerPaths ?? []) {
    if (typeof explicit === "string" && explicit !== "") files.push(explicit);
  }
  try {
    for (const entry of readdirSync(dir).sort()) {
      if (entry.endsWith(".json")) files.push(join(dir, entry));
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTDIR") {
      throw new OfficeWindowError(
        "office-marker-unreadable",
        `refusing to run: the Pi Office policy marker directory ${dir} could not be listed `
          + `(${error instanceof Error ? error.message : String(error)}); failing closed. ${RECONCILE_NOTE}`,
      );
    }
  }

  for (const path of [...new Set(files)]) {
    let marker: ActivePolicyMarker;
    try {
      marker = readMarkerFile(path);
    } catch (error) {
      if (error instanceof MarkerGoneError) continue;
      throw error;
    }
    const repoPath = canonicalizePath(marker.repoPath);
    const related = candidates.some((candidate) => pathsRelated(candidate, repoPath));
    if (!related) continue;

    const observed = await getProcessStartIdentity(marker.runtimePid, options.platform ?? process.platform);
    const what = options.toolName === undefined ? "run" : `run ${options.toolName}`;
    if (identitiesMatch(marker.runtimeStartIdentity, observed)) {
      throw new OfficeWindowError(
        "office-active",
        `refusing to ${what}: Pi Office ${marker.officeId} is active for ${marker.repoPath} `
          + `(policy window state ${marker.state}, runtime pid ${marker.runtimePid}). ${INTERNAL_ONLY_NOTE}`,
        { markerPath: path, officeId: marker.officeId },
      );
    }
    throw new OfficeWindowError(
      "office-stale-marker",
      `refusing to ${what}: a stale Pi Office policy marker ${path} holds ${marker.repoPath} `
        + `(office ${marker.officeId}, window state ${marker.state}, recorded runtime pid ${marker.runtimePid} `
        + `is dead or identity-mismatched); failing closed. ${RECONCILE_NOTE} ${INTERNAL_ONLY_NOTE}`,
      { markerPath: path, officeId: marker.officeId },
    );
  }
}

// ---------------------------------------------------------------------------
// Open-run registry
// ---------------------------------------------------------------------------

export interface OpenRunRegistryWriter {
  /** Replace the recorded open runs; an empty list removes the file. */
  write(runs: readonly LegacyOpenRun[]): void;
  /** Remove the registry file (shutdown). */
  clear(): void;
  readonly path: string;
}

/**
 * `<home>/subagents/open-runs/<parentSessionId>.json` (0600 in a 0700 dir).
 * Pi Office scans these at activation and blocks while any recorded run is
 * live and identity-matching; dead entries are reported as stale, never
 * deleted by Office.
 */
export class OpenRunRegistry implements OpenRunRegistryWriter {
  readonly path: string;
  private readonly dir: string;

  constructor(home: string, parentSessionId: string) {
    this.dir = legacyOpenRunsDir(home);
    this.path = openRunRegistryPath(home, parentSessionId);
  }

  write(runs: readonly LegacyOpenRun[]): void {
    if (runs.length === 0) {
      this.clear();
      return;
    }
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const body = { schemaVersion: 1, runs: [...runs] };
    writeFileSync(this.path, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
  }

  clear(): void {
    rmSync(this.path, { force: true });
  }
}

// ---------------------------------------------------------------------------
// Handshake controller
// ---------------------------------------------------------------------------

/** The `ExtensionAPI` surface this controller needs. */
export interface OfficeCompatHost {
  events: {
    emit(channel: string, data: unknown): void;
    on(channel: string, handler: (data: unknown) => void): () => void;
  };
  getActiveTools(): string[];
  setActiveTools(toolNames: string[]): void;
}

export interface OfficeCompatOptions {
  host: OfficeCompatHost;
  /** This extension's own tool names (removed from the active set on suppress). */
  toolNames: readonly string[];
  /** Open runs this session currently owns (reported in the probe reply). */
  getOpenRunCount?: () => number;
  /** Parent session id (reported in the probe reply). */
  getParentSessionId?: () => string;
  home?: string;
  env?: NodeJS.ProcessEnv;
  packageVersion?: string;
  log?: (line: string) => void;
}

/** Guard used by every `subagent_*` tool before it does any work. */
export interface OfficeToolGuard {
  assertAllowed(toolName: string, paths: readonly string[]): Promise<void>;
}

/** True when this process is an Office-managed child (defense in depth). */
export function officeChildEnvActive(env: NodeJS.ProcessEnv = process.env): boolean {
  return OFFICE_CHILD_ENV_VARS.some((name) => {
    const value = env[name];
    return value !== undefined && value !== "";
  });
}

/**
 * Standalone guard for callers that do not own a handshake controller. It
 * performs the cross-process marker check only -- which is the authority
 * anyway -- so forgetting to wire the controller can never make a
 * `subagent_*` tool weaker than fail-closed.
 */
export function createMarkerOnlyGuard(env: NodeJS.ProcessEnv = process.env): OfficeToolGuard {
  return {
    async assertAllowed(toolName: string, paths: readonly string[]): Promise<void> {
      await assertNoActiveOfficeWindow({ home: resolveOfficeHome(env), paths, toolName });
    },
  };
}

/**
 * Owns the legacy side of the handshake for one extension instance: probe
 * replies, suppression/restoration of the active tool set, and the
 * execute-time fail-closed guard.
 */
export class OfficeCompat implements OfficeToolGuard {
  private readonly host: OfficeCompatHost;
  private readonly toolNames: readonly string[];
  private readonly home: string;
  private readonly packageVersion: string;
  private readonly getOpenRunCount: () => number;
  private readonly getParentSessionId: () => string;
  private readonly logSink: ((line: string) => void) | undefined;
  private suppressedFlag = false;
  private toolSnapshot: readonly string[] | null = null;
  private officeId: string | null = null;
  private policyPath: string | null = null;
  private installed = false;

  constructor(options: OfficeCompatOptions) {
    this.host = options.host;
    this.toolNames = [...options.toolNames];
    this.home = options.home ?? resolveOfficeHome(options.env ?? process.env);
    this.packageVersion = options.packageVersion ?? PACKAGE_VERSION;
    this.getOpenRunCount = options.getOpenRunCount ?? (() => 0);
    this.getParentSessionId = options.getParentSessionId ?? (() => "unbound-session");
    this.logSink = options.log;
  }

  get suppressed(): boolean {
    return this.suppressedFlag;
  }

  /** The exact active-tool array snapshotted at suppression time. */
  get snapshot(): readonly string[] | null {
    return this.toolSnapshot === null ? null : [...this.toolSnapshot];
  }

  get officeHome(): string {
    return this.home;
  }

  private log(line: string): void {
    this.logSink?.(`pi-office-compat: ${line}`);
  }

  /**
   * Install the bus listeners. MUST run at extension-factory time: Pi Office
   * waits exactly one macrotask for the probe reply, and a companion that
   * answers late is treated as incompatible.
   */
  install(): void {
    if (this.installed) return;
    this.installed = true;

    this.host.events.on(COMPAT_PROBE_EVENT, (data: unknown) => {
      if (!isRecord(data)) return;
      if (!positiveInt(data.protocolVersion)) return;
      if (!nonEmptyString(data.replyEvent)) return;
      const reply: CompatProbeReply = {
        protocolVersion: LEGACY_COMPAT_PROTOCOL_VERSION,
        packageVersion: this.packageVersion,
        openRunCount: this.safeOpenRunCount(),
        parentSessionId: this.safeParentSessionId(),
      };
      // Synchronous reply, inside the probe dispatch.
      this.host.events.emit(data.replyEvent, reply);
    });

    this.host.events.on(COMPAT_SUPPRESS_EVENT, (data: unknown) => {
      if (!isRecord(data)) return;
      if (!nonEmptyString(data.officeId) || !nonEmptyString(data.policyPath)) return;
      const active = this.host.getActiveTools();
      const snapshot = [...active];
      this.toolSnapshot = snapshot;
      this.suppressedFlag = true;
      this.officeId = data.officeId;
      this.policyPath = data.policyPath;
      this.host.setActiveTools(active.filter((name) => !this.toolNames.includes(name)));
      this.host.events.emit(COMPAT_SUPPRESSED_REPLY_EVENT, {
        previousToolsHash: hashToolSnapshot(snapshot),
      });
      this.log(`suppressed by Pi Office ${data.officeId} (marker ${data.policyPath})`);
    });

    this.host.events.on(COMPAT_RELEASE_EVENT, (data: unknown) => {
      if (!isRecord(data)) return;
      if (!nonEmptyString(data.officeId)) return;
      if (this.toolSnapshot !== null) this.host.setActiveTools([...this.toolSnapshot]);
      this.suppressedFlag = false;
      this.toolSnapshot = null;
      this.officeId = null;
      this.policyPath = null;
      this.host.events.emit(COMPAT_RELEASED_REPLY_EVENT, { officeId: data.officeId });
      this.log(`released by Pi Office ${data.officeId}; prior tool set restored`);
    });
  }

  /**
   * Fail closed before EVERY launch/control execution: the cross-process
   * marker first (it also catches missed bus events and other Pi processes),
   * then the in-process suppression flag (exact stale-call rejection).
   */
  async assertAllowed(toolName: string, paths: readonly string[]): Promise<void> {
    await assertNoActiveOfficeWindow({
      home: this.home,
      paths,
      ...(this.policyPath !== null ? { markerPaths: [this.policyPath] } : {}),
      toolName,
    });
    if (this.suppressedFlag) {
      throw new OfficeWindowError(
        "office-suppressed",
        `refusing to run ${toolName}: this legacy subagents extension is suppressed by an active Pi Office`
          + `${this.officeId === null ? "" : ` (${this.officeId})`} -- stale call rejected. ${INTERNAL_ONLY_NOTE}`,
        {
          ...(this.policyPath !== null ? { markerPath: this.policyPath } : {}),
          ...(this.officeId !== null ? { officeId: this.officeId } : {}),
        },
      );
    }
  }

  private safeOpenRunCount(): number {
    try {
      const count = this.getOpenRunCount();
      return Number.isInteger(count) && count >= 0 ? count : 0;
    } catch {
      return 0;
    }
  }

  private safeParentSessionId(): string {
    try {
      const id = this.getParentSessionId();
      return nonEmptyString(id) ? id : "unbound-session";
    } catch {
      return "unbound-session";
    }
  }
}

/** Hash of an ORDERED active-tool snapshot (Office records it as evidence). */
export function hashToolSnapshot(names: readonly string[]): string {
  return createHash("sha256").update(JSON.stringify([...names]), "utf8").digest("hex");
}
