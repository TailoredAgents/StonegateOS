import { readFile,writeFile } from 'node:fs/promises';
import path from 'node:path';
const directory=process.argv[2];
if(!directory)throw new Error('Private evidence directory required');
const token=(await readFile(path.join(directory,'probe-token'),'utf8')).trim();
const origin='https://stonegate-container-validation.jeffrey-78e.workers.dev';
const manifest=JSON.parse(await readFile(new URL('../../infra/cloudflare/source-manifest.json',import.meta.url),'utf8'));
const config=JSON.parse(await readFile(new URL('../../infra/cloudflare/containers/wrangler.jsonc',import.meta.url),'utf8'));
const results=[];
const unauthorized=await fetch(origin+'/api/api/healthz');
results.push({check:'reject-unauthenticated',pass:unauthorized.status===401,status:unauthorized.status});
await unauthorized.body?.cancel();
async function check(service,route,method='GET') {
  const start=performance.now();
  const response=await fetch(`${origin}/${service}/${route}`,{method,headers:{authorization:`Bearer ${token}`},signal:AbortSignal.timeout(90000)});
  const body=await response.json();
  const result={service,route,method,status:response.status,ms:Math.round(performance.now()-start),body,pass:response.ok};
  if(route==='api/healthz' || route==='native-check')result.pass&&=body.source===manifest.services[service];
  if(route==='native-check')result.pass&&=body.argon2===true&&body.sharpBytes>0&&body.pdfBytes>0&&body.node==='v'+manifest.runtime;
  if(route==='image') {
    const binding=config.durable_objects.bindings.find(x=>x.name===service.toUpperCase());
    const image=config.containers.find(x=>x.class_name===binding.class_name).images.base.image;
    result.pass&&=body.image===image;
  }
  results.push(result);
  console.log(JSON.stringify({service,route,status:response.status,pass:result.pass,ms:result.ms}));
  if(!result.pass)throw new Error(`${service} ${route} failed`);
}
const settled=await Promise.allSettled(Object.keys(manifest.services).map(async service=>{
  await check(service,'api/healthz');
  await check(service,'image');
  await check(service,'native-check','POST');
  // Only diagnostic processes run in these containers; killing them cannot dispatch jobs.
  await check(service,'stop','POST');
  await check(service,'api/healthz');
  await check(service,'native-check','POST');
  await check(service,'stop','POST');
}));
for(let i=0;i<settled.length;i++)if(settled[i].status==='rejected')results.push({service:Object.keys(manifest.services)[i],pass:false,error:settled[i].reason.message});
await writeFile(path.join(directory,`container-validation-${Date.now()}.json`),JSON.stringify({at:new Date().toISOString(),results},null,2),{mode:0o600,flag:'wx'});
console.log(JSON.stringify({checks:results.length,failures:results.filter(x=>!x.pass).length}));
if(results.some(x=>!x.pass))process.exitCode=1;
