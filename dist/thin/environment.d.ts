export declare function discoverTools(environment?: NodeJS.ProcessEnv): Promise<{
    id: string;
    label: string;
    tools: {
        name: string;
        available: boolean;
    }[];
}[]>;
export declare function runtimeConstraints(root?: string): Promise<{
    pidsMax: number | null;
    memoryMaxBytes: number | null;
    cpuQuota: number | null;
    tmpNoexec: boolean | null;
    rootReadOnly: boolean | null;
}>;
export declare function capabilitySnapshot(environment?: NodeJS.ProcessEnv): Promise<{
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
}>;
export declare function capabilityPrompt(snapshot: Awaited<ReturnType<typeof capabilitySnapshot>>): string;
