import postgres from 'postgres';
import { readFile,readdir,writeFile } from 'node:fs/promises';
import path from 'node:path';
const directory=process.argv[2];
if(!directory || !process.env.DATABASE_URL)throw new Error('Private directory and DATABASE_URL required');
const db=postgres(process.env.DATABASE_URL,{max:1,prepare:false,onnotice:()=>{},connection:{default_transaction_read_only:'on',statement_timeout:60000,application_name:'stonegate-migration-catalog'}});
try {
  const catalog=await db.begin('read only',async sql=>({
    functions:await sql`SELECT n.nspname AS schema,p.proname AS name,pg_get_functiondef(p.oid) AS definition
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN ('public','drizzle') AND p.prokind IN ('f','p') ORDER BY n.nspname,p.proname,pg_get_function_identity_arguments(p.oid)`,
    triggers:await sql`SELECT n.nspname AS schema,c.relname AS table,t.tgname AS name,t.tgenabled AS enabled,pg_get_triggerdef(t.oid) AS definition
      FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ('public','drizzle') AND NOT t.tgisinternal ORDER BY n.nspname,c.relname,t.tgname`,
    views:await sql`SELECT n.nspname AS schema,c.relname AS name,c.relkind AS kind,pg_get_viewdef(c.oid) AS definition
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ('public','drizzle') AND c.relkind IN ('v','m') ORDER BY n.nspname,c.relname`,
    roles:await sql`SELECT rolname,rolsuper,rolinherit,rolcreaterole,rolcreatedb,rolcanlogin,rolreplication,rolbypassrls,rolconnlimit,rolconfig FROM pg_roles ORDER BY rolname`,
    grants:await sql`SELECT grantee,table_schema,table_name,privilege_type,is_grantable FROM information_schema.role_table_grants WHERE table_schema IN ('public','drizzle') ORDER BY grantee,table_schema,table_name,privilege_type`,
    owners:await sql`SELECT n.nspname AS schema,c.relname AS name,c.relkind AS kind,pg_get_userbyid(c.relowner) AS owner FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ('public','drizzle') ORDER BY n.nspname,c.relname`,
  }));
  await writeFile(path.join(directory,`catalog-${Date.now()}.json`),JSON.stringify(catalog,null,2),{mode:0o600,flag:'wx'});
  console.log(JSON.stringify(Object.fromEntries(Object.entries(catalog).map(([key,values])=>[key,values.length]))));
  if(process.env.VERIFY_MEDIA!=='1')process.exitCode=0;
  else {
    const env=JSON.parse(await readFile(path.join(directory,'api-env.json'),'utf8'));
    const references=await db.begin('read only',async sql=>[
      ...await sql`SELECT 'media_assets' AS source,storage_bucket AS bucket,original_object_key AS key,sha256 AS expected_sha256 FROM media_assets WHERE deleted_at IS NULL AND status='ready'`,
      ...await sql`SELECT 'media_assets_display' AS source,storage_bucket AS bucket,display_object_key AS key,NULL AS expected_sha256 FROM media_assets WHERE deleted_at IS NULL AND status='ready' AND display_object_key IS NOT NULL`,
      ...await sql`SELECT 'media_assets_thumbnail' AS source,storage_bucket AS bucket,thumbnail_object_key AS key,NULL AS expected_sha256 FROM media_assets WHERE deleted_at IS NULL AND status='ready' AND thumbnail_object_key IS NOT NULL`,
      ...await sql`SELECT 'expense_receipt_captures' AS source,${env.MEDIA_OBJECT_BUCKET} AS bucket,original_object_key AS key,sha256 AS expected_sha256 FROM expense_receipt_captures WHERE uploaded_at IS NOT NULL`,
      ...await sql`SELECT 'expense_receipts_normalized' AS source,${env.MEDIA_OBJECT_BUCKET} AS bucket,normalized_object_key AS key,NULL AS expected_sha256 FROM expense_receipt_captures WHERE normalized_object_key IS NOT NULL`,
      ...await sql`SELECT 'partner_documents' AS source,storage_bucket AS bucket,storage_object_key AS key,sha256 AS expected_sha256 FROM partner_documents`,
      ...await sql`SELECT 'quote_version_documents' AS source,storage_bucket AS bucket,storage_object_key AS key,sha256 AS expected_sha256 FROM quote_version_documents`,
    ]);
    const files=await readdir(directory);
    const inventories=new Map();
    for(const [alias,bucket] of [['media','stonegate-appointment-media'],['legacy','stonegate']]) {
      const file=files.filter(x=>x.startsWith(`r2-${alias}-`)).sort().at(-1);
      if(!file)throw new Error('Run live-validation before comparing references');
      inventories.set(bucket,new Map(JSON.parse(await readFile(path.join(directory,file),'utf8')).verified.map(x=>[x.key,x])));
    }
    const findings=[];
    for(const reference of references) {
      const object=inventories.get(reference.bucket)?.get(reference.key);
      if(!object || object.missing)findings.push({...reference,issue:'missing_object'});
      else if(reference.expected_sha256 && reference.expected_sha256.toLowerCase()!==object.sha256)findings.push({...reference,issue:'content_hash_mismatch'});
    }
    const [pending]=await db`SELECT count(*)::int AS count FROM media_assets WHERE deleted_at IS NULL AND status='staging'`;
    await writeFile(path.join(directory,`media-references-${Date.now()}.json`),JSON.stringify({references,findings,pendingStaging:pending.count},null,2),{mode:0o600,flag:'wx'});
    console.log(JSON.stringify({mediaReferences:references.length,findings:findings.length,pendingStaging:pending.count}));
    if(findings.length)process.exitCode=1;
  }
}finally{await db.end();}
