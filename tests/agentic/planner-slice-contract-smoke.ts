#!/usr/bin/env tsx
import { validatePlannerResult } from "../../tools/agent-loop/src/prompts/index.js";
import type { WorkflowPolicy } from "../../tools/agent-loop/src/policy/index.js";

const policy = {
  workflows: { tdd: { skillName: "tdd", phase: "execution" } },
  autonomousLoop: {},
} as WorkflowPolicy;

function task(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id, title: id, kind: "implementation", workflow: "tdd", status: "pending", priority: 1,
    acceptanceCriteria: ["behavior works"], validation: [`node ${id}.test.js`], dependsOn: [],
    scope: [`src/${id}.ts`], complexity: "low", complexityReasons: [], sliceRole: "primary",
    ...overrides,
  };
}

function result(tasks: Record<string, unknown>[]): Record<string, unknown> {
  return { verdict: "planned", decisions: [], tasks };
}

function errors(tasks: Record<string, unknown>[], goal = "Add behavior in src/main.ts"): string[] {
  return validatePlannerResult(result(tasks), policy, { goal, enforceCoherentSlices: true });
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

assert(errors([task("primary")]).length === 0, "single primary slice should be valid");

const prerequisite = task("prerequisite", {
  sliceRole: "prerequisite", splitReason: "true-prerequisite", validation: ["node prerequisite.test.js"],
});
const primary = task("primary", { dependsOn: ["prerequisite"], validation: ["node primary.test.js"] });
assert(errors([prerequisite, primary]).length === 0, "true prerequisite plus dependent primary should be valid");

assert(errors([task("one"), task("two")]).some((error) => error.includes("exactly one primary")), "multiple primaries should fail");
assert(errors([
  { ...prerequisite, validation: ["node same.test.js"] },
  { ...primary, validation: ["node same.test.js"] },
]).some((error) => error.includes("distinct validation")), "duplicate proof should fail");
assert(errors([prerequisite, { ...primary, dependsOn: [] }]).some((error) => error.includes("depend on prerequisite")), "unconnected prerequisite should fail");
assert(errors([
  task("discovery", { kind: "investigation", sliceRole: undefined, acceptanceCriteria: [] }),
  primary,
]).some((error) => error.includes("standalone discovery")), "implementation plan should reject standalone discovery ceremony");
assert(errors([
  task("investigation", { kind: "investigation", sliceRole: undefined, acceptanceCriteria: [] }),
], "Investigate runtime behavior and write evidence artifact").length === 0, "artifact/investigation goal may remain one investigation task");

console.log("planner-slice-contract smoke passed");
