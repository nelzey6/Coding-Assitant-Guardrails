import type { RepoContext, AgenticTask } from "../context/index.js";
import type { WorkflowPolicy } from "../policy/index.js";

export interface PlannedTask {
  id: string;
  title: string;
  kind: string;
  workflow: string;
  priority: number;
  acceptanceCriteria: string[];
  validation: string[];
  dependsOn: string[];
}

export interface PlanResult {
  goal: string;
  tasks: PlannedTask[];
  warnings: string[];
}

// Heuristic workflow selection from task text keywords
const WORKFLOW_RULES: Array<{ keywords: string[]; workflow: string; kind: string }> = [
  {
    keywords: ["bug", "fix", "broken", "crash", "error", "failing", "regression", "flak"],
    workflow: "diagnose",
    kind: "bugfix",
  },
  {
    keywords: ["refactor", "clean", "simplif", "restructure", "consolidat", "modulariz", "architecture", "boundary"],
    workflow: "improve-codebase-architecture",
    kind: "refactor",
  },
  {
    keywords: ["document", "readme", "changelog", "comment", "docs", "spec", "adr"],
    workflow: "tdd",
    kind: "maintenance",
  },
  {
    keywords: ["add", "implement", "create", "build", "feature", "support", "enable"],
    workflow: "tdd",
    kind: "implementation",
  },
  {
    keywords: ["investigate", "understand", "explore", "research", "discover", "audit"],
    workflow: "zoom-out",
    kind: "discovery",
  },
  {
    keywords: ["update", "upgrade", "migrate", "bump", "port"],
    workflow: "tdd",
    kind: "maintenance",
  },
];

function selectWorkflow(taskText: string, policy: WorkflowPolicy): { workflow: string; kind: string } {
  const lower = taskText.toLowerCase();
  for (const rule of WORKFLOW_RULES) {
    if (rule.keywords.some((kw) => lower.includes(kw))) {
      // verify the workflow exists in policy
      if (policy.workflows[rule.workflow]) {
        return { workflow: rule.workflow, kind: rule.kind };
      }
    }
  }
  return { workflow: policy.defaultExecutionWorkflow, kind: "implementation" };
}

function slugify(text: string, index: number): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return `task-${String(index + 1).padStart(3, "0")}-${slug}`;
}

function inferAcceptanceCriteria(taskText: string, workflow: string): string[] {
  const criteria: string[] = [
    `${taskText} is complete and verifiable`,
    "All existing checks and tests continue to pass",
  ];
  if (workflow === "tdd") {
    criteria.push("New behavior is covered by at least one focused test or smoke check");
  }
  if (workflow === "diagnose") {
    criteria.push("Root cause is identified and documented");
    criteria.push("Regression test added or evidence provided that the bug cannot recur");
  }
  if (workflow === "improve-codebase-architecture") {
    criteria.push("No net increase in coupling or module count without clear justification");
  }
  return criteria;
}

export function scaffoldPlan(goalText: string, ctx: RepoContext, policy: WorkflowPolicy): PlanResult {
  const warnings: string[] = [];

  // Split goal into sub-tasks by sentence or bullet (simple heuristic)
  const lines = goalText
    .split(/\n|(?<=\.)\s+/)
    .map((l) => l.replace(/^[-*•]\s*/, "").trim())
    .filter((l) => l.length > 3);

  const rawTasks = lines.length > 1 ? lines : [goalText.trim()];

  if (rawTasks.length > 10) {
    warnings.push(
      `Goal produced ${rawTasks.length} candidate tasks — consider narrowing scope. Only first 10 scaffolded.`
    );
  }

  const tasks: PlannedTask[] = rawTasks.slice(0, 10).map((taskText, i) => {
    const { workflow, kind } = selectWorkflow(taskText, policy);
    return {
      id: slugify(taskText, i),
      title: taskText,
      kind,
      workflow,
      priority: i + 1,
      acceptanceCriteria: inferAcceptanceCriteria(taskText, workflow),
      validation: [],
      dependsOn: i === 0 ? [] : [slugify(rawTasks[i - 1], i - 1)],
    };
  });

  if (tasks.length === 1) {
    // Single task: no dependency
    tasks[0].dependsOn = [];
  }

  return { goal: goalText, tasks, warnings };
}

export function renderPlanMarkdown(result: PlanResult): string {
  const lines: string[] = [
    `# Plan: ${result.goal}`,
    "",
    "> **Draft scaffold** — review and edit before promoting to `agentic.json`.",
    "> Workflows and acceptance criteria are heuristic; adjust to fit actual task requirements.",
    "",
  ];

  if (result.warnings.length > 0) {
    lines.push("## Warnings", "");
    result.warnings.forEach((w) => lines.push(`- ${w}`));
    lines.push("");
  }

  lines.push("## Tasks", "");

  result.tasks.forEach((task, i) => {
    lines.push(`### ${i + 1}. ${task.title}`, "");
    lines.push(`- **ID**: \`${task.id}\``);
    lines.push(`- **Kind**: ${task.kind}`);
    lines.push(`- **Workflow**: \`${task.workflow}\``);
    lines.push(`- **Priority**: ${task.priority}`);
    if (task.dependsOn.length > 0) {
      lines.push(`- **Depends on**: ${task.dependsOn.map((d) => `\`${d}\``).join(", ")}`);
    }
    lines.push("");
    lines.push("**Acceptance criteria:**", "");
    task.acceptanceCriteria.forEach((c) => lines.push(`- [ ] ${c}`));
    lines.push("");
    lines.push("**Validation commands:** *(fill in)*", "");
    lines.push("```");
    lines.push("# e.g. pwsh -File tests/agentic/smoke.ps1");
    lines.push("```");
    lines.push("");
  });

  lines.push("---");
  lines.push("");
  lines.push("## Promoting to agentic.json");
  lines.push("");
  lines.push("After reviewing, copy each task object into the `tasks` array in `agentic.json`:");
  lines.push("");
  lines.push("```json");
  lines.push(
    JSON.stringify(
      result.tasks.map((t) => ({
        id: t.id,
        title: t.title,
        kind: t.kind,
        workflow: t.workflow,
        status: "pending",
        priority: t.priority,
        acceptanceCriteria: t.acceptanceCriteria,
        validation: t.validation,
        dependsOn: t.dependsOn,
      })),
      null,
      2
    )
  );
  lines.push("```");

  return lines.join("\n");
}
