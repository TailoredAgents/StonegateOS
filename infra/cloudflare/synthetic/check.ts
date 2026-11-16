// Runs only against the empty-schema synthetic database, never the recovery
// copy or source. The application receives synthetic settings and no provider keys.
export const syntheticCheck = String.raw`
const {spawn}=require('node:child_process');
const {createRequire}=require('node:module');
const {randomUUID,randomBytes,createHash}=require('node:crypto');
const {existsSync,mkdtempSync,writeFileSync,readFileSync,rmSync}=require('node:fs');
const {rootCertificates}=require('node:tls');
const {setTimeout:wait}=require('node:timers/promises');
const postgres=createRequire('/app/apps/api/package.json')('postgres');
const config=JSON.parse(process.env.MIGRATION_SYNTHETIC_CONNECTION);
if(config.database!=='stonegate_staging_20261115'||config.user!=='stonegate_staging'||config.purpose!=='synthetic-staging-only')throw Error('Wrong synthetic target');
const directory=mkdtempSync('/tmp/stonegate-synthetic-');
const managedCa='/etc/cloudflare/certs/cloudflare-containers-ca.crt';
const caFile=directory+'/roots.pem';
writeFileSync(caFile,rootCertificates.join('\n')+'\n'+(existsSync(managedCa)?readFileSync(managedCa,'utf8'):''),{mode:0o600});
const relay=spawn('/usr/local/bin/cloudflared',['access','tcp','--hostname','migration-db.stonegatejunkremoval.com','--url','127.0.0.1:6543'],{
  stdio:'ignore',env:{SSL_CERT_FILE:caFile,TUNNEL_SERVICE_TOKEN_ID:config.client_id,TUNNEL_SERVICE_TOKEN_SECRET:config.client_secret}});
const url=new URL('postgres://127.0.0.1:6543/'+config.database);url.username=config.user;url.password=config.password;
const sql=postgres({host:'127.0.0.1',port:6543,user:config.user,password:config.password,database:config.database,
  max:2,prepare:false,connect_timeout:8,ssl:{ca:config.ca,servername:config.servername,rejectUnauthorized:true}});
const adminKey=randomBytes(32).toString('hex');
const environment={PATH:'/usr/local/bin:/usr/bin:/bin',NODE_ENV:'production',DOTENV_CONFIG_PATH:'/dev/null',NEXT_TELEMETRY_DISABLED:'1',
  DATABASE_URL:url.href,DATABASE_SSL:'true',DATABASE_SSL_CA:config.ca,DATABASE_SSL_SERVERNAME:config.servername,
  ADMIN_API_KEY:adminKey,TEAM_AUTH_RATE_LIMIT_SECRET:randomBytes(32).toString('hex'),SITE_URL:'https://synthetic.invalid',
  TEAM_KILL_EXTERNAL_SENDS:'true',TEAM_KILL_OUTBOX_DISPATCH:'true',TEAM_KILL_FINANCIAL_MUTATIONS:'true',
  TEAM_KILL_ADVERTISING_CHANGES:'true',TEAM_KILL_PUBLISHING:'true',TEAM_KILL_DESTRUCTIVE_MUTATIONS:'true'};
let application;let stdout='';let stderr='';let sessionId;const simulators=[];
const checks=[];
function check(name,pass,extra={}){checks.push({name,pass,...extra});if(!pass)throw Error('CHECK_FAILED:'+name);}
function start(args,extra={}) {
  stdout='';stderr='';
  application=spawn(process.execPath,args,{cwd:'/app',env:{...environment,...extra},stdio:['ignore','pipe','pipe']});
  application.stdout.on('data',chunk=>{if(stdout.length<65536)stdout+=chunk.toString().slice(0,65536-stdout.length);});
  application.stderr.on('data',chunk=>{if(stderr.length<65536)stderr+=chunk.toString().slice(0,65536-stderr.length);});
  application.on('error',()=>{});
}
async function stop(){if(!application||application.exitCode!==null)return;application.kill('SIGTERM');for(let i=0;i<50&&application.exitCode===null;i++)await wait(100);if(application.exitCode===null)application.kill('SIGKILL');}
async function startApi(){
  start(['apps/api/node_modules/next/dist/bin/next','start','apps/api','--hostname',process.env.MIGRATION_MODE==='site'?'0.0.0.0':'127.0.0.1','--port','8082'],{PORT:'8082'});
  for(let i=0;i<100;i++){
    if(application.exitCode!==null)throw Error('API_STARTUP_FAILED');
    try{const r=await fetch('http://127.0.0.1:8082/api/healthz',{signal:AbortSignal.timeout(500)});await r.body?.cancel();if(r.ok)return;}catch{}
    await wait(200);
  }
  throw Error('API_STARTUP_TIMEOUT');
}
async function api(path,options={}){const r=await fetch('http://127.0.0.1:8082'+path,{...options,signal:AbortSignal.timeout(20000)});return {status:r.status,body:await r.json()};}
(async()=>{
 try {
  await wait(750);
  const [state]=await sql.unsafe("select current_database() as database,current_user as role,(select ssl from pg_stat_ssl where pid=pg_backend_pid()) as tls,(select count(*)::int from contacts where email is null or email not like '%@migration.invalid') as unexpected_contacts");
  check('synthetic-target-and-verified-tls',state.database===config.database&&state.role===config.user&&state.tls&&state.unexpected_contacts===0);
  if(process.env.MIGRATION_MODE==='delivery') {
    const [pending]=await sql.unsafe("select count(*)::int as count from outbox_events where processed_at is null and quarantined_at is null and type='estimate.requested'");
    check('synthetic-booking-events-awaiting-delivery',pending.count>0);
    const [baseline]=await sql.unsafe('select count(*)::int as count from external_message_dispatches');
    const uncertainBefore=await sql.unsafe("select id,attempt_number from external_message_dispatches where state in ('dispatched','reconciliation_required') order by id");
    for(const [file,extra] of [['devops/twilio-mock/server.mjs',{PORT:'4010'}],['devops/email-fake/server.mjs',{HTTP_PORT:'4016',SMTP_PORT:'1025'}]]) {
      simulators.push(spawn(process.execPath,[file],{cwd:'/app',env:{PATH:environment.PATH,...extra},stdio:'ignore'}));
    }
    async function local(port,path,options={}) {const r=await fetch('http://127.0.0.1:'+port+path,{...options,signal:AbortSignal.timeout(2000)});if(!r.ok)throw Error('SIMULATOR_FAILED');return r.json();}
    for(const port of [4010,4016]) {
      let ready=false;for(let i=0;i<40;i++){try{await local(port,'/healthz');ready=true;break;}catch{}await wait(100);}
      check('local-provider-simulator-'+port,ready);
    }
    await local(4016,'/__control/scenario',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({operation:'send_email',scenario:'success',delayMs:3000})});
    const fakeEnvironment={E2E_RUN_ID:'cloudflare-synthetic-'+randomUUID(),TEAM_CRM_AUDIT_MODE:'1',
      TEAM_KILL_EXTERNAL_SENDS:'false',TEAM_KILL_OUTBOX_DISPATCH:'false',OUTBOX_POLL_INTERVAL_MS:'500',OUTBOX_BATCH_SIZE:'50',
      TWILIO_ACCOUNT_SID:'AC00000000000000000000000000000000',TWILIO_AUTH_TOKEN:'twilio-test-token',TWILIO_FROM:'+15555550123',
      TWILIO_API_BASE_URL:'http://127.0.0.1:4010',TWILIO_WEBHOOK_PUBLIC_BASE_URL:'http://127.0.0.1:8082',
      SMTP_HOST:'127.0.0.1',SMTP_PORT:'1025',SMTP_USER:'synthetic',SMTP_PASS:'synthetic',SMTP_FROM:'migration@migration.invalid',SMTP_TIMEOUT_MS:'10000'};
    start(['--import','tsx','scripts/outbox-worker.ts'],fakeEnvironment);
    let inFlight;
    const deliveryStartedAt=new Date();
    for(let i=0;i<400;i++) {
      [inFlight]=await sql.unsafe("select id from external_message_dispatches where channel='email' and state='dispatched' and created_at >= $1 order by created_at desc limit 1",[deliveryStartedAt]);
      if(inFlight||application.exitCode!==null)break;await wait(100);
    }
    check('real-outbox-has-in-flight-email',Boolean(inFlight));
    const [boundary]=await sql.unsafe('select clock_timestamp() as at');
    const started=performance.now();application.kill('SIGTERM');
    await wait(100);check('shutdown-waits-for-in-flight-delivery',application.exitCode===null);
    for(let i=0;i<250&&application.exitCode===null;i++)await wait(100);
    check('in-flight-outbox-drains-cleanly',application.exitCode===0&&stdout.includes('outbox.worker.drained'),{ms:Math.round(performance.now()-started)});
    const [settled]=await sql.unsafe('select state from external_message_dispatches where id=$1',[inFlight.id]);
    check('in-flight-email-committed-before-exit',settled.state==='succeeded');
    const [admittedAfterStop]=await sql.unsafe('select count(*)::int as count from external_message_dispatches where created_at > $1',[boundary.at]);
    check('no-provider-dispatch-admitted-after-stop',admittedAfterStop.count===0);
    // Restart against the same durable queue and the same local provider records.
    await local(4016,'/__control/scenario',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({operation:'send_email',scenario:'success',delayMs:0})});
    start(['--import','tsx','scripts/outbox-worker.ts'],{...fakeEnvironment,OUTBOX_BATCH_SIZE:'50'});
    for(let i=0;i<150&&!stdout.includes('outbox.worker.heartbeat');i++){if(application.exitCode!==null)break;await wait(100);}
    check('delivery-worker-heartbeat-after-restart',stdout.includes('outbox.worker.heartbeat'));
    let remaining;
    for(let i=0;i<250;i++) {
      [remaining]=await sql.unsafe("select count(*)::int as count from outbox_events where processed_at is null and quarantined_at is null and (next_attempt_at is null or next_attempt_at<=now())");
      if(remaining.count===0||application.exitCode!==null)break;await wait(100);
    }
    check('synthetic-runnable-queue-drained-after-restart',remaining.count===0);
    await stop();check('restarted-worker-drains-cleanly',application.exitCode===0);
    const emails=(await local(4016,'/__control/requests')).requests;
    const messages=(await local(4010,'/messages')).messages;
    const [dispatches]=await sql.unsafe("select count(*)::int as count,count(*) filter(where state<>'succeeded')::int as unsettled from external_message_dispatches");
    check('synthetic-email-and-sms-accepted',emails.length>0&&messages.length>0&&emails.every(x=>x.outcome==='accepted'),{emailCount:emails.length,smsCount:messages.length});
    check('provider-effects-match-durable-dispatches',dispatches.count-baseline.count===emails.length+messages.length&&dispatches.unsettled===uncertainBefore.length);
    const uncertainAfter=await sql.unsafe("select id,attempt_number from external_message_dispatches where state in ('dispatched','reconciliation_required') order by id");
    check('prior-uncertain-delivery-not-retried',JSON.stringify(uncertainBefore)===JSON.stringify(uncertainAfter),{preserved:uncertainBefore.length});
    const [duplicates]=await sql.unsafe('select count(*)::int as count from (select message_id from external_message_dispatches group by message_id having count(*)>1) duplicates');
    check('restart-does-not-duplicate-dispatches',duplicates.count===0);
  } else if(process.env.MIGRATION_MODE==='outbox') {
    const [queue]=await sql.unsafe('select count(*)::int as count from outbox_events');
    check('outbox-empty-before-worker-start',queue.count===0);
    start(['--import','tsx','scripts/outbox-worker.ts'],{OUTBOX_POLL_INTERVAL_MS:'30000',OUTBOX_BATCH_SIZE:'1'});
    for(let i=0;i<150&&!stdout.includes('outbox.worker.heartbeat');i++){if(application.exitCode!==null)break;await wait(100);}
    check('cloudflare-outbox-heartbeat',stdout.includes('outbox.worker.heartbeat'));
    const started=performance.now();application.kill('SIGTERM');
    for(let i=0;i<150&&application.exitCode===null;i++)await wait(100);
    check('cloudflare-outbox-graceful-drain',application.exitCode===0&&stdout.includes('outbox.worker.draining')&&stdout.includes('outbox.worker.drained'),{ms:Math.round(performance.now()-started)});
  } else {
    const runId=randomUUID();const email=runId+'@migration.invalid';const token=randomBytes(32).toString('base64url');
    const sessionHash=createHash('sha256').update(token).digest('base64url');
    const [role]=await sql.unsafe("insert into team_roles (name,slug,permissions) values ($1,$2,$3::text[]) returning id",['Synthetic migration role','migration-'+runId,['contacts.read','contacts.write','appointments.read']]);
    const [member]=await sql.unsafe("insert into team_members (name,email,email_normalized,email_identity_status,role_id,active) values ($1,$2,$2,'ready',$3,true) returning id",['Synthetic Migration',email,role.id]);
    const [session]=await sql.unsafe("insert into team_sessions (team_member_id,session_hash,expires_at) values ($1,$2,now()+interval '20 minutes') returning id",[member.id,sessionHash]);sessionId=session.id;
    const headers={'x-api-key':adminKey,authorization:'Bearer '+token,'content-type':'application/json'};
    await startApi();check('synthetic-api-starts',true);
    const unauth=await api('/api/admin/contacts');check('reject-anonymous-admin',unauth.status===401);
    const serviceOnly=await api('/api/admin/contacts',{headers:{'x-api-key':adminKey}});check('reject-service-key-without-principal',serviceOnly.status===401);
    const response=await api('/api/admin/contacts',{method:'POST',headers,body:JSON.stringify({firstName:'Synthetic',lastName:'Migration '+runId,email,salespersonMemberId:member.id,source:'cloudflare-synthetic-validation'})});
    check('authenticated-contact-write',response.status===200&&response.body.contact?.email===email,{status:response.status});
    const contactId=response.body.contact.id;
    const [saved]=await sql.unsafe('select count(*)::int as count from contacts where id=$1 and email=$2',[contactId,email]);
    check('write-committed-to-isolated-postgres',saved.count===1);
    const [audit]=await sql.unsafe("select count(*)::int as count from audit_logs where entity_id=$1 and action='contact.created'",[contactId]);
    check('contact-write-audited',audit.count===1);
    await stop();await startApi();
    const after=await api('/api/admin/contacts?contactId='+encodeURIComponent(contactId),{headers});
    check('record-and-session-survive-api-restart',after.status===200&&after.body.contacts?.some(row=>row.id===contactId&&row.email===email));
    async function checkSite(expectedRevoked=false) {
      const origin='https://stonegate-synthetic-validation.jeffrey-78e.workers.dev';
      const headers={authorization:'Bearer '+process.env.MIGRATION_PROBE_TOKEN,'content-type':'application/json'};
      try {
        const response=await fetch(origin+'/site/check',{method:'POST',headers,body:JSON.stringify({adminKey,sessionToken:token,contactId,memberId:member.id,expectedRevoked}),signal:AbortSignal.timeout(120000)});
        const result=await response.json();
        check('site-probe-version-matches',response.headers.get('x-stonegate-probe-sha256')===process.env.MIGRATION_SITE_PROBE_HASH);
        checks.push(...(result.checks??[]));check('coupled-site-api-check',response.ok&&result.ok===true,{status:response.status,...(result.proxyRequests?{proxyRequests:result.proxyRequests}:{})});
      }finally{const stop=await fetch(origin+'/site/stop',{method:'POST',headers,signal:AbortSignal.timeout(15000)});await stop.body?.cancel();if(!stop.ok)throw Error('SITE_CLEANUP_FAILED');}
    }
    if(process.env.MIGRATION_MODE==='site')await checkSite();
    if(process.env.MIGRATION_MODE==='booking') {
      const used=await sql.unsafe("select phone_e164 from contacts where phone_e164 like '+140455501%'");
      const phones=new Set(used.map(row=>row.phone_e164));
      const phone=Array.from({length:100},(_,i)=>'+1404555'+String(100+i).padStart(4,'0')).find(value=>!phones.has(value));
      if(!phone)throw Error('Synthetic phone range exhausted');
      const key='migration-booking:'+randomUUID();
      // Repeated validation must not exhaust capacity in the same arrival window.
      const [latest]=await sql.unsafe('select max(start_at) as start_at from appointments');
      const preferredDate=new Date(Math.max(Date.now()+6*86400000,latest.start_at?new Date(latest.start_at).getTime()+86400000:0)).toISOString().slice(0,10);
      const body={services:['furniture'],name:'Synthetic Booking',phone,email:'booking-'+runId+'@migration.invalid',
        addressLine1:'123 Synthetic Validation Lane',city:'Roswell',state:'GA',postalCode:'30075',appointmentType:'in_person_estimate',
        scheduling:{preferredDate,timeWindow:'morning'},consent:true};
      const intakeHeaders={'content-type':'application/json','idempotency-key':key};
      const booked=await api('/api/web/lead-intake',{method:'POST',headers:intakeHeaders,body:JSON.stringify(body)});
      check('synthetic-booking-created',booked.status===201&&booked.body.ok===true&&typeof booked.body.appointmentId==='string',{status:booked.status,preferredDate,schedulingReviewRequired:booked.body.schedulingReviewRequired??null});
      const leadId=booked.body.leadId;
      const [beforeQueue]=await sql.unsafe("select count(*)::int as count from outbox_events where payload->>'leadId'=$1",[leadId]);
      check('booking-has-durable-outbox',beforeQueue.count>0);
      await stop();await startApi();
      const replay=await api('/api/web/lead-intake',{method:'POST',headers:intakeHeaders,body:JSON.stringify(body)});
      check('booking-idempotency-survives-restart',replay.status===201&&replay.body.leadId===leadId&&replay.body.appointmentId===booked.body.appointmentId);
      const [afterQueue]=await sql.unsafe("select count(*)::int as count from outbox_events where payload->>'leadId'=$1",[leadId]);
      check('booking-replay-does-not-duplicate-outbox',afterQueue.count===beforeQueue.count);
      const conflict=await api('/api/web/lead-intake',{method:'POST',headers:intakeHeaders,body:JSON.stringify({...body,name:'Different Synthetic Booking'})});
      check('booking-key-reuse-with-different-body-rejected',conflict.status===409);
    }
    await sql.unsafe('update team_sessions set revoked_at=now() where id=$1',[sessionId]);
    const revoked=await api('/api/admin/contacts',{headers});check('revoked-session-rejected',revoked.status===401);
    if(process.env.MIGRATION_MODE==='site')await checkSite(true);
  }
  console.log(JSON.stringify({ok:true,checks}));
 } catch(error) {
  console.log(JSON.stringify({ok:false,checks,code:/^[A-Z0-9_]+$/.test(error.code??'')?error.code:'SYNTHETIC_CHECK_FAILED',
    failedCheck:error.message?.startsWith('CHECK_FAILED:')?error.message.slice(13):null,
    processExit:application?.exitCode,stderrFlags:['certificate','ECONNREFUSED','heap out of memory'].filter(x=>stderr.includes(x))}));process.exitCode=1;
 } finally {
  await stop();for(const child of simulators)child.kill('SIGTERM');if(sessionId)await sql.unsafe('update team_sessions set revoked_at=coalesce(revoked_at,now()) where id=$1',[sessionId]).catch(()=>{});
  await sql.end({timeout:2});relay.kill('SIGTERM');await wait(250);if(relay.exitCode===null)relay.kill('SIGKILL');rmSync(directory,{recursive:true,force:true});
 }
})();
`;
