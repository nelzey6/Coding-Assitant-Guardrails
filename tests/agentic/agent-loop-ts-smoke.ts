#!/usr/bin/env tsx
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import { tmpdir } from "os";
import { spawnSync } from "child_process";

const ROOT = resolve(import.meta.dirname, "../..");
const CLI = join(ROOT, "tools/agent-loop/src/index.ts");
const TSX = join(ROOT, "tools/agent-loop/node_modules/tsx/dist/cli.mjs");
const POLICY = join(ROOT, "templates/agent-policy/workflow-policy.json");
const FILTER = process.env.AGENTIC_SMOKE_FILTER?.toLowerCase() ?? "";
const KEEP = process.env.AGENTIC_KEEP_SMOKE === "1";
let passed = 0;
let failed = 0;

function git(args: string[], cwd: string): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf-8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout.trim();
}

function makeRepo(tag: string): string {
  const dir = mkdtempSync(join(tmpdir(), `agent-loop-${tag}-`));
  git(["init"], dir);
  git(["config", "user.email", "smoke@example.test"], dir);
  git(["config", "user.name", "Smoke"], dir);
  mkdirSync(join(dir, "templates/agent-policy"), { recursive: true });
  copyFileSync(POLICY, join(dir, "templates/agent-policy/workflow-policy.json"));
  writeFileSync(join(dir, "README.md"), "# Smoke\n");
  writeFileSync(join(dir, "AGENTS.md"), "Keep changes scoped.");
  git(["add", "-A"], dir);
  git(["commit", "-m", "fixture"], dir);
  return dir;
}

function task(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "task-001", title: "Write output", kind: "implementation", workflow: "tdd",
    status: "pending", priority: 1, acceptanceCriteria: ["requested file exists"],
    validation: [], dependsOn: [], scope: ["output.txt"], complexity: "low",
    plannedRevision: 1, ...overrides,
  };
}

function writeState(dir: string, tasks: Record<string, unknown>[], overrides: Record<string, unknown> = {}): void {
  writeFileSync(join(dir, "agentic.json"), JSON.stringify({
    version: 1, goal: "Complete smoke goal", phase: "execution", maxIterations: 5,
    checks: [], tasks, decisions: [], assumptions: [], openQuestions: [], blockers: [],
    planRevision: 1, ...overrides,
  }, null, 2));
  git(["add", "agentic.json"], dir);
  git(["commit", "-m", "state"], dir);
}

function fakeAgent(dir: string, mutatePhase: "" | "planner" | "stance" | "executor" | "verifier" | "finalize-docs" = ""): string {
  const file = join(dir, "fake-agent.mjs");
  writeFileSync(file, `#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname } from "path";
const prompt = readFileSync(process.argv[2], "utf-8");
const json = (path, value) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(value)); };
const mutatePhase = ${JSON.stringify(mutatePhase)};
const mutateParent = (phase) => {
  if (mutatePhase === phase) writeFileSync(${JSON.stringify(join(dir, "PARENT-MUTATION.txt"))}, phase);
};
if (prompt.includes("Write planner JSON only to:")) {
  mutateParent("planner");
  const result = prompt.match(/Write planner JSON only to: (.+)/)[1].trim();
  const transcriptMatch = prompt.match(/Also write an autonomous grill transcript markdown file to: (.+)/);
  const transcript = transcriptMatch?.[1].trim();
  const stale = prompt.includes("Replace stale task");
  json(result, { verdict:"planned", summary:"planned", decisions:[], assumptions:[], openQuestions:[], blockers:[],
    tasks:[{ id:stale?"replacement":"planned-task", title:stale?"Replacement execution":"Planned execution",
      kind:"implementation", workflow:"tdd", status:"pending", priority:1, acceptanceCriteria:["output exists"],
      validation:[], dependsOn:[], scope:["output.txt"], complexity:"low" }], artifacts:transcript ? [transcript] : [] });
  if (transcript) writeFileSync(transcript, "# Planner evidence\\n"); process.exit(0);
}
if (prompt.includes("Write stance reflection JSON only to:")) {
  mutateParent("stance");
  const result = prompt.match(/Write stance reflection JSON only to: (.+)/)[1].trim();
  json(result, { mode:"stance", verdict:"reconfirm", summary:"stance survived challenge",
    evidence:["task inspected"], unresolved_risks:[], stance:{ owningModule:"target", boundaries:["scope"],
    sequence:["edit","check"], expectedEdits:["target"], validation:["checks"], assumptions:[], rejectedAlternatives:["rewrite"] } });
  process.exit(0);
}
if (prompt.includes("Write JSON only to this path:")) {
  mutateParent("verifier");
  const result = prompt.match(/Write JSON only to this path: (.+)/)[1].trim();
  json(result, { verdict:"pass", summary:"verified", issues:[], humanGates:[], recommendedStatus:"passed", artifacts:[] });
  process.exit(0);
}
if (prompt.includes("You are finalizing a completed agentic loop run.")) {
  mutateParent("finalize-docs");
  if (prompt.includes('"goal": "Reject finalize code mutation"')) writeFileSync("runtime.ts", "export {};\\n");
  else writeFileSync("PROJECT.md", "# Durable project facts\\n");
  process.exit(0);
}
if (prompt.includes("Task JSON:")) {
  mutateParent("executor");
  if (prompt.includes('"title": "Durable docs update"')) { mkdirSync("docs", { recursive:true }); writeFileSync("docs/guide.md", "# Guide\\n"); }
  else if (prompt.includes('"title": "Documentation update"')) writeFileSync("README.md", "# Smoke\\n\\nUpdated.\\n");
  else if (prompt.includes('"title": "Retry output"')) writeFileSync("retry.txt", prompt.includes('"attempts": 2') ? "ok" : "bad");
  else if (prompt.includes('"title": "Architecture change"')) writeFileSync("architecture.txt", "done");
  else if (prompt.includes('"title": "Scope violation"')) writeFileSync("outside.txt", "bad");
  else writeFileSync("output.txt", "done");
  process.exit(0);
}
throw new Error("unknown prompt");
`);
  git(["add", "fake-agent.mjs"], dir);
  git(["commit", "-m", "agent"], dir);
  return file;
}

function run(dir: string, agent: string, finalizeDocs = false): { status: number; stderr: string } {
  const command = `"${process.execPath}" "${agent}" "{prompt}"`;
  const flags = [TSX, CLI, "run", "--command", command, ...(finalizeDocs ? [] : ["--no-apply", "--no-finalize-docs"])];
  const r = spawnSync(process.execPath, flags,
    { cwd: dir, encoding: "utf-8", timeout: 120_000, env: { ...process.env, FORCE_COLOR: "0" } });
  return { status: r.status ?? 1, stderr: r.stderr ?? "" };
}

function events(dir: string): any[] {
  const file = join(dir, ".agent-runs/events.jsonl");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf-8").trim().split("\n").filter(Boolean).map(JSON.parse);
}

function state(dir: string): any { return JSON.parse(readFileSync(join(dir, "agentic.json"), "utf-8")); }
function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }

function test(name: string, body: (dir: string) => void): void {
  if (FILTER && !name.toLowerCase().includes(FILTER)) return;
  const dir = makeRepo(name.replace(/\W+/g, "-"));
  try { body(dir); passed++; console.log(`  PASS  ${name}`); }
  catch (e) { failed++; console.error(`  FAIL  ${name}\n        ${e instanceof Error ? e.message : String(e)}`); }
  finally { if (!KEEP) rmSync(dir, { recursive: true, force: true }); }
}

test("planner from empty state plans then executes", (dir) => {
  writeState(dir, [], { phase:"planning", planRevision:0 });
  const result = run(dir, fakeAgent(dir));
  assert(result.status === 0, `CLI exited ${result.status}: ${result.stderr}`);
  const log = events(dir);
  assert(log.some((e) => e.type === "planner_finished"), "planner missing");
  assert(log.some((e) => e.type === "executor_started"), "executor missing");
  assert(!log.some((e) => String(e.type).includes("task_grill")), "deleted task-grill ran");
  assert(state(dir).tasks.some((t:any) => t.id === "planned-task" && t.status === "passed"), "task did not pass");
});

test("planner-lite omits grill transcript", (dir) => {
  writeState(dir, [], { goal:"Update README.md wording", phase:"planning", planRevision:0 });
  const result = run(dir, fakeAgent(dir));
  assert(result.status === 0, `CLI exited ${result.status}: ${result.stderr}`);
  const planner = events(dir).find((event) => event.type === "planner_finished");
  assert(planner && planner.grillTranscript === undefined, "planner-lite retained grill transcript artifact");
  const prompt = readFileSync(join(planner.runDir, "planner.md"), "utf-8");
  assert(!prompt.includes("Also write an autonomous grill transcript"), "planner-lite still asks model for transcript");
});

test("planner parent checkout mutation is detected", (dir) => {
  writeState(dir, [], { phase:"planning", planRevision:0 });
  const result = run(dir, fakeAgent(dir, "planner"));
  assert(result.status !== 0, "planner parent mutation passed");
  assert(events(dir).some((e) => e.type === "parent_worktree_mutated" && e.phase === "planner"), "planner mutation evidence missing");
  assert(!events(dir).some((e) => e.type === "run_worktree_created"), "execution started after planner mutation");
});

test("bounded documentation change skips verifier", (dir) => {
  writeState(dir, [task({ title:"Documentation update", kind:"maintenance", scope:["README.md"] })]);
  const result = run(dir, fakeAgent(dir), true);
  assert(result.status === 0, `CLI exited ${result.status}: ${result.stderr}`);
  const log = events(dir);
  assert(log.some((e) => e.type === "verifier_skipped"), "skip missing");
  assert(!log.some((e) => e.type === "verifier_started"), "verifier started");
  assert(!log.some((e) => e.type === "finalize_docs_started"), "README-only task started finalizer");
  assert(!log.some((e) => e.type === "task_handover_written"), "routine handover event should not exist");
  assert(!existsSync(join(dir, ".agent-runs/agentic-progress.txt")), "redundant progress markdown should not exist");
  assert(!existsSync(join(dir, ".codegraph")), "compact README task initialized unused CodeGraph state");
  assert(!readdirSync(join(dir, ".agent-runs")).some((name) => /^run-.*\.log$/.test(name)), "duplicate top-level run log should not exist");
});

test("finalize docs commits and applies documentation edits", (dir) => {
  writeState(dir, [task({ title:"Durable docs update", kind:"maintenance", scope:["docs/guide.md"] })]);
  const result = run(dir, fakeAgent(dir), true);
  assert(result.status === 0, `CLI exited ${result.status}: ${result.stderr}`);
  assert(readFileSync(join(dir, "PROJECT.md"), "utf-8").includes("Durable project facts"), "finalizer edit was not applied");
  assert(events(dir).some((e) => e.type === "finalize_docs_finished" && e.changedPaths?.includes("PROJECT.md")), "finalizer completion evidence missing");
});

test("finalize docs rejects non-documentation edits", (dir) => {
  writeState(dir, [task({ title:"Durable docs update", kind:"maintenance", scope:["docs/guide.md"] })], { goal:"Reject finalize code mutation" });
  const result = run(dir, fakeAgent(dir), true);
  assert(result.status !== 0, "non-documentation finalizer mutation passed");
  assert(result.stderr.includes("Finalize-docs changed non-documentation files: runtime.ts"), "finalizer scope error missing");
  assert(!existsSync(join(dir, "runtime.ts")), "unsafe finalizer edit reached parent checkout");
});

test("finalize-docs parent checkout mutation is detected", (dir) => {
  writeState(dir, [task({ title:"Durable docs update", kind:"maintenance", scope:["docs/guide.md"] })]);
  const result = run(dir, fakeAgent(dir, "finalize-docs"), true);
  assert(result.status !== 0, "finalize-docs parent mutation passed");
  assert(events(dir).some((e) => e.type === "parent_worktree_mutated" && e.phase === "finalize-docs"), "finalize-docs mutation evidence missing");
});

test("stale task replans before executor", (dir) => {
  writeState(dir, [task({ title:"Stale execution" })], { goal:"Replace stale task", planRevision:2 });
  const result = run(dir, fakeAgent(dir));
  assert(result.status === 0, `CLI exited ${result.status}: ${result.stderr}`);
  assert(state(dir).tasks.find((t:any) => t.id === "task-001")?.status === "blocked", "stale task not blocked");
  assert(state(dir).tasks.find((t:any) => t.id === "replacement")?.status === "passed", "replacement not passed");
  assert(events(dir).some((e) => e.type === "task_replan_requested"), "replan missing");
});

test("failed checks retry without replanning", (dir) => {
  writeState(dir, [task({ title:"Retry output", scope:["retry.txt"],
    validation:["node -e \"if(require('fs').readFileSync('retry.txt','utf8')!=='ok')process.exit(1)\""] })]);
  const result = run(dir, fakeAgent(dir));
  assert(result.status === 0, `CLI exited ${result.status}: ${result.stderr}`);
  const log = events(dir);
  assert(log.filter((e) => e.type === "executor_started").length === 2, "retry count wrong");
  assert(!log.some((e) => e.type === "planner_started"), "check failure replanned");
  assert(state(dir).tasks[0].status === "passed", "retry did not pass");
});

test("high complexity runs stance and adversarial verification", (dir) => {
  writeState(dir, [task({ title:"Architecture change", kind:"architecture", workflow:"improve-codebase-architecture",
    scope:["architecture.txt"], complexity:"high" })]);
  const result = run(dir, fakeAgent(dir));
  assert(result.status === 0, `CLI exited ${result.status}: ${result.stderr}`);
  const log = events(dir);
  assert(log.some((e) => e.type === "stance_reflection_finished"), "stance missing");
  assert(log.filter((e) => e.type === "verifier_started").length === 3, "three votes missing");
});

test("stance parent checkout mutation is detected", (dir) => {
  writeState(dir, [task({ title:"Architecture change", kind:"architecture", workflow:"improve-codebase-architecture",
    scope:["architecture.txt"], complexity:"high" })]);
  const result = run(dir, fakeAgent(dir, "stance"));
  assert(result.status !== 0, "stance parent mutation passed");
  assert(events(dir).some((e) => e.type === "parent_worktree_mutated" && e.phase === "stance-reflection"), "stance mutation evidence missing");
  assert(!events(dir).some((e) => e.type === "executor_started"), "executor started after stance mutation");
});

test("scope violation blocks passing", (dir) => {
  writeState(dir, [task({ title:"Scope violation", scope:["allowed.txt"] })], { maxIterations:1 });
  const result = run(dir, fakeAgent(dir));
  assert(result.status !== 0, "scope violation passed");
  assert(events(dir).some((e) => e.type === "scope_violation"), "scope event missing");
  assert(state(dir).tasks[0].status === "needs_retry", "wrong scope status");
});

test("verifier parent checkout mutation is detected", (dir) => {
  writeState(dir, [task()]);
  const result = run(dir, fakeAgent(dir, "verifier"));
  assert(result.status !== 0, "verifier parent mutation passed");
  assert(events(dir).some((e) => e.type === "parent_worktree_mutated" && e.phase === "verifier"), "verifier mutation evidence missing");
  assert(state(dir).tasks[0].status !== "passed", "task passed after verifier mutation");
});

test("parent checkout mutation is detected", (dir) => {
  writeState(dir, [task()]);
  const result = run(dir, fakeAgent(dir, "executor"));
  assert(result.status !== 0, "mutation passed");
  assert(events(dir).some((e) => e.type === "parent_worktree_mutated"), "mutation event missing");
  assert(state(dir).tasks[0].status === "needs_human", "mutation did not halt");
});

test("dirty parent checkout is rejected", (dir) => {
  writeState(dir, [task()]);
  const agent = fakeAgent(dir);
  writeFileSync(join(dir, "dirty.txt"), "dirty");
  const result = run(dir, agent);
  assert(result.status !== 0, "dirty checkout ran");
  assert(result.stderr.includes("Main worktree is dirty"), "dirty error missing");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
