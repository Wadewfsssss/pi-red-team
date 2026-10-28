import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionToolContext, ToolLoadout } from "@earendil-works/pi-coding-agent";
import { GraphCapability, bindCypher } from "../src/thin/graph-capability.js";
import { registerDomainTools } from "../src/thin/domain.js";
import { recordLink } from "../src/thin/graph.js";
import { digest } from "../src/files.js";
import { createTeam, offerWork, claimWork, readTeam, requestGraphRefresh, setGraphAccess, settleGraphRequests } from "../src/thin/team/store.js";
import { workerDomainAdapter } from "../src/thin/team/domain-adapter.js";
import { registerTeamTools } from "../src/thin/team/extension.js";
import type { TeamSupervisor } from "../src/thin/team/runtime.js";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, getCurrentTools } from "@earendil-works/pi-ai";

const schema = Type.Object({ query: Type.String() });

test("actual Pi SDK hides off declarations and routes deferred MCP through native nested calls", { timeout: 15000 }, async () => {
  const cwd = await mkdtemp(join(tmpdir(), "thin-graph-native-"));
  const agentDir = join(cwd, "agent"); let session: any; let graph!: GraphCapability; let context!: ExtensionToolContext;
  let modelCalls = 0; let queries = 0; const declarations: string[][] = [];
  try {
    await mkdir(agentDir);
    const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    const model = { id: "owned", name: "Synthetic graph SDK fixture", reasoning: false, input: ["text"], contextWindow: 1000000, maxTokens: 131072, cost };
    await writeFile(join(agentDir, "models.json"), JSON.stringify({ providers: { "owned-graph": { api: "openai-completions", baseUrl: "http://127.0.0.1:1/v1", apiKey: "synthetic-not-an-account", models: [model] } } }));
    const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json"), allowModelNetwork: false, refreshOnCreate: false });
    const settings = SettingsManager.inMemory({ cacheWarming: "off", compaction: { enabled: false } }); settings.setProjectTrusted(true);
    const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager: settings, noExtensions: true, disabledBuiltinExtensions: ["mcp"], noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, extensionFactories: [pi => {
      graph = new GraphCapability(pi); registerDomainTools(pi, graph);
      pi.on("session_start", (_event, ctx) => { context = ctx as ExtensionToolContext; graph.restore(ctx); });
      pi.registerTool({ ...tool("read"), label: "Synthetic deferred read Cypher", description: "No server connection", exposure: "deferred", execute: async () => { queries += 1; return { content: [{ type: "text", text: "[]" }] }; } });
      pi.registerProvider("owned-graph", { api: "openai-completions", baseUrl: "http://127.0.0.1:1/v1", apiKey: "synthetic-not-an-account", models: [model as any], streamSimple(selected, input) {
        declarations.push(getCurrentTools(input.messages).map(value => value.name)); modelCalls += 1;
        const content: any[] = modelCalls === 2 ? [{ type: "toolCall", id: "owned-graph-call", name: "rt_graph", arguments: { action: "snapshot" } }] : [{ type: "text", text: "Owned graph fixture done" }];
        const message: any = { role: "assistant", content, api: selected.api, provider: selected.provider, model: selected.id, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { ...cost, total: 0 } }, stopReason: modelCalls === 2 ? "toolUse" : "stop", timestamp: Date.now() };
        const stream = createAssistantMessageEventStream(); queueMicrotask(() => { stream.push({ type: "start", partial: message }); stream.push({ type: "done", reason: message.stopReason, message }); stream.end(); }); return stream;
      } });
    }] });
    await loader.reload();
    session = (await createAgentSession({ cwd, agentDir, modelRuntime, model: modelRuntime.getModel("owned-graph", "owned"), settingsManager: settings, sessionManager: SessionManager.create(cwd, join(cwd, "sessions")), resourceLoader: loader })).session;
    await session.bindExtensions({ mode: "rpc", onError: (error: unknown) => { throw error; } });
    const activeTools = session.getActiveToolNames();
    graph.select(context, "off"); await session.prompt("Owned task without graph");
    assert(!declarations[0]!.includes("rt_graph")); assert.equal(queries, 0);
    graph.select(context, "auto"); await session.prompt("Read the owned graph fixture");
    assert.deepEqual(session.getActiveToolNames(), activeTools);
    assert(declarations[1]!.includes("rt_graph")); assert(!declarations[1]!.includes(tool("read").name));
    assert.equal(queries, 1); assert.equal(modelCalls, 3);
    assert.equal(graph.status(context).read, true);
    const history = await readFile(session.sessionManager.getSessionFile(), "utf8");
    assert.match(history, /nestedCalls/); assert.match(history, /mcp__neo4j__read_cypher/);
  } finally { await session?.dispose(); await rm(cwd, { recursive: true, force: true }); }
});
const tool = (operation: "read" | "write", server = "neo4j") => ({ name: `mcp__${server}__${operation}_cypher`, parameters: schema });
const relationship = () => ({ source: { id: "finding", kind: "finding" as const, name: "Synthetic finding", properties: { status: "confirmed" as const } }, target: { id: "asset", kind: "asset" as const, name: "Owned asset" }, link: { id: "link", source: "finding", target: "asset", relation: "AFFECTS", state: "observed" as const, evidenceRefs: ["evidence.txt"], observedAt: new Date().toISOString() } });

async function fixture() {
  const cwd = await mkdtemp(join(tmpdir(), "thin-graph-optional-"));
  const tools = new Map<string, any>();
  const entries: any[] = [];
  let registry: any[] = [];
  const api = { registerTool: (value: any) => tools.set(value.name, value), getAllTools: () => registry, getActiveTools: () => registry.filter(value => value.exposure === "direct").map(value => value.name), appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data, id: randomUUID() }) } as unknown as ExtensionAPI;
  const graph = new GraphCapability(api);
  registerDomainTools(api, graph);
  const ctx = { cwd, isProjectTrusted: () => true, sessionManager: { getSessionId: () => "owned-session", getBranch: () => entries }, tools: [] as any[], executeTool: async () => ({ isError: false, result: { content: [{ type: "text", text: "[]" }] } }) } as unknown as ExtensionToolContext;
  const execute = (params: unknown, signal?: AbortSignal) => tools.get("rt_graph").execute("owned-call", params, signal, undefined, ctx);
  return { cwd, tools, api, graph, ctx, entries, execute, setRegistry: (value: any[]) => { registry = value; }, close: () => rm(cwd, { recursive: true, force: true }) };
}

test("unconfigured graph is optional and does not initialize workspace or Finding records", async () => {
  const owned = await fixture();
  try {
    assert.equal((await owned.execute({ action: "snapshot" })).structuredContent.status, "unavailable");
    assert.equal((await owned.execute({ action: "record", ...relationship() })).structuredContent.persistence, "not_attempted");
    await assert.rejects(stat(join(owned.cwd, ".redteam")), { code: "ENOENT" });
    assert.equal(owned.graph.status(owned.ctx).reason, "not_observed");
  } finally { await owned.close(); }
});

test("callable read and write capabilities degrade independently, with successful empty graph distinct", async () => {
  const owned = await fixture();
  try {
    (owned.ctx as any).tools = [tool("read")];
    const snapshot = (await owned.execute({ action: "snapshot" })).structuredContent;
    assert.equal(snapshot.executed, true); assert.deepEqual(snapshot.links, []);
    assert.equal((await owned.execute({ action: "record", ...relationship() })).structuredContent.status, "unavailable");
    (owned.ctx as any).tools = [tool("write")];
    await writeFile(join(owned.cwd, "evidence.txt"), "Owned evidence");
    assert.equal((await owned.execute({ action: "record", ...relationship() })).structuredContent.persistence, "acknowledged");
    assert.equal((await owned.execute({ action: "snapshot" })).structuredContent.status, "unavailable");
  } finally { await owned.close(); }
});

test("off is branch-persistent, hides only declarations and blocks old nested callers", async () => {
  const owned = await fixture();
  try {
    (owned.ctx as any).tools = [tool("read")];
    owned.graph.select(owned.ctx, "off");
    const restarted = new GraphCapability(owned.api); restarted.restore(owned.ctx);
    assert.equal(restarted.status(owned.ctx).mode, "off");
    assert.deepEqual(restarted.prepare({ callable: [tool("read")] } as unknown as ToolLoadout).hiddenDeclarations, ["rt_graph"]);
    assert.equal((await owned.execute({ action: "snapshot" })).structuredContent.reason, "disabled");
    await assert.rejects(stat(join(owned.cwd, ".redteam")), { code: "ENOENT" });
    owned.entries.length = 0;
    assert.equal(restarted.status(owned.ctx).mode, "auto");
  } finally { await owned.close(); }
});

test("metadata and native callability are separate, delayed binding is re-evaluated at execute", async () => {
  const owned = await fixture();
  try {
    owned.setRegistry([{ ...tool("read"), exposure: "deferred" }, { ...tool("write"), exposure: "hidden" }]);
    assert.equal(owned.graph.status(owned.ctx).read, true);
    assert.equal(owned.graph.status(owned.ctx).write, false);
    assert.equal((await owned.execute({ action: "snapshot" })).structuredContent.reason, "not_callable");
    (owned.ctx as any).tools = [tool("read")];
    assert.equal((await owned.execute({ action: "snapshot" })).structuredContent.executed, true);
    assert.equal(bindCypher([tool("read"), { ...tool("read"), name: "mcp__neo4j__read_extra_cypher" }], "neo4j", false).reason, "ambiguous");
    assert.equal(bindCypher([{ name: tool("read").name, parameters: Type.Object({ sql: Type.String() }) }], "neo4j", false).reason, "schema_incompatible");
    assert.equal(bindCypher([{ name: tool("read").name, parameters: Type.Object({ query: Type.String(), database: Type.String() }) }], "neo4j", false).reason, "schema_incompatible");
  } finally { await owned.close(); }
});

test("server selection is explicit and does not switch databases from model arguments", async () => {
  const owned = await fixture();
  try {
    (owned.ctx as any).tools = [tool("read", "other")];
    assert.equal((await owned.execute({ action: "snapshot", server: "other" })).structuredContent.reason, "server_not_selected");
    owned.graph.select(owned.ctx, "auto", "other");
    assert.deepEqual(owned.tools.get("rt_graph").reachesTools({ action: "snapshot" }), ["mcp__other"]);
    assert.deepEqual(owned.graph.reaches("neo4j"), []);
    assert.equal((await owned.execute({ action: "snapshot" })).structuredContent.executed, true);
    owned.graph.select(owned.ctx, "off");
    assert.deepEqual(owned.graph.reaches(), []);
  } finally { await owned.close(); }
});

test("write failure is unknown, preserves diagnostics and is never automatically replayed", async () => {
  const owned = await fixture(); let calls = 0;
  try {
    (owned.ctx as any).tools = [tool("write")];
    (owned.ctx as any).executeTool = async () => { calls += 1; throw new Error("Synthetic disconnect after request"); };
    await writeFile(join(owned.cwd, "evidence.txt"), "Owned evidence");
    const failed = await owned.execute({ action: "record", ...relationship() });
    assert.equal(failed.isError, true); assert.equal(failed.structuredContent.persistence, "unknown");
    assert.equal((await owned.execute({ action: "record", ...relationship() })).structuredContent.reason, "failure_cooldown");
    assert.equal(calls, 1);
    await assert.rejects(stat(join(owned.cwd, ".redteam/findings")), { code: "ENOENT" });
  } finally { await owned.close(); }
});

test("write acknowledged with local failure reports partial success instead of a false rollback", async () => {
  const owned = await fixture();
  try {
    await writeFile(join(owned.cwd, "evidence.txt"), "Owned evidence");
    (owned.ctx as any).executeTool = async () => { await writeFile(join(owned.cwd, ".redteam/findings"), "Synthetic path collision"); return { isError: false, result: { content: [] } }; };
    const rejected = await recordLink({ cwd: owned.cwd }, { ...owned.ctx, tools: [tool("write")] } as any, "neo4j", relationship()).then(() => undefined, error => error);
    assert.equal(rejected.data.persistence, "acknowledged"); assert.equal(rejected.data.persisted, true);
  } finally { await owned.close(); }
});

test("cancellation after a write request is unknown and off does not claim a rollback", async () => {
  const owned = await fixture(); let release!: () => void;
  try {
    await writeFile(join(owned.cwd, "evidence.txt"), "Owned evidence");
    (owned.ctx as any).tools = [tool("write")];
    const entered = new Promise<void>(resolve => { release = resolve; });
    (owned.ctx as any).executeTool = async (_name: string, _args: unknown, options: { signal: AbortSignal }) => { release(); await new Promise((_, reject) => options.signal.addEventListener("abort", () => reject(new Error("Cancelled")), { once: true })); };
    const running = owned.execute({ action: "record", ...relationship() });
    await entered; owned.graph.select(owned.ctx, "off");
    const result = await running;
    assert.equal(result.isError, true); assert.equal(result.structuredContent.persistence, "unknown");
    assert.equal(result.structuredContent.reason, "cancelled");
  } finally { await owned.close(); }
});

test("a native read that ignores cancellation cannot return a stale successful snapshot", async () => {
  const owned = await fixture(); let entered!: () => void; let release!: () => void;
  try {
    (owned.ctx as any).tools = [tool("read")];
    const started = new Promise<void>(resolve => { entered = resolve; });
    const paused = new Promise<void>(resolve => { release = resolve; });
    (owned.ctx as any).executeTool = async () => { entered(); await paused; return { isError: false, result: { content: [{ type: "text", text: "[]" }] } }; };
    const running = owned.execute({ action: "snapshot" });
    await started; owned.graph.select(owned.ctx, "off"); release();
    const result = await running;
    assert.equal(result.isError, true); assert.equal(result.structuredContent.reason, "cancelled");
    assert.equal(result.structuredContent.persistence, "not_applicable");
  } finally { release?.(); await owned.close(); }
});

test("graph requests are unavailable without read capability and off clears existing waits", async () => {
  const owned = await fixture();
  try {
    const project = { cwd: owned.cwd }, run = await createTeam(project, { goal: "Owned graph fixture" });
    const workerId = run.workers[0]!;
    await requestGraphRefresh(project, run.runId, workerId);
    await setGraphAccess(project, run.runId, { mode: "off", server: "neo4j", read: false, write: false, reason: "disabled" });
    assert.deepEqual((await readTeam(project))!.graphRequests, {});
    assert.equal((await requestGraphRefresh(project, run.runId, workerId) as any).status, "unavailable");
    assert.equal((await readTeam(project))!.graphResults[workerId]!.status, "unavailable");
  } finally { await owned.close(); }
});

test("old graph response cannot consume a newer request or a different epoch", async () => {
  const owned = await fixture();
  try {
    const project = { cwd: owned.cwd }, run = await createTeam(project, { goal: "Owned graph fixture" });
    const workerId = run.workers[0]!;
    const first = await requestGraphRefresh(project, run.runId, workerId) as { requestedAt: number };
    await settleGraphRequests(project, run.runId, run.epoch, { [workerId]: first.requestedAt }, "updated", "fixture");
    const second = await requestGraphRefresh(project, run.runId, workerId) as { requestedAt: number };
    assert(second.requestedAt > first.requestedAt);
    await settleGraphRequests(project, run.runId, run.epoch, { [workerId]: first.requestedAt }, "failed", "late");
    await settleGraphRequests(project, run.runId, run.epoch + 1, { [workerId]: second.requestedAt }, "failed", "wrong epoch");
    assert.equal((await readTeam(project))!.graphRequests[workerId], second.requestedAt);
  } finally { await owned.close(); }
});

test("failed native team refresh settles waiters and graph-only stale notice consumes no handoff", async () => {
  const owned = await fixture();
  const hooks = new Map<string, any>(); let notify!: (status: unknown) => void; let consumed = 0;
  const project = { cwd: owned.cwd }; let runId = "";
  (owned.api as any).on = (event: string, handler: unknown) => hooks.set(event, handler);
  (owned.api as any).getThinkingLevel = () => "off";
  (owned.ctx as any).model = { provider: "owned", id: "synthetic" };
  (owned.ctx as any).mode = "rpc";
  (owned.ctx as any).isIdle = () => false;
  (owned.ctx.sessionManager as any).getSessionFile = () => undefined;
  const team = registerTeamTools(owned.api, (_project, callback) => {
    notify = callback;
    return { project, async start(config: any, model: any) {
      const state = await createTeam(project, { goal: config.goal, workerCount: config.workerCount, windowSeconds: config.windowSeconds, limits: config.limits }); runId = state.runId;
      await setGraphAccess(project, runId, model.graphAccess);
    }, async status() { return { activeInThisSession: true, state: await readTeam(project) }; },
    async stop() {}, async consumeHandoff() { consumed += 1; return true; } } as unknown as TeamSupervisor;
  }, owned.graph);
  try {
    owned.setRegistry([{ ...tool("read"), exposure: "deferred" }]);
    (owned.ctx as any).tools = [tool("read")];
    const execute = (params: unknown) => owned.tools.get("rt_team").execute("owned-team", params, undefined, undefined, owned.ctx);
    await execute({ action: "start", goal: "Only owned data", scope: "Temporary files", candidates: [{ title: "Owned", targetRef: "owned", operation: "Read owned data", preconditionHash: digest("owned") }], execution: false });
    const state = (await readTeam(project))!; const workerId = state.workers[0]!;
    await requestGraphRefresh(project, runId, workerId);
    (owned.ctx as any).executeTool = async () => { throw new Error("Owned disconnected MCP"); };
    const failed = await execute({ action: "refresh_graph" });
    assert.equal(failed.isError, true); assert.equal(failed.structuredContent.refreshed, false);
    assert.deepEqual((await readTeam(project))!.graphRequests, {});
    assert.equal((await readTeam(project))!.graphResults[workerId]!.status, "failed");
    assert.equal((await requestGraphRefresh(project, runId, workerId) as any).graphUpdated, false);
    owned.graph.select(owned.ctx, "auto"); await team.updateGraph(owned.ctx);
    await requestGraphRefresh(project, runId, workerId);
    notify({ event: "team_graph_requested", runId, batch: digest("owned-request") });
    owned.graph.select(owned.ctx, "off"); await team.updateGraph(owned.ctx);
    assert.equal(await hooks.get("agent_before_settle")({ outcome: "completed", entries: [] }, owned.ctx), undefined);
    assert.equal(consumed, 0); assert.deepEqual((await readTeam(project))!.graphRequests, {});
  } finally { await team.close(); await owned.close(); }
});

test("invalid saved mode fails closed and can be explicitly repaired", async () => {
  const owned = await fixture();
  try {
    owned.entries.push({ type: "custom", customType: "redteam-graph-selection", data: { version: 1, mode: "auto", server: "bad.name" } });
    owned.graph.restore(owned.ctx);
    assert.equal(owned.graph.status(owned.ctx).mode, "off");
    assert.equal(owned.graph.status(owned.ctx).lastFailure?.reason, "invalid_saved_selection");
    owned.graph.select(owned.ctx, "auto", "neo4j");
    assert.equal(owned.graph.status(owned.ctx).mode, "auto");
  } finally { await owned.close(); }
});

test("worker graph validates snapshot origin and rechecks evidence without live MCP", async () => {
  const owned = await fixture();
  try {
    const project = { cwd: owned.cwd }, run = await createTeam(project, { goal: "Owned graph fixture" });
    const work = await offerWork(project, run.runId, { title: "Owned", targetRef: "owned", operation: "Read local files", preconditionHash: digest("owned") });
    const claim = (await claimWork(project, { runId: run.runId, workItemId: work.task.id, workerId: run.workers[0]!, requestId: randomUUID() })).lease!;
    const adapter = workerDomainAdapter(project, false);
    const query = { action: "domain" as const, tool: "rt_graph" as const, params: { action: "snapshot" } };
    assert.equal((await adapter.invoke(claim, "missing", query) as any).reason, "snapshot_missing");
    const path = join(owned.cwd, ".redteam/team/graph.json");
    await writeFile(join(owned.cwd, "evidence.txt"), "Original");
    const snapshot = { runId: run.runId, epoch: run.epoch, workspaceKey: run.workspaceKey, server: "neo4j", capturedAt: Date.now(), links: [{ ...relationship().link, evidenceHashes: [digest("Original")], evidenceVerified: true }] };
    await writeFile(path, JSON.stringify(snapshot));
    assert.equal((await adapter.invoke(claim, "original", query) as any).links[0].evidenceVerified, true);
    await writeFile(join(owned.cwd, "evidence.txt"), "Changed");
    assert.equal((await adapter.invoke(claim, "changed", query) as any).links[0].evidenceVerified, false);
    await writeFile(path, JSON.stringify({ ...snapshot, server: "other" }));
    await assert.rejects(adapter.invoke(claim, "other", query), /does not match/);
    await writeFile(path, JSON.stringify({ ...snapshot, capturedAt: Date.now() + 100000 }));
    await assert.rejects(adapter.invoke(claim, "future", query), /future/);
    await setGraphAccess(project, run.runId, { mode: "off", server: "neo4j", read: false, write: false, reason: "disabled" });
    assert.equal((await adapter.invoke(claim, "off", query) as any).reason, "disabled");
  } finally { await owned.close(); }
});
