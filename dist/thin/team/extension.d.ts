import { type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { TeamSupervisor } from "./runtime.js";
import type { DomainProject } from "../state.js";
import { GraphCapability } from "../graph-capability.js";
export declare function registerTeamTools(pi: ExtensionAPI, createSupervisor?: (project: DomainProject, notify: (status: unknown) => void) => TeamSupervisor, graph?: GraphCapability): {
    close: () => Promise<void>;
    command: (args: string, ctx: ExtensionContext) => Promise<boolean>;
    updateGraph: (ctx: ExtensionContext) => Promise<void>;
};
