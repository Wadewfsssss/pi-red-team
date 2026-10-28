import { type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { TeamSupervisor } from "./runtime.js";
import type { DomainProject } from "../state.js";
export declare function registerTeamTools(pi: ExtensionAPI, createSupervisor?: (project: DomainProject, notify: (status: unknown) => void) => TeamSupervisor): {
    close: () => Promise<void>;
    command: (args: string, ctx: ExtensionContext) => Promise<boolean>;
};
