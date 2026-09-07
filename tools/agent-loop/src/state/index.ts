import { readFileSync, writeFileSync, existsSync, appendFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { createHash } from "crypto";

export type TaskStatus =
  | "pending"
  | "running"
  | "passed"
  | "failed"
  | "needs_retry"
  | "needs_human"
  | "blocked";

export interface FailureRecord {
  at: string;
  phase: string;
  reason: string;
  resultFile?: string;
  failureAnalysisFile?: string;
}

export interface Task {
  id: string;
  title?: string;
  kind?: string;
  workflow?: string;
  status?: TaskStatus;
  priority?: number;
  acceptanceCriteria?: string[];
  validation?: string[];
  dependsOn?: string[];
  failureHistory?: FailureRecord[];
  lastRunDir?: string;
  attempts?: number;
  scope?: string[];
  artifacts?: string[];
  complexity?: "low" | "medium" | "high";
  complexityReasons?: string[];
  approvedStanceFile?: string;
  plannedRevision?: number;
  plannedContextFingerprint?: string;
  origin?: "planner" | "direct";
  sliceRole?: "primary" | "prerequisite";
  splitReason?: "distinct-proof" | "true-prerequisite" | "independent-rollback";
}

export interface AgenticState {
  lastRun?: { outcome: "completed" | "stopped"; failedStage?: string; reason?: string; durationMs: number; worktree?: string; at: string };
  version?: number;
  goal?: string;
  phase?: string;
  maxIterations?: number;
  checks?: string[];
  tasks?: Task[];
  decisions?: string[];
  assumptions?: string[];
  openQuestions?: string[];
  blockers?: string[];
  /** Optional operator-supplied context files (for example Spec Kit spec/plan/tasks) that prompts should read before planning/execution. */
  contextFiles?: string[];
  promptPolicy?: { lessons?: string[] };
  replanCount?: number;
  lastReplanTaskIds?: string[];
  planRevision?: number;
}

export interface PlannerResult {
  verdict: "planned" | "needs_human" | "blocked";
  summary?: string;
  /** May be flat strings (legacy) or structured decision records (normalized to strings on merge). */
  decisions?: Array<string | Record<string, unknown>>;
  assumptions?: string[];
  openQuestions?: string[];
  blockers?: string[];
  tasks?: Task[];
  artifacts?: string[];
}

export interface CheckDefinition {
  id: string;
  command: string;
  cwd: string;
  sources: Array<"operator" | "state" | "task">;
}
export interface CheckResult extends CheckDefinition {
  status: "passed" | "failed" | "invalid";
  output: string;
  durationMs: number;
  evidenceId?: string;
}
export interface CheckBatch {
  candidate: { head: string; fingerprint: string };
  results: CheckResult[];
  log: string;
  failureKind?: "configuration" | "environment" | "code" | "candidate_mutation";
}
export interface ReviewEvidence {
  candidate: { head: string; fingerprint: string };
  requirements: Array<{ id: string; text: string }>;
  checks: CheckResult[];
  diff: { id: string; files: string[]; hasCode: boolean };
}
export interface Coverage {
  criterionId: string;
  evidenceIds: string[];
  kind: "behavior" | "structure" | "documentation";
  proves: string;
}

export interface ReviewIssue {
  file: string;
  triggeringCase: string;
  consequence: string;
  detail?: string;
}
export function formatReviewIssue(issue: string | ReviewIssue): string {
  return typeof issue === "string" ? issue : `${issue.file}: ${issue.triggeringCase} — ${issue.consequence}${issue.detail ? ` (${issue.detail})` : ""}`;
}

export interface VerifierResult {
  coverage?: Coverage[];
  /** Legacy artifacts are retained for diagnosis, never accepted as new proof. */
  validationEvidence?: Array<{ criterion: string; command: string; proves: string }>;
  verdict: "pass" | "fail" | "needs_human";
  summary?: string;
  issues?: Array<string | ReviewIssue>;
  humanGates?: string[];
  recommendedStatus?: string;
  artifacts?: string[];
}

export function computePlanContextFingerprint(state: AgenticState): string {
  const normalized = (values: string[] | undefined): string[] => [...new Set(values ?? [])].sort();
  return createHash("sha256").update(JSON.stringify({
    goal: state.goal ?? "",
    decisions: normalized(state.decisions),
    assumptions: normalized(state.assumptions),
    openQuestions: normalized(state.openQuestions),
    blockers: normalized(state.blockers),
  })).digest("hex");
}

export function loadState(repoRoot: string, stateFile = "agentic.json"): AgenticState | null {
  const path = join(repoRoot, stateFile);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf-8")) as AgenticState;
}

export function writeState(repoRoot: string, state: AgenticState, stateFile = "agentic.json"): void {
  const path = join(repoRoot, stateFile);
  writeFileSync(path, JSON.stringify(state, null, 2) + "\n", "utf-8");
}

export function getTasks(state: AgenticState): Task[] {
  return state.tasks ?? [];
}

export function dependenciesPassed(task: Task, state: AgenticState): boolean {
  const deps = task.dependsOn ?? [];
  if (deps.length === 0) return true;
  const statusMap = new Map(getTasks(state).map((t) => [t.id, t.status]));
  return deps.every((depId) => statusMap.get(depId) === "passed");
}

export function getNextTask(state: AgenticState): Task | null {
  const runnable: TaskStatus[] = ["pending", "needs_retry"];
  const candidates = getTasks(state)
    .filter((t) => runnable.includes(t.status as TaskStatus))
    .filter((t) => dependenciesPassed(t, state));

  if (candidates.length === 0) return null;

  return candidates.sort((a, b) => {
    const pa = a.priority ?? 999;
    const pb = b.priority ?? 999;
    if (pa !== pb) return pa - pb;
    return (a.id ?? "").localeCompare(b.id ?? "");
  })[0];
}

export function hasUnfinishedTasks(state: AgenticState): boolean {
  const finished: TaskStatus[] = ["passed", "blocked"];
  return getTasks(state).some((t) => !finished.includes(t.status as TaskStatus));
}

export function groupByStatus(state: AgenticState): Record<string, Task[]> {
  const result: Record<string, Task[]> = {};
  for (const task of getTasks(state)) {
    const s = task.status ?? "unknown";
    if (!result[s]) result[s] = [];
    result[s].push(task);
  }
  return result;
}

export function getBlockedDependencySummary(state: AgenticState): string {
  const pending = getTasks(state).filter(
    (t) => t.status === "pending" && !dependenciesPassed(t, state)
  );
  if (pending.length === 0) return "";
  return pending
    .map((t) => `  ${t.id} waiting on [${(t.dependsOn ?? []).join(", ")}]`)
    .join("\n");
}

export function getTaskAttempts(task: Task): number {
  if (typeof task.attempts === "number") return task.attempts;
  return task.failureHistory?.length ?? 0;
}

// Set a task's status and optionally append a failure record. Writes state + event.
export function setTaskStatus(
  repoRoot: string,
  stateFile: string,
  runsRoot: string,
  taskId: string,
  status: TaskStatus,
  failure?: FailureRecord
): AgenticState {
  const state = loadState(repoRoot, stateFile)!;
  for (const task of getTasks(state)) {
    if (task.id === taskId) {
      task.status = status;
      if (failure) {
        if (!task.failureHistory) task.failureHistory = [];
        task.failureHistory.push(failure);
      }
    }
  }
  writeState(repoRoot, state, stateFile);
  const eventData: Record<string, unknown> = { task: taskId, status };
  if (failure) eventData["failure"] = failure;
  appendEventToLog(repoRoot, runsRoot, stateFile, "task_status", eventData);
  return state;
}

// Mark a task passed and record verifier artifacts.
export function setTaskPassed(
  repoRoot: string,
  stateFile: string,
  runsRoot: string,
  taskId: string,
  verifierResult: VerifierResult
): AgenticState {
  const state = loadState(repoRoot, stateFile)!;
  for (const task of getTasks(state)) {
    if (task.id === taskId) {
      task.status = "passed";
      (task as Task & { completedAt?: string }).completedAt = new Date().toISOString();
      if (verifierResult.artifacts?.length) {
        task.artifacts = [...(task.artifacts ?? []), ...verifierResult.artifacts];
      }
    }
  }
  writeState(repoRoot, state, stateFile);
  const eventData: Record<string, unknown> = { task: taskId, status: "passed" };
  if (verifierResult.summary) eventData["summary"] = verifierResult.summary;
  appendEventToLog(repoRoot, runsRoot, stateFile, "task_passed", eventData);
  return state;
}

// Increment attempt counter and stamp lastRunDir / startedAt.
export function addTaskAttempt(
  repoRoot: string,
  stateFile: string,
  runsRoot: string,
  taskId: string,
  runDir: string
): AgenticState {
  const state = loadState(repoRoot, stateFile)!;
  for (const task of getTasks(state)) {
    if (task.id === taskId) {
      task.attempts = (task.attempts ?? 0) + 1;
      task.lastRunDir = runDir;
      (task as Task & { startedAt?: string }).startedAt = new Date().toISOString();
    }
  }
  writeState(repoRoot, state, stateFile);
  appendEventToLog(repoRoot, runsRoot, stateFile, "task_attempt", { task: taskId, runDir });
  return state;
}

// Flatten a (loosely-typed) decision record into the string form stored in state.decisions.
// Kept here (rather than importing from prompts) so the state layer has no prompt dependency.
export function flattenDecisionRecord(d: Record<string, unknown>, taskId: string): string {
  // Accept optionsConsidered (canonical) and options (common alias) for resilience.
  const optsRaw = Array.isArray(d["optionsConsidered"]) ? d["optionsConsidered"]
    : Array.isArray(d["options"]) ? d["options"]
    : [];
  const opts = optsRaw as Record<string, unknown>[];
  const optStr = opts
    .map((o) => `${o["recommended"] === true ? "*" : "-"} ${o["label"] ?? ""} (${o["evidence"] ?? ""})`)
    .join(" | ");
  return `[${taskId}] Q: ${d["question"] ?? ""} | why: ${d["whyItMatters"] ?? ""} | options: ${optStr} | chose: ${d["chosen"] ?? ""} | self-answer: ${d["selfAnswer"] ?? ""} | confidence: ${d["confidence"] ?? ""}`;
}

// Return the most recent failure-analysis.json path for a task, if recorded.
export function getLastFailureAnalysisFile(task: Task): string {
  const history = task.failureHistory ?? [];
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].failureAnalysisFile) return history[i].failureAnalysisFile!;
  }
  return "";
}

// Determine whether a failed phase should retry or escalate to needs_human.
export function getFailureStatusForTask(
  task: Task,
  phase: string,
  maxRetries: number
): TaskStatus {
  if (phase === "executor" || phase === "harness") return "needs_human";
  const attempts = getTaskAttempts(task);
  return attempts <= maxRetries ? "needs_retry" : "needs_human";
}

// Merge a planner result into state: append metadata lists and transition phase.
// Returns the new task IDs added by this plan (used for convergence detection).
export function mergePlannerResult(
  repoRoot: string,
  stateFile: string,
  result: PlannerResult
): AgenticState {
  const state = loadState(repoRoot, stateFile)!;
  if (result.decisions?.length) {
    const flat = result.decisions.map((d) =>
      typeof d === "string" ? d : flattenDecisionRecord(d, "planner")
    );
    state.decisions = [...(state.decisions ?? []), ...flat];
  }
  if (result.assumptions?.length) state.assumptions = [...(state.assumptions ?? []), ...result.assumptions];
  if (result.openQuestions?.length) state.openQuestions = [...(state.openQuestions ?? []), ...result.openQuestions];
  if (result.blockers?.length) state.blockers = [...(state.blockers ?? []), ...result.blockers];
  if (result.verdict === "planned") {
    const newTasks = result.tasks ?? [];
    const planRevision = (state.planRevision ?? 0) + 1;
    const plannedContextFingerprint = computePlanContextFingerprint(state);
    state.planRevision = planRevision;
    state.tasks = [...(state.tasks ?? []), ...newTasks.map((task) => ({ ...task, plannedRevision: planRevision, plannedContextFingerprint }))];
    state.phase = "execution";
    state.lastReplanTaskIds = newTasks.map((t) => t.id);
  } else if (result.verdict === "needs_human") {
    state.phase = "needs_human";
  } else {
    state.phase = "blocked";
  }
  writeState(repoRoot, state, stateFile);
  return state;
}

export function installDirectTask(
  repoRoot: string,
  stateFile: string,
  task: Task
): AgenticState {
  const state = loadState(repoRoot, stateFile)!;
  const planRevision = (state.planRevision ?? 0) + 1;
  state.planRevision = planRevision;
  const plannedContextFingerprint = computePlanContextFingerprint(state);
  const installed = { ...task, origin: "direct" as const, plannedRevision: planRevision, plannedContextFingerprint };
  state.tasks = [...(state.tasks ?? []), installed];
  state.phase = "execution";
  state.lastReplanTaskIds = [installed.id];
  writeState(repoRoot, state, stateFile);
  return state;
}

function appendEventToLog(
  repoRoot: string,
  runsRoot: string,
  stateFile: string,
  type: string,
  data: Record<string, unknown>
): void {
  const logPath = join(repoRoot, runsRoot, "events.jsonl");
  mkdirSync(dirname(logPath), { recursive: true });
  const entry = { ts: new Date().toISOString(), type, state: stateFile, ...data };
  appendFileSync(logPath, JSON.stringify(entry) + "\n", "utf-8");
}
