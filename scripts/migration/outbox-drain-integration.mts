// Run only with an empty disposable localhost PostgreSQL database after migrations.
import {spawn} from 'node:child_process';
import {setTimeout as wait} from 'node:timers/promises';
import {createRequire} from 'node:module';
const database=new URL(process.env.DATABASE_URL??'');
if(!['localhost','127.0.0.1'].includes(database.hostname)||database.pathname!=='/mystos')throw Error('Disposable localhost database required');
const postgres=createRequire(new URL('../../apps/api/package.json',import.meta.url))('postgres');
const inspection=postgres(database.href,{max:1,prepare:false});
try {
  const [state]=await inspection`select count(*)::int as events from outbox_events`;
  if(state.events!==0)throw Error('Worker drain test requires an empty disposable outbox');
} finally {await inspection.end();}
const environment={...process.env,DOTENV_CONFIG_PATH:'/dev/null',OUTBOX_POLL_INTERVAL_MS:'30000',OUTBOX_BATCH_SIZE:'1',
  TEAM_KILL_EXTERNAL_SENDS:'true',TEAM_KILL_OUTBOX_DISPATCH:'true',TEAM_KILL_FINANCIAL_MUTATIONS:'true',
  TEAM_KILL_ADVERTISING_CHANGES:'true',TEAM_KILL_PUBLISHING:'true',TEAM_KILL_DESTRUCTIVE_MUTATIONS:'true'};
// The CI job supplies no provider credentials. Fail if an inherited environment
// could turn this shutdown test into an external operation.
for(const key of ['OPENAI_API_KEY','TWILIO_AUTH_TOKEN','SQUARE_ACCESS_TOKEN','DISCORD_BOT_TOKEN','SMTP_HOST','GOOGLE_REFRESH_TOKEN','FB_PAGE_ACCESS_TOKEN']) {
  if(environment[key as keyof typeof environment])throw Error(`Unexpected provider setting: ${key}`);
}
const child=spawn(process.execPath,['--import','tsx','scripts/outbox-worker.ts'],{cwd:process.cwd(),env:environment,stdio:['ignore','pipe','pipe']});
let output='';let errorOutput='';const completion=new Promise<number|null>((resolve,reject)=>{child.once('exit',resolve);child.once('error',reject);});
child.stdout.on('data',c=>{if(output.length<100000)output+=c.toString();});
child.stderr.on('data',c=>{if(errorOutput.length<100000)errorOutput+=c.toString();});
try {
  for(let attempt=0;attempt<150;attempt++) {
    if(output.includes('"event":"outbox.worker.heartbeat"'))break;
    if(child.exitCode!==null)throw Error(`Worker exited before heartbeat (${child.exitCode})`);
    await wait(100);
  }
  if(!output.includes('"event":"outbox.worker.heartbeat"'))throw Error('Worker heartbeat timeout');
  const started=performance.now();child.kill('SIGTERM');
  let timer:ReturnType<typeof setTimeout>;
  const code=await Promise.race([completion,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('Worker drain timeout')),15000);})]).finally(()=>clearTimeout(timer));
  if(code!==0||!output.includes('outbox.worker.draining')||!output.includes('outbox.worker.drained'))throw Error('Worker did not exit cleanly after drain');
  console.log(JSON.stringify({ok:true,exitCode:code,drainMs:Math.round(performance.now()-started),heartbeat:true,draining:true,drained:true,stderrBytes:errorOutput.length}));
} finally {if(child.exitCode===null)child.kill('SIGKILL');}

// A shutdown between events must preserve the remainder of an already selected
// batch, including its retry budget. Unknown fixture events have no providers.
const {registerApiAliases}=await import('../lib/register-api-aliases');
registerApiAliases();
process.env.TEAM_KILL_EXTERNAL_SENDS='true';
process.env.TEAM_KILL_OUTBOX_DISPATCH='false';
const {processOutboxBatch}=await import('../../apps/api/src/lib/outbox-processor');
const {closeDbForWorkerShutdown}=await import('../../apps/api/src/db');
const fixture=postgres(database.href,{max:1,prepare:false});
const shutdownFixtureEventType='migration.shutdown.fixture';
try {
  await fixture`insert into outbox_events (type,payload) values (${shutdownFixtureEventType},'{}'),(${shutdownFixtureEventType},'{}')`;
  let admitted=0;
  await processOutboxBatch({limit:50,eventTypes:[shutdownFixtureEventType],shouldContinue:()=>admitted++===0});
  const [state]=await fixture`select count(*) filter(where processed_at is not null)::int as processed,count(*) filter(where processed_at is null and attempts=0)::int as untouched from outbox_events where type=${shutdownFixtureEventType}`;
  if(state.processed!==1||state.untouched!==1)throw Error('Drain admitted another event or consumed its retry budget');
  await processOutboxBatch({limit:50,eventTypes:[shutdownFixtureEventType],shouldContinue:()=>false});
  const [stillPending]=await fixture`select count(*)::int as count from outbox_events where type=${shutdownFixtureEventType} and processed_at is null and attempts=0`;
  if(stillPending.count!==1)throw Error('Stopped worker changed pending work');
  await processOutboxBatch({limit:50,eventTypes:[shutdownFixtureEventType]});
  const [resumed]=await fixture`select count(*)::int as count from outbox_events where type=${shutdownFixtureEventType} and processed_at is not null and attempts=1`;
  if(resumed.count!==2)throw Error('Preserved work did not resume exactly once');
  console.log(JSON.stringify({ok:true,batchAdmissionStops:true,pendingRetryBudgetPreserved:true,resumedOnce:true}));
} finally {
  await fixture`delete from outbox_events where type=${shutdownFixtureEventType}`;
  await fixture.end();await closeDbForWorkerShutdown();
}
