import { digest } from "../../files.js";
import { availableWork, claimWork, completeWork, offerWork, publishRecord, readRecords, readTeam, recordDelivery, releaseWork, renewWork, requestGraphRefresh, setJobWait, validateWork, unfoldRecord } from "./store.js";
export function workerStateAdapter(config, domain, assertQuiescent) {
    const project = { cwd: config.cwd };
    const runId = config.teamRunId;
    let lease;
    return async (toolCallId, input) => {
        if (!runId)
            throw new Error("Worker has no team run");
        const state = await readTeam(project);
        if (!state || state.runId !== runId || state.phase !== "running" || !state.workers.includes(config.workerId))
            throw new Error("Worker has no matching active run");
        const hash = digest(JSON.stringify([config.workerId, toolCallId]));
        const requestId = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
        if (input.action === "delivered")
            return recordDelivery(project, runId, config.workerId, input.through);
        if (input.action === "request_graph")
            return requestGraphRefresh(project, runId, config.workerId);
        if (input.action === "notices") {
            const after = state.deliveries[config.workerId] ?? 0;
            const records = boundedPage((await readRecords(project, runId, after)).records.slice(0, 5), 1700);
            return { runId, epoch: state.epoch, records: records.filter(record => record.workerId !== config.workerId).map(record => ({ eventSeq: record.eventSeq, kind: record.kind, summary: record.summary, recordId: record.id, workItemId: record.workItemId })), through: records.at(-1)?.eventSeq ?? after, findingsConfirmed: false };
        }
        if (input.action === "read") {
            const offset = input.candidateAfter ? state.tasks.findIndex(task => task.id === input.candidateAfter) + 1 : 0;
            if (input.candidateAfter && offset === 0)
                throw new Error("Candidate cursor is not in this run; read from the beginning");
            const visible = new Set(availableWork(state, config.workerId).map(task => task.id));
            const eligible = state.tasks.slice(offset).filter(task => visible.has(task.id)).map(task => ({ id: task.id, title: task.title, targetRef: task.targetRef, operation: task.operation, preconditionHash: task.preconditionHash, status: task.status }));
            const candidates = boundedPage(eligible, 5000);
            const after = input.after ?? state.deliveries[config.workerId] ?? 0;
            const page = await readRecords(project, runId, after);
            const records = boundedPage(page.records, 6000);
            return { goal: state.goal.slice(0, 512), goalTruncated: state.goal.length > 512, stateRef: ".redteam/team/state.json", runId, phase: state.phase, epoch: state.epoch, deadline: state.deadline, counts: { total: state.tasks.length, completed: state.tasks.filter(task => task.status === "completed").length, uncertain: state.tasks.filter(task => task.status === "uncertain").length }, candidates, candidatesTruncated: eligible.length > candidates.length, nextCandidateAfter: eligible.length > candidates.length ? candidates.at(-1)?.id : null, claims: state.tasks.filter(task => ["claimed", "uncertain"].includes(task.status)).slice(0, 10).map(task => ({ id: task.id, targetRef: task.targetRef, owner: task.owner, status: task.status })), records, truncated: page.truncated || records.length < page.records.length, nextAfter: records.at(-1)?.eventSeq ?? after, cursorAdvanced: false, conclusionVerified: false };
        }
        if (input.action === "unfold")
            return unfoldRecord(project, runId, input.recordId);
        if (input.action === "offer") {
            const { action: _action, ...offered } = input;
            return offerWork(project, runId, offered);
        }
        if (input.action === "claim") {
            const claimed = await claimWork(project, { runId, workerId: config.workerId, workItemId: input.workItemId, requestId });
            if (claimed.lease)
                lease = claimed.lease;
            return claimed;
        }
        if (!lease)
            throw new Error("Claim work before publishing or changing its state");
        await validateWork(project, lease);
        if (input.action === "validate")
            return { valid: true };
        if (input.action === "domain") {
            if (!domain)
                throw new Error("Worker domain tools are unavailable");
            try {
                const result = await domain(lease, toolCallId, input);
                if (input.tool === "rt_job" && input.params.action === "start" && state.jobWaits[config.workerId])
                    await setJobWait(project, runId, config.workerId);
                return result;
            }
            catch (error) {
                if (input.tool !== "rt_job" || input.params.action !== "start" || !(error instanceof Error) || !/^Global team (heavy )?job slots are full/.test(error.message))
                    throw error;
                await setJobWait(project, runId, config.workerId, input.params.resourceClass === "standard" ? "standard" : "heavy");
                return { phase: "waiting-capacity", reason: error.message, commandReserved: false, noAutomaticReplay: true, instruction: "Return a waiting status; the supervisor continues after capacity is available, then decide whether to start again." };
            }
        }
        if (input.action === "publish")
            return publishRecord(project, lease, { requestId, kind: input.kind, summary: input.summary, preconditionHash: input.preconditionHash, evidenceRefs: input.evidenceRefs });
        await assertQuiescent?.(lease);
        const result = input.action === "complete" ? await completeWork(project, lease, input.recordId) : await releaseWork(project, lease);
        lease = undefined;
        return result;
    };
}
function boundedPage(entries, bytes) {
    const selected = [];
    for (const entry of entries.slice(0, 20)) {
        if (Buffer.byteLength(JSON.stringify([...selected, entry])) > bytes)
            break;
        selected.push(entry);
    }
    return selected;
}
export function renewingWorkerStateAdapter(config, domain, assertQuiescent) {
    const adapter = workerStateAdapter(config, domain, assertQuiescent);
    let current;
    return {
        async invoke(toolCallId, input) {
            const result = await adapter(toolCallId, input);
            if (input.action === "claim" && result && typeof result === "object" && "lease" in result && result.lease)
                current = result.lease;
            if (input.action === "complete" || input.action === "release")
                current = undefined;
            return result;
        },
        async renew() { if (current)
            await renewWork({ cwd: config.cwd }, current); },
    };
}
