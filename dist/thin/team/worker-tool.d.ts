import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type TeamToolInput, type WorkerConfig } from "./protocol.js";
export declare function registerWorkerTeamTool(pi: ExtensionAPI, config: WorkerConfig, Type: typeof import("typebox").Type, invoke: (toolCallId: string, input: TeamToolInput, signal?: AbortSignal) => Promise<string>): void;
