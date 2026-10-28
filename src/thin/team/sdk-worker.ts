import { fork, type ChildProcess } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { openSync, closeSync, writeSync, constants } from "node:fs";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { domainPath } from "../state.js";
import { truncateHead } from "@earendil-works/pi-coding-agent";
import { hostSdkEnvironment } from "./host-sdk.js";
import { renewingWorkerStateAdapter, type workerStateAdapter } from "./worker-state.js";
import { teamToolRequestSchema, workerConfigSchema, workerCommandSchema, workerReplySchema, type WorkerConfig, type WorkerCommand, type WorkerReply, type WorkerView } from "./protocol.js";

type Pending = { resolve: (reply: WorkerReply) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };

export class SdkWorker {
  private child: ChildProcess | undefined;
  private pending = new Map<string, Pending>();
  private heartbeat: NodeJS.Timeout | undefined;
  private stopping = false;
  private stopPromise: Promise<void> | undefined;
  private started = false;
  private closed: Promise<void> = Promise.resolve();
  private logs: number[] = [];
  private listeners = new Set<(reply: WorkerReply) => void>();
  private toolBusy = false;
  private toolOperation: Promise<void> = Promise.resolve();
  private renewal: NodeJS.Timeout | undefined;
  readonly config: WorkerConfig;
  current: WorkerView | undefined;

  constructor(config: WorkerConfig, private readonly domain?: Parameters<typeof workerStateAdapter>[1], private readonly assertQuiescent?: Parameters<typeof workerStateAdapter>[2]) { this.config = workerConfigSchema.parse(config); }

  onActivity(listener: (reply: WorkerReply) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  async start(): Promise<WorkerView> {
    if (this.started || this.stopping) throw new Error("Worker cannot be started twice");
    this.started = true;
    const directory = await domainPath({ cwd: this.config.cwd }, "team", "workers", this.config.workerId);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const logPath = await domainPath({ cwd: this.config.cwd }, "team", "workers", this.config.workerId, "stderr.log");
    const hostEnvironment = await hostSdkEnvironment();
    if (this.stopping) throw new Error("SDK startup cancelled before creating a process");
    const output = openSync(logPath, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
    this.logs.push(output);
    const source = import.meta.url.endsWith(".ts");
    const entry = fileURLToPath(new URL(source ? "./worker-entry.ts" : "./worker-entry.js", import.meta.url));
    const child = fork(entry, [], { cwd: this.config.cwd, env: { ...process.env, ...hostEnvironment, PI_CODING_AGENT_DIR: this.config.agentDir }, execArgv: source ? ["--import", import.meta.resolve("tsx")] : [], stdio: ["ignore", "pipe", "pipe", "ipc"], detached: process.platform !== "win32" });
    this.child = child;
    const stateAdapter = renewingWorkerStateAdapter(this.config, this.domain, this.assertQuiescent);
    let saved = 0;
    const capture = (chunk: Buffer) => {
      let offset = 0;
      const content = chunk.subarray(0, Math.max(0, 8 * 1024 * 1024 - saved));
      try {
        while (offset < content.length) {
          const written = writeSync(output, content, offset, content.length - offset);
          if (!written) throw new Error("Log write stalled");
          offset += written; saved += written;
        }
      } catch { void this.stop().catch(() => {}); }
    };
    child.stdout?.on("data", capture); child.stderr?.on("data", capture);
    this.closed = new Promise(resolve => {
      child.once("close", () => {
        clearInterval(this.heartbeat);
        clearInterval(this.renewal);
        this.stopping = true;
        this.failPending(new Error("SDK worker exited; no command replayed"));
        for (const log of this.logs.splice(0)) closeSync(log);
        resolve();
      });
    });
    child.on("error", () => { this.failPending(new Error("SDK worker process failed")); });
    child.on("message", raw => {
      const tool = teamToolRequestSchema.safeParse(raw);
      if (tool.success) {
        if (this.stopping || this.toolBusy || !this.config.teamRunId) { void this.stop().catch(() => {}); return; }
        this.toolBusy = true;
        this.toolOperation = (async () => {
          let text: string;
          let failed = false;
          try {
            const data = await stateAdapter.invoke(tool.data.toolCallId, tool.data.input);
            const preview = truncateHead(JSON.stringify(data), { maxBytes: 16384, maxLines: 200 });
            text = preview.content + (preview.truncated ? "\nTruncated; query a smaller range. No delivery cursor advanced." : "");
          } catch (error) { text = `Cooperation operation rejected: ${error instanceof Error ? error.message.slice(0, 2000) : "Unknown error"}. Inspect current state before retrying; no automatic replay.`; failed = true; }
          this.toolBusy = false;
          if (child.connected && !this.stopping) child.send({ action: "tool_result", requestId: tool.data.requestId, text, failed }, () => {});
        })().catch(() => { this.toolBusy = false; void this.stop().catch(() => {}); });
        return;
      }
      const parsed = workerReplySchema.safeParse(raw);
      if (!parsed.success) { void this.stop().catch(() => {}); return; }
      const reply = parsed.data;
      if (reply.kind === "activity") {
        if (reply.workerId !== this.config.workerId) { void this.stop().catch(() => {}); return; }
        try { for (const listener of this.listeners) listener(reply); } catch { void this.stop().catch(() => {}); }
        return;
      }
      const pending = this.pending.get(reply.requestId);
      if (!pending) return;
      clearTimeout(pending.timer); this.pending.delete(reply.requestId);
      if (reply.kind === "error") pending.reject(new Error(`SDK worker ${reply.code}${reply.diagnostic ? `: ${reply.diagnostic}` : ""}; no command replayed`));
      else if (reply.view.workerId !== this.config.workerId || reply.view.provider !== this.config.provider || reply.view.model !== this.config.model) {
        pending.reject(new Error("Worker identity or selected model changed")); void this.stop().catch(() => {});
      } else { this.current = reply.view; pending.resolve(reply); }
    });
    this.heartbeat = setInterval(() => { if (child.connected && !this.stopping) child.send({ action: "heartbeat" }); }, 1000);
    if (this.config.teamRunId) this.renewal = setInterval(() => { if (!this.stopping) void stateAdapter.renew().catch(() => { void this.stop().catch(() => {}); }); }, 15000);
    try {
      const reply = await this.request({ action: "init", requestId: randomUUID(), config: this.config }, 60000);
      if (reply.kind !== "ready") throw new Error("Worker did not acknowledge SDK initialization");
      return reply.view;
    } catch (error) { await this.stop(); throw error; }
  }

  private failPending(error: Error) {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
  }

  private request(command: Exclude<WorkerCommand, { action: "heartbeat" }>, timeoutMs: number): Promise<WorkerReply> {
    workerCommandSchema.parse(command);
    if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 86400000) return Promise.reject(new Error("Invalid SDK operation timeout"));
    const child = this.child;
    if (!child?.connected || this.stopping) return Promise.reject(new Error("SDK worker is not available"));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(command.requestId);
        reject(new Error("SDK request timed out; operation state is uncertain and will not be replayed"));
        void this.stop().catch(() => {});
      }, timeoutMs);
      this.pending.set(command.requestId, { resolve, reject, timer });
      child.send(command, error => {
        if (error) {
          clearTimeout(timer); this.pending.delete(command.requestId);
          reject(new Error("SDK IPC delivery failed; no command replayed"));
        }
      });
    });
  }

  prompt(text: string, timeoutMs = 60000): Promise<WorkerReply> {
    return this.request({ action: "prompt", requestId: randomUUID(), text }, timeoutMs);
  }

  inspect(): Promise<WorkerReply> { return this.request({ action: "inspect", requestId: randomUUID() }, 10000); }
  abort(): Promise<WorkerReply> { return this.request({ action: "abort", requestId: randomUUID() }, 10000); }
  compact(instructions?: string): Promise<WorkerReply> { return this.request({ action: "compact", requestId: randomUUID(), instructions }, 60000); }

  stop(): Promise<void> {
    this.stopPromise ??= this.shutdown();
    return this.stopPromise;
  }

  private async shutdown(): Promise<void> {
    const child = this.child;
    if (!child) {
      this.stopping = true;
      for (const log of this.logs.splice(0)) closeSync(log);
      return;
    }
    this.stopping = true;
    clearInterval(this.heartbeat);
    clearInterval(this.renewal);
    this.failPending(new Error("SDK worker is stopping; no command replayed"));
    if (child.connected) child.send({ action: "stop", requestId: randomUUID() }, () => {});
    const force = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null && child.pid) {
        try { if (process.platform === "win32") child.kill("SIGKILL"); else process.kill(-child.pid, "SIGKILL"); } catch {}
      }
    }, 4000);
    let deadline: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        Promise.all([this.closed, this.toolOperation]),
        new Promise<never>((_resolve, reject) => { deadline = setTimeout(() => reject(new Error("SDK worker shutdown timed out; process or domain operation state is unverified, no replay")), 8000); }),
      ]);
      this.listeners.clear();
    } finally { clearTimeout(force); clearTimeout(deadline); }
  }
}
