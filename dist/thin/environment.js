import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import toolkit from "./kali-toolkit.json" with { type: "json" };
export async function discoverTools(environment = process.env) {
    const directories = (environment.PATH ?? "").split(delimiter).filter(Boolean);
    return Promise.all(toolkit.groups.map(async (group) => ({
        id: group.id,
        label: group.label,
        tools: await Promise.all(group.commands.map(async (name) => {
            for (const directory of directories) {
                try {
                    await access(join(directory, name), constants.X_OK);
                    return { name, available: true };
                }
                catch { }
            }
            return { name, available: false };
        })),
    })));
}
export async function runtimeConstraints(root = "/") {
    const read = async (path) => {
        try {
            return (await readFile(join(root, path), "utf8")).trim();
        }
        catch {
            return null;
        }
    };
    const [pids, memory, cpu, mountinfo] = await Promise.all([
        read("sys/fs/cgroup/pids.max"), read("sys/fs/cgroup/memory.max"), read("sys/fs/cgroup/cpu.max"), read("proc/self/mountinfo"),
    ]);
    const limit = (value) => value && /^\d+$/.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : null;
    const cpuParts = cpu?.split(/\s+/);
    const quota = limit(cpuParts?.[0] ?? null);
    const period = limit(cpuParts?.[1] ?? null);
    const tmpMount = mountinfo?.split("\n").find(line => line.split(" ")[4] === "/tmp");
    const rootMount = mountinfo?.split("\n").find(line => line.split(" ")[4] === "/");
    const options = (line) => line?.split(" ")[5]?.split(",");
    return {
        pidsMax: limit(pids), memoryMaxBytes: limit(memory), cpuQuota: quota && period ? quota / period : null,
        tmpNoexec: tmpMount ? options(tmpMount)?.includes("noexec") ?? null : null,
        rootReadOnly: rootMount ? options(rootMount)?.includes("ro") ?? null : null,
    };
}
export async function capabilitySnapshot(environment = process.env) {
    const [toolGroups, constraints, resources] = await Promise.all([discoverTools(environment), runtimeConstraints(), Promise.all(toolkit.resources.map(async (resource) => {
            try {
                await access(resource.path, constants.R_OK);
                return { ...resource, available: true };
            }
            catch {
                return { ...resource, available: false };
            }
        }))]);
    return { profile: toolkit.profile, platform: process.platform, architecture: process.arch, toolGroups, constraints, resources };
}
export function capabilityPrompt(snapshot) {
    const lines = snapshot.toolGroups.map(group => {
        const available = group.tools.filter(tool => tool.available).map(tool => tool.name);
        const missing = group.tools.filter(tool => !tool.available).map(tool => tool.name);
        return `${group.label}: available ${available.join(", ") || "none"}; unavailable ${missing.join(", ") || "none"}.`;
    });
    const constraints = snapshot.constraints;
    return [
        "Observed local tool availability (PATH discovery only, not proof of permissions or successful execution):",
        `Execution platform: ${snapshot.platform}; architecture: ${snapshot.architecture}. Check binary architecture and dynamic loader prerequisites before native execution or using QEMU.`,
        ...lines,
        ...snapshot.resources.map(resource => `Local resource ${resource.id}: ${resource.available ? "available" : "unavailable"} at ${resource.path}. ${resource.hint}`),
        `Observed cgroup/mount limits: ${JSON.stringify(constraints)}. Null means unknown or no numeric limit was observed, not permission to use unlimited resources.`,
        "Use available native tools instead of unnecessarily rewriting their functionality. Read tool help when needed; do not install missing software or dependencies without operator agreement.",
        "The PID limit covers processes and threads across this container; leave capacity for Pi and workers. Start with bounded concurrency, not hundreds of threads.",
        "If tmpNoexec is true, /tmp is not suitable for native executable mappings or dynamic libraries. Prefer preinstalled interpreters and libraries; the image's default python3 includes the pinned analysis environment, while packaged Kali scripts retain /usr/bin/python3. Do not bypass mount restrictions.",
        "Installed tools do not grant raw-socket, packet-capture, ptrace, GPU, cloud-account or target authorization. Cloud CLI availability does not mean credentials exist; Burp is an interactive GUI and Ghidra GUI availability does not mean a display exists. Never start services, extend scope or change privileges silently.",
    ].join("\n");
}
