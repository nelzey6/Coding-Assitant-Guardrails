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
  printResetResult,
  printAcceptResult,
  type DoctorIssue,
  type ResetPlan,
  type AcceptPlan,
} from "./reporting/index.js";
import { loadState, writeState, getTasks, clearTaskReviewState } from "./state/index.js";
import { loadEvents, appendEvent } from "./events/index.js";
import {
  getTaskScope,
  testPathInScope,
  getOutOfScopeFiles,
  testFastVerifierAllowed,
  testTaskIsHighRisk,
  convertToScopeRegex,
} from "./scope/index.js";
import { parseMetricLines, formatMetricsForPrompt, invokeChecks } from "./checks/index.js";
import {
  safeSlug,
  gitBranchExists as toolsGitBranchExists,
  worktreeExists,
  removeWorktree,
  removeWorktreeClean,
  deleteBranch,
  isWorkingTreeClean,
  workingTreeStatusShort,
  revParse,
  integrateBranch,
  mergeModeLabel,
  MERGE_MODES,
  GitError,
  type MergeMode,
} from "./tools/index.js";

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
        if (!toolsGitBranchExists(task.reviewBranch, repoRoot)) {
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

// ── reset-task ────────────────────────────────────────────────────────────────

program
  .command("reset-task <id>")
  .description(
    "Reset a task for a clean rerun: remove its worktree, delete its branch, mark it needs_retry. Dry-run by default."
  )
  .option("--repo <path>", "Path to repo root")
  .option("--runs-root <path>", "Path to runs/event log root (default: .agent-runs)")
  .option("--worktree-root <path>", "Worktree root (default: .worktrees)")
  .option("--apply", "Actually execute the reset (default is dry-run)")
  .option("--json", "Output as JSON")
  .action((id, opts) => {
    const repoRoot = opts.repo ? resolve(opts.repo) : detectRepoRoot();
    const runsRoot = opts.runsRoot ?? ".agent-runs";
    const worktreeRoot = opts.worktreeRoot ?? ".worktrees";
    const apply = !!opts.apply;

    const state = loadState(repoRoot);
    if (!state) { console.error("No agentic.json found."); process.exit(1); }

    const task = getTasks(state).find((t) => t.id === id);
    if (!task) { console.error(`Task '${id}' not found in agentic.json.`); process.exit(1); }

    const safeId = safeSlug(id);
    const branch = task.reviewBranch || `agentic/${safeId}`;
    const worktree = task.reviewWorktree
      ? resolve(repoRoot, task.reviewWorktree)
      : join(repoRoot, worktreeRoot, safeId);

    const worktreeWillRemove = worktreeExists(worktree);
    const branchWillDelete = toolsGitBranchExists(branch, repoRoot);

    if (apply) {
      if (worktreeWillRemove) removeWorktree(worktree, repoRoot);
      if (branchWillDelete) deleteBranch(branch, repoRoot);
      task.status = "needs_retry";
      if (task.reviewBranch !== undefined) task.reviewBranch = "";
      if (task.reviewWorktree !== undefined) task.reviewWorktree = "";
      writeState(repoRoot, state);
      appendEvent(repoRoot, "task_reset", { task: id, branch, worktree, status: "needs_retry" }, runsRoot);
    }

    const plan: ResetPlan = {
      taskId: id,
      branch,
      worktree,
      worktreeWillRemove,
      branchWillDelete,
      newStatus: "needs_retry",
      applied: apply,
    };
    printResetResult(plan, { json: !!opts.json });
  });

// ── accept ────────────────────────────────────────────────────────────────────

program
  .command("accept <id>")
  .description(
    "Integrate a passed task's review branch into the current branch, then clean up. Dry-run by default."
  )
  .option("--repo <path>", "Path to repo root")
  .option("--runs-root <path>", "Path to runs/event log root (default: .agent-runs)")
  .option("--worktree-root <path>", "Worktree root (default: .worktrees)")
  .option("--merge-mode <mode>", "ff-only | no-ff | cherry-pick | apply (default: ff-only)", "ff-only")
  .option("--allow-dirty", "Proceed even if the working tree is dirty")
  .option("--apply", "Actually execute the accept (default is dry-run)")
  .option("--json", "Output as JSON")
  .action((id, opts) => {
    const repoRoot = opts.repo ? resolve(opts.repo) : detectRepoRoot();
    const runsRoot = opts.runsRoot ?? ".agent-runs";
    const worktreeRoot = opts.worktreeRoot ?? ".worktrees";
    const apply = !!opts.apply;
    const mergeMode = opts.mergeMode as MergeMode;

    if (!MERGE_MODES.includes(mergeMode)) {
      console.error(`Invalid merge mode '${mergeMode}'. Expected one of: ${MERGE_MODES.join(", ")}`);
      process.exit(2);
    }

    const state = loadState(repoRoot);
    if (!state) { console.error("No agentic.json found."); process.exit(1); }

    const task = getTasks(state).find((t) => t.id === id);
    if (!task) { console.error(`Cannot accept '${id}': task not found in agentic.json.`); process.exit(1); }
    if (task.status !== "passed") {
      console.error(`Cannot accept '${id}': task status is '${task.status}', expected 'passed'.`);
      process.exit(1);
    }

    if (!opts.allowDirty && !isWorkingTreeClean(repoRoot)) {
      console.error(`Cannot accept '${id}': working tree is dirty. Commit/stash first, or pass --allow-dirty.`);
      console.error(workingTreeStatusShort(repoRoot));
      process.exit(1);
    }

    const safeId = safeSlug(id);
    const branch = task.reviewBranch || `agentic/${safeId}`;
    const worktree = task.reviewWorktree
      ? resolve(repoRoot, task.reviewWorktree)
      : join(repoRoot, worktreeRoot, safeId);

    if (!toolsGitBranchExists(branch, repoRoot)) {
      console.error(`Cannot accept '${id}': branch '${branch}' was not found.`);
      process.exit(1);
    }

    const alreadyIntegrated = revParse(branch, repoRoot) === revParse("HEAD", repoRoot);
    const willCleanup = mergeMode !== "apply";

    const plan: AcceptPlan = {
      taskId: id,
      branch,
      worktree,
      mergeMode,
      mergeLabel: mergeModeLabel(mergeMode, branch),
      alreadyIntegrated,
      willCleanup,
      applied: apply,
    };

    if (apply) {
      let integrated = false;
      if (!alreadyIntegrated) {
        try {
          integrateBranch(mergeMode, branch, id, repoRoot);
          integrated = true;
        } catch (err) {
          const hint =
            mergeMode === "apply"
              ? " The apply/no-commit mode may leave conflict state; resolve it or run 'git cherry-pick --abort' before retrying."
              : "";
          const msg = err instanceof GitError ? err.message : String(err);
          console.error(`Accept failed running '${plan.mergeLabel}'.${hint}\nWorktree '${worktree}' and branch '${branch}' left intact.\n${msg}`);
          process.exit(1);
        }
      }
      plan.integrated = integrated;

      if (willCleanup) {
        try {
          if (worktreeExists(worktree)) removeWorktreeClean(worktree, repoRoot);
          deleteBranch(branch, repoRoot);
          clearTaskReviewState(state, id, new Date().toISOString());
          writeState(repoRoot, state);
        } catch (err) {
          const msg = err instanceof GitError ? err.message : String(err);
          console.error(`Accept integrated '${id}' but cleanup failed. Inspect worktree '${worktree}' and branch '${branch}'.\n${msg}`);
          process.exit(1);
        }
      }

      appendEvent(repoRoot, "task_accepted", { task: id, branch, mergeMode, cleanup: willCleanup }, runsRoot);
    }

    printAcceptResult(plan, { json: !!opts.json });
  });

program.parseAsync(process.argv).catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
