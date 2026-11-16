// Fixed read-only checks against the separate PlanetScale recovery copy.
// No customer values, SQL text or credentials are returned in diagnostics.
export const targetCheck = String.raw`
const {spawn}=require('node:child_process');
const {createRequire}=require('node:module');
const {setTimeout:wait}=require('node:timers/promises');
const postgres=createRequire('/app/apps/api/package.json')('postgres');
const config=JSON.parse(process.env.MIGRATION_TARGET_CONNECTION);
if(config.purpose!=='target-readiness-read-only'||config.database!=='stonegate_restore_20261116'||
 !config.host.endsWith('.psdb.cloud')||config.sqlRole!=='stonegate_target_probe_ro'||
 !config.user.startsWith(config.sqlRole+'.')||Date.parse(config.expiresAt)<=Date.now())throw Error('Invalid target');
const options={host:config.host,port:config.port,user:config.user,password:config.password,database:config.database,
 max:1,prepare:false,connect_timeout:10,onnotice:()=>{},ssl:{rejectUnauthorized:true},
 connection:{application_name:'stonegate-target-readiness',statement_timeout:15000}};
const clients=[];const open=(extra={})=>{const c=postgres({...options,...extra});clients.push(c);return c;};
const checks=[];let application;let applicationErrors='';
const check=(name,pass,details={})=>{checks.push({name,pass,...details});if(!pass)throw Error('CHECK_FAILED');};
(async()=>{
 try{
  let sql=open();
  const [state]=await sql.unsafe("select current_database() as database,current_user as role,current_setting('transaction_read_only') as read_only,"+
   "(select count(*)::int from contacts) as contacts,(select count(*)::int from appointments) as appointments,(select count(*)::int from outbox_events) as outbox_events");
  check('restored-database-role-and-counts',state.database===config.database&&state.role===config.sqlRole&&state.read_only==='on'&&
   ['contacts','appointments','outbox_events'].every(k=>state[k]===config.expected[k]));
  const bad=open({ssl:{rejectUnauthorized:true,servername:'wrong-certificate.invalid'}});
  let rejected=false;try{await bad.unsafe('select 1');}catch(e){rejected=e.code==='ERR_TLS_CERT_ALTNAME_INVALID';}finally{await bad.end({timeout:2});}
  check('wrong-certificate-name-rejected',rejected);
  let writesRejected=false;
  try{await sql.begin('read write',tx=>tx.unsafe('update public.contacts set id=id where false'));}catch(e){writesRejected=e.code==='42501';}
  check('table-permissions-block-writes-even-in-read-write-transaction',writesRejected);
  const controller=open();const [{pid}]=await sql.unsafe('select pg_backend_pid() as pid');
  const [{stopped}]=await controller.unsafe('select pg_terminate_backend($1) as stopped',[pid]);
  check('terminate-only-own-probe-session',stopped===true);await wait(200);
  let recovered=false;
  for(let i=0;i<4;i++){try{const [r]=await sql.unsafe('select current_user as role,pg_backend_pid() as pid');recovered=r.role===config.sqlRole&&r.pid!==pid;if(recovered)break;}catch{}await wait(250);}
  check('same-pool-reconnects-after-session-loss',recovered);
  await controller.end({timeout:2});await sql.end({timeout:2});
  sql=open({max:4});const timings=[];
  const concurrent=await Promise.all(Array.from({length:4},async()=>{
   for(let i=0;i<20;i++){const at=performance.now();const [row]=await sql.unsafe('select (select count(*)::int from contacts) as contacts,(select count(*)::int from appointments) as appointments');
    if(row.contacts!==config.expected.contacts||row.appointments!==config.expected.appointments)return false;timings.push(Math.round(performance.now()-at));}return true;
  }));
  timings.sort((a,b)=>a-b);
  check('four-connection-80-read-trial',concurrent.every(Boolean),{queries:timings.length,p50Ms:timings[Math.floor(timings.length*.5)],p95Ms:timings[Math.floor(timings.length*.95)],maxMs:timings.at(-1)});
  await sql.end({timeout:2});
  const databaseUrl=new URL('postgres://'+config.host+':'+config.port+'/'+config.database);databaseUrl.username=config.user;databaseUrl.password=config.password;
  application=spawn(process.execPath,['apps/api/node_modules/next/dist/bin/next','start','apps/api','--hostname','127.0.0.1','--port','8082'],{
   cwd:'/app',stdio:['ignore','ignore','pipe'],env:{PATH:'/usr/local/bin:/usr/bin:/bin',DOTENV_CONFIG_PATH:'/dev/null',PORT:'8082',NODE_ENV:'production',DATABASE_URL:databaseUrl.href,
    DATABASE_SSL:'true',DATABASE_SSL_SERVERNAME:config.host,ADMIN_API_KEY:'target-only-synthetic-admin-key-not-production',TEAM_AUTH_RATE_LIMIT_SECRET:'target-only-synthetic-rate-limit-secret',
    SITE_URL:'https://target-validation.invalid',TEAM_KILL_EXTERNAL_SENDS:'true',TEAM_KILL_OUTBOX_DISPATCH:'true',TEAM_KILL_FINANCIAL_MUTATIONS:'true',
    TEAM_KILL_ADVERTISING_CHANGES:'true',TEAM_KILL_PUBLISHING:'true',TEAM_KILL_DESTRUCTIVE_MUTATIONS:'true',NEXT_TELEMETRY_DISABLED:'1'}});
  application.stderr.on('data',chunk=>{if(applicationErrors.length<8192)applicationErrors+=chunk.toString().slice(0,8192-applicationErrors.length);});
  let ready=false;
  for(let i=0;i<100;i++){if(application.exitCode!==null)break;try{const r=await fetch('http://127.0.0.1:8082/api/healthz',{signal:AbortSignal.timeout(500)});await r.body?.cancel();if(r.ok){ready=true;break;}}catch{}await wait(200);}
  check('actual-api-image-starts',ready);
  const response=await fetch('http://127.0.0.1:8082/api/readyz',{signal:AbortSignal.timeout(15000)});const body=await response.json();
  check('actual-api-verified-target-query',body.checks?.database?.state==='ok');
  check('actual-api-migration-journal-parity',body.checks?.migrations?.state==='ok');
  const denied=await fetch('http://127.0.0.1:8082/api/admin/policy',{signal:AbortSignal.timeout(5000)});await denied.body?.cancel();
  check('actual-api-admin-requires-authentication',denied.status===401);
  console.log(JSON.stringify({ok:true,checks,productionTouched:false,representativeCapacityTest:false}));
 }catch(e){const code=typeof e.code==='string'&&/^[A-Z0-9_]{1,50}$/.test(e.code)?e.code:'TARGET_PROBE_FAILED';
  console.log(JSON.stringify({ok:false,code,checks,applicationErrorFlags:['certificate','ECONNRESET','heap out of memory','too many connections'].filter(x=>applicationErrors.includes(x))}));process.exitCode=1;
 }finally{await Promise.all(clients.map(c=>c.end({timeout:2}).catch(()=>{})));application?.kill('SIGTERM');await wait(500);if(application&&application.exitCode===null)application.kill('SIGKILL');}
})();
`;
