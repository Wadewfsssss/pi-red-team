import { truncateHead } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { assessBranches, interruptSearchAttempt, listBranches, nextSearchStep, recordFeedback, reviewSearchBranches, searchAttempt, selectSearchBranch, upsertBranch } from "./search.js";
import { candidatePaths, evidenceReferences, graphSnapshot, recordLink } from "./graph.js";
import { reasonGraph } from "./graph-reasoning.js";
import { cancelJob, jobStatus, listJobs, readJobOutput, startJob } from "./jobs.js";
import { loadProject } from "./project.js";
import { z } from "redteam-zod";
import { campaignAction, campaignInput } from "./campaign.js";
const identifier = Type.String({ minLength: 1, maxLength: 80, pattern: "^[A-Za-z0-9_-]+$" });
const text = Type.String({ minLength: 1, maxLength: 500 });
const unit = Type.Number({ minimum: 0, maximum: 1 });
const outcome = Type.Union([Type.Literal("success"), Type.Literal("partial"), Type.Literal("failure")]);
const entity = Type.Object({ id: Type.String({ minLength: 1, maxLength: 200 }), kind: Type.Union(["asset", "identity", "observation", "hypothesis", "finding", "attack_step", "credential", "host", "service", "objective", "evidence"].map(value => Type.Literal(value))), name: Type.String({ minLength: 1, maxLength: 300 }), properties: Type.Optional(Type.Object({ cvss: Type.Optional(Type.Number({ minimum: 0, maximum: 10 })), status: Type.Optional(Type.Union([Type.Literal("confirmed"), Type.Literal("needs_review"), Type.Literal("rejected")])), confidence: Type.Optional(unit), risk: Type.Optional(Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")])), technique: Type.Optional(Type.String({ maxLength: 100 })) })) });
const namespace = { name: "redteam", description: "Track competing test directions, evidence-linked relationships and long jobs when needed. Simple steps stay with native tools; Pi owns execution and sessions." };
const outputSchema = Type.Object({}, { additionalProperties: true });
const branchParameters = Type.Object({ id: identifier, parentId: Type.Optional(identifier), title: text, status: Type.Union([Type.Literal("active"), Type.Literal("suspended"), Type.Literal("confirmed"), Type.Literal("refuted"), Type.Literal("exhausted")]), remainingSteps: Type.Integer({ minimum: 0, maximum: 10000 }), promise: unit, evidence: Type.Array(Type.Object({ reference: text, confidence: Type.Optional(unit), category: Type.Optional(Type.Union([Type.Literal("verified"), Type.Literal("confirmed"), Type.Literal("plausible"), Type.Literal("speculative")])) }), { maxItems: 100 }), kind: Type.Optional(Type.Union([Type.Literal("observation"), Type.Literal("hypothesis"), Type.Literal("action")])), snapshot: Type.Optional(Type.Object({ target: Type.Optional(text), factRefs: Type.Optional(Type.Array(text, { maxItems: 100 })), credentialRefs: Type.Optional(Type.Array(text, { maxItems: 100 })), sessionRefs: Type.Optional(Type.Array(text, { maxItems: 100 })), notes: Type.Optional(Type.String({ maxLength: 2000 })) })) });
const searchBranchParameters = Type.Object({ ...branchParameters.properties,
    evidence: Type.Array(Type.Object({ reference: text, confidence: Type.Optional(unit), category: Type.Optional(Type.Union([Type.Literal("verified"), Type.Literal("confirmed"), Type.Literal("plausible"), Type.Literal("speculative")])), applicable: Type.Optional(Type.Boolean()), reason: Type.Optional(Type.String({ maxLength: 2000 })) }), { maxItems: 100 }),
    role: Type.Optional(Type.Union([Type.Literal("initial-root"), Type.Literal("target"), Type.Literal("pivot"), Type.Literal("needs-review")])),
    readiness: Type.Optional(Type.Union([Type.Literal("ready"), Type.Literal("unknown"), Type.Literal("blocked")])), prerequisites: Type.Optional(Type.Array(text, { maxItems: 100 })),
});
export function currentAttempt(ctx) {
    let attemptId;
    for (const entry of ctx.sessionManager.getBranch?.() ?? []) {
        if (entry.type !== "custom" || entry.customType !== "redteam-selection")
            continue;
        const data = entry.data;
        if (data?.phase === "active")
            attemptId = data.attemptId;
        else if (data?.attemptId === attemptId)
            attemptId = undefined;
    }
    return attemptId;
}
async function projectFor(ctx) {
    const project = await loadProject(ctx.cwd, ctx.isProjectTrusted());
    if (project.status !== "ready")
        throw new Error(project.reason);
    return project;
}
export function registerDomainTools(pi) {
    const result = (value) => {
        const text = JSON.stringify(value);
        const data = JSON.parse(text);
        const preview = truncateHead(text, { maxBytes: 64 * 1024, maxLines: 2000 });
        return { content: [{ type: "text", text: preview.content + (preview.truncated ? "\nResult text truncated. Full structured data is available through codemode; filter it before returning to the model." : "") }], details: data, structuredContent: data };
    };
    pi.registerTool({
        name: "rt_campaign", label: "Optional coverage notes", exposure: "direct", namespace, outputSchema,
        description: "Optional workspace notes: target records an asset/category/blocker/possible next step; coverage records an observed surface with evidence; status reads paged notes. No configure or inventory completeness required. Suggestions are non-exhaustive, not a mandatory checklist or authorization. This tool never declares whole-task success, chooses branches or triggers continuation. Keep hypotheses, competing explanations in snapshot.notes and attempt feedback in rt_search. Simple work needs no coverage notes.",
        executionMode: "sequential", parameters: Type.Unsafe(z.toJSONSchema(campaignInput, { io: "input" })),
        async execute(_callId, params, signal, _update, ctx) {
            return result(await campaignAction(await projectFor(ctx), params, { id: `parent:${ctx.sessionManager.getSessionId()}` }, signal));
        },
    });
    pi.registerTool({
        name: "rt_search", label: "Red-team search assistance", exposure: "direct", namespace, outputSchema,
        description: "For competing directions: upsert evidence-backed hypotheses, next for TDI/UCB recommendation, select(id,decisionId,goal) to declare the logical attempt, then native tools and feedback(id,attemptId,requestId,outcome,reference). Unknown evidence stays unscored. Intermediate TDI needs mode and justification. Interrupt before switching an unfinished attempt. Review references to reconsider related suspended branches. Simple commands need none of this. No automatic execution or verdict.",
        executionMode: "sequential",
        parameters: Type.Object({
            action: Type.Union([Type.Literal("list"), Type.Literal("upsert"), Type.Literal("feedback"), Type.Literal("recommend"), Type.Literal("next"), Type.Literal("select"), Type.Literal("interrupt"), Type.Literal("review")]),
            branch: Type.Optional(searchBranchParameters), pivot: Type.Optional(searchBranchParameters), mode: Type.Optional(Type.Union([Type.Literal("explore"), Type.Literal("advance")])), justification: Type.Optional(Type.String({ minLength: 1, maxLength: 2000 })),
            id: Type.Optional(identifier), outcome: Type.Optional(outcome), note: Type.Optional(Type.String({ maxLength: 2000 })), reference: Type.Optional(text),
            attemptId: Type.Optional(Type.String({ format: "uuid" })), requestId: Type.Optional(Type.String({ format: "uuid" })), decisionId: Type.Optional(Type.String({ format: "uuid" })), goal: Type.Optional(Type.String({ minLength: 1, maxLength: 2000 })), references: Type.Optional(Type.Array(text, { minItems: 1, maxItems: 100 })),
        }),
        async execute(_id, params, signal, _onUpdate, ctx) {
            signal?.throwIfAborted();
            const project = await projectFor(ctx);
            if (params.action === "select") {
                if (!params.id || !params.decisionId || !params.goal)
                    throw new Error("select requires id, decisionId and goal");
                const active = currentAttempt(ctx);
                const prior = active ? await searchAttempt(project, active) : null;
                if (prior?.phase === "active" && prior.decisionId !== params.decisionId)
                    throw new Error("Finish or interrupt current attempt before switching");
                const sessionKey = prior?.phase === "active" ? prior.sessionKey : `${ctx.sessionManager.getSessionId()}:${ctx.sessionManager.getLeafId() ?? "root"}`;
                const selected = await selectSearchBranch(project, { branchId: params.id, decisionId: params.decisionId, goal: params.goal, justification: params.justification ?? "", sessionKey }, signal);
                pi.appendEntry("redteam-selection", selected);
                return result(selected);
            }
            if (params.action === "interrupt") {
                if (!params.attemptId)
                    throw new Error("attemptId is required");
                if (params.attemptId !== currentAttempt(ctx))
                    throw new Error("Attempt is not declared on this native session branch");
                const attempt = await searchAttempt(project, params.attemptId);
                if (!attempt)
                    throw new Error("Attempt unavailable");
                const interrupted = await interruptSearchAttempt(project, params.attemptId, attempt.sessionKey, signal);
                pi.appendEntry("redteam-selection", interrupted);
                return result(interrupted);
            }
            if (params.action === "review")
                return result({ candidates: await reviewSearchBranches(project, params.references ?? []), automaticReactivation: false });
            if (params.action === "upsert") {
                if (!params.branch)
                    throw new Error("branch is required");
                return result(await upsertBranch(project, JSON.parse(JSON.stringify(params.branch)), signal));
            }
            if (params.action === "feedback") {
                if (!params.id || !params.outcome || !params.reference)
                    throw new Error("id, outcome and evidence reference are required");
                if (params.attemptId) {
                    const attempt = await searchAttempt(project, params.attemptId);
                    const owns = (ctx.sessionManager.getBranch?.() ?? []).some(entry => entry.type === "custom" && entry.customType === "redteam-selection" && entry.data?.attemptId === params.attemptId);
                    if (!attempt || !owns)
                        throw new Error("Attempt belongs to another session branch");
                }
                const referenceSha256 = params.attemptId ? (await evidenceReferences(project, [params.reference]))[0].sha256 : undefined;
                const updated = await recordFeedback(project, { id: params.id, outcome: params.outcome, note: params.note ?? "", reference: params.reference, referenceSha256, requestId: params.requestId, attemptId: params.attemptId, ...(params.pivot ? { pivot: JSON.parse(JSON.stringify(params.pivot)) } : {}) }, signal);
                if (params.attemptId && currentAttempt(ctx) === params.attemptId)
                    pi.appendEntry("redteam-selection", await searchAttempt(project, params.attemptId));
                return result({ ...updated, tracking: params.attemptId ? "declared-attempt" : "legacy-unbound", securityVerdictVerified: false });
            }
            const percent = params.action === "list" ? undefined : ctx.getContextUsage()?.percent;
            if (params.action === "next") {
                if (params.mode && !params.justification)
                    throw new Error("Mode selection needs a justification");
                return result(await nextSearchStep(project, percent == null ? undefined : percent / 100, params.mode ? { mode: params.mode, justification: params.justification } : undefined, signal));
            }
            const branches = await listBranches(project);
            if (params.action === "list")
                return result({ branches });
            return result({ candidates: assessBranches(branches, percent == null ? undefined : percent / 100), advisory: true, completeEgats: false, automaticPruning: false, equalHorizonsNormalizeTo: 0 });
        },
    });
    pi.registerTool({
        name: "rt_graph", label: "Red-team graph assistance", exposure: "direct", namespace, outputSchema,
        description: "Use when a next action depends on relationships between hosts, services, identities or access prerequisites. Record interpreted evidence-linked relationships; query next steps, chains, severity, provenance or chokepoints through ChainGraph and native Neo4j MCP. Paths are candidates, not exploitation proof. Credential names must be references, never secrets. Workspace filters are not permission isolation.",
        reachesTools: input => [`mcp__${String(input.server ?? "neo4j").replaceAll("-", "_")}`], executionMode: "sequential",
        parameters: Type.Object({
            action: Type.Union([Type.Literal("snapshot"), Type.Literal("record"), Type.Literal("paths"), Type.Literal("query")]), server: Type.Optional(Type.String({ pattern: "^[A-Za-z0-9_-]+$" })),
            query: Type.Optional(Type.Union([Type.Literal("next"), Type.Literal("chains"), Type.Literal("severity"), Type.Literal("evidence"), Type.Literal("chokepoints")])),
            source: Type.Optional(entity), target: Type.Optional(entity),
            link: Type.Optional(Type.Object({ id: Type.String({ minLength: 1, maxLength: 200 }), source: Type.String({ minLength: 1, maxLength: 200 }), target: Type.String({ minLength: 1, maxLength: 200 }), relation: Type.String({ minLength: 1, maxLength: 100 }), state: Type.Union([Type.Literal("observed"), Type.Literal("hypothesis"), Type.Literal("refuted")]), evidenceRefs: Type.Array(text, { maxItems: 20 }), observedAt: Type.String({ format: "date-time" }) })),
            sourceId: Type.Optional(text), targetId: Type.Optional(text), maxAgeSeconds: Type.Optional(Type.Integer({ minimum: 1, maximum: 2592000 })),
        }),
        async execute(_id, params, signal, _onUpdate, ctx) {
            const project = await projectFor(ctx);
            const server = params.server ?? "neo4j";
            if (params.action === "record") {
                if (!params.source || !params.target || !params.link)
                    throw new Error("source, target and link are required");
                const input = JSON.parse(JSON.stringify({ source: params.source, target: params.target, link: params.link }));
                return result(await recordLink(project, ctx, server, input, signal));
            }
            const links = await graphSnapshot(project, ctx, server, signal);
            if (params.action === "snapshot")
                return result({ projectScoped: true, permissionIsolation: false, links });
            if (params.action === "query") {
                if (!params.query)
                    throw new Error("query is required");
                return result(reasonGraph(links, params.query, { sourceId: params.sourceId, targetId: params.targetId, maxAgeSeconds: params.maxAgeSeconds }));
            }
            if (!params.sourceId || !params.targetId)
                throw new Error("sourceId and targetId are required");
            return result(candidatePaths(links, params.sourceId, params.targetId, Date.now(), params.maxAgeSeconds));
        },
    });
    pi.registerTool({
        name: "rt_job", label: "Red-team long job", exposure: "direct", namespace, outputSchema,
        description: "Linux foreground command supervisor: start, list, inspect or cancel. Survives Pi exit in the SAME live container; does not survive container removal or automatically replay. Raw owner-only logs may contain unknown secrets. Use native bash for ordinary commands. No project configuration is needed; set an explicit timeout for long jobs.",
        executionMode: "sequential",
        parameters: Type.Object({ action: Type.Union([Type.Literal("start"), Type.Literal("list"), Type.Literal("status"), Type.Literal("cancel"), Type.Literal("read")]),
            id: Type.Optional(Type.String({ format: "uuid" })), command: Type.Optional(Type.String({ minLength: 1, maxLength: 8192 })),
            timeoutSeconds: Type.Optional(Type.Integer({ minimum: 1, maximum: 2592000 })), maxOutputBytes: Type.Optional(Type.Integer({ minimum: 1024, maximum: 1024 * 1024 * 1024 })),
            requestId: Type.Optional(Type.String({ format: "uuid" })), attemptId: Type.Optional(Type.String({ format: "uuid" })), cursor: Type.Optional(Type.String({ maxLength: 100 })), maxBytes: Type.Optional(Type.Integer({ minimum: 4, maximum: 65536 })),
            resourceClass: Type.Optional(Type.Union([Type.Literal("standard"), Type.Literal("heavy")], { description: "Declared resource class; unknown defaults to heavy during a team run. Not command classification or a sandbox." })),
        }),
        async execute(_id, params, signal, _onUpdate, ctx) {
            signal?.throwIfAborted();
            if (params.action === "start") {
                const project = await projectFor(ctx);
                if (!params.command)
                    throw new Error("command is required");
                const attemptId = params.attemptId ?? currentAttempt(ctx);
                const attempt = attemptId ? await searchAttempt(project, attemptId) : null;
                if (attemptId && (!attempt || attempt.phase !== "active" || !currentAttempt(ctx) || currentAttempt(ctx) !== attemptId))
                    throw new Error("Job attempt is not the declared active attempt");
                return result(await startJob(project, { command: params.command, timeoutSeconds: params.timeoutSeconds, maxOutputBytes: params.maxOutputBytes, requestId: params.requestId, resourceClass: params.resourceClass, ...(attempt ? { attemptId: attempt.attemptId, branchId: attempt.branchId } : {}), sessionId: ctx.sessionManager.getSessionId() }, signal));
            }
            const workspace = await projectFor(ctx);
            if (params.action === "list")
                return result(await listJobs(workspace));
            if (!params.id)
                throw new Error("id is required");
            if (params.action === "read")
                return result(await readJobOutput(workspace, params.id, params.cursor, params.maxBytes));
            return result(params.action === "cancel" ? await cancelJob(workspace, params.id, signal) : await jobStatus(workspace, params.id));
        },
    });
}
