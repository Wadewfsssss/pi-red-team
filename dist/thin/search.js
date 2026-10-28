import { z } from "redteam-zod";
import { mutateState, projectKey, readState } from "./state.js";
import { digest } from "../files.js";
import { randomUUID } from "node:crypto";
export const scoringVersion = "tda-evidence-v2";
export const searchPolicy = "project-conservative-suspend";
const unit = z.number().min(0).max(1);
const identifier = z.string().regex(/^[A-Za-z0-9_-]{1,80}$/);
const status = z.enum(["active", "suspended", "confirmed", "refuted", "exhausted"]);
const rubric = { verified: 1, confirmed: 0.8, plausible: 0.5, speculative: 0.3 };
const evidence = z.object({ reference: z.string().min(1).max(500), confidence: unit.optional(), category: z.enum(["verified", "confirmed", "plausible", "speculative"]).optional(), applicable: z.boolean().default(true), reason: z.string().max(2000).optional() }).strict().superRefine((entry, ctx) => {
    if (entry.confidence === undefined && !entry.category)
        ctx.addIssue({ code: "custom", message: "Evidence needs a category or justified confidence" });
    if (entry.category && entry.confidence !== undefined && entry.confidence !== rubric[entry.category])
        ctx.addIssue({ code: "custom", message: "Confidence must match the evidence category rubric" });
}).transform(entry => ({ ...entry, confidence: entry.category ? rubric[entry.category] : entry.confidence }));
const snapshot = z.object({ target: z.string().max(500).optional(), factRefs: z.array(z.string().max(500)).max(100).default([]), credentialRefs: z.array(z.string().max(500)).max(100).default([]), sessionRefs: z.array(z.string().max(500)).max(100).default([]), notes: z.string().max(2000).optional() }).strict();
const branch = z.object({
    id: identifier, parentId: identifier.optional(), title: z.string().min(1).max(500), status,
    remainingSteps: z.number().int().min(0).max(10000), promise: unit,
    evidence: z.array(evidence).max(100), attempts: z.number().int().min(0), successes: z.number().int().min(0),
    feedback: z.array(z.object({ outcome: z.enum(["success", "partial", "failure"]), note: z.string().max(2000), reference: z.string().min(1).max(500), at: z.string(), requestId: z.string().uuid().optional(), fingerprint: z.string().regex(/^[a-f0-9]{64}$/).optional(), referenceSha256: z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict()).max(200),
    updatedAt: z.string(),
    kind: z.enum(["observation", "hypothesis", "action"]).default("hypothesis"), snapshot: snapshot.default({ factRefs: [], credentialRefs: [], sessionRefs: [] }),
    role: z.enum(["initial-root", "target", "pivot", "needs-review"]).optional(),
    readiness: z.enum(["ready", "unknown", "blocked"]).default("ready"),
    prerequisites: z.array(z.string().min(1).max(500)).max(100).default([]),
    assessments: z.array(z.object({ attempt: z.number().int().min(1), tdi: unit, at: z.string(), scoringVersion: z.string().optional() }).strict()).max(32).default([]),
}).strict();
const selection = z.object({ attemptId: z.string().uuid(), decisionId: z.string().uuid(), branchId: identifier, sessionKey: z.string().min(1).max(256), goal: z.string().min(1).max(2000), justification: z.string().max(2000), phase: z.enum(["active", "completed", "interrupted"]), at: z.string() }).strict();
const decisionSchema = z.object({ decisionId: z.string().uuid(), branchId: identifier, revision: z.string(), at: z.string() }).strict();
const schema = z.object({ version: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]), projectKey: z.string(), branches: z.array(branch).max(256), selections: z.array(selection).max(256).default([]), decisions: z.array(decisionSchema).max(64).default([]) }).strict();
export const branchInput = branch.pick({ id: true, parentId: true, title: true, status: true, remainingSteps: true, promise: true, evidence: true, kind: true, snapshot: true, role: true, readiness: true, prerequisites: true });
const initial = (project) => ({ version: 4, projectKey: projectKey(project), branches: [], selections: [], decisions: [] });
function check(project, state) {
    if (state.version !== 4) {
        for (const entry of state.branches)
            entry.role ??= entry.parentId ? "target" : "needs-review";
        state.version = 4;
        state.projectKey = projectKey(project);
    }
    if (state.projectKey !== projectKey(project))
        throw new Error("Search state belongs to a different working directory");
    const ids = new Set(state.branches.map(entry => entry.id));
    if (ids.size !== state.branches.length)
        throw new Error("Duplicate search branch");
    for (const entry of state.branches) {
        if (entry.successes > entry.attempts)
            throw new Error("Invalid success count");
        if (entry.role === "initial-root" && (entry.parentId || entry.evidence.length))
            throw new Error("Initial root must have no parent or evidence");
        const seen = new Set([entry.id]);
        let parent = entry.parentId;
        while (parent) {
            if (!ids.has(parent) || seen.has(parent))
                throw new Error("Invalid search tree ancestry");
            seen.add(parent);
            parent = state.branches.find(candidate => candidate.id === parent)?.parentId;
        }
    }
}
export async function upsertBranch(project, input, signal) {
    const parsed = branchInput.parse(input);
    return mutateState(project, project.searchStatePath ?? "branches.json", schema, () => initial(project), state => {
        check(project, state);
        const existing = state.branches.find(entry => entry.id === parsed.id);
        if (existing && existing.parentId !== parsed.parentId)
            throw new Error("Existing branch parent cannot change");
        if (parsed.parentId && !state.branches.some(entry => entry.id === parsed.parentId))
            throw new Error("Parent branch does not exist");
        if (parsed.parentId === parsed.id)
            throw new Error("Branch cannot parent itself");
        const updated = { ...parsed, role: input.role ?? existing?.role ?? "target", readiness: input.readiness ?? existing?.readiness ?? parsed.readiness, prerequisites: input.prerequisites ?? existing?.prerequisites ?? parsed.prerequisites, kind: input.kind ?? existing?.kind ?? parsed.kind, snapshot: input.snapshot ? parsed.snapshot : existing?.snapshot ?? parsed.snapshot, attempts: existing?.attempts ?? 0, successes: existing?.successes ?? 0, feedback: existing?.feedback ?? [], assessments: existing?.assessments ?? [], updatedAt: new Date().toISOString() };
        if (existing)
            Object.assign(existing, updated);
        else
            state.branches.push(updated);
        check(project, state);
        return updated;
    }, signal);
}
export async function recordFeedback(project, input, signal) {
    const parsed = z.object({ id: identifier, outcome: z.enum(["success", "partial", "failure"]), note: z.string().max(2000), reference: z.string().min(1).max(500), pivot: branchInput.optional(), requestId: z.string().uuid().optional(), attemptId: z.string().uuid().optional(), referenceSha256: z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict().parse(input);
    if (parsed.attemptId && !parsed.requestId)
        throw new Error("Bound feedback requires requestId");
    return mutateState(project, project.searchStatePath ?? "branches.json", schema, () => initial(project), state => {
        check(project, state);
        const target = state.branches.find(entry => entry.id === parsed.id);
        if (!target)
            throw new Error("Unknown branch");
        if (parsed.requestId) {
            const previous = state.branches.flatMap(entry => entry.feedback).find(entry => entry.requestId === parsed.requestId);
            if (previous) {
                if (!target.feedback.includes(previous) || (previous.fingerprint ? previous.fingerprint !== digest(JSON.stringify(parsed)) : previous.outcome !== parsed.outcome || previous.note !== parsed.note || previous.reference !== parsed.reference || !!parsed.pivot))
                    throw new Error("Feedback request was reused with different content");
                return target;
            }
            if (target.feedback.length >= 200)
                throw new Error("Scoped feedback limit reached; preserve idempotency before archiving");
        }
        const attempt = parsed.attemptId ? state.selections.find(entry => entry.attemptId === parsed.attemptId) : undefined;
        if (parsed.attemptId && (!attempt || attempt.branchId !== parsed.id || attempt.phase !== "active"))
            throw new Error("Attempt is not active for this branch; do not count it again");
        if (parsed.pivot && (parsed.outcome !== "success" || state.branches.some(entry => entry.id === parsed.pivot.id) || (parsed.pivot.parentId && parsed.pivot.parentId !== target.id)))
            throw new Error("A new pivot requires successful evidence-linked feedback and the current branch as parent");
        target.feedback.push({ outcome: parsed.outcome, note: parsed.note, reference: parsed.reference, at: new Date().toISOString(), ...(parsed.referenceSha256 ? { referenceSha256: parsed.referenceSha256 } : {}), ...(parsed.requestId ? { requestId: parsed.requestId, fingerprint: digest(JSON.stringify(parsed)) } : {}) });
        target.feedback = target.feedback.slice(-200);
        const reward = { success: 1, partial: 0.5, failure: 0.1 }[parsed.outcome];
        let current = target;
        while (current) {
            current.attempts += 1;
            if (parsed.outcome === "success")
                current.successes += 1;
            current.promise = 0.7 * current.promise + 0.3 * reward;
            current.updatedAt = new Date().toISOString();
            current = state.branches.find(entry => entry.id === current?.parentId);
        }
        if (parsed.pivot)
            state.branches.push({ ...parsed.pivot, parentId: target.id, attempts: 0, successes: 0, feedback: [], assessments: [], updatedAt: new Date().toISOString() });
        if (attempt)
            attempt.phase = "completed";
        check(project, state);
        return target;
    }, signal);
}
export async function listBranches(project) {
    const state = await readState(project, project.searchStatePath ?? "branches.json", schema, () => initial(project));
    check(project, state);
    return state.branches;
}
export function assessBranches(branches, contextLoad) {
    if (contextLoad !== undefined)
        unit.parse(contextLoad);
    const active = branches.filter(entry => {
        if (entry.status !== "active" || entry.role === "initial-root" || entry.readiness === "blocked")
            return false;
        const seen = new Set([entry.id]);
        let parent = branches.find(candidate => candidate.id === entry.parentId);
        while (parent) {
            if (seen.has(parent.id))
                throw new Error("Cyclic search tree");
            if (["suspended", "refuted", "exhausted"].includes(parent.status) || parent.readiness === "blocked")
                return false;
            seen.add(parent.id);
            parent = branches.find(candidate => candidate.id === parent?.parentId);
        }
        return true;
    });
    const horizons = active.map(entry => entry.remainingSteps);
    const minimum = Math.min(...horizons), maximum = Math.max(...horizons);
    const total = branches.filter(entry => !entry.parentId).reduce((sum, entry) => sum + entry.attempts, 0);
    return active.map(entry => {
        const path = [];
        const seen = new Set();
        let current = entry;
        while (current) {
            if (seen.has(current.id))
                throw new Error("Cyclic search tree");
            seen.add(current.id);
            path.push(current);
            current = branches.find(candidate => candidate.id === current?.parentId);
        }
        const pathEvidence = path.flatMap(candidate => candidate.evidence);
        const scoredPath = path.filter(candidate => candidate.role !== "initial-root");
        const missing = scoredPath.filter(candidate => candidate.role === "needs-review" || candidate.readiness === "unknown" || !candidate.evidence.some(item => item.applicable !== false));
        const confidence = missing.length || !scoredPath.length ? null : scoredPath.reduce((sum, candidate) => sum + Math.max(...candidate.evidence.filter(item => item.applicable !== false).map(item => item.confidence)), 0) / scoredPath.length;
        const horizon = maximum === minimum ? 0 : (entry.remainingSteps - minimum) / (maximum - minimum);
        const successRate = (entry.successes + 1) / (entry.attempts + 2);
        const tdi = contextLoad === undefined || confidence === null ? null : 0.3 * horizon + 0.3 * (1 - confidence) + 0.2 * contextLoad + 0.2 * (1 - successRate);
        const ucb = tdi === null ? null : entry.promise + Math.SQRT2 * Math.sqrt(Math.log(total + 1) / Math.max(1, entry.attempts)) - 0.5 * tdi;
        return {
            id: entry.id, title: entry.title, tdi, ucb,
            signals: { horizon, evidence: confidence, context: contextLoad ?? null, successRate },
            suggestedMode: tdi === null ? "inspect-context" : tdi > 0.6 ? "explore" : tdi < 0.3 ? "advance" : "agent-decides",
            suspendCandidate: tdi !== null && tdi > 0.8 && entry.attempts >= 3,
            attempts: entry.attempts, recentFeedback: entry.feedback.slice(-3), evidence: pathEvidence,
            scoringVersion, policy: searchPolicy, missing: missing.map(candidate => candidate.id), prerequisites: entry.prerequisites,
            scoring: pathEvidence.some(item => !item.category) ? "custom" : "table-12", explanation: { promise: entry.promise, exploration: Math.SQRT2 * Math.sqrt(Math.log(total + 1) / Math.max(1, entry.attempts)), zeroVisits: "ln(N+1)/max(1,Nn)", evidence: "strongest-applicable-per-node; initial-root-excluded" },
        };
    }).sort((left, right) => (right.ucb ?? -Infinity) - (left.ucb ?? -Infinity) || left.id.localeCompare(right.id));
}
export async function nextSearchStep(project, contextLoad, decision, signal) {
    if (decision)
        z.object({ mode: z.enum(["explore", "advance"]), justification: z.string().min(1).max(2000) }).strict().parse(decision);
    return mutateState(project, project.searchStatePath ?? "branches.json", schema, () => initial(project), state => {
        check(project, state);
        const assessments = assessBranches(state.branches, contextLoad);
        const suspended = [];
        for (const assessment of assessments) {
            const current = state.branches.find(entry => entry.id === assessment.id);
            if (assessment.tdi === null)
                continue;
            const history = current.assessments.filter(entry => entry.scoringVersion === scoringVersion);
            if (current.attempts > 0 && history.at(-1)?.attempt !== current.attempts)
                current.assessments.push({ attempt: current.attempts, tdi: assessment.tdi, at: new Date().toISOString(), scoringVersion });
            current.assessments = current.assessments.slice(-32);
            const recent = current.assessments.filter(entry => entry.scoringVersion === scoringVersion).slice(-3);
            if (assessment.tdi > 0.8 && current.attempts >= 3 && recent.length === 3 && recent.every(entry => entry.tdi > 0.8)) {
                current.status = "suspended";
                suspended.push(current.id);
            }
        }
        const candidates = assessBranches(state.branches, contextLoad);
        const selected = candidates.find(entry => entry.ucb !== null);
        if (!selected)
            return { selected: null, suspended, done: candidates.length === 0, goalCompletionEvaluated: false, taskSuccess: "not-evaluated", reason: "No scored executable candidate; not proof of task completion. Review evidence, prerequisites, root roles or context", needsReview: candidates, automaticExecution: false };
        const path = [];
        let current = state.branches.find(entry => entry.id === selected.id);
        while (current) {
            path.unshift(current);
            current = state.branches.find(entry => entry.id === current?.parentId);
        }
        const mode = selected.suggestedMode === "agent-decides" ? decision?.mode ?? "decision-required" : selected.suggestedMode;
        const decisionId = randomUUID();
        state.decisions.push({ decisionId, branchId: selected.id, revision: digest(JSON.stringify(state.branches)), at: new Date().toISOString() });
        state.decisions = state.decisions.slice(-64);
        return {
            selected, decisionId, scoringVersion, policy: searchPolicy, needsReview: candidates.filter(entry => entry.ucb === null), suspended, done: false, mode, traversal: mode === "explore" ? "breadth-first-recon" : mode === "advance" ? "depth-first-action" : null,
            decisionRequired: mode === "decision-required", justification: selected.suggestedMode === "agent-decides" ? decision?.justification ?? null : null,
            path: path.map(entry => ({ id: entry.id, kind: entry.kind, title: entry.title, snapshot: entry.snapshot, evidence: entry.evidence, feedback: entry.feedback.slice(-1) })),
            siblings: state.branches.filter(entry => entry.id !== selected.id && entry.parentId === path.at(-1)?.parentId).slice(0, 3).map(entry => ({ id: entry.id, status: entry.status, title: entry.title, feedback: entry.feedback.slice(-1) })),
            automaticExecution: false,
        };
    }, signal);
}
export async function selectSearchBranch(project, input, signal) {
    const parsed = selection.pick({ branchId: true, decisionId: true, sessionKey: true, goal: true, justification: true }).parse(input);
    return mutateState(project, project.searchStatePath ?? "branches.json", schema, () => initial(project), state => {
        check(project, state);
        const existing = state.selections.find(entry => entry.sessionKey === parsed.sessionKey && entry.decisionId === parsed.decisionId);
        if (existing) {
            if (existing.branchId !== parsed.branchId || existing.goal !== parsed.goal || existing.justification !== parsed.justification)
                throw new Error("Decision reused with different selection");
            return existing;
        }
        const decision = state.decisions.find(entry => entry.decisionId === parsed.decisionId);
        if (!decision || decision.revision !== digest(JSON.stringify(state.branches)))
            throw new Error("Decision is stale; run next again");
        if (decision.branchId !== parsed.branchId && !parsed.justification.trim())
            throw new Error("Override requires justification");
        const selected = state.branches.find(entry => entry.id === parsed.branchId);
        if (!selected || ["initial-root", "needs-review"].includes(selected.role ?? "target") || selected.status !== "active" || selected.readiness !== "ready")
            throw new Error("Branch is not ready and active");
        let ancestor = selected;
        while (ancestor.parentId) {
            ancestor = state.branches.find(entry => entry.id === ancestor.parentId);
            if (["suspended", "refuted", "exhausted"].includes(ancestor.status) || ancestor.readiness === "blocked")
                throw new Error("Branch ancestor blocks execution");
        }
        if (state.selections.some(entry => entry.sessionKey === parsed.sessionKey && entry.phase === "active"))
            throw new Error("Finish or interrupt the current attempt before switching");
        if (state.selections.length >= 256)
            throw new Error("Attempt ledger is full; archive explicitly without losing idempotency");
        const entry = { ...parsed, attemptId: randomUUID(), phase: "active", at: new Date().toISOString() };
        state.selections.push(entry);
        return entry;
    }, signal);
}
export async function searchAttempt(project, attemptId) {
    z.string().uuid().parse(attemptId);
    const state = await readState(project, project.searchStatePath ?? "branches.json", schema, () => initial(project));
    check(project, state);
    return state.selections.find(entry => entry.attemptId === attemptId) ?? null;
}
export async function interruptSearchAttempt(project, attemptId, sessionKey, signal) {
    return mutateState(project, project.searchStatePath ?? "branches.json", schema, () => initial(project), state => {
        check(project, state);
        const entry = state.selections.find(item => item.attemptId === attemptId && item.sessionKey === sessionKey);
        if (!entry)
            throw new Error("Attempt does not belong to this session branch");
        if (entry.phase === "active")
            entry.phase = "interrupted";
        return entry;
    }, signal);
}
export async function reviewSearchBranches(project, references) {
    z.array(z.string().min(1).max(500)).min(1).max(100).parse(references);
    return (await listBranches(project)).filter(entry => entry.status === "suspended" && [...entry.prerequisites, ...entry.snapshot.factRefs, ...entry.snapshot.credentialRefs, ...entry.snapshot.sessionRefs, ...entry.evidence.map(item => item.reference)].some(reference => references.includes(reference))).map(entry => ({ id: entry.id, title: entry.title, prerequisites: entry.prerequisites, evidence: entry.evidence, reactivation: "Model must confirm changed prerequisites and explicitly upsert active; history is retained" }));
}
