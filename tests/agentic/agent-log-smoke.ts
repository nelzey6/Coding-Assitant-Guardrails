#!/usr/bin/env tsx
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { invokeAgentWithLog } from "../../tools/agent-loop/src/agent/index.js";

const dir = mkdtempSync(join(tmpdir(), "agent-log-smoke-"));
const fakePi = join(dir, "pi");
const prompt = join(dir, "prompt.md");
const log = join(dir, "pi.log");
const secret = "FULL_PRIVATE_MESSAGE_SHOULD_NOT_BE_LOGGED";
const hugeResult = "HUGE_TOOL_RESULT_SHOULD_NOT_BE_LOGGED";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function main(): Promise<void> {
try {
  writeFileSync(prompt, "Perform a tiny task.", "utf-8");
  writeFileSync(fakePi, `#!/usr/bin/env node
const secret = ${JSON.stringify(secret)};
const hugeResult = ${JSON.stringify(hugeResult)};
const usage1 = { input: 120, output: 30, cacheRead: 10, cacheWrite: 2, totalTokens: 162, cost: { total: 0.0042 } };
const usage2 = { input: 80, output: 20, cacheRead: 5, cacheWrite: 1, totalTokens: 106, cost: { total: 0.0021 } };
console.log(JSON.stringify({ type: "session", id: "session-1", cwd: process.cwd() }));
console.log(JSON.stringify({ type: "message_update", delta: secret.repeat(100) }));
console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [
  { type: "thinking", thinking: secret.repeat(100) },
  { type: "text", text: secret.repeat(100) },
  { type: "toolCall", name: "write", arguments: { content: secret.repeat(100) } }
], usage: usage1 } }));
console.log(JSON.stringify({ type: "tool_execution_end", toolName: "write", isError: false, result: hugeResult.repeat(100) }));
console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: secret.repeat(100) }], usage: usage2 } }));
console.log(JSON.stringify({ type: "agent_end", messages: [
  { role: "user", content: secret.repeat(100) },
  { role: "assistant", content: [{ type: "toolCall", name: "write" }], usage: usage1 },
  { role: "assistant", content: [{ type: "text", text: secret.repeat(100) }], usage: usage2 }
] }));
`, "utf-8");
  chmodSync(fakePi, 0o755);

  const result = await invokeAgentWithLog(
    prompt,
    { tool: "pi", commandTemplate: `${fakePi} {prompt}` },
    dir,
    log,
    "planner",
  );
  const output = readFileSync(log, "utf-8");

  assert(result.tool === "pi", "fake pi command was not detected as Pi");
  assert(result.assistantTurns === 2, `expected two assistant turns, got ${result.assistantTurns}`);
  assert(result.toolCalls === 1, `expected one tool call, got ${result.toolCalls}`);
  assert(result.usage?.totalTokens === 268, `compact log did not aggregate Pi usage: ${result.usage?.totalTokens}`);
  assert(result.usage?.costUsd === 0.0063, `compact log did not aggregate Pi cost: ${result.usage?.costUsd}`);
  assert(!output.includes(secret), "compact log retained assistant content or prompt history");
  assert(!output.includes(hugeResult), "compact log retained tool result content");
  assert(Buffer.byteLength(output) < 2_000, `compact log is unexpectedly large: ${Buffer.byteLength(output)} bytes`);

  console.log("agent log smoke passed");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
