#!/usr/bin/env node
import { program } from "commander";
import { writeFileSync, existsSync } from "fs";
import { join, resolve, dirname } from "path";
import { loadContext } from "./context/index.js";
import { loadPolicy } from "./policy/index.js";
import { runValidation } from "./validators/index.js";
import { scaffoldPlan, renderPlanMarkdown } from "./planner/index.js";
import {
  printValidateResult,
  printPlanResult,
  printStatusResult,
  printSummaryResult,
  printLastFailureResult,
  printWhyStuckResult,
  printDoctorResult,
  type DoctorIssue,
} from "./reporting/index.js";
import { loadState, getTasks } from "./state/index.js";
import { loadEvents } from "./events/index.js";
import { execSync } from "child_process";

function detectRepoRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 10; i++) {
    if (existsSync(join(dir, "AGENTS.md")) || existsSync(join(dir, ".git"))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

program
  .name("agent")
  .description("Deterministic pre-flight CLI for the agentic coding loop")
  .version("0.1.0");

// ── validate ──────────────────────────────────────────────────────────────────

program
  .command("validate")
  .description(
    "Check README/plugin/skill consistency across all buckets. Exits non-zero on any error."
  )
  .option("--repo <path>", "Path to repo root (default: auto-detected from cwd)")
  .option("--json", "Output results as JSON")
  .action((opts) => {
    const repoRoot = opts.repo ? resolve(opts.repo) : detectRepoRoot();
    const ctx = loadContext(repoRoot);
    const result = runValidation(ctx);
    printValidateResult(result, { json: !!opts.json });
    if (!result.passed) process.exit(1);
  });

// ── plan ──────────────────────────────────────────────────────────────────────

program
  .command("plan <task>")
  .description(
    "Scaffold a deterministic plan.md from a task description. Never touches agentic.json."
  )
  .option("--repo <path>", "Path to repo root (default: auto-detected from cwd)")
  .option("--output <path>", "Output file path (default: plan.md in repo root)")
  .option("--json", "Output summary as JSON (plan.md is always written)")
  .action((task, opts) => {
    const repoRoot = opts.repo ? resolve(opts.repo) : detectRepoRoot();
    const ctx = loadContext(repoRoot);
    const policy = loadPolicy(repoRoot);
    const planResult = scaffoldPlan(task, ctx, policy);
    const markdown = renderPlanMarkdown(planResult);

    const outputPath = opts.output
      ? resolve(opts.output)
      : join(repoRoot, "plan.md");

    writeFileSync(outputPath, markdown, "utf-8");

    printPlanResult(
      {
        outputPath,
        taskCount: planResult.tasks.length,
        warnings: planResult.warnings,
      },
      { json: !!opts.json }
    );
  });

// ── status ────────────────────────────────────────────────────────────────────

program
  .command("status")
  .description("Print current agentic.json state: tasks, next runnable, recent events.")
  .option("--repo <path>", "Path to repo root")
  .option("--runs-root <path>", "Path to runs/event log root (default: .agent-runs)")
  .option("--json", "Output as JSON")
  .action((opts) => {
    const repoRoot = opts.repo ? resolve(opts.repo) : detectRepoRoot();
    const runsRoot = opts.runsRoot ?? ".agent-runs";
    const state = loadState(repoRoot);
    if (!state) { console.error("No agentic.json found."); process.exit(1); }
    const events = loadEvents(repoRoot, runsRoot);
    printStatusResult({ state, events, worktreeRoot: ".worktrees", runsRoot }, { json: !!opts.json });
  });

// ── summary ───────────────────────────────────────────────────────────────────

program
  .command("summary")
  .description("Print a compact checkpoint summary: task counts by status, next task, recent events.")
  .option("--repo <path>", "Path to repo root")
  .option("--runs-root <path>", "Path to runs/event log root (default: .agent-runs)")
  .option("--json", "Output as JSON")
  .action((opts) => {
    const repoRoot = opts.repo ? resolve(opts.repo) : detectRepoRoot();
    const runsRoot = opts.runsRoot ?? ".agent-runs";
    const state = loadState(repoRoot);
    if (!state) { console.error("No agentic.json found."); process.exit(1); }
    const events = loadEvents(repoRoot, runsRoot);
    printSummaryResult({ state, events, worktreeRoot: ".worktrees", runsRoot }, { json: !!opts.json });
  });

// ── last-failure ──────────────────────────────────────────────────────────────

program
  .command("last-failure")
  .description("Print the most recent failure event or task failureHistory entry.")
  .option("--repo <path>", "Path to repo root")
  .option("--runs-root <path>", "Path to runs/event log root (default: .agent-runs)")
  .option("--json", "Output as JSON")
  .action((opts) => {
    const repoRoot = opts.repo ? resolve(opts.repo) : detectRepoRoot();
    const runsRoot = opts.runsRoot ?? ".agent-runs";
    const state = loadState(repoRoot);
    if (!state) { console.error("No agentic.json found."); process.exit(1); }
    const events = loadEvents(repoRoot, runsRoot);
    printLastFailureResult(state, events, { json: !!opts.json });
  });

// ── why-stuck ─────────────────────────────────────────────────────────────────

program
  .command("why-stuck")
  .description("Explain blocked/needs_human/retryable tasks with suggested next commands.")
  .option("--repo <path>", "Path to repo root")
  .option("--runs-root <path>", "Path to runs/event log root (default: .agent-runs)")
  .option("--json", "Output as JSON")
  .action((opts) => {
    const repoRoot = opts.repo ? resolve(opts.repo) : detectRepoRoot();
    const runsRoot = opts.runsRoot ?? ".agent-runs";
    const state = loadState(repoRoot);
    if (!state) { console.error("No agentic.json found."); process.exit(1); }
    const events = loadEvents(repoRoot, runsRoot);
    printWhyStuckResult(state, events, { json: !!opts.json });
  });

// ── doctor ────────────────────────────────────────────────────────────────────

function gitBranchExists(branch: string): boolean {
  try {
    const out = execSync(`git branch --list ${branch}`, { encoding: "utf-8" });
    return out.trim().length > 0;
  } catch {
    return false;
  }
}

program
  .command("doctor")
  .description("Diagnose stale review metadata: missing branches and worktrees. Exits non-zero on issues.")
  .option("--repo <path>", "Path to repo root")
  .option("--json", "Output as JSON")
  .action((opts) => {
    const repoRoot = opts.repo ? resolve(opts.repo) : detectRepoRoot();
    const state = loadState(repoRoot);
    if (!state) { console.error("No agentic.json found."); process.exit(1); }

    const issues: DoctorIssue[] = [];
    for (const task of getTasks(state)) {
      if (task.reviewBranch) {
        if (!gitBranchExists(task.reviewBranch)) {
          issues.push({ taskId: task.id, kind: "missing-branch", value: task.reviewBranch });
        }
      }
      if (task.reviewWorktree) {
        if (!existsSync(task.reviewWorktree)) {
          issues.push({ taskId: task.id, kind: "missing-worktree", value: task.reviewWorktree });
        }
      }
    }

    const result = { issues, passed: issues.length === 0 };
    printDoctorResult(result, { json: !!opts.json });
    if (!result.passed) process.exit(1);
  });

program.parseAsync(process.argv).catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
