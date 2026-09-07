/** Opt-in model evaluation: runs real fresh Pi sessions, incurs provider usage. */
import assert from 'node:assert/strict';
import {mkdtempSync, writeFileSync, mkdirSync, readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import {resolveChecks, runChecks, buildReviewEvidence} from '../../tools/agent-loop/src/checks/index.js';
import {writeVerifierPrompt, validateVerifierResult} from '../../tools/agent-loop/src/prompts/index.js';
import {invokeAgentPhase} from '../../tools/agent-loop/src/loop/agent-phase.js';
import {loadPolicy} from '../../tools/agent-loop/src/policy/index.js';

async function main() {
  assert.ok(process.argv.includes('--live'), 'Pass --live to authorize real model invocations');
  const commandIndex = process.argv.indexOf('--command');
  const commandTemplate = commandIndex < 0 ? undefined : process.argv[commandIndex + 1];
  assert.ok(commandIndex < 0 || commandTemplate?.includes('{prompt}'), '--command requires a template containing {prompt}');
  const root = process.cwd();
  const out = resolve('.agent-runs', `live-review-${Date.now()}`);
  mkdirSync(out, {recursive: true});
  const cases = [
    {name: 'correct-extraction', body: 'return value == null ? 42 : value;', exported: true, strong: true, pass: true},
    {name: 'changed-default', body: 'return value == null ? 41 : value;', exported: true, strong: false, pass: false},
    {name: 'lost-export', body: 'return value == null ? 42 : value;', exported: false, strong: false, pass: false},
    {name: 'unproven-behavior', body: 'return value == null ? 42 : value;', exported: true, strong: false, pass: false},
    {name: 'falsy-regression', body: 'return value || 42;', exported: true, strong: false, pass: false},
  ];
  const results: unknown[] = [];
  let failures = 0;
  for (const sample of cases) {
    const repo = mkdtempSync(join(tmpdir(), 'loop-review-eval-'));
    const git = (args: string[]) => execFileSync('git', args, {cwd: repo, encoding: 'utf8'});
    git(['init', '-q']);
    mkdirSync(join(repo, 'src'));
    writeFileSync(join(repo, 'src/main.cjs'), 'exports.helper = value => value == null ? 42 : value;\n');
    writeFileSync(join(repo, 'AGENTS.md'), 'Review only. Do not edit repository files.\n');
    writeFileSync(join(repo, 'check.cjs'), sample.strong
      ? "const a=require('node:assert/strict'),h=require('./src/main.cjs').helper; for(const [input,expected] of [[undefined,42],[null,42],[0,0],[false,false],['',''],[7,7]]) a.equal(h(input),expected); a.equal(h,require('./src/helper.cjs').helper);\n"
      : "require('node:assert/strict').equal(typeof require('./src/helper.cjs').helper,'function');\n");
    git(['add', '.']);
    git(['-c', 'user.name=Benchmark', '-c', 'user.email=benchmark@localhost', 'commit', '-qm', 'Baseline']);
    writeFileSync(join(repo, 'src/main.cjs'), sample.exported ? "exports.helper = require('./helper.cjs').helper;\n" : "require('./helper.cjs');\n");
    writeFileSync(join(repo, 'src/helper.cjs'), `exports.helper = value => { ${sample.body} };\n`);
    git(['add', '-N', '.']);
    const task = {id: sample.name, title: 'Extract helper preserving behavior', kind: 'implementation',
      scope: ['src/main.cjs', 'src/helper.cjs'], acceptanceCriteria: ['Both modules export the same helper. Null or undefined returns 42; every other input, including 0, false and empty string, is returned unchanged. Behavioral assertion checks must establish this contract.']};
    const batch = runChecks(repo, resolveChecks(repo, [], [], ['node check.cjs']), 30);
    assert.equal(batch.failureKind, undefined);
    const evidence = buildReviewEvidence(task, batch, repo);
    const run = join(out, sample.name);
    mkdirSync(run);
    const resultFile = join(run, 'result.json');
    const promptFile = join(run, 'verifier.md');
    writeVerifierPrompt(promptFile, {repoRoot: root, runsRoot: out, stateFile: 'unused.json', budget: 'medium', task,
      worktreePath: repo, checkOutput: batch.log, evidence, resultFile, eventLogPath: join(run, 'events.jsonl'), policy: loadPolicy(root), suppressEvent: true});
    try {
      const invocation = await invokeAgentPhase({repoRoot: repo, runsRoot: '.agent-runs', stateFile: 'unused.json', worktreeRoot: '.worktrees',
        promptFile, agent: {tool: 'pi', timeoutSeconds: 180, commandTemplate}, workingDirectory: repo, logFile: join(run, 'verifier.log'), phase: 'verifier', readOnlyCandidate: true});
      const result = JSON.parse(readFileSync(resultFile, 'utf8'));
      const contractErrors = validateVerifierResult(result, task, evidence);
      const correct = contractErrors.length === 0 && result.verdict === (sample.pass ? 'pass' : 'fail');
      if (!correct) failures++;
      results.push({name: sample.name, repo, expected: sample.pass ? 'pass' : 'fail', correct, contractErrors, result,
        durationMs: invocation.durationMs, assistantTurns: invocation.assistantTurns, toolCalls: invocation.toolCalls});
    } catch (error) {
      failures++;
      results.push({name: sample.name, repo, correct: false, error: String(error)});
    }
    writeFileSync(join(out, 'results.json'), JSON.stringify(results, null, 2));
    console.log(JSON.stringify(results.at(-1)));
  }
  console.log(`Live review evaluation: ${cases.length - failures}/${cases.length}; artifacts: ${out}`);
  if (failures) process.exitCode = 1;
}
main().catch(error => {console.error(error); process.exitCode = 1;});
