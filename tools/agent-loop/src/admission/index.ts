import { computePlanContextFingerprint, type Task, type AgenticState } from "../state/index.js";
import { matchPolicyHumanGates, type PhaseAdmissionConfig, type WorkflowPolicy } from "../policy/index.js";
import { getTaskScope, isScopeMeaningfullyBounded, testPathsAreDocumentation, testPathsTouchHumanGate } from "../scope/index.js";

export type TaskRisk = "low" | "medium" | "high";
export type VerifierMode = "skip" | "single" | "adversarial";

interface VerificationEvidence {
  risk: TaskRisk;
  reasons: string[];
  evidence: string[];
}

export type VerificationProfile = VerificationEvidence & (
  | { verifierMode: "skip"; votes: 0 }
  | { verifierMode: "single"; votes: 1 }
  | { verifierMode: "adversarial"; votes: 3 }
);

export type AdmissionPhase = "replan" | "stance" | "verifier";

export interface AdmissionDecision {
  run: boolean;
  reason: string;
}

export type VerifierAdmissionDecision = AdmissionDecision & VerificationProfile;

const DEFAULT_ADMISSION: Required<PhaseAdmissionConfig> = {
  verifier: "auto",
};

function admissionConfig(policy: WorkflowPolicy): Required<PhaseAdmissionConfig> {
  return { ...DEFAULT_ADMISSION, ...(policy.autonomousLoop.phaseAdmission ?? {}) };
}

function latestFailure(task: Task): { phase?: string } | undefined {
  return task.failureHistory?.[task.failureHistory.length - 1];
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
  if (task.complexity === "high") highRiskReasons.push("high task complexity");
  if (scope.length > 0 && !isScopeMeaningfullyBounded(scope)) highRiskReasons.push("broad or catch-all declared scope");
  if (testPathsTouchHumanGate([...scope, ...changedPaths], policy)) highRiskReasons.push("scope or diff touches a human-gate path");
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

export function shouldUseCompactExecutor(task: Task, policy: WorkflowPolicy): boolean {
  return isScopeMeaningfullyBounded(getTaskScope(task))
    && !(task.failureHistory?.length)
    && resolveVerificationProfile(task, policy).risk !== "high";
}

export function taskWasPlannedForCurrentRevision(task: Task, state: AgenticState): boolean {
  return typeof task.plannedRevision === "number"
    && typeof state.planRevision === "number"
    && task.plannedRevision === state.planRevision;
}

export function shouldReplanBeforeTask(task: Task, state: AgenticState): AdmissionDecision {
  const failure = latestFailure(task);
  if (failure && failure.phase && !["checks", "direct_result"].includes(failure.phase)) {
    return { run: true, reason: `${failure.phase} failure invalidated task understanding` };
  }
  if (task.plannedContextFingerprint && task.plannedContextFingerprint !== computePlanContextFingerprint(state)) {
    return { run: true, reason: "goal decisions, assumptions, questions, or blockers changed after planning" };
  }
  if (taskWasPlannedForCurrentRevision(task, state) && !(state.openQuestions?.length) && !(state.blockers?.length)) {
    return { run: false, reason: "fresh planner revision with no ambiguity or drift evidence" };
  }
  return { run: true, reason: "task lacks a fresh, unambiguous planner revision" };
}

export function shouldRunVerifier(
  task: Task,
  policy: WorkflowPolicy,
  changedPaths: string[] = []
): VerifierAdmissionDecision {
  const config = admissionConfig(policy);
  const profile = resolveVerificationProfile(task, policy, changedPaths);
  const profileReason = profile.reasons.join("; ");

  if (config.verifier !== "always" && profile.verifierMode === "skip") {
    return { run: false, reason: `low-risk change passed deterministic checks: ${profileReason}`, ...profile };
  }

  const admittedProfile: VerificationProfile = profile.verifierMode === "skip"
    ? { ...profile, verifierMode: "single", votes: 1 }
    : profile;
  const prefix = config.verifier === "always"
    ? "policy requires verifier"
    : `${admittedProfile.risk}-risk change requires ${admittedProfile.verifierMode} verification`;
  return { run: true, reason: `${prefix}: ${profileReason}`, ...admittedProfile };
}
