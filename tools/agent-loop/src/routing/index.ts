import { validateAcceptanceChecks } from "../checks/index.js";
import { execFileSync } from "child_process";
import { matchPolicyHumanGates, type WorkflowPolicy } from "../policy/index.js";
import type { AgenticState, Task } from "../state/index.js";

export type ExecutionRoute =
  | { route: "direct"; reason: string; paths: string[]; task: Task }
  | { route: "planner"; reason: string; paths: string[] };

export interface DirectExecutionResult {
  verdict: "completed" | "needs_planner" | "needs_human";
  summary: string;
  validation: string[];
  assumptions: string[];
}

const CONCRETE_ACTION = /\b(add|change|correct|document|edit|extract|move|split|refactor|fix|remove|rename|replace|update|write)\b/i;
const AMBIGUOUS_ACTION = /\b(clean\s*up|handle|improve|make\s+better|optimi[sz]e|support)\b/i;
const HIGH_RISK = /\b(architecture|auth(?:entication|orization)?|billing|database|dependency|destructive|migration|package|payment|permission|public\s+(?:api|interface)|rewrite|schema|security|transport|upgrade)\b/i;
const STRUCTURAL_ACTION = /\b(extract|move|split|refactor)\b/i;
const PRESERVE_BEHAVIOR = /\b(preserve (?:the )?behavio(?:u)?r|no behavio(?:u)?r changes?|behavio(?:u)?r[- ]preserving)\b/i;
const DOCUMENT_PATH = /(?:^|\/)(?:README|CONTEXT|PROJECT|AGENTS|CLAUDE)\.md$|\.md$/i;

function normalizePath(raw: string): string {
  return raw.trim().replace(/^[`'"(]+|[`'"),.;:!?]+$/g, "").replace(/\\/g, "/");
}

export function extractNamedRepoPaths(goal: string, repoRoot?: string): string[] {
  const found = new Set<string>();
  const candidates = goal.match(/`[^`]+`|(?:^|\s)[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*\.[A-Za-z0-9]+(?=$|\s|[),.;:!?])/g) ?? [];
  for (const candidate of candidates) {
    const path = normalizePath(candidate);
    if (!/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*\.[A-Za-z0-9]+$/.test(path) || path.startsWith("/") || path.includes("..") || path.includes("*") || /^https?:/i.test(path)) continue;
    found.add(path);
  }
  if (!repoRoot) return [...found];
  // Resolve only unique existing aliases. Never merge distinct real files by suffix.
  const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd: repoRoot, encoding: "utf-8" }).split("\0").filter(Boolean);
  return [...new Set([...found].map((path) => {
    if (files.includes(path)) return path;
    const matches = files.filter((file) => file.endsWith(`/${path}`));
    return matches.length === 1 ? matches[0] : path;
  }))];
}

function directTask(goal: string, paths: string[], policy: WorkflowPolicy): Task {
  const documentationOnly = paths.every((path) => DOCUMENT_PATH.test(path));
  return {
    id: "direct-goal",
    title: goal.trim(),
    kind: documentationOnly ? "maintenance" : "implementation",
    workflow: policy.defaultExecutionWorkflow,
    status: "pending",
    priority: 1,
    acceptanceCriteria: [goal.trim()],
    validation: [],
    dependsOn: [],
    failureHistory: [],
    artifacts: [],
    scope: paths,
    complexity: "low",
    complexityReasons: ["bounded direct goal with up to four explicit repository paths"],
    origin: "direct",
    sliceRole: "primary",
  };
}

export function selectExecutionRoute(state: AgenticState, policy: WorkflowPolicy, repoRoot?: string): ExecutionRoute {
  const goal = (state.goal ?? "").trim();
  const paths = extractNamedRepoPaths(goal, repoRoot);
  const planner = (reason: string): ExecutionRoute => ({ route: "planner", reason, paths });

  if ((state.tasks?.length ?? 0) > 0) return planner("task graph already exists");
  if ((state.openQuestions?.length ?? 0) > 0) return planner("open questions require planning");
  if ((state.blockers?.length ?? 0) > 0) return planner("blockers require planning");
  if (!goal || goal.length > 1000) return planner("goal is empty or exceeds direct-route size limit");
  if (paths.length < 1 || paths.length > 4) return planner("direct route requires up to four explicit repository-relative file paths");
  if (!CONCRETE_ACTION.test(goal)) return planner("goal lacks a concrete edit action");
  if (STRUCTURAL_ACTION.test(goal) && !PRESERVE_BEHAVIOR.test(goal)) return planner("structural change requires explicit behavior preservation");
  if (AMBIGUOUS_ACTION.test(goal)) return planner("goal contains ambiguous improvement language");
  if (HIGH_RISK.test(goal)) return planner("goal contains elevated-risk change language");
  const gates = matchPolicyHumanGates(policy, [goal, ...paths]);
  if (gates.length > 0) return planner(`goal matches human gate: ${gates.join(", ")}`);

  return {
    route: "direct",
    reason: "bounded low-impact goal with concrete action and explicit paths",
    paths,
    task: directTask(goal, paths, policy),
  };
}

export function validateDirectExecutionResult(value: unknown): string[] {
  const result = value as Partial<DirectExecutionResult> | null;
  if (!result || typeof result !== "object") return ["direct execution result must be an object"];
  const errors: string[] = [];
  if (!["completed", "needs_planner", "needs_human"].includes(String(result.verdict ?? ""))) {
    errors.push("verdict must be completed, needs_planner, or needs_human");
  }
  if (!String(result.summary ?? "").trim()) errors.push("summary is required");
  if (!Array.isArray(result.validation) || result.validation.some((command) => typeof command !== "string" || !command.trim())) {
    errors.push("validation must be an array of non-empty command strings");
  }
  if (!Array.isArray(result.assumptions) || result.assumptions.some((assumption) => typeof assumption !== "string")) {
    errors.push("assumptions must be a string array");
  }
  if (result.verdict === "completed" && (result.validation?.length ?? 0) < 1) {
    errors.push("completed direct execution requires at least one validation command");
  }
  if ((result.validation?.length ?? 0) > 3) errors.push("direct execution may return at most three validation commands");
  if (result.verdict === "completed" && Array.isArray(result.validation) && result.validation.every((c) => typeof c === "string")) errors.push(...validateAcceptanceChecks(result.validation));
  return errors;
}
