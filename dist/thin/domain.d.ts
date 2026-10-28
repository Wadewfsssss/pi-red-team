import { type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { GraphCapability } from "./graph-capability.js";
export declare function currentAttempt(ctx: Pick<ExtensionContext, "sessionManager">): string | undefined;
export declare function registerDomainTools(pi: ExtensionAPI, graph?: GraphCapability): void;
