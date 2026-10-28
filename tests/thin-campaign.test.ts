import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, realpath, writeFile, readFile, rm, stat, symlink, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { campaignAction, campaignSummary, readCampaign, campaignPrompt, testingProfiles } from "../src/thin/campaign.js";
import { methodologyRules } from "../src/thin/methodology.js";
import { listBranches, upsertBranch, recordFeedback, nextSearchStep, assessBranches } from "../src/thin/search.js";
import { createTeam, offerWork, claimWork, finishTeam } from "../src/thin/team/store.js";
import { workerDomainAdapter, workerDomainSchemas } from "../src/thin/team/domain-adapter.js";
import { TeamSupervisor, type TeamWorker } from "../src/thin/team/runtime.js";
import { SdkWorker } from "../src/thin/team/sdk-worker.js";
import { workerStateAdapter } from "../src/thin/team/worker-state.js";
import type { WorkerConfig, WorkerView } from "../src/thin/team/protocol.js";
import { digest } from "../src/files.js";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { registerTeamTools } from "../src/thin/team/extension.js";

const parent = { id: "parent:owned-session" };
const goal = "Assess owned local fixtures and report limitations";
async function fixture() {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "thin-coverage-")));
  await writeFile(join(cwd, "evidence.txt"), "Owned observation, no network or account");
  const project = { cwd };
  const act = (input: Parameters<typeof campaignAction>[1], actor: { id: string; targetRef?: string } = parent) => campaignAction(project, input, actor);
  return { project, cwd, act, cleanup: () => rm(cwd, { recursive: true, force: true }) };
}
async function register(owned: Awaited<ReturnType<typeof fixture>>, id = "owned") {
  await owned.act({ action: "target", target: { id, targetRef: id, category: "web" } });
}

test("optional coverage reads do not initialize state or require task configuration", async () => {
  const owned = await fixture();
  try {
    const summary = await campaignSummary(owned.project);
    assert.equal(summary.goalCompletionEvaluated, false);
    assert.equal(campaignPrompt(summary), "");
    assert.deepEqual((await owned.act({ action: "status" }) as any).targets, []);
    await assert.rejects(stat(join(owned.cwd, ".redteam")), { code: "ENOENT" });
    assert.match(methodologyRules.join("\n"), /No target inventory/);
    assert.match(methodologyRules.join("\n"), /snapshot.notes/);
  } finally { await owned.cleanup(); }
});

test("old goal, objective and independent hypothesis-controller actions are rejected", async () => {
  const owned = await fixture();
  try {
    for (const action of ["configure", "objective", "hypothesis", "feedback", "review"]) await assert.rejects(owned.act({ action } as any));
    await assert.rejects(owned.act({ action: "target", target: { id: "owned", targetRef: "owned", category: "web", objectiveInventoryComplete: true } } as any));
    await assert.rejects(stat(join(owned.cwd, ".redteam")), { code: "ENOENT" });
  } finally { await owned.cleanup(); }
});

test("all suggested coverage is still advisory, not whole-task success or proof of absence", async () => {
  const owned = await fixture();
  try {
    await register(owned);
    await assert.rejects(owned.act({ action: "coverage", targetId: "owned", surface: "Control", status: "examined", observation: "No artifact" }), /requires observation evidence/);
    for (const surface of testingProfiles.web) await owned.act({ action: "coverage", targetId: "owned", surface, status: "examined", observation: "Owned observation, not a negative vulnerability finding", evidenceRefs: ["evidence.txt"] });
    const summary = await campaignSummary(owned.project);
    assert.equal(summary.goalCompletionEvaluated, false); assert.equal(summary.advisory, true);
    assert.deepEqual(summary.targets[0]!.suggestedUnexaminedSurfaces, []);
    assert.doesNotMatch(JSON.stringify(summary), /goalStatus|inventoryDeclaredComplete|registered-objectives-complete/);
    assert.match(campaignPrompt(summary), /not mandatory work or proof of completion/);
    await writeFile(join(owned.cwd, "evidence.txt"), "Changed owned observation");
    assert.equal((await owned.act({ action: "status", targetId: "owned" }) as any).coverage[0].artifactIntegrityVerified, false);
    assert.equal((await campaignSummary(owned.project)).targets[0]!.suggestedUnexaminedSurfaces.length, 4);
  } finally { await owned.cleanup(); }
});

test("coverage is paged and asset identity cannot silently change", async () => {
  const owned = await fixture();
  try {
    for (let index = 0; index < 15; index++) await register(owned, "asset-" + index);
    const first = await owned.act({ action: "status" }) as any;
    assert.equal(first.targets.length, 12); assert.equal(first.next, "asset-11");
    assert.equal((await owned.act({ action: "status", after: first.next }) as any).targets.length, 3);
    await assert.rejects(owned.act({ action: "status", after: "missing" }), /cursor/);
    await assert.rejects(owned.act({ action: "target", target: { id: "asset-0", targetRef: "different", category: "web" } }), /silently rewritten/);
    assert.equal((await campaignSummary(owned.project)).targets.length, 6);
  } finally { await owned.cleanup(); }
});

test("legacy completeness and hypothesis state is ignored on read and archived on first write", async () => {
  const owned = await fixture();
  try {
    await register(owned);
    const path = join(owned.cwd, ".redteam/campaign.json");
    const state = JSON.parse(await readFile(path, "utf8"));
    state.version = 1; state.goal = "Old engagement"; state.inventoryDeclaredComplete = true;
    state.targets[0].objectiveInventoryComplete = true;
    state.targets[0].objectives = [{ id: "old", status: "completed", criterion: "Old caller assertion", evidence: [], note: "" }];
    state.targets[0].hypotheses = [{ id: "old", inconclusive: 2 }];
    await writeFile(path, JSON.stringify(state));
    const before = await readFile(path, "utf8");
    assert.doesNotMatch(JSON.stringify(await campaignSummary(owned.project)), /Old engagement|objectives|inconclusive/);
    assert.equal(await readFile(path, "utf8"), before);
    await assert.rejects(stat(join(owned.cwd, ".redteam/campaign.v1.archive.json")), { code: "ENOENT" });
    await owned.act({ action: "target", target: { id: "owned", targetRef: "owned", category: "web", nextStep: "Consider current instructions" } });
    assert.deepEqual(JSON.parse(await readFile(join(owned.cwd, ".redteam/campaign.v1.archive.json"), "utf8")), state);
    const current = await readCampaign(owned.project);
    assert.equal(current!.version, 2); assert.equal((current as any).goal, undefined);
    assert.equal((current!.targets[0] as any).hypotheses, undefined);
  } finally { await owned.cleanup(); }
});

test("coverage cannot change TDA scores, feedback history or suspended branch state", async () => {
  const owned = await fixture();
  try {
    await upsertBranch(owned.project, { id: "path", title: "Competing local explanations", role: "target", status: "active", remainingSteps: 3, promise: 0.5, evidence: [{ reference: "evidence.txt", category: "plausible" }], snapshot: { notes: "Observed error; competing explanations A/B; falsifier: owned control; cheap check: compare inputs" } });
    await recordFeedback(owned.project, { id: "path", outcome: "failure", reference: "evidence.txt", note: "No discriminating result; not absence of a vulnerability", requestId: randomUUID() });
    const branches = await listBranches(owned.project); const score = assessBranches(branches, 0.2);
    await register(owned);
    for (const surface of testingProfiles.web) await owned.act({ action: "coverage", targetId: "owned", surface, status: "not-applicable", observation: "Caller note only" });
    assert.deepEqual(await listBranches(owned.project), branches); assert.deepEqual(assessBranches(await listBranches(owned.project), 0.2), score);
    const current = branches[0]!;
    await upsertBranch(owned.project, { id: current.id, title: current.title, role: current.role, remainingSteps: current.remainingSteps, promise: current.promise, evidence: current.evidence, snapshot: current.snapshot, status: "suspended" });
    const next = await nextSearchStep(owned.project, 0.2);
    assert.equal(next.selected, null); assert.equal(next.goalCompletionEvaluated, false); assert.equal(next.taskSuccess, "not-evaluated");
    assert.equal((await listBranches(owned.project))[0]!.attempts, 1);
    assert.equal((await listBranches(owned.project))[0]!.status, "suspended");
  } finally { await owned.cleanup(); }
});

test("legacy archive conflicts and aborted writes preserve the original record", async () => {
  const owned = await fixture();
  try {
    await register(owned);
    const path = join(owned.cwd, ".redteam/campaign.json");
    const state = JSON.parse(await readFile(path, "utf8")); state.version = 1; state.goal = "Old instruction";
    await writeFile(path, JSON.stringify(state));
    const original = await readFile(path, "utf8");
    const archive = join(owned.cwd, ".redteam/campaign.v1.archive.json"); await writeFile(archive, JSON.stringify({ protectedHistory: true }));
    await assert.rejects(register(owned, "new"), /archive conflicts/);
    assert.equal(await readFile(path, "utf8"), original);
    assert.deepEqual(JSON.parse(await readFile(archive, "utf8")), { protectedHistory: true });
    await rm(archive);
    const controller = new AbortController(); controller.abort();
    await assert.rejects(campaignAction(owned.project, { action: "target", target: { id: "new", targetRef: "new", category: "web" } }, parent, controller.signal));
    assert.equal(await readFile(path, "utf8"), original);
    await assert.rejects(stat(archive), { code: "ENOENT" });
  } finally { await owned.cleanup(); }
});

test("coverage capacity errors preserve old notes rather than silently dropping them", async () => {
  const owned = await fixture();
  try {
    await register(owned);
    const path = join(owned.cwd, ".redteam/campaign.json");
    const state = JSON.parse(await readFile(path, "utf8"));
    state.targets[0].coverage = Array.from({ length: 64 }, (_, index) => ({ surface: "surface-" + index, status: "unexamined", observation: "Owned note", evidence: [] }));
    await writeFile(path, JSON.stringify(state)); const original = await readFile(path, "utf8");
    await assert.rejects(owned.act({ action: "coverage", targetId: "owned", surface: "overflow", status: "unexamined", observation: "Owned note" }));
    assert.equal(await readFile(path, "utf8"), original);
  } finally { await owned.cleanup(); }
});

test("workers can keep optional notes only within their active claim", async () => {
  const owned = await fixture();
  try {
    await register(owned, "peer");
    const run = await createTeam(owned.project, { goal, workerCount: 1 });
    const offered = await offerWork(owned.project, run.runId, { title: "Owned coverage", targetRef: "owned", operation: "Read owned files", preconditionHash: digest("owned") });
    const claim = await claimWork(owned.project, { runId: run.runId, workerId: run.workers[0]!, workItemId: offered.task.id, requestId: randomUUID() });
    const adapter = workerDomainAdapter(owned.project, false);
    const invoke = (params: Record<string, unknown>) => adapter.invoke(claim.lease!, randomUUID(), { action: "domain", tool: "rt_campaign", params });
    await invoke({ action: "target", target: { id: "owned", targetRef: "owned", category: "web" } });
    assert.equal((await invoke({ action: "status" }) as any).targets.length, 1);
    await assert.rejects(invoke({ action: "target", target: { id: "peer", targetRef: "peer", category: "web" } }), /current claim/);
    await assert.rejects(invoke({ action: "coverage", targetId: "peer", surface: "Control", status: "examined", observation: "Not owned", evidenceRefs: ["evidence.txt"] }), /coverage notes/);
    await finishTeam(owned.project, run.runId, "paused");
    await assert.rejects(invoke({ action: "status" }), /inactive/);
  } finally { await owned.cleanup(); }
});

test("unsafe evidence and mismatched workspace identity are still rejected", async () => {
  const owned = await fixture();
  try {
    await register(owned); await symlink(join(owned.cwd, "evidence.txt"), join(owned.cwd, "linked.txt"));
    await assert.rejects(owned.act({ action: "coverage", targetId: "owned", surface: "Control", status: "examined", observation: "Symlink", evidenceRefs: ["linked.txt"] }), /Symlink/);
    const path = join(owned.cwd, ".redteam/campaign.json"); const state = JSON.parse(await readFile(path, "utf8")); state.workspaceKey = "other";
    await writeFile(path, JSON.stringify(state)); await assert.rejects(campaignSummary(owned.project), /another workspace/);
  } finally { await owned.cleanup(); }
});

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
    await register(owned);
    const input = { goal, scope: "Owned files only", candidates: [{ title: "Owned inspection", targetRef: "owned", operation: "Read owned files", preconditionHash: digest("owned") }], workerCount: 1, autoContinue: true, maxRounds: 8, maxParentTurns: 2, windowSeconds: 10 };
    await runtime.start(input, model, "owned-session"); const before = await stopped(runtime);
    assert.equal(prompts, 2); assert.equal(before.checkpoint!.workers[0]!.noProgress, 2);
    assert.equal(before.coverageNotes.goalCompletionEvaluated, false);
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

test("actual offline Pi child exposes campaign tool and records claim-scoped coverage", { timeout: 20000 }, async () => {
  const owned = await fixture(); let worker: SdkWorker | undefined;
  try {
    await register(owned, "owned");
    const agentDir = join(owned.cwd, "agent"); await mkdir(agentDir);
    const model = { id: "owned-model", name: "Scripted fixture only", reasoning: false, input: ["text"], contextWindow: 1000000, maxTokens: 131072, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
    await writeFile(join(agentDir, "models.json"), JSON.stringify({ providers: { "team-scripted": { baseUrl: "http://127.0.0.1:1/v1", apiKey: "synthetic-no-account", api: "openai-completions", models: [model] } } }));
    const run = await createTeam(owned.project, { goal, workerCount: 1 });
    const offered = await offerWork(owned.project, run.runId, { title: "Owned coverage", targetRef: "owned", operation: "Read local fixture", preconditionHash: digest("owned") });
    const adapter = workerDomainAdapter(owned.project, false);
    worker = new SdkWorker({ version: 1, workerId: run.workers[0]!, cwd: owned.cwd, agentDir, provider: "team-scripted", model: model.id, thinkingLevel: "off", providerExtensions: [await realpath(resolve("tests/fixtures/team-provider.mjs"))], parentTimeoutMs: 15000, execution: false, teamRunId: run.runId, domainTools: workerDomainSchemas() }, adapter.invoke, adapter.assertQuiescent);
    const ready = await worker.start();
    assert(ready.tools.includes("rt_campaign"));
    const result = await worker.prompt(`owned-campaign-action:${JSON.stringify({ claim: offered.task.id, params: { action: "coverage", targetId: "owned", surface: "Authentication and session behavior", status: "examined", observation: "Read owned local control artifact only", evidenceRefs: ["evidence.txt"] } })}`);
    assert.equal(result.kind, "result");
    if (result.kind !== "result") return;
    assert.match(result.text, /Owned campaign fixture finished/);
    assert.equal((await readCampaign(owned.project))!.targets[0]!.coverage.length, 1);
    const history = await readFile(result.view.sessionPath!, "utf8");
    assert.match(history, /"toolName":"rt_campaign"/);
  } finally { await worker?.stop(); await owned.cleanup(); }
});

test("actual native Pi uses worker-result handoffs, never a coverage-completeness wakeup", { timeout: 15000 }, async () => {
  const owned = await fixture(); let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  let runtime: TeamSupervisor | undefined; let calls = 0; let confirmations = 0; let started = false; let offered = false; let stoppedTeam = false; let sawBatch = false;
  const errors: unknown[] = [];
  try {
    await register(owned, "first"); await register(owned, "second");
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
            await adapter.invoke(claim.lease, randomUUID(), { action: "domain", tool: "rt_campaign", params: { action: "coverage", targetId: task.targetRef, surface: "Local control", status: "examined", observation: "Owned fixture read", evidenceRefs: ["evidence.txt"] } });
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
    await session.bindExtensions({ mode: "tui", uiContext: { confirm: async () => { confirmations += 1; return true; }, setStatus: () => {}, notify: () => {} } as any, onError: error => errors.push(error) });
    await session.prompt("Review the two owned files within the approved scope; report limitations rather than declare a whole engagement complete.");
    for (let attempt = 0; attempt < 400 && !stoppedTeam; attempt++) await delay(20);
    await session.waitForIdle();
    assert(sawBatch); assert(offered); assert(stoppedTeam); assert.equal(confirmations, 1); assert(calls < 12); assert.deepEqual(errors, []);
    assert.equal((await runtime!.status()).coverageNotes.goalCompletionEvaluated, false);
    assert.equal((await runtime!.status()).state!.tasks.filter(task => task.status === "completed").length, 2);
    const history = await readFile(session.sessionManager.getSessionFile()!, "utf8");
    assert.doesNotMatch(history, /redteam-goal-review|team_goal_review_needed|declared-objectives-complete/); assert.equal(history.split('"role":"user"').length - 1, 1);
  } finally { await runtime?.stop(); session?.dispose(); await owned.cleanup(); }
});
