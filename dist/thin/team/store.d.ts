import { z } from "redteam-zod";
import { type DomainProject } from "../state.js";
import { type TeamLimits } from "./limits.js";
import type { GraphAccess } from "../graph-capability.js";
declare const leaseSchema: z.ZodObject<{
    runId: z.ZodString;
    epoch: z.ZodNumber;
    workItemId: z.ZodString;
    workerId: z.ZodString;
    leaseVersion: z.ZodNumber;
}, z.core.$strict>;
export type WorkLease = z.infer<typeof leaseSchema>;
export declare const teamStateSchema: z.ZodObject<{
    version: z.ZodUnion<readonly [z.ZodLiteral<1>, z.ZodLiteral<2>]>;
    workspaceKey: z.ZodString;
    runId: z.ZodString;
    epoch: z.ZodNumber;
    revision: z.ZodNumber;
    phase: z.ZodEnum<{
        running: "running";
        paused: "paused";
        stopped: "stopped";
    }>;
    goal: z.ZodString;
    deadline: z.ZodNumber;
    workers: z.ZodArray<z.ZodString>;
    tasks: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        title: z.ZodString;
        targetRef: z.ZodString;
        operation: z.ZodString;
        preconditionHash: z.ZodString;
        key: z.ZodString;
        status: z.ZodEnum<{
            ready: "ready";
            completed: "completed";
            claimed: "claimed";
            uncertain: "uncertain";
        }>;
        owner: z.ZodNullable<z.ZodString>;
        leaseVersion: z.ZodNumber;
        leaseUntil: z.ZodNullable<z.ZodNumber>;
        claimRequestId: z.ZodNullable<z.ZodString>;
        resultId: z.ZodNullable<z.ZodString>;
    }, z.core.$strict>>;
    records: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        requestId: z.ZodString;
        fingerprint: z.ZodString;
        eventSeq: z.ZodNumber;
        workerId: z.ZodString;
        workItemId: z.ZodString;
        leaseVersion: z.ZodNumber;
        kind: z.ZodEnum<{
            OBSERVED: "OBSERVED";
            HYPOTHESIS: "HYPOTHESIS";
            FAIL: "FAIL";
            RESULT: "RESULT";
        }>;
        summary: z.ZodString;
        path: z.ZodString;
        sha256: z.ZodString;
    }, z.core.$strict>>;
    limits: z.ZodOptional<z.ZodObject<{
        maxWorkers: z.ZodDefault<z.ZodNumber>;
        maxWorkerAdmissions: z.ZodDefault<z.ZodNumber>;
        maxResidentWorkers: z.ZodDefault<z.ZodNumber>;
        maxRunningWorkers: z.ZodDefault<z.ZodNumber>;
        maxConcurrentStarts: z.ZodDefault<z.ZodNumber>;
        initialWorkers: z.ZodDefault<z.ZodNumber>;
        maxConcurrentJobs: z.ZodDefault<z.ZodNumber>;
        maxHeavyJobs: z.ZodDefault<z.ZodNumber>;
        targetConcurrency: z.ZodDefault<z.ZodNumber>;
    }, z.core.$strict>>;
    admissions: z.ZodDefault<z.ZodNumber>;
    deliveries: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodNumber>>;
    graphRequests: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodNumber>>;
    graphAccess: z.ZodOptional<z.ZodObject<{
        mode: z.ZodEnum<{
            auto: "auto";
            off: "off";
        }>;
        server: z.ZodString;
        read: z.ZodBoolean;
        write: z.ZodBoolean;
        reason: z.ZodString;
    }, z.core.$strict>>;
    graphResults: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodObject<{
        requestedAt: z.ZodNumber;
        epoch: z.ZodNumber;
        status: z.ZodEnum<{
            unavailable: "unavailable";
            cancelled: "cancelled";
            failed: "failed";
            timeout: "timeout";
            updated: "updated";
        }>;
        reason: z.ZodString;
    }, z.core.$strict>>>;
    jobWaits: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodEnum<{
        standard: "standard";
        heavy: "heavy";
    }>>>;
    recordSequence: z.ZodDefault<z.ZodNumber>;
    recordArchives: z.ZodDefault<z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        first: z.ZodNumber;
        last: z.ZodNumber;
        count: z.ZodNumber;
    }, z.core.$strict>>>;
    taskArchives: z.ZodDefault<z.ZodArray<z.ZodString>>;
}, z.core.$strict>;
export type TeamState = z.infer<typeof teamStateSchema>;
export declare function availableWork(state: TeamState, workerId?: string): {
    id: string;
    title: string;
    targetRef: string;
    operation: string;
    preconditionHash: string;
    key: string;
    status: "ready" | "completed" | "claimed" | "uncertain";
    owner: string | null;
    leaseVersion: number;
    leaseUntil: number | null;
    claimRequestId: string | null;
    resultId: string | null;
}[];
export declare const offerSchema: z.ZodObject<{
    title: z.ZodString;
    targetRef: z.ZodString;
    operation: z.ZodString;
    preconditionHash: z.ZodString;
}, z.core.$strict>;
declare const publicationSchema: z.ZodObject<{
    requestId: z.ZodString;
    kind: z.ZodEnum<{
        OBSERVED: "OBSERVED";
        HYPOTHESIS: "HYPOTHESIS";
        FAIL: "FAIL";
        RESULT: "RESULT";
    }>;
    summary: z.ZodString;
    preconditionHash: z.ZodString;
    evidenceRefs: z.ZodArray<z.ZodString>;
}, z.core.$strict>;
export type Publication = z.infer<typeof publicationSchema>;
export declare function readTeam(project: DomainProject): Promise<TeamState | undefined>;
export declare function createTeam(project: DomainProject, input: {
    goal: string;
    workerCount?: number;
    windowSeconds?: number;
    limits?: TeamLimits;
}, now?: number): Promise<TeamState>;
export declare function admitWorker(project: DomainProject, runId: string): Promise<string>;
export declare function fenceWorker(project: DomainProject, runId: string, workerId: string): Promise<void>;
export declare function recordDelivery(project: DomainProject, runId: string, workerId: string, through: number): Promise<{
    deliveredThrough: number;
    findingsConfirmed: boolean;
}>;
export declare function requestGraphRefresh(project: DomainProject, runId: string, workerId: string): Promise<{
    status: string;
    reason: string;
    graphUpdated: boolean;
    instruction: string;
    requestedAt?: undefined;
    noAutomaticCypher?: undefined;
} | {
    graphUpdated: boolean;
    instruction: string;
    requestedAt: number;
    epoch: number;
    status: "unavailable" | "cancelled" | "failed" | "timeout" | "updated";
    reason: string;
    noAutomaticCypher?: undefined;
} | {
    requestedAt: number;
    graphUpdated: boolean;
    noAutomaticCypher: boolean;
    status?: undefined;
    reason?: undefined;
    instruction?: undefined;
}>;
export declare function setGraphAccess(project: DomainProject, runId: string, access: GraphAccess): Promise<void>;
export declare function settleGraphRequests(project: DomainProject, runId: string, epoch: number, requests: Record<string, number>, status: "updated" | "unavailable" | "failed" | "cancelled" | "timeout", reason: string): Promise<boolean>;
export declare function fulfillGraphRefresh(project: DomainProject, runId: string, capturedAt: number): Promise<void>;
export declare function setJobWait(project: DomainProject, runId: string, workerId: string, resourceClass?: "standard" | "heavy"): Promise<void>;
export declare function offerWork(project: DomainProject, runId: string, input: z.infer<typeof offerSchema>, now?: number): Promise<{
    created: boolean;
    task: {
        id: string;
        title: string;
        targetRef: string;
        operation: string;
        preconditionHash: string;
        key: string;
        status: "ready" | "completed" | "claimed" | "uncertain";
        owner: string | null;
        leaseVersion: number;
        leaseUntil: number | null;
        claimRequestId: string | null;
        resultId: string | null;
    };
    archived?: undefined;
} | {
    created: boolean;
    task: {
        id: string;
        title: string;
        targetRef: string;
        operation: string;
        preconditionHash: string;
        key: string;
        status: "ready" | "completed" | "claimed" | "uncertain";
        owner: string | null;
        leaseVersion: number;
        leaseUntil: number | null;
        claimRequestId: string | null;
        resultId: string | null;
    };
    archived: boolean;
}>;
export declare function claimWork(project: DomainProject, input: {
    runId: string;
    workerId: string;
    workItemId: string;
    requestId: string;
}, now?: number): Promise<{
    claimed: boolean;
    reason: string;
    lease: null;
} | {
    claimed: boolean;
    reason: string;
    lease: {
        runId: string;
        epoch: number;
        workItemId: string;
        workerId: string;
        leaseVersion: number;
    };
}>;
export declare function renewWork(project: DomainProject, lease: WorkLease, now?: number): Promise<{
    renewed: boolean;
    leaseUntil: number;
}>;
export declare function validateWork(project: DomainProject, lease: WorkLease, now?: number): Promise<{
    id: string;
    title: string;
    targetRef: string;
    operation: string;
    preconditionHash: string;
    key: string;
    status: "ready" | "completed" | "claimed" | "uncertain";
    owner: string | null;
    leaseVersion: number;
    leaseUntil: number | null;
    claimRequestId: string | null;
    resultId: string | null;
}>;
export declare function finishTeam(project: DomainProject, runId: string, phase: "paused" | "stopped"): Promise<{
    phase: "paused" | "stopped";
    epoch: number;
    runtimeStopVerified: boolean;
}>;
export declare function resumeTeam(project: DomainProject, runId: string, windowSeconds: number): Promise<{
    version: 1 | 2;
    workspaceKey: string;
    runId: string;
    epoch: number;
    revision: number;
    phase: "running" | "paused" | "stopped";
    goal: string;
    deadline: number;
    workers: string[];
    tasks: {
        id: string;
        title: string;
        targetRef: string;
        operation: string;
        preconditionHash: string;
        key: string;
        status: "ready" | "completed" | "claimed" | "uncertain";
        owner: string | null;
        leaseVersion: number;
        leaseUntil: number | null;
        claimRequestId: string | null;
        resultId: string | null;
    }[];
    records: {
        id: string;
        requestId: string;
        fingerprint: string;
        eventSeq: number;
        workerId: string;
        workItemId: string;
        leaseVersion: number;
        kind: "OBSERVED" | "HYPOTHESIS" | "FAIL" | "RESULT";
        summary: string;
        path: string;
        sha256: string;
    }[];
    admissions: number;
    deliveries: Record<string, number>;
    graphRequests: Record<string, number>;
    graphResults: Record<string, {
        requestedAt: number;
        epoch: number;
        status: "unavailable" | "cancelled" | "failed" | "timeout" | "updated";
        reason: string;
    }>;
    jobWaits: Record<string, "standard" | "heavy">;
    recordSequence: number;
    recordArchives: {
        id: string;
        first: number;
        last: number;
        count: number;
    }[];
    taskArchives: string[];
    limits?: {
        maxWorkers: number;
        maxWorkerAdmissions: number;
        maxResidentWorkers: number;
        maxRunningWorkers: number;
        maxConcurrentStarts: number;
        initialWorkers: number;
        maxConcurrentJobs: number;
        maxHeavyJobs: number;
        targetConcurrency: number;
    } | undefined;
    graphAccess?: {
        mode: "auto" | "off";
        server: string;
        read: boolean;
        write: boolean;
        reason: string;
    } | undefined;
}>;
export declare function reconcileWork(project: DomainProject, runId: string, workItemId: string, status: "ready" | "completed", recordId?: string): Promise<{
    reconciled: boolean;
    conclusionVerified: boolean;
}>;
export declare function releaseWork(project: DomainProject, lease: WorkLease, now?: number): Promise<{
    released: boolean;
}>;
export declare function publishRecord(project: DomainProject, lease: WorkLease, input: Publication, now?: number): Promise<{
    admitted: boolean;
    repeated: boolean;
    record: {
        id: string;
        requestId: string;
        fingerprint: string;
        eventSeq: number;
        workerId: string;
        workItemId: string;
        leaseVersion: number;
        kind: "OBSERVED" | "HYPOTHESIS" | "FAIL" | "RESULT";
        summary: string;
        path: string;
        sha256: string;
    };
    conclusionVerified: boolean;
}>;
export declare function completeWork(project: DomainProject, lease: WorkLease, recordId: string, now?: number): Promise<{
    completed: boolean;
    conclusionVerified: boolean;
}>;
export declare function pauseTeam(project: DomainProject, runId: string): Promise<{
    paused: boolean;
    runtimeStopVerified: boolean;
    epoch: number;
}>;
export declare function readRecords(project: DomainProject, runId: string, after?: number): Promise<{
    records: {
        id: string;
        requestId: string;
        fingerprint: string;
        eventSeq: number;
        workerId: string;
        workItemId: string;
        leaseVersion: number;
        kind: "OBSERVED" | "HYPOTHESIS" | "FAIL" | "RESULT";
        summary: string;
        path: string;
        sha256: string;
    }[];
    nextAfter: number;
    truncated: boolean;
    cursorAdvanced: boolean;
    conclusionVerified: boolean;
}>;
export declare function unfoldRecord(project: DomainProject, runId: string, recordId: string): Promise<{
    evidence: {
        verified: boolean;
        reference: string;
        sha256: string;
    }[];
    evidenceVerified: boolean;
    conclusionVerified: boolean;
    version: 1;
    id: string;
    lease: {
        runId: string;
        epoch: number;
        workItemId: string;
        workerId: string;
        leaseVersion: number;
    };
    publication: {
        requestId: string;
        kind: "OBSERVED" | "HYPOTHESIS" | "FAIL" | "RESULT";
        summary: string;
        preconditionHash: string;
        evidenceRefs: string[];
    };
    capturedAt: number;
}>;
export {};
