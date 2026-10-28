import { spawn } from "node:child_process";
import { mkdir, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "redteam-zod";
import { atomicWrite, digest } from "../files.js";
import { readBoundedFile } from "./project.js";
import { domainPath, mutateState, projectKey, resolveWorkspace, type DomainProject } from "./state.js";
import { processIdentity } from "./job-worker.js";
import { readOutputWindow } from "./job-output.js";
import lockfile from "proper-lockfile";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";

type JobWorkspace = DomainProject;

const identitySchema = z.object({ pid: z.number().int().positive(), startTicks: z.string(), bootId: z.string(), hostname: z.string() }).strict();
export const jobOwnerSchema = z.object({ runId: z.string().uuid(), workerId: z.string().uuid(), workItemId: z.string().uuid(), leaseVersion: z.number().int().positive() }).strict();
export type JobOwner = z.infer<typeof jobOwnerSchema>;
const requestSchema = z.object({ version: z.literal(1), projectKey: z.string(), id: z.string().uuid(), command: z.string().min(1).max(8192), cwd: z.string(), timeoutSeconds: z.number().int().min(1).max(2592000), maxOutputBytes: z.number().int().min(1024).max(1024 * 1024 * 1024), expiresAt: z.string().datetime({ offset: true }).optional(), owner: jobOwnerSchema.optional(), requestId: z.string().uuid().optional(), attemptId: z.string().uuid().optional(), branchId: z.string().max(80).optional(), sessionId: z.string().max(256).optional(), resourceClass: z.enum(["standard", "heavy"]).optional() }).strict();
const stateSchema = z.object({ version: z.literal(1), projectKey: z.string(), id: z.string().uuid(), identity: identitySchema, phase: z.enum(["running", "completed", "failed", "cancelled", "timed_out"]), startedAt: z.string(), finishedAt: z.string().optional(), bytesSaved: z.number().int().min(0), outputTruncated: z.boolean(), exitCode: z.number().int().nullable(), signal: z.string().nullable(), terminationVerified: z.boolean().optional() }).strict();
export type JobRequest = z.infer<typeof requestSchema>;
export type JobState = z.infer<typeof stateSchema>;
const identifier = (id: string) => z.string().uuid().parse(id);

async function readJob(project: JobWorkspace, id: string) {
  const directory = await domainPath(project, "jobs", identifier(id));
  const request = requestSchema.parse(JSON.parse((await readBoundedFile(await domainPath(project, "jobs", id, "request.json"), 16384)).toString("utf8")));
  const state = stateSchema.parse(JSON.parse((await readBoundedFile(await domainPath(project, "jobs", id, "status.json"), 16384)).toString("utf8")));
  if (request.cwd !== project.cwd || state.projectKey !== request.projectKey || request.id !== id || state.id !== id) throw new Error("Job does not belong to this working directory");
  return { directory, request, state };
}

export async function jobStatus(project: JobWorkspace, id: string) {
  await resolveWorkspace(project);
  let { state, request } = await readJob(project, id);
  let live = false;
  try { live = JSON.stringify(await processIdentity(state.identity.pid)) === JSON.stringify(state.identity); } catch {}
  if (!live && state.phase === "running") ({ state, request } = await readJob(project, id));
  let cancellationRequested = false;
  try { await stat(await domainPath(project, "jobs", id, "cancel.json")); cancellationRequested = true; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  let outputBytes = state.bytesSaved;
  try { outputBytes = (await stat(await domainPath(project, "jobs", id, "output.log"))).size; } catch {}
  const completionVerified = state.phase !== "running" && state.terminationVerified !== false;
  return { ...state, owner: request.owner, attemptId: request.attemptId, branchId: request.branchId, sessionId: request.sessionId, resourceClass: request.resourceClass ?? "heavy", phase: !completionVerified && (!live || state.phase !== "running") ? cancellationRequested ? "cancelled-unverified" : "interrupted" : state.phase, live,
    outputBytes, outputPath: `.redteam/jobs/${id}/output.log`, cancellationRequested,
    replayed: false, legacyScope: state.projectKey !== projectKey(project), completionVerified, terminationEvidence: state.terminationVerified === undefined ? "legacy-controller-only" : "process-group", outputMayBePartial: state.outputTruncated || !completionVerified,
  };
}

type StartJobInput = { command: string; timeoutSeconds?: number; maxOutputBytes?: number; owner?: JobOwner; requestId?: string; attemptId?: string; branchId?: string; sessionId?: string; resourceClass?: "standard" | "heavy" };
export async function startJob(project: DomainProject, input: StartJobInput, signal?: AbortSignal) {
  if (process.platform !== "linux") throw new Error("Long jobs require Kali/Linux; use native Pi bash on the host");
  signal?.throwIfAborted();
  const directory = await domainPath(project, "jobs");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const lockPath = await domainPath(project, "jobs", ".admission-lock");
  return withFileMutationQueue(lockPath, async () => {
    signal?.throwIfAborted();
    const release = await lockfile.lock(directory, { realpath: false, lockfilePath: lockPath, stale: 30000, update: 5000, retries: { retries: 20, minTimeout: 20, maxTimeout: 100 } });
    try { return await startAdmittedJob(project, input, signal); }
    finally { await release(); }
  });
}

async function checkTeamJobCapacity(project: DomainProject, resourceClass = "heavy") {
  let raw: string;
  try { raw = (await readBoundedFile(await domainPath(project, "team", "state.json"), 2 * 1024 * 1024)).toString("utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  const team = z.object({ phase: z.enum(["running", "paused", "stopped"]), limits: z.object({ maxConcurrentJobs: z.number().int().min(1).max(64), maxHeavyJobs: z.number().int().min(1).max(64).default(1) }).passthrough().optional() }).passthrough().parse(JSON.parse(raw));
  if (team.phase !== "running") return;
  const inventory = await listJobs(project);
  if (inventory.truncated || inventory.jobs.some(job => ["unavailable", "interrupted", "cancelled-unverified"].includes(job.phase))) throw new Error("Global job capacity cannot be verified; inspect inventory before starting work");
  if (inventory.jobs.filter(job => "live" in job && job.live).length >= (team.limits?.maxConcurrentJobs ?? 2)) throw new Error("Global team job slots are full; wait for a terminal job before retrying. No job was reserved or replayed");
  if (resourceClass === "heavy" && inventory.jobs.filter(job => "live" in job && job.live && "resourceClass" in job && job.resourceClass === "heavy").length >= (team.limits?.maxHeavyJobs ?? 1)) throw new Error("Global team heavy job slots are full; wait for a terminal job before retrying. No job was reserved or replayed");
}

async function startAdmittedJob(project: DomainProject, input: StartJobInput, signal?: AbortSignal) {
  signal?.throwIfAborted();
  await resolveWorkspace(project);
  const request = requestSchema.parse({ ...input, version: 1, projectKey: projectKey(project), id: randomUUID(), cwd: project.cwd, timeoutSeconds: input.timeoutSeconds ?? 3600, maxOutputBytes: input.maxOutputBytes ?? 64 * 1024 * 1024 });
  if (request.requestId) {
    const ledgerSchema = z.object({ entries: z.array(z.object({ requestId: z.string().uuid(), id: z.string().uuid(), fingerprint: z.string() })).max(4096) });
    const { id: ignored, ...parameters } = request;
    const fingerprint = digest(JSON.stringify(parameters));
    const reservation = await mutateState(project, "job-starts.json", ledgerSchema, () => ({ entries: [] }), async state => {
      const previous = state.entries.find(entry => entry.requestId === request.requestId);
      if (previous) {
        if (previous.fingerprint !== fingerprint) throw new Error("Job requestId reused with different parameters");
        return { id: previous.id, reused: true };
      }
      if (state.entries.length >= 4096) throw new Error("Job start ledger full; archive explicitly");
      await checkTeamJobCapacity(project, request.resourceClass);
      state.entries.push({ requestId: request.requestId!, id: request.id, fingerprint });
      return { id: request.id, reused: false };
    }, signal) as { id: string; reused: boolean };
    if (reservation.reused) {
      try { return await jobStatus(project, reservation.id); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        return { id: reservation.id, phase: "unavailable", reason: "Startup reserved but not acknowledged; do not replay", replayed: false };
      }
    }
  }
  if (!request.requestId) await checkTeamJobCapacity(project, request.resourceClass);
  const directory = await domainPath(project, "jobs", request.id);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = await domainPath(project, "jobs", request.id, "request.json");
  await atomicWrite(path, JSON.stringify(request, null, 2) + "\n");
  const sourceMode = import.meta.url.endsWith(".ts");
  const worker = fileURLToPath(new URL(sourceMode ? "./job-worker.ts" : "./job-worker.js", import.meta.url));
  const child = spawn(process.execPath, [...(sourceMode ? ["--import", import.meta.resolve("tsx")] : []), worker, path], { detached: true, stdio: "ignore", cwd: project.cwd, env: process.env });
  let spawnError: Error | undefined;
  child.on("error", error => { spawnError = error; });
  child.unref();
  try {
    for (let attempt = 0; attempt < 200; attempt++) {
      signal?.throwIfAborted();
      if (spawnError) throw spawnError;
      try { return await jobStatus(project, request.id); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      await delay(25, undefined, { signal });
    }
    throw new Error("Long-job worker did not acknowledge startup");
  } catch (error) {
    try { if (child.pid) process.kill(-child.pid, "SIGTERM"); } catch {}
    throw error;
  }
}

export async function readJobOutput(project: JobWorkspace, id: string, cursor?: string, maxBytes = 16384) {
  identifier(id);
  z.number().int().min(4).max(65536).parse(maxBytes);
  const match = cursor?.match(/^([a-f0-9-]{36}):([0-9]{1,16})$/);
  if (cursor && (!match || match[1] !== id)) throw new Error("Cursor does not belong to this job");
  const offset = match ? Number(match[2]) : 0;
  if (!Number.isSafeInteger(offset)) throw new Error("Invalid cursor offset");
  const status = await jobStatus(project, id);
  const window = await readOutputWindow(await domainPath(project, "jobs", id, "output.log"), offset, maxBytes, status.completionVerified);
  return { ...window, id, phase: status.phase, nextCursor: `${id}:${window.nextOffset}`, truncated: status.outputTruncated || !window.atEnd, complete: status.completionVerified && !status.outputTruncated && window.atEnd, outputPath: status.outputPath, automaticFeedback: false };
}

export async function cancelJob(project: JobWorkspace, id: string, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const current = await jobStatus(project, id);
  if (!current.live && (current.completionVerified || current.terminationVerified === false)) return current;
  if (!current.completionVerified) await atomicWrite(await domainPath(project, "jobs", identifier(id), "cancel.json"), JSON.stringify({ requestedAt: new Date().toISOString() }) + "\n");
  if (current.live && current.phase === "running") {
    let identity;
    try { identity = await processIdentity(current.identity.pid); }
    catch { if ((await jobStatus(project, id)).live) throw new Error("Job identity cannot be verified; cancellation refused"); }
    if (identity) {
      if (JSON.stringify(identity) !== JSON.stringify(current.identity)) throw new Error("Job identity changed; cancellation refused");
      try { process.kill(current.identity.pid, "SIGTERM"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    }
  }
  for (let attempt = 0; attempt < 320; attempt++) {
    const next = await jobStatus(project, id);
    if (!next.live && (next.completionVerified || next.terminationVerified === false)) return next;
    await delay(25, undefined, { signal });
  }
  const unsettled = await jobStatus(project, id);
  if (!unsettled.live) return unsettled;
  throw new Error("Job cancellation is not verified; inspect its process and output");
}

export async function listJobs(project: JobWorkspace) {
  let ids: string[];
  try { ids = await readdir(await domainPath(project, "jobs")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; return { jobs: [], truncated: false }; }
  const selected = ids.filter(id => z.string().uuid().safeParse(id).success).sort();
  const jobs = await Promise.all(selected.slice(-256).map(async id => {
    try { return await jobStatus(project, id); }
    catch { return { id, phase: "unavailable", completionVerified: false, error: "Job metadata is missing, unsafe or invalid; no action replayed" }; }
  }));
  return { jobs, truncated: selected.length > 256 };
}

export async function listOwnedJobs(project: JobWorkspace, runId: string, workerId?: string) {
  identifier(runId);
  if (workerId) identifier(workerId);
  let ids: string[];
  try { ids = await readdir(await domainPath(project, "jobs")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; return []; }
  if (ids.length > 4096) throw new Error("Job inventory exceeds inspection limit; archive explicitly before cooperation");
  const matches = [];
  for (const id of ids.filter(value => z.string().uuid().safeParse(value).success)) {
    const request = requestSchema.parse(JSON.parse((await readBoundedFile(await domainPath(project, "jobs", id, "request.json"), 16384)).toString("utf8")));
    if (request.owner?.runId === runId && (!workerId || request.owner.workerId === workerId)) matches.push(await jobStatus(project, id));
  }
  return matches;
}
