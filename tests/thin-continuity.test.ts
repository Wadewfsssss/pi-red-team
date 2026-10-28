import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, realpath, writeFile, readFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { workerDomainAdapter } from "../src/thin/team/domain-adapter.js";
import { TeamSupervisor, type TeamWorker } from "../src/thin/team/runtime.js";
import { workerStateAdapter } from "../src/thin/team/worker-state.js";
import type { WorkerConfig, WorkerView } from "../src/thin/team/protocol.js";
import { digest } from "../src/files.js";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { registerTeamTools } from "../src/thin/team/extension.js";

const goal = "Assess owned local fixtures and report limitations";
async function fixture() {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "thin-continuity-")));
  await writeFile(join(cwd, "evidence.txt"), "Owned observation, no network or account");
  const project = { cwd };
  return { project, cwd, cleanup: () => rm(cwd, { recursive: true, force: true }) };
}
async function stopped(runtime: TeamSupervisor) {
  for (let attempt = 0; attempt < 300; attempt++) { const status = await runtime.status(); if (status.checkpoint?.runtimeStopVerified) return status; await delay(20); }
  assert.fail("Fixture did not stop within its bounded deadline");
}
function idle(config: WorkerConfig): TeamWorker {
  const view: WorkerView = { workerId: config.workerId, sessionId: randomUUID(), provider: config.provider, model: config.model, thinkingLevel: "off", contextWindow: 1000000, maxTokens: 384000, tools: [], phase: "idle", bound: true };
  return { current: view, start: async () => view, stop: async () => {}, prompt: async () => ({ kind: "result", requestId: randomUUID(), view, text: "Owned fixture, no new evidence", truncated: false }) };
}

test("runtime liveness pauses preserve budgets and never classify search or goal completion", async () => {
  const owned = await fixture(); const events: any[] = []; let prompts = 0;
  const model = { provider: "scripted", model: "owned", thinkingLevel: "off" as const, agentDir: owned.cwd };
  const factory = (config: WorkerConfig) => { const worker = idle(config); return { ...worker, prompt: async (prompt: string) => { prompts++; return worker.prompt(prompt); } }; };
  const runtime = new TeamSupervisor(owned.project, event => events.push(event), factory); let resumed: TeamSupervisor | undefined;
  try {
    const input = { goal, scope: "Owned files only", candidates: [{ title: "Owned inspection", targetRef: "owned", operation: "Read owned files", preconditionHash: digest("owned") }], workerCount: 1, autoContinue: true, maxRounds: 8, maxParentTurns: 2, windowSeconds: 10 };
    await runtime.start(input, model, "owned-session"); const before = await stopped(runtime);
    assert.equal(prompts, 2); assert.equal(before.checkpoint!.workers[0]!.noProgress, 2);
    assert.equal(before.goalCompletionNotImplied, true);
    assert.equal(events.some(event => ["team_goal_review_needed", "team_reassessment_requested"].includes(event.event)), false);
    assert.equal(events.find(event => event.event === "team_stopped").goalCompletionNotImplied, true);
    resumed = new TeamSupervisor(owned.project, () => {}, factory); await resumed.start(input, model, "owned-resumed", true);
    const after = await stopped(resumed); assert(after.checkpoint!.workers[0]!.rounds > before.checkpoint!.workers[0]!.rounds);
    assert(after.checkpoint!.workers[0]!.noProgress > before.checkpoint!.workers[0]!.noProgress);
  } finally { await runtime.stop(); await resumed?.stop(); await owned.cleanup(); }
});

test("speculative publications cannot hide a stalled worker", async () => {
  const owned = await fixture(); let prompts = 0;
  const runtime = new TeamSupervisor(owned.project, () => {}, config => {
    const worker = idle(config); const state = workerStateAdapter(config); let claimed = false;
    return { ...worker, prompt: async prompt => {
      prompts++;
      if (!claimed) { const board = await state(randomUUID(), { action: "read" }) as any; await state(randomUUID(), { action: "claim", workItemId: board.candidates[0].id }); claimed = true; }
      await state(randomUUID(), { action: "publish", kind: "HYPOTHESIS", summary: "Another unsupported interpretation", preconditionHash: digest("owned"), evidenceRefs: [] });
      return worker.prompt(prompt);
    } };
  });
  try {
    await runtime.start({ goal, scope: "Owned files only", candidates: [{ title: "Owned inspection", targetRef: "owned", operation: "Read files", preconditionHash: digest("owned") }], workerCount: 1, maxRounds: 8, windowSeconds: 10 }, { provider: "scripted", model: "owned", thinkingLevel: "off", agentDir: owned.cwd }, "owned-parent");
    const status = await stopped(runtime); assert.equal(prompts, 2); assert.equal(status.checkpoint!.workers[0]!.noProgress, 2);
  } finally { await runtime.stop(); await owned.cleanup(); }
});

test("actual native Pi uses worker-result handoffs, never a coverage-completeness wakeup", { timeout: 15000 }, async () => {
  const owned = await fixture(); let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  let runtime: TeamSupervisor | undefined; let calls = 0; let confirmations = 0; let started = false; let offered = false; let stoppedTeam = false; let sawBatch = false;
  const errors: unknown[] = [];
  try {
    const agentDir = join(owned.cwd, "agent"); await mkdir(agentDir);
    const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    const model = { id: "owned", name: "Scripted settlement fixture", reasoning: false, input: ["text"], contextWindow: 1000000, maxTokens: 131072, cost };
    await writeFile(join(agentDir, "models.json"), JSON.stringify({ providers: { "owned-settle": { api: "openai-completions", baseUrl: "http://127.0.0.1:1/v1", apiKey: "synthetic-not-an-account", models: [model] } } }));
    const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json"), allowModelNetwork: false, refreshOnCreate: false });
    const settings = SettingsManager.inMemory({ cacheWarming: "off", compaction: { enabled: false } }); settings.setProjectTrusted(true);
    const candidate = (id: string) => ({ title: `Owned ${id}`, targetRef: id, operation: "Read owned artifact", preconditionHash: digest("owned") });
    const loader = new DefaultResourceLoader({ cwd: owned.cwd, agentDir, settingsManager: settings, noExtensions: true, disabledBuiltinExtensions: ["mcp"], noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, extensionFactories: [pi => {
      registerTeamTools(pi, (project, notify) => {
        runtime = new TeamSupervisor(project, notify, config => {
          const worker = idle(config); const adapter = workerDomainAdapter(project, false);
          const state = workerStateAdapter(config, adapter.invoke, adapter.assertQuiescent);
          return { ...worker, prompt: async prompt => {
            const board = await state(randomUUID(), { action: "read" }) as any;
            const task = board.candidates[0];
            const claim = await state(randomUUID(), { action: "claim", workItemId: task.id }) as any;
            const record = await state(randomUUID(), { action: "publish", kind: "RESULT", summary: "Owned local objective", preconditionHash: digest("owned"), evidenceRefs: ["evidence.txt"] }) as any;
            await state(randomUUID(), { action: "complete", recordId: record.record.id });
            return worker.prompt(prompt);
          } };
        });
        return runtime;
      });
      pi.on("project_trust", () => ({ trusted: "yes", remember: false }));
      pi.registerProvider("owned-settle", { api: "openai-completions", baseUrl: "http://127.0.0.1:1/v1", apiKey: "synthetic-not-an-account", models: [model as any], streamSimple(selected, context) {
        calls += 1;
        const serialized = JSON.stringify(context);
        if (serialized.includes("team_batch_completed")) sawBatch = true;
        let content: any[];
        if (!started) { started = true; content = [{ type: "toolCall", id: "owned-start", name: "rt_team", arguments: { action: "start", goal, scope: "Owned temporary files only", candidates: [candidate("first")], workerCount: 1, autoContinue: true, maxRounds: 5, maxParentTurns: 6, windowSeconds: 10 } }]; }
        else if (sawBatch && !offered) { offered = true; content = [{ type: "toolCall", id: "owned-offer", name: "rt_team", arguments: { action: "offer", candidate: candidate("second") } }]; }
        else if (!stoppedTeam && context.messages.some(message => Array.isArray(message.content) && message.content.some(part => part.type === "text" && part.text.includes('"event":"team_batch_completed"') && part.text.includes('"total":2')))) { stoppedTeam = true; content = [{ type: "toolCall", id: "owned-stop", name: "rt_team", arguments: { action: "stop" } }]; }
        else content = [{ type: "text", text: "Owned batch reviewed; lifecycle and overall objective are separate." }];
        const message: any = { role: "assistant", content, api: selected.api, provider: selected.provider, model: selected.id, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { ...cost, total: 0 } }, stopReason: content[0].type === "toolCall" ? "toolUse" : "stop", timestamp: Date.now() };
        const stream = createAssistantMessageEventStream(); stream.push({ type: "start", partial: message }); stream.push({ type: "done", reason: message.stopReason, message }); stream.end(); return stream;
      } });
    }] });
    await loader.reload();
    session = (await createAgentSession({ cwd: owned.cwd, agentDir, modelRuntime, model: modelRuntime.getModel("owned-settle", model.id), thinkingLevel: "off", settingsManager: settings, sessionManager: SessionManager.create(owned.cwd, join(owned.cwd, "sessions")), resourceLoader: loader, tools: ["rt_team"] })).session;
    await session.bindExtensions({ mode: "tui", uiContext: { confirm: async () => { confirmations += 1; throw new Error("Routine delegation must not ask for approval"); }, setStatus: () => {}, notify: () => {} } as any, onError: error => errors.push(error) });
    await session.prompt("Review the two owned files within the approved scope; report limitations rather than declare a whole engagement complete.");
    for (let attempt = 0; attempt < 400 && !stoppedTeam; attempt++) await delay(20);
    await session.waitForIdle();
    assert(sawBatch); assert(offered); assert(stoppedTeam); assert.equal(confirmations, 0); assert(calls < 12); assert.deepEqual(errors, []);
    assert.equal((await runtime!.status()).goalCompletionNotImplied, true);
    assert.equal((await runtime!.status()).state!.tasks.filter(task => task.status === "completed").length, 2);
    const history = await readFile(session.sessionManager.getSessionFile()!, "utf8");
    assert.doesNotMatch(history, /redteam-goal-review|team_goal_review_needed|declared-objectives-complete/); assert.equal(history.split('"role":"user"').length - 1, 1);
  } finally { await runtime?.stop(); session?.dispose(); await owned.cleanup(); }
});
