import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { stream } from "@earendil-works/pi-ai/api/openai-completions";
import { normalizeContext } from "@earendil-works/pi-ai";
import { z } from "redteam-zod";
import extension from "../src/thin/index.js";
import { campaignInput, campaignToolInput } from "../src/thin/campaign.js";
import { Type } from "typebox";
import { registerWorkerTeamTool } from "../src/thin/team/worker-tool.js";
import { workerDomainSchemas } from "../src/thin/team/domain-adapter.js";
import type { WorkerConfig } from "../src/thin/team/protocol.js";
import { randomUUID } from "node:crypto";

function declarations() {
  const tools: any[] = [];
  extension({ on: () => () => {}, registerCommand: () => {}, registerTool: (tool: unknown) => tools.push(tool) } as unknown as ExtensionAPI);
  return tools;
}

test("every red-team input schema has an object root on the actual OpenAI-compatible wire", async () => {
  const tools = declarations();
  assert.deepEqual(tools.map(tool => tool.name).sort(), ["rt_campaign", "rt_graph", "rt_job", "rt_search", "rt_team"]);
  for (const tool of tools) {
    assert.equal(tool.parameters.type, "object", tool.name);
    assert.equal(tool.parameters.oneOf, undefined, tool.name);
    assert.equal(tool.parameters.anyOf, undefined, tool.name);
  }
  const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const model = { id: "owned-schema", name: "Owned schema fixture", api: "openai-completions" as const, provider: "owned-schema", baseUrl: "http://127.0.0.1:1/v1", reasoning: false, input: ["text" as const], contextWindow: 1000000, maxTokens: 131072, cost };
  let payload: any;
  const response = await stream(model, normalizeContext({ messages: [{ role: "user", content: "Inspect schemas only", timestamp: 0 }], tools }), {
    apiKey: "owned-synthetic-not-an-account", maxRetries: 0,
    onPayload(value) { payload = value; throw new Error("owned-schema-capture-complete"); },
    fetch: async () => { assert.fail("Schema capture must not send any network request"); },
  }).result();
  assert.match(response.errorMessage ?? "", /owned-schema-capture-complete/);
  assert.equal(payload.tools.length, 5);
  for (const tool of payload.tools) assert.equal(tool.function.parameters.type, "object", tool.function.name);
  const campaign = payload.tools.find((tool: any) => tool.function.name === "rt_campaign").function.parameters;
  assert.deepEqual(campaign.required, ["action"]);
  assert.deepEqual(campaign.properties.action.enum, ["status", "target", "coverage"]);
});

test("campaign object declaration accepts valid actions while runtime keeps action-specific strict validation", () => {
  const declaration = z.toJSONSchema(campaignToolInput, { io: "input" });
  assert.equal(declaration.type, "object");
  const valid = [
    { action: "status" },
    { action: "target", target: { id: "owned", targetRef: "owned-fixture.txt", category: "web" } },
    { action: "coverage", targetId: "owned", surface: "Inputs", status: "examined", observation: "Owned fixture checked" },
  ];
  for (const input of valid) {
    assert(campaignToolInput.safeParse(input).success);
    assert(campaignInput.safeParse(input).success);
  }
  const coverage = campaignInput.parse(valid[2]);
  assert.equal(coverage.action, "coverage");
  if (coverage.action === "coverage") assert.deepEqual(coverage.evidenceRefs, []);
  const invalid = [{ action: "target" }, { action: "coverage", targetId: "owned" }, { action: "status", surface: "Unexpected" }, { action: "configure" }, { action: "status", unknown: true }];
  for (const input of invalid) assert(!campaignInput.safeParse(input).success);
});

test("worker cooperation and copied domain declarations also have object roots on the model wire", async () => {
  const tools: any[] = [];
  const config = { teamRunId: randomUUID(), domainTools: workerDomainSchemas() } as WorkerConfig;
  registerWorkerTeamTool({ registerTool: (tool: unknown) => tools.push(tool) } as ExtensionAPI, config, Type, async () => "{}");
  const model = { id: "owned-worker-schema", name: "Owned worker schema", api: "openai-completions" as const, provider: "owned-schema", baseUrl: "http://127.0.0.1:1/v1", reasoning: false, input: ["text" as const], contextWindow: 1000000, maxTokens: 131072, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  let payload: any;
  await stream(model, normalizeContext({ messages: [{ role: "user", content: "Inspect worker declarations only", timestamp: 0 }], tools }), {
    apiKey: "owned-synthetic-not-an-account", maxRetries: 0,
    onPayload(value) { payload = value; throw new Error("owned-worker-schema-capture-complete"); },
    fetch: async () => { assert.fail("Worker schema capture must not send any network request"); },
  }).result();
  assert.equal(payload.tools.length, 5);
  for (const tool of payload.tools) assert.equal(tool.function.parameters.type, "object", tool.function.name);
});
