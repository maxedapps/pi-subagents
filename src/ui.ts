import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Component,
  type TUI,
} from "@earendil-works/pi-tui";
import { readFileSync } from "node:fs";
import type { RunSnapshot, RunState } from "./runtime.ts";

export const WIDGET_KEY = "pi-subagents";
const PROFILE_WIDTH = 10;

type WidgetTone = "accent" | "success" | "warning" | "error" | "muted" | "dim";

export interface WidgetRow {
  kind: "agent" | "overflow";
  profile?: string;
  id?: string;
  generation?: string;
  phase?: string;
  label?: string;
  tone: WidgetTone;
}

export interface WidgetPresentation {
  header: string;
  rows: WidgetRow[];
  hint: string;
}

function toneFor(state: RunState): WidgetTone {
  if (state === "running" || state === "starting") return "accent";
  if (state === "idle") return "success";
  if (state === "failed" || state === "timedout") return "error";
  if (state === "blocked") return "warning";
  return "muted";
}

function shortRunId(id: string): string {
  return (id.startsWith("run-") ? id.slice(4) : id).slice(0, 8);
}

export function presentWidget(runs: readonly RunSnapshot[]): WidgetPresentation | undefined {
  const visible = runs.filter((run) => run.state !== "stopped");
  if (!visible.length) return undefined;
  const active = visible.filter((run) => run.state === "starting" || run.state === "running").length;
  const rows: WidgetRow[] = visible.map((run) => ({
    kind: "agent",
    profile: run.profile,
    id: shortRunId(run.id),
    generation: `g${run.generation}`,
    phase: run.state,
    tone: toneFor(run.state),
  }));
  return {
    header: `Subagents · ${active} active · ${visible.length - active} idle/settled`,
    rows: rows.length <= 5
      ? rows
      : [...rows.slice(0, 4), { kind: "overflow", label: `+${rows.length - 4} more`, tone: "muted" }],
    hint: "/subagents",
  };
}

export function formatWidgetLines(runs: readonly RunSnapshot[]): string[] | undefined {
  const presentation = presentWidget(runs);
  if (!presentation) return undefined;
  return [
    presentation.header,
    ...presentation.rows.map((row) =>
      row.kind === "overflow"
        ? `  ${row.label}`
        : `  ${(row.profile ?? "").padEnd(PROFILE_WIDTH)} ${row.id} · ${row.generation} ${row.phase}`
    ),
    `  ${presentation.hint}`,
  ];
}

function fit(text: string, width: number, padding = " "): string {
  const fitted = truncateToWidth(text, width, "");
  return fitted + padding.repeat(Math.max(0, width - visibleWidth(fitted)));
}

export function tuiWidget(presentation: WidgetPresentation) {
  return (_tui: TUI, theme: Theme): Component => ({
    render(width: number): string[] {
      if (width <= 0) return [];
      if (width <= 3) return [theme.fg("border", "─".repeat(width))];
      const innerWidth = width - 2;
      const top = theme.fg("border", `╭${fit(`─ ${presentation.header} `, innerWidth, "─")}╮`);
      const body = presentation.rows.map((row) => {
        const content = row.kind === "overflow"
          ? ` ${theme.fg("muted", row.label ?? "")}`
          : ` ${theme.fg(row.tone, "●")} ${(row.profile ?? "").padEnd(PROFILE_WIDTH)} ${theme.fg("dim", `${row.id} · ${row.generation}`)} ${theme.fg(row.tone, row.phase ?? "")}`;
        return theme.fg("border", "│") + fit(content, innerWidth) + theme.fg("border", "│");
      });
      const hint = theme.fg("border", "│") + fit(` ${theme.fg("dim", presentation.hint)}`, innerWidth) + theme.fg("border", "│");
      const bottom = theme.fg("border", `╰${"─".repeat(innerWidth)}╯`);
      return [top, ...body, hint, bottom];
    },
    invalidate() {},
  });
}

export type OverlayAction =
  | { type: "close" }
  | { type: "refresh" }
  | { type: "select"; run: RunSnapshot };

export class RunListOverlay implements Component {
  private selected = 0;
  private offset = 0;
  private readonly pageSize = 10;

  constructor(
    private readonly getRuns: () => readonly RunSnapshot[],
    private readonly theme: Theme,
    private readonly onAction: (action: OverlayAction) => void,
    private readonly requestRender: () => void,
  ) {}

  handleInput(data: string): void {
    const runs = this.getRuns();
    if (matchesKey(data, Key.escape)) {
      this.onAction({ type: "close" });
      return;
    }
    if (data.toLowerCase() === "r") {
      this.onAction({ type: "refresh" });
      return;
    }
    if (runs.length === 0) return;
    if (matchesKey(data, Key.up)) {
      this.selected = Math.max(0, this.selected - 1);
      this.ensureVisible(runs.length);
      this.requestRender();
      return;
    }
    if (matchesKey(data, Key.down)) {
      this.selected = Math.min(runs.length - 1, this.selected + 1);
      this.ensureVisible(runs.length);
      this.requestRender();
      return;
    }
    if (matchesKey(data, Key.enter)) {
      const run = runs[this.selected];
      if (run) this.onAction({ type: "select", run });
    }
  }

  render(width: number): string[] {
    if (width < 4) return width > 0 ? [truncateToWidth("Subagents", width, "")] : [];
    const runs = this.getRuns();
    this.selected = Math.min(this.selected, Math.max(0, runs.length - 1));
    this.ensureVisible(runs.length);

    const innerWidth = width - 2;
    const row = (content = "", selected = false): string => {
      const clipped = truncateToWidth(content, innerWidth, "");
      const padded = clipped + " ".repeat(Math.max(0, innerWidth - visibleWidth(clipped)));
      const body = selected ? this.theme.bg("selectedBg", padded) : padded;
      return this.theme.fg("border", "│") + body + this.theme.fg("border", "│");
    };

    const lines: string[] = [this.theme.fg("borderAccent", `╭${"─".repeat(innerWidth)}╮`)];
    lines.push(row(` ${this.theme.fg("accent", this.theme.bold("Subagents"))}${this.theme.fg("dim", ` · ${runs.length} open`)}`));
    lines.push(row());

    if (runs.length === 0) {
      lines.push(row(` ${this.theme.fg("muted", "No open subagent runs")}`));
    } else {
      const visible = runs.slice(this.offset, this.offset + this.pageSize);
      for (let index = 0; index < visible.length; index += 1) {
        const absolute = this.offset + index;
        const run = visible[index]!;
        const marker = absolute === this.selected ? "▶" : " ";
        const content = `${marker} ${run.profile.padEnd(PROFILE_WIDTH)} ${shortRunId(run.id)}  g${run.generation}  ${run.state}`;
        lines.push(row(` ${content}`, absolute === this.selected));
      }
    }

    lines.push(row());
    lines.push(row(` ${this.theme.fg("dim", "↑↓ navigate · Enter inspect · r refresh · Esc close")}`));
    lines.push(this.theme.fg("borderAccent", `╰${"─".repeat(innerWidth)}╯`));
    return lines.map((line) => truncateToWidth(line, width, ""));
  }

  invalidate(): void {}

  private ensureVisible(length: number): void {
    if (length === 0) {
      this.selected = 0;
      this.offset = 0;
      return;
    }
    if (this.selected < this.offset) this.offset = this.selected;
    if (this.selected >= this.offset + this.pageSize) this.offset = this.selected - this.pageSize + 1;
    this.offset = Math.max(0, Math.min(this.offset, Math.max(0, length - this.pageSize)));
  }
}

export class DetailOverlay implements Component {
  constructor(
    private readonly run: RunSnapshot,
    private readonly theme: Theme,
    private readonly onClose: () => void,
  ) {}

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.enter)) this.onClose();
  }

  render(width: number): string[] {
    if (width < 4) return [];
    const innerWidth = width - 2;
    const row = (content = ""): string => {
      const clipped = truncateToWidth(content, innerWidth, "");
      const padded = clipped + " ".repeat(Math.max(0, innerWidth - visibleWidth(clipped)));
      return this.theme.fg("border", "│") + padded + this.theme.fg("border", "│");
    };
    const transcript = readTranscriptTail(this.run.transcriptPath, 40);
    const lines = [
      this.theme.fg("borderAccent", `╭${"─".repeat(innerWidth)}╮`),
      row(` ${this.theme.fg("accent", this.theme.bold(this.run.profile))} ${this.theme.fg("dim", this.run.id)}`),
      row(` ${this.theme.fg(toneFor(this.run.state), this.run.state)}  g${this.run.generation}  ${this.theme.fg("dim", this.run.cwd)}`),
      row(` ${this.theme.fg("dim", this.run.transcriptPath)}`),
      row(),
      ...transcript.map((line) => row(` ${line}`)),
      row(),
      row(` ${this.theme.fg("dim", "Enter/Esc close")}`),
      this.theme.fg("borderAccent", `╰${"─".repeat(innerWidth)}╯`),
    ];
    return lines.map((line) => truncateToWidth(line, width, ""));
  }

  invalidate(): void {}
}

export function readTranscriptTail(path: string, maxLines = 40): string[] {
  try {
    const text = readFileSync(path, "utf8");
    const lines = text.split(/\r?\n/);
    if (lines.at(-1) === "") lines.pop();
    return lines.slice(-maxLines);
  } catch {
    return ["(transcript unavailable)"];
  }
}
