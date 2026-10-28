import type { TeamToolInput, WorkerConfig } from "./protocol.js";
import { type WorkLease } from "./store.js";
export declare function workerStateAdapter(config: WorkerConfig, domain?: (lease: WorkLease, toolCallId: string, input: Extract<TeamToolInput, {
    action: "domain";
}>) => Promise<unknown>, assertQuiescent?: (lease: WorkLease) => Promise<void>): (toolCallId: string, input: TeamToolInput) => Promise<unknown>;
export declare function renewingWorkerStateAdapter(config: WorkerConfig, domain?: Parameters<typeof workerStateAdapter>[1], assertQuiescent?: Parameters<typeof workerStateAdapter>[2]): {
    invoke(toolCallId: string, input: TeamToolInput): Promise<unknown>;
    renew(): Promise<void>;
};
