import type { Task, AgenticState, VerifierResult } from "../state/index.js";
import { matchPolicyHumanGates, type PhaseAdmissionConfig, type WorkflowPolicy } from "../policy/index.js";
import { getTaskScope, isScopeMeaningfullyBounded, testPathsAreDocumentation, testPathsTouchHumanGate } from "../scope/index.js";

export type TaskRisk = "low" | "medium" | "high";
export type VerifierMode = "skip" | "single" | "adversarial";

export interface VerificationProfile {
  risk: TaskRisk;
  verifierMode: VerifierMode;
  votes: number;
  reasons: string[];
  evidence: string[];
}

export type AdmissionPhase = "task-grill" | "verifier" | "post-task-review" | "finalize-docs";

export interface AdmissionDecision {
  run: boolean;
  reason: string;
}

export interface VerifierAdmissionDecision extends AdmissionDecision {
  risk: TaskRisk;
  verifierMode: VerifierMode;
  votes: number;
  reasons: string[];
  evidence: string[];
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

export function resolveVerificationProfile(
  task: Task,
  policy: WorkflowPolicy,
  changedPaths: string[] = []
): VerificationProfile {
  const scope = getTaskScope(task as any);
  const evidence = [
    `kind=${task.kind ?? "unspecified"}`,
    `complexity=${task.complexity ?? "unspecified"}`,
    `scope=${scope.length > 0 ? scope.join(",") : "unscoped"}`,
    `changed=${changedPaths.length > 0 ? changedPaths.join(",") : "unknown"}`,
  ];
  const semanticHumanGates = matchPolicyHumanGates(policy, [
    task.title ?? "",
    task.kind ?? "",
    task.workflow ?? "",
    ...(task.acceptanceCriteria ?? []),
    ...scope,
    ...changedPaths,
  ]);
  const highRiskReasons: string[] = [];
  if (task.kind === "architecture" || task.workflow === "improve-codebase-architecture") highRiskReasons.push("architecture work");
  if (task.complexity === "high") highRiskReasons.push("high task complexity");
  if (scope.length > 0 && !isScopeMeaningfullyBounded(scope)) highRiskReasons.push("broad or catch-all declared scope");
  if (testPathsTouchHumanGate([...scope, ...changedPaths], policy)) highRiskReasons.push("scope or diff touches a human-gate path");
  if (scope.length >= 4 || changedPaths.length >= 4) highRiskReasons.push("broad scope or actual diff");
  highRiskReasons.push(...semanticHumanGates.map((gate) => `semantic human gate: ${gate}`));
  if (semanticHumanGates.length > 0) evidence.push(`humanGates=${semanticHumanGates.join(",")}`);
  if (highRiskReasons.length > 0) {
    return { risk: "high", verifierMode: "adversarial", votes: 3, reasons: highRiskReasons, evidence };
  }
  if (isScopeMeaningfullyBounded(scope) && testPathsAreDocumentation(changedPaths) && task.complexity === "low" && (task.failureHistory ?? []).length === 0) {
    return { risk: "low", verifierMode: "skip", votes: 0, reasons: ["bounded documentation-only actual diff", "low task complexity"], evidence };
  }
  const mediumReasons: string[] = [];
  if ((task.failureHistory ?? []).length > 0) mediumReasons.push("prior failure requires independent verification");
  if (scope.length === 0) mediumReasons.push("unscoped task cannot use deterministic fast verification");
  if (changedPaths.length === 0) mediumReasons.push("actual diff unavailable or empty");
  if (changedPaths.length > 0 && !testPathsAreDocumentation(changedPaths)) mediumReasons.push("actual diff includes non-documentation files");
  if (mediumReasons.length === 0) mediumReasons.push("normal bounded change requires one independent verifier");
  return { risk: "medium", verifierMode: "single", votes: 1, reasons: mediumReasons, evidence };
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
  explicitFastVerifier: boolean,
  changedPaths: string[] = [],
  forcedVotes = 0
): VerifierAdmissionDecision {
  const config = admissionConfig(policy);
  const profile = resolveVerificationProfile(task, policy, changedPaths);
  const profileReason = profile.reasons.join("; ");

  if (config.verifier !== "always" && forcedVotes <= 0 && profile.verifierMode === "skip") {
    return { run: false, reason: `low-risk change passed deterministic checks: ${profileReason}`, ...profile };
  }

  const votes = forcedVotes > 0 ? forcedVotes : Math.max(1, profile.votes);
  const verifierMode: VerifierMode = votes > 1 ? "adversarial" : "single";
  const prefix = config.verifier === "always"
    ? "policy requires verifier"
    : explicitFastVerifier
      ? "explicit fast-verifier denied"
      : `${profile.risk}-risk change requires ${verifierMode} verification`;
  return { run: true, reason: `${prefix}: ${profileReason}`, ...profile, verifierMode, votes };
}

export function shouldRunPostTaskReview(args: {
  task: Task;
  remainingTasks: Task[];
  policy: WorkflowPolicy;
  enabled: boolean;
  verifierResult?: VerifierResult;
}): AdmissionDecision {
  if (!args.enabled) return { run: false, reason: "post-task review disabled by operator" };
  if (args.remainingTasks.length === 0) return { run: false, reason: "plan complete; no remaining runnable tasks" };
  const config = admissionConfig(args.policy);
  if (config.postTaskReview === "always") return { run: true, reason: "policy requires review after every passed task" };
  if ((args.verifierResult?.issues?.length ?? 0) > 0) return { run: true, reason: "verifier reported issues requiring remaining-plan review" };
  if (args.task.complexity === "high") return { run: true, reason: "high-complexity task requires remaining-plan review" };

  const currentScope = args.task.scope ?? [];
  if (currentScope.length === 0 || args.remainingTasks.some((task) => (task.scope ?? []).length === 0)) {
    return { run: true, reason: "unscoped task prevents safe deterministic drift check" };
  }
  if (args.remainingTasks.some((task) => scopesMayOverlap(currentScope, task.scope ?? []))) {
    return { run: true, reason: "completed task scope may overlap remaining task scope" };
  }
  return { run: false, reason: "no verifier, complexity, or scope-drift evidence" };
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
