import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {resolveChecks, runChecks} from '../../tools/agent-loop/src/checks/index.js';
const repo=mkdtempSync(join(tmpdir(),'check-evidence-'));
try {
  execFileSync('git',['init','-q'],{cwd:repo});
  writeFileSync(join(repo,'a.txt'),'before');execFileSync('git',['add','.'],{cwd:repo});
  execFileSync('git',['-c','user.name=Test','-c','user.email=test@example.test','commit','-qm','fixture'],{cwd:repo});
  const checks=resolveChecks(repo,['node -e "require(\'node:assert\').equal(1,1)"'],[],['node -e "require(\'node:assert\').equal(1,1)"']);
  assert.equal(checks.length,1);assert.deepEqual(checks[0].sources,['operator','state']);
  const batch=runChecks(repo,checks,10);
  assert.equal(batch.results[0].status,'passed');assert.ok(batch.results[0].evidenceId);
  const invalid=resolveChecks(repo,[],[],['node -e "0" (explains the test)']);
  const failed=runChecks(repo,invalid,10);
  assert.equal(failed.failureKind,'configuration');
  assert.equal(failed.results[0].status,'invalid');
  const partial=runChecks(repo,resolveChecks(repo,[],[],['node -e "0"','node -e "process.exit(1)"']),10);
  assert.equal(partial.failureKind,'code');assert.equal(partial.results.length,2);assert.ok(partial.results[0].evidenceId);
  const mutation=runChecks(repo,resolveChecks(repo,[],[],['node -e "require(\'fs\').writeFileSync(\'a.txt\',\'after\')"']),10);
  assert.equal(mutation.failureKind,'candidate_mutation');
  assert.equal(mutation.results[0].evidenceId,undefined,'mutating check must not supply passing evidence');
  console.log('check evidence smoke passed');
}finally{rmSync(repo,{recursive:true,force:true});}
