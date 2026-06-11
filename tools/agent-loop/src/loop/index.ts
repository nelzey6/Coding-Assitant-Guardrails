import { mkdirSync, copyFileSync, writeFileSync, readFileSync, existsSync, appendFileSync } from "fs";
import { join, resolve, dirname } from "path";
import { execFileSync } from "child_process";
import {
  loadState,
  writeState,
  getTasks,
  getNextTask,
  hasUnfinishedTasks,
  getBlockedDependencySummary,
  getTaskAttempts,
  setTaskStatus,
  setTaskPassed,
  addTaskAttempt,
  getFailureStatusForTask,
  getLastFailureAnalysisFile,
  mergePlannerResult,
  type AgenticState,
  type Task,
  type PlannerResult,
  type VerifierResult,
} from "../state/index.js";
import { appendEvent } from "../events/index.js";
import { safeSlug, createWorktree, worktreeExists, removeWorktree } from "../tools/index.js";
import { invokeAgent, invokeAgentWithLog, getTaskChecks, type AgentConfig } from "../agent/index.js";
import { invokeChecks, parseMetricLines } from "../checks/index.js";
import { getTaskScope, getOutOfScopeFiles, testFastVerifierAllowed, testTaskIsHighRisk, isTaskUnscoped } from "../scope/index.js";
import {
  writeCodeGraphContext,
  writeRepoContext,
  writePlannerPrompt,
  writeTaskGrillPrompt,
  writeExecutorPrompt,
  writeVerifierPrompt,
  writeFinalizeDocsPrompt,
  validatePlannerResult,
  getPromptBudgetLimits,
  writeFailureAnalysis,
  type PromptBudget,
} from "../prompts/index.js";
import { loadPolicy, type WorkflowPolicy } from "../policy/index.js";

export interface LoopConfig {
  repoRoot: string;
  stateFile?: string;
  runsRoot?: string;
  worktreeRoot?: string;
  agent: AgentConfig;
  verifierAgent?: AgentConfig;
  maxIterations?: number;
  maxRetries?: number;
  maxRuntimeSeconds?: number;
  maxAgentCalls?: number;
  /** Override verifier vote count (0 = auto-resolve from risk). */
  verifierVotes?: number;
  /** Rebase worktree on loop-start HEAD before running the verifier (opt-in). */
  rebaseBeforeVerify?: boolean;
  /** Timeout in seconds for each check command (0 = no timeout). */
  checkTimeoutSeconds?: number;
  /** Maximum number of replans allowed before treating as needs_human (0 = no limit). */
  maxReplans?: number;
  /** Extra check commands appended to state.checks (from --checks CLI flag). */
  extraChecks?: string[];
  budget?: PromptBudget;
  planOnly?: boolean;
  retryTaskId?: string;
  commit?: boolean;
  merge?: boolean;
  mergeMode?: "ff-only" | "no-ff" | "cherry-pick";
  reviewBranchMode?: boolean;
  autoAcceptPassed?: boolean;
  cleanupPassed?: boolean;
  fastVerifier?: boolean;
  finalizeDocs?: boolean;
}

export class LoopError extends Error {
  constructor(message: string, public readonly exitCode = 1) {
    super(message);
    this.name = "LoopError";
  }
}

interface TaskGrillResult {
  verdict: "ready" | "needs_replan" | "needs_human" | "blocked";
  understanding?: string;
  risks?: string[];
  executorInstructions?: string;
}

function git(args: string[], cwd?: string): string {
  try {
    return execFileSync("git", args, { encoding: "utf-8", cwd, stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (err: any) {
    const out = [err?.stdout, err?.stderr].filter(Boolean).join("\n").trim();
    throw new LoopError(`git ${args.join(" ")} failed: ${out || err?.message}`);
  }
}

function timestamp(): string {
  return new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
}

function writeDiffArtifacts(worktreePath: string, runDir: string): void {
  try { execFileSync("git", ["-C", worktreePath, "add", "-N", "."], { stdio: "ignore" }); } catch { /* non-fatal */ }
  const patch = (() => { try { return git(["diff", "HEAD"], worktreePath); } catch { return ""; } })();
  const stat  = (() => { try { return git(["diff", "--stat", "HEAD"], worktreePath); } catch { return ""; } })();
  writeFileSync(join(runDir, "diff.patch"), patch, "utf-8");
  writeFileSync(join(runDir, "diff-stat.txt"), stat, "utf-8");
}

function writeChecksLog(logPath: string, content: string): void {
  mkdirSync(dirname(logPath), { recursive: true });
  writeFileSync(logPath, content, "utf-8");
}

function appendProgress(runsRoot: string, taskId: string, summary: string, handoverFile: string): void {
  const progressFile = join(runsRoot, "agentic-progress.txt");
  appendFileSync(progressFile, `\n## ${new Date().toISOString()} ${taskId}\n- Verdict: pass\n- Summary: ${summary}\n- Handover: ${handoverFile}\n`, "utf-8");
}

function resolveVerifierVotes(task: Task, policy: WorkflowPolicy, forcedVotes = 0): number {
  if (forcedVotes > 0) return forcedVotes;
  return testTaskIsHighRisk(task as any, policy) ? 3 : 1;
}

// Run the planner phase: build context, invoke planner agent, validate + merge result.
// Returns the task IDs in the new plan (used by callers for convergence detection).
function runPlannerPhase(
  cfg: Required<LoopConfig>,
  policy: WorkflowPolicy,
  agentCallCounter: { count: number },
  priorFailureAnalysisFile = ""
): string[] {
  const ts = timestamp();
  const plannerRunDir = join(cfg.repoRoot, cfg.runsRoot, `agentic-${ts}-planner`);
  mkdirSync(plannerRunDir, { recursive: true });

  const promptFile       = join(plannerRunDir, "planner.md");
  const repoContextFile  = join(plannerRunDir, "repo-context.md");
  const resultFile       = join(plannerRunDir, "planner-result.json");
  const grillFile        = join(plannerRunDir, "grill-transcript.md");
  const codeGraphFile    = join(plannerRunDir, "codegraph.md");

  const state = loadState(cfg.repoRoot, cfg.stateFile)!;

  writeCodeGraphContext(codeGraphFile, cfg.repoRoot);
  writeRepoContext(repoContextFile, {
    repoRoot: cfg.repoRoot,
    stateGoal: state.goal ?? "",
    checks: state.checks ?? [],
    codeGraphFile,
  });
  writePlannerPrompt(promptFile, {
    repoRoot: cfg.repoRoot,
    runsRoot: cfg.runsRoot,
    stateFile: cfg.stateFile,
    budget: cfg.budget,
    state,
    policy,
    plannerResultFile: resultFile,
    repoContextFile,
    grillTranscriptFile: grillFile,
    codeGraphFile,
    priorFailureAnalysisFile,
  });

  appendEvent(cfg.repoRoot, "planner_started", { runDir: plannerRunDir, prompt: promptFile, resultFile, grillTranscript: grillFile }, cfg.runsRoot, cfg.stateFile);
  console.log("=== Agentic planner ===");
  agentCallCounter.count++;
  invokeAgent(promptFile, cfg.agent, cfg.repoRoot);

  if (!existsSync(resultFile)) throw new LoopError(`Planner did not write ${resultFile}`);
  if (!existsSync(grillFile))  throw new LoopError(`Planner did not write ${grillFile}`);

  let plannerResult = JSON.parse(readFileSync(resultFile, "utf-8")) as Record<string, unknown>;
  let errors = validatePlannerResult(plannerResult, policy);

  if (errors.length > 0) {
    const repairPrompt = join(plannerRunDir, "planner-repair.md");
    const repairContent = [
      "Your previous planner-result.json was invalid.",
      "",
      "Validation errors:",
      errors.join("\n"),
      "",
      "Original planner result:",
      readFileSync(resultFile, "utf-8"),
      "",
      `Rewrite valid planner JSON only to: ${resultFile}`,
      `Follow the schema and policy from the original planner prompt at: ${promptFile}`,
    ].join("\n");
    writeFileSync(repairPrompt, repairContent, "utf-8");
    console.log("=== Agentic planner repair ===");
    agentCallCounter.count++;
    invokeAgent(repairPrompt, cfg.agent, cfg.repoRoot);
    if (!existsSync(resultFile)) throw new LoopError(`Planner repair did not write ${resultFile}`);
    plannerResult = JSON.parse(readFileSync(resultFile, "utf-8")) as Record<string, unknown>;
    errors = validatePlannerResult(plannerResult, policy);
    if (errors.length > 0) throw new LoopError(`Planner result invalid after repair:\n${errors.join("\n")}`);
  }

  appendEvent(cfg.repoRoot, "planner_finished", { runDir: plannerRunDir, verdict: plannerResult["verdict"], resultFile, grillTranscript: grillFile }, cfg.runsRoot, cfg.stateFile);
  const stateAfterPlan = mergePlannerResult(cfg.repoRoot, cfg.stateFile, plannerResult as unknown as PlannerResult);
  return stateAfterPlan.lastReplanTaskIds ?? [];
}

// Run finalize-docs phase after all tasks pass.
function runFinalizeDocsPhase(cfg: Required<LoopConfig>, agentCallCounter: { count: number }): void {
  const merged = git(["rev-parse", "HEAD"], cfg.repoRoot);
  const ts = timestamp();
  const runDir = join(cfg.repoRoot, cfg.runsRoot, `agentic-${ts}-finalize-docs`);
  mkdirSync(runDir, { recursive: true });

  const promptFile  = join(runDir, "finalize-docs.md");
  const logFile     = join(runDir, "finalize-docs.log");
  const summaryFile = join(runDir, "final-summary.md");

  const state = loadState(cfg.repoRoot, cfg.stateFile)!;
  writeFinalizeDocsPrompt(promptFile, {
    repoRoot: cfg.repoRoot,
    runsRoot: cfg.runsRoot,
    stateFile: cfg.stateFile,
    budget: cfg.budget,
    state,
    summaryFile,
  });

  appendEvent(cfg.repoRoot, "finalize_docs_started", { runDir, prompt: promptFile, summary: summaryFile }, cfg.runsRoot, cfg.stateFile);
  agentCallCounter.count++;
  invokeAgentWithLog(promptFile, cfg.agent, cfg.repoRoot, logFile);

  if (!existsSync(summaryFile)) {
    writeFileSync(summaryFile, `# Agentic final summary\n\nFinalizer did not create a summary; inspect ${logFile}.`, "utf-8");
  }

  const docChanges = (() => { try { return git(["status", "--porcelain", "--", "PROJECT.md"], cfg.repoRoot); } catch { return ""; } })();
  if (docChanges && cfg.commit) {
    git(["add", "PROJECT.md"], cfg.repoRoot);
    git(["commit", "-m", "agentic: finalize docs"], cfg.repoRoot);
  }
  appendEvent(cfg.repoRoot, "finalize_docs_finished", { runDir, summary: summaryFile, docsChanged: !!docChanges }, cfg.runsRoot, cfg.stateFile);
}

// Main entry point. Throws LoopError with an appropriate exitCode on terminal failures.
export function runAgenticLoop(config: LoopConfig): void {
  const cfg: Required<LoopConfig> = {
    stateFile:          config.stateFile          ?? "agentic.json",
    runsRoot:           config.runsRoot           ?? ".agent-runs",
    worktreeRoot:       config.worktreeRoot       ?? ".worktrees",
    maxIterations:      config.maxIterations      ?? 10,
    maxRetries:         config.maxRetries         ?? 3,
    maxRuntimeSeconds:  config.maxRuntimeSeconds  ?? 0,
    maxAgentCalls:      config.maxAgentCalls      ?? 0,
    verifierVotes:      config.verifierVotes      ?? 0,
    checkTimeoutSeconds: config.checkTimeoutSeconds ?? 0,
    maxReplans:         config.maxReplans         ?? 5,
    extraChecks:        config.extraChecks        ?? [],
    budget:             config.budget             ?? "medium",
    planOnly:           config.planOnly           ?? false,
    retryTaskId:        config.retryTaskId        ?? "",
    commit:             config.commit             ?? false,
    merge:              config.merge              ?? false,
    mergeMode:          config.mergeMode          ?? "ff-only",
    reviewBranchMode:   config.reviewBranchMode   ?? false,
    autoAcceptPassed:   config.autoAcceptPassed   ?? false,
    cleanupPassed:      config.cleanupPassed      ?? false,
    fastVerifier:       config.fastVerifier       ?? false,
    rebaseBeforeVerify: config.rebaseBeforeVerify ?? false,
    finalizeDocs:       config.finalizeDocs       ?? false,
    repoRoot:           config.repoRoot,
    agent:              config.agent,
    verifierAgent:      config.verifierAgent      ?? config.agent,
  };

  const policy = loadPolicy(cfg.repoRoot);
  const runStartTime = Date.now();
  const agentCallCounter = { count: 0 };
  const eventLogPath = join(cfg.repoRoot, cfg.runsRoot, "events.jsonl");
  // Capture HEAD at loop start — used as rebase target when --rebase-before-verify is set.
  const loopBaseRef = (() => { try { return git(["rev-parse", "HEAD"], cfg.repoRoot); } catch { return ""; } })();

  // ── Planner phase ─────────────────────────────────────────────────────────
  {
    const state = loadState(cfg.repoRoot, cfg.stateFile);
    if (!state) throw new LoopError(`No ${cfg.stateFile} found in ${cfg.repoRoot}`);
    if (getTasks(state).length === 0) {
      runPlannerPhase(cfg, policy, agentCallCounter);
      if (cfg.planOnly) { console.log("<promise>PLANNED</promise>"); return; }
    }
  }
  // Track replan count across the session (loaded fresh each iteration below)
  let sessionReplanCount = 0;
  if (cfg.planOnly) { console.log("<promise>PLANNED</promise>"); return; }

  // ── Execution loop ────────────────────────────────────────────────────────
  for (let iteration = 1; iteration <= cfg.maxIterations; iteration++) {

    // Circuit-breaker check
    if (cfg.maxRuntimeSeconds > 0) {
      const elapsed = (Date.now() - runStartTime) / 1000;
      if (elapsed >= cfg.maxRuntimeSeconds) {
        const reason = `runtime budget exhausted (${Math.round(elapsed)}s >= ${cfg.maxRuntimeSeconds}s)`;
        appendEvent(cfg.repoRoot, "budget_exhausted", { reason, agentCalls: agentCallCounter.count, iteration }, cfg.runsRoot, cfg.stateFile);
        const st = loadState(cfg.repoRoot, cfg.stateFile)!;
        const pending = getNextTask(st);
        if (pending) setTaskStatus(cfg.repoRoot, cfg.stateFile, cfg.runsRoot, pending.id, "needs_human", { at: new Date().toISOString(), phase: "budget", reason, resultFile: "" });
        throw new LoopError(`Circuit breaker tripped: ${reason}. Re-run with a higher budget to continue.`);
      }
    }
    if (cfg.maxAgentCalls > 0 && agentCallCounter.count >= cfg.maxAgentCalls) {
      const reason = `agent-call budget exhausted (${agentCallCounter.count} >= ${cfg.maxAgentCalls} calls)`;
      appendEvent(cfg.repoRoot, "budget_exhausted", { reason, agentCalls: agentCallCounter.count, iteration }, cfg.runsRoot, cfg.stateFile);
      const st = loadState(cfg.repoRoot, cfg.stateFile)!;
      const pending = getNextTask(st);
      if (pending) setTaskStatus(cfg.repoRoot, cfg.stateFile, cfg.runsRoot, pending.id, "needs_human", { at: new Date().toISOString(), phase: "budget", reason, resultFile: "" });
      throw new LoopError(`Circuit breaker tripped: ${reason}. Re-run with a higher budget to continue.`);
    }

    // Pick next task
    const state = loadState(cfg.repoRoot, cfg.stateFile)!;
    let task: Task | null;
    if (cfg.retryTaskId) {
      task = getTasks(state).find((t) => t.id === cfg.retryTaskId) ?? null;
      if (!task) throw new LoopError(`Cannot retry task '${cfg.retryTaskId}': task not found.`);
      if (!["needs_retry", "failed"].includes(task.status ?? "")) throw new LoopError(`Cannot retry '${cfg.retryTaskId}': status is '${task.status}'.`);
    } else {
      task = getNextTask(state);
    }

    if (!task) {
      if (hasUnfinishedTasks(state)) {
        throw new LoopError(`No runnable task available. Blocked by dependencies:\n${getBlockedDependencySummary(state)}`);
      }
      if (cfg.finalizeDocs && cfg.merge) runFinalizeDocsPhase(cfg, agentCallCounter);
      console.log("<promise>COMPLETE</promise>");
      return;
    }

    // Setup run directory and paths
    const taskId   = task.id;
    const safeId   = safeSlug(taskId);
    const branch   = cfg.reviewBranchMode ? `agentic/review/${safeId}` : `agentic/${safeId}`;
    const worktreePath = join(cfg.repoRoot, cfg.worktreeRoot, safeId);
    const ts         = timestamp();
    const runDir     = join(cfg.repoRoot, cfg.runsRoot, `agentic-${ts}-${safeId}`);
    const taskGrillPrompt = join(runDir, "task-grill.md");
    const taskGrillResult = join(runDir, "task-grill-result.json");
    const taskGrillLog    = join(runDir, "task-grill.log");
    const executorPrompt  = join(runDir, "executor.md");
    const verifierPrompt  = join(runDir, "verifier.md");
    const verifierResult  = join(runDir, "verifier-result.json");
    const codeGraphFile   = join(runDir, "codegraph.md");
    const executorLog     = join(runDir, "executor.log");
    const checksLog       = join(runDir, "checks.log");
    const verifierLog     = join(runDir, "verifier.log");
    const handoverFile         = join(runDir, "handover.md");
    const failureAnalysisFile  = join(runDir, "failure-analysis.json");
    const stateBefore          = join(runDir, "state-before.json");
    const stateAfter           = join(runDir, "state-after.json");

    console.log(`=== Agentic iteration ${iteration}/${cfg.maxIterations}: ${taskId} ===`);
    appendEvent(cfg.repoRoot, "iteration_started", { task: taskId, iteration, runDir, branch, worktree: worktreePath }, cfg.runsRoot, cfg.stateFile);
    mkdirSync(runDir, { recursive: true });
    copyFileSync(join(cfg.repoRoot, cfg.stateFile), stateBefore);
    addTaskAttempt(cfg.repoRoot, cfg.stateFile, cfg.runsRoot, taskId, runDir);
    // Re-read task after attempt stamp
    task = getTasks(loadState(cfg.repoRoot, cfg.stateFile)!).find((t) => t.id === taskId)!;
    setTaskStatus(cfg.repoRoot, cfg.stateFile, cfg.runsRoot, taskId, "running");

    // Ensure worktree
    if (!worktreeExists(worktreePath)) {
      createWorktree(branch, worktreePath, "HEAD", cfg.repoRoot);
    }

    try {
      // Task-grill: re-check understanding immediately before execution.
      writeCodeGraphContext(codeGraphFile, worktreePath);
      writeTaskGrillPrompt(taskGrillPrompt, {
        repoRoot: cfg.repoRoot,
        runsRoot: cfg.runsRoot,
        stateFile: cfg.stateFile,
        budget: cfg.budget,
        task,
        iteration,
        runDir,
        resultFile: taskGrillResult,
        eventLogPath,
        codeGraphFile,
        policy,
        priorFailureAnalysisFile: getLastFailureAnalysisFile(task),
      });
      appendEvent(cfg.repoRoot, "task_grill_started", { task: taskId, prompt: taskGrillPrompt, resultFile: taskGrillResult, log: taskGrillLog }, cfg.runsRoot, cfg.stateFile);
      agentCallCounter.count++;
      invokeAgentWithLog(taskGrillPrompt, cfg.agent, worktreePath, taskGrillLog);
      if (!existsSync(taskGrillResult)) throw new LoopError(`Task grill did not write ${taskGrillResult}`);
      const taskGrillResultObj = JSON.parse(readFileSync(taskGrillResult, "utf-8")) as TaskGrillResult;
      appendEvent(cfg.repoRoot, "task_grill_finished", { task: taskId, verdict: taskGrillResultObj.verdict, resultFile: taskGrillResult, understanding: taskGrillResultObj.understanding }, cfg.runsRoot, cfg.stateFile);

      if (taskGrillResultObj.verdict !== "ready") {
        if (taskGrillResultObj.verdict === "needs_replan") {
          const reason = [
            "task-grill requested replanning",
            taskGrillResultObj.understanding ?? "",
            ...(taskGrillResultObj.risks ?? []),
          ].filter(Boolean).join("; ");

          // Replan budget guard
          sessionReplanCount++;
          if (cfg.maxReplans > 0 && sessionReplanCount > cfg.maxReplans) {
            const budgetReason = `replan budget exhausted (${sessionReplanCount - 1} replans >= maxReplans ${cfg.maxReplans}); stopping to avoid thrash. Last reason: ${reason}`;
            setTaskStatus(cfg.repoRoot, cfg.stateFile, cfg.runsRoot, taskId, "needs_human", { at: new Date().toISOString(), phase: "task_grill", reason: budgetReason, resultFile: taskGrillResult });
            appendEvent(cfg.repoRoot, "replan_budget_exhausted", { task: taskId, sessionReplanCount, maxReplans: cfg.maxReplans, reason: budgetReason }, cfg.runsRoot, cfg.stateFile);
            copyFileSync(join(cfg.repoRoot, cfg.stateFile), stateAfter);
            throw new LoopError(`Replan budget exhausted for ${taskId}: ${budgetReason}`);
          }

          // Capture last replan's task IDs before this replan overwrites them
          const preReplanState = loadState(cfg.repoRoot, cfg.stateFile)!;
          const prevReplanTaskIds = (preReplanState.lastReplanTaskIds ?? []).slice().sort().join(",");

          setTaskStatus(cfg.repoRoot, cfg.stateFile, cfg.runsRoot, taskId, "blocked", { at: new Date().toISOString(), phase: "task_grill", reason, resultFile: taskGrillResult });
          appendEvent(cfg.repoRoot, "task_replan_requested", { task: taskId, reason, resultFile: taskGrillResult, sessionReplanCount }, cfg.runsRoot, cfg.stateFile);

          const replanTask = getTasks(loadState(cfg.repoRoot, cfg.stateFile)!).find((t) => t.id === taskId);
          const newTaskIds = runPlannerPhase(cfg, policy, agentCallCounter, replanTask ? getLastFailureAnalysisFile(replanTask) : "");
          const newTaskIdsKey = newTaskIds.slice().sort().join(",");

          // Non-convergence detection: if this replan produced the same task IDs as the previous replan, it's thrashing
          if (prevReplanTaskIds.length > 0 && newTaskIdsKey === prevReplanTaskIds) {
            const thrashReason = `replan produced the same task set as the previous replan (${newTaskIdsKey}); stopping to avoid infinite loop`;
            const afterState = loadState(cfg.repoRoot, cfg.stateFile)!;
            appendEvent(cfg.repoRoot, "replan_convergence_failure", { task: taskId, taskIds: newTaskIdsKey, sessionReplanCount }, cfg.runsRoot, cfg.stateFile);
            for (const t of getTasks(afterState).filter((t) => t.status === "pending" || t.status === "needs_retry")) {
              setTaskStatus(cfg.repoRoot, cfg.stateFile, cfg.runsRoot, t.id, "needs_human", { at: new Date().toISOString(), phase: "replan_convergence", reason: thrashReason, resultFile: "" });
            }
            copyFileSync(join(cfg.repoRoot, cfg.stateFile), stateAfter);
            throw new LoopError(`Replan convergence failure: ${thrashReason}`);
          }

          copyFileSync(join(cfg.repoRoot, cfg.stateFile), stateAfter);
          continue;
        }

        const status = taskGrillResultObj.verdict === "blocked" ? "blocked" : "needs_human";
        const reason = [
          `task-grill verdict=${taskGrillResultObj.verdict}`,
          taskGrillResultObj.understanding ?? "",
          ...(taskGrillResultObj.risks ?? []),
        ].filter(Boolean).join("; ");
        setTaskStatus(cfg.repoRoot, cfg.stateFile, cfg.runsRoot, taskId, status, { at: new Date().toISOString(), phase: "task_grill", reason, resultFile: taskGrillResult });
        copyFileSync(join(cfg.repoRoot, cfg.stateFile), stateAfter);
        throw new LoopError(`Task grill stopped ${taskId} before executor edits: ${reason}`);
      }

      // Warn when no scope is declared — the diff-scope rail cannot bound the change
      if (isTaskUnscoped(task as any)) {
        const warnMsg = `Task ${taskId} has no declared scope. The diff-scope rail is inactive for this task; all file changes will be allowed. Declare 'scope' globs in the task to enable scope enforcement.`;
        console.warn(warnMsg);
        appendEvent(cfg.repoRoot, "scope_missing_warning", { task: taskId, reason: warnMsg }, cfg.runsRoot, cfg.stateFile);
      }

      // Executor
      writeExecutorPrompt(executorPrompt, {
        repoRoot: cfg.repoRoot,
        runsRoot: cfg.runsRoot,
        stateFile: cfg.stateFile,
        budget: cfg.budget,
        task,
        iteration,
        runDir,
        eventLogPath,
        codeGraphFile,
        policy,
        taskGrillResult: taskGrillResultObj,
      });

      appendEvent(cfg.repoRoot, "executor_started", { task: taskId, prompt: executorPrompt, log: executorLog }, cfg.runsRoot, cfg.stateFile);
      try {
        agentCallCounter.count++;
        invokeAgentWithLog(executorPrompt, cfg.agent, worktreePath, executorLog);
        appendEvent(cfg.repoRoot, "executor_passed", { task: taskId, log: executorLog }, cfg.runsRoot, cfg.stateFile);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        appendEvent(cfg.repoRoot, "executor_failed", { task: taskId, reason: msg, log: executorLog }, cfg.runsRoot, cfg.stateFile);
        setTaskStatus(cfg.repoRoot, cfg.stateFile, cfg.runsRoot, taskId, "needs_human", { at: new Date().toISOString(), phase: "executor", reason: msg, resultFile: verifierResult });
        writeChecksLog(checksLog, "Checks not run because executor failed.");
        writeDiffArtifacts(worktreePath, runDir);
        copyFileSync(join(cfg.repoRoot, cfg.stateFile), stateAfter);
        throw new LoopError(`Executor failed for ${taskId}. Worktree retained at ${worktreePath}. ${msg}`);
      }

      // Checks
      const baseChecks = getTaskChecks(task, loadState(cfg.repoRoot, cfg.stateFile)!);
      const taskChecks = [...new Set([...baseChecks, ...cfg.extraChecks])];
      appendEvent(cfg.repoRoot, "checks_started", { task: taskId, commands: taskChecks, log: checksLog }, cfg.runsRoot, cfg.stateFile);
      let checkOutput: string;
      try {
        checkOutput = invokeChecks(worktreePath, taskChecks, cfg.checkTimeoutSeconds || 120);
        writeChecksLog(checksLog, checkOutput);
        const metrics = parseMetricLines(checkOutput);
        appendEvent(cfg.repoRoot, "checks_passed", { task: taskId, log: checksLog, metrics }, cfg.runsRoot, cfg.stateFile);
      } catch (err) {
        checkOutput = err instanceof Error ? err.message : String(err);
        writeChecksLog(checksLog, checkOutput);
        const failureStatus = getFailureStatusForTask(task, "checks", cfg.maxRetries);
        const metrics = parseMetricLines(checkOutput);
        appendEvent(cfg.repoRoot, "checks_failed", { task: taskId, status: failureStatus, reason: checkOutput, log: checksLog, metrics }, cfg.runsRoot, cfg.stateFile);
        writeFailureAnalysis({ taskId, phase: "checks", attempt: task.attempts ?? 1, rawOutput: checkOutput, worktreePath, outputFile: failureAnalysisFile });
        setTaskStatus(cfg.repoRoot, cfg.stateFile, cfg.runsRoot, taskId, failureStatus, { at: new Date().toISOString(), phase: "checks", reason: checkOutput, resultFile: verifierResult, failureAnalysisFile });
        writeDiffArtifacts(worktreePath, runDir);
        copyFileSync(join(cfg.repoRoot, cfg.stateFile), stateAfter);
        if (failureStatus === "needs_retry") { console.warn(`Checks failed for ${taskId}; marked ${failureStatus}.`); continue; }
        throw new LoopError(`Checks failed for ${taskId}; marked ${failureStatus}. Worktree retained at ${worktreePath}.\n${checkOutput}`);
      }

      writeDiffArtifacts(worktreePath, runDir);

      // Scope rail
      const taskScope = getTaskScope(task as any);
      if (taskScope.length > 0) {
        const outOfScope = getOutOfScopeFiles(worktreePath, taskScope);
        if (outOfScope.length > 0) {
          const scopeReason = `Out-of-scope changes for ${taskId} (declared scope: ${taskScope.join(", ")}): ${outOfScope.join(", ")}`;
          const failureStatus = getFailureStatusForTask(task, "checks", cfg.maxRetries);
          appendEvent(cfg.repoRoot, "scope_violation", { task: taskId, status: failureStatus, outOfScope, scope: taskScope }, cfg.runsRoot, cfg.stateFile);
          writeChecksLog(checksLog, `${checkOutput}\n\nSCOPE VIOLATION: ${scopeReason}`);
          writeFailureAnalysis({ taskId, phase: "scope", attempt: task.attempts ?? 1, rawOutput: scopeReason, worktreePath, outputFile: failureAnalysisFile });
          setTaskStatus(cfg.repoRoot, cfg.stateFile, cfg.runsRoot, taskId, failureStatus, { at: new Date().toISOString(), phase: "scope", reason: scopeReason, resultFile: verifierResult, failureAnalysisFile });
          copyFileSync(join(cfg.repoRoot, cfg.stateFile), stateAfter);
          if (failureStatus === "needs_retry") { console.warn(scopeReason); continue; }
          throw new LoopError(`Scope violation for ${taskId}; marked ${failureStatus}. ${scopeReason}`);
        }
        appendEvent(cfg.repoRoot, "scope_passed", { task: taskId, scope: taskScope }, cfg.runsRoot, cfg.stateFile);
      }

      // Rebase-before-verify gate: rebase on loop-start HEAD, re-run checks to catch integration issues
      if (cfg.rebaseBeforeVerify && loopBaseRef) {
        const currentHead = (() => { try { return git(["rev-parse", "HEAD"], worktreePath); } catch { return ""; } })();
        const baseRefResolved = (() => { try { return git(["rev-parse", loopBaseRef], cfg.repoRoot); } catch { return loopBaseRef; } })();
        if (currentHead !== baseRefResolved) {
          appendEvent(cfg.repoRoot, "rebase_before_verify_started", { task: taskId, loopBaseRef }, cfg.runsRoot, cfg.stateFile);
          try {
            git(["rebase", loopBaseRef], worktreePath);
            appendEvent(cfg.repoRoot, "rebase_before_verify_passed", { task: taskId, loopBaseRef }, cfg.runsRoot, cfg.stateFile);
          } catch (rebaseErr) {
            try { git(["rebase", "--abort"], worktreePath); } catch { /* non-fatal */ }
            const rebaseMsg = rebaseErr instanceof Error ? rebaseErr.message : String(rebaseErr);
            const rebaseFailStatus = getFailureStatusForTask(task, "checks", cfg.maxRetries);
            appendEvent(cfg.repoRoot, "rebase_before_verify_failed", { task: taskId, loopBaseRef, reason: rebaseMsg }, cfg.runsRoot, cfg.stateFile);
            setTaskStatus(cfg.repoRoot, cfg.stateFile, cfg.runsRoot, taskId, rebaseFailStatus, { at: new Date().toISOString(), phase: "rebase_before_verify", reason: rebaseMsg, resultFile: verifierResult });
            copyFileSync(join(cfg.repoRoot, cfg.stateFile), stateAfter);
            if (rebaseFailStatus === "needs_retry") { console.warn(`Rebase failed for ${taskId}; marked ${rebaseFailStatus}.`); continue; }
            throw new LoopError(`Rebase-before-verify failed for ${taskId}; worktree retained at ${worktreePath}. ${rebaseMsg}`);
          }
          // Re-run checks post-rebase to catch integration failures
          const rebaseCheckCmds = [...new Set([...getTaskChecks(task, loadState(cfg.repoRoot, cfg.stateFile)!), ...cfg.extraChecks])];
          appendEvent(cfg.repoRoot, "rebase_checks_started", { task: taskId, commands: rebaseCheckCmds }, cfg.runsRoot, cfg.stateFile);
          try {
            checkOutput = invokeChecks(worktreePath, rebaseCheckCmds, cfg.checkTimeoutSeconds || 120);
            appendEvent(cfg.repoRoot, "rebase_checks_passed", { task: taskId }, cfg.runsRoot, cfg.stateFile);
          } catch (err) {
            checkOutput = err instanceof Error ? err.message : String(err);
            const rebaseCheckFailStatus = getFailureStatusForTask(task, "checks", cfg.maxRetries);
            appendEvent(cfg.repoRoot, "rebase_checks_failed", { task: taskId, status: rebaseCheckFailStatus, reason: checkOutput }, cfg.runsRoot, cfg.stateFile);
            writeFailureAnalysis({ taskId, phase: "rebase_checks", attempt: task.attempts ?? 1, rawOutput: checkOutput, worktreePath, outputFile: failureAnalysisFile });
            setTaskStatus(cfg.repoRoot, cfg.stateFile, cfg.runsRoot, taskId, rebaseCheckFailStatus, { at: new Date().toISOString(), phase: "rebase_checks", reason: checkOutput, resultFile: verifierResult, failureAnalysisFile });
            writeDiffArtifacts(worktreePath, runDir);
            copyFileSync(join(cfg.repoRoot, cfg.stateFile), stateAfter);
            if (rebaseCheckFailStatus === "needs_retry") { console.warn(`Post-rebase checks failed for ${taskId}; marked ${rebaseCheckFailStatus}.`); continue; }
            throw new LoopError(`Post-rebase checks failed for ${taskId}; marked ${rebaseCheckFailStatus}. Worktree retained at ${worktreePath}.\n${checkOutput}`);
          }
        }
      }

      // Fast-verifier gate
      const fvDecision = cfg.fastVerifier ? testFastVerifierAllowed(task as any) : { allowed: false, reason: "fast-verifier not requested" };
      if (cfg.fastVerifier && !fvDecision.allowed) {
        appendEvent(cfg.repoRoot, "verifier_skip_denied", { task: taskId, reason: fvDecision.reason }, cfg.runsRoot, cfg.stateFile);
        console.log(`fast-verifier denied for ${taskId}; running full verifier: ${fvDecision.reason}`);
      }

      let verifierResultObj: VerifierResult;
      if (cfg.fastVerifier && fvDecision.allowed) {
        verifierResultObj = { verdict: "pass", summary: `fast-verifier: checks passed; separate verifier skipped (low-risk task: ${fvDecision.reason})`, issues: [], humanGates: [], recommendedStatus: "passed", artifacts: [] };
        writeFileSync(verifierResult, JSON.stringify(verifierResultObj, null, 2), "utf-8");
        writeFileSync(verifierLog, "fast-verifier: skipped separate verifier after checks passed.", "utf-8");
        appendEvent(cfg.repoRoot, "verifier_skipped", { task: taskId, resultFile: verifierResult, log: verifierLog, reason: "fast-verifier" }, cfg.runsRoot, cfg.stateFile);
      } else {
        const votes = resolveVerifierVotes(task, policy, cfg.verifierVotes);
        const adversarial = votes > 1;

        if (votes <= 1) {
          writeVerifierPrompt(verifierPrompt, { repoRoot: cfg.repoRoot, runsRoot: cfg.runsRoot, stateFile: cfg.stateFile, budget: cfg.budget, task, worktreePath, checkOutput, resultFile: verifierResult, eventLogPath, policy, adversarial: false });
          appendEvent(cfg.repoRoot, "verifier_started", { task: taskId, prompt: verifierPrompt, resultFile: verifierResult, log: verifierLog, votes: 1 }, cfg.runsRoot, cfg.stateFile);
          agentCallCounter.count++;
          invokeAgentWithLog(verifierPrompt, cfg.verifierAgent, worktreePath, verifierLog);
          if (!existsSync(verifierResult)) throw new LoopError(`Verifier did not write ${verifierResult}`);
          verifierResultObj = JSON.parse(readFileSync(verifierResult, "utf-8")) as VerifierResult;
        } else {
          appendEvent(cfg.repoRoot, "verifier_votes_started", { task: taskId, votes, adversarial: true }, cfg.runsRoot, cfg.stateFile);
          const voteResults: VerifierResult[] = [];
          for (let v = 1; v <= votes; v++) {
            const vPrompt = join(runDir, `verifier-vote-${v}.md`);
            const vResult = join(runDir, `verifier-vote-${v}.json`);
            const vLog    = join(runDir, `verifier-vote-${v}.log`);
            writeVerifierPrompt(vPrompt, { repoRoot: cfg.repoRoot, runsRoot: cfg.runsRoot, stateFile: cfg.stateFile, budget: cfg.budget, task, worktreePath, checkOutput, resultFile: vResult, eventLogPath, policy, adversarial });
            appendEvent(cfg.repoRoot, "verifier_started", { task: taskId, prompt: vPrompt, resultFile: vResult, log: vLog, vote: v, votes }, cfg.runsRoot, cfg.stateFile);
            agentCallCounter.count++;
            invokeAgentWithLog(vPrompt, cfg.verifierAgent, worktreePath, vLog);
            if (!existsSync(vResult)) throw new LoopError(`Verifier vote ${v} did not write ${vResult}`);
            const vr = JSON.parse(readFileSync(vResult, "utf-8")) as VerifierResult;
            voteResults.push(vr);
            appendEvent(cfg.repoRoot, "verifier_vote", { task: taskId, vote: v, verdict: vr.verdict, summary: vr.summary }, cfg.runsRoot, cfg.stateFile);
          }
          const passCount      = voteResults.filter((r) => r.verdict === "pass").length;
          const needsHumanCount = voteResults.filter((r) => r.verdict === "needs_human").length;
          const majority = Math.floor(votes / 2) + 1;
          const finalVerdict: VerifierResult["verdict"] =
            needsHumanCount > 0 && passCount < majority ? "needs_human"
            : passCount >= majority ? "pass"
            : "fail";
          const issues = voteResults.flatMap((r) => r.issues ?? []).filter(Boolean);
          verifierResultObj = {
            verdict: finalVerdict,
            summary: `adversarial ${votes}-vote verdict: ${passCount} pass / ${votes - passCount - needsHumanCount} fail / ${needsHumanCount} needs_human (majority=${majority}) -> ${finalVerdict}`,
            issues,
            humanGates: [],
            recommendedStatus: finalVerdict === "pass" ? "passed" : finalVerdict === "needs_human" ? "needs_human" : "needs_retry",
            artifacts: [],
          };
          writeFileSync(verifierResult, JSON.stringify(verifierResultObj, null, 2), "utf-8");
          writeFileSync(verifierLog, verifierResultObj.summary ?? "", "utf-8");
          appendEvent(cfg.repoRoot, "verifier_votes_finished", { task: taskId, votes, passCount, needsHuman: needsHumanCount, verdict: finalVerdict }, cfg.runsRoot, cfg.stateFile);
        }
      }

      appendEvent(cfg.repoRoot, "verifier_finished", { task: taskId, verdict: verifierResultObj.verdict, summary: verifierResultObj.summary, resultFile: verifierResult }, cfg.runsRoot, cfg.stateFile);

      // Handle verdict
      if (verifierResultObj.verdict === "pass") {
        if (cfg.commit) {
          git(["add", "-A"], worktreePath);
          const changed = (() => { try { return git(["status", "--porcelain"], worktreePath); } catch { return ""; } })();
          if (changed) git(["commit", "-m", `agentic: complete ${taskId}`], worktreePath);
          else console.log(`No changes to commit for ${taskId}.`);
        }
        if (cfg.merge) {
          const branchHead = git(["rev-parse", branch], cfg.repoRoot);
          const mainHead   = git(["rev-parse", "HEAD"], cfg.repoRoot);
          if (branchHead !== mainHead) {
            if      (cfg.mergeMode === "ff-only")     git(["merge", "--ff-only", branch], cfg.repoRoot);
            else if (cfg.mergeMode === "no-ff")       git(["merge", "--no-ff", branch, "-m", `agentic: merge ${taskId}`], cfg.repoRoot);
            else if (cfg.mergeMode === "cherry-pick") git(["cherry-pick", branch], cfg.repoRoot);
          } else {
            console.log(`No tracked branch changes to merge for ${taskId}.`);
          }
        }
        if (cfg.reviewBranchMode) setTaskPassed(cfg.repoRoot, cfg.stateFile, cfg.runsRoot, taskId, verifierResultObj, branch, worktreePath);
        else setTaskPassed(cfg.repoRoot, cfg.stateFile, cfg.runsRoot, taskId, verifierResultObj);

        if (!cfg.merge && cfg.autoAcceptPassed) {
          // auto-accept: integrate + clean up inline
          try {
            git(["merge", "--ff-only", branch], cfg.repoRoot);
            if (worktreeExists(worktreePath)) removeWorktree(worktreePath, cfg.repoRoot);
            git(["branch", "-D", branch], cfg.repoRoot);
          } catch (err) {
            copyFileSync(join(cfg.repoRoot, cfg.stateFile), stateAfter);
            const msg = err instanceof Error ? err.message : String(err);
            throw new LoopError(`Auto-accept failed for ${taskId}. Worktree retained at ${worktreePath}. ${msg}`);
          }
        }

        // Write handover if executor didn't
        if (!existsSync(handoverFile)) {
          const diffStatForHandover = (() => { try { return readFileSync(join(runDir, "diff-stat.txt"), "utf-8"); } catch { return ""; } })();
          writeFileSync(handoverFile, [
            `# Task handover: ${taskId}`,
            "",
            "## Summary",
            verifierResultObj.summary ?? "",
            "",
            "## Validation",
            `See checks log: ${checksLog}`,
            `Verifier result: ${verifierResult}`,
            "",
            "## Changed files",
            diffStatForHandover,
            "",
            "## Next-task notes",
            "No executor-authored handover was found, so the harness generated this fallback from verifier/check artifacts.",
          ].join("\n"), "utf-8");
        }
        appendEvent(cfg.repoRoot, "task_handover_written", { task: taskId, path: handoverFile }, cfg.runsRoot, cfg.stateFile);
        copyFileSync(join(cfg.repoRoot, cfg.stateFile), stateAfter);
        appendProgress(join(cfg.repoRoot, cfg.runsRoot), taskId, verifierResultObj.summary ?? "", handoverFile);
        if (cfg.cleanupPassed && worktreeExists(worktreePath)) removeWorktree(worktreePath, cfg.repoRoot);
        if (cfg.retryTaskId) { console.log("<promise>COMPLETE</promise>"); return; }

      } else if (verifierResultObj.verdict === "needs_human") {
        writeFailureAnalysis({ taskId, phase: "verifier", attempt: task.attempts ?? 1, rawOutput: [verifierResultObj.summary ?? "", ...(verifierResultObj.issues ?? [])].filter(Boolean).join("\n"), worktreePath, outputFile: failureAnalysisFile });
        setTaskStatus(cfg.repoRoot, cfg.stateFile, cfg.runsRoot, taskId, "needs_human", { at: new Date().toISOString(), phase: "verifier", reason: verifierResultObj.summary ?? "", resultFile: verifierResult, failureAnalysisFile });
        copyFileSync(join(cfg.repoRoot, cfg.stateFile), stateAfter);
        throw new LoopError(`Verifier returned needs_human for ${taskId}. Worktree retained at ${worktreePath}.`);

      } else {
        const failureStatus = getFailureStatusForTask(task, "verifier", cfg.maxRetries);
        writeFailureAnalysis({ taskId, phase: "verifier", attempt: task.attempts ?? 1, rawOutput: [verifierResultObj.summary ?? "", ...(verifierResultObj.issues ?? [])].filter(Boolean).join("\n"), worktreePath, outputFile: failureAnalysisFile });
        setTaskStatus(cfg.repoRoot, cfg.stateFile, cfg.runsRoot, taskId, failureStatus, { at: new Date().toISOString(), phase: "verifier", reason: verifierResultObj.summary ?? "", resultFile: verifierResult, failureAnalysisFile });
        copyFileSync(join(cfg.repoRoot, cfg.stateFile), stateAfter);
        if (failureStatus === "needs_retry") { console.warn(`Verifier failed ${taskId}; marked ${failureStatus}.`); continue; }
        throw new LoopError(`Verifier failed ${taskId}; marked ${failureStatus}. Worktree retained at ${worktreePath}.`);
      }

    } catch (err) {
      if (err instanceof LoopError) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      setTaskStatus(cfg.repoRoot, cfg.stateFile, cfg.runsRoot, taskId, "needs_human", { at: new Date().toISOString(), phase: "harness", reason: msg, resultFile: verifierResult });
      if (!existsSync(checksLog)) writeChecksLog(checksLog, "Checks did not complete before harness failure.");
      if (!existsSync(join(runDir, "diff.patch"))) writeDiffArtifacts(worktreePath, runDir);
      copyFileSync(join(cfg.repoRoot, cfg.stateFile), stateAfter);
      throw new LoopError(`Task ${taskId} failed in harness; marked needs_human. Worktree retained at ${worktreePath}. ${msg}`);
    }
  }

  // Post-loop: check if everything finished
  const finalState = loadState(cfg.repoRoot, cfg.stateFile)!;
  if (!getNextTask(finalState)) {
    if (hasUnfinishedTasks(finalState)) {
      throw new LoopError(`Reached max iterations or no runnable task. Blocked by dependencies:\n${getBlockedDependencySummary(finalState)}`);
    }
    if (cfg.finalizeDocs && cfg.merge) runFinalizeDocsPhase(cfg, agentCallCounter);
    console.log("<promise>COMPLETE</promise>");
    return;
  }

  const tasks = getTasks(finalState);
  const completed = tasks.filter((t) => t.status === "passed").length;
  const unfinished = tasks.filter((t) => !["passed", "blocked"].includes(t.status ?? "")).length;
  throw new LoopError(
    `Reached max iterations (${cfg.maxIterations}) with unfinished tasks: completed ${completed} of ${tasks.length}; ${unfinished} unfinished. Re-run with a higher --max-iterations value to continue.`,
    1
  );
}
