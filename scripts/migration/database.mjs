import postgres from 'postgres';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { chmod, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { Writable } from 'node:stream';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MAGIC = Buffer.from('SGPG01');
const HEADER_BYTES = MAGIC.length + 12;
const quote = (value) => '"' + value.replaceAll('"', '""') + '"';
const connection = () => {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required; never pass credentials as arguments');
  return process.env.DATABASE_URL;
};
const sqlClient = () => postgres(connection(), {
  max: 1, prepare: false, onnotice: () => {},
  connection: { application_name: 'stonegate-migration-verifier', statement_timeout: 300000, lock_timeout: 5000 },
});
function pgEnvironment() {
  const url = new URL(connection());
  return { ...process.env, PGHOST:url.hostname, PGPORT:url.port || '5432',
    PGUSER:decodeURIComponent(url.username), PGPASSWORD:decodeURIComponent(url.password),
    PGDATABASE:decodeURIComponent(url.pathname.slice(1)), PGSSLMODE:url.searchParams.get('sslmode') || 'require' };
}
async function privateJson(file, value) {
  await writeFile(file, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
}
function completed(child) {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`Database command failed: code=${code}, signal=${signal}`)));
  });
}
export async function encrypt(input, destination, key) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const header = Buffer.concat([MAGIC, iv]);
  cipher.setAAD(header);
  const output = createWriteStream(destination, { flags: 'wx', mode: 0o600 });
  output.write(header);
  await pipeline(input, cipher, output, { end: false });
  output.end(cipher.getAuthTag());
  await new Promise((resolve, reject) => { output.on('close', resolve); output.on('error', reject); });
}
export async function decrypt(file, output, key) {
  const info = await stat(file);
  if (info.size < HEADER_BYTES + 16) throw new Error('Truncated encrypted backup');
  const header = await readRange(file, 0, HEADER_BYTES - 1);
  if (!header.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('Unknown backup format');
  const decipher = createDecipheriv('aes-256-gcm', key, header.subarray(MAGIC.length));
  decipher.setAAD(header);
  decipher.setAuthTag(await readRange(file, info.size - 16, info.size - 1));
  await pipeline(createReadStream(file, { start: HEADER_BYTES, end: info.size - 17 }), decipher, output);
}
async function readRange(file, start, end) {
  const buffers = [];
  for await (const chunk of createReadStream(file, { start, end })) buffers.push(chunk);
  return Buffer.concat(buffers);
}
async function fileHash(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
async function manifest(sql) {
  await sql`SET LOCAL TIME ZONE 'UTC'`;
  await sql`SET LOCAL datestyle = 'ISO, YMD'`;
  await sql`SET LOCAL extra_float_digits = 3`;
  await sql`SET LOCAL bytea_output = 'hex'`;
  const [database] = await sql`SELECT current_setting('server_version') AS version, pg_database_size(current_database())::text AS bytes`;
  const extensions = await sql`SELECT extname AS name, extversion AS version FROM pg_extension ORDER BY extname`;
  const tables = await sql`SELECT n.nspname AS schema, c.relname AS name, c.relkind AS kind, c.relispartition AS partition
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%' AND n.nspname NOT LIKE 'pg_temp%'
      AND c.relkind IN ('r','p','m','f') ORDER BY n.nspname COLLATE "C",c.relname COLLATE "C"`;
  if (tables.some(t => t.kind === 'f')) throw new Error('Foreign tables require a separate data migration strategy');
  const schema = await sql`SELECT n.nspname AS schema,c.relname AS table,a.attnum AS position,a.attname AS name,
    format_type(a.atttypid,a.atttypmod) AS type,a.attnotnull AS not_null,a.attidentity AS identity,a.attgenerated AS generated,
    pg_get_expr(d.adbin,d.adrelid) AS default_expression
    FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
    WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%' AND n.nspname NOT LIKE 'pg_temp%'
    AND c.relkind IN ('r','p','v','m','f') AND a.attnum>0 AND NOT a.attisdropped
    ORDER BY n.nspname COLLATE "C",c.relname COLLATE "C",a.attnum`;
  const constraints = await sql`SELECT n.nspname AS schema,c.relname AS table,k.conname AS name,pg_get_constraintdef(k.oid) AS definition,k.convalidated AS validated
    FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname IN ('public','drizzle') ORDER BY n.nspname COLLATE "C",c.relname COLLATE "C",k.conname COLLATE "C"`;
  const indexes = await sql`SELECT schemaname,indexname,indexdef FROM pg_indexes WHERE schemaname IN ('public','drizzle') ORDER BY schemaname COLLATE "C",indexname COLLATE "C"`;
  const enums = await sql`SELECT n.nspname AS schema,t.typname AS name,e.enumsortorder AS position,e.enumlabel AS label
    FROM pg_enum e JOIN pg_type t ON t.oid=e.enumtypid JOIN pg_namespace n ON n.oid=t.typnamespace
    WHERE n.nspname IN ('public','drizzle') ORDER BY n.nspname COLLATE "C",t.typname COLLATE "C",e.enumsortorder`;
  const sequences = await sql`SELECT schemaname,sequencename,data_type,start_value::text,min_value::text,max_value::text,increment_by::text,cycle,cache_size::text,last_value::text
    FROM pg_sequences WHERE schemaname IN ('public','drizzle') ORDER BY schemaname COLLATE "C",sequencename COLLATE "C"`;
  const [largeObjects] = await sql`SELECT count(*)::text AS count FROM pg_largeobject_metadata`;
  if (largeObjects.count !== '0') throw new Error('Large objects present: add content comparison before proceeding');
  const [rowSecurity] = await sql`SELECT count(*)::text AS count FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname IN ('public','drizzle') AND c.relrowsecurity`;
  if (rowSecurity.count !== '0') throw new Error('RLS present: prove verifier can see every row before proceeding');
  const results = [];
  for (const table of tables) {
    const digest = createHash('sha256');
    let rows = 0;
    // ONLY avoids counting partition rows twice; materialized views are compared too.
    const name = `${quote(table.schema)}.${quote(table.name)}`;
    const query = `SELECT to_jsonb(t)::text AS value FROM ONLY ${name} t ORDER BY to_jsonb(t)::text COLLATE "C"`;
    for await (const batch of sql.unsafe(query).cursor(500)) {
      for (const row of batch) { digest.update(row.value); digest.update('\n'); rows++; }
    }
    results.push({ ...table, rows, sha256: digest.digest('hex') });
  }
  return { format: 1, createdAt: new Date().toISOString(), database, extensions, schema, constraints, indexes, enums, sequences,
    largeObjects: largeObjects.count, tables: results,
    sequenceCaveat: 'Sequence values are not MVCC snapshots. Reconcile under final write freeze; backup verification compares definitions only.' };
}
export function compare(expected, actual) {
  const failures = [];
  for (const key of ['schema','constraints','indexes','tables','largeObjects']) {
    if (JSON.stringify(expected[key]) !== JSON.stringify(actual[key])) failures.push(key);
  }
  // PostgreSQL rebuilds fractional enum sort positions during dump/restore.
  // The ordered labels must remain identical; internal numeric positions need not.
  const labels = m => m.enums.map(({position,...rest})=>rest);
  if (JSON.stringify(labels(expected)) !== JSON.stringify(labels(actual))) failures.push('enums');
  // Minor extension patches and source physical size may differ on a supported restore target.
  if (JSON.stringify(expected.extensions.map(x => x.name)) !== JSON.stringify(actual.extensions.map(x => x.name))) failures.push('extension names');
  const definitions = (m) => m.sequences.map(({ last_value, ...rest }) => rest);
  if (JSON.stringify(definitions(expected)) !== JSON.stringify(definitions(actual))) failures.push('sequence definitions');
  return failures;
}
async function backup(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const key = randomBytes(32);
  await writeFile(path.join(directory, 'backup.key'), key, { mode: 0o600, flag: 'wx' });
  const db = sqlClient();
  try {
    await db.begin('isolation level repeatable read read only', async sql => {
      const [{ snapshot }] = await sql`SELECT pg_export_snapshot() AS snapshot`;
      const dump = spawn('pg_dump', ['--format=custom', '--no-owner', '--no-privileges', '--lock-wait-timeout=5s', `--snapshot=${snapshot}`], {
        env: { ...pgEnvironment(), PGOPTIONS: '-c default_transaction_read_only=on -c statement_timeout=300000' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const exit = completed(dump);
      // Save diagnostics privately; database tool errors can contain object or connection details.
      const log = createWriteStream(path.join(directory, 'dump.log'), { mode: 0o600, flags: 'wx' });
      const logs = pipeline(dump.stderr, log);
      const encrypted = path.join(directory, 'database.pgdump.aesgcm.partial');
      try {
        await Promise.all([encrypt(dump.stdout, encrypted, key), exit, logs]);
        const evidence = await manifest(sql);
        evidence.backupSha256 = await fileHash(encrypted);
        await privateJson(path.join(directory, 'manifest.json'), evidence);
        await rename(encrypted, path.join(directory, 'database.pgdump.aesgcm'));
        console.log(JSON.stringify({ event: 'backup-verified-source-snapshot', tables: evidence.tables.length,
          rows: evidence.tables.reduce((sum,t) => sum+t.rows,0), encryptedBytes: (await stat(path.join(directory,'database.pgdump.aesgcm'))).size }));
      } catch (error) { dump.kill('SIGTERM'); throw error; }
    });
  } finally { await db.end(); }
}
async function restore(directory) {
  const target = new URL(connection());
  if (!['127.0.0.1','localhost','[::1]'].includes(target.hostname) || !target.pathname.startsWith('/stonegate_restore_')) {
    throw new Error('Restore is restricted to an isolated local stonegate_restore_* database');
  }
  const key = await readFile(path.join(directory,'backup.key'));
  const file = path.join(directory,'database.pgdump.aesgcm');
  const evidence = JSON.parse(await readFile(path.join(directory,'manifest.json'),'utf8'));
  if (await fileHash(file) !== evidence.backupSha256) throw new Error('Encrypted backup checksum mismatch');
  // Authenticate the entire backup before sending any plaintext to the restore process.
  await decrypt(file, new Writable({ write(_chunk,_encoding,callback) { callback(); } }), key);
  const db = sqlClient();
  try {
    const [{ count }] = await db`SELECT count(*)::int AS count FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%' AND c.relkind IN ('r','p')`;
    if (count !== 0) throw new Error('Restore target is not empty');
  } finally { await db.end(); }
  const child = spawn('pg_restore', ['--exit-on-error','--single-transaction','--no-owner','--no-privileges','--dbname',target.pathname.slice(1)], {
    env: pgEnvironment(), stdio: ['pipe','ignore','pipe'],
  });
  const exit = completed(child);
  const logs = pipeline(child.stderr, createWriteStream(path.join(directory,'restore.log'),{mode:0o600,flags:'wx'}));
  await Promise.all([decrypt(file,child.stdin,key),exit,logs]);
  await verify(directory);
}
async function verify(directory) {
  const expected = JSON.parse(await readFile(path.join(directory,'manifest.json'),'utf8'));
  const db = sqlClient();
  try {
    const actual = await db.begin('isolation level repeatable read read only', manifest);
    const normalized=structuredClone(expected);
    const canonicalized=[];
    const target = new URL(connection());
    // Re-parse source CHECK expressions on the restore server. Different PostgreSQL
    // patch versions may flatten ANDs or array casts. Never strip SQL punctuation
    // or whitelist a changed condition. The server's parsed definitions must match.
    if (['127.0.0.1','localhost','[::1]'].includes(target.hostname) && target.pathname.startsWith('/stonegate_restore_')) {
      for (const item of normalized.constraints) {
        const restored=actual.constraints.find(x=>x.schema===item.schema&&x.table===item.table&&x.name===item.name);
        if (!restored || restored.definition===item.definition || !item.definition.startsWith('CHECK (')) continue;
        const canonical = await db.begin(async sql => {
          await sql.unsafe(`CREATE TEMPORARY TABLE migration_constraint_probe (LIKE ${quote(item.schema)}.${quote(item.table)}) ON COMMIT DROP`);
          await sql.unsafe(`ALTER TABLE pg_temp.migration_constraint_probe ADD CONSTRAINT migration_check ${item.definition}`);
          const [result]=await sql`SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid='pg_temp.migration_constraint_probe'::regclass AND conname='migration_check'`;
          return result.definition;
        });
        if (canonical===restored.definition) {canonicalized.push(`${item.schema}.${item.table}.${item.name}`);item.definition=canonical;}
      }
    }
    const failures = compare(normalized,actual);
    await privateJson(path.join(directory,`verification-${Date.now()}.json`),{ checkedAt:new Date().toISOString(),failures,canonicalizedCheckConstraints:canonicalized,actual });
    if (failures.length) throw new Error('Restore mismatch: '+failures.join(', '));
    console.log(JSON.stringify({ event:'restore-verified',tables:actual.tables.length,rows:actual.tables.reduce((sum,t)=>sum+t.rows,0),canonicalizedCheckConstraints:canonicalized.length,failures }));
  } finally { await db.end(); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command,directory] = process.argv.slice(2);
  try {
    if (!directory) throw new Error('Usage: database.mjs backup|restore|verify PRIVATE_DIRECTORY');
    if (command==='backup') await backup(directory);
    else if (command==='restore') await restore(directory);
    else if (command==='verify') await verify(directory);
    else throw new Error('Unknown command');
  } catch (error) { console.error(error.message); process.exitCode=1; }
}
