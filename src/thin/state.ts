import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import lockfile from "proper-lockfile";
import { z } from "redteam-zod";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { atomicWrite, digest, rejectSymlinks, safePath } from "../files.js";
import { readBoundedFile } from "./project.js";

export type DomainProject = { cwd: string; workspaceId?: string; searchStatePath?: string; mutationGuard?: () => Promise<void> };

export function projectKey(project: DomainProject): string {
  if (!project.workspaceId) throw new Error("Workspace identity is not initialized");
  return digest(JSON.stringify(["pi-red-team-workspace-v3", project.workspaceId]));
}

export async function resolveWorkspace(project: DomainProject): Promise<void> {
  const schema = z.object({ version: z.literal(1), id: z.string().uuid() }).strict();
  const path = await domainPath(project, "workspace.json");
  const read = async () => schema.parse(JSON.parse((await readBoundedFile(path, 1024)).toString("utf8"))).id;
  try { project.workspaceId = await read(); return; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  await withFileMutationQueue(path, async () => {
    const directory = await domainPath(project);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const lockPath = await domainPath(project, ".workspace-lock");
    const release = await lockfile.lock(directory, { realpath: false, lockfilePath: lockPath, stale: 10000, retries: { retries: 20, minTimeout: 20, maxTimeout: 100 } });
    try {
      try { project.workspaceId = await read(); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        project.workspaceId = randomUUID();
        await atomicWrite(path, JSON.stringify({ version: 1, id: project.workspaceId }) + "\n");
      }
    } finally { await release(); }
  });
}

export async function domainPath(project: { cwd: string }, ...parts: string[]): Promise<string> {
  const path = safePath(project.cwd, ".redteam", ...parts);
  await rejectSymlinks(project.cwd, path);
  return path;
}

export async function mutateState<T>(project: DomainProject, name: string, schema: z.ZodType<T>, initial: () => T, mutate: (state: T) => unknown, signal?: AbortSignal): Promise<unknown> {
  signal?.throwIfAborted();
  await resolveWorkspace(project);
  return withFileMutationQueue(await domainPath(project, name), async () => {
    const directory = await domainPath(project);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await rejectSymlinks(project.cwd, join(directory, ".domain-lock"));
    const release = await lockfile.lock(directory, { realpath: false, lockfilePath: join(directory, ".domain-lock"), retries: { retries: 20, minTimeout: 20, maxTimeout: 100 }, stale: 10000 });
    try {
      signal?.throwIfAborted();
      const path = await domainPath(project, name);
      let state: T;
      try { state = schema.parse(JSON.parse((await readBoundedFile(path, 2 * 1024 * 1024)).toString("utf8"))); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; state = initial(); }
      if (state && typeof state === "object" && "branches" in state && "version" in state && typeof state.version === "number" && state.version < 4) {
        const backup = await domainPath(project, `${name}.v${state.version}.backup.json`);
        try { await readBoundedFile(backup, 2 * 1024 * 1024); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          await atomicWrite(backup, JSON.stringify(state, null, 2) + "\n");
        }
      }
      const result = await mutate(state);
      await project.mutationGuard?.();
      signal?.throwIfAborted();
      const validated = schema.parse(state);
      const content = JSON.stringify(validated, null, 2) + "\n";
      if (Buffer.byteLength(content) > 2 * 1024 * 1024) throw new Error("Domain state exceeds 2 MiB; archive it explicitly");
      await atomicWrite(path, content);
      return result;
    } finally { await release(); }
  });
}

export async function readState<T>(project: DomainProject, name: string, schema: z.ZodType<T>, initial: () => T): Promise<T> {
  await resolveWorkspace(project);
  try { return schema.parse(JSON.parse((await readBoundedFile(await domainPath(project, name), 2 * 1024 * 1024)).toString("utf8"))); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; return initial(); }
}
