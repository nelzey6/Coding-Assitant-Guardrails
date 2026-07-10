import type { Task, AgenticState, VerifierResult } from "../state/index.js";
import type { PhaseAdmissionConfig, WorkflowPolicy } from "../policy/index.js";
import { testFastVerifierAllowed } from "../scope/index.js";

export type AdmissionPhase = "task-grill" | "verifier" | "post-task-review" | "finalize-docs";

export interface AdmissionDecision {
  run: boolean;
  reason: string;
}

const DEFAULT_ADMISSION: Required<PhaseAdmissionConfig> = {
  taskGrill: "plan-aware",
  verifier: "auto",
  postTaskReview: "on-drift",
  finalizeDocs: "on-change",
  retryTaskGrill: "on-drift",
};

function admissionConfig(policy: WorkflowPolicy): Required<PhaseAdmissionConfig> {
  return { ...DEFAULT_ADMISSION, ...(policy.autonomousLoop.phaseAdmission ?? {}) };
}

function latestFailure(task: Task): { phase?: string } | undefined {
  return task.failureHistory?.[task.failureHistory.length - 1];
}

function scopePrefix(scope: string): string {
  return scope.replace(/[\\*?].*$/, "").replace(/\/+$/, "");
}

function scopesMayOverlap(left: string[], right: string[]): boolean {
  if (left.length === 0 || right.length === 0) return true;
  return left.some((a) => right.some((b) => {
    if (a === b) return true;
    const ap = scopePrefix(a);
    const bp = scopePrefix(b);
    return ap.length > 0 && bp.length > 0 && (ap.startsWith(bp) || bp.startsWith(ap));
  }));
}

export function taskWasPlannedForCurrentRevision(task: Task, state: AgenticState): boolean {
  return typeof task.plannedRevision === "number"
    && typeof state.planRevision === "number"
    && task.plannedRevision === state.planRevision;
}

export function shouldRunTaskGrill(
  task: Task,
  state: AgenticState,
  policy: WorkflowPolicy,
  force = false
): AdmissionDecision {
  const config = admissionConfig(policy);
  if (force || config.taskGrill === "always") {
    return { run: true, reason: force ? "operator or retry forced task-grill" : "policy requires task-grill for every task" };
  }

  const failure = latestFailure(task);
  if (failure && config.retryTaskGrill === "always") {
    return { run: true, reason: `retry policy requires task-grill after ${failure.phase ?? "unknown"} failure` };
  }
  if (failure && failure.phase && failure.phase !== "checks") {
    return { run: true, reason: `${failure.phase} failure may indicate stale task understanding` };
  }
  if (taskWasPlannedForCurrentRevision(task, state) && !(state.openQuestions?.length) && !(state.blockers?.length)) {
    return { run: false, reason: "fresh planner revision; no open questions, blockers, or drift evidence" };
  }
  return { run: true, reason: "task has no fresh planner revision; readiness must be checked" };
}

export function shouldRunVerifier(
  task: Task,
  policy: WorkflowPolicy,
  explicitFastVerifier: boolean
): AdmissionDecision {
  const config = admissionConfig(policy);
  const fast = testFastVerifierAllowed(task as any);
  if (explicitFastVerifier || config.verifier === "auto") {
    if (fast.allowed) return { run: false, reason: `low-risk scoped task passed deterministic checks: ${fast.reason}` };
    if (explicitFastVerifier) return { run: true, reason: `explicit fast-verifier denied: ${fast.reason}` };
  }
  return { run: true, reason: config.verifier === "always" ? "policy requires verifier" : "task is not eligible for automatic fast verification" };
}

export function shouldRunPostTaskReview(args: {
  task: Task;
  remainingTasks: Task[];
  policy: WorkflowPolicy;
  enabled: boolean;
  assumptionsChanged?: string[];
  verifierResult?: VerifierResult;
}): AdmissionDecision {
  if (!args.enabled) return { run: false, reason: "post-task review disabled by operator" };
  if (args.remainingTasks.length === 0) return { run: false, reason: "plan complete; no remaining runnable tasks" };
  const config = admissionConfig(args.policy);
  if (config.postTaskReview === "always") return { run: true, reason: "policy requires review after every passed task" };
  if ((args.assumptionsChanged?.length ?? 0) > 0) return { run: true, reason: "task-grill reported changed assumptions" };
  if ((args.verifierResult?.issues?.length ?? 0) > 0) return { run: true, reason: "verifier reported issues requiring remaining-plan review" };
  if (args.task.complexity === "high") return { run: true, reason: "high-complexity task requires remaining-plan review" };

  const currentScope = args.task.scope ?? [];
  if (currentScope.length === 0 || args.remainingTasks.some((task) => (task.scope ?? []).length === 0)) {
    return { run: true, reason: "unscoped task prevents safe deterministic drift check" };
  }
  if (args.remainingTasks.some((task) => scopesMayOverlap(currentScope, task.scope ?? []))) {
    return { run: true, reason: "completed task scope may overlap remaining task scope" };
  }
  return { run: false, reason: "no assumption, verifier, complexity, or scope-drift evidence" };
}

export function shouldRunFinalizeDocs(
  changedPaths: string[],
  policy: WorkflowPolicy,
  enabled: boolean
): AdmissionDecision {
  if (!enabled) return { run: false, reason: "finalize-docs disabled by operator" };
  const config = admissionConfig(policy);
  if (config.finalizeDocs === "always") return { run: true, reason: "policy requires finalize-docs after every run" };
  const durableDocs = changedPaths.filter((path) => {
    const normalized = path.replace(/\\/g, "/");
    return normalized.endsWith(".md")
      || normalized.startsWith("docs/")
      || normalized.startsWith("adrs/")
      || normalized.startsWith("templates/");
  });
  if (durableDocs.length > 0) return { run: true, reason: `durable documentation changed: ${durableDocs.join(", ")}` };
  return { run: false, reason: "no durable documentation changed" };
}
