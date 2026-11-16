import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWorkerTaskDrain } from '../lib/worker-task-drain.ts';

test('Discord drain completes accepted work and rejects new events', async () => {
  const tasks=createWorkerTaskDrain();
  let complete; const gate=new Promise(resolve=>{complete=resolve;});
  const effects=[];
  const accepted=tasks.run(async()=>{await gate;effects.push('accepted');});
  tasks.stop();tasks.stop();
  let drained=false;const drain=tasks.drained().then(()=>{drained=true;});
  assert.equal(await tasks.run(async()=>{effects.push('late');}),false);
  assert.equal(drained,false);
  complete();await accepted;await drain;
  assert.deepEqual(effects,['accepted']);assert.equal(drained,true);
});

test('Discord failed tasks are released and draining requires closed admission', async()=>{
  const tasks=createWorkerTaskDrain();
  await assert.rejects(tasks.drained(),/Close task admission/);
  const failed=tasks.run(async()=>{throw Error('simulated provider failure');});
  tasks.stop();await assert.rejects(failed,/simulated provider failure/);
  await tasks.drained();
});
