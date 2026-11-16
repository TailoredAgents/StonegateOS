// Production API standby supervisor. Its gateway denies traffic until a separate
// promotion gate is enabled. Startup checks are read-only; no consumer is started.
export const productionApiRuntime = String.raw`
const {spawn}=require('node:child_process');
const {createRequire}=require('node:module');
const {createServer}=require('node:http');
const {createHash,timingSafeEqual,randomUUID}=require('node:crypto');
const {existsSync,mkdtempSync,writeFileSync,readFileSync,rmSync}=require('node:fs');
const {rootCertificates}=require('node:tls');
const {setTimeout:wait}=require('node:timers/promises');
const postgres=createRequire('/app/apps/api/package.json')('postgres');
const envelope=JSON.parse(process.env.SOURCE_API_RUNTIME_CONFIG);
const config=envelope.connection;
if(envelope.environmentParts!==2||!process.env.SOURCE_API_ENV_1||!process.env.SOURCE_API_ENV_2)throw Error('MISSING_ENVIRONMENT_PARTS');
const sourceEnvironment=JSON.parse(process.env.SOURCE_API_ENV_1+process.env.SOURCE_API_ENV_2);
const environmentSha256=createHash('sha256').update(JSON.stringify(Object.entries(sourceEnvironment).sort(([a],[b])=>a.localeCompare(b)))).digest('hex');
if(envelope.purpose!=='source-api-production-standby'||envelope.service!=='srv-d43o7k0dl3ps73a4rhu0'||envelope.sourceRevision!=='0e66a789ea1c33b297aa5f1324571904c3fa2894'||environmentSha256!==envelope.environmentSha256||sourceEnvironment.NODE_ENV!=='production'||sourceEnvironment.SITE_URL!=='https://stonegatejunkremoval.com'||sourceEnvironment.TWILIO_WEBHOOK_PUBLIC_BASE_URL!=='https://stonegate-api.onrender.com'||!sourceEnvironment.ADMIN_API_KEY)throw Error('INVALID_SOURCE_RUNTIME_SETTINGS');
const originalDatabase=new URL(sourceEnvironment.DATABASE_URL);
if(originalDatabase.hostname!==config.host||decodeURIComponent(originalDatabase.username)!==config.user||decodeURIComponent(originalDatabase.password)!==config.password||originalDatabase.pathname!=='/stonegate')throw Error('SOURCE_DATABASE_SETTINGS_MISMATCH');
if(config.purpose!=='source-production-connection'||config.user!=='stonegate_rot_20260921'||config.database!=='stonegate'||config.host!=='dpg-d43o7c0dl3ps73a4rb4g-a'||config.rejectUnauthorized!==true||!(Date.parse(config.expiresAt)>Date.now()))throw Error('INVALID_PRODUCTION_SOURCE');
const runtimeKey=process.env.MIGRATION_PROBE_TOKEN;if(!runtimeKey||runtimeKey.length<32)throw Error('MISSING_PRIVATE_RUNTIME_KEY');
const directory=mkdtempSync('/tmp/stonegate-api-runtime-');
const managedCa='/etc/cloudflare/certs/cloudflare-containers-ca.crt';
const caFile=directory+'/roots.pem';
writeFileSync(caFile,rootCertificates.join('\n')+'\n'+(existsSync(managedCa)?readFileSync(managedCa,'utf8'):''),{mode:0o600});
const generation=randomUUID();
const runtimeSha256=createHash('sha256').update(process.execArgv[process.execArgv.indexOf('-e')+1]).digest('hex');
let relay,application,sql,server,stopping=false,restartTimer,scopeVerified=false;
const restarts=[];
let startupStage='settings-verified',failure=null,lastDatabaseError=null,scopeChecks=null;
function errorCode(error){const code=String(error?.code??'');return ['ECONNREFUSED','ECONNRESET','ETIMEDOUT','CONNECT_TIMEOUT','CONNECTION_CLOSED','CONNECTION_DESTROYED','28P01','28000','42501','42809','42P01','57014','57P03','53300','CERT_HAS_EXPIRED','UNABLE_TO_VERIFY_LEAF_SIGNATURE','ERR_TLS_CERT_ALTNAME_INVALID'].includes(code)?code:'UNCLASSIFIED';}
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
  restartTimer=setTimeout(()=>{if(stopping)return;restarts.push(Date.now());startRelay();},1000);
 }
 relay.once('exit',stopped);relay.once('error',stopped);
}
 server=createServer((request,response)=>{
  const supplied=String(request.headers['x-runtime-key']??'');
  if(supplied.length>512||!timingSafeEqual(createHash('sha256').update(supplied).digest(),createHash('sha256').update(runtimeKey).digest())){response.writeHead(401).end();return;}
  response.setHeader('content-type','application/json');response.setHeader('cache-control','no-store');
  if(request.method==='GET'&&request.url==='/state'){
   response.end(JSON.stringify({generation,runtimeSha256,environmentSha256,scopeVerified,effectiveRole:scopeVerified?'stonegate':null,loginRole:scopeVerified?config.user:null,existingOwnerCreatePermissions:scopeVerified,startupStage,failure,lastDatabaseError,scopeChecks,readOnly:false,credentialExpiresAt:config.expiresAt,stopping,relayRunning:alive(relay),apiRunning:alive(application),relayRestarts:restarts.length}));return;
  }
  response.writeHead(404).end(JSON.stringify({error:'not_found'}));
 });
 server.listen(8084,'0.0.0.0');
(async()=>{try{
 startupStage='database-connection';
 startRelay();
 sql=postgres({host:'127.0.0.1',port:6543,user:config.user,password:config.password,database:config.database,max:1,prepare:false,connect_timeout:5,
  ssl:{ca:config.ca,servername:config.servername,rejectUnauthorized:true},onnotice(){},connection:{statement_timeout:10000,application_name:'stonegate-production-api-standby'}});
 for(let i=0;i<8&&!stopping;i++){
  try{
   const [scope]=await sql.unsafe("select current_database() as database,current_user as role,session_user as login_role,current_setting('transaction_read_only') as read_only,(select ssl from pg_stat_ssl where pid=pg_backend_pid()) as tls,(select count(*)::int from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','drizzle') and c.relkind in ('r','p') and case when c.relkind in ('r','p') then has_table_privilege(current_user,c.oid,'INSERT,UPDATE,DELETE,TRUNCATE') else false end) as writable_tables,(select count(*)::int from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','drizzle') and c.relkind='S' and case when c.relkind='S' then has_sequence_privilege(current_user,c.oid,'USAGE,UPDATE') else false end) as writable_sequences,(select rolsuper or rolbypassrls from pg_roles where rolname=current_user) as unsafe_role,(select rolcreaterole and rolcreatedb and not rolcanlogin from pg_roles where rolname=current_user) as expected_owner_permissions");
   scopeChecks={database:scope.database===config.database,role:scope.role==='stonegate',loginRole:scope.login_role===config.user,readWrite:scope.read_only==='off',tls:scope.tls===true,tables:scope.writable_tables===230,sequences:scope.writable_sequences===1,notSuperuserOrBypass:scope.unsafe_role===false,existingOwnerPermissions:scope.expected_owner_permissions===true};
   if(scope.database!==config.database||scope.role!=='stonegate'||scope.login_role!==config.user||scope.read_only!=='off'||scope.tls!==true||scope.writable_tables!==230||scope.writable_sequences!==1||scope.unsafe_role!==false||scope.expected_owner_permissions!==true)throw Object.assign(Error('SOURCE_SCOPE_MISMATCH'),{fatal:true});
   scopeVerified=true;lastDatabaseError=null;break;
  }catch(e){if(e.fatal)throw e;lastDatabaseError=errorCode(e);await wait(500);}
 }
 if(!scopeVerified||stopping)throw Error('SOURCE_NOT_READY');
 await sql.end({timeout:2});sql=undefined;
 const url=new URL('postgres://127.0.0.1:6543/'+config.database);url.username=config.user;url.password=config.password;
 const environment={...sourceEnvironment,PATH:'/usr/local/bin:/usr/bin:/bin',NODE_ENV:'production',PORT:'8080',DOTENV_CONFIG_PATH:'/dev/null',NEXT_TELEMETRY_DISABLED:'1',
  NODE_EXTRA_CA_CERTS:managedCa,DATABASE_URL:url.href,DATABASE_SSL:'true',DATABASE_SSL_CA:config.ca,DATABASE_SSL_SERVERNAME:config.servername};
 startupStage='application-start';
 application=spawn(process.execPath,['/app/apps/api/node_modules/next/dist/bin/next','start','/app/apps/api','--hostname','0.0.0.0','--port','8080'],{cwd:'/app',env:environment,stdio:'ignore'});
 application.once('exit',()=>{if(!stopping)void finish(1);});application.once('error',()=>void finish(1));

 startupStage='application-running';
}catch(error){failure=['SOURCE_SCOPE_MISMATCH','SOURCE_NOT_READY'].includes(error?.message)?error.message:'STARTUP_FAILED';console.error(JSON.stringify({event:'production_api_standby_failed',startupStage,failure,lastDatabaseError,scopeChecks}));setTimeout(()=>void finish(1),30000);}})();
`;
