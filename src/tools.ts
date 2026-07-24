import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { ProfileCatalog, ProfileName } from "./profiles.ts";
import type { ThinkingLevel } from "./rpc-child.ts";
import { profileGuidance, type SubagentRuntime } from "./runtime.ts";

const strict = { additionalProperties: false } as const;

export interface RuntimeRef {
  get(): SubagentRuntime;
}

export function createStartSchema(catalog: ProfileCatalog) {
  const keys = Object.keys(catalog);
  if (keys.length === 0) throw new Error("Profile catalog must not be empty");
  const profiles = StringEnum(keys as [string, ...string[]]);
  return Type.Object({
    profile: profiles,
    task: Type.String({ minLength: 1 }),
    cwd: Type.String({ minLength: 1 }),
    wait: Type.Optional(Type.Boolean()),
    executionTimeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: 3_600_000 })),
  }, strict);
}

export const statusSchema = Type.Object({
  ids: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 1 })),
  wait: Type.Optional(Type.Boolean()),
  waitTimeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: 300_000 })),
}, strict);

export const sendSchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  message: Type.String({ minLength: 1 }),
  behavior: Type.Optional(StringEnum(["steer", "follow-up"] as const)),
  wait: Type.Optional(Type.Boolean()),
  executionTimeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: 3_600_000 })),
}, strict);

export const stopSchema = Type.Object({
  ids: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
}, strict);

export const TOOL_NAMES = [
  "subagent_start",
  "subagent_status",
  "subagent_send",
  "subagent_stop",
] as const;

function result(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    details: value,
  };
}

function parentLaunch(pi: ExtensionAPI, ctx: ExtensionContext): { model?: string; thinking?: ThinkingLevel } {
  return {
    ...(ctx.model ? { model: `${ctx.model.provider}/${ctx.model.id}` } : {}),
    thinking: pi.getThinkingLevel() as ThinkingLevel,
  };
}

export function registerSubagentTools(
  pi: ExtensionAPI,
  runtime: SubagentRuntime | RuntimeRef,
  catalog: ProfileCatalog,
): void {
  const getRuntime = (): SubagentRuntime => {
    if (typeof (runtime as RuntimeRef).get === "function" && !("start" in runtime)) {
      return (runtime as RuntimeRef).get();
    }
    return runtime as SubagentRuntime;
  };
  const startSchema = createStartSchema(catalog);
  const guidance = profileGuidance(catalog);

  pi.registerTool({
    name: "subagent_start",
    label: "Start subagent",
    description:
      `Start one headless Pi subagent. Profiles: ${guidance}. `
      + "Async is default. wait:true blocks until that run settles and still returns needsStop:true. "
      + "Children do not wake the parent automatically — poll/join with subagent_status and always subagent_stop when done. "
      + "Parent owns Git/worktrees.",
    parameters: startSchema,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      return result(await getRuntime().start({
        profile: params.profile as ProfileName,
        task: params.task,
        cwd: params.cwd,
        wait: params.wait === true,
        ...(params.executionTimeoutMs !== undefined ? { executionTimeoutMs: params.executionTimeoutMs } : {}),
        parent: parentLaunch(pi, ctx),
        ...(signal ? { signal } : {}),
      }));
    },
  });

  pi.registerTool({
    name: "subagent_status",
    label: "Subagent status",
    description:
      "List open runs, snapshot selected ids, or wait:true until every selected id settles (all-settled, no fail-fast). "
      + "wait requires non-empty ids. waitTimeoutMs expires with waitTimedOut:true and leaves children running. "
      + "Esc during wait stops only still-running runs in scope.",
    parameters: statusSchema,
    async execute(_toolCallId, params, signal) {
      return result(await getRuntime().status({
        ...(params.ids ? { ids: params.ids } : {}),
        wait: params.wait === true,
        ...(params.waitTimeoutMs !== undefined ? { waitTimeoutMs: params.waitTimeoutMs } : {}),
        ...(signal ? { signal } : {}),
      }));
    },
  });

  pi.registerTool({
    name: "subagent_send",
    label: "Send to subagent",
    description:
      "Continue an idle run with a new generation prompt, or steer/follow-up an active generation. "
      + "Active sends require behavior: \"steer\" or \"follow-up\". Optional wait blocks for settlement.",
    parameters: sendSchema,
    async execute(_toolCallId, params, signal) {
      return result(await getRuntime().send({
        id: params.id,
        message: params.message,
        ...(params.behavior ? { behavior: params.behavior } : {}),
        wait: params.wait === true,
        ...(params.executionTimeoutMs !== undefined ? { executionTimeoutMs: params.executionTimeoutMs } : {}),
        ...(signal ? { signal } : {}),
      }));
    },
  });

  pi.registerTool({
    name: "subagent_stop",
    label: "Stop subagent",
    description:
      "Stop and remove each requested run independently. Closes owned viewer panes. "
      + "Transcripts remain until parent-session shutdown. Unknown ids do not block others.",
    parameters: stopSchema,
    async execute(_toolCallId, params) {
      return result(await getRuntime().stop(params.ids));
    },
  });
}
