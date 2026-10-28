import type { ExtensionAPI, ExtensionContext, ExtensionToolContext, ToolLoadout } from "@earendil-works/pi-coding-agent";
import { z } from "redteam-zod";

const selectionSchema = z.object({ version: z.literal(1), mode: z.enum(["auto", "off"]), server: z.string().regex(/^[A-Za-z0-9_-]+$/) }).strict();
export type GraphSelection = z.infer<typeof selectionSchema>;
type NamedTool = { name: string; parameters?: unknown };
export type GraphAccess = { mode: "auto" | "off"; server: string; read: boolean; write: boolean; reason: string };

export class GraphOperationError extends Error {
  constructor(message: string, readonly data: Record<string, unknown>) { super(message); }
}

export function bindCypher(tools: readonly NamedTool[], server: string, write: boolean) {
  if (!/^[A-Za-z0-9_-]+$/.test(server)) throw new Error("Invalid MCP server name");
  const prefix = `mcp__${server.replaceAll("-", "_")}__`;
  const candidates = tools.filter(tool => tool.name.startsWith(prefix) && (write ? /write.*cypher/i : /read.*cypher/i).test(tool.name.slice(prefix.length)));
  if (candidates.length !== 1) return { reason: candidates.length ? "ambiguous" : "not_callable", tool: undefined };
  const parameters = candidates[0]!.parameters as { type?: string; properties?: Record<string, { type?: string }>; required?: string[] } | undefined;
  if (parameters && (parameters.type !== "object" || parameters.properties?.query?.type !== "string" || parameters.required?.some(name => name !== "query"))) return { reason: "schema_incompatible", tool: undefined };
  return { reason: "callable_health_unknown", tool: candidates[0]!.name };
}

export function unavailableGraph(reason: string, operation: string, server: string) {
  return { status: "unavailable", reason, operation, server, executed: false, persistence: "not_attempted", fallback: "Continue native tools, evidence and rt_search; graph-specific work remains blocked. Do not repeatedly request graph refresh." };
}

export class GraphCapability {
  private selection: GraphSelection = { version: 1, mode: "auto", server: "neo4j" };
  private sessionKey?: string;
  private fingerprint?: string;
  private generation = 0;
  private controllers = new Set<AbortController>();
  private lastFailure?: { at: number; server: string; reason: string };
  private callable: readonly NamedTool[] = [];

  constructor(private readonly pi: ExtensionAPI) {}

  private refreshLoadout() {
    if (this.pi.setActiveTools && this.pi.getActiveTools) this.pi.setActiveTools(this.pi.getActiveTools());
  }

  reaches(server?: unknown) {
    return this.selection.mode === "off" || server !== undefined && server !== this.selection.server ? [] : [`mcp__${this.selection.server.replaceAll("-", "_")}`];
  }

  cancel() {
    this.generation += 1;
    for (const controller of this.controllers) controller.abort(new Error("Graph selection or session changed"));
    this.controllers.clear(); this.lastFailure = undefined;
  }

  restore(ctx: ExtensionContext) {
    this.cancel(); this.selection = { version: 1, mode: "auto", server: "neo4j" };
    this.sessionKey = `${ctx.cwd}:${ctx.sessionManager.getSessionId()}`;
    this.fingerprint = undefined;
    this.observe(ctx);
    this.refreshLoadout();
  }

  private observe(ctx: ExtensionContext) {
    const key = `${ctx.cwd}:${ctx.sessionManager.getSessionId()}`;
    if (key !== this.sessionKey) { this.restore(ctx); return; }
    const entries = ctx.sessionManager.getBranch?.() ?? [];
    const entry = [...entries].reverse().find(value => value.type === "custom" && value.customType === "redteam-graph-selection");
    const fingerprint = entry ? JSON.stringify(entry) : undefined;
    if (fingerprint === this.fingerprint) return;
    this.cancel(); this.fingerprint = fingerprint;
    const parsed = entry?.type === "custom" ? selectionSchema.safeParse(entry.data) : undefined;
    this.selection = parsed?.success ? parsed.data : { version: 1, mode: parsed ? "off" : "auto", server: "neo4j" };
    if (parsed && !parsed.success) this.lastFailure = { at: Date.now(), server: "neo4j", reason: "invalid_saved_selection" };
    this.refreshLoadout();
  }

  select(ctx: ExtensionContext, mode: "auto" | "off", server?: string) {
    this.observe(ctx); this.cancel();
    this.selection = selectionSchema.parse({ version: 1, mode, server: server ?? this.selection.server });
    this.pi.appendEntry("redteam-graph-selection", this.selection);
    const entry = [...(ctx.sessionManager.getBranch?.() ?? [])].reverse().find(value => value.type === "custom" && value.customType === "redteam-graph-selection");
    this.fingerprint = entry ? JSON.stringify(entry) : undefined;
    this.refreshLoadout();
    return this.status(ctx);
  }

  prepare(loadout: ToolLoadout) {
    this.callable = loadout.callable;
    const read = bindCypher(loadout.callable, this.selection.server, false);
    const write = bindCypher(loadout.callable, this.selection.server, true);
    return { descriptions: { rt_graph: `Optional Neo4j graph enhancement. Mode ${this.selection.mode}; server ${this.selection.server}; read ${Boolean(read.tool)}, write ${Boolean(write.tool)}; health unknown until a query succeeds. Use only for relationship-dependent work. Absence may be delayed registration, not missing configuration. No automatic setup or retry.` }, ...(this.selection.mode === "off" ? { hiddenDeclarations: ["rt_graph"] } : {}) };
  }

  status(ctx: ExtensionContext, tools?: readonly NamedTool[]): GraphAccess & { lastFailure?: { at: number; server: string; reason: string }; health: "unknown" } {
    this.observe(ctx);
    const active = this.pi.getActiveTools?.() ?? [];
    tools ??= this.pi.getAllTools?.().filter(tool => tool.exposure === "codemode" || tool.exposure === "deferred" || tool.exposure === "direct" && active.includes(tool.name)) ?? this.callable;
    const read = bindCypher(tools, this.selection.server, false), write = bindCypher(tools, this.selection.server, true);
    const cooling = this.lastFailure?.server === this.selection.server && Date.now() - this.lastFailure.at < 30000;
    return { mode: this.selection.mode, server: this.selection.server, read: this.selection.mode !== "off" && !cooling && Boolean(read.tool), write: this.selection.mode !== "off" && !cooling && Boolean(write.tool), reason: this.selection.mode === "off" ? "disabled" : cooling ? "failure_cooldown" : read.tool || write.tool ? "callable_health_unknown" : read.reason === "not_callable" && write.reason === "not_callable" ? "not_observed" : `${read.reason}/${write.reason}`, health: "unknown", lastFailure: this.lastFailure };
  }

  async run<Output>(ctx: ExtensionToolContext, server: string | undefined, write: boolean, signal: AbortSignal | undefined, operation: (signal: AbortSignal, server: string) => Promise<Output>): Promise<Output> {
    const state = this.status(ctx, ctx.tools);
    const selected = server ?? state.server;
    const binding = bindCypher(ctx.tools, selected, write);
    const reason = state.mode === "off" ? "disabled" : selected !== state.server ? "server_not_selected" : !binding.tool ? binding.reason : this.lastFailure?.server === selected && Date.now() - this.lastFailure.at < 30000 ? "failure_cooldown" : undefined;
    if (reason) throw new GraphOperationError(`Graph ${reason}; inspect Pi /mcp if needed`, unavailableGraph(reason, write ? "record" : "read", selected));
    signal?.throwIfAborted();
    const generation = this.generation, controller = new AbortController();
    this.controllers.add(controller);
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    try {
      const result = await operation(combined, selected);
      if (!write && combined.aborted) throw new GraphOperationError("Graph read completed after cancellation; discard the stale result", { status: "error", reason: "cancelled", server: selected, executed: true, persistence: "not_applicable" });
      if (generation === this.generation) this.lastFailure = undefined;
      return result;
    } catch (error) {
      if (combined.aborted && !(error instanceof GraphOperationError)) throw new GraphOperationError("Graph operation cancelled; completion is not verified", { status: "error", reason: "cancelled", server: selected, persistence: write ? "unknown" : "not_applicable", diagnostic: error instanceof Error ? error.message : String(error) });
      if (generation === this.generation && !combined.aborted && error instanceof GraphOperationError && error.data.status === "error") this.lastFailure = { at: Date.now(), server: selected, reason: String(error.data.reason) };
      throw error;
    } finally { this.controllers.delete(controller); }
  }
}
