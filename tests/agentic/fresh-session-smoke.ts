import assert from 'node:assert/strict';
import {mkdtempSync, writeFileSync, readFileSync, chmodSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {invokeAgentWithLog} from '../../tools/agent-loop/src/agent/index.js';

async function main() {
  const dir = mkdtempSync(join(tmpdir(), 'fresh-session-'));
  const oldPath = process.env.PATH;
  try {
    const shim = join(dir, 'pi');
    writeFileSync(shim, '#!/bin/sh\nprintf "%s\\n" "$@" > arguments.txt\n');
    chmodSync(shim, 0o755);
    process.env.PATH = `${dir}:${oldPath}`;
    const prompt = join(dir, 'prompt.md');
    writeFileSync(prompt, 'Review this candidate');
    for (const phase of ['executor', 'verifier', 'verifier-vote-1', 'planner']) {
      await invokeAgentWithLog(prompt, {tool: 'pi'}, dir, join(dir, `${phase}.log`), phase);
      const args = readFileSync(join(dir, 'arguments.txt'), 'utf8').trim().split('\n');
      assert.ok(args.includes('--no-session'), `${phase} must use an ephemeral fresh session`);
      assert.equal(args.includes('--thinking'), phase === 'verifier', 'Only ordinary review overrides effort');
      if (phase === 'verifier') {
        assert.equal(args[args.indexOf('--thinking') + 1], 'medium');
        assert.equal(args[args.indexOf('--tools') + 1], 'read,grep,find,ls,write', 'Ordinary review inspects evidence without a shell');
      } else assert.ok(!args.includes('--tools'), 'Other phases retain their tools');
      assert.ok(!args.some(arg => ['--continue', '--resume', '--session'].includes(arg)));
    }
    await invokeAgentWithLog(prompt, {tool: 'pi', thinking: 'medium'}, dir, join(dir, 'bounded.log'), 'executor');
    const bounded = readFileSync(join(dir, 'arguments.txt'), 'utf8').trim().split('\n');
    assert.equal(bounded[bounded.indexOf('--thinking') + 1], 'medium', 'Bounded execution uses requested native effort');
    await invokeAgentWithLog(prompt, {tool: 'pi', commandTemplate: 'pi -p "{prompt}" --thinking high'}, dir, join(dir, 'custom.log'), 'verifier');
    const custom = readFileSync(join(dir, 'arguments.txt'), 'utf8');
    assert.ok(custom.includes('high'));
    assert.ok(!custom.includes('medium'), 'Explicit operator command owns its effort/session settings');
  } finally {
    process.env.PATH = oldPath;
    rmSync(dir, {recursive: true, force: true});
  }
  console.log('fresh session smoke passed');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
