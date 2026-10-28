import { z } from "redteam-zod";
export type DomainProject = {
    cwd: string;
    workspaceId?: string;
    searchStatePath?: string;
    mutationGuard?: () => Promise<void>;
};
export declare function projectKey(project: DomainProject): string;
export declare function resolveWorkspace(project: DomainProject): Promise<void>;
export declare function domainPath(project: {
    cwd: string;
}, ...parts: string[]): Promise<string>;
export declare function mutateState<T>(project: DomainProject, name: string, schema: z.ZodType<T>, initial: () => T, mutate: (state: T) => unknown, signal?: AbortSignal): Promise<unknown>;
export declare function readState<T>(project: DomainProject, name: string, schema: z.ZodType<T>, initial: () => T): Promise<T>;
