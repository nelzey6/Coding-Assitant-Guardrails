#!/usr/bin/env node
import { program } from "commander";
import { writeFileSync, existsSync } from "fs";
import { join, resolve, dirname } from "path";
import { loadContext } from "./context/index.js";
import { loadPolicy } from "./policy/index.js";
import { runValidation } from "./validators/index.js";
import { scaffoldPlan, renderPlanMarkdown } from "./planner/index.js";
import { printValidateResult, printPlanResult } from "./reporting/index.js";

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

program
  .name("agent")
  .description("Deterministic pre-flight CLI for the agentic coding loop")
  .version("0.1.0");

// ── validate ──────────────────────────────────────────────────────────────────

program
  .command("validate")
  .description(
    "Check README/plugin/skill consistency across all buckets. Exits non-zero on any error."
  )
  .option("--repo <path>", "Path to repo root (default: auto-detected from cwd)")
  .option("--json", "Output results as JSON")
  .action((opts) => {
    const repoRoot = opts.repo ? resolve(opts.repo) : detectRepoRoot();
    const ctx = loadContext(repoRoot);
    const result = runValidation(ctx);
    printValidateResult(result, { json: !!opts.json });
    if (!result.passed) process.exit(1);
  });

// ── plan ──────────────────────────────────────────────────────────────────────

program
  .command("plan <task>")
  .description(
    "Scaffold a deterministic plan.md from a task description. Never touches agentic.json."
  )
  .option("--repo <path>", "Path to repo root (default: auto-detected from cwd)")
  .option("--output <path>", "Output file path (default: plan.md in repo root)")
  .option("--json", "Output summary as JSON (plan.md is always written)")
  .action((task, opts) => {
    const repoRoot = opts.repo ? resolve(opts.repo) : detectRepoRoot();
    const ctx = loadContext(repoRoot);
    const policy = loadPolicy(repoRoot);
    const planResult = scaffoldPlan(task, ctx, policy);
    const markdown = renderPlanMarkdown(planResult);

    const outputPath = opts.output
      ? resolve(opts.output)
      : join(repoRoot, "plan.md");

    writeFileSync(outputPath, markdown, "utf-8");

    printPlanResult(
      {
        outputPath,
        taskCount: planResult.tasks.length,
        warnings: planResult.warnings,
      },
      { json: !!opts.json }
    );
  });

program.parseAsync(process.argv).catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
