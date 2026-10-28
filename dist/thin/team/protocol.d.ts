import { z } from "redteam-zod";
export declare const nativeToolSchema: z.ZodEnum<{
    bash: "bash";
    find: "find";
    read: "read";
    write: "write";
    grep: "grep";
    ls: "ls";
    edit: "edit";
}>;
export declare const workerConfigSchema: z.ZodObject<{
    version: z.ZodLiteral<1>;
    workerId: z.ZodString;
    cwd: z.ZodString;
    agentDir: z.ZodString;
    provider: z.ZodString;
    model: z.ZodString;
    thinkingLevel: z.ZodEnum<{
        off: "off";
        low: "low";
        medium: "medium";
        high: "high";
        minimal: "minimal";
        xhigh: "xhigh";
        max: "max";
    }>;
    providerExtensions: z.ZodDefault<z.ZodArray<z.ZodString>>;
    teamRunId: z.ZodOptional<z.ZodString>;
    execution: z.ZodDefault<z.ZodBoolean>;
    nativeTools: z.ZodOptional<z.ZodArray<z.ZodEnum<{
        bash: "bash";
        find: "find";
        read: "read";
        write: "write";
        grep: "grep";
        ls: "ls";
        edit: "edit";
    }>>>;
    domainTools: z.ZodDefault<z.ZodArray<z.ZodObject<{
        name: z.ZodEnum<{
            rt_graph: "rt_graph";
            rt_campaign: "rt_campaign";
            rt_search: "rt_search";
            rt_job: "rt_job";
        }>;
        description: z.ZodString;
        parameters: z.ZodRecord<z.ZodString, z.ZodUnknown>;
    }, z.core.$strict>>>;
    resumePath: z.ZodOptional<z.ZodString>;
    parentTimeoutMs: z.ZodDefault<z.ZodNumber>;
}, z.core.$strict>;
export type WorkerConfig = z.infer<typeof workerConfigSchema>;
export declare const teamToolInputSchema: z.ZodDiscriminatedUnion<[z.ZodObject<{
    action: z.ZodLiteral<"read">;
    after: z.ZodOptional<z.ZodNumber>;
    candidateAfter: z.ZodOptional<z.ZodString>;
}, z.core.$strict>, z.ZodObject<{
    action: z.ZodLiteral<"notices">;
}, z.core.$strict>, z.ZodObject<{
    action: z.ZodLiteral<"delivered">;
    through: z.ZodNumber;
}, z.core.$strict>, z.ZodObject<{
    action: z.ZodLiteral<"request_graph">;
}, z.core.$strict>, z.ZodObject<{
    action: z.ZodLiteral<"unfold">;
    recordId: z.ZodString;
}, z.core.$strict>, z.ZodObject<{
    action: z.ZodLiteral<"claim">;
    workItemId: z.ZodString;
}, z.core.$strict>, z.ZodObject<{
    action: z.ZodLiteral<"publish">;
    kind: z.ZodEnum<{
        OBSERVED: "OBSERVED";
        HYPOTHESIS: "HYPOTHESIS";
        FAIL: "FAIL";
        RESULT: "RESULT";
    }>;
    summary: z.ZodString;
    preconditionHash: z.ZodString;
    evidenceRefs: z.ZodArray<z.ZodString>;
}, z.core.$strict>, z.ZodObject<{
    action: z.ZodLiteral<"complete">;
    recordId: z.ZodString;
}, z.core.$strict>, z.ZodObject<{
    action: z.ZodLiteral<"release">;
}, z.core.$strict>, z.ZodObject<{
    action: z.ZodLiteral<"validate">;
}, z.core.$strict>, z.ZodObject<{
    action: z.ZodLiteral<"offer">;
    title: z.ZodString;
    targetRef: z.ZodString;
    operation: z.ZodString;
    preconditionHash: z.ZodString;
}, z.core.$strict>, z.ZodObject<{
    action: z.ZodLiteral<"domain">;
    tool: z.ZodEnum<{
        rt_graph: "rt_graph";
        rt_campaign: "rt_campaign";
        rt_search: "rt_search";
        rt_job: "rt_job";
    }>;
    params: z.ZodRecord<z.ZodString, z.ZodUnknown>;
    contextPercent: z.ZodOptional<z.ZodNumber>;
}, z.core.$strict>], "action">;
export type TeamToolInput = z.infer<typeof teamToolInputSchema>;
export declare const teamToolRequestSchema: z.ZodObject<{
    kind: z.ZodLiteral<"tool_request">;
    requestId: z.ZodString;
    toolCallId: z.ZodString;
    input: z.ZodDiscriminatedUnion<[z.ZodObject<{
        action: z.ZodLiteral<"read">;
        after: z.ZodOptional<z.ZodNumber>;
        candidateAfter: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>, z.ZodObject<{
        action: z.ZodLiteral<"notices">;
    }, z.core.$strict>, z.ZodObject<{
        action: z.ZodLiteral<"delivered">;
        through: z.ZodNumber;
    }, z.core.$strict>, z.ZodObject<{
        action: z.ZodLiteral<"request_graph">;
    }, z.core.$strict>, z.ZodObject<{
        action: z.ZodLiteral<"unfold">;
        recordId: z.ZodString;
    }, z.core.$strict>, z.ZodObject<{
        action: z.ZodLiteral<"claim">;
        workItemId: z.ZodString;
    }, z.core.$strict>, z.ZodObject<{
        action: z.ZodLiteral<"publish">;
        kind: z.ZodEnum<{
            OBSERVED: "OBSERVED";
            HYPOTHESIS: "HYPOTHESIS";
            FAIL: "FAIL";
            RESULT: "RESULT";
        }>;
        summary: z.ZodString;
        preconditionHash: z.ZodString;
        evidenceRefs: z.ZodArray<z.ZodString>;
    }, z.core.$strict>, z.ZodObject<{
        action: z.ZodLiteral<"complete">;
        recordId: z.ZodString;
    }, z.core.$strict>, z.ZodObject<{
        action: z.ZodLiteral<"release">;
    }, z.core.$strict>, z.ZodObject<{
        action: z.ZodLiteral<"validate">;
    }, z.core.$strict>, z.ZodObject<{
        action: z.ZodLiteral<"offer">;
        title: z.ZodString;
        targetRef: z.ZodString;
        operation: z.ZodString;
        preconditionHash: z.ZodString;
    }, z.core.$strict>, z.ZodObject<{
        action: z.ZodLiteral<"domain">;
        tool: z.ZodEnum<{
            rt_graph: "rt_graph";
            rt_campaign: "rt_campaign";
            rt_search: "rt_search";
            rt_job: "rt_job";
        }>;
        params: z.ZodRecord<z.ZodString, z.ZodUnknown>;
        contextPercent: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strict>], "action">;
}, z.core.$strict>;
export declare const teamToolResultSchema: z.ZodObject<{
    action: z.ZodLiteral<"tool_result">;
    requestId: z.ZodString;
    text: z.ZodString;
    failed: z.ZodBoolean;
}, z.core.$strict>;
export type TeamToolResult = z.infer<typeof teamToolResultSchema>;
export declare const workerCommandSchema: z.ZodDiscriminatedUnion<[z.ZodObject<{
    action: z.ZodLiteral<"init">;
    requestId: z.ZodString;
    config: z.ZodObject<{
        version: z.ZodLiteral<1>;
        workerId: z.ZodString;
        cwd: z.ZodString;
        agentDir: z.ZodString;
        provider: z.ZodString;
        model: z.ZodString;
        thinkingLevel: z.ZodEnum<{
            off: "off";
            low: "low";
            medium: "medium";
            high: "high";
            minimal: "minimal";
            xhigh: "xhigh";
            max: "max";
        }>;
        providerExtensions: z.ZodDefault<z.ZodArray<z.ZodString>>;
        teamRunId: z.ZodOptional<z.ZodString>;
        execution: z.ZodDefault<z.ZodBoolean>;
        nativeTools: z.ZodOptional<z.ZodArray<z.ZodEnum<{
            bash: "bash";
            find: "find";
            read: "read";
            write: "write";
            grep: "grep";
            ls: "ls";
            edit: "edit";
        }>>>;
        domainTools: z.ZodDefault<z.ZodArray<z.ZodObject<{
            name: z.ZodEnum<{
                rt_graph: "rt_graph";
                rt_campaign: "rt_campaign";
                rt_search: "rt_search";
                rt_job: "rt_job";
            }>;
            description: z.ZodString;
            parameters: z.ZodRecord<z.ZodString, z.ZodUnknown>;
        }, z.core.$strict>>>;
        resumePath: z.ZodOptional<z.ZodString>;
        parentTimeoutMs: z.ZodDefault<z.ZodNumber>;
    }, z.core.$strict>;
}, z.core.$strict>, z.ZodObject<{
    action: z.ZodLiteral<"prompt">;
    requestId: z.ZodString;
    text: z.ZodString;
}, z.core.$strict>, z.ZodObject<{
    action: z.ZodLiteral<"compact">;
    requestId: z.ZodString;
    instructions: z.ZodOptional<z.ZodString>;
}, z.core.$strict>, z.ZodObject<{
    action: z.ZodLiteral<"inspect">;
    requestId: z.ZodString;
}, z.core.$strict>, z.ZodObject<{
    action: z.ZodLiteral<"abort">;
    requestId: z.ZodString;
}, z.core.$strict>, z.ZodObject<{
    action: z.ZodLiteral<"stop">;
    requestId: z.ZodString;
}, z.core.$strict>, z.ZodObject<{
    action: z.ZodLiteral<"heartbeat">;
}, z.core.$strict>], "action">;
export type WorkerCommand = z.infer<typeof workerCommandSchema>;
export declare const workerViewSchema: z.ZodObject<{
    workerId: z.ZodString;
    sessionId: z.ZodString;
    sessionPath: z.ZodOptional<z.ZodString>;
    provider: z.ZodString;
    model: z.ZodString;
    thinkingLevel: z.ZodString;
    contextWindow: z.ZodNumber;
    maxTokens: z.ZodNumber;
    tools: z.ZodArray<z.ZodString>;
    phase: z.ZodEnum<{
        running: "running";
        idle: "idle";
        stopping: "stopping";
    }>;
    bound: z.ZodLiteral<true>;
}, z.core.$strict>;
export type WorkerView = z.infer<typeof workerViewSchema>;
export declare const workerReplySchema: z.ZodDiscriminatedUnion<[z.ZodObject<{
    kind: z.ZodLiteral<"ready">;
    requestId: z.ZodString;
    view: z.ZodObject<{
        workerId: z.ZodString;
        sessionId: z.ZodString;
        sessionPath: z.ZodOptional<z.ZodString>;
        provider: z.ZodString;
        model: z.ZodString;
        thinkingLevel: z.ZodString;
        contextWindow: z.ZodNumber;
        maxTokens: z.ZodNumber;
        tools: z.ZodArray<z.ZodString>;
        phase: z.ZodEnum<{
            running: "running";
            idle: "idle";
            stopping: "stopping";
        }>;
        bound: z.ZodLiteral<true>;
    }, z.core.$strict>;
}, z.core.$strict>, z.ZodObject<{
    kind: z.ZodLiteral<"result">;
    requestId: z.ZodString;
    view: z.ZodObject<{
        workerId: z.ZodString;
        sessionId: z.ZodString;
        sessionPath: z.ZodOptional<z.ZodString>;
        provider: z.ZodString;
        model: z.ZodString;
        thinkingLevel: z.ZodString;
        contextWindow: z.ZodNumber;
        maxTokens: z.ZodNumber;
        tools: z.ZodArray<z.ZodString>;
        phase: z.ZodEnum<{
            running: "running";
            idle: "idle";
            stopping: "stopping";
        }>;
        bound: z.ZodLiteral<true>;
    }, z.core.$strict>;
    text: z.ZodString;
    truncated: z.ZodBoolean;
}, z.core.$strict>, z.ZodObject<{
    kind: z.ZodLiteral<"error">;
    requestId: z.ZodString;
    code: z.ZodEnum<{
        unavailable: "unavailable";
        invalid: "invalid";
        failed: "failed";
        stopping: "stopping";
        busy: "busy";
    }>;
    diagnostic: z.ZodOptional<z.ZodString>;
}, z.core.$strict>, z.ZodObject<{
    kind: z.ZodLiteral<"activity">;
    workerId: z.ZodString;
    event: z.ZodEnum<{
        usage: "usage";
        compaction: "compaction";
        tool: "tool";
        started: "started";
        settled: "settled";
        "provider-retry": "provider-retry";
    }>;
    tool: z.ZodOptional<z.ZodString>;
    usage: z.ZodOptional<z.ZodObject<{
        input: z.ZodNumber;
        output: z.ZodNumber;
        cacheRead: z.ZodNumber;
        cacheWrite: z.ZodNumber;
        cost: z.ZodNumber;
    }, z.core.$strict>>;
    rateLimited: z.ZodOptional<z.ZodBoolean>;
    retryDelayMs: z.ZodOptional<z.ZodNumber>;
}, z.core.$strict>], "kind">;
export type WorkerReply = z.infer<typeof workerReplySchema>;
