import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { resolveTaskComplexity } from "../../tools/agent-loop/src/scope/index.js";
import { writeStanceReflectionPrompt } from "../../tools/agent-loop/src/prompts/index.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const policy = { workflows: {}, humanGatePaths: [] } as any;

const architecture = resolveTaskComplexity({
  id: "architecture",
  kind: "architecture",
  workflow: "improve-codebase-architecture",
  complexity: "low",
  complexityReasons: [],
} as any, policy);
assert(architecture.level === "high", "architecture tasks must escalate to high complexity");
assert(architecture.reasons.length > 0, "escalation must explain its reasons");

const implementation = resolveTaskComplexity({
  id: "implementation",
  kind: "implementation",
  workflow: "tdd",
  complexity: "low",
  scope: ["docs/verification-policy.md"],
} as any, policy);
assert(implementation.level === "low", "implementation kind alone must not raise task complexity");

const dir = mkdtempSync(join(tmpdir(), "agentic-reflection-smoke-"));
try {
  const prompt = join(dir, "stance.md");
  writeStanceReflectionPrompt(prompt, {
    repoRoot: process.cwd(),
    task: { id: "architecture", kind: "architecture", workflow: "improve-codebase-architecture" },
    resultFile: join(dir, "stance.json"),
  });
  const text = readFileSync(prompt, "utf-8");
  assert(text.includes("reflect-on-approach"), "stance prompt must route to the canonical skill");
  assert(text.includes("Do not edit files"), "stance prompt must prohibit implementation edits");
  assert(text.includes("reconfirm|readjust|reassess|needs_human"), "stance prompt must declare verdicts");
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log("reflection complexity smoke passed");
