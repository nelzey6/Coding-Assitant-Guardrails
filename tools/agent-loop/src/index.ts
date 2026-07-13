#!/usr/bin/env node
import { program } from "commander";
import { writeFileSync, existsSync, copyFileSync, mkdirSync } from "fs";
import { execFileSync } from "child_process";
import { join, resolve, dirname, relative } from "path";
import { loadContext } from "./context/index.js";
import { runValidation } from "./validators/index.js";
import {
  printValidateResult,
  printStatusResult,
  printSummaryResult,
  printLastFailureResult,
  printWhyStuckResult,
} from "./reporting/index.js";
import { loadState } from "./state/index.js";
import { runAgenticLoop, LoopError, type LoopConfig } from "./loop/index.js";
import type { AgentConfig } from "./agent/index.js";

function collect(val: string, acc: string[]): string[] { return [...acc, val]; }

function uniq(values: string[]): string[] {
  return [...new Set(values)];
}

function toRepoRelative(repoRoot: string, filePath: string): string {
  const abs = resolve(repoRoot, filePath);
  const rel = relative(repoRoot, abs).replace(/\\/g, "/");
  return rel && !rel.startsWith("..") ? rel : abs;
}

function expandSpecContext(repoRoot: string, specDir: string): string[] {
  const dir = resolve(repoRoot, specDir);
  const candidates = ["spec.md", "plan.md", "tasks.md"].map((name) => join(dir, name));
  return candidates.filter(existsSync).map((path) => toRepoRelative(repoRoot, path));
}

const DEFAULT_RUNS_ROOT = ".agent-runs";
const DEFAULT_WORKTREE_ROOT = ".worktrees";
const DEFAULT_STATE_FILE = "agentic.json";
import { loadEvents } from "./events/index.js";

function detectRepoRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 10; i++) {
    if (existsSync(join(dir, "AGENTS.md")) || existsSync(join(dir, ".git"))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

function failOnInterruptedRun(repoRoot: string, stateFile: string, runsRoot: string): void {
  const state = loadState(repoRoot, stateFile);
  const runningTask = state?.tasks?.find((task) => task.status === "running");
  if (!runningTask) return;

  const events = loadEvents(repoRoot, runsRoot);
  const lastTaskEvent = [...events].reverse().find((event) => event.task === runningTask.id);
  const lastEvent = lastTaskEvent ?? events.at(-1);
  const lastType = lastEvent?.type ?? "unknown";
  const runDir = (lastEvent as { runDir?: string } | undefined)?.runDir ?? runningTask.lastRunDir ?? "unknown";

  console.error(`Found interrupted agentic run: task '${runningTask.id}' is still marked running.`);
  console.error(`Last event: ${lastType}`);
  console.error(`Run directory: ${runDir}`);
  console.error("");
  console.error("Refusing to overwrite interrupted state.");
  console.error(`Inspect the run artifacts, then intentionally reset the task in '${stateFile}' before starting again.`);
  process.exit(2);
}

program
  .name("agent")
  .description("TypeScript CLI for validation and adaptive autonomous agent loops")
  .version("0.1.0");

// ── validate ──────────────────────────────────────────────────────────────────

program
  .command("validate")
  .description(
    "Check README/plugin/skill consistency across all buckets. Exits non-zero on any error."
  )
  .option("--repo <path>", "Path to repo root (default: auto-detected from cwd)")
  .option("--allow-empty", "Treat a repo with zero discovered skills as success")
  .option("--json", "Output results as JSON")
  .action((opts) => {
    const repoRoot = opts.repo ? resolve(opts.repo) : detectRepoRoot();
    const ctx = loadContext(repoRoot);
    const result = runValidation(ctx);
    printValidateResult(result, { json: !!opts.json });
    if (result.checkedSkills === 0 && !opts.allowEmpty) {
      if (!opts.json) {
        console.error("No skills were discovered. Run from the skills repository root, pass --repo, or use --allow-empty intentionally.");
      }
      process.exit(1);
    }
    if (!result.passed) process.exit(1);
  });

// ── init ──────────────────────────────────────────────────────────────────────

program
  .command("init <goal>")
  .description(
    "Start a new goal: archives the existing agentic.json (if any) to .agent-runs/archive-<timestamp>.json, then writes a fresh minimal state for the given goal."
  )
  .option("--repo <path>", "Path to repo root (default: auto-detected from cwd)")
  .option("--runs-root <path>", "Event log / run artifact root (default: .agent-runs)")
  .option("--context <file>", "Optional context file to include in the goal state; repeatable", collect, [] as string[])
  .option("--spec <dir>", "Optional Spec Kit feature directory; expands existing spec.md, plan.md, and tasks.md into context files")
  .option("--json", "Output result as JSON")
  .action((goal: string, opts) => {
    const repoRoot  = opts.repo     ? resolve(opts.repo)     : detectRepoRoot();
    const runsRoot  = join(repoRoot, opts.runsRoot ?? DEFAULT_RUNS_ROOT);
    const stateFile = join(repoRoot, DEFAULT_STATE_FILE);
    const contextFiles = uniq([
      ...((opts.context as string[] | undefined) ?? []).map((path) => toRepoRelative(repoRoot, path)),
      ...(opts.spec ? expandSpecContext(repoRoot, opts.spec) : []),
    ]);

    let archived   = false;
    let archivePath = "";

    if (existsSync(stateFile)) {
      mkdirSync(runsRoot, { recursive: true });
      const ts = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
      archivePath = join(runsRoot, `archive-${ts}.json`);
      copyFileSync(stateFile, archivePath);
      archived = true;
    }

    const freshState = {
      version: 1,
      goal,
      maxIterations: 10,
      checks: [] as string[],
      defaultDiscoveryWorkflow: "grill-with-docs",
      tasks: [] as unknown[],
      decisions: [] as string[],
      assumptions: [] as string[],
      openQuestions: [] as string[],
      blockers: [] as string[],
      contextFiles,
      promptPolicy: { lessons: [] as string[] },
    };
    writeFileSync(stateFile, JSON.stringify(freshState, null, 2), "utf-8");

    if (opts.json) {
      console.log(JSON.stringify({ archived, archivePath: archived ? archivePath : null, stateFile, contextFiles }));
    } else {
      if (archived) console.log(`Archived previous goal to: ${archivePath}`);
      console.log(`Initialised new goal in: ${stateFile}`);
      console.log(`Goal: ${goal}`);
      if (contextFiles.length) console.log(`Context files: ${contextFiles.join(", ")}`);
    }
  });

// ── status ────────────────────────────────────────────────────────────────────

program
  .command("status")
  .description("Print current agentic.json state: tasks, next runnable, recent events.")
  .option("--repo <path>", "Path to repo root")
  .option("--runs-root <path>", "Path to runs/event log root (default: .agent-runs)")
  .option("--json", "Output as JSON")
  .action((opts) => {
    const repoRoot = opts.repo ? resolve(opts.repo) : detectRepoRoot();
    const runsRoot = opts.runsRoot ?? DEFAULT_RUNS_ROOT;
    const state = loadState(repoRoot);
    if (!state) { console.error("No agentic.json found."); process.exit(1); }
    const events = loadEvents(repoRoot, runsRoot);
    printStatusResult({ state, events, worktreeRoot: ".worktrees", runsRoot }, { json: !!opts.json });
  });

// ── summary ───────────────────────────────────────────────────────────────────

program
  .command("summary")
  .description("Print a compact checkpoint summary: task counts by status, next task, recent events.")
  .option("--repo <path>", "Path to repo root")
  .option("--runs-root <path>", "Path to runs/event log root (default: .agent-runs)")
  .option("--json", "Output as JSON")
  .action((opts) => {
    const repoRoot = opts.repo ? resolve(opts.repo) : detectRepoRoot();
    const runsRoot = opts.runsRoot ?? DEFAULT_RUNS_ROOT;
    const state = loadState(repoRoot);
    if (!state) { console.error("No agentic.json found."); process.exit(1); }
    const events = loadEvents(repoRoot, runsRoot);
    printSummaryResult({ state, events, worktreeRoot: ".worktrees", runsRoot }, { json: !!opts.json });
  });

// ── last-failure ──────────────────────────────────────────────────────────────

program
  .command("last-failure")
  .description("Print the most recent failure event or task failureHistory entry.")
  .option("--repo <path>", "Path to repo root")
  .option("--runs-root <path>", "Path to runs/event log root (default: .agent-runs)")
  .option("--json", "Output as JSON")
  .action((opts) => {
    const repoRoot = opts.repo ? resolve(opts.repo) : detectRepoRoot();
    const runsRoot = opts.runsRoot ?? DEFAULT_RUNS_ROOT;
    const state = loadState(repoRoot);
    if (!state) { console.error("No agentic.json found."); process.exit(1); }
    const events = loadEvents(repoRoot, runsRoot);
    printLastFailureResult(state, events, { json: !!opts.json });
  });

// ── why-stuck ─────────────────────────────────────────────────────────────────

program
  .command("why-stuck")
  .description("Explain blocked/needs_human/retryable tasks with suggested next commands.")
  .option("--repo <path>", "Path to repo root")
  .option("--runs-root <path>", "Path to runs/event log root (default: .agent-runs)")
  .option("--json", "Output as JSON")
  .action((opts) => {
    const repoRoot = opts.repo ? resolve(opts.repo) : detectRepoRoot();
    const runsRoot = opts.runsRoot ?? DEFAULT_RUNS_ROOT;
    const state = loadState(repoRoot);
    if (!state) { console.error("No agentic.json found."); process.exit(1); }
    const events = loadEvents(repoRoot, runsRoot);
    printWhyStuckResult(state, events, { json: !!opts.json });
  });

// ── run ───────────────────────────────────────────────────────────────────────

program
  .command("run")
  .description(
    "Run the autonomous agentic loop: plan (if needed) then execute tasks until done or budget exhausted."
  )
  .option("--repo <path>",                   "Path to repo root (default: auto-detected from cwd)")
  .option("--command <template>",            "Agent command for planning, execution, stance, and verification; {prompt} receives the prompt path")
  .option("--agent-timeout <seconds>",       "Seconds before an agent invocation is killed (0 = none)", "0")
  .option("--check-timeout <seconds>",       "Seconds before a check command is killed (0 = none)", "0")
  .option("--max-runtime-seconds <n>",       "Hard runtime budget in seconds (0 = none)", "0")
  .option("--checks <cmd>",                  "Extra check command (repeatable)", collect, [])
  .option("--worktree-bootstrap <cmd>",      "Bootstrap command run inside the isolated run worktree before agents/checks (repeatable)", collect, [])
  .option("--worktree-bootstrap-ignore <path>", "Worktree-relative bootstrap artifact ignored by scope/diff/commit (repeatable)", collect, [])
  .option("--check-env-file <path>",         "Env file loaded for validation checks, relative to worktree or absolute")
  .option("--no-apply",                      "Do not apply run worktree changes to main tree at end (default: apply)")
  .option("--allow-dirty",                   "Proceed even if policy requires a clean main worktree")
  .option("--no-finalize-docs",              "Skip the finalize-docs agent after all tasks pass")
  .action(async (opts) => {
    const repoRoot = opts.repo ? resolve(opts.repo) : detectRepoRoot();
    failOnInterruptedRun(repoRoot, DEFAULT_STATE_FILE, DEFAULT_RUNS_ROOT);

    const timeout = parseInt(opts.agentTimeout ?? "0", 10);
    const detectTool = (template: string): AgentConfig["tool"] => {
      const t = template.trim();
      if (/(?:^|\s|[/\\])pi(?:\s|$)/.test(t)) return "pi";
      if (/(?:^|\s|[/\\])claude(?:\s|$)/.test(t)) return "claude";
      return "custom";
    };
    const detectDefaultTool = (): "pi" | "claude" | null => {
      for (const bin of ["pi", "claude"] as const) {
        try {
          execFileSync(bin, ["--version"], { stdio: "ignore", shell: true });
          return bin;
        } catch { /* try next */ }
      }
      return null;
    };
    const defaultTool = detectDefaultTool();
    if (!defaultTool && !opts.command) {
      throw new LoopError("No executor found. Install 'pi' or 'claude', or pass --command.");
    }
    // When no --command is supplied, use the native adapter for the detected
    // tool (pi runs in JSON mode: pi -p "@<path>" --mode json, giving the
    // harness token usage, cache totals, cost, structured lifecycle events,
    // reliable completion detection, and machine-readable errors).
    const makeAgent = (template?: string): AgentConfig =>
      template && template.trim().length > 0
        ? { tool: detectTool(template), commandTemplate: template, timeoutSeconds: timeout }
        : { tool: defaultTool ?? "pi", timeoutSeconds: timeout };

    const agentConfig: AgentConfig = makeAgent(opts.command);

    const loopConfig: LoopConfig = {
      repoRoot,
      stateFile:           DEFAULT_STATE_FILE,
      runsRoot:            DEFAULT_RUNS_ROOT,
      worktreeRoot:        DEFAULT_WORKTREE_ROOT,
      agent:               agentConfig,
      maxRuntimeSeconds:   parseInt(opts.maxRuntimeSeconds ?? "0", 10),
      checkTimeoutSeconds: parseInt(opts.checkTimeout     ?? "0",  10),
      extraChecks:         (opts.checks as string[]) ?? [],
      worktreeBootstrap:   (opts.worktreeBootstrap as string[]) ?? [],
      worktreeBootstrapIgnore: (opts.worktreeBootstrapIgnore as string[]) ?? [],
      checkEnvFile:        opts.checkEnvFile ?? "",
      apply:                       opts.apply !== false,
      allowDirty:                  !!opts.allowDirty,
      finalizeDocs:                opts.finalizeDocs !== false,
    };

    await runAgenticLoop(loopConfig).catch((err) => {
      if (err instanceof LoopError) {
        console.error(err.message);
        process.exit(err.exitCode);
      }
      throw err;
    });
  });

program.parseAsync(process.argv).catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
