import { z } from "redteam-zod";
declare const observationSchema: z.ZodObject<{
    version: z.ZodLiteral<1>;
    toolCallId: z.ZodString;
    commandHash: z.ZodString;
    branchId: z.ZodNullable<z.ZodString>;
    category: z.ZodNullable<z.ZodEnum<{
        "missing-tool": "missing-tool";
        dependency: "dependency";
        capacity: "capacity";
        permission: "permission";
        timeout: "timeout";
        connection: "connection";
        "execution-error": "execution-error";
    }>>;
    isError: z.ZodBoolean;
    evidenceRef: z.ZodNullable<z.ZodString>;
    repetitions: z.ZodNumber;
    fingerprint: z.ZodOptional<z.ZodString>;
    issue: z.ZodOptional<z.ZodString>;
    turn: z.ZodOptional<z.ZodNumber>;
}, z.core.$strict>;
export type ExecutionObservation = z.infer<typeof observationSchema>;
export declare function executionCategory(output: string, isError: boolean): ExecutionObservation["category"];
export declare class ExecutionFeedback {
    private history;
    private emitted;
    private notices;
    private branchId;
    private summaryKey;
    private turn;
    private noticeTurns;
    private lastNotice;
    private issues;
    private overflow;
    private lastSummaryTurn;
    reset(): void;
    beginRun(): void;
    invalidateSummary(): void;
    endTurn(): void;
    checkpoint(): {
        version: number;
        turn: number;
        noticeTurns: number[];
        lastNotice: [string, number][];
        issues: {
            version: 1;
            toolCallId: string;
            commandHash: string;
            branchId: string | null;
            category: "missing-tool" | "dependency" | "capacity" | "permission" | "timeout" | "connection" | "execution-error" | null;
            isError: boolean;
            evidenceRef: string | null;
            repetitions: number;
            fingerprint?: string | undefined;
            issue?: string | undefined;
            turn?: number | undefined;
        }[];
        overflow: number;
        summaryKey: string | undefined;
        lastSummaryTurn: number;
    };
    resolveAvailableTools(names: Set<string>): void;
    restore(data: unknown): void;
    selectBranch(data: unknown): void;
    observe(input: {
        command: string;
        output: string;
        isError: boolean;
        toolCallId: string;
        evidenceRef?: string;
    }): {
        observation: ExecutionObservation;
        hint?: string;
    };
    summary(): string | undefined;
}
export {};
