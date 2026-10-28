import { z } from "redteam-zod";
import { type DomainProject } from "./state.js";
export declare const scoringVersion = "tda-evidence-v2";
export declare const searchPolicy = "project-conservative-suspend";
declare const branch: z.ZodObject<{
    id: z.ZodString;
    parentId: z.ZodOptional<z.ZodString>;
    title: z.ZodString;
    status: z.ZodEnum<{
        confirmed: "confirmed";
        refuted: "refuted";
        active: "active";
        suspended: "suspended";
        exhausted: "exhausted";
    }>;
    remainingSteps: z.ZodNumber;
    promise: z.ZodNumber;
    evidence: z.ZodArray<z.ZodPipe<z.ZodObject<{
        reference: z.ZodString;
        confidence: z.ZodOptional<z.ZodNumber>;
        category: z.ZodOptional<z.ZodEnum<{
            confirmed: "confirmed";
            verified: "verified";
            plausible: "plausible";
            speculative: "speculative";
        }>>;
        applicable: z.ZodDefault<z.ZodBoolean>;
        reason: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>, z.ZodTransform<{
        confidence: number;
        reference: string;
        applicable: boolean;
        category?: "confirmed" | "verified" | "plausible" | "speculative" | undefined;
        reason?: string | undefined;
    }, {
        reference: string;
        applicable: boolean;
        confidence?: number | undefined;
        category?: "confirmed" | "verified" | "plausible" | "speculative" | undefined;
        reason?: string | undefined;
    }>>>;
    attempts: z.ZodNumber;
    successes: z.ZodNumber;
    feedback: z.ZodArray<z.ZodObject<{
        outcome: z.ZodEnum<{
            success: "success";
            partial: "partial";
            failure: "failure";
        }>;
        note: z.ZodString;
        reference: z.ZodString;
        at: z.ZodString;
        requestId: z.ZodOptional<z.ZodString>;
        fingerprint: z.ZodOptional<z.ZodString>;
        referenceSha256: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>>;
    updatedAt: z.ZodString;
    kind: z.ZodDefault<z.ZodEnum<{
        observation: "observation";
        hypothesis: "hypothesis";
        action: "action";
    }>>;
    snapshot: z.ZodDefault<z.ZodObject<{
        target: z.ZodOptional<z.ZodString>;
        factRefs: z.ZodDefault<z.ZodArray<z.ZodString>>;
        credentialRefs: z.ZodDefault<z.ZodArray<z.ZodString>>;
        sessionRefs: z.ZodDefault<z.ZodArray<z.ZodString>>;
        notes: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>>;
    role: z.ZodOptional<z.ZodEnum<{
        target: "target";
        "initial-root": "initial-root";
        pivot: "pivot";
        "needs-review": "needs-review";
    }>>;
    readiness: z.ZodDefault<z.ZodEnum<{
        ready: "ready";
        unknown: "unknown";
        blocked: "blocked";
    }>>;
    prerequisites: z.ZodDefault<z.ZodArray<z.ZodString>>;
    assessments: z.ZodDefault<z.ZodArray<z.ZodObject<{
        attempt: z.ZodNumber;
        tdi: z.ZodNumber;
        at: z.ZodString;
        scoringVersion: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>>>;
}, z.core.$strict>;
export type Branch = z.infer<typeof branch>;
export declare const branchInput: z.ZodObject<{
    id: z.ZodString;
    status: z.ZodEnum<{
        confirmed: "confirmed";
        refuted: "refuted";
        active: "active";
        suspended: "suspended";
        exhausted: "exhausted";
    }>;
    evidence: z.ZodArray<z.ZodPipe<z.ZodObject<{
        reference: z.ZodString;
        confidence: z.ZodOptional<z.ZodNumber>;
        category: z.ZodOptional<z.ZodEnum<{
            confirmed: "confirmed";
            verified: "verified";
            plausible: "plausible";
            speculative: "speculative";
        }>>;
        applicable: z.ZodDefault<z.ZodBoolean>;
        reason: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>, z.ZodTransform<{
        confidence: number;
        reference: string;
        applicable: boolean;
        category?: "confirmed" | "verified" | "plausible" | "speculative" | undefined;
        reason?: string | undefined;
    }, {
        reference: string;
        applicable: boolean;
        confidence?: number | undefined;
        category?: "confirmed" | "verified" | "plausible" | "speculative" | undefined;
        reason?: string | undefined;
    }>>>;
    kind: z.ZodDefault<z.ZodEnum<{
        observation: "observation";
        hypothesis: "hypothesis";
        action: "action";
    }>>;
    promise: z.ZodNumber;
    title: z.ZodString;
    parentId: z.ZodOptional<z.ZodString>;
    remainingSteps: z.ZodNumber;
    snapshot: z.ZodDefault<z.ZodObject<{
        target: z.ZodOptional<z.ZodString>;
        factRefs: z.ZodDefault<z.ZodArray<z.ZodString>>;
        credentialRefs: z.ZodDefault<z.ZodArray<z.ZodString>>;
        sessionRefs: z.ZodDefault<z.ZodArray<z.ZodString>>;
        notes: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>>;
    role: z.ZodOptional<z.ZodEnum<{
        target: "target";
        "initial-root": "initial-root";
        pivot: "pivot";
        "needs-review": "needs-review";
    }>>;
    readiness: z.ZodDefault<z.ZodEnum<{
        ready: "ready";
        unknown: "unknown";
        blocked: "blocked";
    }>>;
    prerequisites: z.ZodDefault<z.ZodArray<z.ZodString>>;
}, z.core.$strict>;
export type BranchInput = z.input<typeof branchInput>;
export declare function upsertBranch(project: DomainProject, input: BranchInput, signal?: AbortSignal): Promise<unknown>;
export declare function recordFeedback(project: DomainProject, input: {
    id: string;
    outcome: "success" | "partial" | "failure";
    note: string;
    reference: string;
    pivot?: BranchInput;
    requestId?: string;
    attemptId?: string;
    referenceSha256?: string;
}, signal?: AbortSignal): Promise<unknown>;
export declare function listBranches(project: DomainProject): Promise<Branch[]>;
export declare function assessBranches(branches: Branch[], contextLoad: number | undefined): {
    id: string;
    title: string;
    tdi: number | null;
    ucb: number | null;
    signals: {
        horizon: number;
        evidence: number | null;
        context: number | null;
        successRate: number;
    };
    suggestedMode: string;
    suspendCandidate: boolean;
    attempts: number;
    recentFeedback: {
        outcome: "success" | "partial" | "failure";
        note: string;
        reference: string;
        at: string;
        requestId?: string | undefined;
        fingerprint?: string | undefined;
        referenceSha256?: string | undefined;
    }[];
    evidence: {
        confidence: number;
        reference: string;
        applicable: boolean;
        category?: "confirmed" | "verified" | "plausible" | "speculative" | undefined;
        reason?: string | undefined;
    }[];
    scoringVersion: string;
    policy: string;
    missing: string[];
    prerequisites: string[];
    scoring: string;
    explanation: {
        promise: number;
        exploration: number;
        zeroVisits: string;
        evidence: string;
    };
}[];
export declare function nextSearchStep(project: DomainProject, contextLoad: number | undefined, decision?: {
    mode: "explore" | "advance";
    justification: string;
}, signal?: AbortSignal): Promise<unknown>;
export declare function selectSearchBranch(project: DomainProject, input: {
    branchId: string;
    decisionId: string;
    sessionKey: string;
    goal: string;
    justification: string;
}, signal?: AbortSignal): Promise<unknown>;
export declare function searchAttempt(project: DomainProject, attemptId: string): Promise<{
    attemptId: string;
    decisionId: string;
    branchId: string;
    sessionKey: string;
    goal: string;
    justification: string;
    phase: "active" | "completed" | "interrupted";
    at: string;
} | null>;
export declare function interruptSearchAttempt(project: DomainProject, attemptId: string, sessionKey: string, signal?: AbortSignal): Promise<unknown>;
export declare function reviewSearchBranches(project: DomainProject, references: string[]): Promise<{
    id: string;
    title: string;
    prerequisites: string[];
    evidence: {
        confidence: number;
        reference: string;
        applicable: boolean;
        category?: "confirmed" | "verified" | "plausible" | "speculative" | undefined;
        reason?: string | undefined;
    }[];
    reactivation: string;
}[]>;
export {};
