import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath, symlink, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createBashTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import extension from "../src/thin/index.js";
import { loadProject } from "../src/thin/project.js";
import { EvidenceWriter } from "../src/thin/evidence.js";

async function fixture(configured = true) {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "thin-redteam-")));
  const config = { version: 1, name: "owned-fixture", authorization: { reference: "local-unit-test", targets: ["owned-fixture.invalid"], expiresAt: new Date(Date.now() + 3600000).toISOString() }, kali: { container: "fixture-only", workspace: cwd } };
  if (configured) { await mkdir(join(cwd, ".redteam"), { mode: 0o700 }); await writeFile(join(cwd, ".redteam", "project.json"), JSON.stringify(config), { mode: 0o600 }); }
  const handlers = new Map<string, Function>();
  const commands = new Map<string, any>();
  const tools = new Map<string, unknown>();
  const notifications: string[] = [];
  const entries: unknown[] = [];
  const api = {
    on: (name: string, handler: Function) => { handlers.set(name, handler); return () => handlers.delete(name); },
    registerCommand: (name: string, command: unknown) => commands.set(name, command),
    appendEntry: (name: string, data: unknown) => entries.push({ name, data }),
    registerTool: (tool: { name: string; exposure: string }) => { assert(["rt_search", "rt_graph", "rt_job", "rt_team"].includes(tool.name)); assert.equal(tool.exposure, "direct"); tools.set(tool.name, tool); },
    setActiveTools: () => assert.fail("Must not replace the tool set"),
    registerMcpServer: () => assert.fail("MCP belongs to Pi configuration"),
  };
  const ctx = {
    cwd, mode: "rpc", hasUI: true, isProjectTrusted: () => true,
    getContextUsage: () => undefined,
    sessionManager: { getSessionId: () => "native-session", getLeafId: () => "native-leaf" },
    ui: { notify: (text: string) => notifications.push(text), setStatus: () => assert.fail("No TUI status calls in RPC mode") },
  };
  extension(api as unknown as ExtensionAPI);
  const emit = (name: string, event: unknown = {}) => handlers.get(name)?.(event, ctx);
  const result = (id: string, output: string, overrides = {}) => ({ type: "tool_result", toolName: "bash", toolCallId: id, input: { command: "printf fixture" }, content: [{ type: "text", text: output }], details: undefined, structuredContent: { output, truncated: false, exit_code: 0, wall_time_seconds: 0 }, isError: false, ...overrides });
  const close = async () => { await emit("session_shutdown"); await rm(cwd, { recursive: true, force: true }); };
  return { cwd, config, ctx, handlers, commands, tools, notifications, entries, emit, result, close };
}

test("no configuration is required and state is generated only when native tools run", async () => {
  const setup = await fixture(false);
  try {
    await setup.emit("session_start");
    assert.equal(await setup.emit("tool_call", { toolName: "bash" }), undefined);
    assert.equal(await setup.emit("user_bash"), undefined);
    await assert.rejects(stat(join(setup.cwd, ".redteam")), { code: "ENOENT" });
    const event = { systemPromptOptions: { sections: {} } };
    await setup.emit("before_agent_start", event);
    assert.match((event.systemPromptOptions.sections as any).redteam, /No project configuration/);
    assert((await setup.emit("tool_result", setup.result("missing", "native"))).content.some((part: any) => part.text?.includes("Red-team output:")));
    assert.equal((await loadProject(setup.cwd, true)).status, "ready");
    await assert.rejects(stat(join(setup.cwd, ".redteam", "project.json")), { code: "ENOENT" });
  } finally { await setup.close(); }
});

test("untrusted working directory is not loaded", async () => {
  const setup = await fixture();
  try {
    setup.ctx.isProjectTrusted = () => false;
    assert.equal((await loadProject(setup.cwd, false)).status, "untrusted");
    await setup.emit("session_start");
    assert.equal(await setup.emit("tool_result", setup.result("untrusted", "native")), undefined);
    await assert.rejects(stat(join(setup.cwd, "evidence")), { code: "ENOENT" });
  } finally { await setup.close(); }
});

test("removed campaign ignores legacy data and clears stale context after native compaction", async () => {
  const setup = await fixture(false);
  try {
    const directory = join(setup.cwd, ".redteam");
    await mkdir(directory);
    const legacy = join(directory, "campaign.json");
    const archive = join(directory, "campaign.archive.json");
    const archiveData = '{"targets":[{"id":"old-owned"}]}';
    await writeFile(archive, archiveData);
    assert.deepEqual([...setup.tools.keys()].sort(), ["rt_graph", "rt_job", "rt_search", "rt_team"]);
    for (const data of [archiveData, '{"broken":']) {
      await writeFile(legacy, data);
      await setup.emit("session_start");
      for (const compact of [false, true]) {
        if (compact) await setup.emit("session_compact");
        const event = { systemPromptOptions: { sections: { redteam_campaign: "stale legacy coverage" } as Record<string, string> } };
        await setup.emit("before_agent_start", event);
        assert.equal(event.systemPromptOptions.sections.redteam_campaign, undefined);
        assert.match(event.systemPromptOptions.sections.redteam!, /cheap discriminating check/);
        assert(!JSON.stringify(event).includes("old-owned"));
        assert.equal(await readFile(legacy, "utf8"), data);
        assert.equal(await readFile(archive, "utf8"), archiveData);
      }
    }
    for (const name of ["project.json", "branches.json", "findings", "team"]) await assert.rejects(stat(join(directory, name)), { code: "ENOENT" });
  } finally { await setup.close(); }
});

test("legacy project configuration is not read, required or echoed", async () => {
  const setup = await fixture();
  try {
    const path = join(setup.cwd, ".redteam", "project.json");
    await writeFile(path, '{"secret":"must-not-echo"');
    const project = await loadProject(setup.cwd, true);
    assert.equal(project.status, "ready");
    assert(!JSON.stringify(project).includes("must-not-echo"));
    await setup.emit("session_start");
    assert.equal(await setup.emit("tool_call", { toolName: "bash" }), undefined);
    assert.equal(await setup.emit("user_bash"), undefined);
    await rm(path); await symlink(join(setup.cwd, "elsewhere"), path);
    assert.equal((await loadProject(setup.cwd, true)).status, "ready");
  } finally { await setup.close(); }
});

test("legacy expiry does not install a second shell permission system", async () => {
  const setup = await fixture();
  try {
    setup.config.authorization.expiresAt = new Date(Date.now() - 1000).toISOString();
    await writeFile(join(setup.cwd, ".redteam", "project.json"), JSON.stringify(setup.config));
    await setup.emit("session_start");
    assert.equal(await setup.emit("tool_call", { toolName: "bash" }), undefined);
    assert.equal(await setup.emit("user_bash"), undefined);
    assert.equal(setup.handlers.has("tool_call"), false);
    assert.equal(setup.handlers.has("user_bash"), false);
    assert.equal(await setup.emit("tool_call", { toolName: "read" }), undefined);
    assert.deepEqual([...setup.commands.keys()], ["rt"]);
    assert.equal(setup.handlers.has("session_before_compact"), false);
  } finally { await setup.close(); }
});

test("status and doctor remain auxiliary and prompt enhancement is structured", async () => {
  const setup = await fixture();
  try {
    await setup.emit("session_start");
    const event = { systemPromptOptions: { sections: { original: "keep" } } };
    await setup.emit("before_agent_start", event);
    assert.equal(event.systemPromptOptions.sections.original, "keep");
    assert(JSON.stringify(event).includes("Native") || JSON.stringify(event).includes("native"));
    assert(JSON.stringify(event).includes("Observed local tool availability"));
    assert(JSON.stringify(event).includes("Cloud and containers"));
    await setup.commands.get("rt").handler("status", setup.ctx);
    const status = JSON.parse(setup.notifications.at(-1)!);
    assert.equal(status.status, "ready"); assert.equal(status.contextPercent, null);
    assert.equal(status.sessionId, "native-session");
    await setup.commands.get("rt").handler("doctor", setup.ctx);
    assert.equal(JSON.parse(setup.notifications.at(-1)!).neo4j, "Managed by Pi native MCP; inspect /mcp");
    setup.ctx.hasUI = false;
    await setup.commands.get("rt").handler("status", setup.ctx);
    assert.equal(setup.entries.filter((entry: any) => entry.name === "redteam-diagnostic").length, 1);
    assert(setup.entries.some((entry: any) => entry.name === "redteam-feedback-checkpoint"));
  } finally { await setup.close(); }
});

test("real native bash result is captured without a shell override", async () => {
  const setup = await fixture();
  try {
    await setup.emit("session_start");
    const native = await createBashTool(setup.cwd, { exposeSessionEnvironment: false }).execute("actual-bash", { command: "printf actual-native-output" }, undefined);
    const result = await setup.emit("tool_result", { ...setup.result("actual-bash", ""), ...native });
    assert(result.content.some((part: any) => part.text?.includes("Red-team output:")));
    const metadata = JSON.parse((await readFile(join(setup.cwd, ".redteam", "evidence.jsonl"), "utf8")).trim());
    assert.equal(await readFile(join(setup.cwd, metadata.outputPath), "utf8"), "actual-native-output");
    assert.equal(metadata.complete, true);
    assert.equal(metadata.sessionId, "native-session");
    assert.equal((await stat(join(setup.cwd, metadata.outputPath))).mode & 0o777, 0o600);
  } finally { await setup.close(); }
});

test("bash-only work receives bounded diagnostics without rewriting session credentials", async () => {
  const setup = await fixture(false);
  try {
    await setup.emit("session_start");
    await setup.emit("before_agent_start", { messageType: "user", prompt: "Use token: owned-session-credential", systemPromptOptions: { sections: {} } });
    const input = { command: "missing-owned-fixture --token owned-session-credential" };
    for (let attempt = 0; attempt < 5; attempt++) {
      const result = await setup.emit("tool_result", { ...setup.result(`owned-failure-${attempt}`, "missing-owned-fixture: command not found", { isError: true }), input });
      const notices = result.content.filter((part: any) => part.text?.startsWith("Red-team execution signal:"));
      assert.equal(notices.length, attempt === 0 ? 1 : 0);
      assert.equal(input.command, "missing-owned-fixture --token owned-session-credential");
    }
    const observations = setup.entries.filter((entry: any) => entry.name === "redteam-execution") as { name: string; data: any }[];
    assert.equal(observations.length, 5);
    assert(observations.every(entry => entry.data.branchId === null && entry.data.category === "missing-tool"));
    assert(!JSON.stringify(observations).includes("owned-session-credential"));
    const index = await readFile(join(setup.cwd, ".redteam", "evidence.jsonl"), "utf8");
    assert(index.includes("owned-session-credential"));
    assert(index.trim().split("\n").map(line => JSON.parse(line)).every(record => record.redacted === false));
    await assert.rejects(readFile(join(setup.cwd, ".redteam", "branches.json")), /ENOENT/);
  } finally { await setup.close(); }
});

test("concurrent native results keep independent evidence and index records", async () => {
  const setup = await fixture();
  try {
    await setup.emit("session_start");
    await Promise.all(Array.from({ length: 8 }, (_, index) => setup.emit("tool_result", setup.result(`parallel-${index}`, `output-${index}`))));
    const records = (await readFile(join(setup.cwd, ".redteam", "evidence.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
    assert.equal(records.length, 8);
    assert.equal(new Set(records.map(record => record.id)).size, 8);
    for (const record of records) assert.equal(await readFile(join(setup.cwd, record.outputPath), "utf8"), record.toolCallId.replace("parallel", "output"));
  } finally { await setup.close(); }
});

test("complete structured output wins over a missing truncation temp file", async () => {
  const setup = await fixture();
  try {
    await setup.emit("session_start");
    await setup.emit("tool_result", setup.result("complete-structured", "full-structured-output", { details: { fullOutputPath: join(tmpdir(), "missing-native-output"), truncation: { truncated: true } } }));
    const record = JSON.parse((await readFile(join(setup.cwd, ".redteam", "evidence.jsonl"), "utf8")).trim());
    assert.equal(record.complete, true);
  } finally { await setup.close(); }
});

test("full output preservation and unavailable-source labeling are conservative", async () => {
  const setup = await fixture();
  const temporary = await mkdtemp(join(tmpdir(), "thin-native-output-"));
  try {
    const writer = new EvidenceWriter(setup.cwd);
    const path = join(temporary, "output.log"); await writeFile(path, "full native output");
    const capture = { toolCallId: "full", sessionId: "native-session", leafId: null, command: "fixture", output: "tail", truncated: true, isError: false, fullOutputPath: path };
    const complete = await writer.save(capture);
    assert.equal(complete.complete, true);
    assert.equal(await readFile(join(setup.cwd, complete.outputPath), "utf8"), "full native output");
    const missing = await writer.save({ ...capture, fullOutputPath: join(temporary, "missing") });
    assert.equal(missing.complete, false);
    await rm(path); await symlink(join(setup.cwd, ".redteam", "project.json"), path);
    assert.equal((await writer.save(capture)).complete, false);
  } finally { await setup.close(); await rm(temporary, { recursive: true, force: true }); }
});

test("environment and numeric credentials remain unchanged in results and saved evidence", async () => {
  const previous = process.env.THIN_TEST_API_TOKEN;
  process.env.THIN_TEST_API_TOKEN = "fixture-secret-do-not-export";
  const setup = await fixture();
  if (previous === undefined) delete process.env.THIN_TEST_API_TOKEN; else process.env.THIN_TEST_API_TOKEN = previous;
  try {
    await setup.emit("session_start");
    const output = JSON.stringify({ token: "fixture-secret-do-not-export", password: "owned-password", numericToken: 123456 });
    const structured = { output, exit_code: 0, truncated: false, credentials: { password: "owned-password", token: 123456 } };
    const input = { command: "printf '%s' fixture-secret-do-not-export" };
    const event = { ...setup.result("raw-credentials", output), input, structuredContent: structured };
    const result = await setup.emit("tool_result", event);
    assert.equal(result.content[0].text, output);
    assert.equal(result.structuredContent, structured);
    assert.equal(event.content.length, 1);
    const record = JSON.parse((await readFile(join(setup.cwd, ".redteam", "evidence.jsonl"), "utf8")).trim());
    assert.equal(record.redacted, false);
    assert.equal(record.command, input.command);
    assert.equal(await readFile(join(setup.cwd, record.outputPath), "utf8"), output);
  } finally { await setup.close(); }
});

test("unsafe evidence destination reports failure without losing the native result", async () => {
  const setup = await fixture();
  const elsewhere = await mkdtemp(join(tmpdir(), "thin-elsewhere-"));
  try {
    await symlink(elsewhere, join(setup.cwd, "evidence"));
    await setup.emit("session_start");
    const result = await setup.emit("tool_result", setup.result("unsafe", "native-success"));
    assert(result.content.some((part: any) => part.text === "native-success"));
    assert(result.content.some((part: any) => part.text?.includes("save failed")));
    await assert.rejects(stat(join(setup.cwd, ".redteam", "evidence.jsonl")), { code: "ENOENT" });
  } finally { await setup.close(); await rm(elsewhere, { recursive: true, force: true }); }
});

test("shutdown drains writes and disables capture until a native session starts", async () => {
  const setup = await fixture();
  try {
    await setup.emit("session_start");
    const pending = setup.emit("tool_result", setup.result("before-shutdown", "captured"));
    await setup.emit("session_shutdown"); await pending;
    assert.equal(await setup.emit("tool_result", setup.result("after-shutdown", "not captured")), undefined);
    const records = (await readFile(join(setup.cwd, ".redteam", "evidence.jsonl"), "utf8")).trim().split("\n");
    assert.equal(records.length, 1);
    await setup.emit("session_start");
    await setup.commands.get("rt").handler("status", setup.ctx);
    assert.equal(JSON.parse(setup.notifications.at(-1)!).evidenceSavedThisSession, 0);
  } finally { await setup.close(); }
});

test("config deletion does not disable extension and native trust still controls state access", async () => {
  const setup = await fixture();
  try {
    await setup.emit("session_start");
    assert.equal(await setup.emit("tool_call", { toolName: "bash" }), undefined);
    setup.config.authorization.expiresAt = new Date(Date.now() - 1000).toISOString();
    await writeFile(join(setup.cwd, ".redteam", "project.json"), JSON.stringify(setup.config));
    assert.equal(await setup.emit("tool_call", { toolName: "bash" }), undefined);
    await rm(join(setup.cwd, ".redteam", "project.json"));
    assert.equal(await setup.emit("tool_call", { toolName: "bash" }), undefined);
    assert.equal(await setup.emit("user_bash"), undefined);
    setup.config.authorization.expiresAt = new Date(Date.now() + 3600000).toISOString();
    await writeFile(join(setup.cwd, ".redteam", "project.json"), JSON.stringify(setup.config));
    assert.equal(await setup.emit("user_bash"), undefined);
    setup.ctx.isProjectTrusted = () => false;
    assert.equal(await setup.emit("tool_result", setup.result("untrusted", "unchanged")), undefined);
  } finally { await setup.close(); }
});
