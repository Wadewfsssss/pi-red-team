import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { z } from "redteam-zod";
import { atomicWrite, digest, rejectSymlinks, safePath } from "../files.js";
import { readBoundedFile } from "./project.js";
import { domainPath, projectKey, resolveWorkspace, type DomainProject } from "./state.js";
import { bindCypher, GraphOperationError, unavailableGraph } from "./graph-capability.js";

const identifier = z.string().min(1).max(200);
const kind = z.enum(["asset", "identity", "observation", "hypothesis", "finding", "attack_step", "credential", "host", "service", "objective", "evidence"]);
export const propertiesSchema = z.object({ cvss: z.number().min(0).max(10).nullable().optional(), status: z.enum(["confirmed", "needs_review", "rejected"]).nullable().optional(), confidence: z.number().min(0).max(1).nullable().optional(), risk: z.enum(["low", "medium", "high"]).nullable().optional(), technique: z.string().max(100).nullable().optional() }).strict();
export const entitySchema = z.object({ id: identifier, kind, name: z.string().min(1).max(300), properties: propertiesSchema.optional() }).strict();
export const linkSchema = z.object({ id: identifier, source: identifier, target: identifier, relation: z.string().min(1).max(100), state: z.enum(["observed", "hypothesis", "refuted"]), evidenceRefs: z.array(z.string().min(1).max(500)).max(20), evidenceHashes: z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(20).optional(), evidenceVerified: z.boolean().optional(), observedAt: z.string().datetime({ offset: true }), sourceKind: kind.optional(), targetKind: kind.optional(), sourceProperties: propertiesSchema.optional(), targetProperties: propertiesSchema.optional() }).strict();
export type GraphLink = z.infer<typeof linkSchema>;
const quote = (value: string) => JSON.stringify(value);
const propertyMap = (properties: z.infer<typeof propertiesSchema> = {}) => `{${Object.entries(properties).map(([name, value]) => `${name}: ${JSON.stringify(value)}`).join(", ")}}`;

export async function evidenceReferences(project: DomainProject, references: string[]) {
  return Promise.all(references.map(async reference => {
    const path = safePath(project.cwd, reference);
    await rejectSymlinks(project.cwd, path);
    const content = await readBoundedFile(path, 16 * 1024 * 1024);
    return { reference, sha256: digest(content) };
  }));
}

export async function nativeCypher(ctx: ExtensionToolContext, server: string, write: boolean, query: string, signal?: AbortSignal) {
  if (!/^[A-Za-z0-9_-]+$/.test(server)) throw new Error("Invalid MCP server name");
  signal?.throwIfAborted();
  const binding = bindCypher(ctx.tools, server, write);
  if (!binding.tool) throw new GraphOperationError(`Expected one callable ${write ? "write" : "read"} Cypher tool; inspect Pi /mcp`, unavailableGraph(binding.reason, write ? "record" : "read", server));
  try {
    const outcome = await ctx.executeTool(binding.tool, { query }, { signal });
    if (outcome.isError) throw new GraphOperationError("Neo4j MCP query failed; graph persistence is not verified", { status: "error", reason: "query_failed", server, executed: true, persistence: write ? "unknown" : "not_applicable", diagnostic: outcome.result });
    return outcome.result;
  } catch (error) {
    if (error instanceof GraphOperationError) throw error;
    throw new GraphOperationError("Neo4j MCP call interrupted or failed; persistence is not verified", { status: "error", reason: signal?.aborted ? "cancelled" : "call_failed", server, executed: true, persistence: write ? "unknown" : "not_applicable", diagnostic: error instanceof Error ? error.message : String(error) });
  }
}

export async function recordLink(project: DomainProject, ctx: ExtensionToolContext, server: string, input: { source: z.infer<typeof entitySchema>; target: z.infer<typeof entitySchema>; link: GraphLink }, signal?: AbortSignal) {
  const source = entitySchema.parse(input.source), target = entitySchema.parse(input.target), link = linkSchema.parse(input.link);
  if (source.id !== link.source || target.id !== link.target) throw new Error("Graph link endpoints do not match entities");
  if (link.state === "observed" && !link.evidenceRefs.length) throw new Error("Observed graph links require evidence references");
  const binding = bindCypher(ctx.tools, server, true);
  if (!binding.tool) throw new GraphOperationError("No callable graph write tool; inspect Pi /mcp", unavailableGraph(binding.reason, "record", server));
  const refs = await evidenceReferences(project, link.evidenceRefs);
  for (const entry of [source, target]) {
    if (entry.kind !== "finding") continue;
    if (entry.properties?.status === "confirmed" && (!refs.length || link.state !== "observed")) throw new Error("Confirmed finding records require observed evidence references");
  }
  await resolveWorkspace(project);
  const key = quote(projectKey(project));
  const hashes = JSON.stringify(refs.map(reference => reference.sha256));
  const evidence = JSON.stringify(refs.map(reference => reference.reference));
  const query = `MERGE (source:RTEntity {projectId: ${key}, id: ${quote(source.id)}})
SET source.kind = ${quote(source.kind)}, source.name = ${quote(source.name)}
SET source += ${propertyMap(source.properties)}
MERGE (target:RTEntity {projectId: ${key}, id: ${quote(target.id)}})
SET target.kind = ${quote(target.kind)}, target.name = ${quote(target.name)}
SET target += ${propertyMap(target.properties)}
MERGE (source)-[link:RT_LINK {id: ${quote(link.id)}}]->(target)
SET link.relation = ${quote(link.relation)}, link.state = ${quote(link.state)}, link.evidenceRefs = ${evidence}, link.evidenceHashes = ${hashes}, link.observedAt = ${quote(link.observedAt)}
RETURN link.id AS id, link.state AS state`;
  const result = await nativeCypher(ctx, server, true, query, signal);
  const localFindingsWritten: string[] = [];
  try {
    signal?.throwIfAborted();
    for (const entry of [source, target].filter(value => value.kind === "finding")) {
      await atomicWrite(await domainPath(project, "findings", `${digest(entry.id)}.json`), JSON.stringify({ ...entry, evidence: refs, capturedAt: new Date().toISOString(), confirmationIsCallerDeclared: true, graphPersistence: "acknowledged" }, null, 2) + "\n");
      localFindingsWritten.push(entry.id);
    }
  } catch (error) {
    throw new GraphOperationError("Graph write acknowledged but local recording failed", { status: "error", reason: "local_record_failed", executed: true, persisted: true, persistence: "acknowledged", localFindingsWritten, diagnostic: error instanceof Error ? error.message : String(error) });
  }
  return { persisted: true, persistence: "acknowledged", localFindingsWritten, projectKey: projectKey(project), evidence: refs, result };
}

export async function graphSnapshot(project: DomainProject, ctx: ExtensionToolContext, server: string, signal?: AbortSignal): Promise<GraphLink[]> {
  const binding = bindCypher(ctx.tools, server, false);
  if (!binding.tool) throw new GraphOperationError("No callable graph read tool; inspect Pi /mcp", unavailableGraph(binding.reason, "read", server));
  await resolveWorkspace(project);
  const result = await nativeCypher(ctx, server, false, `MATCH (source:RTEntity {projectId: ${quote(projectKey(project))}})-[link:RT_LINK]->(target:RTEntity {projectId: ${quote(projectKey(project))}})
RETURN link.id AS id, source.id AS source, target.id AS target, link.relation AS relation, link.state AS state, link.evidenceRefs AS evidenceRefs, link.evidenceHashes AS evidenceHashes, link.observedAt AS observedAt, source.kind AS sourceKind, target.kind AS targetKind,
{cvss: source.cvss, status: source.status, confidence: source.confidence, risk: source.risk, technique: source.technique} AS sourceProperties,
{cvss: target.cvss, status: target.status, confidence: target.confidence, risk: target.risk, technique: target.technique} AS targetProperties LIMIT 257`, signal);
  for (const content of result.content) {
    if (content.type !== "text") continue;
    let parsed: unknown;
    try { parsed = JSON.parse(content.text); } catch { continue; }
    if (!Array.isArray(parsed)) continue;
    const links = z.array(linkSchema).max(256).parse(parsed);
    if (new Set(links.map(link => link.id)).size !== links.length) throw new Error("Duplicate graph relationship IDs; repair graph before planning");
    return Promise.all(links.map(async link => {
      let evidenceVerified = false;
      try {
        const references = await evidenceReferences(project, link.evidenceRefs);
        evidenceVerified = references.length > 0 && references.length === link.evidenceHashes?.length && references.every((reference, index) => reference.sha256 === link.evidenceHashes?.[index]);
      } catch {}
      return { ...link, evidenceVerified };
    }));
  }
  throw new Error("Neo4j returned an unsupported snapshot format");
}

export function candidatePaths(links: GraphLink[], source: string, target: string, now = Date.now(), maxAgeSeconds = 86400, maxDepth = 8) {
  z.array(linkSchema).max(256).parse(links);
  z.number().int().min(1).max(20).parse(maxDepth);
  const queue: { node: string; nodes: string[]; edges: GraphLink[] }[] = [{ node: source, nodes: [source], edges: [] }];
  const paths: { nodes: string[]; links: GraphLink[]; unverified: string[]; staleEvidence: string[]; verdict: string }[] = [];
  let examined = 0;
  while (queue.length && examined < 1000 && paths.length < 20) {
    const current = queue.shift()!;
    examined += 1;
    if (current.node === target && current.edges.length) {
      paths.push({ nodes: current.nodes, links: current.edges,
        unverified: current.edges.filter(link => link.state !== "observed" || link.evidenceVerified !== true).map(link => link.id),
        staleEvidence: current.edges.filter(link => now - Date.parse(link.observedAt) > maxAgeSeconds * 1000 || Date.parse(link.observedAt) > now).map(link => link.id),
        verdict: "candidate-only; relationships do not prove a working exploit chain",
      });
      continue;
    }
    if (current.edges.length >= maxDepth) continue;
    for (const link of links) {
      if (link.state === "refuted" || link.source !== current.node || current.nodes.includes(link.target)) continue;
      if (queue.length >= 1000) break;
      queue.push({ node: link.target, nodes: [...current.nodes, link.target], edges: [...current.edges, link] });
    }
  }
  return { paths, bounded: true, maxDepth, examined, truncated: queue.length > 0 };
}
