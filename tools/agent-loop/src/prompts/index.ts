import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync } from "fs";
import { join, dirname, resolve } from "path";
import { execFileSync } from "child_process";
import { homedir } from "os";
import type { AgenticState, Task } from "../state/index.js";
import type { WorkflowPolicy } from "../policy/index.js";
import { appendEvent, getRecentEvents, formatEventLine, loadEvents } from "../events/index.js";
import { git as gitTool } from "../tools/index.js";

// Resolve a skill's SKILL.md path from the installed skills directories.
// Checks ~/.claude/skills, ~/.codex/skills, and the repo's own skills/ folder.
// Returns the path if found, or a fallback stub string if not.
export function resolveSkillFile(skillName: string, repoRoot: string): { path: string; found: boolean } {
  const candidates = [
    join(homedir(), ".claude", "skills", skillName, "SKILL.md"),
    join(homedir(), ".codex", "skills", skillName, "SKILL.md"),
    join(repoRoot, "skills", "engineering", skillName, "SKILL.md"),
    join(repoRoot, "skills", "productivity", skillName, "SKILL.md"),
    join(repoRoot, "skills", "misc", skillName, "SKILL.md"),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return { path: p, found: true };
  }
  return { path: "", found: false };
}

// Returns an instruction block pointing at the skill file, with a fallback
// summary when the file is not installed.
export function skillInstruction(skillName: string, repoRoot: string, fallbackSummary: string): string {
  const { path, found } = resolveSkillFile(skillName, repoRoot);
  if (found) return `Read and follow the canonical skill at: ${path}`;
  return `Skill file for '${skillName}' was not found. Follow this summary instead:\n${fallbackSummary}`;
}

export type PromptBudget = "low" | "medium" | "high";

export interface BudgetLimits {
  checkBytes: number;
  diffBytes: number;
  eventLimit: number;
}

const BUDGET_LOW:    BudgetLimits = { checkBytes:  6_000, diffBytes:  12_000, eventLimit:  6 };
const BUDGET_MEDIUM: BudgetLimits = { checkBytes: 12_000, diffBytes:  20_000, eventLimit: 12 };
const BUDGET_HIGH:   BudgetLimits = { checkBytes: 50_000, diffBytes: 100_000, eventLimit: 20 };

export function getPromptBudgetLimits(budget: PromptBudget): BudgetLimits {
  switch (budget) {
    case "low":  return BUDGET_LOW;
    case "high": return BUDGET_HIGH;
    default:     return BUDGET_MEDIUM;
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
    return gitTool(args, cwd);
  } catch {
    return "";
  }
}

// Run `codegraph sync` in the given directory to bring the index up to date after file changes.
// If the index is not initialized, runs `codegraph init -i` first. Silent no-op if codegraph is not on PATH.
export function syncCodeGraph(workingDirectory = "."): void {
  try {
    const statusOut = execFileSync("codegraph", ["status", workingDirectory], { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], timeout: 10_000 });
    if (statusOut.includes("Not initialized")) {
      execFileSync("codegraph", ["init", "-i", workingDirectory], { encoding: "utf-8", stdio: "ignore", timeout: 120_000 });
    } else {
      execFileSync("codegraph", ["sync", workingDirectory], { encoding: "utf-8", stdio: "ignore", timeout: 60_000 });
    }
  } catch {
    // codegraph not installed or failed — non-fatal
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

  const grillSkill = skillInstruction("grill-with-docs", repoRoot,
    "Restate the goal, inspect repo docs/code for answers, separate decisions/assumptions/open questions, update CONTEXT.md when durable context changes, stop with needs_human only for unresolved product/domain decisions."
  );

  const content = [
    "You are the planner for an autonomous agentic coding loop.",
    "",
    "Read and follow AGENTS.md / CLAUDE.md if present.",
    "",
    "DISCOVERY PHASE — before planning, conduct a full grill-with-docs self-interview:",
    grillSkill,
    "",
    `The harness provided a context packet at: ${repoContextFile}`,
    `The harness also generated optional CodeGraph context at: ${codeGraphFile}`,
    "Use CodeGraph context for orientation before broad manual search, then verify conclusions against source files. If the artifact says CodeGraph is unavailable, run `codegraph init -i` in the working directory to initialize it before proceeding.",
    "Inspect deeper in the repository when needed.",
    "",
    "When planning validation, match proof to workflow. Discovery/investigation/zoom-out tasks may be proven by artifacts and evidence notes; do not attach implementation test commands to artifact-only discovery tasks. Implementation/architecture tasks need focused task.validation commands when behavior or code changes should be proven. If a task adds or changes a small smoke test/check that directly proves the change, include that command in task.validation so the harness runs it before verification. Prefer `pwsh -File path/to/smoke.ps1`; mention `powershell.exe` only as legacy fallback.",
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
    "Keep tasks small and independently verifiable. Split broad goals into dependent tasks.",
    "Always set `scope` to the forward-slash glob list of files the task may change. Keep scope tight (5 globs or fewer), but include every file implied by acceptance criteria, including new focused test files when direct helper-level proof requires them.",
    "Task-size budget (enforced by the harness): at most 7 acceptanceCriteria, at most 5 scope globs, implementation/architecture tasks must have at least one acceptanceCriterion.",
    "",
    "For every genuine design/product/architecture decision the plan forces, run a grill-with-docs self-interview: weigh 2-4 real options with concrete repo/docs evidence, mark one recommended, answer it yourself. Set escalate:true only when evidence genuinely cannot settle it.",
    "",
    "Planner result schema:",
    JSON.stringify({
      verdict: "planned|needs_human|blocked",
      summary: "...",
      decisions: [
        {
          question: "...",
          whyItMatters: "...",
          optionsConsidered: [
            { label: "...", evidence: "repo path / command / doc inspected", recommended: true },
            { label: "...", evidence: "...", recommended: false },
          ],
          chosen: "...",
          selfAnswer: "why I answered this myself without a human",
          confidence: "high|medium|low",
          escalate: false,
        },
      ],
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

export function getWorkflowBlock(workflow: string, policy: WorkflowPolicy, repoRoot?: string): string {
  const skillRef = repoRoot
    ? skillInstruction(workflow, repoRoot, `Follow the ${workflow} workflow. Read and follow its canonical SKILL.md.`)
    : `Required workflow: use ${workflow}. Read and follow the canonical SKILL.md for this workflow.`;

  const def = policy.workflows?.[workflow] as unknown as Record<string, unknown> | undefined;
  if (def) {
    const block = def["executorBlock"] as Record<string, unknown> | undefined;
    if (block) {
      const required = (block["requiredWorkflow"] as string | undefined) ?? workflow;
      const lines = [`Required workflow: use ${required}.`, skillRef];
      const loop = block["expectedLoop"] as string[] | undefined;
      if (loop?.length) {
        lines.push("Expected loop:");
        loop.forEach((step, i) => lines.push(`${i + 1}. ${step}`));
      }
      return lines.join("\n");
    }
  }
  return skillRef;
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
  decisionGrillDecisions?: Record<string, unknown>[];
}

export function writeExecutorPrompt(promptFile: string, opts: ExecutorPromptOptions): void {
  const {
    repoRoot, runsRoot, stateFile, budget, task, iteration, runDir,
    eventLogPath: evLogPath, codeGraphFile = "", policy, taskGrillResult,
    decisionGrillDecisions = [],
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
    ...(decisionGrillDecisions.length > 0 ? [
      "Binding decisions — the decision grill resolved these before you run. Treat each as a hard rule:",
      ...decisionGrillDecisions.map((d) => {
        const chosen = String(d["chosen"] ?? "").trim();
        const why = String(d["whyItMatters"] ?? "").trim();
        const q = String(d["question"] ?? "").trim();
        return `- ${q}: ${chosen}${why ? ` (${why})` : ""}`;
      }),
      "",
    ] : []),
    `Iteration: ${iteration}`,
    `State file: ${stateFile}`,
    `Selected workflow: ${workflow}`,
    `Task kind: ${kind}`,
    `Run directory: ${runDir}`,
    `CodeGraph context: ${codeGraphFile}`,
    "",
    "Use CodeGraph context for orientation before broad manual search, especially for dependency/call relationship questions. Verify conclusions by reading source files. If CodeGraph is unavailable, run `codegraph init -i` in the working directory to initialize it before proceeding.",
    "",
    `Recent harness history (JSONL tail; source of truth is ${evLogPath}):`,
    recentHistory,
    "",
    getWorkflowBlock(workflow, policy, repoRoot),
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
  state?: AgenticState;
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
    "Your job is the same as grill-with-docs — but you play BOTH roles: ask the hard questions, then answer them yourself from repo evidence before the executor touches anything.",
    "",
    `Iteration: ${iteration}`,
    `Run directory: ${runDir}`,
    `CodeGraph context: ${codeGraphFile}`,
    "",
    "Read AGENTS.md / CLAUDE.md, PROJECT.md, CONTEXT.md, relevant source files, tests, and recent harness history. Do not edit files.",
    "",
    "Conduct a thorough self-interview. For each question below, inspect actual repo evidence before answering — do not assume or rubber-stamp:",
    "",
    "UNDERSTANDING",
    "- What exactly does this task ask for? Restate it in your own words from the acceptance criteria.",
    "- Which files, functions, or modules are directly involved? (inspect them)",
    "- Are there callers, dependents, or integration points that the executor must not break?",
    "",
    "DOMAIN & PRODUCT",
    "- Is the domain language in the task consistent with CONTEXT.md and existing code? Any terminology mismatch?",
    "- Does the acceptance criteria match what the user actually wants, or could it be misread?",
    "",
    "DESIGN DECISIONS",
    "- Does this task force any real design/architecture choice? If yes, what are the 2-4 genuine options and which does the evidence support?",
    "- Is there an existing pattern in the codebase the executor should follow rather than invent?",
    "",
    "ASSUMPTIONS & RISKS",
    "- Which planner assumptions are stale, unproven, or contradict what you see in the repo right now?",
    "- What is the most likely way the executor will get this wrong? (scope creep, wrong abstraction, missed edge case)",
    "- Are there any safety, security, or data-integrity concerns the executor must not ignore?",
    "",
    "SCOPE & VALIDATION",
    "- Is the declared scope tight enough? Are there files missing from scope that will definitely change?",
    "- What specific command or artifact will prove the task is done? For discovery/investigation/zoom-out tasks, artifact proof is acceptable; for implementation/architecture tasks, use focused validation commands when practical. Is the proof represented in task.validation or artifacts?",
    "- Are there edge cases the acceptance criteria do not cover that could cause a verifier fail?",
    "",
    "VERDICT",
    "- Should this task proceed as-is, or does it need replanning, human input, or is it blocked?",
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
    "If a prior failure was environmental or scope-related, inspect current repo/worktree state before blocking. Do not treat a stale failure as active when current evidence shows bootstrap, env, or scope conditions have changed.",
    priorFailureBlock,
    "",
    `Recent harness history (JSONL tail; source of truth is ${evLogPath}):`,
    recentHistory,
    "",
    "Current planner assumptions (tag [valid]/[changed] from prior grill turns):",
    (opts.state?.assumptions?.length ? opts.state.assumptions.join("\n") : "(none recorded yet)"),
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

export interface DecisionOption {
  label: string;
  evidence: string;
  recommended: boolean;
}

export interface DecisionRecord {
  question: string;
  whyItMatters: string;
  optionsConsidered: DecisionOption[];
  chosen: string;
  selfAnswer: string;
  confidence: "high" | "medium" | "low";
  escalate: boolean;
}

// Validate self-grill decision records, returning error strings (empty = valid).
// This is the detail-sensitivity rail: a decision the loop answers for itself must
// weigh real alternatives with evidence and mark exactly one recommended option,
// mirroring the grill-with-docs discipline (2-4 options, one Recommended, why-it-matters).
export function validateDecisions(records: unknown): string[] {
  const errors: string[] = [];
  if (!Array.isArray(records)) return ["decisions must be an array"];

  records.forEach((raw, i) => {
    const d = raw as Partial<DecisionRecord> | null;
    const tag = `decision[${i}]`;
    if (!d || typeof d !== "object") { errors.push(`${tag} is not an object`); return; }
    if (!String(d.question ?? "").trim()) errors.push(`${tag} missing question`);
    if (!String(d.whyItMatters ?? "").trim()) errors.push(`${tag} missing whyItMatters (every self-answered decision must say why it matters)`);
    if (!String(d.chosen ?? "").trim()) errors.push(`${tag} missing chosen`);
    if (!String(d.selfAnswer ?? "").trim()) errors.push(`${tag} missing selfAnswer (explain why you answered this yourself without a human)`);
    if (!["high", "medium", "low"].includes(d.confidence as string)) errors.push(`${tag} confidence must be high, medium, or low`);
    if (typeof d.escalate !== "boolean") errors.push(`${tag} escalate must be a boolean`);

    const opts = Array.isArray(d.optionsConsidered) ? d.optionsConsidered : [];
    if (opts.length < 2) {
      errors.push(`${tag} considered ${opts.length} option(s); weigh at least 2 real alternatives before answering yourself`);
    }
    if (opts.length > 4) {
      errors.push(`${tag} considered ${opts.length} options; keep it to 2-4 focused alternatives`);
    }
    const recommendedCount = opts.filter((o) => o && (o as DecisionOption).recommended === true).length;
    if (opts.length >= 2 && recommendedCount !== 1) {
      errors.push(`${tag} must mark exactly one option recommended (found ${recommendedCount})`);
    }
    opts.forEach((o, j) => {
      const opt = o as Partial<DecisionOption> | null;
      if (!opt || !String(opt.label ?? "").trim()) errors.push(`${tag}.option[${j}] missing label`);
      if (!opt || !String(opt.evidence ?? "").trim()) errors.push(`${tag}.option[${j}] missing evidence (cite repo/docs/code you inspected)`);
    });
  });

  return errors;
}

// Render one validated decision record as the flat string stored in state.decisions,
// mirroring the assumption-ledger tagging style so the ledger stays string[].
export function formatDecisionRecord(d: DecisionRecord, taskId: string): string {
  const opts = d.optionsConsidered
    .map((o) => `${o.recommended ? "*" : "-"} ${o.label} (${o.evidence})`)
    .join(" | ");
  return `[${taskId}] Q: ${d.question} | why: ${d.whyItMatters} | options: ${opts} | chose: ${d.chosen} | self-answer: ${d.selfAnswer} | confidence: ${d.confidence}`;
}

export interface DecisionGrillPromptOptions {
  repoRoot: string;
  runsRoot: string;
  stateFile: string;
  budget: PromptBudget;
  state: AgenticState;
  task: Task;
  iteration: number;
  runDir: string;
  resultFile: string;
  eventLogPath: string;
  codeGraphFile?: string;
  /** When re-grilling after a shallow/low-confidence pass, the errors/reasons to fix. */
  priorShallowFeedback?: string;
}

export function writeDecisionGrillPrompt(promptFile: string, opts: DecisionGrillPromptOptions): void {
  const {
    repoRoot, runsRoot, stateFile, budget, state, task, iteration, runDir,
    resultFile, eventLogPath: evLogPath, codeGraphFile = "", priorShallowFeedback = "",
  } = opts;

  const limits = getPromptBudgetLimits(budget);
  const recentHistory = getRecentHistoryText(repoRoot, runsRoot, limits.eventLimit, budget);
  const taskJson = JSON.stringify(task, null, 2);

  const reGrillBlock = priorShallowFeedback
    ? [
        "",
        "RE-GRILL: your previous decision pass was rejected as too shallow or low-confidence.",
        "Gather more concrete evidence from the repo before answering. Fix exactly these problems:",
        priorShallowFeedback,
        "If, after genuinely inspecting more evidence, you still cannot answer with at least medium confidence, set escalate=true for that decision.",
        "",
      ].join("\n")
    : "";

  const grillSkill = skillInstruction("grill-with-docs", repoRoot,
    "Ask the hard question, then answer it yourself from repo evidence. Weigh 2-4 real alternatives with concrete evidence. Pick one and justify. Do not rubber-stamp. Only escalate when evidence genuinely cannot settle the question."
  );

  const content = [
    "You are running a grill-with-docs self-interview for one autonomous loop turn.",
    "",
    "Before the executor edits, surface every genuine design/product/architecture decision this task forces. Play BOTH sides:",
    grillSkill,
    "",
    "Read AGENTS.md / CLAUDE.md, PROJECT.md, relevant source, and recent history. Do not edit files.",
    reGrillBlock,
    `Iteration: ${iteration}`,
    `Run directory: ${runDir}`,
    `CodeGraph context: ${codeGraphFile}`,
    "",
    `Write decision JSON only to: ${resultFile}`,
    "",
    "Contract (the harness enforces this — shallow decisions are rejected):",
    "- Each decision needs 2-4 real options, each with concrete evidence you actually inspected.",
    "- Exactly one option must be marked recommended:true.",
    "- whyItMatters must explain the stakes; selfAnswer must justify deciding without a human.",
    "- confidence is high/medium/low. Set escalate:true only when evidence genuinely cannot settle it.",
    "- If the task forces NO real decision, write an empty decisions array.",
    "",
    "Schema:",
    JSON.stringify({
      decisions: [
        {
          question: "...",
          whyItMatters: "...",
          optionsConsidered: [
            { label: "...", evidence: "repo path / command / doc inspected", recommended: true },
            { label: "...", evidence: "...", recommended: false },
          ],
          chosen: "...",
          selfAnswer: "why I answered this myself without a human",
          confidence: "high|medium|low",
          escalate: false,
        },
      ],
    }, null, 2),
    "",
    `Recent harness history (JSONL tail; source of truth is ${evLogPath}):`,
    recentHistory,
    "",
    "Decisions already recorded this run:",
    (state.decisions?.length ? state.decisions.join("\n") : "(none yet)"),
    "",
    "Task JSON:",
    taskJson,
  ].join("\n");

  mkdirSync(dirname(promptFile), { recursive: true });
  writeFileSync(promptFile, content, "utf-8");
}

export interface GoalReviewPromptOptions {
  repoRoot: string;
  runsRoot: string;
  stateFile: string;
  budget: PromptBudget;
  state: AgenticState;
  loopBaseRef: string;
  resultFile: string;
}

export function writeGoalReviewPrompt(promptFile: string, opts: GoalReviewPromptOptions): void {
  const { repoRoot, runsRoot, stateFile, budget, state, loopBaseRef, resultFile } = opts;

  const limits = getPromptBudgetLimits(budget);
  const recentHistory = getRecentHistoryText(repoRoot, runsRoot, limits.eventLimit, budget);
  const passedTasks = (state.tasks ?? []).filter((t) => t.status === "passed");
  const passedSummary = passedTasks.length
    ? passedTasks.map((t) => `- ${t.id}: ${t.title ?? "(no title)"}`).join("\n")
    : "(none)";
  const diffStat = loopBaseRef
    ? git(["diff", "--stat", loopBaseRef, "HEAD"], repoRoot)
    : git(["diff", "--stat", "HEAD"], repoRoot);

  const content = [
    "You are the goal reviewer for a completed agentic loop run.",
    "",
    "Your job: judge whether the work completed actually achieves the stated goal.",
    "Be critical. Look for gaps, missing pieces, and wrong scope.",
    "",
    "Read AGENTS.md / CLAUDE.md and inspect repo state and diffs before deciding.",
    "",
    `Write your verdict JSON only to: ${resultFile}`,
    "",
    "Allowed verdicts: pass, needs_human.",
    `Schema: { "verdict": "pass|needs_human", "summary": "...", "gaps": [] }`,
    "",
    "- pass: the cumulative work clearly satisfies the goal; no material gaps.",
    "- needs_human: one or more significant gaps exist between the completed work and the goal.",
    "",
    `Goal: ${state.goal ?? "(no goal recorded)"}`,
    "",
    "Passed tasks:",
    passedSummary,
    "",
    "Current assumptions:",
    (state.assumptions?.length ? state.assumptions.join("\n") : "(none)"),
    "",
    "Cumulative diff stat since loop start:",
    diffStat || "(no diff)",
    "",
    `Recent harness history:`,
    recentHistory,
  ].join("\n");

  mkdirSync(dirname(promptFile), { recursive: true });
  writeFileSync(promptFile, content, "utf-8");
}

export interface ArchitectCheckpointPromptOptions {
  repoRoot: string;
  runsRoot: string;
  stateFile: string;
  budget: PromptBudget;
  state: AgenticState;
  loopBaseRef: string;
  passedCount: number;
  resultFile: string;
}

export function writeArchitectCheckpointPrompt(promptFile: string, opts: ArchitectCheckpointPromptOptions): void {
  const { repoRoot, runsRoot, stateFile, budget, state, loopBaseRef, passedCount, resultFile } = opts;

  const limits = getPromptBudgetLimits(budget);
  const recentHistory = getRecentHistoryText(repoRoot, runsRoot, limits.eventLimit, budget);
  const tasks = state.tasks ?? [];
  const passedTasks = tasks.filter((t) => t.status === "passed");
  const remainingTasks = tasks.filter((t) => !["passed", "blocked"].includes(t.status ?? ""));
  const diffStat = loopBaseRef
    ? git(["diff", "--stat", loopBaseRef, "HEAD"], repoRoot)
    : git(["diff", "--stat", "HEAD"], repoRoot);

  const content = [
    "You are the architect reviewer for an in-progress agentic loop.",
    "",
    `${passedCount} task(s) have passed since the last checkpoint. Review the plan and cumulative diff for drift.`,
    "",
    "Ask yourself:",
    "- Is the remaining plan still correct given what has actually been built?",
    "- Does the cumulative diff reveal that the plan is heading in the wrong direction?",
    "- Are there missing tasks the plan failed to account for?",
    "- Is the goal still achievable with the current plan, or does the plan need a rethink?",
    "",
    "Read AGENTS.md / CLAUDE.md and inspect repo state before deciding.",
    "",
    `Write your verdict JSON only to: ${resultFile}`,
    "",
    "Allowed verdicts: continue, replan, needs_human.",
    `Schema: { "verdict": "continue|replan|needs_human", "assessment": "...", "suggestedChanges": [] }`,
    "",
    "- continue: plan is on track; proceed.",
    "- replan: the remaining plan needs significant rethinking; the harness will call the planner.",
    "- needs_human: drift is too severe or risky to resolve autonomously.",
    "",
    `Goal: ${state.goal ?? "(no goal recorded)"}`,
    "",
    "Passed tasks:",
    passedTasks.length ? passedTasks.map((t) => `- ${t.id}: ${t.title ?? ""}`).join("\n") : "(none)",
    "",
    "Remaining tasks:",
    remainingTasks.length ? remainingTasks.map((t) => `- [${t.status}] ${t.id}: ${t.title ?? ""}`).join("\n") : "(none — all done)",
    "",
    "Current assumptions:",
    (state.assumptions?.length ? state.assumptions.join("\n") : "(none)"),
    "",
    "Cumulative diff stat since loop start:",
    diffStat || "(no diff)",
    "",
    `Recent harness history:`,
    recentHistory,
  ].join("\n");

  mkdirSync(dirname(promptFile), { recursive: true });
  writeFileSync(promptFile, content, "utf-8");
}

export interface PostTaskReviewPromptOptions {
  repoRoot: string;
  runsRoot: string;
  stateFile: string;
  budget: PromptBudget;
  state: AgenticState;
  taskId: string;
  taskRunDir: string;
  verifierResultFile: string;
  handoverFile: string;
  loopBaseRef: string;
  resultFile: string;
}

export function writePostTaskReviewPrompt(promptFile: string, opts: PostTaskReviewPromptOptions): void {
  const {
    repoRoot, runsRoot, stateFile, budget, state, taskId, taskRunDir,
    verifierResultFile, handoverFile, loopBaseRef, resultFile,
  } = opts;

  const limits = getPromptBudgetLimits(budget);
  const recentHistory = getRecentHistoryText(repoRoot, runsRoot, limits.eventLimit, budget);
  const tasks = state.tasks ?? [];
  const completedTask = tasks.find((t) => t.id === taskId);
  const remainingTasks = tasks.filter((t) => !["passed", "blocked"].includes(t.status ?? ""));
  const diffStat = loopBaseRef
    ? git(["diff", "--stat", loopBaseRef, "HEAD"], repoRoot)
    : git(["diff", "--stat", "HEAD"], repoRoot);

  const content = [
    "You are the post-task plan reviewer for an autonomous agentic loop.",
    "",
    "The verifier already judged whether the completed task passed. Your job is different: reassess whether the remaining plan is still valid after this completed slice.",
    "Spend intelligence on assumptions, validation design, task slicing, and plan drift. Do not propose executor edits here.",
    "",
    `Completed task: ${taskId}`,
    `Completed task run directory: ${taskRunDir}`,
    `Verifier result: ${verifierResultFile}`,
    `Handover: ${handoverFile}`,
    "",
    "Read AGENTS.md / CLAUDE.md, the verifier result, handover, state, and relevant repo files before deciding.",
    "",
    `Write post-task review JSON only to: ${resultFile}`,
    "",
    "Allowed verdicts: continue, adjust_remaining_tasks, replan, needs_human.",
    `Schema: { "verdict": "continue|adjust_remaining_tasks|replan|needs_human", "assessment": "...", "remainingPlanStillValid": true, "suggestedChanges": [] }`,
    "",
    "- continue: the remaining pending tasks are still correctly sliced, scoped, ordered, and validated.",
    "- adjust_remaining_tasks: remaining tasks need focused updates or additions; the harness will call the planner.",
    "- replan: the remaining plan is materially stale or wrong; the harness will call the planner.",
    "- needs_human: a product/domain/safety decision is required before more autonomous work.",
    "",
    "Review questions:",
    "- Did the completed task change assumptions that the remaining tasks depend on?",
    "- Are remaining task scopes still tight and sufficient?",
    "- Is validation still proving the right behavior, or did the last task reveal a better proof?",
    "- Are any remaining tasks now redundant, missing, too broad, or in the wrong order?",
    "- Is this a major checkpoint where the plan should be re-sliced before continuing?",
    "",
    `Goal: ${state.goal ?? "(no goal recorded)"}`,
    "",
    "Completed task JSON:",
    completedTask ? JSON.stringify(completedTask, null, 2) : "(completed task not found in state)",
    "",
    "Remaining tasks:",
    remainingTasks.length ? remainingTasks.map((t) => `- [${t.status}] ${t.id}: ${t.title ?? ""}`).join("\n") : "(none — all done)",
    "",
    "Current assumptions:",
    (state.assumptions?.length ? state.assumptions.join("\n") : "(none)"),
    "",
    "Current decisions:",
    (state.decisions?.length ? state.decisions.join("\n") : "(none)"),
    "",
    "Cumulative diff stat since loop start:",
    diffStat || "(no diff)",
    "",
    "Recent harness history:",
    recentHistory,
  ].join("\n");

  writePromptWithEvent(promptFile, content, "post_task_review", repoRoot, runsRoot, stateFile, budget, {
    task: taskId,
    resultFile,
  });
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
  const recentHistory = getRecentHistoryText(repoRoot, runsRoot, 30, budget);
  const diffStat = git(["diff", "--stat", "HEAD"], repoRoot);
  const projectState = existsSync(join(repoRoot, "PROJECT.md")) ? "PROJECT.md exists" : "PROJECT.md missing";
  const contextState = existsSync(join(repoRoot, "CONTEXT.md"))
    ? "CONTEXT.md exists (planning-stage grill-with-docs ownership)"
    : "CONTEXT.md missing";

  const skillBlock = skillInstruction(
    "update-project-md",
    repoRoot,
    "Update PROJECT.md with durable technical facts: commands, architecture, module roles, validation, constraints. Keep edits concise and factual. Do not add transient run state."
  );

  const content = [
    "You are finalizing a completed agentic loop run.",
    "",
    "Goal: update PROJECT.md with durable technical facts discovered or changed during this run.",
    "",
    skillBlock,
    "",
    "Additional rules for this phase:",
    "- Do not edit CONTEXT.md here; it belongs to the planning grill-with-docs stage. Only touch it if execution discovered a durable domain/product fact that could not have been known during planning.",
    "- Do not edit AGENTS.md or CLAUDE.md unless the run explicitly changed agent policy.",
    "- If no durable facts changed, leave PROJECT.md unchanged and explain why in the summary.",
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
    "Uncommitted diff stat (what the run changed):",
    diffStat,
  ].join("\n");

  mkdirSync(dirname(promptFile), { recursive: true });
  writeFileSync(promptFile, content, "utf-8");
}

export interface FinalizeDocsVerifierPromptOptions {
  repoRoot: string;
  runWorktreePath: string;
  summaryFile: string;
  resultFile: string;
}

export function writeFinalizeDocsVerifierPrompt(promptFile: string, opts: FinalizeDocsVerifierPromptOptions): void {
  const { repoRoot, runWorktreePath, summaryFile, resultFile } = opts;

  // Run branch diff — shows what the tasks actually changed
  const diffStat = (() => { try { return git(["diff", "--stat", "HEAD"], runWorktreePath); } catch { return ""; } })();
  // PROJECT.md diff — shows what the finalizer just wrote in the main tree
  const diff     = (() => { try { return git(["diff", "HEAD", "--", "PROJECT.md"], repoRoot); } catch { return ""; } })();
  const projectMdContent = (() => {
    const p = join(repoRoot, "PROJECT.md");
    try { return existsSync(p) ? readFileSync(p, "utf-8").slice(0, 6000) : "(missing)"; } catch { return "(unreadable)"; }
  })();

  const content = [
    "You are verifying the finalize-docs phase of a completed agentic run.",
    "",
    "The executor was asked to update PROJECT.md with durable technical facts from the run.",
    "",
    `Write a JSON verdict to: ${resultFile}`,
    `Schema: { "verdict": "pass|fail|needs_human", "summary": "...", "issues": [] }`,
    "",
    "Pass if PROJECT.md was meaningfully updated to reflect the run's changes, OR if the run genuinely introduced no new durable facts worth recording.",
    "Fail if PROJECT.md was not touched when it clearly should have been, or if the changes are trivially cosmetic.",
    "needs_human if you cannot determine whether the update is correct.",
    "",
    "Git diff stat (all files this run changed):",
    diffStat || "(no changes)",
    "",
    "PROJECT.md diff:",
    diff || "(no changes to PROJECT.md)",
    "",
    "Current PROJECT.md (first 6000 chars):",
    projectMdContent,
    "",
    `Executor summary: ${summaryFile}`,
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
