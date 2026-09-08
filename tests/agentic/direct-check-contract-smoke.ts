import assert from 'node:assert/strict';
import {validateDirectExecutionResult, getDirectCheckCommands} from '../../tools/agent-loop/src/routing/index.js';
const base={verdict:'completed' as const,summary:'Done',assumptions:[]};
const known=['node existing.cjs'];
const structured={...base,additionalChecks:[{command:'node added.cjs',reason:'Additional edge assertions; previous checks passed'}]};
assert.deepEqual(validateDirectExecutionResult(structured,known),[]);
assert.deepEqual(getDirectCheckCommands(structured),['node added.cjs']);
assert.deepEqual(validateDirectExecutionResult({...base,additionalChecks:[]},known),[]);
assert.deepEqual(validateDirectExecutionResult(base,known),[]);
assert.ok(validateDirectExecutionResult(base).length);
assert.deepEqual(getDirectCheckCommands({...base,validation:['node legacy.cjs']}),['node legacy.cjs']);
assert.deepEqual(validateDirectExecutionResult({...base,validation:['node legacy.cjs']}),[]);
assert.deepEqual(getDirectCheckCommands({...base,additionalChecks:[],validation:['obsolete report (passed)']}),[]);
for(const additionalChecks of [
  [{command:'node added.cjs (passed)'}],
  [{command:''}],
  ['node added.cjs'],
  Array.from({length:4},()=>({command:'node added.cjs'})),
]) assert.ok(validateDirectExecutionResult({...base,additionalChecks},known).length,'Invalid executable proposal accepted');
assert.ok(validateDirectExecutionResult({...base,validation:['node legacy.cjs (passed)']},known).length,'Legacy command descriptions must not be stripped');
console.log('direct check contract smoke passed');
