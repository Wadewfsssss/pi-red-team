import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { teamToolInputSchema, type TeamToolInput, type WorkerConfig } from "./protocol.js";
import type { TSchema } from "typebox";

export function registerWorkerTeamTool(pi: ExtensionAPI, config: WorkerConfig, Type: typeof import("typebox").Type, invoke: (toolCallId: string, input: TeamToolInput, signal?: AbortSignal) => Promise<string>): void {
  const runId = config.teamRunId;
  if (!runId) return;
  pi.registerTool({
    name: "rt_team", label: "Local worker cooperation", exposure: "direct", executionMode: "sequential",
    description: "Read peer summaries, choose and atomically claim one candidate, publish evidence-backed observations or results, and complete or release your own claim. When candidatesTruncated is true, use nextCandidateAfter as candidateAfter to inspect later candidates; after a claim conflict choose another angle or page. Peers choose independently. This worker cannot start, stop or enlarge a team. Reading is not acknowledgement; records are not verified findings.",
    parameters: Type.Union([
      Type.Object({ action: Type.Literal("read"), after: Type.Optional(Type.Integer({ minimum: 0 })), candidateAfter: Type.Optional(Type.String({ format: "uuid" })) }),
      Type.Object({ action: Type.Literal("unfold"), recordId: Type.String({ pattern: "^[a-f0-9]{64}$" }) }),
      Type.Object({ action: Type.Literal("request_graph") }),
      Type.Object({ action: Type.Literal("claim"), workItemId: Type.String({ format: "uuid" }) }),
      Type.Object({ action: Type.Literal("publish"), kind: Type.Union([Type.Literal("OBSERVED"), Type.Literal("HYPOTHESIS"), Type.Literal("FAIL"), Type.Literal("RESULT")]), summary: Type.String({ minLength: 1, maxLength: 512 }), preconditionHash: Type.String({ pattern: "^[a-f0-9]{64}$" }), evidenceRefs: Type.Array(Type.String({ minLength: 1, maxLength: 500 }), { maxItems: 20 }) }),
      Type.Object({ action: Type.Literal("complete"), recordId: Type.String({ pattern: "^[a-f0-9]{64}$" }) }),
      Type.Object({ action: Type.Literal("release") }),
      Type.Object({ action: Type.Literal("offer"), title: Type.String({ minLength: 1, maxLength: 500 }), targetRef: Type.String({ minLength: 1, maxLength: 500 }), operation: Type.String({ minLength: 1, maxLength: 500 }), preconditionHash: Type.String({ pattern: "^[a-f0-9]{64}$" }) }),
    ]),
    async execute(toolCallId, input, signal) {
      signal?.throwIfAborted();
      const text = await invoke(toolCallId, teamToolInputSchema.parse(input), signal);
      return { content: [{ type: "text" as const, text }], details: { parentStateAdapter: true } };
    },
  });
  for (const tool of config.domainTools) {
    pi.registerTool({
      name: tool.name, label: tool.name, exposure: "direct", executionMode: "sequential",
      description: tool.description, parameters: tool.parameters as TSchema,
      async execute(toolCallId, params, signal, _update, ctx) {
        const percent = ctx.getContextUsage()?.percent;
        const text = await invoke(toolCallId, { action: "domain", tool: tool.name, params: params as Record<string, unknown>, ...(percent == null ? {} : { contextPercent: percent }) }, signal);
        if (tool.name === "rt_search" && ["select", "interrupt", "feedback"].includes((params as { action: string }).action)) {
          const data = JSON.parse(text) as { attemptId?: string; branchId?: string; phase?: string };
          if (data.attemptId) pi.appendEntry("redteam-selection", data);
          else if ((params as { action: string }).action === "feedback" && (params as { attemptId?: string }).attemptId) {
            let activeAttempt: string | undefined;
            for (const entry of ctx.sessionManager.getBranch()) {
              if (entry.type !== "custom" || entry.customType !== "redteam-selection") continue;
              const selection = entry.data as { attemptId?: string; phase?: string };
              if (selection.phase === "active") activeAttempt = selection.attemptId;
              else if (selection.attemptId === activeAttempt) activeAttempt = undefined;
            }
            if (activeAttempt === (params as { attemptId?: string }).attemptId) pi.appendEntry("redteam-selection", { phase: "completed", attemptId: activeAttempt });
          }
        }
        return { content: [{ type: "text" as const, text }], details: { parentStateAdapter: true } };
      },
    });
  }
}
