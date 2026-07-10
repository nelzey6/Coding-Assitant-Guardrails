#!/usr/bin/env tsx
import { shouldRunFinalizeDocs, shouldRunPostTaskReview, shouldRunTaskGrill, shouldRunVerifier } from "../../tools/agent-loop/src/admission/index.js";
import type { WorkflowPolicy } from "../../tools/agent-loop/src/policy/index.js";
import type { AgenticState, Task } from "../../tools/agent-loop/src/state/index.js";

const policy = {
  autonomousLoop: {
    phaseAdmission: {
      taskGrill: "plan-aware",
      verifier: "auto",
      postTaskReview: "on-drift",
      finalizeDocs: "on-change",
      retryTaskGrill: "on-drift",
    },
  },
} as WorkflowPolicy;

const state: AgenticState = { planRevision: 3, openQuestions: [], blockers: [] };
const plannedMaintenance: Task = { id: "maintenance", kind: "maintenance", scope: ["src/**"], plannedRevision: 3 };

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

assert(!shouldRunTaskGrill(plannedMaintenance, state, policy).run, "fresh planned task should skip task-grill");
assert(shouldRunTaskGrill({ ...plannedMaintenance, failureHistory: [{ at: "now", phase: "checks", reason: "failed" }] }, state, policy).run === false, "check retry should skip task-grill");
assert(!shouldRunVerifier(plannedMaintenance, policy, false).run, "low-risk scoped task should skip verifier automatically");
assert(shouldRunVerifier({ ...plannedMaintenance, kind: "implementation" }, policy, false).run, "implementation task must keep verifier");
assert(!shouldRunPostTaskReview({ task: plannedMaintenance, remainingTasks: [{ id: "other", kind: "maintenance", scope: ["docs/**"] }], policy, enabled: true }).run, "disjoint low-risk task should skip post-task review");
assert(shouldRunPostTaskReview({ task: plannedMaintenance, remainingTasks: [{ id: "other", kind: "maintenance", scope: ["src/components/**"] }], policy, enabled: true }).run, "overlapping scope should trigger post-task review");
assert(!shouldRunFinalizeDocs(["src/index.ts"], policy, true).run, "code-only diff should skip finalize-docs");
assert(shouldRunFinalizeDocs(["docs/agentic-loop-flow.md"], policy, true).run, "documentation diff should run finalize-docs");

console.log("phase-admission smoke: 8 passed, 0 failed");
