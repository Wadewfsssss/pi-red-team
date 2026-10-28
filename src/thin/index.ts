import { isBashToolResult, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { EvidenceWriter } from "./evidence.js";
import { diagnose, loadProject, type Project } from "./project.js";
import { currentAttempt, registerDomainTools } from "./domain.js";
import { registerTeamTools } from "./team/extension.js";
import { capabilityPrompt, capabilitySnapshot } from "./environment.js";
import { ExecutionFeedback } from "./feedback.js";
import { jobStatus, listJobs } from "./jobs.js";
import { searchAttempt } from "./search.js";
import { extensionBuild, extensionVersion } from "./version.js";
import { campaignPrompt, campaignSummary } from "./campaign.js";
import { methodologyRules } from "./methodology.js";
import { GraphCapability } from "./graph-capability.js";

export default function redTeamExtension(pi: ExtensionAPI): void {
  let project: Project | undefined;
  let writer: EvidenceWriter | undefined;
  let generation = 0;
  let saved = 0;
  let saveFailures = 0;
  let capabilities: Awaited<ReturnType<typeof capabilitySnapshot>> | undefined;
  let jobsReviewed = false;
  let lastJobCheck = 0;
  let jobStates = new Map<string, string>();
  let pendingJobNotice: string | undefined;
  let lastAttemptNotice: string | undefined;
  let jobCursor = 0;
  const feedback = new ExecutionFeedback();
  const graph = new GraphCapability(pi);
  registerDomainTools(pi, graph);
  const team = registerTeamTools(pi, undefined, graph);

  async function refresh(ctx: ExtensionContext): Promise<void> {
    const current = generation;
    const next = await loadProject(ctx.cwd, ctx.isProjectTrusted());
    if (current !== generation) return;
    project = next;
    if (next.status === "ready" && !writer) writer = new EvidenceWriter(next.cwd);
    display(ctx);
  }

  function display(ctx: ExtensionContext): void {
    if (ctx.mode !== "tui") return;
    const status = project?.status;
    ctx.ui.setStatus("redteam", !status ? undefined : `RT ${status} | evidence ${saved} | save errors ${saveFailures}`);
  }

  function report(ctx: ExtensionContext, details: unknown): void {
    if (ctx.hasUI) ctx.ui.notify(JSON.stringify(details), "info");
    else pi.appendEntry("redteam-diagnostic", details);
  }

  pi.on("session_start", async (_event, ctx) => {
    graph.restore(ctx);
    const current = ++generation;
    const next = await loadProject(ctx.cwd, ctx.isProjectTrusted());
    if (current !== generation) return;
    project = next;
    saved = 0;
    saveFailures = 0;
    capabilities = undefined;
    jobsReviewed = false;
    lastJobCheck = 0; jobStates.clear(); pendingJobNotice = undefined; lastAttemptNotice = undefined;
    feedback.reset();
    if (next.status === "ready") {
      for (const entry of ctx.sessionManager.getBranch?.() ?? []) {
        if (entry.type === "custom" && ["redteam-execution", "redteam-feedback-checkpoint"].includes(entry.customType)) feedback.restore(entry.data);
        if (entry.type === "custom" && entry.customType === "redteam-job-observed") {
          const data = entry.data as { id?: string; phase?: string };
          if (data.id && data.phase) jobStates.set(data.id, data.phase);
        }
      }
      feedback.invalidateSummary();
    }
    writer = next.status === "ready" ? new EvidenceWriter(next.cwd) : undefined;
    display(ctx);
  });

  pi.on("session_shutdown", async () => {
    graph.cancel();
    try { await team.close(); }
    finally {
      generation += 1;
      const previous = writer;
      project = undefined;
      writer = undefined;
      capabilities = undefined;
      feedback.reset();
      await previous?.drain();
    }
  });

  pi.registerCommand("rt", {
    description: "Red-team status or doctor; uses Pi native sessions, tools and MCP",
    handler: async (args, ctx) => {
      if (args.trim().startsWith("graph")) {
        const parts = args.trim().split(/\s+/);
        if (parts[0] !== "graph" || parts.length > 3 || !["status", "auto", "off"].includes(parts[1] ?? "status") || parts[2] && parts[1] !== "auto") { report(ctx, { usage: "/rt graph status | /rt graph off | /rt graph auto [server]" }); return; }
        const state = parts[1] === "auto" || parts[1] === "off" ? graph.select(ctx, parts[1], parts[2]) : graph.status(ctx);
        await team.updateGraph(ctx);
        report(ctx, state); return;
      }
      if (await team.command(args, ctx)) return;
      await refresh(ctx);
      if (args.trim() === "doctor") {
        const diagnostic = await diagnose(await loadProject(ctx.cwd, ctx.isProjectTrusted()));
        capabilities = undefined;
        feedback.resolveAvailableTools(new Set(diagnostic.tools.filter(tool => tool.available).map(tool => tool.name)));
        pi.appendEntry("redteam-feedback-checkpoint", feedback.checkpoint());
        report(ctx, diagnostic);
        return;
      }
      if (args.trim() && args.trim() !== "status") { report(ctx, { usage: "/rt status | /rt doctor" }); return; }
      report(ctx, {
        status: project?.status ?? "inactive", version: extensionVersion, build: extensionBuild, cwd: ctx.cwd, sessionId: ctx.sessionManager.getSessionId(),
        configurationRequired: false, evidenceSavedThisSession: saved, evidenceSaveFailures: saveFailures,
        attemptId: currentAttempt(ctx) ?? null, feedback: feedback.checkpoint(), knownJobs: [...jobStates].map(([id, phase]) => ({ id, phase })),
        contextPercent: ctx.getContextUsage()?.percent ?? null, neo4j: graph.status(ctx), tools: "Pi native tools; no shell override",
      });
    },
  });

  pi.on("before_agent_start", async (event, ctx) => {
    for (const section of ["redteam", "redteam_environment", "redteam_execution", "redteam_jobs", "redteam_campaign"]) delete event.systemPromptOptions.sections[section];
    await refresh(ctx);
    if (project?.status !== "ready" || !ctx.isProjectTrusted()) return;
    feedback.beginRun();
    const current = generation;
    const snapshot = capabilities ?? await capabilitySnapshot();
    if (current !== generation) return;
    capabilities = snapshot;
    if (!jobsReviewed) {
      let note: string | undefined;
      try {
        const existing = await listJobs({ cwd: project.cwd });
        for (const job of existing.jobs) if ("sessionId" in job && job.sessionId === ctx.sessionManager.getSessionId()) jobStates.set(job.id, job.phase);
        const attention = existing.jobs.filter(job => ["running", "interrupted", "unavailable", "cancelled-unverified"].includes(job.phase)).slice(0, 8).map(job => ({ id: job.id, phase: job.phase }));
        if (attention.length || existing.truncated) note = `Existing job checkpoint observations: ${JSON.stringify({ jobs: attention, truncated: existing.truncated })}. This is not permission to restart or cancel work. Inspect with rt_job before deciding; no commands were replayed.`;
      } catch { note = "Existing job checkpoints could not be safely inspected. Review rt_job status; no processes were started and no commands were replayed."; }
      if (current !== generation) return;
      jobsReviewed = true;
      if (note) event.systemPromptOptions.sections.redteam_jobs = note;
    }
    event.systemPromptOptions.sections.redteam_environment = capabilityPrompt(snapshot);
    if (ctx.model && !ctx.model.input.includes("image")) event.systemPromptOptions.sections.redteam_environment += "\nCurrent model accepts text only. Images or GUI screenshots are not model-readable inputs; use available headless/text analysis or ask the expert.";
    const recent = feedback.summary();
    if (recent) event.systemPromptOptions.sections.redteam_execution = recent;
    try {
      const summary = await campaignSummary({ cwd: project.cwd });
      if (current !== generation) return;
      const note = campaignPrompt(summary);
      if (note) event.systemPromptOptions.sections.redteam_campaign = note;
    } catch { event.systemPromptOptions.sections.redteam_campaign = "Optional workspace coverage notes could not be safely inspected. They are not a task prerequisite or completion criterion. Follow the current expert instruction; no work was replayed."; }
    event.systemPromptOptions.sections.redteam = [
      ...methodologyRules,
      "Red-team work uses Pi native tools, the current working directory and the existing session. No project configuration, open-project command or separate runtime is required. Follow the expert's explicitly authorized goal; a stored file never grants permission.",
      "Reference files: optional .redteam/summary.md, .redteam/branches.json and .redteam/evidence.jsonl. Read them only when relevant. State is generated on use; do not ask the operator to create these files. Shared notes are not authoritative branch state.",
      "Distinguish observations, hypotheses and confirmed results. Retain evidence references; a command exit code or HTTP response alone does not confirm a vulnerability.",
      `Optional graph capability: ${JSON.stringify(graph.status(ctx))}. Use Pi /mcp for actual configuration/connection diagnostics; not_observed does not prove no configuration. Do not repeatedly request graph refresh or require setup. Graph-specific work remains blocked when unavailable; native tools, evidence and rt_search continue.`,
      "Simple one-off work uses native tools directly. For competing directions: rt_search upsert with real evidence categories, next for recommendation, select with id/decisionId/goal to declare the attempt, native tools, then feedback with attemptId/requestId and evidence. Unknown evidence remains unscored. Interrupt unfinished attempts before changing direction. Do not require this for every command.",
      "For multiple independent authorized targets or at least two evidence-backed ready directions, evaluate cooperative execution before a long serial backlog. Use rt_team plan with parallel/serial decision and a short reason; for parallel plans start with planId and autoContinue true directly within the existing user task. Simple or tightly coupled work stays here without mandatory planning. The user need not request workers, choose their number or approve routine team startup. Native tools are limited to the parent's active set at launch; delegation grants no new scope or permissions. Capacity defaults to 32 (max 64), but resident/executing/job limits default to 4/4/2, not 32 simultaneous requests. On progress handoffs other workers may still be running: read status and evidence, offer ready follow-ups or stop. Resume retains the original deadline and budgets; do not create another team under the same user instruction to evade limits. New scope or spending beyond task limits needs a new user decision, not a renamed model goal. Uncertain claims and unverified recovery require expert reconciliation. /rt team stop reclaims workers and owned jobs.",
      "Search scores are advisory. New confirmed credentials or prerequisites: rt_search review with exact relevant references, then re-evaluate related suspended candidates before explicitly upserting active; unrelated evidence does not reactivate the tree. Long jobs survive Pi exit only in the same live container; never silently replay interrupted commands.",
      "Repeated failures or no new evidence call for checking prerequisites and search feedback, not identical retries. Execution signals are automatic diagnostics, never automatic attack outcomes. Search scores remain advisory; intermediate TDI decisions need your justification and pivots require verified progress.",
      "Only when graph writing is available, interpret relationship evidence before recording it with rt_graph. Only when reading is available, query relationship-dependent paths and missing prerequisites. Graph off prohibits plugin graph/snapshot use, not other native tools. Keep hypotheses separate; no graph edge or severity score proves exploitability.",
      "Use rt_job start with requestId for long foreground work; read with id/cursor/maxBytes for bounded incremental logs, status/cancel for supervision. Inspect existing jobs before retrying interrupted work. Native Pi owns sessions and compaction; do not start another model loop or automatically replay uncertain commands.",
      "Credential values are not redacted or rewritten by this extension. Commands, tool results and saved evidence retain their original values; keep session and evidence files private.",
    ].join("\n");
  });

  pi.on("tool_result", async (event, ctx) => {
    const target = writer;
    const current = project;
    if (event.toolName === "rt_job" && !event.isError && current?.status === "ready" && ctx.isProjectTrusted()) {
      const data = (event.structuredContent ?? event.details) as { id?: string; phase?: string };
      if (data?.id && data.phase && event.input.action === "start") {
        jobStates.set(data.id, data.phase);
        pi.appendEntry("redteam-job-observed", { id: data.id, phase: data.phase });
      }
    }
    if (!isBashToolResult(event) || !target || current?.status !== "ready" || !ctx.isProjectTrusted()) return;
    const structured = event.structuredContent;
    const object = structured && typeof structured === "object" && !Array.isArray(structured) ? structured as Record<string, unknown> : undefined;
    const contentText = event.content.filter(part => part.type === "text").map(part => part.text).join("\n");
    const output = typeof object?.output === "string" ? object.output : contentText;
    const needsFullFile = typeof object?.output !== "string" || object.truncated === true;
    const fullOutputPath = needsFullFile ? event.details?.fullOutputPath ?? (typeof object?.full_output_path === "string" ? object.full_output_path : undefined) : undefined;
    const content = [...event.content];
    try {
      const declared = currentAttempt(ctx);
      const attempt = declared ? await searchAttempt({ cwd: current.cwd }, declared) : null;
      const active = attempt?.phase === "active" ? attempt : null;
      feedback.selectBranch({ selected: active ? { id: active.branchId } : null });
      const evidence = await target.save({
        toolCallId: event.toolCallId, sessionId: ctx.sessionManager.getSessionId(), leafId: ctx.sessionManager.getLeafId(),
        command: typeof event.input.command === "string" ? event.input.command : "", output,
        ...(fullOutputPath ? { fullOutputPath } : {}), truncated: typeof object?.output === "string" ? object.truncated === true : !!event.details?.truncation, isError: event.isError,
        ...(active ? { attemptId: active.attemptId, branchId: active.branchId } : {}), parentToolCallId: event.parentToolCallId,
      });
      const observed = feedback.observe({ command: String(event.input.command ?? ""), output, isError: event.isError, toolCallId: event.toolCallId, evidenceRef: evidence.outputPath });
      if (["missing-tool", "dependency", "permission", "capacity"].includes(observed.observation.category ?? "")) capabilities = undefined;
      try { pi.appendEntry("redteam-execution", observed.observation); }
      catch { content.push({ type: "text", text: "Execution diagnostic checkpoint unavailable; saved evidence is still valid." }); }
      if (observed.hint) content.push({ type: "text", text: observed.hint });
      if (writer === target) { saved += 1; display(ctx); }
      content.push({ type: "text", text: `Red-team output: ${evidence.outputPath} (${evidence.complete ? "complete" : "partial"}); no vulnerability verdict inferred.` });
      return { content, structuredContent: structured };
    } catch {
      if (writer === target) {
        saveFailures += 1;
        display(ctx);
        if (ctx.hasUI) ctx.ui.notify("Red-team evidence save failed; check filesystem permissions and paths", "error");
      }
      content.push({ type: "text", text: "Red-team evidence save failed; the native execution result is retained, but output persistence is not verified." });
      return { content, structuredContent: structured };
    }
  });

  pi.on("turn_end", async (_event, ctx) => {
    if (project?.status !== "ready" || !ctx.isProjectTrusted()) return;
    feedback.endTurn();
    pi.appendEntry("redteam-feedback-checkpoint", feedback.checkpoint());
    if (!jobStates.size || Date.now() - lastJobCheck < 5000) return;
    lastJobCheck = Date.now();
    const current = generation;
    try {
      const ids = [...jobStates.keys()];
      const selected = Array.from({ length: Math.min(32, ids.length) }, (_, index) => ids[(jobCursor + index) % ids.length]!);
      jobCursor = (jobCursor + selected.length) % ids.length;
      const observed = await Promise.all(selected.map(async id => {
        try { return await jobStatus({ cwd: project!.cwd }, id); }
        catch { return { id, phase: "unavailable", attemptId: undefined, outputPath: undefined }; }
      }));
      if (current !== generation) return;
      const changes = [];
      for (const job of observed) {
        if (jobStates.get(job.id) === job.phase) continue;
        jobStates.set(job.id, job.phase);
        pi.appendEntry("redteam-job-observed", { id: job.id, phase: job.phase });
        if (job.phase !== "running") changes.push({ id: job.id, phase: job.phase, attemptId: job.attemptId, outputPath: job.outputPath });
      }
      if (changes.length) {
        pendingJobNotice = "Known job execution state changed (not a security verdict): " + JSON.stringify(changes.slice(0, 3));
        if (ctx.hasUI) ctx.ui.notify(pendingJobNotice, "info");
      }
    } catch { pendingJobNotice = "Known jobs could not be verified; do not replay uncertain commands."; }
  });

  pi.on("context", async (event, ctx) => {
    if (project?.status !== "ready" || !ctx.isProjectTrusted()) return;
    const notes = [];
    const observed = feedback.summary();
    if (observed) notes.push(observed);
    const declared = currentAttempt(ctx);
    if (declared) {
      try {
        const attempt = await searchAttempt({ cwd: project.cwd }, declared);
        const key = JSON.stringify(attempt);
        if (key !== lastAttemptNotice) {
          lastAttemptNotice = key;
          notes.push(attempt ? `Declared logical action: ${JSON.stringify(attempt)}. Read evidence and feedback once it has a valid outcome; interruption is not failure.` : "Declared attempt is unavailable; verify state, do not replay.");
        }
      } catch { notes.push("Search state could not be verified; original Pi tools remain available."); }
    }
    if (pendingJobNotice) { notes.push(pendingJobNotice); pendingJobNotice = undefined; }
    if (!notes.length) return;
    return { messages: [...event.messages, { role: "custom" as const, customType: "redteam-checkpoint", content: notes.join("\n").slice(0, 4000), display: false, timestamp: Date.now() }] };
  });

  pi.on("session_compact", () => { lastAttemptNotice = undefined; feedback.invalidateSummary(); });
  pi.on("session_before_tree", () => { graph.cancel(); });
  pi.on("session_tree", async (_event, ctx) => {
    graph.restore(ctx);
    await team.updateGraph(ctx);
    feedback.reset(); lastAttemptNotice = undefined; capabilities = undefined; jobStates.clear(); pendingJobNotice = undefined;
    for (const entry of ctx.sessionManager.getBranch?.() ?? []) {
      if (entry.type === "custom" && ["redteam-execution", "redteam-feedback-checkpoint"].includes(entry.customType)) feedback.restore(entry.data);
      if (entry.type === "custom" && entry.customType === "redteam-job-observed") {
        const data = entry.data as { id?: string; phase?: string };
        if (data.id && data.phase) jobStates.set(data.id, data.phase);
      }
    }
    feedback.invalidateSummary();
  });
}
