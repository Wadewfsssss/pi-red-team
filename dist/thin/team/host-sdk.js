import { getPackageDir } from "@earendil-works/pi-coding-agent";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
export async function hostSdkEnvironment() {
    const root = getPackageDir();
    const manifestPath = join(root, "package.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    const entry = manifest.exports?.["."]?.import;
    if (typeof entry !== "string" || !entry.startsWith("./"))
        throw new Error("Host Pi has no supported public SDK export");
    return {
        PI_RED_TEAM_HOST_SDK_URL: pathToFileURL(join(root, entry)).href,
        PI_RED_TEAM_HOST_TYPEBOX_URL: pathToFileURL(createRequire(manifestPath).resolve("typebox")).href,
    };
}
