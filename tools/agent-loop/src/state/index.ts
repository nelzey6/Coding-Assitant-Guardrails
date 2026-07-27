import { readFileSync, writeFileSync, existsSync, appendFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";

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

export interface ExecutionIntent {
  objective: string;
  steps: string[];
  currentStep?: string;
  branches?: string[];
  completionEvidence: string[];
  updatedAt: string;
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
  reviewBranch?: string;
  reviewWorktree?: string;
  acceptedAt?: string;
  lastRunDir?: string;
  attempts?: number;
  scope?: string[];
  artifacts?: string[];
  complexity?: "low" | "medium" | "high";
  complexityReasons?: string[];
  approvedStanceFile?: string;
  executionIntent?: ExecutionIntent;
}

export interface AgenticState {
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

export interface VerifierResult {
  verdict: "pass" | "fail" | "needs_human";
  summary?: string;
  issues?: string[];
  humanGates?: string[];
  recommendedStatus?: string;
  artifacts?: string[];
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

// Mutates the matching task in place: clears review branch/worktree pointers and
// stamps acceptedAt. Mirrors the PS1 Clear-TaskReviewState. Caller writes state.
export function clearTaskReviewState(state: AgenticState, taskId: string, acceptedAt: string): void {
  for (const task of getTasks(state)) {
    if (task.id === taskId) {
      task.reviewBranch = "";
      task.reviewWorktree = "";
      task.acceptedAt = acceptedAt;
    }
  }
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

// Mark a task passed, recording verifier artifacts and optional review branch/worktree.
export function setTaskPassed(
  repoRoot: string,
  stateFile: string,
  runsRoot: string,
  taskId: string,
  verifierResult: VerifierResult,
  reviewBranch = "",
  reviewWorktree = ""
): AgenticState {
  const state = loadState(repoRoot, stateFile)!;
  for (const task of getTasks(state)) {
    if (task.id === taskId) {
      task.status = "passed";
      (task as Task & { completedAt?: string }).completedAt = new Date().toISOString();
      if (reviewBranch) task.reviewBranch = reviewBranch;
      if (reviewWorktree) task.reviewWorktree = reviewWorktree;
      if (verifierResult.artifacts?.length) {
        task.artifacts = [...(task.artifacts ?? []), ...verifierResult.artifacts];
      }
    }
  }
  writeState(repoRoot, state, stateFile);
  const eventData: Record<string, unknown> = { task: taskId, status: "passed" };
  if (reviewBranch) eventData["reviewBranch"] = reviewBranch;
  if (reviewWorktree) eventData["reviewWorktree"] = reviewWorktree;
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

// Persist task-grill assumption verdicts back into state.assumptions.
// Items from assumptionsStillValid are tagged "[valid]"; from assumptionsChanged "[changed]".
// Writes state and appends an assumptions_updated event.
export function updateAssumptionsFromGrill(
  repoRoot: string,
  stateFile: string,
  runsRoot: string,
  taskId: string,
  assumptionsStillValid: string[],
  assumptionsChanged: string[]
): void {
  const tagged = [
    ...assumptionsStillValid.map((a) => `[valid] ${a}`),
    ...assumptionsChanged.map((a) => `[changed] ${a}`),
  ];
  if (tagged.length === 0) return;
  const state = loadState(repoRoot, stateFile)!;
  state.assumptions = [...(state.assumptions ?? []), ...tagged];
  writeState(repoRoot, state, stateFile);
  appendEventToLog(repoRoot, runsRoot, stateFile, "assumptions_updated", { task: taskId, count: tagged.length, items: tagged });
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

// Append self-grill decision records (flattened to strings) to state.decisions and emit an event.
// Mirrors updateAssumptionsFromGrill. Returns the count recorded.
export function recordDecisions(
  repoRoot: string,
  stateFile: string,
  runsRoot: string,
  taskId: string,
  decisions: Record<string, unknown>[]
): number {
  if (!decisions.length) return 0;
  const flat = decisions.map((d) => flattenDecisionRecord(d, taskId));
  const state = loadState(repoRoot, stateFile)!;
  state.decisions = [...(state.decisions ?? []), ...flat];
  writeState(repoRoot, state, stateFile);
  appendEventToLog(repoRoot, runsRoot, stateFile, "decisions_recorded", { task: taskId, count: flat.length, items: flat });
  return flat.length;
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
    state.tasks = [...(state.tasks ?? []), ...newTasks];
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
