#!/usr/bin/env tsx
import { resolveTaskComplexity } from "../../tools/agent-loop/src/scope/index.js";
import { shouldReplanBeforeTask, shouldRunVerifier } from "../../tools/agent-loop/src/admission/index.js";
import { resolveEffectivePlannerMode, type WorkflowPolicy } from "../../tools/agent-loop/src/policy/index.js";
import { computePlanContextFingerprint, type AgenticState, type Task } from "../../tools/agent-loop/src/state/index.js";

const policy = {
  autonomousLoop: {
    phaseAdmission: { verifier: "auto" },
  },
} as WorkflowPolicy;

const state: AgenticState = { planRevision: 3, openQuestions: [], blockers: [] };
const plannedMaintenance: Task = { id: "maintenance", kind: "maintenance", scope: ["src/**"], plannedRevision: 3 };

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

assert(!shouldReplanBeforeTask(plannedMaintenance, state).run, "fresh planned task should execute without replanning");
assert(!shouldReplanBeforeTask({ ...plannedMaintenance, failureHistory: [{ at: "now", phase: "checks", reason: "failed" }] }, state).run, "check retry should execute without replanning");
assert(shouldReplanBeforeTask({ ...plannedMaintenance, plannedRevision: 2 }, state).run, "stale planner revision should replan before execution");
assert(shouldReplanBeforeTask({ ...plannedMaintenance, failureHistory: [{ at: "now", phase: "scope", reason: "failed" }] }, state).run, "understanding-sensitive failure should replan before execution");
const originalPlanState: AgenticState = { ...state, assumptions: ["storage stays local"] };
const assumptionBoundTask: Task = {
  ...plannedMaintenance,
  plannedContextFingerprint: computePlanContextFingerprint(originalPlanState),
};
const changedAssumptionState: AgenticState = { ...originalPlanState, assumptions: ["storage is remote"] };
assert(shouldReplanBeforeTask(assumptionBoundTask, changedAssumptionState).run, "changed assumptions must invalidate the current plan before execution");
const docsImplementation = shouldRunVerifier(
  { ...plannedMaintenance, kind: "implementation", scope: ["docs/verification-policy.md"], complexity: "low" },
  policy,
  ["docs/verification-policy.md"]
);
assert(!docsImplementation.run, "bounded docs implementation should skip verifier automatically");
assert(docsImplementation.risk === "low" && docsImplementation.verifierMode === "skip" && docsImplementation.votes === 0, "docs implementation should resolve one low-risk skip decision");

const alwaysVerifiedDocs = shouldRunVerifier(
  { ...plannedMaintenance, kind: "implementation", scope: ["docs/verification-policy.md"], complexity: "low" },
  { ...policy, autonomousLoop: { phaseAdmission: { ...policy.autonomousLoop.phaseAdmission, verifier: "always" } } },
  ["docs/verification-policy.md"]
);
assert(alwaysVerifiedDocs.run, "always policy should run verifier for low-risk docs");
assert(alwaysVerifiedDocs.verifierMode === "single" && alwaysVerifiedDocs.votes === 1, "always policy trace must match the single verifier it executes");

const catchAllDocs = shouldRunVerifier(
  { ...plannedMaintenance, kind: "implementation", scope: ["**"], complexity: "low" },
  policy,
  ["docs/verification-policy.md"]
);
assert(catchAllDocs.run && catchAllDocs.risk !== "low", "catch-all scope must not qualify as bounded low-risk documentation work");
assert(catchAllDocs.reasons.some((reason) => /broad|unbounded|catch-all/.test(reason)), "catch-all scope decision should explain that scope is not meaningfully bounded");

const broadPrefixedDocs = shouldRunVerifier(
  { ...plannedMaintenance, kind: "implementation", scope: ["src/**"], complexity: "low" },
  policy,
  ["src/guide.md"]
);
assert(broadPrefixedDocs.risk === "high" && broadPrefixedDocs.votes === 3, "single-root recursive scope must not qualify as bounded low-risk work");

const codeImplementation = shouldRunVerifier(
  { ...plannedMaintenance, kind: "implementation", scope: ["src/index.ts"], complexity: "low" },
  policy,
  ["src/index.ts"]
);
assert(codeImplementation.run, "normal code implementation should keep verifier");
assert(codeImplementation.risk === "medium" && codeImplementation.verifierMode === "single" && codeImplementation.votes === 1, "normal code implementation should use one verifier vote");
assert(shouldRunVerifier(
  { ...plannedMaintenance, kind: "implementation", scope: ["docs/script.ts"], complexity: "low" },
  policy,
  ["docs/script.ts"]
).risk === "medium", "code under docs directory must not be treated as documentation-only");

const architectureImplementation = shouldRunVerifier(
  { ...plannedMaintenance, kind: "architecture", scope: ["src/index.ts"], complexity: "high" },
  policy,
  ["src/index.ts"]
);
assert(architectureImplementation.run, "architecture task should keep verifier");
assert(architectureImplementation.risk === "high" && architectureImplementation.verifierMode === "adversarial" && architectureImplementation.votes === 3, "architecture task should use adversarial verification");

const semanticHumanGate = shouldRunVerifier(
  { ...plannedMaintenance, title: "Upgrade a dependency", kind: "implementation", scope: ["package.json"], complexity: "low" },
  { ...policy, humanGates: [{ label: "dependency upgrade", all: ["dependency", "upgrade"] }] },
  ["package.json"]
);
assert(semanticHumanGate.risk === "high" && semanticHumanGate.votes === 3, "semantic policy human gate should require adversarial verification");
assert(semanticHumanGate.reasons.some((reason) => reason.includes("dependency upgrade")), "semantic gate reason should name matched policy gate");
assert(shouldRunVerifier(
  { ...plannedMaintenance, title: "Break public API compatibility", kind: "implementation", scope: ["src/api.ts"], complexity: "low" },
  { ...policy, humanGates: ["public API breaking change"] },
  ["src/api.ts"]
).risk === "high", "public API breaking-change policy gate should be semantic high risk");
const forcedPlanner = resolveEffectivePlannerMode(
  { ...policy, autonomousLoop: { ...policy.autonomousLoop, plannerMode: "full" } },
  state,
);
assert(forcedPlanner.mode === "full" && forcedPlanner.source === "policy", "planner mode should inherit repository policy with traceable source");
const adaptivePlanner = resolveEffectivePlannerMode(policy, { goal: "Optimize docs/guide.md wording", planRevision: 0 });
assert(adaptivePlanner.mode === "full" && adaptivePlanner.source === "adaptive", "goals rejected by direct routing should use full planner");
const replanPlanner = resolveEffectivePlannerMode(policy, { goal: "Update docs/guide.md wording", planRevision: 1 });
assert(replanPlanner.mode === "full" && replanPlanner.reason.includes("revision"), "replanning should use full planner context");

const mechanical: Task = {id:"extract",title:"Extract helper; preserve behavior",kind:"architecture",workflow:"improve-codebase-architecture",complexity:"low",scope:["src/main.ts","src/helper.ts","src/index.ts","tests/helper.ts"]};
const complexity = resolveTaskComplexity(mechanical, policy);
assert(complexity.level === "low", "file count and workflow label must not invent high complexity");
assert(shouldRunVerifier(mechanical, policy, mechanical.scope).votes === 1, "bounded structural edit should keep one independent reviewer");
console.log("phase-admission smoke passed");
