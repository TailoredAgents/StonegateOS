import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
const directory=process.argv[2];if(!directory)throw Error('Private evidence directory required');
const token=(await readFile(path.join(directory,'probe-token'),'utf8')).trim();
const settings=JSON.parse(await readFile(path.join(directory,'site-env.json'),'utf8'));
const publicSettings=Object.fromEntries(Object.entries(settings).filter(([key])=>key.startsWith('NEXT_PUBLIC_')||key==='PARTNER_MEDIA_STORAGE_ORIGIN').sort(([a],[b])=>a.localeCompare(b)));
const expected=createHash('sha256').update(JSON.stringify(publicSettings)).digest('hex');
const base='https://stonegate-container-validation.jeffrey-78e.workers.dev';
try {
  const start=performance.now();
  const response=await fetch(base+'/site/site-runtime-check',{method:'POST',headers:{authorization:`Bearer ${token}`},signal:AbortSignal.timeout(180000)});
  const result={at:new Date().toISOString(),status:response.status,ms:Math.round(performance.now()-start),...await response.json()};
  result.publicConfigurationMatches=result.publicConfiguration?.sha256===expected;
  result.ok=response.ok&&result.ok===true&&result.publicConfigurationMatches;
  await writeFile(path.join(directory,`site-runtime-validation-${Date.now()}.json`),JSON.stringify(result),{mode:0o600,flag:'wx'});
  console.log(JSON.stringify({status:result.status,ok:result.ok,checks:result.checks?.length,publicConfigurationMatches:result.publicConfigurationMatches,ms:result.ms}));
  if(!result.ok)process.exitCode=1;
} finally {
  const response=await fetch(base+'/site/stop',{method:'POST',headers:{authorization:`Bearer ${token}`},signal:AbortSignal.timeout(15000)});
  await response.body?.cancel();if(!response.ok)throw Error('Site validation cleanup failed');
}
