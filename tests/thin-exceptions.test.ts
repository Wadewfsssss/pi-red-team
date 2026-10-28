import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, realpath, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { SdkWorker } from "../src/thin/team/sdk-worker.js";
import type { WorkerConfig } from "../src/thin/team/protocol.js";
import { createTeam, offerWork } from "../src/thin/team/store.js";
import { workerDomainSchemas } from "../src/thin/team/domain-adapter.js";
import { atomicWrite, digest } from "../src/files.js";
import { GraphCapability } from "../src/thin/graph-capability.js";
import { registerDomainTools } from "../src/thin/domain.js";
import type { ExtensionAPI, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { TeamSupervisor, type TeamWorker } from "../src/thin/team/runtime.js";
import { setTimeout as delay } from "node:timers/promises";

async function fixture(execution = false) {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "thin-owned-failure-")));
  const agentDir = join(cwd, "agent"); await mkdir(agentDir);
  const model = { id: "owned-model", name: "Owned failure fixture", reasoning: false, input: ["text"], contextWindow: 1000000, maxTokens: 131072, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  await writeFile(join(agentDir, "models.json"), JSON.stringify({ providers: { "owned-failure": { baseUrl: "http://127.0.0.1:1/v1", apiKey: "owned-synthetic-not-an-account", api: "openai-completions", models: [model] } } }));
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ retry: { enabled: false }, compaction: { enabled: false } }));
  const config: WorkerConfig = { version: 1, workerId: randomUUID(), cwd, agentDir, provider: "owned-failure", model: "owned-model", thinkingLevel: "off", providerExtensions: [await realpath(resolve("tests/fixtures/team-failure-provider.mjs"))], parentTimeoutMs: 15000, execution, domainTools: [] };
  return { cwd, config, cleanup: () => rm(cwd, { recursive: true, force: true }) };
}

for (const outcome of ["error", "aborted", "length"] as const) test(`actual SDK worker ${outcome} is not a successful result or a stale previous answer`, { timeout: 20000 }, async () => {
  const owned = await fixture(); const worker = new SdkWorker(owned.config);
  try {
    await worker.start();
    assert.equal((await worker.prompt("owned-success")).kind, "result");
    await assert.rejects(worker.prompt(`owned-model-${outcome}`), outcome === "error" ? /400.*Invalid schema/ : new RegExp(outcome));
    const next = await worker.prompt("owned-success-after-failure");
    assert.equal(next.kind, "result");
    if (next.kind === "result") assert.equal(next.text, "Owned successful reply");
  } finally { await worker.stop(); await owned.cleanup(); }
});

test("failed atomic rename does not leak temporary files or remove the existing destination", async () => {
  const owned = await fixture();
  try {
    const destination = join(owned.cwd, "existing-directory"); await mkdir(destination);
    await writeFile(join(destination, "owned-marker"), "Keep owned destination intact");
    await assert.rejects(atomicWrite(destination, "Cannot replace a directory"));
    assert.deepEqual((await readdir(owned.cwd)).filter(name => name.endsWith(".tmp")), []);
    assert.deepEqual(await readdir(destination), ["owned-marker"]);
  } finally { await owned.cleanup(); }
});

test("a transient provider error retried successfully by Pi is not reported as a terminal worker failure", { timeout: 20000 }, async () => {
  const owned = await fixture(); const worker = new SdkWorker(owned.config);
  try {
    await writeFile(join(owned.config.agentDir, "settings.json"), JSON.stringify({ retry: { enabled: true, maxRetries: 1, baseDelayMs: 1, maxAgentDelayMs: 1000 }, compaction: { enabled: false } }));
    let retries = 0;
    worker.onActivity(event => { if (event.kind === "activity" && event.event === "provider-retry") retries += 1; });
    await worker.start();
    const response = await worker.prompt("owned-provider-retry");
    assert.equal(response.kind, "result");
    if (response.kind === "result") assert.equal(response.text, "Owned successful reply");
    assert.equal(retries, 1);
  } finally { await worker.stop(); await owned.cleanup(); }
});

test("background worker failure plus checkpoint IO failure is handled and cannot report verified shutdown", { timeout: 15000 }, async () => {
  const owned = await fixture();
  let fail!: () => void;
  const blocked = new Promise<void>(resolve => { fail = resolve; });
  const runtime = new TeamSupervisor(owned, () => {}, config => {
    const view = { workerId: config.workerId, sessionId: randomUUID(), provider: config.provider, model: config.model, thinkingLevel: config.thinkingLevel, contextWindow: 1000000, maxTokens: 131072, tools: [], phase: "idle" as const, bound: true as const };
    return { current: view, start: async () => view, stop: async () => {}, prompt: async () => { await blocked; throw new Error("503 owned provider unavailable"); } } as TeamWorker;
  });
  const internals = runtime as any;
  try {
    await runtime.start({ goal: "Inspect owned fixture only", scope: "Owned temporary directory; no network", candidates: [{ title: "Owned fixture", targetRef: "owned-fixture", operation: "Read owned fixture", preconditionHash: digest("owned") }], workerCount: 1, windowSeconds: 30, maxRounds: 2 }, { provider: owned.config.provider, model: owned.config.model, thinkingLevel: "off", agentDir: owned.config.agentDir }, "owned-parent");
    const settled = Promise.allSettled(internals.loops);
    internals.save = async () => { throw new Error("EIO owned checkpoint unavailable"); };
    fail();
    assert((await settled).every(result => result.status === "fulfilled"));
    await assert.rejects(runtime.stop(), /EIO/);
    assert.equal(internals.checkpoint.phase, "attention");
    assert.equal(internals.checkpoint.runtimeStopVerified, false);
  } finally { fail(); await runtime.stop().catch(() => {}); await owned.cleanup(); }
});

for (const format of ["malformed", "invalid-row", "duplicate", "oversized"] as const) test(`malformed Neo4j ${format} response is structured, not an empty graph or an unlimited retry`, async () => {
  const owned = await fixture();
  try {
    const definitions = new Map<string, any>();
    const api = { registerTool: (tool: any) => definitions.set(tool.name, tool) } as ExtensionAPI;
    const graph = new GraphCapability(api); registerDomainTools(api, graph);
    const link = { id: "owned", source: "source", target: "target", relation: "owned", state: "hypothesis", evidenceRefs: [], observedAt: new Date().toISOString() };
    const text = format === "malformed" ? "Owned invalid JSON" : format === "invalid-row" ? '[{"id":"missing-fields"}]' : JSON.stringify(format === "duplicate" ? [link, link] : Array.from({ length: 257 }, (_, index) => ({ ...link, id: `owned-${index}` })));
    let calls = 0;
    const ctx = { cwd: owned.cwd, isProjectTrusted: () => true, sessionManager: { getSessionId: () => "owned-graph-failure", getBranch: () => [] }, tools: [{ name: "mcp__neo4j__read_cypher", parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } }], executeTool: async () => { calls += 1; return { isError: false, result: { content: [{ type: "text", text }] } }; } } as unknown as ExtensionToolContext;
    const tool = definitions.get("rt_graph");
    const response = await tool.execute(randomUUID(), { action: "snapshot" }, undefined, undefined, ctx);
    assert.equal(response.isError, true); assert.equal(response.structuredContent.reason, "invalid_response");
    assert.equal(response.structuredContent.persistence, "not_applicable");
    const second = await tool.execute(randomUUID(), { action: "snapshot" }, undefined, undefined, ctx);
    assert.equal(second.structuredContent.reason, "failure_cooldown"); assert.equal(calls, 1);
  } finally { await owned.cleanup(); }
});

test("handled input without a new model response cannot return old assistant text", { timeout: 20000 }, async () => {
  const owned = await fixture(); const worker = new SdkWorker(owned.config);
  try {
    await worker.start(); await worker.prompt("owned-success");
    const handled = await worker.prompt("owned-handled");
    assert.equal(handled.kind, "result");
    if (handled.kind === "result") assert.equal(handled.text, "");
  } finally { await worker.stop(); await owned.cleanup(); }
});

test("explicit worker abort rejects the pending prompt without preventing passive inspection", { timeout: 20000 }, async () => {
  const owned = await fixture(); const worker = new SdkWorker(owned.config);
  try {
    await worker.start();
    const running = assert.rejects(worker.prompt("owned-wait"), /aborted|cancelled/);
    let started = false;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const inspected = await worker.inspect();
      if (inspected.kind === "result" && inspected.view.phase === "running") { started = true; break; }
      await delay(10);
    }
    assert(started); await worker.abort(); await running;
    const inspected = await worker.inspect();
    assert.equal(inspected.kind, "result");
    if (inspected.kind === "result") assert.equal(inspected.view.phase, "idle");
  } finally { await worker.stop(); await owned.cleanup(); }
});

test("worker evidence-save exception preserves native output and reports persistence unverified", { timeout: 20000 }, async () => {
  const owned = await fixture(true);
  const state = await createTeam(owned, { goal: "Read an owned local fixture", workerCount: 1, windowSeconds: 60 });
  const offered = await offerWork(owned, state.runId, { title: "Owned fixture", targetRef: "owned-fixture", operation: "Read only owned fixture", preconditionHash: digest("Owned fixture") });
  const worker = new SdkWorker({ ...owned.config, teamRunId: state.runId, workerId: state.workers[0]!, domainTools: workerDomainSchemas() });
  try {
    await writeFile(join(owned.cwd, "evidence"), "Owned path collision for fault injection");
    await worker.start();
    const response = await worker.prompt(`owned-evidence-error:${offered.task.id}`);
    assert.equal(response.kind, "result");
    if (response.kind === "result") {
      assert.match(response.text, /owned-native-result/);
      assert.match(response.text, /persistence is not verified/);
    }
  } finally { await worker.stop(); await owned.cleanup(); }
});
