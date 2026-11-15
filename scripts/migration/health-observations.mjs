import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
const directory=process.argv[2];
if(!directory)throw new Error('Private evidence directory required');
const token=(await readFile(path.join(directory,'probe-token'),'utf8')).trim();
const origin='https://stonegate-migration-validation.jeffrey-78e.workers.dev';
async function get(route) {
  const response=await fetch(origin+route,{headers:{authorization:`Bearer ${token}`},signal:AbortSignal.timeout(30000)});
  if(!response.ok)throw new Error(`Observation read failed: ${response.status}`);
  return response.json();
}
const listing=await get('/observations');
if(listing.truncated)throw new Error('Observation listing truncated: export remaining records through R2 before evaluating coverage');
const receipts=[];
for(const object of listing.objects) receipts.push(await get('/observation?key='+encodeURIComponent(object.key)));
receipts.sort((a,b)=>a.at.localeCompare(b.at));
const scheduled=receipts.filter(r=>r.scheduledAt!==null);
const timestamps=[...new Set(scheduled.map(r=>r.scheduledAt))].sort((a,b)=>a-b);
const gaps=timestamps.slice(1).flatMap((at,i)=>at-timestamps[i]>20*60000?[{from:new Date(timestamps[i]).toISOString(),to:new Date(at).toISOString()}]:[]);
const summary={at:new Date().toISOString(),endsAt:listing.endsAt,expired:listing.expired,
  runs:receipts.length,scheduledRuns:scheduled.length,failures:receipts.filter(r=>!r.pass).length,
  first:receipts[0]?.at??null,last:receipts.at(-1)?.at??null,
  scheduledStale:!timestamps.length||Date.now()-timestamps.at(-1)>30*60000,gaps};
await writeFile(path.join(directory,`health-observations-${Date.now()}.json`),JSON.stringify({summary,receipts},null,2),{mode:0o600,flag:'wx'});
console.log(JSON.stringify(summary,null,2));
if(summary.failures||summary.gaps.length||summary.scheduledStale)process.exitCode=1;
