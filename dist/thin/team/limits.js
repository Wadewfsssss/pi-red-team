import { z } from "redteam-zod";
export const teamLimitsSchema = z.object({
    maxWorkers: z.number().int().min(1).max(64).default(32),
    maxWorkerAdmissions: z.number().int().min(1).max(64).default(64),
    maxResidentWorkers: z.number().int().min(1).max(64).default(4),
    maxRunningWorkers: z.number().int().min(1).max(64).default(4),
    maxConcurrentStarts: z.number().int().min(1).max(8).default(2),
    initialWorkers: z.number().int().min(1).max(64).default(2),
    maxConcurrentJobs: z.number().int().min(1).max(64).default(2),
    maxHeavyJobs: z.number().int().min(1).max(64).default(1),
    targetConcurrency: z.number().int().min(1).max(64).default(1),
}).strict();
export function resolveTeamLimits(input = {}, legacyCount) {
    const limits = teamLimitsSchema.parse({ ...input, ...(legacyCount === undefined ? {} : { maxWorkers: legacyCount }) });
    limits.maxWorkers = Math.min(limits.maxWorkers, limits.maxWorkerAdmissions);
    limits.maxResidentWorkers = Math.min(limits.maxResidentWorkers, limits.maxWorkers);
    limits.maxRunningWorkers = Math.min(limits.maxRunningWorkers, limits.maxResidentWorkers);
    limits.maxConcurrentStarts = Math.min(limits.maxConcurrentStarts, limits.maxResidentWorkers);
    limits.initialWorkers = Math.min(limits.initialWorkers, limits.maxResidentWorkers);
    limits.maxHeavyJobs = Math.min(limits.maxHeavyJobs, limits.maxConcurrentJobs);
    return limits;
}
export class ExecutionSlots {
    limit;
    used = 0;
    pending = [];
    constructor(limit) {
        this.limit = limit;
        if (!Number.isInteger(limit) || limit < 1)
            throw new Error("Invalid execution concurrency");
    }
    get active() { return this.used; }
    get queued() { return this.pending.length; }
    resize(limit) {
        if (!Number.isInteger(limit) || limit < 1)
            throw new Error("Invalid execution concurrency");
        this.limit = limit;
        this.drain();
    }
    drain() {
        while (this.used < this.limit && this.pending.length) {
            const next = this.pending.shift();
            next.signal.removeEventListener("abort", next.abort);
            this.used += 1;
            next.resolve(this.releaseOnce());
        }
    }
    acquire(signal) {
        signal.throwIfAborted();
        if (this.used < this.limit) {
            this.used += 1;
            return Promise.resolve(this.releaseOnce());
        }
        return new Promise((resolve, reject) => {
            const entry = { resolve, reject, signal, abort: () => { this.pending = this.pending.filter(item => item !== entry); reject(new Error("Execution admission cancelled")); } };
            signal.addEventListener("abort", entry.abort, { once: true });
            this.pending.push(entry);
        });
    }
    releaseOnce() {
        let released = false;
        return () => {
            if (released)
                return;
            released = true;
            this.used -= 1;
            this.drain();
        };
    }
}
