import type { ExtensionAPI, ExtensionContext, ExtensionToolContext, ToolLoadout } from "@earendil-works/pi-coding-agent";
import { z } from "redteam-zod";
declare const selectionSchema: z.ZodObject<{
    version: z.ZodLiteral<1>;
    mode: z.ZodEnum<{
        auto: "auto";
        off: "off";
    }>;
    server: z.ZodString;
}, z.core.$strict>;
export type GraphSelection = z.infer<typeof selectionSchema>;
type NamedTool = {
    name: string;
    parameters?: unknown;
};
export type GraphAccess = {
    mode: "auto" | "off";
    server: string;
    read: boolean;
    write: boolean;
    reason: string;
};
export declare class GraphOperationError extends Error {
    readonly data: Record<string, unknown>;
    constructor(message: string, data: Record<string, unknown>);
}
export declare function bindCypher(tools: readonly NamedTool[], server: string, write: boolean): {
    reason: string;
    tool: undefined;
} | {
    reason: string;
    tool: string;
};
export declare function unavailableGraph(reason: string, operation: string, server: string): {
    status: string;
    reason: string;
    operation: string;
    server: string;
    executed: boolean;
    persistence: string;
    fallback: string;
};
export declare class GraphCapability {
    private readonly pi;
    private selection;
    private sessionKey?;
    private fingerprint?;
    private generation;
    private controllers;
    private lastFailure?;
    private callable;
    constructor(pi: ExtensionAPI);
    private refreshLoadout;
    reaches(server?: unknown): string[];
    cancel(): void;
    restore(ctx: ExtensionContext): void;
    private observe;
    select(ctx: ExtensionContext, mode: "auto" | "off", server?: string): GraphAccess & {
        lastFailure?: {
            at: number;
            server: string;
            reason: string;
        };
        health: "unknown";
    };
    prepare(loadout: ToolLoadout): {
        hiddenDeclarations?: string[] | undefined;
        descriptions: {
            rt_graph: string;
        };
    };
    status(ctx: ExtensionContext, tools?: readonly NamedTool[]): GraphAccess & {
        lastFailure?: {
            at: number;
            server: string;
            reason: string;
        };
        health: "unknown";
    };
    run<Output>(ctx: ExtensionToolContext, server: string | undefined, write: boolean, signal: AbortSignal | undefined, operation: (signal: AbortSignal, server: string) => Promise<Output>): Promise<Output>;
}
export {};
