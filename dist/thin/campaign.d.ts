import { z } from "redteam-zod";
import { type DomainProject } from "./state.js";
export declare const campaignInput: z.ZodDiscriminatedUnion<[z.ZodObject<{
    action: z.ZodLiteral<"status">;
    targetId: z.ZodOptional<z.ZodString>;
    after: z.ZodOptional<z.ZodString>;
}, z.core.$strict>, z.ZodObject<{
    action: z.ZodLiteral<"target">;
    target: z.ZodObject<{
        id: z.ZodString;
        targetRef: z.ZodString;
        category: z.ZodEnum<{
            binary: "binary";
            network: "network";
            web: "web";
            "identity-cloud": "identity-cloud";
            other: "other";
        }>;
        blocker: z.ZodOptional<z.ZodString>;
        nextStep: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>;
}, z.core.$strict>, z.ZodObject<{
    action: z.ZodLiteral<"coverage">;
    targetId: z.ZodString;
    surface: z.ZodString;
    status: z.ZodEnum<{
        unexamined: "unexamined";
        examined: "examined";
        blocked: "blocked";
        "not-applicable": "not-applicable";
    }>;
    observation: z.ZodString;
    evidenceRefs: z.ZodDefault<z.ZodArray<z.ZodString>>;
}, z.core.$strict>], "action">;
export type CampaignInput = z.input<typeof campaignInput>;
export declare const campaignToolInput: z.ZodObject<{
    action: z.ZodEnum<{
        status: "status";
        target: "target";
        coverage: "coverage";
    }>;
    targetId: z.ZodOptional<z.ZodString>;
    surface: z.ZodOptional<z.ZodString>;
    status: z.ZodOptional<z.ZodEnum<{
        unexamined: "unexamined";
        examined: "examined";
        blocked: "blocked";
        "not-applicable": "not-applicable";
    }>>;
    observation: z.ZodOptional<z.ZodString>;
    evidenceRefs: z.ZodOptional<z.ZodDefault<z.ZodArray<z.ZodString>>>;
    target: z.ZodOptional<z.ZodObject<{
        id: z.ZodString;
        targetRef: z.ZodString;
        category: z.ZodEnum<{
            binary: "binary";
            network: "network";
            web: "web";
            "identity-cloud": "identity-cloud";
            other: "other";
        }>;
        blocker: z.ZodOptional<z.ZodString>;
        nextStep: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>>;
    after: z.ZodOptional<z.ZodOptional<z.ZodString>>;
}, z.core.$strict>;
export declare const testingProfiles: {
    readonly web: readonly ["Entry points and input handling", "Authentication and session behavior", "Authorization and object boundaries", "Application configuration and exposed functionality"];
    readonly "identity-cloud": readonly ["Identities and trust boundaries", "Effective permissions and prerequisites", "Resource access relationships", "Credential and session provenance"];
    readonly network: readonly ["Reachability and service inventory", "Service configuration and access boundaries", "Dependencies between systems", "Evidence-backed path prerequisites"];
    readonly binary: readonly ["Program inputs and execution model", "Data flow and validation constraints", "Observed runtime behavior", "Competing interpretations of program semantics"];
    readonly other: readonly ["Inputs and outputs", "Trust boundaries", "Known prerequisites", "Alternative explanations"];
};
export declare function readCampaign(project: DomainProject): Promise<{
    version: 2;
    workspaceKey: string;
    revision: number;
    targets: {
        id: string;
        targetRef: string;
        category: "binary" | "network" | "web" | "identity-cloud" | "other";
        coverage: {
            surface: string;
            status: "unexamined" | "examined" | "blocked" | "not-applicable";
            observation: string;
            evidence: {
                reference: string;
                sha256: string;
            }[];
        }[];
        blocker: string;
        nextStep: string;
    }[];
} | undefined>;
export declare function campaignSummary(project: DomainProject): Promise<{
    configured: boolean;
    registeredTargets: number;
    targets: never[];
    advisory: boolean;
    goalCompletionEvaluated: boolean;
    authorizationGranted: boolean;
    truncated?: undefined;
    integrityChecksTruncated?: undefined;
} | {
    configured: boolean;
    registeredTargets: number;
    targets: {
        id: string;
        targetRef: string;
        suggestedUnexaminedSurfaces: ("Entry points and input handling" | "Authentication and session behavior" | "Authorization and object boundaries" | "Application configuration and exposed functionality" | "Identities and trust boundaries" | "Effective permissions and prerequisites" | "Resource access relationships" | "Credential and session provenance" | "Reachability and service inventory" | "Service configuration and access boundaries" | "Dependencies between systems" | "Evidence-backed path prerequisites" | "Program inputs and execution model" | "Data flow and validation constraints" | "Observed runtime behavior" | "Competing interpretations of program semantics" | "Inputs and outputs" | "Trust boundaries" | "Known prerequisites" | "Alternative explanations")[];
        blocker: string;
        nextStep: string;
    }[];
    truncated: boolean;
    advisory: boolean;
    goalCompletionEvaluated: boolean;
    authorizationGranted: boolean;
    integrityChecksTruncated: boolean;
}>;
export declare function campaignAction(project: DomainProject, input: CampaignInput, actor: {
    id: string;
    targetRef?: string;
}, signal?: AbortSignal): Promise<unknown>;
export declare function campaignPrompt(summary: Awaited<ReturnType<typeof campaignSummary>>): string;
