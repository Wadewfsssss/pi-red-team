import { EventEmitter } from "node:events";
import { resolve } from "node:path";
const changes = new EventEmitter();
changes.setMaxListeners(0);
export function teamChanged(project) { changes.emit(resolve(project.cwd)); }
export function onTeamChange(project, listener) {
    const key = resolve(project.cwd);
    changes.on(key, listener);
    return () => { changes.off(key, listener); };
}
export function waitForTeamChange(project, signal, timeoutMs = 5000) {
    if (signal.aborted)
        return Promise.resolve();
    return new Promise(resolveWait => {
        const finish = () => { dispose(); clearTimeout(timer); signal.removeEventListener("abort", finish); resolveWait(); };
        const dispose = onTeamChange(project, finish);
        const timer = setTimeout(finish, timeoutMs);
        signal.addEventListener("abort", finish, { once: true });
    });
}
