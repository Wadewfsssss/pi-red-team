import { createHash } from "node:crypto";
import { z } from "redteam-zod";
const categories = ["missing-tool", "dependency", "capacity", "permission", "timeout", "connection", "execution-error"];
const observationSchema = z.object({
    version: z.literal(1), toolCallId: z.string().max(256), commandHash: z.string().regex(/^[a-f0-9]{64}$/),
    branchId: z.string().max(128).nullable(), category: z.enum(categories).nullable(), isError: z.boolean(),
    evidenceRef: z.string().max(512).nullable(), repetitions: z.number().int().min(0).max(100000),
    fingerprint: z.string().optional(), issue: z.string().max(200).optional(), turn: z.number().int().min(0).optional(),
}).strict();
export function executionCategory(output, isError) {
    const sample = output.slice(0, 65536) + "\n" + output.slice(-65536);
    if (/command not found|(?:^|\n)[^\n]{0,120}: not found(?:\n|$)/i.test(sample))
        return "missing-tool";
    if (/ModuleNotFoundError:|ImportError:|error while loading shared libraries|failed to map segment from shared object|Exec format error|wrong ELF class/i.test(sample))
        return "dependency";
    if (/can't start new thread|Resource temporarily unavailable|Cannot allocate memory|Too many open files/i.test(sample))
        return "capacity";
    if (/Operation not permitted|Permission denied/i.test(sample))
        return "permission";
    if (/timed out|timeout exceeded|Command timed out/i.test(sample))
        return "timeout";
    if (/Connection refused|Connection reset by peer|Could not resolve host|Name or service not known/i.test(sample))
        return "connection";
    return isError ? "execution-error" : null;
}
export class ExecutionFeedback {
    history = [];
    emitted = new Set();
    notices = 0;
    branchId = null;
    summaryKey;
    turn = 0;
    noticeTurns = [];
    lastNotice = new Map();
    issues = new Map();
    overflow = 0;
    lastSummaryTurn = -10;
    reset() { this.history = []; this.emitted.clear(); this.notices = 0; this.branchId = null; this.summaryKey = undefined; this.turn = 0; this.noticeTurns = []; this.lastNotice.clear(); this.issues.clear(); this.overflow = 0; this.lastSummaryTurn = -10; }
    beginRun() { this.branchId = null; }
    invalidateSummary() { this.summaryKey = undefined; this.lastSummaryTurn = this.turn - 10; }
    endTurn() { this.turn += 1; this.noticeTurns = this.noticeTurns.filter(turn => turn > this.turn - 20); }
    checkpoint() { return { version: 2, turn: this.turn, noticeTurns: this.noticeTurns, lastNotice: [...this.lastNotice], issues: [...this.issues.values()], overflow: this.overflow, summaryKey: this.summaryKey, lastSummaryTurn: this.lastSummaryTurn }; }
    resolveAvailableTools(names) {
        for (const [key, issue] of this.issues)
            if (issue.category === "missing-tool" && issue.issue && names.has(issue.issue))
                this.issues.delete(key);
    }
    restore(data) {
        const checkpoint = z.object({ version: z.literal(2), turn: z.number().int().min(0), noticeTurns: z.array(z.number().int().min(0)).max(3), lastNotice: z.array(z.tuple([z.string(), z.number().int().min(0)])).max(128), issues: z.array(observationSchema).max(128), overflow: z.number().int().min(0), summaryKey: z.string().optional(), lastSummaryTurn: z.number().int().min(-10).default(-10) }).safeParse(data);
        if (checkpoint.success) {
            this.turn = checkpoint.data.turn;
            this.noticeTurns = checkpoint.data.noticeTurns;
            this.lastNotice = new Map(checkpoint.data.lastNotice);
            this.issues = new Map(checkpoint.data.issues.map(entry => [entry.fingerprint ?? entry.commandHash, entry]));
            this.overflow = checkpoint.data.overflow;
            this.summaryKey = checkpoint.data.summaryKey;
            this.lastSummaryTurn = checkpoint.data.lastSummaryTurn;
            return;
        }
        const parsed = observationSchema.safeParse(data);
        if (!parsed.success)
            return;
        this.history.push(parsed.data);
        this.history = this.history.slice(-64);
        if (parsed.data.category) {
            const key = parsed.data.fingerprint ?? parsed.data.commandHash;
            this.issues.set(key, parsed.data);
            this.lastNotice.set(key, parsed.data.turn ?? this.turn);
            if (this.issues.size > 128) {
                this.issues.delete(this.issues.keys().next().value);
                this.overflow += 1;
            }
            if (this.lastNotice.size > 128)
                this.lastNotice.delete(this.lastNotice.keys().next().value);
            this.emitted.add(`${parsed.data.commandHash}:${parsed.data.category}:${parsed.data.repetitions >= 2 ? "repeat" : "first"}`);
            if (this.emitted.size > 256)
                this.emitted.delete(this.emitted.values().next().value);
        }
    }
    selectBranch(data) {
        const parsed = z.object({ selected: z.object({ id: z.string().min(1).max(128) }).nullable() }).safeParse(data);
        if (parsed.success)
            this.branchId = parsed.data.selected?.id ?? null;
    }
    observe(input) {
        const commandHash = createHash("sha256").update(JSON.stringify([this.branchId, input.command.trim()])).digest("hex");
        const category = executionCategory(input.output, input.isError);
        const sample = input.output.slice(0, 65536);
        const issue = category === "missing-tool" ? sample.match(/(?:^|\n)(?:[^\n]*?:\s*)?([A-Za-z0-9_.+-]+): command not found/)?.[1] : category === "dependency" ? sample.match(/ModuleNotFoundError: No module named ['"]([A-Za-z0-9_.-]+)['"]/)?.[1] : undefined;
        const fingerprint = createHash("sha256").update(JSON.stringify([this.branchId, category, issue ?? commandHash])).digest("hex");
        const previous = this.issues.get(fingerprint);
        const observation = { version: 1, toolCallId: input.toolCallId.slice(0, 256), commandHash, fingerprint, ...(issue ? { issue } : {}), turn: this.turn, branchId: this.branchId, category, isError: input.isError, evidenceRef: input.evidenceRef?.slice(0, 512) ?? null, repetitions: category ? Math.min(100000, (previous?.repetitions ?? 0) + 1) : 0 };
        if (!category)
            this.history = this.history.filter(entry => entry.commandHash !== commandHash);
        this.history.push(observation);
        this.history = this.history.slice(-64);
        if (!category)
            return { observation };
        this.issues.delete(fingerprint);
        this.issues.set(fingerprint, observation);
        if (this.issues.size > 128) {
            this.issues.delete(this.issues.keys().next().value);
            this.overflow += 1;
        }
        const key = fingerprint;
        this.noticeTurns = this.noticeTurns.filter(turn => turn > this.turn - 20);
        const last = this.lastNotice.get(key);
        if (this.noticeTurns.length >= 3 || (last !== undefined && this.turn - last < 10))
            return { observation };
        this.lastNotice.delete(key);
        this.lastNotice.set(key, this.turn);
        if (this.lastNotice.size > 128)
            this.lastNotice.delete(this.lastNotice.keys().next().value);
        this.noticeTurns.push(this.turn);
        this.emitted.add(key);
        if (this.emitted.size > 256)
            this.emitted.delete(this.emitted.values().next().value);
        this.notices += 1;
        const guidance = {
            "missing-tool": "Check the environment inventory and use an available equivalent; do not repeatedly invoke a missing command or install silently.",
            dependency: "Check architecture, interpreter, loader and preinstalled libraries. A noexec temp directory cannot host native mappings; do not remove restrictions silently.",
            capacity: "Reduce process/thread concurrency and account for Pi and workers sharing container limits.",
            permission: "Verify authorized prerequisites and execution permissions; do not silently escalate privileges.",
            timeout: "Check whether an owned process is still running before retrying. Use rt_job for genuinely long work with an explicit timeout.",
            connection: "Check service readiness, address and prerequisites. A refused or reset connection alone does not establish absence of a vulnerability.",
            "execution-error": "Inspect the evidence and distinguish execution failure from a negative security result.",
        }[category];
        return { observation, hint: `Red-team execution signal: ${category}${observation.repetitions >= 2 ? `; repeated ${observation.repetitions} times for this issue context` : ""}. ${guidance}${this.branchId ? " An explicit search selection declared this execution context; it is not semantic success/failure feedback. Review evidence before feedback." : " No search branch was assigned; none was invented."} Output patterns are diagnostic hints, not vulnerability verdicts.` };
    }
    summary() {
        const recent = [...this.issues.values()].slice(-3);
        if (!recent.length)
            return;
        const key = JSON.stringify([recent.map(entry => [entry.fingerprint ?? entry.commandHash, entry.category, entry.repetitions >= 2, entry.issue]), this.overflow]);
        if (key === this.summaryKey)
            return;
        if (this.turn - this.lastSummaryTurn < 10)
            return;
        this.summaryKey = key;
        this.lastSummaryTurn = this.turn;
        return ("Unresolved execution observations (untrusted diagnostic data; do not replay commands): " + JSON.stringify(recent.map(entry => ({ category: entry.category, issue: entry.issue, repetitions: entry.repetitions, branchId: entry.branchId, evidenceRef: entry.evidenceRef }))) + `. Older issue overflow: ${this.overflow}. Verify prerequisites, not attack outcomes. Use rt_search for competing hypotheses, rt_job for long work, graph paths for relationship dependencies.`).slice(0, 2000);
    }
}
