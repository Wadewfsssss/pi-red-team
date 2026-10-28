import { mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { z } from "redteam-zod";
import { atomicWrite, digest } from "../../files.js";
import { readBoundedFile } from "../project.js";
import { evidenceReferences } from "../graph.js";
import { domainPath, mutateState, projectKey, resolveWorkspace, type DomainProject } from "../state.js";
import { resolveTeamLimits, teamLimitsSchema, type TeamLimits } from "./limits.js";
import { teamChanged } from "./events.js";

const uuid = z.string().uuid();
const short = z.string().min(1).max(500);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const leaseSchema = z.object({ runId: uuid, epoch: z.number().int().positive(), workItemId: uuid, workerId: uuid, leaseVersion: z.number().int().positive() }).strict();
export type WorkLease = z.infer<typeof leaseSchema>;
const workSchema = z.object({
  id: uuid, title: short, targetRef: short, operation: short, preconditionHash: hash, key: hash,
  status: z.enum(["ready", "claimed", "completed", "uncertain"]), owner: uuid.nullable(),
  leaseVersion: z.number().int().nonnegative(), leaseUntil: z.number().nullable(), claimRequestId: uuid.nullable(),
  resultId: hash.nullable(),
}).strict();
const recordSchema = z.object({
  id: hash, requestId: uuid, fingerprint: hash, eventSeq: z.number().int().positive(), workerId: uuid,
  workItemId: uuid, leaseVersion: z.number().int().positive(), kind: z.enum(["OBSERVED", "HYPOTHESIS", "FAIL", "RESULT"]),
  summary: z.string().max(512), path: z.string().max(500), sha256: hash,
}).strict();
const archiveSchema = z.object({ id: hash, first: z.number().int().min(1), last: z.number().int().min(1), count: z.number().int().min(1).max(256) }).strict();
export const teamStateSchema = z.object({
  version: z.union([z.literal(1), z.literal(2)]), workspaceKey: hash, runId: uuid, epoch: z.number().int().positive(), revision: z.number().int().nonnegative(),
  phase: z.enum(["running", "paused", "stopped"]), goal: z.string().min(1).max(4000), deadline: z.number().finite(),
  workers: z.array(uuid).min(1).max(64), tasks: z.array(workSchema).max(128), records: z.array(recordSchema).max(512),
  limits: teamLimitsSchema.optional(), admissions: z.number().int().min(0).max(64).default(0),
  deliveries: z.record(z.string(), z.number().int().min(0)).default({}),
  graphRequests: z.record(z.string(), z.number().int().min(0)).default({}),
  jobWaits: z.record(z.string(), z.enum(["standard", "heavy"])).default({}),
  recordSequence: z.number().int().min(0).default(0),
  recordArchives: z.array(archiveSchema).max(128).default([]),
  taskArchives: z.array(hash).max(128).default([]),
}).strict();
export type TeamState = z.infer<typeof teamStateSchema>;
export function availableWork(state: TeamState, workerId?: string) {
  return state.tasks.filter(task => {
    if (task.status === "claimed") return task.owner === workerId;
    if (task.status !== "ready") return false;
    const peers = state.tasks.filter(peer => peer.id !== task.id && peer.targetRef.trim().toLowerCase() === task.targetRef.trim().toLowerCase() && ["claimed", "uncertain"].includes(peer.status));
    return peers.length < (state.limits?.targetConcurrency ?? 1);
  });
}
const stateName = "team/state.json";
export const offerSchema = z.object({ title: short, targetRef: short, operation: short, preconditionHash: hash }).strict();
const publicationSchema = z.object({
  requestId: uuid, kind: z.enum(["OBSERVED", "HYPOTHESIS", "FAIL", "RESULT"]),
  summary: z.string().min(1).refine(value => Buffer.byteLength(value) <= 512, "Summary exceeds 512 UTF-8 bytes"),
  preconditionHash: hash, evidenceRefs: z.array(z.string().min(1).max(500)).max(20),
}).strict();
export type Publication = z.infer<typeof publicationSchema>;

async function mutateTeam<Result>(project: DomainProject, change: (state: TeamState) => Result | Promise<Result>, announce = true): Promise<Result> {
  const result = await mutateState(project, stateName, teamStateSchema, () => { throw new Error("No team run exists"); }, async state => {
    if (state.workspaceKey !== projectKey(project)) throw new Error("Team state belongs to another workspace");
    if (state.version === 1) {
      await atomicWrite(await domainPath(project, "team", `state.${state.runId}.v1.backup.json`), JSON.stringify(state) + "\n");
      state.version = 2;
    }
    state.limits ??= resolveTeamLimits({}, state.workers.length);
    state.admissions = Math.max(state.admissions, state.workers.length);
    state.recordSequence = Math.max(state.recordSequence, state.records.at(-1)?.eventSeq ?? 0);
    const result = await change(state);
    state.revision += 1;
    return result;
  }) as Result;
  if (announce) teamChanged(project);
  return result;
}

function active(state: TeamState, runId: string, now: number): void {
  z.number().finite().parse(now);
  uuid.parse(runId);
  if (state.runId !== runId || state.phase !== "running" || now >= state.deadline) throw new Error("Team run is inactive or its window expired");
}

function heldTask(state: TeamState, input: WorkLease, now: number) {
  const lease = leaseSchema.parse(input);
  active(state, lease.runId, now);
  const task = state.tasks.find(entry => entry.id === lease.workItemId);
  if (!task || state.epoch !== lease.epoch || task.status !== "claimed" || task.owner !== lease.workerId || task.leaseVersion !== lease.leaseVersion || task.leaseUntil === null || now >= task.leaseUntil) throw new Error("Work lease is stale or belongs to another worker");
  return task;
}

export async function readTeam(project: DomainProject): Promise<TeamState | undefined> {
  let content: Buffer;
  try { content = await readBoundedFile(await domainPath(project, "team", "state.json"), 2 * 1024 * 1024); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  await resolveWorkspace(project);
  const state = teamStateSchema.parse(JSON.parse(content.toString("utf8")));
  if (state.workspaceKey !== projectKey(project)) throw new Error("Team state belongs to another workspace");
  state.recordSequence = Math.max(state.recordSequence, state.records.at(-1)?.eventSeq ?? 0);
  state.admissions = Math.max(state.admissions, state.workers.length);
  state.limits ??= resolveTeamLimits({}, state.workers.length);
  return state;
}

export async function createTeam(project: DomainProject, input: { goal: string; workerCount?: number; windowSeconds?: number; limits?: TeamLimits }, now = Date.now()): Promise<TeamState> {
  const params = z.object({ goal: z.string().min(1).max(4000), workerCount: z.number().int().min(1).max(64).default(2), windowSeconds: z.number().int().min(1).max(86400).default(3600), limits: teamLimitsSchema.optional() }).strict().parse(input);
  const limits = params.limits ?? resolveTeamLimits({}, params.workerCount);
  if (params.workerCount > limits.maxWorkers) throw new Error("Initial admission exceeds approved capacity");
  await mkdir(await domainPath(project, "team"), { recursive: true, mode: 0o700 });
  return await mutateState<TeamState>(project, stateName, teamStateSchema, () => teamStateSchema.parse({ version: 1, workspaceKey: projectKey(project), runId: randomUUID(), epoch: 1, revision: 0, phase: "stopped", goal: params.goal, deadline: now, workers: [randomUUID()], tasks: [], records: [] }), async state => {
    if (state.workspaceKey !== projectKey(project)) throw new Error("Team state belongs to another workspace");
    if (state.phase !== "stopped") throw new Error("Existing team must be reconciled and stopped first");
    if (state.tasks.length || state.records.length) {
      await mkdir(await domainPath(project, "team", "runs"), { recursive: true, mode: 0o700 });
      await atomicWrite(await domainPath(project, "team", "runs", `${state.runId}.json`), JSON.stringify(state) + "\n");
    }
    if (state.revision > 0) {
      await mkdir(await domainPath(project, "team", "runs"), { recursive: true, mode: 0o700 });
      await atomicWrite(await domainPath(project, "team", "runs", `${state.runId}.json`), JSON.stringify(state) + "\n");
    }
    Object.assign(state, { version: 2, runId: randomUUID(), epoch: 1, revision: 1, phase: "running", goal: params.goal, deadline: now + params.windowSeconds * 1000, workers: Array.from({ length: params.workerCount }, () => randomUUID()), tasks: [], records: [], limits, admissions: params.workerCount, deliveries: {}, graphRequests: {}, jobWaits: {}, recordSequence: 0, recordArchives: [], taskArchives: [] });
    return structuredClone(state);
  }) as TeamState;
}

export async function admitWorker(project: DomainProject, runId: string): Promise<string> {
  return mutateTeam(project, state => {
    active(state, runId, Date.now());
    const limits = state.limits!;
    if (state.workers.length >= limits.maxWorkers || state.admissions >= limits.maxWorkerAdmissions) throw new Error("Approved worker admission budget exhausted");
    const workerId = randomUUID();
    state.workers.push(workerId); state.admissions += 1;
    return workerId;
  });
}

export async function fenceWorker(project: DomainProject, runId: string, workerId: string) {
  return mutateTeam(project, state => {
    if (state.runId !== runId || !state.workers.includes(workerId)) throw new Error("Unknown worker run");
    for (const task of state.tasks) if (task.owner === workerId && task.status === "claimed") { task.status = "uncertain"; task.leaseVersion += 1; }
  });
}

export async function recordDelivery(project: DomainProject, runId: string, workerId: string, through: number) {
  return mutateTeam(project, state => {
    active(state, runId, Date.now());
    if (!state.workers.includes(workerId)) throw new Error("Unknown recipient");
    const sequence = z.number().int().min(0).max(state.recordSequence).parse(through);
    state.deliveries[workerId] = Math.max(state.deliveries[workerId] ?? 0, sequence);
    return { deliveredThrough: state.deliveries[workerId], findingsConfirmed: false };
  }, false);
}

export async function requestGraphRefresh(project: DomainProject, runId: string, workerId: string) {
  return mutateTeam(project, state => {
    active(state, runId, Date.now());
    if (!state.workers.includes(workerId)) throw new Error("Unknown graph requester");
    state.graphRequests[workerId] ??= Date.now();
    return { requestedAt: state.graphRequests[workerId], graphUpdated: false, noAutomaticCypher: true };
  });
}

export async function fulfillGraphRefresh(project: DomainProject, runId: string, capturedAt: number) {
  return mutateTeam(project, state => {
    active(state, runId, Date.now());
    for (const [workerId, requestedAt] of Object.entries(state.graphRequests)) if (requestedAt <= capturedAt) delete state.graphRequests[workerId];
  });
}

export async function setJobWait(project: DomainProject, runId: string, workerId: string, resourceClass?: "standard" | "heavy") {
  return mutateTeam(project, state => {
    active(state, runId, Date.now());
    if (!state.workers.includes(workerId)) throw new Error("Unknown job waiter");
    if (resourceClass) state.jobWaits[workerId] = resourceClass;
    else delete state.jobWaits[workerId];
  });
}

export async function offerWork(project: DomainProject, runId: string, input: z.infer<typeof offerSchema>, now = Date.now()) {
  const params = offerSchema.parse(input);
  return mutateTeam(project, async state => {
    active(state, runId, now);
    const key = digest(JSON.stringify([params.targetRef, params.operation, params.preconditionHash]));
    const existing = state.tasks.find(entry => entry.key === key);
    if (existing) return { created: false, task: structuredClone(existing) };
    for (const id of state.taskArchives) {
      const content = await readBoundedFile(await domainPath(project, "team", "task-history", `${id}.json`), 1024 * 1024);
      if (digest(content) !== id) throw new Error("Task history integrity mismatch");
      const previous = z.array(workSchema).max(64).parse(JSON.parse(content.toString("utf8"))).find(task => task.key === key);
      if (previous) return { created: false, task: previous, archived: true };
    }
    if (state.tasks.length >= 128) {
      const archived = state.tasks.filter(task => task.status === "completed").slice(0, 64);
      if (archived.length && state.taskArchives.length < 128) {
        const content = JSON.stringify(archived) + "\n"; const id = digest(content);
        await mkdir(await domainPath(project, "team", "task-history"), { recursive: true, mode: 0o700 });
        await atomicWrite(await domainPath(project, "team", "task-history", `${id}.json`), content);
        state.taskArchives.push(id);
        const identifiers = new Set(archived.map(task => task.id));
        state.tasks = state.tasks.filter(task => !identifiers.has(task.id));
      }
    }
    if (state.tasks.length >= 128) throw new Error("Team work limit reached; no tasks were discarded");
    const task = workSchema.parse({ ...params, id: randomUUID(), key, status: "ready", owner: null, leaseVersion: 0, leaseUntil: null, claimRequestId: null, resultId: null });
    state.tasks.push(task);
    return { created: true, task: structuredClone(task) };
  });
}

export async function claimWork(project: DomainProject, input: { runId: string; workerId: string; workItemId: string; requestId: string }, now = Date.now()) {
  const params = z.object({ runId: uuid, workerId: uuid, workItemId: uuid, requestId: uuid }).strict().parse(input);
  return mutateTeam(project, state => {
    active(state, params.runId, now);
    if (!state.workers.includes(params.workerId)) throw new Error("Unknown worker");
    const task = state.tasks.find(entry => entry.id === params.workItemId);
    if (!task) throw new Error("Unknown work item");
    if (task.status === "claimed" && task.leaseUntil !== null && now >= task.leaseUntil) {
      task.status = "uncertain";
      return { claimed: false, reason: "Expired claim needs reconciliation; no action replayed", lease: null };
    }
    const repeated = task.status === "claimed" && task.owner === params.workerId && task.claimRequestId === params.requestId;
    if (!repeated && task.status === "ready" && !availableWork(state, params.workerId).some(entry => entry.id === task.id)) return { claimed: false, reason: "Target conflict group is occupied; read another candidate page", lease: null };
    if (!repeated && (task.status !== "ready" || state.tasks.some(entry => entry.owner === params.workerId && ["claimed", "uncertain"].includes(entry.status)))) return { claimed: false, reason: "Work or worker already has an owner", lease: null };
    if (!repeated) {
      task.status = "claimed"; task.owner = params.workerId; task.leaseVersion += 1;
      task.leaseUntil = Math.min(state.deadline, now + 120000); task.claimRequestId = params.requestId;
    }
    const lease: WorkLease = { runId: state.runId, epoch: state.epoch, workItemId: task.id, workerId: params.workerId, leaseVersion: task.leaseVersion };
    return { claimed: true, reason: repeated ? "Existing claim" : "Claimed", lease };
  });
}

export async function renewWork(project: DomainProject, lease: WorkLease, now = Date.now()) {
  return mutateTeam(project, state => { const task = heldTask(state, lease, now); task.leaseUntil = Math.min(state.deadline, now + 120000); return { renewed: true, leaseUntil: task.leaseUntil }; });
}

export async function validateWork(project: DomainProject, lease: WorkLease, now = Date.now()) {
  const state = await readTeam(project);
  if (!state) throw new Error("Unknown team");
  return structuredClone(heldTask(state, lease, now));
}

export async function finishTeam(project: DomainProject, runId: string, phase: "paused" | "stopped") {
  return mutateTeam(project, state => {
    if (state.runId !== uuid.parse(runId)) throw new Error("Unknown team");
    if (state.phase !== phase) state.epoch += 1;
    state.phase = phase;
    for (const task of state.tasks) if (task.status === "claimed") task.status = "uncertain";
    return { phase, epoch: state.epoch, runtimeStopVerified: false };
  });
}

export async function resumeTeam(project: DomainProject, runId: string, windowSeconds: number) {
  z.number().int().min(1).max(86400).parse(windowSeconds);
  return mutateTeam(project, state => {
    if (state.runId !== uuid.parse(runId) || state.phase === "running") throw new Error("Team must be reconciled before resume");
    if (state.tasks.some(task => task.status === "uncertain")) throw new Error("Uncertain work requires expert reconciliation before resume");
    state.epoch += 1; state.phase = "running"; state.deadline = Date.now() + windowSeconds * 1000;
    return structuredClone(state);
  });
}

export async function reconcileWork(project: DomainProject, runId: string, workItemId: string, status: "ready" | "completed", recordId?: string) {
  return mutateTeam(project, async state => {
    if (state.runId !== uuid.parse(runId) || state.phase === "running") throw new Error("Stop the team before expert reconciliation");
    const task = state.tasks.find(entry => entry.id === uuid.parse(workItemId));
    if (!task || task.status !== "uncertain") throw new Error("Work is not uncertain");
    if (status === "completed") {
      const record = recordId ? await findRecord(project, state, recordId) : undefined;
      if (!record || record.workItemId !== task.id || record.kind !== "RESULT" || !(await unfoldRecord(project, runId, record.id)).evidenceVerified) throw new Error("Reconciliation requires unchanged result evidence");
      task.resultId = record.id;
    }
    task.status = status; task.owner = null; task.leaseUntil = null; task.claimRequestId = null;
    return { reconciled: true, conclusionVerified: false };
  });
}

export async function releaseWork(project: DomainProject, lease: WorkLease, now = Date.now()) {
  return mutateTeam(project, state => {
    const task = heldTask(state, lease, now);
    task.status = "ready"; task.owner = null; task.leaseUntil = null; task.claimRequestId = null;
    return { released: true };
  });
}

export async function publishRecord(project: DomainProject, lease: WorkLease, input: Publication, now = Date.now()) {
  const params = publicationSchema.parse(input);
  const fingerprint = digest(JSON.stringify(params));
  const id = digest(JSON.stringify([lease.runId, lease.workerId, params.requestId]));
  return mutateTeam(project, async state => {
    const task = heldTask(state, lease, now);
    if (task.preconditionHash !== params.preconditionHash) throw new Error("Publication preconditions do not match this claim");
    const existing = await findRecord(project, state, id);
    if (existing) {
      if (existing.fingerprint !== fingerprint || existing.workItemId !== task.id || existing.leaseVersion !== lease.leaseVersion) throw new Error("Publication request ID was reused with different content");
      const content = await readBoundedFile(await domainPath(project, "team", "records", `${id}.json`), 65536);
      if (digest(content) !== existing.sha256) throw new Error("Published detail integrity mismatch");
      return { admitted: true, repeated: true, record: structuredClone(existing), conclusionVerified: false };
    }
    if (state.records.length >= 512) {
      if (state.recordArchives.length >= 128) throw new Error("Team record archive capacity reached; no unread records were discarded");
      const archived = state.records.slice(0, 256);
      const content = JSON.stringify(archived) + "\n"; const archiveId = digest(content);
      await mkdir(await domainPath(project, "team", "record-history"), { recursive: true, mode: 0o700 });
      await atomicWrite(await domainPath(project, "team", "record-history", `${archiveId}.json`), content);
      state.recordArchives.push({ id: archiveId, first: archived[0]!.eventSeq, last: archived.at(-1)!.eventSeq, count: archived.length });
      state.records = state.records.slice(256);
    }
    if (params.kind !== "HYPOTHESIS" && !params.evidenceRefs.length) throw new Error("Observation, failure and result records require evidence references");
    const evidence = await evidenceReferences(project, params.evidenceRefs);
    const path = `.redteam/team/records/${id}.json`;
    const content = JSON.stringify({ version: 1, id, lease, publication: params, evidence, capturedAt: now, conclusionVerified: false }) + "\n";
    await mkdir(await domainPath(project, "team", "records"), { recursive: true, mode: 0o700 });
    await atomicWrite(await domainPath(project, "team", "records", `${id}.json`), content);
    const record = recordSchema.parse({ id, requestId: params.requestId, fingerprint, eventSeq: state.recordSequence + 1, workerId: lease.workerId, workItemId: lease.workItemId, leaseVersion: lease.leaseVersion, kind: params.kind, summary: params.summary, path, sha256: digest(content) });
    state.recordSequence = record.eventSeq;
    state.records.push(record);
    return { admitted: true, repeated: false, record: structuredClone(record), conclusionVerified: false };
  });
}

export async function completeWork(project: DomainProject, lease: WorkLease, recordId: string, now = Date.now()) {
  hash.parse(recordId);
  return mutateTeam(project, async state => {
    const task = heldTask(state, lease, now);
    const record = await findRecord(project, state, recordId);
    if (!record || record.workItemId !== task.id || record.workerId !== lease.workerId || record.leaseVersion !== lease.leaseVersion || record.kind !== "RESULT") throw new Error("Completion requires this claim's result record");
    const detail = await unfoldRecord(project, lease.runId, recordId);
    if (!detail.evidenceVerified) throw new Error("Completion requires unchanged available evidence");
    task.status = "completed"; task.resultId = recordId; task.owner = null; task.leaseUntil = null;
    return { completed: true, conclusionVerified: false };
  });
}

export async function pauseTeam(project: DomainProject, runId: string) {
  return mutateTeam(project, state => {
    if (state.runId !== uuid.parse(runId) || state.phase !== "running") throw new Error("Team cannot be paused");
    state.phase = "paused"; state.epoch += 1;
    for (const task of state.tasks) if (task.status === "claimed") task.status = "uncertain";
    return { paused: true, runtimeStopVerified: false, epoch: state.epoch };
  });
}

export async function readRecords(project: DomainProject, runId: string, after = 0) {
  z.number().int().nonnegative().parse(after);
  const state = await readTeam(project);
  if (!state || state.runId !== uuid.parse(runId)) throw new Error("Unknown run");
  const selected: TeamState["records"] = [];
  for (const archive of state.recordArchives.filter(archive => archive.last > after)) {
    selected.push(...(await readRecordArchive(project, archive)).filter(record => record.eventSeq > after));
    if (selected.length > 20) break;
  }
  selected.push(...state.records.filter(record => record.eventSeq > after));
  const records: typeof selected = [];
  for (const record of selected.slice(0, 20)) {
    if (Buffer.byteLength(JSON.stringify([...records, record])) > 12000) break;
    records.push(record);
  }
  return { records, nextAfter: records.at(-1)?.eventSeq ?? after, truncated: state.recordSequence > (records.at(-1)?.eventSeq ?? after), cursorAdvanced: false, conclusionVerified: false };
}

async function readRecordArchive(project: DomainProject, archive: z.infer<typeof archiveSchema>) {
  const content = await readBoundedFile(await domainPath(project, "team", "record-history", `${archive.id}.json`), 1024 * 1024);
  if (digest(content) !== archive.id) throw new Error("Record history integrity mismatch");
  const records = z.array(recordSchema).max(256).parse(JSON.parse(content.toString("utf8")));
  if (records.length !== archive.count || records[0]?.eventSeq !== archive.first || records.at(-1)?.eventSeq !== archive.last) throw new Error("Record history range mismatch");
  return records;
}

async function findRecord(project: DomainProject, state: TeamState, id: string) {
  const recent = state.records.find(record => record.id === id);
  if (recent) return recent;
  for (const archive of state.recordArchives) {
    const found = (await readRecordArchive(project, archive)).find(record => record.id === id);
    if (found) return found;
  }
  return undefined;
}

export async function unfoldRecord(project: DomainProject, runId: string, recordId: string) {
  hash.parse(recordId);
  const state = await readTeam(project);
  if (!state || state.runId !== uuid.parse(runId)) throw new Error("Unknown run");
  const record = await findRecord(project, state, recordId);
  if (!record) throw new Error("Unknown record");
  const content = await readBoundedFile(await domainPath(project, "team", "records", `${recordId}.json`), 65536);
  if (digest(content) !== record.sha256) throw new Error("Published detail integrity mismatch");
  const detail = z.object({
    version: z.literal(1), id: hash, lease: leaseSchema, publication: publicationSchema,
    evidence: z.array(z.object({ reference: short, sha256: hash }).strict()).max(20), capturedAt: z.number().finite(), conclusionVerified: z.literal(false),
  }).strict().parse(JSON.parse(content.toString("utf8")));
  const evidence = await Promise.all(detail.evidence.map(async reference => {
    try {
      const current = (await evidenceReferences(project, [reference.reference]))[0]!;
      return { ...reference, verified: current.sha256 === reference.sha256 };
    } catch { return { ...reference, verified: false }; }
  }));
  return { ...detail, evidence, evidenceVerified: evidence.length > 0 && evidence.every(reference => reference.verified), conclusionVerified: false };
}
