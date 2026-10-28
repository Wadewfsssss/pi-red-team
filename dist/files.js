import { createHash, randomUUID } from "node:crypto";
import { open, mkdir, rename, lstat, rm } from "node:fs/promises";
import { resolve, dirname } from "node:path";
export function digest(value) {
    return createHash("sha256").update(value).digest("hex");
}
export function safePath(root, ...parts) {
    const base = resolve(root);
    const path = resolve(base, ...parts);
    if (path !== base && !path.startsWith(base + "/"))
        throw new Error("Path escapes campaign directory");
    return path;
}
export async function rejectSymlinks(root, path) {
    const base = resolve(root);
    safePath(base, path);
    let current = resolve(path);
    while (true) {
        try {
            if ((await lstat(current)).isSymbolicLink())
                throw new Error("Symlink in campaign path");
        }
        catch (error) {
            if (error.code !== "ENOENT")
                throw error;
        }
        if (current === base)
            break;
        current = dirname(current);
    }
}
export async function atomicWrite(path, value) {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
        const file = await open(temporary, "wx", 0o600);
        try {
            await file.writeFile(value);
            await file.sync();
        }
        finally {
            await file.close();
        }
        await rename(temporary, path);
        const directory = await open(dirname(path), "r");
        try {
            await directory.sync();
        }
        finally {
            await directory.close();
        }
    }
    catch (error) {
        await rm(temporary, { force: true }).catch(() => { });
        throw error;
    }
}
