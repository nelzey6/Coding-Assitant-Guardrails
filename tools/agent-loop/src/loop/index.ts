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
  updateAssumptionsFromGrill,
  recordDecisions,
  mergePlannerResult,
  type AgenticState,
  type Task,
  type PlannerResult,
  type VerifierResult,
} from "../state/index.js";
import { appendEvent } from "../events/index.js";
import { safeSlug, createWorktree, worktreeExists, removeWorktree, git as gitTool, GitError, CheckoutMutationError, withUnchangedCheckout } from "../tools/index.js";
import { invokeAgent, invokeAgentWithLog, getTaskChecks, type AgentConfig, type AgentInvocationResult } from "../agent/index.js";
import { invokeChecks, parseMetricLines } from "../checks/index.js";
import { getTaskScope, getOutOfScopeFiles, isTaskUnscoped, resolveTaskComplexity, testPathInScope, testPathsAreDocumentation } from "../scope/index.js";
import {
  syncCodeGraph,
  writeCodeGraphContext,
  writeRepoContext,
  writePlannerPrompt,
  writeTaskGrillPrompt,
  writeExecutorPrompt,
  writeVerifierPrompt,
  writeFinalizeDocsPrompt,
  writeFinalizeDocsVerifierPrompt,
  writeGoalReviewPrompt,
  writeArchitectCheckpointPrompt,
  writeDecisionGrillPrompt,
  writePreflightPrompt,
  writePostTaskReviewPrompt,
  writeBundledReviewPrompt,
  writeStanceReflectionPrompt,
  validatePlannerResult,
  validateDecisions,
  getPromptBudgetLimits,
  writeFailureAnalysis,
  type PromptBudget,
} from "../prompts/index.js";
import { loadPolicy, resolvePlannerMode, type WorkflowPolicy } from "../policy/index.js";
import { runShellScript } from "../tools/shell.js";
import {
  shouldRunFinalizeDocs,
  shouldRunPostTaskReview,
  shouldRunTaskGrill,
  shouldRunVerifier,
} from "../admission/index.js";

export interface LoopConfig {
  repoRoot: string;
  stateFile?: string;
  runsRoot?: string;
  worktreeRoot?: string;
  /** Default agent used for any phase that does not have its own override. */
  agent: AgentConfig;
  /** High-effort planning phases: initial planner, replan, architect checkpoint, goal review. Falls back to agent. */
  plannerAgent?: AgentConfig;
  /** Planner admission: auto uses planner-lite only for conservative low-risk goals. */
  plannerMode?: "auto" | "lite" | "full";
  /** Per-task critical-thinking phases: task-grill, decision-grill, post-task review. Falls back to agent. */
  grillAgent?: AgentConfig;
  /** Executor phase: the agent that edits files. Falls back to agent. */
  executorAgent?: AgentConfig;
  /** Verifier phase. Falls back to agent. */
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
  /** Shell commands run inside each worktree before task-grill/checks. */
  worktreeBootstrap?: string[];
  /** Worktree-relative paths owned by bootstrap and ignored by scope/diff/commit. */
  worktreeBootstrapIgnore?: string[];
  /** Env file, relative to worktree or absolute, loaded for checks. */
  checkEnvFile?: string;
  /** Run a goal-review agent after all tasks pass, before finalize-docs. Halts on needs_human. */
  goalReview?: boolean;
  /** Reassess the remaining plan after every passed task. */
  postTaskReview?: boolean;
  /** Run an architect checkpoint every N passed tasks (0 = disabled). */
  architectCheckpointInterval?: number;
  /** Run a grill-with-docs self-interview before each executor turn; escalates low-confidence decisions. */
  decisionGrill?: boolean;
  budget?: PromptBudget;
  planOnly?: boolean;
  retryTaskId?: string;
  commit?: boolean;
  merge?: boolean;
  /** After all tasks pass, copy changed files from the run worktree into the main tree as unstaged changes. Default: true. */
  apply?: boolean;
  mergeMode?: "ff-only" | "no-ff" | "cherry-pick";
  reviewBranchMode?: boolean;
  autoAcceptPassed?: boolean;
  cleanupPassed?: boolean;
  fastVerifier?: boolean;
  finalizeDocs?: boolean;
  allowDirty?: boolean;
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
  assumptionsStillValid?: string[];
  assumptionsChanged?: string[];
}

export function git(args: string[], cwd?: string): string {
  try {
    return gitTool(args, cwd);
  } catch (err) {
    const msg = err instanceof GitError ? err.message : String(err);
    throw new LoopError(msg);
  }
}

export function emitTokenUsage(cfg: Required<LoopConfig>, invocation: AgentInvocationResult, taskId?: string): void {
  appendEvent(cfg.repoRoot, "agent_invocation_finished", {
    ...(taskId ? { task: taskId } : {}),
    phase: invocation.phase,
    tool: invocation.tool,
    telemetryStatus: invocation.telemetryStatus,
    startedAt: invocation.startedAt,
    finishedAt: invocation.finishedAt,
    durationMs: invocation.durationMs,
    assistantTurns: invocation.assistantTurns,
    toolCalls: invocation.toolCalls,
    logBytes: invocation.logBytes,
  }, cfg.runsRoot, cfg.stateFile);
  const usage = invocation.usage;
  if (!usage) return;
  appendEvent(cfg.repoRoot, "token_usage", {
    ...(taskId ? { task: taskId } : {}),
    phase: usage.phase,
    tool: usage.tool,
    input: usage.input,
    output: usage.output,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
    totalTokens: usage.totalTokens,
    ...(usage.costUsd !== null ? { costUsd: usage.costUsd } : {}),
  }, cfg.runsRoot, cfg.stateFile);
}

function timestamp(): string {
  return new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
}

function pathspecExcludes(paths: string[]): string[] {
  return expandIgnoredPaths(paths).map((p) => `:(exclude)${p}`);
}

const HARNESS_OWNED_IGNORES = [".codegraph/**"];

function harnessIgnoredPaths(configured: string[]): string[] {
  return [...new Set([...configured, ...HARNESS_OWNED_IGNORES])];
}

function expandIgnoredPaths(paths: string[]): string[] {
  const expanded: string[] = [];
  for (const path of paths) {
    const normalized = path.replace(/\\/g, "/").replace(/^\/+/, "").trim();
    if (!normalized) continue;
    expanded.push(normalized);
    if (normalized.endsWith("/**")) expanded.push(normalized.slice(0, -3));
  }
  return [...new Set(expanded)];
}

function writeDiffArtifacts(worktreePath: string, runDir: string, ignoredPaths: string[] = []): void {
  try { execFileSync("git", ["-C", worktreePath, "add", "-N", "."], { stdio: "ignore" }); } catch { /* non-fatal */ }
  const excludes = pathspecExcludes(ignoredPaths);
  const diffArgs = excludes.length > 0 ? ["diff", "HEAD", "--", ".", ...excludes] : ["diff", "HEAD"];
  const statArgs = excludes.length > 0 ? ["diff", "--stat", "HEAD", "--", ".", ...excludes] : ["diff", "--stat", "HEAD"];
  const patch = (() => { try { return git(diffArgs, worktreePath); } catch { return ""; } })();
  const stat  = (() => { try { return git(statArgs, worktreePath); } catch { return ""; } })();
  writeFileSync(join(runDir, "diff.patch"), patch, "utf-8");
  writeFileSync(join(runDir, "diff-stat.txt"), stat, "utf-8");
}

function writeWorktreeExclude(worktreePath: string, ignoredPaths: string[]): void {
  const normalized = expandIgnoredPaths(ignoredPaths);
  if (normalized.length === 0) return;
  const gitDir = git(["rev-parse", "--git-dir"], worktreePath);
  const infoDir = join(gitDir, "info");
  mkdirSync(infoDir, { recursive: true });
  appendFileSync(join(infoDir, "exclude"), `\n# agentic-loop bootstrap artifacts\n${normalized.join("\n")}\n`, "utf-8");
}

function runWorktreeBootstrap(worktreePath: string, commands: string[], timeoutSeconds: number): string {
  const effective = [...new Set(commands.filter((c) => c && c.trim().length > 0))];
  if (effective.length === 0) return "No worktree bootstrap commands configured.";
  const log: string[] = [];
  for (const command of effective) {
    const output = runShellScript(command, worktreePath, timeoutSeconds > 0 ? timeoutSeconds * 1000 : undefined, "pipe");
    log.push(`PASS: ${command}`);
    if (output) log.push(output);
  }
  return log.join("\n");
}

function isArtifactOnlyTask(task: Task): boolean {
  const workflow = task.workflow ?? "";
  const kind = task.kind ?? "";
  return workflow === "zoom-out" || kind === "discovery" || kind === "investigation";
}

function choosePlannerMode(
  cfg: Required<LoopConfig>,
  state: AgenticState,
  priorFailureAnalysisFile: string
): { mode: "full" | "lite"; reason: string } {
  if (cfg.plannerMode === "full") return { mode: "full", reason: "configured full planner" };
  if (cfg.plannerMode === "lite") return { mode: "lite", reason: "configured planner-lite" };
  if (priorFailureAnalysisFile) return { mode: "full", reason: "replan after failure requires full planner context" };
  if ((state.planRevision ?? 0) > 0) return { mode: "full", reason: "non-initial planning revision requires full planner context" };

  const goal = (state.goal ?? "").trim();
  const lowRiskGoal = goal.length <= 240
    && /\b(add|update|change|edit|document|docs?|wording|sentence|readme|markdown)\b/i.test(goal)
    && /(?:^|\s|[`"'(])(?:[\w./-]+\.md|docs?\/)[\w./-]*/i.test(goal)
    && !/\b(api|architecture|auth|billing|database|delete|dependency|migration|package|permission|public|refactor|schema|security|service|transport|worktree)\b/i.test(goal);
  return lowRiskGoal
    ? { mode: "lite", reason: "short documentation/maintenance goal with no elevated-risk terms" }
    : { mode: "full", reason: "goal does not meet conservative planner-lite admission" };
}

function writeChecksLog(logPath: string, content: string): void {
  mkdirSync(dirname(logPath), { recursive: true });
  writeFileSync(logPath, content, "utf-8");
}

function appendPhaseAdmission(
  cfg: Required<LoopConfig>,
  phase: string,
  decision: { run: boolean; reason: string },
  taskId?: string
): void {
  appendEvent(cfg.repoRoot, decision.run ? "phase_admitted" : "phase_skipped", {
    ...(taskId ? { task: taskId } : {}),
    phase,
    reason: decision.reason,
  }, cfg.runsRoot, cfg.stateFile);
}

function changedPathsSince(worktreePath: string, baseRef: string, ignoredPaths: string[] = []): string[] {
  const names = new Set<string>();
  const collect = (args: string[]): void => {
    try {
      const output = git(args, worktreePath);
      output.split(/\r?\n/).map((path) => path.trim()).filter(Boolean).forEach((path) => names.add(path));
    } catch { /* best effort; finalize gate remains conservative when no diff is available */ }
  };
  if (baseRef) collect(["diff", "--name-only", `${baseRef}..HEAD`]);
  collect(baseRef ? ["diff", "--name-only", baseRef] : ["diff", "--name-only", "HEAD"]);
  const effectiveIgnores = expandIgnoredPaths(ignoredPaths);
  return [...names].filter((path) => !testPathInScope(path, effectiveIgnores)).sort();
}

// After all tasks pass: apply run worktree changes to main tree.
// With cfg.apply (default): copy changed files as unstaged changes in the main tree, delete the run branch + worktree.
// With cfg.merge: merge the run branch into main instead.
function applyRunWorktree(cfg: Required<LoopConfig>, runBranch: string, runWorktreePath: string): void {
  if (!worktreeExists(runWorktreePath)) return;

  if (cfg.merge) {
    const branchHead = (() => { try { return git(["rev-parse", runBranch], cfg.repoRoot); } catch { return ""; } })();
    const mainHead   = (() => { try { return git(["rev-parse", "HEAD"],    cfg.repoRoot); } catch { return ""; } })();
    if (branchHead && branchHead !== mainHead) {
      if      (cfg.mergeMode === "ff-only")     git(["merge", "--ff-only", runBranch], cfg.repoRoot);
      else if (cfg.mergeMode === "no-ff")       git(["merge", "--no-ff", runBranch, "-m", `agentic: merge ${runBranch}`], cfg.repoRoot);
      else if (cfg.mergeMode === "cherry-pick") git(["cherry-pick", runBranch], cfg.repoRoot);
      syncCodeGraph(cfg.repoRoot);
    }
    removeWorktree(runWorktreePath, cfg.repoRoot);
    try { git(["branch", "-D", runBranch], cfg.repoRoot); } catch { /* non-fatal */ }
    return;
  }

  if (cfg.apply) {
    // Checkout the run branch files into the main working tree as unstaged changes.
    try {
      git(["checkout", runBranch, "--", "."], cfg.repoRoot);
      // Unstage everything so the user sees clean unstaged diffs.
      git(["restore", "--staged", "."], cfg.repoRoot);
      syncCodeGraph(cfg.repoRoot);
      console.log(`Applied changes from ${runBranch} to main working tree as unstaged changes.`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`apply failed, worktree retained at ${runWorktreePath}: ${msg}`);
      return;
    }
    removeWorktree(runWorktreePath, cfg.repoRoot);
    try { git(["branch", "-D", runBranch], cfg.repoRoot); } catch { /* non-fatal */ }
  }
}

function appendProgress(runsRoot: string, taskId: string, summary: string, handoverFile: string): void {
  const progressFile = join(runsRoot, "agentic-progress.txt");
  appendFileSync(progressFile, `\n## ${new Date().toISOString()} ${taskId}\n- Verdict: pass\n- Summary: ${summary}\n- Handover: ${handoverFile}\n`, "utf-8");
}

function handleMainWorktreeMutation(
  cfg: Required<LoopConfig>,
  taskId: string,
  mutation: CheckoutMutationError,
  runDir: string,
  worktreePath: string,
  attempt: number,
  failureAnalysisFile: string,
  stateAfter: string,
  verifierResult: string
): void {
  const mutationFile = join(runDir, "parent-worktree-mutation.txt");
  writeFileSync(mutationFile, [
    "The parent checkout changed while the executor was running.",
    "The harness stopped before checks, commit, apply, or merge.",
    "",
    "Status before executor:",
    mutation.before.status || "clean",
    "",
    "Status after executor:",
    mutation.after.status || "clean",
    "",
    `Fingerprint before: ${mutation.before.fingerprint}`,
    `Fingerprint after: ${mutation.after.fingerprint}`,
    `Untracked before: ${mutation.before.untrackedPaths.join(", ") || "none"}`,
    `Untracked after: ${mutation.after.untrackedPaths.join(", ") || "none"}`,
    ...(mutation.actionError ? ["", `Executor also failed: ${mutation.actionError instanceof Error ? mutation.actionError.message : String(mutation.actionError)}`] : []),
  ].join("\n"), "utf-8");
  appendEvent(cfg.repoRoot, "parent_worktree_mutated", {
    task: taskId,
    runDir,
    worktree: worktreePath,
    mutationFile,
    before: mutation.before.status || "clean",
    after: mutation.after.status || "clean",
    executorFailed: mutation.actionError !== undefined,
  }, cfg.runsRoot, cfg.stateFile);
  writeFailureAnalysis({
    taskId,
    phase: "executor_isolation",
    attempt,
    rawOutput: `Parent checkout changed during executor phase. Inspect ${mutationFile}.`,
    worktreePath,
    outputFile: failureAnalysisFile,
  });
  setTaskStatus(cfg.repoRoot, cfg.stateFile, cfg.runsRoot, taskId, "needs_human", {
    at: new Date().toISOString(),
    phase: "executor_isolation",
    reason: `Parent checkout changed during executor phase. Inspect ${mutationFile}.`,
    resultFile: verifierResult,
    failureAnalysisFile,
  });
  writeChecksLog(join(runDir, "checks.log"), "Checks not run because executor mutated the parent checkout.");
  writeDiffArtifacts(worktreePath, runDir, harnessIgnoredPaths(cfg.worktreeBootstrapIgnore));
  copyFileSync(join(cfg.repoRoot, cfg.stateFile), stateAfter);
  throw new LoopError(`Executor isolation failed for ${taskId}: parent checkout changed. Worktree retained at ${worktreePath}.`, 1);
}

// Run the planner phase: build context, invoke planner agent, validate + merge result.
// Returns the task IDs in the new plan (used by callers for convergence detection).
async function runPlannerPhase(
  cfg: Required<LoopConfig>,
  policy: WorkflowPolicy,
  agentCallCounter: { count: number },
  priorFailureAnalysisFile = ""
): Promise<string[]> {
  const ts = timestamp();
  const plannerRunDir = join(cfg.repoRoot, cfg.runsRoot, `agentic-${ts}-planner`);
  mkdirSync(plannerRunDir, { recursive: true });

  const promptFile       = join(plannerRunDir, "planner.md");
  const repoContextFile  = join(plannerRunDir, "repo-context.md");
  const resultFile       = join(plannerRunDir, "planner-result.json");
  const grillFile        = join(plannerRunDir, "grill-transcript.md");
  const codeGraphFile    = join(plannerRunDir, "codegraph.md");
  const plannerLogFile   = join(plannerRunDir, "planner.log");

  const state = loadState(cfg.repoRoot, cfg.stateFile)!;

  const plannerMode = choosePlannerMode(cfg, state, priorFailureAnalysisFile);
  appendEvent(cfg.repoRoot, "planner_mode_selected", {
    mode: plannerMode.mode,
    reason: plannerMode.reason,
  }, cfg.runsRoot, cfg.stateFile);

  if (plannerMode.mode === "full") writeCodeGraphContext(codeGraphFile, cfg.repoRoot);
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
    mode: plannerMode.mode,
    priorFailureAnalysisFile,
  });

  appendEvent(cfg.repoRoot, "planner_started", { runDir: plannerRunDir, prompt: promptFile, resultFile, grillTranscript: grillFile, log: plannerLogFile }, cfg.runsRoot, cfg.stateFile);
  console.log("=== Agentic planner ===");
  agentCallCounter.count++;
  emitTokenUsage(cfg, await invokeAgentWithLog(promptFile, cfg.plannerAgent, cfg.repoRoot, plannerLogFile, "planner"));

  if (!existsSync(resultFile)) throw new LoopError(`Planner did not write ${resultFile}`);
  if (!existsSync(grillFile))  throw new LoopError(`Planner did not write ${grillFile}`);

  let plannerResult = JSON.parse(readFileSync(resultFile, "utf-8")) as Record<string, unknown>;
  let errors = [
    ...validatePlannerResult(plannerResult, policy),
    ...validateDecisions(plannerResult["decisions"] ?? []),
  ];

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
    emitTokenUsage(cfg, await invokeAgentWithLog(repairPrompt, cfg.plannerAgent, cfg.repoRoot, plannerLogFile, "planner-repair"));
    if (!existsSync(resultFile)) throw new LoopError(`Planner repair did not write ${resultFile}`);
    plannerResult = JSON.parse(readFileSync(resultFile, "utf-8")) as Record<string, unknown>;
    errors = [
      ...validatePlannerResult(plannerResult, policy),
      ...validateDecisions(plannerResult["decisions"] ?? []),
    ];
    if (errors.length > 0) throw new LoopError(`Planner result invalid after repair:\n${errors.join("\n")}`);
  }

  appendEvent(cfg.repoRoot, "planner_finished", { runDir: plannerRunDir, verdict: plannerResult["verdict"], resultFile, grillTranscript: grillFile }, cfg.runsRoot, cfg.stateFile);
  const stateAfterPlan = mergePlannerResult(cfg.repoRoot, cfg.stateFile, plannerResult as unknown as PlannerResult);
  if (plannerResult["verdict"] !== "planned") {
    const verdict = String(plannerResult["verdict"] ?? "blocked");
    const reason = [
      `planner verdict=${verdict}`,
      ...(Array.isArray(plannerResult["openQuestions"]) ? plannerResult["openQuestions"] as string[] : []),
      ...(Array.isArray(plannerResult["blockers"]) ? plannerResult["blockers"] as string[] : []),
      typeof plannerResult["summary"] === "string" ? plannerResult["summary"] : "",
    ].filter(Boolean).join("; ");
    appendEvent(cfg.repoRoot, "goal_intake_needs_human", { runDir: plannerRunDir, verdict, reason, resultFile }, cfg.runsRoot, cfg.stateFile);
    throw new LoopError(`Goal intake stopped before execution: ${reason}`);
  }
  return stateAfterPlan.lastReplanTaskIds ?? [];
}

// Run finalize-docs phase after all tasks pass.
// Executor updates PROJECT.md; a single-vote verifier confirms the file was actually updated.
async function runFinalizeDocsPhase(cfg: Required<LoopConfig>, agentCallCounter: { count: number }, runWorktreePath: string): Promise<void> {
  const ts = timestamp();
  const runDir = join(cfg.repoRoot, cfg.runsRoot, `agentic-${ts}-finalize-docs`);
  mkdirSync(runDir, { recursive: true });

  const promptFile    = join(runDir, "finalize-docs.md");
  const executorLog   = join(runDir, "finalize-docs.log");
  const summaryFile   = join(runDir, "final-summary.md");
  const verifierPrompt = join(runDir, "verifier.md");
  const verifierResult = join(runDir, "verifier-result.json");
  const verifierLog    = join(runDir, "verifier.log");

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
  console.log("=== Agentic finalize-docs ===");
  agentCallCounter.count++;
  emitTokenUsage(cfg, await invokeAgentWithLog(promptFile, cfg.executorAgent, cfg.repoRoot, executorLog, "finalize-docs"));

  if (!existsSync(summaryFile)) {
    writeFileSync(summaryFile, `# Agentic final summary\n\nFinalizer did not create a summary; inspect ${executorLog}.`, "utf-8");
  }

  // Skip verifier when the executor reports no durable facts changed.
  let summaryText = "";
  try { summaryText = readFileSync(summaryFile, "utf-8"); } catch { /* empty */ }
  const trivialRun = /(?:no (?:durable|new) (?:facts|changes)|PROJECT\.md (?:was not |unchanged|already up.?to.?date)|nothing (?:to|worth) (?:update|record))/i.test(summaryText);

  let verifierVerdict = "skipped";
  if (trivialRun) {
    appendEvent(cfg.repoRoot, "finalize_docs_verifier_skipped", { runDir, reason: "executor reported no durable facts changed" }, cfg.runsRoot, cfg.stateFile);
  } else {
    writeFinalizeDocsVerifierPrompt(verifierPrompt, {
      repoRoot: cfg.repoRoot,
      runWorktreePath,
      summaryFile,
      resultFile: verifierResult,
    });
    agentCallCounter.count++;
    emitTokenUsage(cfg, await invokeAgentWithLog(verifierPrompt, cfg.verifierAgent, cfg.repoRoot, verifierLog, "finalize-docs-verifier"));

    verifierVerdict = (() => {
      if (!existsSync(verifierResult)) return "fail";
      try { return (JSON.parse(readFileSync(verifierResult, "utf-8")) as { verdict?: string }).verdict ?? "fail"; } catch { return "fail"; }
    })();
  }

  appendEvent(cfg.repoRoot, "finalize_docs_finished", {
    runDir, summary: summaryFile, verifierVerdict,
  }, cfg.runsRoot, cfg.stateFile);

  if (verifierVerdict === "fail") {
    console.warn("finalize-docs verifier returned fail — PROJECT.md may not have been updated. Check:", verifierResult);
  }
}

async function runFinalizeDocsIfNeeded(
  cfg: Required<LoopConfig>,
  policy: WorkflowPolicy,
  agentCallCounter: { count: number },
  runWorktreePath: string,
  loopBaseRef: string
): Promise<void> {
  const changedPaths = changedPathsSince(runWorktreePath, loopBaseRef, harnessIgnoredPaths(cfg.worktreeBootstrapIgnore));
  const decision = shouldRunFinalizeDocs(changedPaths, policy, cfg.finalizeDocs);
  appendPhaseAdmission(cfg, "finalize-docs", decision);
  if (!decision.run) {
    console.log(`Skipping finalize-docs: ${decision.reason}`);
    return;
  }
  await runFinalizeDocsPhase(cfg, agentCallCounter, runWorktreePath);
}

interface GoalReviewResult {
  verdict: "pass" | "needs_human";
  summary?: string;
  gaps?: string[];
}

// Run goal-review phase: one agent call judging cumulative diff vs state.goal.
// Throws LoopError if the agent returns needs_human.
async function runGoalReviewPhase(
  cfg: Required<LoopConfig>,
  agentCallCounter: { count: number },
  loopBaseRef: string
): Promise<void> {
  const ts = timestamp();
  const runDir = join(cfg.repoRoot, cfg.runsRoot, `agentic-${ts}-goal-review`);
  mkdirSync(runDir, { recursive: true });

  const promptFile = join(runDir, "goal-review.md");
  const logFile    = join(runDir, "goal-review.log");
  const resultFile = join(runDir, "goal-review-result.json");

  const state = loadState(cfg.repoRoot, cfg.stateFile)!;
  writeGoalReviewPrompt(promptFile, {
    repoRoot: cfg.repoRoot,
    runsRoot: cfg.runsRoot,
    stateFile: cfg.stateFile,
    budget: cfg.budget,
    state,
    loopBaseRef,
    resultFile,
  });

  appendEvent(cfg.repoRoot, "goal_review_started", { runDir, prompt: promptFile, resultFile }, cfg.runsRoot, cfg.stateFile);
  console.log("=== Agentic goal review ===");
  agentCallCounter.count++;
  emitTokenUsage(cfg, await invokeAgentWithLog(promptFile, cfg.plannerAgent, cfg.repoRoot, logFile, "goal-review"));

  if (!existsSync(resultFile)) throw new LoopError(`Goal review agent did not write ${resultFile}`);
  const result = JSON.parse(readFileSync(resultFile, "utf-8")) as GoalReviewResult;
  appendEvent(cfg.repoRoot, "goal_review_finished", { runDir, verdict: result.verdict, summary: result.summary, gaps: result.gaps }, cfg.runsRoot, cfg.stateFile);

  if (result.verdict === "needs_human") {
    throw new LoopError(`Goal review returned needs_human: ${result.summary ?? "(no summary)"}. Gaps: ${(result.gaps ?? []).join("; ") || "(none listed)"}`);
  }
  console.log(`Goal review passed: ${result.summary ?? "ok"}`);
}

interface ArchitectCheckpointResult {
  verdict: "continue" | "replan" | "needs_human";
  assessment?: string;
  suggestedChanges?: string[];
}

interface PostTaskReviewResult {
  verdict: "continue" | "adjust_remaining_tasks" | "replan" | "needs_human";
  assessment?: string;
  remainingPlanStillValid?: boolean;
  suggestedChanges?: string[];
}

function enforceReplanBudget(
  cfg: Required<LoopConfig>,
  sessionReplanCountRef: { count: number },
  phase: string,
  reason: string
): void {
  sessionReplanCountRef.count++;
  if (cfg.maxReplans > 0 && sessionReplanCountRef.count > cfg.maxReplans) {
    appendEvent(cfg.repoRoot, "replan_budget_exhausted", { phase, sessionReplanCount: sessionReplanCountRef.count, maxReplans: cfg.maxReplans, reason }, cfg.runsRoot, cfg.stateFile);
    throw new LoopError(`Replan budget exhausted at ${phase} (${sessionReplanCountRef.count - 1} replans >= maxReplans ${cfg.maxReplans}): ${reason}`);
  }
}

async function runPlannerWithConvergenceGuard(
  cfg: Required<LoopConfig>,
  policy: WorkflowPolicy,
  agentCallCounter: { count: number },
  sessionReplanCountRef: { count: number },
  phase: string,
  reason: string,
  priorFailureAnalysisFile = ""
): Promise<void> {
  enforceReplanBudget(cfg, sessionReplanCountRef, phase, reason);

  const preReplanState = loadState(cfg.repoRoot, cfg.stateFile)!;
  const prevReplanTaskIds = (preReplanState.lastReplanTaskIds ?? []).slice().sort().join(",");
  const newTaskIds = await runPlannerPhase(cfg, policy, agentCallCounter, priorFailureAnalysisFile);
  const newTaskIdsKey = newTaskIds.slice().sort().join(",");

  if (prevReplanTaskIds.length > 0 && newTaskIdsKey === prevReplanTaskIds) {
    const thrashReason = `replan produced the same task set as the previous replan (${newTaskIdsKey}); stopping to avoid infinite loop`;
    const afterState = loadState(cfg.repoRoot, cfg.stateFile)!;
    appendEvent(cfg.repoRoot, "replan_convergence_failure", { phase, taskIds: newTaskIdsKey, sessionReplanCount: sessionReplanCountRef.count }, cfg.runsRoot, cfg.stateFile);
    for (const t of getTasks(afterState).filter((t) => t.status === "pending" || t.status === "needs_retry")) {
      setTaskStatus(cfg.repoRoot, cfg.stateFile, cfg.runsRoot, t.id, "needs_human", { at: new Date().toISOString(), phase: "replan_convergence", reason: thrashReason, resultFile: "" });
    }
    throw new LoopError(`Replan convergence failure: ${thrashReason}`);
  }
}

async function invalidatePlanAndReplan(args: {
  cfg: Required<LoopConfig>;
  policy: WorkflowPolicy;
  agentCallCounter: { count: number };
  sessionReplanCountRef: { count: number };
  phase: string;
  reason: string;
  resultFile: string;
  currentTaskId?: string;
  blockRemaining?: boolean;
  priorFailureAnalysisFile?: string;
}): Promise<void> {
  if (args.currentTaskId) {
    setTaskStatus(args.cfg.repoRoot, args.cfg.stateFile, args.cfg.runsRoot, args.currentTaskId, "blocked", {
      at: new Date().toISOString(),
      phase: args.phase,
      reason: args.reason,
      resultFile: args.resultFile,
    });
    appendEvent(args.cfg.repoRoot, "task_replan_requested", {
      task: args.currentTaskId,
      phase: args.phase,
      reason: args.reason,
      resultFile: args.resultFile,
      sessionReplanCount: args.sessionReplanCountRef.count,
    }, args.cfg.runsRoot, args.cfg.stateFile);
  }
  if (args.blockRemaining) {
    blockRemainingPlanForReplan(args.cfg, args.phase, args.reason, args.resultFile);
  }
  await runPlannerWithConvergenceGuard(
    args.cfg,
    args.policy,
    args.agentCallCounter,
    args.sessionReplanCountRef,
    args.phase,
    args.reason,
    args.priorFailureAnalysisFile,
  );
}

function blockRemainingPlanForReplan(
  cfg: Required<LoopConfig>,
  phase: string,
  reason: string,
  resultFile: string
): void {
  const state = loadState(cfg.repoRoot, cfg.stateFile)!;
  for (const t of getTasks(state).filter((t) => t.status === "pending" || t.status === "needs_retry")) {
    setTaskStatus(cfg.repoRoot, cfg.stateFile, cfg.runsRoot, t.id, "blocked", { at: new Date().toISOString(), phase, reason, resultFile });
  }
}

// Run architect checkpoint: review plan + cumulative diff for drift after N passed tasks.
// Returns true if the loop should continue, false if it should halt (throws on needs_human).
// Triggers runPlannerPhase on replan verdict.
async function runArchitectCheckpointPhase(
  cfg: Required<LoopConfig>,
  policy: WorkflowPolicy,
  agentCallCounter: { count: number },
  loopBaseRef: string,
  sessionReplanCountRef: { count: number }
): Promise<void> {
  const ts = timestamp();
  const runDir = join(cfg.repoRoot, cfg.runsRoot, `agentic-${ts}-architect-checkpoint`);
  mkdirSync(runDir, { recursive: true });

  const promptFile = join(runDir, "architect-checkpoint.md");
  const logFile    = join(runDir, "architect-checkpoint.log");
  const resultFile = join(runDir, "architect-checkpoint-result.json");

  const state = loadState(cfg.repoRoot, cfg.stateFile)!;
  const passedCount = (state.tasks ?? []).filter((t) => t.status === "passed").length;
  writeArchitectCheckpointPrompt(promptFile, {
    repoRoot: cfg.repoRoot,
    runsRoot: cfg.runsRoot,
    stateFile: cfg.stateFile,
    budget: cfg.budget,
    state,
    loopBaseRef,
    passedCount,
    resultFile,
  });

  appendEvent(cfg.repoRoot, "architect_checkpoint_started", { runDir, prompt: promptFile, resultFile, passedCount }, cfg.runsRoot, cfg.stateFile);
  console.log(`=== Agentic architect checkpoint (${passedCount} tasks passed) ===`);
  agentCallCounter.count++;
  emitTokenUsage(cfg, await invokeAgentWithLog(promptFile, cfg.plannerAgent, cfg.repoRoot, logFile, "architect-checkpoint"));

  if (!existsSync(resultFile)) throw new LoopError(`Architect checkpoint agent did not write ${resultFile}`);
  const result = JSON.parse(readFileSync(resultFile, "utf-8")) as ArchitectCheckpointResult;
  appendEvent(cfg.repoRoot, "architect_checkpoint_finished", { runDir, verdict: result.verdict, assessment: result.assessment }, cfg.runsRoot, cfg.stateFile);

  if (result.verdict === "needs_human") {
    throw new LoopError(`Architect checkpoint returned needs_human: ${result.assessment ?? "(no assessment)"}`);
  }

  if (result.verdict === "replan") {
    console.log(`Architect checkpoint requested replan: ${result.assessment ?? ""}`);
    appendEvent(cfg.repoRoot, "architect_checkpoint_replan", { assessment: result.assessment, suggestedChanges: result.suggestedChanges }, cfg.runsRoot, cfg.stateFile);
    await invalidatePlanAndReplan({
      cfg, policy, agentCallCounter, sessionReplanCountRef,
      phase: "architect_checkpoint",
      reason: result.assessment ?? "architect checkpoint requested replan",
      resultFile,
      blockRemaining: true,
    });
    return;
  }

  console.log(`Architect checkpoint: continue. ${result.assessment ?? ""}`);
}

async function runPostTaskReviewPhase(
  cfg: Required<LoopConfig>,
  policy: WorkflowPolicy,
  agentCallCounter: { count: number },
  loopBaseRef: string,
  sessionReplanCountRef: { count: number },
  taskId: string,
  taskRunDir: string,
  verifierResultFile: string,
  handoverFile: string
): Promise<void> {
  const bundledResultFile = join(taskRunDir, "post-task-review-result.json");
  const ts = timestamp();
  const runDir = join(cfg.repoRoot, cfg.runsRoot, `agentic-${ts}-${safeSlug(taskId)}-post-task-review`);
  mkdirSync(runDir, { recursive: true });

  const promptFile = join(runDir, "post-task-review.md");
  const logFile    = join(runDir, "post-task-review.log");
  const resultFile = existsSync(bundledResultFile) ? bundledResultFile : join(runDir, "post-task-review-result.json");

  const state = loadState(cfg.repoRoot, cfg.stateFile)!;
  if (!existsSync(resultFile)) writePostTaskReviewPrompt(promptFile, {
    repoRoot: cfg.repoRoot,
    runsRoot: cfg.runsRoot,
    stateFile: cfg.stateFile,
    budget: cfg.budget,
    state,
    taskId,
    taskRunDir,
    verifierResultFile,
    handoverFile,
    loopBaseRef,
    resultFile,
  });

  appendEvent(cfg.repoRoot, "post_task_review_started", { task: taskId, runDir, prompt: promptFile, resultFile, bundled: resultFile === bundledResultFile }, cfg.runsRoot, cfg.stateFile);
  if (resultFile === bundledResultFile) {
    appendEvent(cfg.repoRoot, "post_task_review_reused_bundled_review", { task: taskId, resultFile }, cfg.runsRoot, cfg.stateFile);
  } else {
    console.log(`=== Agentic post-task review: ${taskId} ===`);
    agentCallCounter.count++;
    emitTokenUsage(cfg, await invokeAgentWithLog(promptFile, cfg.grillAgent, cfg.repoRoot, logFile, "post-task-review"), taskId);
  }

  if (!existsSync(resultFile)) throw new LoopError(`Post-task review agent did not write ${resultFile}`);
  const result = JSON.parse(readFileSync(resultFile, "utf-8")) as PostTaskReviewResult;
  appendEvent(cfg.repoRoot, "post_task_review_finished", { task: taskId, verdict: result.verdict, assessment: result.assessment, remainingPlanStillValid: result.remainingPlanStillValid, suggestedChanges: result.suggestedChanges }, cfg.runsRoot, cfg.stateFile);

  if (result.verdict === "needs_human") {
    throw new LoopError(`Post-task review returned needs_human after ${taskId}: ${result.assessment ?? "(no assessment)"}`);
  }

  if (result.verdict === "adjust_remaining_tasks") {
    appendEvent(cfg.repoRoot, "post_task_review_advisory_recorded", { task: taskId, verdict: result.verdict, assessment: result.assessment, suggestedChanges: result.suggestedChanges }, cfg.runsRoot, cfg.stateFile);
    console.log(`Post-task review advisory recorded; continuing to next task. ${result.assessment ?? ""}`);
    return;
  }

  if (result.verdict === "replan") {
    appendEvent(cfg.repoRoot, "post_task_review_replan", { task: taskId, verdict: result.verdict, assessment: result.assessment, suggestedChanges: result.suggestedChanges }, cfg.runsRoot, cfg.stateFile);
    await invalidatePlanAndReplan({
      cfg, policy, agentCallCounter, sessionReplanCountRef,
      phase: "post_task_review",
      reason: result.assessment ?? "post-task review requested replan",
      resultFile,
      blockRemaining: true,
    });
    return;
  }

  console.log(`Post-task review: continue. ${result.assessment ?? ""}`);
}

interface DecisionGrillOutcome {
  /** Decisions to record into state (accepted, non-escalating). */
  accepted: Record<string, unknown>[];
  /** A task-halting reason if the grill escalated; empty when the loop may continue. */
  escalateReason: string;
}

import { runStanceReflectionPhase, type StanceReflectionResult } from "./stance-reflection-phase.js";
export { runStanceReflectionPhase, type StanceReflectionResult };

// Run a grill-with-docs self-interview before the executor edits.
// Validates the decision contract; re-grills ONCE if the result is shallow or low-confidence
// without escalation; escalates to a halting reason if it's still inadequate or any decision
// asks to escalate. Records accepted decisions into state.decisions.
async function runDecisionGrillPhase(
  cfg: Required<LoopConfig>,
  agentCallCounter: { count: number },
  task: Task,
  iteration: number,
  runDir: string,
  codeGraphFile: string,
  worktreePath: string,
  eventLogPath: string
): Promise<DecisionGrillOutcome> {
  const promptFile = join(runDir, "decision-grill.md");
  const resultFile = join(runDir, "decision-grill-result.json");
  const logFile    = join(runDir, "decision-grill.log");

  const runOnce = async (priorShallowFeedback: string): Promise<{ decisions: Record<string, unknown>[]; errors: string[] }> => {
    const state = loadState(cfg.repoRoot, cfg.stateFile)!;
    writeDecisionGrillPrompt(promptFile, {
      repoRoot: cfg.repoRoot, runsRoot: cfg.runsRoot, stateFile: cfg.stateFile,
      budget: cfg.budget, state, task, iteration, runDir, resultFile, eventLogPath,
      codeGraphFile, priorShallowFeedback,
    });
    appendEvent(cfg.repoRoot, "decision_grill_started", { task: task.id, prompt: promptFile, resultFile, reGrill: !!priorShallowFeedback }, cfg.runsRoot, cfg.stateFile);
    agentCallCounter.count++;
    emitTokenUsage(cfg, await invokeAgentWithLog(promptFile, cfg.grillAgent, worktreePath, logFile, "decision-grill"), task.id);
    if (!existsSync(resultFile)) throw new LoopError(`Decision grill did not write ${resultFile}`);
    const parsed = JSON.parse(readFileSync(resultFile, "utf-8")) as { decisions?: Record<string, unknown>[] };
    const decisions = parsed.decisions ?? [];
    return { decisions, errors: validateDecisions(decisions) };
  };

  // Reasons to re-grill: schema-shallow, or any decision is low-confidence without choosing to escalate.
  const needsReGrill = (decisions: Record<string, unknown>[], errors: string[]): string[] => {
    const reasons = [...errors];
    for (const d of decisions) {
      if (d["confidence"] === "low" && d["escalate"] !== true) {
        reasons.push(`decision "${String(d["question"] ?? "").slice(0, 80)}" is low-confidence; gather more evidence or set escalate:true`);
      }
    }
    return reasons;
  };

  console.log(`=== Agentic decision grill: ${task.id} ===`);
  let decisions: Record<string, unknown>[] = [];
  let errors: string[] = [];
  if (existsSync(resultFile)) {
    const parsed = JSON.parse(readFileSync(resultFile, "utf-8")) as { decisions?: Record<string, unknown>[] };
    decisions = parsed.decisions ?? [];
    errors = validateDecisions(decisions);
    appendEvent(cfg.repoRoot, "decision_grill_reused_preflight", { task: task.id, count: decisions.length }, cfg.runsRoot, cfg.stateFile);
  } else {
    ({ decisions, errors } = await runOnce(""));
  }
  let reGrillReasons = needsReGrill(decisions, errors);

  if (reGrillReasons.length > 0) {
    appendEvent(cfg.repoRoot, "decision_grill_regrill", { task: task.id, reasons: reGrillReasons }, cfg.runsRoot, cfg.stateFile);
    console.log(`Decision grill shallow/low-confidence; re-grilling once for ${task.id}.`);
    ({ decisions, errors } = await runOnce(reGrillReasons.join("\n")));
    reGrillReasons = needsReGrill(decisions, errors);
  }

  // After the single re-grill: if the contract is still unmet, escalate.
  if (errors.length > 0) {
    const reason = `decision grill still inadequate after re-grill: ${errors.join("; ")}`;
    appendEvent(cfg.repoRoot, "decision_grill_finished", { task: task.id, verdict: "needs_human", reason, count: decisions.length }, cfg.runsRoot, cfg.stateFile);
    return { accepted: [], escalateReason: reason };
  }

  // Any decision that asks to escalate (or stayed low-confidence) halts the task for a human.
  const escalating = decisions.filter((d) => d["escalate"] === true || (d["confidence"] === "low"));
  if (escalating.length > 0) {
    const reason = `decision grill escalated ${escalating.length} decision(s): ${escalating.map((d) => String(d["question"] ?? "")).join("; ")}`;
    appendEvent(cfg.repoRoot, "decision_grill_finished", { task: task.id, verdict: "needs_human", reason, count: decisions.length }, cfg.runsRoot, cfg.stateFile);
    return { accepted: [], escalateReason: reason };
  }

  appendEvent(cfg.repoRoot, "decision_grill_finished", { task: task.id, verdict: "answered", count: decisions.length }, cfg.runsRoot, cfg.stateFile);
  console.log(`Decision grill answered ${decisions.length} decision(s) for ${task.id}.`);
  return { accepted: decisions, escalateReason: "" };
}

// Main entry point. Throws LoopError with an appropriate exitCode on terminal failures.
export async function runAgenticLoop(config: LoopConfig): Promise<void> {
  const policy = loadPolicy(config.repoRoot);
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
    worktreeBootstrap:  config.worktreeBootstrap  ?? policy.autonomousLoop.worktreeBootstrap ?? [],
    worktreeBootstrapIgnore: config.worktreeBootstrapIgnore ?? policy.autonomousLoop.worktreeBootstrapIgnore ?? [],
    checkEnvFile:       config.checkEnvFile       ?? policy.autonomousLoop.checkEnvFile ?? "",
    budget:             config.budget             ?? "medium",
    planOnly:           config.planOnly           ?? false,
    retryTaskId:        config.retryTaskId        ?? "",
    commit:             config.commit             ?? true,
    merge:              config.merge              ?? false,
    apply:              config.apply              ?? true,
    mergeMode:          config.mergeMode          ?? "ff-only",
    reviewBranchMode:   config.reviewBranchMode   ?? false,
    autoAcceptPassed:   config.autoAcceptPassed   ?? false,
    cleanupPassed:      config.cleanupPassed      ?? false,
    fastVerifier:       config.fastVerifier       ?? false,
    rebaseBeforeVerify:          config.rebaseBeforeVerify          ?? false,
    finalizeDocs:                config.finalizeDocs                ?? true,
    allowDirty:                  config.allowDirty                  ?? false,
    goalReview:                  config.goalReview                  ?? false,
    postTaskReview:              config.postTaskReview              ?? true,
    architectCheckpointInterval: config.architectCheckpointInterval ?? 0,
    decisionGrill:               config.decisionGrill               ?? true,
    repoRoot:           config.repoRoot,
    agent:              config.agent,
    plannerAgent:       config.plannerAgent       ?? config.agent,
    plannerMode:        resolvePlannerMode(policy, config.plannerMode),
    grillAgent:         config.grillAgent         ?? config.agent,
    executorAgent:      config.executorAgent      ?? config.agent,
    verifierAgent:      config.verifierAgent      ?? config.agent,
  };

  const runStartTime = Date.now();
  const agentCallCounter = { count: 0 };
  const eventLogPath = join(cfg.repoRoot, cfg.runsRoot, "events.jsonl");
  // Capture HEAD at loop start — used as rebase target when --rebase-before-verify is set.
  const loopBaseRef = (() => { try { return git(["rev-parse", "HEAD"], cfg.repoRoot); } catch { return ""; } })();

  if (policy.autonomousLoop.requireCleanMainWorktree && !cfg.allowDirty && git(["status", "--porcelain"], cfg.repoRoot).length > 0) {
    throw new LoopError("Main worktree is dirty. Commit/stash first, or pass --allow-dirty.", 2);
  }

  // ── Planner phase ─────────────────────────────────────────────────────────
  {
    const state = loadState(cfg.repoRoot, cfg.stateFile);
    if (!state) throw new LoopError(`No ${cfg.stateFile} found in ${cfg.repoRoot}`);
    if (getTasks(state).length === 0) {
      await runPlannerPhase(cfg, policy, agentCallCounter);
      if (cfg.planOnly) { console.log("<promise>PLANNED</promise>"); return; }
    }
  }
  // Track replan count and architect checkpoint state across the session.
  const sessionReplanCountRef = { count: 0 };
  let passedSinceLastCheckpoint = 0;
  if (cfg.planOnly) { console.log("<promise>PLANNED</promise>"); return; }

  // ── Single run worktree (shared across all tasks) ─────────────────────────
  const runTs0 = timestamp();
  const runBranch     = `agentic/run-${runTs0}`;
  const runWorktreePath = join(cfg.repoRoot, cfg.worktreeRoot, `run-${runTs0}`);
  createWorktree(runBranch, runWorktreePath, "HEAD", cfg.repoRoot);
  writeWorktreeExclude(runWorktreePath, harnessIgnoredPaths(cfg.worktreeBootstrapIgnore));
  appendEvent(cfg.repoRoot, "run_worktree_created", { branch: runBranch, worktree: runWorktreePath }, cfg.runsRoot, cfg.stateFile);

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
      if (cfg.goalReview) await runGoalReviewPhase(cfg, agentCallCounter, loopBaseRef);
      await runFinalizeDocsIfNeeded(cfg, policy, agentCallCounter, runWorktreePath, loopBaseRef);
      applyRunWorktree(cfg, runBranch, runWorktreePath);
      console.log("<promise>COMPLETE</promise>");
      return;
    }

    // Setup run directory and paths
    const taskId   = task.id;
    const safeId   = safeSlug(taskId);
    const branch   = runBranch;
    const worktreePath = runWorktreePath;
    const ts         = timestamp();
    const runDir     = join(cfg.repoRoot, cfg.runsRoot, `agentic-${ts}-${safeId}`);
    const taskGrillPrompt = join(runDir, "task-grill.md");
    const taskGrillResult = join(runDir, "task-grill-result.json");
    const taskGrillLog    = join(runDir, "task-grill.log");
    const decisionGrillResult = join(runDir, "decision-grill-result.json");
    const executorPrompt  = join(runDir, "executor.md");
    const verifierPrompt  = join(runDir, "verifier.md");
    const verifierResult  = join(runDir, "verifier-result.json");
    const bundledPostTaskResult = join(runDir, "post-task-review-result.json");
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

    writeWorktreeExclude(worktreePath, harnessIgnoredPaths(cfg.worktreeBootstrapIgnore));

    try {
      if (cfg.worktreeBootstrap.length > 0) {
        const bootstrapLog = join(runDir, "bootstrap.log");
        appendEvent(cfg.repoRoot, "worktree_bootstrap_started", { task: taskId, commands: cfg.worktreeBootstrap, ignored: cfg.worktreeBootstrapIgnore, log: bootstrapLog }, cfg.runsRoot, cfg.stateFile);
        try {
          const bootstrapOutput = runWorktreeBootstrap(worktreePath, cfg.worktreeBootstrap, cfg.checkTimeoutSeconds || 120);
          writeFileSync(bootstrapLog, bootstrapOutput, "utf-8");
          appendEvent(cfg.repoRoot, "worktree_bootstrap_passed", { task: taskId, log: bootstrapLog }, cfg.runsRoot, cfg.stateFile);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          writeFileSync(bootstrapLog, msg, "utf-8");
          appendEvent(cfg.repoRoot, "worktree_bootstrap_failed", { task: taskId, reason: msg, log: bootstrapLog }, cfg.runsRoot, cfg.stateFile);
          setTaskStatus(cfg.repoRoot, cfg.stateFile, cfg.runsRoot, taskId, "needs_human", { at: new Date().toISOString(), phase: "bootstrap", reason: msg });
          copyFileSync(join(cfg.repoRoot, cfg.stateFile), stateAfter);
          throw new LoopError(`Worktree bootstrap failed for ${taskId}. Worktree retained at ${worktreePath}.\n${msg}`);
        }
      }
      // Goal intake already performed discovery, planning, and decision capture for
      // fresh planner revisions. Re-run task-grill only when the task is stale,
      // manually supplied, retried after a non-check failure, or explicitly forced.
      const taskState = loadState(cfg.repoRoot, cfg.stateFile)!;
      const taskGrillDecision = shouldRunTaskGrill(task, taskState, policy);
      appendPhaseAdmission(cfg, "task-grill", taskGrillDecision, taskId);
      let taskGrillResultObj: TaskGrillResult;
      let acceptedDecisions: Record<string, unknown>[] = [];

      if (taskGrillDecision.run) {
        syncCodeGraph(worktreePath);
        writeCodeGraphContext(codeGraphFile, worktreePath);
        const preflightOptions = {
          repoRoot: cfg.repoRoot,
          runsRoot: cfg.runsRoot,
          stateFile: cfg.stateFile,
          budget: cfg.budget,
          state: taskState,
          task,
          iteration,
          runDir,
          resultFile: taskGrillResult,
          eventLogPath,
          codeGraphFile,
          policy,
          priorFailureAnalysisFile: getLastFailureAnalysisFile(task),
        };
        if (cfg.decisionGrill) {
          writePreflightPrompt(taskGrillPrompt, { ...preflightOptions, decisionResultFile: decisionGrillResult });
          appendEvent(cfg.repoRoot, "preflight_started", { task: taskId, prompt: taskGrillPrompt, taskGrillResult, decisionGrillResult, log: taskGrillLog }, cfg.runsRoot, cfg.stateFile);
        } else {
          writeTaskGrillPrompt(taskGrillPrompt, preflightOptions);
        }
        appendEvent(cfg.repoRoot, "task_grill_started", { task: taskId, prompt: taskGrillPrompt, resultFile: taskGrillResult, log: taskGrillLog, bundled: cfg.decisionGrill }, cfg.runsRoot, cfg.stateFile);
        agentCallCounter.count++;
        emitTokenUsage(cfg, await invokeAgentWithLog(taskGrillPrompt, cfg.grillAgent, worktreePath, taskGrillLog, cfg.decisionGrill ? "preflight" : "task-grill"), taskId);
        if (!existsSync(taskGrillResult)) throw new LoopError(`Task grill did not write ${taskGrillResult}`);
        taskGrillResultObj = JSON.parse(readFileSync(taskGrillResult, "utf-8")) as TaskGrillResult;
        appendEvent(cfg.repoRoot, "task_grill_finished", { task: taskId, verdict: taskGrillResultObj.verdict, resultFile: taskGrillResult, understanding: taskGrillResultObj.understanding }, cfg.runsRoot, cfg.stateFile);
        if (cfg.decisionGrill && existsSync(decisionGrillResult)) {
          appendEvent(cfg.repoRoot, "preflight_finished", { task: taskId, taskGrillVerdict: taskGrillResultObj.verdict, decisionResultFile: decisionGrillResult }, cfg.runsRoot, cfg.stateFile);
        }
      } else {
        taskGrillResultObj = {
          verdict: "ready",
          understanding: `Task readiness inherited from planner revision: ${taskGrillDecision.reason}`,
          risks: [],
          executorInstructions: "Use planner decisions and current task scope; stop if new material ambiguity appears.",
          assumptionsStillValid: [],
          assumptionsChanged: [],
        };
        writeFileSync(taskGrillResult, JSON.stringify(taskGrillResultObj, null, 2) + "\n", "utf-8");
        writeFileSync(codeGraphFile, "# CodeGraph context\n\nSkipped during fast-path admission; planner context is authoritative for this unchanged task.\n", "utf-8");
        if (cfg.decisionGrill) appendPhaseAdmission(cfg, "decision-grill", { run: false, reason: "goal intake decisions already belong to the fresh planner revision" }, taskId);
      }

      if (taskGrillResultObj.verdict !== "ready") {
        if (taskGrillResultObj.verdict === "needs_replan") {
          const reason = [
            "task-grill requested replanning",
            taskGrillResultObj.understanding ?? "",
            ...(taskGrillResultObj.risks ?? []),
          ].filter(Boolean).join("; ");

          const replanTask = getTasks(loadState(cfg.repoRoot, cfg.stateFile)!).find((t) => t.id === taskId);
          await invalidatePlanAndReplan({
            cfg, policy, agentCallCounter, sessionReplanCountRef,
            phase: "task_grill",
            reason,
            resultFile: taskGrillResult,
            currentTaskId: taskId,
            priorFailureAnalysisFile: replanTask ? getLastFailureAnalysisFile(replanTask) : "",
          });

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

      // Persist assumption verdicts from task-grill into state so future turns can see them.
      updateAssumptionsFromGrill(
        cfg.repoRoot, cfg.stateFile, cfg.runsRoot, taskId,
        taskGrillResultObj.assumptionsStillValid ?? [],
        taskGrillResultObj.assumptionsChanged ?? []
      );

      if ((taskGrillResultObj.assumptionsChanged?.length ?? 0) > 0) {
        const reason = `task-grill changed assumptions: ${taskGrillResultObj.assumptionsChanged!.join("; ")}`;
        await invalidatePlanAndReplan({
          cfg, policy, agentCallCounter, sessionReplanCountRef,
          phase: "assumption_drift",
          reason,
          resultFile: taskGrillResult,
          currentTaskId: taskId,
          priorFailureAnalysisFile: getLastFailureAnalysisFile(task),
        });
        copyFileSync(join(cfg.repoRoot, cfg.stateFile), stateAfter);
        continue;
      }

      // Decision grill remains bundled with task-grill for stale/manual tasks.
      if (cfg.decisionGrill && taskGrillDecision.run) {
        const outcome = await runDecisionGrillPhase(
          cfg, agentCallCounter, task, iteration, runDir, codeGraphFile, worktreePath, eventLogPath
        );
        if (outcome.escalateReason) {
          setTaskStatus(cfg.repoRoot, cfg.stateFile, cfg.runsRoot, taskId, "needs_human", { at: new Date().toISOString(), phase: "decision_grill", reason: outcome.escalateReason, resultFile: join(runDir, "decision-grill-result.json") });
          copyFileSync(join(cfg.repoRoot, cfg.stateFile), stateAfter);
          throw new LoopError(`Decision grill halted ${taskId} before executor edits: ${outcome.escalateReason}`);
        }
        acceptedDecisions = outcome.accepted;
        recordDecisions(cfg.repoRoot, cfg.stateFile, cfg.runsRoot, taskId, outcome.accepted);
      }

      const complexity = resolveTaskComplexity(task as any, policy);
      task.complexity = complexity.level;
      task.complexityReasons = complexity.reasons;
      {
        const complexityState = loadState(cfg.repoRoot, cfg.stateFile)!;
        const persistedTask = getTasks(complexityState).find((t) => t.id === taskId);
        if (persistedTask) {
          persistedTask.complexity = complexity.level;
          persistedTask.complexityReasons = complexity.reasons;
          writeState(cfg.repoRoot, complexityState, cfg.stateFile);
        }
      }
      appendEvent(cfg.repoRoot, "task_complexity_resolved", { task: taskId, level: complexity.level, reasons: complexity.reasons }, cfg.runsRoot, cfg.stateFile);

      let approvedStance: StanceReflectionResult | undefined;
      if (complexity.level === "high") {
        try {
          const stance = await runStanceReflectionPhase(cfg, agentCallCounter, task, runDir, worktreePath, codeGraphFile, acceptedDecisions);
          approvedStance = stance.result;
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          setTaskStatus(cfg.repoRoot, cfg.stateFile, cfg.runsRoot, taskId, "needs_human", { at: new Date().toISOString(), phase: "stance_reflection", reason });
          copyFileSync(join(cfg.repoRoot, cfg.stateFile), stateAfter);
          throw err;
        }
      }

      // Warn when no scope is declared — the diff-scope rail cannot bound the change
      if (isTaskUnscoped(task as any)) {
        const warnMsg = `Task ${taskId} has no declared scope. The diff-scope rail is inactive for this task; all file changes will be allowed. Declare 'scope' globs in the task to enable scope enforcement.`;
        console.warn(warnMsg);
        appendEvent(cfg.repoRoot, "scope_missing_warning", { task: taskId, reason: warnMsg }, cfg.runsRoot, cfg.stateFile);
      }

      // Executor
      const declaredScope = getTaskScope(task as any);
      const compactExecutor = complexity.level === "low"
        && !isTaskUnscoped(task as any)
        && (["maintenance", "discovery", "investigation"].includes(task.kind ?? "")
          || testPathsAreDocumentation(declaredScope));
      writeExecutorPrompt(executorPrompt, {
        repoRoot: cfg.repoRoot,
        worktreePath,
        compact: compactExecutor,
        runsRoot: cfg.runsRoot,
        stateFile: cfg.stateFile,
        budget: cfg.budget,
        state,
        task,
        iteration,
        runDir,
        eventLogPath,
        codeGraphFile,
        policy,
        taskGrillResult: taskGrillResultObj,
        decisionGrillDecisions: acceptedDecisions,
        approvedStance,
      });

      appendEvent(cfg.repoRoot, "executor_started", { task: taskId, prompt: executorPrompt, log: executorLog }, cfg.runsRoot, cfg.stateFile);
      try {
        agentCallCounter.count++;
        const invocation = await withUnchangedCheckout(cfg.repoRoot, () =>
          invokeAgentWithLog(executorPrompt, cfg.executorAgent, worktreePath, executorLog, "executor")
        , [cfg.stateFile, cfg.runsRoot, cfg.worktreeRoot]);
        emitTokenUsage(cfg, invocation, taskId);
        appendEvent(cfg.repoRoot, "executor_passed", { task: taskId, log: executorLog }, cfg.runsRoot, cfg.stateFile);
      } catch (err) {
        if (err instanceof CheckoutMutationError) {
          handleMainWorktreeMutation(
            cfg,
            taskId,
            err,
            runDir,
            worktreePath,
            task.attempts ?? 1,
            failureAnalysisFile,
            stateAfter,
            verifierResult,
          );
        }
        if (err instanceof LoopError) throw err;
        const msg = err instanceof Error ? err.message : String(err);
        appendEvent(cfg.repoRoot, "executor_failed", { task: taskId, reason: msg, log: executorLog }, cfg.runsRoot, cfg.stateFile);
        setTaskStatus(cfg.repoRoot, cfg.stateFile, cfg.runsRoot, taskId, "needs_human", { at: new Date().toISOString(), phase: "executor", reason: msg, resultFile: verifierResult });
        writeChecksLog(checksLog, "Checks not run because executor failed.");
        writeDiffArtifacts(worktreePath, runDir, harnessIgnoredPaths(cfg.worktreeBootstrapIgnore));
        copyFileSync(join(cfg.repoRoot, cfg.stateFile), stateAfter);
        throw new LoopError(`Executor failed for ${taskId}. Worktree retained at ${worktreePath}. ${msg}`);
      }

      // Checks
      const baseChecks = getTaskChecks(task, loadState(cfg.repoRoot, cfg.stateFile)!);
      const taskChecks = isArtifactOnlyTask(task) && cfg.extraChecks.length === 0
        ? []
        : [...new Set([...baseChecks, ...cfg.extraChecks])];
      appendEvent(cfg.repoRoot, "checks_started", { task: taskId, commands: taskChecks, log: checksLog }, cfg.runsRoot, cfg.stateFile);
      let checkOutput: string;
      try {
        checkOutput = invokeChecks(worktreePath, taskChecks, cfg.checkTimeoutSeconds || 120, cfg.checkEnvFile);
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
        writeDiffArtifacts(worktreePath, runDir, harnessIgnoredPaths(cfg.worktreeBootstrapIgnore));
        copyFileSync(join(cfg.repoRoot, cfg.stateFile), stateAfter);
        if (failureStatus === "needs_retry") { console.warn(`Checks failed for ${taskId}; marked ${failureStatus}.`); continue; }
        throw new LoopError(`Checks failed for ${taskId}; marked ${failureStatus}. Worktree retained at ${worktreePath}.\n${checkOutput}`);
      }

      writeDiffArtifacts(worktreePath, runDir, harnessIgnoredPaths(cfg.worktreeBootstrapIgnore));

      // Scope rail
      const taskScope = getTaskScope(task as any);
      if (taskScope.length > 0) {
        const outOfScope = getOutOfScopeFiles(worktreePath, taskScope, harnessIgnoredPaths(cfg.worktreeBootstrapIgnore));
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
            checkOutput = invokeChecks(worktreePath, rebaseCheckCmds, cfg.checkTimeoutSeconds || 120, cfg.checkEnvFile);
            appendEvent(cfg.repoRoot, "rebase_checks_passed", { task: taskId }, cfg.runsRoot, cfg.stateFile);
          } catch (err) {
            checkOutput = err instanceof Error ? err.message : String(err);
            const rebaseCheckFailStatus = getFailureStatusForTask(task, "checks", cfg.maxRetries);
            appendEvent(cfg.repoRoot, "rebase_checks_failed", { task: taskId, status: rebaseCheckFailStatus, reason: checkOutput }, cfg.runsRoot, cfg.stateFile);
            writeFailureAnalysis({ taskId, phase: "rebase_checks", attempt: task.attempts ?? 1, rawOutput: checkOutput, worktreePath, outputFile: failureAnalysisFile });
            setTaskStatus(cfg.repoRoot, cfg.stateFile, cfg.runsRoot, taskId, rebaseCheckFailStatus, { at: new Date().toISOString(), phase: "rebase_checks", reason: checkOutput, resultFile: verifierResult, failureAnalysisFile });
            writeDiffArtifacts(worktreePath, runDir, harnessIgnoredPaths(cfg.worktreeBootstrapIgnore));
            copyFileSync(join(cfg.repoRoot, cfg.stateFile), stateAfter);
            if (rebaseCheckFailStatus === "needs_retry") { console.warn(`Post-rebase checks failed for ${taskId}; marked ${rebaseCheckFailStatus}.`); continue; }
            throw new LoopError(`Post-rebase checks failed for ${taskId}; marked ${rebaseCheckFailStatus}. Worktree retained at ${worktreePath}.\n${checkOutput}`);
          }
        }
      }

      // Resolve verification intensity from actual diff evidence after checks.
      // Task kind describes the work; it does not determine risk by itself.
      const changedPaths = changedPathsSince(worktreePath, "", harnessIgnoredPaths(cfg.worktreeBootstrapIgnore));
      const verifierDecision = shouldRunVerifier(task, policy, cfg.fastVerifier, changedPaths, cfg.verifierVotes);
      appendPhaseAdmission(cfg, "verifier", verifierDecision, taskId);
      appendEvent(cfg.repoRoot, "verification_profile_resolved", {
        task: taskId,
        risk: verifierDecision.risk,
        verifierMode: verifierDecision.verifierMode,
        votes: verifierDecision.votes,
        reasons: verifierDecision.reasons,
        evidence: verifierDecision.evidence,
      }, cfg.runsRoot, cfg.stateFile);
      if (cfg.fastVerifier && verifierDecision.run) {
        appendEvent(cfg.repoRoot, "verifier_skip_denied", { task: taskId, reason: verifierDecision.reason }, cfg.runsRoot, cfg.stateFile);
        console.log(`fast-verifier denied for ${taskId}; running full verifier: ${verifierDecision.reason}`);
      }

      // Only bundle plan review when deterministic drift evidence already says it
      // is needed. Otherwise the verifier stays a single-purpose call; a verifier
      // that reports new issues can still trigger a standalone review after pass.
      const remainingBeforeVerify = (loadState(cfg.repoRoot, cfg.stateFile)!.tasks ?? []).filter(
        (t) => t.id !== taskId && (t.status === "pending" || t.status === "needs_retry")
      );
      const reviewBeforeVerify = shouldRunPostTaskReview({
        task,
        remainingTasks: remainingBeforeVerify,
        policy,
        enabled: cfg.postTaskReview,
      });

      let verifierResultObj: VerifierResult;
      if (!verifierDecision.run) {
        verifierResultObj = { verdict: "pass", summary: `fast-verifier: checks passed; separate verifier skipped (${verifierDecision.reason})`, issues: [], humanGates: [], recommendedStatus: "passed", artifacts: [] };
        writeFileSync(verifierResult, JSON.stringify(verifierResultObj, null, 2), "utf-8");
        writeFileSync(verifierLog, "fast-verifier: skipped separate verifier after checks passed.", "utf-8");
        appendEvent(cfg.repoRoot, "verifier_skipped", { task: taskId, resultFile: verifierResult, log: verifierLog, reason: "fast-verifier" }, cfg.runsRoot, cfg.stateFile);
      } else {
        const votes = verifierDecision.votes;
        const adversarial = votes > 1;

        if (votes <= 1) {
          const verifierOptions = { repoRoot: cfg.repoRoot, runsRoot: cfg.runsRoot, stateFile: cfg.stateFile, budget: cfg.budget, task, worktreePath, checkOutput, resultFile: verifierResult, eventLogPath, policy, adversarial: false };
          if (reviewBeforeVerify.run) {
            writeBundledReviewPrompt(verifierPrompt, {
              ...verifierOptions,
              postTaskResultFile: bundledPostTaskResult,
              taskRunDir: runDir,
              handoverFile,
              loopBaseRef,
              state: loadState(cfg.repoRoot, cfg.stateFile)!,
            });
            appendEvent(cfg.repoRoot, "bundled_review_started", { task: taskId, prompt: verifierPrompt, verifierResult, postTaskResult: bundledPostTaskResult }, cfg.runsRoot, cfg.stateFile);
          } else {
            writeVerifierPrompt(verifierPrompt, verifierOptions);
          }
          appendEvent(cfg.repoRoot, "verifier_started", { task: taskId, prompt: verifierPrompt, resultFile: verifierResult, log: verifierLog, votes: 1, bundled: reviewBeforeVerify.run }, cfg.runsRoot, cfg.stateFile);
          agentCallCounter.count++;
          emitTokenUsage(cfg, await invokeAgentWithLog(verifierPrompt, cfg.verifierAgent, worktreePath, verifierLog, reviewBeforeVerify.run ? "bundled-review" : "verifier"), taskId);
          if (reviewBeforeVerify.run && !existsSync(verifierResult)) {
            writeVerifierPrompt(verifierPrompt, verifierOptions);
            appendEvent(cfg.repoRoot, "bundled_review_verifier_fallback", { task: taskId, prompt: verifierPrompt, resultFile: verifierResult }, cfg.runsRoot, cfg.stateFile);
            agentCallCounter.count++;
            emitTokenUsage(cfg, await invokeAgentWithLog(verifierPrompt, cfg.verifierAgent, worktreePath, verifierLog, "verifier-fallback"), taskId);
          }
          if (!existsSync(verifierResult)) throw new LoopError(`Verifier did not write ${verifierResult}`);
          verifierResultObj = JSON.parse(readFileSync(verifierResult, "utf-8")) as VerifierResult;
          if (reviewBeforeVerify.run && existsSync(bundledPostTaskResult)) {
            appendEvent(cfg.repoRoot, "bundled_review_finished", { task: taskId, verifierVerdict: verifierResultObj.verdict, postTaskResult: bundledPostTaskResult }, cfg.runsRoot, cfg.stateFile);
          }
        } else {
          appendEvent(cfg.repoRoot, "verifier_votes_started", { task: taskId, votes, adversarial: true }, cfg.runsRoot, cfg.stateFile);
          const voteSlots = Array.from({ length: votes }, (_, i) => i + 1).map((v) => ({
            prompt: join(runDir, `verifier-vote-${v}.md`),
            result: join(runDir, `verifier-vote-${v}.json`),
            log:    join(runDir, `verifier-vote-${v}.log`),
            v,
          }));
          for (const { prompt: vPrompt, result: vResult, log: vLog, v } of voteSlots) {
            writeVerifierPrompt(vPrompt, { repoRoot: cfg.repoRoot, runsRoot: cfg.runsRoot, stateFile: cfg.stateFile, budget: cfg.budget, task, worktreePath, checkOutput, resultFile: vResult, eventLogPath, policy, adversarial });
            appendEvent(cfg.repoRoot, "verifier_started", { task: taskId, prompt: vPrompt, resultFile: vResult, log: vLog, vote: v, votes }, cfg.runsRoot, cfg.stateFile);
            agentCallCounter.count++;
          }
          const voteUsages = await Promise.all(voteSlots.map(({ prompt: vPrompt, log: vLog, v }) =>
            invokeAgentWithLog(vPrompt, cfg.verifierAgent, worktreePath, vLog, `verifier-vote-${v}`)
          ));
          voteUsages.forEach((u) => emitTokenUsage(cfg, u, taskId));
          const voteResults: VerifierResult[] = voteSlots.map(({ result: vResult, v }) => {
            if (!existsSync(vResult)) throw new LoopError(`Verifier vote ${v} did not write ${vResult}`);
            const vr = JSON.parse(readFileSync(vResult, "utf-8")) as VerifierResult;
            appendEvent(cfg.repoRoot, "verifier_vote", { task: taskId, vote: v, verdict: vr.verdict, summary: vr.summary }, cfg.runsRoot, cfg.stateFile);
            return vr;
          });
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
          const excludes = pathspecExcludes(harnessIgnoredPaths(cfg.worktreeBootstrapIgnore));
          if (excludes.length > 0) git(["add", "-A", "--", ".", ...excludes], worktreePath);
          else git(["add", "-A"], worktreePath);
          const changed = (() => { try { git(["diff", "--cached", "--quiet"], worktreePath); return ""; } catch { return "staged"; } })();
          if (changed) git(["commit", "-m", `agentic: ${taskId}`], worktreePath);
          else console.log(`No changes to commit for ${taskId}.`);
        }
        setTaskPassed(cfg.repoRoot, cfg.stateFile, cfg.runsRoot, taskId, verifierResultObj);

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

        if (cfg.postTaskReview) {
          const remainingRunnable = (loadState(cfg.repoRoot, cfg.stateFile)!.tasks ?? []).filter(
            (t) => t.id !== taskId && (t.status === "pending" || t.status === "needs_retry")
          );
          const reviewDecision = shouldRunPostTaskReview({
            task,
            remainingTasks: remainingRunnable,
            policy,
            enabled: cfg.postTaskReview,
            verifierResult: verifierResultObj,
          });
          appendPhaseAdmission(cfg, "post-task-review", reviewDecision, taskId);
          if (reviewDecision.run) {
            await runPostTaskReviewPhase(cfg, policy, agentCallCounter, loopBaseRef, sessionReplanCountRef, taskId, runDir, verifierResult, handoverFile);
          } else {
            appendEvent(cfg.repoRoot, "post_task_review_skipped", { task: taskId, reason: reviewDecision.reason }, cfg.runsRoot, cfg.stateFile);
          }
        }

        // Architect checkpoint: trigger every N passed tasks if configured.
        passedSinceLastCheckpoint++;
        if (cfg.architectCheckpointInterval > 0 && passedSinceLastCheckpoint >= cfg.architectCheckpointInterval) {
          passedSinceLastCheckpoint = 0;
          await runArchitectCheckpointPhase(cfg, policy, agentCallCounter, loopBaseRef, sessionReplanCountRef);
        }

        if (cfg.retryTaskId) { applyRunWorktree(cfg, runBranch, runWorktreePath); console.log("<promise>COMPLETE</promise>"); return; }

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
      if (!existsSync(join(runDir, "diff.patch"))) writeDiffArtifacts(worktreePath, runDir, harnessIgnoredPaths(cfg.worktreeBootstrapIgnore));
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
    if (cfg.goalReview) await runGoalReviewPhase(cfg, agentCallCounter, loopBaseRef);
    await runFinalizeDocsIfNeeded(cfg, policy, agentCallCounter, runWorktreePath, loopBaseRef);
    applyRunWorktree(cfg, runBranch, runWorktreePath);
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
