import { type GraphLink } from "./graph.js";
export declare function reasonGraph(links: GraphLink[], query: "next" | "chains" | "severity" | "evidence" | "chokepoints", input?: {
    sourceId?: string;
    targetId?: string;
    maxAgeSeconds?: number;
}, now?: number): {
    steps: {
        stepId: string;
        evidenceVerified: boolean;
        next: string[];
        gains: string[];
        prerequisites: {
            id: string;
            evidenceVerified: boolean;
        }[];
    }[];
    query: "evidence" | "next" | "chains" | "severity" | "chokepoints";
    candidateOnly: boolean;
    nodeCount: number;
    relationshipCount: number;
} | {
    scores: {
        id: string;
        score: number;
    }[];
    engine: string;
    containsUnverifiedRelationships: boolean;
    query: "evidence" | "next" | "chains" | "severity" | "chokepoints";
    candidateOnly: boolean;
    nodeCount: number;
    relationshipCount: number;
} | {
    chains: {
        nodes: string[];
        links: GraphLink[];
        unverified: string[];
        staleEvidence: string[];
        verdict: string;
        sourceId: string;
        targetId: string;
    }[];
    truncated: boolean;
    maxDepth: number;
    query: "evidence" | "next" | "chains" | "severity" | "chokepoints";
    candidateOnly: boolean;
    nodeCount: number;
    relationshipCount: number;
} | {
    chains: {
        sourceId: string;
        targetId: string;
        receipts: {
            linkId: string;
            references: string[];
            hashes: string[];
            verified: boolean;
        }[];
    }[];
    truncated: boolean;
    query: "evidence" | "next" | "chains" | "severity" | "chokepoints";
    candidateOnly: boolean;
    nodeCount: number;
    relationshipCount: number;
} | {
    findings: {
        findingId: string;
        localCvss: number;
        score: number | null;
        severity: string;
        targetId: string;
        path: string[];
        promotionIsPolicyNotCvss: boolean;
    }[];
    truncated: boolean;
    reachBonus: number;
    riskWeights: {
        high: number;
        medium: number;
        low: number;
    };
    query: "evidence" | "next" | "chains" | "severity" | "chokepoints";
    candidateOnly: boolean;
    nodeCount: number;
    relationshipCount: number;
};
