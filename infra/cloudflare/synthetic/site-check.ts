// The real site talks to the real synthetic API through a fixed authenticated
// relay. Only server-rendered routes are exercised; no production browser APIs.
export const syntheticSiteCheck = String.raw`
const {spawn}=require('node:child_process');
const {createServer}=require('node:http');
const {setTimeout:wait}=require('node:timers/promises');
const {randomUUID}=require('node:crypto');
const fixture=JSON.parse(process.env.MIGRATION_SITE_FIXTURE);
const probeToken=process.env.MIGRATION_PROBE_TOKEN;
const origin='https://stonegate-synthetic-validation.jeffrey-78e.workers.dev';
if(!/^[a-f0-9]{64}$/.test(fixture.adminKey)||!/^[A-Za-z0-9_-]{32,100}$/.test(fixture.sessionToken)||
  !/^[a-f0-9-]{36}$/.test(fixture.contactId)||!/^[a-f0-9-]{36}$/.test(fixture.memberId))throw Error('Invalid synthetic fixture');
const allowed=new Set(['/api/public/team/session','/api/admin/team/directory','/api/admin/contacts']);
const proxyRequests=[];
const proxy=createServer(async(req,res)=>{
 try {
  const url=new URL(req.url,'http://127.0.0.1');
  if(!(req.method==='GET'||(req.method==='POST'&&url.pathname==='/api/admin/contacts'))||!allowed.has(url.pathname)){res.writeHead(403);res.end();return;}
  const headers=new Headers();
  for(const name of ['authorization','x-api-key','accept','content-type'])if(typeof req.headers[name]==='string')headers.set(name,req.headers[name]);
  headers.set('x-migration-proxy-key',probeToken);
  const upstream=await fetch(origin+'/relay'+url.pathname+url.search,{method:req.method,headers,...(req.method==='POST'?{body:req,duplex:'half'}:{}),signal:AbortSignal.timeout(12000)});
  proxyRequests.push({path:url.pathname,status:upstream.status});
  const body=Buffer.from(await upstream.arrayBuffer());if(body.length>2000000)throw Error('Response too large');
  res.writeHead(upstream.status,{'content-type':upstream.headers.get('content-type')??'application/json','cache-control':'no-store'});res.end(body);
 }catch(error){proxyRequests.push({error:error.code??error.cause?.code??error.name});res.writeHead(502);res.end('{}');}
});
let child;let createdContactId;let createdEmail;const checks=[];
function check(name,pass,extra={}){checks.push({name,pass,...extra});if(!pass)throw Error('CHECK_FAILED:'+name);}
(async()=>{
 try {
  await new Promise(resolve=>proxy.listen(8083,'127.0.0.1',resolve));
  child=spawn(process.execPath,['apps/site/node_modules/next/dist/bin/next','start','apps/site','--hostname','0.0.0.0','--port','8081'],{
   cwd:'/app',stdio:'ignore',env:{PATH:'/usr/local/bin:/usr/bin:/bin',NODE_ENV:'production',DOTENV_CONFIG_PATH:'/dev/null',NEXT_TELEMETRY_DISABLED:'1',PORT:'8081',
    API_BASE_URL:'http://127.0.0.1:8083',ADMIN_API_KEY:fixture.adminKey,NEXT_PUBLIC_API_BASE_URL:'http://127.0.0.1:8083',SITE_URL:origin}});
  let ready=false;for(let i=0;i<100;i++){if(child.exitCode!==null)break;try{const r=await fetch('http://127.0.0.1:8081/api/healthz',{signal:AbortSignal.timeout(500)});await r.body?.cancel();if(r.ok){ready=true;break;}}catch{}await wait(200);}
  check('site-real-next-starts',ready);
  async function get(path,authenticated=true){const r=await fetch(origin+'/site/gateway'+path,{headers:{'x-migration-proxy-key':probeToken,...(authenticated?{cookie:'myst-team-session='+fixture.sessionToken}:{})},redirect:'manual',signal:AbortSignal.timeout(15000)});return{status:r.status,cache:r.headers.get('cache-control'),body:await r.json()};}
  const anonymous=await get('/api/team/directory',false);check('site-anonymous-directory-rejected',anonymous.status===401);
  const directory=await get('/api/team/directory');
  if(fixture.expectedRevoked){check('site-revoked-cookie-rejected',directory.status===401);}
  else {
   check('site-cookie-verifies-through-real-api',directory.status===200&&directory.body.ok&&directory.body.members?.some(row=>row.id===fixture.memberId),{status:directory.status});
   check('site-directory-projection-and-cache',directory.cache?.includes('no-store')&&directory.body.members.every(row=>Object.keys(row).sort().join(',')==='id,name'));
   const contact=await get('/api/team/contacts?contactId='+fixture.contactId);
   check('site-reads-committed-api-contact',contact.status===200&&contact.body.contacts?.some(row=>row.id===fixture.contactId),{status:contact.status});
   createdEmail=randomUUID()+'@migration.invalid';
   const form=new URLSearchParams({firstName:'Synthetic',lastName:'Gateway Migration',email:createdEmail,salespersonMemberId:fixture.memberId,sourceType:'website'});
   async function post(requestOrigin){const r=await fetch(origin+'/site/gateway/api/team/contacts',{method:'POST',headers:{'x-migration-proxy-key':probeToken,cookie:'myst-team-session='+fixture.sessionToken,'content-type':'application/x-www-form-urlencoded',...(requestOrigin?{origin:requestOrigin}:{}),'sec-fetch-site':'same-origin','x-forwarded-host':'attacker.invalid','x-forwarded-proto':'http'},body:form,redirect:'manual',signal:AbortSignal.timeout(15000)});await r.body?.cancel();return r;}
   const foreign=await post('https://attacker.invalid');check('site-gateway-rejects-cross-origin-write',foreign.status===403);
   const missing=await post(null);check('site-gateway-rejects-missing-origin-write',missing.status===403);
   const before=await get('/api/team/contacts?q='+encodeURIComponent(createdEmail));check('rejected-origin-writes-create-no-record',before.status===200&&!before.body.contacts?.some(row=>row.email===createdEmail));
   const created=await post(origin);const destination=created.headers.get('location');
   const location=destination?new URL(destination):null;createdContactId=location?.searchParams.get('created');
   check('site-gateway-cookie-form-write',created.status===303&&location?.origin===origin&&location?.pathname==='/team'&&/^[a-f0-9-]{36}$/.test(createdContactId??''),{status:created.status});
   check('site-gateway-preserves-success-cookie',created.headers.get('set-cookie')?.includes('myst-flash=Contact%20created'));
   const persisted=await get('/api/team/contacts?contactId='+createdContactId);check('site-gateway-reads-back-committed-write',persisted.status===200&&persisted.body.contacts?.some(row=>row.id===createdContactId&&row.email===createdEmail));
  }
  console.log(JSON.stringify({ok:true,checks,createdContactId,createdEmail}));
 }catch(error){console.log(JSON.stringify({ok:false,checks,proxyRequests,failedCheck:error.message?.startsWith('CHECK_FAILED:')?error.message.slice(13):null}));process.exitCode=1;}
 finally{child?.kill('SIGTERM');await wait(500);if(child&&child.exitCode===null)child.kill('SIGKILL');proxy.closeAllConnections();proxy.close();}
})();
`;
