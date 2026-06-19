#!/usr/bin/env node
import { program } from "commander";
import { writeFileSync, existsSync, copyFileSync, mkdirSync, createWriteStream } from "fs";
import { execFileSync } from "child_process";
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
import { runAgenticLoop, LoopError, type LoopConfig } from "./loop/index.js";
import type { AgentConfig } from "./agent/index.js";

function collect(val: string, acc: string[]): string[] { return [...acc, val]; }

const DEFAULT_RUNS_ROOT = ".agent-runs";
const DEFAULT_WORKTREE_ROOT = ".worktrees";
const DEFAULT_STATE_FILE = "agentic.json";
import { loadEvents, appendEvent } from "./events/index.js";
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
  .description("TypeScript CLI for validation, planning, and task-grilled autonomous agent loops")
  .version("0.1.0");

// ── validate ──────────────────────────────────────────────────────────────────

program
  .command("validate")
  .description(
    "Check README/plugin/skill consistency across all buckets. Exits non-zero on any error."
  )
  .option("--repo <path>", "Path to repo root (default: auto-detected from cwd)")
  .option("--allow-empty", "Treat a repo with zero discovered skills as success")
  .option("--json", "Output results as JSON")
  .action((opts) => {
    const repoRoot = opts.repo ? resolve(opts.repo) : detectRepoRoot();
    const ctx = loadContext(repoRoot);
    const result = runValidation(ctx);
    printValidateResult(result, { json: !!opts.json });
    if (result.checkedSkills === 0 && !opts.allowEmpty) {
      if (!opts.json) {
        console.error("No skills were discovered. Run from the skills repository root, pass --repo, or use --allow-empty intentionally.");
      }
      process.exit(1);
    }
    if (!result.passed) process.exit(1);
  });

// ── init ──────────────────────────────────────────────────────────────────────

program
  .command("init <goal>")
  .description(
    "Start a new goal: archives the existing agentic.json (if any) to .agent-runs/archive-<timestamp>.json, then writes a fresh minimal state for the given goal."
  )
  .option("--repo <path>", "Path to repo root (default: auto-detected from cwd)")
  .option("--runs-root <path>", "Event log / run artifact root (default: .agent-runs)")
  .option("--json", "Output result as JSON")
  .action((goal: string, opts) => {
    const repoRoot  = opts.repo     ? resolve(opts.repo)     : detectRepoRoot();
    const runsRoot  = join(repoRoot, opts.runsRoot ?? DEFAULT_RUNS_ROOT);
    const stateFile = join(repoRoot, DEFAULT_STATE_FILE);

    let archived   = false;
    let archivePath = "";

    if (existsSync(stateFile)) {
      mkdirSync(runsRoot, { recursive: true });
      const ts = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
      archivePath = join(runsRoot, `archive-${ts}.json`);
      copyFileSync(stateFile, archivePath);
      archived = true;
    }

    const freshState = {
      version: 1,
      goal,
      maxIterations: 10,
      checks: [] as string[],
      defaultDiscoveryWorkflow: "grill-with-docs",
      tasks: [] as unknown[],
      decisions: [] as string[],
      assumptions: [] as string[],
      openQuestions: [] as string[],
      blockers: [] as string[],
      promptPolicy: { lessons: [] as string[] },
    };
    writeFileSync(stateFile, JSON.stringify(freshState, null, 2), "utf-8");

    if (opts.json) {
      console.log(JSON.stringify({ archived, archivePath: archived ? archivePath : null, stateFile }));
    } else {
      if (archived) console.log(`Archived previous goal to: ${archivePath}`);
      console.log(`Initialised new goal in: ${stateFile}`);
      console.log(`Goal: ${goal}`);
    }
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
    const runsRoot = opts.runsRoot ?? DEFAULT_RUNS_ROOT;
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
    const runsRoot = opts.runsRoot ?? DEFAULT_RUNS_ROOT;
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
    const runsRoot = opts.runsRoot ?? DEFAULT_RUNS_ROOT;
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
    const runsRoot = opts.runsRoot ?? DEFAULT_RUNS_ROOT;
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
    const runsRoot = opts.runsRoot ?? DEFAULT_RUNS_ROOT;
    const worktreeRoot = opts.worktreeRoot ?? DEFAULT_WORKTREE_ROOT;
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
    const runsRoot = opts.runsRoot ?? DEFAULT_RUNS_ROOT;
    const worktreeRoot = opts.worktreeRoot ?? DEFAULT_WORKTREE_ROOT;
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

// ── run ───────────────────────────────────────────────────────────────────────

program
  .command("run")
  .description(
    "Run the autonomous agentic loop: plan (if needed) then execute tasks until done or budget exhausted."
  )
  .option("--repo <path>",                   "Path to repo root (default: auto-detected from cwd)")
  .option("--state <file>",                  "State file name relative to repo root (default: agentic.json)")
  .option("--runs-root <path>",              "Event log / run artifact root (default: .agent-runs)")
  .option("--worktree-root <path>",          "Worktree root (default: .worktrees)")
  .option("--command <template>",            "Default agent command; {prompt} is replaced with the prompt file path")
  .option("--planner-command <template>",    "Command for planner, replan, architect checkpoint, goal review (defaults to --command)")
  .option("--grill-command <template>",      "Command for task-grill, decision-grill, post-task review (defaults to --command)")
  .option("--executor-command <template>",   "Command for the executor agent (defaults to --command)")
  .option("--verifier-command <template>",   "Command for the verifier agent (defaults to --command)")
  .option("--agent-timeout <seconds>",       "Seconds before an agent invocation is killed (0 = none)", "0")
  .option("--check-timeout <seconds>",       "Seconds before a check command is killed (0 = none)", "0")
  .option("--max-iterations <n>",            "Maximum loop iterations (default: 10)", "10")
  .option("--max-retries <n>",               "Maximum retries per task before escalating to needs_human (default: 3)", "3")
  .option("--max-runtime-seconds <n>",       "Hard runtime budget in seconds (0 = none)", "0")
  .option("--max-agent-calls <n>",           "Hard agent-call budget (0 = none)", "0")
  .option("--max-replans <n>",               "Maximum replans allowed before escalating to needs_human (0 = no limit, default: 5)", "5")
  .option("--verifier-votes <n>",            "Override verifier vote count (0 = auto)", "0")
  .option("--checks <cmd>",                  "Extra check command (repeatable)", collect, [])
  .option("--worktree-bootstrap <cmd>",      "Bootstrap command run inside each task worktree before agents/checks (repeatable)", collect, [])
  .option("--worktree-bootstrap-ignore <path>", "Worktree-relative bootstrap artifact ignored by scope/diff/commit (repeatable)", collect, [])
  .option("--check-env-file <path>",         "Env file loaded for validation checks, relative to worktree or absolute")
  .option("--prompt-budget <level>",         "Prompt context budget: low | medium | high (default: medium)", "medium")
  .option("--merge-mode <mode>",             "ff-only | no-ff | cherry-pick (default: ff-only)", "ff-only")
  .option("--no-commit",                     "Do not commit changes in the worktree after a pass")
  .option("--no-apply",                      "Do not apply run worktree changes to main tree at end (default: apply)")
  .option("--merge",                         "Merge the run branch into main instead of applying as unstaged changes")
  .option("--review-branch",                 "Keep changes on a review branch instead of merging (implies --no-apply)")
  .option("--auto-accept-passed",            "Automatically integrate and clean up passed tasks")
  .option("--cleanup-passed",                "Remove the worktree after a task passes")
  .option("--plan-only",                     "Run the planner then exit without executing tasks")
  .option("--retry <id>",                    "Retry a specific task id (must be needs_retry or failed)")
  .option("--fast-verifier",                 "Skip the verifier agent for low-risk tasks that pass checks")
  .option("--rebase-before-verify",          "Rebase worktree on loop-start HEAD before verifier; re-runs checks to catch integration issues")
  .option("--allow-dirty",                   "Proceed even if policy requires a clean main worktree")
  .option("--no-finalize-docs",              "Skip the finalize-docs agent after all tasks pass")
  .option("--goal-review",                   "Run a goal-review agent after all tasks pass; halts with needs_human if gaps detected")
  .option("--no-post-task-review",           "Skip the default plan-validity review after each passed task")
  .option("--architect-checkpoint-interval <n>", "Run an architect checkpoint every N passed tasks (0 = disabled, default: 3)", "3")
  .option("--decision-grill",                "Run the per-task design decision self-interview (default)")
  .option("--no-decision-grill",             "Skip the per-task grill-with-docs self-interview (on by default)")
  .action((opts) => {
    const repoRoot = opts.repo ? resolve(opts.repo) : detectRepoRoot();

    const timeout = parseInt(opts.agentTimeout ?? "0", 10);
    const makeAgent = (template?: string): AgentConfig =>
      template && template.trim().length > 0
        ? { tool: "custom", commandTemplate: template, timeoutSeconds: timeout }
        : { tool: "pi", timeoutSeconds: timeout };

    // Auto-detect executor command if --command not supplied.
    const detectDefaultCommand = (): string => {
      if (opts.command && (opts.command as string).trim().length > 0) return opts.command as string;
      for (const [bin, flag] of [["claude", "-p"], ["pi", "-p"]] as [string, string][]) {
        try {
          execFileSync(bin, ["--version"], { stdio: "ignore", shell: true });
          return `${bin} ${flag} {prompt}`;
        } catch { /* try next */ }
      }
      throw new LoopError("No executor found. Install 'claude' or 'pi', or pass --command.");
    };
    const defaultCmd = detectDefaultCommand();
    const agentConfig:    AgentConfig = makeAgent(defaultCmd);
    const plannerConfig:  AgentConfig = makeAgent(opts.plannerCommand  ?? defaultCmd);
    const grillConfig:    AgentConfig = makeAgent(opts.grillCommand    ?? defaultCmd);
    const executorConfig: AgentConfig = makeAgent(opts.executorCommand ?? defaultCmd);
    const verifierConfig: AgentConfig = makeAgent(opts.verifierCommand ?? defaultCmd);

    const mergeModeRaw = opts.mergeMode ?? "ff-only";
    if (!["ff-only", "no-ff", "cherry-pick"].includes(mergeModeRaw)) {
      console.error(`Invalid --merge-mode '${mergeModeRaw}'. Expected: ff-only | no-ff | cherry-pick`);
      process.exit(2);
    }

    const budgetRaw = opts.promptBudget ?? "medium";
    if (!["low", "medium", "high"].includes(budgetRaw)) {
      console.error(`Invalid --prompt-budget '${budgetRaw}'. Expected: low | medium | high`);
      process.exit(2);
    }

    const loopConfig: LoopConfig = {
      repoRoot,
      stateFile:           opts.state           ?? DEFAULT_STATE_FILE,
      runsRoot:            opts.runsRoot         ?? DEFAULT_RUNS_ROOT,
      worktreeRoot:        opts.worktreeRoot     ?? DEFAULT_WORKTREE_ROOT,
      agent:               agentConfig,
      plannerAgent:        plannerConfig,
      grillAgent:          grillConfig,
      executorAgent:       executorConfig,
      verifierAgent:       verifierConfig,
      maxIterations:       parseInt(opts.maxIterations    ?? "10", 10),
      maxRetries:          parseInt(opts.maxRetries       ?? "3",  10),
      maxRuntimeSeconds:   parseInt(opts.maxRuntimeSeconds ?? "0", 10),
      maxAgentCalls:       parseInt(opts.maxAgentCalls    ?? "0",  10),
      maxReplans:          parseInt(opts.maxReplans       ?? "5",  10),
      verifierVotes:       parseInt(opts.verifierVotes    ?? "0",  10),
      checkTimeoutSeconds: parseInt(opts.checkTimeout     ?? "0",  10),
      extraChecks:         (opts.checks as string[]) ?? [],
      worktreeBootstrap:   (opts.worktreeBootstrap as string[]) ?? [],
      worktreeBootstrapIgnore: (opts.worktreeBootstrapIgnore as string[]) ?? [],
      checkEnvFile:        opts.checkEnvFile ?? "",
      budget:              budgetRaw as "low" | "medium" | "high",
      mergeMode:           mergeModeRaw as "ff-only" | "no-ff" | "cherry-pick",
      planOnly:            !!opts.planOnly,
      retryTaskId:         opts.retry            ?? "",
      commit:              opts.commit           !== false,
      apply:               opts.apply            !== false && !opts.merge && !opts.reviewBranch,
      merge:               !!opts.merge && !opts.reviewBranch,
      reviewBranchMode:    !!opts.reviewBranch,
      autoAcceptPassed:    !!opts.autoAcceptPassed,
      cleanupPassed:       !!opts.cleanupPassed,
      fastVerifier:                !!opts.fastVerifier,
      rebaseBeforeVerify:          !!opts.rebaseBeforeVerify,
      allowDirty:                  !!opts.allowDirty,
      finalizeDocs:                opts.finalizeDocs !== false,
      goalReview:                  !!opts.goalReview,
      postTaskReview:              opts.postTaskReview !== false,
      architectCheckpointInterval: parseInt(opts.architectCheckpointInterval ?? "3", 10),
      decisionGrill:               opts.decisionGrill !== false,
    };

    const runsRoot = join(repoRoot, loopConfig.runsRoot ?? DEFAULT_RUNS_ROOT);
    mkdirSync(runsRoot, { recursive: true });
    const runTs = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
    const runLogPath = join(runsRoot, `run-${runTs}.log`);
    const logStream = createWriteStream(runLogPath, { flags: "a" });
    for (const stream of [process.stdout, process.stderr] as NodeJS.WriteStream[]) {
      const orig = stream.write.bind(stream);
      (stream as NodeJS.WriteStream).write = function(chunk: Uint8Array | string, ...rest: unknown[]) {
        logStream.write(chunk);
        return (orig as (...a: unknown[]) => boolean)(chunk, ...rest);
      } as typeof stream.write;
    }
    if (process.stdout.isTTY) console.log(`Run log: ${runLogPath}`);

    runAgenticLoop(loopConfig).catch((err) => {
      if (err instanceof LoopError) {
        console.error(err.message);
        process.exit(err.exitCode);
      }
      throw err;
    });
  });

program.parseAsync(process.argv).catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
