import test from 'node:test';
import assert from 'node:assert/strict';
import {createOutboxDrainController} from '../../apps/api/src/lib/outbox-worker-runtime.ts';

test('drain wakes a long idle poll immediately and remains stopped',async()=>{
  const drain=createOutboxDrainController();
  const waiting=drain.wait(30000);
  drain.requestStop();drain.requestStop();
  await waiting;
  assert.equal(drain.stopping,true);
  await drain.wait(30000);
});

test('drain allows an in-flight operation to settle before admitting no further work',async()=>{
  const drain=createOutboxDrainController();
  let release;
  const providerResult=new Promise(resolve=>{release=resolve;});
  const effects=[];
  const running=(async()=>{
    while(!drain.stopping) {
      effects.push('started');
      await providerResult;
      effects.push('settled');
      if(!drain.stopping)effects.push('next-scheduler');
    }
    effects.push('closed');
  })();
  drain.requestStop();
  assert.deepEqual(effects,['started']);
  release();await running;
  assert.deepEqual(effects,['started','settled','closed']);
});
