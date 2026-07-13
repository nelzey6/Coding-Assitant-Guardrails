#!/usr/bin/env tsx
import { shouldRunFinalizeDocs, shouldRunPostTaskReview, shouldRunTaskGrill, shouldRunVerifier } from "../../tools/agent-loop/src/admission/index.js";
import { resolvePlannerMode, type WorkflowPolicy } from "../../tools/agent-loop/src/policy/index.js";
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
const docsImplementation = shouldRunVerifier(
  { ...plannedMaintenance, kind: "implementation", scope: ["docs/verification-policy.md"], complexity: "low" },
  policy,
  false,
  ["docs/verification-policy.md"]
);
assert(!docsImplementation.run, "bounded docs implementation should skip verifier automatically");
assert(docsImplementation.risk === "low" && docsImplementation.verifierMode === "skip" && docsImplementation.votes === 0, "docs implementation should resolve one low-risk skip decision");

const alwaysVerifiedDocs = shouldRunVerifier(
  { ...plannedMaintenance, kind: "implementation", scope: ["docs/verification-policy.md"], complexity: "low" },
  { ...policy, autonomousLoop: { phaseAdmission: { ...policy.autonomousLoop.phaseAdmission, verifier: "always" } } },
  false,
  ["docs/verification-policy.md"]
);
assert(alwaysVerifiedDocs.run, "always policy should run verifier for low-risk docs");
assert(alwaysVerifiedDocs.verifierMode === "single" && alwaysVerifiedDocs.votes === 1, "always policy trace must match the single verifier it executes");

const catchAllDocs = shouldRunVerifier(
  { ...plannedMaintenance, kind: "implementation", scope: ["**"], complexity: "low" },
  policy,
  false,
  ["docs/verification-policy.md"]
);
assert(catchAllDocs.run && catchAllDocs.risk !== "low", "catch-all scope must not qualify as bounded low-risk documentation work");
assert(catchAllDocs.reasons.some((reason) => /broad|unbounded|catch-all/.test(reason)), "catch-all scope decision should explain that scope is not meaningfully bounded");

const codeImplementation = shouldRunVerifier(
  { ...plannedMaintenance, kind: "implementation", scope: ["src/index.ts"], complexity: "low" },
  policy,
  false,
  ["src/index.ts"]
);
assert(codeImplementation.run, "normal code implementation should keep verifier");
assert(codeImplementation.risk === "medium" && codeImplementation.verifierMode === "single" && codeImplementation.votes === 1, "normal code implementation should use one verifier vote");
assert(shouldRunVerifier(
  { ...plannedMaintenance, kind: "implementation", scope: ["docs/script.ts"], complexity: "low" },
  policy,
  false,
  ["docs/script.ts"]
).risk === "medium", "code under docs directory must not be treated as documentation-only");

const architectureImplementation = shouldRunVerifier(
  { ...plannedMaintenance, kind: "architecture", scope: ["src/index.ts"], complexity: "high" },
  policy,
  false,
  ["src/index.ts"]
);
assert(architectureImplementation.run, "architecture task should keep verifier");
assert(architectureImplementation.risk === "high" && architectureImplementation.verifierMode === "adversarial" && architectureImplementation.votes === 3, "architecture task should use adversarial verification");

const semanticHumanGate = shouldRunVerifier(
  { ...plannedMaintenance, title: "Upgrade a dependency", kind: "implementation", scope: ["package.json"], complexity: "low" },
  { ...policy, humanGates: ["dependency upgrade"] },
  false,
  ["package.json"]
);
assert(semanticHumanGate.risk === "high" && semanticHumanGate.votes === 3, "semantic policy human gate should require adversarial verification");
assert(semanticHumanGate.reasons.some((reason) => reason.includes("dependency upgrade")), "semantic gate reason should name matched policy gate");
assert(shouldRunVerifier(
  { ...plannedMaintenance, title: "Break public API compatibility", kind: "implementation", scope: ["src/api.ts"], complexity: "low" },
  { ...policy, humanGates: ["public API breaking change"] },
  false,
  ["src/api.ts"]
).risk === "high", "public API breaking-change policy gate should be semantic high risk");
assert(resolvePlannerMode({ ...policy, autonomousLoop: { ...policy.autonomousLoop, plannerMode: "full" } }) === "full", "planner mode should inherit repository policy");
assert(resolvePlannerMode({ ...policy, autonomousLoop: { ...policy.autonomousLoop, plannerMode: "full" } }, "lite") === "lite", "explicit planner mode should override repository policy");
assert(!shouldRunPostTaskReview({ task: plannedMaintenance, remainingTasks: [{ id: "other", kind: "maintenance", scope: ["docs/**"] }], policy, enabled: true }).run, "disjoint low-risk task should skip post-task review");
assert(shouldRunPostTaskReview({ task: plannedMaintenance, remainingTasks: [{ id: "other", kind: "maintenance", scope: ["src/components/**"] }], policy, enabled: true }).run, "overlapping scope should trigger post-task review");
assert(!shouldRunFinalizeDocs(["src/index.ts"], policy, true).run, "code-only diff should skip finalize-docs");
assert(shouldRunFinalizeDocs(["docs/agentic-loop-flow.md"], policy, true).run, "documentation diff should run finalize-docs");

console.log("phase-admission smoke passed");
