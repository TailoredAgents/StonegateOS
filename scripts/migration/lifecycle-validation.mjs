import {readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
const [directory,action]=process.argv.slice(2);
if(!directory||!['start','check','stop'].includes(action))throw Error('Usage: lifecycle-validation.mjs <private-directory> start|check|stop');
const token=(await readFile(path.join(directory,'probe-token'),'utf8')).trim();
const origin='https://stonegate-lifecycle-validation.jeffrey-78e.workers.dev';
const response=await fetch(origin+(action==='check'?'/status':'/'+action),{
  method:action==='check'?'GET':'POST',headers:{authorization:`Bearer ${token}`},signal:AbortSignal.timeout(90000)});
const result=await response.json();
if(!response.ok)throw Error(`Lifecycle validation ${action} failed (${response.status})`);
if(action==='start')await writeFile(path.join(directory,'lifecycle-start.json'),JSON.stringify(result),{mode:0o600});
if(action==='check') {
  const start=JSON.parse(await readFile(path.join(directory,'lifecycle-start.json'),'utf8'));
  result.pass=result.running===true&&result.healthy===true&&result.validationId===start.validationId&&
    result.lastAlarm?.healthy===true&&result.lastAlarm?.validationId===start.validationId&&
    result.objectExecutionId!==start.objectExecutionId;
  result.sameContainerAcrossObjectRecreation=result.pass;
  await writeFile(path.join(directory,`lifecycle-validation-${Date.now()}.json`),JSON.stringify({at:new Date().toISOString(),start,result}),{mode:0o600,flag:'wx'});
  if(!result.pass)process.exitCode=1;
}
console.log(JSON.stringify({action,...result}));
