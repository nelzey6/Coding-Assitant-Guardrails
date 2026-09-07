import { createHash } from "crypto";
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
  installDirectTask,
  computePlanContextFingerprint,
  type AgenticState,
  type Task,
  type PlannerResult,
  type VerifierResult,
  type CheckBatch,
  formatReviewIssue,
} from "../state/index.js";
import { appendEvent } from "../events/index.js";
import { safeSlug, createWorktree, worktreeExists, removeWorktree, git as gitTool, GitError } from "../tools/index.js";
import type { AgentConfig, AgentInvocationResult } from "../agent/index.js";
import { AgentPhaseMutationError, invokeAgentPhase } from "./agent-phase.js";
import { resolveChecks, runChecks, buildReviewEvidence, parseMetricLines, validateAcceptanceChecks } from "../checks/index.js";
import { getTaskScope, getOutOfScopeFiles, isTaskUnscoped, resolveTaskComplexity, testPathInScope, testPathsAreDocumentation } from "../scope/index.js";
import {
  syncCodeGraph,
  writeCodeGraphContext,
  writeRepoContext,
  writePlannerPrompt,
  writeExecutorPrompt,
  writeVerifierPrompt,
  writeStanceReflectionPrompt,
  validatePlannerResult,
  validateVerifierResult,
  validateDecisions,
  writeFailureAnalysis,
} from "../prompts/index.js";
import { loadPolicy, resolveEffectivePlannerMode, type WorkflowPolicy } from "../policy/index.js";
import { selectExecutionRoute, validateDirectExecutionResult, type DirectExecutionResult } from "../routing/index.js";
import { phaseLatencyDecision, resolveLatencyPolicy, type LatencyRoute } from "../latency/index.js";
import { runShellScript, validateShellSyntax } from "../tools/shell.js";
import {
  shouldReplanBeforeTask,
  shouldRunVerifier,
  shouldUseCompactExecutor,
} from "../admission/index.js";

export interface LoopConfig {
  repoRoot: string;
  stateFile?: string;
  runsRoot?: string;
  worktreeRoot?: string;
  /** One agent adapter for planning, stance, execution, and verification. */
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
  recordPhaseLatency(cfg, invocation.phase, invocation.durationMs, taskId);
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

function recordPhaseLatency(cfg: Required<LoopConfig>, phase: string, durationMs: number, taskId?: string): void {
  const decision = phaseLatencyDecision(phase, durationMs, resolveLatencyPolicy(loadPolicy(cfg.repoRoot)));
  appendEvent(cfg.repoRoot, "phase_latency", {
    ...(taskId ? { task: taskId } : {}),
    phase,
    category: decision.phase,
    durationMs,
    targetSeconds: decision.targetSeconds,
    exceeded: decision.exceeded,
  }, cfg.runsRoot, cfg.stateFile);
  if (decision.exceeded) {
    appendEvent(cfg.repoRoot, "latency_target_exceeded", {
      ...(taskId ? { task: taskId } : {}),
      scope: "phase",
      phase,
      durationMs,
      targetSeconds: decision.targetSeconds,
    }, cfg.runsRoot, cfg.stateFile);
  }
}

function timestamp(): string {
  return new Date().toISOString().replace(/[-:.]/g, "").replace("T", "-").replace("Z", "");
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
  const codeGraphFile    = join(plannerRunDir, "codegraph.md");
  const plannerLogFile   = join(plannerRunDir, "planner.log");

  const state = loadState(cfg.repoRoot, cfg.stateFile)!;

  const plannerMode = resolveEffectivePlannerMode(policy, state, priorFailureAnalysisFile);
  const grillFile = plannerMode.mode === "full" ? join(plannerRunDir, "grill-transcript.md") : "";
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

  appendEvent(cfg.repoRoot, "planner_started", { runDir: plannerRunDir, prompt: promptFile, resultFile, ...(grillFile ? { grillTranscript: grillFile } : {}), log: plannerLogFile }, cfg.runsRoot, cfg.stateFile);
  console.log("=== Agentic planner ===");
  agentCallCounter.count++;
  emitTokenUsage(cfg, await invokeAgentPhase({ ...cfg, promptFile, workingDirectory: cfg.repoRoot, logFile: plannerLogFile, phase: "planner" }));

  if (!existsSync(resultFile)) throw new LoopError(`Planner did not write ${resultFile}`);
  if (grillFile && !existsSync(grillFile)) throw new LoopError(`Planner did not write ${grillFile}`);

  let plannerResult = JSON.parse(readFileSync(resultFile, "utf-8")) as Record<string, unknown>;
  let errors = [
    ...validatePlannerResult(plannerResult, policy, { goal: state.goal, enforceCoherentSlices: plannerMode.mode === "full" }),
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
      ...validatePlannerResult(plannerResult, policy, { goal: state.goal, enforceCoherentSlices: plannerMode.mode === "full" }),
      ...validateDecisions(plannerResult["decisions"] ?? []),
    ];
    if (errors.length > 0) throw new LoopError(`Planner result invalid after repair:\n${errors.join("\n")}`);
  }

  appendEvent(cfg.repoRoot, "planner_finished", { runDir: plannerRunDir, verdict: plannerResult["verdict"], resultFile, ...(grillFile ? { grillTranscript: grillFile } : {}) }, cfg.runsRoot, cfg.stateFile);
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

function bootstrapFingerprint(worktree: string, commands: string[], ignoredPaths: string[]): string {
  const files = [...new Set(git(["ls-files", "--cached", "--others", "--exclude-standard", "-z"], worktree).split("\0"))]
    .filter((path) => /(?:^|\/)(?:package(?:-lock)?\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|pnpm-workspace\.yaml|bun\.lockb?|\.npmrc|\.yarnrc(?:\.yml)?|\.node-version|\.nvmrc)$/.test(path))
    .filter((path) => !testPathInScope(path, ignoredPaths)).sort();
  const hash = createHash("sha256").update(JSON.stringify([commands, process.version, process.platform, process.arch]));
  for (const path of files) {
    hash.update(path).update(existsSync(join(worktree, path)) ? readFileSync(join(worktree, path)) : "deleted");
  }
  return hash.digest("hex");
}

/** Protocol repair cannot edit code or consume a code attempt. */
async function readPhaseResult<T>(cfg: Required<LoopConfig>, taskId: string, phase: string, resultFile: string,
  worktree: string, context: string, validate: (value: unknown) => string[], beforeRepair: () => void): Promise<T> {
  for (let attempt = 0; attempt < 2; attempt++) {
    let value: unknown;
    let errors: string[];
    try {
      value = JSON.parse(readFileSync(resultFile, "utf-8"));
      // Semantic objections and gates are outcomes, never format repairs that could erase them.
      if (phase.startsWith("verifier") && value && typeof value === "object") {
        const result = value as VerifierResult;
        if (Array.isArray(result.humanGates) && result.humanGates.length) result.verdict = "needs_human";
        else if (Array.isArray(result.issues) && result.issues.length) result.verdict = "fail";
      }
      errors = validate(value);
    } catch (error) { errors = [error instanceof Error ? error.message : String(error)]; }
    if (!errors.length) return value as T;
    appendEvent(cfg.repoRoot, "phase_result_invalid", { task: taskId, phase, errors, resultFile, repairAttempt: attempt }, cfg.runsRoot, cfg.stateFile);
    if (attempt === 1) throw new LoopError(`Invalid ${phase} result after one artifact repair: ${errors.join("; ")}`);
    beforeRepair();
    const promptFile = join(dirname(resultFile), `${phase}-repair.md`);
    writeFileSync(promptFile, [
      "Repair only the named result artifact. This is not an implementation attempt.",
      "Do not edit, commit, install or otherwise mutate repository files. Preserve existing human gates and defects. Do not invent successful evidence.",
      `Repair result JSON only to: ${resultFile}`,
      `Validation errors: ${JSON.stringify(errors)}`,
      "Previous response:", JSON.stringify(value ?? null),
      "Authoritative context and output contract:", context,
    ].join("\n"));
    appendEvent(cfg.repoRoot, "artifact_repair_started", { task: taskId, phase, resultFile }, cfg.runsRoot, cfg.stateFile);
    const invocation = await invokeAgentPhase({ ...cfg, promptFile, workingDirectory: worktree,
      logFile: join(dirname(resultFile), `${phase}-repair.log`), phase: `${phase}-repair`, taskId, readOnlyCandidate: true });
    emitTokenUsage(cfg, invocation, taskId);
  }
  throw new LoopError("Unreachable result repair state");
}

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
  let runLatencyRoute: LatencyRoute = "planned";
  let completed = false;
  let failedStage = "admission";
  let terminalReason: string | undefined;
  let retainedWorktree: string | undefined;
  let activeTaskId: string | undefined;
  const recordRunLatency = (): void => {
    const latency = resolveLatencyPolicy(policy);
    const targetSeconds = runLatencyRoute === "direct"
      ? latency.directTargetSeconds
      : runLatencyRoute === "complex"
        ? latency.complexTargetSeconds
        : latency.plannedTargetSeconds;
    const durationMs = Date.now() - runStartTime;
    appendEvent(cfg.repoRoot, "run_latency", { route: runLatencyRoute, outcome: completed ? "completed" : "stopped", durationMs, targetSeconds, exceeded: durationMs > targetSeconds * 1000 }, cfg.runsRoot, cfg.stateFile);
    if (durationMs > targetSeconds * 1000) {
      appendEvent(cfg.repoRoot, "latency_target_exceeded", { scope: "run", route: runLatencyRoute, durationMs, targetSeconds }, cfg.runsRoot, cfg.stateFile);
    }
  };

  try {
    if (policy.autonomousLoop.requireCleanMainWorktree && !cfg.allowDirty && git(["status", "--porcelain"], cfg.repoRoot).length > 0) {
      throw new LoopError("Main worktree is dirty. Commit/stash first, or pass --allow-dirty.", 2);
    }

    // ── Planner phase ─────────────────────────────────────────────────────────
    {
      const state = loadState(cfg.repoRoot, cfg.stateFile)!;
      if (getTasks(state).length === 0) {
        const route = selectExecutionRoute(state, policy, cfg.repoRoot);
        appendEvent(cfg.repoRoot, "execution_route_selected", {
          route: route.route,
          reason: route.reason,
          paths: route.paths,
        }, cfg.runsRoot, cfg.stateFile);
        if (route.route === "direct") installDirectTask(cfg.repoRoot, cfg.stateFile, route.task);
        else { failedStage = "planner"; await runPlannerPhase(cfg, policy, agentCallCounter); }
        runLatencyRoute = route.route === "direct" ? "direct" : "planned";
      }
    }
    // Track replans across the session.
    const sessionReplanCountRef = { count: 0 };

    // ── Single run worktree (shared across all tasks) ─────────────────────────
    const runTs0 = timestamp();
    const runBranch     = `agentic/run-${runTs0}`;
    const runWorktreePath = join(cfg.repoRoot, cfg.worktreeRoot, `run-${runTs0}`);
    failedStage = "worktree";
    createWorktree(runBranch, runWorktreePath, "HEAD", cfg.repoRoot);
    retainedWorktree = runWorktreePath;
    writeWorktreeExclude(runWorktreePath, harnessIgnoredPaths(cfg.worktreeBootstrapIgnore));
    appendEvent(cfg.repoRoot, "run_worktree_created", { branch: runBranch, worktree: runWorktreePath }, cfg.runsRoot, cfg.stateFile);

    let bootstrappedFingerprint: string | undefined;

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
          failedStage = "budget";
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
        failedStage = "apply";
        applyRunWorktree(cfg, runBranch, runWorktreePath);
        completed = true;
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
      const directResultFile = join(runDir, "direct-execution-result.json");
      const checksLog       = join(runDir, "checks.log");
      const verifierLog     = join(runDir, "verifier.log");
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
      activeTaskId = taskId;

      writeWorktreeExclude(worktreePath, harnessIgnoredPaths(cfg.worktreeBootstrapIgnore));

      try {
        const ensureBootstrap = (): void => {
          if (cfg.worktreeBootstrap.length === 0) return;
          const fingerprint = bootstrapFingerprint(worktreePath, cfg.worktreeBootstrap, cfg.worktreeBootstrapIgnore);
          if (fingerprint === bootstrappedFingerprint) return;
          failedStage = "bootstrap";
          const bootstrapLog = join(runDir, "bootstrap.log");
          appendEvent(cfg.repoRoot, "worktree_bootstrap_started", { task: taskId, commands: cfg.worktreeBootstrap, ignored: cfg.worktreeBootstrapIgnore, log: bootstrapLog }, cfg.runsRoot, cfg.stateFile);
          try {
            const bootstrapOutput = runWorktreeBootstrap(worktreePath, cfg.worktreeBootstrap, cfg.checkTimeoutSeconds || 120);
            writeFileSync(bootstrapLog, bootstrapOutput, "utf-8");
            bootstrappedFingerprint = bootstrapFingerprint(worktreePath, cfg.worktreeBootstrap, cfg.worktreeBootstrapIgnore);
            appendEvent(cfg.repoRoot, "worktree_bootstrap_passed", { task: taskId, log: bootstrapLog }, cfg.runsRoot, cfg.stateFile);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            writeFileSync(bootstrapLog, msg, "utf-8");
            appendEvent(cfg.repoRoot, "worktree_bootstrap_failed", { task: taskId, reason: msg, log: bootstrapLog }, cfg.runsRoot, cfg.stateFile);
            setTaskStatus(cfg.repoRoot, cfg.stateFile, cfg.runsRoot, taskId, "needs_human", { at: new Date().toISOString(), phase: "bootstrap", reason: msg });
            copyFileSync(join(cfg.repoRoot, cfg.stateFile), stateAfter);
            throw new LoopError(`Worktree bootstrap failed for ${taskId}. Worktree retained at ${worktreePath}.\n${msg}`);
          }
        };
        // Planner owns task understanding. Stale/manual tasks and failures that may
        // invalidate that understanding re-enter the planner instead of paying for a
        // Planner revision is the single source of task understanding.
        const taskState = loadState(cfg.repoRoot, cfg.stateFile)!;
        const replanDecision = shouldReplanBeforeTask(task, taskState);
        appendPhaseAdmission(cfg, "replan", replanDecision, taskId);
        if (replanDecision.run) {
          failedStage = "planner";
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

        ensureBootstrap();
        const complexity = resolveTaskComplexity(task as any, policy);
        task.complexity = complexity.level;
        if (complexity.level === "high") runLatencyRoute = "complex";
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

        const compactExecutor = shouldUseCompactExecutor(task, policy);
        if (!compactExecutor) {
          syncCodeGraph(worktreePath);
          writeCodeGraphContext(codeGraphFile, worktreePath);
        }

        let approvedStance: StanceReflectionResult | undefined;
        if (complexity.level === "high") {
          try {
            failedStage = "stance";
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

        // Known evidence is resolved before the model sees the task.
        const knownChecks = resolveChecks(worktreePath, state.checks ?? [], task.validation ?? [], cfg.extraChecks);
        for (const check of knownChecks) {
          const error = validateShellSyntax(check.command);
          if (error) { failedStage = "check_configuration"; throw new LoopError(`Invalid configured check ${check.id}: ${error}`); }
        }
        const beforeRepair = (): void => {
          if (cfg.maxRuntimeSeconds > 0 && Date.now() - runStartTime >= cfg.maxRuntimeSeconds * 1000) throw new LoopError("Runtime budget exhausted before artifact repair");
          agentCallCounter.count++;
        };
        // Executor
        failedStage = "executor";
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
          directResultFile: task.origin === "direct" ? directResultFile : undefined,
          checks: knownChecks,
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

        if (task.origin === "direct") {
          failedStage = "direct_result";
          const directResult = await readPhaseResult<DirectExecutionResult>(cfg, taskId, "direct-result", directResultFile,
            worktreePath, [
              'Schema: {"verdict":"completed|needs_planner|needs_human","summary":"...","validation":[],"assumptions":[]}',
              "validation contains only executable additional shell commands, no descriptions. Empty is valid when configured checks suffice. Do not remove needed assertions.",
              `Task: ${JSON.stringify(task)}`, `Configured checks: ${JSON.stringify(knownChecks)}`,
            ].join("\n"), (value) => validateDirectExecutionResult(value, knownChecks.map((check) => check.command)), beforeRepair);

          if (directResult.verdict === "needs_human") {
            setTaskStatus(cfg.repoRoot, cfg.stateFile, cfg.runsRoot, taskId, "needs_human", { at: new Date().toISOString(), phase: "direct_execution", reason: directResult.summary, resultFile: directResultFile });
            writeChecksLog(checksLog, "Checks not run because Direct Executor requested human input.");
            writeDiffArtifacts(worktreePath, runDir, harnessIgnoredPaths(cfg.worktreeBootstrapIgnore));
            copyFileSync(join(cfg.repoRoot, cfg.stateFile), stateAfter);
            throw new LoopError(`Direct Executor needs human input for ${taskId}: ${directResult.summary}`);
          }
          if (directResult.verdict === "needs_planner") {
            const changed = uncommittedPaths(worktreePath, harnessIgnoredPaths(cfg.worktreeBootstrapIgnore));
            if (changed.length > 0) {
              const reason = `Direct Executor returned needs_planner after changing: ${changed.join(", ")}`;
              setTaskStatus(cfg.repoRoot, cfg.stateFile, cfg.runsRoot, taskId, "needs_human", { at: new Date().toISOString(), phase: "direct_execution", reason, resultFile: directResultFile });
              writeChecksLog(checksLog, "Checks not run because Direct Executor requested planning after editing the worktree.");
              writeDiffArtifacts(worktreePath, runDir, harnessIgnoredPaths(cfg.worktreeBootstrapIgnore));
              copyFileSync(join(cfg.repoRoot, cfg.stateFile), stateAfter);
              throw new LoopError(reason);
            }
            failedStage = "planner";
            runLatencyRoute = "planned";
            appendEvent(cfg.repoRoot, "direct_execution_needs_planner", { task: taskId, reason: directResult.summary, resultFile: directResultFile }, cfg.runsRoot, cfg.stateFile);
            await invalidatePlanAndReplan({
              cfg, policy, agentCallCounter, sessionReplanCountRef,
              phase: "direct_execution",
              reason: directResult.summary,
              resultFile: directResultFile,
              currentTaskId: taskId,
            });
            copyFileSync(join(cfg.repoRoot, cfg.stateFile), stateAfter);
            continue;
          }

          task.validation = [...new Set([...(task.validation ?? []), ...directResult.validation])];
          const directState = loadState(cfg.repoRoot, cfg.stateFile)!;
          const directTask = getTasks(directState).find((candidate) => candidate.id === taskId);
          if (directTask) directTask.validation = task.validation;
          if (directResult.assumptions.length > 0) {
            directState.assumptions = [...new Set([...(directState.assumptions ?? []), ...directResult.assumptions])];
          }
          // Direct execution owns its accepted assumptions; check retries keep that understanding.
          if (directTask) directTask.plannedContextFingerprint = computePlanContextFingerprint(directState);
          writeState(cfg.repoRoot, directState, cfg.stateFile);
          appendEvent(cfg.repoRoot, "direct_execution_completed", { task: taskId, summary: directResult.summary, validation: directResult.validation, assumptions: directResult.assumptions }, cfg.runsRoot, cfg.stateFile);
        }

        ensureBootstrap();
        writeDiffArtifacts(worktreePath, runDir, harnessIgnoredPaths(cfg.worktreeBootstrapIgnore));
        // Checks
        failedStage = "checks";
        const definitions = isArtifactOnlyTask(task) && cfg.extraChecks.length === 0 ? []
          : resolveChecks(worktreePath, state.checks ?? [], task.validation ?? [], cfg.extraChecks);
        const taskChecks = definitions.map((check) => check.command);
        let batch: CheckBatch | undefined;
        appendEvent(cfg.repoRoot, "checks_started", { task: taskId, commands: taskChecks, log: checksLog }, cfg.runsRoot, cfg.stateFile);
        let checkOutput: string;
        const checksStartedAt = Date.now();
        try {
          if (!["discovery", "investigation", "handoff"].includes(task.kind ?? "implementation")) {
            const proofErrors = validateAcceptanceChecks(taskChecks);
            if (proofErrors.length > 0) throw new Error(proofErrors.join("; "));
          }
          batch = runChecks(worktreePath, definitions, cfg.checkTimeoutSeconds || 120, cfg.checkEnvFile);
          writeFileSync(join(runDir, "check-evidence.json"), JSON.stringify(batch, null, 2));
          checkOutput = batch.log;
          if (batch.failureKind) throw new Error(batch.log);
          recordPhaseLatency(cfg, "checks", Date.now() - checksStartedAt, taskId);
          writeChecksLog(checksLog, checkOutput);
          const metrics = parseMetricLines(checkOutput);
          appendEvent(cfg.repoRoot, "checks_passed", { task: taskId, log: checksLog, metrics }, cfg.runsRoot, cfg.stateFile);
        } catch (err) {
          recordPhaseLatency(cfg, "checks", Date.now() - checksStartedAt, taskId);
          checkOutput = err instanceof Error ? err.message : String(err);
          writeChecksLog(checksLog, checkOutput);
          const failureStatus = !batch || (batch.failureKind && batch.failureKind !== "code") ? "needs_human" : getFailureStatusForTask(task, "checks", maxRetries);
          const metrics = parseMetricLines(checkOutput);
          appendEvent(cfg.repoRoot, "checks_failed", { task: taskId, status: failureStatus, failureKind: batch?.failureKind ?? "configuration", reason: checkOutput, log: checksLog, metrics }, cfg.runsRoot, cfg.stateFile);
          writeFailureAnalysis({ taskId, phase: "checks", attempt: task.attempts ?? 1, rawOutput: checkOutput, worktreePath, outputFile: failureAnalysisFile });
          setTaskStatus(cfg.repoRoot, cfg.stateFile, cfg.runsRoot, taskId, failureStatus, { at: new Date().toISOString(), phase: "checks", reason: checkOutput, resultFile: verifierResult, failureAnalysisFile });
          writeDiffArtifacts(worktreePath, runDir, harnessIgnoredPaths(cfg.worktreeBootstrapIgnore));
          copyFileSync(join(cfg.repoRoot, cfg.stateFile), stateAfter);
          if (failureStatus === "needs_retry") { console.warn(`Checks failed for ${taskId}; marked ${failureStatus}.`); continue; }
          throw new LoopError(`Checks failed for ${taskId}; marked ${failureStatus}. Worktree retained at ${worktreePath}.\n${checkOutput}`);
        }

        writeDiffArtifacts(worktreePath, runDir, harnessIgnoredPaths(cfg.worktreeBootstrapIgnore));

        failedStage = "scope";
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

        const evidence = buildReviewEvidence(task, batch!, worktreePath);
        writeFileSync(join(runDir, "review-evidence.json"), JSON.stringify(evidence, null, 2));
        failedStage = "verifier";
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
            const verifierOptions = { repoRoot: cfg.repoRoot, runsRoot: cfg.runsRoot, stateFile: cfg.stateFile, budget: "medium" as const, task: { ...task, validation: taskChecks }, worktreePath, checkOutput, evidence, resultFile: verifierResult, eventLogPath, policy, adversarial: false };
            writeVerifierPrompt(verifierPrompt, verifierOptions);
            appendEvent(cfg.repoRoot, "verifier_started", { task: taskId, prompt: verifierPrompt, resultFile: verifierResult, log: verifierLog, votes: 1 }, cfg.runsRoot, cfg.stateFile);
            agentCallCounter.count++;
            emitTokenUsage(cfg, await invokeAgentPhase({ ...cfg, promptFile: verifierPrompt, workingDirectory: worktreePath, logFile: verifierLog, phase: "verifier", taskId }), taskId);
            verifierResultObj = await readPhaseResult<VerifierResult>(cfg, taskId, "verifier", verifierResult,
              worktreePath, readFileSync(verifierPrompt, "utf-8"), (value) => validateVerifierResult(value, task!, evidence), beforeRepair);
          } else {
            appendEvent(cfg.repoRoot, "verifier_votes_started", { task: taskId, votes, adversarial: true }, cfg.runsRoot, cfg.stateFile);
            const voteSlots = Array.from({ length: votes }, (_, i) => i + 1).map((v) => ({
              prompt: join(runDir, `verifier-vote-${v}.md`),
              result: join(runDir, `verifier-vote-${v}.json`),
              log:    join(runDir, `verifier-vote-${v}.log`),
              v,
            }));
            for (const { prompt: vPrompt, result: vResult, log: vLog, v } of voteSlots) {
              writeVerifierPrompt(vPrompt, { repoRoot: cfg.repoRoot, runsRoot: cfg.runsRoot, stateFile: cfg.stateFile, budget: "medium", task: { ...task, validation: taskChecks }, worktreePath, checkOutput, evidence, resultFile: vResult, eventLogPath, policy, adversarial, reviewFocus: ["Behavioral correctness and edge cases", "Compatibility, ownership and public contracts", "Acceptance proof, scope and unresolved human gates"][v - 1] });
              appendEvent(cfg.repoRoot, "verifier_started", { task: taskId, prompt: vPrompt, resultFile: vResult, log: vLog, vote: v, votes }, cfg.runsRoot, cfg.stateFile);
              agentCallCounter.count++;
            }
            const voteOutcomes = await Promise.allSettled(voteSlots.map(({ prompt: vPrompt, log: vLog, v }) =>
              invokeAgentPhase({ ...cfg, promptFile: vPrompt, workingDirectory: worktreePath, logFile: vLog, phase: `verifier-vote-${v}`, taskId })
            ));
            for (const outcome of voteOutcomes) {
              if (outcome.status === "fulfilled") emitTokenUsage(cfg, outcome.value, taskId);
            }
            const failedVote = voteOutcomes.find((outcome) => outcome.status === "rejected");
            if (failedVote?.status === "rejected") throw failedVote.reason;
            const voteResults: VerifierResult[] = [];
            // Wait for every initial vote above; protocol repairs remain bounded per vote.
            for (const { result: vResult, prompt: vPrompt, v } of voteSlots) {
              const vr = await readPhaseResult<VerifierResult>(cfg, taskId, `verifier-vote-${v}`, vResult,
                worktreePath, readFileSync(vPrompt, "utf-8"), (value) => validateVerifierResult(value, task!, evidence), beforeRepair);
              appendEvent(cfg.repoRoot, "verifier_vote", { task: taskId, vote: v, verdict: vr.verdict, summary: vr.summary }, cfg.runsRoot, cfg.stateFile);
              voteResults.push(vr);
            }
            const passCount      = voteResults.filter((r) => r.verdict === "pass").length;
            const needsHumanCount = voteResults.filter((r) => r.verdict === "needs_human").length;
            const finalVerdict: VerifierResult["verdict"] =
              needsHumanCount > 0 || voteResults.some((r) => (r.humanGates ?? []).length > 0) ? "needs_human"
              : passCount === votes ? "pass"
              : "fail";
            const issues = voteResults.flatMap((r) => r.issues ?? []).filter(Boolean);
            verifierResultObj = {
              verdict: finalVerdict,
              summary: `adversarial ${votes}-vote verdict: ${passCount} pass / ${votes - passCount - needsHumanCount} fail / ${needsHumanCount} needs_human (all reviewers must pass) -> ${finalVerdict}`,
              issues,
              coverage: voteResults.flatMap((r) => r.coverage ?? []),
              humanGates: [...new Set(voteResults.flatMap((r) => r.humanGates ?? []))],
              recommendedStatus: finalVerdict === "pass" ? "passed" : finalVerdict === "needs_human" ? "needs_human" : "needs_retry",
              artifacts: [],
            };
            writeFileSync(verifierResult, JSON.stringify(verifierResultObj, null, 2), "utf-8");
            writeFileSync(verifierLog, verifierResultObj.summary ?? "", "utf-8");
            appendEvent(cfg.repoRoot, "verifier_votes_finished", { task: taskId, votes, passCount, needsHuman: needsHumanCount, verdict: finalVerdict }, cfg.runsRoot, cfg.stateFile);
          }
        }

        if ((verifierResultObj.humanGates ?? []).length > 0) {
          verifierResultObj.verdict = "needs_human";
          verifierResultObj.recommendedStatus = "needs_human";
          writeFileSync(verifierResult, JSON.stringify(verifierResultObj, null, 2), "utf-8");
        }
        appendEvent(cfg.repoRoot, "verifier_finished", { task: taskId, verdict: verifierResultObj.verdict, summary: verifierResultObj.summary, resultFile: verifierResult }, cfg.runsRoot, cfg.stateFile);

        // Handle verdict
        if (verifierResultObj.verdict === "pass") {
          buildReviewEvidence(task, batch!, worktreePath);
          failedStage = "commit";
          {
            // Stage the validated candidate file list; negative ignored-directory
            // pathspecs make git add fail on real dependency installations.
            if (changedPaths.length > 0) git(["--literal-pathspecs", "add", "-A", "--", ...changedPaths], worktreePath);
            const changed = (() => { try { git(["diff", "--cached", "--quiet"], worktreePath); return ""; } catch { return "staged"; } })();
            if (changed) git(["commit", "-m", `agentic: ${taskId}`], worktreePath);
            else console.log(`No changes to commit for ${taskId}.`);
          }
          setTaskPassed(cfg.repoRoot, cfg.stateFile, cfg.runsRoot, taskId, verifierResultObj);

          copyFileSync(join(cfg.repoRoot, cfg.stateFile), stateAfter);

        } else if (verifierResultObj.verdict === "needs_human") {
          writeFailureAnalysis({ taskId, phase: "verifier", attempt: task.attempts ?? 1, rawOutput: [verifierResultObj.summary ?? "", ...(verifierResultObj.issues ?? []).map(formatReviewIssue)].filter(Boolean).join("\n"), worktreePath, outputFile: failureAnalysisFile });
          setTaskStatus(cfg.repoRoot, cfg.stateFile, cfg.runsRoot, taskId, "needs_human", { at: new Date().toISOString(), phase: "verifier", reason: verifierResultObj.summary ?? "", resultFile: verifierResult, failureAnalysisFile });
          copyFileSync(join(cfg.repoRoot, cfg.stateFile), stateAfter);
          throw new LoopError(`Verifier returned needs_human for ${taskId}. Worktree retained at ${worktreePath}.`);

        } else {
          const failureStatus = getFailureStatusForTask(task, "verifier", maxRetries);
          writeFailureAnalysis({ taskId, phase: "verifier", attempt: task.attempts ?? 1, rawOutput: [verifierResultObj.summary ?? "", ...(verifierResultObj.issues ?? []).map(formatReviewIssue)].filter(Boolean).join("\n"), worktreePath, outputFile: failureAnalysisFile });
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
      failedStage = "apply";
      applyRunWorktree(cfg, runBranch, runWorktreePath);
      completed = true;
      console.log("<promise>COMPLETE</promise>");
      return;
    }

    const tasks = getTasks(finalState);
    const completedCount = tasks.filter((t) => t.status === "passed").length;
    const unfinished = tasks.filter((t) => !["passed", "blocked"].includes(t.status ?? "")).length;
    throw new LoopError(
      `Reached max iterations (${maxIterations}) with unfinished tasks: completed ${completedCount} of ${tasks.length}; ${unfinished} unfinished. Increase maxIterations in ${cfg.stateFile} to continue.`,
      1
    );
  } catch (error) {
    terminalReason = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    // Recording failures must not hide the original outcome.
    try {
      const terminalState = loadState(cfg.repoRoot, cfg.stateFile);
      if (terminalState) {
        for (const task of getTasks(terminalState)) if (task.id === activeTaskId && task.status === "running") {
          task.status = "failed";
          task.failureHistory = [...(task.failureHistory ?? []), { at: new Date().toISOString(), phase: failedStage, reason: terminalReason ?? "Run stopped" }];
        }
        terminalState.lastRun = { outcome: completed ? "completed" : "stopped", ...(!completed ? { failedStage, reason: terminalReason } : {}),
          durationMs: Date.now() - runStartTime, worktree: retainedWorktree && worktreeExists(retainedWorktree) ? retainedWorktree : undefined, at: new Date().toISOString() };
        writeState(cfg.repoRoot, terminalState, cfg.stateFile);
        appendEvent(cfg.repoRoot, "run_finished", terminalState.lastRun, cfg.runsRoot, cfg.stateFile);
      }
      recordRunLatency();
    } catch (recordError) { console.warn(`Could not record terminal run state: ${recordError instanceof Error ? recordError.message : String(recordError)}`); }
  }

}
