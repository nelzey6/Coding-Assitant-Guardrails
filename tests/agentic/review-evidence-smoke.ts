import assert from 'node:assert/strict';
import {validateVerifierResult} from '../../tools/agent-loop/src/prompts/index.js';
import type {ReviewEvidence} from '../../tools/agent-loop/src/state/index.js';
const task={id:'task',kind:'implementation',acceptanceCriteria:['Preserve behavior and update docs.']};
const evidence:ReviewEvidence={candidate:{head:'h',fingerprint:'f'},requirements:[{id:'c1',text:task.acceptanceCriteria[0]}],checks:[{id:'check1',command:'node test.js',cwd:'.',sources:['operator'],status:'passed',output:'pass',durationMs:1,evidenceId:'pass1'}],diff:{id:'diff1',files:['src/a.js','PROJECT.md'],hasCode:true}};
const result={verdict:'pass',issues:[],humanGates:[],coverage:[{criterionId:'c1',kind:'behavior',evidenceIds:['pass1'],proves:'Tests assert unchanged behavior'},{criterionId:'c1',kind:'documentation',evidenceIds:['diff1'],proves:'Docs describe the changed ownership'}]};
assert.deepEqual(validateVerifierResult(result,task,evidence),[]);
for(const bad of [
 {...result,coverage:[{...result.coverage[0],criterionId:'invented'}]},
 {...result,coverage:[{...result.coverage[0],evidenceIds:['stale-pass']}]},
 {...result,coverage:[{...result.coverage[0],evidenceIds:['diff1']}]},
 {...result,coverage:[{...result.coverage[1],evidenceIds:['pass1']}]},
 {...result,coverage:[]},
 {...result,issues:['real defect']},
]) assert.ok(validateVerifierResult(bad,task,evidence).length,'invalid proof accepted');
assert.deepEqual(validateVerifierResult({verdict:'fail',issues:[{file:'src/helper.js',triggeringCase:'Call helper',consequence:'Returns 41 instead of 42'}],humanGates:[]},task,evidence),[]);
console.log('review evidence smoke passed');
