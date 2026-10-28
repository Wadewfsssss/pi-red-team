import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ExtensionAPI, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { assessBranches, listBranches, recordFeedback, upsertBranch, type BranchInput } from "../src/thin/search.js";
import { candidatePaths, graphSnapshot, nativeCypher, recordLink, type GraphLink } from "../src/thin/graph.js";
import { projectKey, type DomainProject } from "../src/thin/state.js";
import { registerDomainTools } from "../src/thin/domain.js";
import { digest } from "../src/files.js";
import { randomUUID } from "node:crypto";

async function fixture() {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "thin-domain-")));
  const project: DomainProject = { cwd };
  await mkdir(join(cwd, ".redteam"));
  return { project, close: () => rm(cwd, { recursive: true, force: true }) };
}
const branch = (id: string, overrides: Partial<BranchInput> = {}): BranchInput => ({ id, title: id, status: "active", remainingSteps: 2, promise: 0.5, evidence: [{ reference: "fixture-evidence", confidence: 0.8 }], ...overrides });

test("search uses min-max horizon, Laplace success, path evidence and advisory UCB", async () => {
  const setup = await fixture();
  try {
    await upsertBranch(setup.project, branch("root", { remainingSteps: 1, evidence: [{ reference: "root", confidence: 1 }] }));
    await upsertBranch(setup.project, branch("child", { parentId: "root", remainingSteps: 5, evidence: [{ reference: "child", confidence: 0.3 }] }));
    await recordFeedback(setup.project, { id: "child", outcome: "failure", note: "Missing prerequisite, not proof of absence", reference: "fixture-output" });
    const branches = await listBranches(setup.project);
    assert.equal(branches.find(entry => entry.id === "root")!.attempts, 1);
    assert.equal(branches.find(entry => entry.id === "root")!.promise, 0.38);
    const assessment = assessBranches(branches, 0.5);
    const child = assessment.find(entry => entry.id === "child")!;
    assert.equal(child.signals.horizon, 1);
    assert.equal(child.signals.evidence, 0.65);
    assert.equal(child.signals.successRate, 1 / 3);
    assert(Math.abs(child.tdi! - (0.3 + 0.3 * 0.35 + 0.1 + 0.2 * (2 / 3))) < 1e-12);
    assert.equal(child.suggestedMode, "explore");
    assert.equal(child.suspendCandidate, false);
    assert.equal(assessBranches(branches, undefined)[0]!.tdi, null);
    assert.equal(assessBranches(branches, undefined)[0]!.suggestedMode, "inspect-context");
    assert.throws(() => assessBranches(branches, 2));
  } finally { await setup.close(); }
});

test("search preserves concurrent feedback, restart and explicit suspension without deleting branches", async () => {
  const setup = await fixture();
  try {
    await upsertBranch(setup.project, branch("root", { remainingSteps: 1 }));
    await upsertBranch(setup.project, branch("hard", { remainingSteps: 9, evidence: [{ reference: "hypothesis", category: "speculative" }] }));
    await Promise.all(Array.from({ length: 5 }, (_, index) => recordFeedback(setup.project, { id: "hard", outcome: "failure", note: `failure-${index}`, reference: `output-${index}` })));
    const snapshot = await listBranches({ ...setup.project });
    assert.equal(snapshot.find(entry => entry.id === "hard")!.attempts, 5);
    assert(assessBranches(snapshot, 1).find(entry => entry.id === "hard")!.suspendCandidate);
    assert.equal((await listBranches(setup.project)).length, 2);
    await upsertBranch(setup.project, branch("hard", { status: "suspended" }));
    assert(!assessBranches(await listBranches(setup.project), 0).some(entry => entry.id === "hard"));
    await upsertBranch(setup.project, branch("hard", { status: "active", evidence: [{ reference: "new-evidence", confidence: 1 }] }));
    assert.equal((await listBranches(setup.project)).find(entry => entry.id === "hard")!.attempts, 5);
    assert(assessBranches(await listBranches(setup.project), 0).some(entry => entry.id === "hard"));
  } finally { await setup.close(); }
});

test("search rejects cycles, scope changes, symlinks and aborted mutations", async () => {
  const setup = await fixture();
  try {
    await assert.rejects(upsertBranch(setup.project, branch("bad", { parentId: "bad" })));
    await upsertBranch(setup.project, branch("root"));
    await upsertBranch(setup.project, branch("child", { parentId: "root" }));
    await assert.rejects(upsertBranch(setup.project, branch("root", { parentId: "child" })));
    const statePath = join(setup.project.cwd, ".redteam", "branches.json");
    const persisted = JSON.parse(await readFile(statePath, "utf8"));
    const originalKey = persisted.projectKey;
    persisted.projectKey = "another-directory";
    await writeFile(statePath, JSON.stringify(persisted));
    await assert.rejects(listBranches(setup.project), /different working directory/);
    persisted.projectKey = originalKey;
    await writeFile(statePath, JSON.stringify(persisted));
    const controller = new AbortController(); controller.abort();
    await assert.rejects(upsertBranch(setup.project, branch("aborted"), controller.signal));
    assert.equal((await listBranches(setup.project)).length, 2);
    await rm(join(setup.project.cwd, ".redteam", "branches.json"));
    await symlink(join(setup.project.cwd, "outside.json"), join(setup.project.cwd, ".redteam", "branches.json"));
    await assert.rejects(upsertBranch(setup.project, branch("unsafe")), /Symlink/);
  } finally { await setup.close(); }
});

test("graph paths exclude refutations and cycles, and label stale or unsupported evidence", () => {
  const now = Date.now();
  const link = (id: string, source: string, target: string, overrides: Partial<GraphLink> = {}): GraphLink => ({ id, source, target, relation: "related", state: "observed", evidenceRefs: ["evidence"], evidenceVerified: true, observedAt: new Date(now).toISOString(), ...overrides });
  const graph = [link("first", "source", "middle"), link("second", "middle", "goal", { state: "hypothesis", observedAt: new Date(now - 100000).toISOString() }), link("back", "middle", "source"), link("refuted", "source", "goal", { state: "refuted" })];
  const result = candidatePaths(graph, "source", "goal", now, 10);
  assert.equal(result.paths.length, 1);
  assert.deepEqual(result.paths[0]!.nodes, ["source", "middle", "goal"]);
  assert.deepEqual(result.paths[0]!.unverified, ["second"]);
  assert.deepEqual(result.paths[0]!.staleEvidence, ["second"]);
  assert.match(result.paths[0]!.verdict, /candidate-only/);
  assert.equal(candidatePaths(graph, "goal", "source").paths.length, 0);
});

test("graph writes use native nested MCP, verified file hashes and escaped values", async () => {
  const setup = await fixture();
  try {
    await writeFile(join(setup.project.cwd, "evidence.txt"), "actual local observation");
    const calls: any[] = [];
    const ctx = { tools: [{ name: "mcp__fixture__write_cypher" }], executeTool: async (name: string, args: unknown, options: unknown) => { calls.push({ name, args, options }); return { isError: false, result: { content: [{ type: "text", text: '[{"id":"link"}]' }] } }; } } as unknown as ExtensionToolContext;
    const input = { source: { id: "source", kind: "asset" as const, name: 'quote" injected' }, target: { id: "goal", kind: "identity" as const, name: "credential-reference-only" }, link: { id: "link", source: "source", target: "goal", relation: "reference", state: "observed" as const, evidenceRefs: ["evidence.txt"], observedAt: new Date().toISOString() } };
    const result = await recordLink(setup.project, ctx, "fixture", input);
    assert.equal(result.persisted, true);
    assert.equal(result.evidence[0]!.sha256, digest("actual local observation"));
    assert(calls[0].args.query.includes(JSON.stringify('quote" injected')));
    assert(calls[0].args.query.includes(projectKey(setup.project)));
    await assert.rejects(recordLink(setup.project, ctx, "fixture", { ...input, link: { ...input.link, evidenceRefs: [] } }), /require evidence/);
    await assert.rejects(recordLink(setup.project, ctx, "fixture", { ...input, link: { ...input.link, evidenceRefs: ["../escape"] } }));
    assert.equal(calls.length, 1);
  } finally { await setup.close(); }
});

test("graph snapshot rechecks evidence hashes and rejects disconnected or malformed MCP", async () => {
  const setup = await fixture();
  try {
    await writeFile(join(setup.project.cwd, "evidence.txt"), "original");
    const rows = [{ id: "link", source: "source", target: "goal", relation: "related", state: "observed", evidenceRefs: ["evidence.txt"], evidenceHashes: [digest("original")], observedAt: new Date().toISOString() }];
    const ctx = { tools: [{ name: "mcp__fixture__read_cypher" }], executeTool: async () => ({ isError: false, result: { content: [{ type: "text", text: JSON.stringify(rows) }] } }) } as unknown as ExtensionToolContext;
    assert.equal((await graphSnapshot(setup.project, ctx, "fixture"))[0]!.evidenceVerified, true);
    await writeFile(join(setup.project.cwd, "evidence.txt"), "changed");
    const changed = await graphSnapshot(setup.project, ctx, "fixture");
    assert.equal(changed[0]!.evidenceVerified, false);
    assert.deepEqual(candidatePaths(changed, "source", "goal").paths[0]!.unverified, ["link"]);
    await assert.rejects(nativeCypher({ ...ctx, tools: [] }, "fixture", false, "RETURN 1"), /inspect Pi/);
    await assert.rejects(nativeCypher({ ...ctx, executeTool: async () => ({ isError: true, result: { content: [] } }) } as unknown as ExtensionToolContext, "fixture", false, "RETURN 1"), /not verified/);
  } finally { await setup.close(); }
});

test("domain tools work without project configuration and retain native trust", async () => {
  const setup = await fixture();
  try {
    const tools = new Map<string, any>();
    registerDomainTools({ registerTool: (tool: any) => tools.set(tool.name, tool) } as unknown as ExtensionAPI);
    const ctx = { cwd: setup.project.cwd, isProjectTrusted: () => true, getContextUsage: () => ({ percent: null }) };
    assert.equal(tools.size, 4);
    await tools.get("rt_search").execute("call", { action: "upsert", branch: branch("root") }, undefined, undefined, ctx);
    const recommendation = await tools.get("rt_search").execute("call", { action: "recommend" }, undefined, undefined, ctx);
    assert.equal(recommendation.structuredContent.candidates[0].tdi, null);
    await tools.get("rt_search").execute("call", { action: "upsert", branch: branch("next") }, undefined, undefined, ctx);
    assert.equal((await tools.get("rt_job").execute("call", { action: "list" }, undefined, undefined, ctx)).structuredContent.jobs.length, 0);
    await assert.rejects(readFile(join(setup.project.cwd, ".redteam", "project.json")), { code: "ENOENT" });
    await assert.rejects(tools.get("rt_search").execute("call", { action: "list" }, undefined, undefined, { ...ctx, isProjectTrusted: () => false }), /trusted/);
  } finally { await setup.close(); }
});

test("invalid project configuration does not disable safe job inspection or hide failed launches", async () => {
  const setup = await fixture();
  try {
    const tools = new Map<string, any>();
    registerDomainTools({ registerTool: (tool: any) => tools.set(tool.name, tool) } as unknown as ExtensionAPI);
    const ctx = { cwd: setup.project.cwd, isProjectTrusted: () => true };
    const id = randomUUID();
    await mkdir(join(setup.project.cwd, ".redteam", "jobs", id), { recursive: true });
    await writeFile(join(setup.project.cwd, ".redteam", "project.json"), "{broken");
    const listed = await tools.get("rt_job").execute("call", { action: "list" }, undefined, undefined, ctx);
    assert.equal(listed.structuredContent.configurationStatus, undefined);
    assert.equal(listed.structuredContent.jobs[0].id, id);
    assert.equal(listed.structuredContent.jobs[0].phase, "unavailable");
    await assert.rejects(tools.get("rt_job").execute("call", { action: "cancel", id }, undefined, undefined, ctx), { code: "ENOENT" });
    await assert.rejects(tools.get("rt_job").execute("call", { action: "list" }, undefined, undefined, { ...ctx, isProjectTrusted: () => false }), /trusted/);
  } finally { await setup.close(); }
});

test("large domain results keep structured data but bound model-facing text", async () => {
  const setup = await fixture();
  try {
    const tools = new Map<string, any>();
    registerDomainTools({ registerTool: (tool: any) => tools.set(tool.name, tool) } as unknown as ExtensionAPI);
    const ctx = { cwd: setup.project.cwd, isProjectTrusted: () => true };
    for (const id of ["first", "second"]) await upsertBranch(setup.project, branch(id, { evidence: Array.from({ length: 100 }, () => ({ reference: "x".repeat(500), confidence: 0.5 })) }));
    const result = await tools.get("rt_search").execute("call", { action: "list" }, undefined, undefined, ctx);
    assert.match(result.content[0].text, /Result text truncated/);
    assert(Buffer.byteLength(result.content[0].text) < 66000);
    assert.equal(result.structuredContent.branches.length, 2);
    assert.equal(result.structuredContent.branches[0].evidence.length, 100);
  } finally { await setup.close(); }
});
