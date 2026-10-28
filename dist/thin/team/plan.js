import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { z } from "redteam-zod";
import { atomicWrite } from "../../files.js";
import { domainPath } from "../state.js";
import { readBoundedFile } from "../project.js";
import { offerSchema } from "./store.js";
export const teamPlanSchema = z.object({
    goal: z.string().min(1).max(4000), scope: z.string().min(1).max(4000),
    decision: z.enum(["parallel", "serial"]), reason: z.string().min(1).max(2000),
    candidates: z.array(offerSchema).max(128).default([]),
}).strict().refine(plan => plan.decision !== "parallel" || plan.candidates.length >= 2, "Parallel plans require at least two independent candidates");
const savedPlanSchema = z.object({ version: z.literal(1), id: z.string().uuid(), parentSession: z.string(), createdAt: z.number(), plan: teamPlanSchema }).strict();
export async function saveTeamPlan(project, parentSession, input) {
    const saved = savedPlanSchema.parse({ version: 1, id: randomUUID(), parentSession, createdAt: Date.now(), plan: input });
    await mkdir(await domainPath(project, "team", "plans"), { recursive: true, mode: 0o700 });
    await atomicWrite(await domainPath(project, "team", "plans", `${saved.id}.json`), JSON.stringify(saved) + "\n");
    return { ...saved, authorized: false, processesStarted: 0 };
}
export async function loadTeamPlan(project, parentSession, id) {
    z.string().uuid().parse(id);
    const saved = savedPlanSchema.parse(JSON.parse((await readBoundedFile(await domainPath(project, "team", "plans", `${id}.json`), 256 * 1024)).toString("utf8")));
    if (saved.id !== id || saved.parentSession !== parentSession)
        throw new Error("Plan is not from this Pi session; plan again before starting");
    if (saved.plan.decision !== "parallel")
        throw new Error("Serial plan does not authorize team startup");
    return saved.plan;
}
