import { z } from "redteam-zod";
import type { GraphAccess } from "../graph-capability.js";
import { type DomainProject } from "../state.js";
import { type WorkerConfig, type WorkerReply, type WorkerView } from "./protocol.js";
import { workerDomainAdapter } from "./domain-adapter.js";
export declare const startTeamSchema: z.ZodPipe<z.ZodObject<{
    goal: z.ZodString;
    scope: z.ZodString;
    candidates: z.ZodArray<z.ZodObject<{
        title: z.ZodString;
        targetRef: z.ZodString;
        operation: z.ZodString;
        preconditionHash: z.ZodString;
    }, z.core.$strict>>;
    workerCount: z.ZodOptional<z.ZodNumber>;
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
    windowSeconds: z.ZodDefault<z.ZodNumber>;
    maxRounds: z.ZodDefault<z.ZodNumber>;
    execution: z.ZodDefault<z.ZodBoolean>;
    autoContinue: z.ZodDefault<z.ZodBoolean>;
    maxParentTurns: z.ZodDefault<z.ZodNumber>;
}, z.core.$strict>, z.ZodTransform<{
    limits: {
        maxWorkers: number;
        maxWorkerAdmissions: number;
        maxResidentWorkers: number;
        maxRunningWorkers: number;
        maxConcurrentStarts: number;
        initialWorkers: number;
        maxConcurrentJobs: number;
        maxHeavyJobs: number;
        targetConcurrency: number;
    };
    goal: string;
    scope: string;
    candidates: {
        title: string;
        targetRef: string;
        operation: string;
        preconditionHash: string;
    }[];
    windowSeconds: number;
    maxRounds: number;
    execution: boolean;
    autoContinue: boolean;
    maxParentTurns: number;
    workerCount?: number | undefined;
}, {
    goal: string;
    scope: string;
    candidates: {
        title: string;
        targetRef: string;
        operation: string;
        preconditionHash: string;
    }[];
    windowSeconds: number;
    maxRounds: number;
    execution: boolean;
    autoContinue: boolean;
    maxParentTurns: number;
    workerCount?: number | undefined;
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
}>>;
export type StartTeam = z.input<typeof startTeamSchema>;
export interface TeamWorker {
    current: WorkerView | undefined;
    start(): Promise<WorkerView>;
    prompt(text: string, timeoutMs?: number): Promise<WorkerReply>;
    stop(): Promise<void>;
    onActivity?(listener: (reply: WorkerReply) => void): () => void;
}
type WorkerFactory = (config: WorkerConfig, domain: ReturnType<typeof workerDomainAdapter>) => TeamWorker;
type TeamModel = Pick<WorkerConfig, "provider" | "model" | "thinkingLevel" | "agentDir" | "nativeTools"> & {
    taskKey?: string;
    graphAccess?: GraphAccess;
};
export declare class TeamSupervisor {
    readonly project: DomainProject;
    private readonly notify;
    private readonly factory;
    private workers;
    private checkpoint;
    private releaseOwner;
    private deadline;
    private stopping;
    private running;
    private cancelled;
    private cleanupFinished;
    private writes;
    private preparing;
    private loops;
    private handoffs;
    private signal;
    private executionSlots;
    private startSlots;
    private unsubscribe;
    private scaling;
    private modelConfig;
    private handoffTimer;
    private lastEvidenceSeq;
    private lastGraphRequest;
    private usage;
    private providerErrors;
    private cooldownUntil;
    constructor(project: DomainProject, notify?: (status: unknown) => void, factory?: WorkerFactory);
    private requestStop;
    private acquire;
    private save;
    status(): Promise<{
        activeInThisSession: boolean;
        checkpoint: {
            version: 1 | 2;
            runId: string;
            parentSession: string;
            scope: string;
            provider: string;
            model: string;
            execution: boolean;
            maxRounds: number;
            autoContinue: boolean;
            maxParentTurns: number;
            parentTurns: number;
            lastBatch: string | null;
            deliveredBatch: string | null;
            workers: {
                workerId: string;
                rounds: number;
                phase: string;
                sessionPath?: string | undefined;
                reason?: string | undefined;
                noProgress?: number | undefined;
                reassessments?: number | undefined;
            }[];
            phase: "running" | "paused" | "stopped" | "starting" | "attention";
            reason: string;
            runtimeStopVerified: boolean;
            nativeTools?: ("bash" | "find" | "read" | "write" | "grep" | "ls" | "edit")[] | undefined;
            taskKey?: string | undefined;
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
            workerStopsVerified?: boolean | undefined;
        } | undefined;
        state: {
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
        } | undefined;
        coverageNotes: {
            configured: boolean;
            registeredTargets: number;
            targets: never[];
            advisory: boolean;
            goalCompletionEvaluated: boolean;
            authorizationGranted: boolean;
            truncated?: undefined;
            integrityChecksTruncated?: undefined;
        } | {
            configured: boolean;
            registeredTargets: number;
            targets: {
                id: string;
                targetRef: string;
                suggestedUnexaminedSurfaces: ("Entry points and input handling" | "Authentication and session behavior" | "Authorization and object boundaries" | "Application configuration and exposed functionality" | "Identities and trust boundaries" | "Effective permissions and prerequisites" | "Resource access relationships" | "Credential and session provenance" | "Reachability and service inventory" | "Service configuration and access boundaries" | "Dependencies between systems" | "Evidence-backed path prerequisites" | "Program inputs and execution model" | "Data flow and validation constraints" | "Observed runtime behavior" | "Competing interpretations of program semantics" | "Inputs and outputs" | "Trust boundaries" | "Known prerequisites" | "Alternative explanations")[];
                blocker: string;
                nextStep: string;
            }[];
            truncated: boolean;
            advisory: boolean;
            goalCompletionEvaluated: boolean;
            authorizationGranted: boolean;
            integrityChecksTruncated: boolean;
        } | {
            available: boolean;
            advisory: boolean;
            goalCompletionEvaluated: boolean;
            authorizationGranted: boolean;
        };
        goalCompletionNotImplied: boolean;
        load: {
            capacity: number | undefined;
            admissions: number;
            resident: number;
            executing: number;
            executionLimit: number;
            queued: number;
            waiting: number;
            attention: number;
            requestConcurrencyVerified: boolean;
            providerErrors: number;
            cooldownUntil: number;
            notScalingReason: string;
        };
        usage: {
            scope: string;
            input: number;
            output: number;
            cacheRead: number;
            cacheWrite: number;
            cost: number;
            observations: number;
        } | null;
        capacity: {
            tasks: number;
            taskLimit: number;
            records: number;
            recordLimit: number;
        } | undefined;
        requiresRecovery: boolean;
        actualTokenCost: string;
        configurationRequired: boolean;
    }>;
    private coverageNotes;
    private loadCheckpoint;
    consumeHandoff(runId: string, batch: string, model: {
        provider: string;
        id: string;
    } | undefined): Promise<boolean>;
    start(input: StartTeam, model: TeamModel, parentSession: string, resume?: boolean): Promise<void>;
    private prepare;
    private launch;
    private scheduleScale;
    private scheduleEvidenceHandoff;
    private workerAttention;
    private loop;
    private waitForJobs;
    private waitForGraph;
    private waitForJobCapacity;
    stop(reason?: string, phase?: "paused" | "stopped"): Promise<void>;
    private cleanup;
    recover(): Promise<void>;
}
export {};
