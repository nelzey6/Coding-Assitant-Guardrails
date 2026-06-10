import type { ValidationResult, Violation } from "../validators/index.js";
import type { PlanResult } from "../planner/index.js";
import type { AgenticState, Task } from "../state/index.js";
import {
  getTasks,
  getNextTask,
  hasUnfinishedTasks,
  groupByStatus,
  getBlockedDependencySummary,
  getTaskAttempts,
  dependenciesPassed,
} from "../state/index.js";
import type { AgenticEvent } from "../events/index.js";
import { getFailureEvents, getRecentEvents, formatEventLine } from "../events/index.js";

export interface ReportOptions {
  json: boolean;
}

// ── Validate reporting ────────────────────────────────────────────────────────

function groupBy<T>(items: T[], key: (item: T) => string): Record<string, T[]> {
  const result: Record<string, T[]> = {};
  for (const item of items) {
    const k = key(item);
    if (!result[k]) result[k] = [];
    result[k].push(item);
  }
  return result;
}

export function printValidateResult(result: ValidationResult, opts: ReportOptions): void {
  if (opts.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    return;
  }

  const errors = result.violations.filter((v) => v.severity === "error");
  const warnings = result.violations.filter((v) => v.severity === "warning");

  console.log(`\nValidated ${result.checkedSkills} skills across all buckets.\n`);

  if (result.passed) {
    console.log("✓ All invariants pass — no violations found.");
  } else {
    console.log(`✗ ${errors.length} error(s), ${warnings.length} warning(s) found.\n`);
  }

  if (errors.length > 0) {
    console.log("ERRORS");
    console.log("──────");
    const bySurface = groupBy(errors, (v) => v.surface);
    for (const [surface, vs] of Object.entries(bySurface)) {
      console.log(`\n  [${surface}]`);
      for (const v of vs) {
        console.log(`  • ${v.message}`);
        console.log(`    Fix: ${v.expectedFix}`);
      }
    }
    console.log("");
  }

  if (warnings.length > 0) {
    console.log("WARNINGS");
    console.log("────────");
    for (const v of warnings) {
      console.log(`  • ${v.message}`);
      console.log(`    Fix: ${v.expectedFix}`);
    }
    console.log("");
  }
}

// ── Plan reporting ────────────────────────────────────────────────────────────

export interface PlanFileResult {
  outputPath: string;
  taskCount: number;
  warnings: string[];
}

export function printPlanResult(result: PlanFileResult, opts: ReportOptions): void {
  if (opts.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    return;
  }

  console.log(`\nPlan written to: ${result.outputPath}`);
  console.log(`Tasks scaffolded: ${result.taskCount}`);
  if (result.warnings.length > 0) {
    console.log("\nWarnings:");
    result.warnings.forEach((w) => console.log(`  • ${w}`));
  }
  console.log(
    "\nReview plan.md, adjust workflows and acceptance criteria, then promote tasks to agentic.json."
  );
}

// ── Status reporting ──────────────────────────────────────────────────────────

export interface StatusData {
  state: AgenticState;
  events: AgenticEvent[];
  worktreeRoot: string;
  runsRoot: string;
}

export function printStatusResult(data: StatusData, opts: ReportOptions): void {
  const { state, events } = data;

  if (opts.json) {
    const next = getNextTask(state);
    process.stdout.write(
      JSON.stringify(
        {
          goal: state.goal,
          phase: state.phase,
          tasks: getTasks(state).map((t) => ({
            id: t.id,
            status: t.status,
            workflow: t.workflow,
            title: t.title,
            dependsOn: t.dependsOn ?? [],
          })),
          nextTask: next ? { id: next.id, title: next.title } : null,
          recentEvents: getRecentEvents(events, 8).map(formatEventLine),
        },
        null,
        2
      ) + "\n"
    );
    return;
  }

  console.log(`Goal:  ${state.goal ?? "(none)"}`);
  console.log(`Phase: ${state.phase ?? "(none)"}`);
  console.log("");
  console.log("Tasks:");

  const tasks = getTasks(state).sort((a, b) => {
    const pa = a.priority ?? 999;
    const pb = b.priority ?? 999;
    if (pa !== pb) return pa - pb;
    return (a.id ?? "").localeCompare(b.id ?? "");
  });

  for (const task of tasks) {
    const deps = (task.dependsOn ?? []).length > 0 ? ` deps=[${task.dependsOn!.join(",")}]` : "";
    const review = task.reviewBranch ? ` review=[${task.reviewBranch}]` : "";
    console.log(
      `  ${pad(task.status ?? "?", 13)} ${pad(task.id ?? "", 40)} ${task.workflow ?? ""} ${task.title ?? ""}${deps}${review}`
    );
  }

  console.log("");
  const next = getNextTask(state);
  if (next) {
    console.log(`Next runnable: ${next.id} — ${next.title}`);
  } else if (hasUnfinishedTasks(state)) {
    console.log("No runnable task. Blocked dependencies:");
    console.log(getBlockedDependencySummary(state));
  } else {
    console.log("All tasks complete.");
  }

  const recent = getRecentEvents(events, 8);
  if (recent.length > 0) {
    console.log("\nRecent events:");
    recent.forEach((e) => console.log(formatEventLine(e)));
  }
}

// ── Summary reporting ─────────────────────────────────────────────────────────

export function printSummaryResult(data: StatusData, opts: ReportOptions): void {
  const { state, events } = data;
  const byStatus = groupByStatus(state);

  if (opts.json) {
    const counts: Record<string, number> = {};
    for (const [s, tasks] of Object.entries(byStatus)) counts[s] = tasks.length;
    const next = getNextTask(state);
    process.stdout.write(
      JSON.stringify(
        {
          goal: state.goal,
          phase: state.phase,
          counts,
          nextTask: next ? { id: next.id, title: next.title } : null,
          recentEvents: getRecentEvents(events, 12).map(formatEventLine),
        },
        null,
        2
      ) + "\n"
    );
    return;
  }

  console.log("# Agentic checkpoint summary");
  console.log(`Goal:  ${state.goal ?? "(none)"}`);
  console.log(`Phase: ${state.phase ?? "(none)"}`);
  console.log("");

  for (const s of ["passed", "running", "pending", "needs_retry", "needs_human", "blocked", "failed"]) {
    const count = (byStatus[s] ?? []).length;
    if (count > 0) console.log(`  ${s}: ${count}`);
  }

  const next = getNextTask(state);
  if (next) console.log(`\nNext: ${next.id} — ${next.title}`);

  const recent = getRecentEvents(events, 12);
  if (recent.length > 0) {
    console.log("\nRecent events:");
    recent.forEach((e) => console.log(formatEventLine(e)));
  }
}

// ── Last-failure reporting ────────────────────────────────────────────────────

export function printLastFailureResult(
  state: AgenticState,
  events: AgenticEvent[],
  opts: ReportOptions
): void {
  const failures = getFailureEvents(events, 1);

  if (failures.length > 0) {
    if (opts.json) {
      process.stdout.write(JSON.stringify(failures[0], null, 2) + "\n");
    } else {
      console.log("Latest failure/status event:");
      console.log(JSON.stringify(failures[0], null, 2));
    }
    return;
  }

  const taskWithHistory = getTasks(state)
    .filter((t) => (t.failureHistory ?? []).length > 0)
    .at(-1);

  if (taskWithHistory) {
    if (opts.json) {
      process.stdout.write(JSON.stringify(taskWithHistory, null, 2) + "\n");
    } else {
      console.log("Latest task failureHistory:");
      console.log(JSON.stringify(taskWithHistory, null, 2));
    }
    return;
  }

  const msg = "No failure events or task failureHistory found.";
  if (opts.json) {
    process.stdout.write(JSON.stringify({ message: msg }) + "\n");
  } else {
    console.log(msg);
  }
}

// ── Why-stuck reporting ───────────────────────────────────────────────────────

export function printWhyStuckResult(
  state: AgenticState,
  events: AgenticEvent[],
  opts: ReportOptions
): void {
  const tasks = getTasks(state);
  const needsHuman = tasks.filter((t) => t.status === "needs_human");
  const retryable = tasks.filter((t) => t.status === "needs_retry" || t.status === "failed");
  const pendingBlocked = tasks.filter(
    (t) => t.status === "pending" && !dependenciesPassed(t, state)
  );

  if (opts.json) {
    process.stdout.write(
      JSON.stringify(
        {
          goal: state.goal,
          needsHuman: needsHuman.map((t) => ({ id: t.id, lastRunDir: t.lastRunDir })),
          retryable: retryable.map((t) => ({
            id: t.id,
            attempts: getTaskAttempts(t),
            suggestedCommand: `npm run agent -- status`,
          })),
          pendingBlocked: pendingBlocked.map((t) => ({
            id: t.id,
            waitingOn: t.dependsOn,
          })),
          recentFailures: getFailureEvents(events, 5).map(formatEventLine),
        },
        null,
        2
      ) + "\n"
    );
    return;
  }

  console.log(`Why-stuck analysis for: ${state.goal ?? "(no goal)"}\n`);

  if (needsHuman.length === 0 && retryable.length === 0 && pendingBlocked.length === 0) {
    const next = getNextTask(state);
    if (next) {
      console.log(`Not stuck: next runnable task is ${next.id}.`);
      console.log(`Suggested: run the loop normally.`);
    } else {
      console.log("No stuck tasks detected. All tasks may be complete.");
    }
    return;
  }

  for (const t of needsHuman) {
    console.log(`needs_human: ${t.id}`);
    if (t.lastRunDir) console.log(`  inspect: ${t.lastRunDir}`);
    console.log(`  resolve manually or split/reset if safe.`);
  }

  for (const t of retryable) {
    console.log(`retryable:   ${t.id}  attempts=${getTaskAttempts(t)}`);
    console.log(`  suggested: pwsh -File scripts/agentic/agentic-loop.ps1 --retry ${t.id}`);
    console.log(`             pwsh -File scripts/agentic/agentic-loop.ps1 --reset-task ${t.id}`);
  }

  for (const t of pendingBlocked) {
    console.log(`blocked:     ${t.id}  waiting on [${(t.dependsOn ?? []).join(", ")}]`);
  }

  const recentFailures = getFailureEvents(events, 5);
  if (recentFailures.length > 0) {
    console.log("\nRecent failures:");
    recentFailures.forEach((e) => console.log(formatEventLine(e)));
  }
}

// ── Doctor reporting ──────────────────────────────────────────────────────────

export interface DoctorIssue {
  taskId: string;
  kind: "missing-branch" | "missing-worktree";
  value: string;
}

export interface DoctorResult {
  issues: DoctorIssue[];
  passed: boolean;
}

export function printDoctorResult(result: DoctorResult, opts: ReportOptions): void {
  if (opts.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    return;
  }

  if (result.passed) {
    console.log("Doctor found no issues.");
    return;
  }

  console.log(`Doctor found ${result.issues.length} issue(s):`);
  for (const issue of result.issues) {
    const label = issue.kind === "missing-branch" ? "review branch missing" : "review worktree missing";
    console.log(`  - [${issue.taskId}] ${label}: ${issue.value}`);
  }
}

// ── Reset-task reporting ──────────────────────────────────────────────────────

export interface ResetPlan {
  taskId: string;
  branch: string;
  worktree: string;
  worktreeWillRemove: boolean;
  branchWillDelete: boolean;
  newStatus: string;
  applied: boolean;
}

export function printResetResult(plan: ResetPlan, opts: ReportOptions): void {
  if (opts.json) {
    process.stdout.write(JSON.stringify(plan, null, 2) + "\n");
    return;
  }

  const verb = plan.applied ? "Reset" : "Would reset";
  console.log(`${verb} task: ${plan.taskId}`);
  console.log("");

  const mark = (will: boolean) => (plan.applied ? "✓" : will ? "•" : "—");
  console.log(`  ${mark(plan.worktreeWillRemove)} remove worktree: ${plan.worktree}${plan.worktreeWillRemove ? "" : " (not present)"}`);
  console.log(`  ${mark(plan.branchWillDelete)} delete branch:   ${plan.branch}${plan.branchWillDelete ? "" : " (not present)"}`);
  console.log(`  ${plan.applied ? "✓" : "•"} set status:      ${plan.newStatus}`);
  console.log("");

  if (plan.applied) {
    console.log(`Done. Suggested next: pwsh -File scripts/agentic/agentic-loop.ps1 --retry ${plan.taskId}`);
  } else {
    console.log("Dry run — nothing changed. Re-run with --apply to execute.");
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function pad(s: string, len: number): string {
  return s.length >= len ? s : s + " ".repeat(len - s.length);
}
