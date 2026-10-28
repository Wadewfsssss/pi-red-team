import { z } from "redteam-zod";
import { type DomainProject } from "../state.js";
export declare const teamPlanSchema: z.ZodObject<{
    goal: z.ZodString;
    scope: z.ZodString;
    decision: z.ZodEnum<{
        parallel: "parallel";
        serial: "serial";
    }>;
    reason: z.ZodString;
    candidates: z.ZodDefault<z.ZodArray<z.ZodObject<{
        title: z.ZodString;
        targetRef: z.ZodString;
        operation: z.ZodString;
        preconditionHash: z.ZodString;
    }, z.core.$strict>>>;
}, z.core.$strict>;
export declare function saveTeamPlan(project: DomainProject, parentSession: string, input: z.input<typeof teamPlanSchema>): Promise<{
    authorized: boolean;
    processesStarted: number;
    version: 1;
    id: string;
    parentSession: string;
    createdAt: number;
    plan: {
        goal: string;
        scope: string;
        decision: "parallel" | "serial";
        reason: string;
        candidates: {
            title: string;
            targetRef: string;
            operation: string;
            preconditionHash: string;
        }[];
    };
}>;
export declare function loadTeamPlan(project: DomainProject, parentSession: string, id: string): Promise<{
    goal: string;
    scope: string;
    decision: "parallel" | "serial";
    reason: string;
    candidates: {
        title: string;
        targetRef: string;
        operation: string;
        preconditionHash: string;
    }[];
}>;
