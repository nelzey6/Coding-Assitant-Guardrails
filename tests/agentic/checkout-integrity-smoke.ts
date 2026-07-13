#!/usr/bin/env tsx
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { execFileSync } from "child_process";
import { CheckoutMutationError, withUnchangedCheckout } from "../../tools/agent-loop/src/tools/index.js";

function git(args: string[], cwd: string): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

async function main(): Promise<void> {
  const repo = mkdtempSync(join(tmpdir(), "checkout-integrity-"));
  try {
  git(["init"], repo);
  git(["config", "user.email", "smoke@example.test"], repo);
  git(["config", "user.name", "Smoke"], repo);
  writeFileSync(join(repo, "README.md"), "# Fixture\n");
  git(["add", "README.md"], repo);
  git(["commit", "-m", "fixture"], repo);

  await withUnchangedCheckout(repo, async () => undefined);

  let detected = false;
  try {
    await withUnchangedCheckout(repo, async () => {
      git(["commit", "--allow-empty", "-m", "unexpected head movement"], repo);
    });
  } catch (error) {
    detected = error instanceof CheckoutMutationError;
  }
  assert(detected, "HEAD movement without a file diff must be detected");
  console.log("checkout-integrity smoke passed");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

void main();
