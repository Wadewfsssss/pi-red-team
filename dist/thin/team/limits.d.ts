import { z } from "redteam-zod";
export declare const teamLimitsSchema: z.ZodObject<{
    maxWorkers: z.ZodDefault<z.ZodNumber>;
    maxWorkerAdmissions: z.ZodDefault<z.ZodNumber>;
    maxResidentWorkers: z.ZodDefault<z.ZodNumber>;
    maxRunningWorkers: z.ZodDefault<z.ZodNumber>;
    maxConcurrentStarts: z.ZodDefault<z.ZodNumber>;
    initialWorkers: z.ZodDefault<z.ZodNumber>;
    maxConcurrentJobs: z.ZodDefault<z.ZodNumber>;
    maxHeavyJobs: z.ZodDefault<z.ZodNumber>;
    targetConcurrency: z.ZodDefault<z.ZodNumber>;
}, z.core.$strict>;
export type TeamLimits = z.infer<typeof teamLimitsSchema>;
export declare function resolveTeamLimits(input?: z.input<typeof teamLimitsSchema>, legacyCount?: number): TeamLimits;
export declare class ExecutionSlots {
    limit: number;
    private used;
    private pending;
    constructor(limit: number);
    get active(): number;
    get queued(): number;
    resize(limit: number): void;
    private drain;
    acquire(signal: AbortSignal): Promise<() => void>;
    private releaseOnce;
}
