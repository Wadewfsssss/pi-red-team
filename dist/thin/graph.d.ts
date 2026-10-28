import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { z } from "redteam-zod";
import { type DomainProject } from "./state.js";
export declare const propertiesSchema: z.ZodObject<{
    cvss: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
    status: z.ZodOptional<z.ZodNullable<z.ZodEnum<{
        confirmed: "confirmed";
        needs_review: "needs_review";
        rejected: "rejected";
    }>>>;
    confidence: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
    risk: z.ZodOptional<z.ZodNullable<z.ZodEnum<{
        low: "low";
        medium: "medium";
        high: "high";
    }>>>;
    technique: z.ZodOptional<z.ZodNullable<z.ZodString>>;
}, z.core.$strict>;
export declare const entitySchema: z.ZodObject<{
    id: z.ZodString;
    kind: z.ZodEnum<{
        identity: "identity";
        asset: "asset";
        observation: "observation";
        hypothesis: "hypothesis";
        finding: "finding";
        attack_step: "attack_step";
        credential: "credential";
        host: "host";
        service: "service";
        objective: "objective";
        evidence: "evidence";
    }>;
    name: z.ZodString;
    properties: z.ZodOptional<z.ZodObject<{
        cvss: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
        status: z.ZodOptional<z.ZodNullable<z.ZodEnum<{
            confirmed: "confirmed";
            needs_review: "needs_review";
            rejected: "rejected";
        }>>>;
        confidence: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
        risk: z.ZodOptional<z.ZodNullable<z.ZodEnum<{
            low: "low";
            medium: "medium";
            high: "high";
        }>>>;
        technique: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    }, z.core.$strict>>;
}, z.core.$strict>;
export declare const linkSchema: z.ZodObject<{
    id: z.ZodString;
    source: z.ZodString;
    target: z.ZodString;
    relation: z.ZodString;
    state: z.ZodEnum<{
        hypothesis: "hypothesis";
        observed: "observed";
        refuted: "refuted";
    }>;
    evidenceRefs: z.ZodArray<z.ZodString>;
    evidenceHashes: z.ZodOptional<z.ZodArray<z.ZodString>>;
    evidenceVerified: z.ZodOptional<z.ZodBoolean>;
    observedAt: z.ZodString;
    sourceKind: z.ZodOptional<z.ZodEnum<{
        identity: "identity";
        asset: "asset";
        observation: "observation";
        hypothesis: "hypothesis";
        finding: "finding";
        attack_step: "attack_step";
        credential: "credential";
        host: "host";
        service: "service";
        objective: "objective";
        evidence: "evidence";
    }>>;
    targetKind: z.ZodOptional<z.ZodEnum<{
        identity: "identity";
        asset: "asset";
        observation: "observation";
        hypothesis: "hypothesis";
        finding: "finding";
        attack_step: "attack_step";
        credential: "credential";
        host: "host";
        service: "service";
        objective: "objective";
        evidence: "evidence";
    }>>;
    sourceProperties: z.ZodOptional<z.ZodObject<{
        cvss: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
        status: z.ZodOptional<z.ZodNullable<z.ZodEnum<{
            confirmed: "confirmed";
            needs_review: "needs_review";
            rejected: "rejected";
        }>>>;
        confidence: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
        risk: z.ZodOptional<z.ZodNullable<z.ZodEnum<{
            low: "low";
            medium: "medium";
            high: "high";
        }>>>;
        technique: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    }, z.core.$strict>>;
    targetProperties: z.ZodOptional<z.ZodObject<{
        cvss: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
        status: z.ZodOptional<z.ZodNullable<z.ZodEnum<{
            confirmed: "confirmed";
            needs_review: "needs_review";
            rejected: "rejected";
        }>>>;
        confidence: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
        risk: z.ZodOptional<z.ZodNullable<z.ZodEnum<{
            low: "low";
            medium: "medium";
            high: "high";
        }>>>;
        technique: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    }, z.core.$strict>>;
}, z.core.$strict>;
export type GraphLink = z.infer<typeof linkSchema>;
export declare function evidenceReferences(project: DomainProject, references: string[]): Promise<{
    reference: string;
    sha256: string;
}[]>;
export declare function nativeCypher(ctx: ExtensionToolContext, server: string, write: boolean, query: string, signal?: AbortSignal): Promise<import("@earendil-works/pi-coding-agent").AgentToolResult<any>>;
export declare function recordLink(project: DomainProject, ctx: ExtensionToolContext, server: string, input: {
    source: z.infer<typeof entitySchema>;
    target: z.infer<typeof entitySchema>;
    link: GraphLink;
}, signal?: AbortSignal): Promise<{
    persisted: boolean;
    persistence: string;
    localFindingsWritten: string[];
    projectKey: string;
    evidence: {
        reference: string;
        sha256: string;
    }[];
    result: import("@earendil-works/pi-coding-agent").AgentToolResult<any>;
}>;
export declare function graphSnapshot(project: DomainProject, ctx: ExtensionToolContext, server: string, signal?: AbortSignal): Promise<GraphLink[]>;
export declare function candidatePaths(links: GraphLink[], source: string, target: string, now?: number, maxAgeSeconds?: number, maxDepth?: number): {
    paths: {
        nodes: string[];
        links: GraphLink[];
        unverified: string[];
        staleEvidence: string[];
        verdict: string;
    }[];
    bounded: boolean;
    maxDepth: number;
    examined: number;
    truncated: boolean;
};
