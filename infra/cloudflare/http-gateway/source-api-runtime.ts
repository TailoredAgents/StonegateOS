// Persistent source-connection rehearsal. Credentials are SELECT-only, provider
// sends are disabled, and no production application credentials are accepted.
export const sourceApiRuntime = String.raw`
const {spawn}=require('node:child_process');
const {createRequire}=require('node:module');
const {createServer}=require('node:http');
const {createHash,timingSafeEqual,randomUUID}=require('node:crypto');
const {existsSync,mkdtempSync,writeFileSync,readFileSync,rmSync}=require('node:fs');
const {rootCertificates}=require('node:tls');
const {setTimeout:wait}=require('node:timers/promises');
const postgres=createRequire('/app/apps/api/package.json')('postgres');
const config=JSON.parse(process.env.MIGRATION_SOURCE_CONNECTION);
if(config.purpose!=='source-readiness-read-only'||config.user!=='stonegate_source_probe_ro'||config.host!=='dpg-d43o7c0dl3ps73a4rb4g-a'||config.rejectUnauthorized!==true||!(Date.parse(config.expiresAt)>Date.now()))throw Error('INVALID_READ_ONLY_SOURCE');
const runtimeKey=process.env.MIGRATION_PROBE_TOKEN;if(!runtimeKey||runtimeKey.length<32)throw Error('MISSING_PRIVATE_RUNTIME_KEY');
const directory=mkdtempSync('/tmp/stonegate-api-runtime-');
const managedCa='/etc/cloudflare/certs/cloudflare-containers-ca.crt';
const caFile=directory+'/roots.pem';
writeFileSync(caFile,rootCertificates.join('\n')+'\n'+(existsSync(managedCa)?readFileSync(managedCa,'utf8'):''),{mode:0o600});
const generation=randomUUID();
const runtimeSha256=createHash('sha256').update(process.execArgv[process.execArgv.indexOf('-e')+1]).digest('hex');
let relay,application,sql,server,stopping=false,restartTimer,forcedRelayDelayUntil=0,scopeVerified=false;
const restarts=[];
function alive(child){return Boolean(child&&child.exitCode===null&&child.signalCode===null);}
async function finish(code){
 if(stopping)return;stopping=true;clearTimeout(restartTimer);
 server?.close();
 if(alive(application)){
  application.kill('SIGTERM');
  for(let i=0;i<120&&alive(application);i++)await wait(100);
  if(alive(application)){application.kill('SIGKILL');code=1;}
 }
 if(alive(relay))relay.kill('SIGTERM');
 if(sql)await sql.end({timeout:2}).catch(()=>{});
 for(let i=0;i<20&&alive(relay);i++)await wait(100);
 if(alive(relay))relay.kill('SIGKILL');
 rmSync(directory,{recursive:true,force:true});
 process.exit(code);
}
process.on('SIGTERM',()=>void finish(0));process.on('SIGINT',()=>void finish(0));
function startRelay(){
 if(stopping)return;
 relay=spawn('/usr/local/bin/cloudflared',['access','tcp','--hostname','migration-live-db.stonegatejunkremoval.com','--url','127.0.0.1:6543'],{stdio:'ignore',env:{SSL_CERT_FILE:caFile,TUNNEL_SERVICE_TOKEN_ID:config.client_id,TUNNEL_SERVICE_TOKEN_SECRET:config.client_secret}});
 let handled=false;
 function stopped(){
  if(handled||stopping)return;handled=true;
  const recent=restarts.filter(at=>at>Date.now()-3600000);
  if(recent.length>=3){void finish(1);return;}
  restartTimer=setTimeout(()=>{if(stopping)return;restarts.push(Date.now());startRelay();},Math.max(1000,forcedRelayDelayUntil-Date.now()));
 }
 relay.once('exit',stopped);relay.once('error',stopped);
}
(async()=>{try{
 startRelay();
 sql=postgres({host:'127.0.0.1',port:6543,user:config.user,password:config.password,database:config.database,max:1,prepare:false,connect_timeout:5,
  ssl:{ca:config.ca,servername:config.servername,rejectUnauthorized:true},onnotice(){},connection:{statement_timeout:10000,application_name:'stonegate-source-runtime-readiness'}});
 for(let i=0;i<8&&!stopping;i++){
  try{
   const [scope]=await sql.unsafe("select current_database() as database,current_user as role,current_setting('transaction_read_only') as read_only,(select ssl from pg_stat_ssl where pid=pg_backend_pid()) as tls,(select count(*)::int from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','drizzle') and c.relkind in ('r','p') and has_table_privilege(current_user,c.oid,'INSERT,UPDATE,DELETE,TRUNCATE')) as writable_tables,(select count(*)::int from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','drizzle') and c.relkind='S' and has_sequence_privilege(current_user,c.oid,'USAGE,UPDATE')) as writable_sequences,(select rolsuper or rolcreaterole or rolcreatedb or rolbypassrls from pg_roles where rolname=current_user) as elevated_role");
   if(scope.database!==config.database||scope.role!==config.user||scope.read_only!=='on'||scope.tls!==true||scope.writable_tables!==0||scope.writable_sequences!==0||scope.elevated_role!==false)throw Object.assign(Error('SOURCE_SCOPE_MISMATCH'),{fatal:true});
   scopeVerified=true;break;
  }catch(e){if(e.fatal)throw e;await wait(500);}
 }
 if(!scopeVerified||stopping)throw Error('SOURCE_NOT_READY');
 await sql.end({timeout:2});sql=undefined;
 const url=new URL('postgres://127.0.0.1:6543/'+config.database);url.username=config.user;url.password=config.password;
 const environment={PATH:'/usr/local/bin:/usr/bin:/bin',NODE_ENV:'production',PORT:'8080',DOTENV_CONFIG_PATH:'/dev/null',NEXT_TELEMETRY_DISABLED:'1',
  NODE_EXTRA_CA_CERTS:managedCa,DATABASE_URL:url.href,DATABASE_SSL:'true',DATABASE_SSL_CA:config.ca,DATABASE_SSL_SERVERNAME:config.servername,
  ADMIN_API_KEY:'isolated-source-runtime-synthetic-key-only',TEAM_AUTH_RATE_LIMIT_SECRET:'isolated-source-runtime-synthetic-rate-limit-key',
  SITE_URL:'https://source-runtime.invalid',TEAM_KILL_EXTERNAL_SENDS:'true',TEAM_KILL_OUTBOX_DISPATCH:'true',TEAM_KILL_FINANCIAL_MUTATIONS:'true',
  TEAM_KILL_ADVERTISING_CHANGES:'true',TEAM_KILL_PUBLISHING:'true',TEAM_KILL_DESTRUCTIVE_MUTATIONS:'true'};
 application=spawn(process.execPath,['/app/apps/api/node_modules/next/dist/bin/next','start','/app/apps/api','--hostname','0.0.0.0','--port','8080'],{cwd:'/app',env:environment,stdio:'ignore'});
 application.once('exit',()=>{if(!stopping)void finish(1);});application.once('error',()=>void finish(1));
 server=createServer((request,response)=>{
  const supplied=String(request.headers['x-runtime-key']??'');
  if(supplied.length>512||!timingSafeEqual(createHash('sha256').update(supplied).digest(),createHash('sha256').update(runtimeKey).digest())){response.writeHead(401).end();return;}
  response.setHeader('content-type','application/json');response.setHeader('cache-control','no-store');
  if(request.method==='GET'&&request.url==='/state'){
   response.end(JSON.stringify({generation,runtimeSha256,scopeVerified,stopping,relayRunning:alive(relay),apiRunning:alive(application),relayRestarts:restarts.length}));return;
  }
  if(request.method==='POST'&&request.url==='/interrupt-relay'&&alive(relay)&&!stopping){
   forcedRelayDelayUntil=Date.now()+3000;relay.kill('SIGKILL');response.end(JSON.stringify({interruptionRequested:true,generation}));return;
  }
  response.writeHead(404).end(JSON.stringify({error:'not_found'}));
 });
 server.listen(8084,'0.0.0.0');
}catch{console.error(JSON.stringify({event:'source_api_runtime_failed'}));await finish(1);}})();
`;
