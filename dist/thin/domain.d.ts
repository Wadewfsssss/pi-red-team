import { type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
export declare function currentAttempt(ctx: Pick<ExtensionContext, "sessionManager">): string | undefined;
export declare function registerDomainTools(pi: ExtensionAPI): void;
