import { claimWork } from "../../src/thin/team/store.ts";
const input = JSON.parse(process.argv[2]);
console.log(JSON.stringify(await claimWork({ cwd: input.cwd }, input.claim)));
