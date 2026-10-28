import { z } from "redteam-zod";
import { unavailableGraph } from "../graph-capability.js";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { registerDomainTools } from "../domain.js";
import { assessBranches, branchInput, interruptSearchAttempt, listBranches, nextSearchStep, recordFeedback, reviewSearchBranches, searchAttempt, selectSearchBranch, upsertBranch } from "../search.js";
import { candidatePaths, evidenceReferences, linkSchema } from "../graph.js";
import { reasonGraph } from "../graph-reasoning.js";
import { cancelJob, jobStatus, listOwnedJobs, readJobOutput, startJob } from "../jobs.js";
import { domainPath, type DomainProject } from "../state.js";
import { readBoundedFile } from "../project.js";
import { digest, rejectSymlinks, safePath } from "../../files.js";
import { readTeam, validateWork, type WorkLease } from "./store.js";
import type { TeamToolInput, WorkerConfig } from "./protocol.js";
import { campaignAction, type CampaignInput } from "../campaign.js";

export function workerDomainSchemas(): WorkerConfig["domainTools"] {
  const definitions: ToolDefinition[] = [];
  registerDomainTools({ registerTool: (tool: ToolDefinition) => { definitions.push(tool); } } as ExtensionAPI);
  return definitions.map(tool => ({ name: tool.name as "rt_search" | "rt_graph" | "rt_job" | "rt_campaign", description: tool.name === "rt_graph" ? "Read the expert's bounded graph snapshot and run graph reasoning. Snapshot is not live Neo4j and may be stale. No writes or arbitrary Cypher." : tool.description, parameters: tool.name === "rt_graph" ? { type: "object", properties: { action: { enum: ["snapshot", "paths", "query"] }, query: { enum: ["next", "chains", "severity", "evidence", "chokepoints"] }, sourceId: { type: "string", maxLength: 500 }, targetId: { type: "string", maxLength: 500 }, maxAgeSeconds: { type: "integer", minimum: 1, maximum: 2592000 } }, required: ["action"], additionalProperties: false } : tool.parameters as Record<string, unknown> }));
}

const searchInput = z.object({ action: z.enum(["list", "upsert", "feedback", "recommend", "next", "select", "interrupt", "review"]), branch: branchInput.optional(), pivot: branchInput.optional(), mode: z.enum(["explore", "advance"]).optional(), justification: z.string().min(1).max(2000).optional(), id: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/).optional(), outcome: z.enum(["success", "partial", "failure"]).optional(), note: z.string().max(2000).optional(), reference: z.string().min(1).max(500).optional(), requestId: z.string().uuid().optional(), attemptId: z.string().uuid().optional(), decisionId: z.string().uuid().optional(), goal: z.string().min(1).max(2000).optional(), references: z.array(z.string().min(1).max(500)).min(1).max(100).optional() }).strict();
const graphInput = z.object({ action: z.enum(["snapshot", "paths", "query"]), query: z.enum(["next", "chains", "severity", "evidence", "chokepoints"]).optional(), sourceId: z.string().min(1).max(500).optional(), targetId: z.string().min(1).max(500).optional(), maxAgeSeconds: z.number().int().min(1).max(2592000).optional() }).strict();
const jobInput = z.object({ action: z.enum(["start", "list", "status", "cancel", "read"]), id: z.string().uuid().optional(), command: z.string().min(1).max(8192).optional(), timeoutSeconds: z.number().int().min(1).max(2592000).optional(), maxOutputBytes: z.number().int().min(1024).max(1073741824).optional(), requestId: z.string().uuid().optional(), attemptId: z.string().uuid().optional(), cursor: z.string().max(100).optional(), maxBytes: z.number().int().min(4).max(65536).optional(), resourceClass: z.enum(["standard", "heavy"]).optional() }).strict();

export function workerDomainAdapter(project: DomainProject, execution: boolean) {
  const owned = async (lease: WorkLease) => (await listOwnedJobs(project, lease.runId, lease.workerId)).filter(job => job.owner?.workItemId === lease.workItemId && job.owner.leaseVersion === lease.leaseVersion);
  return {
    async assertQuiescent(lease: WorkLease) {
      const jobs = await owned(lease);
      if (jobs.some(job => job.live || ["running", "interrupted", "cancelled-unverified"].includes(job.phase))) throw new Error("Stop and verify this claim's jobs before release or completion");
    },
    async invoke(lease: WorkLease, toolCallId: string, input: Extract<TeamToolInput, { action: "domain" }>) {
      const task = await validateWork(project, lease);
      const params = JSON.parse(JSON.stringify(input.params));
      if (input.tool === "rt_campaign") {
        const scoped = { ...project, mutationGuard: async () => { await validateWork(project, lease); } };
        return campaignAction(scoped, params as CampaignInput, { id: `worker:${lease.workerId}`, targetRef: task.targetRef });
      }
      if (input.tool === "rt_search") {
        const parsed = searchInput.parse(params);
        const scoped = { ...project, searchStatePath: `team/search/${lease.runId}/${lease.workItemId}/branches.json`, mutationGuard: async () => { await validateWork(project, lease); } };
        const sessionKey = `${lease.runId}:${lease.workItemId}:${lease.workerId}:${lease.leaseVersion}`;
        if (parsed.action === "select") {
          if (!parsed.id || !parsed.decisionId || !parsed.goal) throw new Error("id, decisionId and goal required");
          return selectSearchBranch(scoped, { branchId: parsed.id, decisionId: parsed.decisionId, goal: parsed.goal, justification: parsed.justification ?? "", sessionKey });
        }
        if (parsed.action === "interrupt") {
          if (!parsed.attemptId) throw new Error("attemptId required");
          return interruptSearchAttempt(scoped, parsed.attemptId, sessionKey);
        }
        if (parsed.action === "review") return { candidates: await reviewSearchBranches(scoped, parsed.references ?? []), automaticReactivation: false };
        if (parsed.action === "upsert") {
          if (!parsed.branch) throw new Error("branch required");
          await evidenceReferences(project, parsed.branch.evidence.map(entry => entry.reference));
          return upsertBranch(scoped, parsed.branch);
        }
        if (parsed.action === "feedback") {
          if (!parsed.id || !parsed.outcome || !parsed.reference) throw new Error("id, outcome and evidence reference required");
          const references = await evidenceReferences(project, [parsed.reference]);
          const hash = digest(JSON.stringify([lease.runId, lease.workerId, toolCallId]));
          const requestId = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
          if (parsed.attemptId && (await searchAttempt(scoped, parsed.attemptId))?.sessionKey !== sessionKey) throw new Error("Attempt belongs to another claim");
          return recordFeedback(scoped, { id: parsed.id, outcome: parsed.outcome, reference: parsed.reference, note: parsed.note ?? "", pivot: parsed.pivot, requestId: parsed.requestId ?? requestId, attemptId: parsed.attemptId, referenceSha256: references[0]!.sha256 });
        }
        const context = input.contextPercent == null ? undefined : input.contextPercent / 100;
        if (parsed.action === "next") return nextSearchStep(scoped, context, parsed.mode && parsed.justification ? { mode: parsed.mode, justification: parsed.justification } : undefined);
        const branches = await listBranches(scoped);
        return parsed.action === "list" ? { branches, claimScoped: true } : { candidates: assessBranches(branches, context), advisory: true };
      }
      if (input.tool === "rt_graph") {
        const parsed = graphInput.parse(params);
        const state = await readTeam(project);
        if (!state || state.runId !== lease.runId || state.epoch !== lease.epoch) throw new Error("Graph claim lost its run");
        const server = state.graphAccess?.server ?? "neo4j";
        if (state.graphAccess?.mode === "off") return unavailableGraph("disabled", parsed.action, server);
        let content: Buffer;
        try { content = await readBoundedFile(await domainPath(project, "team", `graph.${state.runId}.${state.epoch}.${server.replaceAll("-", "_")}.json`), 1024 * 1024); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          try { content = await readBoundedFile(await domainPath(project, "team", "graph.json"), 1024 * 1024); }
          catch (fallback) { if ((fallback as NodeJS.ErrnoException).code === "ENOENT") return unavailableGraph("snapshot_missing", parsed.action, server); throw fallback; }
        }
        const snapshot = z.object({ runId: z.string().uuid(), epoch: z.number().int().positive().optional(), workspaceKey: z.string().regex(/^[a-f0-9]{64}$/).optional(), server: z.string().optional(), capturedAt: z.number().finite(), links: z.array(linkSchema).max(256) }).strict().parse(JSON.parse(content.toString("utf8")));
        if (snapshot.runId !== lease.runId) throw new Error("Graph snapshot is from another run; ask main Pi to refresh");
        if (!snapshot.epoch || !snapshot.workspaceKey || !snapshot.server) return unavailableGraph("snapshot_unbound", parsed.action, server);
        if (snapshot.epoch !== state.epoch || snapshot.workspaceKey !== state.workspaceKey || snapshot.server !== server) throw new Error("Graph snapshot workspace, epoch or server does not match the run");
        if (snapshot.capturedAt > Date.now()) throw new Error("Graph snapshot has a future timestamp");
        const ageSeconds = (Date.now() - snapshot.capturedAt) / 1000;
        if (ageSeconds > (parsed.maxAgeSeconds ?? 86400)) return unavailableGraph("snapshot_expired", parsed.action, server);
        if (new Set(snapshot.links.map(link => link.id)).size !== snapshot.links.length) throw new Error("Duplicate graph relationship IDs");
        const references = new Map<string, string | null>();
        let bytes = 0;
        for (const link of snapshot.links) {
          for (const reference of link.evidenceRefs) {
            if (references.has(reference)) continue;
            if (references.size >= 256 || bytes >= 16 * 1024 * 1024) { references.set(reference, null); continue; }
            try {
              const path = safePath(project.cwd, reference);
              await rejectSymlinks(project.cwd, path);
              const buffer = await readBoundedFile(path, 16 * 1024 * 1024 - bytes);
              bytes += buffer.length; references.set(reference, digest(buffer));
            } catch { references.set(reference, null); }
          }
          link.evidenceVerified = link.evidenceRefs.length > 0 && link.evidenceHashes?.length === link.evidenceRefs.length && link.evidenceRefs.every((reference, index) => references.get(reference) === link.evidenceHashes?.[index]);
        }
        const latest = await readTeam(project);
        if (latest?.graphAccess?.mode === "off") return unavailableGraph("disabled", parsed.action, server);
        if (latest?.runId !== lease.runId || latest.epoch !== lease.epoch || latest.graphAccess?.server && latest.graphAccess.server !== server) throw new Error("Graph binding changed during reasoning");
        const metadata = { snapshot: true, capturedAt: snapshot.capturedAt, ageSeconds, liveNeo4j: false, conclusionVerified: false };
        if (parsed.action === "snapshot") return { ...metadata, links: snapshot.links };
        if (parsed.action === "query") {
          if (!parsed.query) throw new Error("query required");
          return { ...metadata, reasoning: reasonGraph(snapshot.links, parsed.query, parsed) };
        }
        if (!parsed.sourceId || !parsed.targetId) throw new Error("source and target required");
        return { ...metadata, paths: candidatePaths(snapshot.links, parsed.sourceId, parsed.targetId, Date.now(), parsed.maxAgeSeconds) };
      }
      const parsed = jobInput.parse(input.params);
      const jobs = await owned(lease);
      if (parsed.action === "list") return { jobs, ownerScoped: true };
      if (parsed.action === "start") {
        if (!execution || !parsed.command) throw new Error("Parent native bash capability and command required");
        if (jobs.filter(job => job.live).length >= 2) throw new Error("At most two active jobs per claim");
        const state = await readTeam(project);
        if (!state || state.runId !== lease.runId) throw new Error("Run unavailable");
        const available = Math.floor((state.deadline - Date.now()) / 1000);
        if (available < 1 || (parsed.timeoutSeconds !== undefined && parsed.timeoutSeconds > available)) throw new Error("Job timeout exceeds remaining approved window");
        const scoped = { ...project, searchStatePath: `team/search/${lease.runId}/${lease.workItemId}/branches.json` };
        const attempt = parsed.attemptId ? await searchAttempt(scoped, parsed.attemptId) : null;
        if (parsed.attemptId && (!attempt || attempt.phase !== "active" || attempt.sessionKey !== `${lease.runId}:${lease.workItemId}:${lease.workerId}:${lease.leaseVersion}`)) throw new Error("Attempt belongs to another claim");
        return startJob(project, { command: parsed.command, timeoutSeconds: parsed.timeoutSeconds ?? Math.min(3600, available), maxOutputBytes: Math.min(parsed.maxOutputBytes ?? 67108864, 67108864), requestId: parsed.requestId, resourceClass: parsed.resourceClass, ...(attempt ? { attemptId: attempt.attemptId, branchId: attempt.branchId } : {}), owner: { runId: lease.runId, workerId: lease.workerId, workItemId: lease.workItemId, leaseVersion: lease.leaseVersion } });
      }
      if (!parsed.id || !jobs.some(job => job.id === parsed.id)) throw new Error("Job belongs to another claim");
      if (parsed.action === "read") return readJobOutput(project, parsed.id, parsed.cursor, parsed.maxBytes);
      return parsed.action === "cancel" ? cancelJob(project, parsed.id) : jobStatus(project, parsed.id);
    },
  };
}
