import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, writeFile, rm, realpath, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "redteam-zod";
import { digest } from "../src/files.js";
import { mutateState, readState } from "../src/thin/state.js";
import { claimWork, completeWork, createTeam, offerWork, pauseTeam, publishRecord, readRecords, readTeam, releaseWork, renewWork, unfoldRecord } from "../src/thin/team/store.js";

const execute = promisify(execFile);
const preconditionHash = digest("owned target state v1");
async function fixture() {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "team-store-")));
  return { cwd, cleanup: () => rm(cwd, { recursive: true, force: true }) };
}
async function ownedClaim(project: { cwd: string }, now = Date.now()) {
  const team = await createTeam(project, { goal: "Owned local protocol goal" }, now);
  const offered = await offerWork(project, team.runId, { title: "Inspect an owned fixture", targetRef: "owned-fixture", operation: "inspect", preconditionHash }, now);
  const claimed = await claimWork(project, { runId: team.runId, workerId: team.workers[0]!, workItemId: offered.task.id, requestId: randomUUID() }, now);
  assert(claimed.lease);
  return { team, task: offered.task, lease: claimed.lease };
}

test("team status does not create configuration or state before an explicit run", async () => {
  const owned = await fixture();
  try { assert.equal(await readTeam(owned), undefined); await assert.rejects(stat(join(owned.cwd, ".redteam")), { code: "ENOENT" }); }
  finally { await owned.cleanup(); }
});

test("async domain mutations commit only after final mutation and roll back on failure", async () => {
  const owned = await fixture();
  const schema = z.object({ counter: z.number() });
  try {
    await mutateState(owned, "async-test.json", schema, () => ({ counter: 0 }), async state => { await Promise.resolve(); state.counter += 1; return state.counter; });
    assert.equal((await readState(owned, "async-test.json", schema, () => ({ counter: 0 }))).counter, 1);
    await assert.rejects(mutateState(owned, "async-test.json", schema, () => ({ counter: 0 }), async state => { state.counter += 1; await Promise.resolve(); throw new Error("Expected fixture failure"); }), /Expected/);
    assert.equal((await readState(owned, "async-test.json", schema, () => ({ counter: 0 }))).counter, 1);
  } finally { await owned.cleanup(); }
});

test("two processes cannot claim the same work and repeated claim preserves its lease", { timeout: 15000 }, async () => {
  const owned = await fixture();
  try {
    const team = await createTeam(owned, { goal: "Owned concurrent claim fixture" });
    const first = await offerWork(owned, team.runId, { title: "First label", targetRef: "owned", operation: "inspect", preconditionHash });
    const repeated = await offerWork(owned, team.runId, { title: "Different label", targetRef: "owned", operation: "inspect", preconditionHash });
    assert.equal(repeated.created, false);
    assert.equal(first.task.id, repeated.task.id);
    const claims = team.workers.map(workerId => ({ runId: team.runId, workerId, workItemId: first.task.id, requestId: randomUUID() }));
    const results = await Promise.all(claims.map(async claim => JSON.parse((await execute(process.execPath, ["--import", import.meta.resolve("tsx"), resolve("tests/fixtures/team-claim.mjs"), JSON.stringify({ cwd: owned.cwd, claim })], { timeout: 10000 })).stdout)));
    assert.equal(results.filter(result => result.claimed).length, 1);
    const winner = results.findIndex(result => result.claimed);
    const retried = await claimWork(owned, claims[winner]!);
    assert.deepEqual(retried.lease, results[winner].lease);
  } finally { await owned.cleanup(); }
});

test("expired claims remain uncertain and pause fences old worker publications", async () => {
  const owned = await fixture();
  const now = Date.now();
  try {
    const { team, task, lease } = await ownedClaim(owned, now);
    const expired = await claimWork(owned, { runId: team.runId, workerId: team.workers[1]!, workItemId: task.id, requestId: randomUUID() }, now + 120001);
    assert.equal(expired.claimed, false);
    assert.equal((await readTeam(owned))!.tasks[0]!.status, "uncertain");
    await assert.rejects(renewWork(owned, lease, now + 120001), /stale/);
    const paused = await pauseTeam(owned, team.runId);
    assert.equal(paused.runtimeStopVerified, false);
    await assert.rejects(publishRecord(owned, lease, { requestId: randomUUID(), kind: "HYPOTHESIS", summary: "Late fixture publication", preconditionHash, evidenceRefs: [] }, now + 120002), /inactive/);
  } finally { await owned.cleanup(); }
});

test("reassignment rejects the old lease and result completion is evidence-linked and idempotent", async () => {
  const owned = await fixture();
  try {
    const { team, task, lease } = await ownedClaim(owned);
    await releaseWork(owned, lease);
    const next = await claimWork(owned, { runId: team.runId, workerId: team.workers[1]!, workItemId: task.id, requestId: randomUUID() });
    assert(next.lease);
    assert(next.lease.leaseVersion > lease.leaseVersion);
    await assert.rejects(renewWork(owned, lease), /stale/);
    await writeFile(join(owned.cwd, "owned-evidence.txt"), "Owned non-offensive evidence");
    const publication = { requestId: randomUUID(), kind: "RESULT" as const, summary: "Owned fixture inspected", preconditionHash, evidenceRefs: ["owned-evidence.txt"] };
    const first = await publishRecord(owned, next.lease, publication);
    const repeated = await publishRecord(owned, next.lease, publication);
    assert.equal(first.record.id, repeated.record.id);
    assert.equal(repeated.repeated, true);
    await assert.rejects(publishRecord(owned, next.lease, { ...publication, summary: "Different content" }), /reused/);
    const before = (await readTeam(owned))!.revision;
    const read = await readRecords(owned, team.runId);
    assert.equal(read.records.length, 1);
    assert.equal(read.cursorAdvanced, false);
    assert.equal((await readTeam(owned))!.revision, before);
    const detail = JSON.parse(await readFile(join(owned.cwd, first.record.path), "utf8"));
    assert.equal(detail.evidence[0].sha256, digest("Owned non-offensive evidence"));
    assert.equal(detail.conclusionVerified, false);
    assert.equal((await unfoldRecord(owned, team.runId, first.record.id)).evidenceVerified, true);
    await writeFile(join(owned.cwd, "owned-evidence.txt"), "Changed fixture data");
    assert.equal((await unfoldRecord(owned, team.runId, first.record.id)).evidenceVerified, false);
    await assert.rejects(completeWork(owned, next.lease, first.record.id), /unchanged available evidence/);
    await writeFile(join(owned.cwd, "owned-evidence.txt"), "Owned non-offensive evidence");
    const completed = await completeWork(owned, next.lease, first.record.id);
    assert.equal(completed.completed, true);
    assert.equal(completed.conclusionVerified, false);
    assert.equal((await readTeam(owned))!.records.length, 1);
  } finally { await owned.cleanup(); }
});

test("publication rejects missing evidence, altered preconditions and oversized UTF-8 summaries", async () => {
  const owned = await fixture();
  try {
    const { lease } = await ownedClaim(owned);
    const publication = { requestId: randomUUID(), kind: "FAIL" as const, summary: "Owned negative observation", preconditionHash, evidenceRefs: [] };
    await assert.rejects(publishRecord(owned, lease, publication), /require evidence/);
    await assert.rejects(publishRecord(owned, lease, { ...publication, kind: "HYPOTHESIS", preconditionHash: digest("different state") }), /preconditions/);
    await assert.rejects(publishRecord(owned, lease, { ...publication, kind: "HYPOTHESIS", summary: "界".repeat(171) }), /512/);
    assert.equal((await readTeam(owned))!.records.length, 0);
  } finally { await owned.cleanup(); }
});
