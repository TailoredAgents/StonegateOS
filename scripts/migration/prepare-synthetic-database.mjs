// Creates an empty, isolated application database only on the known temporary
// restore server. No customer rows, source roles or production credentials copy.
import postgres from 'postgres';
import {randomBytes} from 'node:crypto';
import {readFile,writeFile,chmod} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import path from 'node:path';
const directory=process.argv[2];
if(!directory)throw Error('Private evidence directory required');
const restore=JSON.parse(await readFile(path.join(directory,'restore-connection.json'),'utf8'));
const transport=JSON.parse(await readFile(path.join(directory,'container-restore-secret.json'),'utf8'));
const source=new URL(restore.internalConnectionString);
if(source.hostname!=='dpg-dbt21dui0phs73efick0-a'||source.pathname!=='/stonegate_restore_20261115')throw Error('Not the isolated restore server');
const database='stonegate_staging_20261115';
const user='stonegate_staging';
const ownerOptions={host:'127.0.0.1',port:65432,user:decodeURIComponent(source.username),password:decodeURIComponent(source.password),database:source.pathname.slice(1),
  max:1,prepare:false,ssl:{ca:transport.ca,servername:transport.servername,rejectUnauthorized:true}};
const owner=postgres(ownerOptions);
let staging;
try {
  const [state]=await owner`select current_database() as database, (select ssl from pg_stat_ssl where pid=pg_backend_pid()) as tls`;
  if(state.database!=='stonegate_restore_20261115'||!state.tls)throw Error('Restore identity/TLS mismatch');
  const existing=await owner`select datname from pg_database where datname=${database}`;
  if(existing.length)throw Error('Staging database already exists; inspect its receipt rather than recreating it');
  const role=await owner`select rolname from pg_roles where rolname=${user}`;
  const configFile=path.join(directory,'synthetic-connection.json');
  const config=role.length?JSON.parse(await readFile(configFile,'utf8')):
    {...transport,database,user,password:randomBytes(32).toString('hex'),expected:undefined,purpose:'synthetic-staging-only'};
  if(config.database!==database||config.user!==user||config.purpose!=='synthetic-staging-only'||!/^\w{64}$/.test(config.password))throw Error('Unexpected partial preparation credentials');
  const {password}=config;
  if(!role.length){
    await writeFile(configFile,JSON.stringify(config),{mode:0o600,flag:'wx'});
    await owner.unsafe(`CREATE ROLE ${user} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION`);
  }
  // Render's database administrator must have SET ROLE membership to assign
  // ownership. This grants access only to our new, unprivileged staging role.
  await owner.unsafe(`GRANT ${user} TO ${'"'+ownerOptions.user.replaceAll('"','""')+'"'}`);
  await owner.unsafe(`CREATE DATABASE ${database} OWNER ${user}`);
  await owner.unsafe(`REVOKE ALL ON DATABASE ${database} FROM PUBLIC`);
  const caFile=path.join(directory,'restore-pg-ca.pem');
  await writeFile(caFile,transport.ca,{mode:0o600});
  const pgEnv={...process.env,PGHOST:transport.servername,PGHOSTADDR:'127.0.0.1',PGPORT:'65432',
    PGUSER:ownerOptions.user,PGPASSWORD:ownerOptions.password,PGDATABASE:ownerOptions.database,PGSSLMODE:'verify-full',PGSSLROOTCERT:caFile};
  // Schema-only archive contains no table data. Keep it private for repeatability.
  const archive=path.join(directory,'synthetic-schema.pgdump');
  async function command(binary,args,env) {
    const child=spawn(binary,args,{env,stdio:['ignore','ignore','pipe']});
    let log='';child.stderr.on('data',chunk=>{log+=chunk.toString();});
    const code=await new Promise((resolve,reject)=>{child.once('exit',resolve);child.once('error',reject);});
    if(code!==0){await writeFile(path.join(directory,'synthetic-schema-error.log'),log,{mode:0o600});throw Error(`${binary} failed (${code}); see private log`);}
  }
  await command('pg_dump',['--schema-only','--format=custom','--no-owner','--no-acl','--file',archive],pgEnv);
  await chmod(archive,0o600);
  await command('pg_restore',['--exit-on-error','--single-transaction','--no-owner','--no-acl','--dbname',database,archive],
    {...pgEnv,PGUSER:user,PGPASSWORD:password,PGDATABASE:database});
  staging=postgres({...ownerOptions,user,password,database});
  const journal=await owner`select id,hash,created_at from drizzle.__drizzle_migrations order by id`;
  await staging.begin(async tx=>{for(const row of journal)await tx`insert into drizzle.__drizzle_migrations (id,hash,created_at) values (${row.id},${row.hash},${row.created_at})`;});
  const tables=await staging`select schemaname,tablename from pg_tables where schemaname in ('public','drizzle') order by 1,2`;
  let totalRows=0;
  for(const table of tables) {
    const [row]=await staging`select count(*)::int as count from ${staging(table.schemaname,table.tablename)}`;
    if(table.schemaname!=='drizzle'&&row.count!==0)throw Error('Unexpected data in synthetic database');
    totalRows+=row.count;
  }
  const [permissions]=await staging`select rolsuper,rolcreatedb,rolcreaterole,rolreplication from pg_roles where rolname=current_user`;
  if(Object.values(permissions).some(Boolean))throw Error('Staging role has elevated privileges');
  const receipt={at:new Date().toISOString(),database,user,tables:tables.length,applicationRows:0,migrationJournalRows:journal.length,totalRows,tlsVerified:true,privileged:false};
  await writeFile(path.join(directory,'synthetic-database-receipt.json'),JSON.stringify(receipt,null,2),{mode:0o600,flag:'wx'});
  console.log(JSON.stringify(receipt));
} finally {await staging?.end({timeout:2});await owner.end({timeout:2});}
