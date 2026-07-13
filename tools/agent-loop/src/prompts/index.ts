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
function resolveSkillFile(skillName: string, repoRoot: string): { path: string; found: boolean } {
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
function skillInstruction(skillName: string, repoRoot: string, fallbackSummary: string): string {
  const { path, found } = resolveSkillFile(skillName, repoRoot);
  if (found) return `Read and follow the canonical skill at: ${path}`;
  return `Skill file for '${skillName}' was not found. Follow this summary instead:\n${fallbackSummary}`;
}

type PromptBudget = "low" | "medium" | "high";

interface BudgetLimits {
  checkBytes: number;
  diffBytes: number;
  eventLimit: number;
}

const BUDGET_LOW:    BudgetLimits = { checkBytes:  6_000, diffBytes:  12_000, eventLimit:  6 };
const BUDGET_MEDIUM: BudgetLimits = { checkBytes: 12_000, diffBytes:  20_000, eventLimit: 12 };
const BUDGET_HIGH:   BudgetLimits = { checkBytes: 50_000, diffBytes: 100_000, eventLimit: 20 };

function getPromptBudgetLimits(budget: PromptBudget): BudgetLimits {
  switch (budget) {
    case "low":  return BUDGET_LOW;
    case "high": return BUDGET_HIGH;
    default:     return BUDGET_MEDIUM;
  }
}

function limitTextForPrompt(text: string, maxBytes: number, tailLines = 80): string {
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

// Extract only markdown heading lines (# / ## / ###) from a file to give the model
// a compact outline of what a doc contains, without inlining the full body.
// The model can `read` the file itself if it needs the detail.
function outlineHeadings(filePath: string, maxBytes = 600): string {
  let text: string;
  try {
    text = readFileSync(filePath, "utf-8");
  } catch {
    return "(unreadable)";
  }
  const headings = text
    .split(/\r?\n/)
    .filter((l) => /^#{1,6}\s+\S/.test(l))
    .map((l) => l.trim());
  let out = headings.join(" | ");
  if (Buffer.byteLength(out, "utf-8") > maxBytes) {
    out = out.slice(0, maxBytes) + " …";
  }
  return out || "(no headings)";
}

function getRecentHistoryText(
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

// Item 1: project a Task to only the fields a given phase actually reads.
// Strips most harness bookkeeping (failureHistory, reviewBranch/Worktree,
// acceptedAt, lastRunDir, status, approvedStanceFile). Attempt count remains
// visible to executors so retry-aware work can make progress without another
// discovery session.
type TaskPhase = "executor" | "stance" | "verifier";
function projectTaskForPhase(task: Task, phase: TaskPhase): Record<string, unknown> {
  const base = {
    id: task.id,
    title: task.title,
    kind: task.kind,
    workflow: task.workflow,
    priority: task.priority,
    acceptanceCriteria: task.acceptanceCriteria,
    validation: task.validation,
    scope: task.scope,
    dependsOn: task.dependsOn,
    complexity: task.complexity,
    complexityReasons: task.complexityReasons,
    ...(phase === "executor" && typeof task.attempts === "number" ? { attempts: task.attempts } : {}),
  };
  return base;
}

// Item 2: project WorkflowPolicy to only what a phase needs, instead of
// stringifying the full policy object (which is invariant across tasks).
function projectPolicyForTask(policy: WorkflowPolicy, workflow: string | undefined): Record<string, unknown> {
  const selected = workflow && policy.workflows?.[workflow]
    ? { [workflow]: policy.workflows[workflow] }
    : {};
  return {
    defaultDiscoveryWorkflow: policy.defaultDiscoveryWorkflow,
    defaultExecutionWorkflow: policy.defaultExecutionWorkflow,
    selectedWorkflow: selected,
    humanGates: policy.humanGates ?? [],
  };
}

// Item 3: distill the event log to what an agent actually needs to avoid
// blind-retry loops — failures, verdicts, and assumption/decision changes —
// instead of a raw JSONL tail full of lifecycle noise. Falls back to the
// full recent tail only at budget "high".
const DISTILL_EVENT_TYPES = /failed|failure|needs_human|task_status|verifier|task_grill_finished|stance_reflection_finished|assumption|decision/;
function getDistilledHistoryText(
  repoRoot: string,
  runsRoot: string,
  phase: TaskPhase | "planner" | "review" | "default",
  budget: PromptBudget
): string {
  const events = loadEvents(repoRoot, runsRoot);
  if (events.length === 0) return "No prior event log entries.";
  if (budget === "high") {
    return getRecentEvents(events, 12).map((e) => JSON.stringify(e)).join("\n");
  }
  const distilled = events.filter((e) => DISTILL_EVENT_TYPES.test(e.type));
  const tail = distilled.slice(-8);
  if (tail.length === 0) {
    return "No failures, verdicts, or assumption changes in the event log yet.";
  }
  return tail.map(formatEventLine).join("\n");
}

function getOperatorContextBlock(state: AgenticState | undefined): string[] {
  const files = state?.contextFiles ?? [];
  if (files.length === 0) return [];
  return [
    "Operator-supplied context files:",
    ...files.map((file) => `- ${file}`),
    "Read these files before planning or editing. Treat them as guidance and acceptance context; if they conflict with current repo evidence, surface the conflict instead of silently choosing.",
    "",
  ];
}

// Write a prompt file, creating parent dirs, and append a prompt_written event.
function writePromptWithEvent(
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

interface RepoContextOptions {
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

  // Structural top-level summary instead of a raw 80-entry dump.
  // Group entries into directories vs files so the model sees the repo shape.
  const dirs: string[] = [];
  const files: string[] = [];
  try {
    for (const e of readdirSync(repoRoot).slice(0, 80)) {
      try {
        (statSync(join(repoRoot, e)).isDirectory() ? dirs : files).push(e);
      } catch { /* skip */ }
    }
  } catch { /* non-fatal */ }
  const topSummary = [
    `dirs: ${dirs.map((d) => `${d}/`).join(", ")}`,
    `files: ${files.join(", ")}`,
  ].join(" | ");

  // Reference canonical docs by path + heading outline; do NOT inline the body.
  // The model has read tools and pulls detail on demand, so we only tell it
  // what each doc covers and where it lives.
  const docRef = (name: string) => {
    const p = join(repoRoot, name);
    if (!existsSync(p)) return `- ${name}: not found`;
    return `- ${name}: present at ${p}. Sections: ${outlineHeadings(p)}`;
  };

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
    "Agent cookbooks (read if relevant):",
    `- ${existsSync(join(repoRoot, "AGENTS.md")) ? "AGENTS.md present" : "AGENTS.md not found"}`,
    `- ${existsSync(join(repoRoot, "CLAUDE.md")) ? "CLAUDE.md present" : "CLAUDE.md not found"}`,
    "",
    "Configured checks:",
    checks.length ? checks.join("\n") : "(none)",
    "",
    "Top-level structure:",
    topSummary,
    "",
    "Canonical docs (read the file itself for full detail; only the section outline is shown here):",
    docRef("PROJECT.md"),
    docRef("CONTEXT.md"),
    "",
    "CodeGraph context file:",
    codeGraphFile || "(none)",
  ].join("\n");

  mkdirSync(dirname(contextFile), { recursive: true });
  writeFileSync(contextFile, content, "utf-8");
}

interface PlannerPromptOptions {
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
  mode?: "full" | "lite";
  /** Path to failure-analysis.json from the task that triggered this replan, if any. */
  priorFailureAnalysisFile?: string;
}

export function writePlannerPrompt(promptFile: string, opts: PlannerPromptOptions): void {
  const {
    repoRoot, runsRoot, stateFile, budget, state, policy, resolvedPolicyFile,
    plannerResultFile, repoContextFile, grillTranscriptFile, codeGraphFile,
    priorFailureAnalysisFile = "",
  } = opts;
  const mode = opts.mode ?? "full";
  const lite = mode === "lite";

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
    ...(lite ? [
      "PLANNER-LITE MODE: This is a conservative low-risk planning pass.",
      "Inspect only the goal, the directly named files, and the smallest relevant repository guidance.",
      "Do not run a full grill-with-docs interview, CodeGraph exploration, ADR review, or broad repository search.",
      "If the goal is ambiguous, risky, cross-module, or cannot be given a focused validation command, write needs_human rather than guessing.",
    ] : [
      "DISCOVERY PHASE — before planning, conduct a full grill-with-docs self-interview:",
      grillSkill,
    ]),
    "",
    `The harness provided a context packet at: ${repoContextFile}`,
    ...(lite ? [] : [
      `The harness also generated optional CodeGraph context at: ${codeGraphFile}`,
      "Use CodeGraph context for orientation before broad manual search, then verify conclusions against source files. If the artifact says CodeGraph is unavailable, run `codegraph init -i` in the working directory to initialize it before proceeding.",
    ]),
    "Inspect deeper in the repository when needed.",
    "",
    "When planning validation, match proof to workflow. Discovery/investigation/zoom-out tasks may be proven by artifacts and evidence notes; do not attach implementation test commands to artifact-only discovery tasks. Implementation/architecture tasks need focused task.validation commands when behavior or code changes should be proven. If a task adds or changes a small smoke test/check that directly proves the change, include that command in task.validation so the harness runs it before verification. Prefer `pwsh -File path/to/smoke.ps1`; mention `powershell.exe` only as legacy fallback.",
    "",
    `Do not edit ${stateFile} directly. Write planner JSON only to: ${plannerResultFile}`,
    `Also write an autonomous grill transcript markdown file to: ${grillTranscriptFile}`,
    "",
    ...(lite ? [
      "Write a concise planner-lite transcript with the goal, directly inspected evidence, task choice, scope, validation, and fallback reason if any.",
    ] : [
      "The grill transcript must make your discovery visible for human review. Use this structure:",
    ]),
    "# Autonomous Grill Transcript",
    "## Goal Restatement",
    "## Questions, Evidence, Answers, Proposals",
    ...(lite ? [] : [
      "For each grill question include: question, repo/docs evidence inspected, autonomous answer, proposal/decision, and whether human input is needed.",
      "## Final Plan Rationale",
      "Explain why the task split, dependencies, validation commands, assumptions, and open questions are appropriate.",
    ]),
    "",
    "Allowed verdicts: planned, needs_human, blocked.",
    "Allowed task statuses in planner output: pending, needs_human, blocked.",
    "Allowed task kinds: discovery, investigation, implementation, architecture, maintenance, handoff.",
    "Each task must have: id, title, kind, workflow, status, priority, acceptanceCriteria, validation, dependsOn, failureHistory, artifacts, scope, complexity, complexityReasons.",
    "Use one workflow per task. Use dependencies for workflow sequences. Use only canonical workflows from the policy.",
    "Plan around verification seams, not file boundaries. Every task incurs execution and deterministic-check cost, and may incur stance or independent-verifier cost, so each task must buy meaningful independent proof.",
    "Split a task only when at least one is true: it has a different risk profile, a different acceptance proof, different scope/ownership, independent rollback value, or creates a dependency required by later work.",
    "Do not create one task per helper, file move, module extraction, or similarly mechanical edit when those edits share one risk profile and one validation command. Group them into the smallest coherent verification slice.",
    "Keep tasks independently verifiable, but reject orchestration-heavy plans where repeated validation is identical and task boundaries add no new proof.",
    "Always set `scope` to the forward-slash glob list of files the task may change. Keep scope tight (5 globs or fewer), but include every file implied by acceptance criteria, including new focused test files when direct helper-level proof requires them.",
    "Set complexity to low, medium, or high and give concrete complexityReasons. Architecture, broad cross-module, assumption-heavy, or costly-to-reverse work should be high. Split high-complexity work only at genuine verification seams; do not multiply model calls merely to reduce changed-file count.",
    "Task-size budget (enforced by the harness): at most 7 acceptanceCriteria, at most 5 scope globs, implementation/architecture tasks must have at least one acceptanceCriterion.",
    "",
    ...(lite ? [
      "Do not invent design decisions in planner-lite mode. Use an empty decisions array unless the goal is no longer low-risk; then escalate with needs_human.",
    ] : [
      "For every genuine design/product/architecture decision the plan forces, run a grill-with-docs self-interview: weigh 2-4 real options with concrete repo/docs evidence, mark one recommended, answer it yourself. Set escalate:true only when evidence genuinely cannot settle it.",
    ]),
    "",
    "Planner result schema (write valid JSON only):",
    `{"verdict":"planned|needs_human|blocked","summary":"...","decisions":[{"question":"...","whyItMatters":"...","optionsConsidered":[{"label":"...","evidence":"repo path / command / doc inspected","recommended":true}],"chosen":"...","selfAnswer":"...","confidence":"high|medium|low","escalate":false}],"assumptions":[],"openQuestions":[],"blockers":[],"tasks":[],"artifacts":["${grillTranscriptFile}"]}`,
    `Each task object: {"id":"...","title":"...","kind":"discovery|investigation|implementation|architecture|maintenance|handoff","workflow":"...","status":"pending","priority":1,"acceptanceCriteria":[],"validation":[],"dependsOn":[],"failureHistory":[],"artifacts":[],"scope":["path/**"],"complexity":"low|medium|high","complexityReasons":[]}`,
    priorFailureBlock,
    "",
    `Goal: ${state.goal ?? ""}`,
    "",
    ...getOperatorContextBlock(state),
    "Workflow policy (canonical workflow names, phases, and skills; read the policy file for full detail):",
    resolvedPolicyFile && existsSync(resolvedPolicyFile) ? `${resolvedPolicyFile}` : "(policy file not resolved)",
    JSON.stringify(
      {
        defaultDiscoveryWorkflow: policy.defaultDiscoveryWorkflow,
        defaultExecutionWorkflow: policy.defaultExecutionWorkflow,
        workflows: Object.fromEntries(
          Object.entries(policy.workflows ?? {}).map(([k, v]) => {
            const w = v as unknown as Record<string, unknown>;
            return [k, { phase: w.phase, skill: w.skillName, default: w.default === true }];
          })
        ),
        humanGates: policy.humanGates ?? [],
      },
      null,
      0
    ),
  ].join("\n");

  writePromptWithEvent(promptFile, content, "planner", repoRoot, runsRoot, stateFile, budget, {
    resultFile: plannerResultFile,
    codegraph: codeGraphFile,
    priorFailureAnalysis: priorFailureAnalysisFile || undefined,
  });
}

function getWorkflowBlock(workflow: string, policy: WorkflowPolicy, repoRoot?: string): string {
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

interface ExecutorPromptOptions {
  repoRoot: string;
  worktreePath: string;
  compact?: boolean;
  runsRoot: string;
  stateFile: string;
  budget: PromptBudget;
  state?: AgenticState;
  task: Task;
  iteration: number;
  runDir: string;
  eventLogPath: string;
  codeGraphFile?: string;
  policy: WorkflowPolicy;
  approvedStance?: unknown;
}

export function writeExecutorPrompt(promptFile: string, opts: ExecutorPromptOptions): void {
  const {
    repoRoot, worktreePath, compact = false, runsRoot, stateFile, budget, state, task, iteration, runDir,
    eventLogPath: evLogPath, codeGraphFile = "", policy, approvedStance,
  } = opts;

  const limits = getPromptBudgetLimits(budget);
  const workflow = task.workflow ?? "tdd";
  const kind = task.kind ?? "implementation";
  const taskJson = JSON.stringify(projectTaskForPhase(task, "executor"), null, 2);
  const recentHistory = compact
    ? "Compact low-risk task: no failure or drift history was admitted."
    : getDistilledHistoryText(repoRoot, runsRoot, "executor", budget);

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
    `- Your active repository worktree is ${worktreePath} (your process working directory).`,
    "- For repository files, use paths relative to the active worktree and never edit the parent repo via an absolute path.",
    "- Absolute paths under the parent repo may be used only for harness artifacts explicitly named below, such as the run directory.",
    ...(compact ? [
      "- Compact low-risk task: make the smallest scoped edit and do not spend time writing a handover; the harness will generate one from the diff and checks.",
    ] : []),
    `- Keep task artifacts under this run directory when useful: ${runDir}`,
    ...(!compact ? [`- Before finishing, write a concise handover note to \`${runDir}/handover.md\` with: what changed, key files, validation run, gotchas, and next-task notes.`] : []),
    "- For discovery/investigation tasks, useful artifact files may be the main output; code changes are not required unless the task asks for them.",
    "- For implementation/architecture/maintenance tasks, prefer tracked repo changes plus validation unless the task is explicitly artifact-only.",
    "- When you add a focused smoke test/check that proves this task, use or propose it as a task.validation command (for example `pwsh -File tests/path/focused-smoke.ps1`) so the harness runs it before verification.",
    "- Use `pwsh -File` in harness and smoke-test command examples. Mention `powershell.exe` only as a legacy Windows PowerShell compatibility fallback when explicitly needed.",
    "- If the task JSON has a non-empty `scope`, change only files matching those globs. The harness enforces this as a hard pre-verifier rail: files changed outside scope fail the task. If you must touch a file outside scope, stop and record it in the handover instead of editing it.",
    "",
    ...(approvedStance ? [
      "Approved implementation stance — treat this as the current technical approach:",
      JSON.stringify(approvedStance, null, 2),
      "If repository evidence invalidates it, stop and record the conflict; do not silently choose a different architecture.",
      "",
    ] : []),
    `Iteration: ${iteration}`,
    `State file: ${stateFile}`,
    `Selected workflow: ${workflow}`,
    `Task kind: ${kind}`,
    `Run directory: ${runDir}`,
    `Execution worktree: ${worktreePath}`,
    `CodeGraph context: ${codeGraphFile}`,
    "",
    ...(compact ? [] : getOperatorContextBlock(state)),
    "Use CodeGraph context for orientation before broad manual search, especially for dependency/call relationship questions. Verify conclusions by reading source files. If CodeGraph is unavailable, run `codegraph init -i` in the working directory to initialize it before proceeding.",
    "",
    `Recent harness history (verdicts, failures, assumption changes; source of truth is ${evLogPath}):`,
    recentHistory,
    "",
    getWorkflowBlock(workflow, policy, repoRoot),
    "",
    "Task JSON:",
    taskJson,
  ].join("\n");

  writePromptWithEvent(promptFile, content, "executor", repoRoot, runsRoot, stateFile, budget, {
    task: task.id,
    codegraph: codeGraphFile,
  });
}

interface StanceReflectionPromptOptions {
  repoRoot: string;
  task: Task;
  resultFile: string;
  codeGraphFile?: string;
}

export function writeStanceReflectionPrompt(promptFile: string, opts: StanceReflectionPromptOptions): void {
  const skill = skillInstruction("reflect-on-approach", opts.repoRoot,
    "Use stance mode. Challenge the implementation route from a fresh perspective. Do not edit repository files."
  );
  const content = [
    "You are a fresh technical stance reviewer before implementation begins.",
    skill,
    "",
    "Run this self-challenge cycle on your own reasoning, in this one sitting, before writing anything to disk:",
    "  1. Reassess: form an initial implementation stance and actively challenge it from a fresh perspective.",
    "  2. Readjust: revise the stance to address whatever the challenge surfaced.",
    "  3. Reconfirm: challenge the readjusted stance once more; let it stand only if it survives, or escalate to needs_human if it cannot.",
    "Do not stop after the first pass. Walk through all three passes internally, then write only the final outcome.",
    `CodeGraph context: ${opts.codeGraphFile ?? ""}`,
    "Read repository guidance, relevant source, tests, and decisions. Do not edit files.",
    `Write stance reflection JSON only to: ${opts.resultFile}`,
    'Schema: { "mode":"stance", "verdict":"reconfirm|readjust|reassess|needs_human", "summary":"...", "evidence":[], "assumptions_challenged":[], "perspectives_considered":[], "recommended_changes":[], "unresolved_risks":[], "next_action":"...", "selfChallengeRounds":[{"pass":"reassess|readjust|reconfirm","note":"..."}], "stance": { "owningModule":"...", "boundaries":[], "sequence":[], "expectedEdits":[], "validation":[], "assumptions":[], "rejectedAlternatives":[] } }',
    "A bare approval is invalid. The summary must explain what was challenged across all three passes and why the final stance survived, or how it changed.",
    "Task:", JSON.stringify(projectTaskForPhase(opts.task, "stance"), null, 2),
  ].join("\n");
  mkdirSync(dirname(promptFile), { recursive: true });
  writeFileSync(promptFile, content, "utf-8");
}

interface VerifierPromptOptions {
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
  suppressEvent?: boolean;
}

export function writeVerifierPrompt(promptFile: string, opts: VerifierPromptOptions): void {
  const {
    repoRoot, runsRoot, stateFile, budget, task, worktreePath,
    checkOutput, resultFile, eventLogPath: evLogPath, policy, adversarial = false,
  } = opts;

  const limits = getPromptBudgetLimits(budget);
  const taskJson = JSON.stringify(projectTaskForPhase(task, "verifier"), null, 2);
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
  const recentHistory = getDistilledHistoryText(repoRoot, runsRoot, "verifier", budget);

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
    `Recent harness history (verdicts, failures, assumption changes; source of truth is ${evLogPath}):`,
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

  if (opts.suppressEvent) {
    mkdirSync(dirname(promptFile), { recursive: true });
    writeFileSync(promptFile, content, "utf-8");
  } else writePromptWithEvent(promptFile, content, "verifier", repoRoot, runsRoot, stateFile, budget, {
    task: task.id,
    diffBytes: rawDiffBytes,
    diffInlined,
    checkBytes: Buffer.byteLength(checkOutput, "utf-8"),
  });
}

interface FailureAnalysis {
  taskId: string;
  phase: string;
  attempt: number;
  failedAt: string;
  reason: string;
  diffStat: string;
}

interface WriteFailureAnalysisOptions {
  taskId: string;
  phase: string;
  attempt: number;
  rawOutput: string;
  worktreePath: string;
  outputFile: string;
}

// Write a structured failure-analysis.json to the run dir at every failure point.
// Harness-written (no agent call): captures phase, truncated output, diff stat, attempt.
// Consumed by planner prompts to break blind-retry loops.
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

interface DecisionOption {
  label: string;
  evidence: string;
  recommended: boolean;
}

interface DecisionRecord {
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

    // Accept optionsConsidered (canonical) and options (common alias) so a field-name
    // mismatch doesn't trigger a wasteful re-grill pass.
    const opts = Array.isArray(d.optionsConsidered) ? d.optionsConsidered
      : Array.isArray((d as Record<string, unknown>).options) ? (d as Record<string, unknown>).options as DecisionOption[]
      : [];
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

interface FinalizeDocsPromptOptions {
  repoRoot: string;
  worktreePath: string;
  runsRoot: string;
  stateFile: string;
  budget: PromptBudget;
  state: AgenticState;
  summaryFile: string;
}

export function writeFinalizeDocsPrompt(promptFile: string, opts: FinalizeDocsPromptOptions): void {
  const { repoRoot, worktreePath, runsRoot, stateFile, budget, state, summaryFile } = opts;

  const stateJson = JSON.stringify(state, null, 2);
  const recentHistory = getRecentHistoryText(repoRoot, runsRoot, 30, budget);
  const diffStat = git(["diff", "--stat", "HEAD"], worktreePath);
  const projectState = existsSync(join(worktreePath, "PROJECT.md")) ? "PROJECT.md exists" : "PROJECT.md missing";
  const contextState = existsSync(join(worktreePath, "CONTEXT.md"))
    ? "CONTEXT.md exists (planning-stage grill-with-docs ownership)"
    : "CONTEXT.md missing";

  const skillBlock = skillInstruction(
    "update-project-md",
    worktreePath,
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
    const complexity = task["complexity"] as string | undefined;
    if (complexity != null && !["low", "medium", "high"].includes(complexity)) {
      errors.push(`${id} has invalid complexity: ${complexity}`);
    }
    if (complexity === "high") {
      const reasons = (task["complexityReasons"] as unknown[] | undefined) ?? [];
      if (reasons.length === 0) errors.push(`${id} is high complexity without complexityReasons`);
    }

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
