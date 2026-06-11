import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync } from "fs";
import { join, dirname, resolve } from "path";
import { execFileSync } from "child_process";
import type { AgenticState, Task } from "../state/index.js";
import type { WorkflowPolicy } from "../policy/index.js";
import { appendEvent, getRecentEvents, formatEventLine, loadEvents } from "../events/index.js";

export type PromptBudget = "low" | "medium" | "high";

export interface BudgetLimits {
  checkBytes: number;
  diffBytes: number;
  eventLimit: number;
}

export function getPromptBudgetLimits(budget: PromptBudget): BudgetLimits {
  switch (budget) {
    case "low":  return { checkBytes: 6_000,  diffBytes: 12_000,  eventLimit: 6 };
    case "high": return { checkBytes: 50_000, diffBytes: 100_000, eventLimit: 20 };
    default:     return { checkBytes: 12_000, diffBytes: 20_000,  eventLimit: 12 };
  }
}

export function limitTextForPrompt(text: string, maxBytes: number, tailLines = 80): string {
  if (!text) return "";
  const bytes = Buffer.byteLength(text, "utf-8");
  if (bytes <= maxBytes) return text;

  const lines = text.split(/\r?\n/);
  let tail = lines.slice(-tailLines).join("\n");
  while (Buffer.byteLength(tail, "utf-8") > maxBytes && tail.length > 200) {
    tail = tail.slice(Math.min(200, tail.length));
  }
  return `[truncated for prompt: original ${bytes} bytes; showing tail]\n${tail}`;
}

export function getRecentHistoryText(
  repoRoot: string,
  runsRoot: string,
  limit: number,
  budget: PromptBudget
): string {
  const events = loadEvents(repoRoot, runsRoot);
  if (events.length === 0) return "No prior event log entries.";
  const recent = getRecentEvents(events, limit);
  if (budget === "high") return recent.map((e) => JSON.stringify(e)).join("\n");
  return recent.map(formatEventLine).join("\n");
}

// Write a prompt file, creating parent dirs, and append a prompt_written event.
export function writePromptWithEvent(
  promptFile: string,
  content: string,
  kind: string,
  repoRoot: string,
  runsRoot: string,
  stateFile: string,
  budget: PromptBudget,
  extra: Record<string, unknown> = {}
): void {
  mkdirSync(dirname(promptFile), { recursive: true });
  writeFileSync(promptFile, content, "utf-8");
  appendEvent(
    repoRoot,
    "prompt_written",
    { prompt: promptFile, kind, bytes: Buffer.byteLength(content, "utf-8"), promptBudget: budget, ...extra },
    runsRoot,
    stateFile
  );
}

function git(args: string[], cwd?: string): string {
  try {
    return execFileSync("git", args, { encoding: "utf-8", cwd, stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch {
    return "";
  }
}

// Generate the codegraph context file by invoking the repo's context helper scripts.
// Falls back to a stub when the helper is not found or fails.
export function writeCodeGraphContext(outputFile: string, workingDirectory = "."): void {
  mkdirSync(dirname(outputFile), { recursive: true });

  // Locate the repo root by walking up from workingDirectory
  const findRepoRoot = (start: string): string => {
    let dir = resolve(start);
    for (let i = 0; i < 10; i++) {
      if (existsSync(join(dir, ".git")) || existsSync(join(dir, "AGENTS.md"))) return dir;
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    return resolve(start);
  };
  const repoRoot = findRepoRoot(workingDirectory);

  const ps1Helper = join(repoRoot, "scripts", "context", "codegraph-context.ps1");
  const shHelper  = join(repoRoot, "scripts", "context", "codegraph-context.sh");
  const isWin = process.platform === "win32";

  const stub = "# CodeGraph Context\n\nCodeGraph context helper was unavailable. Continue with normal repository inspection.";

  // Try the platform-native helper first, then cross-platform fallback
  const candidates: Array<{ cmd: string; args: string[] }> = [];
  if (isWin && existsSync(ps1Helper)) {
    candidates.push({ cmd: "pwsh", args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ps1Helper, "-Output", outputFile, "-WorkingDirectory", workingDirectory] });
    candidates.push({ cmd: "powershell.exe", args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ps1Helper, "-Output", outputFile, "-WorkingDirectory", workingDirectory] });
  }
  if (!isWin && existsSync(shHelper)) {
    candidates.push({ cmd: "bash", args: [shHelper, outputFile, workingDirectory] });
  }
  // Cross-platform fallback: pwsh on non-Windows if available
  if (!isWin && existsSync(ps1Helper)) {
    candidates.push({ cmd: "pwsh", args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ps1Helper, "-Output", outputFile, "-WorkingDirectory", workingDirectory] });
  }

  for (const { cmd, args } of candidates) {
    try {
      execFileSync(cmd, args, { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], timeout: 30_000 });
      // Helper writes the file itself; verify it was created
      if (existsSync(outputFile)) return;
    } catch {
      // Try next candidate
    }
  }

  // All candidates failed or unavailable — write the stub
  writeFileSync(outputFile, stub, "utf-8");
}

export interface RepoContextOptions {
  repoRoot: string;
  stateGoal: string;
  checks: string[];
  codeGraphFile?: string;
}

export function writeRepoContext(contextFile: string, opts: RepoContextOptions): void {
  const { repoRoot, stateGoal, checks, codeGraphFile = "" } = opts;
  const branch = git(["branch", "--show-current"], repoRoot) || "(detached)";
  const head   = git(["rev-parse", "--short", "HEAD"], repoRoot) || "unknown";
  const statusText = git(["status", "--short"], repoRoot) || "clean";

  const topItems: string[] = [];
  try {
    const entries = readdirSync(repoRoot).slice(0, 80);
    for (const e of entries) {
      try { topItems.push(statSync(join(repoRoot, e)).isDirectory() ? `${e}/` : e); } catch { /* skip */ }
    }
  } catch { /* non-fatal */ }

  const readOrMissing = (name: string) => {
    const p = join(repoRoot, name);
    return existsSync(p) ? readFileSync(p, "utf-8") : `${name} not found.`;
  };
  const flagOrMissing = (name: string) => existsSync(join(repoRoot, name)) ? `${name} present` : `${name} not found`;

  const content = [
    "# Agentic planner repository context",
    "",
    `Goal: ${stateGoal}`,
    "",
    "Git:",
    `- Branch: ${branch}`,
    `- HEAD: ${head}`,
    `- Status: ${statusText}`,
    "",
    "Agent cookbooks:",
    `- ${flagOrMissing("AGENTS.md")}`,
    `- ${flagOrMissing("CLAUDE.md")}`,
    "",
    "Configured checks:",
    checks.join("\n"),
    "",
    "Top-level files:",
    topItems.join("\n"),
    "",
    "PROJECT.md:",
    readOrMissing("PROJECT.md"),
    "",
    "CONTEXT.md:",
    readOrMissing("CONTEXT.md"),
    "",
    "CodeGraph context:",
    codeGraphFile,
  ].join("\n");

  mkdirSync(dirname(contextFile), { recursive: true });
  writeFileSync(contextFile, content, "utf-8");
}

export interface PlannerPromptOptions {
  repoRoot: string;
  runsRoot: string;
  stateFile: string;
  budget: PromptBudget;
  state: AgenticState;
  policy: WorkflowPolicy;
  resolvedPolicyFile?: string;
  plannerResultFile: string;
  repoContextFile: string;
  grillTranscriptFile: string;
  codeGraphFile: string;
  /** Path to failure-analysis.json from the task that triggered this replan, if any. */
  priorFailureAnalysisFile?: string;
}

export function writePlannerPrompt(promptFile: string, opts: PlannerPromptOptions): void {
  const {
    repoRoot, runsRoot, stateFile, budget, state, resolvedPolicyFile,
    plannerResultFile, repoContextFile, grillTranscriptFile, codeGraphFile,
    priorFailureAnalysisFile = "",
  } = opts;

  const policyText = resolvedPolicyFile && existsSync(resolvedPolicyFile)
    ? readFileSync(resolvedPolicyFile, "utf-8")
    : "";

  const priorFailureBlock = (() => {
    if (!priorFailureAnalysisFile || !existsSync(priorFailureAnalysisFile)) return "";
    try {
      const fa = JSON.parse(readFileSync(priorFailureAnalysisFile, "utf-8"));
      return [
        "",
        "A prior task attempt failed and triggered this replan. Use this failure context when designing the new plan:",
        `- Failed task: ${fa.taskId ?? "unknown"}`,
        `- Phase that failed: ${fa.phase ?? "unknown"}`,
        `- Attempt number: ${fa.attempt ?? "unknown"}`,
        `- Diff stat at failure:\n${fa.diffStat || "(none)"}`,
        `- Failure reason (truncated):\n${fa.reason || "(none)"}`,
        "",
        "Design tasks that avoid repeating the same failure. If the failure reveals a misunderstanding of the codebase, investigate before proposing implementation tasks.",
      ].join("\n");
    } catch {
      return "";
    }
  })();

  const content = [
    "You are the planner for an autonomous agentic coding loop.",
    "",
    "Read and follow AGENTS.md / CLAUDE.md if present. Use grill-with-docs-style discovery by default before planning: restate the goal, inspect repo docs/code for answers, separate decisions/assumptions/open questions, update CONTEXT.md when durable domain/product context changes, and stop with needs_human only for unresolved product/domain decisions.",
    "",
    `The harness provided a context packet at: ${repoContextFile}`,
    `The harness also generated optional CodeGraph context at: ${codeGraphFile}`,
    "Use CodeGraph context for orientation before broad manual search, then verify conclusions against source files. If the artifact says CodeGraph is unavailable, continue normally.",
    "Inspect deeper in the repository when needed.",
    "",
    "When planning validation, propose focused task.validation commands that prove each task. If a task adds or changes a small smoke test/check that directly proves the change, include that newly added focused smoke command in the task.validation array so the harness runs it before verification. Prefer PowerShell Core examples in the form `pwsh -File path/to/smoke.ps1`; mention `powershell.exe` only for explicitly documented legacy Windows PowerShell compatibility.",
    "",
    `Do not edit ${stateFile} directly. Write planner JSON only to: ${plannerResultFile}`,
    `Also write an autonomous grill transcript markdown file to: ${grillTranscriptFile}`,
    "",
    "The grill transcript must make your discovery visible for human review. Use this structure:",
    "# Autonomous Grill Transcript",
    "## Goal Restatement",
    "## Questions, Evidence, Answers, Proposals",
    "For each grill question include: question, repo/docs evidence inspected, autonomous answer, proposal/decision, and whether human input is needed.",
    "## Final Plan Rationale",
    "Explain why the task split, dependencies, validation commands, assumptions, and open questions are appropriate.",
    "",
    "Allowed verdicts: planned, needs_human, blocked.",
    "Allowed task statuses in planner output: pending, needs_human, blocked.",
    "Allowed task kinds: discovery, investigation, implementation, architecture, maintenance, handoff.",
    "Each task must have: id, title, kind, workflow, status, priority, acceptanceCriteria, validation, dependsOn, failureHistory, artifacts, scope.",
    "Use one workflow per task. Use dependencies for workflow sequences. Use only canonical workflows from the policy.",
    "Keep tasks small and independently verifiable: one logical change, one primary artifact/change area, and focused validation. Split broad goals into dependent tasks. If safe slicing is unclear or a task would need multiple unrelated changes, record the uncertainty in openQuestions or needs_human rather than creating a broad task.",
    "Always set `scope` to the forward-slash glob list of files the task may change (for example [\"scripts/agentic/**\", \"tests/agentic/my-smoke.ps1\"]). The harness enforces scope as a hard pre-verifier rail: files changed outside scope fail the task. Keep scope tight (5 globs or fewer) so the rail is meaningful; if a task needs broad scope it is probably too large and should be split.",
    "Task-size budget (enforced by the harness validator): at most 7 acceptanceCriteria, at most 5 scope globs, and implementation/architecture tasks must have at least one acceptanceCriterion. Tasks exceeding the budget are rejected; split them or record the difficulty in openQuestions/needs_human.",
    "",
    "Planner result schema:",
    JSON.stringify({
      verdict: "planned|needs_human|blocked",
      summary: "...",
      decisions: [],
      assumptions: [],
      openQuestions: [],
      blockers: [],
      tasks: [],
      artifacts: ["path/to/grill-transcript.md"],
    }, null, 2),
    `Each task object: ${JSON.stringify({ id: "...", title: "...", kind: "...", workflow: "...", status: "pending", priority: 1, acceptanceCriteria: [], validation: [], dependsOn: [], failureHistory: [], artifacts: [], scope: ["scripts/agentic/**"] })}`,
    priorFailureBlock,
    "",
    `Goal: ${state.goal ?? ""}`,
    "Policy:",
    policyText,
  ].join("\n");

  writePromptWithEvent(promptFile, content, "planner", repoRoot, runsRoot, stateFile, budget, {
    resultFile: plannerResultFile,
    codegraph: codeGraphFile,
    priorFailureAnalysis: priorFailureAnalysisFile || undefined,
  });
}

export function getWorkflowBlock(workflow: string, policy: WorkflowPolicy): string {
  const def = policy.workflows?.[workflow] as unknown as Record<string, unknown> | undefined;
  if (def) {
    const block = def["executorBlock"] as Record<string, unknown> | undefined;
    if (block) {
      const required = (block["requiredWorkflow"] as string | undefined) ?? workflow;
      const lines = [`Required workflow: use ${required}.`];
      const loop = block["expectedLoop"] as string[] | undefined;
      if (loop?.length) {
        lines.push("Expected loop:");
        loop.forEach((step, i) => lines.push(`${i + 1}. ${step}`));
      }
      return lines.join("\n");
    }
  }
  return `Required workflow: use ${workflow}. Read and follow the canonical SKILL.md for this workflow.`;
}

export interface ExecutorPromptOptions {
  repoRoot: string;
  runsRoot: string;
  stateFile: string;
  budget: PromptBudget;
  task: Task;
  iteration: number;
  runDir: string;
  eventLogPath: string;
  codeGraphFile?: string;
  policy: WorkflowPolicy;
  taskGrillResult?: unknown;
}

export function writeExecutorPrompt(promptFile: string, opts: ExecutorPromptOptions): void {
  const {
    repoRoot, runsRoot, stateFile, budget, task, iteration, runDir,
    eventLogPath: evLogPath, codeGraphFile = "", policy, taskGrillResult,
  } = opts;

  const limits = getPromptBudgetLimits(budget);
  const workflow = task.workflow ?? "tdd";
  const kind = task.kind ?? "implementation";
  const taskJson = JSON.stringify(task, null, 2);
  const recentHistory = getRecentHistoryText(repoRoot, runsRoot, limits.eventLimit, budget);

  const content = [
    "You are executing one task inside an agentic harness worktree.",
    "",
    "Hard rules:",
    "- Complete exactly one task: the task JSON below.",
    "- Read AGENTS.md / CLAUDE.md and follow repository rules.",
    "- Read and follow the canonical SKILL.md for the selected workflow.",
    "- The harness owns task status, verification, commits, and merges.",
    "- Do not mark the task passed yourself.",
    "- Do not edit upstream-derived files unless explicit permission is present.",
    `- Keep task artifacts under this run directory when useful: ${runDir}`,
    `- Before finishing, write a concise handover note to \`${runDir}/handover.md\` with: what changed, key files, validation run, gotchas, and next-task notes.`,
    "- For discovery/investigation tasks, useful artifact files may be the main output; code changes are not required unless the task asks for them.",
    "- For implementation/architecture/maintenance tasks, prefer tracked repo changes plus validation unless the task is explicitly artifact-only.",
    "- When you add a focused smoke test/check that proves this task, use or propose it as a task.validation command (for example `pwsh -File tests/path/focused-smoke.ps1`) so the harness runs it before verification.",
    "- Use `pwsh -File` in harness and smoke-test command examples. Mention `powershell.exe` only as a legacy Windows PowerShell compatibility fallback when explicitly needed.",
    "- If the task JSON has a non-empty `scope`, change only files matching those globs. The harness enforces this as a hard pre-verifier rail: files changed outside scope fail the task. If you must touch a file outside scope, stop and record it in the handover instead of editing it.",
    "",
    `Iteration: ${iteration}`,
    `State file: ${stateFile}`,
    `Selected workflow: ${workflow}`,
    `Task kind: ${kind}`,
    `Run directory: ${runDir}`,
    `CodeGraph context: ${codeGraphFile}`,
    "",
    "Use CodeGraph context for orientation before broad manual search, especially for dependency/call relationship questions. Verify conclusions by reading source files. If CodeGraph is unavailable, continue normally.",
    "",
    `Recent harness history (JSONL tail; source of truth is ${evLogPath}):`,
    recentHistory,
    "",
    getWorkflowBlock(workflow, policy),
    "",
    "Task-grill result for this turn:",
    taskGrillResult ? JSON.stringify(taskGrillResult, null, 2) : "No task-grill result was provided.",
    "",
    "Task JSON:",
    taskJson,
  ].join("\n");

  writePromptWithEvent(promptFile, content, "executor", repoRoot, runsRoot, stateFile, budget, {
    task: task.id,
    codegraph: codeGraphFile,
  });
}

export interface TaskGrillPromptOptions {
  repoRoot: string;
  runsRoot: string;
  stateFile: string;
  budget: PromptBudget;
  task: Task;
  iteration: number;
  runDir: string;
  resultFile: string;
  eventLogPath: string;
  codeGraphFile?: string;
  policy: WorkflowPolicy;
  /** Path to failure-analysis.json from the most recent failed attempt, if any. */
  priorFailureAnalysisFile?: string;
}

export function writeTaskGrillPrompt(promptFile: string, opts: TaskGrillPromptOptions): void {
  const {
    repoRoot, runsRoot, stateFile, budget, task, iteration, runDir,
    resultFile, eventLogPath: evLogPath, codeGraphFile = "", policy,
    priorFailureAnalysisFile = "",
  } = opts;

  const limits = getPromptBudgetLimits(budget);
  const recentHistory = getRecentHistoryText(repoRoot, runsRoot, limits.eventLimit, budget);
  const taskJson = JSON.stringify(task, null, 2);

  const priorFailureBlock = (() => {
    if (!priorFailureAnalysisFile || !existsSync(priorFailureAnalysisFile)) return "";
    try {
      const fa = JSON.parse(readFileSync(priorFailureAnalysisFile, "utf-8"));
      return [
        "",
        "Prior attempt failure analysis (read carefully before deciding verdict):",
        `- Phase that failed: ${fa.phase ?? "unknown"}`,
        `- Attempt number: ${fa.attempt ?? "unknown"}`,
        `- Failed at: ${fa.failedAt ?? "unknown"}`,
        `- Diff stat at failure:\n${fa.diffStat || "(none)"}`,
        `- Failure reason (truncated):\n${fa.reason || "(none)"}`,
      ].join("\n");
    } catch {
      return "";
    }
  })();

  const content = [
    "You are the task-grill reviewer for one autonomous agentic loop turn.",
    "",
    "Goal: decide whether the executor truly understands the next task in the current repository state before any edits happen.",
    "",
    `Iteration: ${iteration}`,
    `Run directory: ${runDir}`,
    `CodeGraph context: ${codeGraphFile}`,
    "",
    "Read AGENTS.md / CLAUDE.md, repo docs, relevant source, recent harness history, and the task JSON. Do not edit files.",
    "",
    "Ask yourself:",
    "- Do I understand exactly what this task asks for now?",
    "- What current repo evidence supports that understanding?",
    "- Which planner assumptions are stale, risky, or unproven?",
    "- Is declared scope still right and sufficient?",
    "- What proof/check should the executor produce before verifier review?",
    "- Should this task stop before editing because it needs human input, replanning, or is blocked?",
    "",
    `Write task-grill JSON only to: ${resultFile}`,
    "",
    "Allowed verdicts: ready, needs_replan, needs_human, blocked.",
    "Schema:",
    JSON.stringify({
      verdict: "ready|needs_replan|needs_human|blocked",
      understanding: "...",
      evidence: ["path or command inspected"],
      assumptionsStillValid: [],
      assumptionsChanged: [],
      scopeDecision: {
        declaredScopeOk: true,
        requestedScopeChanges: [],
      },
      acceptanceProof: ["command or artifact expected"],
      risks: [],
      executorInstructions: "Concrete instructions for the executor on this turn.",
    }, null, 2),
    "",
    "If verdict is not ready, explain why in risks or assumptionsChanged. The harness will stop before executor edits.",
    priorFailureBlock,
    "",
    `Recent harness history (JSONL tail; source of truth is ${evLogPath}):`,
    recentHistory,
    "",
    "Workflow policy:",
    JSON.stringify(policy, null, 2),
    "",
    "Task JSON:",
    taskJson,
  ].join("\n");

  writePromptWithEvent(promptFile, content, "task_grill", repoRoot, runsRoot, stateFile, budget, {
    task: task.id,
    resultFile,
    codegraph: codeGraphFile,
    priorFailureAnalysis: priorFailureAnalysisFile || undefined,
  });
}

export interface VerifierPromptOptions {
  repoRoot: string;
  runsRoot: string;
  stateFile: string;
  budget: PromptBudget;
  task: Task;
  worktreePath: string;
  checkOutput: string;
  resultFile: string;
  eventLogPath: string;
  policy: WorkflowPolicy;
  adversarial?: boolean;
}

export function writeVerifierPrompt(promptFile: string, opts: VerifierPromptOptions): void {
  const {
    repoRoot, runsRoot, stateFile, budget, task, worktreePath,
    checkOutput, resultFile, eventLogPath: evLogPath, policy, adversarial = false,
  } = opts;

  const limits = getPromptBudgetLimits(budget);
  const taskJson = JSON.stringify(task, null, 2);
  const diffStat = git(["diff", "--stat", "HEAD"], worktreePath);
  const rawDiff  = git(["diff", "HEAD"], worktreePath);
  const rawDiffBytes = Buffer.byteLength(rawDiff, "utf-8");
  const diffPath = join(dirname(promptFile), "diff.patch");
  const diffInlined = rawDiffBytes <= limits.diffBytes;
  const diff = diffInlined
    ? rawDiff
    : `[diff omitted from prompt: ${rawDiffBytes} bytes exceeds ${limits.diffBytes}. Full diff artifact: ${diffPath}]`;

  const checkOutputForPrompt = limitTextForPrompt(checkOutput, limits.checkBytes, 80);
  const gates = JSON.stringify(policy.humanGates ?? [], null, 2);
  const recentHistory = getRecentHistoryText(repoRoot, runsRoot, limits.eventLimit, budget);

  const adversarialBlock = adversarial
    ? [
        "This task is high-risk and you are one of several independent adversarial reviewers.",
        "Your job is to REFUTE the change: actively look for the reason it is wrong, incomplete, or unsafe.",
        "Default to fail or needs_human when you cannot positively confirm the change is correct and in scope.",
        "Only return pass if, after genuinely trying to break it, you find no defensible objection.",
        "",
      ].join("\n")
    : "";

  const content = [
    "You are the verifier for one agentic task.",
    "",
    adversarialBlock,
    `Review the task, acceptance criteria, workflow, git diff, checks, and human gates. Write JSON only to this path: ${resultFile}`,
    "",
    "Allowed verdicts: pass, fail, needs_human.",
    `Schema: { "verdict": "pass|fail|needs_human", "summary": "...", "issues": [], "humanGates": [], "recommendedStatus": "passed|failed|needs_retry|needs_human|blocked", "artifacts": [] }`,
    "",
    "Task-kind guidance:",
    "- discovery/investigation tasks may pass with artifact evidence and no git diff.",
    "- implementation/architecture/maintenance tasks normally need tracked changes or a clear no-diff explanation.",
    "- handoff tasks should produce a handoff artifact and usually recommend needs_human or blocked unless the task explicitly only asks for a handoff note.",
    "",
    "Task JSON:",
    taskJson,
    "",
    "Human gates:",
    gates,
    "",
    `Recent harness history (JSONL tail; source of truth is ${evLogPath}):`,
    recentHistory,
    "",
    "Check output (capped; full output is in checks.log):",
    checkOutputForPrompt,
    "",
    "Git diff stat:",
    diffStat,
    "",
    "Git diff:",
    diff,
  ].join("\n");

  writePromptWithEvent(promptFile, content, "verifier", repoRoot, runsRoot, stateFile, budget, {
    task: task.id,
    diffBytes: rawDiffBytes,
    diffInlined,
    checkBytes: Buffer.byteLength(checkOutput, "utf-8"),
  });
}

export interface FailureAnalysis {
  taskId: string;
  phase: string;
  attempt: number;
  failedAt: string;
  reason: string;
  diffStat: string;
}

export interface WriteFailureAnalysisOptions {
  taskId: string;
  phase: string;
  attempt: number;
  rawOutput: string;
  worktreePath: string;
  outputFile: string;
}

// Write a structured failure-analysis.json to the run dir at every failure point.
// Harness-written (no agent call): captures phase, truncated output, diff stat, attempt.
// Consumed by task-grill and planner prompts to break blind-retry loops.
export function writeFailureAnalysis(opts: WriteFailureAnalysisOptions): FailureAnalysis {
  const { taskId, phase, attempt, rawOutput, worktreePath, outputFile } = opts;
  const diffStat = git(["diff", "--stat", "HEAD"], worktreePath);
  const truncatedReason = limitTextForPrompt(rawOutput, 8_000, 100);
  const analysis: FailureAnalysis = {
    taskId,
    phase,
    attempt,
    failedAt: new Date().toISOString(),
    reason: truncatedReason,
    diffStat,
  };
  mkdirSync(dirname(outputFile), { recursive: true });
  writeFileSync(outputFile, JSON.stringify(analysis, null, 2), "utf-8");
  return analysis;
}

export interface FinalizeDocsPromptOptions {
  repoRoot: string;
  runsRoot: string;
  stateFile: string;
  budget: PromptBudget;
  state: AgenticState;
  summaryFile: string;
}

export function writeFinalizeDocsPrompt(promptFile: string, opts: FinalizeDocsPromptOptions): void {
  const { repoRoot, runsRoot, stateFile, budget, state, summaryFile } = opts;

  const stateJson = JSON.stringify(state, null, 2);
  const limits = getPromptBudgetLimits(budget);
  const recentHistory = getRecentHistoryText(repoRoot, runsRoot, 30, budget);
  const diffStat = git(["diff", "--stat", "HEAD"], repoRoot);
  const projectState = existsSync(join(repoRoot, "PROJECT.md")) ? "PROJECT.md exists" : "PROJECT.md missing";
  const contextState = existsSync(join(repoRoot, "CONTEXT.md"))
    ? "CONTEXT.md exists (planning-stage grill-with-docs ownership)"
    : "CONTEXT.md missing";

  const content = [
    "You are finalizing a completed agentic loop run.",
    "",
    "Goal: update durable repository markdowns only when the completed work changed durable facts.",
    "",
    "Rules:",
    "- Use the canonical update-project-md behavior for PROJECT.md.",
    "- Update PROJECT.md for technical facts: commands, architecture, validation, workflows, debugging, file roles, setup changes.",
    "- Do not normally edit CONTEXT.md here; CONTEXT.md belongs to the planning grill-with-docs stage. Only touch it if execution discovered a durable domain/product fact that could not have been known during planning, and explain that exception in the final summary.",
    "- Do not edit AGENTS.md or CLAUDE.md unless the task explicitly changed agent policy.",
    "- Keep edits concise and factual. Do not add transient run logs.",
    "- If no durable docs need changes, leave the markdown files unchanged and explain why in the final summary.",
    `- Always write a final human checkpoint summary to: ${summaryFile}`,
    "",
    "Docs available:",
    `- ${projectState}`,
    `- ${contextState}`,
    "",
    "Agentic state:",
    stateJson,
    "",
    "Recent harness events:",
    recentHistory,
    "",
    "Current uncommitted diff stat before doc finalization:",
    diffStat,
  ].join("\n");

  mkdirSync(dirname(promptFile), { recursive: true });
  writeFileSync(promptFile, content, "utf-8");
}

// Validate a raw planner result object, returning an array of error strings (empty = valid).
export function validatePlannerResult(
  result: Record<string, unknown> | null,
  policy: WorkflowPolicy
): string[] {
  const errors: string[] = [];
  if (!result) return ["planner result is empty"];

  const validVerdicts = ["planned", "needs_human", "blocked"];
  if (!validVerdicts.includes(result["verdict"] as string)) {
    errors.push("verdict must be planned, needs_human, or blocked");
  }

  const allowedWorkflows = Object.keys(policy.workflows ?? {});
  const allowedKinds = ["discovery", "investigation", "implementation", "architecture", "maintenance", "handoff"];
  const allowedStatuses = ["pending", "needs_human", "blocked"];
  const tasks = (result["tasks"] as Record<string, unknown>[] | undefined) ?? [];
  const ids = new Set<string>();

  for (const task of tasks) {
    const id = (task["id"] as string | undefined)?.trim();
    if (!id) { errors.push("task missing id"); continue; }
    if (ids.has(id)) { errors.push(`duplicate task id: ${id}`); } else { ids.add(id); }
    if (!(task["title"] as string | undefined)?.trim()) errors.push(`${id} missing title`);
    if (!allowedKinds.includes(task["kind"] as string)) errors.push(`${id} has invalid kind: ${task["kind"]}`);
    if (!allowedWorkflows.includes(task["workflow"] as string)) errors.push(`${id} has invalid workflow: ${task["workflow"]}`);
    if (!allowedStatuses.includes(task["status"] as string)) errors.push(`${id} has invalid status: ${task["status"]}`);
    if (task["priority"] == null) errors.push(`${id} missing priority`);

    const ac = (task["acceptanceCriteria"] as unknown[] | undefined) ?? [];
    if (ac.length > 7) errors.push(`${id} has too many acceptanceCriteria (${ac.length} > 7); split the task`);

    const scope = ((task["scope"] as unknown[] | undefined) ?? []).filter((s) => String(s).trim());
    if (scope.length > 5) errors.push(`${id} has too many scope globs (${scope.length} > 5); split the task or tighten scope`);

    const kind = task["kind"] as string;
    if (["implementation", "architecture"].includes(kind) && ac.length === 0) {
      errors.push(`${id} is an ${kind} task with no acceptanceCriteria; add criteria or reclassify`);
    }
  }

  for (const task of tasks) {
    const id = task["id"] as string;
    const deps = (task["dependsOn"] as unknown[] | undefined) ?? [];
    for (const dep of deps) {
      const depStr = String(dep);
      if (!ids.has(depStr)) errors.push(`${id} depends on unknown task: ${depStr}`);
      if (depStr === id) errors.push(`${id} depends on itself`);
    }
  }

  return errors;
}
