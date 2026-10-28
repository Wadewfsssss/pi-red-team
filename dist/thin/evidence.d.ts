export interface BashCapture {
    toolCallId: string;
    sessionId: string;
    leafId: string | null;
    command: string;
    output: string;
    fullOutputPath?: string;
    truncated: boolean;
    isError: boolean;
    attemptId?: string;
    branchId?: string;
    parentToolCallId?: string;
}
export declare class EvidenceWriter {
    readonly cwd: string;
    private queue;
    constructor(cwd: string);
    save(capture: BashCapture): Promise<{
        id: `${string}-${string}-${string}-${string}-${string}`;
        tool: string;
        toolCallId: string;
        sessionId: string;
        leafId: string | null;
        capturedAt: string;
        cwd: string;
        command: string;
        outputPath: string;
        complete: boolean;
        incompleteReason: string | null;
        isError: boolean;
        bytes: number;
        sha256: string;
        redacted: boolean;
        attemptId: string | null;
        branchId: string | null;
        parentToolCallId: string | null;
        association: string;
    }>;
    drain(): Promise<void>;
    private write;
}
