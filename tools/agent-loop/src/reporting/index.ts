import type { ValidationResult, Violation } from "../validators/index.js";
import type { PlanResult } from "../planner/index.js";

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
