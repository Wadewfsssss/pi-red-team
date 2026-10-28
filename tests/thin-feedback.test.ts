import assert from "node:assert/strict";
import test from "node:test";
import { ExecutionFeedback, executionCategory } from "../src/thin/feedback.js";

test("execution classification is diagnostic, not an attack outcome", () => {
  assert.equal(executionCategory("RuntimeError: can't start new thread", true), "capacity");
  assert.equal(executionCategory("ModuleNotFoundError: No module named 'capstone'", true), "dependency");
  assert.equal(executionCategory("failed to map segment from shared object", true), "dependency");
  assert.equal(executionCategory("cannot execute binary file: Exec format error", true), "dependency");
  assert.equal(executionCategory("bash: absent-tool: command not found", true), "missing-tool");
  assert.equal(executionCategory("Connection refused", false), "connection");
  assert.equal(executionCategory("HTTP 404; no issue observed", false), null);
});

test("same-command signals are bounded, deduplicated and recoverable", () => {
  const feedback = new ExecutionFeedback();
  const input = { command: "owned-missing-tool", output: "owned-missing-tool: command not found", isError: true, toolCallId: "owned-call" };
  const first = feedback.observe(input);
  assert(first.hint?.includes("No search branch was assigned"));
  const second = feedback.observe(input);
  assert.equal(second.hint, undefined);
  for (let attempt = 0; attempt < 20; attempt++) assert.equal(feedback.observe(input).hint, undefined);
  const resumed = new ExecutionFeedback();
  resumed.restore(second.observation);
  resumed.restore({ ...second.observation, commandHash: "invalid" });
  assert.equal(resumed.observe(input).hint, undefined);
  assert(resumed.summary()?.includes("do not replay commands"));
  assert.equal(resumed.summary(), undefined);
  resumed.beginRun();
  assert.equal(resumed.observe(input).hint, undefined);
});

test("only an explicitly declared execution context associates a branch, without changing search scores", () => {
  const feedback = new ExecutionFeedback();
  feedback.selectBranch({ selected: { id: "owned-branch", tdi: 0.2 } });
  const observed = feedback.observe({ command: "printf fixture", output: "Permission denied", isError: true, toolCallId: "owned-call", evidenceRef: "evidence/owned/output.log" });
  assert.equal(observed.observation.branchId, "owned-branch");
  assert(observed.hint?.includes("not semantic success/failure feedback"));
  feedback.beginRun();
  assert.equal(feedback.observe({ command: "printf fixture", output: "ok", isError: false, toolCallId: "owned-next" }).observation.branchId, null);
});

test("a rolling window emits at most three immediate diagnostics and no automatic continuation", () => {
  const feedback = new ExecutionFeedback();
  let notices = 0;
  for (let attempt = 0; attempt < 10; attempt++) {
    const observed = feedback.observe({ command: `fixture-command-${attempt}`, output: "Command timed out", isError: true, toolCallId: `fixture-call-${attempt}` });
    if (observed.hint) notices++;
    assert.equal("continue" in observed, false);
  }
  assert.equal(notices, 3);
  for (let turn = 0; turn < 20; turn++) feedback.endTurn();
  assert(feedback.observe({ command: "new-window", output: "Command timed out", isError: true, toolCallId: "new-window" }).hint);
});

test("execution diagnostics hash commands without rewriting credential values", () => {
  const command = 'token: owned-session-value; password="owned-password"';
  const feedback = new ExecutionFeedback();
  const observed = feedback.observe({ command, output: "timeout exceeded", isError: true, toolCallId: "fixture" });
  assert(!JSON.stringify(observed).includes("owned-session-value"));
  assert.equal(command, 'token: owned-session-value; password="owned-password"');
  assert.match(observed.observation.commandHash, /^[a-f0-9]{64}$/);
});

test("available tools resolve only the corresponding missing-command prerequisite", () => {
  const feedback = new ExecutionFeedback();
  feedback.observe({ command: "owned-tool", output: "owned-tool: command not found", isError: true, toolCallId: "missing" });
  feedback.observe({ command: "python fixture.py", output: "ModuleNotFoundError: No module named 'ownedmodule'", isError: true, toolCallId: "module" });
  feedback.resolveAvailableTools(new Set(["owned-tool"]));
  const state = feedback.checkpoint();
  assert.equal(state.issues.length, 1);
  assert.equal(state.issues[0]!.category, "dependency");
  assert.equal("outcome" in state.issues[0]!, false);
});

test("context replacement reintroduces unresolved observations once without resetting immediate budgets", () => {
  const feedback = new ExecutionFeedback();
  const input = { command: "owned-tool", output: "owned-tool: command not found", isError: true, toolCallId: "missing" };
  feedback.observe(input);
  assert(feedback.summary());
  const checkpoint = feedback.checkpoint();
  feedback.invalidateSummary();
  assert(feedback.summary());
  assert.equal(feedback.summary(), undefined);
  assert.deepEqual(feedback.checkpoint().noticeTurns, checkpoint.noticeTurns);
  assert.equal(feedback.observe(input).hint, undefined);
  const resumed = new ExecutionFeedback();
  resumed.restore(feedback.checkpoint());
  resumed.invalidateSummary();
  assert(resumed.summary());
  assert.equal(resumed.summary(), undefined);
});
