#!/usr/bin/env tsx
import { validateDirectExecutionResult } from "../../tools/agent-loop/src/routing/index.js";
function assert(value: boolean, message: string) { if (!value) throw new Error(message); }
for (const command of ["true", "echo done", "git diff", "git diff --check", 'node -e "process.exit(0)"']) {
  assert(validateDirectExecutionResult({verdict:"completed",summary:"done",validation:[command],assumptions:[]}).length > 0, `vacuous proof accepted: ${command}`);
}
assert(validateDirectExecutionResult({verdict:"completed",summary:"done",validation:["npm test -- helper"],assumptions:[]}).length === 0, "focused test rejected");
console.log("acceptance-proof smoke passed");
