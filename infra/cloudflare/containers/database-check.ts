// Fixed read-only trial through the official Access TCP client. The PostgreSQL
// certificate is obtained over authenticated Render SSH and trusted explicitly.
export const databaseCheck = String.raw`
const {spawn}=require('node:child_process');
const {createRequire}=require('node:module');
const {existsSync,mkdtempSync,writeFileSync,readFileSync,rmSync}=require('node:fs');
const {rootCertificates}=require('node:tls');
const {setTimeout:wait}=require('node:timers/promises');
const postgres=createRequire('/app/apps/api/package.json')('postgres');
const isSource=process.env.MIGRATION_SOURCE_READINESS==='1';
const config=JSON.parse(isSource?process.env.MIGRATION_SOURCE_CONNECTION:process.env.MIGRATION_RESTORE_CONNECTION);
if(isSource){if(config.user!=='stonegate_source_probe_ro'||config.purpose!=='source-readiness-read-only'||Date.parse(config.expiresAt)<=Date.now())throw Error('Unexpected source readiness target');}
else if(!config.database.startsWith('stonegate_restore_') || config.user!=='stonegate_validation_ro')throw Error('Unexpected restore target');
const hostname=isSource?'migration-live-db.stonegatejunkremoval.com':'migration-db.stonegatejunkremoval.com';
// The slim Node image has Node's CA roots but no system PEM bundle for Go.
// Export the exact bundled roots for cloudflared; TLS verification stays enabled.
const caDirectory=mkdtempSync('/tmp/stonegate-validation-ca-');
const managedCa='/etc/cloudflare/certs/cloudflare-containers-ca.crt';
const caFile=caDirectory+'/roots.pem';
writeFileSync(caFile,rootCertificates.join('\n')+'\n'+(existsSync(managedCa)?readFileSync(managedCa,'utf8'):''),{mode:0o600});
let tunnelLog='';let tunnelError=false;
function startTunnel(){const child=spawn('/usr/local/bin/cloudflared',['access','tcp','--hostname',hostname,'--url','127.0.0.1:6543'],{
 stdio:['ignore','ignore','pipe'],env:{SSL_CERT_FILE:caFile,TUNNEL_SERVICE_TOKEN_ID:config.client_id,TUNNEL_SERVICE_TOKEN_SECRET:config.client_secret}
});
child.stderr.on('data',chunk=>{if(tunnelLog.length<8192)tunnelLog+=chunk.toString('utf8').slice(0,8192-tunnelLog.length);});
child.on('error',()=>{tunnelError=true;});return child;}
let tunnel=startTunnel();let application;let applicationLog='';
function diagnostics(){let text=tunnelLog;for(const value of [config.client_id,config.client_secret,config.password])text=text.split(value).join('[REDACTED]');return {
 caBundlePresent:existsSync('/etc/ssl/certs/ca-certificates.crt'),managedCaPresent:existsSync(managedCa),rootCertificateCount:rootCertificates.length,
 applicationExitCode:application?.exitCode,applicationSignal:application?.signalCode,
 applicationErrorFlags:['certificate','ECONNREFUSED','ECONNRESET','heap out of memory','api_check_failed'].filter(x=>applicationLog.includes(x)),
 memoryEvents:existsSync('/sys/fs/cgroup/memory.events')?readFileSync('/sys/fs/cgroup/memory.events','utf8').slice(0,400):null,
 tunnelLog:text.replace(/https?:\/\/\S+/g,'[URL]').replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,'[JWT]').slice(-4000)};}
const options={host:'127.0.0.1',port:6543,user:config.user,password:config.password,database:config.database,max:1,
 connect_timeout:8,idle_timeout:1,connection:{statement_timeout:10000},
 ssl:{ca:config.ca,servername:config.servername,rejectUnauthorized:true}};
(async()=>{
 const checks=[];let sql;
 try {
  await wait(750);
  if(tunnelError || tunnel.exitCode!==null)throw Error('Tunnel startup failed');
  sql=postgres(options);
  for(let i=0;i<3;i++) {
   const start=performance.now();
   const [state]=await sql.unsafe("select current_database() as database,current_user as role,current_setting('transaction_read_only') as read_only,"+
    "(select ssl from pg_stat_ssl where pid=pg_backend_pid()) as tls,"+
    "has_table_privilege(current_user,'public.contacts','INSERT,UPDATE,DELETE') as can_write_contacts,"+
    "(select count(*)::int from public.contacts) as contacts,"+
    "(select count(*)::int from public.appointments) as appointments,"+
    "(select count(*)::int from public.outbox_events) as outbox_events");
   const pass=state.database===config.database && state.role===config.user && state.read_only==='on' && state.tls===true && state.can_write_contacts===false &&
    ['contacts','appointments','outbox_events'].every(key=>isSource?Number.isSafeInteger(state[key])&&state[key]>=0:state[key]===config.expected[key]);
   checks.push({name:'read-only-private-query',pass,ms:Math.round(performance.now()-start)});
  }
  // Interrupt the authenticated local relay while a pool connection is open.
  // Only fixed SELECTs may retry; no mutation retry policy is implied here.
  tunnel.kill('SIGTERM');await wait(500);
  try{await sql.unsafe('select 1');checks.push({name:'connection-fails-during-relay-outage',pass:false});}
  catch(e){checks.push({name:'connection-fails-during-relay-outage',pass:['ECONNRESET','ECONNREFUSED','CONNECTION_CLOSED','CONNECTION_ENDED','CONNECT_TIMEOUT'].includes(e.code)});}
  tunnel=startTunnel();await wait(750);
  let recovered=false;
  for(let attempt=0;attempt<5;attempt++) {
   try{const [row]=await sql.unsafe("select current_database() as database,current_user as role,current_setting('transaction_read_only') as read_only");recovered=row.database===config.database&&row.role===config.user&&row.read_only==='on';if(recovered)break;}
   catch{}await wait(500);
  }
  checks.push({name:'same-pool-recovers-after-relay-restart',pass:recovered});
  await sql.end();sql=undefined;
  const invalid=postgres({...options,ssl:{...options.ssl,servername:'incorrect-hostname.invalid'}});
  try{await invalid.unsafe('select 1');checks.push({name:'reject-wrong-certificate-identity',pass:false});}
  catch(e){checks.push({name:'reject-wrong-certificate-identity',pass:e.code==='ERR_TLS_CERT_ALTNAME_INVALID'});}
  finally{await invalid.end({timeout:2});}
  if(process.env.MIGRATION_CHECK_API==='1') {
   const databaseUrl=new URL('postgres://127.0.0.1:6543/'+config.database);databaseUrl.username=config.user;databaseUrl.password=config.password;
   application=spawn(process.execPath,['apps/api/node_modules/next/dist/bin/next','start','apps/api','--hostname','127.0.0.1','--port','8082'],{
    cwd:'/app',stdio:['ignore','ignore','pipe'],env:{PATH:'/usr/local/bin:/usr/bin:/bin',DOTENV_CONFIG_PATH:'/dev/null',PORT:'8082',NODE_ENV:'production',DATABASE_URL:databaseUrl.href,
     DATABASE_SSL:'true',DATABASE_SSL_CA:config.ca,DATABASE_SSL_SERVERNAME:config.servername,
     ADMIN_API_KEY:'restore-only-synthetic-admin-key-not-production',TEAM_AUTH_RATE_LIMIT_SECRET:'restore-only-synthetic-team-rate-limit-secret',
     SITE_URL:'https://restore-validation.invalid',TEAM_KILL_EXTERNAL_SENDS:'true',TEAM_KILL_OUTBOX_DISPATCH:'true',TEAM_KILL_FINANCIAL_MUTATIONS:'true',
     TEAM_KILL_ADVERTISING_CHANGES:'true',TEAM_KILL_PUBLISHING:'true',TEAM_KILL_DESTRUCTIVE_MUTATIONS:'true',NEXT_TELEMETRY_DISABLED:'1'}
   });
   application.stderr.on('data',chunk=>{if(applicationLog.length<32768)applicationLog+=chunk.toString('utf8').slice(0,32768-applicationLog.length);});
   let ready=false;
   for(let attempt=0;attempt<100;attempt++) {
    if(application.exitCode!==null)throw Error('API_STARTUP_FAILED');
    try{const r=await fetch('http://127.0.0.1:8082/api/healthz',{signal:AbortSignal.timeout(500)});await r.body?.cancel();if(r.ok){ready=true;break;}}catch{}
    await wait(200);
   }
   checks.push({name:'pinned-api-starts',pass:ready});
   if(!ready)throw Error('API_STARTUP_TIMEOUT');
   const readiness=await fetch('http://127.0.0.1:8082/api/readyz',{signal:AbortSignal.timeout(15000)});
   const state=await readiness.json();
   checks.push({name:'pinned-api-verified-database-query',pass:state.checks?.database?.state==='ok'});
   checks.push({name:'pinned-api-migration-journal',pass:state.checks?.migrations?.state==='ok'});
   const rejected=await fetch('http://127.0.0.1:8082/api/admin/policy',{signal:AbortSignal.timeout(5000)});await rejected.body?.cancel();
   checks.push({name:'pinned-api-rejects-unauthenticated-admin',pass:rejected.status===401});
   // Overall readiness is not asserted: provider keys and an active dispatcher
   // are intentionally absent, and restored queue timestamps are historical.
  }
  console.log(JSON.stringify({ok:checks.every(x=>x.pass),checks}));
  if(checks.some(x=>!x.pass))process.exitCode=1;
 }catch(e){const code=typeof e.code==='string' && /^[A-Z0-9_]{1,50}$/.test(e.code)?e.code:e.name==='TimeoutError'?'PROBE_REQUEST_TIMEOUT':'DATABASE_PROBE_FAILED';console.log(JSON.stringify({ok:false,code,checks,diagnostics:diagnostics()}));process.exitCode=1;}
 finally{if(sql)await sql.end({timeout:2});application?.kill('SIGTERM');tunnel.kill('SIGTERM');await wait(500);if(application&&application.exitCode===null)application.kill('SIGKILL');if(tunnel.exitCode===null)tunnel.kill('SIGKILL');rmSync(caDirectory,{recursive:true,force:true});}
})();
`;
