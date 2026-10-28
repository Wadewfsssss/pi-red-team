import { constants } from "node:fs";
import { mkdir, open, realpath } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import lockfile from "proper-lockfile";
import { atomicWrite, digest, rejectSymlinks, safePath } from "../files.js";
import { readBoundedFile } from "./project.js";

export interface BashCapture {
  toolCallId: string;
  sessionId: string;
  leafId: string | null;
  command: string;
  output: string;
  fullOutputPath?: string;
  truncated: boolean;
  isError: boolean;
  attemptId?: string;
  branchId?: string;
  parentToolCallId?: string;
}

export class EvidenceWriter {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(readonly cwd: string) {}

  save(capture: BashCapture) {
    const pending = this.queue.then(() => this.write(capture));
    this.queue = pending.catch(() => undefined);
    return pending;
  }

  async drain(): Promise<void> { await this.queue; }

  private async write(capture: BashCapture) {
    let output = capture.output;
    let complete = !capture.truncated && !capture.isError;
    let incompleteReason: string | null = complete ? null : "Native result is truncated or reports an execution error";
    if (capture.fullOutputPath) {
      try {
        const source = resolve(capture.fullOutputPath);
        const temporaryRoot = await realpath(tmpdir());
        const parent = await realpath(resolve(source, ".."));
        if (parent !== temporaryRoot && !parent.startsWith(temporaryRoot + sep) && parent !== this.cwd && !parent.startsWith(this.cwd + sep)) throw new Error("Unexpected native output location");
        output = (await readBoundedFile(source, 16 * 1024 * 1024)).toString("utf8");
        complete = !capture.isError;
        incompleteReason = complete ? null : "Native tool reported an execution error";
      } catch {
        complete = false;
        incompleteReason = "Full output unavailable, unsafe or above the 16 MiB capture limit";
      }
    }
    const id = randomUUID();
    const directory = safePath(this.cwd, "evidence", id);
    const index = safePath(this.cwd, ".redteam", "evidence.jsonl");
    await rejectSymlinks(this.cwd, directory);
    await rejectSymlinks(this.cwd, index);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await mkdir(join(this.cwd, ".redteam"), { recursive: true, mode: 0o700 });
    const metadata = {
      id, tool: "bash", toolCallId: capture.toolCallId, sessionId: capture.sessionId, leafId: capture.leafId,
      capturedAt: new Date().toISOString(), cwd: this.cwd, command: capture.command,
      outputPath: relative(this.cwd, join(directory, "output.log")), complete, incompleteReason,
      isError: capture.isError, bytes: Buffer.byteLength(output), sha256: digest(output), redacted: false,
      attemptId: capture.attemptId ?? null, branchId: capture.branchId ?? null, parentToolCallId: capture.parentToolCallId ?? null, association: capture.attemptId ? "declared-context" : "unbound",
    };
    await atomicWrite(join(directory, "output.log"), output);
    await atomicWrite(join(directory, "meta.json"), JSON.stringify(metadata, null, 2) + "\n");
    const lockPath = safePath(this.cwd, ".redteam", ".evidence-lock");
    await rejectSymlinks(this.cwd, lockPath);
    const release = await lockfile.lock(join(this.cwd, ".redteam"), { realpath: false, lockfilePath: lockPath, stale: 10000, retries: { retries: 50, minTimeout: 10, maxTimeout: 100 } });
    try {
      const file = await open(index, constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
      try {
        if (!(await file.stat()).isFile()) throw new Error("Evidence index is not a regular file");
        await file.chmod(0o600);
        await file.writeFile(JSON.stringify(metadata) + "\n");
        await file.sync();
      } finally { await file.close(); }
    } finally { await release(); }
    return metadata;
  }
}
