export type Project = {
    cwd: string;
    status: "untrusted" | "invalid";
    reason: string;
} | {
    cwd: string;
    status: "ready";
};
export declare function readBoundedFile(path: string, limit: number): Promise<Buffer>;
export declare function loadProject(cwd: string, trusted: boolean): Promise<Project>;
export declare function diagnose(project: Project, environment?: NodeJS.ProcessEnv): Promise<{
    neo4j: string;
    configurationRequired: boolean;
    profile: string;
    platform: NodeJS.Platform;
    architecture: NodeJS.Architecture;
    toolGroups: {
        id: string;
        label: string;
        tools: {
            name: string;
            available: boolean;
        }[];
    }[];
    constraints: {
        pidsMax: number | null;
        memoryMaxBytes: number | null;
        cpuQuota: number | null;
        tmpNoexec: boolean | null;
        rootReadOnly: boolean | null;
    };
    resources: {
        available: boolean;
        id: string;
        path: string;
        hint: string;
    }[];
    status: "untrusted" | "invalid" | "ready";
    cwd: string;
    kali: boolean;
    writable: boolean;
    tools: {
        name: string;
        available: boolean;
    }[];
}>;
