import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listBranches, nextSearchStep, recordFeedback, upsertBranch, type BranchInput } from "../src/thin/search.js";
import { reasonGraph } from "../src/thin/graph-reasoning.js";
import { projectKey, resolveWorkspace, type DomainProject } from "../src/thin/state.js";
import type { GraphLink } from "../src/thin/graph.js";

const candidate = (id: string, changes: Partial<BranchInput> = {}): BranchInput => ({ id, title: id, status: "active", remainingSteps: 2, promise: 0.5, evidence: [{ reference: "owned-observation", category: "plausible" }], ...changes });
async function workspace() {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "pi-paper-")));
  return { cwd, close: () => rm(cwd, { recursive: true, force: true }) };
}

test("TDA evidence rubric and same-agent intermediate decisions persist path snapshots", async () => {
  const root = await workspace();
  try {
    await upsertBranch(root, candidate("root", { kind: "observation", snapshot: { target: "owned-local", factRefs: ["observation.json"], credentialRefs: ["secret-reference-only"] } }));
    const first: any = await nextSearchStep(root, 0.5);
    assert.equal(first.mode, "decision-required");
    assert.equal(first.decisionRequired, true);
    assert.equal(first.selected.signals.evidence, 0.5);
    const decided: any = await nextSearchStep(root, 0.5, { mode: "advance", justification: "Owned evidence supports this local step" });
    assert.equal(decided.traversal, "depth-first-action");
    assert.equal(decided.automaticExecution, false);
    assert.deepEqual(decided.path[0].snapshot.credentialRefs, ["secret-reference-only"]);
    await upsertBranch(root, candidate("root", { evidence: [{ reference: "verified", category: "verified" }] }));
    assert.equal((await listBranches(root))[0]!.snapshot.target, "owned-local");
    assert.equal((await listBranches(root))[0]!.kind, "observation");
    await assert.rejects(upsertBranch(root, candidate("invalid", { evidence: [{ reference: "fake", category: "verified", confidence: 0.1 }] })), /rubric/);
    const unknown: any = await nextSearchStep(root, undefined);
    assert.equal(unknown.selected, null);
    assert(unknown.needsReview.length > 0);
    await assert.rejects(readFile(join(root.cwd, ".redteam", "project.json")), { code: "ENOENT" });
  } finally { await root.close(); }
});

test("EGATS suspension needs distinct high-difficulty attempts, suppresses subtree and preserves reactivation", async () => {
  const root = await workspace();
  try {
    await upsertBranch(root, candidate("easy", { remainingSteps: 0, evidence: [{ reference: "valid", category: "verified" }] }));
    await upsertBranch(root, candidate("hard", { remainingSteps: 100, evidence: [{ reference: "hypothesis", category: "speculative" }] }));
    await upsertBranch(root, candidate("child", { parentId: "hard", remainingSteps: 100, evidence: [{ reference: "child-hypothesis", category: "speculative" }] }));
    await recordFeedback(root, { id: "hard", outcome: "failure", note: "Owned unsuccessful attempt", reference: "attempt-1" });
    for (let index = 0; index < 4; index++) await nextSearchStep(root, 1);
    assert.equal((await listBranches(root)).find(entry => entry.id === "hard")!.assessments.length, 1);
    for (const reference of ["attempt-2", "attempt-3"]) {
      await recordFeedback(root, { id: "hard", outcome: "failure", note: "Owned unsuccessful attempt", reference });
      await nextSearchStep(root, 1);
    }
    assert.equal((await listBranches(root)).find(entry => entry.id === "hard")!.status, "suspended");
    const selected: any = await nextSearchStep(root, 1);
    assert.equal(selected.selected.id, "easy");
    await upsertBranch(root, candidate("hard", { remainingSteps: 100, evidence: [{ reference: "new-proof", category: "verified" }] }));
    await nextSearchStep(root, 1);
    assert.equal((await listBranches(root)).find(entry => entry.id === "hard")!.status, "active");
  } finally { await root.close(); }
});

test("successful feedback spawns a pivot atomically and legacy local state upgrades without project configuration", async () => {
  const root = await workspace();
  try {
    await upsertBranch(root, candidate("root"));
    await assert.rejects(recordFeedback(root, { id: "root", outcome: "failure", note: "failure cannot unlock a pivot", reference: "owned", pivot: candidate("pivot") }));
    assert.equal((await listBranches(root))[0]!.attempts, 0);
    await recordFeedback(root, { id: "root", outcome: "success", note: "Evidence-backed owned progress", reference: "owned-success", pivot: candidate("pivot", { snapshot: { target: "owned-new-target" } }) });
    assert.equal((await listBranches(root)).find(entry => entry.id === "pivot")!.parentId, "root");
    const path = join(root.cwd, ".redteam", "branches.json");
    const old = JSON.parse(await readFile(path, "utf8")); old.version = 1; old.projectKey = "retired-config-scope";
    await writeFile(path, JSON.stringify(old));
    await nextSearchStep(root, 0.5);
    const current = JSON.parse(await readFile(path, "utf8"));
    assert.equal(current.version, 4); assert.equal(current.projectKey, projectKey(root)); assert.equal(current.branches.length, 2);
    assert.equal(JSON.parse(await readFile(join(root.cwd, ".redteam", "branches.json.v1.backup.json"), "utf8")).version, 1);
  } finally { await root.close(); }
});

test("automatic workspace identity is concurrent-safe and separates containers with the same /workspace path", async () => {
  const first = await workspace(), second = await workspace();
  try {
    const copies: DomainProject[] = Array.from({ length: 8 }, () => ({ cwd: first.cwd }));
    await Promise.all(copies.map(resolveWorkspace));
    assert.equal(new Set(copies.map(entry => entry.workspaceId)).size, 1);
    const other: DomainProject = { cwd: second.cwd };
    await resolveWorkspace(other);
    assert.notEqual(projectKey({ cwd: "/workspace", workspaceId: copies[0]!.workspaceId }), projectKey({ cwd: "/workspace", workspaceId: other.workspaceId }));
    await assert.rejects(readFile(join(first.cwd, ".redteam", "project.json")), { code: "ENOENT" });
  } finally { await first.close(); await second.close(); }
});

test("ChainGraph five queries reproduce next steps, pathing, policy severity, provenance and directed betweenness", () => {
  const now = Date.now();
  const nodes: Record<string, { kind: NonNullable<GraphLink["sourceKind"]>; properties?: GraphLink["sourceProperties"] }> = {
    finding: { kind: "finding", properties: { status: "confirmed", cvss: 6.5 } }, step: { kind: "attack_step", properties: { risk: "high" } },
    identity: { kind: "identity" }, crown: { kind: "asset" }, objective: { kind: "objective" }, credential: { kind: "credential" },
  };
  const link = (source: string, target: string, relation: string): GraphLink => ({ id: `${source}-${target}`, source, target, relation, state: "observed", evidenceRefs: ["owned-receipt"], evidenceHashes: ["a".repeat(64)], evidenceVerified: true, observedAt: new Date(now).toISOString(), sourceKind: nodes[source]!.kind, targetKind: nodes[target]!.kind, sourceProperties: nodes[source]!.properties, targetProperties: nodes[target]!.properties });
  const graph = [link("finding", "step", "ENABLES"), link("step", "credential", "YIELDS"), link("credential", "identity", "AUTHENTICATES"), link("identity", "crown", "CAN_ACCESS"), link("objective", "crown", "TARGETS")];
  const next: any = reasonGraph(graph, "next", { sourceId: "finding" }, now);
  assert.deepEqual(next.steps[0].gains, ["credential"]);
  const chains: any = reasonGraph(graph, "chains", {}, now);
  assert.deepEqual(chains.chains[0].nodes, ["finding", "step", "credential", "identity", "crown"]);
  const severity: any = reasonGraph(graph, "severity", {}, now);
  assert.equal(severity.findings[0].score, 9.1); assert.equal(severity.findings[0].severity, "Critical"); assert.equal(severity.candidateOnly, true);
  const receipts: any = reasonGraph(graph, "evidence", {}, now);
  assert.equal(receipts.chains[0].receipts.length, 4); assert(receipts.chains[0].receipts.every((receipt: any) => receipt.verified));
  const cuts: any = reasonGraph(graph, "chokepoints", {}, now);
  assert(cuts.scores.find((entry: any) => entry.id === "credential").score > 0);
  assert.equal(cuts.scores.find((entry: any) => entry.id === "finding").score, 0);
  graph[0]!.sourceProperties = { status: "needs_review", cvss: 6.5 };
  assert.equal((reasonGraph(graph, "severity", {}, now) as any).findings.length, 0);
  graph[0]!.sourceProperties = { status: "confirmed", cvss: 6.5 }; graph[2]!.evidenceVerified = false;
  assert.equal((reasonGraph(graph, "severity", {}, now) as any).findings[0].score, null);
});
