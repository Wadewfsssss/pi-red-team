import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { digest } from "../src/files.js";
import { TeamSupervisor, type TeamWorker } from "../src/thin/team/runtime.js";
import { registerTeamTools } from "../src/thin/team/extension.js";
import { offerWork } from "../src/thin/team/store.js";
import { workerStateAdapter } from "../src/thin/team/worker-state.js";
import type { WorkerConfig, WorkerView } from "../src/thin/team/protocol.js";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";

const preconditionHash = digest("owned automatic fixture prerequisites");
const candidate = (title: string) => ({ title, targetRef: "owned-fixture.txt", operation: `Read owned fixture: ${title}`, preconditionHash });
const input = { goal: "Inspect only owned fixture data", scope: "Temporary fixture files only; no network", candidates: [candidate("initial")], workerCount: 2, windowSeconds: 10, maxRounds: 5, autoContinue: true, maxParentTurns: 2, execution: false };
async function fixture() {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "thin-team-auto-")));
  const agentDir = join(cwd, "agent"); await mkdir(agentDir);
  await writeFile(join(cwd, "owned-fixture.txt"), "Owned evidence, no targets or model account");
  return { cwd, model: { provider: "owned-scripted", model: "owned-model", thinkingLevel: "off" as const, agentDir }, cleanup: () => rm(cwd, { recursive: true, force: true }) };
}
async function until<Output>(check: () => Promise<Output | undefined>): Promise<Output> {
  for (let attempt = 0; attempt < 200; attempt++) { const result = await check(); if (result !== undefined) return result; await delay(20); }
  assert.fail("Owned automatic fixture did not reach the expected state");
}
function completingWorker(config: WorkerConfig, calls: string[], selfOffer = false): TeamWorker {
  const state = workerStateAdapter(config);
  const view: WorkerView = { workerId: config.workerId, sessionId: randomUUID(), provider: config.provider, model: config.model, thinkingLevel: config.thinkingLevel, contextWindow: 1000000, maxTokens: 131072, tools: ["rt_team"], phase: "idle", bound: true };
  let offered = false;
  return { current: view, start: async () => view, stop: async () => {}, prompt: async prompt => {
    calls.push(prompt);
    const board = await state(randomUUID(), { action: "read" }) as any;
    const task = board.candidates[0];
    if (task) {
      const claimed = await state(randomUUID(), { action: "claim", workItemId: task.id }) as any;
      if (claimed.lease) {
        if (selfOffer && !offered) { offered = true; await state(randomUUID(), { action: "offer", ...candidate("peer-derived follow-up") }); }
        const publication = await state(randomUUID(), { action: "publish", kind: "RESULT", summary: "Owned fixture checked", preconditionHash, evidenceRefs: ["owned-fixture.txt"] }) as any;
        await state(randomUUID(), { action: "complete", recordId: publication.record.id });
      }
    }
    return { kind: "result", requestId: randomUUID(), view, text: "Owned fixture complete", truncated: false };
  } };
}

test("automatic peers stay available within one bounded window and do not poll the model while idle", async () => {
  const owned = await fixture(); const calls: string[] = []; const events: any[] = [];
  const runtime = new TeamSupervisor(owned, event => events.push(event), config => completingWorker(config, calls));
  try {
    await runtime.start(input, owned.model, "owned-parent");
    const first = await until(async () => events.find(event => event.event === "team_batch_completed"));
    const count = calls.length;
    await delay(450);
    assert.equal(calls.length, count);
    assert.equal(events.filter(event => event.event === "team_batch_completed").length, 1);
    assert.equal((await runtime.status()).activeInThisSession, true);
    assert.equal(await runtime.consumeHandoff(first.runId, first.batch, { provider: owned.model.provider, id: owned.model.model }), true);
    assert.equal(await runtime.consumeHandoff(first.runId, first.batch, { provider: owned.model.provider, id: owned.model.model }), false);
    const deadline = (await runtime.status()).state!.deadline;
    await offerWork(owned, first.runId, candidate("parent-derived follow-up"));
    await until(async () => events.filter(event => event.event === "team_batch_completed").length === 2 ? true : undefined);
    const status = await runtime.status();
    assert.equal(status.state!.runId, first.runId); assert.equal(status.state!.deadline, deadline);
    assert(status.state!.tasks.every(task => task.status === "completed"));
    assert.equal(status.checkpoint!.parentTurns, 1);
    assert(calls.every(prompt => prompt.includes("Do not wait for a human to assign every subtask")));
  } finally { await runtime.stop(); await owned.cleanup(); }
});

test("a peer can discover and complete follow-up work without a parent assigning it", async () => {
  const owned = await fixture(); const calls: string[] = []; const events: any[] = [];
  const runtime = new TeamSupervisor(owned, event => events.push(event), config => completingWorker(config, calls, true));
  try {
    await runtime.start({ ...input, workerCount: 1 }, owned.model, "owned-parent");
    await until(async () => events.find(event => event.event === "team_batch_completed"));
    const status = await runtime.status();
    assert.equal(status.state!.tasks.length, 2); assert(status.state!.tasks.every(task => task.status === "completed"));
    assert.equal(status.checkpoint!.parentTurns, 0); assert.equal(calls.length, 2);
  } finally { await runtime.stop(); await owned.cleanup(); }
});

test("parent handoff limits cannot be reset by offering another batch", async () => {
  const owned = await fixture(); const calls: string[] = []; const events: any[] = [];
  const runtime = new TeamSupervisor(owned, event => events.push(event), config => completingWorker(config, calls));
  try {
    await runtime.start({ ...input, workerCount: 1, maxParentTurns: 1 }, owned.model, "owned-parent");
    const first = await until(async () => events.find(event => event.event === "team_batch_completed"));
    assert.equal(await runtime.consumeHandoff(randomUUID(), first.batch, { provider: owned.model.provider, id: owned.model.model }), false);
    assert.equal(await runtime.consumeHandoff(first.runId, first.batch, { provider: owned.model.provider, id: owned.model.model }), true);
    await offerWork(owned, first.runId, candidate("second"));
    const status = await until(async () => { const state = await runtime.status(); return state.checkpoint?.runtimeStopVerified ? state : undefined; });
    assert.match(status.checkpoint!.reason, /parent continuation budget/);
    assert.equal(status.checkpoint!.parentTurns, 1);
    assert.equal(events.filter(event => event.event === "team_batch_completed").length, 1);
  } finally { await runtime.stop(); await owned.cleanup(); }
});

test("automatic standby expires and cannot continue with another model or after stop", async () => {
  for (const reason of ["deadline", "model", "stop"]) {
    const owned = await fixture(); const events: any[] = [];
    const runtime = new TeamSupervisor(owned, event => events.push(event), config => completingWorker(config, []));
    try {
      await runtime.start({ ...input, workerCount: 1, windowSeconds: reason === "deadline" ? 1 : 10 }, owned.model, "owned-parent");
      const first = await until(async () => events.find(event => event.event === "team_batch_completed"));
      if (reason === "model") assert.equal(await runtime.consumeHandoff(first.runId, first.batch, { provider: "other", id: "other" }), false);
      if (reason === "stop") await runtime.stop();
      await until(async () => (await runtime.status()).checkpoint?.runtimeStopVerified ? true : undefined);
      assert.equal(await runtime.consumeHandoff(first.runId, first.batch, { provider: owned.model.provider, id: owned.model.model }), false);
    } finally { await runtime.stop(); await owned.cleanup(); }
  }
});

async function extensionFixture(idle: boolean, overrides: Record<string, unknown> = {}, parentTools = ["read", "grep", "find", "ls", "bash", "edit", "write", "rt_team"]) {
  const owned = await fixture(); const handlers = new Map<string, Function>(); const tools = new Map<string, any>(); const messages: any[] = []; const events: any[] = [];
  let confirmations = 0; let runtime!: TeamSupervisor; let emit!: (notification: unknown) => void;
  const ctx = { cwd: owned.cwd, mode: "tui", hasUI: true, model: { provider: owned.model.provider, id: owned.model.model }, isProjectTrusted: () => true, isIdle: () => idle, sessionManager: { getSessionId: () => "owned-parent", getSessionFile: () => undefined, getBranch: () => [] }, ui: { confirm: async () => { confirmations += 1; return true; }, setStatus: () => {}, notify: () => {} } };
  const configs: WorkerConfig[] = [];
  registerTeamTools({ registerTool: (tool: any) => tools.set(tool.name, tool), on: (name: string, handler: Function) => handlers.set(name, handler), getThinkingLevel: () => "off", getActiveTools: () => parentTools, appendEntry: (_name: string, entry: any) => events.push(entry), sendMessage: (message: any, options: any) => messages.push({ message, options }) } as any, (project, notify) => {
    emit = notify;
    runtime = new TeamSupervisor(project, notify, config => { configs.push(config); return completingWorker({ ...config, agentDir: owned.model.agentDir }, []); }); return runtime;
  });
  const execute = (params: any) => tools.get("rt_team").execute(randomUUID(), params, undefined, undefined, ctx);
  const { autoContinue: _autoContinue, ...initial } = input;
  await execute({ action: "start", ...initial, ...overrides });
  await until(async () => events.find(event => event.event === "team_batch_completed"));
  return { ...owned, handlers, tools, messages, events, ctx, execute, runtime, emit, configs, confirmations: () => confirmations, close: async () => { await handlers.get("session_before_switch")!(); await owned.cleanup(); } };
}

test("routine startup infers native execution only from the parent active tool set", async () => {
  for (const nativeTools of [["read"], ["read", "edit"]]) {
    const owned = await extensionFixture(false, { execution: undefined }, [...nativeTools, "rt_team"]);
    try {
      assert.equal(owned.confirmations(), 0);
      assert(owned.configs.length > 0);
      for (const config of owned.configs) { assert.deepEqual(config.nativeTools, nativeTools); assert.equal(config.execution, nativeTools.includes("edit")); }
    } finally { await owned.close(); }
  }
});

test("a newer notice arriving during handoff consumption is delivered once after the busy gate clears", async () => {
  const owned = await extensionFixture(false);
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const batches: string[] = [];
  owned.runtime.consumeHandoff = async (_runId, batch) => { batches.push(batch); if (batches.length === 1) await blocked; return true; };
  try {
    owned.ctx.isIdle = () => true;
    const first = owned.events.find(event => event.event === "team_batch_completed");
    const consuming = owned.handlers.get("agent_before_settle")!({ outcome: "completed", entries: [], context: {} }, owned.ctx);
    const newerBatch = digest("Owned newer incremental notice");
    owned.emit({ event: "team_evidence_available", runId: first.runId, batch: newerBatch });
    await delay(50);
    assert.equal(batches.length, 1);
    release(); await consuming;
    await until(async () => owned.messages.find(message => message.options.triggerTurn));
    assert.deepEqual(batches, [first.batch, newerBatch]);
    assert.equal(owned.messages.filter(message => message.options.triggerTurn).length, 1);
    assert.equal(owned.messages.find(message => message.options.triggerTurn).message.details.batch, newerBatch);
    await delay(50); assert.equal(batches.length, 2);
  } finally { release(); await owned.close(); }
});

test("busy main Pi continues through the official settlement boundary, preserving prior entries", async () => {
  const owned = await extensionFixture(false);
  try {
    assert.equal(owned.messages.filter(message => message.options.triggerTurn).length, 0);
    const previous = { type: "custom", customType: "owned-existing", data: 1 };
    const boundary = { outcome: "completed", entries: [previous], continue: false, context: { canContinue: false } };
    const result = await owned.handlers.get("agent_before_settle")!(boundary, owned.ctx);
    assert.equal(result.continue, true); assert.deepEqual(result.entries[0], previous);
    assert.equal(result.entries[1].customType, "redteam-team-handoff");
    assert.equal(await owned.handlers.get("agent_before_settle")!(boundary, owned.ctx), undefined);
    await owned.execute({ action: "offer", candidate: candidate("automatic second batch") });
    await until(async () => owned.events.filter(event => event.event === "team_batch_completed").length === 2 ? true : undefined);
    assert.equal(owned.confirmations(), 0);
    assert.equal((await owned.runtime.status()).checkpoint!.parentTurns, 1);
  } finally { await owned.close(); }
});

test("idle main Pi receives one native follow-up and lifecycle notifications remain passive", async () => {
  const owned = await extensionFixture(true);
  try {
    const next = await until(async () => owned.messages.find(message => message.options.triggerTurn === true));
    assert.equal(next.options.deliverAs, "followUp"); assert.equal(next.message.details.authorizationExpanded, false);
    await delay(450);
    assert.equal(owned.messages.filter(message => message.options.triggerTurn).length, 1);
    await owned.execute({ action: "stop" });
    assert(owned.messages.filter(message => message.message.customType === "redteam-team").every(message => message.options.triggerTurn === false));
  } finally { await owned.close(); }
});

test("manual stop, session replacement and interrupted main Pi discard pending automatic handoffs", async () => {
  for (const action of ["stop", "switch", "abort"]) {
    const owned = await extensionFixture(false);
    try {
      if (action === "stop") await owned.execute({ action: "stop" });
      if (action === "switch") await owned.handlers.get("session_before_switch")!();
      if (action === "abort") await owned.handlers.get("agent_before_settle")!({ outcome: "aborted", entries: [], context: {} }, owned.ctx);
      assert.equal(await owned.handlers.get("agent_before_settle")!({ outcome: "completed", entries: [], context: { canContinue: false } }, owned.ctx), undefined);
      assert.equal(owned.messages.filter(message => message.options.triggerTurn).length, 0);
      assert.equal((await owned.runtime.status()).checkpoint!.runtimeStopVerified, true);
    } finally { await owned.close(); }
  }
});

for (const mode of ["tui", "rpc"] as const) test(`an actual offline Pi ${mode} session delegates and resumes with no team confirmation or extra user prompt`, { timeout: 15000 }, async () => {
  const owned = await fixture();
  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  let runtime: TeamSupervisor | undefined;
  let calls = 0; let confirmations = 0; let customStarts = 0;
  const errors: unknown[] = [];
  try {
    const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    await writeFile(join(owned.model.agentDir, "models.json"), JSON.stringify({ providers: { [owned.model.provider]: { api: "openai-completions", baseUrl: "http://127.0.0.1:1/v1", apiKey: "owned-synthetic-not-an-account", models: [{ id: owned.model.model, name: "Owned automatic fixture", reasoning: false, input: ["text"], contextWindow: 1000000, maxTokens: 131072, cost }] } } }));
    const settings = SettingsManager.inMemory({ cacheWarming: "off", compaction: { enabled: false } }); settings.setProjectTrusted(true);
    const modelRuntime = await ModelRuntime.create({ authPath: join(owned.model.agentDir, "auth.json"), modelsPath: join(owned.model.agentDir, "models.json"), allowModelNetwork: false, refreshOnCreate: false });
    const loader = new DefaultResourceLoader({ cwd: owned.cwd, agentDir: owned.model.agentDir, settingsManager: settings, noExtensions: true, disabledBuiltinExtensions: ["mcp"], noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, extensionFactories: [pi => {
      registerTeamTools(pi, (project, notify) => { runtime = new TeamSupervisor(project, notify, config => completingWorker(config, [])); return runtime; });
      pi.on("project_trust", () => ({ trusted: "yes", remember: false }));
      pi.on("before_agent_start", event => { if (event.messageType === "custom") customStarts += 1; });
      pi.registerProvider(owned.model.provider, {
        api: "openai-completions", baseUrl: "http://127.0.0.1:1/v1", apiKey: "owned-synthetic-not-an-account",
        models: [{ id: owned.model.model, name: "Owned automatic fixture", reasoning: false, input: ["text"], contextWindow: 1000000, maxTokens: 131072, cost }],
        streamSimple(model) {
          calls += 1;
          const content: any[] = calls === 1 ? [{ type: "toolCall", id: "owned-auto-start", name: "rt_team", arguments: { action: "start", ...input, workerCount: 1 } }] : calls === 3 ? [{ type: "toolCall", id: "owned-auto-stop", name: "rt_team", arguments: { action: "stop" } }] : [{ type: "text", text: calls === 2 ? "Owned work delegated; waiting for evidence" : "Owned automatic handoff reviewed" }];
          const message: any = { role: "assistant", content, api: model.api, provider: model.provider, model: model.id, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { ...cost, total: 0 } }, stopReason: content[0].type === "toolCall" ? "toolUse" : "stop", timestamp: Date.now() };
          const stream = createAssistantMessageEventStream();
          queueMicrotask(() => { stream.push({ type: "start", partial: message }); stream.push({ type: "done", reason: message.stopReason, message }); stream.end(); });
          return stream;
        },
      });
    }] });
    await loader.reload();
    const created = await createAgentSession({ cwd: owned.cwd, agentDir: owned.model.agentDir, modelRuntime, model: modelRuntime.getModel(owned.model.provider, owned.model.model), thinkingLevel: "off", settingsManager: settings, sessionManager: SessionManager.create(owned.cwd, join(owned.cwd, "sessions")), resourceLoader: loader, tools: ["rt_team"] });
    session = created.session;
    await session.bindExtensions({ mode, ...(mode === "tui" ? { uiContext: { confirm: async () => { confirmations += 1; throw new Error("Routine delegation must not ask for approval"); }, setStatus: () => {}, notify: () => {} } as any } : {}), onError: error => errors.push(error) });
    await session.prompt("Inspect the owned fixture and report evidence; choose an efficient approach.");
    await until(async () => calls >= 4 && session?.isIdle ? true : undefined);
    await session.waitForIdle();
    assert.equal(confirmations, 0); assert.equal(customStarts, 1); assert.equal(calls, 4); assert.deepEqual(errors, []);
    const history = await readFile(session.sessionManager.getSessionFile()!, "utf8");
    assert.match(history, /redteam-team-handoff/); assert.match(history, /Owned automatic handoff reviewed/);
    assert.equal(history.split('"role":"user"').length - 1, 1);
    assert.equal((await runtime!.status()).checkpoint!.runtimeStopVerified, true);
  } finally { await runtime?.stop(); await session?.dispose(); await owned.cleanup(); }
});
