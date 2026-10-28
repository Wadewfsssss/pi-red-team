import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export default function teamFixture(pi) {
  const configuredModel = JSON.parse(readFileSync(join(process.env.PI_CODING_AGENT_DIR, "models.json"), "utf8")).providers["team-scripted"].models[0];
  let calls = 0;
  let candidateIndex = 0;
  pi.on("input", event => event.text === "owned-handled-input" ? { action: "handled" } : undefined);
  pi.registerProvider("team-scripted", {
    baseUrl: "http://127.0.0.1:1/v1", apiKey: "synthetic-not-an-account", api: "openai-completions",
    models: [configuredModel],
    streamSimple(model, context, options) {
      const stream = createAssistantMessageEventStream();
      const content = JSON.stringify(context);
      if (content.includes("UNRELATED_SYSTEM_SENTINEL")) throw new Error("Unrelated system instructions leaked into worker");
      const summarizing = content.includes("context summarization assistant");
      const current = [...context.messages].reverse().find(message => message.role === "user");
      const currentText = JSON.stringify(current);
      const native = currentText.includes("owned-native-execution:");
      const supervised = currentText.includes("Authorized goal:");
      const cooperation = currentText.includes("team-cooperate:") || supervised;
      const waiting = currentText.includes("wait-until-aborted") && !summarizing;
      const names = context.messages.filter(message => message.role === "system").flatMap(message => message.toolsAdded ?? []).map(tool => tool.name);
      if (names.some(name => (!native && ["bash", "edit", "write"].includes(name)) || (!cooperation && !native && name === "rt_team") || name.startsWith("mcp__"))) throw new Error("Worker tool ceiling leaked");
      let cooperativeContent;
      if (native) {
        const text = typeof current.content === "string" ? current.content : current.content.filter(entry => entry.type === "text").map(entry => entry.text).join("\n");
        const seed = JSON.parse(text.slice(text.indexOf("owned-native-execution:") + 23));
        calls += 1;
        if (calls === 1 && seed.claim) cooperativeContent = [{ type: "toolCall", id: "owned-native-claim", name: "rt_team", arguments: { action: "claim", workItemId: seed.claim } }];
        else if (calls === (seed.claim ? 2 : 1)) cooperativeContent = [{ type: "toolCall", id: "owned-native-bash", name: "bash", arguments: { command: seed.command ?? "printf owned-native-data > worker-owned.txt; cat worker-owned.txt" } }];
        else {
          if (seed.expectPeerNotice && !content.includes("Peer evidence notice")) throw new Error("Peer evidence did not reach the real model context during native execution");
          cooperativeContent = [{ type: "text", text: "Owned native fixture finished" }];
        }
      }
      if (cooperation) {
        const text = typeof current.content === "string" ? current.content : current.content.filter(entry => entry.type === "text").map(entry => entry.text).join("\n");
        let seed = supervised ? undefined : JSON.parse(text.slice(text.indexOf("team-cooperate:") + 15));
        const values = [];
        const visit = value => {
          if (typeof value === "string") { try { const parsed = JSON.parse(value); if (parsed && typeof parsed === "object") values.push(parsed); } catch {} }
          else if (Array.isArray(value)) value.forEach(visit);
          else if (value && typeof value === "object") Object.values(value).forEach(visit);
        };
        visit(context.messages);
        const board = values.filter(value => Array.isArray(value.candidates) && value.goal).at(-1);
        if (supervised && board) seed = { candidateIds: board.candidates.filter(task => task.status === "ready" || task.status === "claimed").map(task => task.id), preconditionHash: board.candidates[0].preconditionHash, evidenceRef: "team-evidence.txt" };
        const claimed = values.filter(value => typeof value.claimed === "boolean").at(-1);
        const published = values.filter(value => value.admitted === true && value.record).at(-1);
        const completed = values.some(value => value.completed === true);
        const searched = values.some(value => value.id === "owned-root" && typeof value.attempts === "number");
        calls += 1;
        if (calls > 8) throw new Error("Owned cooperation fixture exceeded its fixed protocol steps");
        if (completed) cooperativeContent = [{ type: "text", text: "Owned worker finished its independently claimed work" }];
        else {
          let args;
          if (!seed) args = { action: "read" };
          else if (!claimed?.claimed) {
            if (claimed?.claimed === false) candidateIndex += 1;
            args = { action: "claim", workItemId: seed.candidateIds[candidateIndex] };
          } else if (supervised && !searched) args = { action: "upsert", branch: { id: "owned-root", title: "Owned scoped search", status: "active", remainingSteps: 1, promise: 0.5, evidence: [{ reference: seed.evidenceRef, category: "verified" }] } };
          else if (!published) args = { action: "publish", kind: "RESULT", summary: "Owned read-only fixture inspected", preconditionHash: seed.preconditionHash, evidenceRefs: [seed.evidenceRef] };
          else args = { action: "complete", recordId: published.record.id };
          cooperativeContent = [{ type: "toolCall", id: `owned-cooperate-${calls}`, name: args.action === "upsert" ? "rt_search" : "rt_team", arguments: args }];
        }
      }
      const finish = aborted => {
        const message = {
          role: "assistant", content: cooperativeContent ?? [{ type: "text", text: aborted ? "Owned request aborted" : summarizing ? "## Goal\nContinue the owned fixture.\n## Progress\nOwned-history-marker retained.\n## Critical Context\nOnly read tools, no real model or target." : `Owned scripted result; previous-marker=${content.includes("Owned-history-marker")}; model-output-limit=${model.maxTokens}` }],
          api: model.api, provider: model.provider, model: model.id,
          usage: { input: 3, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 5, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: aborted ? "aborted" : cooperativeContent?.[0]?.type === "toolCall" ? "toolUse" : "stop", timestamp: Date.now(),
        };
        stream.push({ type: "start", partial: message });
        stream.push(aborted ? { type: "error", reason: "aborted", error: message } : { type: "done", reason: message.stopReason, message });
        stream.end();
      };
      if (waiting) {
        if (options?.signal?.aborted) queueMicrotask(() => finish(true));
        else options?.signal?.addEventListener("abort", () => finish(true), { once: true });
      } else queueMicrotask(() => finish(false));
      return stream;
    },
  });
}
