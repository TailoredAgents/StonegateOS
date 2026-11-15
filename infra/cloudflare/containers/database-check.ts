// Fixed read-only trial through the official Access TCP client. The PostgreSQL
// certificate is obtained over authenticated Render SSH and trusted explicitly.
export const databaseCheck = String.raw`
const {spawn}=require('node:child_process');
const {createRequire}=require('node:module');
const {existsSync,mkdtempSync,writeFileSync,readFileSync,rmSync}=require('node:fs');
const {rootCertificates}=require('node:tls');
const {setTimeout:wait}=require('node:timers/promises');
const postgres=createRequire('/app/apps/api/package.json')('postgres');
const config=JSON.parse(process.env.MIGRATION_RESTORE_CONNECTION);
if(!config.database.startsWith('stonegate_restore_') || config.user!=='stonegate_validation_ro')throw Error('Unexpected restore target');
// The slim Node image has Node's CA roots but no system PEM bundle for Go.
// Export the exact bundled roots for cloudflared; TLS verification stays enabled.
const caDirectory=mkdtempSync('/tmp/stonegate-validation-ca-');
const managedCa='/etc/cloudflare/certs/cloudflare-containers-ca.crt';
const caFile=caDirectory+'/roots.pem';
writeFileSync(caFile,rootCertificates.join('\n')+'\n'+(existsSync(managedCa)?readFileSync(managedCa,'utf8'):''),{mode:0o600});
const tunnel=spawn('/usr/local/bin/cloudflared',['access','tcp','--hostname','migration-db.stonegatejunkremoval.com','--url','127.0.0.1:6543'],{
 stdio:['ignore','ignore','pipe'],env:{...process.env,SSL_CERT_FILE:caFile,TUNNEL_SERVICE_TOKEN_ID:config.client_id,TUNNEL_SERVICE_TOKEN_SECRET:config.client_secret}
});
let tunnelLog='';tunnel.stderr.on('data',chunk=>{if(tunnelLog.length<8192)tunnelLog+=chunk.toString('utf8').slice(0,8192-tunnelLog.length);});
function diagnostics(){let text=tunnelLog;for(const value of [config.client_id,config.client_secret,config.password])text=text.split(value).join('[REDACTED]');return {
 caBundlePresent:existsSync('/etc/ssl/certs/ca-certificates.crt'),managedCaPresent:existsSync(managedCa),rootCertificateCount:rootCertificates.length,
 tunnelLog:text.replace(/https?:\/\/\S+/g,'[URL]').replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,'[JWT]').slice(-4000)};}
let tunnelError=false;tunnel.on('error',()=>{tunnelError=true;});
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
    ['contacts','appointments','outbox_events'].every(key=>state[key]===config.expected[key]);
   checks.push({name:'read-only-private-query',pass,ms:Math.round(performance.now()-start)});
  }
  await sql.end();sql=undefined;
  const invalid=postgres({...options,ssl:{...options.ssl,servername:'incorrect-hostname.invalid'}});
  try{await invalid.unsafe('select 1');checks.push({name:'reject-wrong-certificate-identity',pass:false});}
  catch(e){checks.push({name:'reject-wrong-certificate-identity',pass:e.code==='ERR_TLS_CERT_ALTNAME_INVALID'});}
  finally{await invalid.end({timeout:2});}
  console.log(JSON.stringify({ok:checks.every(x=>x.pass),checks}));
  if(checks.some(x=>!x.pass))process.exitCode=1;
 }catch(e){const code=typeof e.code==='string' && /^[A-Z0-9_]{1,50}$/.test(e.code)?e.code:'DATABASE_PROBE_FAILED';console.log(JSON.stringify({ok:false,code,checks,diagnostics:diagnostics()}));process.exitCode=1;}
 finally{if(sql)await sql.end({timeout:2});tunnel.kill('SIGTERM');await wait(500);if(tunnel.exitCode===null)tunnel.kill('SIGKILL');rmSync(caDirectory,{recursive:true,force:true});}
})();
`;
