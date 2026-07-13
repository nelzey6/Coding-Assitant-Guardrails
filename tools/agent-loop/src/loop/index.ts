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
import { safeSlug, createWorktree, worktreeExists, removeWorktree, git as gitTool, GitError } from "../tools/index.js";
import { getTaskChecks, type AgentConfig, type AgentInvocationResult } from "../agent/index.js";
import { AgentPhaseMutationError, invokeAgentPhase } from "./agent-phase.js";
import { invokeChecks, parseMetricLines } from "../checks/index.js";
import { getTaskScope, getOutOfScopeFiles, isTaskUnscoped, resolveTaskComplexity, testPathInScope, testPathsAreDocumentation } from "../scope/index.js";
import {
  syncCodeGraph,
  writeCodeGraphContext,
  writeRepoContext,
  writePlannerPrompt,
  writeExecutorPrompt,
  writeVerifierPrompt,
  writeFinalizeDocsPrompt,
  writeStanceReflectionPrompt,
  validatePlannerResult,
  validateDecisions,
  writeFailureAnalysis,
} from "../prompts/index.js";
import { loadPolicy, resolveEffectivePlannerMode, type WorkflowPolicy } from "../policy/index.js";
import { runShellScript } from "../tools/shell.js";
import {
  shouldReplanBeforeTask,
  shouldRunFinalizeDocs,
  shouldRunVerifier,
} from "../admission/index.js";

export interface LoopConfig {
  repoRoot: string;
  stateFile?: string;
  runsRoot?: string;
  worktreeRoot?: string;
  /** One agent adapter for planning, stance, execution, verification, and docs. */
  agent: AgentConfig;
  maxRuntimeSeconds?: number;
  /** Timeout in seconds for each check command (0 = no timeout). */
  checkTimeoutSeconds?: number;
  /** Extra check commands appended to state.checks (from --checks CLI flag). */
  extraChecks?: string[];
  /** Shell commands run inside the worktree before execution and checks. */
  worktreeBootstrap?: string[];
  /** Worktree-relative paths owned by bootstrap and ignored by scope/diff/commit. */
  worktreeBootstrapIgnore?: string[];
  /** Env file, relative to worktree or absolute, loaded for checks. */
  checkEnvFile?: string;
  /** After all tasks pass, copy changed files from the run worktree into the main tree as unstaged changes. Default: true. */
  apply?: boolean;
  finalizeDocs?: boolean;
  allowDirty?: boolean;
}

export class LoopError extends Error {
  constructor(message: string, public readonly exitCode = 1) {
    super(message);
    this.name = "LoopError";
  }
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

function uncommittedPaths(worktreePath: string, ignoredPaths: string[] = []): string[] {
  const names = new Set<string>();
  for (const args of [
    ["diff", "--name-only", "HEAD"],
    ["ls-files", "--others", "--exclude-standard"],
  ]) {
    const output = git(args, worktreePath);
    output.split(/\r?\n/).map((path) => path.trim()).filter(Boolean).forEach((path) => names.add(path));
  }
  const effectiveIgnores = expandIgnoredPaths(ignoredPaths);
  return [...names].filter((path) => !testPathInScope(path, effectiveIgnores)).sort();
}

// After all tasks pass, optionally copy run changes to the parent checkout as
// unstaged files. No merge-mode matrix: one safe integration path.
function applyRunWorktree(cfg: Required<LoopConfig>, runBranch: string, runWorktreePath: string): void {
  if (!worktreeExists(runWorktreePath)) return;

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
  mutation: AgentPhaseMutationError,
  runDir: string,
  worktreePath: string,
  attempt: number,
  failureAnalysisFile: string,
  stateAfter: string,
  verifierResult: string
): void {
  const mutationFile = mutation.evidenceFile;
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

  const plannerMode = resolveEffectivePlannerMode(policy, state, priorFailureAnalysisFile);
  appendEvent(cfg.repoRoot, "planner_mode_selected", {
    mode: plannerMode.mode,
    source: plannerMode.source,
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
    budget: "medium",
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
  emitTokenUsage(cfg, await invokeAgentPhase({ ...cfg, promptFile, workingDirectory: cfg.repoRoot, logFile: plannerLogFile, phase: "planner" }));

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
    emitTokenUsage(cfg, await invokeAgentPhase({ ...cfg, promptFile: repairPrompt, workingDirectory: cfg.repoRoot, logFile: plannerLogFile, phase: "planner-repair" }));
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

// Update durable repository docs once, only when changed paths admit this phase.
async function runFinalizeDocsPhase(cfg: Required<LoopConfig>, agentCallCounter: { count: number }, runWorktreePath: string): Promise<void> {
  const ts = timestamp();
  const runDir = join(cfg.repoRoot, cfg.runsRoot, `agentic-${ts}-finalize-docs`);
  mkdirSync(runDir, { recursive: true });

  const promptFile    = join(runDir, "finalize-docs.md");
  const executorLog   = join(runDir, "finalize-docs.log");
  const summaryFile   = join(runDir, "final-summary.md");

  const state = loadState(cfg.repoRoot, cfg.stateFile)!;
  writeFinalizeDocsPrompt(promptFile, {
    repoRoot: cfg.repoRoot,
    worktreePath: runWorktreePath,
    runsRoot: cfg.runsRoot,
    stateFile: cfg.stateFile,
    budget: "medium",
    state,
    summaryFile,
  });

  appendEvent(cfg.repoRoot, "finalize_docs_started", { runDir, prompt: promptFile, summary: summaryFile }, cfg.runsRoot, cfg.stateFile);
  console.log("=== Agentic finalize-docs ===");
  agentCallCounter.count++;
  emitTokenUsage(cfg, await invokeAgentPhase({ ...cfg, promptFile, workingDirectory: runWorktreePath, logFile: executorLog, phase: "finalize-docs" }));

  const changedPaths = uncommittedPaths(runWorktreePath, harnessIgnoredPaths(cfg.worktreeBootstrapIgnore));
  if (changedPaths.length > 0 && !testPathsAreDocumentation(changedPaths)) {
    throw new LoopError(`Finalize-docs changed non-documentation files: ${changedPaths.join(", ")}. Worktree retained at ${runWorktreePath}.`);
  }
  if (changedPaths.length > 0) {
    git(["add", "-A", "--", ...changedPaths], runWorktreePath);
    git(["commit", "-m", "agentic: finalize docs"], runWorktreePath);
  }

  if (!existsSync(summaryFile)) {
    writeFileSync(summaryFile, `# Agentic final summary\n\nFinalizer did not create a summary; inspect ${executorLog}.`, "utf-8");
  }

  appendEvent(cfg.repoRoot, "finalize_docs_finished", {
    runDir, summary: summaryFile, changedPaths,
  }, cfg.runsRoot, cfg.stateFile);
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

function enforceReplanBudget(
  cfg: Required<LoopConfig>,
  sessionReplanCountRef: { count: number },
  phase: string,
  reason: string
): void {
  sessionReplanCountRef.count++;
  if (sessionReplanCountRef.count > 5) {
    appendEvent(cfg.repoRoot, "replan_budget_exhausted", { phase, sessionReplanCount: sessionReplanCountRef.count, maxReplans: 5, reason }, cfg.runsRoot, cfg.stateFile);
    throw new LoopError(`Replan budget exhausted at ${phase} (${sessionReplanCountRef.count - 1} replans >= 5): ${reason}`);
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

import { runStanceReflectionPhase, type StanceReflectionResult } from "./stance-reflection-phase.js";
export { runStanceReflectionPhase, type StanceReflectionResult };

// Main entry point. Throws LoopError with an appropriate exitCode on terminal failures.
export async function runAgenticLoop(config: LoopConfig): Promise<void> {
  const policy = loadPolicy(config.repoRoot);
  const cfg: Required<LoopConfig> = {
    stateFile:          config.stateFile          ?? "agentic.json",
    runsRoot:           config.runsRoot           ?? ".agent-runs",
    worktreeRoot:       config.worktreeRoot       ?? ".worktrees",
    maxRuntimeSeconds:  config.maxRuntimeSeconds  ?? 0,
    checkTimeoutSeconds: config.checkTimeoutSeconds ?? 0,
    extraChecks:        config.extraChecks        ?? [],
    worktreeBootstrap:  config.worktreeBootstrap  ?? policy.autonomousLoop.worktreeBootstrap ?? [],
    worktreeBootstrapIgnore: config.worktreeBootstrapIgnore ?? policy.autonomousLoop.worktreeBootstrapIgnore ?? [],
    checkEnvFile:       config.checkEnvFile       ?? policy.autonomousLoop.checkEnvFile ?? "",
    apply:              config.apply              ?? true,
    finalizeDocs:                config.finalizeDocs                ?? true,
    allowDirty:                  config.allowDirty                  ?? false,
    repoRoot:           config.repoRoot,
    agent:              config.agent,
  };

  const initialState = loadState(cfg.repoRoot, cfg.stateFile);
  if (!initialState) throw new LoopError(`No ${cfg.stateFile} found in ${cfg.repoRoot}`);
  const maxIterations = initialState.maxIterations ?? 10;
  const maxRetries = policy.autonomousLoop.maxRetriesPerTask ?? 3;

  const runStartTime = Date.now();
  const agentCallCounter = { count: 0 };
  const eventLogPath = join(cfg.repoRoot, cfg.runsRoot, "events.jsonl");
  // Capture HEAD at loop start for cumulative diff and finalization admission.
  const loopBaseRef = (() => { try { return git(["rev-parse", "HEAD"], cfg.repoRoot); } catch { return ""; } })();

  if (policy.autonomousLoop.requireCleanMainWorktree && !cfg.allowDirty && git(["status", "--porcelain"], cfg.repoRoot).length > 0) {
    throw new LoopError("Main worktree is dirty. Commit/stash first, or pass --allow-dirty.", 2);
  }

  // ── Planner phase ─────────────────────────────────────────────────────────
  {
    const state = loadState(cfg.repoRoot, cfg.stateFile)!;
    if (getTasks(state).length === 0) {
      await runPlannerPhase(cfg, policy, agentCallCounter);
    }
  }
  // Track replans across the session.
  const sessionReplanCountRef = { count: 0 };

  // ── Single run worktree (shared across all tasks) ─────────────────────────
  const runTs0 = timestamp();
  const runBranch     = `agentic/run-${runTs0}`;
  const runWorktreePath = join(cfg.repoRoot, cfg.worktreeRoot, `run-${runTs0}`);
  createWorktree(runBranch, runWorktreePath, "HEAD", cfg.repoRoot);
  writeWorktreeExclude(runWorktreePath, harnessIgnoredPaths(cfg.worktreeBootstrapIgnore));
  appendEvent(cfg.repoRoot, "run_worktree_created", { branch: runBranch, worktree: runWorktreePath }, cfg.runsRoot, cfg.stateFile);

  // ── Execution loop ────────────────────────────────────────────────────────
  for (let iteration = 1; iteration <= maxIterations; iteration++) {

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
    // Pick next task
    const state = loadState(cfg.repoRoot, cfg.stateFile)!;
    let task: Task | null = getNextTask(state);

    if (!task) {
      if (hasUnfinishedTasks(state)) {
        throw new LoopError(`No runnable task available. Blocked by dependencies:\n${getBlockedDependencySummary(state)}`);
      }
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

    console.log(`=== Agentic iteration ${iteration}/${maxIterations}: ${taskId} ===`);
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
      // Planner owns task understanding. Stale/manual tasks and failures that may
      // invalidate that understanding re-enter the planner instead of paying for a
      // Planner revision is the single source of task understanding.
      const taskState = loadState(cfg.repoRoot, cfg.stateFile)!;
      const replanDecision = shouldReplanBeforeTask(task, taskState);
      appendPhaseAdmission(cfg, "replan", replanDecision, taskId);
      if (replanDecision.run) {
        await invalidatePlanAndReplan({
          cfg, policy, agentCallCounter, sessionReplanCountRef,
          phase: "pre_execution_replan",
          reason: replanDecision.reason,
          resultFile: "",
          currentTaskId: taskId,
          priorFailureAnalysisFile: getLastFailureAnalysisFile(task),
        });
        copyFileSync(join(cfg.repoRoot, cfg.stateFile), stateAfter);
        continue;
      }

      syncCodeGraph(worktreePath);
      writeCodeGraphContext(codeGraphFile, worktreePath);

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
          appendPhaseAdmission(cfg, "stance", { run: true, reason: "high task complexity" }, taskId);
          const stance = await runStanceReflectionPhase(cfg, agentCallCounter, task, runDir, worktreePath, codeGraphFile);
          approvedStance = stance.result;
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          setTaskStatus(cfg.repoRoot, cfg.stateFile, cfg.runsRoot, taskId, "needs_human", { at: new Date().toISOString(), phase: "stance_reflection", reason });
          copyFileSync(join(cfg.repoRoot, cfg.stateFile), stateAfter);
          throw err;
        }
      }
      if (complexity.level !== "high") appendPhaseAdmission(cfg, "stance", { run: false, reason: `${complexity.level} task complexity` }, taskId);

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
        budget: "medium",
        state,
        task,
        iteration,
        runDir,
        eventLogPath,
        codeGraphFile,
        policy,
        approvedStance,
      });

      appendEvent(cfg.repoRoot, "executor_started", { task: taskId, prompt: executorPrompt, log: executorLog }, cfg.runsRoot, cfg.stateFile);
      try {
        agentCallCounter.count++;
        const invocation = await invokeAgentPhase({ ...cfg, promptFile: executorPrompt, workingDirectory: worktreePath, logFile: executorLog, phase: "executor", taskId });
        emitTokenUsage(cfg, invocation, taskId);
        appendEvent(cfg.repoRoot, "executor_passed", { task: taskId, log: executorLog }, cfg.runsRoot, cfg.stateFile);
      } catch (err) {
        if (err instanceof AgentPhaseMutationError) {
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
        const failureStatus = getFailureStatusForTask(task, "checks", maxRetries);
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
          const failureStatus = getFailureStatusForTask(task, "checks", maxRetries);
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

      // Resolve verification intensity from actual diff evidence after checks.
      // Task kind describes the work; it does not determine risk by itself.
      const changedPaths = changedPathsSince(worktreePath, "", harnessIgnoredPaths(cfg.worktreeBootstrapIgnore));
      const verifierDecision = shouldRunVerifier(task, policy, changedPaths);
      appendPhaseAdmission(cfg, "verifier", verifierDecision, taskId);
      appendEvent(cfg.repoRoot, "verification_profile_resolved", {
        task: taskId,
        risk: verifierDecision.risk,
        verifierMode: verifierDecision.verifierMode,
        votes: verifierDecision.votes,
        reasons: verifierDecision.reasons,
        evidence: verifierDecision.evidence,
      }, cfg.runsRoot, cfg.stateFile);
      let verifierResultObj: VerifierResult;
      if (!verifierDecision.run) {
        verifierResultObj = { verdict: "pass", summary: `Deterministic checks passed; independent verifier skipped (${verifierDecision.reason})`, issues: [], humanGates: [], recommendedStatus: "passed", artifacts: [] };
        writeFileSync(verifierResult, JSON.stringify(verifierResultObj, null, 2), "utf-8");
        writeFileSync(verifierLog, "Independent verifier skipped after deterministic low-risk checks passed.", "utf-8");
        appendEvent(cfg.repoRoot, "verifier_skipped", { task: taskId, resultFile: verifierResult, log: verifierLog, reason: verifierDecision.reason }, cfg.runsRoot, cfg.stateFile);
      } else {
        const votes = verifierDecision.votes;
        const adversarial = votes > 1;

        if (votes <= 1) {
          const verifierOptions = { repoRoot: cfg.repoRoot, runsRoot: cfg.runsRoot, stateFile: cfg.stateFile, budget: "medium" as const, task, worktreePath, checkOutput, resultFile: verifierResult, eventLogPath, policy, adversarial: false };
          writeVerifierPrompt(verifierPrompt, verifierOptions);
          appendEvent(cfg.repoRoot, "verifier_started", { task: taskId, prompt: verifierPrompt, resultFile: verifierResult, log: verifierLog, votes: 1 }, cfg.runsRoot, cfg.stateFile);
          agentCallCounter.count++;
          emitTokenUsage(cfg, await invokeAgentPhase({ ...cfg, promptFile: verifierPrompt, workingDirectory: worktreePath, logFile: verifierLog, phase: "verifier", taskId }), taskId);
          if (!existsSync(verifierResult)) throw new LoopError(`Verifier did not write ${verifierResult}`);
          verifierResultObj = JSON.parse(readFileSync(verifierResult, "utf-8")) as VerifierResult;
        } else {
          appendEvent(cfg.repoRoot, "verifier_votes_started", { task: taskId, votes, adversarial: true }, cfg.runsRoot, cfg.stateFile);
          const voteSlots = Array.from({ length: votes }, (_, i) => i + 1).map((v) => ({
            prompt: join(runDir, `verifier-vote-${v}.md`),
            result: join(runDir, `verifier-vote-${v}.json`),
            log:    join(runDir, `verifier-vote-${v}.log`),
            v,
          }));
          for (const { prompt: vPrompt, result: vResult, log: vLog, v } of voteSlots) {
            writeVerifierPrompt(vPrompt, { repoRoot: cfg.repoRoot, runsRoot: cfg.runsRoot, stateFile: cfg.stateFile, budget: "medium", task, worktreePath, checkOutput, resultFile: vResult, eventLogPath, policy, adversarial });
            appendEvent(cfg.repoRoot, "verifier_started", { task: taskId, prompt: vPrompt, resultFile: vResult, log: vLog, vote: v, votes }, cfg.runsRoot, cfg.stateFile);
            agentCallCounter.count++;
          }
          const voteUsages = await Promise.all(voteSlots.map(({ prompt: vPrompt, log: vLog, v }) =>
            invokeAgentPhase({ ...cfg, promptFile: vPrompt, workingDirectory: worktreePath, logFile: vLog, phase: `verifier-vote-${v}`, taskId })
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
        {
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

      } else if (verifierResultObj.verdict === "needs_human") {
        writeFailureAnalysis({ taskId, phase: "verifier", attempt: task.attempts ?? 1, rawOutput: [verifierResultObj.summary ?? "", ...(verifierResultObj.issues ?? [])].filter(Boolean).join("\n"), worktreePath, outputFile: failureAnalysisFile });
        setTaskStatus(cfg.repoRoot, cfg.stateFile, cfg.runsRoot, taskId, "needs_human", { at: new Date().toISOString(), phase: "verifier", reason: verifierResultObj.summary ?? "", resultFile: verifierResult, failureAnalysisFile });
        copyFileSync(join(cfg.repoRoot, cfg.stateFile), stateAfter);
        throw new LoopError(`Verifier returned needs_human for ${taskId}. Worktree retained at ${worktreePath}.`);

      } else {
        const failureStatus = getFailureStatusForTask(task, "verifier", maxRetries);
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
    await runFinalizeDocsIfNeeded(cfg, policy, agentCallCounter, runWorktreePath, loopBaseRef);
    applyRunWorktree(cfg, runBranch, runWorktreePath);
    console.log("<promise>COMPLETE</promise>");
    return;
  }

  const tasks = getTasks(finalState);
  const completed = tasks.filter((t) => t.status === "passed").length;
  const unfinished = tasks.filter((t) => !["passed", "blocked"].includes(t.status ?? "")).length;
  throw new LoopError(
    `Reached max iterations (${maxIterations}) with unfinished tasks: completed ${completed} of ${tasks.length}; ${unfinished} unfinished. Increase maxIterations in ${cfg.stateFile} to continue.`,
    1
  );
}
