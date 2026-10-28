import { candidatePaths, linkSchema } from "./graph.js";
import { z } from "redteam-zod";
const latticeRelations = new Set(["ENABLES", "NEXT", "YIELDS", "AUTHENTICATES", "REQUIRES", "ESCALATES_TO", "PIVOTS_TO", "CAN_ACCESS", "EXPOSES"]);
const relation = (link) => link.relation.toUpperCase();
function entities(links) {
    const nodes = new Map();
    for (const link of links) {
        for (const entry of [{ id: link.source, kind: link.sourceKind, properties: link.sourceProperties }, { id: link.target, kind: link.targetKind, properties: link.targetProperties }]) {
            const previous = nodes.get(entry.id);
            if (previous && entry.kind && previous.kind && entry.kind !== previous.kind)
                throw new Error("Inconsistent entity kinds in graph snapshot");
            for (const [key, value] of Object.entries(entry.properties ?? {})) {
                if (value != null && previous?.properties[key] != null && previous.properties[key] !== value)
                    throw new Error("Inconsistent entity properties in graph snapshot");
            }
            nodes.set(entry.id, { id: entry.id, kind: entry.kind ?? previous?.kind, properties: { ...previous?.properties, ...Object.fromEntries(Object.entries(entry.properties ?? {}).filter(([, value]) => value != null)) } });
        }
    }
    return nodes;
}
function betweenness(links) {
    const adjacency = new Map();
    for (const link of links) {
        if (!adjacency.has(link.source))
            adjacency.set(link.source, new Set());
        if (!adjacency.has(link.target))
            adjacency.set(link.target, new Set());
        if (link.source !== link.target)
            adjacency.get(link.source).add(link.target);
    }
    const scores = new Map([...adjacency.keys()].map(id => [id, 0]));
    for (const source of adjacency.keys()) {
        const stack = [], queue = [source];
        const predecessors = new Map([...adjacency.keys()].map(id => [id, []]));
        const distances = new Map([...adjacency.keys()].map(id => [id, -1]));
        const counts = new Map([...adjacency.keys()].map(id => [id, 0]));
        distances.set(source, 0);
        counts.set(source, 1);
        for (let index = 0; index < queue.length; index++) {
            const current = queue[index];
            stack.push(current);
            for (const target of adjacency.get(current)) {
                if (distances.get(target) < 0) {
                    distances.set(target, distances.get(current) + 1);
                    queue.push(target);
                }
                if (distances.get(target) === distances.get(current) + 1) {
                    counts.set(target, counts.get(target) + counts.get(current));
                    predecessors.get(target).push(current);
                }
            }
        }
        const dependency = new Map([...adjacency.keys()].map(id => [id, 0]));
        while (stack.length) {
            const current = stack.pop();
            for (const predecessor of predecessors.get(current))
                dependency.set(predecessor, dependency.get(predecessor) + counts.get(predecessor) / counts.get(current) * (1 + dependency.get(current)));
            if (current !== source)
                scores.set(current, scores.get(current) + dependency.get(current));
        }
    }
    return [...scores].map(([id, score]) => ({ id, score })).sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));
}
export function reasonGraph(links, query, input = {}, now = Date.now()) {
    z.array(linkSchema).max(256).parse(links);
    const nodes = entities(links);
    const lattice = links.filter(link => link.state !== "refuted" && latticeRelations.has(relation(link)));
    const age = input.maxAgeSeconds ?? 86400;
    z.number().int().min(1).max(2592000).parse(age);
    const fresh = (link) => link.state === "observed" && link.evidenceVerified === true && now >= Date.parse(link.observedAt) && now - Date.parse(link.observedAt) <= age * 1000;
    const base = { query, candidateOnly: true, nodeCount: nodes.size, relationshipCount: lattice.length };
    if (query === "next") {
        if (!input.sourceId)
            throw new Error("sourceId is required for next-step inference");
        const steps = lattice.filter(link => link.source === input.sourceId && relation(link) === "ENABLES").map(enabled => ({ stepId: enabled.target, evidenceVerified: fresh(enabled),
            next: lattice.filter(link => link.source === enabled.target && relation(link) === "NEXT").map(link => link.target),
            gains: lattice.filter(link => link.source === enabled.target && relation(link) === "YIELDS").map(link => link.target),
            prerequisites: lattice.filter(link => link.source === enabled.target && relation(link) === "REQUIRES").map(link => ({ id: link.target, evidenceVerified: fresh(link) })),
        }));
        return { ...base, steps };
    }
    if (query === "chokepoints")
        return { ...base, scores: betweenness(lattice).slice(0, 20), engine: "local-directed-unweighted-Brandes", containsUnverifiedRelationships: lattice.some(link => !fresh(link)) };
    const targets = input.targetId ? [input.targetId] : links.filter(link => link.state !== "refuted" && relation(link) === "TARGETS" && nodes.get(link.source)?.kind === "objective").map(link => link.target);
    const sources = input.sourceId ? [input.sourceId] : [...nodes.values()].filter(node => node.kind === "finding").map(node => node.id);
    if (!sources.length || !targets.length)
        throw new Error("Specify sourceId/targetId or record Finding and Objective TARGETS entities first");
    const chains = [];
    let truncated = false;
    let searches = 0;
    for (const source of [...new Set(sources)].slice(0, 64)) {
        for (const target of [...new Set(targets)].slice(0, 16)) {
            if (searches++ >= 64) {
                truncated = true;
                break;
            }
            const result = candidatePaths(lattice, source, target, now, age, 20);
            truncated ||= result.truncated;
            for (const path of result.paths)
                chains.push({ sourceId: source, targetId: target, ...path });
        }
    }
    chains.sort((left, right) => left.links.length - right.links.length || left.sourceId.localeCompare(right.sourceId));
    truncated ||= chains.length > 20 || sources.length > 64 || targets.length > 16;
    if (query === "chains")
        return { ...base, chains: chains.slice(0, 20), truncated, maxDepth: 20 };
    if (query === "evidence")
        return { ...base, chains: chains.slice(0, 20).map(chain => ({ sourceId: chain.sourceId, targetId: chain.targetId, receipts: chain.links.map(link => ({ linkId: link.id, references: link.evidenceRefs, hashes: link.evidenceHashes ?? [], verified: fresh(link) })) })), truncated };
    const ranked = [];
    for (const source of new Set(sources)) {
        const node = nodes.get(source);
        if (node?.kind !== "finding" || node.properties.status !== "confirmed" || node.properties.cvss == null)
            continue;
        const chain = chains.find(path => path.sourceId === source);
        if (!chain)
            continue;
        const supported = !chain.unverified.length && !chain.staleEvidence.length;
        const risk = chain.nodes.slice(1).filter(id => nodes.get(id)?.kind === "attack_step").reduce((total, id) => total + ({ high: 0.6, medium: 0.3, low: 0 }[nodes.get(id)?.properties.risk ?? "low"]), 0);
        const score = supported ? node.properties.cvss + 2 + risk : null;
        ranked.push({ findingId: source, localCvss: node.properties.cvss, score, severity: score === null ? "unverified" : score >= 9 ? "Critical" : score >= 7 ? "High" : score >= 4 ? "Medium" : "Low", targetId: chain.targetId, path: chain.nodes, promotionIsPolicyNotCvss: true });
    }
    ranked.sort((left, right) => (right.score ?? -1) - (left.score ?? -1));
    return { ...base, findings: ranked.slice(0, 20), truncated, reachBonus: 2, riskWeights: { high: 0.6, medium: 0.3, low: 0 } };
}
