#!/usr/bin/env tsx
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { execFileSync } from "child_process";
import { tmpdir } from "os";
import { join } from "path";
import { selectExecutionRoute, extractNamedRepoPaths } from "../../tools/agent-loop/src/routing/index.js";
import type { AgenticState } from "../../tools/agent-loop/src/state/index.js";
import type { WorkflowPolicy } from "../../tools/agent-loop/src/policy/index.js";

const policy = {
  defaultExecutionWorkflow: "tdd",
  workflows: { tdd: { skillName: "tdd", phase: "execution" } },
  humanGates: [{ label: "dependency upgrade", all: ["dependency", "upgrade"] }],
  autonomousLoop: {},
} as WorkflowPolicy;

function route(goal: string, overrides: Partial<AgenticState> = {}) {
  return selectExecutionRoute({ goal, tasks: [], openQuestions: [], blockers: [], ...overrides }, policy);
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

const docs = route("Update wording in README.md");
assert(docs.route === "direct", "bounded documentation goal should use direct execution");
assert(docs.task?.kind === "maintenance", "documentation-only direct task should classify as maintenance");
assert(docs.task?.scope?.join(",") === "README.md", "direct task should use named path as scope");

const code = route("Add null guard in tools/agent-loop/src/state/index.ts");
assert(code.route === "direct", "bounded code goal should use direct execution");
assert(code.task?.kind === "implementation", "code direct task should remain implementation");
assert(code.task?.acceptanceCriteria?.[0]?.includes("Add null guard"), "goal should become acceptance criterion");

assert(route("Optimize the agent loop in tools/agent-loop/src/loop/index.ts").route === "planner", "ambiguous optimize goal should require planner");
assert(route("Refactor architecture in tools/agent-loop/src/loop/index.ts").route === "planner", "architecture goal should require planner");
assert(route("Fix the small typo").route === "planner", "pathless goal should require planner");
assert(route("Upgrade dependency in package.json").route === "planner", "human-gated goal should require planner");
assert(route("Update a.md b.md c.md d.md e.md").route === "planner", "more than four paths should require planner");
assert(route("Update README.md", { openQuestions: ["Which section?"] }).route === "planner", "open questions should require planner");
assert(route("Update README.md", { blockers: ["Need approval"] }).route === "planner", "blockers should require planner");

assert(route("Extract helper from src/main.ts into src/helper.ts. Preserve behavior.").route === "direct", "mechanical extraction should run directly");
assert(route("Move helper from src/main.ts to src/helper.ts. No behavior changes.").route === "direct", "mechanical move should run directly");
assert(route("Refactor src/main.ts into src/helper.ts. Preserve behavior.").route === "direct", "bounded behavior-preserving refactor should run directly");
assert(route("Refactor src/main.ts").route === "planner", "unspecified refactor still needs planning");
assert(route("Extract auth logic from src/main.ts into src/helper.ts. Preserve behavior.").route === "planner", "mechanical wording must not bypass elevated impact");
assert(route("Move helper from src/main.ts to src/helper.ts. Preserve behavior; update src/index.ts and tests/helper.ts.").route === "direct", "focused export and test files should not force planning");
const repo = mkdtempSync(join(tmpdir(), "routing-alias-"));
try {
  execFileSync("git", ["init"], {cwd:repo,stdio:"ignore"});
  mkdirSync(join(repo,"src/loop"),{recursive:true});
  writeFileSync(join(repo,"src/loop/index.ts"),"export {};");
  assert(extractNamedRepoPaths("Edit src/loop/index.ts and loop/index.ts",repo).join(",") === "src/loop/index.ts", "unique existing alias was not resolved");
  mkdirSync(join(repo,"loop")); writeFileSync(join(repo,"loop/index.ts"),"export {};");
  assert(extractNamedRepoPaths("Edit src/loop/index.ts and loop/index.ts",repo).length === 2, "distinct existing files collapsed");
  assert(extractNamedRepoPaths("Edit src/loop/index.ts; run `npm test`",repo).length === 1, "command was mistaken for a path");
} finally { rmSync(repo,{recursive:true,force:true}); }
console.log("impact-routing smoke passed");
