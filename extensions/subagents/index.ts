import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { fileURLToPath } from "node:url";
import { detectHerdrEnv, HerdrViewerManager } from "../../src/herdr.ts";
import { CHILD_ENV_MARKER, loadProfileCatalog } from "../../src/profiles.ts";
import { SubagentRuntime } from "../../src/runtime.ts";
import { registerSubagentTools } from "../../src/tools.ts";
import {
  DetailOverlay,
  formatWidgetLines,
  presentWidget,
  type OverlayAction,
  RunListOverlay,
  tuiWidget,
  WIDGET_KEY,
} from "../../src/ui.ts";

const skillPath = fileURLToPath(new URL("../../skills/use-pi-subagents/SKILL.md", import.meta.url));

type EndMessage = { role?: string; stopReason?: string };

export function lastAssistantMessage(messages: readonly EndMessage[]): EndMessage | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "assistant") return message;
  }
  return undefined;
}

export function isAbortedAssistantStop(messages: readonly EndMessage[]): boolean {
  const assistant = lastAssistantMessage(messages);
  return assistant?.role === "assistant" && assistant.stopReason === "aborted";
}

export default function subagentsExtension(pi: ExtensionAPI): void {
  if (process.env[CHILD_ENV_MARKER] === "1") return;

  const profiles = loadProfileCatalog();
  let runtime: SubagentRuntime | undefined;
  let herdr: HerdrViewerManager | undefined;
  let refreshWidget: () => void = () => {};

  const runtimeRef = {
    get(): SubagentRuntime {
      if (!runtime) throw new Error("Subagent runtime is not bound to a parent session yet");
      return runtime;
    },
  };

  function ensureRuntime(ctx: ExtensionContext): SubagentRuntime {
    if (runtime) return runtime;
    herdr = new HerdrViewerManager(
      (command, args, options) => pi.exec(command, args, options),
      detectHerdrEnv(),
    );
    runtime = new SubagentRuntime({
      catalog: profiles,
      parentSessionId: ctx.sessionManager.getSessionId(),
      onChange: () => refreshWidget(),
      closeViewer: async (runId) => {
        await herdr?.close(runId);
      },
    });
    return runtime;
  }

  function bindWidget(ctx: ExtensionContext): void {
    refreshWidget = () => {
      if (!runtime || !ctx.hasUI) return;
      const runs = runtime.listOpen();
      if (ctx.mode === "tui") {
        const presentation = presentWidget(runs);
        ctx.ui.setWidget(
          WIDGET_KEY,
          presentation ? tuiWidget(presentation) : undefined,
          { placement: "belowEditor" },
        );
      } else {
        ctx.ui.setWidget(WIDGET_KEY, formatWidgetLines(runs), { placement: "belowEditor" });
      }
    };
    refreshWidget();
  }

  registerSubagentTools(pi, runtimeRef, profiles);
  pi.on("resources_discover", () => ({ skillPaths: [skillPath] }));

  pi.on("session_start", (_event, ctx) => {
    ensureRuntime(ctx);
    bindWidget(ctx);
  });

  pi.on("context", (event, ctx) => {
    const active = ensureRuntime(ctx);
    const reminder = active.formatReminder();
    if (!reminder) return;
    return {
      messages: [
        ...event.messages,
        {
          role: "custom" as const,
          customType: "pi-subagent-reminder",
          content: reminder,
          display: false,
          timestamp: Date.now(),
        },
      ],
    };
  });

  pi.on("agent_end", async (event, ctx) => {
    if (!isAbortedAssistantStop(event.messages)) return;
    const active = ensureRuntime(ctx);
    if (!active.hasActiveRuns()) return;
    await active.stopActive("parent-esc");
    refreshWidget();
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    try {
      if (runtime) {
        await herdr?.closeAll();
        await runtime.shutdown();
      }
    } finally {
      if (ctx.hasUI) ctx.ui.setWidget(WIDGET_KEY, undefined);
      runtime = undefined;
      herdr = undefined;
      refreshWidget = () => {};
    }
  });

  pi.registerCommand("subagents", {
    description: "Inspect open Pi subagent runs",
    handler: async (_args, ctx) => {
      const active = ensureRuntime(ctx);
      if (ctx.mode !== "tui") {
        ctx.ui.notify("Interactive /subagents inspection requires the TUI. Use subagent_status instead.", "warning");
        return;
      }
      const viewer = herdr ?? new HerdrViewerManager(
        (command, args, options) => pi.exec(command, args, options),
        detectHerdrEnv(),
      );
      herdr = viewer;
      await showRunOverlay(ctx, active, viewer, () => refreshWidget());
    },
  });
}

async function showRunOverlay(
  ctx: ExtensionCommandContext,
  runtime: SubagentRuntime,
  herdr: HerdrViewerManager,
  refresh: () => void,
): Promise<void> {
  const selected = await ctx.ui.custom<OverlayAction>((tui, theme, _keys, done) => {
    return new RunListOverlay(
      () => runtime.listOpen(),
      theme,
      (action) => {
        if (action.type === "refresh") {
          refresh();
          tui.requestRender();
          return;
        }
        done(action);
      },
      () => tui.requestRender(),
    );
  }, {
    overlay: true,
    overlayOptions: {
      anchor: "center",
      width: "80%",
      minWidth: 72,
      maxHeight: "80%",
      margin: 1,
    },
  });

  if (!selected || selected.type !== "select") return;
  const run = selected.run;

  if (herdr.isAvailable) {
    const opened = await herdr.openOrFocus(run.id, run.transcriptPath, `${run.profile}-${run.id.slice(-8)}`);
    if (opened.ok) {
      ctx.ui.notify(`Herdr viewer focused for ${run.profile}`, "info");
      return;
    }
    herdr.clear(run.id);
    ctx.ui.notify(`Herdr viewer unavailable (${opened.reason}); showing Pi detail.`, "warning");
  }

  await ctx.ui.custom((_tui, theme, _keys, done) => {
    return new DetailOverlay(runtime.get(run.id) ?? run, theme, () => done(undefined));
  }, {
    overlay: true,
    overlayOptions: {
      anchor: "center",
      width: "90%",
      minWidth: 72,
      maxHeight: "85%",
      margin: 1,
    },
  });
}
