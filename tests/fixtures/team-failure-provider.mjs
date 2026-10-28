import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";

export default function failureFixture(pi) {
  const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let retryAttempts = 0;
  pi.on("input", event => event.text === "owned-handled" ? { action: "handled" } : undefined);
  pi.registerProvider("owned-failure", {
    api: "openai-completions", baseUrl: "http://127.0.0.1:1/v1", apiKey: "owned-synthetic-not-an-account",
    models: [{ id: "owned-model", name: "Owned failure fixture", reasoning: false, input: ["text"], contextWindow: 1000000, maxTokens: 131072, cost }],
    streamSimple(model, context, options) {
      const stream = createAssistantMessageEventStream();
      const current = [...context.messages].reverse().find(message => message.role === "user");
      const text = JSON.stringify(current);
      if (text.includes("owned-wait")) {
        const message = { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { ...cost, total: 0 } }, stopReason: "aborted", timestamp: Date.now() };
        const cancel = () => { stream.push({ type: "error", reason: "aborted", error: message }); stream.end(); };
        if (options?.signal?.aborted) cancel(); else options?.signal?.addEventListener("abort", cancel, { once: true });
        return stream;
      }
      const retrying = text.includes("owned-provider-retry");
      const transient = retrying && retryAttempts++ === 0;
      const failed = text.includes("owned-model-error") || transient, aborted = text.includes("owned-model-aborted"), length = text.includes("owned-model-length");
      const native = text.includes("owned-evidence-error");
      const toolResult = [...context.messages].reverse().find(message => message.role === "toolResult");
      const workItemId = /owned-evidence-error:([a-f0-9-]+)/.exec(text)?.[1];
      const content = native && !toolResult ? [{ type: "toolCall", id: "owned-evidence-claim", name: "rt_team", arguments: { action: "claim", workItemId } }] : native && toolResult.toolName === "rt_team" ? [{ type: "toolCall", id: "owned-evidence-command", name: "bash", arguments: { command: "printf owned-native-result" } }] : aborted ? [] : [{ type: "text", text: failed ? "Unverified partial text" : native ? JSON.stringify(toolResult) : "Owned successful reply" }];
      const stopReason = failed ? "error" : aborted ? "aborted" : length ? "length" : content[0]?.type === "toolCall" ? "toolUse" : "stop";
      const message = { role: "assistant", content, api: model.api, provider: model.provider, model: model.id, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { ...cost, total: 0 } }, stopReason, timestamp: Date.now(), ...(failed ? { errorMessage: transient ? "503 owned temporary server error" : '400 Invalid schema for function rt_search' } : {}) };
      queueMicrotask(() => {
        stream.push({ type: "start", partial: message });
        stream.push(stopReason === "error" || stopReason === "aborted" ? { type: "error", reason: stopReason, error: message } : { type: "done", reason: stopReason, message });
        stream.end();
      });
      return stream;
    },
  });
}
