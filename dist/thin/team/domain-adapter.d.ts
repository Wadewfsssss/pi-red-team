import { type DomainProject } from "../state.js";
import { type WorkLease } from "./store.js";
import type { TeamToolInput, WorkerConfig } from "./protocol.js";
export declare function workerDomainSchemas(): WorkerConfig["domainTools"];
export declare function workerDomainAdapter(project: DomainProject, execution: boolean): {
    assertQuiescent(lease: WorkLease): Promise<void>;
    invoke(lease: WorkLease, toolCallId: string, input: Extract<TeamToolInput, {
        action: "domain";
    }>): Promise<unknown>;
};
