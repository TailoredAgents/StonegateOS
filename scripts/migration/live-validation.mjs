import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
const directory=process.argv[2];
if(!directory) throw new Error('Supply the private migration evidence directory');
const token=(await readFile(path.join(directory,'probe-token'),'utf8')).trim();
const worker='https://stonegate-migration-validation.jeffrey-78e.workers.dev';
const api='https://stonegate-api.onrender.com';
const site='https://stonegatejunkremoval.com';
const checks=[];
async function check(name,url,expected,options={}) {
  const start=performance.now();
  try {
    const response=await fetch(url,{...options,signal:AbortSignal.timeout(30000),redirect:'manual'});
    const result={name,status:response.status,pass:expected.includes(response.status),ms:Math.round(performance.now()-start)};
    if(name==='api-readiness' && response.headers.get('content-type')?.includes('json')) result.readiness=await response.json();
    else await response.body?.cancel();
    checks.push(result);
  } catch(error) {checks.push({name,pass:false,error:error.name});}
}
await Promise.all([
  check('website-home',site+'/',[200]),
  check('website-book',site+'/book',[200]),
  check('partner-login',site+'/partners/login',[200]),
  check('api-health',api+'/api/healthz',[200]),
  check('api-readiness',api+'/api/readyz',[200]),
  check('admin-unauthenticated',api+'/api/admin/contacts',[401,403]),
  ...['sms','voice','call-status'].map(route=>check('twilio-reject-unsigned-'+route,api+'/api/webhooks/twilio/'+route,[401,403],{
    method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:''})),
  check('cloudflare-reject-unauthenticated',worker+'/health',[401]),
  check('cloudflare-reject-invalid-token',worker+'/health',[401],{headers:{authorization:'Bearer invalid-test-token'}}),
  check('cloudflare-health',worker+'/health',[200],{headers:{authorization:`Bearer ${token}`}}),
  check('cloudflare-storage-roundtrip',worker+'/r2-roundtrip',[200],{method:'POST',headers:{authorization:`Bearer ${token}`}}),
]);
await writeFile(path.join(directory,`live-validation-${Date.now()}.json`),JSON.stringify({at:new Date().toISOString(),checks},null,2),{mode:0o600,flag:'wx'});
console.log(JSON.stringify(checks.map(({readiness,...result})=>result),null,2));
// Save object keys and content hashes privately. No media bodies leave Cloudflare.
for (const bucket of ['media','legacy']) {
  const objects=[];let cursor=null;
  do {
    const url=new URL(worker+'/inventory');url.searchParams.set('bucket',bucket);if(cursor)url.searchParams.set('cursor',cursor);
    const response=await fetch(url,{headers:{authorization:`Bearer ${token}`},signal:AbortSignal.timeout(30000)});
    if(!response.ok)throw new Error(`R2 inventory failed (${bucket}, ${response.status})`);
    const page=await response.json();objects.push(...page.objects);cursor=page.cursor;
  } while(cursor);
  const verified=[];
  for(let i=0;i<objects.length;i+=16) {
    const response=await fetch(`${worker}/verify?bucket=${bucket}`,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},
      body:JSON.stringify(objects.slice(i,i+16).map(x=>x.key)),signal:AbortSignal.timeout(120000)});
    if(!response.ok)throw new Error(`R2 content verification failed (${bucket}, ${response.status})`);
    verified.push(...(await response.json()).objects);
  }
  const mismatches=verified.filter(x=>x.missing || objects.find(o=>o.key===x.key)?.size!==x.size || objects.find(o=>o.key===x.key)?.etag!==x.etag);
  await writeFile(path.join(directory,`r2-${bucket}-${Date.now()}.json`),JSON.stringify({at:new Date().toISOString(),objects,verified,mismatches},null,2),{mode:0o600,flag:'wx'});
  console.log(JSON.stringify({bucket,objects:objects.length,bytes:objects.reduce((sum,x)=>sum+x.size,0),contentHashes:verified.length,mismatches:mismatches.length}));
  if(mismatches.length)process.exitCode=1;
}
if(checks.some(x=>!x.pass))process.exitCode=1;
