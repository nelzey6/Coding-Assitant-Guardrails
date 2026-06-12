#!/usr/bin/env tsx
/**
 * End-to-end smoke test for the TypeScript agentic loop CLI.
 * Mirrors the coverage of scope-rail-smoke, fast-verifier-guard-smoke,
 * validation-checks-smoke, and retry-smoke — but drives `agent run`
 * (tools/agent-loop/src/index.ts) instead of the PS1 harness.
 *
 * Each case spins up a throwaway git repo in $TEMP, writes a fake agent
 * script that either passes, fails checks, or writes a verifier JSON,
 * runs the CLI, then asserts on state + events.
 *
 * Run: npx tsx tests/agentic/agent-loop-ts-smoke.ts
 * Keep temp dirs: AGENTIC_KEEP_SMOKE=1 npx tsx tests/agentic/agent-loop-ts-smoke.ts
 */

import {
  mkdirSync, mkdtempSync, writeFileSync, readFileSync,
  rmSync, existsSync, copyFileSync,
} from "fs";
import { join, resolve } from "path";
import { tmpdir } from "os";
import { spawnSync, execFileSync } from "child_process";

// ── helpers ──────────────────────────────────────────────────────────────────

const REPO_ROOT = resolve(import.meta.dirname, "../..");
const CLI = join(REPO_ROOT, "tools/agent-loop/src/index.ts");
// On Windows, avoid tsx.cmd (which requires shell:true and breaks quoted --command args).
// Instead invoke node directly with tsx's CLI entry point so we can use shell:false.
const TSX_CLI_MJS = join(REPO_ROOT, "tools/agent-loop/node_modules/tsx/dist/cli.mjs");
const IS_WIN = process.platform === "win32";
const keep = process.env.AGENTIC_KEEP_SMOKE === "1";

const POLICY_SRC = join(REPO_ROOT, "templates/agent-policy/workflow-policy.json");

function tmpRepo(tag: string): string {
  const dir = mkdtempSync(join(tmpdir(), `agentic-ts-smoke-${tag}-`));
  git(["init"], dir);
  git(["config", "user.email", "agentic-smoke@example.test"], dir);
  git(["config", "user.name", "Agentic Smoke"], dir);
  writeFileSync(join(dir, "README.md"), "# smoke", "utf-8");
  writeFileSync(join(dir, "AGENTS.md"), "Smoke repo rules.", "utf-8");
  // Provide the workflow policy so loadPolicy() can resolve it.
  const policyDir = join(dir, "templates", "agent-policy");
  mkdirSync(policyDir, { recursive: true });
  copyFileSync(POLICY_SRC, join(policyDir, "workflow-policy.json"));
  return dir;
}

function git(args: string[], cwd?: string): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf-8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed:\n${r.stderr}`);
  return r.stdout.trim();
}

function writeState(dir: string, state: object): void {
  writeFileSync(join(dir, "agentic.json"), JSON.stringify(state, null, 2), "utf-8");
}

function readState(dir: string): any {
  return JSON.parse(readFileSync(join(dir, "agentic.json"), "utf-8"));
}

function readEvents(dir: string): any[] {
  const p = join(dir, ".agent-runs", "events.jsonl");
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf-8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

function hasEvent(events: any[], type: string): boolean {
  return events.some((e) => e.type === type);
}

// Write a JS fake-agent script. On Windows the `--command` template invokes
// node directly (avoids shell quoting complexity with tsx).
function writeFakeAgent(dir: string, name: string, body: string): string {
  const p = join(dir, name);
  writeFileSync(p, `#!/usr/bin/env node
import { readFileSync as __readFileSync, writeFileSync as __writeFileSync, mkdirSync as __mkdirSync } from "fs";
import { dirname as __dirname } from "path";
const __promptFile = process.argv[2];
const __promptContent = __readFileSync(__promptFile, "utf-8");
if (__promptContent.includes("Write task-grill JSON only to:")) {
  const m = __promptContent.match(/Write task-grill JSON only to: (.+)/);
  if (!m) throw new Error("no task-grill result path");
  const resultPath = m[1].trim();
  __mkdirSync(__dirname(resultPath), { recursive: true });
  if (__promptContent.includes('"title": "Stop before edit"')) {
    __writeFileSync(resultPath, JSON.stringify({
      verdict: "needs_human",
      understanding: "Task is intentionally ambiguous in this smoke test.",
      evidence: ["task JSON"],
      assumptionsStillValid: [],
      assumptionsChanged: ["acceptance proof missing"],
      scopeDecision: { declaredScopeOk: false, requestedScopeChanges: [] },
      acceptanceProof: [],
      risks: ["stop before executor edits"],
      executorInstructions: ""
    }), "utf-8");
  } else if (__promptContent.includes('"title": "Needs replan"')) {
    __writeFileSync(resultPath, JSON.stringify({
      verdict: "needs_replan",
      understanding: "Task is stale and should be replaced before editing.",
      evidence: ["task JSON"],
      assumptionsStillValid: [],
      assumptionsChanged: ["original task is stale"],
      scopeDecision: { declaredScopeOk: false, requestedScopeChanges: ["output.txt"] },
      acceptanceProof: [],
      risks: ["planner must create replacement task"],
      executorInstructions: ""
    }), "utf-8");
  } else {
    __writeFileSync(resultPath, JSON.stringify({
      verdict: "ready",
      understanding: "Task understood for smoke execution.",
      evidence: ["task JSON"],
      assumptionsStillValid: [],
      assumptionsChanged: [],
      scopeDecision: { declaredScopeOk: true, requestedScopeChanges: [] },
      acceptanceProof: ["configured checks and verifier"],
      risks: [],
      executorInstructions: "Proceed with the task and respect declared scope."
    }), "utf-8");
  }
  process.exit(0);
}
if (__promptContent.includes("Write post-task review JSON only to:")) {
  const m = __promptContent.match(/Write post-task review JSON only to: (.+)/);
  if (!m) throw new Error("no post-task review result path");
  const resultPath = m[1].trim();
  __mkdirSync(__dirname(resultPath), { recursive: true });
  if (__promptContent.includes('"title": "Post review replan"')) {
    __writeFileSync(resultPath, JSON.stringify({
      verdict: "replan",
      assessment: "completed slice changed remaining plan",
      remainingPlanStillValid: false,
      suggestedChanges: ["replace remaining stale task"]
    }), "utf-8");
    process.exit(0);
  }
  __writeFileSync(resultPath, JSON.stringify({
    verdict: "continue",
    assessment: "remaining plan still valid for smoke execution",
    remainingPlanStillValid: true,
    suggestedChanges: []
  }), "utf-8");
  process.exit(0);
}
if (__promptContent.includes("Write decision JSON only to:")) {
  const m = __promptContent.match(/Write decision JSON only to: (.+)/);
  if (!m) throw new Error("no decision result path");
  const resultPath = m[1].trim();
  __mkdirSync(__dirname(resultPath), { recursive: true });
  __writeFileSync(resultPath, JSON.stringify({ decisions: [] }), "utf-8");
  process.exit(0);
}
if (__promptContent.includes("Write your verdict JSON only to:") && __promptContent.includes("architect reviewer")) {
  const m = __promptContent.match(/Write your verdict JSON only to: (.+)/);
  if (!m) throw new Error("no architect checkpoint result path");
  const resultPath = m[1].trim();
  __mkdirSync(__dirname(resultPath), { recursive: true });
  __writeFileSync(resultPath, JSON.stringify({
    verdict: "continue",
    assessment: "checkpoint still valid",
    suggestedChanges: []
  }), "utf-8");
  process.exit(0);
}
${body}
`, "utf-8");
  return p;
}

function runCLI(cwd: string, args: string[], timeout = 60_000): { status: number; stdout: string; stderr: string } {
  // Use node + tsx/dist/cli.mjs directly (no .cmd wrapper) so we can use shell:false
  // and pass quoted --command arguments without the shell re-parsing them.
  const r = spawnSync(
    process.execPath,
    [TSX_CLI_MJS, CLI, ...args],
    { cwd, encoding: "utf-8", timeout, shell: false, env: { ...process.env, FORCE_COLOR: "0" } }
  );
  return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

// Fake agents are plain .mjs (no TypeScript), run with node directly.
// Quote both paths so Windows paths with spaces (e.g. "C:\Program Files\...") don't break.
function fakeCommand(agentPath: string): string {
  const nodePath = process.execPath.includes(" ") ? `"${process.execPath}"` : process.execPath;
  const agentQ   = agentPath.includes(" ")        ? `"${agentPath}"`        : agentPath;
  return `${nodePath} ${agentQ} {prompt}`;
}

function baseTask(overrides: object = {}): object {
  return {
    id: "task-001",
    title: "Smoke task",
    kind: "implementation",
    workflow: "tdd",
    status: "pending",
    priority: 1,
    acceptanceCriteria: ["output.txt exists"],
    validation: [],
    dependsOn: [],
    failureHistory: [],
    artifacts: [],
    scope: [],
    ...overrides,
  };
}

function baseState(taskOverrides: object = {}, stateOverrides: object = {}): object {
  return {
    version: 1,
    goal: "Smoke goal",
    maxIterations: 3,
    checks: [],
    defaultDiscoveryWorkflow: "grill-with-docs",
    tasks: [baseTask(taskOverrides)],
    decisions: [],
    assumptions: [],
    openQuestions: [],
    blockers: [],
    promptPolicy: { lessons: [] },
    ...stateOverrides,
  };
}

function assert(condition: boolean, msg: string): void {
  if (!condition) throw new Error(`ASSERTION FAILED: ${msg}`);
}

const results: { name: string; ok: boolean; error?: string }[] = [];

function runCase(name: string, fn: () => void): void {
  try {
    fn();
    results.push({ name, ok: true });
    console.log(`  PASS  ${name}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    results.push({ name, ok: false, error: msg });
    console.error(`  FAIL  ${name}\n        ${msg}`);
  }
}

// ── case 1: happy path — executor writes file, verifier passes ────────────────

runCase("happy path: task passes end-to-end", () => {
  const dir = tmpRepo("happy");
  try {
    writeState(dir, baseState());

    const agent = writeFakeAgent(dir, "fake-agent.mjs", `
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { dirname } from "path";
const promptFile = process.argv[2];
const content = readFileSync(promptFile, "utf-8");
if (content.includes("Write JSON only to this path:")) {
  const m = content.match(/Write JSON only to this path: (.+)/);
  if (!m) throw new Error("no result path");
  const p = m[1].trim();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify({ verdict: "pass", summary: "ok", issues: [], humanGates: [], recommendedStatus: "passed", artifacts: [] }), "utf-8");
  process.exit(0);
}
if (!content.includes("Task-grill result for this turn:")) throw new Error("executor prompt missing task-grill result");
writeFileSync("output.txt", "done", "utf-8");
`);

    git(["add", "-A"], dir);
    git(["commit", "-m", "initial"], dir);

    const r = runCLI(dir, ["run", "--command", fakeCommand(agent), "--max-iterations", "1", "--no-merge"]);
    assert(r.status === 0, `CLI exited ${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);

    const state = readState(dir);
    assert(state.tasks[0].status === "passed", `expected passed, got ${state.tasks[0].status}`);
    const events = readEvents(dir);
    assert(hasEvent(events, "task_grill_finished"), "missing task_grill_finished event");
    assert(hasEvent(events, "verifier_finished"), "missing verifier_finished event");
    assert(hasEvent(events, "task_passed"), "missing task_passed event");
    assert(hasEvent(events, "post_task_review_finished"), "missing post_task_review_finished event");
  } finally {
    if (!keep) rmSync(dir, { recursive: true, force: true });
  }
});

// ── case 1b: task-grill can stop before executor edits ───────────────────────

runCase("task-grill stop: needs_human before executor edits", () => {
  const dir = tmpRepo("grill-stop");
  try {
    writeState(dir, baseState({ title: "Stop before edit", scope: ["output.txt"] }));

    const agent = writeFakeAgent(dir, "fake-agent.mjs", `
throw new Error("executor/verifier should not run after task-grill stop");
`);

    git(["add", "-A"], dir);
    git(["commit", "-m", "initial"], dir);

    const r = runCLI(dir, ["run", "--command", fakeCommand(agent), "--max-iterations", "1", "--no-merge"]);
    assert(r.status !== 0, "expected non-zero exit when task-grill stops");
    const state = readState(dir);
    assert(state.tasks[0].status === "needs_human", `expected needs_human, got ${state.tasks[0].status}`);
    assert(!existsSync(join(dir, ".worktrees", "task-001", "output.txt")), "executor must not create output.txt");
    const events = readEvents(dir);
    assert(hasEvent(events, "task_grill_finished"), "missing task_grill_finished event");
    assert(!hasEvent(events, "executor_started"), "executor must not start after task-grill stop");
  } finally {
    if (!keep) rmSync(dir, { recursive: true, force: true });
  }
});

// ── case 1c: task-grill can route stale tasks back through planner ───────────

runCase("task-grill replan: stale task is blocked and replacement task runs", () => {
  const dir = tmpRepo("grill-replan");
  try {
    writeState(dir, baseState({ title: "Needs replan", scope: ["stale.txt"] }, { maxIterations: 3 }));

    const agent = writeFakeAgent(dir, "fake-agent.mjs", `
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname } from "path";
const promptFile = process.argv[2];
const content = readFileSync(promptFile, "utf-8");
if (content.includes("Write planner JSON only to:")) {
  const m = content.match(/Write planner JSON only to: (.+)/);
  if (!m) throw new Error("no planner result path");
  const resultPath = m[1].trim();
  mkdirSync(dirname(resultPath), { recursive: true });
  writeFileSync(resultPath, JSON.stringify({
    verdict: "planned",
    summary: "replacement task planned",
    decisions: [],
    assumptions: [],
    openQuestions: [],
    blockers: [],
    artifacts: [],
    tasks: [{
      id: "task-002",
      title: "Replanned task",
      kind: "maintenance",
      workflow: "tdd",
      status: "pending",
      priority: 2,
      acceptanceCriteria: ["output.txt exists"],
      validation: [],
      dependsOn: [],
      failureHistory: [],
      artifacts: [],
      scope: ["output.txt"]
    }]
  }), "utf-8");
  const grillPathMatch = content.match(/Also write an autonomous grill transcript markdown file to: (.+)/);
  if (grillPathMatch) {
    const grillPath = grillPathMatch[1].trim();
    mkdirSync(dirname(grillPath), { recursive: true });
    writeFileSync(grillPath, "# Autonomous Grill Transcript\\n\\nReplacement planned.", "utf-8");
  }
  process.exit(0);
}
if (content.includes("Write JSON only to this path:")) {
  const m = content.match(/Write JSON only to this path: (.+)/);
  if (!m) throw new Error("no verifier result path");
  const p = m[1].trim();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify({ verdict: "pass", summary: "replanned ok", issues: [], humanGates: [], recommendedStatus: "passed", artifacts: [] }), "utf-8");
  process.exit(0);
}
if (!content.includes('"id": "task-002"')) throw new Error("executor should only run replacement task");
writeFileSync("output.txt", "done", "utf-8");
`);

    git(["add", "-A"], dir);
    git(["commit", "-m", "initial"], dir);

    const r = runCLI(dir, ["run", "--command", fakeCommand(agent), "--max-iterations", "3", "--no-merge"], 90_000);
    assert(r.status === 0, `CLI exited ${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
    const state = readState(dir);
    const stale = state.tasks.find((t: any) => t.id === "task-001");
    const replacement = state.tasks.find((t: any) => t.id === "task-002");
    assert(stale?.status === "blocked", `expected stale task blocked, got ${stale?.status}`);
    assert(replacement?.status === "passed", `expected replacement passed, got ${replacement?.status}`);
    const events = readEvents(dir);
    assert(hasEvent(events, "task_replan_requested"), "missing task_replan_requested event");
    assert(hasEvent(events, "planner_finished"), "missing planner_finished event");
    assert(hasEvent(events, "task_passed"), "missing task_passed event");
  } finally {
    if (!keep) rmSync(dir, { recursive: true, force: true });
  }
});

// ── case 1d: post-task review can replan stale remaining work ────────────────

runCase("post-task review: replan verdict calls planner before continuing", () => {
  const dir = tmpRepo("post-task-replan");
  try {
    writeState(dir, baseState(
      { title: "Post review replan", scope: ["output.txt"] },
      {
        maxIterations: 4,
        tasks: [
          baseTask({ id: "task-001", title: "Post review replan", scope: ["output.txt"], priority: 1 }),
          baseTask({ id: "task-002", title: "Stale remaining task", scope: ["stale.txt"], priority: 2, dependsOn: ["task-001"] }),
        ],
      }
    ));

    const agent = writeFakeAgent(dir, "fake-agent.mjs", `
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname } from "path";
const promptFile = process.argv[2];
const content = readFileSync(promptFile, "utf-8");
if (content.includes("Write planner JSON only to:")) {
  const m = content.match(/Write planner JSON only to: (.+)/);
  if (!m) throw new Error("no planner result path");
  const resultPath = m[1].trim();
  mkdirSync(dirname(resultPath), { recursive: true });
  writeFileSync(resultPath, JSON.stringify({
    verdict: "planned",
    summary: "remaining plan adjusted after post-task review",
    decisions: [],
    assumptions: ["post-task review replaced stale remaining task"],
    openQuestions: [],
    blockers: [],
    artifacts: [],
    tasks: [{
      id: "task-003",
      title: "Adjusted remaining task",
      kind: "maintenance",
      workflow: "tdd",
      status: "pending",
      priority: 3,
      acceptanceCriteria: ["adjusted.txt exists"],
      validation: [],
      dependsOn: [],
      failureHistory: [],
      artifacts: [],
      scope: ["adjusted.txt"]
    }]
  }), "utf-8");
  const grillPathMatch = content.match(/Also write an autonomous grill transcript markdown file to: (.+)/);
  if (grillPathMatch) {
    const grillPath = grillPathMatch[1].trim();
    mkdirSync(dirname(grillPath), { recursive: true });
    writeFileSync(grillPath, "# Autonomous Grill Transcript\\n\\nAdjusted after post-task review.", "utf-8");
  }
  process.exit(0);
}
if (content.includes("Write JSON only to this path:")) {
  const m = content.match(/Write JSON only to this path: (.+)/);
  if (!m) throw new Error("no verifier result path");
  const p = m[1].trim();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify({ verdict: "pass", summary: "verified", issues: [], humanGates: [], recommendedStatus: "passed", artifacts: [] }), "utf-8");
  process.exit(0);
}
if (content.includes('"id": "task-003"')) {
  writeFileSync("adjusted.txt", "done", "utf-8");
  process.exit(0);
}
if (content.includes('"id": "task-002"')) throw new Error("executor should not run stale task-002 after post-task replan");
writeFileSync("output.txt", "done", "utf-8");
`);

    git(["add", "-A"], dir);
    git(["commit", "-m", "initial"], dir);

    const r = runCLI(dir, ["run", "--command", fakeCommand(agent), "--max-iterations", "4", "--no-merge"], 120_000);
    assert(r.status === 0, `CLI exited ${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
    const state = readState(dir);
    const adjusted = state.tasks.find((t: any) => t.id === "task-003");
    assert(adjusted?.status === "passed", `expected adjusted task passed, got ${adjusted?.status}`);
    const events = readEvents(dir);
    assert(hasEvent(events, "post_task_review_replan"), "missing post_task_review_replan event");
    assert(hasEvent(events, "planner_finished"), "missing planner_finished after post-task review");
  } finally {
    if (!keep) rmSync(dir, { recursive: true, force: true });
  }
});

// ── case 1e: unscoped task emits warning event, still runs ───────────────────

runCase("unscoped task: emits scope_missing_warning, task still runs", () => {
  const dir = tmpRepo("unscoped");
  try {
    writeState(dir, baseState({ scope: [] }));

    const agent = writeFakeAgent(dir, "fake-agent.mjs", `
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname } from "path";
const content = readFileSync(process.argv[2], "utf-8");
if (content.includes("Write JSON only to this path:")) {
  const m = content.match(/Write JSON only to this path: (.+)/);
  const p = m[1].trim();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify({ verdict: "pass", summary: "ok", issues: [], humanGates: [], recommendedStatus: "passed", artifacts: [] }), "utf-8");
  process.exit(0);
}
writeFileSync("output.txt", "done", "utf-8");
`);

    git(["add", "-A"], dir);
    git(["commit", "-m", "initial"], dir);

    const r = runCLI(dir, ["run", "--command", fakeCommand(agent), "--max-iterations", "1", "--no-merge"]);
    assert(r.status === 0, `CLI exited ${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
    const state = readState(dir);
    assert(state.tasks[0].status === "passed", `expected passed, got ${state.tasks[0].status}`);
    const events = readEvents(dir);
    assert(hasEvent(events, "scope_missing_warning"), "expected scope_missing_warning event for unscoped task");
    assert(hasEvent(events, "task_passed"), "expected task to still pass despite missing scope");
  } finally {
    if (!keep) rmSync(dir, { recursive: true, force: true });
  }
});

// ── case 2: scope violation — out-of-scope file → task fails ─────────────────

runCase("scope violation: out-of-scope file marks task failed", () => {
  const dir = tmpRepo("scope");
  try {
    writeState(dir, baseState({ scope: ["allowed/**"] }));

    const agent = writeFakeAgent(dir, "fake-agent.mjs", `
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname } from "path";
const content = readFileSync(process.argv[2], "utf-8");
if (content.includes("Write JSON only to this path:")) throw new Error("verifier must not run after scope violation");
mkdirSync("allowed", { recursive: true });
writeFileSync("allowed/in.txt", "ok", "utf-8");
writeFileSync("outside.txt", "sneaky", "utf-8");
`);

    git(["add", "-A"], dir);
    git(["commit", "-m", "initial"], dir);

    const r = runCLI(dir, ["run", "--command", fakeCommand(agent), "--max-iterations", "1", "--no-merge"]);
    // non-zero exit expected (needs_human path)
    const state = readState(dir);
    assert(state.tasks[0].status !== "passed", `task must not pass after scope violation, got ${state.tasks[0].status}`);
    const events = readEvents(dir);
    assert(hasEvent(events, "scope_violation"), "missing scope_violation event");
    const scopeEv = events.find((e) => e.type === "scope_violation");
    assert(scopeEv?.outOfScope?.includes("outside.txt"), `expected outside.txt in outOfScope, got ${JSON.stringify(scopeEv?.outOfScope)}`);
  } finally {
    if (!keep) rmSync(dir, { recursive: true, force: true });
  }
});

// ── case 3: scope clean — task passes when diff stays in scope ───────────────

runCase("scope clean: in-scope diff → scope_passed event", () => {
  const dir = tmpRepo("scope-clean");
  try {
    writeState(dir, baseState({ scope: ["allowed/**"] }));

    const agent = writeFakeAgent(dir, "fake-agent.mjs", `
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname } from "path";
const content = readFileSync(process.argv[2], "utf-8");
if (content.includes("Write JSON only to this path:")) {
  const m = content.match(/Write JSON only to this path: (.+)/);
  const p = m[1].trim();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify({ verdict: "pass", summary: "ok", issues: [], humanGates: [], recommendedStatus: "passed", artifacts: [] }), "utf-8");
  process.exit(0);
}
mkdirSync("allowed", { recursive: true });
writeFileSync("allowed/in.txt", "ok", "utf-8");
`);

    git(["add", "-A"], dir);
    git(["commit", "-m", "initial"], dir);

    const r = runCLI(dir, ["run", "--command", fakeCommand(agent), "--max-iterations", "1", "--no-merge"]);
    assert(r.status === 0, `CLI exited ${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
    const state = readState(dir);
    assert(state.tasks[0].status === "passed", `expected passed, got ${state.tasks[0].status}`);
    const events = readEvents(dir);
    assert(hasEvent(events, "scope_passed"), "missing scope_passed event");
  } finally {
    if (!keep) rmSync(dir, { recursive: true, force: true });
  }
});

// ── case 4: fast-verifier denied for high-risk task ──────────────────────────

runCase("fast-verifier denied: high-risk task runs full verifier", () => {
  const dir = tmpRepo("fvguard");
  try {
    writeState(dir, baseState({ kind: "implementation", scope: ["out.txt"] }));

    const agent = writeFakeAgent(dir, "fake-agent.mjs", `
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname } from "path";
const content = readFileSync(process.argv[2], "utf-8");
if (content.includes("Write JSON only to this path:")) {
  const m = content.match(/Write JSON only to this path: (.+)/);
  const p = m[1].trim();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify({ verdict: "pass", summary: "full verifier ran", issues: [], humanGates: [], recommendedStatus: "passed", artifacts: [] }), "utf-8");
  process.exit(0);
}
writeFileSync("out.txt", "ok", "utf-8");
`);

    git(["add", "-A"], dir);
    git(["commit", "-m", "initial"], dir);

    const r = runCLI(dir, ["run", "--command", fakeCommand(agent), "--max-iterations", "1", "--no-merge", "--fast-verifier"]);
    assert(r.status === 0, `CLI exited ${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);

    const events = readEvents(dir);
    assert(hasEvent(events, "verifier_skip_denied"), "expected verifier_skip_denied for high-risk task");
    assert(!hasEvent(events, "verifier_skipped"), "verifier must NOT be skipped for a high-risk task");
    assert(hasEvent(events, "verifier_finished"), "expected verifier_finished (full verifier ran)");
  } finally {
    if (!keep) rmSync(dir, { recursive: true, force: true });
  }
});

// ── case 5: fast-verifier allowed for low-risk task ──────────────────────────

runCase("fast-verifier allowed: low-risk task skips verifier agent", () => {
  const dir = tmpRepo("fvallow");
  try {
    writeState(dir, baseState({ kind: "maintenance", scope: ["out.txt"] }));

    const agent = writeFakeAgent(dir, "fake-agent.mjs", `
import { readFileSync, writeFileSync } from "fs";
const content = readFileSync(process.argv[2], "utf-8");
if (content.includes("Write JSON only to this path:")) throw new Error("verifier agent must not be called for fast-verifier task");
writeFileSync("out.txt", "ok", "utf-8");
`);

    git(["add", "-A"], dir);
    git(["commit", "-m", "initial"], dir);

    const r = runCLI(dir, ["run", "--command", fakeCommand(agent), "--max-iterations", "1", "--no-merge", "--fast-verifier"]);
    assert(r.status === 0, `CLI exited ${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);

    const events = readEvents(dir);
    assert(hasEvent(events, "verifier_skipped"), "expected verifier_skipped event");
    assert(!hasEvent(events, "verifier_started"), "verifier agent must not start for fast-verifier task");
    const state = readState(dir);
    assert(state.tasks[0].status === "passed", `expected passed, got ${state.tasks[0].status}`);
  } finally {
    if (!keep) rmSync(dir, { recursive: true, force: true });
  }
});

// ── case 6: checks failure → retry → pass ────────────────────────────────────

runCase("checks retry: task retries after check failure, passes on second attempt", () => {
  const dir = tmpRepo("retry");
  try {
    writeState(dir, baseState({ validation: ["node -e \"if(!require('fs').existsSync('retry-output.txt'))process.exit(1)\""] }, { maxIterations: 3 }));

    const agent = writeFakeAgent(dir, "fake-agent.mjs", `
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { dirname } from "path";
const content = readFileSync(process.argv[2], "utf-8");
if (content.includes("Write JSON only to this path:")) {
  const m = content.match(/Write JSON only to this path: (.+)/);
  const p = m[1].trim();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify({ verdict: "pass", summary: "retry ok", issues: [], humanGates: [], recommendedStatus: "passed", artifacts: [] }), "utf-8");
  process.exit(0);
}
// Only write output on the second attempt (attempts=2 appears in task JSON)
if (content.includes('"attempts": 2') || content.includes('"attempts":2')) {
  writeFileSync("retry-output.txt", "ok", "utf-8");
}
`);

    git(["add", "-A"], dir);
    git(["commit", "-m", "initial"], dir);

    const r = runCLI(dir, ["run", "--command", fakeCommand(agent), "--max-iterations", "3", "--max-retries", "2", "--no-merge", "--no-decision-grill", "--no-post-task-review"], 90_000);
    assert(r.status === 0, `CLI exited ${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);

    const state = readState(dir);
    assert(state.tasks[0].status === "passed", `expected passed, got ${state.tasks[0].status}`);
    assert((state.tasks[0].attempts ?? 0) >= 2, `expected >=2 attempts, got ${state.tasks[0].attempts}`);
    const events = readEvents(dir);
    assert(hasEvent(events, "checks_failed"), "expected checks_failed event on first attempt");
    assert(hasEvent(events, "task_passed"), "expected task_passed on second attempt");
  } finally {
    if (!keep) rmSync(dir, { recursive: true, force: true });
  }
});

// ── case 7: verifier fail → retry budget exhausted → needs_human ─────────────

runCase("verifier fail: retry budget exhausted escalates to needs_human", () => {
  const dir = tmpRepo("vfail");
  try {
    writeState(dir, baseState({}, { maxIterations: 4 }));

    const agent = writeFakeAgent(dir, "fake-agent.mjs", `
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname } from "path";
const content = readFileSync(process.argv[2], "utf-8");
if (content.includes("Write JSON only to this path:")) {
  const m = content.match(/Write JSON only to this path: (.+)/);
  const p = m[1].trim();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify({ verdict: "fail", summary: "always fail", issues: [], humanGates: [], recommendedStatus: "needs_retry", artifacts: [] }), "utf-8");
  process.exit(0);
}
writeFileSync("output.txt", "done", "utf-8");
`);

    git(["add", "-A"], dir);
    git(["commit", "-m", "initial"], dir);

    // max-retries 1 means after 2 attempts (1 original + 1 retry) it escalates
    const r = runCLI(dir, ["run", "--command", fakeCommand(agent), "--max-iterations", "4", "--max-retries", "1", "--no-merge"], 90_000);
    assert(r.status !== 0, "expected non-zero exit when budget exhausted");
    const state = readState(dir);
    assert(state.tasks[0].status === "needs_human", `expected needs_human, got ${state.tasks[0].status}`);
    const events = readEvents(dir);
    assert(hasEvent(events, "verifier_finished"), "expected verifier_finished");
  } finally {
    if (!keep) rmSync(dir, { recursive: true, force: true });
  }
});

// ── case 7b: failure-analysis injected into task-grill on retry ──────────────
// Attempt 1: executor writes output.txt, checks fail (node exits 1).
// Harness writes failure-analysis.json and marks needs_retry.
// Attempt 2: task-grill prompt must contain "Prior attempt failure analysis".
// Executor writes output.txt again, checks pass, task passes.

runCase("failure-analysis: injected into task-grill on retry", () => {
  const dir = tmpRepo("failure-analysis");
  try {
    writeState(dir, baseState(
      { validation: ["node -e \"if(!require('fs').existsSync('output.txt'))process.exit(1)\""] },
      { maxIterations: 3 }
    ));

    // Track whether task-grill on attempt 2 received the failure analysis.
    // Write the fake agent directly (not via writeFakeAgent) so we own the task-grill handler.
    const grillLogFile = join(dir, "grill-saw-failure-analysis.txt");
    const agentPath = join(dir, "fake-agent.mjs");
    writeFileSync(agentPath, `
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname } from "path";
const content = readFileSync(process.argv[2], "utf-8");

if (content.includes("Write task-grill JSON only to:")) {
  const m = content.match(/Write task-grill JSON only to: (.+)/);
  if (!m) throw new Error("no task-grill result path");
  const resultPath = m[1].trim();
  mkdirSync(dirname(resultPath), { recursive: true });
  if (content.includes("Prior attempt failure analysis")) {
    writeFileSync(${JSON.stringify(grillLogFile)}, "yes", "utf-8");
  }
  writeFileSync(resultPath, JSON.stringify({
    verdict: "ready", understanding: "ok", evidence: [], assumptionsStillValid: [],
    assumptionsChanged: [], scopeDecision: { declaredScopeOk: true, requestedScopeChanges: [] },
    acceptanceProof: [], risks: [], executorInstructions: "proceed"
  }), "utf-8");
  process.exit(0);
}
if (content.includes("Write JSON only to this path:")) {
  const m = content.match(/Write JSON only to this path: (.+)/);
  const p = m[1].trim();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify({ verdict: "pass", summary: "ok", issues: [], humanGates: [], recommendedStatus: "passed", artifacts: [] }), "utf-8");
  process.exit(0);
}
// Executor: only write output.txt on attempt 2
if (content.includes('"attempts": 2') || content.includes('"attempts":2')) {
  writeFileSync("output.txt", "done", "utf-8");
}
`, "utf-8");
    const agent = agentPath;

    git(["add", "-A"], dir);
    git(["commit", "-m", "initial"], dir);

    const r = runCLI(dir, ["run", "--command", fakeCommand(agent), "--max-iterations", "3", "--max-retries", "2", "--no-merge", "--no-decision-grill", "--no-post-task-review"], 90_000);
    assert(r.status === 0, `CLI exited ${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);

    const state = readState(dir);
    assert(state.tasks[0].status === "passed", `expected passed, got ${state.tasks[0].status}`);
    assert(existsSync(grillLogFile), "task-grill on retry must have received prior failure analysis block");
    const events = readEvents(dir);
    assert(hasEvent(events, "checks_failed"), "expected checks_failed on first attempt");
    assert(hasEvent(events, "task_passed"), "expected task_passed on second attempt");
  } finally {
    if (!keep) rmSync(dir, { recursive: true, force: true });
  }
});

// ── case 8: replan budget exhaustion ─────────────────────────────────────────
// Agent: task-grill always returns needs_replan; planner always writes a new unique task
// so convergence detection doesn't fire. Budget guard fires on replan #2 when maxReplans=1.

runCase("replan budget: exhausted after maxReplans, task escalates to needs_human", () => {
  const dir = tmpRepo("replan-budget");
  try {
    writeState(dir, baseState({ title: "Needs replan", scope: ["stale.txt"] }, { maxIterations: 5 }));

    // This fake agent handles task-grill (via writeFakeAgent "Needs replan" title),
    // planner (writes a fresh unique task each time), and never reaches executor/verifier.
    const agentBody = `
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { dirname } from "path";
const promptFile = process.argv[2];
const content = readFileSync(promptFile, "utf-8");
if (content.includes("Write planner JSON only to:")) {
  const m = content.match(/Write planner JSON only to: (.+)/);
  if (!m) throw new Error("no planner result path");
  const resultPath = m[1].trim();
  mkdirSync(dirname(resultPath), { recursive: true });
  // Count previous planner results to generate a unique task id each call
  const runDir = dirname(resultPath);
  const countFile = resultPath + ".count";
  let n = existsSync(countFile) ? parseInt(readFileSync(countFile, "utf-8")) + 1 : 1;
  writeFileSync(countFile, String(n), "utf-8");
  writeFileSync(resultPath, JSON.stringify({
    verdict: "planned",
    summary: "replan " + n,
    decisions: [], assumptions: [], openQuestions: [], blockers: [], artifacts: [],
    tasks: [{
      id: "task-replan-" + n,
      title: "Needs replan",
      kind: "maintenance",
      workflow: "tdd",
      status: "pending",
      priority: 1,
      acceptanceCriteria: ["stale.txt exists"],
      validation: [],
      dependsOn: [],
      failureHistory: [],
      artifacts: [],
      scope: ["stale.txt"]
    }]
  }), "utf-8");
  const grillMatch = content.match(/Also write an autonomous grill transcript markdown file to: (.+)/);
  if (grillMatch) {
    const gp = grillMatch[1].trim();
    mkdirSync(dirname(gp), { recursive: true });
    writeFileSync(gp, "# Grill\\nReplanned.", "utf-8");
  }
  process.exit(0);
}
throw new Error("executor/verifier must not run in replan-budget test");
`;

    const agent = writeFakeAgent(dir, "fake-agent.mjs", agentBody);

    git(["add", "-A"], dir);
    git(["commit", "-m", "initial"], dir);

    // maxReplans=1: first replan (sessionReplanCount=1) is allowed, second (count=2) triggers budget exhaustion
    const r = runCLI(dir, ["run", "--command", fakeCommand(agent), "--max-iterations", "5", "--max-replans", "1", "--no-merge"], 90_000);
    assert(r.status !== 0, "expected non-zero exit when replan budget exhausted");
    const events = readEvents(dir);
    assert(hasEvent(events, "replan_budget_exhausted"), "expected replan_budget_exhausted event");
  } finally {
    if (!keep) rmSync(dir, { recursive: true, force: true });
  }
});

// ── case 9: replan convergence detection ──────────────────────────────────────
// Agent: task-grill always returns needs_replan; planner always produces the same task IDs.
// Convergence detection fires on the second replan (same pending task set as before).

runCase("replan convergence: identical plan detected, loop stops", () => {
  const dir = tmpRepo("replan-conv");
  try {
    writeState(dir, baseState({ title: "Needs replan", scope: ["stale.txt"] }, { maxIterations: 5 }));

    const agentBody = `
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname } from "path";
const promptFile = process.argv[2];
const content = readFileSync(promptFile, "utf-8");
if (content.includes("Write planner JSON only to:")) {
  const m = content.match(/Write planner JSON only to: (.+)/);
  if (!m) throw new Error("no planner result path");
  const resultPath = m[1].trim();
  mkdirSync(dirname(resultPath), { recursive: true });
  writeFileSync(resultPath, JSON.stringify({
    verdict: "planned",
    summary: "same plan again",
    decisions: [], assumptions: [], openQuestions: [], blockers: [], artifacts: [],
    tasks: [{
      id: "task-001",
      title: "Needs replan",
      kind: "maintenance",
      workflow: "tdd",
      status: "pending",
      priority: 1,
      acceptanceCriteria: ["stale.txt exists"],
      validation: [],
      dependsOn: [],
      failureHistory: [],
      artifacts: [],
      scope: ["stale.txt"]
    }]
  }), "utf-8");
  const grillMatch = content.match(/Also write an autonomous grill transcript markdown file to: (.+)/);
  if (grillMatch) {
    const gp = grillMatch[1].trim();
    mkdirSync(dirname(gp), { recursive: true });
    writeFileSync(gp, "# Grill\\nSame plan.", "utf-8");
  }
  process.exit(0);
}
throw new Error("executor/verifier must not run when convergence detected");
`;

    const agent = writeFakeAgent(dir, "fake-agent.mjs", agentBody);

    git(["add", "-A"], dir);
    git(["commit", "-m", "initial"], dir);

    // maxReplans=5 so budget won't fire first; convergence fires when plan is identical
    const r = runCLI(dir, ["run", "--command", fakeCommand(agent), "--max-iterations", "5", "--max-replans", "5", "--no-merge"], 90_000);
    assert(r.status !== 0, "expected non-zero exit on convergence failure");
    const events = readEvents(dir);
    assert(hasEvent(events, "replan_convergence_failure"), "expected replan_convergence_failure event");
  } finally {
    if (!keep) rmSync(dir, { recursive: true, force: true });
  }
});

// ── case 10: assumption ledger — grill results persisted to state.assumptions ──
// Task-grill writes assumptionsStillValid and assumptionsChanged.
// After the loop, state.assumptions must contain both tagged entries.

runCase("assumption ledger: grill assumptionsStillValid/Changed persisted to state", () => {
  const dir = tmpRepo("assumptions");
  try {
    writeState(dir, baseState());

    const agentPath = join(dir, "fake-agent.mjs");
    writeFileSync(agentPath, `
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname } from "path";
const content = readFileSync(process.argv[2], "utf-8");

if (content.includes("Write task-grill JSON only to:")) {
  const m = content.match(/Write task-grill JSON only to: (.+)/);
  if (!m) throw new Error("no task-grill result path");
  const resultPath = m[1].trim();
  mkdirSync(dirname(resultPath), { recursive: true });
  writeFileSync(resultPath, JSON.stringify({
    verdict: "ready",
    understanding: "Task understood.",
    evidence: ["task JSON"],
    assumptionsStillValid: ["repo uses npm workspaces"],
    assumptionsChanged: ["output path changed from dist/ to build/"],
    scopeDecision: { declaredScopeOk: true, requestedScopeChanges: [] },
    acceptanceProof: ["checks pass"],
    risks: [],
    executorInstructions: "proceed"
  }), "utf-8");
  process.exit(0);
}
if (content.includes("Write JSON only to this path:")) {
  const m = content.match(/Write JSON only to this path: (.+)/);
  const p = m[1].trim();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify({ verdict: "pass", summary: "ok", issues: [], humanGates: [], recommendedStatus: "passed", artifacts: [] }), "utf-8");
  process.exit(0);
}
writeFileSync("output.txt", "done", "utf-8");
`, "utf-8");

    git(["add", "-A"], dir);
    git(["commit", "-m", "initial"], dir);

    const r = runCLI(dir, ["run", "--command", fakeCommand(agentPath), "--max-iterations", "1", "--no-merge", "--no-decision-grill", "--no-post-task-review"]);
    assert(r.status === 0, `CLI exited ${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);

    const state = readState(dir);
    assert(state.tasks[0].status === "passed", `expected passed, got ${state.tasks[0].status}`);
    const assumptions: string[] = state.assumptions ?? [];
    assert(
      assumptions.some((a: string) => a.startsWith("[valid]") && a.includes("npm workspaces")),
      `expected [valid] assumption, got: ${JSON.stringify(assumptions)}`
    );
    assert(
      assumptions.some((a: string) => a.startsWith("[changed]") && a.includes("output path")),
      `expected [changed] assumption, got: ${JSON.stringify(assumptions)}`
    );
    const events = readEvents(dir);
    assert(hasEvent(events, "assumptions_updated"), "expected assumptions_updated event");
  } finally {
    if (!keep) rmSync(dir, { recursive: true, force: true });
  }
});

// ── case 11: goal review pass ─────────────────────────────────────────────────
// Task passes normally. Goal review agent writes { verdict: "pass" }.
// Loop should emit goal_review_finished and exit 0.

runCase("goal review: pass verdict allows loop to complete", () => {
  const dir = tmpRepo("goal-review-pass");
  try {
    writeState(dir, baseState());

    const agentPath = join(dir, "fake-agent.mjs");
    writeFileSync(agentPath, `
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname } from "path";
const content = readFileSync(process.argv[2], "utf-8");

if (content.includes("Write task-grill JSON only to:")) {
  const m = content.match(/Write task-grill JSON only to: (.+)/);
  const p = m[1].trim();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify({
    verdict: "ready", understanding: "ok", evidence: [], assumptionsStillValid: [],
    assumptionsChanged: [], scopeDecision: { declaredScopeOk: true, requestedScopeChanges: [] },
    acceptanceProof: [], risks: [], executorInstructions: "proceed"
  }), "utf-8");
  process.exit(0);
}
if (content.includes("Write your verdict JSON only to:")) {
  const m = content.match(/Write your verdict JSON only to: (.+)/);
  const p = m[1].trim();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify({ verdict: "pass", summary: "goal achieved", gaps: [] }), "utf-8");
  process.exit(0);
}
if (content.includes("Write JSON only to this path:")) {
  const m = content.match(/Write JSON only to this path: (.+)/);
  const p = m[1].trim();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify({ verdict: "pass", summary: "ok", issues: [], humanGates: [], recommendedStatus: "passed", artifacts: [] }), "utf-8");
  process.exit(0);
}
writeFileSync("output.txt", "done", "utf-8");
`, "utf-8");

    git(["add", "-A"], dir);
    git(["commit", "-m", "initial"], dir);

    const r = runCLI(dir, ["run", "--command", fakeCommand(agentPath), "--max-iterations", "1", "--no-merge", "--goal-review", "--no-decision-grill", "--no-post-task-review"]);
    assert(r.status === 0, `CLI exited ${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
    const events = readEvents(dir);
    assert(hasEvent(events, "goal_review_started"), "expected goal_review_started event");
    assert(hasEvent(events, "goal_review_finished"), "expected goal_review_finished event");
    const ev = events.find((e: any) => e.type === "goal_review_finished");
    assert(ev?.verdict === "pass", `expected goal_review verdict=pass, got ${ev?.verdict}`);
    assert(hasEvent(events, "task_passed"), "expected task_passed");
  } finally {
    if (!keep) rmSync(dir, { recursive: true, force: true });
  }
});

// ── case 12: goal review needs_human ─────────────────────────────────────────
// Task passes. Goal review agent returns needs_human.
// Loop should emit goal_review_finished and exit non-zero.

runCase("goal review: needs_human verdict halts loop", () => {
  const dir = tmpRepo("goal-review-nh");
  try {
    writeState(dir, baseState());

    const agentPath = join(dir, "fake-agent.mjs");
    writeFileSync(agentPath, `
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname } from "path";
const content = readFileSync(process.argv[2], "utf-8");

if (content.includes("Write task-grill JSON only to:")) {
  const m = content.match(/Write task-grill JSON only to: (.+)/);
  const p = m[1].trim();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify({
    verdict: "ready", understanding: "ok", evidence: [], assumptionsStillValid: [],
    assumptionsChanged: [], scopeDecision: { declaredScopeOk: true, requestedScopeChanges: [] },
    acceptanceProof: [], risks: [], executorInstructions: "proceed"
  }), "utf-8");
  process.exit(0);
}
if (content.includes("Write your verdict JSON only to:")) {
  const m = content.match(/Write your verdict JSON only to: (.+)/);
  const p = m[1].trim();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify({ verdict: "needs_human", summary: "goal not met", gaps: ["missing feature X"] }), "utf-8");
  process.exit(0);
}
if (content.includes("Write JSON only to this path:")) {
  const m = content.match(/Write JSON only to this path: (.+)/);
  const p = m[1].trim();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify({ verdict: "pass", summary: "ok", issues: [], humanGates: [], recommendedStatus: "passed", artifacts: [] }), "utf-8");
  process.exit(0);
}
writeFileSync("output.txt", "done", "utf-8");
`, "utf-8");

    git(["add", "-A"], dir);
    git(["commit", "-m", "initial"], dir);

    const r = runCLI(dir, ["run", "--command", fakeCommand(agentPath), "--max-iterations", "1", "--no-merge", "--goal-review", "--no-decision-grill", "--no-post-task-review"]);
    assert(r.status !== 0, "expected non-zero exit when goal review returns needs_human");
    const events = readEvents(dir);
    assert(hasEvent(events, "goal_review_finished"), "expected goal_review_finished event");
    const ev = events.find((e: any) => e.type === "goal_review_finished");
    assert(ev?.verdict === "needs_human", `expected verdict=needs_human, got ${ev?.verdict}`);
  } finally {
    if (!keep) rmSync(dir, { recursive: true, force: true });
  }
});

// ── case 13: architect checkpoint continue ─────────────────────────────────────
// Two tasks pass. Architect checkpoint interval=2. Checkpoint fires after task 2.
// Agent returns continue. Loop completes normally.

runCase("architect checkpoint: fires after N tasks, continue verdict proceeds", () => {
  const dir = tmpRepo("arch-checkpoint");
  try {
    writeState(dir, {
      version: 1,
      goal: "Smoke goal",
      maxIterations: 5,
      checks: [],
      defaultDiscoveryWorkflow: "grill-with-docs",
      tasks: [
        baseTask({ id: "task-001", title: "First task",  priority: 1, scope: ["out1.txt"] }),
        baseTask({ id: "task-002", title: "Second task", priority: 2, scope: ["out2.txt"] }),
      ],
      decisions: [], assumptions: [], openQuestions: [], blockers: [],
      promptPolicy: { lessons: [] },
    });

    const agentPath = join(dir, "fake-agent.mjs");
    writeFileSync(agentPath, `
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname } from "path";
const content = readFileSync(process.argv[2], "utf-8");

if (content.includes("Write task-grill JSON only to:")) {
  const m = content.match(/Write task-grill JSON only to: (.+)/);
  const p = m[1].trim();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify({
    verdict: "ready", understanding: "ok", evidence: [], assumptionsStillValid: [],
    assumptionsChanged: [], scopeDecision: { declaredScopeOk: true, requestedScopeChanges: [] },
    acceptanceProof: [], risks: [], executorInstructions: "proceed"
  }), "utf-8");
  process.exit(0);
}
if (content.includes("Write your verdict JSON only to:")) {
  const m = content.match(/Write your verdict JSON only to: (.+)/);
  const p = m[1].trim();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify({ verdict: "continue", assessment: "plan on track", suggestedChanges: [] }), "utf-8");
  process.exit(0);
}
if (content.includes("Write JSON only to this path:")) {
  const m = content.match(/Write JSON only to this path: (.+)/);
  const p = m[1].trim();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify({ verdict: "pass", summary: "ok", issues: [], humanGates: [], recommendedStatus: "passed", artifacts: [] }), "utf-8");
  process.exit(0);
}
if (content.includes('"id": "task-001"')) writeFileSync("out1.txt", "done", "utf-8");
else if (content.includes('"id": "task-002"')) writeFileSync("out2.txt", "done", "utf-8");
`, "utf-8");

    git(["add", "-A"], dir);
    git(["commit", "-m", "initial"], dir);

    const r = runCLI(dir, ["run", "--command", fakeCommand(agentPath), "--max-iterations", "5", "--no-merge", "--architect-checkpoint-interval", "2", "--no-decision-grill", "--no-post-task-review"], 120_000);
    assert(r.status === 0, `CLI exited ${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
    const state = readState(dir);
    assert(state.tasks.every((t: any) => t.status === "passed"), `not all tasks passed: ${JSON.stringify(state.tasks.map((t: any) => t.status))}`);
    const events = readEvents(dir);
    assert(hasEvent(events, "architect_checkpoint_started"), "expected architect_checkpoint_started event");
    assert(hasEvent(events, "architect_checkpoint_finished"), "expected architect_checkpoint_finished event");
    const ev = events.find((e: any) => e.type === "architect_checkpoint_finished");
    assert(ev?.verdict === "continue", `expected verdict=continue, got ${ev?.verdict}`);
  } finally {
    if (!keep) rmSync(dir, { recursive: true, force: true });
  }
});

// ── case 14: architect checkpoint replan ──────────────────────────────────────
// Two tasks pass. Architect checkpoint interval=2. Agent returns replan.
// Planner creates a new task. Loop completes with the new task passing.

runCase("architect checkpoint: replan verdict calls planner and continues", () => {
  const dir = tmpRepo("arch-replan");
  try {
    writeState(dir, {
      version: 1, goal: "Smoke goal", maxIterations: 8, checks: [],
      defaultDiscoveryWorkflow: "grill-with-docs",
      tasks: [
        baseTask({ id: "task-001", title: "First task",  priority: 1, scope: ["out1.txt"] }),
        baseTask({ id: "task-002", title: "Second task", priority: 2, scope: ["out2.txt"] }),
      ],
      decisions: [], assumptions: [], openQuestions: [], blockers: [],
      promptPolicy: { lessons: [] },
    });

    const agentPath = join(dir, "fake-agent.mjs");
    writeFileSync(agentPath, `
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { dirname } from "path";
const content = readFileSync(process.argv[2], "utf-8");

if (content.includes("Write task-grill JSON only to:")) {
  const m = content.match(/Write task-grill JSON only to: (.+)/);
  const p = m[1].trim();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify({
    verdict: "ready", understanding: "ok", evidence: [], assumptionsStillValid: [],
    assumptionsChanged: [], scopeDecision: { declaredScopeOk: true, requestedScopeChanges: [] },
    acceptanceProof: [], risks: [], executorInstructions: "proceed"
  }), "utf-8");
  process.exit(0);
}

// Architect checkpoint: first call returns replan, second (after new task) returns continue.
if (content.includes("Write your verdict JSON only to:") && content.includes("task-003")) {
  const m = content.match(/Write your verdict JSON only to: (.+)/);
  const p = m[1].trim();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify({ verdict: "continue", assessment: "new task added, on track", suggestedChanges: [] }), "utf-8");
  process.exit(0);
}
if (content.includes("Write your verdict JSON only to:")) {
  const m = content.match(/Write your verdict JSON only to: (.+)/);
  const p = m[1].trim();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify({ verdict: "replan", assessment: "missed a task", suggestedChanges: ["add task-003"] }), "utf-8");
  process.exit(0);
}

if (content.includes("Write planner JSON only to:")) {
  const pm = content.match(/Write planner JSON only to: (.+)/);
  const pp = pm[1].trim();
  mkdirSync(dirname(pp), { recursive: true });
  writeFileSync(pp, JSON.stringify({
    verdict: "planned", summary: "added missing task", decisions: [], assumptions: [],
    openQuestions: [], blockers: [], artifacts: [],
    tasks: [{
      id: "task-003", title: "Extra task", kind: "maintenance", workflow: "tdd",
      status: "pending", priority: 3,
      acceptanceCriteria: ["out3.txt exists"], validation: [],
      dependsOn: [], failureHistory: [], artifacts: [], scope: ["out3.txt"]
    }]
  }), "utf-8");
  const gm = content.match(/Also write an autonomous grill transcript markdown file to: (.+)/);
  if (gm) { mkdirSync(dirname(gm[1].trim()), { recursive: true }); writeFileSync(gm[1].trim(), "# Grill\\nok.", "utf-8"); }
  process.exit(0);
}

if (content.includes("Write JSON only to this path:")) {
  const m = content.match(/Write JSON only to this path: (.+)/);
  const p = m[1].trim();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify({ verdict: "pass", summary: "ok", issues: [], humanGates: [], recommendedStatus: "passed", artifacts: [] }), "utf-8");
  process.exit(0);
}
if (content.includes('"id": "task-001"')) writeFileSync("out1.txt", "done", "utf-8");
else if (content.includes('"id": "task-002"')) writeFileSync("out2.txt", "done", "utf-8");
else if (content.includes('"id": "task-003"')) writeFileSync("out3.txt", "done", "utf-8");
`, "utf-8");

    git(["add", "-A"], dir);
    git(["commit", "-m", "initial"], dir);

    const r = runCLI(dir, ["run", "--command", fakeCommand(agentPath), "--max-iterations", "8", "--no-merge", "--architect-checkpoint-interval", "2", "--no-decision-grill", "--no-post-task-review"], 180_000);
    assert(r.status === 0, `CLI exited ${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
    const state = readState(dir);
    const task3 = state.tasks.find((t: any) => t.id === "task-003");
    assert(task3?.status === "passed", `expected task-003 passed, got ${task3?.status}`);
    const events = readEvents(dir);
    assert(hasEvent(events, "architect_checkpoint_replan"), "expected architect_checkpoint_replan event");
    assert(hasEvent(events, "planner_finished"), "expected planner_finished after architect replan");
  } finally {
    if (!keep) rmSync(dir, { recursive: true, force: true });
  }
});

// ── case 15: planner phase from empty task list ───────────────────────────────
// agentic.json starts with no tasks. Loop runs planner, then executes the planned task.

runCase("planner from empty state: plans then executes", () => {
  const dir = tmpRepo("plan-from-empty");
  try {
    writeState(dir, {
      version: 1, goal: "Smoke goal", maxIterations: 3, checks: [],
      defaultDiscoveryWorkflow: "grill-with-docs",
      tasks: [],
      decisions: [], assumptions: [], openQuestions: [], blockers: [],
      promptPolicy: { lessons: [] },
    });

    const agentPath = join(dir, "fake-agent.mjs");
    writeFileSync(agentPath, `
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname } from "path";
const content = readFileSync(process.argv[2], "utf-8");

if (content.includes("Write planner JSON only to:")) {
  const pm = content.match(/Write planner JSON only to: (.+)/);
  const pp = pm[1].trim();
  mkdirSync(dirname(pp), { recursive: true });
  writeFileSync(pp, JSON.stringify({
    verdict: "planned", summary: "initial plan", decisions: [], assumptions: [],
    openQuestions: [], blockers: [], artifacts: [],
    tasks: [{
      id: "task-001", title: "Planned task", kind: "maintenance", workflow: "tdd",
      status: "pending", priority: 1,
      acceptanceCriteria: ["output.txt exists"], validation: [],
      dependsOn: [], failureHistory: [], artifacts: [], scope: ["output.txt"]
    }]
  }), "utf-8");
  const gm = content.match(/Also write an autonomous grill transcript markdown file to: (.+)/);
  if (gm) { mkdirSync(dirname(gm[1].trim()), { recursive: true }); writeFileSync(gm[1].trim(), "# Grill\\nPlanned.", "utf-8"); }
  process.exit(0);
}
if (content.includes("Write task-grill JSON only to:")) {
  const m = content.match(/Write task-grill JSON only to: (.+)/);
  const p = m[1].trim();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify({
    verdict: "ready", understanding: "ok", evidence: [], assumptionsStillValid: [],
    assumptionsChanged: [], scopeDecision: { declaredScopeOk: true, requestedScopeChanges: [] },
    acceptanceProof: [], risks: [], executorInstructions: "proceed"
  }), "utf-8");
  process.exit(0);
}
if (content.includes("Write JSON only to this path:")) {
  const m = content.match(/Write JSON only to this path: (.+)/);
  const p = m[1].trim();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify({ verdict: "pass", summary: "ok", issues: [], humanGates: [], recommendedStatus: "passed", artifacts: [] }), "utf-8");
  process.exit(0);
}
writeFileSync("output.txt", "done", "utf-8");
`, "utf-8");

    git(["add", "-A"], dir);
    git(["commit", "-m", "initial"], dir);

    const r = runCLI(dir, ["run", "--command", fakeCommand(agentPath), "--max-iterations", "3", "--no-merge", "--no-decision-grill", "--no-post-task-review"], 90_000);
    assert(r.status === 0, `CLI exited ${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
    const state = readState(dir);
    assert(state.tasks.length > 0, "expected tasks to be planned");
    assert(state.tasks[0].status === "passed", `expected task passed, got ${state.tasks[0].status}`);
    const events = readEvents(dir);
    assert(hasEvent(events, "planner_finished"), "expected planner_finished from initial planning");
    assert(hasEvent(events, "task_passed"), "expected task_passed after planning");
  } finally {
    if (!keep) rmSync(dir, { recursive: true, force: true });
  }
});

// ── case 16: decision grill — rich decision answered and recorded ─────────────
// --decision-grill on. The decision-grill agent writes a well-formed decision
// (2 options, one recommended, high confidence). It must be recorded to
// state.decisions and the task must pass.

runCase("decision grill: rich self-answered decision recorded, task passes", () => {
  const dir = tmpRepo("decision-rich");
  try {
    writeState(dir, baseState({ scope: ["output.txt"] }));

    const agentPath = join(dir, "fake-agent.mjs");
    writeFileSync(agentPath, `
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname } from "path";
const content = readFileSync(process.argv[2], "utf-8");

if (content.includes("Write task-grill JSON only to:")) {
  const m = content.match(/Write task-grill JSON only to: (.+)/);
  const p = m[1].trim();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify({
    verdict: "ready", understanding: "ok", evidence: [], assumptionsStillValid: [],
    assumptionsChanged: [], scopeDecision: { declaredScopeOk: true, requestedScopeChanges: [] },
    acceptanceProof: [], risks: [], executorInstructions: "proceed"
  }), "utf-8");
  process.exit(0);
}
if (content.includes("Write decision JSON only to:")) {
  const m = content.match(/Write decision JSON only to: (.+)/);
  const p = m[1].trim();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify({ decisions: [{
    question: "Reuse existing writer or add a new one?",
    whyItMatters: "Affects coupling and future maintenance.",
    optionsConsidered: [
      { label: "Reuse existing writer", evidence: "src already exports writeFile helper", recommended: true },
      { label: "Add a new writer module", evidence: "no existing helper found in scope", recommended: false }
    ],
    chosen: "Reuse existing writer",
    selfAnswer: "Evidence shows a helper already exists; no human needed.",
    confidence: "high",
    escalate: false
  }] }), "utf-8");
  process.exit(0);
}
if (content.includes("Write JSON only to this path:")) {
  const m = content.match(/Write JSON only to this path: (.+)/);
  const p = m[1].trim();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify({ verdict: "pass", summary: "ok", issues: [], humanGates: [], recommendedStatus: "passed", artifacts: [] }), "utf-8");
  process.exit(0);
}
writeFileSync("output.txt", "done", "utf-8");
`, "utf-8");

    git(["add", "-A"], dir);
    git(["commit", "-m", "initial"], dir);

    const r = runCLI(dir, ["run", "--command", fakeCommand(agentPath), "--max-iterations", "1", "--no-merge", "--decision-grill", "--no-post-task-review"]);
    assert(r.status === 0, `CLI exited ${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
    const state = readState(dir);
    assert(state.tasks[0].status === "passed", `expected passed, got ${state.tasks[0].status}`);
    const decisions: string[] = state.decisions ?? [];
    assert(
      decisions.some((d) => d.includes("Reuse existing writer") && d.includes("confidence: high")),
      `expected recorded decision, got: ${JSON.stringify(decisions)}`
    );
    const events = readEvents(dir);
    assert(hasEvent(events, "decision_grill_finished"), "expected decision_grill_finished event");
    assert(hasEvent(events, "decisions_recorded"), "expected decisions_recorded event");
    const ev = events.find((e: any) => e.type === "decision_grill_finished");
    assert(ev?.verdict === "answered", `expected verdict=answered, got ${ev?.verdict}`);
    assert(!hasEvent(events, "decision_grill_regrill"), "well-formed decision must not trigger a re-grill");
  } finally {
    if (!keep) rmSync(dir, { recursive: true, force: true });
  }
});

// ── case 17: decision grill — shallow decision re-grilled, then escalates ─────
// First decision pass is shallow (1 option). Harness re-grills once. The second
// pass is also shallow. The loop must escalate the task to needs_human.

runCase("decision grill: shallow decision re-grilled once then escalates", () => {
  const dir = tmpRepo("decision-shallow");
  try {
    writeState(dir, baseState({ scope: ["output.txt"] }));

    const agentPath = join(dir, "fake-agent.mjs");
    writeFileSync(agentPath, `
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname } from "path";
const content = readFileSync(process.argv[2], "utf-8");

if (content.includes("Write task-grill JSON only to:")) {
  const m = content.match(/Write task-grill JSON only to: (.+)/);
  const p = m[1].trim();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify({
    verdict: "ready", understanding: "ok", evidence: [], assumptionsStillValid: [],
    assumptionsChanged: [], scopeDecision: { declaredScopeOk: true, requestedScopeChanges: [] },
    acceptanceProof: [], risks: [], executorInstructions: "proceed"
  }), "utf-8");
  process.exit(0);
}
if (content.includes("Write decision JSON only to:")) {
  const m = content.match(/Write decision JSON only to: (.+)/);
  const p = m[1].trim();
  mkdirSync(dirname(p), { recursive: true });
  // Always shallow: only one option, so validateDecisions rejects both passes.
  writeFileSync(p, JSON.stringify({ decisions: [{
    question: "Which approach?",
    whyItMatters: "It matters.",
    optionsConsidered: [{ label: "the only one", evidence: "gut feeling", recommended: true }],
    chosen: "the only one",
    selfAnswer: "picked it",
    confidence: "high",
    escalate: false
  }] }), "utf-8");
  process.exit(0);
}
throw new Error("executor/verifier must not run after decision-grill escalation");
`, "utf-8");

    git(["add", "-A"], dir);
    git(["commit", "-m", "initial"], dir);

    const r = runCLI(dir, ["run", "--command", fakeCommand(agentPath), "--max-iterations", "1", "--no-merge", "--decision-grill", "--no-post-task-review"], 90_000);
    assert(r.status !== 0, "expected non-zero exit when decision grill escalates");
    const state = readState(dir);
    assert(state.tasks[0].status === "needs_human", `expected needs_human, got ${state.tasks[0].status}`);
    const events = readEvents(dir);
    assert(hasEvent(events, "decision_grill_regrill"), "expected a re-grill on the shallow decision");
    const ev = events.find((e: any) => e.type === "decision_grill_finished");
    assert(ev?.verdict === "needs_human", `expected verdict=needs_human, got ${ev?.verdict}`);
    assert(!hasEvent(events, "executor_started"), "executor must not start after decision-grill escalation");
  } finally {
    if (!keep) rmSync(dir, { recursive: true, force: true });
  }
});

// ── case 18: decision grill — low-confidence re-grilled, then answered ────────
// First pass: well-formed but low confidence (no escalate) → harness re-grills.
// Second pass: same shape but high confidence → answered, task passes.

runCase("decision grill: low-confidence re-grilled then answered on second pass", () => {
  const dir = tmpRepo("decision-lowconf");
  try {
    writeState(dir, baseState({ scope: ["output.txt"] }));

    const agentPath = join(dir, "fake-agent.mjs");
    writeFileSync(agentPath, `
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname } from "path";
const content = readFileSync(process.argv[2], "utf-8");

if (content.includes("Write task-grill JSON only to:")) {
  const m = content.match(/Write task-grill JSON only to: (.+)/);
  const p = m[1].trim();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify({
    verdict: "ready", understanding: "ok", evidence: [], assumptionsStillValid: [],
    assumptionsChanged: [], scopeDecision: { declaredScopeOk: true, requestedScopeChanges: [] },
    acceptanceProof: [], risks: [], executorInstructions: "proceed"
  }), "utf-8");
  process.exit(0);
}
if (content.includes("Write decision JSON only to:")) {
  const m = content.match(/Write decision JSON only to: (.+)/);
  const p = m[1].trim();
  mkdirSync(dirname(p), { recursive: true });
  // The re-grill prompt carries the RE-GRILL banner; use it to switch to high confidence.
  const isReGrill = content.includes("RE-GRILL:");
  writeFileSync(p, JSON.stringify({ decisions: [{
    question: "Which storage format?",
    whyItMatters: "Affects downstream parsing.",
    optionsConsidered: [
      { label: "JSON", evidence: "existing files use JSON", recommended: true },
      { label: "YAML", evidence: "no YAML parser in repo", recommended: false }
    ],
    chosen: "JSON",
    selfAnswer: isReGrill ? "Confirmed by inspecting existing files." : "Leaning JSON but unsure.",
    confidence: isReGrill ? "high" : "low",
    escalate: false
  }] }), "utf-8");
  process.exit(0);
}
if (content.includes("Write JSON only to this path:")) {
  const m = content.match(/Write JSON only to this path: (.+)/);
  const p = m[1].trim();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify({ verdict: "pass", summary: "ok", issues: [], humanGates: [], recommendedStatus: "passed", artifacts: [] }), "utf-8");
  process.exit(0);
}
writeFileSync("output.txt", "done", "utf-8");
`, "utf-8");

    git(["add", "-A"], dir);
    git(["commit", "-m", "initial"], dir);

    const r = runCLI(dir, ["run", "--command", fakeCommand(agentPath), "--max-iterations", "1", "--no-merge", "--decision-grill", "--no-post-task-review"], 90_000);
    assert(r.status === 0, `CLI exited ${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
    const state = readState(dir);
    assert(state.tasks[0].status === "passed", `expected passed, got ${state.tasks[0].status}`);
    const events = readEvents(dir);
    assert(hasEvent(events, "decision_grill_regrill"), "expected a re-grill on the low-confidence decision");
    const ev = events.find((e: any) => e.type === "decision_grill_finished");
    assert(ev?.verdict === "answered", `expected verdict=answered after re-grill, got ${ev?.verdict}`);
    const decisions: string[] = state.decisions ?? [];
    assert(decisions.some((d) => d.includes("JSON") && d.includes("confidence: high")), `expected high-confidence decision recorded, got: ${JSON.stringify(decisions)}`);
  } finally {
    if (!keep) rmSync(dir, { recursive: true, force: true });
  }
});

// ── case 19: post-task review adjust_remaining_tasks ─────────────────────────
// Same code path as replan but verdict is "adjust_remaining_tasks" and the
// emitted phase is "post_task_adjustment". The stale remaining task must be
// blocked and a replacement task must run and pass.

runCase("post-task review: adjust_remaining_tasks blocks stale task and replans", () => {
  const dir = tmpRepo("post-task-adjust");
  try {
    writeState(dir, baseState(
      { title: "First task", scope: ["output.txt"], priority: 1 },
      {
        maxIterations: 4,
        tasks: [
          baseTask({ id: "task-001", title: "First task", scope: ["output.txt"], priority: 1 }),
          baseTask({ id: "task-002", title: "Stale adjustment task", scope: ["stale.txt"], priority: 2, dependsOn: ["task-001"] }),
        ],
      }
    ));

    // Override post-task review to return adjust_remaining_tasks for the first task.
    const agentPath = join(dir, "fake-agent.mjs");
    writeFileSync(agentPath, `
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname } from "path";
const content = readFileSync(process.argv[2], "utf-8");

if (content.includes("Write task-grill JSON only to:")) {
  const m = content.match(/Write task-grill JSON only to: (.+)/);
  const p = m[1].trim();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify({
    verdict: "ready", understanding: "ok", evidence: [], assumptionsStillValid: [],
    assumptionsChanged: [], scopeDecision: { declaredScopeOk: true, requestedScopeChanges: [] },
    acceptanceProof: [], risks: [], executorInstructions: "proceed"
  }), "utf-8");
  process.exit(0);
}
if (content.includes("Write decision JSON only to:")) {
  const m = content.match(/Write decision JSON only to: (.+)/);
  const p = m[1].trim();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify({ decisions: [] }), "utf-8");
  process.exit(0);
}
if (content.includes("Write post-task review JSON only to:")) {
  const m = content.match(/Write post-task review JSON only to: (.+)/);
  const p = m[1].trim();
  mkdirSync(dirname(p), { recursive: true });
  // Only trigger adjust on the first task; return continue for subsequent reviews.
  if (content.includes('"id": "task-001"') || content.includes('"task": "task-001"')) {
    writeFileSync(p, JSON.stringify({
      verdict: "adjust_remaining_tasks",
      assessment: "scope of remaining tasks needs narrowing",
      remainingPlanStillValid: false,
      suggestedChanges: ["replace stale task-002 with narrower task"]
    }), "utf-8");
  } else {
    writeFileSync(p, JSON.stringify({
      verdict: "continue",
      assessment: "adjusted plan still valid",
      remainingPlanStillValid: true,
      suggestedChanges: []
    }), "utf-8");
  }
  process.exit(0);
}
if (content.includes("Write planner JSON only to:")) {
  const m = content.match(/Write planner JSON only to: (.+)/);
  const pp = m[1].trim();
  mkdirSync(dirname(pp), { recursive: true });
  writeFileSync(pp, JSON.stringify({
    verdict: "planned", summary: "narrowed remaining task", decisions: [], assumptions: [],
    openQuestions: [], blockers: [], artifacts: [],
    tasks: [{
      id: "task-003", title: "Narrowed task", kind: "maintenance", workflow: "tdd",
      status: "pending", priority: 3,
      acceptanceCriteria: ["adjusted.txt exists"], validation: [],
      dependsOn: [], failureHistory: [], artifacts: [], scope: ["adjusted.txt"]
    }]
  }), "utf-8");
  const gm = content.match(/Also write an autonomous grill transcript markdown file to: (.+)/);
  if (gm) { mkdirSync(dirname(gm[1].trim()), { recursive: true }); writeFileSync(gm[1].trim(), "# Grill\\nAdjusted.", "utf-8"); }
  process.exit(0);
}
if (content.includes("Write JSON only to this path:")) {
  const m = content.match(/Write JSON only to this path: (.+)/);
  const p = m[1].trim();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify({ verdict: "pass", summary: "ok", issues: [], humanGates: [], recommendedStatus: "passed", artifacts: [] }), "utf-8");
  process.exit(0);
}
if (content.includes('"id": "task-002"')) throw new Error("executor must not run stale task-002 after adjust_remaining_tasks");
if (content.includes('"id": "task-003"')) { writeFileSync("adjusted.txt", "done", "utf-8"); process.exit(0); }
writeFileSync("output.txt", "done", "utf-8");
`, "utf-8");

    git(["add", "-A"], dir);
    git(["commit", "-m", "initial"], dir);

    const r = runCLI(dir, ["run", "--command", fakeCommand(agentPath), "--max-iterations", "4", "--no-merge", "--decision-grill"], 120_000);
    assert(r.status === 0, `CLI exited ${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
    const state = readState(dir);
    const stale = state.tasks.find((t: any) => t.id === "task-002");
    const adjusted = state.tasks.find((t: any) => t.id === "task-003");
    assert(stale?.status === "blocked", `expected task-002 blocked, got ${stale?.status}`);
    assert(adjusted?.status === "passed", `expected task-003 passed, got ${adjusted?.status}`);
    const events = readEvents(dir);
    assert(hasEvent(events, "post_task_review_replan"), "expected post_task_review_replan event");
    const ev = events.find((e: any) => e.type === "post_task_review_replan");
    assert(ev?.verdict === "adjust_remaining_tasks", `expected verdict=adjust_remaining_tasks, got ${ev?.verdict}`);
    assert(hasEvent(events, "planner_finished"), "expected planner_finished after adjust_remaining_tasks");
  } finally {
    if (!keep) rmSync(dir, { recursive: true, force: true });
  }
});

// ── case 20: architect checkpoint needs_human ─────────────────────────────────
// Two tasks pass. Architect checkpoint fires (interval=2). Agent returns
// needs_human. Loop must exit non-zero without running any more tasks.

runCase("architect checkpoint: needs_human verdict halts loop", () => {
  const dir = tmpRepo("arch-nh");
  try {
    writeState(dir, {
      version: 1, goal: "Smoke goal", maxIterations: 5, checks: [],
      defaultDiscoveryWorkflow: "grill-with-docs",
      tasks: [
        baseTask({ id: "task-001", title: "First task",  priority: 1, scope: ["out1.txt"] }),
        baseTask({ id: "task-002", title: "Second task", priority: 2, scope: ["out2.txt"] }),
        baseTask({ id: "task-003", title: "Third task",  priority: 3, scope: ["out3.txt"], dependsOn: ["task-002"] }),
      ],
      decisions: [], assumptions: [], openQuestions: [], blockers: [],
      promptPolicy: { lessons: [] },
    });

    const agentPath = join(dir, "fake-agent.mjs");
    writeFileSync(agentPath, `
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname } from "path";
const content = readFileSync(process.argv[2], "utf-8");

if (content.includes("Write task-grill JSON only to:")) {
  const m = content.match(/Write task-grill JSON only to: (.+)/);
  const p = m[1].trim();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify({
    verdict: "ready", understanding: "ok", evidence: [], assumptionsStillValid: [],
    assumptionsChanged: [], scopeDecision: { declaredScopeOk: true, requestedScopeChanges: [] },
    acceptanceProof: [], risks: [], executorInstructions: "proceed"
  }), "utf-8");
  process.exit(0);
}
// Architect checkpoint: return needs_human
if (content.includes("Write your verdict JSON only to:") && content.includes("architect reviewer")) {
  const m = content.match(/Write your verdict JSON only to: (.+)/);
  const p = m[1].trim();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify({ verdict: "needs_human", assessment: "architectural risk discovered, human review required", suggestedChanges: [] }), "utf-8");
  process.exit(0);
}
if (content.includes("Write JSON only to this path:")) {
  const m = content.match(/Write JSON only to this path: (.+)/);
  const p = m[1].trim();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify({ verdict: "pass", summary: "ok", issues: [], humanGates: [], recommendedStatus: "passed", artifacts: [] }), "utf-8");
  process.exit(0);
}
if (content.includes('"id": "task-003"')) throw new Error("task-003 must not run after architect checkpoint needs_human");
if (content.includes('"id": "task-001"')) writeFileSync("out1.txt", "done", "utf-8");
else if (content.includes('"id": "task-002"')) writeFileSync("out2.txt", "done", "utf-8");
`, "utf-8");

    git(["add", "-A"], dir);
    git(["commit", "-m", "initial"], dir);

    const r = runCLI(dir, ["run", "--command", fakeCommand(agentPath), "--max-iterations", "5", "--no-merge", "--architect-checkpoint-interval", "2", "--no-decision-grill", "--no-post-task-review"], 120_000);
    assert(r.status !== 0, "expected non-zero exit when architect checkpoint returns needs_human");
    const events = readEvents(dir);
    assert(hasEvent(events, "architect_checkpoint_finished"), "expected architect_checkpoint_finished event");
    const ev = events.find((e: any) => e.type === "architect_checkpoint_finished");
    assert(ev?.verdict === "needs_human", `expected verdict=needs_human, got ${ev?.verdict}`);
    const state = readState(dir);
    assert(state.tasks.find((t: any) => t.id === "task-003")?.status !== "passed", "task-003 must not pass after architect needs_human");
  } finally {
    if (!keep) rmSync(dir, { recursive: true, force: true });
  }
});

// ── case 21: agent-call budget exhaustion ─────────────────────────────────────
// Two maintenance tasks with --fast-verifier (no verifier agent call).
// Task-1 uses grill(1) + executor(1) = 2 agent calls.
// --max-agent-calls 2: iteration 2 starts with count=2 >= 2, fires
// budget_exhausted before task-2's grill runs. Loop exits non-zero.

runCase("agent-call budget: exhausted after maxAgentCalls, loop halts", () => {
  const dir = tmpRepo("agent-call-budget");
  try {
    writeState(dir, {
      version: 1, goal: "Budget smoke", maxIterations: 5, checks: [],
      defaultDiscoveryWorkflow: "grill-with-docs",
      tasks: [
        baseTask({ id: "task-001", kind: "maintenance", title: "First task",  priority: 1, scope: ["out1.txt"] }),
        baseTask({ id: "task-002", kind: "maintenance", title: "Second task", priority: 2, scope: ["out2.txt"] }),
      ],
      decisions: [], assumptions: [], openQuestions: [], blockers: [],
      promptPolicy: { lessons: [] },
    });

    const agentPath = join(dir, "fake-agent.mjs");
    writeFileSync(agentPath, `
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname } from "path";
const content = readFileSync(process.argv[2], "utf-8");

if (content.includes("Write task-grill JSON only to:")) {
  const m = content.match(/Write task-grill JSON only to: (.+)/);
  const p = m[1].trim();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify({
    verdict: "ready", understanding: "ok", evidence: [], assumptionsStillValid: [],
    assumptionsChanged: [], scopeDecision: { declaredScopeOk: true, requestedScopeChanges: [] },
    acceptanceProof: [], risks: [], executorInstructions: "proceed"
  }), "utf-8");
  process.exit(0);
}
if (content.includes('"id": "task-001"')) { writeFileSync("out1.txt", "done", "utf-8"); process.exit(0); }
writeFileSync("out2.txt", "done", "utf-8");
`, "utf-8");

    git(["add", "-A"], dir);
    git(["commit", "-m", "initial"], dir);

    // grill(1) + executor(1) = 2 calls for task-1. Budget fires at iteration 2 top.
    const r = runCLI(dir, ["run", "--command", fakeCommand(agentPath), "--max-iterations", "5", "--max-agent-calls", "2", "--no-merge", "--no-decision-grill", "--no-post-task-review", "--fast-verifier"], 90_000);
    assert(r.status !== 0, "expected non-zero exit when agent-call budget exhausted");
    const events = readEvents(dir);
    assert(hasEvent(events, "budget_exhausted"), "expected budget_exhausted event");
    const ev = events.find((e: any) => e.type === "budget_exhausted");
    assert(ev?.reason?.includes("agent-call budget exhausted"), `expected agent-call budget reason, got: ${ev?.reason}`);
  } finally {
    if (!keep) rmSync(dir, { recursive: true, force: true });
  }
});

// ── case 22: post-task review needs_human halts loop ─────────────────────────
// Task passes. Post-task review agent returns needs_human. Loop must exit
// non-zero without running any further tasks.

runCase("post-task review: needs_human verdict halts loop", () => {
  const dir = tmpRepo("post-task-nh");
  try {
    writeState(dir, baseState(
      { title: "Smoke task", scope: ["output.txt"], priority: 1 },
      {
        maxIterations: 3,
        tasks: [
          baseTask({ id: "task-001", title: "Smoke task", scope: ["output.txt"], priority: 1 }),
          baseTask({ id: "task-002", title: "Should not run", scope: ["other.txt"], priority: 2, dependsOn: ["task-001"] }),
        ],
      }
    ));

    const agentPath = join(dir, "fake-agent.mjs");
    writeFileSync(agentPath, `
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname } from "path";
const content = readFileSync(process.argv[2], "utf-8");

if (content.includes("Write task-grill JSON only to:")) {
  const m = content.match(/Write task-grill JSON only to: (.+)/);
  const p = m[1].trim();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify({
    verdict: "ready", understanding: "ok", evidence: [], assumptionsStillValid: [],
    assumptionsChanged: [], scopeDecision: { declaredScopeOk: true, requestedScopeChanges: [] },
    acceptanceProof: [], risks: [], executorInstructions: "proceed"
  }), "utf-8");
  process.exit(0);
}
if (content.includes("Write post-task review JSON only to:")) {
  const m = content.match(/Write post-task review JSON only to: (.+)/);
  const p = m[1].trim();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify({
    verdict: "needs_human",
    assessment: "completed work revealed a requirement gap that needs human clarification",
    remainingPlanStillValid: false,
    suggestedChanges: []
  }), "utf-8");
  process.exit(0);
}
if (content.includes("Write JSON only to this path:")) {
  const m = content.match(/Write JSON only to this path: (.+)/);
  const p = m[1].trim();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify({ verdict: "pass", summary: "ok", issues: [], humanGates: [], recommendedStatus: "passed", artifacts: [] }), "utf-8");
  process.exit(0);
}
if (content.includes('"id": "task-002"')) throw new Error("task-002 must not run after post-task review needs_human");
writeFileSync("output.txt", "done", "utf-8");
`, "utf-8");

    git(["add", "-A"], dir);
    git(["commit", "-m", "initial"], dir);

    const r = runCLI(dir, ["run", "--command", fakeCommand(agentPath), "--max-iterations", "3", "--no-merge", "--no-decision-grill"], 90_000);
    assert(r.status !== 0, "expected non-zero exit when post-task review returns needs_human");
    const events = readEvents(dir);
    assert(hasEvent(events, "post_task_review_finished"), "expected post_task_review_finished event");
    const ev = events.find((e: any) => e.type === "post_task_review_finished");
    assert(ev?.verdict === "needs_human", `expected verdict=needs_human, got ${ev?.verdict}`);
    const state = readState(dir);
    assert(state.tasks.find((t: any) => t.id === "task-002")?.status !== "passed", "task-002 must not pass after post-task review needs_human");
  } finally {
    if (!keep) rmSync(dir, { recursive: true, force: true });
  }
});

// ── case 23: init — no prior state ───────────────────────────────────────────
// agentic-loop init "my goal" in a fresh repo creates agentic.json with the
// given goal and does not create an archive file.

runCase("init: no prior agentic.json creates fresh state", () => {
  const dir = tmpRepo("init-fresh");
  try {
    git(["commit", "--allow-empty", "-m", "initial"], dir);

    const r = runCLI(dir, ["init", "my fresh goal", "--json"]);
    assert(r.status === 0, `CLI exited ${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);

    const out = JSON.parse(r.stdout.trim());
    assert(out.archived === false, `expected archived=false, got ${out.archived}`);
    assert(out.archivePath === null, `expected archivePath=null, got ${out.archivePath}`);
    assert(existsSync(out.stateFile), `stateFile ${out.stateFile} does not exist`);

    const state = JSON.parse(readFileSync(out.stateFile, "utf-8"));
    assert(state.goal === "my fresh goal", `expected goal, got ${state.goal}`);
    assert(Array.isArray(state.tasks) && state.tasks.length === 0, "expected empty tasks");
    assert(!existsSync(join(dir, ".agent-runs")), "no archive dir expected for fresh init");
  } finally {
    if (!keep) rmSync(dir, { recursive: true, force: true });
  }
});

// ── case 24: init — archives existing state ───────────────────────────────────
// agentic-loop init "new goal" when agentic.json already exists archives the
// old file to .agent-runs/archive-<timestamp>.json and writes a fresh state.

runCase("init: existing agentic.json is archived and replaced", () => {
  const dir = tmpRepo("init-archive");
  try {
    git(["commit", "--allow-empty", "-m", "initial"], dir);

    // Seed an existing state
    writeFileSync(join(dir, "agentic.json"), JSON.stringify({ version: 1, goal: "old goal", tasks: [] }), "utf-8");

    const r = runCLI(dir, ["init", "new goal", "--json"]);
    assert(r.status === 0, `CLI exited ${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);

    const out = JSON.parse(r.stdout.trim());
    assert(out.archived === true, `expected archived=true, got ${out.archived}`);
    assert(typeof out.archivePath === "string" && out.archivePath.length > 0, "expected archivePath string");
    assert(existsSync(out.archivePath), `archive file ${out.archivePath} does not exist`);

    const archive = JSON.parse(readFileSync(out.archivePath, "utf-8"));
    assert(archive.goal === "old goal", `archive should contain old goal, got ${archive.goal}`);

    const state = JSON.parse(readFileSync(out.stateFile, "utf-8"));
    assert(state.goal === "new goal", `expected new goal, got ${state.goal}`);
    assert(Array.isArray(state.tasks) && state.tasks.length === 0, "expected empty tasks in fresh state");
  } finally {
    if (!keep) rmSync(dir, { recursive: true, force: true });
  }
});

// ── summary ───────────────────────────────────────────────────────────────────

const passed = results.filter((r) => r.ok).length;
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
