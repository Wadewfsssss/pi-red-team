import { z } from "redteam-zod";
const absolute = z.string().min(1).max(4096).startsWith("/");
export const workerConfigSchema = z.object({
    version: z.literal(1), workerId: z.string().uuid(), cwd: absolute, agentDir: absolute,
    provider: z.string().min(1).max(200), model: z.string().min(1).max(300),
    thinkingLevel: z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]),
    providerExtensions: z.array(absolute).max(4).default([]),
    teamRunId: z.string().uuid().optional(),
    execution: z.boolean().default(false),
    domainTools: z.array(z.object({ name: z.enum(["rt_search", "rt_graph", "rt_job", "rt_campaign"]), description: z.string().max(4000), parameters: z.record(z.string(), z.unknown()) }).strict()).max(4).default([]),
    resumePath: absolute.optional(), parentTimeoutMs: z.number().int().min(3000).max(60000).default(15000),
}).strict();
export const teamToolInputSchema = z.discriminatedUnion("action", [
    z.object({ action: z.literal("read"), after: z.number().int().min(0).optional(), candidateAfter: z.string().uuid().optional() }).strict(),
    z.object({ action: z.literal("notices") }).strict(),
    z.object({ action: z.literal("delivered"), through: z.number().int().min(0) }).strict(),
    z.object({ action: z.literal("request_graph") }).strict(),
    z.object({ action: z.literal("unfold"), recordId: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
    z.object({ action: z.literal("claim"), workItemId: z.string().uuid() }).strict(),
    z.object({ action: z.literal("publish"), kind: z.enum(["OBSERVED", "HYPOTHESIS", "FAIL", "RESULT"]), summary: z.string().min(1).max(512), preconditionHash: z.string().regex(/^[a-f0-9]{64}$/), evidenceRefs: z.array(z.string().min(1).max(500)).max(20) }).strict(),
    z.object({ action: z.literal("complete"), recordId: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
    z.object({ action: z.literal("release") }).strict(),
    z.object({ action: z.literal("validate") }).strict(),
    z.object({ action: z.literal("offer"), title: z.string().min(1).max(500), targetRef: z.string().min(1).max(500), operation: z.string().min(1).max(500), preconditionHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
    z.object({ action: z.literal("domain"), tool: z.enum(["rt_search", "rt_graph", "rt_job", "rt_campaign"]), params: z.record(z.string(), z.unknown()).refine(value => Buffer.byteLength(JSON.stringify(value)) <= 65536, "Domain material exceeds 64 KiB"), contextPercent: z.number().min(0).max(100).optional() }).strict(),
]);
export const teamToolRequestSchema = z.object({ kind: z.literal("tool_request"), requestId: z.string().uuid(), toolCallId: z.string().min(1).max(500), input: teamToolInputSchema }).strict();
export const teamToolResultSchema = z.object({ action: z.literal("tool_result"), requestId: z.string().uuid(), text: z.string().max(32768), failed: z.boolean() }).strict();
export const workerCommandSchema = z.discriminatedUnion("action", [
    z.object({ action: z.literal("init"), requestId: z.string().uuid(), config: workerConfigSchema }).strict(),
    z.object({ action: z.literal("prompt"), requestId: z.string().uuid(), text: z.string().min(1).max(32768).refine(value => Buffer.byteLength(value) <= 32768, "Prompt material exceeds 32768 UTF-8 bytes") }).strict(),
    z.object({ action: z.literal("compact"), requestId: z.string().uuid(), instructions: z.string().max(4000).optional() }).strict(),
    z.object({ action: z.literal("inspect"), requestId: z.string().uuid() }).strict(),
    z.object({ action: z.literal("abort"), requestId: z.string().uuid() }).strict(),
    z.object({ action: z.literal("stop"), requestId: z.string().uuid() }).strict(),
    z.object({ action: z.literal("heartbeat") }).strict(),
]);
export const workerViewSchema = z.object({
    workerId: z.string().uuid(), sessionId: z.string(), sessionPath: absolute.optional(),
    provider: z.string(), model: z.string(), thinkingLevel: z.string(),
    contextWindow: z.number(), maxTokens: z.number(), tools: z.array(z.string()),
    phase: z.enum(["idle", "running", "stopping"]), bound: z.literal(true),
}).strict();
export const workerReplySchema = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("ready"), requestId: z.string().uuid(), view: workerViewSchema }).strict(),
    z.object({ kind: z.literal("result"), requestId: z.string().uuid(), view: workerViewSchema, text: z.string().max(32768), truncated: z.boolean() }).strict(),
    z.object({ kind: z.literal("error"), requestId: z.string().uuid(), code: z.enum(["invalid", "unavailable", "busy", "failed", "stopping"]) }).strict(),
    z.object({ kind: z.literal("activity"), workerId: z.string().uuid(), event: z.enum(["started", "settled", "tool", "compaction", "usage", "provider-retry"]), tool: z.string().max(200).optional(), usage: z.object({ input: z.number().finite().min(0), output: z.number().finite().min(0), cacheRead: z.number().finite().min(0), cacheWrite: z.number().finite().min(0), cost: z.number().finite().min(0) }).strict().optional(), rateLimited: z.boolean().optional(), retryDelayMs: z.number().int().min(0).max(86400000).optional() }).strict(),
]);
