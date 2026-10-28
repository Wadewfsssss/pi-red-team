import { spawn } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { closeSync, fsyncSync, openSync, writeSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { atomicWrite } from "../files.js";
import type { JobRequest, JobState } from "./jobs.js";

export async function processIdentity(pid: number) {
  if (process.platform !== "linux") throw new Error("Long jobs require the native Kali/Linux environment");
  const stat = await readFile(`/proc/${pid}/stat`, "utf8");
  const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
  const startTicks = fields[19];
  if (!startTicks || fields[0] === "Z") throw new Error("Process is not live");
  return { pid, startTicks, bootId: (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim(), hostname: hostname() };
}

async function groupMembers(group: number) {
  const members: { pid: number; startTicks: string }[] = [];
  for (const name of await readdir("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const stat = await readFile(`/proc/${name}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
      if (Number(fields[2]) === group && !["Z", "X"].includes(fields[0]!)) members.push({ pid: Number(name), startTicks: fields[19]! });
    } catch (error) { if (!["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error; }
  }
  return members;
}

async function signalGroup(group: number, signal: NodeJS.Signals) {
  for (const member of await groupMembers(group)) {
    let identity;
    try { identity = await processIdentity(member.pid); } catch { continue; }
    if (identity.startTicks !== member.startTicks) continue;
    try { process.kill(member.pid, signal); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
  }
}

async function run(requestPath: string): Promise<void> {
  const request: JobRequest = JSON.parse(await readFile(requestPath, "utf8"));
  const directory = dirname(requestPath);
  const identity = await processIdentity(process.pid);
  const state: JobState = { version: 1, projectKey: request.projectKey, id: request.id, identity, phase: "running", startedAt: new Date().toISOString(), bytesSaved: 0, outputTruncated: false, exitCode: null, signal: null };
  const persist = async () => {
    await atomicWrite(join(directory, "status.json"), JSON.stringify(state, null, 2) + "\n");
  };
  const deadline = Math.min(Date.now() + request.timeoutSeconds * 1000, request.expiresAt ? Date.parse(request.expiresAt) : Infinity);
  if (!Number.isFinite(deadline) || deadline <= Date.now()) throw new Error("Job deadline expired");
  const output = openSync(join(directory, "output.log"), "wx", 0o600);
  let stopReason: "cancelled" | "timed_out" | "failed" | undefined;
  let finished = false;
  let force: NodeJS.Timeout | undefined;
  let timer: NodeJS.Timeout | undefined;
  let inspectionFailed = false;
  const signalChildGroup = (signal: NodeJS.Signals) => {
    if (child.pid) void signalGroup(child.pid, signal).catch(() => { inspectionFailed = true; });
  };
  const stop = (reason: typeof stopReason) => {
    if (finished || stopReason) return;
    stopReason = reason;
    signalChildGroup("SIGTERM");
    force = setTimeout(() => signalChildGroup("SIGKILL"), 1500);
  };
  process.on("SIGTERM", () => stop("cancelled"));
  process.on("SIGINT", () => stop("cancelled"));
  const schedule = () => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) { stop("timed_out"); return; }
    timer = setTimeout(schedule, Math.min(remaining, 2147000000));
  };
  const child = spawn("bash", ["-lc", request.command], { cwd: request.cwd, env: process.env, stdio: ["ignore", "pipe", "pipe"], detached: true });
  const capture = (chunk: Buffer) => {
    try {
      const available = Math.max(0, request.maxOutputBytes - state.bytesSaved);
      const content = chunk.subarray(0, available);
      let offset = 0;
      while (offset < content.length) {
        const written = writeSync(output, content, offset, content.length - offset);
        if (!written) throw new Error("Output write made no progress");
        offset += written; state.bytesSaved += written;
      }
      if (chunk.length > available) state.outputTruncated = true;
    } catch { state.outputTruncated = true; stop("failed"); }
  };
  child.stdout.on("data", capture);
  child.stderr.on("data", capture);
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
    child.once("error", () => { stopReason = "failed"; resolve({ code: null, signal: null }); });
  });
  const closed = new Promise<boolean>(resolve => child.once("close", () => resolve(true)));
  schedule();
  try { await persist(); } catch { stop("failed"); }
  const completion = await exited;
  let terminationVerified = false;
  try {
    if (child.pid && (await groupMembers(child.pid)).length) {
      stop(stopReason ?? "failed");
      const drainDeadline = Date.now() + 5000;
      while ((await groupMembers(child.pid)).length && Date.now() < drainDeadline) await delay(25);
    }
    terminationVerified = !inspectionFailed && (!child.pid || (await groupMembers(child.pid)).length === 0);
  } catch { inspectionFailed = true; }
  let closeTimer: NodeJS.Timeout | undefined;
  const streamsClosed = await Promise.race([closed, new Promise<boolean>(resolve => { closeTimer = setTimeout(() => resolve(false), 1000); })]);
  clearTimeout(closeTimer);
  if (!streamsClosed) { child.stdout.destroy(); child.stderr.destroy(); state.outputTruncated = true; }
  terminationVerified = terminationVerified && streamsClosed && !inspectionFailed;
  finished = true;
  clearTimeout(timer); clearTimeout(force);
  try { fsyncSync(output); } finally { closeSync(output); }
  state.phase = stopReason ?? (completion.code === 0 ? "completed" : "failed");
  state.exitCode = completion.code;
  state.signal = completion.signal;
  state.finishedAt = new Date().toISOString();
  state.terminationVerified = terminationVerified;
  await persist();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  run(process.argv[2]!).catch(() => { process.exitCode = 1; });
}
