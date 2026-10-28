import type { DomainProject } from "../state.js";
export declare function teamChanged(project: DomainProject): void;
export declare function onTeamChange(project: DomainProject, listener: () => void): () => void;
export declare function waitForTeamChange(project: DomainProject, signal: AbortSignal, timeoutMs?: number): Promise<void>;
