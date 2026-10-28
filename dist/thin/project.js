import { constants } from "node:fs";
import { access, open, readFile, realpath } from "node:fs/promises";
import { capabilitySnapshot } from "./environment.js";
export async function readBoundedFile(path, limit) {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
        const stats = await file.stat();
        if (!stats.isFile() || stats.size > limit)
            throw new Error("Expected a bounded regular file");
        const buffer = Buffer.alloc(limit + 1);
        let length = 0;
        while (length <= limit) {
            const { bytesRead } = await file.read(buffer, length, buffer.length - length, null);
            if (!bytesRead)
                break;
            length += bytesRead;
        }
        if (length > limit)
            throw new Error("File exceeds capture limit");
        return buffer.subarray(0, length);
    }
    finally {
        await file.close();
    }
}
export async function loadProject(cwd, trusted) {
    if (!trusted)
        return { cwd, status: "untrusted", reason: "Pi has not trusted this working directory" };
    try {
        return { cwd: await realpath(cwd), status: "ready" };
    }
    catch {
        return { cwd, status: "invalid", reason: "Working directory is unavailable" };
    }
}
export async function diagnose(project, environment = process.env) {
    const capabilities = await capabilitySnapshot(environment);
    const tools = capabilities.toolGroups.flatMap(group => group.tools);
    let kali = false;
    try {
        kali = /^ID=kali$/m.test(await readFile("/etc/os-release", "utf8"));
    }
    catch { }
    let writable = false;
    try {
        await access(project.cwd, constants.W_OK);
        writable = true;
    }
    catch { }
    return { status: project.status, cwd: project.cwd, kali, writable, tools, ...capabilities, neo4j: "Managed by Pi native MCP; inspect /mcp", configurationRequired: false };
}
