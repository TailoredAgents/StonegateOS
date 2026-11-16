// Runs the real pinned Next.js build inside the network-isolated validation image.
// No customer cookies, database credentials or provider keys are supplied.
export const siteCheck = String.raw`
const {spawn}=require('node:child_process');
const {readFileSync}=require('node:fs');
const {createHash}=require('node:crypto');
const {setTimeout:wait}=require('node:timers/promises');
const child=spawn(process.execPath,['apps/site/node_modules/next/dist/bin/next','start','apps/site','--hostname','127.0.0.1','--port','8081'],{
  cwd:'/app',stdio:'ignore',env:{...process.env,PORT:'8081',API_BASE_URL:'http://127.0.0.1:1',NEXT_PUBLIC_API_BASE_URL:'http://127.0.0.1:1',NEXT_TELEMETRY_DISABLED:'1'}
});
let spawnError=false;child.on('error',()=>{spawnError=true;});
(async()=>{
 const checks=[];
 try {
  let ready=false;
  for(let i=0;i<100;i++) {
   if(spawnError || child.exitCode!==null)throw Error('startup_failed');
   try {const r=await fetch('http://127.0.0.1:8081/api/healthz',{signal:AbortSignal.timeout(500)});await r.body?.cancel();if(r.ok){ready=true;break;}}catch{}
   await wait(200);
  }
  if(!ready)throw Error('readiness_timeout');
  for(const route of ['/','/book','/partners/login','/team/login','/mobile/login','/api/healthz']) {
   const r=await fetch('http://127.0.0.1:8081'+route,{redirect:'manual',signal:AbortSignal.timeout(10000)});
   const reader=r.body?.getReader();let bytes=0;const chunks=[];
   if(reader)while(true){const n=await reader.read();if(n.done)break;bytes+=n.value.byteLength;if(bytes>2000000){await reader.cancel();throw Error('response_limit');}chunks.push(Buffer.from(n.value));}
   const body=Buffer.concat(chunks).toString('utf8');
   checks.push({route,status:r.status,bytes,contentType:r.headers.get('content-type'),pass:r.status===200 && bytes>0});
   if(route==='/') {
    const asset=body.match(/src="(\/_next\/static\/[^"?]+\.js)[^"]*"/);
    if(!asset)throw Error('missing_script_asset');
    const a=await fetch('http://127.0.0.1:8081'+asset[1],{signal:AbortSignal.timeout(10000)});await a.body?.cancel();
    checks.push({route:'static-javascript',status:a.status,pass:a.ok});
   }
  }
  const compatibility=JSON.parse(readFileSync('/app/infra/cloudflare/site-action-compatibility.json','utf8'));
  checks.push({route:'existing-form-actions',count:compatibility.existingActionCount,pass:compatibility.ok===true&&compatibility.actionIdsMatch===true&&compatibility.encryptionKeyMatches===true&&compatibility.existingActionCount===202});
  const legacy=JSON.parse(readFileSync('/app/infra/cloudflare/site-legacy-assets.json','utf8'));
  let verified=0;
  for(let offset=0;offset<legacy.length;offset+=4){
   await Promise.all(legacy.slice(offset,offset+4).map(async asset=>{
    const r=await fetch('http://127.0.0.1:8081/_next/static/'+asset.key,{signal:AbortSignal.timeout(10000)});
    const bytes=Buffer.from(await r.arrayBuffer());
    if(r.status!==200||bytes.length!==asset.bytes||createHash('sha256').update(bytes).digest('hex')!==asset.sha256)throw Error('legacy_static_asset_mismatch');
    verified++;
   }));
  }
  checks.push({route:'existing-static-assets',verified,pass:verified===115&&verified===compatibility.legacyAssets});
  const publicConfiguration=JSON.parse(readFileSync('/app/infra/cloudflare/site-public-build-manifest.json','utf8'));
  console.log(JSON.stringify({ok:checks.every(c=>c.pass),checks,publicConfiguration,compatibility}));
  if(checks.some(c=>!c.pass))process.exitCode=1;
 }catch(e){console.log(JSON.stringify({ok:false,error:e.message,checks}));process.exitCode=1;}
 finally{child.kill('SIGTERM');await wait(500);if(child.exitCode===null)child.kill('SIGKILL');}
})();
`;
