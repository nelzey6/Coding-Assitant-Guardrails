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
  const fixturePolicy = JSON.parse(readFileSync(POLICY,"utf8"));
  fixturePolicy.autonomousLoop.worktreeBootstrap = [];
  fixturePolicy.autonomousLoop.worktreeBootstrapIgnore = [];
  writeFileSync(join(dir,"templates/agent-policy/workflow-policy.json"), JSON.stringify(fixturePolicy));
  writeFileSync(join(dir, "README.md"), "# Smoke\n");
  writeFileSync(join(dir, "AGENTS.md"), "Keep changes scoped.");
  writeFileSync(join(dir, "check.mjs"), `import {readFileSync,existsSync} from 'node:fs';
import assert from 'node:assert/strict';
const expected = {'output.txt':'done','architecture.txt':'done','README.md':'Updated.','docs/guide.md':'# Guide'};
assert.ok(Object.entries(expected).some(([path,text]) => existsSync(path) && readFileSync(path,'utf8').includes(text)), 'expected output missing');
`);
  git(["add", "-A"], dir);
  git(["commit", "-m", "fixture"], dir);
  return dir;
}

function task(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "task-001", title: "Write output", kind: "implementation", workflow: "tdd",
    status: "pending", priority: 1, acceptanceCriteria: ["requested file exists"],
    validation: ["node check.mjs"], dependsOn: [], scope: ["output.txt"], complexity: "low",
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

function fakeAgent(dir: string, mutatePhase: "" | "planner" | "stance" | "executor" | "verifier" = ""): string {
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
if (prompt.includes("Repair result JSON only to:") && !prompt.includes("You are the independent verifier")) {
  const result=prompt.match(/Repair result JSON only to: (.+)/)[1].trim();
  if (prompt.includes("Add tampered result")) writeFileSync("output.txt","tampered");
  json(result,{verdict:"completed",summary:"artifact repaired",validation:["node check.mjs"],assumptions:[]});
  process.exit(0);
}
if (prompt.includes("Write planner JSON only to:")) {
  mutateParent("planner");
  const result = prompt.match(/Write planner JSON only to: (.+)/)[1].trim();
  const transcriptMatch = prompt.match(/Also write an autonomous grill transcript markdown file to: (.+)/);
  const transcript = transcriptMatch?.[1].trim();
  const stale = prompt.includes("Replace stale task");
  const tasks = [{ id:stale?"replacement":"planned-task", title:stale?"Replacement execution":"Planned execution",
      kind:"implementation", workflow:"tdd", status:"pending", priority:1, acceptanceCriteria:["output exists"],
      validation:["node check.mjs"], dependsOn:[], scope:["output.txt"], complexity:"low", sliceRole:"primary" }];
  json(result, { verdict:"planned", summary:"planned", decisions:[], assumptions:[], openQuestions:[], blockers:[], tasks, artifacts:transcript ? [transcript] : [] });
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
  if (prompt.includes('"title": "Reviewer mutation"')) writeFileSync("output.txt", "tampered");
  if (prompt.includes('"title": "Captured live review"') && !prompt.includes("Repair result JSON only to:")) {
    json(result,JSON.parse(readFileSync("captured-review.json","utf8")));process.exit(0);
  }
  if (prompt.includes('"title": "Captured live defect"')) {
    json(result,JSON.parse(readFileSync("captured-review.json","utf8")));process.exit(0);
  }
  const reviewedTask = JSON.parse(prompt.split("Task JSON:\\n")[1].split("\\n\\nHuman gates:")[0]);
  const evidence = JSON.parse(prompt.split("Evidence JSON:\\n")[1].split("\\n\\nCheck output")[0]);
  const coverage = prompt.includes('"title": "Review without proof"') ? [] : evidence.requirements.map(({id}) => ({criterionId:id,kind:evidence.diff.hasCode?"behavior":"documentation", evidenceIds:[evidence.diff.hasCode?evidence.checks.find((c)=>c.status==='passed').evidenceId:evidence.diff.id],proves:"fixture check asserts requested output"}));
  const defect = prompt.includes('"title": "Unresolved review defect"') && result.includes("vote-3");
  const human = prompt.includes('"title": "Unresolved review gate"') && result.includes("vote-3");
  json(result, { verdict:human?"needs_human":defect?"fail":"pass", summary:"verified", coverage, issues:defect?["output.txt: missing edge case"]:[], humanGates:human?["approval needed"]:[], recommendedStatus:human?"needs_human":"passed", artifacts:[] });
  process.exit(0);
}
if (prompt.includes("Task JSON:")) {
  mutateParent("executor");
  if (prompt.includes('"title": "Add malformed check in output.txt"')) {
    writeFileSync("output.txt","done");
    const result=prompt.match(/Write direct execution JSON only to: (.+)/)[1].trim();
    json(result,{verdict:"completed",summary:"code done",validation:[readFileSync("malformed-check.txt","utf8").trim()],assumptions:[]});process.exit(0);
  }
  if (prompt.includes('"title": "Add configured result in output.txt"')) {
    if (!prompt.includes("node check.mjs")) throw new Error("operator checks hidden from executor");
    writeFileSync("output.txt","done");
    const result=prompt.match(/Write direct execution JSON only to: (.+)/)[1].trim();
    json(result,{verdict:"completed",summary:"known checks suffice",validation:[],assumptions:[]});process.exit(0);
  }
  if (prompt.includes('"title": "Add tampered result in output.txt"')) {writeFileSync("output.txt","done");process.exit(0);}
  if (prompt.includes('"title": "Slow output"')) await new Promise((resolve) => setTimeout(resolve, 1100));
  const directResult = prompt.match(/Write direct execution JSON only to: (.+)/)?.[1]?.trim();
  if (prompt.includes('"title": "Update README.md but escalate cleanly"')) {
    if (directResult) json(directResult, { verdict:"needs_planner", summary:"needs broader context", validation:[], assumptions:[] });
    process.exit(0);
  }
  if (prompt.includes('"title": "Update README.md then escalate after editing"')) {
    writeFileSync("README.md", "# Unsafe early edit\\n");
    if (directResult) json(directResult, { verdict:"needs_planner", summary:"edited before escalation", validation:[], assumptions:[] });
    process.exit(0);
  }
  if (prompt.includes('"title": "Add retry result in output.txt"') && !prompt.includes('"attempts": 2')) {
    writeFileSync("output.txt", "done");
    process.exit(0);
  }
  if (prompt.includes('"title": "Add assumed retry result in retry.txt"')) {
    writeFileSync("retry.txt", prompt.includes('"attempts": 2') ? "ok" : "bad");
    json(directResult, {verdict:"completed",summary:"retry output",validation:["node check-retry.cjs"],assumptions:["output format remains unchanged"]});
    process.exit(0);
  }
  if (prompt.includes('"title": "Extract helper from src/main.js')) {
    writeFileSync("src/helper.js", "exports.helper = () => 42;");
    writeFileSync("src/main.js", "exports.helper = require('./helper.js').helper;");
    if (directResult) json(directResult, {verdict:"completed",summary:"extracted",validation:["node check-extraction.cjs"],assumptions:[]});
    process.exit(0);
  }
  if (prompt.includes('"title": "Update wording in README.md"')) writeFileSync("README.md", "# Smoke\\n\\nUpdated.\\n");
  else if (prompt.includes('"title": "Durable docs update"')) { mkdirSync("docs", { recursive:true }); writeFileSync("docs/guide.md", "# Guide\\n"); }
  else if (prompt.includes('"title": "Documentation update"')) writeFileSync("README.md", "# Smoke\\n\\nUpdated.\\n");
  else if (prompt.includes('"title": "Retry output"')) writeFileSync("retry.txt", prompt.includes('"attempts": 2') ? "ok" : "bad");
  else if (prompt.includes('"title": "Dependency input change"')) { writeFileSync("package.json", '{"name":"changed"}'); writeFileSync("output.txt", "done"); }
  else if (prompt.includes('"title": "Architecture change"')) writeFileSync("architecture.txt", "done");
  else if (prompt.includes('"title": "Scope violation"')) writeFileSync("outside.txt", "bad");
  else writeFileSync("output.txt", "done");
  if (directResult) json(directResult, { verdict:"completed", summary:"direct task complete", validation:["node check.mjs"], assumptions:[] });
  process.exit(0);
}
throw new Error("unknown prompt");
`);
  git(["add", "fake-agent.mjs"], dir);
  git(["commit", "-m", "agent"], dir);
  return file;
}

function run(dir: string, agent: string, apply = false, extraFlags: string[] = []): { status: number; stderr: string } {
  const command = `"${process.execPath}" "${agent}" "{prompt}"`;
  const flags = [TSX, CLI, "run", "--command", command, ...extraFlags, ...(apply ? [] : ["--no-apply"])];
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

test("ignored dependency directories do not break commit staging", (dir) => {
  writeFileSync(join(dir,".gitignore"),"tools/deps/\n");
  git(["add",".gitignore"],dir);git(["commit","-m","ignored dependency directory"],dir);
  writeState(dir,[task()]);
  const result=run(dir,fakeAgent(dir),false,["--worktree-bootstrap","node -e \"require('fs').mkdirSync('tools/deps',{recursive:true}); require('fs').writeFileSync('tools/deps/generated','dependency')\"","--worktree-bootstrap-ignore","tools/deps"]);
  assert(result.status===0,result.stderr);
  assert(state(dir).tasks[0].status==="passed","candidate not committed");
});

test("invalid configured shell stops before executor", (dir) => {
  writeState(dir,[task()]);
  const result=run(dir,fakeAgent(dir),false,["--checks","node check.mjs (explanation)"]);
  assert(result.status!==0,"invalid configured command accepted");
  assert(!events(dir).some((e)=>e.type==="executor_started"),"configuration error paid for executor");
  assert(state(dir).lastRun.failedStage==="check_configuration","wrong stopped stage");
});

test("environment check failure does not retry code", (dir) => {
  writeState(dir,[task({validation:['node -e "process.exit(127)"']})]);
  const result=run(dir,fakeAgent(dir));
  assert(result.status!==0,"environment failure passed");
  assert(events(dir).filter((e)=>e.type==="executor_started").length===1,"environment failure retried code");
  assert(events(dir).find((e)=>e.type==="checks_failed")?.failureKind==="environment","failure classification lost");
  assert(state(dir).lastRun.outcome==="stopped","no terminal state");
});

test("operator checks visible and sufficient without new commands", (dir) => {
  writeState(dir, [], {goal:"Add configured result in output.txt",phase:"planning",planRevision:0});
  const result=run(dir,fakeAgent(dir),false,["--checks","node check.mjs"]);
  assert(result.status===0, result.stderr);
  assert(events(dir).filter((e)=>e.type==="executor_started").length===1,"extra execution");
  assert(state(dir).lastRun.outcome==="completed","missing terminal outcome");
});

for (const fixture of ["small-review", "full-review"]) test(`captured ${fixture} repairs proof without code retry`, (dir) => {
  copyFileSync(join(ROOT,"tests/agentic/fixtures/live-contracts",fixture+".json"),join(dir,"captured-review.json"));
  git(["add","captured-review.json"],dir);git(["commit","-m","captured model response"],dir);
  writeState(dir,[task({title:"Captured live review"})]);
  const result=run(dir,fakeAgent(dir));
  assert(result.status===0,result.stderr);
  const log=events(dir);
  assert(log.filter((e)=>e.type==="executor_started").length===1,"proof repair repeated code");
  assert(log.filter((e)=>e.type==="artifact_repair_started").length===1,"proof was silently accepted or repair unbounded");
  assert(state(dir).tasks[0].attempts===1,"artifact repair consumed code attempt");
});

for (const effort of ["medium", "xhigh"]) test(`captured ${effort} defect is an outcome not artifact repair`, (dir) => {
  copyFileSync(join(ROOT,"tests/agentic/fixtures/live-contracts",effort+"-defect.json"),join(dir,"captured-review.json"));
  git(["add","captured-review.json"],dir);git(["commit","-m","captured structured finding"],dir);
  writeState(dir,[task({title:"Captured live defect"})],{maxIterations:1});
  const result=run(dir,fakeAgent(dir));
  assert(result.status!==0,"concrete defect accepted");
  assert(events(dir).find((e)=>e.type==="verifier_finished")?.verdict==="fail","defect lost");
  assert(!events(dir).some((e)=>e.type==="artifact_repair_started"),"useful finding paid for reformatting");
  assert(!events(dir).some((e)=>e.type==="task_passed"),"defective candidate committed");
});

test("captured malformed command repairs metadata before checks", (dir) => {
  copyFileSync(join(ROOT,"tests/agentic/fixtures/live-contracts/malformed-check.txt"),join(dir,"malformed-check.txt"));
  git(["add","malformed-check.txt"],dir);git(["commit","-m","captured command"],dir);
  writeState(dir,[],{goal:"Add malformed check in output.txt",phase:"planning",planRevision:0});
  const result=run(dir,fakeAgent(dir),false,["--checks","node check.mjs"]);
  assert(result.status===0,result.stderr);
  const log=events(dir);
  assert(log.filter((e)=>e.type==="executor_started").length===1,"syntax error triggered coding");
  assert(log.filter((e)=>e.type==="artifact_repair_started").length===1,"missing repair");
  assert(!log.some((e)=>e.type==="checks_failed"),"invalid syntax reached execution");
});

test("artifact repair mutation stops with terminal state", (dir) => {
  writeState(dir,[],{goal:"Add tampered result in output.txt",phase:"planning",planRevision:0});
  const result=run(dir,fakeAgent(dir));
  assert(result.status!==0,"repair mutated repository and passed");
  assert(events(dir).some((e)=>e.type==="candidate_mutated"),"missing mutation evidence");
  assert(!state(dir).tasks.some((t:any)=>t.status==="running"),"dead task left running");
  assert(state(dir).lastRun.outcome==="stopped","missing terminal stop");
  assert(events(dir).filter((e)=>e.type==="run_latency").length===1,"terminal time not recorded once");
});

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

test("bounded documentation goal executes directly without planner", (dir) => {
  writeState(dir, [], { goal:"Update wording in README.md", phase:"planning", planRevision:0 });
  const result = run(dir, fakeAgent(dir));
  assert(result.status === 0, `CLI exited ${result.status}: ${result.stderr}`);
  const log = events(dir);
  assert(log.some((e) => e.type === "execution_route_selected" && e.route === "direct"), "direct route event missing");
  assert(!log.some((e) => e.type === "planner_started"), "planner ran for direct goal");
  assert(log.some((e) => e.type === "checks_started" && e.commands?.includes('node check.mjs')), "executor validation was not adopted");
  assert(log.some((e) => e.type === "verifier_skipped"), "documentation direct task should skip verifier");
});

test("bounded code goal executes directly with verifier", (dir) => {
  writeState(dir, [], { goal:"Add output in output.txt", phase:"planning", planRevision:0 });
  const result = run(dir, fakeAgent(dir));
  assert(result.status === 0, `CLI exited ${result.status}: ${result.stderr}`);
  const log = events(dir);
  assert(!log.some((e) => e.type === "planner_started"), "planner ran for direct code goal");
  assert(log.some((e) => e.type === "verifier_started"), "code direct task skipped verifier");
});

test("mechanical extraction preserves runtime exports with two model calls", (dir) => {
  mkdirSync(join(dir,"src"));
  writeFileSync(join(dir,"src/main.js"), "exports.helper = () => 42;");
  writeFileSync(join(dir,"check-extraction.cjs"), "const assert=require('node:assert/strict'); assert.equal(require('./src/main.js').helper(),42); assert.equal(require('./src/helper.js').helper(),42);");
  git(["add","src/main.js","check-extraction.cjs"],dir); git(["commit","-m","extraction fixture"],dir);
  writeState(dir, [], {goal:"Extract helper from src/main.js into src/helper.js. Preserve behavior.",phase:"planning",planRevision:0});
  const started = performance.now();
  const result = run(dir, fakeAgent(dir), true);
  assert(result.status === 0, `extraction failed: ${result.stderr}`);
  assert(spawnSync(process.execPath,["check-extraction.cjs"],{cwd:dir}).status === 0, "applied runtime exports broke");
  const log = events(dir);
  assert(log.filter((e) => e.type === "agent_invocation_finished").length === 2, "small extraction paid for extra model phases");
  const executor = log.find((e) => e.type === "executor_started");
  const prompt = readFileSync(executor.prompt,"utf8");
  assert(prompt.includes("Compact low-risk task"), "code prompt was not compact");
  assert(!prompt.includes("Read and follow the canonical SKILL.md"), "mechanical task forced a full workflow");
  assert(!existsSync(join(dir,".codegraph")), "extraction created an index");
  console.log(`        fixture wall=${Math.round(performance.now()-started)}ms; agent invocations=2`);
});

test("clean direct escalation falls back to full planner", (dir) => {
  writeState(dir, [], { goal:"Update README.md but escalate cleanly", phase:"planning", planRevision:0 });
  const result = run(dir, fakeAgent(dir));
  assert(result.status === 0, `CLI exited ${result.status}: ${result.stderr}`);
  const log = events(dir);
  assert(log.some((e) => e.type === "direct_execution_needs_planner"), "direct fallback event missing");
  assert(log.some((e) => e.type === "planner_started"), "fallback planner missing");
  assert(state(dir).tasks.find((t:any) => t.id === "direct-goal")?.status === "blocked", "direct task not blocked before replacement");
});

test("dirty direct escalation fails instead of planning over edits", (dir) => {
  writeState(dir, [], { goal:"Update README.md then escalate after editing", phase:"planning", planRevision:0 });
  const result = run(dir, fakeAgent(dir));
  assert(result.status !== 0, "dirty direct escalation passed");
  assert(result.stderr.includes("needs_planner after changing"), "dirty escalation error missing");
  assert(!events(dir).some((e) => e.type === "planner_started"), "planner ran over dirty direct changes");
});

test("missing direct result repairs artifact without code retry", (dir) => {
  writeState(dir, [], { goal:"Add retry result in output.txt", phase:"planning", planRevision:0 });
  const result = run(dir, fakeAgent(dir));
  assert(result.status === 0, `CLI exited ${result.status}: ${result.stderr}`);
  const log = events(dir);
  assert(log.filter((e) => e.type === "executor_started").length === 1, "artifact repair repeated execution");
  assert(log.some((e) => e.type === "artifact_repair_started"), "artifact repair event missing");
  assert(!log.some((e) => e.type === "planner_started"), "missing result should not force planner");
});

test("ambiguous bounded documentation goal uses full planner", (dir) => {
  writeState(dir, [], { goal:"Optimize wording in README.md", phase:"planning", planRevision:0 });
  const result = run(dir, fakeAgent(dir));
  assert(result.status === 0, `CLI exited ${result.status}: ${result.stderr}`);
  const planner = events(dir).find((event) => event.type === "planner_finished");
  assert(planner?.grillTranscript, "full planner transcript missing");
  const prompt = readFileSync(join(planner.runDir, "planner.md"), "utf-8");
  assert(prompt.includes("Also write an autonomous grill transcript"), "ambiguous goal did not receive full planning contract");
});

test("slow history never adds a planner repair", (dir) => {
  writeState(dir, [], { goal:"Optimize wording in README.md", phase:"planning", planRevision:0 });
  writeFileSync(join(dir, ".git/info/exclude"), ".agent-runs/\n");
  mkdirSync(join(dir, ".agent-runs"), { recursive:true });
  writeFileSync(join(dir, ".agent-runs/events.jsonl"), Array.from({length:3}, () => JSON.stringify({ ts:new Date().toISOString(), type:"agent_invocation_finished", phase:"planner", durationMs:600000 })).join("\n") + "\n");
  const result = run(dir, fakeAgent(dir));
  assert(result.status === 0, `CLI exited ${result.status}: ${result.stderr}`);
  const log = events(dir);
  assert(log.filter((e) => e.type === "agent_invocation_finished" && String(e.phase).startsWith("planner")).length === 4, "slow history added another planning invocation");
  assert(!log.some((e) => e.type === "planner_latency_repair_started"), "observational latency must not add model work");
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

test("durable documentation is checked and applied without finalizer", (dir) => {
  writeState(dir, [task({ title:"Durable docs update", kind:"maintenance", scope:["docs/guide.md"] })]);
  const result = run(dir, fakeAgent(dir), true);
  assert(result.status === 0, `CLI exited ${result.status}: ${result.stderr}`);
  assert(readFileSync(join(dir,"docs/guide.md"),"utf8").includes("# Guide"), "executor docs not applied");
  assert(!events(dir).some((e) => e.type === "finalize_docs_started"), "documentation triggered another agent");
  assert(!existsSync(join(dir,"PROJECT.md")), "unscoped finalizer edit reached parent");
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
  assert(new Set(log.filter((e) => e.type === "iteration_started").map((e) => e.runDir)).size === 2, "retry reused prior verdict artifacts");
  assert(!log.some((e) => e.type === "planner_started"), "check failure replanned");
  assert(state(dir).tasks[0].status === "passed", "retry did not pass");
});

test("direct assumptions do not force planning on check retry", (dir) => {
  writeFileSync(join(dir,"check-retry.cjs"), "require('node:assert/strict').equal(require('node:fs').readFileSync('retry.txt','utf8'),'ok');");
  git(["add","check-retry.cjs"],dir); git(["commit","-m","retry assertion"],dir);
  writeState(dir, [], {goal:"Add assumed retry result in retry.txt",phase:"planning",planRevision:0});
  const result = run(dir,fakeAgent(dir));
  assert(result.status === 0, `direct retry failed: ${result.stderr}`);
  assert(!events(dir).some((e) => e.type === "planner_started"), "accepted direct assumptions invalidated retry");
  assert(events(dir).filter((e) => e.type === "executor_started").length === 2, "direct retry did not repair once");
});

test("bootstrap is reused across a check retry", (dir) => {
  writeState(dir, [task({title:"Retry output",scope:["retry.txt"],validation:["node -e \"require('node:assert').equal(require('node:fs').readFileSync('retry.txt','utf8'),'ok')\""]})]);
  const command = "node -e \"require('node:fs').appendFileSync('.bootstrap-count','1')\"";
  const result = run(dir, fakeAgent(dir), false, ["--worktree-bootstrap",command,"--worktree-bootstrap-ignore",".bootstrap-count"]);
  assert(result.status === 0, `bootstrap run failed: ${result.stderr}`);
  assert(events(dir).filter((e) => e.type === "worktree_bootstrap_passed").length === 1, "unchanged dependencies repeated bootstrap");
});

test("policy bootstrap reruns before checks when dependencies change", (dir) => {
  writeState(dir, [task({title:"Dependency input change",scope:["output.txt","package.json"],validation:["node -e \"require('node:assert').equal(require('node:fs').readFileSync('.bootstrap-count','utf8'),'11')\""]})]);
  const policyPath = join(dir,"templates/agent-policy/workflow-policy.json");
  const policy = JSON.parse(readFileSync(policyPath,"utf8"));
  policy.autonomousLoop.worktreeBootstrap = ["node -e \"require('node:fs').appendFileSync('.bootstrap-count','1')\""];
  policy.autonomousLoop.worktreeBootstrapIgnore = [".bootstrap-count"];
  writeFileSync(policyPath,JSON.stringify(policy));
  git(["add",policyPath],dir); git(["commit","-m","bootstrap policy"],dir);
  const result = run(dir,fakeAgent(dir));
  assert(result.status === 0, `dependency bootstrap failed: ${result.stderr}`);
  assert(events(dir).filter((e) => e.type === "worktree_bootstrap_passed").length === 2, "dependency edit did not invalidate setup");
});

test("high complexity runs stance and adversarial verification", (dir) => {
  writeState(dir, [task({ title:"Architecture change", kind:"architecture", workflow:"improve-codebase-architecture",
    scope:["architecture.txt"], complexity:"high" })]);
  const result = run(dir, fakeAgent(dir));
  assert(result.status === 0, `CLI exited ${result.status}: ${result.stderr}`);
  const log = events(dir);
  assert(log.some((e) => e.type === "stance_reflection_finished"), "stance missing");
  assert(log.filter((e) => e.type === "verifier_started").length === 3, "three votes missing");
  const thirdStart = log.map((e) => e.type).lastIndexOf("verifier_started");
  const firstVoteFinish = log.findIndex((e) => e.type === "agent_invocation_finished" && String(e.phase).startsWith("verifier-vote-"));
  assert(firstVoteFinish > thirdStart, "adversarial votes were not launched together before completion collection");
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
  writeState(dir, [task({ title:"Scope violation", scope:["allowed.txt"], validation:["node -e \"require('node:assert').ok(require('node:fs').existsSync('outside.txt'))\""] })], { maxIterations:1 });
  const result = run(dir, fakeAgent(dir));
  assert(result.status !== 0, "scope violation passed");
  assert(events(dir).some((e) => e.type === "scope_violation"), "scope event missing");
  assert(state(dir).tasks[0].status === "needs_retry", "wrong scope status");
});

test("passing review must explain acceptance proof", (dir) => {
  writeState(dir, [task({title:"Review without proof"})]);
  const result = run(dir, fakeAgent(dir));
  assert(result.status !== 0, "unsupported pass verdict accepted");
  assert(!events(dir).some((e) => e.type === "task_passed"), "unsupported pass committed");
  assert(state(dir).tasks[0].status === "failed", "rejected result left task running");
  assert(state(dir).lastRun.failedStage === "verifier", "failed stage lost");
  assert(events(dir).filter((e)=>e.type==="run_latency").length===1, "failed run omitted terminal time");
});

test("one unresolved defect cannot be outvoted", (dir) => {
  writeState(dir, [task({title:"Unresolved review defect",complexity:"high",complexityReasons:["behavioral uncertainty"]})],{maxIterations:1});
  const result = run(dir,fakeAgent(dir));
  assert(result.status !== 0, "two passing votes hid a concrete defect");
  assert(events(dir).find((e) => e.type === "verifier_finished")?.verdict === "fail", "defect verdict lost");
});

test("one unresolved human gate cannot be outvoted", (dir) => {
  writeState(dir, [task({title:"Unresolved review gate",complexity:"high",complexityReasons:["public contract uncertainty"]})]);
  const result = run(dir, fakeAgent(dir));
  assert(result.status !== 0, "two passes overruled human gate");
  const event = events(dir).find((e) => e.type === "verifier_finished");
  assert(event?.verdict === "needs_human", "unresolved gate must stop run");
  assert(JSON.parse(readFileSync(event.resultFile,"utf8")).humanGates.includes("approval needed"), "human gate lost during aggregation");
});

test("reviewer cannot change the checked candidate", (dir) => {
  writeState(dir, [task({title:"Reviewer mutation"})]);
  const result = run(dir, fakeAgent(dir));
  assert(result.status !== 0, "reviewer changed candidate and still passed");
  assert(events(dir).some((e) => e.type === "candidate_mutated"), "candidate mutation evidence missing");
  assert(!events(dir).some((e) => e.type === "task_passed"), "mutated candidate committed");
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

test("hard max-runtime circuit breaker remains authoritative", (dir) => {
  writeState(dir, [task({ title:"Slow output" })]);
  const result = run(dir, fakeAgent(dir), false, ["--max-runtime-seconds", "1"]);
  assert(result.status !== 0, "hard runtime breaker did not stop run");
  assert(events(dir).some((e) => e.type === "budget_exhausted"), "hard runtime budget event missing");
});

test("soft phase overrun emits evidence without stopping", (dir) => {
  writeState(dir, [task()]);
  const policyPath = join(dir, "templates/agent-policy/workflow-policy.json");
  const localPolicy = JSON.parse(readFileSync(policyPath, "utf-8"));
  localPolicy.autonomousLoop.latency.phaseTargetsSeconds.executor = 0.001;
  writeFileSync(policyPath, JSON.stringify(localPolicy, null, 2));
  git(["add", policyPath], dir);
  git(["commit", "-m", "tight latency fixture"], dir);
  const result = run(dir, fakeAgent(dir));
  assert(result.status === 0, `soft overrun stopped run: ${result.stderr}`);
  assert(events(dir).some((e) => e.type === "latency_target_exceeded" && e.scope === "phase" && e.phase === "executor"), "soft phase overrun event missing");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
