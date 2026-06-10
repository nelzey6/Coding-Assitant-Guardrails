import { readFileSync, existsSync } from "fs";
import { join } from "path";

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
  lastRunDir?: string;
  attempts?: number;
}

export interface AgenticState {
  version?: number;
  goal?: string;
  phase?: string;
  maxIterations?: number;
  tasks?: Task[];
  decisions?: string[];
  assumptions?: string[];
  openQuestions?: string[];
  blockers?: string[];
}

export function loadState(repoRoot: string, stateFile = "agentic.json"): AgenticState | null {
  const path = join(repoRoot, stateFile);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf-8")) as AgenticState;
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
  const finished: TaskStatus[] = ["passed"];
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
